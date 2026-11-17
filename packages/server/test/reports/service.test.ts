import { gt, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemCtx } from '../../src/app-services';
import type { Ctx } from '../../src/context';
import { activities, issues } from '../../src/db/schema';
import { createBoard, createSprint, setSprintIssues } from '../../src/services/boards';
import { createIssue, deleteIssue, updateIssue } from '../../src/services/issues';
import { createProject } from '../../src/services/projects';
import { burndownReport, createdResolvedReport, cycleTimeReport, flowReport, timeReport } from '../../src/services/reports';
import { logWork } from '../../src/services/workitems';
import { createWorld, type TestWorld } from '../helpers';

let w: TestWorld;
let anna: Ctx;
const NOW = Date.parse('2026-11-10T12:00:00Z');

/** Run `fn`, then place every activity it recorded at `when`, as if it had happened then. */
async function at<T>(when: string, fn: () => Promise<T>): Promise<T> {
  const [{ max } = { max: 0 }] = await w.app.db.select({ max: sql<number>`coalesce(max(${activities.id}), 0)` }).from(activities);
  const result = await fn();
  await w.app.db.update(activities).set({ createdAt: new Date(when) }).where(gt(activities.id, Number(max)));
  return result;
}

beforeAll(async () => {
  w = await createWorld();
  anna = systemCtx(w.app, w.anna, 'web');
  await createProject(w.adminCtx, { key: 'HIST', name: 'History', template: 'software' });
  // HIST-1: created before the window, moves inside it.
  await at('2026-10-20T10:00:00Z', () => createIssue(anna, { project: 'HIST', summary: 'Older than the window', fields: { Estimation: '1d' } }));
  await at('2026-11-02T10:00:00Z', () => updateIssue(anna, 'HIST-1', { fields: { State: 'In Progress' } }));
  await at('2026-11-03T10:00:00Z', () => updateIssue(anna, 'HIST-1', { fields: { State: 'Fixed' } }));
  // HIST-2: created and deleted inside the window.
  await at('2026-11-02T15:00:00Z', () => createIssue(anna, { project: 'HIST', summary: 'Deleted on the third' }));
  await at('2026-11-03T08:00:00Z', () => deleteIssue(w.adminCtx, 'HIST-2'));
  // HIST-3: resolved, reopened, resolved again.
  await at('2026-11-01T09:00:00Z', () => createIssue(anna, { project: 'HIST', summary: 'Reopened once' }));
  await at('2026-11-01T11:00:00Z', () => updateIssue(anna, 'HIST-3', { fields: { State: 'In Progress' } }));
  await at('2026-11-02T09:00:00Z', () => updateIssue(anna, 'HIST-3', { fields: { State: 'Fixed' } }));
  await at('2026-11-02T18:00:00Z', () => updateIssue(anna, 'HIST-3', { fields: { State: 'Open' } }));
  await at('2026-11-03T23:30:00Z', () => updateIssue(anna, 'HIST-3', { fields: { State: 'Fixed' } }));
});
afterAll(async () => w?.close());

describe('cumulative flow from the activity log', () => {
  it('counts a project\'s issues in their states each day, the deleted one on the days it existed', async () => {
    const f = await flowReport(anna, { project: 'HIST', from: '2026-11-01', to: '2026-11-03', timeZone: 'UTC' }, NOW);
    const at = (date: string) => Object.fromEntries(f.states.map((s, i) => [s.name, f.days.find((d) => d.date === date)!.counts[i]]));
    expect(at('2026-11-01')).toMatchObject({ Open: 1, 'In Progress': 1, Fixed: 0 });
    expect(at('2026-11-02')).toMatchObject({ Open: 2, 'In Progress': 1, Fixed: 0 }); // HIST-2 is there; HIST-3 reopened
    expect(at('2026-11-03')).toMatchObject({ Open: 0, 'In Progress': 0, Fixed: 2 }); // HIST-2 gone; HIST-3 fixed at 23:30
    expect(f.scope.includesDeleted).toBe(true);
    expect(f.states.findIndex((s) => s.resolved)).toBeGreaterThan(f.states.findIndex((s) => s.name === 'In Progress'));
  });

  it('takes issues as a query matches them now, which leaves the deleted one out', async () => {
    const f = await flowReport(anna, { project: 'HIST', query: '#Resolved', from: '2026-11-02', to: '2026-11-02', timeZone: 'UTC' }, NOW);
    expect(f.scope.includesDeleted).toBe(false);
    expect(f.days[0]!.total).toBe(2); // HIST-1 and HIST-3, both resolved now
  });

  it('moves a change at 23:30 UTC into the next day for a reader in Berlin', async () => {
    const utc = await flowReport(anna, { project: 'HIST', from: '2026-11-03', to: '2026-11-04', timeZone: 'UTC' }, NOW);
    const berlin = await flowReport(anna, { project: 'HIST', from: '2026-11-03', to: '2026-11-04', timeZone: 'Europe/Berlin' }, NOW);
    const fixed = (f: typeof utc) => f.days.map((d) => d.counts[f.states.findIndex((s) => s.name === 'Fixed')]);
    expect(fixed(utc)).toEqual([2, 2]);
    expect(fixed(berlin)).toEqual([1, 2]);
  });
});

describe('created against resolved, and cycle time', () => {
  it('counts creations, resolutions and reopenings by day', async () => {
    const r = await createdResolvedReport(anna, { project: 'HIST', from: '2026-11-01', to: '2026-11-03', timeZone: 'UTC' }, NOW);
    expect(r.interval).toBe('day');
    expect(r.buckets.map((b) => [b.from, b.created, b.resolved, b.reopened, b.open])).toEqual([
      ['2026-11-01', 1, 0, 0, 2],
      ['2026-11-02', 1, 1, 1, 3],
      ['2026-11-03', 0, 2, 0, 0],
    ]);
    expect(r.totals).toEqual({ created: 2, resolved: 3, reopened: 1 });
  });

  it('times issues from first In Progress to their last resolution, with percentiles', async () => {
    const c = await cycleTimeReport(anna, { project: 'HIST', from: '2026-11-01', to: '2026-11-09', timeZone: 'UTC' }, NOW);
    expect(c.issues.map((i) => [i.issue, i.days, i.reopened])).toEqual([
      ['HIST-1', 1, false],
      ['HIST-3', 2.52, true],
    ]);
    expect(c.percentiles.p50).toBe(1);
    expect(c.percentiles.p95).toBe(2.5);
    expect(c.startStates).toEqual(['In Progress']);
  });

  it('says what is wrong with a bad request', async () => {
    await expect(flowReport(anna, { project: 'NOPE' }, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(flowReport(anna, { project: 'HIST', timeZone: 'Mars/Olympus' }, NOW)).rejects.toMatchObject({ status: 400, hint: expect.stringContaining('IANA') });
    await expect(flowReport(anna, { project: 'HIST', from: '2026-11-05', to: '2026-11-01' }, NOW)).rejects.toMatchObject({ status: 400 });
    await expect(flowReport(anna, { project: 'HIST', from: '2024-01-01', to: '2026-11-01' }, NOW)).rejects.toMatchObject({ status: 400 });
    await expect(cycleTimeReport(anna, { project: 'HIST', start: 'Doing' }, NOW)).rejects.toMatchObject({ status: 400, hint: expect.stringContaining('In Progress') });
    await expect(flowReport(anna, { project: 'HIST', query: 'Stat: Open' }, NOW)).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a caller without read access', async () => {
    const none = { ...anna, actor: { ...anna.actor, scopes: [] as never[] } };
    await expect(flowReport(none, { project: 'HIST' }, NOW)).rejects.toMatchObject({ status: 403 });
    await expect(timeReport(none, { project: 'HIST' }, NOW)).rejects.toMatchObject({ status: 403 });
  });
});

describe('a sprint\'s burndown', () => {
  let sprintId: string;
  let emptyId: string;
  beforeAll(async () => {
    const board = await createBoard(w.adminCtx, { name: 'Sprints', projects: ['BACK'], sprintsEnabled: true });
    const sprint = await createSprint(w.adminCtx, board.id, { name: 'Sprint 1', startDate: '2026-11-02', endDate: '2026-11-13' });
    const empty = await createSprint(w.adminCtx, board.id, { name: 'Sprint 0', startDate: '2026-10-19', endDate: '2026-10-30' });
    await createSprint(w.adminCtx, board.id, { name: 'Undated' });
    sprintId = sprint.id;
    emptyId = empty.id;
    await at('2026-10-28T09:00:00Z', () => createIssue(anna, { project: 'BACK', summary: 'Committed A', fields: { Estimation: '1d' } }));
    await at('2026-10-28T09:00:00Z', () => createIssue(anna, { project: 'BACK', summary: 'Committed B', fields: { Estimation: '1d' } }));
    await at('2026-10-30T09:00:00Z', () => setSprintIssues(w.adminCtx, sprintId, ['BACK-1', 'BACK-2'], false));
    await at('2026-11-03T15:00:00Z', () => updateIssue(anna, 'BACK-1', { fields: { State: 'Fixed' } }));
    // Scope added mid-sprint: a new issue joins on the 4th.
    await at('2026-11-04T09:00:00Z', () => createIssue(anna, { project: 'BACK', summary: 'Added later', fields: { Estimation: '4h' } }));
    await at('2026-11-04T10:00:00Z', () => setSprintIssues(w.adminCtx, sprintId, ['BACK-3'], false));
    // Reopened on the 5th.
    await at('2026-11-05T09:00:00Z', () => updateIssue(anna, 'BACK-1', { fields: { State: 'Open' } }));
    await at('2026-11-05T12:00:00Z', () => logWork(anna, 'BACK-1', { duration: '2h', date: '2026-11-05' }));
  });

  it('commits what was in it at the start, and shows each day\'s scope and progress', async () => {
    const b = await burndownReport(anna, { sprint: sprintId, timeZone: 'UTC' }, NOW);
    expect(b.start).toBe(960);
    expect(b.workingDays).toBe(10);
    expect(b.days.map((d) => d.remaining)).toEqual([960, 480, 720, 1200, 1200, 1200, 1200, null, null, null]);
    expect(b.days[1]).toMatchObject({ completed: 480 });
    expect(b.days[2]).toMatchObject({ added: 240 });
    expect(b.days[3]).toMatchObject({ reopened: 480, spentMinutes: 120 });
    expect(b.changes.map((c) => [c.issue, c.kind])).toEqual([
      ['BACK-1', 'resolved'],
      ['BACK-3', 'added'],
      ['BACK-1', 'reopened'],
    ]);
    expect(b.status.verdict).toBe('behind');
    expect(b.status.words).toMatch(/^Behind: 20h left, where the ideal had \d+(\.\d)?h left as today began/);
    expect(b.workingDaysLeft).toBe(3);
  });

  it('counts issues instead, and finds the sprint by its board and name', async () => {
    const b = await burndownReport(anna, { board: 'Sprints', sprint: 'Sprint 1', by: 'count', timeZone: 'UTC' }, NOW);
    expect(b.unit).toBe('issues');
    expect(b.days.slice(0, 4).map((d) => d.remaining)).toEqual([2, 1, 2, 3]);
  });

  it('says an empty sprint is empty, and asks for dates where there are none', async () => {
    const empty = await burndownReport(anna, { sprint: emptyId, timeZone: 'UTC' }, NOW);
    expect(empty.status.verdict).toBe('empty');
    expect(empty.days.every((d) => d.remaining === 0)).toBe(true);
    await expect(burndownReport(anna, { board: 'Sprints', sprint: 'Undated' }, NOW)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('no start') });
    await expect(burndownReport(anna, {}, NOW)).rejects.toMatchObject({ status: 400 });
    await expect(burndownReport(anna, { board: 'Nope' }, NOW)).rejects.toMatchObject({ status: 404 });
  });

  it('records who joined and left the sprint in each issue\'s history', async () => {
    const rows = await w.app.db.select({ type: activities.type }).from(activities).where(sql`${activities.type} like 'sprint.%'`);
    expect(rows.map((r) => r.type)).toEqual(['sprint.issue_added', 'sprint.issue_added', 'sprint.issue_added']);
    // Joining again changes nothing, and records nothing.
    await setSprintIssues(w.adminCtx, sprintId, ['BACK-3'], false);
    const again = await w.app.db.select({ n: sql<number>`count(*)::int` }).from(activities).where(sql`${activities.type} like 'sprint.%'`);
    expect(Number(again[0]!.n)).toBe(3);
  });
});

describe('time', () => {
  it('totals logged work by person, project and week, and sets each issue\'s estimate against what was spent', async () => {
    await logWork(w.adminCtx, 'HIST-1', { duration: '6h', date: '2026-11-02', author: 'ben' });
    await logWork(anna, 'HIST-1', { duration: '4h', date: '2026-11-09' });
    await logWork(anna, 'HIST-3', { duration: '1h', date: '2026-11-03', description: '=HYPERLINK("x")' });
    const t = await timeReport(anna, { project: 'HIST', from: '2026-11-01', to: '2026-11-10' }, NOW);
    expect(t.totalMinutes).toBe(660);
    expect(t.byPerson.map((p) => [p.user?.login, p.minutes])).toEqual([
      ['anna', 300],
      ['ben', 360],
    ].sort((a, b) => (b[1] as number) - (a[1] as number)));
    // 2 Nov 2026 is a Monday: weeks begin on it.
    expect(t.byWeek.map((x) => [x.key, x.minutes])).toEqual([
      ['2026-11-02', 420],
      ['2026-11-09', 240],
    ]);
    expect(t.weeks).toEqual(['2026-10-26', '2026-11-02', '2026-11-09']);
    const hist1 = t.byIssue.find((i) => i.issue === 'HIST-1')!;
    expect(hist1).toMatchObject({ minutes: 600, spentMinutes: 600, estimateMinutes: 480, overMinutes: 120 });
    expect(t.matrix.find((m) => m.user?.login === 'anna')!.minutes).toEqual([0, 60, 240]);
    const mine = await timeReport(anna, { project: 'HIST', from: '2026-11-01', to: '2026-11-10', author: 'me' }, NOW);
    expect(mine.totalMinutes).toBe(300);
  });
});

describe('speed', () => {
  it('works out 90 days of flow for thousands of issues in well under a few seconds', async () => {
    await createProject(w.adminCtx, { key: 'PERF', name: 'Many issues', template: 'software' });
    const s = await w.app.schema.get();
    const project = s.projectsByKey.get('PERF')!;
    const states = ['In Progress', 'In Review', 'Fixed'];
    const base = Date.parse('2026-08-01T09:00:00Z');
    const rows: (typeof activities.$inferInsert)[] = [];
    const N = 3000;
    for (let n = 1; n <= N; n++) {
      const rid = `PERF-${n}`;
      const start = base + (n % 90) * 86_400_000;
      rows.push({ type: 'issue.created', projectId: project.id, issueId: null, actorId: null, channel: 'api', payload: { issue: { id: rid, summary: `Issue ${n}`, resolved: false, state: 'Open' }, data: { fields: { State: 'Open', Estimation: '1d' } } }, createdAt: new Date(start) });
      states.forEach((state, k) => {
        rows.push({
          type: 'issue.updated',
          projectId: project.id,
          issueId: null,
          actorId: null,
          channel: 'api',
          payload: { issue: { id: rid, summary: `Issue ${n}`, resolved: state === 'Fixed', state }, changes: [{ field: 'State', from: k ? states[k - 1] : 'Open', to: state }, { field: 'Description', from: null, to: 'x'.repeat(200) }] },
          createdAt: new Date(start + (k + 1) * 3 * 86_400_000),
        });
      });
    }
    for (let i = 0; i < rows.length; i += 1000) await w.app.db.insert(activities).values(rows.slice(i, i + 1000));
    const t0 = Date.now();
    const f = await flowReport(anna, { project: 'PERF', from: '2026-08-01', to: '2026-10-29', timeZone: 'UTC' }, Date.parse('2026-11-01T00:00:00Z'));
    const took = Date.now() - t0;
    expect(f.days).toHaveLength(90);
    expect(f.days.at(-1)!.total).toBe(N);
    const t1 = Date.now();
    await cycleTimeReport(anna, { project: 'PERF', from: '2026-08-01', to: '2026-10-29', timeZone: 'UTC' }, Date.parse('2026-11-01T00:00:00Z'));
    const tookCycle = Date.now() - t1;
    console.log(`flow over ${N} issues (${rows.length} events), 90 days: ${took} ms; cycle time: ${tookCycle} ms`);
    expect(took).toBeLessThan(8000);
    void issues;
  });
});
