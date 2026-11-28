/**
 * Plain-data contract of the planning engine. Inputs are a snapshot of a
 * project (tasks, people, logged work, calendar, optional baseline); outputs
 * mirror the API schemas in `@a4a/shared` (ScheduleTask, Schedule,
 * ResourceLoad, LevelingResult, CostReport, Evm, WhatIfResult) but carry ids
 * instead of DTOs: `id` is a task's readable id, `assigneeId` / `resourceId`
 * a person's id. All dates are ISO calendar dates (YYYY-MM-DD).
 *
 * A plan can span projects (D73): each task is planned on its own project's
 * calendar (`PlanInput.calendars`, named by `PlanTaskInput.calendarId`), then
 * on its assignee's week and days away. A plan whose tasks name no calendar is
 * planned on `PlanInput.calendar`, exactly as before.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A project's calendar, and its money. In a plan across projects each keeps its own (D73). */
export interface PlanCalendar {
  /** Project start; null = the earliest start constraint or logged work of its tasks, else its first working day from today. */
  startDate: string | null;
  /** 0 = Sunday … 6 = Saturday. Empty (or invalid) means Monday–Friday. */
  workingDays: number[];
  hoursPerDay: number;
  holidays: string[];
  budget: number | null;
  currency: string;
}

export interface PlanResource {
  id: string;
  login: string;
  name: string;
  capacityHoursPerDay: number;
  hourlyRate: number | null;
  /**
   * Their working week (D43): hours on each weekday, Sunday first. They work the plan's working
   * days on which they have hours, those hours each. Absent or null: every working day, at capacity.
   */
  week?: readonly number[] | null;
}

export interface PlanTaskInput {
  /** Readable id, e.g. "MIG-4". */
  id: string;
  summary: string;
  /** Readable id of the parent (summary) task, if it is in the plan. */
  parent: string | null;
  assigneeId: string | null;
  /** Estimation, in minutes. */
  effortMinutes: number | null;
  /** "Start date" field: start no earlier than. */
  startConstraint: string | null;
  /** "Due date" field. */
  deadline: string | null;
  resolved: boolean;
  resolvedAt: string | null;
  /** Earliest logged work date; makes an unresolved task "in progress". */
  firstWorkDate: string | null;
  spentMinutes: number;
  /** Lower = more important. */
  priorityOrdinal: number | null;
  fixedCost: number | null;
  /** Finish-to-start predecessors; may reference ids outside the plan. */
  predecessors: string[];
  isMilestone: boolean;
  /**
   * The key in `PlanInput.calendars` of its project's calendar (D73). None, or one the plan doesn't have
   * (with a warning), is the plan's own calendar, `PlanInput.calendar`.
   */
  calendarId?: string;
}

export interface PlanWorkItem {
  taskId: string;
  authorId: string | null;
  date: string;
  minutes: number;
  /** Rate frozen on the work item; falls back to the author's current rate. */
  hourlyRate: number | null;
}

export interface PlanBaselineTask {
  id: string;
  start: string;
  finish: string;
  effortMinutes: number;
  cost: number;
}

export interface PlanBaseline {
  id: string;
  name: string;
  tasks: PlanBaselineTask[];
}

/** How much of a day someone is away: all of it, or the morning or the afternoon. */
export type AwayPart = 'day' | 'morning' | 'afternoon';

/**
 * Days a person is away (D36): whole days from `from` to `to`, or, when `half` is set, half of
 * the one day `from` is. Their work skips whole days away and does half a day's on a half day.
 */
export interface PlanAbsence {
  resourceId: string;
  from: string;
  to: string;
  half: 'morning' | 'afternoon' | null;
}

export interface PlanInput {
  /** The status date. The engine never reads the clock. */
  today: string;
  /**
   * The plan's own calendar: of each task that names none, of a plan that holds no task, and the currency
   * a plan's costs are totalled in when its calendars have several (D73).
   */
  calendar: PlanCalendar;
  /**
   * The calendars of the plan's projects, by the key their tasks name (D73). Given, results also say what
   * they say per calendar: levelling's `keepStarts`, the cost report's `byCalendar` and `byCurrency`. Where
   * those name the plan's own calendar, its key is `PLAN_CALENDAR_KEY` (the empty string).
   */
  calendars?: Record<string, PlanCalendar>;
  tasks: PlanTaskInput[];
  resources: PlanResource[];
  workItems: PlanWorkItem[];
  baseline?: PlanBaseline | null;
  /** People's days away. Without any, everyone works on their tasks' calendars. */
  absences?: PlanAbsence[];
}

/** A what-if change to one task; nothing is saved. */
export interface PlanOverride {
  id: string;
  /** Push the start by N working days (on a summary: its first subtasks). */
  delayDays?: number;
  effortMinutes?: number;
  assigneeId?: string | null;
  /** Replaces the task's start constraint. */
  start?: string;
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

/** Mirrors `LEVELING_MODES` in `@a4a/shared`. */
export type LevelingMode = 'within_slack' | 'allow_delay';

/**
 * Why a task starts when it does: logged work or resolution (`actual`), a start
 * date plus due date with no estimate (`fixed`), its start date (`start`), its
 * predecessors (`dependencies`), or the project start / today (`project_start`).
 */
export type ScheduledFrom = 'actual' | 'fixed' | 'start' | 'dependencies' | 'project_start';

export interface TaskBaseline {
  start: string;
  finish: string;
  effortMinutes: number;
  cost: number;
}

/** Current minus baseline; dates in signed working days. */
export interface TaskVariance {
  startDays: number;
  finishDays: number;
  effortMinutes: number;
  cost: number;
}

/**
 * Working-day figures (duration, slack, variance) count the task's own days: its calendar's, and for work
 * someone does, theirs (D36, D43, D73).
 */
export interface ScheduledTask {
  id: string;
  summary: string;
  parent: string | null;
  depth: number;
  isSummary: boolean;
  isMilestone: boolean;
  /** For a summary: all of its subtasks are resolved. */
  resolved: boolean;
  assigneeId: string | null;
  priorityOrdinal: number | null;
  start: string;
  finish: string;
  /** Working days. */
  durationDays: number;
  effortMinutes: number;
  spentMinutes: number;
  /** Work still to do: max(effort − spent, 0); 0 when resolved. */
  remainingMinutes: number;
  percentComplete: number;
  earlyStart: string;
  earlyFinish: string;
  lateStart: string;
  lateFinish: string;
  /** Working days; negative when a due date cannot be met. */
  slackDays: number;
  critical: boolean;
  deadline: string | null;
  late: boolean;
  scheduledFrom: ScheduledFrom;
  /** In-plan predecessors only. */
  predecessors: string[];
  plannedCost: number;
  actualCost: number;
  baseline: TaskBaseline | null;
  variance: TaskVariance | null;
}

export interface ScheduleBaselineSummary {
  id: string;
  name: string;
  finish: string;
  finishVarianceDays: number;
}

/** Plan-level day counts (a baseline's finish variance) are on the plan's union calendar: any of its calendars' working days (D73). */
export interface ScheduleResult {
  start: string;
  finish: string;
  today: string;
  /** Parent first, depth first; siblings by start, then id. */
  tasks: ScheduledTask[];
  /** Critical leaf tasks by early start. */
  criticalPath: string[];
  warnings: string[];
  baseline: ScheduleBaselineSummary | null;
}

export interface WhatIfImpact {
  id: string;
  summary: string;
  startDeltaDays: number;
  finishDeltaDays: number;
}

export interface WhatIfAnalysis {
  before: { finish: string; criticalPath: string[] };
  after: ScheduleResult;
  /** Signed working days of the plan's union calendar (D73); each impacted task's, of its own calendar. */
  finishDeltaDays: number;
  impacted: WhatIfImpact[];
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface ResourceLoadDay {
  date: string;
  hours: number;
  /** Hours they can work that day: their capacity, half of it on a half day away, 0 on a day away. */
  capacity: number;
  /** Whether they're away that day, and for which part of it. */
  away: AwayPart | null;
  tasks: { issue: string; hours: number }[];
}

export interface ResourceLoadRow {
  resourceId: string;
  capacityHoursPerDay: number;
  totalHours: number;
  overallocatedDays: number;
  peakLoadPct: number;
  days: ResourceLoadDay[];
}

export interface ResourceLoadResult {
  from: string;
  to: string;
  resources: ResourceLoadRow[];
  unassignedHours: number;
}

export interface LevelingChange {
  id: string;
  summary: string;
  assigneeId: string | null;
  fromStart: string;
  fromFinish: string;
  toStart: string;
  toFinish: string;
  /** Working days of its own calendar. */
  delayDays: number;
  /**
   * `resources`: delayed to find room for its assignee; `dependencies`: it only
   * follows predecessors that moved, so it needs no Start date of its own.
   */
  movedBy: 'resources' | 'dependencies';
}

export interface LevelingProposal {
  mode: LevelingMode;
  finishBefore: string;
  finishAfter: string;
  overallocatedDaysBefore: number;
  overallocatedDaysAfter: number;
  changes: LevelingChange[];
  /** Tasks that could not be levelled within the chosen mode. */
  unresolved: string[];
  /**
   * The Start dates to write to apply the proposal: one per task delayed for
   * resources (`movedBy: 'resources'`). The rest follow their predecessors.
   * Passed as `start` overrides, they reproduce the levelled schedule.
   */
  levelledStarts: Record<string, string>;
  /**
   * For a plan with no start date of its own, which begins at its earliest Start date: written,
   * the levelled starts would become that earliest date, and everything else would move to it.
   * Then this is where the plan began, to keep as its start date; otherwise null. A plan of several
   * calendars has no one start: each calendar keeps its own, in `keepStarts`, and this is null (D73).
   */
  keepStart: string | null;
  /** With `PlanInput.calendars`: `keepStart` for each calendar whose start would move, by its key (D73). */
  keepStarts?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Costs
// ---------------------------------------------------------------------------

export interface TaskCostRow {
  id: string;
  summary: string;
  assigneeId: string | null;
  plannedCost: number;
  actualCost: number;
  fixedCost: number;
  effortMinutes: number;
  spentMinutes: number;
  resolved: boolean;
}

/** Money in the report's `currency`; hours are all their hours. */
export interface PersonCostRow {
  resourceId: string;
  hourlyRate: number | null;
  plannedHours: number;
  actualHours: number;
  plannedCost: number;
  actualCost: number;
  /** With `PlanInput.calendars`: their cost in each currency their work is in, never converted (D73). */
  byCurrency?: PersonCurrencyCost[];
}

export interface PersonCurrencyCost {
  currency: string;
  plannedCost: number;
  actualCost: number;
}

export interface EvmResult {
  asOf: string;
  bac: number;
  pv: number;
  ev: number;
  ac: number;
  cv: number;
  sv: number;
  cpi: number | null;
  spi: number | null;
  eac: number | null;
  etc: number | null;
  vac: number | null;
}

/** One calendar's budget and money, in its own currency (D73). */
export interface CalendarCostRow {
  /** Its key in `PlanInput.calendars`; `PLAN_CALENDAR_KEY` for the plan's own. */
  calendarId: string;
  currency: string;
  budget: number | null;
  plannedCost: number;
  actualCost: number;
  forecastCost: number;
  budgetVariance: number | null;
}

/** The plan's money in one currency, never converted (D73). Budgets are per calendar only. */
export interface CurrencyCostRow {
  currency: string;
  plannedCost: number;
  actualCost: number;
  forecastCost: number;
  evm: EvmResult | null;
}

/**
 * A plan of one calendar has its budget and currency. A plan of several (D73) has no budget of its own
 * (`budget` and `budgetVariance` are null; each calendar's is in `byCalendar`), and when they use several
 * currencies, every figure here but a task's is in `currency`, the plan's own calendar's: the others are in
 * `byCurrency`, and a warning says so. A task's money is in its own calendar's currency.
 */
export interface CostResult {
  currency: string;
  budget: number | null;
  plannedCost: number;
  actualCost: number;
  forecastCost: number;
  budgetVariance: number | null;
  byTask: TaskCostRow[];
  byPerson: PersonCostRow[];
  evm: EvmResult | null;
  warnings: string[];
  /** With `PlanInput.calendars`: each calendar in use, by key order. */
  byCalendar?: CalendarCostRow[];
  /** With `PlanInput.calendars`: each currency in use, alphabetically. */
  byCurrency?: CurrencyCostRow[];
}
