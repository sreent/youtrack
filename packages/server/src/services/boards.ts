import type { Board, BoardColumn, BoardView, Sprint } from '@a4a/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { boards, issues, sprintIssues, sprints } from '../db/schema';
import { publishActivities, recordActivity, type ActivityRow } from '../events/activity';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { searchIssueRows } from '../search/service';
import { assertCanProject, assertCanWriteProject, issueSeenSql, projectAccess, scopeSchema, type AccessView } from './access';
import { issueRefsById } from './issue-refs';
import { issueDtos } from './issues';
import { resolveIssue } from './issues';
import { allowedValues, fieldByName, projectByKey, type SchemaSnapshot } from './schema-cache';

type BoardRow = typeof boards.$inferSelect;
type SprintRow = typeof sprints.$inferSelect;

interface StoredColumn {
  name: string;
  valueIds: string[];
  wipLimit: number | null;
}

const MAX_BOARD_ISSUES = 500;

function columnsDto(s: SchemaSnapshot, stored: StoredColumn[]): BoardColumn[] {
  return stored.map((c) => ({
    name: c.name,
    values: c.valueIds.map((id) => s.values.get(id)?.name).filter((n): n is string => Boolean(n)),
    wipLimit: c.wipLimit,
  }));
}

function boardDto(s: SchemaSnapshot, row: BoardRow): Board {
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
    sprintsEnabled: row.sprintsEnabled,
  };
}

/** Sprints, counting only the issues the caller can see. */
async function sprintDtos(db: Db, view: AccessView, rows: SprintRow[], s: SchemaSnapshot): Promise<Sprint[]> {
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
      if (!found) throw badRequest(`Unknown value "${name}" for column "${c.name}"`);
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

/** The reference data as the caller sees it, so a board names no project or value they can't see. */
async function scoped(ctx: Ctx): Promise<{ s: SchemaSnapshot; view: AccessView }> {
  const view = await projectAccess(ctx);
  return { s: scopeSchema(await ctx.app.schema.get(), view.visibleIds()), view };
}

export async function listBoards(ctx: Ctx): Promise<Board[]> {
  requireScope(ctx, 'read');
  const { s, view } = await scoped(ctx);
  const rows = await ctx.db.select().from(boards).orderBy(asc(boards.name));
  return rows.filter((r) => seesBoard(view, r)).map((r) => boardDto(s, r));
}

async function loadBoard(ctx: Ctx, id: string, need: 'read' | 'manage' = 'read'): Promise<BoardRow> {
  requireScope(ctx, 'read');
  const [row] = await ctx.db.select().from(boards).where(eq(boards.id, id));
  const view = await projectAccess(ctx);
  // A board on projects the caller can't see is not found, exactly as one that doesn't exist.
  if (!row || !seesBoard(view, row)) throw notFound('Board');
  if (need === 'manage') await assertCanManageBoard(ctx, view, row.projectIds);
  return row;
}

async function assertCanManageBoard(ctx: Ctx, view: AccessView, projectIds: string[]): Promise<void> {
  if (projectIds.some((id) => !view.canRead(id))) {
    throw forbidden('Only managers of every project on this board can change it', 'Ask an administrator.');
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
  sprintsEnabled?: boolean;
}

function resolveBoardInput(s: SchemaSnapshot, input: BoardInput) {
  const projectIds = input.projects.map((k) => {
    const p = projectByKey(s, k);
    if (!p) throw notFound(`Project ${k}`);
    return p.id;
  });
  const columnField = fieldByName(s, input.columnField ?? 'State');
  if (!columnField || !['state', 'enum', 'version'].includes(columnField.type)) {
    throw badRequest(`Column field "${input.columnField ?? 'State'}" must be a field with a list of values`);
  }
  const swimlane = input.swimlaneField ? fieldByName(s, input.swimlaneField) : undefined;
  if (input.swimlaneField && !swimlane) throw notFound(`Field ${input.swimlaneField}`);
  return {
    projectIds,
    columnFieldId: columnField.id,
    columns: resolveColumns(s, columnField.id, projectIds, input.columns),
    swimlaneFieldId: swimlane?.id ?? null,
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
  if (!res.length) throw notFound('Board');
}

export async function boardView(ctx: Ctx, id: string, sprintId?: string): Promise<BoardView> {
  requireScope(ctx, 'read');
  const row = await loadBoard(ctx, id);
  const { s, view } = await scoped(ctx);
  const board = boardDto(s, row);
  const readable = row.projectIds.filter((pid) => view.canRead(pid));
  const sprintRows = await ctx.db.select().from(sprints).where(eq(sprints.boardId, id)).orderBy(asc(sprints.startDate), asc(sprints.createdAt));
  const allSprints = await sprintDtos(ctx.db, view, sprintRows, s);
  let sprint: Sprint | null = null;
  if (row.sprintsEnabled) {
    const today = new Date().toISOString().slice(0, 10);
    sprint =
      (sprintId ? allSprints.find((x) => x.id === sprintId) : undefined) ??
      allSprints.find((x) => !x.archived && (x.startDate ?? '') <= today && (x.endDate ?? '9999') >= today) ??
      allSprints.filter((x) => !x.archived).at(-1) ??
      null;
    if (sprintId && !sprint) throw notFound('Sprint');
  }
  const extraWhere = sprint
    ? sql`EXISTS (SELECT 1 FROM sprint_issues si WHERE si.issue_id = issues.id AND si.sprint_id = ${sprint.id})`
    : undefined;
  const { rows } = await searchIssueRows(ctx, row.query ?? '', { projectIds: readable, extraWhere, limit: MAX_BOARD_ISSUES });
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
    return { ...c, issues: inColumn, count: inColumn.length };
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
      swimlanes = [...new Set(readable.flatMap((pid) => allowedValues(s, field.id, pid).map((v) => v.name)))];
      swimlanes.push('No value');
    }
  }
  return { board, sprint, sprints: allSprints, columns, swimlanes };
}

// Sprints ---------------------------------------------------------------------

export async function createSprint(
  ctx: Ctx,
  boardId: string,
  input: { name: string; goal?: string; startDate?: string | null; endDate?: string | null },
): Promise<Sprint> {
  requireScope(ctx, 'write');
  const board = await loadBoard(ctx, boardId, 'manage');
  if (!board.sprintsEnabled) throw badRequest('This board does not use sprints', 'Enable sprints on the board first.');
  const [row] = await ctx.db
    .insert(sprints)
    .values({ id: newId(), boardId, name: input.name, goal: input.goal ?? '', startDate: input.startDate ?? null, endDate: input.endDate ?? null })
    .returning();
  return (await sprintDtos(ctx.db, await projectAccess(ctx), [row!], await ctx.app.schema.get()))[0]!;
}

/** A sprint on a board the caller sees (404 otherwise, as for one that doesn't exist). */
async function loadSprint(ctx: Ctx, id: string, need: 'read' | 'manage'): Promise<{ sprint: SprintRow; board: BoardRow }> {
  const [sprint] = await ctx.db.select().from(sprints).where(eq(sprints.id, id));
  if (!sprint) throw notFound('Sprint');
  const board = await loadBoard(ctx, sprint.boardId, need).catch((e: unknown) => {
    if (e instanceof AppError && e.status === 404) throw notFound('Sprint');
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
  if (!row) throw notFound('Sprint');
  return (await sprintDtos(ctx.db, await projectAccess(ctx), [row], await ctx.app.schema.get()))[0]!;
}

export async function deleteSprint(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'write');
  await loadSprint(ctx, id, 'manage');
  const res = await ctx.db.delete(sprints).where(eq(sprints.id, id)).returning({ id: sprints.id });
  if (!res.length) throw notFound('Sprint');
}

/** Putting an issue in a sprint, or taking it out, is work on the issue: a member of its project may. */
export async function setSprintIssues(ctx: Ctx, sprintId: string, issueIds: string[], remove: boolean): Promise<Sprint> {
  requireScope(ctx, 'write');
  const { sprint, board } = await loadSprint(ctx, sprintId, 'read');
  const rows = await Promise.all(issueIds.map((id) => resolveIssue(ctx, id)));
  for (const r of rows) {
    if (!board.projectIds.includes(r.projectId)) throw badRequest('An issue from another project cannot join this board\'s sprint');
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
