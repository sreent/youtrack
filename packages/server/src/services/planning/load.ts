/** Loading a project's plan: everything the engine needs about it, as plain data. */
import { WELL_KNOWN_FIELDS, type IssueRef } from '@a4a/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../../context';
import { baselines, baselineTasks, issueFieldValues, issueLinks, issues, workItems } from '../../db/schema';
import { todayISO } from '../../lib/dates';
import { notFound } from '../../lib/errors';
import type { PlanBaseline, PlanInput, PlanResource, PlanTaskInput, PlanWorkItem } from '../../planning';
import { searchIssueRows } from '../../search/service';
import { absencesForPlan } from '../absences';
import { hiddenFields, issueSeenSql, projectAccess, requireProject, seenIssueIds, type AccessView, type ProjectNeed } from '../access';
import { readableId, stateNames, type IssueRow } from '../issue-refs';
import { projectWorkers } from '../agile';
import { projectSettings } from '../projects';
import { fieldByName, idWithKeyNow, type ProjectRow, type SchemaSnapshot } from '../schema-cache';

const MAX_PLAN_ISSUES = 2000;

export interface Loaded {
  input: PlanInput;
  project: ProjectRow;
  s: SchemaSnapshot;
  /** Who reads it: what they may see of its money and its people (D64). */
  view: AccessView;
  refs: Map<string, IssueRef>;
  rowsById: Map<string, IssueRow>;
  priorityName: Map<string, string | null>;
}

function localDate(d: Date): string {
  return todayISO(d);
}

export async function projectFor(ctx: Ctx, key: string, need: ProjectNeed = 'read'): Promise<{ s: SchemaSnapshot; project: ProjectRow }> {
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
  const view = await projectAccess(ctx);
  // A guest reads the plan as it stands (D64): a baseline is the team's record of what it planned, and
  // what it cost, so to a guest one is missing, as one that doesn't exist.
  if (opts.baselineId && view.guest) throw notFound('Baseline').said('planning.baselineNotFound');
  const rows: IssueRow[] = opts.query?.trim()
    ? (await searchIssueRows(ctx, opts.query, { projectId: project.id, limit: MAX_PLAN_ISSUES })).rows
    : await ctx.db
        .select()
        .from(issues)
        // A plan holds the issues the caller sees (D37): its managers, who level it, see them all.
        .where(and(eq(issues.projectId, project.id), issueSeenSql(view, s)))
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
  const kept = hiddenFields(view, s).get(project.id);
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
    const ext = await ctx.db.select().from(issues).where(inArray(issues.id, [...externalIds]));
    const seen = await seenIssueIds(ctx, ext.map((e) => e.id));
    for (const e of ext) if (view.canRead(e.projectId) && seen.has(e.id)) rid.set(e.id, readableId(s, e));
  }

  const work = ids.length ? (await ctx.db.select().from(workItems).where(inArray(workItems.issueId, ids))).filter((w): w is typeof w & { issueId: string } => w.issueId !== null) : [];
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
  // A team is more than who is busy (D43's revisit): the project's members who can change its
  // issues join the grid with their capacity, so a person with nothing planned is seen too.
  for (const id of await projectWorkers(ctx.db, [project.id])) people.add(id);
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
    view,
    refs,
    rowsById: new Map(rows.map((r) => [rid.get(r.id)!, r])),
    priorityName,
  };
}
