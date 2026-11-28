/**
 * Working-day arithmetic over ISO date strings. A working day is a weekday
 * listed in `workingDays` that is not a holiday. Calendars are treated as
 * immutable: lookups are memoised per calendar object.
 */
import { addDays, diffDays, isISODate, weekday } from '../lib/dates';
import type { PlanCalendar } from './types';

/** Upper bound for any day-by-day walk (about 55 years). */
export const MAX_CALENDAR_STEPS = 20_000;

/** Same as DEFAULT_HOURS_PER_DAY in `@a4a/shared` (kept local: the engine has no runtime deps). */
const DEFAULT_HOURS_PER_DAY = 8;
const MONDAY_TO_FRIDAY = [1, 2, 3, 4, 5];
const MEMO_LIMIT = 100_000;

interface CalendarIndex {
  workingDays: ReadonlySet<number>;
  holidays: ReadonlySet<string>;
  /** Holidays on working weekdays, sorted: the only ones that change a count. */
  workingHolidays: readonly string[];
  perWeek: number;
  /** First working day strictly after / before a date. */
  after: Map<string, string>;
  before: Map<string, string>;
  sourceDays: readonly number[];
  sourceHolidays: readonly string[];
  sourceLengths: string;
  source: PlanCalendar;
}

const indexes = new WeakMap<PlanCalendar, CalendarIndex>();
/** What a plan of several calendars calls each (D73), so an error can say which to check. */
const names = new WeakMap<PlanCalendar, string>();

/** Names a calendar for the errors working-day arithmetic throws on it. */
export function nameCalendar(cal: PlanCalendar, name: string): void {
  names.set(cal, name);
}

function validWorkingDays(days: readonly number[]): number[] {
  const valid = [...new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
  return valid.length > 0 ? valid : [...MONDAY_TO_FRIDAY];
}

/**
 * A copy of `cal` with safe values: Monday–Friday when no valid working day
 * is set, an 8-hour day when `hoursPerDay` is not positive, valid holidays only.
 */
export function normalizeCalendar(cal: PlanCalendar): PlanCalendar {
  return {
    startDate: cal.startDate && isISODate(cal.startDate) ? cal.startDate : null,
    workingDays: validWorkingDays(cal.workingDays),
    hoursPerDay: Number.isFinite(cal.hoursPerDay) && cal.hoursPerDay > 0 ? cal.hoursPerDay : DEFAULT_HOURS_PER_DAY,
    holidays: [...new Set(cal.holidays.filter(isISODate))].sort(),
    budget: typeof cal.budget === 'number' && Number.isFinite(cal.budget) ? cal.budget : null,
    currency: cal.currency,
  };
}

function lengthsOf(cal: PlanCalendar): string {
  return `${cal.workingDays.length}/${cal.holidays.length}`;
}

function buildIndex(cal: PlanCalendar): CalendarIndex {
  const workingDays = new Set(validWorkingDays(cal.workingDays));
  const holidays = new Set(cal.holidays.filter(isISODate));
  return {
    workingDays,
    holidays,
    workingHolidays: [...holidays].filter((h) => workingDays.has(weekday(h))).sort(),
    perWeek: workingDays.size,
    after: new Map(),
    before: new Map(),
    sourceDays: cal.workingDays,
    sourceHolidays: cal.holidays,
    sourceLengths: lengthsOf(cal),
    source: cal,
  };
}

function indexOf(cal: PlanCalendar): CalendarIndex {
  const cached = indexes.get(cal);
  if (
    cached &&
    cached.sourceDays === cal.workingDays &&
    cached.sourceHolidays === cal.holidays &&
    cached.sourceLengths === lengthsOf(cal)
  ) {
    return cached;
  }
  const built = buildIndex(cal);
  indexes.set(cal, built);
  return built;
}

function works(idx: CalendarIndex, d: string): boolean {
  return idx.workingDays.has(weekday(d)) && !idx.holidays.has(d);
}

/** The first working day strictly after (`dir` 1) or before (`dir` -1) `d`. */
function step(idx: CalendarIndex, d: string, dir: 1 | -1): string {
  const memo = dir === 1 ? idx.after : idx.before;
  const hit = memo.get(d);
  if (hit) return hit;
  let cur = d;
  for (let i = 0; i < MAX_CALENDAR_STEPS; i++) {
    cur = addDays(cur, dir);
    if (works(idx, cur)) {
      if (memo.size >= MEMO_LIMIT) memo.clear();
      memo.set(d, cur);
      return cur;
    }
  }
  const name = names.get(idx.source);
  throw new Error(
    `No working day within ${MAX_CALENDAR_STEPS} days ${dir === 1 ? 'after' : 'before'} ${d}: ` +
      `check ${name ? `the calendar ${name}` : 'the plan calendar'} (working days and holidays)`,
  );
}

/** Number of sorted `items` in [from, to]. */
function countInRange(items: readonly string[], from: string, to: string): number {
  const lower = (x: string, inclusive: boolean): number => {
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (inclusive ? items[mid]! < x : items[mid]! <= x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return lower(to, false) - lower(from, true);
}

/** Weekday listed in `workingDays` and not a holiday. */
export function isWorkingDay(cal: PlanCalendar, d: string): boolean {
  return works(indexOf(cal), d);
}

/** `d` itself if it is a working day, else the next one. */
export function nextWorkingDay(cal: PlanCalendar, d: string): string {
  const idx = indexOf(cal);
  return works(idx, d) ? d : step(idx, d, 1);
}

/** `d` itself if it is a working day, else the previous one. */
export function prevWorkingDay(cal: PlanCalendar, d: string): string {
  const idx = indexOf(cal);
  return works(idx, d) ? d : step(idx, d, -1);
}

/**
 * The working day `n` working days after `d` (before, when `n` is negative).
 * `n` = 0 returns `d` (or the next working day if `d` is not one). From a
 * non-working day, +1 is the next working day and -1 the previous one.
 */
export function addWorkingDays(cal: PlanCalendar, d: string, n: number): string {
  const count = Math.trunc(n);
  if (count === 0) return nextWorkingDay(cal, d);
  if (Math.abs(count) > MAX_CALENDAR_STEPS) {
    throw new Error(`Cannot move ${count} working days from ${d}: the limit is ${MAX_CALENDAR_STEPS}`);
  }
  const idx = indexOf(cal);
  const dir = count > 0 ? 1 : -1;
  let cur = d;
  for (let i = 0; i < Math.abs(count); i++) cur = step(idx, cur, dir);
  return cur;
}

/** Working days in [a, b]; 0 when b is before a. */
export function workingDaysInclusive(cal: PlanCalendar, a: string, b: string): number {
  if (b < a) return 0;
  const idx = indexOf(cal);
  const total = diffDays(a, b) + 1;
  const weeks = Math.floor(total / 7);
  let count = weeks * idx.perWeek;
  const first = weekday(a);
  for (let k = 0; k < total % 7; k++) if (idx.workingDays.has((first + k) % 7)) count++;
  return count - countInRange(idx.workingHolidays, a, b);
}

/**
 * Signed working days from a to b, exclusive of a and inclusive of b: the
 * count in (a, b] when b is later, minus the count in [b, a) when b is
 * earlier, 0 when equal. For working days, addWorkingDays(a, result) = b.
 */
export function workingDaysBetween(cal: PlanCalendar, a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? workingDaysInclusive(cal, addDays(a, 1), b) : -workingDaysInclusive(cal, b, addDays(a, -1));
}

/** The working days in [from, to], in order. */
export function listWorkingDays(cal: PlanCalendar, from: string, to: string): string[] {
  const days: string[] = [];
  if (to < from) return days;
  const idx = indexOf(cal);
  let d = nextWorkingDay(cal, from);
  while (d <= to) {
    if (days.length >= MAX_CALENDAR_STEPS) {
      throw new Error(`More than ${MAX_CALENDAR_STEPS} working days between ${from} and ${to}`);
    }
    days.push(d);
    d = step(idx, d, 1);
  }
  return days;
}
