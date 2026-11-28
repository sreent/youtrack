/**
 * The planning engine: pure functions from a plan snapshot (PlanInput) to a
 * schedule, resource load, a levelling proposal and a cost report. No I/O, no
 * clock: `today` is part of the input.
 */
export {
  addWorkingDays,
  isWorkingDay,
  listWorkingDays,
  nextWorkingDay,
  normalizeCalendar,
  prevWorkingDay,
  workingDaysBetween,
  workingDaysInclusive,
} from './calendar';
export { computeCosts } from './costs';
export { PLAN_CALENDAR_KEY, planCalendars, type PlanCalendars } from './plan-calendars';
export { computeLoad, levelResources } from './resources';
export { computeSchedule, isAwayWarning, whatIf } from './schedule';
export type * from './types';
