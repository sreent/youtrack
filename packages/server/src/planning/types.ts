/**
 * Plain-data contract of the planning engine. Inputs are a snapshot of a
 * project (tasks, people, logged work, calendar, optional baseline); outputs
 * mirror the API schemas in `@a4a/shared` (ScheduleTask, Schedule,
 * ResourceLoad, LevelingResult, CostReport, Evm, WhatIfResult) but carry ids
 * instead of DTOs: `id` is a task's readable id, `assigneeId` / `resourceId`
 * a person's id. All dates are ISO calendar dates (YYYY-MM-DD).
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface PlanCalendar {
  /** Project start; null = the earliest start constraint or logged work, else today. */
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

export interface PlanInput {
  /** The status date. The engine never reads the clock. */
  today: string;
  calendar: PlanCalendar;
  tasks: PlanTaskInput[];
  resources: PlanResource[];
  workItems: PlanWorkItem[];
  baseline?: PlanBaseline | null;
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
  /** Signed working days. */
  finishDeltaDays: number;
  impacted: WhatIfImpact[];
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface ResourceLoadDay {
  date: string;
  hours: number;
  capacity: number;
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
  /** Working days. */
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
   * Then this is where the plan began, to keep as its start date; otherwise null.
   */
  keepStart: string | null;
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

export interface PersonCostRow {
  resourceId: string;
  hourlyRate: number | null;
  plannedHours: number;
  actualHours: number;
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
}
