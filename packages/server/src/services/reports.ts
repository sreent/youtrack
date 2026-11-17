/**
 * Reports, worked out on request from the activity log and the logged work (src/reports holds the
 * arithmetic): a sprint's burndown, cumulative flow, created against resolved, cycle time, and
 * time. Nothing is stored, so a report can't go stale; docs/architecture.md says why, and when
 * that should change.
 */
import {
  parsePeriod,
  WELL_KNOWN_FIELDS,
  type Burndown,
  type CreatedResolved,
  type CycleTime,
  type Flow,
  type Interval,
  type ProjectRef,
  type ReportScope,
  type TimeReport,
  type UserRef,
} from '@a4a/shared';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import { activities, boards, issueFieldValues, issues, sprintIssues, sprints, users, workItems } from '../db/schema';
import { addDays, addMonths, diffDays, isISODate, startOfMonth, startOfWeek } from '../lib/dates';
import { badRequest, notFound } from '../lib/errors';
import { addWorkingDays, listWorkingDays, normalizeCalendar } from '../planning/calendar';
import { burndown, createdResolved, cumulativeFlow, cycleTimes, histogram, percentile, type Bucket, type StateInfo } from '../reports/engine';
import { buildTimelines, insideDuring, leftSprint, type HistoryEvent, type Timeline } from '../reports/history';
import { dayBounds, startOfDay, timeZoneOrThrow, todayIn } from '../reports/tz';
import { compileOrThrow } from '../search/service';
import { issueSeenSql, projectAccess, requireProject, seenIssueIds, visibleProjectIds } from './access';
import { projectSettings } from './projects';
import { allowedValues, fieldByName, findUser, projectByKey, stateField, type ProjectRow, type SchemaSnapshot } from './schema-cache';
import { toneOf, userRefDto } from './values';

/** Past this many events a report asks for a narrower scope instead of working for minutes. */
const MAX_EVENTS = 400_000;
const MAX_WORK_ITEMS = 50_000;
const SHAPING = ['issue.created', 'issue.updated', 'issue.deleted'] as const;

// ---------------------------------------------------------------------------
// Scope: which issues, which projects
// ---------------------------------------------------------------------------

export interface Scope {
  projects: ProjectRow[];
  query: string | null;
  /** Activities of the issues in scope: by project (deleted issues too), or the issues a query matches now. */
  activityWhere: SQL;
  /** The issues in scope now, for logged work. */
  issueWhere: SQL;
  includesDeleted: boolean;
  /** Whether a project, by key, is one of the report's: where a moved issue counts (D41). */
  inScope: (projectKey: string) => boolean;
  /** The project asked for, if one was. */
  project: ProjectRow | null;
}

const keySet = (projects: ProjectRow[]) => {
  const keys = new Set(projects.map((p) => p.key.toUpperCase()));
  return (key: string) => keys.has(key.toUpperCase());
};

export function inList(column: SQL | typeof activities.projectId, values: string[]): SQL {
  if (!values.length) return sql`FALSE`;
  return sql`${column} IN (${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )})`;
}

export async function resolveScope(ctx: Ctx, s: SchemaSnapshot, input: { project?: string; query?: string }): Promise<Scope> {
  requireScope(ctx, 'read');
  const query = input.query?.trim() || null;
  // A project the caller can't see answers exactly as one that doesn't exist.
  const project = input.project?.trim() ? await requireProject(ctx, input.project, 'read') : undefined;
  const visibleProjects = async () => {
    const visible = await visibleProjectIds(ctx);
    return [...s.projects.values()].filter((p) => visible === null || visible.includes(p.id));
  };
  if (query) {
    const { compiled } = await compileOrThrow(ctx, query, { projectId: project?.id });
    const where = compiled.where ?? sql`TRUE`;
    const ids = sql`(SELECT issues.id FROM issues WHERE ${where})`;
    let projects: ProjectRow[];
    if (project) projects = [project];
    else {
      const rows = await ctx.db.selectDistinct({ id: issues.projectId }).from(issues).where(where);
      projects = rows.map((r) => s.projects.get(r.id)).filter((p): p is ProjectRow => Boolean(p));
    }
    // A matched issue counts on the days it was in a project the caller sees (the one asked for, if any).
    const inScope = keySet(project ? [project] : await visibleProjects());
    return { projects, query, activityWhere: sql`${activities.issueId} IN ${ids}`, issueWhere: sql`${issues.id} IN ${ids}`, includesDeleted: false, inScope, project: project ?? null };
  }
  const projects: ProjectRow[] = project ? [project] : await visibleProjects();
  const ids = projects.map((p) => p.id);
  // An issue moved away (D41) leaves: its move is filed under the project it went to, so read that too.
  const movedAway = sql`(${activities.type} = 'issue.moved' AND ${inList(
    sql`${activities.payload}->'data'->>'fromProject'`,
    projects.map((p) => p.key),
  )})`;
  // And what came before an issue moved in, so its values, standing and age are its own; while it
  // was elsewhere, it doesn't count.
  const movedIn = sql`${activities.issueId} IN (SELECT a2.issue_id FROM activities a2 WHERE a2.type = 'issue.moved' AND ${inList(sql`a2.project_id`, ids)})`;
  const inProjects = sql`(${inList(activities.projectId, ids)} OR ${movedAway} OR ${movedIn})`;
  // Issues limited away from the caller (D37) count for nothing here, as in a search; a deleted
  // issue's history still counts, as before.
  const view = await projectAccess(ctx);
  const seen = issueSeenSql(view, s, 'seen_ri');
  const issueSeen = issueSeenSql(view, s);
  return {
    projects,
    query: null,
    activityWhere: seen ? sql`(${inProjects} AND NOT EXISTS (SELECT 1 FROM issues seen_ri WHERE seen_ri.id = ${activities.issueId} AND NOT ${seen}))` : inProjects,
    issueWhere: issueSeen ? sql`(${inList(sql`${issues.projectId}`, ids)} AND ${issueSeen})` : inList(sql`${issues.projectId}`, ids),
    includesDeleted: true,
    inScope: keySet(projects),
    project: project ?? null,
  };
}

export const refOf = (p: ProjectRow): ProjectRef => ({ id: p.id, key: p.key, name: p.name });

/** Time logged counts only in projects whose role lets the caller see time and costs (D37). */
async function costsWhere(ctx: Ctx): Promise<SQL> {
  const view = await projectAccess(ctx);
  const visible = view.visibleIds();
  if (view.admin || visible === null) return sql`TRUE`;
  return inList(sql`${issues.projectId}`, visible.filter((id) => view.allows(id, 'costs')));
}

// ---------------------------------------------------------------------------
// Loading history
// ---------------------------------------------------------------------------

/** The names an estimate has gone by in history: the field's own and the well-known one. */
function estimateNames(s: SchemaSnapshot): string[] {
  const f = fieldByName(s, WELL_KNOWN_FIELDS.estimation);
  const out = new Set<string>([WELL_KNOWN_FIELDS.estimation]);
  if (f) out.add(f.name);
  for (const field of s.fields.values()) if (field.type === 'period' && field.name.toLowerCase().includes('estimat')) out.add(field.name);
  return [...out];
}

function minutesOf(text: string | null): number | null {
  if (text === null || text === undefined || text === '') return null;
  return parsePeriod(text);
}

function ms(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/**
 * Events that shape issues (created, changed, deleted) matching `where`, oldest first. Only the
 * parts of each payload a report reads leave the database; estimates only when asked for.
 */
/** What a burndown counts of an issue: its estimate in minutes, or a board's story points (D43). */
export interface Measure {
  /** The names the field has gone by in history. */
  names: string[];
  parse(value: unknown): number | null;
}

/** Story points, from the board's points field. */
export function pointsMeasure(name: string): Measure {
  return {
    names: [name],
    parse: (v) => {
      if (v === null || v === undefined || v === '') return null;
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    },
  };
}

export async function loadEvents(
  ctx: Ctx,
  s: SchemaSnapshot,
  where: SQL,
  opts: { sprintEvents?: boolean; estimates?: boolean; measure?: Measure; /** Follow this field's value, by name (D44). */ field?: string } = {},
): Promise<HistoryEvent[]> {
  const measure = opts.measure ?? { names: estimateNames(s), parse: (v: unknown) => minutesOf(v as string | null) };
  const names = measure.names;
  const est = names[0]!;
  const nameList = sql.join(
    names.map((n) => sql`${n}`),
    sql`, `,
  );
  const types = opts.sprintEvents ? [...SHAPING, 'issue.moved', 'sprint.issue_added', 'sprint.issue_removed'] : [...SHAPING, 'issue.moved'];
  const p = activities.payload;
  const field = opts.field;
  const rows = await ctx.db
    .select({
      id: activities.id,
      type: activities.type,
      at: activities.createdAt,
      rid: sql<string | null>`${p}->'issue'->>'id'`,
      summary: sql<string | null>`${p}->'issue'->>'summary'`,
      state: sql<string | null>`${p}->'issue'->>'state'`,
      resolved: sql<string | null>`${p}->'issue'->>'resolved'`,
      createdEstimate: opts.estimates ? sql<string | null>`CASE WHEN ${activities.type} = 'issue.created' THEN ${p}->'data'->'fields'->>${est} END` : sql<null>`NULL`,
      // The estimate's change, when the event has one: {"to": "2d"} (to may be null, when cleared).
      estimateChange: opts.estimates
        ? sql<{ to: string | null } | null>`CASE WHEN ${activities.type} = 'issue.updated' AND jsonb_typeof(${p}->'changes') = 'array' THEN (SELECT jsonb_build_object('to', c->'to') FROM jsonb_array_elements(${p}->'changes') c WHERE c->>'field' IN (${nameList}) LIMIT 1) END`
        : sql<null>`NULL`,
      importedCreated: sql<string | null>`CASE WHEN ${activities.type} = 'issue.created' THEN ${p}->'data'->'imported'->>'createdAt' END`,
      importedResolved: sql<string | null>`CASE WHEN ${activities.type} = 'issue.created' THEN ${p}->'data'->'imported'->>'resolvedAt' END`,
      sprintId: opts.sprintEvents ? sql<string | null>`${p}->'data'->>'sprintId'` : sql<null>`NULL`,
      // A move (D41): both ids and projects, the sprints it left, and when the issue was created.
      move: sql<MoveData | string | null>`CASE WHEN ${activities.type} = 'issue.moved' THEN jsonb_build_object('from', ${p}->'data'->'from', 'to', ${p}->'data'->'to', 'fromProject', ${p}->'data'->'fromProject', 'toProject', ${p}->'data'->'toProject', 'leftSprints', ${p}->'data'->'leftSprints', 'created', (SELECT i.created_at FROM issues i WHERE i.id = ${activities.issueId})) END`,
      value: field
        ? sql<{ to: string | null } | string | null>`CASE WHEN ${activities.type} = 'issue.created' THEN jsonb_build_object('to', ${p}->'data'->'fields'->${field}) WHEN jsonb_typeof(${p}->'changes') = 'array' THEN (SELECT jsonb_build_object('to', c->'to') FROM jsonb_array_elements(${p}->'changes') c WHERE c->>'field' = ${field} LIMIT 1) END`
        : sql<null>`NULL`,
    })
    .from(activities)
    .where(and(inArray(activities.type, types), where))
    .orderBy(asc(activities.id))
    .limit(MAX_EVENTS + 1);
  if (rows.length > MAX_EVENTS) {
    throw badRequest('This report would read more history than a4a reads at once', 'Narrow it: choose a project, or add a query.').said('reports.tooMuchHistory');
  }
  const out: HistoryEvent[] = [];
  for (const r of rows) {
    if (!r.rid) continue;
    const e: HistoryEvent = { id: Number(r.id), at: new Date(r.at).getTime(), type: r.type, rid: r.rid, summary: r.summary };
    if (r.type !== 'sprint.issue_added' && r.type !== 'sprint.issue_removed') {
      e.state = r.state;
      e.resolved = r.resolved === 'true';
    }
    if (r.type === 'issue.created') {
      if (opts.estimates) e.estimate = { minutes: measure.parse(r.createdEstimate) };
      const created = ms(r.importedCreated);
      if (created !== null) e.imported = { createdAt: created, resolvedAt: ms(r.importedResolved) };
    } else if (r.estimateChange) {
      const change = typeof r.estimateChange === 'string' ? (JSON.parse(r.estimateChange) as { to: string | null }) : r.estimateChange;
      e.estimate = { minutes: measure.parse(change.to) };
    }
    if (r.sprintId) e.sprintId = r.sprintId;
    if (r.move) {
      const m = (typeof r.move === 'string' ? JSON.parse(r.move) : r.move) as MoveData;
      if (m.from && m.to && m.fromProject && m.toProject) {
        e.move = { from: m.from, to: m.to, fromProject: m.fromProject, toProject: m.toProject, created: ms(m.created) };
        if (Array.isArray(m.leftSprints)) e.move.leftSprints = m.leftSprints.filter((x): x is string => typeof x === 'string');
      }
    }
    if (r.value) {
      const v = (typeof r.value === 'string' ? JSON.parse(r.value) : r.value) as { to: unknown };
      e.value = { to: typeof v.to === 'string' && v.to !== '' ? v.to : null };
    }
    out.push(e);
  }
  return out;
}

interface MoveData {
  from?: string;
  to?: string;
  fromProject?: string;
  toProject?: string;
  leftSprints?: unknown;
  created?: string | null;
}

/** The state an imported issue was in before its resolution: the project's default, or its first open state. */
export function openStates(s: SchemaSnapshot): (rid: string) => string | null {
  const sf = stateField(s);
  const cache = new Map<string, string | null>();
  return (rid) => {
    const key = rid.split('-')[0]!.toUpperCase();
    if (cache.has(key)) return cache.get(key)!;
    const project = s.projectsByKey.get(key);
    let name: string | null = null;
    if (project && sf) {
      const pf = (s.projectFields.get(project.id) ?? []).find((x) => x.fieldId === sf.id);
      if (typeof pf?.defaultValue === 'string') name = pf.defaultValue;
      name ??= allowedValues(s, sf.id, project.id).find((v) => !v.isResolved)?.name ?? null;
    }
    cache.set(key, name);
    return name;
  };
}

/** The state field's values in these projects, in workflow order: open ones first, then resolved. */
export function knownStates(s: SchemaSnapshot, projects: ProjectRow[]): StateInfo[] {
  const sf = stateField(s);
  if (!sf) return [];
  const seen = new Map<string, StateInfo & { ordinal: number }>();
  for (const p of projects) {
    for (const v of (s.valuesByField.get(sf.id) ?? []).filter((x) => x.projectId === null || x.projectId === p.id)) {
      const k = v.name.toLowerCase();
      if (!seen.has(k)) seen.set(k, { name: v.name, resolved: v.isResolved, tone: toneOf(v.tone), current: !v.archived, ordinal: v.ordinal });
    }
  }
  return [...seen.values()]
    .sort((a, b) => Number(a.resolved) - Number(b.resolved) || a.ordinal - b.ordinal)
    .map(({ ordinal: _o, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

export interface Window {
  tz: string;
  today: string;
  now: number;
  from: string;
  to: string;
}

export function windowOf(input: { from?: string; to?: string; timeZone?: string }, defaultDays: number, maxDays: number, now = Date.now()): Window {
  const tz = timeZoneOrThrow(input.timeZone);
  const today = todayIn(tz, now);
  for (const [name, v] of [['from', input.from], ['to', input.to]] as const) {
    if (v !== undefined && !isISODate(v)) throw badRequest(`"${name}" must be a date, YYYY-MM-DD`).said('reports.notADate', { name });
  }
  let to = input.to ?? today;
  if (to > today) to = today; // days to come have no figures yet
  const from = input.from ?? addDays(to, -(defaultDays - 1));
  if (from > to) throw badRequest(`"from" (${from}) is after "to" (${to})`, 'Swap them, or leave "to" out for today.').said('reports.fromAfterTo', { from, to });
  if (diffDays(from, to) + 1 > maxDays) throw badRequest(`That is ${diffDays(from, to) + 1} days; this report takes ${maxDays} at most`, 'Choose a shorter window.').said('reports.windowTooLong', { days: diffDays(from, to) + 1, maxDays });
  return { tz, today, now, from, to };
}

export function scopeDto(scope: Scope, w: Window, issueCount: number): ReportScope {
  return {
    projects: scope.projects.map(refOf),
    query: scope.query,
    issues: issueCount,
    includesDeleted: scope.includesDeleted,
    from: w.from,
    to: w.to,
    today: w.today,
    timeZone: w.tz,
  };
}

/** Issues that existed at some time in [start, end), in the report's projects. */
export function within(timelines: Iterable<Timeline>, start: number, end: number): Timeline[] {
  return [...timelines].filter((t) => t.start < end && (t.end === null || t.end >= start) && insideDuring(t, start, end));
}

// ---------------------------------------------------------------------------
// Cumulative flow
// ---------------------------------------------------------------------------

export interface WindowInput {
  project?: string;
  query?: string;
  from?: string;
  to?: string;
  timeZone?: string;
}

export async function flowReport(ctx: Ctx, input: WindowInput, now = Date.now()): Promise<Flow> {
  const s = await ctx.app.schema.get();
  const scope = await resolveScope(ctx, s, input);
  const w = windowOf(input, 30, 366, now);
  const bounds = dayBounds(w.from, w.to, w.tz);
  const timelines = buildTimelines(await loadEvents(ctx, s, scope.activityWhere), openStates(s), { inScope: scope.inScope });
  const counted = within(timelines.values(), bounds.starts[0]!, Math.min(bounds.ends[bounds.ends.length - 1]!, now + 1));
  const res = cumulativeFlow(counted, bounds, now, knownStates(s, scope.projects));
  return { scope: scopeDto(scope, w, counted.length), states: res.states, days: res.days, noState: res.noState };
}

// ---------------------------------------------------------------------------
// Created against resolved
// ---------------------------------------------------------------------------

export async function createdResolvedReport(ctx: Ctx, input: WindowInput & { interval?: Interval }, now = Date.now()): Promise<CreatedResolved> {
  const s = await ctx.app.schema.get();
  const scope = await resolveScope(ctx, s, input);
  const w = windowOf(input, 30, 3700, now);
  const span = diffDays(w.from, w.to) + 1;
  const interval: Interval = input.interval ?? (span <= 31 ? 'day' : span <= 182 ? 'week' : 'month');
  if (interval === 'day' && span > 366) throw badRequest(`By day, this report takes 366 days at most; that is ${span}`, 'Choose interval=week or month.').said('reports.byDayTooLong', { span });
  if (interval === 'week' && span > 1100) throw badRequest(`By week, this report takes about three years at most; that is ${span} days`, 'Choose interval=month.').said('reports.byWeekTooLong', { span });
  const buckets: Bucket[] = [];
  for (let d = w.from; d <= w.to; ) {
    const next = interval === 'day' ? addDays(d, 1) : interval === 'week' ? addDays(startOfWeek(d), 7) : addMonths(startOfMonth(d), 1);
    const last = addDays(next, -1) < w.to ? addDays(next, -1) : w.to;
    buckets.push({ from: d, to: last, start: startOfDay(d, w.tz), end: startOfDay(addDays(last, 1), w.tz) });
    d = next;
  }
  const timelines = buildTimelines(await loadEvents(ctx, s, scope.activityWhere), openStates(s), { inScope: scope.inScope });
  const counted = within(timelines.values(), buckets[0]!.start, Math.min(buckets[buckets.length - 1]!.end, now + 1));
  const rows = createdResolved(counted, buckets, now);
  const totals = rows.reduce((t, r) => ({ created: t.created + r.created, resolved: t.resolved + r.resolved, reopened: t.reopened + r.reopened }), {
    created: 0,
    resolved: 0,
    reopened: 0,
  });
  return { scope: scopeDto(scope, w, counted.length), interval, buckets: rows, totals };
}

// ---------------------------------------------------------------------------
// Cycle time
// ---------------------------------------------------------------------------

export async function cycleTimeReport(ctx: Ctx, input: WindowInput & { start?: string }, now = Date.now()): Promise<CycleTime> {
  const s = await ctx.app.schema.get();
  const scope = await resolveScope(ctx, s, input);
  const w = windowOf(input, 90, 1100, now);
  const startStates = (input.start ?? 'In Progress')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (!startStates.length) throw badRequest('Name at least one state that starts the clock', 'For example start=In Progress').said('reports.nameStartState');
  const known = knownStates(s, scope.projects);
  const unknown = startStates.filter((n) => !known.some((k) => k.name.toLowerCase() === n.toLowerCase()));
  if (unknown.length && known.length) {
    throw badRequest(`No state is called ${unknown.map((n) => `"${n}"`).join(', ')}`, `States: ${known.map((k) => k.name).join(', ')}`).said('reports.noSuchState', { unknown: unknown.map((n) => `"${n}"`).join(', '), states: known.map((k) => k.name).join(', ') });
  }
  const from = startOfDay(w.from, w.tz);
  const to = Math.min(startOfDay(addDays(w.to, 1), w.tz), now + 1);
  const timelines = buildTimelines(await loadEvents(ctx, s, scope.activityWhere), openStates(s), { inScope: scope.inScope });
  const res = cycleTimes(timelines.values(), from, to, startStates);
  const values = res.items.map((i) => i.days).sort((a, b) => a - b);
  const hist = histogram(values);
  const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
  return {
    scope: scopeDto(scope, w, res.items.length + res.notStarted.length),
    startStates: startStates.map((n) => known.find((k) => k.name.toLowerCase() === n.toLowerCase())?.name ?? n),
    count: values.length,
    percentiles: { p50: round1(percentile(values, 50)), p75: round1(percentile(values, 75)), p85: round1(percentile(values, 85)), p95: round1(percentile(values, 95)) },
    mean: values.length ? round1(values.reduce((a, b) => a + b, 0) / values.length) : null,
    bucketDays: hist.width,
    buckets: hist.buckets,
    issues: res.items.map((i) => ({
      issue: i.rid,
      summary: i.summary,
      started: new Date(i.started).toISOString(),
      resolved: new Date(i.resolved).toISOString(),
      days: i.days,
      reopened: i.reopened,
    })),
    notStarted: res.notStarted.map((i) => ({ issue: i.rid, summary: i.summary, resolved: new Date(i.resolved).toISOString() })),
  };
}

// ---------------------------------------------------------------------------
// Sprint burndown
// ---------------------------------------------------------------------------

type SprintRow = typeof sprints.$inferSelect;
type BoardRow = typeof boards.$inferSelect;

/**
 * The sprint asked for: by id, by name on a board, or a board's current one (as the board shows it).
 * A board is the caller's to see when any of its projects is, as on the board itself; one they can't
 * see, and its sprints, answer exactly as ones that don't exist.
 */
export async function findSprint(ctx: Ctx, input: { sprint?: string; board?: string }, today: string): Promise<{ sprint: SprintRow; board: BoardRow }> {
  const view = await projectAccess(ctx);
  const sees = (b: BoardRow) => b.projectIds.some((id) => view.canRead(id));
  const name = input.sprint?.trim();
  if (name) {
    const [byId] = await ctx.db.select().from(sprints).where(eq(sprints.id, name));
    if (byId) {
      const [board] = await ctx.db.select().from(boards).where(eq(boards.id, byId.boardId));
      if (board && sees(board)) return { sprint: byId, board };
    }
  }
  const boardName = input.board?.trim();
  if (!boardName) {
    throw badRequest(name ? `No sprint has the id "${name}"` : 'Say which sprint', 'Give a sprint id, or a board (its current sprint) and optionally the sprint\'s name.').said('reports.whichSprint', { asked: name ? 'yes' : 'no', name: name ?? '' });
  }
  const all = (await ctx.db.select().from(boards)).filter(sees);
  const board = all.find((b) => b.id === boardName) ?? all.find((b) => b.name.toLowerCase() === boardName.toLowerCase());
  if (!board) throw notFound(`Board ${boardName}`, `Boards: ${all.map((b) => b.name).join(', ') || 'none yet'}`).said('reports.boardNotFound', { name: boardName, n: all.length, boards: all.map((b) => b.name).join(', ') });
  const list = await ctx.db.select().from(sprints).where(eq(sprints.boardId, board.id)).orderBy(asc(sprints.startDate), asc(sprints.createdAt));
  if (!list.length) throw notFound(`A sprint on ${board.name}`, board.sprintsEnabled ? 'Plan a sprint on the board first.' : 'This board does not use sprints.').said('reports.noSprints', { board: board.name, sprints: board.sprintsEnabled ? 'on' : 'off' });
  if (name) {
    const sprint = list.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!sprint) throw notFound(`Sprint "${name}" on ${board.name}`, `Its sprints: ${list.map((x) => x.name).join(', ')}`).said('reports.sprintNotFound', { name, board: board.name, sprints: list.map((x) => x.name).join(', ') });
    return { sprint, board };
  }
  const sprint =
    list.find((x) => !x.archived && (x.startDate ?? '') <= today && (x.endDate ?? '9999') >= today) ?? list.filter((x) => !x.archived).at(-1) ?? list.at(-1)!;
  return { sprint, board };
}

/** Hours, as a burndown counts work: "68h", "4.5h". */
function hoursWords(minutes: number): string {
  const h = Math.round((minutes / 60) * 10) / 10;
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}

function amount(n: number, by: 'estimate' | 'count'): string {
  if (by === 'count') return `${Math.round(n)} ${Math.round(n) === 1 ? 'issue' : 'issues'}`;
  return n > 0 ? hoursWords(n) : 'nothing';
}

/** "1.5 issues", "3.5h": a pace, which a count may make a fraction of. */
function paceWords(n: number, by: 'estimate' | 'count'): string {
  if (by === 'estimate') return hoursWords(n);
  const r = Math.round(n * 10) / 10;
  return `${r} ${r === 1 ? 'issue' : 'issues'}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "3 Dec", with the year when it isn't this one. */
export function dayMonth(iso: string, today: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]}${String(y) === today.slice(0, 4) ? '' : ` ${y}`}`;
}

/**
 * A sprint's burndown as the engine works it out, from the history of the issues of `projects`
 * in it: shared by the burndown report and velocity (D43), which may count story points instead
 * of estimates (`measure`).
 */
export async function sprintBurn(
  ctx: Ctx,
  s: SchemaSnapshot,
  sprint: { id: string; name: string; startDate: string; endDate: string },
  projects: ProjectRow[],
  by: 'estimate' | 'count',
  tz: string,
  now: number,
  measure?: Measure,
) {
  const readable = projects.map((p) => p.id);
  // Who is in it now, and every record of joining or leaving it.
  const inSprint = await ctx.db
    .select({ id: issues.id, projectId: issues.projectId, number: issues.number, createdAt: issues.createdAt })
    .from(sprintIssues)
    .innerJoin(issues, eq(issues.id, sprintIssues.issueId))
    .where(and(eq(sprintIssues.sprintId, sprint.id), inList(sql`${issues.projectId}`, readable)));
  const records = await ctx.db
    .select({ issueId: activities.issueId, rid: sql<string | null>`${activities.payload}->'issue'->>'id'`, type: activities.type })
    .from(activities)
    .where(
      and(
        sql`${activities.payload}->'data'->>'sprintId' = ${sprint.id}`,
        sql`${activities.type} in ('sprint.issue_added', 'sprint.issue_removed')`,
        inList(activities.projectId, readable),
      ),
    )
    .orderBy(asc(activities.id));
  // An issue limited away from the caller (D37) counts for nothing here, as in the sprint's count:
  // not its points, not its changes, not its summary. A deleted issue's records still count.
  const seen = await seenIssueIds(ctx, [...inSprint.map((c) => c.id), ...records.flatMap((r) => (r.issueId ? [r.issueId] : []))]);
  const current = inSprint.filter((c) => seen.has(c.id));
  const sprintRows = records.filter((r) => !r.issueId || seen.has(r.issueId));
  const ridOf = (r: { projectId: string; number: number }) => `${s.projects.get(r.projectId)?.key ?? '?'}-${r.number}`;
  const liveIds = new Set(current.map((c) => c.id));
  const deletedRids = new Set<string>();
  for (const r of sprintRows) {
    if (r.issueId) liveIds.add(r.issueId);
    else if (r.rid) deletedRids.add(r.rid);
  }
  const conds: SQL[] = [];
  if (liveIds.size) conds.push(inList(sql`${activities.issueId}`, [...liveIds]));
  if (deletedRids.size) {
    conds.push(and(inList(activities.projectId, readable), inList(sql`${activities.payload}->'issue'->>'id'`, [...deletedRids]))!);
  }
  const events = conds.length
    ? await loadEvents(ctx, s, conds.length === 1 ? conds[0]! : sql`(${sql.join(conds, sql` OR `)})`, { sprintEvents: true, estimates: true, measure })
    : [];
  const timelines = buildTimelines(events, openStates(s));
  // A move that left this sprint (D41) names it, not its id: file it under the sprint's.
  const leftThis = leftSprint(sprint.name);
  for (const t of timelines.values()) for (const e of t.sprints) if (e.sprintId === leftThis) e.sprintId = sprint.id;

  const start = startOfDay(sprint.startDate, tz);
  const end = startOfDay(addDays(sprint.endDate, 1), tz);
  // In the sprint now with no record of joining (or leaving first): joined before records were kept.
  const firstRecord = new Map<string, string>();
  for (const r of sprintRows) if (r.rid && !firstRecord.has(r.rid)) firstRecord.set(r.rid, r.type);
  const legacy = new Map<string, number>();
  const since = Math.min(start, now) - 1;
  for (const c of current) if (!firstRecord.has(ridOf(c))) legacy.set(ridOf(c), since);
  for (const [rid, type] of firstRecord) if (type === 'sprint.issue_removed') legacy.set(rid, since);
  for (const c of current) {
    const rid = ridOf(c);
    if (!timelines.has(rid)) {
      // No history at all (it predates the log): it existed, as it is now, from its creation.
      timelines.set(rid, { rid, summary: '', start: c.createdAt.getTime(), end: null, standings: [{ at: c.createdAt.getTime(), state: null, resolved: false }], estimates: [], sprints: [], outside: [], bornInside: true, values: [], projects: [{ at: c.createdAt.getTime(), key: rid.split('-')[0]! }] });
    }
  }

  const cal = normalizeCalendar(projectSettings(projects[0] ?? ({ settings: {} } as ProjectRow)).plan);
  let workDates = listWorkingDays(cal, sprint.startDate, sprint.endDate);
  const warnings: string[] = [];
  if (!workDates.length) {
    workDates = dayBounds(sprint.startDate, sprint.endDate, tz).dates;
    warnings.push('The sprint has no working days in the project calendar, so every day of it is counted.');
  }
  const days = workDates.map((date) => ({ date, start: startOfDay(date, tz), end: startOfDay(addDays(date, 1), tz) }));
  const res = burndown({ timelines: [...timelines.values()], sprintId: sprint.id, legacy, days, start, end, now, by });
  return { res, workDates, warnings, current, sprintRows, days, start, end, cal, legacy, timelines };
}

export async function burndownReport(ctx: Ctx, input: { sprint?: string; board?: string; by?: 'estimate' | 'count'; timeZone?: string }, now = Date.now()): Promise<Burndown> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const tz = timeZoneOrThrow(input.timeZone);
  const today = todayIn(tz, now);
  const by = input.by ?? 'estimate';
  const { sprint, board } = await findSprint(ctx, input, today);
  // As the board shows it: the issues of the projects the caller can read, and no others.
  const view = await projectAccess(ctx);
  const readable = board.projectIds.filter((id) => view.canRead(id));
  if (!sprint.startDate || !sprint.endDate) {
    throw badRequest(`${sprint.name} has no ${sprint.startDate ? 'end' : 'start'} date`, `Give it its dates (PATCH /sprints/${sprint.id}) to see its burndown.`).said('reports.sprintMissingDate', { sprint: sprint.name, missing: sprint.startDate ? 'end' : 'start', id: sprint.id });
  }
  if (sprint.endDate < sprint.startDate) throw badRequest(`${sprint.name} ends before it starts`, 'Correct its dates.').said('reports.sprintEndsFirst', { sprint: sprint.name });
  if (diffDays(sprint.startDate, sprint.endDate) > 366) throw badRequest(`${sprint.name} is longer than a year`, 'A burndown is for a sprint of days or weeks.').said('reports.sprintTooLong', { sprint: sprint.name });
  const projects = readable.map((id) => s.projects.get(id)).filter((p): p is ProjectRow => Boolean(p));

  const { res, workDates, warnings, current, sprintRows, days, start, end, cal, legacy, timelines } = await sprintBurn(ctx, s, { ...sprint, startDate: sprint.startDate, endDate: sprint.endDate }, projects, by, tz, now);

  // Spent time: work logged on the sprint's issues on its days.
  const memberIds = current.map((c) => c.id);
  for (const r of sprintRows) if (r.issueId) memberIds.push(r.issueId);
  const spentRows = memberIds.length
    ? await ctx.db
        .select({ date: workItems.date, minutes: sql<number>`sum(${workItems.minutes})::int` })
        .from(workItems)
        .where(and(inArray(workItems.issueId, [...new Set(memberIds)]), sql`${workItems.date} >= ${sprint.startDate}`, sql`${workItems.date} <= ${sprint.endDate}`))
        .groupBy(workItems.date)
    : [];
  const spentByDate = new Map(spentRows.map((r) => [r.date, Number(r.minutes)]));
  // Work logged on a day off counts on the next working day, as changes do.
  const spentDays = res.days.map(() => 0);
  for (const [date, minutes] of spentByDate) {
    const k = workDates.findIndex((d) => d >= date);
    if (k >= 0) spentDays[k]! += minutes;
  }

  const unit = by === 'count' ? 'issues' : 'minutes';
  const completed = res.days.reduce((n, d) => n + d.completed, 0);
  const reopened = res.days.reduce((n, d) => n + d.reopened, 0);
  const added = res.days.reduce((n, d) => n + d.added, 0);
  const removed = res.days.reduce((n, d) => n + d.removed, 0);
  const elapsed = days.filter((d) => d.start <= now).length;
  const ended = days.filter((d) => d.end <= now).length;
  const left = days.filter((d) => d.start > now).length;
  const n = days.length;
  const idealNow = n ? Math.round(res.start * (1 - ended / n) * 100) / 100 : 0;
  const pace = elapsed ? (completed - reopened) / elapsed : 0;
  const todayStr = (iso: string) => dayMonth(iso, today);

  let verdict: Burndown['status']['verdict'];
  let words: string;
  let forecastEnd: string | null = null;
  const toGo = `${left} working ${left === 1 ? 'day' : 'days'} to go.`;
  if (!res.members.length) {
    verdict = 'empty';
    words = 'There are no issues in this sprint yet.';
  } else if (now < start) {
    verdict = 'not_started';
    words = `Starts on ${todayStr(sprint.startDate)}, with ${amount(res.remaining, by)} in it so far.`;
  } else if (res.open === 0) {
    verdict = 'done';
    words = `Done: everything in the sprint is resolved${now >= end || !left ? '.' : `, with ${left} working ${left === 1 ? 'day' : 'days'} to spare.`}`;
  } else if (now >= end) {
    verdict = 'ended';
    words = `Ended on ${todayStr(sprint.endDate)} with ${amount(res.remaining, by)} of ${amount(res.start + added - removed, by)} left.`;
  } else {
    const tolerance = Math.max(res.start * 0.1, by === 'count' ? 1 : 60);
    if (pace > 0) {
      const needed = Math.ceil(res.remaining / pace);
      forecastEnd = addWorkingDays(cal, today, Math.max(0, needed - (days.some((d) => d.date === today) ? 1 : 0)));
    }
    // Measured against the ideal as today began, so a morning isn't behind for not yet doing the day's work.
    const lead = `${amount(res.remaining, by)} left, where the ideal had ${amount(idealNow, by)} left as today began`;
    if (res.remaining > idealNow + tolerance) {
      verdict = 'behind';
      if (forecastEnd) {
        const late = forecastEnd > sprint.endDate;
        words = `Behind: ${lead}. At the pace so far, ${paceWords(pace, by)} a day, the rest would be done by ${todayStr(forecastEnd)}${late ? ', after the sprint ends' : ''}.`;
      } else words = `Behind: ${lead}, and ${by === 'estimate' ? 'no estimated work' : 'nothing'} has been resolved yet. ${toGo}`;
    } else if (res.remaining < idealNow - tolerance) {
      verdict = 'ahead';
      words = `Ahead: ${lead}. ${toGo}`;
    } else {
      verdict = 'on_track';
      words = `On track: ${lead}. ${toGo}`;
    }
    if (by === 'estimate' && res.unestimated.length) {
      words += ` ${res.unestimated.length} open ${res.unestimated.length === 1 ? 'issue has' : 'issues have'} no estimate.`;
    }
  }
  if (res.unestimated.length && by === 'estimate') {
    warnings.push(`${res.unestimated.length} ${res.unestimated.length === 1 ? 'issue has' : 'issues have'} no estimate, so ${res.unestimated.length === 1 ? 'it counts' : 'they count'} as nothing by estimate: ${res.unestimated.slice(0, 10).join(', ')}${res.unestimated.length > 10 ? '…' : ''}.`);
  }
  if (legacy.size) {
    warnings.push(`${legacy.size} ${legacy.size === 1 ? 'issue joined' : 'issues joined'} the sprint before a4a kept a record of it; ${legacy.size === 1 ? 'it counts' : 'they count'} from the sprint's start.`);
  }

  return {
    sprint: { id: sprint.id, name: sprint.name, goal: sprint.goal, startDate: sprint.startDate, endDate: sprint.endDate, board: { id: board.id, name: board.name } },
    projects: projects.map(refOf),
    by,
    unit,
    timeZone: tz,
    today,
    start: res.start,
    remaining: res.remaining,
    completed: Math.round(completed * 100) / 100,
    added: Math.round(added * 100) / 100,
    removed: Math.round(removed * 100) / 100,
    workingDays: n,
    workingDaysLeft: left,
    days: res.days.map((d, i) => ({ ...d, spentMinutes: spentDays[i] ?? 0 })),
    status: { verdict, words, idealNow: now >= start && now < end ? idealNow : null, forecastEnd },
    changes: res.changes.map((c) => ({
      at: new Date(c.at).toISOString(),
      date: todayIn(tz, c.at),
      issue: c.rid,
      summary: timelines.get(c.rid)?.summary ?? '',
      kind: c.kind,
      amount: Math.round(c.amount * 100) / 100,
    })),
    unestimated: res.unestimated,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export async function timeReport(ctx: Ctx, input: { project?: string; query?: string; from?: string; to?: string; author?: string }, now = Date.now()): Promise<TimeReport> {
  const s = await ctx.app.schema.get();
  const scope = await resolveScope(ctx, s, input);
  const w = windowOf({ ...input, to: input.to }, 28, 366, now);
  let author: UserRef | null = null;
  const conds: SQL[] = [scope.issueWhere, await costsWhere(ctx), sql`${workItems.date} >= ${w.from}`, sql`${workItems.date} <= ${w.to}`];
  if (input.author?.trim()) {
    const u = findUser(s, input.author, ctx.actor.user.id);
    if (!u) throw notFound(`User ${input.author}`, 'Use a login, a full name, or "me".').said('reports.authorNotFound', { author: input.author });
    author = userRefDto(u);
    conds.push(eq(workItems.authorId, u.id));
  }
  const rows = await ctx.db
    .select({
      minutes: workItems.minutes,
      date: workItems.date,
      authorId: workItems.authorId,
      issueId: issues.id,
      projectId: issues.projectId,
      number: issues.number,
      summary: issues.summary,
      resolvedAt: issues.resolvedAt,
    })
    .from(workItems)
    .innerJoin(issues, eq(issues.id, workItems.issueId))
    .where(and(...conds))
    .limit(MAX_WORK_ITEMS + 1);
  if (rows.length > MAX_WORK_ITEMS) throw badRequest('That is more logged work than a4a reports at once', 'Choose a shorter window, a project or a person.').said('reports.tooMuchWork');

  const weeks: string[] = [];
  for (let d = startOfWeek(w.from); d <= w.to; d = addDays(d, 7)) weeks.push(d);
  const group = <K extends string>(keyOf: (r: (typeof rows)[number]) => K, label: (k: K) => string) => {
    const m = new Map<K, { minutes: number; entries: number }>();
    for (const r of rows) {
      const k = keyOf(r);
      const g = m.get(k) ?? { minutes: 0, entries: 0 };
      g.minutes += r.minutes;
      g.entries++;
      m.set(k, g);
    }
    return [...m.entries()].map(([key, g]) => ({ key, label: label(key), minutes: g.minutes, entries: g.entries }));
  };
  const personLabel = (id: string) => {
    const u = s.users.get(id);
    return u ? (u.isBot ? u.login : u.name) : 'Someone no longer here';
  };
  const byPerson = group((r) => r.authorId ?? '', (k) => (k ? personLabel(k) : 'Someone no longer here'))
    .map((g) => ({ ...g, user: g.key && s.users.get(g.key) ? userRefDto(s.users.get(g.key)!) : null }))
    .sort((a, b) => b.minutes - a.minutes);
  const byProject = group((r) => r.projectId, (k) => s.projects.get(k)?.key ?? '?').sort((a, b) => b.minutes - a.minutes);
  const byWeek = group((r) => startOfWeek(r.date), (k) => `Week of ${dayMonth(k, w.today)}`)
    .map((g) => ({ ...g, from: g.key }))
    .sort((a, b) => a.key.localeCompare(b.key));

  // Estimate against spent, per issue: spent in the window, spent all told, and the estimate.
  const issueIds = [...new Set(rows.map((r) => r.issueId))];
  const est = fieldByName(s, WELL_KNOWN_FIELDS.estimation);
  const [totals, estimates] = issueIds.length
    ? await Promise.all([
        ctx.db
          .select({ issueId: workItems.issueId, minutes: sql<number>`sum(${workItems.minutes})::int` })
          .from(workItems)
          .where(inArray(workItems.issueId, issueIds))
          .groupBy(workItems.issueId),
        est
          ? ctx.db
              .select({ issueId: issueFieldValues.issueId, minutes: issueFieldValues.numberValue })
              .from(issueFieldValues)
              .where(and(eq(issueFieldValues.fieldId, est.id), inArray(issueFieldValues.issueId, issueIds)))
          : Promise.resolve([] as { issueId: string; minutes: number | null }[]),
      ])
    : [[], []];
  const spentAll = new Map(totals.map((t) => [t.issueId, Number(t.minutes)]));
  const estimateOf = new Map(estimates.map((e) => [e.issueId, e.minutes]));
  const perIssue = new Map<string, (typeof rows)[number] & { window: number }>();
  for (const r of rows) {
    const cur = perIssue.get(r.issueId);
    if (cur) cur.window += r.minutes;
    else perIssue.set(r.issueId, { ...r, window: r.minutes });
  }
  const byIssue = [...perIssue.values()]
    .map((r) => {
      const estimate = estimateOf.get(r.issueId);
      const spent = spentAll.get(r.issueId) ?? r.window;
      return {
        issue: `${s.projects.get(r.projectId)?.key ?? '?'}-${r.number}`,
        summary: r.summary,
        project: s.projects.get(r.projectId)?.key ?? '?',
        minutes: r.window,
        spentMinutes: spent,
        estimateMinutes: estimate === null || estimate === undefined ? null : Math.round(estimate),
        overMinutes: estimate === null || estimate === undefined ? null : Math.max(0, spent - Math.round(estimate)),
        resolved: r.resolvedAt !== null,
      };
    })
    .sort((a, b) => b.minutes - a.minutes);

  const matrix = byPerson.map((p) => ({
    user: p.user,
    label: p.label,
    minutes: weeks.map((wk) => rows.filter((r) => (r.authorId ?? '') === p.key && startOfWeek(r.date) === wk).reduce((n, r) => n + r.minutes, 0)),
  }));

  return {
    projects: scope.projects.map(refOf),
    query: scope.query,
    from: w.from,
    to: w.to,
    author,
    totalMinutes: rows.reduce((n, r) => n + r.minutes, 0),
    entries: rows.length,
    byPerson,
    byProject,
    byWeek,
    byIssue,
    weeks,
    matrix,
  };
}

/** Each work item in scope, for a time report's CSV of entries. */
export async function timeEntries(ctx: Ctx, input: { project?: string; query?: string; from?: string; to?: string; author?: string }, now = Date.now()) {
  const s = await ctx.app.schema.get();
  const scope = await resolveScope(ctx, s, input);
  const w = windowOf(input, 28, 366, now);
  const conds: SQL[] = [scope.issueWhere, await costsWhere(ctx), sql`${workItems.date} >= ${w.from}`, sql`${workItems.date} <= ${w.to}`];
  if (input.author?.trim()) {
    const u = findUser(s, input.author, ctx.actor.user.id);
    if (!u) throw notFound(`User ${input.author}`).said('notFound.user', { id: input.author });
    conds.push(eq(workItems.authorId, u.id));
  }
  const rows = await ctx.db
    .select({
      date: workItems.date,
      minutes: workItems.minutes,
      description: workItems.description,
      login: users.login,
      name: users.name,
      projectId: issues.projectId,
      number: issues.number,
      summary: issues.summary,
    })
    .from(workItems)
    .innerJoin(issues, eq(issues.id, workItems.issueId))
    .leftJoin(users, eq(users.id, workItems.authorId))
    .where(and(...conds))
    .orderBy(asc(workItems.date), asc(issues.number))
    .limit(MAX_WORK_ITEMS + 1);
  if (rows.length > MAX_WORK_ITEMS) throw badRequest('That is more logged work than a4a exports at once', 'Choose a shorter window, a project or a person.').said('reports.tooMuchWorkToExport');
  return {
    from: w.from,
    to: w.to,
    rows: rows.map((r) => ({ ...r, project: s.projects.get(r.projectId)?.key ?? '?', issue: `${s.projects.get(r.projectId)?.key ?? '?'}-${r.number}` })),
  };
}
