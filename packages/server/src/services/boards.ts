import type { Board, BoardColumn, BoardView, Issue, Sprint } from '@a4a/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { boardRanks, boards, issues, sprintIssues, sprints } from '../db/schema';
import { publishActivities, recordActivity, type ActivityRow } from '../events/activity';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { searchIssueRows } from '../search/service';
import { assertCanProject, assertCanWriteProject, issueSeenSql, projectAccess, scopeFields, scopeSchema, type AccessView } from './access';
import { issueRefsById, type IssueRow } from './issue-refs';
import { issueDtos } from './issues';
import { resolveIssue } from './issues';
import { allowedValues, fieldByName, projectByKey, type SchemaSnapshot } from './schema-cache';

export type BoardRow = typeof boards.$inferSelect;
export type SprintRow = typeof sprints.$inferSelect;

interface StoredColumn {
  name: string;
  valueIds: string[];
  wipLimit: number | null;
}

export const MAX_BOARD_ISSUES = 500;

function columnsDto(s: SchemaSnapshot, stored: StoredColumn[]): BoardColumn[] {
  return stored.map((c) => ({
    name: c.name,
    values: c.valueIds.map((id) => s.values.get(id)?.name).filter((n): n is string => Boolean(n)),
    wipLimit: c.wipLimit,
  }));
}

export function boardDto(s: SchemaSnapshot, row: BoardRow): Board {
  return {
    id: row.id,
    name: row.name,
    projects: row.projectIds
      .map((id) => s.projects.get(id))
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
      .map((p) => ({ id: p.id, key: p.key, name: p.name })),
    columnField: row.columnFieldId ? (s.fields.get(row.columnFieldId)?.name ?? 'State') : 'State',
    columns: columnsDto(s, row.columns as StoredColumn[]),
    swimlaneField: row.swimlaneFieldId ? (s.fields.get(row.swimlaneFieldId)?.name ?? null) : null,
    query: row.query,
    backlogQuery: row.backlogQuery,
    pointsField: row.pointsFieldId ? (s.fields.get(row.pointsFieldId)?.name ?? null) : null,
    sprintsEnabled: row.sprintsEnabled,
  };
}

/** An issue's story points: the board's points field, when it holds a number (D43). */
export function pointsOf(issue: Issue, pointsFieldId: string): number | null {
  const v = issue.fields.find((f) => f.fieldId === pointsFieldId)?.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The points of issues, or null when the board has no points field. */
export function sumPoints(items: Issue[], pointsFieldId: string | null): number | null {
  if (!pointsFieldId) return null;
  return Math.round(items.reduce((sum, i) => sum + (pointsOf(i, pointsFieldId) ?? 0), 0) * 100) / 100;
}

/**
 * Issue rows in board order (D43): those with a rank first, lowest first, then the rest in the
 * order they came (the query's).
 */
export async function rankRows<T extends { id: string }>(db: Db, boardId: string, rows: T[]): Promise<{ rows: T[]; ranks: Map<string, number> }> {
  if (!rows.length) return { rows, ranks: new Map() };
  const found = await db
    .select({ issueId: boardRanks.issueId, rank: boardRanks.rank })
    .from(boardRanks)
    .where(and(eq(boardRanks.boardId, boardId), inArray(boardRanks.issueId, rows.map((r) => r.id))));
  const ranks = new Map(found.map((r) => [r.issueId, r.rank]));
  if (!ranks.size) return { rows, ranks };
  const at = new Map(rows.map((r, i) => [r.id, i]));
  const ordered = [...rows].sort((a, b) => {
    const ra = ranks.get(a.id);
    const rb = ranks.get(b.id);
    if (ra !== undefined && rb !== undefined) return ra - rb || at.get(a.id)! - at.get(b.id)!;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return at.get(a.id)! - at.get(b.id)!;
  });
  return { rows: ordered, ranks };
}

/** Sprints, counting only the issues the caller can see. */
export async function sprintDtos(db: Db, view: AccessView, rows: SprintRow[], s: SchemaSnapshot): Promise<Sprint[]> {
  if (!rows.length) return [];
  const visible = view.visibleIds();
  const counts = await db
    .select({ sprintId: sprintIssues.sprintId, n: sql<number>`count(*)::int` })
    .from(sprintIssues)
    .innerJoin(issues, eq(issues.id, sprintIssues.issueId))
    .where(
      and(
        inArray(sprintIssues.sprintId, rows.map((r) => r.id)),
        visible === null ? undefined : visible.length ? inArray(issues.projectId, visible) : sql`FALSE`,
        issueSeenSql(view, s),
      ),
    )
    .groupBy(sprintIssues.sprintId);
  const byId = new Map(counts.map((c) => [c.sprintId, Number(c.n)]));
  return rows.map((r) => ({
    id: r.id,
    boardId: r.boardId,
    name: r.name,
    goal: r.goal,
    startDate: r.startDate,
    endDate: r.endDate,
    archived: r.archived,
    issueCount: byId.get(r.id) ?? 0,
  }));
}

function resolveColumns(
  s: SchemaSnapshot,
  fieldId: string,
  projectIds: string[],
  input: { name: string; values: string[]; wipLimit?: number | null }[] | undefined,
): StoredColumn[] {
  const values = projectIds.flatMap((pid) => allowedValues(s, fieldId, pid));
  const byName = new Map<string, string[]>();
  for (const v of values) byName.set(v.name.toLowerCase(), [...(byName.get(v.name.toLowerCase()) ?? []), v.id]);
  if (!input?.length) {
    // Default: a column per open value, and one "Done" column for every resolved value.
    const seen = new Set<string>();
    const open: StoredColumn[] = [];
    const doneIds: string[] = [];
    for (const v of values) {
      if (v.isResolved) {
        doneIds.push(v.id);
        continue;
      }
      const key = v.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      open.push({ name: v.name, valueIds: byName.get(key) ?? [v.id], wipLimit: null });
    }
    return doneIds.length ? [...open, { name: 'Done', valueIds: [...new Set(doneIds)], wipLimit: null }] : open;
  }
  return input.map((c) => {
    const ids = c.values.flatMap((name) => {
      const found = byName.get(name.trim().toLowerCase());
      if (!found) throw badRequest(`Unknown value "${name}" for column "${c.name}"`).said('boards.unknownColumnValue', { name, name2: c.name });
      return found;
    });
    return { name: c.name, valueIds: [...new Set(ids)], wipLimit: c.wipLimit ?? null };
  });
}

/**
 * A board spans projects. Someone sees it when they can see one of its projects, and then only
 * those projects' issues and values; changing it, or its sprints, is for managers of all of them.
 */
function seesBoard(view: AccessView, row: BoardRow): boolean {
  return row.projectIds.some((id) => view.canRead(id));
}

/**
 * The reference data as the caller sees it, so a board names no project or value they can't see, nor a
 * private field kept from them (D50): its lanes, columns and points are then as if it had none.
 */
export async function scoped(ctx: Ctx): Promise<{ s: SchemaSnapshot; view: AccessView }> {
  const view = await projectAccess(ctx);
  return { s: scopeFields(scopeSchema(await ctx.app.schema.get(), view.visibleIds()), view), view };
}

export async function listBoards(ctx: Ctx): Promise<Board[]> {
  requireScope(ctx, 'read');
  const { s, view } = await scoped(ctx);
  const rows = await ctx.db.select().from(boards).orderBy(asc(boards.name));
  return rows.filter((r) => seesBoard(view, r)).map((r) => boardDto(s, r));
}

export async function loadBoard(ctx: Ctx, id: string, need: 'read' | 'manage' = 'read'): Promise<BoardRow> {
  requireScope(ctx, 'read');
  const [row] = await ctx.db.select().from(boards).where(eq(boards.id, id));
  const view = await projectAccess(ctx);
  // A board on projects the caller can't see is not found, exactly as one that doesn't exist.
  if (!row || !seesBoard(view, row)) throw notFound('Board').said('notFound.boardUnnamed');
  if (need === 'manage') await assertCanManageBoard(ctx, view, row.projectIds);
  return row;
}

async function assertCanManageBoard(ctx: Ctx, view: AccessView, projectIds: string[]): Promise<void> {
  if (projectIds.some((id) => !view.canRead(id))) {
    throw forbidden('Only managers of every project on this board can change it', 'Ask an administrator.').said('boards.onlyManagersOfAll');
  }
  for (const id of projectIds) await assertCanProject(ctx, id, 'boards');
}

export async function getBoard(ctx: Ctx, id: string): Promise<Board> {
  const row = await loadBoard(ctx, id);
  const { s } = await scoped(ctx);
  return boardDto(s, row);
}

export interface BoardInput {
  name: string;
  projects: string[];
  columnField?: string;
  columns?: { name: string; values: string[]; wipLimit?: number | null }[];
  swimlaneField?: string | null;
  query?: string | null;
  backlogQuery?: string | null;
  pointsField?: string | null;
  sprintsEnabled?: boolean;
}

function resolveBoardInput(s: SchemaSnapshot, input: BoardInput) {
  const projectIds = input.projects.map((k) => {
    const p = projectByKey(s, k);
    if (!p) throw notFound(`Project ${k}`).said('notFound.project', { id: k });
    return p.id;
  });
  const columnField = fieldByName(s, input.columnField ?? 'State');
  if (!columnField || !['state', 'enum', 'version'].includes(columnField.type)) {
    throw badRequest(`Column field "${input.columnField ?? 'State'}" must be a field with a list of values`).said('boards.columnFieldNeedsValues', { field: input.columnField ?? 'State' });
  }
  const swimlane = input.swimlaneField ? fieldByName(s, input.swimlaneField) : undefined;
  if (input.swimlaneField && !swimlane) throw notFound(`Field ${input.swimlaneField}`).said('notFound.field', { id: input.swimlaneField });
  const points = input.pointsField ? fieldByName(s, input.pointsField) : undefined;
  if (input.pointsField && !points) throw notFound(`Field ${input.pointsField}`).said('notFound.field', { id: input.pointsField });
  if (points && !['integer', 'float'].includes(points.type)) {
    throw badRequest(`Story points are counted in a number field, and ${points.name} isn't one`, 'Choose an integer or float field, such as Story points.').said('boards.pointsNeedNumberField', { name: points.name });
  }
  return {
    projectIds,
    columnFieldId: columnField.id,
    columns: resolveColumns(s, columnField.id, projectIds, input.columns),
    swimlaneFieldId: swimlane?.id ?? null,
    pointsFieldId: points?.id ?? null,
    backlogQuery: input.backlogQuery?.trim() || null,
  };
}

export async function createBoard(ctx: Ctx, input: BoardInput): Promise<Board> {
  requireScope(ctx, 'write');
  const { s, view } = await scoped(ctx);
  const r = resolveBoardInput(s, input);
  await assertCanManageBoard(ctx, view, r.projectIds);
  const [row] = await ctx.db
    .insert(boards)
    .values({
      id: newId(),
      name: input.name,
      projectIds: r.projectIds,
      columnFieldId: r.columnFieldId,
      columns: r.columns,
      swimlaneFieldId: r.swimlaneFieldId,
      query: input.query ?? null,
      backlogQuery: r.backlogQuery,
      pointsFieldId: r.pointsFieldId,
      sprintsEnabled: input.sprintsEnabled ?? false,
      ownerId: ctx.actor.user.id,
    })
    .returning();
  return boardDto(s, row!);
}

export async function updateBoard(ctx: Ctx, id: string, input: Partial<BoardInput>): Promise<Board> {
  requireScope(ctx, 'write');
  const { s, view } = await scoped(ctx);
  const current = boardDto(s, await loadBoard(ctx, id, 'manage'));
  const merged: BoardInput = {
    name: input.name ?? current.name,
    projects: input.projects ?? current.projects.map((p) => p.key),
    columnField: input.columnField ?? current.columnField,
    columns: input.columns ?? (input.columnField || input.projects ? undefined : current.columns),
    swimlaneField: input.swimlaneField === undefined ? current.swimlaneField : input.swimlaneField,
    query: input.query === undefined ? current.query : input.query,
    backlogQuery: input.backlogQuery === undefined ? current.backlogQuery : input.backlogQuery,
    pointsField: input.pointsField === undefined ? current.pointsField : input.pointsField,
    sprintsEnabled: input.sprintsEnabled ?? current.sprintsEnabled,
  };
  const r = resolveBoardInput(s, merged);
  await assertCanManageBoard(ctx, view, r.projectIds);
  const [row] = await ctx.db
    .update(boards)
    .set({
      name: merged.name,
      projectIds: r.projectIds,
      columnFieldId: r.columnFieldId,
      columns: r.columns,
      swimlaneFieldId: r.swimlaneFieldId,
      query: merged.query ?? null,
      backlogQuery: r.backlogQuery,
      pointsFieldId: r.pointsFieldId,
      sprintsEnabled: merged.sprintsEnabled ?? false,
      updatedAt: new Date(),
    })
    .where(eq(boards.id, id))
    .returning();
  return boardDto(s, row!);
}

export async function deleteBoard(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'write');
  await loadBoard(ctx, id, 'manage');
  const res = await ctx.db.delete(boards).where(eq(boards.id, id)).returning({ id: boards.id });
  if (!res.length) throw notFound('Board').said('notFound.boardUnnamed');
}

/**
 * The sprint a board shows: the one asked for, else the one under way, else its latest that isn't
 * archived; none on a board without sprints. One asked for that isn't the board's is not found.
 */
export function shownSprint<T extends Pick<SprintRow, 'id' | 'archived' | 'startDate' | 'endDate'>>(row: BoardRow, all: T[], sprintId?: string): T | null {
  if (!row.sprintsEnabled) return null;
  const today = new Date().toISOString().slice(0, 10);
  const sprint =
    (sprintId ? all.find((x) => x.id === sprintId) : undefined) ??
    all.find((x) => !x.archived && (x.startDate ?? '') <= today && (x.endDate ?? '9999') >= today) ??
    all.filter((x) => !x.archived).at(-1) ??
    null;
  if (sprintId && !sprint) throw notFound('Sprint').said('notFound.sprintUnnamed');
  return sprint;
}

/** The board's sprints, in the order it lists them. */
export function boardSprintRows(db: Db, boardId: string): Promise<SprintRow[]> {
  return db.select().from(sprints).where(eq(sprints.boardId, boardId)).orderBy(asc(sprints.startDate), asc(sprints.createdAt));
}

/**
 * The board's cards as rows, in the board's order (D43): its query, in the projects the caller
 * reads and in the sprint shown, ranked first, then the rest in the query's order.
 */
export async function boardCardRows(ctx: Ctx, row: BoardRow, view: AccessView, sprintId: string | null): Promise<IssueRow[]> {
  const readable = row.projectIds.filter((pid) => view.canRead(pid));
  const extraWhere = sprintId ? sql`EXISTS (SELECT 1 FROM sprint_issues si WHERE si.issue_id = issues.id AND si.sprint_id = ${sprintId})` : undefined;
  const found = await searchIssueRows(ctx, row.query ?? '', { projectIds: readable, extraWhere, limit: MAX_BOARD_ISSUES });
  return (await rankRows(ctx.db, row.id, found.rows)).rows;
}

export async function boardView(ctx: Ctx, id: string, sprintId?: string): Promise<BoardView> {
  requireScope(ctx, 'read');
  const row = await loadBoard(ctx, id);
  const { s, view } = await scoped(ctx);
  const board = boardDto(s, row);
  const readable = row.projectIds.filter((pid) => view.canRead(pid));
  const allSprints = await sprintDtos(ctx.db, view, await boardSprintRows(ctx.db, id), s);
  const sprint: Sprint | null = shownSprint(row, allSprints, sprintId);
  // Cards are in the board's rank, the backlog's (D43).
  const rows = await boardCardRows(ctx, row, view, sprint?.id ?? null);
  const items = await issueDtos(ctx, rows);
  const stored = row.columns as StoredColumn[];
  const columns = board.columns.map((c, i) => {
    const ids = new Set(stored[i]?.valueIds ?? []);
    const inColumn = items.filter((issue) => {
      const f = issue.fields.find((x) => x.fieldId === row.columnFieldId);
      const v = f?.value;
      if (!v) return false;
      const values = Array.isArray(v) ? v : [v];
      return values.some((x) => typeof x === 'object' && x !== null && 'id' in x && ids.has((x as { id: string }).id));
    });
    return { ...c, issues: inColumn, count: inColumn.length, points: sumPoints(inColumn, row.pointsFieldId) };
  });
  let swimlanes: string[] = [];
  if (row.swimlaneFieldId) {
    const field = s.fields.get(row.swimlaneFieldId);
    if (field?.type === 'user') {
      const names = new Set<string>();
      for (const issue of items) {
        const v = issue.fields.find((x) => x.fieldId === field.id)?.value;
        if (v && typeof v === 'object' && !Array.isArray(v) && 'login' in v) names.add((v as { login: string }).login);
      }
      swimlanes = [...names].sort();
      swimlanes.push('Unassigned');
    } else if (field) {
      // Lanes of the projects whose issues show the field to them (D50).
      const showing = readable.filter((pid) => (s.projectFields.get(pid) ?? []).some((pf) => pf.fieldId === field.id));
      swimlanes = [...new Set(showing.flatMap((pid) => allowedValues(s, field.id, pid).map((v) => v.name)))];
      swimlanes.push('No value');
    }
  }
  return { board, sprint, sprints: allSprints, columns, swimlanes, points: sumPoints(items, row.pointsFieldId), order: items.map((i) => i.id) };
}

// Sprints ---------------------------------------------------------------------

export async function createSprint(
  ctx: Ctx,
  boardId: string,
  input: { name: string; goal?: string; startDate?: string | null; endDate?: string | null },
): Promise<Sprint> {
  requireScope(ctx, 'write');
  const board = await loadBoard(ctx, boardId, 'manage');
  if (!board.sprintsEnabled) throw badRequest('This board does not use sprints', 'Enable sprints on the board first.').said('boards.noSprints');
  const [row] = await ctx.db
    .insert(sprints)
    .values({ id: newId(), boardId, name: input.name, goal: input.goal ?? '', startDate: input.startDate ?? null, endDate: input.endDate ?? null })
    .returning();
  return (await sprintDtos(ctx.db, await projectAccess(ctx), [row!], await ctx.app.schema.get()))[0]!;
}

/** A sprint on a board the caller sees (404 otherwise, as for one that doesn't exist). */
export async function loadSprint(ctx: Ctx, id: string, need: 'read' | 'manage'): Promise<{ sprint: SprintRow; board: BoardRow }> {
  const [sprint] = await ctx.db.select().from(sprints).where(eq(sprints.id, id));
  if (!sprint) throw notFound('Sprint').said('notFound.sprintUnnamed');
  const board = await loadBoard(ctx, sprint.boardId, need).catch((e: unknown) => {
    if (e instanceof AppError && e.status === 404) throw notFound('Sprint').said('notFound.sprintUnnamed');
    throw e;
  });
  return { sprint, board };
}

export async function updateSprint(
  ctx: Ctx,
  id: string,
  input: { name?: string; goal?: string; startDate?: string | null; endDate?: string | null; archived?: boolean },
): Promise<Sprint> {
  requireScope(ctx, 'write');
  await loadSprint(ctx, id, 'manage');
  const [row] = await ctx.db
    .update(sprints)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.goal !== undefined ? { goal: input.goal } : {}),
      ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
      ...(input.endDate !== undefined ? { endDate: input.endDate } : {}),
      ...(input.archived !== undefined ? { archived: input.archived } : {}),
    })
    .where(eq(sprints.id, id))
    .returning();
  if (!row) throw notFound('Sprint').said('notFound.sprintUnnamed');
  return (await sprintDtos(ctx.db, await projectAccess(ctx), [row], await ctx.app.schema.get()))[0]!;
}

export async function deleteSprint(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'write');
  await loadSprint(ctx, id, 'manage');
  const res = await ctx.db.delete(sprints).where(eq(sprints.id, id)).returning({ id: sprints.id });
  if (!res.length) throw notFound('Sprint').said('notFound.sprintUnnamed');
}

/** Putting an issue in a sprint, or taking it out, is work on the issue: a member of its project may. */
export async function setSprintIssues(ctx: Ctx, sprintId: string, issueIds: string[], remove: boolean): Promise<Sprint> {
  requireScope(ctx, 'write');
  const { sprint, board } = await loadSprint(ctx, sprintId, 'read');
  const rows = await Promise.all(issueIds.map((id) => resolveIssue(ctx, id)));
  for (const r of rows) {
    if (!board.projectIds.includes(r.projectId)) throw badRequest('An issue from another project cannot join this board\'s sprint').said('boards.otherProjectsIssue');
  }
  for (const pid of new Set(rows.map((r) => r.projectId))) await assertCanWriteProject(ctx, pid);
  const recorded = await ctx.db.transaction(async (txRaw) => changeSprintInTx(txRaw as unknown as Db, ctx, sprint, board, rows, remove));
  await publishActivities(ctx.app, recorded);
  return (await sprintDtos(ctx.db, await projectAccess(ctx), [sprint], await ctx.app.schema.get()))[0]!;
}

/**
 * Issues join or leave a sprint inside `tx`. Who joined or left is history a burndown reads, so
 * each change is recorded with it, at once; `data` is said in each activity (an import's origin).
 */
export async function changeSprintInTx(
  tx: Db,
  ctx: Ctx,
  sprint: SprintRow,
  board: BoardRow,
  rows: { id: string; projectId: string }[],
  remove: boolean,
  data: Record<string, unknown> = {},
): Promise<ActivityRow[]> {
  const ids = rows.map((r) => r.id);
  if (!ids.length) return [];
  const changed = remove
    ? await tx
        .delete(sprintIssues)
        .where(and(eq(sprintIssues.sprintId, sprint.id), inArray(sprintIssues.issueId, ids)))
        .returning({ issueId: sprintIssues.issueId })
    : await tx
        .insert(sprintIssues)
        .values(ids.map((issueId) => ({ sprintId: sprint.id, issueId })))
        .onConflictDoNothing()
        .returning({ issueId: sprintIssues.issueId });
  if (!changed.length) return [];
  const s = await ctx.app.schema.get(tx);
  const refs = await issueRefsById(tx, s, changed.map((c) => c.issueId));
  const out: ActivityRow[] = [];
  for (const c of changed) {
    const row = rows.find((r) => r.id === c.issueId)!;
    out.push(
      await recordActivity(tx, ctx, {
        type: remove ? 'sprint.issue_removed' : 'sprint.issue_added',
        projectId: row.projectId,
        issueId: row.id,
        payload: { issue: refs.get(row.id), data: { ...data, sprintId: sprint.id, sprint: sprint.name, boardId: board.id, board: board.name } },
      }),
    );
  }
  return out;
}
