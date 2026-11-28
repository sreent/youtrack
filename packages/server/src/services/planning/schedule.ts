/** A plan's schedule and its what-ifs, as the reader may see them: money and people as D64 says. */
import { parsePeriod, type Schedule, type ScheduleTask, type WhatIfResult } from '@a4a/shared';
import type { Ctx } from '../../context';
import { addDays, maxDate, minDate } from '../../lib/dates';
import { badRequest } from '../../lib/errors';
import { computeSchedule, isAwayWarning, whatIf, type PlanOverride, type ScheduledTask, type ScheduleResult } from '../../planning';
import { isWorkingDay, normalizeCalendar } from '../../planning/calendar';
import type { AwayPart } from '../../planning/types';
import { absencesForPlan } from '../absences';
import { findUser } from '../schema-cache';
import { userRefDto } from '../values';
import { loadPlan, type Loaded } from './load';

/**
 * Whether the reader sees a plan's money: costs, rates, the budget and earned value. It takes the costs
 * permission, as the cost report does (D37); a guest never has it, and neither does a role without it (D64).
 */
function seesMoney(l: Loaded): boolean {
  return l.view.allows(l.project.id, 'costs');
}

function taskDto(l: Loaded, t: ScheduledTask, money = seesMoney(l)): ScheduleTask {
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

function scheduleDto(l: Loaded, r: ScheduleResult): Schedule {
  const money = seesMoney(l);
  // A guest reaches no people (D37): not who is away, nor when, in the list or in a warning (D64). The
  // dates are the team's all the same, worked out on everyone's own days.
  const people = !l.view.guest;
  return {
    project: { id: l.project.id, key: l.project.key, name: l.project.name },
    calendar: money ? l.input.calendar : { ...l.input.calendar, budget: null },
    start: r.start,
    finish: r.finish,
    today: r.today,
    criticalPath: r.criticalPath,
    tasks: r.tasks.map((t) => taskDto(l, t, money)),
    warnings: people ? r.warnings : r.warnings.filter((w) => !isAwayWarning(w)),
    baseline: r.baseline,
    away: people ? awayDto(l, r) : [],
  };
}

/** Assignees' days away on the plan's working days between its start and finish, for the Gantt (D36, D43). */
function awayDto(l: Loaded, r: ScheduleResult): Schedule['away'] {
  const assignees = new Set(r.tasks.map((t) => t.assigneeId).filter((id): id is string => Boolean(id)));
  const cal = normalizeCalendar(l.input.calendar);
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

export async function getSchedule(ctx: Ctx, key: string, opts: { query?: string; baseline?: string } = {}): Promise<Schedule> {
  const l = await loadPlan(ctx, key, { query: opts.query, baselineId: opts.baseline });
  return scheduleDto(l, computeSchedule(l.input));
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

export async function whatIfSchedule(ctx: Ctx, key: string, body: { query?: string; baseline?: string; overrides: OverrideInput[] }): Promise<WhatIfResult> {
  const l = await loadPlan(ctx, key, { query: body.query, baselineId: body.baseline });
  const planned = new Set(l.input.resources.map((r) => r.id));
  const overrides = toOverrides(l, ctx, body.overrides);
  // Someone a what-if gives work to is planned around their own days away too.
  const added = l.input.resources.map((r) => r.id).filter((id) => !planned.has(id));
  if (added.length) l.input.absences = [...(l.input.absences ?? []), ...(await absencesForPlan(ctx.db, added, l.input.today))];
  const res = whatIf(l.input, overrides);
  return { before: res.before, after: scheduleDto(l, res.after), finishDeltaDays: res.finishDeltaDays, impacted: res.impacted.map((i) => ({ issue: i.id, summary: i.summary, startDeltaDays: i.startDeltaDays, finishDeltaDays: i.finishDeltaDays })) };
}
