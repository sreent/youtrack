/**
 * Cost tracking: planned, actual and forecast cost per task and per person,
 * budget variance, and earned value (EVM) against a baseline. Figures are
 * computed unrounded and rounded at the output boundary (money to cents,
 * indices to three decimals).
 */
import { isISODate } from '../lib/dates';
import { normalizeCalendar, workingDaysInclusive } from './calendar';
import type {
  CostResult,
  EvmResult,
  PersonCostRow,
  PlanBaseline,
  PlanCalendar,
  PlanInput,
  PlanResource,
  PlanWorkItem,
  ScheduleResult,
  ScheduledTask,
  TaskCostRow,
} from './types';
import { compareIds, finite, hours2, money, pushTo, round, Warnings } from './util';

/** Unrounded cost of one task; a summary's includes its subtasks'. */
export interface TaskCost {
  planned: number;
  actual: number;
  forecast: number;
}

interface CostBasis {
  resources: Map<string, PlanResource>;
  fixed: Map<string, number>;
  /** Work items of in-plan tasks, by task id. */
  items: Map<string, PlanWorkItem[]>;
}

function basisOf(input: PlanInput, inPlan: ReadonlySet<string>): CostBasis {
  const fixed = new Map<string, number>();
  for (const t of input.tasks) if (inPlan.has(t.id) && !fixed.has(t.id)) fixed.set(t.id, finite(t.fixedCost, 0));
  const items = new Map<string, PlanWorkItem[]>();
  for (const w of input.workItems) {
    if (inPlan.has(w.taskId) && finite(w.minutes, 0) > 0) pushTo(items, w.taskId, w);
  }
  return { resources: new Map(input.resources.map((r) => [r.id, r])), fixed, items };
}

/** A person's current hourly rate, or null when they have none (or are not a plan resource). */
function rateOf(basis: CostBasis, personId: string | null): number | null {
  const r = personId ? basis.resources.get(personId) : undefined;
  return r && typeof r.hourlyRate === 'number' && Number.isFinite(r.hourlyRate) ? r.hourlyRate : null;
}

/** minutes / 60 × (the item's own rate ?? the author's current rate ?? 0). */
function workItemCost(basis: CostBasis, w: PlanWorkItem): number {
  const rate = typeof w.hourlyRate === 'number' && Number.isFinite(w.hourlyRate) ? w.hourlyRate : rateOf(basis, w.authorId);
  return (w.minutes / 60) * (rate ?? 0);
}

/** A task's own figures. A summary's estimate is ignored, but its own fixed cost and logged work are real money. */
function ownCost(t: ScheduledTask, basis: CostBasis): TaskCost {
  const fixed = basis.fixed.get(t.id) ?? 0;
  const logged = (basis.items.get(t.id) ?? []).reduce((sum, w) => sum + workItemCost(basis, w), 0);
  const actual = logged + (t.resolved ? fixed : 0);
  if (t.isSummary) return { planned: fixed, actual, forecast: logged + fixed };
  const rate = rateOf(basis, t.assigneeId) ?? 0;
  const remainingHours = Math.max(t.effortMinutes - t.spentMinutes, 0) / 60;
  return {
    planned: (t.effortMinutes / 60) * rate + fixed,
    actual,
    forecast: t.resolved ? actual : logged + remainingHours * rate + fixed,
  };
}

/**
 * Planned, actual and forecast cost of every task in `tasks` (unrounded).
 * Summaries add their subtasks' figures to their own, so nothing is counted twice.
 */
export function taskCosts(input: PlanInput, tasks: readonly ScheduledTask[]): Map<string, TaskCost> {
  return rollUp(basisOf(input, new Set(tasks.map((t) => t.id))), tasks);
}

function rollUp(basis: CostBasis, tasks: readonly ScheduledTask[]): Map<string, TaskCost> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const children = new Map<string, string[]>();
  for (const t of tasks) if (t.parent && byId.has(t.parent)) pushTo(children, t.parent, t.id);
  const result = new Map<string, TaskCost>();
  const visit = (t: ScheduledTask): TaskCost => {
    const done = result.get(t.id);
    if (done) return done;
    const cost = ownCost(t, basis);
    for (const id of children.get(t.id) ?? []) {
      const c = visit(byId.get(id)!);
      cost.planned += c.planned;
      cost.actual += c.actual;
      cost.forecast += c.forecast;
    }
    result.set(t.id, cost);
    return cost;
  };
  for (const t of tasks) visit(t);
  return result;
}

/** The cost report for a schedule (which may be a what-if schedule). */
export function computeCosts(input: PlanInput, schedule: ScheduleResult): CostResult {
  const tasks = schedule.tasks;
  const inPlan = new Set(tasks.map((t) => t.id));
  const basis = basisOf(input, inPlan);
  const costs = rollUp(basis, tasks);
  const leaves = tasks.filter((t) => !t.isSummary);
  const total = { planned: 0, actual: 0, forecast: 0 };
  for (const t of tasks) {
    if (t.parent && inPlan.has(t.parent)) continue;
    const c = costs.get(t.id)!;
    total.planned += c.planned;
    total.actual += c.actual;
    total.forecast += c.forecast;
  }
  const calendar = normalizeCalendar(input.calendar);
  const byTask: TaskCostRow[] = leaves.map((t) => ({
    id: t.id,
    summary: t.summary,
    assigneeId: t.assigneeId,
    plannedCost: money(costs.get(t.id)!.planned),
    actualCost: money(costs.get(t.id)!.actual),
    fixedCost: money(basis.fixed.get(t.id) ?? 0),
    effortMinutes: t.effortMinutes,
    spentMinutes: t.spentMinutes,
    resolved: t.resolved,
  }));
  return {
    currency: input.calendar.currency,
    budget: calendar.budget,
    plannedCost: money(total.planned),
    actualCost: money(total.actual),
    forecastCost: money(total.forecast),
    budgetVariance: calendar.budget === null ? null : money(calendar.budget - total.forecast),
    byTask,
    byPerson: personRows(input, leaves, basis),
    evm: input.baseline ? earnedValue(calendar, input.baseline, schedule, total.actual) : null,
    warnings: rateWarnings(leaves, basis),
  };
}

/** Planned (estimates of their leaf tasks) and actual (their logged work) hours and cost per person. */
function personRows(input: PlanInput, leaves: readonly ScheduledTask[], basis: CostBasis): PersonCostRow[] {
  const rows = new Map<string, PersonCostRow>();
  const row = (id: string): PersonCostRow => {
    let r = rows.get(id);
    if (!r) {
      r = { resourceId: id, hourlyRate: rateOf(basis, id), plannedHours: 0, actualHours: 0, plannedCost: 0, actualCost: 0 };
      rows.set(id, r);
    }
    return r;
  };
  for (const t of leaves) {
    if (!t.assigneeId) continue;
    const r = row(t.assigneeId);
    r.plannedHours += t.effortMinutes / 60;
    r.plannedCost += (t.effortMinutes / 60) * (r.hourlyRate ?? 0);
  }
  for (const items of basis.items.values()) {
    for (const w of items) {
      if (!w.authorId) continue;
      const r = row(w.authorId);
      r.actualHours += w.minutes / 60;
      r.actualCost += workItemCost(basis, w);
    }
  }
  const known = input.resources.map((r) => r.id).filter((id) => rows.has(id));
  const unknown = [...rows.keys()].filter((id) => !basis.resources.has(id)).sort(compareIds);
  return [...new Set([...known, ...unknown])].map((id) => {
    const r = rows.get(id)!;
    return {
      ...r,
      plannedHours: hours2(r.plannedHours),
      actualHours: hours2(r.actualHours),
      plannedCost: money(r.plannedCost),
      actualCost: money(r.actualCost),
    };
  });
}

/** One warning per person whose missing rate turns an estimate or logged work into 0. */
function rateWarnings(leaves: readonly ScheduledTask[], basis: CostBasis): string[] {
  const warnings = new Warnings();
  const check = (personId: string): void => {
    if (rateOf(basis, personId) !== null) return;
    const r = basis.resources.get(personId);
    warnings.add(
      r
        ? `${r.name} has no hourly rate; their work counts as 0`
        : `${personId} is not a plan resource and has no hourly rate; their work counts as 0`,
    );
  };
  for (const t of leaves) if (t.assigneeId && t.effortMinutes > 0) check(t.assigneeId);
  let anonymous = 0;
  for (const items of basis.items.values()) {
    for (const w of items) {
      if (typeof w.hourlyRate === 'number' && Number.isFinite(w.hourlyRate)) continue;
      if (w.authorId) check(w.authorId);
      else anonymous++;
    }
  }
  if (anonymous > 0) warnings.add(`${anonymous} work item(s) have no author and no rate; they count as 0`);
  return warnings.list;
}

/**
 * Share of a baseline task's working days elapsed by `asOf` (inclusive): 0
 * before its start, 1 from its finish on, linear between. A one-day task or a
 * milestone therefore steps from 0 to 1 on its date.
 */
export function plannedFraction(cal: PlanCalendar, start: string, finish: string, asOf: string): number {
  if (asOf < start) return 0;
  if (asOf >= finish) return 1;
  const total = workingDaysInclusive(cal, start, finish);
  return total > 0 ? workingDaysInclusive(cal, start, asOf) / total : 0;
}

/**
 * Earned value over the baseline rows that are leaf tasks of this plan
 * (summary rows would count their subtasks twice; rows for tasks no longer in
 * the plan have nothing to earn). AC is the plan's total actual cost.
 */
function earnedValue(cal: PlanCalendar, baseline: PlanBaseline, schedule: ScheduleResult, actualCost: number): EvmResult {
  const leaves = new Map(schedule.tasks.filter((t) => !t.isSummary).map((t) => [t.id, t]));
  const seen = new Set<string>();
  let bac = 0;
  let pv = 0;
  let ev = 0;
  for (const b of baseline.tasks) {
    const t = leaves.get(b.id);
    if (!t || seen.has(b.id) || !isISODate(b.start) || !isISODate(b.finish)) continue;
    seen.add(b.id);
    const cost = finite(b.cost, 0);
    bac += cost;
    pv += cost * plannedFraction(cal, b.start, b.finish, schedule.today);
    ev += (cost * t.percentComplete) / 100;
  }
  const ac = actualCost;
  const cpi = ac > 0 ? ev / ac : null;
  const spi = pv > 0 ? ev / pv : null;
  const eac = cpi ? bac / cpi : null;
  return {
    asOf: schedule.today,
    bac: money(bac),
    pv: money(pv),
    ev: money(ev),
    ac: money(ac),
    cv: money(ev - ac),
    sv: money(ev - pv),
    cpi: cpi === null ? null : round(cpi, 3),
    spi: spi === null ? null : round(spi, 3),
    eac: eac === null ? null : money(eac),
    etc: eac === null ? null : money(eac - ac),
    vac: eac === null ? null : money(bac - eac),
  };
}
