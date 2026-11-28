/**
 * Cost tracking: planned, actual and forecast cost per task and per person,
 * budget variance, and earned value (EVM) against a baseline. Figures are
 * computed unrounded and rounded at the output boundary (money to cents,
 * indices to three decimals).
 *
 * Across projects (D73) a task's money is in its own calendar's currency, and
 * budgets are each calendar's. Money is totalled per currency, never converted:
 * a summary counts what is in its own currency, and a plan of several
 * currencies says the rest apart (`byCurrency`).
 */
import { isISODate } from '../lib/dates';
import { workingDaysInclusive } from './calendar';
import { planCalendars } from './plan-calendars';
import type {
  CalendarCostRow,
  CostResult,
  CurrencyCostRow,
  EvmResult,
  PersonCostRow,
  PersonCurrencyCost,
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

/** Every task's money in its own currency (D73); one currency for a plan of one. */
type CurrencyOf = (taskId: string) => string;
const ONE_CURRENCY: CurrencyOf = () => '';

/**
 * Planned, actual and forecast cost of every task in `tasks` (unrounded), in its own currency.
 * Summaries add their subtasks' figures in that currency to their own, so nothing is counted twice.
 */
export function taskCosts(input: PlanInput, tasks: readonly ScheduledTask[], currencyOf: CurrencyOf = ONE_CURRENCY): Map<string, TaskCost> {
  return rollUp(basisOf(input, new Set(tasks.map((t) => t.id))), tasks, currencyOf).costs;
}

interface RolledUp {
  /** Each task's figures in its own currency, its subtasks' in that currency included. */
  costs: Map<string, TaskCost>;
  /** Each task's and its subtasks' figures, by currency. */
  subtree: Map<string, Map<string, TaskCost>>;
}

function rollUp(basis: CostBasis, tasks: readonly ScheduledTask[], currencyOf: CurrencyOf): RolledUp {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const children = new Map<string, string[]>();
  for (const t of tasks) if (t.parent && byId.has(t.parent)) pushTo(children, t.parent, t.id);
  const subtree = new Map<string, Map<string, TaskCost>>();
  const visit = (t: ScheduledTask): Map<string, TaskCost> => {
    const done = subtree.get(t.id);
    if (done) return done;
    const sums = new Map<string, TaskCost>([[currencyOf(t.id), ownCost(t, basis)]]);
    for (const id of children.get(t.id) ?? []) {
      for (const [currency, c] of visit(byId.get(id)!)) {
        const cost = sums.get(currency);
        if (!cost) {
          sums.set(currency, { ...c });
          continue;
        }
        cost.planned += c.planned;
        cost.actual += c.actual;
        cost.forecast += c.forecast;
      }
    }
    subtree.set(t.id, sums);
    return sums;
  };
  for (const t of tasks) visit(t);
  return { costs: new Map(tasks.map((t) => [t.id, subtree.get(t.id)!.get(currencyOf(t.id))!])), subtree };
}

const nothing = (): TaskCost => ({ planned: 0, actual: 0, forecast: 0 });

/**
 * The cost report for a schedule (which may be a what-if schedule). A plan of one calendar has its budget
 * and currency; a plan of several has each calendar's (D73), and totals per currency, never converted.
 */
export function computeCosts(input: PlanInput, schedule: ScheduleResult): CostResult {
  const tasks = schedule.tasks;
  const inPlan = new Set(tasks.map((t) => t.id));
  const basis = basisOf(input, inPlan);
  const cals = planCalendars(input);
  const currencyOf: CurrencyOf = (id) => cals.of(id).currency;
  const { costs, subtree } = rollUp(basis, tasks, currencyOf);
  const leaves = tasks.filter((t) => !t.isSummary);
  const totals = new Map<string, TaskCost>();
  for (const t of tasks) {
    if (t.parent && inPlan.has(t.parent)) continue;
    for (const [currency, c] of subtree.get(t.id)!) {
      const total = totals.get(currency) ?? nothing();
      totals.set(currency, total);
      total.planned += c.planned;
      total.actual += c.actual;
      total.forecast += c.forecast;
    }
  }
  const currencies = [...new Set(cals.keys.map((k) => cals.byKey.get(k)!.currency))].sort();
  // Totals in one currency: the one its calendars use, or with several, the plan's own calendar's.
  const severalCurrencies = currencies.length > 1;
  const currency = severalCurrencies ? input.calendar.currency : currencies[0]!;
  const total = totals.get(currency) ?? nothing();
  // A plan of one calendar has its budget; a plan of several has each calendar's, and none of its own.
  const budget = cals.several ? null : cals.byKey.get(cals.keys[0]!)!.budget;
  const counted = (id: string): boolean => !severalCurrencies || currencyOf(id) === currency;
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
  const evmOf = (actual: number, counts: (id: string) => boolean): EvmResult | null =>
    input.baseline ? earnedValue(cals.of, input.baseline, schedule, actual, counts) : null;
  const warnings = rateWarnings(leaves, basis);
  for (const other of currencies) {
    if (other !== currency) warnings.push(`Some costs are in ${other}: the totals are in ${currency}, and each currency is totalled on its own, never converted`);
  }
  return {
    currency,
    budget,
    plannedCost: money(total.planned),
    actualCost: money(total.actual),
    forecastCost: money(total.forecast),
    budgetVariance: budget === null ? null : money(budget - total.forecast),
    byTask,
    byPerson: personRows(input, leaves, basis, { currencyOf, currency, split: severalCurrencies, keyed: cals.keyed }),
    evm: evmOf(total.actual, counted),
    warnings,
    ...(cals.keyed
      ? {
          byCalendar: cals.keys.map((key) => calendarRow(key, cals.byKey.get(key)!, tasks.filter((t) => cals.keyOf(t.id) === key), basis)),
          byCurrency: currencies.map((c): CurrencyCostRow => {
            const sum = totals.get(c) ?? nothing();
            return {
              currency: c,
              plannedCost: money(sum.planned),
              actualCost: money(sum.actual),
              forecastCost: money(sum.forecast),
              evm: evmOf(sum.actual, (id) => currencyOf(id) === c),
            };
          }),
        }
      : {}),
  };
}

/** One calendar's budget and its tasks' own money, in its currency. */
function calendarRow(key: string, cal: PlanCalendar, tasks: readonly ScheduledTask[], basis: CostBasis): CalendarCostRow {
  const sum = nothing();
  for (const t of tasks) {
    const c = ownCost(t, basis);
    sum.planned += c.planned;
    sum.actual += c.actual;
    sum.forecast += c.forecast;
  }
  return {
    calendarId: key,
    currency: cal.currency,
    budget: cal.budget,
    plannedCost: money(sum.planned),
    actualCost: money(sum.actual),
    forecastCost: money(sum.forecast),
    budgetVariance: cal.budget === null ? null : money(cal.budget - sum.forecast),
  };
}

interface PersonMoney {
  currencyOf: CurrencyOf;
  /** The report's currency. */
  currency: string;
  /** Several currencies: a person's figures are those in the report's currency. */
  split: boolean;
  /** Each person's money also by currency. */
  keyed: boolean;
}

/**
 * Planned (estimates of their leaf tasks) and actual (their logged work) hours and cost per person. Their
 * rate is read in the currency of the project the work is in; nothing converts it (D73).
 */
function personRows(input: PlanInput, leaves: readonly ScheduledTask[], basis: CostBasis, m: PersonMoney): PersonCostRow[] {
  const rows = new Map<string, PersonCostRow>();
  const split = new Map<string, Map<string, PersonCurrencyCost>>();
  const row = (id: string): PersonCostRow => {
    let r = rows.get(id);
    if (!r) {
      r = { resourceId: id, hourlyRate: rateOf(basis, id), plannedHours: 0, actualHours: 0, plannedCost: 0, actualCost: 0 };
      rows.set(id, r);
    }
    return r;
  };
  const inCurrency = (id: string, currency: string): PersonCurrencyCost => {
    const byCurrency = split.get(id) ?? new Map<string, PersonCurrencyCost>();
    split.set(id, byCurrency);
    const c = byCurrency.get(currency) ?? { currency, plannedCost: 0, actualCost: 0 };
    byCurrency.set(currency, c);
    return c;
  };
  for (const t of leaves) {
    if (!t.assigneeId) continue;
    const r = row(t.assigneeId);
    const cost = (t.effortMinutes / 60) * (r.hourlyRate ?? 0);
    r.plannedHours += t.effortMinutes / 60;
    r.plannedCost += cost;
    inCurrency(t.assigneeId, m.currencyOf(t.id)).plannedCost += cost;
  }
  for (const items of basis.items.values()) {
    for (const w of items) {
      if (!w.authorId) continue;
      const r = row(w.authorId);
      const cost = workItemCost(basis, w);
      r.actualHours += w.minutes / 60;
      r.actualCost += cost;
      inCurrency(w.authorId, m.currencyOf(w.taskId)).actualCost += cost;
    }
  }
  const known = input.resources.map((r) => r.id).filter((id) => rows.has(id));
  const unknown = [...rows.keys()].filter((id) => !basis.resources.has(id)).sort(compareIds);
  return [...new Set([...known, ...unknown])].map((id) => {
    const r = rows.get(id)!;
    const byCurrency = [...(split.get(id)?.values() ?? [])].sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));
    const own = m.split ? byCurrency.find((c) => c.currency === m.currency) : undefined;
    return {
      ...r,
      plannedHours: hours2(r.plannedHours),
      actualHours: hours2(r.actualHours),
      plannedCost: money(m.split ? (own?.plannedCost ?? 0) : r.plannedCost),
      actualCost: money(m.split ? (own?.actualCost ?? 0) : r.actualCost),
      ...(m.keyed ? { byCurrency: byCurrency.map((c) => ({ currency: c.currency, plannedCost: money(c.plannedCost), actualCost: money(c.actualCost) })) } : {}),
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
 * the plan have nothing to earn), and of them those `counts` keeps: a
 * currency's (D73). Each row's planned share counts its task's own calendar's
 * days. AC is the actual cost in the same money.
 */
function earnedValue(
  calendarOf: (taskId: string) => PlanCalendar,
  baseline: PlanBaseline,
  schedule: ScheduleResult,
  actualCost: number,
  counts: (taskId: string) => boolean,
): EvmResult {
  const leaves = new Map(schedule.tasks.filter((t) => !t.isSummary).map((t) => [t.id, t]));
  const seen = new Set<string>();
  let bac = 0;
  let pv = 0;
  let ev = 0;
  for (const b of baseline.tasks) {
    const t = leaves.get(b.id);
    if (!t || seen.has(b.id) || !isISODate(b.start) || !isISODate(b.finish)) continue;
    seen.add(b.id);
    if (!counts(b.id)) continue;
    const cost = finite(b.cost, 0);
    bac += cost;
    pv += cost * plannedFraction(calendarOf(b.id), b.start, b.finish, schedule.today);
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
