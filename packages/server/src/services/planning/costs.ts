/** A plan's costs and earned value, for those with the costs permission (D37, D64). */
import type { CostReport } from '@a4a/shared';
import type { Ctx } from '../../context';
import { computeCosts, computeSchedule } from '../../planning';
import { userRefDto } from '../values';
import { loadPlan } from './load';

export async function getCostReport(ctx: Ctx, key: string, opts: { baseline?: string } = {}): Promise<CostReport> {
  // Costs are for roles that see time and costs (D37).
  const l = await loadPlan(ctx, key, { baselineId: opts.baseline, need: 'costs' });
  const schedule = computeSchedule(l.input);
  const c = computeCosts(l.input, schedule);
  return {
    project: { id: l.project.id, key: l.project.key, name: l.project.name },
    currency: c.currency,
    budget: c.budget,
    plannedCost: c.plannedCost,
    actualCost: c.actualCost,
    forecastCost: c.forecastCost,
    budgetVariance: c.budgetVariance,
    byTask: c.byTask.map((t) => ({
      issue: t.id,
      summary: t.summary,
      assignee: t.assigneeId ? (l.s.users.get(t.assigneeId)?.login ?? null) : null,
      plannedCost: t.plannedCost,
      actualCost: t.actualCost,
      fixedCost: t.fixedCost,
      effortMinutes: t.effortMinutes,
      spentMinutes: t.spentMinutes,
      resolved: t.resolved,
    })),
    byPerson: c.byPerson
      .map((p) => {
        const u = l.s.users.get(p.resourceId);
        return u ? { user: userRefDto(u), hourlyRate: p.hourlyRate, plannedHours: p.plannedHours, actualHours: p.actualHours, plannedCost: p.plannedCost, actualCost: p.actualCost } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null),
    evm: c.evm,
    warnings: c.warnings,
  };
}
