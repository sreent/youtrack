/**
 * Resource load (each person's remaining work spread over working days,
 * against capacity) and resource levelling: a priority-based serial schedule
 * generation heuristic, the family MS Project's levelling belongs to. It
 * delays tasks until their assignee has room; it is not an optimiser.
 */
import { isISODate, maxDate, minDate } from '../lib/dates';
import { availabilities, type Availability } from './availability';
import { addWorkingDays, listWorkingDays, nextWorkingDay, normalizeCalendar, workingDaysBetween } from './calendar';
import { buildPlan, type PlanModel } from './schedule';
import type {
  LevelingChange,
  LevelingMode,
  LevelingProposal,
  PlanCalendar,
  PlanInput,
  PlanOverride,
  PlanResource,
  ResourceLoadDay,
  ResourceLoadResult,
  ResourceLoadRow,
  ScheduledTask,
  ScheduleResult,
} from './types';
import { compareIds, finite, hours2, round } from './util';

/** Default window of the load view, in working days. */
export const DEFAULT_LOAD_DAYS = 180;
/** Longest window the load view accepts when `to` is given, in working days. */
export const MAX_LOAD_DAYS = 1_000;
/** How far `allow_delay` levelling searches for room, in working days. */
export const LEVEL_SEARCH_DAYS = 400;
/** Hours over capacity that still count as fitting (rounding noise). */
const TOLERANCE = 0.01;

/** Hours booked per resource per day. */
type Bookings = Map<string, Map<string, number>>;

interface Spread {
  days: string[];
  /** Hours on each of `days`. */
  hours: number[];
}

/**
 * An unresolved leaf task's remaining hours spread over its assignee's working days in
 * [start, finish] (for a task in progress, from today on), evenly, a half day away taking half
 * a day's share; or null when it has no remaining hours to place.
 */
function spreadOf(a: Availability, today: string, t: ScheduledTask, start = t.start, finish = t.finish): Spread | null {
  if (t.isSummary || t.resolved || t.isMilestone || t.remainingMinutes <= 0) return null;
  const from = t.scheduledFrom === 'actual' ? nextWorkingDay(a.cal, maxDate(today, start)) : start;
  const days = listWorkingDays(a.cal, from, finish);
  if (days.length === 0) return null;
  const remaining = t.remainingMinutes / 60;
  if (!a.hasAbsences) return { days, hours: days.map(() => remaining / days.length) };
  const shares = days.map((d) => a.share(d));
  const total = shares.reduce((sum, x) => sum + x, 0);
  return { days, hours: shares.map((x) => (remaining * x) / total) };
}

function resourceMap(resources: readonly PlanResource[]): Map<string, PlanResource> {
  const map = new Map<string, PlanResource>();
  for (const r of resources) if (!map.has(r.id)) map.set(r.id, r);
  return map;
}

function capacityOf(r: PlanResource): number {
  return Math.max(0, finite(r.capacityHoursPerDay, 0));
}

/** Hours they can work on a day: all their capacity, half of it on a half day away, none on a day away. */
function capacityOn(r: PlanResource, a: Availability, d: string): number {
  return capacityOf(r) * a.share(d);
}

/** The task's assignee if they are a plan resource; anyone else counts as unassigned. */
function ownerOf(t: ScheduledTask, resources: Map<string, PlanResource>): string | null {
  return t.assigneeId && resources.has(t.assigneeId) ? t.assigneeId : null;
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Daily load per resource over [from, to]. By default the window runs from
 * today (kept within the schedule's span: remaining work is never placed in
 * the past) to the schedule's finish, at most DEFAULT_LOAD_DAYS working days;
 * at most MAX_LOAD_DAYS when `to` is given. `to` in the result is the last day
 * actually covered.
 */
export function computeLoad(input: PlanInput, schedule: ScheduleResult, from?: string, to?: string): ResourceLoadResult {
  const cal = normalizeCalendar(input.calendar);
  const availabilityOf = availabilities(cal, input.absences, input.today, input.resources);
  const window = loadWindow(cal, schedule, from, to);
  const inWindow = new Set(window.days);
  const resources = resourceMap(input.resources);
  const load = new Map<string, Map<string, Map<string, number>>>();
  let unassigned = 0;
  for (const t of schedule.tasks) {
    const owner = ownerOf(t, resources);
    const spread = spreadOf(availabilityOf(owner), schedule.today, t);
    if (!spread) continue;
    spread.days.forEach((d, i) => {
      if (!inWindow.has(d)) return;
      const h = spread.hours[i]!;
      if (owner === null) {
        unassigned += h;
        return;
      }
      const days = load.get(owner) ?? new Map<string, Map<string, number>>();
      load.set(owner, days);
      const tasks = days.get(d) ?? new Map<string, number>();
      days.set(d, tasks);
      tasks.set(t.id, (tasks.get(t.id) ?? 0) + h);
    });
  }
  return {
    from: window.from,
    to: window.to,
    resources: [...resources.values()].map((r) => loadRow(r, availabilityOf(r.id), window.days, load.get(r.id))),
    unassignedHours: hours2(unassigned),
  };
}

function loadWindow(cal: PlanCalendar, schedule: ScheduleResult, from?: string, to?: string) {
  for (const [name, value] of [
    ['from', from],
    ['to', to],
  ] as const) {
    if (value !== undefined && !isISODate(value)) throw new Error(`${name} must be an ISO date (YYYY-MM-DD), got "${value}"`);
  }
  const start = from ?? minDate(maxDate(schedule.today, schedule.start), schedule.finish);
  const end = to ?? schedule.finish;
  const limit = to === undefined ? DEFAULT_LOAD_DAYS : MAX_LOAD_DAYS;
  const days: string[] = [];
  for (let d = nextWorkingDay(cal, start); d <= end && days.length < limit; d = addWorkingDays(cal, d, 1)) days.push(d);
  const last = days[days.length - 1];
  const truncated = last !== undefined && days.length === limit && addWorkingDays(cal, last, 1) <= end;
  return { from: start, to: truncated ? last : end, days };
}

function loadRow(r: PlanResource, a: Availability, days: readonly string[], byDay?: Map<string, Map<string, number>>): ResourceLoadRow {
  let total = 0;
  let overallocated = 0;
  let peak = 0;
  const rows: ResourceLoadDay[] = days.map((date) => {
    const capacity = capacityOn(r, a, date);
    const tasks = byDay?.get(date) ?? new Map<string, number>();
    const hours = [...tasks.values()].reduce((s, h) => s + h, 0);
    total += hours;
    if (hours > capacity + TOLERANCE) overallocated++;
    if (capacity > 0) peak = Math.max(peak, (hours / capacity) * 100);
    const shares = [...tasks].map(([issue, h]) => ({ issue, hours: hours2(h) }));
    shares.sort((x, y) => y.hours - x.hours || compareIds(x.issue, y.issue));
    return { date, hours: hours2(hours), capacity: hours2(capacity), away: a.away(date), tasks: shares };
  });
  return {
    resourceId: r.id,
    capacityHoursPerDay: capacityOf(r),
    totalHours: hours2(total),
    overallocatedDays: overallocated,
    peakLoadPct: round(peak, 1),
    days: rows,
  };
}

// ---------------------------------------------------------------------------
// Levelling
// ---------------------------------------------------------------------------

interface Placement {
  start: string;
  finish: string;
}

/**
 * Proposes start dates that remove over-allocation. Resolved and in-progress
 * work stays put; not-started leaf tasks are placed one by one in dependency
 * order (ready tasks by earliest start, priority, slack, id), each at the first
 * working day its assignee has room for it on every day it spans. In
 * `within_slack` mode no task may start after its late start, so the finish
 * date never moves; tasks that cannot fit are left in place and reported.
 */
export function levelResources(
  input: PlanInput,
  mode: LevelingMode,
  overrides: readonly PlanOverride[] = [],
): LevelingProposal {
  const model = buildPlan(input, overrides);
  const { schedule, calendar: cal, graph, tasks, anchor, anchorWith } = model;
  const resources = resourceMap(input.resources);
  const today = schedule.today;
  const leaves = graph.leaves.map((id) => tasks.get(id)!);
  const planned = new Set(leaves.filter((t) => !t.resolved && t.scheduledFrom !== 'actual').map((t) => t.id));
  const ofOwner = (t: ScheduledTask): Availability => model.availabilityOf(ownerOf(t, resources));

  const booked: Bookings = new Map();
  for (const t of leaves) if (!planned.has(t.id)) book(booked, ofOwner(t), today, t, resources, t);

  const placed = new Map<string, Placement>();
  const unresolved = new Set<string>();
  const delayedForResources = new Set<string>();
  const earliestOf = (t: ScheduledTask): string => {
    let earliest = t.earlyStart;
    for (const p of graph.leafPreds.get(t.id)!) {
      const finish = placed.get(p)?.finish ?? tasks.get(p)!.finish;
      const after = t.isMilestone ? nextWorkingDay(cal, finish) : addWorkingDays(cal, finish, 1);
      if (after > earliest) earliest = after;
    }
    return earliest;
  };
  const waiting = new Map([...planned].map((id) => [id, graph.leafPreds.get(id)!.filter((p) => planned.has(p)).length]));
  const ready = [...planned].filter((id) => waiting.get(id) === 0).map((id) => ({ task: tasks.get(id)!, earliest: '' }));
  for (const r of ready) r.earliest = earliestOf(r.task);

  while (ready.length > 0) {
    ready.sort((a, b) => byLevelingPriority(a.task, a.earliest, b.task, b.earliest));
    const { task, earliest: from } = ready.shift()!;
    const owner = ownerOf(task, resources);
    const avail = ofOwner(task);
    // The first day it could start is one its assignee works; that much isn't levelling's doing.
    const earliest = model.spanOf(task.id, from).start;
    let start = earliest;
    if (owner && !task.isMilestone && task.durationDays > 0 && task.remainingMinutes > 0) {
      const latest =
        mode === 'within_slack'
          ? maxDate(task.lateStart, earliest)
          : addWorkingDays(cal, earliest, LEVEL_SEARCH_DAYS);
      const r = resources.get(owner)!;
      const slot = findSlot(avail, booked.get(owner), (d) => capacityOn(r, avail, d), earliest, latest, (s) => loadAt(model, avail, today, task, s));
      if (slot === null) unresolved.add(task.id);
      else start = slot;
      if (start > earliest) delayedForResources.add(task.id);
    }
    const placement = model.spanOf(task.id, start);
    placed.set(task.id, placement);
    book(booked, avail, today, task, resources, placement);
    for (const s of graph.leafSuccs.get(task.id)!) {
      if (!planned.has(s)) continue;
      const left = waiting.get(s)! - 1;
      waiting.set(s, left);
      if (left === 0) ready.push({ task: tasks.get(s)!, earliest: earliestOf(tasks.get(s)!) });
    }
  }

  const datesAfter = (t: ScheduledTask): Placement => placed.get(t.id) ?? t;
  const order = schedule.tasks.filter((t) => planned.has(t.id));
  const changes: LevelingChange[] = order
    .filter((t) => datesAfter(t).start !== t.start)
    .map((t) => ({
      id: t.id,
      summary: t.summary,
      assigneeId: t.assigneeId,
      fromStart: t.start,
      fromFinish: t.finish,
      toStart: datesAfter(t).start,
      toFinish: datesAfter(t).finish,
      delayDays: workingDaysBetween(cal, t.start, datesAfter(t).start),
      movedBy: delayedForResources.has(t.id) ? ('resources' as const) : ('dependencies' as const),
    }));
  // Writing a Start date on a task that only follows its predecessors would pin it there
  // (and turn a task with a due date but no estimate into a start-to-due window).
  const levelledStarts = Object.fromEntries(changes.filter((c) => c.movedBy === 'resources').map((c) => [c.id, c.toStart]));
  return {
    mode,
    finishBefore: schedule.finish,
    finishAfter: leaves.map((t) => datesAfter(t).finish).reduce(maxDate, schedule.finish),
    overallocatedDaysBefore: overallocatedDays(today, leaves, resources, ofOwner, (t) => t),
    overallocatedDaysAfter: overallocatedDays(today, leaves, resources, ofOwner, datesAfter),
    changes,
    unresolved: order.filter((t) => unresolved.has(t.id)).map((t) => t.id),
    levelledStarts,
    // The plan applied must be the plan proposed: if the written starts would move where it
    // begins, it keeps beginning where it did.
    keepStart: anchorWith(levelledStarts) !== anchor ? anchor : null,
  };
}

/** Earliest possible start, then priority (lower first, none last), then slack, then id. */
function byLevelingPriority(a: ScheduledTask, aEarliest: string, b: ScheduledTask, bEarliest: string): number {
  if (aEarliest !== bEarliest) return aEarliest < bEarliest ? -1 : 1;
  const pa = a.priorityOrdinal ?? Infinity;
  const pb = b.priorityOrdinal ?? Infinity;
  if (pa !== pb) return pa < pb ? -1 : 1;
  return a.slackDays - b.slackDays || compareIds(a.id, b.id);
}

/** The hours a task not yet started would put on each of its days, were it to start on `start`. */
function loadAt(model: PlanModel, a: Availability, today: string, t: ScheduledTask, start: string): Spread {
  const span = model.spanOf(t.id, start);
  return spreadOf(a, today, t, span.start, span.finish) ?? { days: [], hours: [] };
}

/**
 * The first of the resource's working days d in [earliest, latest] such that they have room,
 * on each day the task would take from d, for the hours it would put there. A task that alone
 * exceeds a day's capacity needs that day with nothing else booked.
 */
function findSlot(
  a: Availability,
  used: Map<string, number> | undefined,
  capacity: (d: string) => number,
  earliest: string,
  latest: string,
  loadFrom: (start: string) => Spread,
): string | null {
  const fits = (d: string, hours: number): boolean => {
    const booked = used?.get(d) ?? 0;
    const room = capacity(d);
    return hours > room + TOLERANCE ? booked <= TOLERANCE : booked + hours <= room + TOLERANCE;
  };
  let start = earliest;
  while (start <= latest) {
    const spread = loadFrom(start);
    const clash = spread.days.find((d, i) => !fits(d, spread.hours[i]!)) ?? null;
    if (clash === null) return start;
    start = addWorkingDays(a.cal, clash, 1); // every start up to the clash would include it
  }
  return null;
}

function book(
  booked: Bookings,
  a: Availability,
  today: string,
  t: ScheduledTask,
  resources: Map<string, PlanResource>,
  dates: Placement,
): void {
  const owner = ownerOf(t, resources);
  const spread = owner ? spreadOf(a, today, t, dates.start, dates.finish) : null;
  if (!owner || !spread) return;
  const days = booked.get(owner) ?? new Map<string, number>();
  booked.set(owner, days);
  spread.days.forEach((d, i) => days.set(d, (days.get(d) ?? 0) + spread.hours[i]!));
}

/** Resource-days over capacity, summed over resources, with each task at `datesOf(task)`. */
function overallocatedDays(
  today: string,
  leaves: readonly ScheduledTask[],
  resources: Map<string, PlanResource>,
  availabilityOf: (t: ScheduledTask) => Availability,
  datesOf: (t: ScheduledTask) => Placement,
): number {
  const booked: Bookings = new Map();
  const ofPerson = new Map<string, Availability>();
  for (const t of leaves) {
    const a = availabilityOf(t);
    const owner = ownerOf(t, resources);
    if (owner) ofPerson.set(owner, a);
    book(booked, a, today, t, resources, datesOf(t));
  }
  let count = 0;
  for (const [id, days] of booked) {
    const r = resources.get(id)!;
    const a = ofPerson.get(id)!;
    for (const [d, hours] of days) if (hours > capacityOn(r, a, d) + TOLERANCE) count++;
  }
  return count;
}
