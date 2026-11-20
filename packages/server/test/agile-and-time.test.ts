/**
 * Agile and time tracking (D43): the backlog and its rank, story points, velocity, a sprint's load
 * against capacity, the sprint command, timers, work types, the weekly timesheet, and each
 * person's working week in scheduling, the load grid and the timesheet; then the same over REST.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserRow } from '../src/context';
import { runCommand, commandSpec } from '../src/commands/executor';
import { parseCommand } from '../src/commands/parser';
import { createHttpApp } from '../src/http/app';
import { addDays, todayISO, weekday } from '../src/lib/dates';
import { availabilities } from '../src/planning/availability';
import { isWorkingDay, normalizeCalendar } from '../src/planning/calendar';
import { createAbsence } from '../src/services/absences';
import { getBacklog, rankIssue, sprintPlan, velocity } from '../src/services/agile';
import { issueTokenFor } from '../src/services/auth';
import { boardView, createBoard, createSprint, setSprintIssues, updateBoard } from '../src/services/boards';
import { attachField, createField } from '../src/services/fields';
import { createIssue, findVisibleIssue, updateIssue } from '../src/services/issues';
import { addMember } from '../src/services/members';
import { getResourceLoad, getSchedule } from '../src/services/planning';
import { createProject, updateProject } from '../src/services/projects';
import { approveTimesheet, discardTimer, getTimesheet, listTimers, pauseTimer, reopenTimesheet, setTimesheetCell, startTimer, stopTimer, submitTimesheet } from '../src/services/time';
import { updateUser } from '../src/services/users';
import { listWorkItems, logWork } from '../src/services/workitems';
import { createWorkType, deleteWorkType, listWorkTypes, updateWorkType } from '../src/services/work-types';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
/** The Monday at least a week from today, and the days of its week. */
let mon = '';
const day = (n: number) => addDays(mon, n);
const today = todayISO();

async function refused(call: () => Promise<unknown>): Promise<{ status: number; message: string; hint?: string }> {
  try {
    await call();
  } catch (e) {
    const err = e as { status: number; message: string; hint?: string };
    return { status: err.status, message: err.message, hint: err.hint };
  }
  throw new Error('expected a refusal');
}

/** Moves an issue's history back in time, as if it had happened then. */
async function backdate(issueId: string, type: string, at: string) {
  const row = await findVisibleIssue(w.adminCtx, issueId);
  await w.app.db.execute(sql`UPDATE activities SET created_at = ${at}::timestamptz WHERE issue_id = ${row!.id} AND type = ${type}`);
}

beforeAll(async () => {
  w = await createWorld();
  await createProject(w.adminCtx, { key: 'AGL', name: 'Agile', template: 'software', lead: 'ben' });
  await addMember(w.adminCtx, 'AGL', { user: 'anna', role: 'member' });
  const points = await createField(w.adminCtx, { name: 'Story points', type: 'integer', multi: false, description: '', values: [] });
  await attachField(w.adminCtx, 'AGL', points.id, {});
  mon = addDays(today, 7 + ((8 - weekday(today)) % 7));
});
afterAll(async () => w?.close());

describe('the backlog', () => {
  it('holds what is unresolved outside open sprints, in rank order, and moves by rank', async () => {
    const ctx = w.as(w.anna);
    const board = await createBoard(w.as(w.ben), { name: 'Agile board', projects: ['AGL'], sprintsEnabled: true, pointsField: 'Story points' });
    expect(board).toMatchObject({ backlogQuery: null, pointsField: 'Story points' });
    // One after another: the backlog orders unranked issues by number, and on Postgres issues made
    // at once can take their numbers in any order, putting Alpha where the test ranks after.
    const made = [];
    for (const [i, summary] of ['Alpha', 'Bravo', 'Charlie', 'Delta'].entries()) made.push(await createIssue(ctx, { project: 'AGL', summary, fields: { 'Story points': i + 1 } }));
    const [a, b, c, d] = made;
    const done = await createIssue(ctx, { project: 'AGL', summary: 'Echo', fields: { State: 'Fixed' } });
    const ids = async () => (await getBacklog(ctx, board.id)).issues.map((i) => i.summary);
    const before = await getBacklog(ctx, board.id);
    expect(before.query).toBe('#Unresolved');
    expect(before.issues.map((i) => i.id)).not.toContain(done.id);
    expect(before.ranked).toEqual([]);
    expect(before.points).toBe(10);

    // To the top; then just after an issue without a rank, which ranks those shown above it too.
    await rankIssue(ctx, board.id, { issue: c!.id });
    expect((await ids())[0]).toBe('Charlie');
    const shown = (await getBacklog(ctx, board.id)).issues.map((i) => i.id);
    const third = shown[2]!;
    await rankIssue(ctx, board.id, { issue: a!.id, after: third });
    const after = await getBacklog(ctx, board.id);
    const rest = shown.filter((x) => x !== a!.id);
    const upTo = rest.indexOf(third) + 1;
    expect(after.issues.map((i) => i.id).slice(0, upTo + 1)).toEqual([...rest.slice(0, upTo), a!.id]);
    expect(after.ranked).toEqual([...rest.slice(0, upTo), a!.id]);
    await rankIssue(ctx, board.id, { issue: d!.id, before: c!.id });
    expect((await ids())[0]).toBe('Delta');
    // Many moves into the same gap space the ranks out again, and keep the order.
    for (let k = 0; k < 60; k++) await rankIssue(ctx, board.id, { issue: k % 2 ? b!.id : a!.id, after: d!.id });
    expect((await ids()).slice(0, 2)).toEqual(['Delta', 'Bravo']);

    expect((await refused(() => rankIssue(ctx, board.id, { issue: a!.id, after: a!.id }))).status).toBe(400);
    // Vera sees the board but may not change it.
    expect((await refused(() => rankIssue(w.as(w.viewer), board.id, { issue: a!.id }))).status).toBe(403);
    const other = await createIssue(w.adminCtx, { project: 'BACK', summary: 'Elsewhere' });
    expect((await refused(() => rankIssue(ctx, board.id, { issue: other.id }))).message).toMatch(/isn't on this board/);

    // In an open sprint, an issue leaves the backlog; the board's cards follow the rank.
    const sprint = await createSprint(w.as(w.ben), board.id, { name: 'Sprint 1', startDate: today, endDate: addDays(today, 13) });
    await setSprintIssues(ctx, sprint.id, [a!.id, b!.id, d!.id], false);
    expect(await ids()).not.toContain('Delta');
    const view = await boardView(ctx, board.id, sprint.id);
    const open = view.columns.find((col) => col.issues.length)!;
    expect(open.issues.map((i) => i.summary)).toEqual(['Delta', 'Bravo', 'Alpha']);
    expect([open.points, view.points]).toEqual([7, 7]);

    // A backlog query of its own, and a points field must hold numbers.
    await updateBoard(w.as(w.ben), board.id, { backlogQuery: 'Charlie' });
    expect(await ids()).toEqual(['Charlie']);
    await updateBoard(w.as(w.ben), board.id, { backlogQuery: null });
    expect((await refused(() => updateBoard(w.as(w.ben), board.id, { pointsField: 'Priority' }))).message).toMatch(/number field/);
  });
});

describe('sprints by command', () => {
  it('moves issues into a sprint and out of it, all of the command or none', async () => {
    const ctx = w.as(w.anna);
    const board = await createBoard(w.as(w.ben), { name: 'Command board', projects: ['AGL'], sprintsEnabled: true });
    const sprint = await createSprint(w.as(w.ben), board.id, { name: 'Sprint 7', startDate: today, endDate: addDays(today, 6) });
    const issue = await createIssue(ctx, { project: 'AGL', summary: 'By command' });
    const res = await runCommand(ctx, { issues: [issue.id], command: 'sprint Sprint 7 Priority Critical' });
    expect(res.results[0]!.errors).toEqual([]);
    expect(res.results[0]!.changes).toContainEqual({ field: 'Sprint', from: null, to: 'Sprint 7' });
    expect(res.description).toMatch(/add to sprint Sprint 7/);
    expect((await sprintPlan(ctx, sprint.id)).totals.issues).toBe(1);
    const out = await runCommand(ctx, { issues: [issue.id], command: 'remove sprint sprint 7' });
    expect(out.results[0]!.changes).toEqual([{ field: 'Sprint', from: 'Sprint 7', to: null }]);
    const missing = await runCommand(ctx, { issues: [issue.id], command: 'sprint Sprint 99 Priority Minor' });
    expect(missing.results[0]!.errors[0]).toMatch(/no board .* has a sprint called Sprint 99|No board/);
    expect((await findVisibleIssue(ctx, issue.id))).toBeTruthy();
    // A rule's command doesn't move issues between sprints.
    const s = await w.app.schema.get();
    const parsed = parseCommand('sprint Sprint 7', s, [issue.project.id]);
    const row = (await findVisibleIssue(ctx, issue.id))!;
    expect((await refused(() => commandSpec(ctx, row, parsed.ops))).message).toMatch(/command run on issues/);
  });
});

describe('velocity and a sprint plan', () => {
  it('counts committed and done per sprint from history, with the average of the last three', async () => {
    const ctx = w.as(w.anna);
    const board = await createBoard(w.as(w.ben), { name: 'Velocity board', projects: ['AGL'], sprintsEnabled: true, pointsField: 'Story points' });
    const sprints = [];
    for (let k = 0; k < 4; k++) {
      const start = addDays(today, -40 + k * 10);
      const sprint = await createSprint(w.as(w.ben), board.id, { name: `V${k}`, startDate: start, endDate: addDays(start, 6) });
      const x = await createIssue(ctx, { project: 'AGL', summary: `V${k} done`, fields: { 'Story points': 5 } });
      const y = await createIssue(ctx, { project: 'AGL', summary: `V${k} left`, fields: { 'Story points': 3 } });
      await setSprintIssues(ctx, sprint.id, [x.id, y.id], false);
      await updateIssue(ctx, x.id, { fields: { State: 'Fixed' } });
      for (const i of [x, y]) {
        await backdate(i.id, 'issue.created', `${addDays(start, -2)}T09:00:00Z`);
        await backdate(i.id, 'sprint.issue_added', `${addDays(start, -1)}T09:00:00Z`);
      }
      await backdate(x.id, 'issue.updated', `${addDays(start, 2 + k % 2)}T12:00:00Z`);
      sprints.push(sprint);
    }
    const v = await velocity(ctx, board.id);
    expect(v.by).toBe('points');
    expect(v.sprints.map((x) => [x.name, x.committed, x.done, x.finished])).toEqual([
      ['V0', 8, 5, true],
      ['V1', 8, 5, true],
      ['V2', 8, 5, true],
      ['V3', 8, 5, true],
    ]);
    expect(v.average).toBe(5);
    const byCount = await velocity(ctx, board.id, 'count');
    expect(byCount.sprints[0]).toMatchObject({ committed: 2, done: 1 });
    expect(byCount.unit).toBe('issues');
    const plain = await createBoard(w.as(w.ben), { name: 'No points', projects: ['AGL'], sprintsEnabled: true });
    expect((await refused(() => velocity(ctx, plain.id, 'points'))).message).toMatch(/no story points/);
  });

  it("weighs a sprint's remaining estimates against its people's working weeks and days away", async () => {
    const ctx = w.as(w.anna);
    const board = await createBoard(w.as(w.ben), { name: 'Plan board', projects: ['AGL'], sprintsEnabled: true, pointsField: 'Story points' });
    const sprint = await createSprint(w.as(w.ben), board.id, { name: 'Planned', startDate: day(0), endDate: day(4) });
    // Anna works four days, Wednesday off; Ben is away on Monday.
    await updateUser(ctx, 'anna', { workWeek: [0, 8, 8, 0, 8, 8, 0] });
    await createAbsence(w.as(w.ben), { from: day(0) });
    const one = await createIssue(ctx, { project: 'AGL', summary: 'Plan one', fields: { Assignee: 'anna', Estimation: '2d', 'Story points': 3 } });
    const two = await createIssue(ctx, { project: 'AGL', summary: 'Plan two', fields: { Assignee: 'ben', Estimation: '1d', 'Story points': 2 } });
    const three = await createIssue(ctx, { project: 'AGL', summary: 'Plan three', fields: { 'Story points': 1 } });
    await logWork(ctx, one.id, { duration: '4h' });
    await setSprintIssues(ctx, sprint.id, [one.id, two.id, three.id], false);
    const plan = await sprintPlan(ctx, sprint.id);
    expect([plan.from, plan.to]).toEqual([day(0), day(4)]);
    expect(plan.people.map((p) => [p.user?.login ?? null, p.issues, p.points, p.loadHours, p.capacityHours])).toEqual([
      ['anna', 1, 3, 12, 32],
      ['ben', 1, 2, 8, 32],
      [null, 1, 1, 0, null],
    ]);
    expect(plan.totals).toEqual({ issues: 3, points: 6, loadHours: 20, capacityHours: 64 });
    await updateUser(ctx, 'anna', { workWeek: null });
  });
});

describe('the working week', () => {
  it('gives the engine the days and hours each person works', () => {
    const cal = normalizeCalendar({ startDate: null, workingDays: [1, 2, 3, 4, 5], hoursPerDay: 8, holidays: [], budget: null, currency: 'USD' });
    const a = availabilities(cal, [], mon, [{ id: 'p', login: 'p', name: 'P', capacityHoursPerDay: 8, hourlyRate: null, week: [0, 8, 8, 0, 8, 4, 0] }]);
    const p = a('p');
    expect([isWorkingDay(p.cal, day(0)), isWorkingDay(p.cal, day(2)), p.share(day(0)), p.share(day(4))]).toEqual([true, false, 1, 0.5]);
    // A week that changes nothing leaves them on the plan's own calendar.
    const same = availabilities(cal, [], mon, [{ id: 'q', login: 'q', name: 'Q', capacityHoursPerDay: 8, hourlyRate: null, week: [0, 8, 8, 8, 8, 8, 0] }]);
    expect(same('q').cal).toBe(cal);
  });

  it('is used by scheduling, the load grid and the Gantt, which draws days away', async () => {
    await createProject(w.adminCtx, { key: 'WWK', name: 'Weeks', template: 'waterfall', lead: 'ben' });
    await addMember(w.adminCtx, 'WWK', { user: 'anna', role: 'member' });
    const ctx = w.as(w.ben);
    await updateUser(ctx, 'ben', { workWeek: [0, 8, 8, 0, 8, 4, 0] });
    // (Ben is away on day(0), from the sprint plan above: this is the week after.)
    const t = await createIssue(ctx, { project: 'WWK', summary: 'Part time', fields: { Assignee: 'ben', Estimation: '3d', 'Start date': day(7) } });
    const task = (await getSchedule(ctx, 'WWK')).tasks.find((x) => x.issue.id === t.id)!;
    // 24 hours: Monday and Tuesday (16), no Wednesday, Thursday (8).
    expect([task.start, task.finish]).toEqual([day(7), day(10)]);
    const load = await getResourceLoad(ctx, 'WWK', { from: day(7), to: day(11) });
    const row = load.resources.find((r) => r.user.login === 'ben')!;
    expect(row.days.map((d) => [d.date, d.capacity])).toEqual([
      [day(7), 8],
      [day(8), 8],
      [day(9), 0],
      [day(10), 8],
      [day(11), 4],
    ]);

    await createAbsence(w.as(w.anna), { from: day(1), to: day(2) });
    await createIssue(ctx, { project: 'WWK', summary: 'Anna', fields: { Assignee: 'anna', Estimation: '1d', 'Start date': day(0) } });
    const schedule = await getSchedule(ctx, 'WWK');
    expect(schedule.away.find((x) => x.assignee === 'anna')?.days).toEqual([
      { date: day(1), part: 'day' },
      { date: day(2), part: 'day' },
    ]);
    await updateUser(ctx, 'ben', { workWeek: null });
  });
});

describe('work types', () => {
  it('are kept by managers, chosen when logging, and required where the project says', async () => {
    const ben = w.as(w.ben);
    const anna = w.as(w.anna);
    const dev = await createWorkType(ben, 'AGL', { name: 'Development' });
    await createWorkType(ben, 'AGL', { name: 'Testing' });
    expect((await refused(() => createWorkType(ben, 'AGL', { name: 'testing' }))).status).toBe(409);
    expect((await refused(() => createWorkType(anna, 'AGL', { name: 'Review' }))).status).toBe(403);
    expect((await listWorkTypes(anna, 'AGL')).map((t) => t.name)).toEqual(['Development', 'Testing']);

    const issue = await createIssue(anna, { project: 'AGL', summary: 'Typed work' });
    const item = await logWork(anna, issue.id, { duration: '1h', type: 'development' });
    expect(item.type).toEqual({ id: dev.id, name: 'Development' });
    expect((await refused(() => logWork(anna, issue.id, { duration: '1h', type: 'Design' }))).hint).toMatch(/Development, Testing/);
    await updateProject(ben, 'AGL', { settings: { time: { workTypeRequired: true } } });
    expect((await refused(() => logWork(anna, issue.id, { duration: '1h' }))).message).toMatch(/needs a work type/);
    await updateWorkType(ben, dev.id, { archived: true });
    expect((await refused(() => logWork(anna, issue.id, { duration: '1h', type: 'Development' }))).message).toMatch(/archived/);
    expect((await listWorkItems(anna, issue.id))[0]!.type?.name).toBe('Development');
    expect((await refused(() => deleteWorkType(ben, dev.id))).status).toBe(409);
    await updateProject(ben, 'AGL', { settings: { time: { workTypeRequired: false } } });
  });
});

describe('timers', () => {
  it('run one at a time per person, pause, and become work items when stopped', async () => {
    const anna = w.as(w.anna);
    const one = await createIssue(anna, { project: 'AGL', summary: 'Timed one' });
    const two = await createIssue(anna, { project: 'AGL', summary: 'Timed two' });
    expect((await startTimer(anna, one.id)).running).toBe(true);
    await startTimer(anna, two.id);
    const timers = await listTimers(anna);
    expect(timers.map((t) => [t.issue.id, t.running])).toEqual([
      [two.id, true],
      [one.id, false],
    ]);
    expect((await pauseTimer(anna, two.id)).running).toBe(false);
    // Twenty-five minutes on the first, as if it had run that long.
    await w.app.db.execute(sql`UPDATE timers SET elapsed_seconds = 1500 WHERE issue_id = (SELECT id FROM issues WHERE summary = 'Timed one')`);
    await startTimer(anna, one.id);
    const stopped = await stopTimer(anna, one.id, { description: 'Pairing', type: 'Testing' });
    expect([stopped.workItem?.minutes, stopped.workItem?.description, stopped.workItem?.type?.name]).toEqual([25, 'Pairing', 'Testing']);
    // Under half a minute logs nothing; a refused log leaves the timer as it was.
    expect((await stopTimer(anna, two.id)).workItem).toBeNull();
    await startTimer(anna, two.id);
    expect((await refused(() => stopTimer(anna, two.id, { duration: '1h', type: 'Nonsense' }))).status).toBe(400);
    expect((await listTimers(anna)).map((t) => t.issue.id)).toEqual([two.id]);
    await discardTimer(anna, two.id);
    expect(await listTimers(anna)).toEqual([]);
    expect((await refused(() => pauseTimer(anna, two.id))).status).toBe(404);
    expect((await refused(() => startTimer(w.as(w.viewer), one.id))).status).toBe(403);
  });
});

describe('the timesheet', () => {
  it("shows a week by issue and type against the person's working hours, and sets cells", async () => {
    const anna = w.as(w.anna);
    await updateUser(anna, 'anna', { workWeek: [0, 8, 8, 8, 8, 4, 0] });
    await createAbsence(anna, { from: day(9), half: 'morning' });
    const x = await createIssue(anna, { project: 'AGL', summary: 'Sheet x' });
    await logWork(anna, x.id, { duration: '2h', date: day(7), type: 'Testing' });
    let sheet = await setTimesheetCell(anna, { issue: x.id, date: day(8), minutes: 90 });
    expect(sheet.week).toBe(day(7));
    expect(sheet.hours).toEqual([8, 8, 4, 8, 4, 0, 0]);
    const rowOf = (type: string | null) => sheet.rows.find((r) => r.issue.id === x.id && (r.type?.name ?? null) === type)!;
    expect(rowOf('Testing').minutes).toEqual([120, 0, 0, 0, 0, 0, 0]);
    expect(rowOf(null).minutes).toEqual([0, 90, 0, 0, 0, 0, 0]);
    expect(sheet.totals).toEqual([120, 90, 0, 0, 0, 0, 0]);
    sheet = await setTimesheetCell(anna, { issue: x.id, date: day(7), minutes: 30, type: 'Testing' });
    expect(rowOf('Testing').minutes[0]).toBe(30);
    sheet = await setTimesheetCell(anna, { issue: x.id, date: day(8), minutes: 0 });
    expect(sheet.rows.find((r) => r.type === null)).toBeUndefined();
    await logWork(anna, x.id, { duration: '1h', date: day(7), type: 'Testing' });
    expect((await refused(() => setTimesheetCell(anna, { issue: x.id, date: day(7), minutes: 10, type: 'Testing' }))).status).toBe(409);
    expect((await refused(() => getTimesheet(w.as(w.ben), { user: 'anna' }))).status).toBe(403);
    expect((await getTimesheet(w.adminCtx, { user: 'anna', week: day(9) })).totals[0]).toBe(90);
    await updateUser(anna, 'anna', { workWeek: null });
  });
});

describe('over REST', () => {
  it('serves the backlog, rank, velocity, timers, work types and timesheet', async () => {
    const app = createHttpApp(w.app);
    const token = (await issueTokenFor(w.app.db, w.anna.id, { name: 'anna', scopes: ['read', 'write'] })).token;
    const call = async (method: string, path: string, body?: unknown) => {
      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await app.request(`/api/v1${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const boards = (await call('GET', '/boards')).body as { id: string; name: string }[];
    const board = boards.find((b) => b.name === 'Agile board')!;
    const backlog = await call('GET', `/boards/${board.id}/backlog`);
    expect(backlog.status).toBe(200);
    const first = backlog.body.issues.at(-1).id as string;
    expect((await call('POST', `/boards/${board.id}/rank`, { issue: first })).status).toBe(204);
    expect((await call('GET', `/boards/${board.id}/backlog`)).body.issues[0].id).toBe(first);
    expect((await call('GET', `/boards/${board.id}/velocity?by=count`)).body.by).toBe('count');
    expect((await call('POST', `/issues/${first}/timer/start`)).body.running).toBe(true);
    expect((await call('GET', '/timers')).body).toHaveLength(1);
    expect((await call('DELETE', `/issues/${first}/timer`)).status).toBe(204);
    expect((await call('GET', '/projects/AGL/work-types')).body.length).toBe(2);
    const sheet = await call('PUT', '/timesheet/cell', { issue: first, date: day(14), minutes: 45 });
    expect([sheet.status, sheet.body.totals[0]]).toEqual([200, 45]);
    const item = (await call('GET', `/issues/${first}/work-items`)).body.find((x: { date: string }) => x.date === day(14));
    expect((await call('PATCH', `/work-items/${item.id}`, { duration: '1h' })).body.minutes).toBe(60);
    expect((await call('PATCH', '/me', { workWeek: [0, 6, 6, 6, 6, 6, 0] })).body.workWeek).toEqual([0, 6, 6, 6, 6, 6, 0]);
    expect((await call('PATCH', '/me', { workWeek: [8, 8] })).status).toBe(400);
  });
});
describe("a week submitted and approved (D43's revisit)", () => {
  it('submits, locks its cells, is approved by a manager of its projects, and comes back open', async () => {
    const anna = w.as(w.anna);
    const issue = await createIssue(anna, { project: 'AGL', summary: 'Timesheet me', fields: { Type: 'Task' } });
    await setTimesheetCell(anna, { issue: issue.id, date: day(0), minutes: 60 });
    const open = await getTimesheet(anna, { week: mon });
    expect(open.status).toBe('open');
    const submitted = await submitTimesheet(anna, { week: mon });
    expect(submitted.status).toBe('submitted');
    expect(submitted.submittedAt).not.toBeNull();
    // Its cells are locked: submitted, the cell refuses.
    const locked = await refused(() => setTimesheetCell(anna, { issue: issue.id, date: day(0), minutes: 90 }));
    expect(locked.status).toBe(409);
    // Ben, AGL's lead, approves it; Anna can't.
    const notAnna = await refused(() => approveTimesheet(anna, { week: mon, user: 'anna' }));
    expect(notAnna.status).toBe(403);
    const approved = await approveTimesheet(w.as(w.ben), { week: mon, user: 'anna' });
    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toMatchObject({ login: 'ben' });
    // Sent back, its cells change again.
    const again = await reopenTimesheet(w.as(w.ben), { week: mon, user: 'anna' });
    expect(again.status).toBe('open');
    await setTimesheetCell(anna, { issue: issue.id, date: day(0), minutes: 90 });
  });
});
describe("the approval rule is the projects' to set (D43's revisit)", () => {
  it("every project's 'any' lets one of the week's managers approve the whole week; the strict rule needs them all", async () => {
    const anna = w.as(w.anna);
    const ben = w.as(w.ben);
    const agl = await createIssue(anna, { project: 'AGL', summary: 'AGL time', fields: { Type: 'Task' } });
    const back = await createIssue(anna, { project: 'BACK', summary: 'BACK time', fields: { Type: 'Task' } });
    await logWork(anna, agl.id, { duration: 30, date: day(0) });
    await logWork(anna, back.id, { duration: 30, date: day(1) });
    await submitTimesheet(anna, { week: mon });
    // Ben manages AGL but not BACK: with the strict rule (the default) he can't approve the week.
    const strict = await refused(() => approveTimesheet(ben, { week: mon, user: 'anna' }));
    expect(strict.status).toBe(403);
    // Both projects say 'any': one of the week's managers approves the whole week.
    await updateProject(w.adminCtx, 'AGL', { settings: { time: { timesheetApproval: 'any' } } });
    await updateProject(w.adminCtx, 'BACK', { settings: { time: { timesheetApproval: 'any' } } });
    const approved = await approveTimesheet(ben, { week: mon, user: 'anna' });
    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toMatchObject({ login: 'ben' });
  });
});
describe("the timesheet itself is each project's to turn off (D43's revisit)", () => {
  it("a project's work leaves the sheet, and its cells refuse, until it is on again", async () => {
    const anna = w.as(w.anna);
    // A week of its own, so the other test's submitted week doesn't lock these cells.
    const next = addDays(mon, 7);
    const back = await createIssue(anna, { project: 'BACK', summary: 'Off the sheet', fields: { Type: 'Task' } });
    await logWork(anna, back.id, { duration: 30, date: next });
    await updateProject(w.adminCtx, 'BACK', { settings: { time: { timesheetEnabled: false } } });
    const sheet = await getTimesheet(anna, { week: next });
    expect(sheet.rows.some((r) => r.issue.id === back.id)).toBe(false);
    const refusedCell = await refused(() => setTimesheetCell(anna, { issue: back.id, date: next, minutes: 60 }));
    expect(refusedCell.status).toBe(400);
    await updateProject(w.adminCtx, 'BACK', { settings: { time: { timesheetEnabled: true } } });
    const again = await getTimesheet(anna, { week: next });
    expect(again.rows.some((r) => r.issue.id === back.id)).toBe(true);
  });
});
