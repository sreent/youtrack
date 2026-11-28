/**
 * Critical-path scheduling over working days: durations from estimates and
 * capacity, a forward pass (early dates), a backward pass (late dates, slack,
 * critical path), summary roll-ups and baseline variance. Leaf tasks are
 * scheduled; summary tasks span their subtasks.
 *
 * Each task is planned on its own calendar (its project's, D73) and its
 * assignee's days. A dependency is measured on the successor's calendar, then
 * snapped to its assignee's days; going back, a predecessor's bound snaps to
 * its own days. Numbers of the whole plan count the union calendar's days.
 */
import { isISODate, maxDate } from '../lib/dates';
import { availabilityByCalendar, everyone, spanFrom, type Availability } from './availability';
import { addWorkingDays, nextWorkingDay, prevWorkingDay, workingDaysBetween, workingDaysInclusive } from './calendar';
import { taskCosts, type TaskCost } from './costs';
import { buildGraph, type PlanGraph } from './graph';
import { planCalendars, type PlanCalendars } from './plan-calendars';
import type {
  PlanBaseline,
  PlanBaselineTask,
  PlanCalendar,
  PlanInput,
  PlanOverride,
  PlanResource,
  PlanTaskInput,
  ScheduleBaselineSummary,
  ScheduledFrom,
  ScheduledTask,
  ScheduleResult,
  WhatIfAnalysis,
  WhatIfImpact,
} from './types';
import { ceilSafe, cleanDate, compareIds, finite, money, Warnings } from './util';

/** Longest task the engine plans, in working days (about 20 years). */
export const MAX_TASK_DAYS = 5_000;

/** The schedule plus what levelling needs to replay it. */
export interface PlanModel {
  schedule: ScheduleResult;
  /** Where the plan begins: the earliest of where its calendars' work begins (`anchorOf`). */
  anchor: string;
  /** Where it would begin if these tasks had these Start dates (as levelling writes them). */
  anchorWith(starts: Readonly<Record<string, string>>): string;
  /**
   * Where a calendar's work begins (D73): its own start date, else the earliest Start date or logged work
   * of its tasks (`starts` standing in for theirs), else its first working day from today.
   */
  anchorOf(key: string, starts?: Readonly<Record<string, string>>): string;
  /** The calendar numbers of the whole plan count on: its one calendar, normalised, or the union of its several (D73). */
  calendar: PlanCalendar;
  /** Its calendars: each task's own, and that union. */
  calendars: PlanCalendars;
  graph: PlanGraph;
  tasks: Map<string, ScheduledTask>;
  /**
   * When a person can work on a calendar, by default the plan's (`calendar`): its days without their days
   * away, on their week (D36, D43). Its share of a day is theirs on every calendar.
   */
  availabilityOf(resourceId: string | null, cal?: PlanCalendar): Availability;
  /**
   * Where a task not yet started would run if it began no earlier than `from`: its assignee's
   * first working day from then, and the day its work would be done.
   */
  spanOf(id: string, from: string): { start: string; finish: string };
}

type LeafKind = 'resolved' | 'in_progress' | 'planned';

/** A what-if's edits to one task. */
interface TaskEdit {
  start?: string;
  delay?: number;
  effort?: number;
  assigneeId?: string | null;
}

/** Scheduling state of one leaf task. */
interface Leaf {
  task: PlanTaskInput;
  /** Its calendar (its project's, D73): its key and the calendar, normalised. */
  key: string;
  cal: PlanCalendar;
  kind: LeafKind;
  assigneeId: string | null;
  effort: number;
  dailyHours: number;
  /** Working days: planned length, then (once placed) the span it occupies. */
  duration: number;
  /** No estimate, but a start date and a due date: the task fills that window. */
  pinned: boolean;
  /** Latest of its own start date and its ancestors'. */
  startFloor: string | null;
  /** Earliest of its own due date and its ancestors'. */
  deadlineCap: string | null;
  /** When its assignee works on its calendar; a milestone, or work with nobody to do it, keeps the calendar. */
  avail: Availability;
  delay: number;
  es: string;
  ef: string;
  ls: string;
  lf: string;
  slack: number;
  from: ScheduledFrom;
}

interface Context {
  today: string;
  cals: PlanCalendars;
  graph: PlanGraph;
  tasks: Map<string, PlanTaskInput>;
  resources: Map<string, PlanResource>;
  edits: Map<string, TaskEdit>;
  warn: (message: string) => void;
  availabilityOf: (cal: PlanCalendar, resourceId: string | null) => Availability;
}

/** When two start terms give the same date, the more specific reason wins. */
const REASON_RANK: Record<ScheduledFrom, number> = { project_start: 0, start: 1, fixed: 2, dependencies: 3, actual: 4 };

/** The warning for a window that falls while its assignee is away (D36): it says when someone is away. */
const AWAY_WARNING = ' falls on days its assignee is away; planned for when they’re back';
export const awayWarning = (id: string): string => `${id}${AWAY_WARNING}`;
/** Whether a warning says that someone is away, for a reader who isn't told who is (a guest, D64). */
export const isAwayWarning = (warning: string): boolean => warning.endsWith(AWAY_WARNING);

/** The project schedule, optionally with what-if overrides applied. */
export function computeSchedule(input: PlanInput, overrides: readonly PlanOverride[] = []): ScheduleResult {
  return buildPlan(input, overrides).schedule;
}

/** Compares the schedule with and without `overrides`; nothing is saved. */
export function whatIf(input: PlanInput, overrides: readonly PlanOverride[]): WhatIfAnalysis {
  const before = computeSchedule(input);
  const after = computeSchedule(input, overrides);
  // Each task moves by days of its own calendar; the plan, by days of the union of its calendars (D73).
  const cals = planCalendars(input);
  const prior = new Map(before.tasks.map((t) => [t.id, t]));
  const impacted: WhatIfImpact[] = [];
  for (const t of after.tasks) {
    const b = prior.get(t.id);
    if (!b || (b.start === t.start && b.finish === t.finish)) continue;
    const cal = cals.of(t.id);
    impacted.push({
      id: t.id,
      summary: t.summary,
      startDeltaDays: workingDaysBetween(cal, b.start, t.start),
      finishDeltaDays: workingDaysBetween(cal, b.finish, t.finish),
    });
  }
  return {
    before: { finish: before.finish, criticalPath: before.criticalPath },
    after,
    finishDeltaDays: workingDaysBetween(cals.union, before.finish, after.finish),
    impacted,
  };
}

/** Computes the schedule and keeps the graph and calendar it used. */
export function buildPlan(input: PlanInput, overrides: readonly PlanOverride[] = []): PlanModel {
  if (!isISODate(input.today)) throw new Error(`PlanInput.today must be an ISO date (YYYY-MM-DD), got "${input.today}"`);
  const warnings = new Warnings();
  const tasks = sanitizeTasks(input.tasks, warnings.add);
  const graph = buildGraph(tasks, warnings.add);
  const cals = planCalendars(input, tasks, warnings.add);
  const ctx: Context = {
    today: input.today,
    cals,
    graph,
    tasks: new Map(tasks.map((t) => [t.id, t])),
    resources: new Map(input.resources.map((r) => [r.id, r])),
    edits: new Map(),
    warn: warnings.add,
    availabilityOf: availabilityByCalendar(input.absences, input.today, input.resources),
  };
  collectEdits(ctx, overrides);

  const leaves = new Map(graph.leaves.map((id) => [id, setUpLeaf(ctx, id)]));
  // Each calendar's work begins where that calendar's does; the plan, at the earliest of them (D73).
  const starts = new Map(cals.keys.map((k) => [k, calendarStart(ctx, k)]));
  const planStart = minOf([...starts.values()])!;
  forwardPass(ctx, leaves, starts);
  const projectFinish = maxOf([...leaves.values()].map((l) => l.ef)) ?? planStart;
  backwardPass(ctx, leaves, projectFinish);

  const byId = new Map<string, ScheduledTask>();
  for (const leaf of leaves.values()) byId.set(leaf.task.id, leafTask(ctx, leaf));
  for (const id of graph.ids) if (!graph.isLeaf(id)) byId.set(id, summaryTask(ctx, id, byId));
  const ordered = orderTasks(graph, byId);
  const costs = taskCosts(input, ordered, (id) => cals.of(id).currency);
  for (const t of ordered) {
    t.plannedCost = money(costs.get(t.id)!.planned);
    t.actualCost = money(costs.get(t.id)!.actual);
  }

  const start = minOf([...cals.keys.map((k) => cals.byKey.get(k)!.startDate), ...ordered.map((t) => t.start)]) ?? planStart;
  const finish = leaves.size > 0 ? projectFinish : start;
  const baseline = compareBaseline(ctx, input.baseline ?? null, ordered, costs, finish);
  const topo = new Map(graph.order.map((id, i) => [id, i]));
  const criticalPath = ordered
    .filter((t) => !t.isSummary && t.critical)
    .sort((a, b) => compareDates(a.earlyStart, b.earlyStart) || topo.get(a.id)! - topo.get(b.id)!)
    .map((t) => t.id);
  const schedule: ScheduleResult = {
    start,
    finish,
    today: input.today,
    tasks: ordered,
    criticalPath,
    warnings: warnings.list,
    baseline,
  };
  return {
    schedule,
    calendar: cals.union,
    calendars: cals,
    graph,
    tasks: byId,
    anchor: planStart,
    anchorWith: (written) => minOf(cals.keys.map((k) => calendarStart(ctx, k, written)))!,
    anchorOf: (key, written = {}) => calendarStart(ctx, key, written),
    availabilityOf: (resourceId, cal = cals.union) => ctx.availabilityOf(cal, resourceId),
    spanOf: (id, from) => {
      const leaf = leaves.get(id);
      if (!leaf) throw new Error(`${id} is not a task of this plan's to schedule`);
      const { start, finish } = spanAt(leaf, from);
      return { start, finish };
    },
  };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Drops duplicate ids and invalid dates (with warnings) and clamps numbers. */
function sanitizeTasks(tasks: readonly PlanTaskInput[], warn: (message: string) => void): PlanTaskInput[] {
  const seen = new Set<string>();
  const out: PlanTaskInput[] = [];
  for (const t of tasks) {
    if (seen.has(t.id)) {
      warn(`${t.id} appears more than once in the plan; using the first`);
      continue;
    }
    seen.add(t.id);
    const date = (value: string | null, label: string): string | null =>
      cleanDate(value, (raw) => warn(`${t.id} has an invalid ${label} "${raw}"; ignored`));
    const effort = finite(t.effortMinutes, 0);
    out.push({
      ...t,
      effortMinutes: effort > 0 ? effort : null,
      spentMinutes: Math.max(0, finite(t.spentMinutes, 0)),
      startConstraint: date(t.startConstraint, 'start date'),
      deadline: date(t.deadline, 'due date'),
      resolvedAt: date(t.resolvedAt, 'resolution date'),
      firstWorkDate: date(t.firstWorkDate, 'first work date'),
      predecessors: [...new Set(t.predecessors)],
    });
  }
  return out;
}

/** Records what-if edits in `ctx.edits`; later overrides of the same task win. */
function collectEdits(ctx: Context, overrides: readonly PlanOverride[]): void {
  for (const o of overrides) {
    const t = ctx.tasks.get(o.id);
    if (!t) {
      ctx.warn(`Override for ${o.id} ignored: it is not in this plan`);
      continue;
    }
    const leaf = ctx.graph.isLeaf(o.id);
    if (leaf && t.resolved) {
      ctx.warn(`${o.id} is resolved; its override is ignored`);
      continue;
    }
    const edit = ctx.edits.get(o.id) ?? {};
    if (o.start !== undefined) {
      if (!isISODate(o.start)) ctx.warn(`Override for ${o.id}: "${o.start}" is not a date; ignored`);
      else if (leaf && !t.isMilestone && t.firstWorkDate) ctx.warn(`${o.id} has already started; its start override is ignored`);
      else edit.start = o.start;
    }
    if (o.delayDays !== undefined) edit.delay = Math.min(MAX_TASK_DAYS, Math.max(0, ceilSafe(finite(o.delayDays, 0))));
    if (o.effortMinutes !== undefined) {
      if (leaf) edit.effort = Math.max(0, finite(o.effortMinutes, 0));
      else ctx.warn(`${o.id} is a summary task; its estimate override is ignored`);
    }
    if (o.assigneeId !== undefined) edit.assigneeId = o.assigneeId;
    ctx.edits.set(o.id, edit);
  }
}

/**
 * Where a calendar's work begins: its start date, else the earliest start date or logged work of its tasks,
 * else today. Each project keeps its own start (D73); a plan of one calendar begins where it always did.
 */
function calendarStart(ctx: Context, key: string, starts: Readonly<Record<string, string>> = {}): string {
  const cal = ctx.cals.byKey.get(key)!;
  if (cal.startDate) return cal.startDate;
  const own = [...ctx.tasks.values()].filter((t) => ctx.cals.keyOf(t.id) === key);
  // Not the raw today: a plan can only begin on a working day, so the fallback is the first one (D43's revisit).
  return minOf(own.flatMap((t) => [starts[t.id] ?? t.startConstraint, t.firstWorkDate])) ?? nextWorkingDay(cal, ctx.today);
}

// ---------------------------------------------------------------------------
// Leaf tasks: durations and the two passes
// ---------------------------------------------------------------------------

function setUpLeaf(ctx: Context, id: string): Leaf {
  const t = ctx.tasks.get(id)!;
  const edit = ctx.edits.get(id) ?? {};
  const ancestors = ctx.graph.ancestors.get(id)!;
  const kind: LeafKind = t.resolved ? 'resolved' : !t.isMilestone && t.firstWorkDate ? 'in_progress' : 'planned';
  const assigneeId = edit.assigneeId !== undefined ? edit.assigneeId : t.assigneeId;
  const ownStart = edit.start ?? t.startConstraint;
  const key = ctx.cals.keyOf(id);
  const cal = ctx.cals.byKey.get(key)!;
  // A milestone is a point in time, not anybody's work; nor is work with nobody to do it.
  const avail = t.isMilestone ? everyone(cal) : ctx.availabilityOf(cal, assigneeId && ctx.resources.has(assigneeId) ? assigneeId : null);
  const leaf: Leaf = {
    task: t,
    key,
    cal,
    kind,
    assigneeId,
    effort: edit.effort ?? t.effortMinutes ?? 0,
    dailyHours: dailyHours(ctx, cal, id, assigneeId, kind !== 'resolved'),
    duration: 0,
    pinned: false,
    startFloor: maxOf([ownStart, ...ancestors.map((a) => ctx.edits.get(a)?.start ?? ctx.tasks.get(a)!.startConstraint)]),
    deadlineCap: minOf([t.deadline, ...ancestors.map((a) => ctx.tasks.get(a)!.deadline)]),
    avail,
    delay: delayOf(ctx, id),
    es: ctx.today,
    ef: ctx.today,
    ls: ctx.today,
    lf: ctx.today,
    slack: 0,
    from: 'project_start',
  };
  if (kind === 'planned') Object.assign(leaf, plannedDuration(ctx, leaf, ownStart));
  if (kind === 'in_progress') leaf.duration = remainingDays(ctx, leaf);
  return leaf;
}

/** Hours a day the assignee can give the task: min(capacity, its calendar's day), else a calendar day. */
function dailyHours(ctx: Context, cal: PlanCalendar, id: string, assigneeId: string | null, report: boolean): number {
  const r = assigneeId ? ctx.resources.get(assigneeId) : undefined;
  if (assigneeId && !r && report) {
    ctx.warn(`${id} is assigned to ${assigneeId}, who is not a plan resource; planned at ${cal.hoursPerDay}h a day`);
  }
  const hours = r ? Math.min(finite(r.capacityHoursPerDay, 0), cal.hoursPerDay) : cal.hoursPerDay;
  return hours > 0 ? hours : cal.hoursPerDay;
}

/** Its own delay, plus that of each ancestor it opens (no predecessor inside that ancestor). */
function delayOf(ctx: Context, id: string): number {
  let delay = ctx.edits.get(id)?.delay ?? 0;
  for (const a of ctx.graph.ancestors.get(id)!) {
    const extra = ctx.edits.get(a)?.delay;
    if (!extra) continue;
    const inside = new Set(ctx.graph.leafDescendants.get(a));
    if (!ctx.graph.leafPreds.get(id)!.some((p) => inside.has(p))) delay += extra;
  }
  return Math.min(delay, MAX_TASK_DAYS);
}

/** Milestone 0; estimate ÷ daily hours; a start-to-due window; else 1 day. */
function plannedDuration(ctx: Context, leaf: Leaf, ownStart: string | null): { duration: number; pinned: boolean } {
  const t = leaf.task;
  if (t.isMilestone) return { duration: 0, pinned: false };
  if (leaf.effort > 0) {
    return { duration: clampDays(ctx, t.id, ceilSafe(leaf.effort / 60 / leaf.dailyHours)), pinned: false };
  }
  if (ownStart && t.deadline) {
    const theirs = workingDaysInclusive(leaf.avail.cal, ownStart, t.deadline);
    if (theirs === 0 && workingDaysInclusive(leaf.cal, ownStart, t.deadline) > 0) {
      ctx.warn(awayWarning(t.id));
    }
    return { duration: clampDays(ctx, t.id, theirs), pinned: true };
  }
  ctx.warn(`${t.id} has no estimate; planned as 1 day`);
  return { duration: 1, pinned: false };
}

/** Working days left on a task in progress (at least one). */
function remainingDays(ctx: Context, leaf: Leaf): number {
  if (leaf.effort <= 0) ctx.warn(`${leaf.task.id} has no estimate; planned as 1 day`);
  const remaining = Math.max(leaf.effort - leaf.task.spentMinutes, 0);
  return remaining > 0 ? clampDays(ctx, leaf.task.id, ceilSafe(remaining / 60 / leaf.dailyHours)) : 1;
}

function clampDays(ctx: Context, id: string, days: number): number {
  if (days <= MAX_TASK_DAYS) return Math.max(1, days);
  ctx.warn(`${id} would take ${days} working days; planned as ${MAX_TASK_DAYS}`);
  return MAX_TASK_DAYS;
}

/** Early dates, in topological order; each task from where its calendar's work begins. */
function forwardPass(ctx: Context, leaves: Map<string, Leaf>, starts: ReadonlyMap<string, string>): void {
  for (const id of ctx.graph.order) {
    const leaf = leaves.get(id)!;
    if (leaf.kind === 'resolved') placeResolved(ctx, leaf);
    else if (leaf.kind === 'in_progress') placeInProgress(ctx, leaf);
    else placePlanned(ctx, leaf, starts.get(leaf.key)!, ctx.graph.leafPreds.get(id)!.map((p) => leaves.get(p)!));
  }
}

/** Actual dates; early = late, no slack. */
function placeResolved(ctx: Context, leaf: Leaf): void {
  const t = leaf.task;
  let start = t.startConstraint ?? t.firstWorkDate ?? t.resolvedAt ?? ctx.today;
  const finish = t.resolvedAt ?? start;
  if (start > finish || t.isMilestone) start = finish;
  leaf.es = leaf.ls = start;
  leaf.ef = leaf.lf = finish;
  leaf.slack = 0;
  leaf.from = 'actual';
  leaf.duration = t.isMilestone ? 0 : Math.max(1, workingDaysInclusive(leaf.cal, start, finish));
}

/** Started on its first logged work; the remaining work runs from today, on its assignee's days. */
function placeInProgress(ctx: Context, leaf: Leaf): void {
  const start = leaf.task.firstWorkDate!;
  const cal = leaf.avail.cal;
  const resume = nextWorkingDay(cal, maxDate(ctx.today, start));
  const remaining = Math.max(leaf.effort - leaf.task.spentMinutes, 0) / 60;
  leaf.es = start;
  leaf.ef =
    leaf.avail.hasAbsences && remaining > 0
      ? spanFrom(leaf.avail, addWorkingDays(cal, resume, leaf.delay), remaining, leaf.dailyHours, MAX_TASK_DAYS).finish
      : addWorkingDays(cal, resume, leaf.duration - 1 + leaf.delay);
  leaf.from = 'actual';
  leaf.duration = Math.max(1, workingDaysInclusive(cal, start, leaf.ef));
}

/**
 * Not started: the next working day on or after the latest of the project
 * start, today, its start date and the day after each predecessor finishes
 * (a milestone sits on its predecessors' finish day), then any delay. "The day
 * after" is its own calendar's next working day (D73), and then it waits for
 * its assignee's next day.
 */
function placePlanned(ctx: Context, leaf: Leaf, planStart: string, preds: readonly Leaf[]): void {
  const milestone = leaf.task.isMilestone;
  const terms: [string, ScheduledFrom][] = [
    [planStart, 'project_start'],
    [ctx.today, 'project_start'],
  ];
  if (leaf.startFloor) terms.push([leaf.startFloor, leaf.pinned ? 'fixed' : 'start']);
  for (const p of preds) terms.push([milestone ? p.ef : addWorkingDays(leaf.cal, p.ef, 1), 'dependencies']);
  let [date, from] = terms[0]!;
  for (const [d, f] of terms) if (d > date || (d === date && REASON_RANK[f] > REASON_RANK[from])) [date, from] = [d, f];
  let es = nextWorkingDay(leaf.avail.cal, date);
  if (leaf.delay > 0) es = addWorkingDays(leaf.avail.cal, es, leaf.delay);
  const span = spanAt(leaf, es);
  leaf.es = span.start;
  leaf.ef = span.finish;
  leaf.duration = span.days;
  leaf.from = from;
}

/**
 * Where a leaf not yet started runs if it begins no earlier than `from`, on its assignee's
 * days, and how many of their days that is. Its work at its daily hours takes as many as it
 * needs, a half day away giving half; a start-to-due window keeps its length.
 */
function spanAt(leaf: Leaf, from: string): { start: string; finish: string; days: number } {
  const start = nextWorkingDay(leaf.avail.cal, from);
  if (leaf.task.isMilestone) return { start, finish: start, days: 0 };
  if (leaf.pinned || !leaf.avail.hasAbsences || leaf.effort <= 0) {
    return { start, finish: addWorkingDays(leaf.avail.cal, start, leaf.duration - 1), days: leaf.duration };
  }
  const span = spanFrom(leaf.avail, start, leaf.effort / 60, leaf.dailyHours, MAX_TASK_DAYS);
  return { start, finish: span.finish, days: span.days };
}

/**
 * Late dates and slack of unresolved leaves, in reverse topological order.
 * Only not-started successors hold a task back (started work already began),
 * and a due date (its own or an ancestor's) caps the late finish, which is
 * what makes slack negative when a task cannot meet it.
 */
function backwardPass(ctx: Context, leaves: Map<string, Leaf>, projectFinish: string): void {
  const finishLine = prevWorkingDay(ctx.cals.union, projectFinish);
  for (const id of [...ctx.graph.order].reverse()) {
    const leaf = leaves.get(id)!;
    if (leaf.kind === 'resolved') continue;
    let lf = finishLine;
    for (const s of ctx.graph.leafSuccs.get(id)!) {
      const succ = leaves.get(s)!;
      if (succ.kind !== 'planned') continue;
      // The last day before its successor starts is its own calendar's, as forward its successor's is (D73):
      // a Friday can come before a Sunday start, where neither calendar works the Saturday.
      const bound = succ.task.isMilestone ? succ.ls : addWorkingDays(leaf.cal, succ.ls, -1);
      if (bound < lf) lf = bound;
    }
    if (leaf.deadlineCap && leaf.deadlineCap < lf) lf = leaf.deadlineCap;
    // Its own days: the last it can finish on is a day its assignee works.
    const cal = leaf.avail.cal;
    lf = prevWorkingDay(cal, lf);
    leaf.lf = lf;
    // Started work cannot start any later: its late start is its actual start, its slack is finish slack.
    if (leaf.kind === 'in_progress') leaf.ls = leaf.es;
    else leaf.ls = leaf.task.isMilestone ? lf : addWorkingDays(cal, lf, -(leaf.duration - 1));
    leaf.slack = workingDaysBetween(cal, leaf.ef, lf);
  }
}

// ---------------------------------------------------------------------------
// Output rows
// ---------------------------------------------------------------------------

function leafTask(ctx: Context, leaf: Leaf): ScheduledTask {
  const t = leaf.task;
  return {
    id: t.id,
    summary: t.summary,
    parent: ctx.graph.parent.get(t.id) ?? null,
    depth: ctx.graph.depth.get(t.id)!,
    isSummary: false,
    isMilestone: t.isMilestone,
    resolved: t.resolved,
    assigneeId: leaf.assigneeId,
    priorityOrdinal: t.priorityOrdinal,
    start: leaf.es,
    finish: leaf.ef,
    durationDays: leaf.duration,
    effortMinutes: leaf.effort,
    spentMinutes: t.spentMinutes,
    remainingMinutes: t.resolved || t.isMilestone ? 0 : Math.max(leaf.effort - t.spentMinutes, 0),
    percentComplete: t.resolved ? 100 : leaf.effort > 0 ? Math.min(95, Math.round((t.spentMinutes / leaf.effort) * 100)) : 0,
    earlyStart: leaf.es,
    earlyFinish: leaf.ef,
    lateStart: leaf.ls,
    lateFinish: leaf.lf,
    slackDays: leaf.slack,
    critical: !t.resolved && leaf.slack <= 0,
    deadline: t.deadline,
    late: t.deadline !== null && leaf.ef > t.deadline,
    scheduledFrom: leaf.from,
    predecessors: ctx.graph.predecessors.get(t.id)!,
    plannedCost: 0,
    actualCost: 0,
    baseline: null,
    variance: null,
  };
}

/** Spans its leaf subtasks; effort and progress roll up, own logged time included. */
function summaryTask(ctx: Context, id: string, byId: Map<string, ScheduledTask>): ScheduledTask {
  const t = ctx.tasks.get(id)!;
  if (t.effortMinutes) ctx.warn(`${id} is a summary task; its own estimate is ignored`);
  const leaves = ctx.graph.leafDescendants.get(id)!.map((l) => byId.get(l)!);
  const open = leaves.filter((l) => !l.resolved);
  const first = [...leaves].sort((a, b) => compareDates(a.start, b.start) || compareIds(a.id, b.id))[0]!;
  const finish = maxOf(leaves.map((l) => l.finish))!;
  const edit = ctx.edits.get(id);
  const sum = (pick: (task: ScheduledTask) => number): number => leaves.reduce((s, l) => s + pick(l), 0);
  return {
    id,
    summary: t.summary,
    parent: ctx.graph.parent.get(id) ?? null,
    depth: ctx.graph.depth.get(id)!,
    isSummary: true,
    isMilestone: false,
    resolved: open.length === 0,
    assigneeId: edit?.assigneeId !== undefined ? edit.assigneeId : t.assigneeId,
    priorityOrdinal: t.priorityOrdinal,
    start: first.start,
    finish,
    // Its span is its subtasks', counted on its own calendar (D73).
    durationDays: leaves.every((l) => l.isMilestone) ? 0 : Math.max(1, workingDaysInclusive(ctx.cals.of(id), first.start, finish)),
    effortMinutes: sum((l) => l.effortMinutes),
    spentMinutes: [id, ...ctx.graph.descendants.get(id)!].reduce((s, d) => s + ctx.tasks.get(d)!.spentMinutes, 0),
    remainingMinutes: sum((l) => l.remainingMinutes),
    percentComplete: rollUpPercent(leaves, open.length === 0),
    earlyStart: minOf(leaves.map((l) => l.earlyStart))!,
    earlyFinish: maxOf(leaves.map((l) => l.earlyFinish))!,
    lateStart: minOf(leaves.map((l) => l.lateStart))!,
    lateFinish: maxOf(leaves.map((l) => l.lateFinish))!,
    slackDays: open.reduce((min, l) => Math.min(min, l.slackDays), open.length > 0 ? Infinity : 0),
    critical: leaves.some((l) => l.critical),
    deadline: t.deadline,
    late: t.deadline !== null && finish > t.deadline,
    scheduledFrom: first.scheduledFrom,
    predecessors: ctx.graph.predecessors.get(id)!,
    plannedCost: 0,
    actualCost: 0,
    baseline: null,
    variance: null,
  };
}

/** Effort-weighted (plain average when nothing is estimated); 100 only when all are resolved. */
function rollUpPercent(leaves: readonly ScheduledTask[], resolved: boolean): number {
  if (resolved) return 100;
  const effort = leaves.reduce((s, l) => s + l.effortMinutes, 0);
  const work = leaves.filter((l) => !l.isMilestone);
  const pool = work.length > 0 ? work : leaves;
  const pct =
    effort > 0
      ? leaves.reduce((s, l) => s + l.percentComplete * l.effortMinutes, 0) / effort
      : pool.reduce((s, l) => s + l.percentComplete, 0) / pool.length;
  return Math.min(99, Math.round(pct));
}

/** Parent first, depth first; siblings by start, then id. */
function orderTasks(graph: PlanGraph, byId: Map<string, ScheduledTask>): ScheduledTask[] {
  const out: ScheduledTask[] = [];
  const visit = (ids: readonly string[]): void => {
    const siblings = ids.map((id) => byId.get(id)!).sort((a, b) => compareDates(a.start, b.start) || compareIds(a.id, b.id));
    for (const t of siblings) {
      out.push(t);
      visit(graph.children.get(t.id) ?? []);
    }
  };
  visit(graph.ids.filter((id) => graph.parent.get(id) === null));
  return out;
}

/** Fills each task's baseline and variance (current minus baseline) and summarises the finish. */
function compareBaseline(
  ctx: Context,
  baseline: PlanBaseline | null,
  tasks: readonly ScheduledTask[],
  costs: Map<string, TaskCost>,
  finish: string,
): ScheduleBaselineSummary | null {
  if (!baseline) return null;
  const rows = new Map<string, PlanBaselineTask>();
  for (const b of baseline.tasks) {
    if (!isISODate(b.start) || !isISODate(b.finish)) ctx.warn(`Baseline row for ${b.id} has invalid dates; ignored`);
    else if (!rows.has(b.id)) rows.set(b.id, b);
  }
  for (const t of tasks) {
    const b = rows.get(t.id);
    if (!b) continue;
    t.baseline = { start: b.start, finish: b.finish, effortMinutes: b.effortMinutes, cost: b.cost };
    const cal = ctx.cals.of(t.id);
    t.variance = {
      startDays: workingDaysBetween(cal, b.start, t.start),
      finishDays: workingDaysBetween(cal, b.finish, t.finish),
      effortMinutes: t.effortMinutes - finite(b.effortMinutes, 0),
      cost: money(costs.get(t.id)!.planned - finite(b.cost, 0)),
    };
  }
  const baselineFinish = maxOf([...rows.values()].map((b) => b.finish)) ?? finish;
  return {
    id: baseline.id,
    name: baseline.name,
    finish: baselineFinish,
    finishVarianceDays: workingDaysBetween(ctx.cals.union, baselineFinish, finish),
  };
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function minOf(dates: readonly (string | null)[]): string | null {
  let best: string | null = null;
  for (const d of dates) if (d !== null && (best === null || d < best)) best = d;
  return best;
}

function maxOf(dates: readonly (string | null)[]): string | null {
  let best: string | null = null;
  for (const d of dates) if (d !== null && (best === null || d > best)) best = d;
  return best;
}
