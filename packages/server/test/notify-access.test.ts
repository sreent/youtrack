/**
 * Notifications, watching and the help desk under per-project access: a members-only project
 * stays hidden through them from whoever is outside it, whatever reaches a person is checked
 * against their own access, and a viewer can't use them to do what a viewer may not.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx, UserRow } from '../src/context';
import { activities, comments } from '../src/db/schema';
import { OutboxWorker } from '../src/events/worker';
import { helpdeskConsumer } from '../src/helpdesk/consumer';
import { createHttpApp } from '../src/http/app';
import { AppError } from '../src/lib/errors';
import { MailWorker } from '../src/mail/outbox';
import type { OutgoingMail } from '../src/mail/transport';
import { notifierConsumer } from '../src/notify/notifier';
import { setMailTransportForTests } from '../src/notify/state';
import { searchIssues } from '../src/search/service';
import { issueTokenFor } from '../src/services/auth';
import { addComment } from '../src/services/comments';
import { fileRequest, mintTrackingToken, replyToRequest, requestOf, trackRequest } from '../src/services/helpdesk';
import { createIssue, updateIssue } from '../src/services/issues';
import { linkIssues } from '../src/services/links';
import { addMember, removeMember } from '../src/services/members';
import { listNotifications, markNotifications, unreadCount } from '../src/services/notifications';
import { createProject, updateProject } from '../src/services/projects';
import { insertUser } from '../src/services/users';
import { listWatchers, unwatchIssue, watchIssue } from '../src/services/watchers';
import { toolByName } from '../src/tools/registry';
import { createWorld, type TestWorld } from './helpers';

const CODEWORD = 'okapiharbour';

let w: TestWorld;
let http: ReturnType<typeof createHttpApp>;
let outbox: OutboxWorker;
let mailer: MailWorker;
const sent: OutgoingMail[] = [];
let anna: Ctx; // a member of SECRET
let ben: Ctx; // outside it
let chloe: UserRow; // a member of SECRET, until she isn't
let admin: Ctx;
let secretId = '';
let secretUid = '';
let backId = '';
let benToken = '';

const as = (u: UserRow) => w.as(u);
const inbox = async (ctx: Ctx) => (await listNotifications(ctx, { limit: 100 })).items;
/** What the outbox would do next: notifications now, and their email once it's due. */
const flush = () => outbox.drain();
const send = () => mailer.drain();

/** What an error says, with one id put back as a placeholder, to compare "hidden" with "missing". */
async function failure(p: Promise<unknown>, word?: string): Promise<{ status: number; code: string; message: string; hint?: string }> {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    const strip = (t?: string) => (word && t ? t.split(word).join('<X>') : t);
    return { status: e.status, code: e.code, message: strip(e.message)!, hint: strip(e.hint) };
  }
  throw new Error('expected it to fail');
}

async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await http.request(`/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text: text.split(secretId).join('<X>').split('BACK-999').join('<X>') };
}

const run = async (ctx: Ctx, name: string, input: Record<string, unknown>) => {
  const tool = toolByName(name)!;
  return tool.run(ctx, tool.input.parse(input) as never);
};

beforeAll(async () => {
  w = await createWorld();
  setMailTransportForTests(w.app, { send: async (m) => void sent.push(m) });
  http = createHttpApp(w.app);
  admin = w.adminCtx;
  anna = as(w.anna);
  ben = as(w.ben);
  chloe = await insertUser(w.app.db, { login: 'chloe.m', name: 'Chloé Martin', email: 'chloe@example.com' });
  w.app.schema.invalidate();
  await createProject(admin, { key: 'SECRET', name: 'Merger', template: 'software', visibility: 'members' });
  await addMember(admin, 'SECRET', { user: 'anna', role: 'member' });
  await addMember(admin, 'SECRET', { user: 'chloe.m', role: 'member' });
  outbox = new OutboxWorker(w.app, [notifierConsumer(w.app), helpdeskConsumer(w.app)], {}, [], () => {});
  await outbox.drain(); // the consumers start from here
  mailer = new MailWorker(w.app, () => new Date(Date.now() + 10 * 60_000));
  benToken = (await issueTokenFor(w.app.db, w.ben.id, { name: 'ben', scopes: ['read', 'write'] })).token;
});

afterAll(async () => {
  setMailTransportForTests(w.app, null);
  await w?.close();
});

describe('a members-only project, through notifications and watching', () => {
  it('tells nobody outside it, even someone mentioned, and nobody watches it for them', async () => {
    const secret = await createIssue(anna, { project: 'SECRET', summary: `Acquire Initech ${CODEWORD}`, description: 'Ask @ben and @chloe.m' });
    secretId = secret.id;
    secretUid = secret.uid;
    await addComment(anna, secretId, `@ben, the ${CODEWORD} numbers are in`);
    await flush();
    expect((await listWatchers(anna, secretId)).watchers.map((x) => x.user.login).sort()).toEqual(['anna', 'chloe.m']);
    expect(await inbox(ben)).toEqual([]);
    expect(await unreadCount(ben)).toBe(0);
    expect((await inbox(as(chloe))).map((n) => [n.issue.id, n.kind])).toEqual([[secretId, 'mentioned']]);
    // Its events name only whom they concern: people who can see the project.
    const rows = await w.app.db.select().from(activities).where(eq(activities.issueId, secretUid));
    const told = rows.map((r) => (r.payload as { data?: { mentions?: string[] } }).data?.mentions ?? []);
    expect(told.flat()).toEqual(['chloe.m']);
  });

  it('tells a watcher of a link only when they can see the issue at its other end', async () => {
    const back = await createIssue(ben, { project: 'BACK', summary: 'Rate limit the public API' });
    backId = back.id;
    await watchIssue(as(chloe), backId);
    await flush();
    await linkIssues(anna, backId, 'relates to', secretId);
    await flush();
    expect((await inbox(ben)).map((n) => n.issue.id)).not.toContain(backId);
    const chloes = (await inbox(as(chloe))).find((n) => n.issue.id === backId);
    expect(chloes?.events.map((e) => e.type)).toEqual(['link.created']);
    // A change ben can see still reaches him, and says nothing of the link.
    await updateIssue(anna, backId, { summary: 'Rate limit the public API per token' });
    await flush();
    const bens = (await inbox(ben)).find((n) => n.issue.id === backId);
    expect(bens?.events.map((e) => e.type)).toEqual(['issue.updated']);
    expect(JSON.stringify(await inbox(ben))).not.toContain('SECRET');
  });

  it('answers for its issues exactly as for missing ones', async () => {
    const same = async (f: (issue: string) => Promise<unknown>) => expect(await failure(f(secretId), secretId)).toEqual(await failure(f('BACK-999'), 'BACK-999'));
    await same((i) => listWatchers(ben, i));
    await same((i) => watchIssue(ben, i));
    await same((i) => unwatchIssue(ben, i));
    await same((i) => listNotifications(ben, { issue: i }));
    await same((i) => markNotifications(ben, { issue: i }));
    await same((i) => requestOf(ben, i));
    await same((i) => run(ben, 'watch_issue', { issue: i }));
    await same((i) => run(ben, 'unwatch_issue', { issue: i }));
    await same((i) => run(ben, 'list_watchers', { issue: i }));
    for (const [method, path] of [
      ['GET', '/issues/<id>/watchers'],
      ['PUT', '/issues/<id>/watchers/me'],
      ['DELETE', '/issues/<id>/watchers/me'],
      ['GET', '/issues/<id>/request'],
      ['GET', '/notifications?issue=<id>'],
    ] as const) {
      const hidden = await call(benToken, method, path.replace('<id>', secretId));
      const missing = await call(benToken, method, path.replace('<id>', 'BACK-999'));
      expect(hidden.status, `${method} ${path}`).toBe(404);
      expect(hidden).toEqual(missing);
    }
    expect(JSON.stringify((await run(ben, 'list_notifications', {})).data)).not.toContain(CODEWORD);
    expect(await watchIssue(anna, secretId)).toMatchObject({ watching: true });
  });

  it('finds none of it through watcher:, has: watchers, sla: or has: request', async () => {
    for (const q of ['watcher: me', 'watcher: anna', 'has: watchers', 'has: request', 'sla: due', `${CODEWORD} watcher: anna`]) {
      expect(JSON.stringify((await searchIssues(ben, q)).items), q).not.toContain('SECRET');
    }
    expect((await searchIssues(anna, `watcher: me ${CODEWORD}`)).items.map((i) => i.id)).toEqual([secretId]);
  });

  it('forgets it for someone who loses sight of it: their inbox, its email, its watchers', async () => {
    await removeMember(admin, 'SECRET', 'chloe.m');
    // Her notification from SECRET is gone from her inbox; the link on BACK no longer shows.
    expect((await inbox(as(chloe))).map((n) => n.issue.id)).not.toContain(secretId);
    const onBack = (await inbox(as(chloe))).find((n) => n.issue.id === backId);
    expect(onBack?.events.map((e) => e.type)).toEqual(['issue.updated']);
    // Its email, queued while she could see it, isn't sent now.
    await send();
    expect(sent.filter((m) => m.to === 'chloe@example.com').map((m) => m.subject)).toEqual([]);
    expect(sent.some((m) => m.text.includes(CODEWORD) && m.to !== 'anna@example.com')).toBe(false);
    // She watched it; she isn't listed, and isn't told of what comes next.
    expect((await listWatchers(anna, secretId)).watchers.map((x) => x.user.login)).toEqual(['anna']);
    await addComment(as(w.admin), secretId, `Signed, ${CODEWORD}`);
    await flush();
    expect((await inbox(as(chloe))).map((n) => n.issue.id)).not.toContain(secretId);
    expect((await listNotifications(as(chloe), { limit: 100 })).total).toBe((await inbox(as(chloe))).length);
  });
});

describe('a help desk on a members-only project', () => {
  it('files and answers requests there, and tells only its people', async () => {
    await updateProject(admin, 'SECRET', { lead: 'anna', settings: { helpdesk: { enabled: true, firstResponseHours: 2 } } });
    await flush();
    const before = (await inbox(ben)).length;
    await fileRequest(w.app, 'SECRET', { name: 'Jo Public', email: 'jo@example.com', summary: `Where is my ${CODEWORD}?`, description: 'Hello' });
    await flush();
    const [request] = (await searchIssues(anna, `project: SECRET has: request ${CODEWORD}`)).items;
    expect(request).toBeDefined();
    // The lead hears of it; nobody outside does.
    expect((await inbox(anna)).filter((n) => n.issue.id === request!.id).map((n) => n.kind)).toEqual(['request']);
    expect((await inbox(ben)).length).toBe(before);
    // The requester's reply goes in through the help desk's agent, which reaches this project only.
    const token = await mintTrackingToken(w.app.db, request!.uid);
    await replyToRequest(w.app, token, 'Any news?');
    await flush();
    expect((await trackRequest(w.app, token)).messages.map((m) => [m.from, m.text])).toEqual([['you', 'Any news?']]);
    expect((await inbox(anna)).find((n) => n.issue.id === request!.id)?.eventCount).toBe(2);
    expect(await failure(requestOf(ben, request!.id), request!.id)).toEqual(await failure(requestOf(ben, 'BACK-999'), 'BACK-999'));
  });
});

describe('a viewer, through notifications and the help desk', () => {
  let vic: Ctx;
  let vicToken = '';
  let requestId = '';

  beforeAll(async () => {
    const u = await insertUser(w.app.db, { login: 'vic', name: 'Vic Viewer', email: 'vic@example.com' });
    w.app.schema.invalidate();
    await addMember(admin, 'BACK', { user: 'vic', role: 'viewer' });
    vic = as(u);
    vicToken = (await issueTokenFor(w.app.db, u.id, { name: 'vic', scopes: ['read', 'write'] })).token;
    await updateProject(admin, 'BACK', { settings: { helpdesk: { enabled: true } } });
    await fileRequest(w.app, 'BACK', { name: 'Sam Public', email: 'sam@example.com', summary: 'The export is empty', description: '' });
    await flush();
    requestId = (await searchIssues(admin, 'project: BACK has: request')).items[0]!.id;
  });

  it('may watch, and comment for the team', async () => {
    expect(await watchIssue(vic, requestId)).toMatchObject({ watching: true });
    expect((await addComment(vic, requestId, 'Seen this before')).visibility).toBe('internal');
    expect(await unwatchIssue(vic, requestId)).toMatchObject({ watching: false });
  });

  it("can't answer the requester, by any channel: that's for who may change the issue", async () => {
    expect((await failure(addComment(vic, requestId, 'Fixed!', { visibility: 'public' }))).status).toBe(403);
    expect((await failure(run(vic, 'add_comment', { issue: requestId, text: 'Fixed!', public: true }))).status).toBe(403);
    const rest = await call(vicToken, 'POST', `/issues/${requestId}/comments`, { text: 'Fixed!', visibility: 'public' });
    expect(rest.status).toBe(403);
    const publicOnes = await w.app.db.select().from(comments).where(and(eq(comments.visibility, 'public'), eq(comments.text, 'Fixed!')));
    expect(publicOnes).toEqual([]);
    // A member may.
    expect((await addComment(as(w.ben), requestId, 'Fixed in 1.2', { visibility: 'public' })).visibility).toBe('public');
  });

  it("can't set up the help desk, which is its managers'", async () => {
    expect((await failure(updateProject(vic, 'BACK', { settings: { helpdesk: { enabled: false } } }))).status).toBe(403);
    expect((await call(vicToken, 'PATCH', '/projects/BACK', { settings: { helpdesk: { intro: 'Go away' } } })).status).toBe(403);
    expect((await failure(updateProject(ben, 'BACK', { settings: { helpdesk: { enabled: false } } }))).status).toBe(403);
    // Its lead manages it.
    await updateProject(admin, 'BACK', { lead: 'anna' });
    expect((await updateProject(anna, 'BACK', { settings: { helpdesk: { intro: 'Ask us' } } })).settings.helpdesk.intro).toBe('Ask us');
  });

  it("marks only its own notifications, and a token limited to other projects marks none of SECRET's", async () => {
    const web = (await w.app.schema.get()).projectsByKey.get('WEB')!;
    const limited = (await issueTokenFor(w.app.db, w.anna.id, { name: 'web only', scopes: ['read', 'write'], projectIds: [web.id] })).token;
    const unreadBefore = await unreadCount(anna);
    const res = await call(limited, 'POST', '/notifications/read', { all: true });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({ changed: 0 });
    expect(await unreadCount(anna)).toBe(unreadBefore);
  });
});
