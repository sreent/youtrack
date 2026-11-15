/**
 * Shared fixtures for the planning tests. The calendar is Monday–Friday with
 * 8-hour days and one holiday, Thursday 19 November 2026; "today" is Monday
 * 16 November 2026. Working days from today:
 *
 *   Mon 16, Tue 17, Wed 18, (Thu 19 off), Fri 20, Mon 23, Tue 24, Wed 25, …
 */
import type {
  PlanCalendar,
  PlanInput,
  PlanResource,
  PlanTaskInput,
  ScheduledTask,
  ScheduleResult,
} from '../../src/planning';

export const TODAY = '2026-11-16';
export const HOLIDAY = '2026-11-19';

export function calendar(fields: Partial<PlanCalendar> = {}): PlanCalendar {
  return {
    startDate: null,
    workingDays: [1, 2, 3, 4, 5],
    hoursPerDay: 8,
    holidays: [HOLIDAY],
    budget: null,
    currency: 'EUR',
    ...fields,
  };
}

export const anna: PlanResource = { id: 'u-anna', login: 'anna', name: 'Anna Schmidt', capacityHoursPerDay: 8, hourlyRate: 100 };
export const ben: PlanResource = { id: 'u-ben', login: 'ben', name: 'Ben Okafor', capacityHoursPerDay: 8, hourlyRate: 80 };

/** Minutes in `h` hours. */
export const hours = (h: number): number => h * 60;

export function task(id: string, fields: Partial<PlanTaskInput> = {}): PlanTaskInput {
  return {
    id,
    summary: `Task ${id}`,
    parent: null,
    assigneeId: null,
    effortMinutes: null,
    startConstraint: null,
    deadline: null,
    resolved: false,
    resolvedAt: null,
    firstWorkDate: null,
    spentMinutes: 0,
    priorityOrdinal: null,
    fixedCost: null,
    predecessors: [],
    isMilestone: false,
    ...fields,
  };
}

export function plan(tasks: PlanTaskInput[], fields: Partial<PlanInput> = {}): PlanInput {
  return { today: TODAY, calendar: calendar(), tasks, resources: [anna, ben], workItems: [], baseline: null, ...fields };
}

/** The scheduled task with this id (throws if it is missing). */
export function get(schedule: ScheduleResult, id: string): ScheduledTask {
  const t = schedule.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`${id} is not in the schedule`);
  return t;
}

/** Start and finish of a task, for compact assertions. */
export function span(schedule: ScheduleResult, id: string): [string, string] {
  const t = get(schedule, id);
  return [t.start, t.finish];
}
