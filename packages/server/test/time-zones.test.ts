/**
 * Per-person time zones (D31): what "today" and a day's bounds are in searches, across zones and
 * across clock changes; the profile's zone; the digest's hour; email's times; the day work is logged on.
 */
import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemCtx } from '../src/app-services';
import type { Ctx, UserRow } from '../src/context';
import { issues, mailOutbox, notificationSettings, users } from '../src/db/schema';
import { OutboxWorker } from '../src/events/worker';
import { createHttpApp } from '../src/http/app';
import { MailWorker, scheduleDigests } from '../src/mail/outbox';
import { notifierConsumer } from '../src/notify/notifier';
import { emailTime } from '../src/notify/words';
import { serverTimeZone, todayIn } from '../src/reports/tz';
import { compileQuery } from '../src/search/compiler';
import { parseQuery } from '../src/search/parser';
import { prepareQuery } from '../src/search/service';
import { buildVocabulary } from '../src/search/vocabulary';
import { runCommand } from '../src/commands/executor';
import { issueTokenFor } from '../src/services/auth';
import { createIssue, getIssue, resolveIssue, updateIssue } from '../src/services/issues';
import { listNotifications, updateNotificationSettings } from '../src/services/notifications';
import { createProject } from '../src/services/projects';
import { zoneOf, zoneOfUser } from '../src/services/time-zones';
import { insertUser, updateMe } from '../src/services/users';
import { logWork } from '../src/services/workitems';
import { createWorld, type TestWorld } from './helpers';
import { fakeSmtp, type FakeSmtp } from './smtp';

let w: TestWorld;
let smtp: FakeSmtp;
let tokyo: UserRow;
let newYork: UserRow;

const as = (u: UserRow): Ctx => systemCtx(w.app, u, 'web');
async function withZone(u: UserRow, timeZone: string | null): Promise<UserRow> {
  await w.app.db.update(users).set({ timeZone }).where(eq(users.id, u.id));
  w.app.schema.invalidate();
  return (await w.app.db.select().from(users).where(eq(users.id, u.id)))[0]!;
}

/** Issue summaries in project TZ a query finds, read in a zone at a moment. */
async function found(query: string, timeZone: string, now?: Date): Promise<string[]> {
  const s = await w.app.schema.get();
  const compiled = compileQuery(parseQuery(`project: TZ ${query}`, buildVocabulary(s)), { s, meId: w.admin.id, timeZone, now });
  expect(compiled.problems).toEqual([]);
  const rows = await w.app.db.select({ summary: issues.summary }).from(issues).where(compiled.where!);
  return rows.map((r) => r.summary).sort();
}

/** An issue in TZ made at a moment, as if then. */
async function madeAt(summary: string, at: string, fields: Record<string, string> = {}) {
  const issue = await createIssue(w.adminCtx, { project: 'TZ', summary, fields });
  await w.app.db.update(issues).set({ createdAt: new Date(at) }).where(eq(issues.summary, summary));
  return issue;
}

beforeAll(async () => {
  smtp = await fakeSmtp(0);
  w = await createWorld({ config: { smtpUrl: smtp.url, notifyWindowMs: 0, publicUrl: 'http://a4a.test', digestHour: 8 } });
  await createProject(w.adminCtx, { key: 'TZ', name: 'Zones', template: 'software' });
  tokyo = await insertUser(w.app.db, { login: 'kenji', name: 'Kenji Sato', email: 'kenji@example.com' });
  newYork = await insertUser(w.app.db, { login: 'maya', name: 'Maya Brooks', email: 'maya@example.com' });
  tokyo = await withZone(tokyo, 'Asia/Tokyo');
  newYork = await withZone(newYork, 'America/New_York');
  // Days that clocks change: Berlin springs forward on 29 March 2026, New York falls back on 1 November.
  await madeAt('Berlin, 00:30 on the 29th', '2026-03-28T23:30:00Z');
  await madeAt('Berlin, 23:30 on the 29th', '2026-03-29T21:30:00Z');
  await madeAt('Berlin, 00:30 on the 30th', '2026-03-29T22:30:00Z');
  await madeAt('New York, 23:30 on 31 October', '2026-11-01T03:30:00Z');
  await madeAt('New York, 23:30 on 1 November', '2026-11-02T04:30:00Z');
  await madeAt('Kiritimati, just after midnight', '2026-11-16T10:30:00Z', { 'Due date': '2026-11-17' });
});

afterAll(async () => {
  await w?.close();
  await smtp?.close();
});

describe('dates in searches', () => {
  it("bounds a day where the asker is, across the day clocks spring forward (23 hours)", async () => {
    expect(await found('created: 2026-03-29', 'Europe/Berlin')).toEqual(['Berlin, 00:30 on the 29th', 'Berlin, 23:30 on the 29th']);
    expect(await found('created: 2026-03-30', 'Europe/Berlin')).toEqual(['Berlin, 00:30 on the 30th']);
    expect(await found('created: 2026-03-29', 'UTC')).toEqual(['Berlin, 00:30 on the 30th', 'Berlin, 23:30 on the 29th']);
  });

  it('and across the day clocks fall back (25 hours)', async () => {
    expect(await found('created: 2026-11-01', 'America/New_York')).toEqual(['New York, 23:30 on 1 November']);
    expect(await found('created: 2026-10-31', 'America/New_York')).toEqual(['New York, 23:30 on 31 October']);
    expect(await found('created: 2026-11-01', 'UTC')).toEqual(['New York, 23:30 on 31 October']);
  });

  it('takes "today" and its kin from where the asker is', async () => {
    // 23:30 UTC on 16 November: already the 17th in Kiritimati (UTC+14), still the 16th in Pago Pago (UTC−11).
    const now = new Date('2026-11-16T23:30:00Z');
    expect(await found('created: today', 'Pacific/Kiritimati', now)).toContain('Kiritimati, just after midnight');
    expect(await found('created: today', 'Pacific/Pago_Pago', now)).not.toContain('Kiritimati, just after midnight');
    expect(await found('created: yesterday', 'Pacific/Pago_Pago', now)).toContain('Kiritimati, just after midnight');
    // A date field holds calendar days: which one is today depends on where you are too.
    expect(await found('Due date: today', 'Pacific/Kiritimati', now)).toEqual(['Kiritimati, just after midnight']);
    expect(await found('Due date: today', 'Pacific/Pago_Pago', now)).toEqual([]);
    expect(await found('Due date: tomorrow', 'Pacific/Pago_Pago', now)).toEqual(['Kiritimati, just after midnight']);
    expect(await found('Due date: {this week}', 'Pacific/Kiritimati', now)).toEqual(['Kiritimati, just after midnight']);
  });

  it("reads a person's searches in their zone, and says so", async () => {
    const reading = await prepareQuery(as(tokyo), 'created: today');
    expect(reading.explanation).toMatch(/\(dates in Asia\/Tokyo\)$/);
    expect((await prepareQuery(as(newYork), 'Due date: Overdue')).explanation).toMatch(/\(dates in America\/New_York\)$/);
    // A search with no dates in it has nothing to say about zones.
    expect((await prepareQuery(as(tokyo), 'project: TZ #Unresolved')).explanation).not.toMatch(/dates in/);
  });
});

describe('a person’s zone', () => {
  it('is set on the profile, by its canonical name, and refused when unknown', async () => {
    const ctx = as(w.anna);
    await updateMe(ctx, { timeZone: 'US/Eastern' });
    expect((await w.app.db.select().from(users).where(eq(users.id, w.anna.id)))[0]!.timeZone).toBe('America/New_York');
    await expect(updateMe(ctx, { timeZone: 'Mars/Olympus_Mons' })).rejects.toMatchObject({ status: 400, message: 'Unknown time zone "Mars/Olympus_Mons"' });
    await updateMe(ctx, { timeZone: null });
    expect((await w.app.db.select().from(users).where(eq(users.id, w.anna.id)))[0]!.timeZone).toBeNull();
  });

  it("is the server's for anyone without one: rules, agents of their own, and people who didn't say", async () => {
    expect(zoneOfUser({ timeZone: null })).toBe(serverTimeZone());
    expect(zoneOfUser({ timeZone: 'Nowhere/Atlantis' })).toBe(serverTimeZone());
    expect(zoneOf(as(tokyo))).toBe('Asia/Tokyo');
  });

  it('shows on /me with the server’s, and changes there', async () => {
    const http = createHttpApp(w.app);
    const token = (await issueTokenFor(w.app.db, w.ben.id, { name: 'ben', scopes: ['read', 'write'] })).token;
    const call = (method: string, body?: unknown) =>
      http.request('/api/v1/me', { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    expect(await (await call('GET')).json()).toMatchObject({ timeZone: null, serverTimeZone: serverTimeZone() });
    const changed = await call('PATCH', { timeZone: 'Europe/Lisbon' });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ login: 'ben', timeZone: 'Europe/Lisbon' });
    expect(await (await call('GET')).json()).toMatchObject({ timeZone: 'Europe/Lisbon' });
    const bad = await call('PATCH', { timeZone: 'Somewhere/Else' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { hint: 'Use an IANA name such as Europe/Berlin, America/New_York or UTC.' } });
  });

  it('is the day work is logged on, and the day "today" is in a command or a field', async () => {
    const kiritimati = await withZone(await insertUser(w.app.db, { login: 'teata', name: 'Teata Tito' }), 'Pacific/Kiritimati');
    const pagoPago = await withZone(await insertUser(w.app.db, { login: 'sina', name: 'Sina Lefiti' }), 'Pacific/Pago_Pago');
    const issue = await createIssue(w.adminCtx, { project: 'TZ', summary: 'Logged from both ends of the day' });
    // 25 hours apart: their days always differ.
    expect(todayIn('Pacific/Kiritimati')).not.toBe(todayIn('Pacific/Pago_Pago'));
    expect((await logWork(as(kiritimati), issue.id, { duration: '1h' })).date).toBe(todayIn('Pacific/Kiritimati'));
    expect((await logWork(as(pagoPago), issue.id, { duration: '1h' })).date).toBe(todayIn('Pacific/Pago_Pago'));

    const due = async () => (await getIssue(w.adminCtx, issue.id)).fields.find((f) => f.name === 'Due date')?.value;
    await updateIssue(as(kiritimati), issue.id, { fields: { 'Due date': 'today' } });
    expect(await due()).toBe(todayIn('Pacific/Kiritimati'));
    await runCommand(as(pagoPago), { issues: [issue.id], command: 'Due date today' });
    expect(await due()).toBe(todayIn('Pacific/Pago_Pago'));
  });
});

describe('the digest and email', () => {
  it('queues each digest at the digest hour where its person is, once a day of theirs', async () => {
    for (const u of [tokyo, newYork]) await updateNotificationSettings(as(u), { digest: true });
    const queued = async () =>
      (await w.app.db.select({ key: mailOutbox.dedupeKey }).from(mailOutbox).where(like(mailOutbox.dedupeKey, 'digest:%'))).map((r) => r.key).sort();
    // 22:30 UTC: 07:30 tomorrow in Tokyo (not yet), 17:30 today in New York (past 08:00).
    await scheduleDigests(w.app, new Date('2026-11-16T22:30:00Z'));
    expect(await queued()).toEqual([`digest:${newYork.id}:2026-11-16`]);
    // 23:05 UTC: 08:05 in Tokyo. New York's is queued already: once a day.
    await scheduleDigests(w.app, new Date('2026-11-16T23:05:00Z'));
    expect(await queued()).toEqual([`digest:${newYork.id}:2026-11-16`, `digest:${tokyo.id}:2026-11-17`].sort());
    // New York's went out; its next is at 08:00 New York time the next day, not before.
    await w.app.db.update(notificationSettings).set({ lastDigestAt: new Date('2026-11-16T22:31:00Z') }).where(eq(notificationSettings.userId, newYork.id));
    await scheduleDigests(w.app, new Date('2026-11-17T12:00:00Z'));
    expect(await queued()).not.toContain(`digest:${newYork.id}:2026-11-17`);
    await scheduleDigests(w.app, new Date('2026-11-17T13:30:00Z'));
    expect(await queued()).toContain(`digest:${newYork.id}:2026-11-17`);
  });

  it('writes the times in an email in its reader’s zone, named', async () => {
    expect(emailTime('2026-11-16T22:30:00.000Z', 'Asia/Tokyo')).toMatch(/^Tue 17 Nov, 07:30 /);
    expect(emailTime('2026-11-16T22:30:00.000Z', 'America/New_York')).toMatch(/^Mon 16 Nov, 17:30 /);

    const outbox = new OutboxWorker(w.app, [notifierConsumer(w.app)], {}, [], () => {});
    await outbox.drain();
    const mailer = new MailWorker(w.app, () => new Date(Date.now() + 10 * 60_000));
    await mailer.drain();
    smtp.messages.length = 0;
    const issue = await createIssue(w.adminCtx, { project: 'TZ', summary: 'For Kenji', fields: { Assignee: 'kenji' } });
    await outbox.drain();
    await mailer.drain();
    const [n] = (await listNotifications(as(tokyo), { issue: issue.id })).items;
    const mail = smtp.messages.find((m) => m.to.includes('kenji@example.com'));
    expect(mail?.text).toContain(emailTime(n!.events[0]!.occurredAt, 'Asia/Tokyo'));
    await outbox.stop();
    expect((await resolveIssue(w.adminCtx, issue.id)).id).toBeTruthy();
    expect(await w.app.db.select().from(issues).where(and(eq(issues.summary, 'For Kenji')))).toHaveLength(1);
  });
});
