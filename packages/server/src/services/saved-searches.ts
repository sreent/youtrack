import type { SavedSearch } from '@a4a/shared';
import { and, asc, eq, or } from 'drizzle-orm';
import { isAdmin, requireScope, type Ctx } from '../context';
import { savedSearches } from '../db/schema';
import { forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { prepareQuery } from '../search/service';
import { badRequest } from '../lib/errors';
import { savedSearchChanged } from './subscriptions';
import { userRefDto } from './values';

type Row = typeof savedSearches.$inferSelect;

async function dto(ctx: Ctx, r: Row): Promise<SavedSearch> {
  const s = await ctx.app.schema.get();
  const owner = s.users.get(r.ownerId);
  return { id: r.id, name: r.name, query: r.query, shared: r.shared, owner: owner ? userRefDto(owner) : null };
}

async function validate(ctx: Ctx, query: string) {
  const prepared = await prepareQuery(ctx, query);
  if (prepared.compiled.problems.length) {
    throw badRequest(`Invalid query: ${prepared.compiled.problems.map((p) => p.message).join('; ')}`, undefined, {
      problems: prepared.compiled.problems,
    });
  }
}

/**
 * Your saved searches, and the shared ones that make sense to you. Running one finds only what
 * you can see, as every search does; a shared one that names a project or value you can't see
 * isn't listed at all, so its words don't give that project away.
 */
export async function listSavedSearches(ctx: Ctx): Promise<SavedSearch[]> {
  requireScope(ctx, 'read');
  const rows = await ctx.db
    .select()
    .from(savedSearches)
    .where(or(eq(savedSearches.ownerId, ctx.actor.user.id), eq(savedSearches.shared, true)))
    .orderBy(asc(savedSearches.ordinal), asc(savedSearches.name));
  const out: SavedSearch[] = [];
  for (const r of rows) {
    if (r.ownerId !== ctx.actor.user.id && (await prepareQuery(ctx, r.query)).compiled.problems.length) continue;
    out.push(await dto(ctx, r));
  }
  return out;
}

export async function createSavedSearch(ctx: Ctx, input: { name: string; query: string; shared: boolean }): Promise<SavedSearch> {
  requireScope(ctx, 'write');
  await validate(ctx, input.query);
  const [row] = await ctx.db
    .insert(savedSearches)
    .values({ id: newId(), ownerId: ctx.actor.user.id, name: input.name, query: input.query, shared: input.shared })
    .returning();
  return dto(ctx, row!);
}

async function loadOwned(ctx: Ctx, id: string): Promise<Row> {
  const [row] = await ctx.db.select().from(savedSearches).where(and(eq(savedSearches.id, id)));
  if (!row || (row.ownerId !== ctx.actor.user.id && !row.shared && !isAdmin(ctx))) throw notFound('Saved search');
  if (row.ownerId !== ctx.actor.user.id && !isAdmin(ctx)) throw forbidden('Only its owner can change a saved search');
  return row;
}

export async function updateSavedSearch(
  ctx: Ctx,
  id: string,
  input: { name?: string; query?: string; shared?: boolean },
): Promise<SavedSearch> {
  requireScope(ctx, 'write');
  const before = await loadOwned(ctx, id);
  if (input.query !== undefined) await validate(ctx, input.query);
  const [row] = await ctx.db
    .update(savedSearches)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.shared !== undefined ? { shared: input.shared } : {}),
    })
    .where(eq(savedSearches.id, id))
    .returning();
  // Its subscribers (D31) start over from what a new query finds; unshared, it keeps only its owner's.
  await savedSearchChanged(ctx.app, ctx.db, row!, { query: row!.query !== before.query, unshared: before.shared && !row!.shared });
  return dto(ctx, row!);
}

export async function deleteSavedSearch(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'write');
  await loadOwned(ctx, id);
  await ctx.db.delete(savedSearches).where(eq(savedSearches.id, id));
}
