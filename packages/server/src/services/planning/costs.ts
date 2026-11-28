/** A plan's costs and earned value, for those with the costs permission (D37, D64), per calendar and per currency (D73). */
import type { CostReport } from '@a4a/shared';
import type { Ctx } from '../../context';
import { computeCosts, computeSchedule, PLAN_CALENDAR_KEY } from '../../planning';
import { userRefDto } from '../values';
import { loadProjectPlan, type Loaded } from './load';

export async function getCostReport(ctx: Ctx, key: string, opts: { baseline?: string } = {}): Promise<CostReport> {
  // Costs are for roles that see time and costs (D37).
  const l = await loadProjectPlan(ctx, key, { baselineId: opts.baseline, need: 'costs' });
  return costReportOf(l);
}

/**
 * The cost report of a loaded plan. Each project's money is in its own currency and against its own budget
 * (`byCalendar`, by the project's key); the plan's is totalled per currency, never converted (`byCurrency`).
 * Across several calendars the plan has no budget of its own, and its top-level figures are in its own
 * calendar's currency (D73).
 */
export function costReportOf(l: Loaded): CostReport {
  const schedule = computeSchedule(l.input);
  const c = computeCosts(l.input, schedule);
  const calendarKey = (k: string) => (k === PLAN_CALENDAR_KEY ? (l.project?.key ?? '') : k);
  return {
    project: l.project ? { id: l.project.id, key: l.project.key, name: l.project.name } : { id: '', key: '', name: '' },
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
        return u
          ? {
              user: userRefDto(u),
              hourlyRate: p.hourlyRate,
              plannedHours: p.plannedHours,
              actualHours: p.actualHours,
              plannedCost: p.plannedCost,
              actualCost: p.actualCost,
              ...(p.byCurrency ? { byCurrency: p.byCurrency } : {}),
            }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null),
    evm: c.evm,
    warnings: c.warnings,
    ...(c.byCalendar
      ? {
          byCalendar: c.byCalendar.map((k) => ({
            calendar: calendarKey(k.calendarId),
            currency: k.currency,
            budget: k.budget,
            plannedCost: k.plannedCost,
            actualCost: k.actualCost,
            forecastCost: k.forecastCost,
            budgetVariance: k.budgetVariance,
          })),
        }
      : {}),
    ...(c.byCurrency ? { byCurrency: c.byCurrency } : {}),
  };
}
