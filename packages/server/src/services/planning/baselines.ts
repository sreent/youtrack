/**
 * Baselines: a plan as it stood, kept as a snapshot (D10). A project's belong to it, and are the scope
 * `{project: KEY}`'s; a saved search's belong to the search they were taken of, across its projects (D72).
 */
import type { Baseline } from '@a4a/shared';
import { desc, eq } from 'drizzle-orm';
import { isAdmin, requireScope, type Ctx } from '../../context';
import type { Db } from '../../db/client';
import { baselines, baselineTasks } from '../../db/schema';
import { publishActivities, recordActivity } from '../../events/activity';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { computeSchedule } from '../../planning';
import { canReadProject, projectAccess, requireProject, type AccessView } from '../access';
import { projectSettings } from '../projects';
import type { SchemaSnapshot } from '../schema-cache';
import { userRefDto } from '../values';
import { baselineTasksSeen, loadPlan, loadProjectPlan, projectFor, readSavedSearch, type Loaded, type SavedSearchRow } from './load';

type BaselineRow = typeof baselines.$inferSelect;

const missing = () => notFound('Baseline').said('planning.baselineNotFound');

async function baselineDto(ctx: Ctx, s: SchemaSnapshot, row: BaselineRow, count?: number): Promise<Baseline> {
  const by = row.createdById ? s.users.get(row.createdById) : undefined;
  const n =
    count ?? (await ctx.db.select({ id: baselineTasks.issueId }).from(baselineTasks).where(eq(baselineTasks.baselineId, row.id))).length;
  return {
    id: row.id,
    projectKey: (row.projectId ? s.projects.get(row.projectId)?.key : undefined) ?? '',
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

/**
 * A saved search's baseline, as its reader may read it (D37, D64): its tasks they see, their dates, and their
 * money in each project where they have the costs permission, in that project's currency, never converted (D73).
 */
async function searchBaselineDto(ctx: Ctx, s: SchemaSnapshot, view: AccessView, row: BaselineRow): Promise<Baseline> {
  const all = await ctx.db.select().from(baselineTasks).where(eq(baselineTasks.baselineId, row.id));
  const seen = await baselineTasksSeen(ctx, view, all);
  const tasks = all.filter((t) => seen.has(t.issueId));
  const byProject = new Map<string, typeof tasks>();
  for (const t of tasks) if (t.projectId) byProject.set(t.projectId, [...(byProject.get(t.projectId) ?? []), t]);
  const projects = [...byProject]
    .map(([id, ts]) => ({ project: s.projects.get(id), ts }))
    .filter((x): x is { project: NonNullable<typeof x.project>; ts: typeof tasks } => Boolean(x.project))
    .sort((a, b) => (a.project.key < b.project.key ? -1 : a.project.key > b.project.key ? 1 : 0))
    .map(({ project, ts }) => ({
      key: project.key,
      currency: projectSettings(project).plan.currency,
      plannedCost: view.allows(project.id, 'costs') ? Math.round(ts.reduce((sum, t) => sum + t.cost, 0) * 100) / 100 : null,
    }));
  const currency = projects[0]?.currency ?? '';
  const dates = (pick: (t: (typeof tasks)[number]) => string) => tasks.map(pick).sort();
  const by = row.createdById ? s.users.get(row.createdById) : undefined;
  return {
    id: row.id,
    projectKey: '',
    savedSearch: row.savedSearchId ?? undefined,
    name: row.name,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    createdBy: by ? userRefDto(by) : null,
    taskCount: tasks.length,
    start: dates((t) => t.start)[0] ?? null,
    finish: dates((t) => t.finish).at(-1) ?? null,
    plannedCost: Math.round(projects.filter((p) => p.currency === currency).reduce((sum, p) => sum + (p.plannedCost ?? 0), 0) * 100) / 100,
    currency,
    projects,
  };
}

export async function listBaselines(ctx: Ctx, key: string): Promise<Baseline[]> {
  const { s, project } = await projectFor(ctx, key);
  const rows = await ctx.db.select().from(baselines).where(eq(baselines.projectId, project.id)).orderBy(desc(baselines.createdAt));
  return Promise.all(rows.map((r) => baselineDto(ctx, s, r)));
}

/** A saved search's baselines (D72): whoever reads the search reads them, as they see them. A guest has none. */
export async function listSearchBaselines(ctx: Ctx, savedSearchId: string): Promise<Baseline[]> {
  const view = await projectAccess(ctx);
  const search = await readSavedSearch(ctx, savedSearchId, view);
  const s = await ctx.app.schema.get();
  const rows = await ctx.db.select().from(baselines).where(eq(baselines.savedSearchId, search.id)).orderBy(desc(baselines.createdAt));
  return Promise.all(rows.map((r) => searchBaselineDto(ctx, s, view, r)));
}

/** The saved search a baseline was taken of, as the reader reads it; a baseline of one they can't read is missing. */
async function searchOf(ctx: Ctx, view: AccessView, row: BaselineRow): Promise<SavedSearchRow> {
  try {
    return await readSavedSearch(ctx, row.savedSearchId!, view);
  } catch {
    throw missing();
  }
}

export async function getBaseline(ctx: Ctx, id: string): Promise<Baseline> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const view = await projectAccess(ctx);
  const [row] = await ctx.db.select().from(baselines).where(eq(baselines.id, id));
  // A guest reads no baseline (D64), and a baseline of a project or a search the caller can't read is not
  // found, as one that doesn't exist.
  if (!row || view.guest) throw missing();
  if (row.savedSearchId) {
    await searchOf(ctx, view, row);
    return searchBaselineDto(ctx, s, view, row);
  }
  if (!row.projectId || !(await canReadProject(ctx, row.projectId))) throw missing();
  return baselineDto(ctx, s, row);
}

/** What a baseline keeps of a plan: its leaves, each with the project it's in. */
function snapshot(l: Loaded) {
  const schedule = computeSchedule(l.input);
  const leaves = schedule.tasks.filter((t) => !t.isSummary);
  return { schedule, leaves, plannedCost: leaves.reduce((sum, t) => sum + t.plannedCost, 0) };
}

async function insertBaseline(
  ctx: Ctx,
  l: Loaded,
  owner: { projectId: string } | { savedSearchId: string },
  input: { name: string; note?: string },
  internal: { createdAt?: Date } = {},
): Promise<Baseline> {
  const { schedule, leaves, plannedCost } = snapshot(l);
  const id = newId();
  const { row, activities } = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx
      .insert(baselines)
      .values({
        id,
        ...owner,
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
          projectId: l.projectOf.get(t.id) ?? null,
        })),
      );
    }
    const activities = [];
    if ('projectId' in owner) {
      activities.push(
        await recordActivity(tx, ctx, {
          type: 'baseline.created',
          projectId: owner.projectId,
          issueId: null,
          payload: { data: { baselineId: id, name: input.name, tasks: leaves.length, finish: schedule.finish, plannedCost } },
        }),
      );
    } else {
      // A saved search's baseline is told in each project it holds, with what it holds there: its readers
      // learn nothing of the others', and no money, which takes the costs permission (D64).
      for (const p of [...l.projects.values()]) {
        const mine = leaves.filter((t) => l.projectOf.get(t.id) === p.row.id);
        if (!mine.length) continue;
        const finish = mine.map((t) => t.finish).sort().at(-1)!;
        activities.push(
          await recordActivity(tx, ctx, {
            type: 'baseline.created',
            projectId: p.row.id,
            issueId: null,
            payload: { data: { baselineId: id, savedSearchId: owner.savedSearchId, name: input.name, tasks: mine.length, finish } },
          }),
        );
      }
    }
    return { row: row!, activities };
  });
  await publishActivities(ctx.app, activities);
  return 'projectId' in owner ? baselineDto(ctx, l.s, row, leaves.length) : searchBaselineDto(ctx, l.s, l.view, row);
}

/**
 * Snapshot a project's plan as it stands. `asOf` lets the demo seed record a plan of
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
  const l = await loadProjectPlan(ctx, key, { query: input.query, today: internal.asOf, need: 'manage' });
  return insertBaseline(ctx, l, { projectId: l.project.id }, input, internal);
}

/**
 * Whether the caller may keep a saved search's baselines (D72): an administrator, or its owner managing every
 * project in `projectIds`. Anyone else is refused, saying who may.
 */
function assertKeepsSearchBaselines(ctx: Ctx, view: AccessView, s: SchemaSnapshot, search: SavedSearchRow, projectIds: readonly string[]): void {
  if (isAdmin(ctx)) return;
  if (search.ownerId !== ctx.actor.user.id) {
    throw forbidden("Only a saved search's owner keeps its baselines", 'Ask its owner, or an administrator.').said('plans.baselineOnlyOwner');
  }
  const unmanaged = [...new Set(projectIds)]
    .filter((id) => !view.canManage(id))
    .map((id) => s.projects.get(id)?.key ?? id)
    .sort();
  if (unmanaged.length) {
    throw forbidden(
      `A saved search's baselines are kept by its owner managing every project it holds: you don't manage ${unmanaged.join(', ')}`,
      'Ask a manager of those projects or an administrator, or narrow the search to the projects you manage.',
    ).said('plans.baselineNeedsManage', { projects: unmanaged });
  }
}

/**
 * Snapshot a saved search's plan as it stands (D72): the issues its query finds for its owner now. Its owner
 * takes it, managing every project the search holds at that moment, or an administrator does.
 */
export async function createSearchBaseline(ctx: Ctx, savedSearchId: string, input: { name: string; note?: string }): Promise<Baseline> {
  requireScope(ctx, 'write');
  const l = await loadPlan(ctx, { savedSearch: savedSearchId });
  const held = [...l.projects.keys()];
  assertKeepsSearchBaselines(ctx, l.view, l.s, l.savedSearch!, held);
  if (!l.input.tasks.length) throw badRequest('The saved search finds no issues to take a baseline of', 'Take one once it finds some.').said('plans.baselineEmpty');
  return insertBaseline(ctx, l, { savedSearchId: l.savedSearch!.id }, input);
}

export async function deleteBaseline(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const view = await projectAccess(ctx);
  const [row] = await ctx.db.select().from(baselines).where(eq(baselines.id, id));
  if (!row || view.guest) throw missing();
  if (row.savedSearchId) {
    // Kept by whoever may take one: its search's owner managing every project the baseline holds, or an administrator.
    const search = await searchOf(ctx, view, row);
    const held = (await ctx.db.select({ projectId: baselineTasks.projectId }).from(baselineTasks).where(eq(baselineTasks.baselineId, row.id)))
      .map((t) => t.projectId)
      .filter((p): p is string => Boolean(p));
    assertKeepsSearchBaselines(ctx, view, s, search, held);
  } else {
    if (!row.projectId || !(await canReadProject(ctx, row.projectId))) throw missing();
    await requireProject(ctx, s.projects.get(row.projectId)?.key ?? '', 'manage');
  }
  await ctx.db.delete(baselines).where(eq(baselines.id, id));
}
