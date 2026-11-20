import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminCtx } from '../src/app-services';
import { seedDemo } from '../src/db/seed';
import { createIssue } from '../src/services/issues';
import { createBaseline, getCostReport, getResourceLoad, getSchedule, level, listBaselines, whatIfSchedule } from '../src/services/planning';
import { createProject, getProject } from '../src/services/projects';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
beforeAll(async () => {
  w = await createWorld({ projects: false, people: false });
  await seedDemo(w.app, w.admin);
});
afterAll(async () => w?.close());

describe('planning over the demo data', () => {
  it('schedules the migration with summary rows, a critical path and the plan of record', async () => {
    const ctx = adminCtx(w.app, w.admin);
    const [baseline] = await listBaselines(ctx, 'MIG');
    expect(baseline!.name).toBe('Plan of record');
    const s = await getSchedule(ctx, 'MIG', { baseline: baseline!.id });
    expect(s.tasks.filter((t) => t.isSummary).map((t) => t.issue.summary)).toEqual(['Assessment', 'Design', 'Migration', 'Closure']);
    expect(s.criticalPath.length).toBeGreaterThan(3);
    const cutover = s.tasks.find((t) => t.issue.summary === 'Cut over DNS and traffic')!;
    expect(cutover.predecessors.length).toBe(2);
    expect(s.baseline?.name).toBe('Plan of record');
    expect(s.baseline!.finishVarianceDays).toBeGreaterThan(0); // slipped since kickoff
    const depmap = s.tasks.find((t) => t.issue.summary === 'Map application dependencies')!;
    expect(depmap.scheduledFrom).toBe('actual');
    expect(depmap.variance).not.toBeNull();
  });

  it('answers what-if questions without saving', async () => {
    const ctx = adminCtx(w.app, w.admin);
    const s = await getSchedule(ctx, 'MIG');
    const critical = s.criticalPath.find((id) => !s.tasks.find((t) => t.issue.id === id)!.issue.resolved)!;
    const res = await whatIfSchedule(ctx, 'MIG', { overrides: [{ issue: critical, delayDays: 3 }] });
    expect(res.finishDeltaDays).toBe(3);
    expect((await getSchedule(ctx, 'MIG')).finish).toBe(s.finish);
  });

  it('finds Chloé over capacity; within_slack keeps the finish date', async () => {
    const ctx = adminCtx(w.app, w.admin);
    const load = await getResourceLoad(ctx, 'MIG');
    expect(load.resources.find((r) => r.user.login === 'chloe')!.overallocatedDays).toBeGreaterThan(0);
    const proposal = await level(ctx, 'MIG', { mode: 'within_slack', dryRun: true });
    expect(proposal.applied).toBe(false);
    expect(proposal.finishAfter).toBe(proposal.finishBefore);
  });

  it('applies exactly the proposal it was shown, all at once, or nothing', async () => {
    const ctx = adminCtx(w.app, w.admin);
    const chloeBefore = (await getResourceLoad(ctx, 'MIG')).resources.find((r) => r.user.login === 'chloe')!.overallocatedDays;
    const proposal = await level(ctx, 'MIG', { mode: 'allow_delay', dryRun: true });
    expect(proposal.overallocatedDaysAfter).toBeLessThan(proposal.overallocatedDaysBefore);
    const moved = proposal.changes.filter((c) => c.movedBy === 'resources');
    expect(Object.keys(proposal.starts).sort()).toEqual(moved.map((c) => c.issue).sort());

    // A proposal that no longer holds is refused, and nothing is written.
    const [first] = Object.keys(proposal.starts);
    const stale = { ...proposal.starts, [first!]: '2001-01-01' };
    await expect(level(ctx, 'MIG', { mode: 'allow_delay', dryRun: false, expect: stale })).rejects.toMatchObject({ status: 409 });
    expect((await getSchedule(ctx, 'MIG')).finish).toBe(proposal.finishBefore);

    const applied = await level(ctx, 'MIG', { mode: 'allow_delay', dryRun: false, expect: proposal.starts });
    expect(applied.applied).toBe(true);
    // The plan now is the plan proposed: every task moved, for resources or by following, lands where it was shown.
    const after = await getSchedule(ctx, 'MIG');
    expect(after.finish).toBe(proposal.finishAfter);
    const byId = new Map(after.tasks.map((t) => [t.issue.id, t]));
    for (const c of proposal.changes) {
      expect([c.issue, byId.get(c.issue)!.start, byId.get(c.issue)!.finish]).toEqual([c.issue, c.toStart, c.toFinish]);
    }
    const chloeAfter = (await getResourceLoad(ctx, 'MIG')).resources.find((r) => r.user.login === 'chloe')!.overallocatedDays;
    expect(chloeAfter).toBeLessThan(chloeBefore);
    // Levelled again, there is nothing left to move.
    expect(Object.keys((await level(ctx, 'MIG', { mode: 'allow_delay', dryRun: true })).starts)).toHaveLength(0);
  });

  it('keeps where a plan without a start date of its own begins, so it stays as levelled', async () => {
    const ctx = adminCtx(w.app, w.admin);
    await createProject(ctx, { key: 'CUT', name: 'Cutover', template: 'waterfall' });
    const runbook = await createIssue(ctx, { project: 'CUT', summary: 'Write the runbook', fields: { Type: 'Task', Assignee: 'anna', Estimation: '3d' } });
    await createIssue(ctx, { project: 'CUT', summary: 'Review the runbook', fields: { Type: 'Task', Assignee: 'anna', Estimation: '2d' } });
    expect((await getProject(ctx, 'CUT')).settings.plan.startDate).toBeNull();
    const before = await getSchedule(ctx, 'CUT');
    const startOf = (s: typeof before, id: string) => s.tasks.find((t) => t.issue.id === id)!.start;

    const proposal = await level(ctx, 'CUT', { mode: 'allow_delay', dryRun: true });
    expect(Object.keys(proposal.starts)).toHaveLength(1);
    expect(proposal.keepsStart).toBe(startOf(before, runbook.id));
    await level(ctx, 'CUT', { mode: 'allow_delay', dryRun: false, expect: proposal.starts });

    // Its written Start date is no longer where the plan begins: the runbook stays, and the plan is the proposal.
    const after = await getSchedule(ctx, 'CUT');
    expect(startOf(after, runbook.id)).toBe(startOf(before, runbook.id));
    expect(after.finish).toBe(proposal.finishAfter);
    expect((await getProject(ctx, 'CUT')).settings.plan.startDate).toBe(proposal.keepsStart);
    expect(Object.keys((await level(ctx, 'CUT', { mode: 'allow_delay', dryRun: true })).starts)).toHaveLength(0);
  });

  it('reports costs and earned value against the baseline', async () => {
    const ctx = adminCtx(w.app, w.admin);
    const [baseline] = await listBaselines(ctx, 'MIG');
    const c = await getCostReport(ctx, 'MIG', { baseline: baseline!.id });
    expect(c.currency).toBe('USD');
    expect(c.budget).toBe(60000);
    expect(c.actualCost).toBeGreaterThan(0);
    expect(c.plannedCost).toBeGreaterThan(15000); // includes the 12k + 3k fixed costs
    expect(c.evm).not.toBeNull();
    expect(c.evm!.bac).toBeCloseTo(baseline!.plannedCost, 0);
    const later = await createBaseline(ctx, 'MIG', { name: 'After levelling' });
    expect(later.taskCount).toBeGreaterThan(10);
  });
});
describe("the load grid's team (D43's revisit)", () => {
  it('shows the project\'s members who can change its issues, with their capacity, even with nothing planned', async () => {
    const ctx = adminCtx(w.app, w.admin);
    const load = await getResourceLoad(ctx, 'MIG');
    const logins = load.resources.map((r) => r.user.login);
    // Diego is a member of MIG: his capacity is on the grid as his own.
    expect(logins).toContain('diego');
    const diego = load.resources.find((r) => r.user.login === 'diego');
    expect(diego!.capacityHoursPerDay).toBeGreaterThan(0);
  });
});
