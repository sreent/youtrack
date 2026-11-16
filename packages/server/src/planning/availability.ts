/**
 * People's days away (docs/architecture.md, D36), as the engine works with them. Each person
 * works on the plan's calendar with their whole days away taken out, and on a half day away
 * gives half their hours. Someone with no days away works on the plan's calendar itself, the
 * same object, so a plan without any is scheduled exactly as it was before there were absences.
 */
import { addDays, isISODate, maxDate, minDate } from '../lib/dates';
import { addWorkingDays, normalizeCalendar } from './calendar';
import type { AwayPart, PlanAbsence, PlanCalendar } from './types';
import { ceilSafe } from './util';

/** Days away the engine looks at around today: a year back, and five ahead. */
export const AWAY_LOOK_BACK_DAYS = 366;
export const AWAY_LOOK_AHEAD_DAYS = 5 * 366;

export interface Availability {
  /** The days they can work: the plan's calendar, their whole days away taken out. */
  cal: PlanCalendar;
  /** Whether they're away on a date, and for which part of it. */
  away(date: string): AwayPart | null;
  /** The share of a working day they're there: 1, or ½ on a half day away. */
  share(date: string): number;
  /** False when they're never away: then `cal` is the plan's own calendar. */
  hasAbsences: boolean;
}

/** Someone who is never away, on the plan's calendar. */
export function everyone(cal: PlanCalendar): Availability {
  return { cal, away: () => null, share: () => 1, hasAbsences: false };
}

/**
 * Each person's availability, from the plan's (normalised) calendar and their days away. People
 * without days away, and work with nobody to do it, get the plan's calendar.
 */
export function availabilities(
  cal: PlanCalendar,
  absences: readonly PlanAbsence[] | undefined,
  today: string,
): (resourceId: string | null) => Availability {
  const plain = everyone(cal);
  if (!absences?.length) return () => plain;
  const first = addDays(today, -AWAY_LOOK_BACK_DAYS);
  const last = addDays(today, AWAY_LOOK_AHEAD_DAYS);
  const byPerson = new Map<string, Map<string, AwayPart>>();
  for (const a of absences) {
    if (!isISODate(a.from) || !isISODate(a.to) || a.to < a.from) continue;
    const days = byPerson.get(a.resourceId) ?? new Map<string, AwayPart>();
    byPerson.set(a.resourceId, days);
    if (a.half) {
      // A half day is one day; its morning and its afternoon together are the whole of it.
      if (a.from < first || a.from > last) continue;
      const had = days.get(a.from);
      days.set(a.from, had === 'day' || (had && had !== a.half) ? 'day' : a.half);
      continue;
    }
    for (let d = maxDate(a.from, first), end = minDate(a.to, last); d <= end; d = addDays(d, 1)) days.set(d, 'day');
  }
  const built = new Map<string, Availability>();
  return (resourceId) => {
    if (resourceId === null) return plain;
    const done = built.get(resourceId);
    if (done) return done;
    const days = byPerson.get(resourceId);
    let a = plain;
    if (days?.size) {
      const whole = [...days].filter(([, part]) => part === 'day').map(([d]) => d);
      a = {
        cal: whole.length ? normalizeCalendar({ ...cal, holidays: [...cal.holidays, ...whole] }) : cal,
        away: (d) => days.get(d) ?? null,
        share: (d) => {
          const part = days.get(d);
          return part === undefined ? 1 : part === 'day' ? 0 : 0.5;
        },
        hasAbsences: true,
      };
    }
    built.set(resourceId, a);
    return a;
  };
}

/**
 * The last day of work of `hours`, at `daily` hours a day, begun on `start` (one of their working
 * days): each day gives `daily` times their share of it. Someone never away needs
 * ceil(hours ÷ daily) working days, as the engine has always counted. At most `maxDays`.
 */
export function spanFrom(a: Availability, start: string, hours: number, daily: number, maxDays: number): { finish: string; days: number } {
  if (!a.hasAbsences || hours <= 0 || daily <= 0) {
    const days = Math.min(maxDays, Math.max(1, ceilSafe(hours / (daily > 0 ? daily : 1))));
    return { finish: addWorkingDays(a.cal, start, days - 1), days };
  }
  let left = hours;
  let d = start;
  for (let days = 1; ; days++) {
    left -= daily * a.share(d);
    if (left <= 1e-9 || days >= maxDays) return { finish: d, days };
    d = addWorkingDays(a.cal, d, 1);
  }
}
