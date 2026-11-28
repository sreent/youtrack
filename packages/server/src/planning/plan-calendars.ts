/**
 * A plan's calendars (D73). A plan can hold several projects' issues, and each is planned on its own
 * project's calendar: its working days, hours a day, holidays and start, and its budget and currency.
 * Numbers of the whole plan (its finish, a what-if's delta in days, a baseline's finish variance) count the
 * days of a union calendar instead, on which a day works if any of the plan's calendars works it.
 *
 * A plan whose tasks are all on one calendar has that calendar, normalised once, as its union too: it is
 * counted exactly as the engine always counted it.
 */
import { weekday } from '../lib/dates';
import { nameCalendar, normalizeCalendar } from './calendar';
import type { PlanCalendar, PlanInput, PlanTaskInput } from './types';
import { compareIds } from './util';

/** The key that names the plan's own calendar (`PlanInput.calendar`) where results say per calendar. */
export const PLAN_CALENDAR_KEY = '';

export interface PlanCalendars {
  /** The input names calendars of its own (`PlanInput.calendars`): results then also say per calendar. */
  keyed: boolean;
  /** The keys of the calendars its tasks are on, the plan's own first, then in natural order. A plan with no task has the plan's own. */
  keys: readonly string[];
  /** Each of those calendars, normalised. */
  byKey: ReadonlyMap<string, PlanCalendar>;
  /** Its tasks are on more than one calendar. */
  several: boolean;
  /** The days any of its calendars works, for numbers of the whole plan. With one calendar, that calendar. */
  union: PlanCalendar;
  /** The key of a task's calendar; the plan's own for a task it doesn't know. */
  keyOf(taskId: string): string;
  /** A task's calendar, normalised. */
  of(taskId: string): PlanCalendar;
}

const byKeyOrder = (a: string, b: string): number => (a === b ? 0 : a === PLAN_CALENDAR_KEY ? -1 : b === PLAN_CALENDAR_KEY ? 1 : compareIds(a, b));

/**
 * The calendars of `tasks` (the plan's, sanitised: the first of a duplicated id counts). A task naming a
 * calendar the plan doesn't have is planned on the plan's own, and `warn` says so, naming it.
 */
export function planCalendars(input: PlanInput, tasks: readonly PlanTaskInput[] = input.tasks, warn?: (message: string) => void): PlanCalendars {
  const given = input.calendars && typeof input.calendars === 'object' ? input.calendars : null;
  const keyOfTask = new Map<string, string>();
  for (const t of tasks) {
    if (keyOfTask.has(t.id)) continue;
    const id = t.calendarId;
    let key = PLAN_CALENDAR_KEY;
    if (typeof id === 'string' && id !== PLAN_CALENDAR_KEY) {
      if (given && Object.hasOwn(given, id) && given[id]) key = id;
      else warn?.(`${t.id} is on the calendar ${id}, which this plan doesn’t have; planned on the plan’s own calendar`);
    }
    keyOfTask.set(t.id, key);
  }
  const used = [...new Set(keyOfTask.values())].sort(byKeyOrder);
  const keys = used.length > 0 ? used : [PLAN_CALENDAR_KEY];
  const byKey = new Map(keys.map((k) => [k, normalizeCalendar(k === PLAN_CALENDAR_KEY ? input.calendar : given![k]!)]));
  // An error about a calendar's days names the one to check.
  for (const [k, cal] of byKey) if (k !== PLAN_CALENDAR_KEY) nameCalendar(cal, k);
  const own = byKey.get(PLAN_CALENDAR_KEY) ?? normalizeCalendar(input.calendar);
  const several = keys.length > 1;
  const union = several ? unionOf([...byKey.values()], own) : byKey.get(keys[0]!)!;
  const keyOf = (taskId: string): string => keyOfTask.get(taskId) ?? PLAN_CALENDAR_KEY;
  return {
    keyed: given !== null,
    keys,
    byKey,
    several,
    union,
    keyOf,
    of: (taskId) => byKey.get(keyOf(taskId)) ?? own,
  };
}

/**
 * The calendar on which a day works if any of `cals` works it: their weekdays together, less the days that
 * are a holiday in every calendar working that weekday. It is for counting days: its hours and currency are
 * the plan's own calendar's, and it has no start or budget.
 */
function unionOf(cals: readonly PlanCalendar[], own: PlanCalendar): PlanCalendar {
  const workingDays = [...new Set(cals.flatMap((c) => c.workingDays))].sort((a, b) => a - b);
  const each = cals.map((c) => ({ days: new Set(c.workingDays), holidays: new Set(c.holidays) }));
  const holidays = [...new Set(cals.flatMap((c) => c.holidays))].filter((d) => each.every((c) => !c.days.has(weekday(d)) || c.holidays.has(d))).sort();
  return normalizeCalendar({ startDate: null, workingDays, hoursPerDay: own.hoursPerDay, holidays, budget: null, currency: own.currency });
}
