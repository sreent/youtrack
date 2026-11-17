import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminCtx, systemCtx } from '../src/app-services';
import type { Ctx, UserRow } from '../src/context';
import { activities, mailOutbox, notificationEvents, notifications, users } from '../src/db/schema';
import { toEventDto } from '../src/events/activity';
import { OutboxWorker } from '../src/events/worker';
import { helpdeskConsumer } from '../src/helpdesk/consumer';
import { createHttpApp } from '../src/http/app';
import { MailWorker, scheduleDigests } from '../src/mail/outbox';
import type { MailTransport, OutgoingMail } from '../src/mail/transport';
import { notifierConsumer, notifyEvent } from '../src/notify/notifier';
import { endInboxStreams, setMailTransportForTests } from '../src/notify/state';
import type { Signal } from '../src/events/signals';
import { searchIssues } from '../src/search/service';
import { issueTokenFor } from '../src/services/auth';
import { addComment, updateComment } from '../src/services/comments';
import { createIssue, deleteIssue, updateIssue } from '../src/services/issues';
import { getNotification, listNotifications, markNotifications, unreadCount, updateNotificationSettings } from '../src/services/notifications';
import { listWatchers, unwatchIssue, watchIssue } from '../src/services/watchers';
import { TRIAGE_BOT } from '../src/db/defaults';
import { toolByName } from '../src/tools/registry';
import { createWorld, type TestWorld } from './helpers';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalDiskStorage, setAttachmentStorage } from '../src/attachments/storage';
import { fakeSmtp, type FakeSmtp } from './smtp';

let w: TestWorld;
let smtp: FakeSmtp;
let outbox: OutboxWorker;
/** The mail sender, ten minutes ahead, so every notification's window has passed. */
let mailer: MailWorker;
let chloe: UserRow;

const as = (u: UserRow): Ctx => systemCtx(w.app, u, 'web');
const run = () => outbox.drain();
/** Deliver and send everything waiting, then forget what was sent: a test starts with no mail. */
async function flush() {
  await run();
  await mailer.drain();
  smtp.messages.length = 0;
}

async function inbox(u: UserRow, opts: { unread?: boolean } = {}) {
  return (await listNotifications(as(u), { unread: opts.unread, limit: 100 })).items;
}

beforeAll(async () => {
  smtp = await fakeSmtp();
  w = await createWorld({ config: { smtpUrl: smtp.url, notifyWindowMs: 60_000, publicUrl: 'http://a4a.test' } });
  for (const [u, email] of [
    [w.anna, 'anna@example.com'],
    [w.ben, 'ben@example.com'],
    [w.viewer, 'vera@example.com'],
  ] as const) {
    await w.app.db.update(users).set({ email }).where(eq(users.id, u.id));
  }
  const { insertUser } = await import('../src/services/users');
  chloe = await insertUser(w.app.db, { login: 'chloe.m', name: 'Chloé Martin', email: 'chloe@example.com' });
  w.app.schema.invalidate();
  const fresh = async (u: UserRow) => (await w.app.db.select().from(users).where(eq(users.id, u.id)))[0]!;
  w.anna = await fresh(w.anna);
  w.ben = await fresh(w.ben);
  w.viewer = await fresh(w.viewer);
  outbox = new OutboxWorker(w.app, [notifierConsumer(w.app), helpdeskConsumer(w.app)], {}, [], () => {});
  await outbox.drain(); // the consumers start from here
  mailer = new MailWorker(w.app, () => new Date(Date.now() + 10 * 60_000));
});

afterAll(async () => {
  await w?.close();
  await smtp?.close();
});

describe('watchers', () => {
  it('watches a new issue for its reporter, its assignee and the people mentioned in it', async () => {
    const issue = await createIssue(as(w.anna), {
      project: 'BACK',
      summary: 'Sign-in page times out',
      description: 'Seen by @vera and @chloe.m. (Not anna@example.com, who is an address.) `@ben` in code mentions nobody.',
      fields: { Assignee: 'ben' },
    });
    const watchers = await listWatchers(as(w.anna), issue.id);
    expect(watchers.watching).toBe(true);
    expect(watchers.watchers.map((x) => [x.user.login, x.reason])).toEqual([
      ['anna', 'reporter'],
      ['ben', 'assignee'],
      ['vera', 'mentioned'],
      ['chloe.m', 'mentioned'],
    ]);
  });

  it('watches for whoever comments, and again for someone mentioned after they unwatched', async () => {
    const issue = await createIssue(as(w.anna), { project: 'BACK', summary: 'Export to CSV drops the header row' });
    await addComment(as(w.ben), issue.id, 'Same on my machine.');
    expect((await listWatchers(as(w.ben), issue.id)).watching).toBe(true);
    expect((await unwatchIssue(as(w.ben), issue.id)).watching).toBe(false);
    // Unwatched stays unwatched while nothing involves them…
    await updateIssue(as(w.anna), issue.id, { fields: { Priority: 'Major' } });
    expect((await listWatchers(as(w.ben), issue.id)).watching).toBe(false);
    // …until someone calls on them again.
    await addComment(as(w.anna), issue.id, 'Could you check the fix, @ben?');
    expect((await listWatchers(as(w.ben), issue.id)).watchers.find((x) => x.user.login === 'ben')?.reason).toBe('mentioned');
  });

  it('makes watching and unwatching idempotent, and each person their own', async () => {
    const issue = await createIssue(as(w.anna), { project: 'WEB', summary: 'Tooltip covers the save button' });
    await watchIssue(as(w.ben), issue.id);
    await watchIssue(as(w.ben), issue.id);
    const after = await listWatchers(as(w.anna), issue.id);
    expect(after.watchers.filter((x) => x.user.login === 'ben')).toHaveLength(1);
    expect(after.watchers.find((x) => x.user.login === 'ben')?.reason).toBe('explicit');
    await unwatchIssue(as(w.ben), issue.id);
    await unwatchIssue(as(w.ben), issue.id);
    expect((await listWatchers(as(w.anna), issue.id)).watchers.map((x) => x.user.login)).toEqual(['anna']);
    // A viewer may watch what they can read; it changes nothing on the issue.
    const v = await watchIssue(as(w.viewer), issue.id);
    expect(v.watching).toBe(true);
    const { version } = await (await import('../src/services/issues')).getIssue(as(w.anna), issue.id);
    expect(version).toBe(issue.version);
  });

  it('never lets an agent watch, and refuses a read-only token', async () => {
    const issue = await createIssue(as(w.anna), { project: 'WEB', summary: 'Footer links are not keyboard reachable' });
    const s = await w.app.schema.get();
    const triage = [...s.users.values()].find((u) => u.login === TRIAGE_BOT)!;
    await addComment(systemCtx(w.app, triage, 'automation'), issue.id, 'Looks like a duplicate of WEB-1.');
    expect((await listWatchers(as(w.anna), issue.id)).watchers.map((x) => x.user.login)).not.toContain(TRIAGE_BOT);
    const readOnly: Ctx = { ...as(w.ben), actor: { ...as(w.ben).actor, authMethod: 'token', scopes: ['read'] } };
    await expect(watchIssue(readOnly, issue.id)).rejects.toMatchObject({ status: 403 });
    expect((await listWatchers(readOnly, issue.id)).watching).toBe(false);
  });

  it('gives issues from before watching existed their watchers, once', async () => {
    const quiet = await createWorld();
    try {
      const issue = await createIssue(quiet.as(quiet.anna), { project: 'BACK', summary: 'Old issue', fields: { Assignee: 'ben' } });
      await addComment(quiet.as(quiet.viewer), issue.id, 'Me too.').catch(() => undefined); // a viewer can't comment
      await addComment(quiet.adminCtx, issue.id, 'Noted.');
      // As it was before watching existed: no watchers, and never backfilled.
      await quiet.app.db.delete((await import('../src/db/schema')).issueWatchers);
      const { backfillWatchers } = await import('../src/services/watchers');
      expect(await backfillWatchers(quiet.app)).toBe(3);
      const watchers = await listWatchers(quiet.as(quiet.anna), issue.id);
      expect(watchers.watchers.map((x) => [x.user.login, x.reason]).sort()).toEqual([
        ['admin', 'commenter'],
        ['anna', 'reporter'],
        ['ben', 'assignee'],
      ]);
      expect(await backfillWatchers(quiet.app)).toBe(0);
    } finally {
      await quiet.close();
    }
  });

  it('finds what you watch with watcher: me', async () => {
    const watched = await createIssue(as(w.ben), { project: 'BACK', summary: 'Rotate the signing keys' });
    const mine = (await searchIssues(as(w.ben), 'watcher: me', 0, 200)).items.map((i) => i.id);
    expect(mine).toContain(watched.id);
    const annas = (await searchIssues(as(w.anna), 'watcher: me', 0, 200)).items.map((i) => i.id);
    expect(annas).not.toContain(watched.id);
    expect((await searchIssues(as(w.anna), 'watcher: ben', 0, 200)).items.map((i) => i.id)).toContain(watched.id);
    expect((await searchIssues(as(w.anna), `has: watchers ${watched.id}`, 0, 10)).total).toBe(1);
  });
});

describe('notifications', () => {
  it('tells the assignee and the people mentioned, and never whoever acted', async () => {
    const issue = await createIssue(as(w.anna), {
      project: 'BACK',
      summary: 'Webhook retries ignore Retry-After',
      description: 'Found while reading the logs with @vera.',
      fields: { Assignee: 'ben' },
    });
    await run();
    const ben = (await inbox(w.ben)).filter((n) => n.issue.id === issue.id);
    expect(ben).toHaveLength(1);
    expect(ben[0]).toMatchObject({ kind: 'assigned', title: 'Anna Schmidt reported it and assigned it to you', readAt: null });
    const vera = (await inbox(w.viewer)).filter((n) => n.issue.id === issue.id);
    expect(vera[0]).toMatchObject({ kind: 'mentioned', title: 'Anna Schmidt mentioned you' });
    expect((await inbox(w.anna)).filter((n) => n.issue.id === issue.id)).toEqual([]);
  });

  it('brings an import in quietly: its reporter there and its assignee watch it, and nobody is told', async () => {
    const imported = { createdAt: new Date('2025-03-01'), updatedAt: new Date('2025-03-02'), resolvedAt: null, reporterId: w.viewer.id, data: { source: 'jira', key: 'OLD-7' } };
    const issue = await createIssue(as(w.anna), { project: 'BACK', summary: 'Imported: payments double-charge', description: 'Reported by @vera there.', fields: { Assignee: 'ben' } }, { imported });
    // A rerun of the import that changes it is history too.
    await updateIssue(as(w.anna), issue.id, { fields: { Priority: 'Major' } }, { data: { imported: imported.data } });
    await run();
    // Whoever ran the import isn't its reporter: the reporter there and the assignee watch it.
    expect((await listWatchers(as(w.anna), issue.id)).watchers.map((x) => [x.user.login, x.reason])).toEqual([
      ['vera', 'reporter'],
      ['ben', 'assignee'],
    ]);
    for (const u of [w.ben, w.viewer, w.anna]) expect((await inbox(u)).filter((n) => n.issue.id === issue.id)).toEqual([]);
  });

  it('folds a burst of changes on one issue into one notification, with the strongest reason', async () => {
    const issue = await createIssue(as(w.anna), { project: 'BACK', summary: 'Audit log misses token names' });
    await watchIssue(as(w.ben), issue.id);
    await updateIssue(as(w.anna), issue.id, { fields: { Priority: 'Critical' } });
    await addComment(as(w.anna), issue.id, 'The token name is dropped in the API layer.');
    await updateIssue(as(w.anna), issue.id, { fields: { Assignee: 'ben' } });
    await run();
    const ben = (await inbox(w.ben)).filter((n) => n.issue.id === issue.id);
    expect(ben).toHaveLength(1);
    expect(ben[0]!.kind).toBe('assigned');
    expect(ben[0]!.eventCount).toBe(3);
    expect(ben[0]!.events.map((e) => e.type)).toEqual(['issue.updated', 'comment.created', 'issue.updated']);
    expect(ben[0]!.title).toBe('Anna Schmidt assigned it to you');
  });

  it('starts a new notification once the last was read, or once the window has passed', async () => {
    const issue = await createIssue(as(w.anna), { project: 'WEB', summary: 'Dark mode loses the focus ring' });
    await watchIssue(as(w.ben), issue.id);
    await updateIssue(as(w.anna), issue.id, { fields: { Priority: 'Major' } });
    await run();
    const [first] = (await inbox(w.ben)).filter((n) => n.issue.id === issue.id);
    await markNotifications(as(w.ben), { ids: [first!.id] });
    await addComment(as(w.anna), issue.id, 'Reproduced in Firefox.');
    await run();
    let mine = (await inbox(w.ben)).filter((n) => n.issue.id === issue.id);
    expect(mine).toHaveLength(2);
    expect(mine[0]!.title).toBe('Anna Schmidt commented');
    // The window: a change long after the last one begins a notification of its own.
    await w.app.db.update(notifications).set({ firstEventAt: new Date(Date.now() - 3_600_000) }).where(eq(notifications.id, mine[0]!.id));
    await updateIssue(as(w.anna), issue.id, { fields: { Priority: 'Minor' } });
    await run();
    mine = (await inbox(w.ben, { unread: true })).filter((n) => n.issue.id === issue.id);
    expect(mine).toHaveLength(2);
  });

  it('never delivers the same event twice, however often the outbox hands it over', async () => {
    const issue = await createIssue(as(w.anna), { project: 'BACK', summary: 'Rate limiter counts OPTIONS requests', fields: { Assignee: 'ben' } });
    const [row] = await w.app.db.select().from(activities).where(and(eq(activities.type, 'issue.created'), sql`${activities.payload}->'issue'->>'id' = ${issue.id}`));
    const event = toEventDto(await w.app.schema.get(), row!);
    await notifyEvent(w.app, event);
    await notifyEvent(w.app, event);
    await run(); // and once more through the outbox itself
    const ben = (await inbox(w.ben)).filter((n) => n.issue.id === issue.id);
    expect(ben).toHaveLength(1);
    expect(ben[0]!.eventCount).toBe(1);
    const rows = await w.app.db.select().from(notificationEvents).where(eq(notificationEvents.eventId, event.id));
    expect(rows).toHaveLength(1);
  });

  it('tells a newly mentioned person when a comment is edited, and nobody else', async () => {
    const issue = await createIssue(as(w.anna), { project: 'BACK', summary: 'Cache keys collide across tenants' });
    const c = await addComment(as(w.anna), issue.id, 'Needs a second pair of eyes.');
    await run();
    await updateComment(as(w.anna), c.id, 'Needs a second pair of eyes: @ben, could you look?');
    await run();
    const ben = (await inbox(w.ben)).filter((n) => n.issue.id === issue.id);
    expect(ben.map((n) => n.kind)).toEqual(['mentioned']);
    // Editing again, with the same mention, tells nobody anew.
    await updateComment(as(w.anna), c.id, 'Needs a second pair of eyes: @ben, could you look today?');
    await run();
    expect((await inbox(w.ben)).filter((n) => n.issue.id === issue.id)[0]!.eventCount).toBe(1);
  });

  it("tells an issue's watchers when it is deleted", async () => {
    const issue = await createIssue(as(w.ben), { project: 'WEB', summary: 'Old banner experiment' });
    await watchIssue(as(w.anna), issue.id);
    await deleteIssue(w.adminCtx, issue.id);
    await run();
    const anna = (await inbox(w.anna)).filter((n) => n.issue.id === issue.id);
    expect(anna).toHaveLength(1);
    expect(anna[0]).toMatchObject({ issueDeleted: true, title: 'Ada Admin deleted it' });
    expect((await inbox(w.ben)).filter((n) => n.issue.id === issue.id)[0]?.issueDeleted).toBe(true);
  });

  it("tells an issue's watchers of a file added to it, and leaves a comment's own files to the comment", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'a4a-notify-files-'));
    setAttachmentStorage(w.app, new LocalDiskStorage(dir));
    try {
      const issue = await createIssue(as(w.ben), { project: 'WEB', summary: 'Upload fails on Safari' });
      await watchIssue(as(w.anna), issue.id);
      await run();
      const attach = toolByName('attach_file')!;
      await attach.run(as(w.ben), attach.input.parse({ to: issue.id, name: 'safari.log', text: 'TypeError: Load failed' }) as never);
      await run();
      const [n] = (await inbox(w.anna)).filter((x) => x.issue.id === issue.id);
      expect(n?.title).toBe('Ben Okafor attached safari.log');
      const comment = await addComment(as(w.ben), issue.id, 'The log from a second try');
      await attach.run(as(w.ben), attach.input.parse({ to: issue.id, comment: comment.id, name: 'again.log', text: 'TypeError: Load failed' }) as never);
      await run();
      const events = (await inbox(w.anna)).filter((x) => x.issue.id === issue.id).flatMap((x) => x.events.map((e) => e.type));
      expect(events).toEqual(['attachment.added', 'comment.created']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps each inbox its own', async () => {
    const issue = await createIssue(as(w.anna), { project: 'BACK', summary: 'Session cookie lacks SameSite', fields: { Assignee: 'ben' } });
    await run();
    const [n] = (await inbox(w.ben)).filter((x) => x.issue.id === issue.id);
    await expect(getNotification(as(w.anna), n!.id)).rejects.toMatchObject({ status: 404 });
    expect((await markNotifications(as(w.anna), { ids: [n!.id] })).changed).toBe(0);
    expect((await getNotification(as(w.ben), n!.id)).readAt).toBeNull();
  });

  it('marks read only what was seen, when told when that was', async () => {
    const issue = await createIssue(as(w.anna), { project: 'BACK', summary: 'Retry budget is per process', fields: { Assignee: 'ben' } });
    await run();
    const [n] = (await inbox(w.ben)).filter((x) => x.issue.id === issue.id);
    const seen = new Date(new Date(n!.lastAt).getTime() - 1000).toISOString();
    expect((await markNotifications(as(w.ben), { issue: issue.id, until: seen })).changed).toBe(0);
    expect((await markNotifications(as(w.ben), { issue: issue.id, until: n!.lastAt })).changed).toBe(1);
    expect((await markNotifications(as(w.ben), { issue: issue.id, read: false })).changed).toBe(1);
    const before = await unreadCount(as(w.ben));
    const res = await markNotifications(as(w.ben), { all: true });
    expect(res.unread).toBe(0);
    expect(res.changed).toBe(before);
    await expect(markNotifications(as(w.ben), {})).rejects.toMatchObject({ status: 400 });
  });

  it('does not tell a banned person', async () => {
    const { insertUser } = await import('../src/services/users');
    const gone = await insertUser(w.app.db, { login: 'gone', name: 'Gone Person', email: 'gone@example.com' });
    w.app.schema.invalidate();
    const issue = await createIssue(as(w.anna), { project: 'BACK', summary: 'Ask @gone about the old cron jobs' , description: '@gone knows.' });
    await w.app.db.update(users).set({ banned: true }).where(eq(users.id, gone.id));
    w.app.schema.invalidate();
    await run();
    const rows = await w.app.db.select().from(notifications).where(eq(notifications.userId, gone.id));
    expect(rows).toEqual([]);
    expect(issue.id).toBeTruthy();
  });
});

describe('email', () => {
  it('emails a mention once its window has passed, with a plain and a simple HTML part', async () => {
    await flush();
    const issue = await createIssue(as(w.anna), { project: 'BACK', summary: 'Token page shows the secret twice' });
    await addComment(as(w.anna), issue.id, 'Can you look at this, @ben?\n\nIt shows twice on Safari only. <script>alert(1)</script>');
    await run();
    await mailer.drain();
    const mails = smtp.messages.filter((m) => m.to.includes('ben@example.com'));
    expect(mails).toHaveLength(1);
    const m = mails[0]!;
    expect(m.headers.get('subject')).toBe(`${issue.id}: Token page shows the secret twice`);
    expect(m.text).toContain('Anna Schmidt mentioned you on');
    // The comment as written, line by line, not the event's one-line excerpt.
    expect(m.text).toMatch(/> Can you look at this, @ben\?\r?\n\s+> \r?\n\s+> It shows twice on Safari only\./);
    expect(m.text).toContain(`http://a4a.test/issues/${issue.id}`);
    expect(m.html).toContain(`href="http://a4a.test/issues/${issue.id}"`);
    expect(m.html).not.toMatch(/<script|<img|src=|style=/i);
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.headers.get('list-unsubscribe')).toMatch(/^<http:\/\/a4a\.test\/api\/v1\/unsubscribe\?token=direct\./);
    expect(m.headers.get('list-unsubscribe-post')).toBe('List-Unsubscribe=One-Click');
    expect(m.headers.get('auto-submitted')).toBe('auto-generated');
    expect(m.headers.get('references')).toMatch(/^<issue-.+@a4a\.test>$/);
    // Sending again sends nothing new: one email per notification.
    await mailer.drain();
    expect(smtp.messages.filter((x) => x.to.includes('ben@example.com'))).toHaveLength(1);
    const [n] = (await inbox(w.ben)).filter((x) => x.issue.id === issue.id);
    const rows = await w.app.db.select().from(mailOutbox).where(eq(mailOutbox.dedupeKey, `notification:${n!.id}`));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('emails changes on watched issues only to those who want everything, and nothing to those who want none', async () => {
    await flush();
    await updateNotificationSettings(as(w.ben), { email: 'all' });
    await updateNotificationSettings(as(w.viewer), { email: 'none' });
    const issue = await createIssue(as(w.anna), { project: 'WEB', summary: 'Pager skips page 2', description: 'cc @vera' });
    await watchIssue(as(w.ben), issue.id);
    await updateIssue(as(w.anna), issue.id, { fields: { Priority: 'Critical' } });
    await run();
    await mailer.drain();
    expect(smtp.messages.filter((m) => m.to.includes('ben@example.com'))).toHaveLength(1);
    expect(smtp.messages.filter((m) => m.to.includes('vera@example.com'))).toHaveLength(0);
    await updateNotificationSettings(as(w.ben), { email: 'direct' });
    await updateNotificationSettings(as(w.viewer), { email: 'direct' });
    // With mentions and assignments only, a change on a watched issue stays in the inbox.
    await updateIssue(as(w.anna), issue.id, { fields: { Priority: 'Minor' } });
    await w.app.db.update(notifications).set({ readAt: new Date() }).where(eq(notifications.userId, w.ben.id));
    await updateIssue(as(w.anna), issue.id, { fields: { Priority: 'Major' } });
    await run();
    await mailer.drain();
    expect(smtp.messages.filter((m) => m.to.includes('ben@example.com'))).toHaveLength(1);
  });

  it('retries a refused email with backoff, and gives up on one that will never go', async () => {
    await flush();
    const issue = await createIssue(as(w.anna), { project: 'BACK', summary: 'Backoff test', fields: { Assignee: 'ben' } });
    await run();
    smtp.refuse(451);
    await mailer.drain();
    const [n] = (await inbox(w.ben)).filter((x) => x.issue.id === issue.id);
    const [row] = await w.app.db.select().from(mailOutbox).where(eq(mailOutbox.dedupeKey, `notification:${n!.id}`));
    expect(row).toMatchObject({ status: 'pending', attempts: 1 });
    expect(row!.lastError).toMatch(/Try again/);
    expect(row!.sendAfter.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000); // a minute after the sender's own "now"
    await new MailWorker(w.app, () => new Date(Date.now() + 30 * 60_000)).drain();
    const [after] = await w.app.db.select().from(mailOutbox).where(eq(mailOutbox.id, row!.id));
    expect(after).toMatchObject({ status: 'sent', attempts: 2 });
    expect(smtp.messages.filter((m) => m.to.includes('ben@example.com'))).toHaveLength(1);

    const other = await createIssue(as(w.anna), { project: 'BACK', summary: 'Never goes', fields: { Assignee: 'ben' } });
    await run();
    smtp.refuse(550);
    await mailer.drain();
    const [m] = (await inbox(w.ben)).filter((x) => x.issue.id === other.id);
    const [failed] = await w.app.db.select().from(mailOutbox).where(eq(mailOutbox.dedupeKey, `notification:${m!.id}`));
    expect(failed).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('sends a mail once even when two senders try at the same time', async () => {
    await flush();
    const sent: OutgoingMail[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: MailTransport = { send: async (mail) => void (await gate, sent.push(mail)) };
    setMailTransportForTests(w.app, slow);
    try {
      const issue = await createIssue(as(w.anna), { project: 'WEB', summary: 'Two senders', fields: { Assignee: 'ben' } });
      await run();
      const clock = () => new Date(Date.now() + 10 * 60_000);
      const a = new MailWorker(w.app, clock).drain();
      const b = new MailWorker(w.app, clock).drain();
      await new Promise((r) => setTimeout(r, 50));
      release();
      await Promise.all([a, b]);
      expect(sent.filter((m) => m.subject.startsWith(issue.id))).toHaveLength(1);
    } finally {
      setMailTransportForTests(w.app, undefined as never);
    }
  });

  it("doesn't email what was read in the app before its email went", async () => {
    await flush();
    const issue = await createIssue(as(w.anna), { project: 'BACK', summary: 'Read before mailed', fields: { Assignee: 'ben' } });
    await run();
    await markNotifications(as(w.ben), { issue: issue.id });
    await mailer.drain();
    expect(smtp.messages.filter((m) => m.to.includes('ben@example.com'))).toHaveLength(0);
    const [n] = (await inbox(w.ben)).filter((x) => x.issue.id === issue.id);
    const [row] = await w.app.db.select().from(mailOutbox).where(eq(mailOutbox.dedupeKey, `notification:${n!.id}`));
    expect(row!.status).toBe('skipped');
  });

  it('stops by the one-click link in List-Unsubscribe, and refuses a forged one', async () => {
    await flush();
    const issue = await createIssue(as(w.anna), { project: 'BACK', summary: 'Unsubscribe me', fields: { Assignee: 'ben' } });
    await run();
    await mailer.drain();
    const mail = smtp.messages.find((m) => m.to.includes('ben@example.com'))!;
    const url = new URL(/^<(.+)>$/.exec(mail.headers.get('list-unsubscribe')!)![1]!);
    const http = createHttpApp(w.app);
    const described = await http.request(`${url.pathname}${url.search}`);
    expect(described.status).toBe(200);
    expect(((await described.json()) as { done: boolean }).done).toBe(false);
    // The one-click POST, as a mail client sends it: no cookie, no origin, a form body.
    const done = await http.request(`${url.pathname}${url.search}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ done: true });
    expect((await (await import('../src/services/notifications')).getNotificationSettings(as(w.ben))).email).toBe('none');
    const forged = url.searchParams.get('token')!.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expect((await http.request(`/api/v1/unsubscribe?token=${encodeURIComponent(forged)}`, { method: 'POST' })).status).toBe(404);
    const otherKind = url.searchParams.get('token')!.replace(/^direct\./, 'digest.');
    expect((await http.request(`/api/v1/unsubscribe?token=${encodeURIComponent(otherKind)}`, { method: 'POST' })).status).toBe(404);
    // With email off, the inbox still has it.
    await updateIssue(as(w.anna), issue.id, { fields: { Assignee: 'vera' } });
    await updateIssue(as(w.anna), issue.id, { fields: { Assignee: 'ben' } });
    await run();
    await mailer.drain();
    expect(smtp.messages.filter((m) => m.to.includes('ben@example.com'))).toHaveLength(1);
    await updateNotificationSettings(as(w.ben), { email: 'direct' });
  });

  it('sends a daily digest of what is still unread and was not emailed, once a day', async () => {
    await flush();
    await updateNotificationSettings(as(chloe), { digest: true, email: 'none' });
    const issue = await createIssue(as(w.anna), { project: 'WEB', summary: 'Digest material', description: 'For @chloe.m' });
    await run();
    const at = new Date();
    at.setHours(Math.max(w.app.config.digestHour, at.getHours()), 30, 0, 0);
    if (at.getTime() < Date.now()) at.setTime(Date.now() + 1000);
    expect(await scheduleDigests(w.app, at)).toBe(1);
    expect(await scheduleDigests(w.app, at)).toBe(0);
    await new MailWorker(w.app, () => new Date(at.getTime() + 60_000)).drain();
    const digests = smtp.messages.filter((m) => m.to.includes('chloe@example.com'));
    expect(digests).toHaveLength(1);
    expect(digests[0]!.headers.get('subject')).toMatch(/^Your a4a digest: 1 unread notification$/);
    expect(digests[0]!.text).toContain(issue.id);
    expect(digests[0]!.headers.get('list-unsubscribe')).toContain('token=digest.');
  });
});

describe('without SMTP', () => {
  it('sends nothing and fails nothing', async () => {
    const quiet = await createWorld();
    try {
      const worker = new OutboxWorker(quiet.app, [notifierConsumer(quiet.app), helpdeskConsumer(quiet.app)], {}, [], () => {});
      await worker.drain();
      await quiet.app.db.update(users).set({ email: 'ben@example.com' }).where(eq(users.id, quiet.ben.id));
      quiet.app.schema.invalidate();
      const issue = await createIssue(quiet.as(quiet.anna), { project: 'BACK', summary: 'Quiet', fields: { Assignee: 'ben' } });
      await worker.drain();
      await new MailWorker(quiet.app).drain();
      expect(await quiet.app.db.select().from(mailOutbox)).toEqual([]);
      const ben = (await listNotifications(quiet.as(quiet.ben))).items;
      expect(ben.map((n) => n.issue.id)).toEqual([issue.id]);
      expect((await (await import('../src/services/notifications')).getNotificationSettings(quiet.as(quiet.ben))).mailConfigured).toBe(false);
    } finally {
      await quiet.close();
    }
  });
});

describe('the channels', () => {
  let http: ReturnType<typeof createHttpApp>;
  let token = '';
  let readToken = '';
  const call = async (method: string, path: string, opts: { body?: unknown; token?: string } = {}) => {
    const res = await http.request(`/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${opts.token ?? token}`, ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  beforeAll(async () => {
    http = createHttpApp(w.app);
    token = (await issueTokenFor(w.app.db, w.ben.id, { name: 'claude-code', scopes: ['read', 'write'] })).token;
    readToken = (await issueTokenFor(w.app.db, w.ben.id, { name: 'explorer', scopes: ['read'] })).token;
  });

  it('REST: watch, unwatch, the inbox, marking read and settings', async () => {
    const issue = await createIssue(as(w.anna), { project: 'BACK', summary: 'REST watch test' });
    expect((await call('PUT', `/issues/${issue.id}/watchers/me`)).body).toMatchObject({ watching: true });
    expect((await call('PUT', `/issues/${issue.id}/watchers/me`, { token: readToken })).status).toBe(403);
    expect((await call('GET', `/issues/${issue.id}/watchers`, { token: readToken })).body.watchers.map((x: { user: { login: string } }) => x.user.login)).toEqual(['anna', 'ben']);
    await addComment(as(w.anna), issue.id, 'REST says hello');
    await run();
    const list = await call('GET', `/notifications?unread=true&issue=${issue.id}`, { token: readToken });
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ kind: 'watching', title: 'Anna Schmidt commented', project: 'BACK' });
    expect((await call('GET', '/notifications/count')).body.unread).toBe(list.body.unread);
    expect((await call('POST', '/notifications/read', { body: { ids: [list.body.items[0].id] }, token: readToken })).status).toBe(403);
    const marked = await call('PATCH', `/notifications/${list.body.items[0].id}`, { body: { read: true } });
    expect(marked.body.readAt).not.toBeNull();
    expect((await call('PATCH', '/notifications/nope', { body: { read: true } })).status).toBe(404);
    expect((await call('DELETE', `/issues/${issue.id}/watchers/me`)).body).toMatchObject({ watching: false });
    expect((await call('PATCH', '/me/notification-settings', { body: { email: 'all', digest: true } })).body).toMatchObject({ email: 'all', digest: true, mailConfigured: true, address: 'ben@example.com' });
    expect((await call('PATCH', '/me/notification-settings', { body: { email: 'sometimes' } })).status).toBe(400);
    await call('PATCH', '/me/notification-settings', { body: { email: 'direct', digest: false } });
  });

  it('SSE: the unread count, as it changes', async () => {
    const res = await http.request('/api/v1/notifications/stream', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    const next = async () => {
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buf += value;
        const m = /event: unread\ndata: (.+)\n/.exec(buf);
        if (m) return JSON.parse(m[1]!) as { unread: number };
      }
    };
    const first = await next();
    await createIssue(as(w.anna), { project: 'WEB', summary: 'Live count test', fields: { Assignee: 'ben' } });
    await run();
    const second = await next();
    expect(second.unread).toBe(first.unread + 1);
    await reader.cancel();
  });

  it('SSE: counts again when another instance changed the inbox, and ends when the server stops', async () => {
    const res = await http.request('/api/v1/notifications/stream', { headers: { authorization: `Bearer ${token}` } });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    const next = async () => {
      for (;;) {
        const m = /event: unread\ndata: (.+)\n\n/.exec(buf);
        if (m) {
          buf = buf.slice(m.index + m[0].length);
          return JSON.parse(m[1]!) as { unread: number };
        }
        const { value, done } = await reader.read();
        if (done) return null;
        buf += value;
      }
    };
    const first = (await next())!;
    // Another instance delivered one: its row is here, and its NOTIFY arrives as a signal.
    const [row] = await w.app.db.select().from(notifications).where(eq(notifications.userId, w.ben.id)).limit(1);
    await w.app.db.update(notifications).set({ readAt: null }).where(eq(notifications.id, row!.id));
    const before = first.unread + (row!.readAt ? 1 : 0);
    const fanout = (w.app.signals as unknown as { fanout: { dispatch(s: Signal): void } }).fanout;
    fanout.dispatch({ kind: 'inbox', origin: 'another-instance', users: [w.ben.id] });
    expect((await next())!.unread).toBe(before);
    // After LISTEN reconnects, everyone's stream counts again; an unchanged count says nothing.
    await w.app.db.update(notifications).set({ readAt: new Date() }).where(eq(notifications.id, row!.id));
    fanout.dispatch({ kind: 'resync' });
    expect((await next())!.unread).toBe(before - 1);
    // Shutting down ends the stream, so the server can close; the client reconnects elsewhere.
    endInboxStreams(w.app);
    expect(await next()).toBeNull();
  });

  it('MCP: watch_issue, unwatch_issue, list_notifications and mark_notifications_read', async () => {
    const ctx: Ctx = { ...adminCtx(w.app, w.ben, 'mcp'), actor: { ...adminCtx(w.app, w.ben, 'mcp').actor, scopes: ['read', 'write'], authMethod: 'token', tokenName: 'claude-code' } };
    const issue = await createIssue(as(w.anna), { project: 'BACK', summary: 'MCP watch test' });
    const watch = toolByName('watch_issue')!;
    expect((await watch.run(ctx, { issue: issue.id })).data).toMatchObject({ watching: true });
    expect(await watch.preview!(ctx, { issue: issue.id })).toContain('Watch');
    await updateIssue(as(w.anna), issue.id, { fields: { State: 'In Progress' } });
    await run();
    const listed = (await toolByName('list_notifications')!.run(ctx, { unread_only: true, limit: 30 })).data as {
      unread: number;
      issues: { issue: string; notifications: { what: string; events: { by: string; did: string; detail: string[] }[] }[] }[];
    };
    const group = listed.issues.find((g) => g.issue === issue.id)!;
    expect(group.notifications[0]!.what).toBe('Anna Schmidt changed State');
    expect(group.notifications[0]!.events[0]).toMatchObject({ by: 'Anna Schmidt', detail: ['State: Open → In Progress'] });
    const marked = (await toolByName('mark_notifications_read')!.run(ctx, { issue: issue.id })).data as { changed: number };
    expect(marked.changed).toBe(1);
    expect((await toolByName('unwatch_issue')!.run(ctx, { issue: issue.id })).data).toMatchObject({ watching: false });
  });
});
