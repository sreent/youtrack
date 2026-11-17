/**
 * Planning sprints from a board (docs/architecture.md, D43): its backlog in rank order, ranking (on
 * the board too, D53), story points, velocity, and a sprint’s load against what its people can work.
 */
import { WELL_KNOWN_FIELDS, type Backlog, type Change, type Issue, type RankInput, type SprintPlan, type Velocity } from '@a4a/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { boardRanks, boards, issues, sprintIssues, sprints, users, workItems } from '../db/schema';
import { publishActivities, recordActivity, type ActivityRow } from '../events/activity';
import { diffDays } from '../lib/dates';
import { badRequest, notFound } from '../lib/errors';
import { availabilities } from '../planning/availability';
import { listWorkingDays, normalizeCalendar } from '../planning/calendar';
import type { PlanResource } from '../planning/types';
import { todayIn } from '../reports/tz';
import { searchIssueRows } from '../search/service';
import { absencesForPlan } from './absences';
import { assertCanWriteProject, projectAccess } from './access';
import { MAX_BOARD_ISSUES, boardCardRows, boardSprintRows, loadBoard, loadSprint, pointsOf, rankRows, shownSprint, sprintDtos, sumPoints, type BoardRow } from './boards';
import { issueRefsById, readableId, type IssueRow } from './issue-refs';
import { applyChanges, fieldValuesOf, issueDtos, resolveFieldsInput, resolveIssue, type FieldChangeSpec } from './issues';
import { projectSettings } from './projects';
import { pointsMeasure, sprintBurn } from './reports';
import { allowedValues, fieldByName, type ProjectRow, type SchemaSnapshot } from './schema-cache';
import { zoneOf } from './time-zones';
import { userRefDto, type ResolvedValue } from './values';

/** What a backlog holds when its board doesn't say. */
export const DEFAULT_BACKLOG_QUERY = '#Unresolved';
/** Gaps between ranks: room for many moves before the board's ranks are renumbered. */
const RANK_STEP = 1024;
/** The sprints a velocity chart shows, at most: the latest. */
const VELOCITY_SPRINTS = 12;

/**
 * The backlog's issues: the board's backlog query in the projects the caller can read, without the
 * issues of its open sprints (not archived, and not over), in rank order.
 */
async function backlogRows(ctx: Ctx, board: BoardRow): Promise<{ rows: IssueRow[]; ranks: Map<string, number>; total: number; query: string }> {
  const view = await projectAccess(ctx);
  const readable = board.projectIds.filter((id) => view.canRead(id));
  const query = board.backlogQuery ?? DEFAULT_BACKLOG_QUERY;
  const today = todayIn(zoneOf(ctx));
  const extraWhere = sql`NOT EXISTS (SELECT 1 FROM sprint_issues si JOIN sprints sp ON sp.id = si.sprint_id WHERE si.issue_id = issues.id AND sp.board_id = ${board.id} AND NOT sp.archived AND (sp.end_date IS NULL OR sp.end_date >= ${today}))`;
  const found = await searchIssueRows(ctx, query, { projectIds: readable, extraWhere, limit: MAX_BOARD_ISSUES });
  const { rows, ranks } = await rankRows(ctx.db, board.id, found.rows);
  return { rows, ranks, total: found.total, query };
}

export async function getBacklog(ctx: Ctx, boardId: string): Promise<Backlog> {
  requireScope(ctx, 'read');
  const board = await loadBoard(ctx, boardId);
  const { rows, ranks, total, query } = await backlogRows(ctx, board);
  const items = await issueDtos(ctx, rows);
  const rankedIds = new Set(rows.filter((r) => ranks.has(r.id)).map((r) => r.id));
  return {
    query,
    issues: items,
    ranked: items.filter((i) => rankedIds.has(i.uid)).map((i) => i.id),
    count: total,
    points: sumPoints(items, board.pointsFieldId),
  };
}

/** What ranking an issue did, or would do (a dry run): its fields' changes, and whether its place moved. */
export interface RankOutcome {
  /** The board's column field, and its swimlane's, when its card went into another column or lane (D53). */
  changes: Change[];
  /** Whether its place in the board's order changed: not when it was already there, or kept its place. */
  placed: boolean;
}

interface StoredColumn {
  name: string;
  valueIds: string[];
}

/**
 * Where an issue goes among a board's ranks (D43): the ranks to write to put it just after or
 * just before the anchor, or at the top without one. `order` is the board's ranked issues, lowest
 * first. Ranks are numbers with gaps, and a move takes the middle of the gap. An anchor without a
 * rank first gives itself, and those without one shown above it, places after the ranked ones, in
 * the order shown, so nothing on the screen jumps. When the gap is too small for a double to
 * split, every rank on the board is spaced out again, in the order they're in.
 */
export function placeAmong(order: readonly { id: string; rank: number }[], issueId: string, anchor: string | null, side: 'after' | 'before', shown: readonly string[] | null): Map<string, number> {
  const list = order.filter((o) => o.id !== issueId);
  const writes = new Map<string, number>();
  if (anchor && !list.some((o) => o.id === anchor)) {
    const ranked = new Set(list.map((o) => o.id));
    const seen = (shown ?? []).filter((id) => id !== issueId);
    const at = seen.indexOf(anchor);
    const run = at >= 0 ? seen.slice(0, at + 1).filter((id) => !ranked.has(id)) : [anchor];
    let last = list.at(-1)?.rank ?? 0;
    for (const id of run) {
      last += RANK_STEP;
      list.push({ id, rank: last });
      writes.set(id, last);
    }
  }
  const i = anchor ? list.findIndex((o) => o.id === anchor) : -1;
  const pos = !anchor ? 0 : side === 'after' ? i + 1 : i;
  const prev = list[pos - 1]?.rank;
  const next = list[pos]?.rank;
  let rank = prev === undefined && next === undefined ? RANK_STEP : prev === undefined ? next! - RANK_STEP : next === undefined ? prev + RANK_STEP : (prev + next) / 2;
  const fits = Number.isFinite(rank) && (prev === undefined || rank > prev) && (next === undefined || rank < next);
  if (!fits) {
    // No room left between its neighbours (or two share a rank): space the board's ranks out again.
    list.splice(pos, 0, { id: issueId, rank: 0 });
    list.forEach((o, k) => writes.set(o.id, (k + 1) * RANK_STEP));
    rank = (pos + 1) * RANK_STEP;
  }
  writes.set(issueId, rank);
  return writes;
}

/** Whether the issue already sits where it's asked to go: just after or before the anchor, or first. */
function alreadyThere(order: readonly { id: string; rank: number }[], issueId: string, anchor: string | null, side: 'after' | 'before'): boolean {
  const at = order.findIndex((o) => o.id === issueId);
  if (at < 0) return false;
  const me = order[at]!.rank;
  if (!anchor) return at === 0 && (order[1]?.rank ?? Infinity) > me;
  const other = side === 'after' ? order[at - 1] : order[at + 1];
  return other?.id === anchor && (side === 'after' ? other.rank < me : other.rank > me);
}

/** A board's column by its name, as people and agents say it. */
function columnNamed(board: BoardRow, name: string): StoredColumn {
  const stored = board.columns as StoredColumn[];
  const found = stored.find((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (!found) {
    const names = stored.map((c) => c.name).join(', ');
    throw badRequest(`This board has no column "${name.trim()}"`, `Its columns: ${names}`).said('agile.noSuchColumn', { name: name.trim(), names });
  }
  return found;
}

/** The value a card's lane shows: a person's login, a value's name, or none. */
function laneValueOf(s: SchemaSnapshot, values: readonly ResolvedValue[]): string | null {
  const v = values[0];
  if (!v) return null;
  if (v.userId) return s.users.get(v.userId)?.login ?? null;
  if (v.valueId) return s.values.get(v.valueId)?.name ?? null;
  return v.textValue ?? null;
}

/**
 * What moving a card on the board writes to its issue (D53): the board's column field, when the
 * card goes into another column, as the first of that column's values its project has; and the
 * swimlane's field, into another lane. A card dropped in the column it's in keeps its value there,
 * so one in a Done column of Fixed and Won't fix stays Won't fix. Read inside the transaction.
 */
async function cardFields(tx: Db, ctx: Ctx, s: SchemaSnapshot, board: BoardRow, issue: IssueRow, column: StoredColumn | null, lane: string | null | undefined): Promise<FieldChangeSpec[]> {
  const project = s.projects.get(issue.projectId)!;
  const current = await fieldValuesOf(tx, issue.id);
  const input: Record<string, string | null> = {};
  const columnField = board.columnFieldId ? s.fields.get(board.columnFieldId) : undefined;
  if (column && columnField && !(current.get(columnField.id) ?? []).some((v) => v.valueId && column.valueIds.includes(v.valueId))) {
    const own = new Set(allowedValues(s, columnField.id, issue.projectId).map((v) => v.id));
    const valueId = column.valueIds.find((id) => own.has(id));
    const id = readableId(s, issue);
    if (!valueId) {
      throw badRequest(`${id} can't go into ${column.name}: none of its values are ${project.key}'s`, `Add a value of ${project.key}'s ${columnField.name} to the column in the board's settings.`).said(
        'agile.columnNotForProject',
        { id, column: column.name, key: project.key, field: columnField.name },
      );
    }
    input[columnField.name] = s.values.get(valueId)!.name;
  }
  const laneField = board.swimlaneFieldId ? s.fields.get(board.swimlaneFieldId) : undefined;
  if (lane !== undefined && laneField) {
    const now = laneValueOf(s, current.get(laneField.id) ?? []);
    if ((now ?? '').toLowerCase() !== (lane ?? '').toLowerCase()) input[laneField.name] = lane;
  }
  return resolveFieldsInput(s, project, input, ctx.actor.user.id, todayIn(zoneOf(ctx)), zoneOf(ctx));
}

/** Rows written a thousand at a time, so a board of any size stays within a statement's parameters. */
const WRITE_CHUNK = 1000;

/**
 * Puts an issue just after or just before another in the board's order, or at the top (D43); and,
 * on the board itself (D53), into a column and a lane too, all in one transaction. The column
 * field's change goes through applyChanges, so a state machine, a guard or a field's condition
 * that refuses it refuses the move whole, and the issue keeps its place.
 *
 * - The board's row is locked for the move (FOR NO KEY UPDATE), so two people ranking at once each
 *   place their issue among the ranks the other left, and a respacing never crosses a move.
 * - On the board, with neither after nor before, the issue keeps its place: it shows in its new
 *   column where the board's order puts it.
 * - An anchor without a rank is placed among what was shown: the board's cards in the sprint
 *   shown, or the backlog. That's read before the transaction (the search runs on its own
 *   connection; PGlite has one), and only issues that still exist are written.
 */
export async function rankIssue(ctx: Ctx, boardId: string, input: RankInput, opts: { dryRun?: boolean } = {}): Promise<RankOutcome> {
  requireScope(ctx, opts.dryRun ? 'read' : 'write');
  const board = await loadBoard(ctx, boardId);
  const s = await ctx.app.schema.get();
  const onBoard = async (id: string) => {
    const row = await resolveIssue(ctx, id);
    if (!board.projectIds.includes(row.projectId)) throw badRequest(`${id.toUpperCase()} isn't on this board`, 'Only issues of the board’s projects have a place on it.').said('agile.notOnBoard', { id: id.toUpperCase() });
    return row;
  };
  if (input.after && input.before) throw badRequest('Say where with after or before, not both').said('agile.afterOrBefore');
  const issue = await onBoard(input.issue);
  // Placing an issue is work on it (D43): its project's edit permission, as the backlog's. A change of
  // column asks more, through applyChanges below: what its state machine, guards and conditions allow.
  if (!opts.dryRun) await assertCanWriteProject(ctx, issue.projectId);
  const anchorInput = input.after ?? input.before ?? null;
  const anchor = anchorInput ? await onBoard(anchorInput) : null;
  if (anchor?.id === issue.id) throw badRequest('An issue can’t be placed next to itself').said('agile.nextToItself');
  const side = input.after ? 'after' : 'before';
  const onTheBoard = input.column !== undefined || input.lane !== undefined || input.sprint !== undefined;
  const column = input.column !== undefined ? columnNamed(board, input.column) : null;
  if (input.lane !== undefined && !board.swimlaneFieldId) {
    throw badRequest('This board has no swimlanes', 'Choose a swimlane field in the board’s settings, or leave the lane out.').said('agile.noLanes');
  }
  const sprint = onTheBoard && board.sprintsEnabled ? shownSprint(board, await boardSprintRows(ctx.db, board.id), input.sprint) : null;
  const keepPlace = onTheBoard && !anchor;
  const anchorRanked = anchor
    ? (await ctx.db.select({ issueId: boardRanks.issueId }).from(boardRanks).where(and(eq(boardRanks.boardId, board.id), eq(boardRanks.issueId, anchor.id)))).length > 0
    : true;
  const shown =
    anchor && !anchorRanked && !opts.dryRun
      ? onTheBoard
        ? (await boardCardRows(ctx, board, await projectAccess(ctx), sprint?.id ?? null)).map((r) => r.id)
        : (await backlogRows(ctx, board)).rows.map((r) => r.id)
      : null;

  if (opts.dryRun) {
    // A preview: the dry run of its fields' change, which writes nothing.
    return ctx.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const fields = onTheBoard ? await cardFields(tx, ctx, s, board, issue, column, input.lane) : [];
      const changes = fields.length ? (await applyChanges(tx, ctx, issue, { fields, expectedVersion: input.expectedVersion }, { dryRun: true })).changes : [];
      return { changes, placed: !keepPlace };
    });
  }

  const { outcome, recorded } = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [locked] = await tx.select({ id: boards.id }).from(boards).where(eq(boards.id, board.id)).for('no key update');
    if (!locked) throw notFound('Board').said('notFound.boardUnnamed');
    const out: ActivityRow[] = [];
    const fields = onTheBoard ? await cardFields(tx, ctx, s, board, issue, column, input.lane) : [];
    const applied = fields.length ? await applyChanges(tx, ctx, issue, { fields, expectedVersion: input.expectedVersion }) : null;
    if (applied) out.push(...applied.activities);
    const changes = applied?.changes ?? [];
    if (keepPlace) return { outcome: { changes, placed: false }, recorded: out };
    const order = (await tx.select().from(boardRanks).where(eq(boardRanks.boardId, board.id)).orderBy(asc(boardRanks.rank), asc(boardRanks.issueId))).map((r) => ({ id: r.issueId, rank: r.rank }));
    if (alreadyThere(order, issue.id, anchor?.id ?? null, side)) return { outcome: { changes, placed: false }, recorded: out };
    const writes = placeAmong(order, issue.id, anchor?.id ?? null, side, shown);
    // Those without a place until now are new rows: each is locked against being deleted meanwhile,
    // and one that has gone since the board was read is left out.
    const ranked = new Set(order.map((o) => o.id));
    const fresh = [...writes.keys()].filter((id) => !ranked.has(id));
    const alive = new Set(fresh.length ? (await tx.select({ id: issues.id }).from(issues).where(inArray(issues.id, fresh)).for('key share')).map((r) => r.id) : []);
    if (!ranked.has(issue.id) && !alive.has(issue.id)) throw notFound(`Issue ${input.issue}`, 'Use a readable id such as BACK-12.').said('issues.notFound', { id: input.issue });
    const updates = [...writes].filter(([id]) => ranked.has(id));
    for (let k = 0; k < updates.length; k += WRITE_CHUNK) {
      const rows = updates.slice(k, k + WRITE_CHUNK).map(([id, rank]) => sql`(${id}, ${rank}::double precision)`);
      // A rank whose issue was deleted meanwhile went with it: the update finds nothing to change.
      await tx.execute(sql`UPDATE board_ranks AS br SET rank = v.rank FROM (VALUES ${sql.join(rows, sql`, `)}) AS v(issue_id, rank) WHERE br.board_id = ${board.id} AND br.issue_id = v.issue_id`);
    }
    const inserts = [...writes].filter(([id]) => alive.has(id)).map(([issueId, rank]) => ({ boardId: board.id, issueId, rank }));
    for (let k = 0; k < inserts.length; k += WRITE_CHUNK) {
      await tx
        .insert(boardRanks)
        .values(inserts.slice(k, k + WRITE_CHUNK))
        .onConflictDoUpdate({ target: [boardRanks.boardId, boardRanks.issueId], set: { rank: sql`excluded.rank` } });
    }
    const ref = (await issueRefsById(tx, await ctx.app.schema.get(tx), [issue.id])).get(issue.id);
    out.push(await recordActivity(tx, ctx, { type: 'board.issue_ranked', projectId: issue.projectId, issueId: issue.id, payload: { issue: ref, data: { boardId: board.id, board: board.name } } }));
    return { outcome: { changes, placed: true }, recorded: out };
  });
  await publishActivities(ctx.app, recorded);
  return outcome;
}

// ---------------------------------------------------------------------------
// Velocity
// ---------------------------------------------------------------------------

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Per sprint that has begun: what it held when it started, and what was resolved in it by its end,
 * in story points, estimated hours or issues; and the average done over the last three that are
 * over. Each sprint's figures come from history, as its burndown's do.
 */
export async function velocity(ctx: Ctx, boardId: string, by?: Velocity['by']): Promise<Velocity> {
  requireScope(ctx, 'read');
  const board = await loadBoard(ctx, boardId);
  if (!board.sprintsEnabled) throw badRequest('This board does not use sprints', 'Enable sprints on the board first.').said('agile.noSprints');
  const measureBy = by ?? (board.pointsFieldId ? 'points' : 'estimate');
  const s = await ctx.app.schema.get();
  const pointsName = board.pointsFieldId ? s.fields.get(board.pointsFieldId)?.name : undefined;
  if (measureBy === 'points' && !pointsName) {
    throw badRequest('This board has no story points field', 'Choose one in the board’s settings, or ask for velocity by estimate or count.').said('agile.noStoryPoints');
  }
  const view = await projectAccess(ctx);
  const projects = board.projectIds.filter((id) => view.canRead(id)).map((id) => s.projects.get(id)).filter((p): p is ProjectRow => Boolean(p));
  const tz = zoneOf(ctx);
  const now = Date.now();
  const today = todayIn(tz, now);
  const rows = await ctx.db.select().from(sprints).where(eq(sprints.boardId, board.id)).orderBy(asc(sprints.startDate), asc(sprints.createdAt));
  const begun = rows
    .filter((r): r is typeof r & { startDate: string; endDate: string } => Boolean(r.startDate && r.endDate))
    .filter((r) => r.startDate <= today && r.endDate >= r.startDate && diffDays(r.startDate, r.endDate) <= 366)
    .slice(-VELOCITY_SPRINTS);
  const measure = measureBy === 'points' ? pointsMeasure(pointsName!) : undefined;
  const scale = (n: number) => (measureBy === 'estimate' ? round1(n / 60) : round1(n));
  const out: Velocity['sprints'] = [];
  for (const r of begun) {
    const { res } = await sprintBurn(ctx, s, r, projects, measureBy === 'count' ? 'count' : 'estimate', tz, now, measure);
    const done = res.days.reduce((sum, d) => sum + d.completed - d.reopened, 0);
    out.push({ id: r.id, name: r.name, startDate: r.startDate, endDate: r.endDate, committed: scale(res.start), done: scale(Math.max(0, done)), finished: r.endDate < today });
  }
  const lastThree = out.filter((x) => x.finished).slice(-3);
  return {
    by: measureBy,
    unit: measureBy === 'points' ? 'points' : measureBy === 'estimate' ? 'hours' : 'issues',
    sprints: out,
    average: lastThree.length ? round1(lastThree.reduce((sum, x) => sum + x.done, 0) / lastThree.length) : null,
  };
}

// ---------------------------------------------------------------------------
// A sprint's load against its people's capacity
// ---------------------------------------------------------------------------

function userOf(issue: Issue, fieldId: string | undefined): { id: string } | null {
  if (!fieldId) return null;
  const v = issue.fields.find((f) => f.fieldId === fieldId)?.value;
  return v && typeof v === 'object' && !Array.isArray(v) && 'login' in v && 'id' in v ? (v as { id: string }) : null;
}

function minutesOfValue(issue: Issue, fieldId: string | undefined): number {
  if (!fieldId) return 0;
  const v = issue.fields.find((f) => f.fieldId === fieldId)?.value;
  return v && typeof v === 'object' && !Array.isArray(v) && 'minutes' in v ? Number((v as { minutes: number }).minutes) || 0 : 0;
}

/**
 * Who has what in a sprint (D43): per assignee, its issues, their points, the remaining estimate
 * of the unresolved ones (estimate less work logged), and the hours they can work from its start
 * (or today, once it has started) to its end, by their working week and days away.
 */
export async function sprintPlan(ctx: Ctx, sprintId: string): Promise<SprintPlan> {
  requireScope(ctx, 'read');
  const { sprint, board } = await loadSprint(ctx, sprintId, 'read');
  const view = await projectAccess(ctx);
  const s = await ctx.app.schema.get();
  const readable = board.projectIds.filter((id) => view.canRead(id));
  const rows = readable.length
    ? await ctx.db
        .select()
        .from(issues)
        .where(and(inArray(issues.projectId, readable), sql`EXISTS (SELECT 1 FROM ${sprintIssues} si WHERE si.issue_id = ${issues.id} AND si.sprint_id = ${sprint.id})`))
        .orderBy(asc(issues.number))
    : [];
  const { rows: ordered } = await rankRows(ctx.db, board.id, rows as IssueRow[]);
  const items = await issueDtos(ctx, ordered);
  const assignee = fieldByName(s, WELL_KNOWN_FIELDS.assignee)?.id;
  const estimate = fieldByName(s, WELL_KNOWN_FIELDS.estimation)?.id;
  const spentRows = rows.length
    ? await ctx.db
        .select({ issueId: workItems.issueId, minutes: sql<number>`sum(${workItems.minutes})::int` })
        .from(workItems)
        .where(inArray(workItems.issueId, rows.map((r) => r.id)))
        .groupBy(workItems.issueId)
    : [];
  const spent = new Map(spentRows.map((r) => [r.issueId, Number(r.minutes)]));

  type Row = { userId: string | null; issues: number; points: number; loadMinutes: number };
  const byUser = new Map<string, Row>();
  const keyOf = (id: string | null) => id ?? '';
  for (const issue of items) {
    const userId = userOf(issue, assignee)?.id ?? null;
    const row = byUser.get(keyOf(userId)) ?? { userId, issues: 0, points: 0, loadMinutes: 0 };
    byUser.set(keyOf(userId), row);
    row.issues += 1;
    row.points += board.pointsFieldId ? (pointsOf(issue, board.pointsFieldId) ?? 0) : 0;
    if (!issue.resolvedAt) row.loadMinutes += Math.max(0, minutesOfValue(issue, estimate) - (spent.get(issue.uid) ?? 0));
  }

  const today = todayIn(zoneOf(ctx));
  const from = sprint.startDate && sprint.endDate ? (sprint.startDate > today ? sprint.startDate : today) : null;
  const to = sprint.startDate && sprint.endDate ? sprint.endDate : null;
  const people = [...byUser.values()].map((r) => r.userId).filter((id): id is string => Boolean(id));
  const userRows = people.length ? await ctx.db.select().from(users).where(inArray(users.id, people)) : [];
  const first = readable.map((id) => s.projects.get(id)).find((p): p is ProjectRow => Boolean(p));
  const cal = normalizeCalendar(projectSettings(first ?? ({ settings: {} } as ProjectRow)).plan);
  const resources: PlanResource[] = userRows.map((u) => ({ id: u.id, login: u.login, name: u.name, capacityHoursPerDay: u.capacityHoursPerDay, hourlyRate: u.hourlyRate, week: u.workWeek }));
  const availabilityOf = availabilities(cal, await absencesForPlan(ctx.db, people, today), today, resources);
  const capacityOf = (userId: string): number | null => {
    if (!from || !to) return null;
    if (from > to) return 0;
    const u = userRows.find((x) => x.id === userId);
    if (!u) return 0;
    const a = availabilityOf(userId);
    return round1(listWorkingDays(a.cal, from, to).reduce((sum, d) => sum + Math.max(0, u.capacityHoursPerDay) * a.share(d), 0));
  };
  const hasPoints = Boolean(board.pointsFieldId);
  const out: SprintPlan['people'] = [...byUser.values()]
    .map((r) => {
      const u = r.userId ? s.users.get(r.userId) : undefined;
      return {
        user: u ? userRefDto(u) : null,
        issues: r.issues,
        points: hasPoints ? round1(r.points) : null,
        loadHours: round1(r.loadMinutes / 60),
        capacityHours: r.userId ? capacityOf(r.userId) : null,
      };
    })
    .sort((a, b) => (a.user === null ? 1 : b.user === null ? -1 : a.user.name.localeCompare(b.user.name)));
  const named = out.filter((p) => p.user);
  return {
    sprint: (await sprintDtos(ctx.db, view, [sprint], s))[0]!,
    from,
    to,
    people: out,
    totals: {
      issues: items.length,
      points: hasPoints ? round1(out.reduce((sum, p) => sum + (p.points ?? 0), 0)) : null,
      loadHours: round1(out.reduce((sum, p) => sum + p.loadHours, 0)),
      capacityHours: from && to ? round1(named.reduce((sum, p) => sum + (p.capacityHours ?? 0), 0)) : null,
    },
  };
}
