/**
 * Business time (D45): how much of a desk's working time lies between two instants, and the instant
 * a span of it runs out.
 *
 * A desk's hours are wall-clock times in its time zone, per day of the week, with holidays off. They
 * are worked out day by day as instants, so a day on which clocks change runs the hours its wall
 * clock shows: a desk open round the clock has 23 hours that day, or 25. A desk without hours counts
 * every hour, as targets did before (D24).
 */
import type { BusinessHours } from '@a4a/shared';
import { badRequest } from '../lib/errors';
import { addDays } from '../lib/dates';
import { localDate, startOfDay, timeZoneOrThrow, zonedTime } from '../reports/tz';

export interface Calendar {
  timeZone: string;
  /** For each day of the week (0 = Sunday), its hours as minutes of the day, in order, not overlapping. */
  byDay: [number, number][][];
  holidays: Set<string>;
}

/** No target is ever this far off: past it, a calendar with no hours would loop. */
const MAX_DAYS = 3_700;

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/** A desk's hours as a calendar; null for none, which counts every hour. A 400 says what's wrong with them. */
export function calendarOf(hours: BusinessHours | null | undefined): Calendar | null {
  if (!hours) return null;
  const timeZone = timeZoneOrThrow(hours.timeZone);
  const byDay: [number, number][][] = [[], [], [], [], [], [], []];
  for (const h of hours.hours) {
    const from = minutes(h.from);
    const to = minutes(h.to);
    if (to <= from) throw badRequest(`Working hours end after they start: ${h.from}–${h.to} doesn't`, 'For hours past midnight, give two spans: one to 24:00 and one from 00:00 the next day.').said('helpdesk.hoursBackwards', { from: h.from, to: h.to });
    byDay[h.day]!.push([from, to]);
  }
  for (const [day, spans] of byDay.entries()) {
    spans.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) {
      if (spans[i]![0] < spans[i - 1]![1]) {
        const name = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day];
        throw badRequest(`${name}'s working hours overlap`, 'Give each part of the day once.').said('helpdesk.hoursOverlap', { day: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][day]! });
      }
    }
  }
  if (!byDay.some((d) => d.length)) throw badRequest('Working hours need at least one day', 'Add the hours the team works, such as Monday 09:00–17:00.').said('helpdesk.hoursNeedDay');
  return { timeZone, byDay, holidays: new Set(hours.holidays) };
}

function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** The working spans of one local day, as instants: none on a holiday. */
function spansOn(date: string, cal: Calendar): [number, number][] {
  if (cal.holidays.has(date)) return [];
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const at = (min: number): number =>
    min === 0 ? startOfDay(date, cal.timeZone) : min === 1440 ? startOfDay(addDays(date, 1), cal.timeZone) : zonedTime(y, m, d, Math.floor(min / 60), min % 60, 0, cal.timeZone);
  return (cal.byDay[weekday(date)] ?? []).map(([from, to]) => [at(from), at(to)] as [number, number]).filter(([a, b]) => b > a);
}

/** The working time, in ms, between two instants. */
export function businessMsBetween(from: number, to: number, cal: Calendar | null): number {
  if (to <= from) return 0;
  if (!cal) return to - from;
  let total = 0;
  const last = localDate(to, cal.timeZone);
  for (let date = localDate(from, cal.timeZone), i = 0; date <= last && i < MAX_DAYS; date = addDays(date, 1), i++) {
    for (const [a, b] of spansOn(date, cal)) total += Math.max(0, Math.min(b, to) - Math.max(a, from));
  }
  return total;
}

/** The instant `ms` of working time from `start` runs out; `start` itself for none. */
export function addBusinessMs(start: number, ms: number, cal: Calendar | null): number {
  if (ms <= 0) return start;
  if (!cal) return start + ms;
  let left = ms;
  for (let date = localDate(start, cal.timeZone), i = 0; i < MAX_DAYS; date = addDays(date, 1), i++) {
    for (const [a, b] of spansOn(date, cal)) {
      const from = Math.max(a, start);
      if (b <= from) continue;
      if (b - from >= left) return from + left;
      left -= b - from;
    }
  }
  throw new Error('No working hours within ten years');
}
