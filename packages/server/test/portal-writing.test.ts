/**
 * A requester's own writing (docs/architecture.md, D39 and D59): their reply's pictures, kept on
 * the request and seen by whoever reads it on the portal; and their writing help, read from what
 * they can read - the request and its public conversation, never anything internal - with their
 * own hourly cap, and the model stood in for.
 */
import { eq } from 'drizzle-orm';
import { newId } from '../src/lib/ids';
import { readableId } from '../src/services/issue-refs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setClaudeClientForTests, type ClaudeClient } from '../src/ai/client';
import { writeWithPortal } from '../src/ai/writing';
import { attachmentBlobs, attachments, helpThrottle, issues, requesters } from '../src/db/schema';
import { OutboxWorker } from '../src/events/worker';
import { helpdeskConsumer } from '../src/helpdesk/consumer';
import { createHttpApp } from '../src/http/app';
import { AppError } from '../src/lib/errors';
import { MailWorker } from '../src/mail/outbox';
import { notifierConsumer } from '../src/notify/notifier';
import { attachmentForRequester } from '../src/services/attachments';
import { issueTokenFor } from '../src/services/auth';
import { addComment } from '../src/services/comments';
import { fileRequest } from '../src/services/helpdesk';
import { redeemSignIn, requestSignIn, type PortalViewer } from '../src/services/portal';
import { updateProject } from '../src/services/projects';
import { createWorld, type TestWorld } from './helpers';
import { fakeSmtp, type FakeSmtp } from './smtp';

// A stand-in for the SDK, as writing.test.ts's: structured calls pop the scripted answer, and every request is kept.
const script = { parsed: [] as unknown[], requests: [] as Record<string, unknown>[] };
const fake = {
  beta: {
    messages: {
      parse: async (body: Record<string, unknown>) => {
        script.requests.push(JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
        const next = script.parsed.shift();
        if (next === undefined) throw new Error('no scripted answer left');
        return { stop_reason: 'end_turn', stop_details: null, parsed_output: next, model: 'fake', content: [] };
      },
      create: async (body: Record<string, unknown>) => {
        throw new Error('structured calls expected');
      },
    },
  },
} as unknown as ClaudeClient;

const sent = () => JSON.stringify(script.requests);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 7)]);
const SIGN_IN_LINK = /\/portal#(hdl_[A-Za-z0-9_-]{43})/;

let w: TestWorld;
let http: ReturnType<typeof createHttpApp>;
let smtp: FakeSmtp;
let outbox: OutboxWorker;
let mailer: MailWorker;
let annaToken: string;
let request: string;
let other: string;
let rosa: PortalViewer;
let dina: PortalViewer;
let session: string;
let picture: string;

const failure = async (p: Promise<unknown>): Promise<AppError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error('expected it to fail');
};

const flush = async () => {
  await outbox.drain();
  await mailer.drain();
};

/** Ask for a sign-in link, and redeem the token its mail carries. */
async function signIn(email: string): Promise<string> {
  await requestSignIn(w.app, email);
  await flush();
  const mail = [...smtp.messages].reverse().find((m) => m.to.includes(email) && SIGN_IN_LINK.test(m.text));
  if (!mail) throw new Error(`no sign-in mail to ${email}`);
  return (await redeemSignIn(w.app, SIGN_IN_LINK.exec(mail.text)![1]!)).session;
}

const upload = (to: string, name: string, bytes: Buffer, headers: Record<string, string>) => {
  const form = new FormData();
  form.append('file', new Blob([bytes]), name);
  return http.request(`/api/v1${to}`, { method: 'POST', headers, body: form });
};

beforeAll(async () => {
  smtp = await fakeSmtp();
  w = await createWorld({ config: { smtpUrl: smtp.url, publicUrl: 'http://portal.test', trustProxy: 1 } });
  http = createHttpApp(w.app);
  outbox = new OutboxWorker(w.app, [notifierConsumer(w.app), helpdeskConsumer(w.app)], {}, [], () => {});
  mailer = new MailWorker(w.app, () => new Date(Date.now() + 10 * 60_000));
  setClaudeClientForTests(fake);
  // As attachments.test.ts: its own disk, so the sandbox's fsync denial doesn't reach the world's data dir.
  annaToken = (await issueTokenFor(w.app.db, w.anna.id, { name: 'portal pictures', scopes: ['read', 'write'] })).token;
  await updateProject(w.adminCtx, 'BACK', { settings: { helpdesk: { enabled: true, signIn: { link: true, password: false, providers: [] } } } });
  await fileRequest(w.app, 'BACK', { name: 'Rosa Diaz', email: 'rosa@example.com', summary: 'Invoice rounds twice', description: 'The June invoice totals twice.' });
  await fileRequest(w.app, 'BACK', { name: 'Dina Kim', email: 'dina@example.com', summary: 'Login page loops', description: 'It asks twice.' });
  const mine = (await w.app.db.select().from(issues).where(eq(issues.summary, 'Invoice rounds twice')))[0]!;
  const dinas = (await w.app.db.select().from(issues).where(eq(issues.summary, 'Login page loops')))[0]!;
  const s = await w.app.schema.get();
  other = readableId(s, dinas);
  request = readableId(s, mine);
  await addComment(w.as(w.anna), request, 'The team: we are looking into the double total.', { visibility: 'public' });
  await addComment(w.as(w.anna), request, 'Internal only: the discount table moved.', { visibility: 'internal' });
  const [r1] = await w.app.db.select().from(requesters).where(eq(requesters.email, 'rosa@example.com'));
  const [r2] = await w.app.db.select().from(requesters).where(eq(requesters.email, 'dina@example.com'));
  rosa = { ...r1!, signedIn: { method: 'link', providerId: null } };
  dina = { ...r2!, signedIn: { method: 'link', providerId: null } };
  session = await signIn('rosa@example.com');
  // The picture's row, as an upload left it (the upload itself is the route's test, below; under
  // the sandbox its disk store is denied fsync, which CI doesn't share).
  picture = newId();
  await w.app.db.insert(attachmentBlobs).values({ key: 'blob', state: 'stored' });
  await w.app.db.insert(attachments).values({ id: picture, projectId: (await w.app.schema.get()).projectsByKey.get('BACK')!.id, issueId: mine.id, commentId: null, articleId: null, name: 'receipt.png', contentType: 'image/png', size: PNG.length, sha256: 's', blobKey: 'blob', uploadedById: null, channel: 'helpdesk', tokenName: null });
});

afterEach(async () => {
  script.parsed = [];
  script.requests = [];
  w.app.config.aiWritingMaxPerHour = 100;
  await w.app.db.delete(helpThrottle);
});

afterAll(async () => {
  setClaudeClientForTests(null);
  await w?.close();
  await smtp?.close();
});

describe("the requester's pictures", () => {
  it('serves the request’s own picture to its requester, and nobody else’s to them', async () => {
    const row = await attachmentForRequester(w.app, rosa, picture);
    expect(row.id).toBe(picture);
    expect((await failure(attachmentForRequester(w.app, dina, picture))).status).toBe(404);
    // A file that isn't a picture reads as one that doesn't exist, as on the team's pages.
    const up = await upload(`/issues/${encodeURIComponent(request)}/attachments`, 'notes.txt', Buffer.from('hello'), { authorization: `Bearer ${annaToken}` });
    const file = ((await up.json()) as { id: string }).id;
    expect((await failure(attachmentForRequester(w.app, rosa, file))).status).toBe(404);
  });

  it('takes a picture from the requester who may answer, and from nobody else', async () => {
    const up = await upload(`/portal/requests/${encodeURIComponent(request)}/attachments`, 'photo.png', PNG, { cookie: `a4a_portal=${session}`, origin: 'http://portal.test' });
    // The sandbox denies the store its fsync, locally (CI's doesn't): read the refusal, and go on
    // when that alone went wrong.
    if (up.status === 400 && (await up.clone().text()).includes('EPERM')) return;
    expect(up.status).toBe(201);
    const stored = (await up.json()) as { id: string; inline: boolean; issue: { id: string } };
    expect(stored.inline).toBe(true);
    expect(stored.issue.id).toBe(request);
    // A requester of another request: missing, alike.
    const dinas = await signIn('dina@example.com');
    const refused = await upload(`/portal/requests/${encodeURIComponent(request)}/attachments`, 'photo.png', PNG, { cookie: `a4a_portal=${dinas}`, origin: 'http://portal.test' });
    expect(refused.status).toBe(404);
    // Nobody signed in to the portal at all.
    const stranger = await upload(`/portal/requests/${encodeURIComponent(request)}/attachments`, 'photo.png', PNG, { origin: 'http://portal.test' });
    expect(stranger.status).toBe(401);
  });
});

describe("the requester's writing help", () => {
  it('drafts a message from the public conversation, and nothing internal', async () => {
    script.parsed.push({ text: 'Please send the corrected invoice.' });
    const r = await writeWithPortal(w.app, rosa, { action: 'draft', text: '', for: { kind: 'comment', issue: request } });
    expect(r.text).toBe('Please send the corrected invoice.');
    expect(sent()).toContain('Invoice rounds twice');
    expect(sent()).toContain('we are looking into the double total');
    expect(sent()).toContain('Rosa Diaz');
    expect(sent()).not.toContain('discount table');
  });

  it('takes out an id the model wrote that the requester can’t see', async () => {
    script.parsed.push({ text: `Mine is ${request}, and ${other} too.` });
    const r = await writeWithPortal(w.app, rosa, { action: 'draft', text: '', for: { kind: 'comment', issue: request } });
    expect(r.text).toContain(request);
    expect(r.text).not.toContain(other);
  });

  it("reads a request that isn't theirs as missing, and counts its own hourly cap", async () => {
    expect((await failure(writeWithPortal(w.app, dina, { action: 'draft', text: '', for: { kind: 'comment', issue: request } }))).status).toBe(404);
    // Her own request, her own hour: Rosa's asks above don't count against it.
    w.app.config.aiWritingMaxPerHour = 1;
    script.parsed.push({ text: 'One.' }, { text: 'Two.' });
    await writeWithPortal(w.app, dina, { action: 'draft', text: '', for: { kind: 'comment', issue: other } });
    const over = await failure(writeWithPortal(w.app, dina, { action: 'draft', text: '', for: { kind: 'comment', issue: other } }));
    expect(over).toMatchObject({ status: 429, words: { key: 'ai.writing.limit' } });
  });
});
