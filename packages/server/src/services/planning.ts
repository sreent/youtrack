/**
 * Planning: loads a project into the pure engine (src/planning) and maps its
 * results to API shapes. Schedules are computed on request and never stored;
 * baselines are stored snapshots.
 */
import {
  parsePeriod,
  WELL_KNOWN_FIELDS,
  type Baseline,
  type CostReport,
  type IssueRef,
  type LevelingMode,
  type LevelingResult,
  type ResourceLoad,
  type Schedule,
  type ScheduleTask,
  type WhatIfResult,
} from '@a4a/shared';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { baselines, baselineTasks, issueFieldValues, issueLinks, issues, projects, workItems } from '../db/schema';
import { publishActivities, recordActivity, type ActivityRow } from '../events/activity';
import { addDays, maxDate, minDate, todayISO } from '../lib/dates';
import { badRequest, conflict, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import {
  computeCosts,
  computeLoad,
  computeSchedule,
  levelResources,
  whatIf,
  type PlanBaseline,
  type PlanInput,
  type PlanOverride,
  type PlanResource,
  type PlanTaskInput,
  type PlanWorkItem,
  type ScheduledTask,
  type ScheduleResult,
} from '../planning';
import { isWorkingDay, normalizeCalendar } from '../planning/calendar';
import type { AwayPart } from '../planning/types';
import { searchIssueRows } from '../search/service';
import { absencesForPlan } from './absences';
import { canReadProject, hiddenFields, issueSeenSql, projectAccess, requireProject, seenIssueIds, type ProjectNeed } from './access';
import { readableId, stateNames, type IssueRow } from './issue-refs';
import { applyChanges, resolveFieldsInput } from './issues';
import { projectSettings } from './projects';
import { fieldByName, findUser, idWithKeyNow, projectByKey, type ProjectRow, type SchemaSnapshot } from './schema-cache';
import { userRefDto } from './values';

const MAX_PLAN_ISSUES = 2000;

interface Loaded {
  input: PlanInput;
  project: ProjectRow;
  s: SchemaSnapshot;
  refs: Map<string, IssueRef>;
  rowsById: Map<string, IssueRow>;
  priorityName: Map<string, string | null>;
}

function localDate(d: Date): string {
  return todayISO(d);
}

async function projectFor(ctx: Ctx, key: string, need: ProjectNeed = 'read'): Promise<{ s: SchemaSnapshot; project: ProjectRow }> {
  const project = await requireProject(ctx, key, need);
  return { s: await ctx.app.schema.get(), project };
}

/** Everything the engine needs about a project, as plain data. */
export async function loadPlan(
  ctx: Ctx,
  key: string,
  opts: { query?: string; baselineId?: string; today?: string; need?: ProjectNeed } = {},
): Promise<Loaded> {
  const { s, project } = await projectFor(ctx, key, opts.need);
  const rows: IssueRow[] = opts.query?.trim()
    ? (await searchIssueRows(ctx, opts.query, { projectId: project.id, limit: MAX_PLAN_ISSUES })).rows
    : await ctx.db
        .select()
        .from(issues)
        // A plan holds the issues the caller sees (D37): its managers, who level it, see them all.
        .where(and(eq(issues.projectId, project.id), issueSeenSql(await projectAccess(ctx), s)))
        .orderBy(asc(issues.number))
        .limit(MAX_PLAN_ISSUES);
  const ids = rows.map((r) => r.id);
  const rid = new Map(rows.map((r) => [r.id, readableId(s, r)]));

  const field = (name: string) => fieldByName(s, name);
  const fAssignee = field(WELL_KNOWN_FIELDS.assignee);
  const fEstimate = field(WELL_KNOWN_FIELDS.estimation);
  const fStart = field(WELL_KNOWN_FIELDS.startDate);
  const fDue = field(WELL_KNOWN_FIELDS.dueDate);
  const fCost = field(WELL_KNOWN_FIELDS.fixedCost);
  const fPriority = field(WELL_KNOWN_FIELDS.priority);
  const fType = field(WELL_KNOWN_FIELDS.type);

  // A private field kept from the caller is no value to the plan they read (D50), as a limited issue is no task (D37).
  const kept = hiddenFields(await projectAccess(ctx), s).get(project.id);
  const values = (ids.length ? await ctx.db.select().from(issueFieldValues).where(inArray(issueFieldValues.issueId, ids)) : []).filter((v) => !kept?.has(v.fieldId));
  const byIssue = new Map<string, typeof values>();
  for (const v of values) byIssue.set(v.issueId, [...(byIssue.get(v.issueId) ?? []), v]);
  const val = (issueId: string, fieldId: string | undefined) => (fieldId ? byIssue.get(issueId)?.find((v) => v.fieldId === fieldId) : undefined);

  const aggregation = new Set(s.linkTypes.filter((t) => t.aggregation).map((t) => t.id));
  const depends = s.linkPhrases.find((p) => p.phrase === 'depends on');
  const links = ids.length
    ? await ctx.db.select().from(issueLinks).where(inArray(issueLinks.sourceId, ids))
    : [];
  const incoming = ids.length ? await ctx.db.select().from(issueLinks).where(inArray(issueLinks.targetId, ids)) : [];
  const parentOf = new Map<string, string>();
  for (const l of [...links, ...incoming]) if (aggregation.has(l.typeId) && rid.has(l.sourceId)) parentOf.set(l.targetId, l.sourceId);
  const predecessors = new Map<string, Set<string>>();
  const externalIds = new Set<string>();
  if (depends) {
    for (const l of links) {
      if (l.typeId !== depends.type.id) continue;
      // "source depends on target": target must finish first.
      const set = predecessors.get(l.sourceId) ?? new Set();
      set.add(l.targetId);
      predecessors.set(l.sourceId, set);
      if (!rid.has(l.targetId)) externalIds.add(l.targetId);
    }
  }
  if (externalIds.size) {
    // A dependency on an issue in another project is named only when the caller can see it: the
    // plan's warnings must not give away an issue they can't open.
    const view = await projectAccess(ctx);
    const ext = await ctx.db.select().from(issues).where(inArray(issues.id, [...externalIds]));
    const seen = await seenIssueIds(ctx, ext.map((e) => e.id));
    for (const e of ext) if (view.canRead(e.projectId) && seen.has(e.id)) rid.set(e.id, readableId(s, e));
  }

  const work = ids.length ? await ctx.db.select().from(workItems).where(inArray(workItems.issueId, ids)) : [];
  const spent = new Map<string, number>();
  const firstWork = new Map<string, string>();
  for (const w of work) {
    spent.set(w.issueId, (spent.get(w.issueId) ?? 0) + w.minutes);
    if (!firstWork.has(w.issueId) || w.date < firstWork.get(w.issueId)!) firstWork.set(w.issueId, w.date);
  }

  const states = await stateNames(ctx.db, s, ids);
  const refs = new Map<string, IssueRef>();
  const priorityName = new Map<string, string | null>();
  const tasks: PlanTaskInput[] = rows.map((r) => {
    const id = rid.get(r.id)!;
    refs.set(id, { id, summary: r.summary, resolved: r.resolvedAt !== null, state: states.get(r.id) ?? null });
    const prio = val(r.id, fPriority?.id)?.valueId;
    const prioValue = prio ? s.values.get(prio) : undefined;
    priorityName.set(id, prioValue?.name ?? null);
    const typeValue = val(r.id, fType?.id)?.valueId;
    const parent = parentOf.get(r.id);
    return {
      id,
      summary: r.summary,
      parent: parent && rid.has(parent) && ids.includes(parent) ? rid.get(parent)! : null,
      assigneeId: val(r.id, fAssignee?.id)?.userId ?? null,
      effortMinutes: val(r.id, fEstimate?.id)?.numberValue ?? null,
      startConstraint: val(r.id, fStart?.id)?.dateValue ?? null,
      deadline: val(r.id, fDue?.id)?.dateValue ?? null,
      resolved: r.resolvedAt !== null,
      resolvedAt: r.resolvedAt ? localDate(r.resolvedAt) : null,
      firstWorkDate: firstWork.get(r.id) ?? null,
      spentMinutes: spent.get(r.id) ?? 0,
      priorityOrdinal: prioValue?.ordinal ?? null,
      fixedCost: val(r.id, fCost?.id)?.numberValue ?? null,
      predecessors: [...(predecessors.get(r.id) ?? [])].map((p) => rid.get(p)!).filter(Boolean),
      isMilestone: typeValue ? s.values.get(typeValue)?.name.toLowerCase() === 'milestone' : false,
    };
  });

  const people = new Set<string>();
  for (const t of tasks) if (t.assigneeId) people.add(t.assigneeId);
  for (const w of work) if (w.authorId) people.add(w.authorId);
  const resources: PlanResource[] = [...people]
    .map((id) => s.users.get(id))
    .filter((u): u is NonNullable<typeof u> => Boolean(u))
    .map((u) => ({ id: u.id, login: u.login, name: u.name, capacityHoursPerDay: u.capacityHoursPerDay, hourlyRate: u.hourlyRate, week: u.workWeek }));
  const items: PlanWorkItem[] = work.map((w) => ({ taskId: rid.get(w.issueId)!, authorId: w.authorId, date: w.date, minutes: w.minutes, hourlyRate: w.hourlyRate }));

  let baseline: PlanBaseline | null = null;
  if (opts.baselineId) {
    const [b] = await ctx.db.select().from(baselines).where(and(eq(baselines.id, opts.baselineId), eq(baselines.projectId, project.id)));
    if (!b) throw notFound('Baseline', `Baselines of ${project.key}: GET /projects/${project.key}/baselines`).said('planning.baselineNotFoundList', { project: project.key });
    const bt = await ctx.db.select().from(baselineTasks).where(eq(baselineTasks.baselineId, b.id));
    // Its tasks keep the ids they had; the plan's read as the issues read now (a key renamed since, D52).
    baseline = { id: b.id, name: b.name, tasks: bt.map((t) => ({ id: rid.get(t.issueId) ?? idWithKeyNow(s, t.readableId), start: t.start, finish: t.finish, effortMinutes: t.effortMinutes, cost: t.cost })) };
  }

  const plan = projectSettings(project).plan;
  const today = opts.today ?? todayISO();
  // Each person's days away, so their work lands on the days they're there (D36).
  const away = await absencesForPlan(ctx.db, resources.map((r) => r.id), today);
  return {
    input: { today, calendar: plan, tasks, resources, workItems: items, baseline, absences: away },
    project,
    s,
    refs,
    rowsById: new Map(rows.map((r) => [rid.get(r.id)!, r])),
    priorityName,
  };
}

function taskDto(l: Loaded, t: ScheduledTask): ScheduleTask {
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
    plannedCost: t.plannedCost,
    actualCost: t.actualCost,
    baseline: t.baseline,
    variance: t.variance,
  };
}

function scheduleDto(l: Loaded, r: ScheduleResult): Schedule {
  return {
    project: { id: l.project.id, key: l.project.key, name: l.project.name },
    calendar: l.input.calendar,
    start: r.start,
    finish: r.finish,
    today: r.today,
    criticalPath: r.criticalPath,
    tasks: r.tasks.map((t) => taskDto(l, t)),
    warnings: r.warnings,
    baseline: r.baseline,
    away: awayDto(l, r),
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

export async function getResourceLoad(ctx: Ctx, key: string, opts: { from?: string; to?: string; query?: string } = {}): Promise<ResourceLoad> {
  const l = await loadPlan(ctx, key, { query: opts.query });
  const schedule = computeSchedule(l.input);
  const load = computeLoad(l.input, schedule, opts.from, opts.to);
  return {
    from: load.from,
    to: load.to,
    unassignedHours: load.unassignedHours,
    resources: load.resources
      .map((r) => {
        const u = l.s.users.get(r.resourceId);
        if (!u) return null;
        return {
          user: userRefDto(u),
          capacityHoursPerDay: r.capacityHoursPerDay,
          totalHours: r.totalHours,
          overallocatedDays: r.overallocatedDays,
          peakLoadPct: r.peakLoadPct,
          days: r.days,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null),
  };
}

/** Propose (dryRun) or apply levelling. Applying writes each moved task's Start date, never its due date. */
export async function level(
  ctx: Ctx,
  key: string,
  opts: { query?: string; mode: LevelingMode; dryRun: boolean; expect?: Record<string, string> },
): Promise<LevelingResult> {
  if (!opts.dryRun) requireScope(ctx, 'write');
  // Applying writes Start dates, which is work on issues: members may, as for each issue by hand.
  const l = await loadPlan(ctx, key, { query: opts.query, need: opts.dryRun ? 'read' : 'write' });
  const p = levelResources(l.input, opts.mode);
  const changes = p.changes.map((c) => ({
    issue: c.id,
    summary: c.summary,
    assignee: c.assigneeId ? (l.s.users.get(c.assigneeId)?.login ?? null) : null,
    fromStart: c.fromStart,
    fromFinish: c.fromFinish,
    toStart: c.toStart,
    toFinish: c.toFinish,
    delayDays: c.delayDays,
    movedBy: c.movedBy,
  }));
  // Applying writes the starts of the tasks levelling moved, and only those: a task that
  // moved because its predecessors did follows them by itself, and pinning its start
  // would turn a task with a due date and no estimate into a start-to-due window.
  const starts = p.levelledStarts;
  const writes = Object.entries(starts);
  if (!opts.dryRun && opts.expect && !sameStarts(opts.expect, starts)) {
    throw conflict(
      `The plan of ${l.project.key} changed since this levelling was proposed`,
      'Review the new proposal, then level again.',
      { starts },
    ).said('planning.planChanged', { project: l.project.key });
  }
  if (!opts.dryRun && writes.length) {
    const startField = fieldByName(l.s, WELL_KNOWN_FIELDS.startDate);
    if (!startField || !(l.s.projectFields.get(l.project.id) ?? []).some((pf) => pf.fieldId === startField.id)) {
      throw badRequest(`${l.project.key} has no "${WELL_KNOWN_FIELDS.startDate}" field to record levelled starts`, 'Attach the field in the project settings.').said('planning.noStartDateField', { project: l.project.key, field: WELL_KNOWN_FIELDS.startDate });
    }
    // One transaction: the person agreed to the whole proposal, so it lands whole or not at all.
    const activities = await ctx.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const out: ActivityRow[] = [];
      if (p.keepStart) {
        // Part of what was proposed, not a change of settings: the plan begins where it did.
        // Only plan.startDate, in SQL, so a settings change made meanwhile is kept.
        await tx
          .update(projects)
          .set({
            settings: sql`jsonb_set(coalesce(${projects.settings}, '{}'::jsonb), '{plan}', coalesce(${projects.settings}->'plan', '{}'::jsonb) || jsonb_build_object('startDate', ${p.keepStart}::text))`,
            updatedAt: new Date(),
          })
          .where(eq(projects.id, l.project.id));
      }
      for (const [id, start] of writes) {
        const row = l.rowsById.get(id);
        if (!row) throw notFound(`Issue ${id}`).said('notFound.issue', { id });
        const fields = resolveFieldsInput(l.s, l.project, { [WELL_KNOWN_FIELDS.startDate]: start }, ctx.actor.user.id);
        const res = await applyChanges(tx, ctx, row, { fields });
        out.push(...res.activities);
      }
      return out;
    });
    if (p.keepStart) ctx.app.schema.invalidate();
    await publishActivities(ctx.app, activities);
  }
  return {
    mode: p.mode,
    applied: !opts.dryRun && writes.length > 0,
    finishBefore: p.finishBefore,
    finishAfter: p.finishAfter,
    overallocatedDaysBefore: p.overallocatedDaysBefore,
    overallocatedDaysAfter: p.overallocatedDaysAfter,
    changes,
    starts,
    unresolved: p.unresolved,
    keepsStart: writes.length ? p.keepStart : null,
  };
}

function sameStarts(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => b[k] === a[k]);
}

export async function getCostReport(ctx: Ctx, key: string, opts: { baseline?: string } = {}): Promise<CostReport> {
  // Costs are for roles that see time and costs (D37).
  const l = await loadPlan(ctx, key, { baselineId: opts.baseline, need: 'costs' });
  const schedule = computeSchedule(l.input);
  const c = computeCosts(l.input, schedule);
  return {
    project: { id: l.project.id, key: l.project.key, name: l.project.name },
    currency: c.currency,
    budget: c.budget,
    plannedCost: c.plannedCost,
    actualCost: c.actualCost,
    forecastCost: c.forecastCost,
    budgetVariance: c.budgetVariance,
    byTask: c.byTask.map((t) => ({
      issue: t.id,
      summary: t.summary,
      assignee: t.assigneeId ? (l.s.users.get(t.assigneeId)?.login ?? null) : null,
      plannedCost: t.plannedCost,
      actualCost: t.actualCost,
      fixedCost: t.fixedCost,
      effortMinutes: t.effortMinutes,
      spentMinutes: t.spentMinutes,
      resolved: t.resolved,
    })),
    byPerson: c.byPerson
      .map((p) => {
        const u = l.s.users.get(p.resourceId);
        return u ? { user: userRefDto(u), hourlyRate: p.hourlyRate, plannedHours: p.plannedHours, actualHours: p.actualHours, plannedCost: p.plannedCost, actualCost: p.actualCost } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null),
    evm: c.evm,
    warnings: c.warnings,
  };
}

// Baselines ------------------------------------------------------------------

async function baselineDto(ctx: Ctx, s: SchemaSnapshot, row: typeof baselines.$inferSelect, count?: number): Promise<Baseline> {
  const by = row.createdById ? s.users.get(row.createdById) : undefined;
  const n =
    count ?? (await ctx.db.select({ id: baselineTasks.issueId }).from(baselineTasks).where(eq(baselineTasks.baselineId, row.id))).length;
  return {
    id: row.id,
    projectKey: s.projects.get(row.projectId)?.key ?? '',
    name: row.name,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    createdBy: by ? userRefDto(by) : null,
    taskCount: n,
    start: row.start,
    finish: row.finish,
    plannedCost: row.plannedCost,
  };
}

export async function listBaselines(ctx: Ctx, key: string): Promise<Baseline[]> {
  const { s, project } = await projectFor(ctx, key);
  const rows = await ctx.db.select().from(baselines).where(eq(baselines.projectId, project.id)).orderBy(desc(baselines.createdAt));
  return Promise.all(rows.map((r) => baselineDto(ctx, s, r)));
}

export async function getBaseline(ctx: Ctx, id: string): Promise<Baseline> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const [row] = await ctx.db.select().from(baselines).where(eq(baselines.id, id));
  // A baseline of a project the caller can't see is not found, as one that doesn't exist.
  if (!row || !(await canReadProject(ctx, row.projectId))) throw notFound('Baseline').said('planning.baselineNotFound');
  return baselineDto(ctx, s, row);
}

/**
 * Snapshot the plan as it stands. `asOf` lets the demo seed record a plan of
 * record as it looked on the project's first day.
 */
export async function createBaseline(
  ctx: Ctx,
  key: string,
  input: { name: string; note?: string; query?: string },
  internal: { asOf?: string; createdAt?: Date } = {},
): Promise<Baseline> {
  requireScope(ctx, 'write');
  // Baselines are the plan of record: its managers keep them.
  const l = await loadPlan(ctx, key, { query: input.query, today: internal.asOf, need: 'manage' });
  const schedule = computeSchedule(l.input);
  const leaves = schedule.tasks.filter((t) => !t.isSummary);
  const plannedCost = leaves.reduce((sum, t) => sum + t.plannedCost, 0);
  const id = newId();
  const { row, activity } = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx
      .insert(baselines)
      .values({
        id,
        projectId: l.project.id,
        name: input.name,
        note: input.note ?? '',
        createdById: ctx.actor.user.id,
        start: schedule.start,
        finish: schedule.finish,
        plannedCost: Math.round(plannedCost * 100) / 100,
        ...(internal.createdAt ? { createdAt: internal.createdAt } : {}),
      })
      .returning();
    if (leaves.length) {
      await tx.insert(baselineTasks).values(
        leaves.map((t) => ({
          baselineId: id,
          issueId: l.rowsById.get(t.id)?.id ?? t.id,
          readableId: t.id,
          summary: t.summary,
          start: t.start,
          finish: t.finish,
          effortMinutes: Math.round(t.effortMinutes),
          cost: t.plannedCost,
          assigneeId: t.assigneeId,
        })),
      );
    }
    const activity = await recordActivity(tx, ctx, {
      type: 'baseline.created',
      projectId: l.project.id,
      issueId: null,
      payload: { data: { baselineId: id, name: input.name, tasks: leaves.length, finish: schedule.finish, plannedCost } },
    });
    return { row: row!, activity };
  });
  await publishActivities(ctx.app, [activity]);
  return baselineDto(ctx, l.s, row, leaves.length);
}

export async function deleteBaseline(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const [row] = await ctx.db.select().from(baselines).where(eq(baselines.id, id));
  if (!row || !(await canReadProject(ctx, row.projectId))) throw notFound('Baseline').said('planning.baselineNotFound');
  await requireProject(ctx, s.projects.get(row.projectId)?.key ?? '', 'manage');
  await ctx.db.delete(baselines).where(eq(baselines.id, id));
}
