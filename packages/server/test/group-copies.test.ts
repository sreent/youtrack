/**
 * A customer group's copies (D56's revisit): only of the requests the group shares with its people;
 * kept current as each email is sent, wherever copies are listed, and in D67's relay; emails that say
 * it's because of the group and how replying works for them; a stop that matches the reason (the
 * group, not one request), twice the same as once, and a portal switch that turns later ones back
 * on; who is copied past the desk's cap decided, not chance; and a stop and a request filed at the
 * same moment taking turns.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemCtx } from '../src/app-services';
import type { Ctx, UserRow } from '../src/context';
import type { Db } from '../src/db/client';
import { activities, issues, requestCcs, requesters, users } from '../src/db/schema';
import { OutboxWorker } from '../src/events/worker';
import { helpdeskConsumer } from '../src/helpdesk/consumer';
import { receiveMail } from '../src/helpdesk/inbound';
import { relayConsumer } from '../src/helpdesk/relay';
import { createHttpApp } from '../src/http/app';
import { MailWorker } from '../src/mail/outbox';
import { notifierConsumer } from '../src/notify/notifier';
import { addComment, listComments } from '../src/services/comments';
import { addGroupMember, createCustomerGroup, listCustomerGroups, listGroupCopyStops, removeGroupMember, requesterByEmail, updateCustomerGroup } from '../src/services/customer-groups';
import { openRequest, requestOf, updateRequest } from '../src/services/helpdesk';
import { newMailSecret, setDeskAddress } from '../src/services/helpdesk-mail';
import { updateIssue } from '../src/services/issues';
import { portalReply, portalRequest } from '../src/services/portal';
import { startPortalSession } from '../src/services/portal-sign-in';
import { updateProject } from '../src/services/projects';
import { copyGroupMembers, stopGroupCopies } from '../src/services/request-ccs';
import { projectByKey } from '../src/services/schema-cache';
import { createWorld, type TestWorld } from './helpers';
import { fakeSmtp, type FakeSmtp } from './smtp';

const BASE = 'http://copies.test';
const DESK = 'support@desk.test';

let w: TestWorld;
let smtp: FakeSmtp;
let http: ReturnType<typeof createHttpApp>;
let outbox: OutboxWorker;
let mailer: MailWorker;
let serial = 0;

const as = (u: UserRow): Ctx => systemCtx(w.app, u, 'web');
const desk = async () => projectByKey(await w.app.schema.get(), 'BACK')!;
const ask = async (email: string, summary: string, more: { private?: boolean } = {}) =>
  openRequest(w.app, await desk(), { name: email.split('@')[0]!, email, summary, description: '', via: 'form', ...more });
const reply = (id: string, text: string) => addComment(as(w.anna), id, text, { visibility: 'public' });
const copies = async (uid: string) => (await w.app.db.select().from(requestCcs).where(eq(requestCcs.issueId, uid))).sort((a, b) => a.addedAt.getTime() - b.addedAt.getTime());
const active = async (uid: string) => (await copies(uid)).filter((c) => !c.removedAt).map((c) => c.email);
const copiesIvy = async (uid: string) => (await active(uid)).includes('ivy@six.example');
const mailsTo = (address: string, words?: string) => smtp.messages.filter((m) => m.to.includes(address) && (!words || m.text.includes(words)));
const group = async (name: string, sharing: 'none' | 'read' | 'comment', domains: string[]) => createCustomerGroup(w.adminCtx, 'BACK', { name, domains, sharing });
const viewer = async (email: string) => ({ ...(await requesterByEmail(w.app.db, email)), signedIn: { method: 'link' as const, providerId: null } });
/** Every event so far through the consumers, queueing what they mail. */
async function queue() {
  await outbox.drain();
}
async function flush() {
  await queue();
  await mailer.drain();
}

/** An email answering one a4a sent (In-Reply-To its Message-ID), to the address given. */
function answer(from: string, to: string, inReplyTo: string, body: string): Buffer {
  return Buffer.from(
    [`From: ${from}`, `To: ${to}`, 'Subject: Re: it', `Message-ID: <copies${++serial}@mail.example.com>`, `In-Reply-To: ${inReplyTo}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body, ''].join('\r\n'),
  );
}
const mailIn = async (raw: Buffer) => receiveMail(w.app, raw, { via: 'webhook', desk: await desk() });

/** A call to the API as a requester signed in to the portal, from its own page; or with no session at all. */
async function api(method: string, path: string, requesterId: string | null, body?: unknown) {
  const headers: Record<string, string> = { origin: BASE };
  if (requesterId) headers.cookie = `a4a_portal=${await startPortalSession(w.app.db, requesterId, { method: 'link', providerId: null }, 3_600_000)}`;
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
  await updateProject(w.adminCtx, 'BACK', { lead: 'anna', settings: { helpdesk: { enabled: true } } });
  await setDeskAddress(w.adminCtx, 'BACK', DESK);
  await newMailSecret(w.adminCtx, 'BACK');
  http = createHttpApp(w.app);
  outbox = new OutboxWorker(w.app, [notifierConsumer(w.app), helpdeskConsumer(w.app), relayConsumer(w.app)], {}, [], () => {});
  // Its consumers start from the newest event the first time it runs: from here on, then.
  await outbox.drain();
  mailer = new MailWorker(w.app, () => new Date(Date.now() + 10 * 60_000));
});

afterAll(async () => {
  await smtp?.close();
  await w?.close();
});

describe("a group's copies: only of what it shares", () => {
  it('copies nobody where the group shares nothing, nor on a request kept from it', async () => {
    await group('Quiet', 'none', ['quiet.example']);
    await ask('ana@quiet.example', 'Quiet first');
    const quiet = await ask('bob@quiet.example', 'Quiet second');
    expect(await copies(quiet.uid)).toEqual([]);
    await group('Kept', 'read', ['kept.example']);
    await ask('ana@kept.example', 'Kept first');
    const kept = await ask('bob@kept.example', 'Kept from the group', { private: true });
    expect(await copies(kept.uid)).toEqual([]);
  });

  it('shared to read: copies them, says why, mints no reply address, and refuses a reply by email as before', async () => {
    const readers = await group('Readers', 'read', ['read.example']);
    await addGroupMember(w.adminCtx, 'BACK', readers.id, { email: 'rita@elsewhere.example' });
    await ask('ana@read.example', 'Readers first');
    const r = await ask('bob@read.example', 'Toner is low');
    expect(await active(r.uid)).toEqual(['rita@elsewhere.example', 'ana@read.example']);
    expect((await copies(r.uid)).every((c) => c.via === 'group' && c.groupId === readers.id)).toBe(true);
    await reply(r.id, 'A new cartridge is on its way.');
    await flush();
    const [mail] = mailsTo('ana@read.example', 'new cartridge');
    expect(mail!.text).toContain("bob's request");
    expect(mail!.text).toContain("You get this because you're in Readers, whose people can read each other's requests to Backend's help desk. Replies to this email reach nobody: the link above opens it.");
    expect(mail!.text).toContain('See the request');
    expect(mail!.text).not.toContain('See the request and reply');
    expect(mail!.text).toContain("Stop emails about Readers's requests");
    expect(mail!.headers.get('reply-to')).toBeUndefined();
    expect(mail!.headers.get('list-unsubscribe')).toContain('/api/v1/unsubscribe?token=group.');
    // Answering it reaches the desk's own address, and is refused, as a reader's answer always was.
    const before = (await listComments(w.adminCtx, r.id)).length;
    const res = await mailIn(answer('ana@read.example', DESK, mail!.headers.get('message-id') as string, 'Thanks!'));
    expect(res.outcome).toBe('refused');
    expect((await listComments(w.adminCtx, r.id)).length).toBe(before);
  });

  it('shared to comment: copies them with words for answering and a reply address, and takes their answer', async () => {
    await group('Answerers', 'comment', ['answer.example']);
    await ask('carl@answer.example', 'Answerers first');
    const r = await ask('dina@answer.example', 'Scanner jams');
    expect(await active(r.uid)).toEqual(['carl@answer.example']);
    await reply(r.id, 'Try the rear tray.');
    await flush();
    const [mail] = mailsTo('carl@answer.example', 'rear tray');
    expect(mail!.text).toContain("whose people can answer each other's requests to Backend's help desk. To reply, answer this email, or use the link above.");
    expect(mail!.text).toContain('See the request and reply');
    const replyTo = mail!.headers.get('reply-to') as string;
    expect(replyTo).toMatch(/^support\+/);
    const res = await mailIn(answer('Carl <carl@answer.example>', replyTo, mail!.headers.get('message-id') as string, 'The rear tray works, thanks.'));
    expect(res).toMatchObject({ outcome: 'reply', reason: 'a reply by its reply address, from someone of its customer group' });
    expect((await listComments(w.adminCtx, r.id)).at(-1)).toMatchObject({ text: 'The rear tray works, thanks.', visibility: 'public', requester: { name: 'carl' } });
  });
});

describe('kept current, as each email is sent and wherever copies are listed', () => {
  it('made private after it copied them: a queued email is not sent, and the lists show them not hearing', async () => {
    await group('Privates', 'read', ['priv.example']);
    await ask('erin@priv.example', 'Privates first');
    const r = await ask('frank@priv.example', 'Badge broken');
    expect(await active(r.uid)).toEqual(['erin@priv.example']);
    await reply(r.id, 'A new badge is printed.');
    await queue(); // queued for Erin
    await updateRequest(w.adminCtx, r.id, { private: true });
    await mailer.drain();
    expect(mailsTo('erin@priv.example', 'new badge')).toEqual([]);
    // The team sees her copied, not hearing; Frank's portal doesn't list her.
    expect((await requestOf(w.adminCtx, r.id)).ccs).toEqual([expect.objectContaining({ email: 'erin@priv.example', via: 'group', group: 'Privates', hears: false })]);
    expect((await portalRequest(w.app, await viewer('frank@priv.example'), r.id)).ccs).toEqual([]);
    // Shared with the group again, she hears again.
    await updateRequest(w.adminCtx, r.id, { private: false });
    expect((await requestOf(w.adminCtx, r.id)).ccs[0]).toMatchObject({ hears: true });
    await reply(r.id, 'The badge is at the front desk.');
    await flush();
    expect(mailsTo('erin@priv.example', 'front desk')).toHaveLength(1);
  });

  it('sharing changed to none, a member taken off, a domain taken off: each stops what is queued', async () => {
    const g = await group('Changes', 'read', ['five.example']);
    await addGroupMember(w.adminCtx, 'BACK', g.id, { email: 'hand@elsewhere.example' });
    await ask('gina@five.example', 'Changes first');
    const r = await ask('harry@five.example', 'Three changes');
    expect(await active(r.uid)).toEqual(['hand@elsewhere.example', 'gina@five.example']);
    const settings = { name: g.name, domains: ['five.example'], agents: [] as string[] };

    await reply(r.id, 'First news.');
    await queue();
    await updateCustomerGroup(w.adminCtx, 'BACK', g.id, { ...settings, sharing: 'none' });
    await mailer.drain();
    expect([...mailsTo('gina@five.example', 'First news'), ...mailsTo('hand@elsewhere.example', 'First news')]).toEqual([]);
    await updateCustomerGroup(w.adminCtx, 'BACK', g.id, { ...settings, sharing: 'read' });

    await reply(r.id, 'Second news.');
    await queue();
    const hand = await requesterByEmail(w.app.db, 'hand@elsewhere.example');
    await removeGroupMember(w.adminCtx, 'BACK', g.id, hand.id);
    await mailer.drain();
    expect(mailsTo('hand@elsewhere.example', 'Second news')).toEqual([]);
    expect(mailsTo('gina@five.example', 'Second news')).toHaveLength(1);

    await reply(r.id, 'Third news.');
    await queue();
    await updateCustomerGroup(w.adminCtx, 'BACK', g.id, { ...settings, domains: [], sharing: 'read' });
    await mailer.drain();
    expect(mailsTo('gina@five.example', 'Third news')).toEqual([]);
    expect((await requestOf(w.adminCtx, r.id)).ccs.map((c) => [c.email, c.hears])).toEqual([
      ['hand@elsewhere.example', false],
      ['gina@five.example', false],
    ]);
  });

  it("relays (D67) nothing to a copy that doesn't hear now, and a reader's relay mints no reply address", async () => {
    await updateProject(w.adminCtx, 'BACK', { settings: { helpdesk: { ccsRelay: true } } });
    try {
      const g = await group('Relayed', 'read', ['eight.example']);
      await ask('luke@eight.example', 'Relayed first');
      const r = await ask('mia@eight.example', 'Relay me');
      expect(await active(r.uid)).toEqual(['luke@eight.example']);
      await portalReply(w.app, await viewer('mia@eight.example'), r.id, 'It still beeps at night.');
      await flush();
      const [relayed] = mailsTo('luke@eight.example', 'beeps at night');
      expect(relayed!.text).toContain('mia wrote:');
      expect(relayed!.text).toContain("whose people can read each other's requests");
      expect(relayed!.headers.get('reply-to')).toBeUndefined();
      await updateCustomerGroup(w.adminCtx, 'BACK', g.id, { name: g.name, domains: ['eight.example'], sharing: 'none' });
      await portalReply(w.app, await viewer('mia@eight.example'), r.id, 'And now it smokes.');
      await flush();
      expect(mailsTo('luke@eight.example', 'smokes')).toEqual([]);
    } finally {
      await updateProject(w.adminCtx, 'BACK', { settings: { helpdesk: { ccsRelay: false } } });
    }
  });
});

describe("stopping a group's emails", () => {
  it('stops this request, its other open ones and its later ones; twice is once; the portal turns later ones back on', async () => {
    const g = await group('Sixes', 'comment', ['six.example']);
    await ask('ivy@six.example', 'Sixes first');
    const one = await ask('jack@six.example', 'One');
    const two = await ask('kim@six.example', 'Two');
    const done = await ask('kim@six.example', 'Done already');
    await updateIssue(w.adminCtx, done.id, { fields: { State: 'Fixed' } });
    await reply(one.id, 'News on one.');
    await flush();
    const [mail] = mailsTo('ivy@six.example', 'News on one');
    const oneClick = /<([^>]+)>/.exec(mail!.headers.get('list-unsubscribe') as string)![1]!;
    const token = new URL(oneClick).searchParams.get('token')!;

    // Opening the link changes nothing; it says which group's emails it stops.
    const seen = await api('GET', `/unsubscribe?token=${encodeURIComponent(token)}`, null);
    expect(seen.body).toMatchObject({ kind: 'group', group: { name: 'Sixes', desk: 'Backend' }, done: false });
    // The mail client's one-click POST, redelivered, and twice at once: the same as once.
    const posts = await Promise.all([1, 2].map(() => api('POST', `/unsubscribe?token=${encodeURIComponent(token)}`, null)));
    expect(posts.map((p) => [p.status, p.body.done])).toEqual([
      [200, true],
      [200, true],
    ]);
    expect((await api('POST', `/unsubscribe?token=${encodeURIComponent(token)}`, null)).body.done).toBe(true);

    expect([await copiesIvy(one.uid), await copiesIvy(two.uid)]).toEqual([false, false]);
    // The resolved one isn't taken off, but hears no more.
    expect(await copiesIvy(done.uid)).toBe(true);
    expect((await requestOf(w.adminCtx, done.id)).ccs.find((c) => c.email === 'ivy@six.example')).toMatchObject({ hears: false });
    const off = (await copies(one.uid)).find((c) => c.email === 'ivy@six.example')!;
    expect(off.removedVia).toBe('group');
    const history = await w.app.db.select().from(activities).where(eq(activities.type, 'request.cc_removed'));
    const ivys = history.filter((a) => (a.payload as { data: { cc: { email: string } } }).data.cc.email === 'ivy@six.example');
    expect(ivys).toHaveLength(2);
    expect((ivys[0]!.payload as { data: unknown }).data).toEqual({ cc: { email: 'ivy@six.example', name: 'ivy' }, via: 'group', requester: { name: 'ivy' }, group: { name: 'Sixes' }, where: 'link' });

    // Nothing more reaches her, and the group's next request doesn't copy her.
    await reply(two.id, 'News on two.');
    await reply(done.id, 'Reopened, maybe.');
    await flush();
    expect([...mailsTo('ivy@six.example', 'News on two'), ...mailsTo('ivy@six.example', 'Reopened')]).toEqual([]);
    const three = await ask('jack@six.example', 'Three');
    expect(await active(three.uid)).toEqual(['kim@six.example']);

    // The team sees who stopped, and why she isn't hearing.
    expect((await listGroupCopyStops(w.adminCtx, 'BACK', g.id)).map((s) => s.requester.email)).toEqual(['ivy@six.example']);
    expect((await listCustomerGroups(w.adminCtx, 'BACK')).find((x) => x.id === g.id)).toMatchObject({ stops: 1 });

    // On the portal: the group says it no longer copies her; she turns it back on, for later requests only.
    const ivy = await requesterByEmail(w.app.db, 'ivy@six.example');
    const me = await api('GET', '/portal/me', ivy.id);
    expect(me.body.groups).toEqual([expect.objectContaining({ id: g.id, name: 'Sixes', sharing: 'comment', copies: false })]);
    const on = await api('PATCH', `/portal/me/groups/${g.id}`, ivy.id, { copies: true });
    expect(on.status).toBe(200);
    expect(on.body.groups[0]).toMatchObject({ copies: true });
    expect(await copiesIvy(one.uid)).toBe(false);
    expect((await requestOf(w.adminCtx, done.id)).ccs.find((c) => c.email === 'ivy@six.example')).toMatchObject({ hears: false });
    const four = await ask('jack@six.example', 'Four');
    expect(await copiesIvy(four.uid)).toBe(true);
    await reply(four.id, 'News on four.');
    await flush();
    expect(mailsTo('ivy@six.example', 'News on four')).toHaveLength(1);

    // Off from the portal, the same as the link, said in the history as the portal's.
    const offAgain = await api('PATCH', `/portal/me/groups/${g.id}`, ivy.id, { copies: false });
    expect(offAgain.body.groups[0]).toMatchObject({ copies: false });
    expect(await copiesIvy(four.uid)).toBe(false);
    const last = (await w.app.db.select().from(activities).where(and(eq(activities.type, 'request.cc_removed'), eq(activities.issueId, four.uid))))[0]!;
    expect((last.payload as { data: { where: string } }).data.where).toBe('portal');
  });

  it("answers a group not theirs as missing, alike with one that doesn't exist, and refuses bad input", async () => {
    const other = await group('Not hers', 'read', ['nothers.example']);
    const ivy = await requesterByEmail(w.app.db, 'ivy@six.example');
    const theirs = await api('PATCH', `/portal/me/groups/${other.id}`, ivy.id, { copies: false });
    const none = await api('PATCH', '/portal/me/groups/nosuchgroup', ivy.id, { copies: false });
    expect([theirs.status, theirs.body.error.message]).toEqual([404, "There's no group of yours here"]);
    expect([none.status, none.body.error.message]).toEqual([404, "There's no group of yours here"]);
    expect((await api('PATCH', `/portal/me/groups/${other.id}`, ivy.id, { copies: 'yes' })).status).toBe(400);
    expect((await api('PATCH', `/portal/me/groups/${other.id}`, null, { copies: true })).status).toBe(401);
    // A broken link stops nothing, and says so as a link that doesn't exist.
    expect((await api('POST', '/unsubscribe?token=group.nosuchgroup-nobody.forged', null)).status).toBe(404);
  });
});

describe('who is copied past the cap', () => {
  it('takes those added by hand first, then the domains’ requesters who asked most recently, ties by address', async () => {
    const g = await group('Capped', 'read', ['seven.example']);
    await addGroupMember(w.adminCtx, 'BACK', g.id, { email: 'zed@hand.example' });
    await addGroupMember(w.adminCtx, 'BACK', g.id, { email: 'amy@hand.example' });
    await ask('old@seven.example', 'Asked long ago');
    await ask('new@seven.example', 'Asked just now');
    await requesterByEmail(w.app.db, 'b@seven.example');
    await requesterByEmail(w.app.db, 'a@seven.example');
    expect((await listCustomerGroups(w.adminCtx, 'BACK')).find((x) => x.id === g.id)).toMatchObject({ people: 6 });
    await updateProject(w.adminCtx, 'BACK', { settings: { helpdesk: { ccsMax: 5 } } });
    try {
      const r = await ask('asker@seven.example', 'Cap order');
      expect(await active(r.uid)).toEqual(['zed@hand.example', 'amy@hand.example', 'new@seven.example', 'old@seven.example', 'a@seven.example']);
    } finally {
      await updateProject(w.adminCtx, 'BACK', { settings: { helpdesk: { ccsMax: 20 } } });
    }
  });
});

describe('a stop and a request filed at the same moment', () => {
  it('take turns: the request copies them before the stop takes them off, or sees the stop', async () => {
    const g = await group('Racers', 'none', ['nine.example']);
    await ask('nina@nine.example', 'Racers first');
    // Filed while the group shared nothing; it starts sharing as its people are copied, in a transaction of their own.
    const r = await ask('oscar@nine.example', 'Race');
    await updateCustomerGroup(w.adminCtx, 'BACK', g.id, { name: g.name, domains: ['nine.example'], sharing: 'read' });
    const [issue] = await w.app.db.select().from(issues).where(eq(issues.id, r.uid));
    const [row] = await w.app.db.select().from(requesters).where(eq(requesters.email, 'nina@nine.example'));
    let copied!: () => void;
    const ready = new Promise<void>((res) => (copied = res));
    const filing = w.app.db.transaction(async (tx) => {
      await copyGroupMembers(tx as unknown as Db, w.app, issue!, { ...g, projectId: (await desk()).id, providerId: null, businessHours: null, createdAt: new Date(), updatedAt: new Date() });
      copied();
      await new Promise((res) => setTimeout(res, 300));
    });
    await ready;
    await stopGroupCopies(w.app, g.id, row!.id, 'link');
    await filing;
    const left = await w.app.db
      .select()
      .from(requestCcs)
      .where(and(eq(requestCcs.issueId, r.uid), isNull(requestCcs.removedAt)));
    expect(left).toEqual([]);
  });
});
