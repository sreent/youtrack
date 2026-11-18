/**
 * Planning sprints from a board (docs/architecture.md, D43): its backlog in rank order, ranking (on
 * the board too, D53), story points, velocity, and a sprint’s load against what its people can work.
 */
import { WELL_KNOWN_FIELDS, type Backlog, type Change, type Issue, type RankInput, type SprintPlan, type Velocity } from '@a4a/shared';
import { RANK_KEY_LIMIT, keyBetween, keysBetween } from '@a4a/shared/ranks';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { boardLaneRanks, boardMoves, boardRanks, boards, issues, sprintIssues, sprints, users, workItems } from '../db/schema';
import { translatorFor } from '../i18n';
import { publishActivities, recordActivity, type ActivityRow } from '../events/activity';
import { diffDays } from '../lib/dates';
import { badRequest, notFound } from '../lib/errors';
import { availabilities } from '../planning/availability';
import { listWorkingDays, normalizeCalendar } from '../planning/calendar';
import type { PlanResource } from '../planning/types';
import { todayIn } from '../reports/tz';
import { searchIssueRows } from '../search/service';
import { absencesForPlan } from './absences';
import { assertCanWriteProject, projectAccess, type AccessView } from './access';
import {
  MAX_BOARD_ISSUES,
  boardCardRows,
  boardCards,
  boardSprintRows,
  laneIdNamed,
  laneIdOf,
  loadBoard,
  loadSprint,
  ownLanes,
  pointsOf,
  rankRows,
  scoped,
  shownSprint,
  sprintDtos,
  sumPoints,
  type BoardRow,
} from './boards';
import { rewriteKeys } from './rank-keys';
import { issueRefsById, readableId, type IssueRow } from './issue-refs';
import { applyChanges, fieldValuesOf, issueDtos, resolveFieldsInput, resolveIssue, type FieldChangeSpec } from './issues';
import { projectSettings } from './projects';
import { pointsMeasure, sprintBurn } from './reports';
import { allowedValues, fieldByName, type ProjectRow, type SchemaSnapshot } from './schema-cache';
import { zoneOf } from './time-zones';
import { userRefDto, type ResolvedValue } from './values';

/** What a backlog holds when its board doesn't say. */
export const DEFAULT_BACKLOG_QUERY = '#Unresolved';
/** The sprints a velocity chart shows, at most: the latest. */
const VELOCITY_SPRINTS = 12;

/**
 * The backlog's issues: the board's backlog query in the projects the caller can read, without the
 * issues of its open sprints (not archived, and not over), in rank order.
 */
async function backlogRows(ctx: Ctx, board: BoardRow): Promise<{ rows: IssueRow[]; ranks: Map<string, string>; total: number; query: string }> {
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
 * The order a move reads and writes (D65): the board's own (`lane` null), shared by its backlog and its
 * cards; or one lane's, on a board whose lanes keep their own. Both through an index on (board, [lane,]
 * key), so a move reads its anchor's key and the next one, and nothing else of the board.
 */
export interface PlaceOrder {
  boardId: string;
  lane: string | null;
}

const tableOf = (o: PlaceOrder) => (o.lane === null ? sql`board_ranks` : sql`board_lane_ranks`);
const inOrder = (o: PlaceOrder) => (o.lane === null ? sql`board_id = ${o.boardId}` : sql`board_id = ${o.boardId} AND lane = ${o.lane}`);
const rowsOf = <T>(res: unknown) => (res as { rows: T[] }).rows;

/** The keys some issues have in the order, by issue. */
async function keysOf(tx: Db, o: PlaceOrder, ids: readonly string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const res = await tx.execute(sql`SELECT issue_id, key FROM ${tableOf(o)} WHERE ${inOrder(o)} AND issue_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
  return new Map(rowsOf<{ issue_id: string; key: string }>(res).map((r) => [r.issue_id, r.key]));
}

/**
 * The place next to a key: the first after it (or the first of all, for none), or the last before it.
 * By the key alone, so the index on (board, [lane,] key) answers it: under the board's lock no two
 * places share a key, and the bounds are strict, so even a tie couldn't put a card out of order.
 */
async function nextTo(tx: Db, o: PlaceOrder, key: string | null, side: 'after' | 'before'): Promise<{ id: string; key: string } | null> {
  const res =
    side === 'after'
      ? await tx.execute(sql`SELECT issue_id, key FROM ${tableOf(o)} WHERE ${inOrder(o)}${key === null ? sql`` : sql` AND key > ${key}`} ORDER BY key LIMIT 1`)
      : await tx.execute(sql`SELECT issue_id, key FROM ${tableOf(o)} WHERE ${inOrder(o)}${key === null ? sql`` : sql` AND key < ${key}`} ORDER BY key DESC LIMIT 1`);
  const row = rowsOf<{ issue_id: string; key: string }>(res)[0];
  return row ? { id: row.issue_id, key: row.key } : null;
}

/**
 * Where an issue goes in an order (D43, D65): the keys to write so it sits just after or just before
 * the anchor, or first without one; null when it's there already. It reads the anchor's key and the
 * one next to it, and writes one key. An anchor without a place first gives itself, and those shown
 * above it without one, places after the placed ones, in the order shown, so nothing on the screen
 * jumps. A key past `RANK_KEY_LIMIT` is never written: the order's keys are written afresh, under the
 * board's lock the move holds, and the place is found again among them.
 */
export async function placeIn(tx: Db, o: PlaceOrder, issueId: string, anchor: string | null, side: 'after' | 'before', shown: readonly string[] | null, rewritten = false): Promise<Map<string, string> | null> {
  const writes = new Map<string, string>();
  let key: string;
  const anchorKey = anchor ? ((await keysOf(tx, o, [anchor])).get(anchor) ?? null) : null;
  if (anchor && anchorKey === null) {
    const seen = (shown ?? []).filter((id) => id !== issueId);
    const at = seen.indexOf(anchor);
    const upTo = at >= 0 ? seen.slice(0, at + 1) : [anchor];
    const placed = await keysOf(tx, o, upTo);
    const run = upTo.filter((id) => !placed.has(id));
    const last = (await nextTo(tx, o, null, 'before'))?.key ?? null;
    const keys = keysBetween(last, null, run.length);
    run.forEach((id, i) => writes.set(id, keys[i]!));
    const own = writes.get(anchor)!;
    key = side === 'after' ? keyBetween(own, null) : keyBetween(keys[run.length - 2] ?? last, own);
  } else {
    const next = await nextTo(tx, o, anchorKey, anchor ? side : 'after');
    // Just after (or before) the anchor already, or first already: nothing to write.
    if (next?.id === issueId) return null;
    key = !anchor ? keyBetween(null, next?.key ?? null) : side === 'after' ? keyBetween(anchorKey, next?.key ?? null) : keyBetween(next?.key ?? null, anchorKey);
  }
  if (key.length > RANK_KEY_LIMIT && !rewritten) {
    await rewriteKeys(tx, o.boardId, o.lane ?? undefined);
    return placeIn(tx, o, issueId, anchor, side, shown, true);
  }
  writes.set(issueId, key);
  return writes;
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

/** Keys written to an order: a card's place in the board's order, or its one place in a lane (D65). */
async function writeKeys(tx: Db, o: PlaceOrder, rows: [string, string][]): Promise<void> {
  if (!rows.length) return;
  if (o.lane === null) {
    await tx
      .insert(boardRanks)
      .values(rows.map(([issueId, key]) => ({ boardId: o.boardId, issueId, key })))
      .onConflictDoUpdate({ target: [boardRanks.boardId, boardRanks.issueId], set: { key: sql`excluded.key` } });
    return;
  }
  await tx
    .insert(boardLaneRanks)
    .values(rows.map(([issueId, key]) => ({ boardId: o.boardId, issueId, lane: o.lane!, key })))
    .onConflictDoUpdate({ target: [boardLaneRanks.boardId, boardLaneRanks.issueId], set: { lane: sql`excluded.lane`, key: sql`excluded.key` } });
}

/** What the board showed, for an anchor without a place: its cards in the sprint shown, in order, or its lane's (D65). */
async function shownOnBoard(ctx: Ctx, board: BoardRow, seen: { s: SchemaSnapshot; view: AccessView }, sprintId: string | null, lane: string | null): Promise<string[]> {
  if (lane === null) return (await boardCardRows(ctx, board, seen.view, sprintId)).map((r) => r.id);
  const { items, laneOf } = await boardCards(ctx, board, seen.s, seen.view, sprintId);
  return items.filter((i) => laneOf?.get(i.uid) === lane).map((i) => i.uid);
}

/** How long after a line's first move another by the same person on the same board folds into it (D65). */
export const MOVE_FOLD_MINUTES = 10;

/**
 * A move's line in its issue's history (D65): folded into the issue's latest line when that is one
 * by the same person, through the same channel, on the same board, begun within ten minutes, and
 * nothing else has happened to the issue since; a new one otherwise. Its place is a kept note (D49):
 * the anchor's id and the board's name as they were, said for each reader with what they may see.
 */
async function keepMove(tx: Db, ctx: Ctx, m: { issueId: string; board: BoardRow; anchorId: string | null; anchorRef: string; side: 'above' | 'below' | 'top'; eventId: number }) {
  const actorId = ctx.actor.authMethod === 'system' && ctx.actor.user.id === 'system' ? null : ctx.actor.user.id;
  const said = { key: 'boards.history.moved', values: { side: m.side, anchor: m.anchorRef, onBoard: 'yes', board: m.board.name } };
  const note = translatorFor('en').t(said.key, said.values);
  const latest = sql`(SELECT id FROM board_moves WHERE issue_id = ${m.issueId} ORDER BY last_event_id DESC LIMIT 1)`;
  const [open] = await tx
    .select({ id: boardMoves.id })
    .from(boardMoves)
    .where(
      and(
        sql`${boardMoves.id} = ${latest}`,
        eq(boardMoves.boardId, m.board.id),
        sql`${boardMoves.actorId} IS NOT DISTINCT FROM ${actorId}`,
        eq(boardMoves.channel, ctx.actor.channel),
        sql`${boardMoves.tokenName} IS NOT DISTINCT FROM ${ctx.actor.tokenName ?? null}`,
        sql`${boardMoves.firstAt} > now() - make_interval(mins => ${MOVE_FOLD_MINUTES})`,
        sql`NOT EXISTS (SELECT 1 FROM activities a WHERE a.issue_id = ${m.issueId} AND a.id > ${boardMoves.lastEventId} AND a.id < ${m.eventId} AND a.type <> 'board.issue_ranked')`,
      ),
    )
    .for('update');
  const line = { anchorId: m.anchorId, side: m.side, lastEventId: m.eventId, note, said };
  if (open) {
    await tx
      .update(boardMoves)
      .set({ ...line, moves: sql`${boardMoves.moves} + 1`, lastAt: sql`now()` })
      .where(eq(boardMoves.id, open.id));
    return;
  }
  await tx.insert(boardMoves).values({ ...line, issueId: m.issueId, boardId: m.board.id, actorId, channel: ctx.actor.channel, tokenName: ctx.actor.tokenName ?? null });
}

/**
 * Puts an issue just after or just before another in the board's order, or at the top (D43); and,
 * on the board itself (D53), into a column and a lane too, all in one transaction. The column
 * field's change goes through applyChanges, so a state machine, a guard or a field's condition
 * that refuses it refuses the move whole, and the issue keeps its place.
 *
 * - The board's row is locked for the move (FOR NO KEY UPDATE), so two people ranking at once each
 *   place their issue among the keys the other left: two put just after one card both land after it,
 *   the later first; and keys written afresh never cross a move (D65).
 * - A move reads its anchor's key and the one next to it, and writes one row (D65).
 * - On a board whose lanes keep their own order (D65), a card moved on the board takes its place in
 *   the order of the lane it goes into, or is in; the backlog keeps the board's.
 * - On the board, with neither after nor before, the issue keeps its place: it shows in its new
 *   column where the board's order (or its lane's) puts it.
 * - An anchor without a place is placed among what was shown: the board's cards in the sprint
 *   shown (its lane's, for a lane's order), or the backlog. That's read before the transaction (the
 *   search runs on its own connection; PGlite has one), and only issues that still exist are written.
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
  // A lane's own order (D65): on the board, the lane the card goes into, or is in, as the caller sees it.
  const seen = await scoped(ctx);
  const laneField = onTheBoard ? ownLanes(seen.s, board) : null;
  const lane = laneField ? (input.lane !== undefined ? laneIdNamed(s, laneField, input.lane) : laneIdOf(seen.s, laneField, (await issueDtos(ctx, [issue]))[0]!)) : null;
  const order: PlaceOrder = { boardId: board.id, lane };
  const anchorPlaced = anchor ? (await keysOf(ctx.db, order, [anchor.id])).size > 0 : true;
  const shown = anchor && !anchorPlaced && !opts.dryRun ? (onTheBoard ? await shownOnBoard(ctx, board, seen, sprint?.id ?? null, lane) : (await backlogRows(ctx, board)).rows.map((r) => r.id)) : null;

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
    const writes = await placeIn(tx, order, issue.id, anchor?.id ?? null, side, shown);
    if (!writes) return { outcome: { changes, placed: false }, recorded: out };
    // Each issue given a place is locked against being deleted meanwhile; one gone since the board was
    // read is left out, and the issue moved gone is missing.
    const alive = new Set((await tx.select({ id: issues.id }).from(issues).where(inArray(issues.id, [...writes.keys()])).for('key share')).map((r) => r.id));
    if (!alive.has(issue.id)) throw notFound(`Issue ${input.issue}`, 'Use a readable id such as BACK-12.').said('issues.notFound', { id: input.issue });
    await writeKeys(tx, order, [...writes].filter(([id]) => alive.has(id)));
    const ref = (await issueRefsById(tx, await ctx.app.schema.get(tx), [issue.id])).get(issue.id);
    const ranked = await recordActivity(tx, ctx, { type: 'board.issue_ranked', projectId: issue.projectId, issueId: issue.id, payload: { issue: ref, data: { boardId: board.id, board: board.name } } });
    out.push(ranked);
    await keepMove(tx, ctx, { issueId: issue.id, board, anchorId: anchor?.id ?? null, anchorRef: anchor ? readableId(s, anchor) : '', side: !anchor ? 'top' : side === 'after' ? 'below' : 'above', eventId: ranked.id });
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
