/**
 * CCs on help desk requests (D57): who an email's Cc copies, and who it never does; the cap, under
 * concurrency too; the team's public replies reaching each CC in an email of their own, and nothing
 * internal; a CC's answer by email becoming their public comment, cut from what it quotes; forged
 * and stale senders refused; stopping from the email's link; the portal; access.
 */
import { REQUEST_CCS_MAX } from '@a4a/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemCtx } from '../src/app-services';
import type { Ctx, UserRow } from '../src/context';
import { helpdeskInbound, issues, requestCcs, requesters, users } from '../src/db/schema';
import { OutboxWorker } from '../src/events/worker';
import { helpdeskConsumer } from '../src/helpdesk/consumer';
import { receiveMail } from '../src/helpdesk/inbound';
import { createHttpApp } from '../src/http/app';
import { MailWorker } from '../src/mail/outbox';
import { notifierConsumer } from '../src/notify/notifier';
import { issueActivity } from '../src/services/activity';
import { addComment, listComments } from '../src/services/comments';
import { requestOf, trackRequest } from '../src/services/helpdesk';
import { newMailSecret, setDeskAddress } from '../src/services/helpdesk-mail';
import { createIssue } from '../src/services/issues';
import { applyUnsubscribe, describeUnsubscribe } from '../src/services/notifications';
import { portalCopy, portalReply, portalRequest, portalRequests } from '../src/services/portal';
import { updateProject } from '../src/services/projects';
import { addCc, listCcs, removeCc } from '../src/services/request-ccs';
import { projectByKey, type ProjectRow } from '../src/services/schema-cache';
import { createWorld, type TestWorld } from './helpers';
import { fakeSmtp, type FakeSmtp } from './smtp';

const BASE = 'http://desk.test';
const DESK = 'support@desk.test';

let w: TestWorld;
let smtp: FakeSmtp;
let http: ReturnType<typeof createHttpApp>;
let outbox: OutboxWorker;
let mailer: MailWorker;
let back: ProjectRow;
let serial = 0;

const as = (u: UserRow): Ctx => systemCtx(w.app, u, 'web');

function message(opts: { from: string; to?: string; cc?: string; subject: string; body: string; headers?: string[]; inReplyTo?: string; id?: string }): Buffer {
  return Buffer.from(
    [
      `From: ${opts.from}`,
      `To: ${opts.to ?? DESK}`,
      ...(opts.cc ? [`Cc: ${opts.cc}`] : []),
      `Subject: ${opts.subject}`,
      `Message-ID: <${opts.id ?? `cc${Date.now().toString(36)}${++serial}`}@mail.example.com>`,
      ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`, `References: ${opts.inReplyTo}`] : []),
      ...(opts.headers ?? []),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      opts.body,
      '',
    ].join('\r\n'),
  );
}

async function flush() {
  await outbox.drain();
  await mailer.drain();
}

const mailIn = (raw: Buffer) => receiveMail(w.app, raw, { via: 'webhook', desk: back });

async function issueOf(summary: string) {
  const [row] = await w.app.db.select().from(issues).where(eq(issues.summary, summary));
  if (!row) throw new Error(`no issue "${summary}"`);
  return row;
}

const mailsTo = (address: string) => smtp.messages.filter((m) => m.to.includes(address));
const newestTo = (address: string) => {
  const m = mailsTo(address).at(-1);
  if (!m) throw new Error(`nothing mailed to ${address}`);
  return { subject: m.headers.get('subject') ?? '', replyTo: m.headers.get('reply-to') ?? '', unsubscribe: m.headers.get('list-unsubscribe') ?? '', text: m.text, messageId: m.headers.get('message-id') ?? '' };
};

async function api(method: string, path: string, user: UserRow, body?: unknown) {
  const token = (await (await import('../src/services/auth')).issueTokenFor(w.app.db, user.id, { name: `t${++serial}`, scopes: ['read', 'write'] })).token;
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await http.request(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  smtp = await fakeSmtp();
  w = await createWorld({ config: { smtpUrl: smtp.url, publicUrl: BASE, mailFrom: 'a4a <a4a@desk.test>', notifyWindowMs: 60_000, trustProxy: 1 } });
  await w.app.db.update(users).set({ email: 'anna@example.com' }).where(eq(users.id, w.anna.id));
  w.app.schema.invalidate();
  await updateProject(w.adminCtx, 'BACK', { lead: 'anna', settings: { helpdesk: { enabled: true, firstResponseHours: 4, intro: '' } } });
  await setDeskAddress(w.adminCtx, 'BACK', DESK);
  await newMailSecret(w.adminCtx, 'BACK');
  back = projectByKey(await w.app.schema.get(), 'BACK')!;
  http = createHttpApp(w.app);
  outbox = new OutboxWorker(w.app, [notifierConsumer(w.app), helpdeskConsumer(w.app)], {}, [], () => {});
  await outbox.drain();
  mailer = new MailWorker(w.app, () => new Date(Date.now() + 10 * 60_000));
});

afterAll(async () => {
  await w?.close();
  await smtp?.close();
});

describe('CCs on a help desk request', () => {
  let id = '';
  let uid = '';
  const first = 'printer-first';

  it("copies the people in the Cc of the requester's email, and never a4a's own, the team's, or a no-reply address", async () => {
    const got = await mailIn(
      message({
        id: first,
        from: 'Jane Doe <jane@example.com>',
        cc: `"Alice Ames" <Alice@Example.org>, bob@example.org, ${DESK}, support+abcdefghijklmnopqrstuvwxyz@desk.test, a4a@desk.test, anna@example.com, no-reply@shop.example, jane@example.com`,
        subject: 'The printer on floor 3 jams',
        body: 'It jams on every second page.\n\n-- \nJane',
      }),
    );
    expect(got.outcome).toBe('request');
    expect(got.reason).toContain('a new request; copied alice@example.org, bob@example.org');
    expect(got.reason).toContain('left out of its Cc');
    expect(got.reason).toContain('anna@example.com (someone on the team)');
    const issue = await issueOf('The printer on floor 3 jams');
    uid = issue.id;
    id = `BACK-${issue.number}`;
    const ccs = await listCcs(w.adminCtx, id);
    expect(ccs.map((c) => [c.email, c.name, c.via, c.addedBy])).toEqual([
      ['alice@example.org', 'Alice Ames', 'email', null],
      ['bob@example.org', '', 'email', null],
    ]);
    // The history says who copied whom, through the help desk, for the requester.
    const history = (await issueActivity(w.adminCtx, id)).filter((e) => e.type === 'request.cc_added');
    expect(history.map((e) => [e.actor.channel, e.data])).toEqual([
      ['helpdesk', { cc: { email: 'alice@example.org', name: 'Alice Ames' }, via: 'email', requester: { name: 'Jane Doe' } }],
      ['helpdesk', { cc: { email: 'bob@example.org', name: '' }, via: 'email', requester: { name: 'Jane Doe' } }],
    ]);
    // They aren't sent the requester's acknowledgement: only what the team says from now on.
    await flush();
    expect(mailsTo('alice@example.org')).toHaveLength(0);
    expect(newestTo('jane@example.com').subject).toBe('Re: The printer on floor 3 jams');
  });

  it("doesn't copy from mail no person wrote, nor from anyone but the requester", async () => {
    const ack = newestTo('jane@example.com');
    const away = await mailIn(message({ from: 'jane@example.com', to: ack.replyTo, cc: 'carl@example.org', subject: 'Automatic reply', body: 'Away.', headers: ['Auto-Submitted: auto-replied'] }));
    expect(away).toMatchObject({ outcome: 'ignored', reason: 'an automatic reply' });
    expect((await listCcs(w.adminCtx, id)).map((c) => c.email)).not.toContain('carl@example.org');
  });

  it('sends each public reply to everyone copied, in an email of their own, and nothing internal', async () => {
    const before = mailsTo('bob@example.org').length;
    await addComment(as(w.anna), id, 'Internal: the fuser is worn.', { visibility: 'internal' });
    await addComment(as(w.anna), id, 'We have ordered a new fuser; it comes on Thursday.', { visibility: 'public' });
    await flush();
    expect(mailsTo('bob@example.org')).toHaveLength(before + 1);
    const alice = newestTo('alice@example.org');
    expect(alice.subject).toBe('Re: The printer on floor 3 jams');
    expect(alice.text).toContain("Anna Schmidt replied to Jane Doe's request.");
    expect(alice.text).toContain('We have ordered a new fuser');
    expect(alice.text).not.toContain('fuser is worn');
    expect(alice.text).toContain(`${BASE}/portal?request=${id}`);
    // Never the requester's tracking link, which speaks in the requester's name.
    expect(alice.text).not.toContain('/request#');
    expect(alice.replyTo).toMatch(/^support\+[a-z2-7]{26}@desk\.test$/);
    expect(alice.replyTo).not.toBe(newestTo('bob@example.org').replyTo);
    expect(alice.unsubscribe).toContain('/api/v1/unsubscribe?token=cc.');
    expect(newestTo('jane@example.com').text).toContain('We have ordered a new fuser');
  });

  it("takes a CC's answer by email as their public comment, cut from what it quotes, without counting as the team's", async () => {
    const alice = newestTo('alice@example.org');
    const raw = message({
      from: 'Alice Ames <alice@example.org>',
      to: alice.replyTo,
      cc: 'dora@example.org',
      subject: 'Re: The printer on floor 3 jams',
      body: 'Thursday works. I can let the technician in.\n\nOn Tue, 17 Nov 2026 at 10:02, a4a <a4a@desk.test> wrote:\n> We have ordered a new fuser',
    });
    const got = await mailIn(raw);
    expect(got).toMatchObject({ outcome: 'reply', reason: 'a reply by its reply address, from someone copied on it' });
    const last = (await listComments(w.adminCtx, id)).at(-1)!;
    expect(last).toMatchObject({ text: 'Thursday works. I can let the technician in.', visibility: 'public', requester: { name: 'Alice Ames', copied: true }, author: { login: 'helpdesk' } });
    // A requester account for that address, as the portal makes them.
    const [account] = await w.app.db.select().from(requesters).where(eq(requesters.email, 'alice@example.org'));
    expect(account?.name).toBe('Alice Ames');
    // Only the requester's own messages copy people.
    expect((await listCcs(w.adminCtx, id)).map((c) => c.email)).not.toContain('dora@example.org');
    // Customer's side: the team's first response is still the team's reply.
    const r = await requestOf(w.adminCtx, id);
    expect(r.firstResponse.state).toBe('met');
    // The requester's page shows it as someone copied, by name, never as theirs.
    await flush();
    const tracked = await trackRequest(w.app, (/\/request#(hdt_[A-Za-z0-9_-]{43})/.exec(newestTo('jane@example.com').text) ?? [])[1]);
    expect(tracked.messages.at(-1)).toMatchObject({ from: 'cc', name: 'Alice Ames' });
    // What a CC writes isn't sent on: a4a emails people outside the team only the team's words.
    expect(mailsTo('bob@example.org').some((m) => m.text.includes('Thursday works'))).toBe(false);
  });

  it('refuses a reply from an address that isn’t copied, or isn’t whom the reply address was for, and tells nobody', async () => {
    const alice = newestTo('alice@example.org');
    const before = (await listComments(w.adminCtx, id)).length;
    const sent = smtp.messages.length;
    const forged = await mailIn(message({ from: 'mallory@example.net', to: alice.replyTo, subject: 'Re: The printer', body: 'Cancel the order.' }));
    expect(forged).toMatchObject({ outcome: 'refused', reason: 'a reply by its reply address, sent from an address it wasn’t sent to' });
    // Not even the requester or another CC speaks through Alice's address.
    const bobThere = await mailIn(message({ from: 'bob@example.org', to: alice.replyTo, subject: 'Re: The printer', body: 'Me too.' }));
    expect(bobThere.outcome).toBe('refused');
    // Answering the first message, someone not on it files a request of their own; a CC answers.
    const stranger = await mailIn(message({ from: 'erin@example.net', subject: 'Re: The printer on floor 3 jams', body: 'Ours too.', inReplyTo: `<${first}@mail.example.com>` }));
    expect(stranger.outcome).toBe('request');
    const bob = await mailIn(message({ from: 'bob@example.org', subject: 'Re: The printer on floor 3 jams', body: 'Floor 4 has a spare.', inReplyTo: `<${first}@mail.example.com>` }));
    expect(bob).toMatchObject({ outcome: 'reply', reason: 'a reply answering its first message, from someone copied on it' });
    await flush();
    expect((await listComments(w.adminCtx, id)).length).toBe(before + 1);
    expect(smtp.messages.slice(sent).filter((m) => m.to.includes('mallory@example.net'))).toHaveLength(0);
  });

  it("takes someone off from their email's unsubscribe link: their answers are refused, and an email's Cc doesn't copy them again", async () => {
    const bob = newestTo('bob@example.org');
    const token = decodeURIComponent(/token=([^>\s]+)/.exec(bob.unsubscribe)![1]!);
    expect(await describeUnsubscribe(w.app, token)).toMatchObject({ kind: 'cc', done: false });
    // Opening the link changes nothing; the POST does, and twice is once.
    expect((await listCcs(w.adminCtx, id)).map((c) => c.email)).toContain('bob@example.org');
    expect(await applyUnsubscribe(w.app, token)).toMatchObject({ kind: 'cc', done: true });
    expect(await applyUnsubscribe(w.app, token)).toMatchObject({ kind: 'cc', done: true });
    expect((await listCcs(w.adminCtx, id)).map((c) => c.email)).toEqual(['alice@example.org']);
    const removed = (await issueActivity(w.adminCtx, id)).filter((e) => e.type === 'request.cc_removed');
    expect(removed.map((e) => e.data)).toEqual([{ cc: { email: 'bob@example.org', name: '' }, via: 'unsubscribe', requester: { name: 'bob@example.org' } }]);

    const late = await mailIn(message({ from: 'bob@example.org', to: bob.replyTo, subject: 'Re: x', body: 'One more thing.' }));
    expect(late).toMatchObject({ outcome: 'refused', reason: 'a reply by its reply address, from someone no longer copied on it' });
    const jane = newestTo('jane@example.com');
    const again = await mailIn(message({ from: 'jane@example.com', to: jane.replyTo, cc: 'bob@example.org, dora@example.org', subject: 'Re: x', body: 'Adding Dora.' }));
    expect(again.reason).toContain('copied dora@example.org');
    expect(again.reason).toContain('bob@example.org (taken off it before)');
    const before = mailsTo('bob@example.org').length;
    await addComment(as(w.anna), id, 'The technician comes at nine.', { visibility: 'public' });
    await flush();
    expect(mailsTo('bob@example.org')).toHaveLength(before);
    expect(newestTo('dora@example.org').text).toContain('The technician comes at nine.');
    // Nor may the requester, on the portal; the team may.
    const [jane2] = await w.app.db.select().from(requesters).where(eq(requesters.email, 'jane@example.com'));
    await expect(portalCopy(w.app, jane2!, id, { email: 'bob@example.org' })).rejects.toMatchObject({ status: 409, words: { key: 'requestCcs.theyStopped' } });
    expect((await addCc(as(w.anna), id, { email: 'bob@example.org' })).map((c) => c.email)).toContain('bob@example.org');
  });

  it('lets the team copy and take off on the API, which says why it won’t, in words and keys', async () => {
    const added = await api('POST', `/issues/${id}/request/ccs`, w.anna, { email: 'gus@example.org', name: 'Gus' });
    expect(added.status).toBe(200);
    expect(added.body.at(-1)).toMatchObject({ email: 'gus@example.org', name: 'Gus', via: 'team', addedBy: { login: 'anna' } });
    expect((await api('POST', `/issues/${id}/request/ccs`, w.anna, { email: 'gus@example.org' })).status).toBe(200);
    const own = await api('POST', `/issues/${id}/request/ccs`, w.anna, { email: DESK });
    expect(own.status).toBe(400);
    expect(own.body.error.key).toBe('requestCcs.ownAddress');
    expect((await api('POST', `/issues/${id}/request/ccs`, w.anna, { email: 'jane@example.com' })).body.error.key).toBe('requestCcs.requesterAddress');
    expect((await api('POST', `/issues/${id}/request/ccs`, w.anna, { email: 'noreply@example.org' })).body.error.key).toBe('requestCcs.notAnAddress');
    expect((await api('POST', `/issues/${id}/request/ccs`, w.anna, { email: 'not an address' })).status).toBe(400);
    // A viewer reads who is copied, and copies nobody.
    expect((await api('GET', `/issues/${id}/request/ccs`, w.viewer)).body.map((c: { email: string }) => c.email)).toContain('gus@example.org');
    expect((await api('POST', `/issues/${id}/request/ccs`, w.viewer, { email: 'hal@example.org' })).status).toBe(403);
    const off = await api('DELETE', `/issues/${id}/request/ccs?email=GUS@example.org`, w.anna);
    expect(off.status).toBe(200);
    expect(off.body.map((c: { email: string }) => c.email)).not.toContain('gus@example.org');
    expect((await api('DELETE', `/issues/${id}/request/ccs?email=gus@example.org`, w.anna)).status).toBe(200);
    expect((await issueActivity(w.adminCtx, id)).filter((e) => e.type === 'request.cc_removed').at(-1)).toMatchObject({ actor: { login: 'anna' }, data: { via: 'team' } });
    // An issue that's no request, and one the caller can't see, answer as missing.
    const plain = await createIssue(w.adminCtx, { project: 'BACK', summary: 'Not a request' });
    expect((await api('GET', `/issues/${plain.id}/request/ccs`, w.anna)).body.error.key).toBe('helpdesk.requestNotFound');
    await updateProject(w.adminCtx, 'BACK', { visibility: 'members' });
    try {
      expect((await api('POST', `/issues/${id}/request/ccs`, w.ben, { email: 'x@example.org' })).status).toBe(404);
    } finally {
      await updateProject(w.adminCtx, 'BACK', { visibility: 'open' });
    }
  });

  it(`copies at most ${REQUEST_CCS_MAX}, also when people are copied at once`, async () => {
    const have = (await listCcs(w.adminCtx, id)).length;
    for (let i = have; i < REQUEST_CCS_MAX - 1; i++) await addCc(as(w.anna), id, { email: `p${i}@example.org` });
    const racing = await Promise.allSettled(['r1', 'r2', 'r3', 'r4'].map((n) => addCc(as(w.anna), id, { email: `${n}@example.org` })));
    expect(racing.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = racing.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ status: 409, words: { key: 'requestCcs.full', values: { max: REQUEST_CCS_MAX } } });
    expect((await listCcs(w.adminCtx, id)).length).toBe(REQUEST_CCS_MAX);
    // An email's Cc past the cap is left out, and the log says so.
    const jane = newestTo('jane@example.com');
    const over = await mailIn(message({ from: 'jane@example.com', to: jane.replyTo, cc: 'zed@example.org', subject: 'Re: x', body: 'And Zed.' }));
    expect(over.reason).toContain(`zed@example.org (it copies ${REQUEST_CCS_MAX} already)`);
    const [logged] = await w.app.db.select().from(helpdeskInbound).where(eq(helpdeskInbound.commentId, over.commentId!));
    expect(logged?.reason).toContain('zed@example.org');
  });

  it("shows a CC the request on the portal, where they reply; only its requester copies others", async () => {
    const [alice] = await w.app.db.select().from(requesters).where(eq(requesters.email, 'alice@example.org'));
    const [jane] = await w.app.db.select().from(requesters).where(eq(requesters.email, 'jane@example.com'));
    const list = await portalRequests(w.app, alice!);
    expect(list.find((r) => r.id === id)).toMatchObject({ copied: true, requester: { name: 'Jane Doe', mine: false } });
    const seen = await portalRequest(w.app, alice!, id);
    expect(seen.ccs).toBeNull();
    expect(seen.messages.map((m) => m.text)).not.toContain('Internal: the fuser is worn.');
    expect((await portalReply(w.app, alice!, id, 'The technician has been.')).messages.at(-1)).toMatchObject({ from: 'you' });
    await expect(portalCopy(w.app, alice!, id, { email: 'ivy@example.org' })).rejects.toMatchObject({ status: 403 });
    // Its requester sees the list, and who copied whom.
    const theirs = await portalRequest(w.app, jane!, id);
    expect(theirs.messages.at(-1)).toMatchObject({ from: 'cc', name: 'Alice Ames' });
    expect(theirs.ccs?.find((c) => c.email === 'alice@example.org')).toMatchObject({ byYou: true });
    // Taken off, they see it no longer, alike with one that doesn't exist.
    await removeCc(as(w.anna), id, 'alice@example.org');
    await expect(portalRequest(w.app, alice!, id)).rejects.toMatchObject({ status: 404, words: { key: 'portal.noRequestHere' } });
    // Its requester may copy anyone again, the team's choice to take them off notwithstanding.
    await removeCc(as(w.anna), id, 'p1@example.org');
    expect((await portalCopy(w.app, jane!, id, { email: 'Alice@example.org', name: 'Alice' })).ccs?.find((c) => c.email === 'alice@example.org')).toMatchObject({ byYou: true });
    const [row] = await w.app.db.select().from(requestCcs).where(and(eq(requestCcs.issueId, uid), eq(requestCcs.email, 'alice@example.org')));
    expect(row).toMatchObject({ via: 'portal', removedAt: null });
    // A guest isn't told who is copied, as they aren't told who asked.
    expect((await issueActivity(w.adminCtx, id)).some((e) => e.type === 'request.cc_added')).toBe(true);
  });
});
