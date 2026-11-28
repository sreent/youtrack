/** A plan's schedule and its what-ifs, as the reader may see them: money and people as D64 says, across projects as D72 and D73 say. */
import {
  parsePeriod,
  type PlanSchedule,
  type PlanScope,
  type PlanSetValue,
  type PlanTask,
  type PlanWhatIfResult,
  type Schedule,
  type ScheduleTask,
  type WhatIfResult,
} from '@a4a/shared';
import type { Ctx } from '../../context';
import { addDays, maxDate, minDate } from '../../lib/dates';
import { badRequest } from '../../lib/errors';
import { computeSchedule, isAwayWarning, planCalendars, whatIf, type PlanOverride, type ScheduledTask, type ScheduleResult } from '../../planning';
import { isWorkingDay } from '../../planning/calendar';
import type { AwayPart, PlanTaskInput } from '../../planning/types';
import { absencesForPlan } from '../absences';
import { findUser, type FieldRow } from '../schema-cache';
import { userRefDto } from '../values';
import { loadPlan, loadProjectPlan, MAX_PLAN_ISSUES, type Loaded, type PlanProject } from './load';

/**
 * Whether the reader sees a project's money in a plan: costs, rates, the budget and earned value. It takes the
 * costs permission there, as the cost report does (D37); a guest never has it, and neither does a role without
 * it (D64). In a plan across projects, each task's money is its own project's to show (D73).
 */
export function seesMoneyIn(l: Loaded, projectId: string | undefined): boolean {
  return Boolean(projectId) && l.view.allows(projectId!, 'costs');
}

function taskDto(l: Loaded, t: ScheduledTask, money = seesMoneyIn(l, l.projectOf.get(t.id))): ScheduleTask {
  const u = t.assigneeId ? l.s.users.get(t.assigneeId) : undefined;
  return {
    issue: l.refs.get(t.id) ?? { id: t.id, summary: t.summary, resolved: t.resolved, state: null },
    assignee: u ? userRefDto(u) : null,
    priority: l.priorityName.get(t.id) ?? null,
    parent: t.parent,
    depth: t.depth,
    isSummary: t.isSummary,
    isMilestone: t.isMilestone,
    start: t.start,
    finish: t.finish,
    durationDays: t.durationDays,
    effortMinutes: t.effortMinutes,
    spentMinutes: t.spentMinutes,
    percentComplete: t.percentComplete,
    earlyStart: t.earlyStart,
    earlyFinish: t.earlyFinish,
    lateStart: t.lateStart,
    lateFinish: t.lateFinish,
    slackDays: t.slackDays,
    critical: t.critical,
    deadline: t.deadline,
    late: t.late,
    scheduledFrom: t.scheduledFrom,
    predecessors: t.predecessors,
    plannedCost: money ? t.plannedCost : null,
    actualCost: money ? t.actualCost : null,
    baseline: t.baseline && (money ? t.baseline : { ...t.baseline, cost: null }),
    variance: t.variance && (money ? t.variance : { ...t.variance, cost: null }),
  };
}

/**
 * A project's schedule, as today's routes answer it (`Schedule`): the plan's own project, its calendar and money.
 * `sayCut` words a plan cut short among the warnings, where a project's answer has nowhere else to say it (D72).
 */
function scheduleDto(l: Loaded, r: ScheduleResult, sayCut = true): Schedule {
  const money = seesMoneyIn(l, l.project?.id);
  // A guest reaches no people (D37): not who is away, nor when, in the list or in a warning (D64). The
  // dates are the team's all the same, worked out on everyone's own days.
  const people = !l.view.guest;
  const warnings = people ? r.warnings : r.warnings.filter((w) => !isAwayWarning(w));
  return {
    project: l.project ? { id: l.project.id, key: l.project.key, name: l.project.name } : { id: '', key: '', name: '' },
    calendar: money ? l.input.calendar : { ...l.input.calendar, budget: null },
    start: r.start,
    finish: r.finish,
    today: r.today,
    criticalPath: r.criticalPath,
    tasks: r.tasks.map((t) => taskDto(l, t)),
    warnings: sayCut && l.truncated ? [...warnings, `Only the first ${MAX_PLAN_ISSUES} of ${l.total} issues are planned, by project and number: narrow the search to plan the rest`] : warnings,
    baseline: r.baseline,
    away: people ? awayDto(l, r) : [],
  };
}

/** Each role's field in a task's project, and the value the issue holds there (D72): what a cell writes back. */
function setOf(t: PlanTaskInput | undefined, p: PlanProject | undefined): NonNullable<PlanTask['set']> {
  const one = (f: FieldRow | null | undefined, value: string | number | null | undefined): PlanSetValue | null => (f ? { field: f.name, value: value ?? null } : null);
  return {
    start: one(p?.roles.start, t?.startConstraint),
    end: one(p?.roles.end, t?.deadline),
    duration: one(p?.roles.duration, null),
    estimate: one(p?.roles.estimate, t?.effortMinutes),
  };
}

/**
 * A plan of a scope (D72): today's schedule, and what a plan across projects adds. Each task says its project
 * and calendar, whether the reader may change it (the edit permission there, as `applyChanges` checks it), and
 * the dates and work people set, in its project's fields; each project's calendar keeps its budget only for a
 * reader with the costs permission there. A plan cut short says so in `truncated` and `total`, which a page words.
 */
function planScheduleDto(l: Loaded, r: ScheduleResult): PlanSchedule {
  const base = scheduleDto(l, r, false);
  const inputs = new Map(l.input.tasks.map((t) => [t.id, t]));
  const withTasks = [...l.projects.values()].filter((p) => Object.hasOwn(l.input.calendars ?? {}, p.calendarId));
  return {
    ...base,
    tasks: r.tasks.map((t, i) => {
      const projectId = l.projectOf.get(t.id);
      const p = projectId ? l.projects.get(projectId) : undefined;
      return { ...base.tasks[i]!, project: p?.row.key, calendar: p?.calendarId, editable: projectId ? l.view.canWrite(projectId) : false, set: setOf(inputs.get(t.id), p) };
    }),
    scope: l.scope,
    projects: withTasks.map((p) => ({ key: p.row.key, name: p.row.name, calendar: p.calendarId })),
    calendars: Object.fromEntries(withTasks.map((p) => [p.calendarId, seesMoneyIn(l, p.row.id) ? p.calendar : { ...p.calendar, budget: null }])),
    total: l.total,
    truncated: l.truncated,
  };
}

/**
 * Assignees' days away on the plan's working days between its start and finish, for the Gantt (D36, D43): the
 * days of its union calendar, on which a day works if any of its projects works it (D73).
 */
function awayDto(l: Loaded, r: ScheduleResult): Schedule['away'] {
  const assignees = new Set(r.tasks.map((t) => t.assigneeId).filter((id): id is string => Boolean(id)));
  const cal = planCalendars(l.input).union;
  const byLogin = new Map<string, Map<string, AwayPart>>();
  for (const a of l.input.absences ?? []) {
    const login = assignees.has(a.resourceId) ? l.s.users.get(a.resourceId)?.login : undefined;
    if (!login) continue;
    const days = byLogin.get(login) ?? new Map<string, AwayPart>();
    byLogin.set(login, days);
    const last = a.half ? a.from : minDate(a.to, r.finish);
    for (let d = maxDate(a.from, r.start); d <= last; d = addDays(d, 1)) {
      if (d > r.finish || !isWorkingDay(cal, d)) continue;
      const had = days.get(d);
      // A morning and an afternoon away are the whole day.
      days.set(d, !a.half || had === 'day' || (had && had !== a.half) ? 'day' : a.half);
    }
  }
  return [...byLogin]
    .filter(([, days]) => days.size > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([assignee, days]) => ({ assignee, days: [...days].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, part]) => ({ date, part })) }));
}

/** A project's schedule, as `GET /projects/{key}/schedule` answers it. */
export async function getSchedule(ctx: Ctx, key: string, opts: { query?: string; baseline?: string } = {}): Promise<Schedule> {
  const l = await loadProjectPlan(ctx, key, { query: opts.query, baselineId: opts.baseline });
  return scheduleDto(l, computeSchedule(l.input));
}

/** A plan of a scope (D72), as `GET /plans/schedule` answers it. */
export async function getPlanSchedule(ctx: Ctx, scope: PlanScope, opts: { baseline?: string } = {}): Promise<PlanSchedule> {
  const l = await loadPlan(ctx, scope, { baselineId: opts.baseline });
  return planScheduleDto(l, computeSchedule(l.input));
}

export interface OverrideInput {
  issue: string;
  delayDays?: number;
  estimate?: string;
  assignee?: string | null;
  start?: string;
}

function toOverrides(l: Loaded, ctx: Ctx, list: OverrideInput[]): PlanOverride[] {
  return list.map((o) => {
    const id = o.issue.toUpperCase();
    if (!l.refs.has(id)) throw badRequest(`${o.issue} is not in this plan`).said('planning.notInPlan', { issue: o.issue });
    const out: PlanOverride = { id };
    if (o.delayDays !== undefined) out.delayDays = o.delayDays;
    if (o.estimate !== undefined) {
      const m = parsePeriod(o.estimate);
      if (m === null) throw badRequest(`"${o.estimate}" is not a duration`).said('planning.notADuration', { estimate: o.estimate });
      out.effortMinutes = m;
    }
    if (o.assignee !== undefined) {
      if (o.assignee === null) out.assigneeId = null;
      else {
        const u = findUser(l.s, o.assignee, ctx.actor.user.id);
        if (!u) throw badRequest(`Unknown user "${o.assignee}"`).said('planning.unknownUser', { assignee: o.assignee });
        out.assigneeId = u.id;
        if (!l.input.resources.some((r) => r.id === u.id)) {
          l.input.resources.push({ id: u.id, login: u.login, name: u.name, capacityHoursPerDay: u.capacityHoursPerDay, hourlyRate: u.hourlyRate, week: u.workWeek });
        }
      }
    }
    if (o.start !== undefined) out.start = o.start;
    return out;
  });
}

async function whatIfOf(ctx: Ctx, l: Loaded, overrides: OverrideInput[]) {
  const planned = new Set(l.input.resources.map((r) => r.id));
  const changes = toOverrides(l, ctx, overrides);
  // Someone a what-if gives work to is planned around their own days away too.
  const added = l.input.resources.map((r) => r.id).filter((id) => !planned.has(id));
  if (added.length) l.input.absences = [...(l.input.absences ?? []), ...(await absencesForPlan(ctx.db, added, l.input.today))];
  const res = whatIf(l.input, changes);
  return { res, impacted: res.impacted.map((i) => ({ issue: i.id, summary: i.summary, startDeltaDays: i.startDeltaDays, finishDeltaDays: i.finishDeltaDays })) };
}

/** What-if on a project's plan, as `POST /projects/{key}/schedule/what-if` answers it. */
export async function whatIfSchedule(ctx: Ctx, key: string, body: { query?: string; baseline?: string; overrides: OverrideInput[] }): Promise<WhatIfResult> {
  const l = await loadProjectPlan(ctx, key, { query: body.query, baselineId: body.baseline });
  const { res, impacted } = await whatIfOf(ctx, l, body.overrides);
  return { before: res.before, after: scheduleDto(l, res.after), finishDeltaDays: res.finishDeltaDays, impacted };
}

/** What-if on a plan of a scope (D72), as `POST /plans/what-if` answers it: nothing is saved. */
export async function whatIfPlan(ctx: Ctx, body: { scope: PlanScope; baseline?: string; overrides: OverrideInput[] }): Promise<PlanWhatIfResult> {
  const l = await loadPlan(ctx, body.scope, { baselineId: body.baseline });
  const { res, impacted } = await whatIfOf(ctx, l, body.overrides);
  return { before: res.before, after: planScheduleDto(l, res.after), finishDeltaDays: res.finishDeltaDays, impacted };
}
