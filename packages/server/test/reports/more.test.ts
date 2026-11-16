import { eq, gt, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemCtx } from '../../src/app-services';
import type { Ctx } from '../../src/context';
import { activities, issues } from '../../src/db/schema';
import { searchIssues } from '../../src/search/service';
import { createBoard } from '../../src/services/boards';
import { createIssue, getIssue, updateIssue } from '../../src/services/issues';
import { averageAgeReport, issuesPerFieldReport, matrixReport, timeInStateReport } from '../../src/services/more-reports';
import { moveIssue } from '../../src/services/move';
import { createProject } from '../../src/services/projects';
import { createdResolvedReport, cycleTimeReport, flowReport } from '../../src/services/reports';
import { createWorld, type TestWorld } from '../helpers';

let w: TestWorld;
let anna: Ctx;
const NOW = Date.parse('2026-11-10T12:00:00Z');
const UTC = { timeZone: 'UTC' };

/** Run `fn`, then place every activity it recorded at `when`, as if it had happened then. */
async function at<T>(when: string, fn: () => Promise<T>): Promise<T> {
  const [{ max } = { max: 0 }] = await w.app.db.select({ max: sql<number>`coalesce(max(${activities.id}), 0)` }).from(activities);
  const result = await fn();
  await w.app.db.update(activities).set({ createdAt: new Date(when) }).where(gt(activities.id, Number(max)));
  return result;
}

const count = async (query: string | null) => (query === null ? null : (await searchIssues(anna, query)).items.length);

let moved = '';
beforeAll(async () => {
  w = await createWorld();
  anna = systemCtx(w.app, w.anna, 'web');
  await createProject(w.adminCtx, { key: 'MVA', name: 'Moves from', template: 'software' });
  await createProject(w.adminCtx, { key: 'MVB', name: 'Moves to', template: 'software' });
  await createProject(w.adminCtx, { key: 'FLD', name: 'Fields', template: 'software' });
  // MVA-1 starts in MVA, moves to MVB on the third, and is fixed there on the fifth.
  const first = await at('2026-11-01T10:00:00Z', () => createIssue(anna, { project: 'MVA', summary: 'Moves across' }));
  await w.app.db.update(issues).set({ createdAt: new Date('2026-11-01T10:00:00Z') }).where(eq(issues.id, first.uid));
  await at('2026-11-01T12:00:00Z', () => createIssue(anna, { project: 'MVA', summary: 'Stays put' }));
  await at('2026-11-02T10:00:00Z', () => updateIssue(anna, 'MVA-1', { fields: { State: 'In Progress' } }));
  moved = (await at('2026-11-03T10:00:00Z', () => moveIssue(anna, 'MVA-1', { project: 'MVB' }))).to!;
  await at('2026-11-05T10:00:00Z', () => updateIssue(anna, moved, { fields: { State: 'Fixed' } }));

  await createIssue(anna, { project: 'FLD', summary: 'One', fields: { Priority: 'Critical', Type: 'Bug', Estimation: '2d', 'Due date': '2026-11-20' } });
  await createIssue(anna, { project: 'FLD', summary: 'Two', fields: { Priority: 'Critical', Type: 'Feature', 'Due date': '2026-11-21' } });
  await createIssue(anna, { project: 'FLD', summary: 'Three', fields: { Priority: 'Major', Type: 'Bug', Assignee: w.anna.login } });
  await createIssue(anna, { project: 'FLD', summary: 'Four, in progress', fields: { Priority: 'Major', Type: 'Bug', State: 'In Progress' } });
});
afterAll(async () => w?.close());

describe('a moved issue in the history reports (D41)', () => {
  const totals = async (input: { project?: string; query?: string }) => (await flowReport(anna, { ...input, from: '2026-11-01', to: '2026-11-05', ...UTC }, NOW)).days.map((d) => d.total);

  it('counts once, in the project it was in each day', async () => {
    expect(moved).toMatch(/^MVB-\d+$/);
    expect(await totals({ project: 'MVA' })).toEqual([2, 2, 1, 1, 1]); // it leaves on the third
    expect(await totals({ project: 'MVB' })).toEqual([0, 0, 1, 1, 1]); // and arrives there
    expect(await totals({ query: 'project: MVA, MVB' })).toEqual([2, 2, 2, 2, 2]); // never twice
  });

  it('arrives without being created, and is resolved where it was resolved', async () => {
    const a = await createdResolvedReport(anna, { project: 'MVA', from: '2026-11-01', to: '2026-11-05', ...UTC }, NOW);
    const b = await createdResolvedReport(anna, { project: 'MVB', from: '2026-11-01', to: '2026-11-05', ...UTC }, NOW);
    expect(a.totals).toEqual({ created: 2, resolved: 0, reopened: 0 });
    expect(b.totals).toEqual({ created: 0, resolved: 1, reopened: 0 });
    expect(b.buckets.map((x) => x.open)).toEqual([0, 0, 1, 1, 0]);
    const cycle = await cycleTimeReport(anna, { project: 'MVB', from: '2026-11-01', to: '2026-11-05', ...UTC }, NOW);
    expect(cycle.issues.map((i) => [i.issue, i.days])).toEqual([[moved, 2]]); // its clock starts here: in progress on arriving
    expect((await cycleTimeReport(anna, { project: 'MVA', from: '2026-11-01', to: '2026-11-05', ...UTC }, NOW)).count).toBe(0);
    // A query takes the issues it matches now over their whole history, wherever the caller can see.
    const byQuery = await cycleTimeReport(anna, { query: `issue id: ${moved}`, from: '2026-11-01', to: '2026-11-05', ...UTC }, NOW);
    expect(byQuery.issues.map((i) => [i.issue, i.days])).toEqual([[moved, 3]]);
  });

  it('keeps its age from its creation, and its time in a state only where it spent it', async () => {
    const age = await averageAgeReport(anna, { project: 'MVB', from: '2026-11-04', to: '2026-11-04', ...UTC }, NOW);
    expect(age.days).toEqual([{ date: '2026-11-04', open: 1, averageDays: 3.6, medianDays: 3.6 }]);
    const tis = await timeInStateReport(anna, { project: 'MVB', from: '2026-11-01', to: '2026-11-05', ...UTC }, NOW);
    const inProgress = tis.states.findIndex((s) => s.name === 'In Progress');
    expect(tis.issues).toHaveLength(1);
    expect(tis.issues[0]!.days[inProgress]).toBe(2); // two of its three days in progress were in MVB
    expect(tis.states[inProgress]).toMatchObject({ issues: 1, p50: 2, p85: 2 });
    const mva = await timeInStateReport(anna, { project: 'MVA', from: '2026-11-01', to: '2026-11-05', ...UTC }, NOW);
    expect(mva.issues).toEqual([]);
    expect(mva.ongoing.map((o) => [o.issue, o.state, o.daysInState])).toEqual([['MVA-2', 'Open', 4.5]]);
  });
});

describe('issues per field and the matrix', () => {
  it('counts by any field, each count with the query that finds its issues', async () => {
    const byPriority = await issuesPerFieldReport(anna, { project: 'FLD', field: 'priority', ...UTC }, NOW);
    expect(byPriority.field).toEqual({ name: 'Priority', type: 'enum', multi: false });
    expect(byPriority.total).toBe(4);
    expect(byPriority.values.map((v) => [v.label, v.count])).toEqual([
      ['Critical', 2],
      ['Major', 2],
    ]);
    for (const v of byPriority.values) expect(await count(v.query)).toBe(v.count);

    const byDue = await issuesPerFieldReport(anna, { project: 'FLD', field: 'Due date', ...UTC }, NOW);
    expect(byDue.interval).toBe('day');
    expect(byDue.values.map((v) => [v.key, v.count])).toEqual([
      ['2026-11-20', 1],
      ['2026-11-21', 1],
      ['', 2],
    ]);
    for (const v of byDue.values) expect(await count(v.query)).toBe(v.count);
    const byWeek = await issuesPerFieldReport(anna, { project: 'FLD', field: 'Due date', interval: 'week', ...UTC }, NOW);
    expect(byWeek.values[0]).toMatchObject({ key: '2026-11-16', label: 'Week of 2026-11-16', count: 2 });
    expect(await count(byWeek.values[0]!.query)).toBe(2);

    for (const field of ['Estimation', 'Assignee', 'State', 'Project']) {
      const r = await issuesPerFieldReport(anna, { project: 'FLD', field, ...UTC }, NOW);
      expect(r.values.reduce((n, v) => n + v.count, 0)).toBe(4);
      for (const v of r.values) expect(await count(v.query), `${field}: ${v.label}`).toBe(v.count);
    }
  });

  it('crosses two fields, with totals, each cell opening its issues', async () => {
    const m = await matrixReport(anna, { project: 'FLD', rows: 'Priority', columns: 'Type', ...UTC }, NOW);
    expect(m.rows.values.map((r) => [r.label, r.count])).toEqual([
      ['Critical', 2],
      ['Major', 2],
    ]);
    const types = m.columns.values.map((c) => c.label);
    const cell = (row: number, type: string) => m.cells[row]![types.indexOf(type)]!;
    expect(cell(0, 'Bug').count).toBe(1);
    expect(cell(0, 'Feature').count).toBe(1);
    expect(cell(1, 'Bug').count).toBe(2);
    expect(m.total).toBe(4);
    for (const row of m.cells) for (const c of row) expect(await count(c.query)).toBe(c.count);
  });

  it('says which fields there are when one is unknown', async () => {
    await expect(issuesPerFieldReport(anna, { project: 'FLD', field: 'Priorty' }, NOW)).rejects.toMatchObject({ hint: expect.stringContaining('Did you mean "Priority"?') });
  });
});

describe('time in a board\'s columns', () => {
  it('adds up the states each column holds', async () => {
    await createBoard(w.adminCtx, {
      name: 'Moves board',
      projects: ['MVB'],
      columns: [
        { name: 'To do', values: ['Open', 'Submitted'], wipLimit: null },
        { name: 'Doing', values: ['In Progress'], wipLimit: null },
        { name: 'Done', values: ['Fixed', 'Verified'], wipLimit: null },
      ],
    });
    const t = await timeInStateReport(anna, { board: 'moves board', from: '2026-11-01', to: '2026-11-05', ...UTC }, NOW);
    expect(t.by).toBe('column');
    expect(t.states.map((s) => s.name)).toEqual(['To do', 'Doing', 'Done']);
    expect(t.issues.map((i) => [i.issue, i.days])).toEqual([[moved, [0, 2, 0]]]);
    await expect(timeInStateReport(anna, { board: 'No such board' }, NOW)).rejects.toMatchObject({ status: 404 });
    expect((await getIssue(anna, moved)).id).toBe(moved);
  });
});
