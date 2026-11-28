/** Baselines: a plan as it stood, kept as a snapshot (D10). */
import type { Baseline } from '@a4a/shared';
import { desc, eq } from 'drizzle-orm';
import { requireScope, type Ctx } from '../../context';
import type { Db } from '../../db/client';
import { baselines, baselineTasks } from '../../db/schema';
import { publishActivities, recordActivity } from '../../events/activity';
import { notFound } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { computeSchedule } from '../../planning';
import { canReadProject, requireProject } from '../access';
import type { SchemaSnapshot } from '../schema-cache';
import { userRefDto } from '../values';
import { loadPlan, projectFor } from './load';

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
