/**
 * A project's work types (docs/architecture.md, D43): the kinds of work people log time as.
 * Managers of the project keep the list; a project can require one on every work item.
 */
import type { WorkType } from '@a4a/shared';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { workItems, workTypes } from '../db/schema';
import { badRequest, conflict, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { requireProject } from './access';

export type WorkTypeRow = typeof workTypes.$inferSelect;

export function workTypeDto(r: WorkTypeRow): WorkType {
  return { id: r.id, name: r.name, ordinal: r.ordinal, archived: r.archived };
}

async function typesOf(db: Db, projectId: string): Promise<WorkTypeRow[]> {
  return db.select().from(workTypes).where(eq(workTypes.projectId, projectId)).orderBy(asc(workTypes.ordinal), asc(workTypes.createdAt));
}

export async function listWorkTypes(ctx: Ctx, projectKey: string): Promise<WorkType[]> {
  requireScope(ctx, 'read');
  const p = await requireProject(ctx, projectKey);
  return (await typesOf(ctx.db, p.id)).map(workTypeDto);
}

function sameName(rows: WorkTypeRow[], name: string, except?: string): WorkTypeRow | undefined {
  return rows.find((r) => r.id !== except && r.name.toLowerCase() === name.toLowerCase());
}

export async function createWorkType(ctx: Ctx, projectKey: string, input: { name: string }): Promise<WorkType> {
  requireScope(ctx, 'write');
  const p = await requireProject(ctx, projectKey, 'manage');
  const name = input.name.trim();
  const rows = await typesOf(ctx.db, p.id);
  const taken = sameName(rows, name);
  if (taken) throw conflict(`${p.key} already has the work type ${taken.name}`).said('workTypes.alreadyHas', { key: p.key, taken: taken.name });
  const ordinal = rows.reduce((max, r) => Math.max(max, r.ordinal + 1), 0);
  const [row] = await ctx.db.insert(workTypes).values({ id: newId(), projectId: p.id, name, ordinal }).returning();
  return workTypeDto(row!);
}

/** A work type in a project the caller manages; one in a project they can't see is not found. */
async function loadForManager(ctx: Ctx, id: string): Promise<WorkTypeRow> {
  const [row] = await ctx.db.select().from(workTypes).where(eq(workTypes.id, id));
  const project = row ? (await ctx.app.schema.get()).projects.get(row.projectId) : undefined;
  if (!row || !project) throw notFound('Work type').said('workTypes.notFound');
  await requireProject(ctx, project.key, 'manage').catch((e: unknown) => {
    if (e instanceof Error && 'status' in e && e.status === 404) throw notFound('Work type').said('workTypes.notFound');
    throw e;
  });
  return row;
}

export async function updateWorkType(ctx: Ctx, id: string, input: { name?: string; archived?: boolean; ordinal?: number }): Promise<WorkType> {
  requireScope(ctx, 'write');
  const row = await loadForManager(ctx, id);
  const name = input.name?.trim();
  if (name) {
    const taken = sameName(await typesOf(ctx.db, row.projectId), name, row.id);
    if (taken) throw conflict(`There is already a work type called ${taken.name}`).said('workTypes.nameTaken', { taken: taken.name });
  }
  const [updated] = await ctx.db
    .update(workTypes)
    .set({
      ...(name ? { name } : {}),
      ...(input.archived !== undefined ? { archived: input.archived } : {}),
      ...(input.ordinal !== undefined ? { ordinal: input.ordinal } : {}),
    })
    .where(eq(workTypes.id, id))
    .returning();
  return workTypeDto(updated!);
}

/** Only a type nobody has logged work as can go; one that has been used is archived instead. */
export async function deleteWorkType(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'write');
  const row = await loadForManager(ctx, id);
  const [used] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(workItems).where(eq(workItems.workTypeId, id));
  if (Number(used?.n ?? 0) > 0) {
    throw conflict(`Work has been logged as ${row.name}`, 'Archive it instead: it stays on that work, and is no longer offered.').said('workTypes.inUse', { name: row.name });
  }
  await ctx.db.delete(workTypes).where(eq(workTypes.id, id));
}

/**
 * The work type `input` names (its id, or its name in any case) in a project, for work logged
 * there; none when nothing is named and the project doesn't require one (D43).
 */
export async function resolveWorkType(
  db: Db,
  project: { id: string; key: string },
  input: string | null | undefined,
  required: boolean,
): Promise<WorkTypeRow | null> {
  const rows = await typesOf(db, project.id);
  const offered = rows.filter((r) => !r.archived).map((r) => r.name);
  const choose = offered.length ? `Choose one of: ${offered.join(', ')}.` : 'A manager of the project can add work types.';
  const named = input?.trim();
  if (!named) {
    if (required) throw badRequest(`Work logged in ${project.key} needs a work type`, choose).said('workTypes.needed', { project: project.key, n: offered.length, types: offered });
    return null;
  }
  const found = rows.find((r) => r.id === named) ?? rows.find((r) => r.name.toLowerCase() === named.toLowerCase());
  if (!found) throw badRequest(`${project.key} has no work type "${named}"`, choose).said('workTypes.unknown', { project: project.key, name: named, n: offered.length, types: offered });
  if (found.archived) throw badRequest(`The work type ${found.name} is archived`, choose).said('workTypes.archived', { name: found.name, n: offered.length, types: offered });
  return found;
}

/** Names of work types by id, for showing work items. */
export async function workTypeNames(db: Db, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!wanted.length) return new Map();
  const rows = await db
    .select({ id: workTypes.id, name: workTypes.name })
    .from(workTypes)
    .where(inArray(workTypes.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name]));
}
