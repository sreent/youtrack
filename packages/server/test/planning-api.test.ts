import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminCtx } from '../src/app-services';
import { seedDemo } from '../src/db/seed';
import { createBaseline, getCostReport, getResourceLoad, getSchedule, level, listBaselines, whatIfSchedule } from '../src/services/planning';
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

  it('finds Chloé over capacity and levels within slack without moving the finish', async () => {
    const ctx = adminCtx(w.app, w.admin);
    const load = await getResourceLoad(ctx, 'MIG');
    const chloe = load.resources.find((r) => r.user.login === 'chloe')!;
    expect(chloe.overallocatedDays).toBeGreaterThan(0);
    const before = await getSchedule(ctx, 'MIG');
    const proposal = await level(ctx, 'MIG', { mode: 'allow_delay', dryRun: true });
    expect(proposal.applied).toBe(false);
    expect(proposal.overallocatedDaysAfter).toBeLessThan(proposal.overallocatedDaysBefore);
    const applied = await level(ctx, 'MIG', { mode: 'allow_delay', dryRun: false });
    expect(applied.applied).toBe(true);
    const after = await getResourceLoad(ctx, 'MIG');
    expect(after.resources.find((r) => r.user.login === 'chloe')!.overallocatedDays).toBeLessThan(chloe.overallocatedDays);
    expect((await getSchedule(ctx, 'MIG')).finish >= before.finish).toBe(true);
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
