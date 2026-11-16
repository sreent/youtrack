/**
 * Days away (D36): who may enter them and see why, what's refused and how to put it right, the
 * plans that skip them, the load grid's remembered window, and the same over REST.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserRow } from '../src/context';
import { createHttpApp } from '../src/http/app';
import { addDays, todayISO, weekday } from '../src/lib/dates';
import { createAbsence, deleteAbsence, getPreferences, listAbsences, updateAbsence, updatePreferences } from '../src/services/absences';
import { issueTokenFor } from '../src/services/auth';
import { createIssue } from '../src/services/issues';
import { addMember } from '../src/services/members';
import { getResourceLoad, getSchedule, level } from '../src/services/planning';
import { createProject } from '../src/services/projects';
import { insertUser } from '../src/services/users';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let dan: UserRow;
let bot: UserRow;
/** The Monday at least a week from today, and the days of its week. */
let mon = '';
const day = (n: number) => addDays(mon, n);

/** Refused, with its status: each call starts only when it's awaited. */
async function refused(call: () => Promise<unknown>): Promise<{ status: number; message: string; hint?: string }> {
  try {
    await call();
  } catch (e) {
    const err = e as { status: number; message: string; hint?: string };
    return { status: err.status, message: err.message, hint: err.hint };
  }
  throw new Error('expected a refusal');
}

beforeAll(async () => {
  w = await createWorld();
  dan = await insertUser(w.app.db, { login: 'dan', name: 'Dan Doe', role: 'member' });
  bot = await insertUser(w.app.db, { login: 'helper', name: 'Helper', role: 'member', isBot: true });
  w.app.schema.invalidate();
  // Ben leads OPS, where Anna works; Dan doesn't. BACK and WEB are open, and nobody there manages.
  await createProject(w.adminCtx, { key: 'OPS', name: 'Operations', template: 'waterfall', visibility: 'members', lead: 'ben' });
  await addMember(w.adminCtx, 'OPS', { user: 'anna', role: 'member' });
  const today = todayISO();
  mon = addDays(today, 7 + ((8 - weekday(today)) % 7));
});
afterAll(async () => w?.close());

describe('who enters days away, and who sees why', () => {
  it('lets a person enter their own; everyone sees when, only some see why', async () => {
    const a = await createAbsence(w.as(w.anna), { from: day(0), to: day(4), kind: 'holiday', note: 'Lisbon' });
    expect([a.user.login, a.from, a.to, a.half, a.kind, a.note, a.canChange, a.createdBy?.login]).toEqual(['anna', day(0), day(4), null, 'holiday', 'Lisbon', true, 'anna']);

    const asBen = (await listAbsences(w.as(w.ben), { user: 'anna' })).find((x) => x.id === a.id)!;
    expect([asBen.from, asBen.to, asBen.kind, asBen.note, asBen.canChange]).toEqual([day(0), day(4), null, null, true]);
    const asDan = (await listAbsences(w.as(dan), { user: 'anna' })).find((x) => x.id === a.id)!;
    expect([asDan.kind, asDan.note, asDan.canChange]).toEqual([null, null, false]);
    const asAdmin = (await listAbsences(w.adminCtx, { user: 'anna' })).find((x) => x.id === a.id)!;
    expect([asAdmin.kind, asAdmin.note, asAdmin.canChange]).toEqual(['holiday', 'Lisbon', true]);
    await deleteAbsence(w.as(w.anna), a.id);
  });

  it('lets a manager enter them for someone who works in their project, and see why, having entered it', async () => {
    const t = await createAbsence(w.as(w.ben), { user: 'anna', from: day(9), kind: 'training' });
    expect([t.user.login, t.kind, t.createdBy?.login]).toEqual(['anna', 'training', 'ben']);
    expect((await listAbsences(w.as(w.anna))).find((x) => x.id === t.id)!.kind).toBe('training');
    expect((await listAbsences(w.as(dan), { user: 'anna' })).find((x) => x.id === t.id)!.kind).toBeNull();
    await deleteAbsence(w.as(w.anna), t.id);
  });

  it("refuses anyone else, and an agent's", async () => {
    const asDan = await refused(() => createAbsence(w.as(dan), { user: 'anna', from: day(0) }));
    expect(asDan).toMatchObject({ status: 403, message: 'You can enter days away for yourself, and for people who work in a project you manage' });
    // Ben manages OPS, which Dan doesn't work in.
    expect((await refused(() => createAbsence(w.as(w.ben), { user: 'dan', from: day(0) }))).status).toBe(403);
    // A read-only role changes no plan.
    expect((await refused(() => createAbsence(w.as(w.viewer), { from: day(0) }))).status).toBe(403);
    expect(await refused(() => createAbsence(w.adminCtx, { user: 'helper', from: day(0) }))).toMatchObject({ status: 400, message: 'helper is an agent, and agents are never away' });
    expect((await refused(() => createAbsence(w.as(w.anna), { user: 'nobody', from: day(0) }))).status).toBe(404);
    const byAdmin = await createAbsence(w.adminCtx, { user: 'dan', from: day(1), kind: 'sick' });
    expect(byAdmin.user.login).toBe('dan');
    await deleteAbsence(w.adminCtx, byAdmin.id);
    expect(bot.isBot).toBe(true);
  });
});

describe("what's refused, and how to put it right", () => {
  it('refuses dates out of order, more than a year, and half of several days', async () => {
    expect(await refused(() => createAbsence(w.as(w.anna), { from: day(4), to: day(0) }))).toMatchObject({
      status: 400,
      message: `The last day away, ${day(0)}, is before the first, ${day(4)}`,
      hint: `Give the first day as "from" and the last as "to": from ${day(0)} to ${day(4)}.`,
    });
    expect(await refused(() => createAbsence(w.as(w.anna), { from: day(0), to: day(400) }))).toMatchObject({ status: 400, hint: `Enter it a year at a time: from ${day(0)} to ${day(365)} first.` });
    expect(await refused(() => createAbsence(w.as(w.anna), { from: day(0), to: day(1), half: 'morning' }))).toMatchObject({ status: 400, message: 'Half a day away is one day' });
  });

  it('refuses days that overlap others, naming them; a morning and an afternoon share nothing', async () => {
    const week = await createAbsence(w.as(w.anna), { from: day(0), to: day(4) });
    const clash = await refused(() => createAbsence(w.as(w.anna), { from: day(3), to: day(8) }));
    expect(clash.status).toBe(409);
    expect(clash.message).toMatch(/^Anna Schmidt is already away \d+ \w+ to \d+ \w+$/);
    const morning = await createAbsence(w.as(w.anna), { from: day(7), half: 'morning' });
    const afternoon = await createAbsence(w.as(w.anna), { from: day(7), half: 'afternoon', kind: 'other' });
    expect((await refused(() => createAbsence(w.as(w.anna), { from: day(7) }))).message).toMatch(/^Anna Schmidt is already away the (morning|afternoon) of /);
    for (const a of [week, morning, afternoon]) await deleteAbsence(w.as(w.anna), a.id);
  });

  it('changes them against the version read, and a half day moved onto several becomes whole days', async () => {
    const a = await createAbsence(w.as(w.anna), { from: day(2), half: 'afternoon' });
    const longer = await updateAbsence(w.as(w.anna), a.id, { to: day(3), expectedVersion: a.version });
    expect([longer.from, longer.to, longer.half, longer.version]).toEqual([day(2), day(3), null, a.version + 1]);
    expect((await refused(() => updateAbsence(w.as(w.anna), a.id, { to: day(4), expectedVersion: a.version }))).status).toBe(409);
    // Moving a one-day absence moves its last day with it.
    const one = await createAbsence(w.as(w.anna), { from: day(9) });
    expect(await updateAbsence(w.as(w.anna), one.id, { from: day(10) })).toMatchObject({ from: day(10), to: day(10) });
    expect((await refused(() => updateAbsence(w.as(dan), a.id, { kind: 'sick' }))).status).toBe(403);
    expect((await refused(() => deleteAbsence(w.as(dan), a.id))).status).toBe(403);
    await deleteAbsence(w.as(w.anna), a.id);
    await deleteAbsence(w.as(w.ben), one.id);
    expect((await listAbsences(w.as(w.anna))).length).toBe(0);
  });
});

describe('plans skip them', () => {
  it("moves a person's work past a day they're away, and shows the day in the load, never why", async () => {
    await createProject(w.adminCtx, { key: 'PLN', name: 'Plan', template: 'waterfall' });
    const ctx = w.as(w.anna);
    const t = await createIssue(ctx, { project: 'PLN', summary: 'Rack the new servers', fields: { Assignee: 'anna', Estimation: '2d', 'Start date': day(0) } });
    const before = (await getSchedule(ctx, 'PLN')).tasks.find((x) => x.issue.id === t.id)!;
    expect([before.start, before.finish]).toEqual([day(0), day(1)]);

    const away = await createAbsence(ctx, { from: day(1), kind: 'sick', note: 'Flu' });
    const after = (await getSchedule(ctx, 'PLN')).tasks.find((x) => x.issue.id === t.id)!;
    expect([after.start, after.finish, after.durationDays]).toEqual([day(0), day(2), 2]);

    const load = await getResourceLoad(w.as(w.ben), 'PLN', { from: day(0), to: day(4) });
    const row = load.resources.find((r) => r.user.login === 'anna')!;
    expect(row.days.map((d) => [d.date, d.away, d.capacity, d.hours])).toEqual([
      [day(0), null, 8, 8],
      [day(1), 'day', 0, 0],
      [day(2), null, 8, 8],
      [day(3), null, 8, 0],
      [day(4), null, 8, 0],
    ]);
    expect(JSON.stringify(load)).not.toMatch(/sick|Flu/);

    // Levelling has nothing to move: the work only waits for her.
    expect((await level(ctx, 'PLN', { mode: 'within_slack', dryRun: true })).changes).toEqual([]);
    await deleteAbsence(ctx, away.id);
  });
});

describe("the load grid's window, remembered for each person", () => {
  it('keeps what each person chose, and only what they send', async () => {
    expect(await getPreferences(w.as(w.anna))).toEqual({ loadWindow: null });
    expect(await updatePreferences(w.as(w.anna), { loadWindow: { preset: '1m' } })).toEqual({ loadWindow: { preset: '1m' } });
    expect(await updatePreferences(w.as(w.anna), {})).toEqual({ loadWindow: { preset: '1m' } });
    expect(await getPreferences(w.as(w.ben))).toEqual({ loadWindow: null });
    // A read-only role still chooses what it sees.
    expect(await updatePreferences(w.as(w.viewer), { loadWindow: { from: day(0), to: day(20) } })).toEqual({ loadWindow: { from: day(0), to: day(20) } });
    expect(await refused(() => updatePreferences(w.as(w.anna), { loadWindow: { from: day(5), to: day(0) } }))).toMatchObject({ status: 400 });
    expect(await updatePreferences(w.as(w.anna), { loadWindow: null })).toEqual({ loadWindow: null });
  });
});

describe('over REST', () => {
  it('enters, lists, changes and removes days away, and keeps the window', async () => {
    const app = createHttpApp(w.app);
    const anna = (await issueTokenFor(w.app.db, w.anna.id, { name: 'anna', scopes: ['read', 'write'] })).token;
    const danRead = (await issueTokenFor(w.app.db, dan.id, { name: 'dan', scopes: ['read'] })).token;
    const call = async (method: string, path: string, bearer: string, body?: unknown) => {
      const headers: Record<string, string> = { authorization: `Bearer ${bearer}` };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await app.request(`/api/v1${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const made = await call('POST', '/absences', anna, { from: day(0), to: day(1), kind: 'holiday' });
    expect([made.status, made.body.kind, made.body.to]).toEqual([201, 'holiday', day(1)]);
    const seen = await call('GET', '/absences?user=anna', danRead);
    expect([seen.status, seen.body[0].from, seen.body[0].kind]).toEqual([200, day(0), null]);
    expect((await call('POST', '/absences', danRead, { from: day(0) })).status).toBe(403);
    const changed = await call('PATCH', `/absences/${made.body.id}`, anna, { to: day(2), expectedVersion: made.body.version });
    expect([changed.status, changed.body.to]).toEqual([200, day(2)]);
    expect((await call('DELETE', `/absences/${made.body.id}`, anna)).status).toBe(204);
    expect((await call('GET', '/absences', anna)).body).toEqual([]);

    expect((await call('PATCH', '/me/preferences', anna, { loadWindow: { preset: '2w' } })).body).toEqual({ loadWindow: { preset: '2w' } });
    expect((await call('GET', '/me/preferences', anna)).body).toEqual({ loadWindow: { preset: '2w' } });
    // A read-only token changes nothing of its person's, preferences included.
    expect((await call('PATCH', '/me/preferences', danRead, { loadWindow: null })).status).toBe(403);
  });
});
