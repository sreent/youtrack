/**
 * People's days away (docs/architecture.md, D36), as the engine works with them. Each person
 * works on the plan's calendar with their whole days away taken out, and on a half day away
 * gives half their hours; someone with a working week of their own (D43) works the plan's days on
 * which they have hours, and those hours. Someone with neither works on the plan's calendar itself,
 * the same object, so a plan without any is scheduled exactly as it was before there were absences.
 */
import { addDays, isISODate, maxDate, minDate } from '../lib/dates';
import { addWorkingDays, normalizeCalendar } from './calendar';
import type { AwayPart, PlanAbsence, PlanCalendar, PlanResource } from './types';
import { ceilSafe } from './util';

/** Days away the engine looks at around today: a year back, and five ahead. */
export const AWAY_LOOK_BACK_DAYS = 366;
export const AWAY_LOOK_AHEAD_DAYS = 5 * 366;

export interface Availability {
  /** The days they can work: the plan's calendar, their whole days away taken out. */
  cal: PlanCalendar;
  /** Whether they're away on a date, and for which part of it. */
  away(date: string): AwayPart | null;
  /** The share of a working day they give: 1, ½ on a half day away, times their working week's share of their capacity (D43). */
  share(date: string): number;
  /** False when they're never away and work the plan's week: then `cal` is the plan's own calendar. */
  hasAbsences: boolean;
}

/** Someone who is never away, on the plan's calendar. */
export function everyone(cal: PlanCalendar): Availability {
  return { cal, away: () => null, share: () => 1, hasAbsences: false };
}

/** Days of the week as the engine counts them (0 = Sunday). */
function dayOfWeek(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

/**
 * Someone's own working week (D43), as the engine uses it: the plan's working days on which they
 * have hours, and what share of their capacity each weekday is. Null when they have none, or one
 * that changes nothing (every working day, at their capacity), or one with no working day in it.
 */
export function ownWeek(cal: PlanCalendar, r: Pick<PlanResource, 'week' | 'capacityHoursPerDay'>): { workingDays: number[]; ratio: number[] } | null {
  const week = r.week;
  if (!week || week.length !== 7 || week.some((h) => typeof h !== 'number' || !Number.isFinite(h) || h < 0)) return null;
  const workingDays = cal.workingDays.filter((d) => (week[d] ?? 0) > 0);
  if (!workingDays.length) return null;
  const capacity = Number.isFinite(r.capacityHoursPerDay) && r.capacityHoursPerDay > 0 ? r.capacityHoursPerDay : 0;
  const ratio = week.map((h) => (capacity > 0 ? h / capacity : h > 0 ? 1 : 0));
  const same = workingDays.length === cal.workingDays.length && workingDays.every((d) => Math.abs(ratio[d]! - 1) < 1e-9);
  return same ? null : { workingDays, ratio };
}

/**
 * Each person's availability, from the plan's (normalised) calendar, their days away and their own
 * working week (D43). People with neither, and work with nobody to do it, get the plan's calendar.
 */
export function availabilities(
  cal: PlanCalendar,
  absences: readonly PlanAbsence[] | undefined,
  today: string,
  resources: readonly PlanResource[] = [],
): (resourceId: string | null) => Availability {
  const plain = everyone(cal);
  const weeks = new Map<string, NonNullable<ReturnType<typeof ownWeek>>>();
  for (const r of resources) {
    const w = weeks.has(r.id) ? null : ownWeek(cal, r);
    if (w) weeks.set(r.id, w);
  }
  if (!absences?.length && !weeks.size) return () => plain;
  const first = addDays(today, -AWAY_LOOK_BACK_DAYS);
  const last = addDays(today, AWAY_LOOK_AHEAD_DAYS);
  const byPerson = new Map<string, Map<string, AwayPart>>();
  for (const a of absences ?? []) {
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
    const week = weeks.get(resourceId);
    let a = plain;
    if (days?.size || week) {
      const whole = days ? [...days].filter(([, part]) => part === 'day').map(([d]) => d) : [];
      const own =
        whole.length || week ? normalizeCalendar({ ...cal, workingDays: week?.workingDays ?? cal.workingDays, holidays: [...cal.holidays, ...whole] }) : cal;
      a = {
        cal: own,
        away: (d) => days?.get(d) ?? null,
        share: (d) => {
          const part = days?.get(d);
          const there = part === undefined ? 1 : part === 'day' ? 0 : 0.5;
          return week ? there * week.ratio[dayOfWeek(d)]! : there;
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
