/**
 * Loading a plan: everything the engine needs about the issues a scope holds, as plain data (D10, D72).
 * A scope is a saved search or a query, as its reader reads it, in one project or several; each project
 * keeps its own calendar (D73), and its own fields for the dates people set.
 */
import { WELL_KNOWN_FIELDS, type IssueRef, type PlanScope } from '@a4a/shared';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { isAdmin, requireScope, type Ctx } from '../../context';
import { baselines, baselineTasks, issueFieldValues, issueLinks, issues, projects, savedSearches, workItems } from '../../db/schema';
import { todayISO } from '../../lib/dates';
import { AppError, notFound } from '../../lib/errors';
import type { PlanBaseline, PlanCalendar, PlanInput, PlanResource, PlanTaskInput, PlanWorkItem } from '../../planning';
import { compileOrThrow, prepareQuery } from '../../search/service';
import { absencesForPlan } from '../absences';
import { hiddenFields, issueSeenSql, projectAccess, requireProject, seenIssueIds, type AccessView, type ProjectNeed } from '../access';
import { readableId, stateNames, type IssueRow } from '../issue-refs';
import { projectWorkers } from '../agile';
import { DEFAULT_PLAN, projectSettings } from '../projects';
import { fieldByName, idWithKeyNow, type FieldRow, type ProjectRow, type SchemaSnapshot } from '../schema-cache';

/** The most issues a plan holds (D72): a scope that finds more is planned by its first, by project and number, and says so. */
export const MAX_PLAN_ISSUES = 2000;

export type SavedSearchRow = typeof savedSearches.$inferSelect;

/** The roles a field plays in a plan (D72), and the field that plays each in a project: none where it plans that role from no field. */
export interface PlanRoles {
  start: FieldRow | null;
  end: FieldRow | null;
  duration: FieldRow | null;
  estimate: FieldRow | null;
}

/** One of a plan's projects: its calendar, under its key (D73), and the fields its issues' dates are set in. */
export interface PlanProject {
  row: ProjectRow;
  /** Its calendar's id among the plan's calendars, which its tasks name: its key. */
  calendarId: string;
  calendar: PlanCalendar;
  /** As the reader reads them: a field kept from them (D50) plans no role for them. */
  roles: PlanRoles;
}

export interface Loaded {
  input: PlanInput;
  scope: PlanScope;
  /** The saved search the scope names, read as its reader may read it. */
  savedSearch: SavedSearchRow | null;
  /** The project whose calendar is the plan's own (D73): the scope's, else the first the plan holds; null for an empty plan of no one project. */
  project: ProjectRow | null;
  /** The plan's projects, by id, in the order of their keys: those its tasks are in, and the scope's. */
  projects: Map<string, PlanProject>;
  s: SchemaSnapshot;
  /** Who reads it: what they may see of its money and its people (D64), and change (D72). */
  view: AccessView;
  refs: Map<string, IssueRef>;
  rowsById: Map<string, IssueRow>;
  /** Each task's project id, by its readable id. */
  projectOf: Map<string, string>;
  priorityName: Map<string, string | null>;
  /** How many issues the scope holds: more than the plan does when it's `truncated`. */
  total: number;
  /** The scope holds more than MAX_PLAN_ISSUES, so the plan holds its first, by project and number. */
  truncated: boolean;
}

/** A plan of one project, as today's routes read it: the scope `{project, query}`. */
export type ProjectLoaded = Loaded & { project: ProjectRow };

export interface PlanLoadOptions {
  /** A baseline to compare with: one of the saved search's, or, for a project's scope read by query, one of the project's. */
  baselineId?: string;
  /** The status date; today where the server is, else. */
  today?: string;
  /** What the reader must be allowed in the scope's project, as today's routes ask (D37): read, unless said. */
  need?: ProjectNeed;
}

function localDate(d: Date): string {
  return todayISO(d);
}

export async function projectFor(ctx: Ctx, key: string, need: ProjectNeed = 'read'): Promise<{ s: SchemaSnapshot; project: ProjectRow }> {
  const project = await requireProject(ctx, key, need);
  return { s: await ctx.app.schema.get(), project };
}

const missingSearch = () => notFound('Saved search').said('savedSearches.notFound');

/** Whether a saved search is the reader's own to answer for: theirs, or, with no owner (D72), an administrator's. */
function ownsSearch(ctx: Ctx, row: SavedSearchRow): boolean {
  return row.ownerId === ctx.actor.user.id || (row.ownerId === null && isAdmin(ctx));
}

/**
 * A saved search as its reader may read it (D72), as `listSavedSearches` lists them: their own; a shared one,
 * or one whose owner was deleted, whose query reads for them; and, to an administrator, one with no owner.
 * Any other is missing, in the words of one that doesn't exist. A guest has none (D64).
 *
 * `compile` false leaves whether its query reads to the caller, who compiles it anyway: a plan compiles
 * it once.
 */
export async function readSavedSearch(ctx: Ctx, id: string, view: AccessView, compile = true): Promise<SavedSearchRow> {
  requireScope(ctx, 'read');
  if (view.guest) throw missingSearch();
  const [row] = await ctx.db.select().from(savedSearches).where(eq(savedSearches.id, id));
  if (!row) throw missingSearch();
  if (ownsSearch(ctx, row)) return row;
  if (!row.shared && row.ownerId !== null) throw missingSearch();
  if (compile && (await prepareQuery(ctx, row.query)).compiled.problems.length) throw missingSearch();
  return row;
}

/** The fields a project plans each role from: today's well-known ones, where it has them and the reader sees them (P8 makes them choosable). */
function rolesOf(s: SchemaSnapshot, project: ProjectRow, kept: ReadonlySet<string> | undefined): PlanRoles {
  const attached = new Set((s.projectFields.get(project.id) ?? []).map((pf) => pf.fieldId));
  const role = (name: string): FieldRow | null => {
    const f = fieldByName(s, name);
    return f && attached.has(f.id) && !kept?.has(f.id) ? f : null;
  };
  return { start: role(WELL_KNOWN_FIELDS.startDate), end: role(WELL_KNOWN_FIELDS.dueDate), duration: null, estimate: role(WELL_KNOWN_FIELDS.estimation) };
}

/** The ids of the issues the scope holds, by project and number: up to one more than a plan holds, and how many there are. */
async function selectIds(ctx: Ctx, view: AccessView, s: SchemaSnapshot, where: SQL | null): Promise<{ ids: string[]; total: number }> {
  // The compiled query reads as its reader sees the tracker; the access seam's own conditions are said here
  // too, so what a plan holds never depends on how a search composes them (D37).
  const parts: SQL[] = [];
  if (where) parts.push(where);
  const visible = view.visibleIds();
  if (visible !== null) parts.push(visible.length ? inArray(issues.projectId, visible) : sql`FALSE`);
  const seen = issueSeenSql(view, s);
  if (seen) parts.push(seen);
  const cond = parts.length ? and(...parts) : undefined;
  const byProject = sql`(SELECT ${projects.key} FROM ${projects} WHERE ${projects.id} = ${issues.projectId})`;
  const rows = await ctx.db
    .select({ id: issues.id })
    .from(issues)
    .where(cond)
    .orderBy(asc(byProject), asc(issues.number), asc(issues.id))
    .limit(MAX_PLAN_ISSUES + 1);
  if (rows.length <= MAX_PLAN_ISSUES) return { ids: rows.map((r) => r.id), total: rows.length };
  const [count] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(issues).where(cond);
  return { ids: rows.slice(0, MAX_PLAN_ISSUES).map((r) => r.id), total: Number(count?.n ?? rows.length) };
}

/**
 * Everything the engine needs about the issues a scope holds, as plain data (D72, D73).
 *
 * The query (a saved search's, read for this reader, or the one given) is compiled once, as the reader sees
 * the tracker, and narrowed to the scope's project. The plan holds the issues it finds that the reader sees,
 * across projects, by project and number, at most MAX_PLAN_ISSUES of them: `total` says how many it found,
 * and `truncated` that the plan holds fewer. Each project brings its calendar (its tasks name it by the
 * project's key), the fields its dates are set in, and its workers; dependencies are the links of the type
 * marked as the dependency (D72), whatever its phrases say.
 */
export async function loadPlan(ctx: Ctx, scope: PlanScope | string, opts: PlanLoadOptions & { query?: string } = {}): Promise<Loaded> {
  // Today's one-project loader is this one's scope `{project: key, query}`, and a key still says it.
  if (typeof scope === 'string') return loadProjectPlan(ctx, scope, opts);
  requireScope(ctx, 'read');
  // A project the reader can't see is missing, in the words of one that doesn't exist (D37).
  const scoped = scope.project ? await requireProject(ctx, scope.project, opts.need ?? 'read') : null;
  const s = await ctx.app.schema.get();
  const view = await projectAccess(ctx);
  // A guest reads the plan as it stands (D64): a baseline is the team's record of what it planned, and
  // what it cost, so to a guest one is missing, as one that doesn't exist.
  if (opts.baselineId && view.guest) throw notFound('Baseline').said('planning.baselineNotFound');
  const savedSearch = 'savedSearch' in scope ? await readSavedSearch(ctx, scope.savedSearch, view, false) : null;
  const query = savedSearch ? savedSearch.query : 'query' in scope ? scope.query : '';

  let where: SQL | null;
  try {
    where = (await compileOrThrow(ctx, query, scoped ? { projectId: scoped.id } : undefined)).compiled.where;
  } catch (e) {
    // Someone else's search that doesn't read for this reader (it names what they can't see) is missing to them.
    if (savedSearch && !ownsSearch(ctx, savedSearch) && e instanceof AppError && e.status === 400) throw missingSearch();
    throw e;
  }
  const picked = await selectIds(ctx, view, s, where);
  const order = new Map(picked.ids.map((id, i) => [id, i]));
  const rows: IssueRow[] = picked.ids.length
    ? (await ctx.db.select().from(issues).where(inArray(issues.id, picked.ids))).sort((a, b) => order.get(a.id)! - order.get(b.id)!)
    : [];
  const ids = rows.map((r) => r.id);
  const inPlan = new Set(ids);
  const rid = new Map(rows.map((r) => [r.id, readableId(s, r)]));

  // The plan's projects: those its issues are in, and the scope's, each with its calendar and the fields of its dates.
  const kept = hiddenFields(view, s);
  const projectIds = new Set(rows.map((r) => r.projectId));
  if (scoped) projectIds.add(scoped.id);
  const planProjects = new Map<string, PlanProject>(
    [...projectIds]
      .map((id) => s.projects.get(id) ?? (id === scoped?.id ? scoped : undefined))
      .filter((p): p is ProjectRow => Boolean(p))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((p) => [p.id, { row: p, calendarId: p.key, calendar: projectSettings(p).plan, roles: rolesOf(s, p, kept.get(p.id)) }]),
  );
  const withTasks = [...planProjects.values()].filter((p) => rows.some((r) => r.projectId === p.row.id));
  const own = scoped ?? withTasks[0]?.row ?? null;

  const field = (name: string) => fieldByName(s, name);
  const fAssignee = field(WELL_KNOWN_FIELDS.assignee);
  const fEstimate = field(WELL_KNOWN_FIELDS.estimation);
  const fStart = field(WELL_KNOWN_FIELDS.startDate);
  const fDue = field(WELL_KNOWN_FIELDS.dueDate);
  const fCost = field(WELL_KNOWN_FIELDS.fixedCost);
  const fPriority = field(WELL_KNOWN_FIELDS.priority);
  const fType = field(WELL_KNOWN_FIELDS.type);

  // A private field kept from the caller is no value to the plan they read (D50), as a limited issue is no task (D37).
  const projectOfIssue = new Map(rows.map((r) => [r.id, r.projectId]));
  const values = (ids.length ? await ctx.db.select().from(issueFieldValues).where(inArray(issueFieldValues.issueId, ids)) : []).filter(
    (v) => !kept.get(projectOfIssue.get(v.issueId) ?? '')?.has(v.fieldId),
  );
  const byIssue = new Map<string, typeof values>();
  for (const v of values) byIssue.set(v.issueId, [...(byIssue.get(v.issueId) ?? []), v]);
  const val = (issueId: string, fieldId: string | undefined) => (fieldId ? byIssue.get(issueId)?.find((v) => v.fieldId === fieldId) : undefined);

  const aggregation = new Set(s.linkTypes.filter((t) => t.aggregation).map((t) => t.id));
  // The dependency is a type's, marked so (D72), not a phrase: renaming "depends on" keeps every one.
  const dependency = s.linkTypes.find((t) => t.dependency);
  const links = ids.length ? await ctx.db.select().from(issueLinks).where(inArray(issueLinks.sourceId, ids)) : [];
  const incoming = ids.length ? await ctx.db.select().from(issueLinks).where(inArray(issueLinks.targetId, ids)) : [];
  const parentOf = new Map<string, string>();
  for (const l of [...links, ...incoming]) if (aggregation.has(l.typeId) && rid.has(l.sourceId)) parentOf.set(l.targetId, l.sourceId);
  const predecessors = new Map<string, Set<string>>();
  const externalIds = new Set<string>();
  if (dependency) {
    for (const l of links) {
      if (l.typeId !== dependency.id) continue;
      // "source depends on target": target must finish first.
      const set = predecessors.get(l.sourceId) ?? new Set();
      set.add(l.targetId);
      predecessors.set(l.sourceId, set);
      if (!rid.has(l.targetId)) externalIds.add(l.targetId);
    }
  }
  if (externalIds.size) {
    // A dependency on an issue outside the plan is named only when the caller can see it: the
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
  const projectOf = new Map<string, string>();
  const tasks: PlanTaskInput[] = rows.map((r) => {
    const id = rid.get(r.id)!;
    refs.set(id, { id, summary: r.summary, resolved: r.resolvedAt !== null, state: states.get(r.id) ?? null });
    projectOf.set(id, r.projectId);
    const prio = val(r.id, fPriority?.id)?.valueId;
    const prioValue = prio ? s.values.get(prio) : undefined;
    priorityName.set(id, prioValue?.name ?? null);
    const typeValue = val(r.id, fType?.id)?.valueId;
    const parent = parentOf.get(r.id);
    return {
      id,
      summary: r.summary,
      parent: parent && inPlan.has(parent) ? rid.get(parent)! : null,
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
      // Each issue keeps its own project's calendar (D73).
      calendarId: planProjects.get(r.projectId)?.calendarId,
    };
  });

  const people = new Set<string>();
  for (const t of tasks) if (t.assigneeId) people.add(t.assigneeId);
  for (const w of work) if (w.authorId) people.add(w.authorId);
  // A team is more than who is busy (D43's revisit): each project's members who can change its issues
  // join the grid with their capacity, so a person with nothing planned is seen too.
  for (const id of await projectWorkers(ctx.db, [...planProjects.keys()])) people.add(id);
  const resources: PlanResource[] = [...people]
    .map((id) => s.users.get(id))
    .filter((u): u is NonNullable<typeof u> => Boolean(u))
    .map((u) => ({ id: u.id, login: u.login, name: u.name, capacityHoursPerDay: u.capacityHoursPerDay, hourlyRate: u.hourlyRate, week: u.workWeek }));
  const items: PlanWorkItem[] = work.map((w) => ({ taskId: rid.get(w.issueId)!, authorId: w.authorId, date: w.date, minutes: w.minutes, hourlyRate: w.hourlyRate }));

  const baseline = opts.baselineId ? await baselineOf(ctx, { s, view, savedSearch, project: scoped, rid }, opts.baselineId) : null;

  const today = opts.today ?? todayISO();
  // Each person's days away, so their work lands on the days they're there (D36).
  const away = await absencesForPlan(ctx.db, resources.map((r) => r.id), today);
  // The plan's own calendar is its own project's, else what a project starts with; each project with a task
  // in the plan brings its own, by its key (D73).
  const calendar = own ? projectSettings(own).plan : { ...DEFAULT_PLAN };
  const calendars = Object.fromEntries(withTasks.map((p) => [p.calendarId, p.calendar]));
  return {
    input: { today, calendar, calendars, tasks, resources, workItems: items, baseline, absences: away },
    scope,
    savedSearch,
    project: own,
    projects: planProjects,
    s,
    view,
    refs,
    rowsById: new Map(rows.map((r) => [rid.get(r.id)!, r])),
    projectOf,
    priorityName,
    total: picked.total,
    truncated: picked.total > rows.length,
  };
}

/**
 * The baseline a plan is compared with: one of its saved search's, or, for a project's scope read by query,
 * one of the project's. Any other is missing, in the words that say where the right ones are.
 */
async function baselineOf(
  ctx: Ctx,
  l: { s: SchemaSnapshot; view: AccessView; savedSearch: SavedSearchRow | null; project: ProjectRow | null; rid: Map<string, string> },
  baselineId: string,
): Promise<PlanBaseline> {
  const [b] = await ctx.db.select().from(baselines).where(eq(baselines.id, baselineId));
  if (l.savedSearch) {
    if (!b || b.savedSearchId !== l.savedSearch.id) {
      throw notFound('Baseline', `Baselines of this saved search: GET /saved-searches/${l.savedSearch.id}/baselines`).said('plans.baselineNotFoundList', { id: l.savedSearch.id });
    }
  } else if (l.project) {
    const key = l.project.key;
    if (!b || b.projectId !== l.project.id) throw notFound('Baseline', `Baselines of ${key}: GET /projects/${key}/baselines`).said('planning.baselineNotFoundList', { project: key });
  } else {
    throw notFound('Baseline').said('planning.baselineNotFound');
  }
  const rows = await ctx.db.select().from(baselineTasks).where(eq(baselineTasks.baselineId, b.id));
  // A saved search's baseline spans projects its readers may not all see: each reads it for what they see
  // (D37), so no date of what's hidden from them moves its finish. A project's is read whole, as it always was.
  const seen = l.savedSearch ? await baselineTasksSeen(ctx, l.view, rows) : null;
  // Its tasks keep the ids they had; the plan's read as the issues read now (a key renamed since, D52).
  return {
    id: b.id,
    name: b.name,
    tasks: rows.filter((t) => !seen || seen.has(t.issueId)).map((t) => ({ id: l.rid.get(t.issueId) ?? idWithKeyNow(l.s, t.readableId), start: t.start, finish: t.finish, effortMinutes: t.effortMinutes, cost: t.cost })),
  };
}

/**
 * Of a baseline's tasks, the issues the reader sees (D37): standing ones they see, and, of one deleted since,
 * those of a project whose every issue they see, as its managers do.
 */
export async function baselineTasksSeen(ctx: Ctx, view: AccessView, rows: readonly { issueId: string; projectId: string | null }[]): Promise<Set<string>> {
  const ids = [...new Set(rows.map((r) => r.issueId))];
  const standing = new Set(ids.length ? (await ctx.db.select({ id: issues.id }).from(issues).where(inArray(issues.id, ids))).map((r) => r.id) : []);
  const seen = await seenIssueIds(ctx, [...standing]);
  for (const r of rows) if (!standing.has(r.issueId) && r.projectId && view.seesAllIn(r.projectId)) seen.add(r.issueId);
  return seen;
}

/** A plan of one project, as today's routes read it (`/projects/{key}/…`): the scope `{project: key, query}`. */
export async function loadProjectPlan(ctx: Ctx, key: string, opts: PlanLoadOptions & { query?: string } = {}): Promise<ProjectLoaded> {
  const { query, ...rest } = opts;
  const l = await loadPlan(ctx, { query: query ?? '', project: key }, rest);
  return l as ProjectLoaded;
}
