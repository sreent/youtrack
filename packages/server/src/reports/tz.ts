/**
 * Days in a time zone. A report's day is a calendar day where its reader is: it begins at local
 * midnight in the report's time zone (an IANA name) and ends at the next. Days are found by their
 * boundaries, worked out once per report, so an event's day is a binary search, not a date format.
 */
import { badRequest } from '../lib/errors';
import { addDays } from '../lib/dates';

/** The server's own zone: what "today" means in queries, and a report's default. */
export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** The zone asked for, or the server's; a 400 with a hint when the name is unknown. */
export function timeZoneOrThrow(tz?: string | null): string {
  const zone = tz?.trim() || serverTimeZone();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw badRequest(`Unknown time zone "${tz}"`, 'Use an IANA name such as Europe/Berlin, America/New_York or UTC.').said('reports.unknownTimeZone', { zone: String(tz) });
  }
  return zone;
}

const formats = new Map<string, Intl.DateTimeFormat>();
function format(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formats.set(tz, f);
  }
  return f;
}

function fields(ms: number, tz: string): { y: number; m: number; d: number; h: number; min: number; s: number } {
  const out: Record<string, number> = {};
  for (const p of format(tz).formatToParts(new Date(ms))) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return { y: out.year!, m: out.month!, d: out.day!, h: out.hour! % 24, min: out.minute!, s: out.second! };
}

/** The calendar date (YYYY-MM-DD) an instant falls on in `tz`. */
export function localDate(ms: number, tz: string): string {
  const f = fields(ms, tz);
  return `${f.y}-${String(f.m).padStart(2, '0')}-${String(f.d).padStart(2, '0')}`;
}

/** How far `tz` is ahead of UTC at an instant, in ms. */
function offset(ms: number, tz: string): number {
  const f = fields(ms, tz);
  const asUtc = Date.UTC(f.y, f.m - 1, f.d, f.h, f.min, f.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a calendar day begins in `tz`: local midnight, or the first instant of the day
 * where a clock change skips midnight.
 */
export function startOfDay(date: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offset(guess, tz);
  const second = offset(t, tz);
  if (guess - second !== t) t = guess - second;
  // Where midnight doesn't exist, the day starts at the first hour that does.
  for (let i = 0; i < 4 && localDate(t, tz) < date; i++) t += 3_600_000;
  for (let i = 0; i < 4 && localDate(t - 1, tz) === date; i++) t -= 3_600_000;
  return t;
}

/** The instant a wall-clock time in `tz` names (the earlier one, where clocks go back). */
export function zonedTime(y: number, m: number, d: number, h: number, min: number, s: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, min, s);
  let t = guess - offset(guess, tz);
  const second = offset(t, tz);
  if (guess - second !== t) t = guess - second;
  return t;
}

/** Today's date in `tz`. */
export function todayIn(tz: string, now = Date.now()): string {
  return localDate(now, tz);
}

/**
 * The days from `from` to `to` (inclusive) with the instant each ends at, for snapshots "at the end
 * of the day". The end of day d is the start of d + 1, so an event at exactly local midnight
 * belongs to the day it begins.
 */
export interface DayBounds {
  dates: string[];
  /** Start of each day. */
  starts: number[];
  /** End of each day: the start of the next. */
  ends: number[];
}

export function dayBounds(from: string, to: string, tz: string): DayBounds {
  const dates: string[] = [];
  for (let d = from; d <= to && dates.length <= 3700; d = addDays(d, 1)) dates.push(d);
  const starts = dates.map((d) => startOfDay(d, tz));
  const ends = dates.map((d, i) => (i + 1 < dates.length ? starts[i + 1]! : startOfDay(addDays(d, 1), tz)));
  return { dates, starts, ends };
}

/** Index of the day an instant falls in, -1 before the first, dates.length after the last. */
export function dayIndex(bounds: DayBounds, ms: number): number {
  const { starts, ends } = bounds;
  if (!starts.length || ms < starts[0]!) return -1;
  if (ms >= ends[ends.length - 1]!) return starts.length;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= ms) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
