/**
 * Subscriptions (D31): to a project's new issues or every change in it, and to a saved search's
 * issues coming in or any change to one in it; who is told, who isn't, and what it says.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { systemCtx } from '../src/app-services';
import type { Ctx, UserRow } from '../src/context';
import { notifications, subscriptionIssues, subscriptions, users } from '../src/db/schema';
import { OutboxWorker } from '../src/events/worker';
import { createHttpApp } from '../src/http/app';
import { MailWorker } from '../src/mail/outbox';
import { notifierConsumer, recheckSearches } from '../src/notify/notifier';
import { addComment } from '../src/services/comments';
import { issueTokenFor } from '../src/services/auth';
import { createIssue, resolveIssue, updateIssue } from '../src/services/issues';
import { addMember } from '../src/services/members';
import { applyUnsubscribe, describeUnsubscribe, listNotifications, updateNotificationSettings } from '../src/services/notifications';
import { attachField, createField } from '../src/services/fields';
import { createProject } from '../src/services/projects';
import { createSavedSearch, updateSavedSearch } from '../src/services/saved-searches';
import { listSubscriptions, subscribe, unsubscribe, updateSubscription } from '../src/services/subscriptions';
import { toolByName } from '../src/tools/registry';
import { subscriptionTells } from '@a4a/shared/i18n';
import { translatorFor } from '../src/i18n';
import { todayISO } from '../src/lib/dates';
import { createWorld, type TestWorld } from './helpers';
import { fakeSmtp, type FakeSmtp } from './smtp';

let w: TestWorld;
let smtp: FakeSmtp;
let outbox: OutboxWorker;
let mailer: MailWorker;

const as = (u: UserRow): Ctx => systemCtx(w.app, u, 'web');
const run = () => outbox.drain();
async function flush() {
  await run();
  await mailer.drain();
  smtp.messages.length = 0;
}
/** One person's notifications about one issue. */
async function told(u: UserRow, issueId: string) {
  return (await listNotifications(as(u), { limit: 100 })).items.filter((n) => n.issue.id === issueId);
}
async function readAll(u: UserRow) {
  await w.app.db.update(notifications).set({ readAt: new Date() }).where(eq(notifications.userId, u.id));
}

beforeAll(async () => {
  smtp = await fakeSmtp(0);
  w = await createWorld({ config: { smtpUrl: smtp.url, notifyWindowMs: 60_000, publicUrl: 'http://a4a.test' } });
  for (const [u, email] of [
    [w.anna, 'anna@example.com'],
    [w.ben, 'ben@example.com'],
    [w.viewer, 'vera@example.com'],
  ] as const) {
    await w.app.db.update(users).set({ email }).where(eq(users.id, u.id));
  }
  w.app.schema.invalidate();
  const fresh = async (u: UserRow) => (await w.app.db.select().from(users).where(eq(users.id, u.id)))[0]!;
  w.anna = await fresh(w.anna);
  w.ben = await fresh(w.ben);
  w.viewer = await fresh(w.viewer);
  outbox = new OutboxWorker(w.app, [notifierConsumer(w.app)], {}, [], () => {});
  await outbox.drain();
  mailer = new MailWorker(w.app, () => new Date(Date.now() + 10 * 60_000));
});

afterAll(async () => {
  await w?.close();
  await smtp?.close();
});

describe('subscriptions to a project', () => {
  it("tells of a project's new issues, and of nothing else it didn't ask for", async () => {
    const sub = await subscribe(as(w.anna), { project: 'back', events: 'new' });
    expect(sub).toMatchObject({ target: 'project', project: { key: 'BACK', name: 'Backend' }, events: 'new', email: true, about: 'New issues in Backend' });
    const issue = await createIssue(as(w.ben), { project: 'BACK', summary: 'Exports time out on big projects' });
    await run();
    const [n] = await told(w.anna, issue.id);
    expect(n).toMatchObject({ kind: 'subscribed', title: 'Ben Okafor reported it', subscription: { id: sub.id, about: 'new issues in Backend', target: 'project', events: 'new', name: 'Backend' } });
    await readAll(w.anna);

    // A change to it isn't a new issue, and she doesn't watch it.
    await updateIssue(as(w.ben), issue.id, { fields: { Priority: 'Major' } });
    await addComment(as(w.ben), issue.id, 'It is the CSV writer.');
    await run();
    expect((await told(w.anna, issue.id)).filter((x) => !x.readAt)).toEqual([]);

    // Her own new issue tells her nothing.
    const own = await createIssue(as(w.anna), { project: 'BACK', summary: 'My own' });
    await run();
    expect(await told(w.anna, own.id)).toEqual([]);
    // Nor does one in another project.
    const web = await createIssue(as(w.ben), { project: 'WEB', summary: 'Elsewhere' });
    await run();
    expect(await told(w.anna, web.id)).toEqual([]);
    await unsubscribe(as(w.anna), sub.id);
  });

  it('tells of every change when asked to, folded per issue as everything is', async () => {
    const sub = await subscribe(as(w.viewer), { project: 'WEB', events: 'all', email: false });
    const issue = await createIssue(as(w.ben), { project: 'WEB', summary: 'The menu flickers' });
    await updateIssue(as(w.ben), issue.id, { fields: { Priority: 'Critical' } });
    await addComment(as(w.ben), issue.id, 'On Safari only.');
    await run();
    const mine = await told(w.viewer, issue.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: 'subscribed', eventCount: 3, subscription: { about: 'every change in Web app' } });
    expect(mine[0]!.events.map((e) => e.type)).toEqual(['issue.created', 'issue.updated', 'comment.created']);
    await unsubscribe(as(w.viewer), sub.id);
  });

  it('takes the stronger reason when someone is told for two', async () => {
    const sub = await subscribe(as(w.anna), { project: 'BACK', events: 'all' });
    const issue = await createIssue(as(w.ben), { project: 'BACK', summary: 'Assign me', fields: { Assignee: 'anna' } });
    await run();
    const [n] = await told(w.anna, issue.id);
    expect(n).toMatchObject({ kind: 'assigned', subscription: null });
    await unsubscribe(as(w.anna), sub.id);
  });

  it('tells nobody who can no longer see the project, and hides the subscription from them', async () => {
    await createProject(w.adminCtx, { key: 'SEC', name: 'Merger', template: 'software' });
    const sub = await subscribe(as(w.anna), { project: 'SEC', events: 'new' });
    const { updateProject } = await import('../src/services/projects');
    await updateProject(w.adminCtx, 'SEC', { visibility: 'members' });
    await addMember(w.adminCtx, 'SEC', { user: 'ben', role: 'member' });
    const issue = await createIssue(as(w.ben), { project: 'SEC', summary: 'Due diligence list' });
    await run();
    expect(await told(w.anna, issue.id)).toEqual([]);
    expect((await listSubscriptions(as(w.anna))).map((s) => s.id)).not.toContain(sub.id);
    // Hidden equals missing: the same words as one that doesn't exist.
    await expect(updateSubscription(as(w.anna), sub.id, { events: 'all' })).rejects.toMatchObject({ status: 404, message: 'Subscription not found' });
    await expect(subscribe(as(w.viewer), { project: 'SEC' })).rejects.toMatchObject({ status: 404 });
  });

  it('tells nobody of an import', async () => {
    const sub = await subscribe(as(w.anna), { project: 'BACK', events: 'all' });
    const imported = { createdAt: new Date('2025-03-01'), updatedAt: new Date('2025-03-02'), resolvedAt: null, reporterId: w.ben.id, data: { source: 'jira', key: 'OLD-9' } };
    const issue = await createIssue(as(w.ben), { project: 'BACK', summary: 'Imported: old bug' }, { imported });
    await updateIssue(as(w.ben), issue.id, { fields: { Priority: 'Major' } }, { data: { imported: imported.data } });
    await run();
    expect(await told(w.anna, issue.id)).toEqual([]);
    await unsubscribe(as(w.anna), sub.id);
  });
});

describe('subscriptions to a saved search', () => {
  it('tells of an issue coming into the search, and not of one that was in it already', async () => {
    const already = await createIssue(as(w.ben), { project: 'BACK', summary: 'Logins fail', fields: { Priority: 'Critical' } });
    const search = await createSavedSearch(as(w.anna), { name: 'Critical in BACK', query: 'project: BACK Priority: Critical', shared: false });
    const sub = await subscribe(as(w.anna), { savedSearch: search.id, events: 'new' });
    expect(sub).toMatchObject({ target: 'search', search: { id: search.id, name: 'Critical in BACK' }, about: 'Issues coming into “Critical in BACK”' });
    await flush();

    // Already in it: a change to it isn't news.
    await addComment(as(w.ben), already.id, 'Still failing.');
    await run();
    expect(await told(w.anna, already.id)).toEqual([]);

    // Created into it, or changed into it: news.
    const fresh = await createIssue(as(w.ben), { project: 'BACK', summary: 'Payments double-charge', fields: { Priority: 'Critical' } });
    const later = await createIssue(as(w.ben), { project: 'BACK', summary: 'Search is slow', fields: { Priority: 'Normal' } });
    await run();
    expect(await told(w.anna, fresh.id)).toMatchObject([{ kind: 'subscribed', subscription: { about: 'issues coming into “Critical in BACK”', target: 'search', events: 'new', name: 'Critical in BACK' } }]);
    expect(await told(w.anna, later.id)).toEqual([]);
    await updateIssue(as(w.ben), later.id, { fields: { Priority: 'Critical' } });
    await run();
    const [came] = await told(w.anna, later.id);
    expect(came).toMatchObject({ kind: 'subscribed', title: 'Ben Okafor changed Priority' });
    await readAll(w.anna);

    // Out and back in: news again. Out alone isn't, for "new".
    await updateIssue(as(w.ben), later.id, { fields: { Priority: 'Normal' } });
    await run();
    expect((await told(w.anna, later.id)).filter((n) => !n.readAt)).toEqual([]);
    await updateIssue(as(w.ben), later.id, { fields: { Priority: 'Critical' } });
    await run();
    expect((await told(w.anna, later.id)).filter((n) => !n.readAt)).toHaveLength(1);

    // An issue brought in by an import was in the search from then on: its next change isn't news.
    const imported = { createdAt: new Date('2025-03-01'), updatedAt: new Date('2025-03-02'), resolvedAt: null, reporterId: w.ben.id, data: { source: 'jira', key: 'OLD-11' } };
    const old = await createIssue(as(w.ben), { project: 'BACK', summary: 'Imported: crash on start', fields: { Priority: 'Critical' } }, { imported });
    await run();
    await addComment(as(w.ben), old.id, 'Seen again today.');
    await run();
    expect(await told(w.anna, old.id)).toEqual([]);
    await unsubscribe(as(w.anna), sub.id);
  });

  it('tells of any change to an issue in it, the one that takes it out included, when asked to', async () => {
    const search = await createSavedSearch(as(w.ben), { name: 'Major on the web', query: 'project: WEB Priority: Major', shared: true });
    const sub = await subscribe(as(w.viewer), { savedSearch: search.id, events: 'all', email: false });
    const issue = await createIssue(as(w.ben), { project: 'WEB', summary: 'Dark mode loses contrast', fields: { Priority: 'Major' } });
    await run();
    await readAll(w.viewer);
    await addComment(as(w.ben), issue.id, 'The buttons, mostly.');
    await run();
    expect((await told(w.viewer, issue.id)).filter((n) => !n.readAt)).toHaveLength(1);
    await readAll(w.viewer);
    // The change that takes it out is told; after that, it's no longer theirs to hear of.
    await updateIssue(as(w.ben), issue.id, { fields: { Priority: 'Normal' } });
    await run();
    expect((await told(w.viewer, issue.id)).filter((n) => !n.readAt)).toHaveLength(1);
    await readAll(w.viewer);
    await addComment(as(w.ben), issue.id, 'Fixed the buttons.');
    await run();
    expect((await told(w.viewer, issue.id)).filter((n) => !n.readAt)).toEqual([]);

    // Unshared, it's its owner's alone: the others' subscriptions end.
    await updateSavedSearch(as(w.ben), search.id, { shared: false });
    expect((await listSubscriptions(as(w.viewer))).map((s) => s.id)).not.toContain(sub.id);
    expect(await w.app.db.select().from(subscriptions).where(eq(subscriptions.id, sub.id))).toEqual([]);
  });

  it("starts over, quietly, from what a changed search finds, and follows no one else's private search", async () => {
    const search = await createSavedSearch(as(w.anna), { name: 'Mine to fix', query: 'project: BACK Priority: Minor', shared: false });
    const sub = await subscribe(as(w.anna), { savedSearch: search.id });
    const major = await createIssue(as(w.ben), { project: 'BACK', summary: 'Tooltips cut off', fields: { Priority: 'Major' } });
    await run();
    expect(await told(w.anna, major.id)).toEqual([]);
    // The search now finds Major ones too: what it finds already is in it, not news.
    await updateSavedSearch(as(w.anna), search.id, { query: 'project: BACK Priority: Minor, Major' });
    const known = await w.app.db.select().from(subscriptionIssues).where(eq(subscriptionIssues.subscriptionId, sub.id));
    expect(known.map((r) => r.issueId)).toContain((await resolveIssue(as(w.anna), major.id)).id);
    await addComment(as(w.ben), major.id, 'Only on narrow screens.');
    await run();
    expect(await told(w.anna, major.id)).toEqual([]);

    // Someone else's search that isn't shared is not found, in the words for one that doesn't exist.
    await expect(subscribe(as(w.ben), { savedSearch: search.id })).rejects.toMatchObject({ status: 404, message: 'Saved search not found' });
    await expect(subscribe(as(w.ben), { savedSearch: 'nope' })).rejects.toMatchObject({ status: 404, message: 'Saved search not found' });
    await expect(subscribe(as(w.ben), {})).rejects.toMatchObject({ status: 400 });
    await unsubscribe(as(w.anna), sub.id);
  });
});

describe("what you can't see", () => {
  it("hides a shared search that names a project you can't see, in the words for one that doesn't exist", async () => {
    await createProject(w.adminCtx, { key: 'MRG', name: 'Merger', template: 'software', visibility: 'members' });
    await addMember(w.adminCtx, 'MRG', { user: 'ben', role: 'member' });
    const search = await createSavedSearch(as(w.ben), { name: 'Merger work', query: 'project: MRG #Unresolved', shared: true });
    // Not "Unknown project MRG": that would name it.
    await expect(subscribe(as(w.anna), { savedSearch: search.id })).rejects.toMatchObject({ status: 404, message: 'Saved search not found' });
    const tool = toolByName('subscribe')!;
    const anna: Ctx = { ...as(w.anna), actor: { ...as(w.anna).actor, channel: 'mcp' } };
    await expect(tool.run(anna, { saved_search: 'Merger work', events: 'new', email: true })).rejects.toMatchObject({ status: 404, message: 'Saved search “Merger work” not found' });
    await expect(tool.run(anna, { saved_search: 'No such search', events: 'new', email: true })).rejects.toMatchObject({ status: 404, message: 'Saved search “No such search” not found' });
    // Its project's people follow it.
    const bens = await subscribe(as(w.ben), { savedSearch: search.id });
    expect(bens.search?.name).toBe('Merger work');
    await unsubscribe(as(w.ben), bens.id);
  });
});

describe('subscriptions by email', () => {
  it('emails as the subscription asks, names it, and its link stops its email alone', async () => {
    const sub = await subscribe(as(w.anna), { project: 'WEB', events: 'new', email: true });
    await flush();
    const issue = await createIssue(as(w.ben), { project: 'WEB', summary: 'Checkout button hidden on phones' });
    await run();
    await mailer.drain();
    const mail = smtp.messages.find((m) => m.to.includes('anna@example.com'));
    expect(mail?.text).toContain('You get this because you subscribed to new issues in Web app.');
    expect(mail?.text).toContain('Stop emails about new issues in Web app');
    const token = /unsubscribe\?token=([^\s"&<>]+)/.exec(mail!.text)![1]!;
    const link = decodeURIComponent(token);
    expect(await describeUnsubscribe(w.app, link)).toEqual({
      kind: 'subscription',
      what: 'Emails about new issues in Web app. Your inbox in a4a still has them.',
      subscription: { target: 'project', events: 'new', name: 'Web app' },
      // A customer group's copies' links name their group (D56's revisit); a subscription's name none.
      group: null,
      done: false,
    });
    expect(await applyUnsubscribe(w.app, link)).toMatchObject({ kind: 'subscription', done: true });
    expect((await listSubscriptions(as(w.anna))).find((s) => s.id === sub.id)).toMatchObject({ email: false });
    smtp.messages.length = 0;

    // The inbox still has it; email doesn't.
    const next = await createIssue(as(w.ben), { project: 'WEB', summary: 'Prices round wrongly' });
    await run();
    await mailer.drain();
    expect(await told(w.anna, next.id)).toHaveLength(1);
    expect(smtp.messages.filter((m) => m.to.includes('anna@example.com'))).toEqual([]);
    expect(issue.id).toBeTruthy();
    await unsubscribe(as(w.anna), sub.id);
  });

  it('names the subscription in its person’s language, in the case each sentence needs', async () => {
    await w.app.db.update(users).set({ locale: 'de' }).where(eq(users.id, w.viewer.id));
    const sub = await subscribe(as(w.viewer), { project: 'WEB', events: 'all', email: true });
    await flush();
    const issue = await createIssue(as(w.ben), { project: 'WEB', summary: 'Coupons stack twice' });
    await run();
    await mailer.drain();
    const mail = smtp.messages.find((m) => m.to.includes('vera@example.com'));
    // German says "abonniert" with its accusative, and "zu" with its dative.
    expect(mail?.text).toContain('Sie erhalten dies, weil Sie jede Änderung in Web app abonniert haben.');
    expect(mail?.text).toContain('E-Mails zu jeder Änderung in Web app abbestellen');
    // The inbox and the unsubscribe page get what to word it from; their English stays for the API.
    const [n] = await told(w.viewer, issue.id);
    expect(n!.subscription).toEqual({ id: sub.id, about: 'every change in Web app', target: 'project', events: 'all', name: 'Web app' });
    const token = /unsubscribe\?token=([^\s"&<>]+)/.exec(mail!.text)![1]!;
    expect(await describeUnsubscribe(w.app, decodeURIComponent(token))).toEqual({
      kind: 'subscription',
      what: 'Emails about every change in Web app. Your inbox in a4a still has them.',
      subscription: { target: 'project', events: 'all', name: 'Web app' },
      // A customer group's copies' links name their group (D56's revisit); a subscription's name none.
      group: null,
      done: false,
    });
    // What a German page makes of them: the inbox's line and the unsubscribe page's.
    const de = translatorFor('de');
    const tells = subscriptionTells(n!.subscription!.target, n!.subscription!.events);
    expect(de.t('page.inbox.becauseYouSubscribedTo', { tells, name: 'Web app' })).toBe('Weil Sie jede Änderung in Web app abonniert haben.');
    expect(de.t('page.unsubscribe.subscription', { tells, name: 'Web app' })).toBe('E-Mails zu jeder Änderung in Web app. Ihr Posteingang in a4a enthält sie weiterhin.');
    expect(de.t('page.unsubscribe.what', { kind: 'digest' })).toBe('Der tägliche Überblick.');
    await w.app.db.update(users).set({ locale: null }).where(eq(users.id, w.viewer.id));
    await unsubscribe(as(w.viewer), sub.id);
    smtp.messages.length = 0;
  });

  it('sends nothing when the person asks for no email at all', async () => {
    await updateNotificationSettings(as(w.ben), { email: 'none' });
    const sub = await subscribe(as(w.ben), { project: 'BACK', events: 'new', email: true });
    await flush();
    const issue = await createIssue(as(w.anna), { project: 'BACK', summary: 'A new one for Ben' });
    await run();
    await mailer.drain();
    expect(await told(w.ben, issue.id)).toHaveLength(1);
    expect(smtp.messages.filter((m) => m.to.includes('ben@example.com'))).toEqual([]);
    await updateNotificationSettings(as(w.ben), { email: 'direct' });
    await unsubscribe(as(w.ben), sub.id);
  });
});

describe('over HTTP and MCP', () => {
  it('lists, changes and ends your own subscriptions, and no one else’s', async () => {
    const http = createHttpApp(w.app);
    const tokenOf = async (u: UserRow, scopes: ('read' | 'write')[]) => (await issueTokenFor(w.app.db, u.id, { name: `${u.login} ${scopes.join(' ')}`, scopes })).token;
    const token = await tokenOf(w.anna, ['read', 'write']);
    const call = (method: string, path: string, body?: unknown, t = token) =>
      http.request(`/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const made = await call('POST', '/subscriptions', { project: 'BACK', events: 'all' });
    expect(made.status).toBe(200);
    const sub = (await made.json()) as { id: string; about: string };
    expect(sub.about).toBe('Every change in Backend');
    // Subscribing again changes the same one.
    const again = (await (await call('POST', '/subscriptions', { project: 'BACK', events: 'new', email: false })).json()) as { id: string; events: string };
    expect(again).toMatchObject({ id: sub.id, events: 'new' });
    expect(((await (await call('GET', '/subscriptions')).json()) as { id: string }[]).map((s) => s.id)).toEqual([sub.id]);
    expect((await call('PATCH', `/subscriptions/${sub.id}`, { events: 'all' })).status).toBe(200);
    // Someone else's is not found.
    const benToken = await tokenOf(w.ben, ['read', 'write']);
    expect((await call('GET', `/subscriptions/${sub.id}`, undefined, benToken)).status).toBe(404);
    expect((await call('DELETE', `/subscriptions/${sub.id}`, undefined, benToken)).status).toBe(404);
    // A read-only token may list, not subscribe.
    const reader = await tokenOf(w.anna, ['read']);
    expect((await call('GET', '/subscriptions', undefined, reader)).status).toBe(200);
    expect((await call('POST', '/subscriptions', { project: 'WEB' }, reader)).status).toBe(403);
    expect((await call('DELETE', `/subscriptions/${sub.id}`)).status).toBe(204);
    expect(await (await call('GET', '/subscriptions')).json()).toEqual([]);
  });

  it('lets an agent subscribe its person, by a saved search’s name, and end it', async () => {
    const search = await createSavedSearch(as(w.ben), { name: 'Release blockers', query: 'project: BACK Priority: Show-stopper', shared: true });
    const ctx: Ctx = { ...as(w.anna), actor: { ...as(w.anna).actor, channel: 'mcp' } };
    const tool = toolByName('subscribe')!;
    const preview = await tool.preview!(ctx, { saved_search: 'release blockers', events: 'new', email: true });
    expect(preview).toBe('Subscribe to the saved search “Release blockers”: you\'ll be told of an issue coming into it, by email too');
    const done = await tool.run(ctx, { saved_search: 'Release blockers', events: 'new', email: true });
    expect(done.summary).toBe('Subscribed: Issues coming into “Release blockers”');
    const listed = await toolByName('list_subscriptions')!.run(ctx, {});
    expect(listed.data).toContainEqual(expect.objectContaining({ saved_search: 'Release blockers', events: 'new', email: true }));
    const ended = await tool.run(ctx, { saved_search: search.id, events: 'none', email: true });
    expect(ended.summary).toBe('Unsubscribed from issues coming into “Release blockers”');
    expect((await listSubscriptions(as(w.anna))).filter((s) => s.search?.id === search.id)).toEqual([]);
  });
});

describe('what time alone brings into a search', () => {
  it("tells of an issue becoming overdue at the day’s turn, its “new” subscribers alone, and reads no clock-free search", async () => {
    const field = await createField(w.adminCtx, { name: 'Deadline', type: 'date', multi: false, description: '', values: [] });
    await attachField(w.adminCtx, 'BACK', field.id, {});
    const search = await createSavedSearch(as(w.anna), { name: 'Overdue in BACK', query: 'project: BACK Deadline: overdue', shared: true });
    const mine = await subscribe(as(w.anna), { savedSearch: search.id, events: 'new' });
    const every = await subscribe(as(w.viewer), { savedSearch: search.id, events: 'all', email: false });
    // Due today, not overdue yet: nothing in the search, nothing to tell.
    const issue = await createIssue(as(w.ben), { project: 'BACK', summary: 'The invoice audit', fields: { Deadline: todayISO() } });
    // A search whose words read no clock is left to the events alone.
    const plain = await createSavedSearch(as(w.anna), { name: 'Critical anywhere', query: 'Priority: Critical', shared: false });
    const quiet = await subscribe(as(w.anna), { savedSearch: plain.id, events: 'new' });
    await flush();
    expect(await told(w.anna, issue.id)).toEqual([]);
    expect(await told(w.viewer, issue.id)).toEqual([]);

    // The day turns: the issue becomes overdue with nothing changing, and the chore says so.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 26 * 3_600_000);
    try {
      expect(await recheckSearches(w.app)).toBe(1);
      // Once: what it found is kept, so reading again tells nobody again.
      expect(await recheckSearches(w.app)).toBe(0);
      await mailer.drain();
    } finally {
      vi.useRealTimers();
    }
    const [n] = await told(w.anna, issue.id);
    expect(n).toMatchObject({
      kind: 'subscribed',
      title: 'It came into a search you follow',
      subscription: { id: mine.id, about: 'issues coming into “Overdue in BACK”', target: 'search', events: 'new', name: 'Overdue in BACK' },
    });
    // No event behind it: the issue alone, no lines of changes under it.
    expect(n!.events).toEqual([]);
    // 'Every change' hears nothing: time brought it in, nothing changed.
    expect(await told(w.viewer, issue.id)).toEqual([]);
    // The email her subscription asked for, with the link that stops its email alone.
    const mail = smtp.messages.find((m) => m.to.includes('anna@example.com'));
    expect(mail?.text).toContain('It came into a search you follow');
    expect(mail?.text).toContain('You get this because you subscribed to issues coming into “Overdue in BACK”.');
    expect(mail?.text).toContain('Stop emails about issues coming into “Overdue in BACK”');

    // Time takes it out again (the clock put back): nothing is told, and coming back later is news again.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      expect(await recheckSearches(w.app)).toBe(0);
      const kept = await w.app.db.select().from(subscriptionIssues).where(eq(subscriptionIssues.subscriptionId, mine.id));
      expect(kept.map((r) => r.issueId)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
    await unsubscribe(as(w.anna), mine.id);
    await unsubscribe(as(w.viewer), every.id);
    await unsubscribe(as(w.anna), quiet.id);
  });
});
