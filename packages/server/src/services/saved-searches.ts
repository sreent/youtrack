import { ViewSettingsSchema, viewSettingsOf, type SavedSearch, type UpdateSavedSearchInput, type ViewSettings } from '@a4a/shared';
import { and, asc, count, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { isAdmin, requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { baselines, savedSearches, users } from '../db/schema';
import { badRequest, conflict, forbidden, notFound, saidProblems } from '../lib/errors';
import { newId } from '../lib/ids';
import { prepareQuery } from '../search/service';
import { visibleSchema } from './access';
import { fieldByName } from './schema-cache';
import { savedSearchChanged } from './subscriptions';
import { userRefDto } from './values';

type Row = typeof savedSearches.$inferSelect;

async function dto(ctx: Ctx, r: Row): Promise<SavedSearch> {
  const s = await ctx.app.schema.get();
  const owner = r.ownerId ? s.users.get(r.ownerId) : undefined;
  return { id: r.id, name: r.name, query: r.query, shared: r.shared, owner: owner ? userRefDto(owner) : null, view: viewSettingsOf(r.view), version: r.version };
}

async function validate(ctx: Ctx, query: string) {
  const prepared = await prepareQuery(ctx, query);
  if (prepared.compiled.problems.length) {
    throw badRequest(`Invalid query: ${prepared.compiled.problems.map((p) => p.message).join('; ')}`, undefined, {
      problems: prepared.compiled.problems,
    }).said('savedSearches.queryDoesntRead', { problems: saidProblems(prepared.compiled.problems) });
  }
}

/**
 * A view as it's kept (D72): read through the schema, so its caps hold on every channel, and grouped by a
 * field the one saving it knows, by name. Whether every project of its issues has the field is the list's
 * to say: an issue of a project without it is in the group of issues with none.
 */
async function viewToKeep(ctx: Ctx, view: unknown): Promise<ViewSettings> {
  const parsed = ViewSettingsSchema.safeParse(view);
  if (!parsed.success) throw badRequest('That view isn’t one a saved search keeps', 'See ViewSettings in the API’s reference: a view’s kind, its grouping and each view’s settings, each within its limits.', parsed.error.issues).said('savedSearches.viewDoesntRead');
  const v = parsed.data;
  if (v.group !== null) {
    const field = fieldByName(await visibleSchema(ctx), v.group);
    if (!field || field.type === 'text') {
      throw badRequest(`Cannot group issues by "${v.group}"`, 'Group them by a field of their projects, by its name, other than a text field.').said('issues.cannotGroupBy', { field: v.group });
    }
    v.group = field.name;
  }
  return v;
}

/**
 * Your saved searches, and the shared ones that make sense to you. Running one finds only what
 * you can see, as every search does; a shared one that names a project or value you can't see
 * isn't listed at all, so its words don't give that project away.
 *
 * One whose owner was deleted (D72) is nobody's own: to everyone it's a shared one, by the same rule,
 * and administrators, who adopt it, mend it or delete it, see every one, whether or not it reads.
 */
export async function listSavedSearches(ctx: Ctx): Promise<SavedSearch[]> {
  requireScope(ctx, 'read');
  const admin = isAdmin(ctx);
  const rows = await ctx.db
    .select()
    .from(savedSearches)
    .where(or(eq(savedSearches.ownerId, ctx.actor.user.id), eq(savedSearches.shared, true), admin ? isNull(savedSearches.ownerId) : undefined))
    .orderBy(asc(savedSearches.ordinal), asc(savedSearches.name));
  const out: SavedSearch[] = [];
  for (const r of rows) {
    const theirs = r.ownerId === ctx.actor.user.id || (admin && r.ownerId === null);
    if (!theirs && (await prepareQuery(ctx, r.query)).compiled.problems.length) continue;
    out.push(await dto(ctx, r));
  }
  return out;
}

export async function createSavedSearch(ctx: Ctx, input: { name: string; query: string; shared: boolean; view?: ViewSettings }): Promise<SavedSearch> {
  requireScope(ctx, 'write');
  await validate(ctx, input.query);
  const view = input.view ? await viewToKeep(ctx, input.view) : undefined;
  const [row] = await ctx.db
    .insert(savedSearches)
    .values({ id: newId(), ownerId: ctx.actor.user.id, name: input.name, query: input.query, shared: input.shared, ...(view ? { view } : {}) })
    .returning();
  return dto(ctx, row!);
}

/**
 * Before someone is deleted, in the transaction that deletes them: their private searches go with them,
 * and their shared ones stay, the delete leaving them without an owner (D72). Their row is locked first,
 * so no search of theirs is made meanwhile, then their searches, so none is unshared in between.
 */
export async function deletePrivateSearchesOf(tx: Db, userId: string): Promise<void> {
  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
  await tx.select({ id: savedSearches.id }).from(savedSearches).where(eq(savedSearches.ownerId, userId)).for('update');
  await tx.delete(savedSearches).where(and(eq(savedSearches.ownerId, userId), eq(savedSearches.shared, false)));
}

const missing = () => notFound('Saved search').said('savedSearches.notFound');
/** One whose owner was deleted (D72): nobody's to change until an administrator adopts it. */
const ownerless = () => forbidden('Nobody owns this saved search now: its owner was deleted', 'An administrator can adopt it, and then change it.').said('savedSearches.ownerless');

/**
 * Whether they may change it: its owner, or an administrator; one with no owner (D72) only an
 * administrator. What they don't see (another's private search) is missing.
 */
function mayChange(ctx: Ctx, row: Row | undefined): Row {
  const admin = isAdmin(ctx);
  if (!row || (row.ownerId !== ctx.actor.user.id && !row.shared && !admin)) throw missing();
  if (row.ownerId === null && !admin) throw ownerless();
  if (row.ownerId !== ctx.actor.user.id && !admin) throw forbidden('Only its owner can change a saved search').said('savedSearches.onlyOwner');
  return row;
}

async function loadOwned(ctx: Ctx, id: string): Promise<Row> {
  const [row] = await ctx.db.select().from(savedSearches).where(eq(savedSearches.id, id));
  return mayChange(ctx, row);
}

/** The rows a change of theirs may write: a non-administrator's own only, so an adoption or a delete meanwhile isn't written over. */
function writable(ctx: Ctx, id: string): SQL {
  return isAdmin(ctx) ? eq(savedSearches.id, id) : and(eq(savedSearches.id, id), eq(savedSearches.ownerId, ctx.actor.user.id))!;
}

/**
 * Change a saved search: its name, query, sharing or view (D72). Every change counts in its version;
 * with `expectedVersion`, one made since is refused (409, with the version now) rather than written over,
 * the check made by the write itself, so of two changes sent with the same version only one is kept.
 */
export async function updateSavedSearch(ctx: Ctx, id: string, input: UpdateSavedSearchInput): Promise<SavedSearch> {
  requireScope(ctx, 'write');
  const before = await loadOwned(ctx, id);
  if (input.query !== undefined) await validate(ctx, input.query);
  const view = input.view !== undefined ? await viewToKeep(ctx, input.view) : undefined;
  const conds = [writable(ctx, id)];
  if (input.expectedVersion !== undefined) conds.push(eq(savedSearches.version, input.expectedVersion));
  const [row] = await ctx.db
    .update(savedSearches)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.shared !== undefined ? { shared: input.shared } : {}),
      ...(view !== undefined ? { view } : {}),
      version: sql`${savedSearches.version} + 1`,
    })
    .where(and(...conds))
    .returning();
  if (!row) {
    // Someone came first: it was deleted, adopted or changed since it was read.
    const [now] = await ctx.db.select().from(savedSearches).where(eq(savedSearches.id, id));
    mayChange(ctx, now);
    throw conflict(`"${now!.name}" was changed since you read it (version ${now!.version}, you sent ${input.expectedVersion})`, 'Read it again, then make your change again.', {
      currentVersion: now!.version,
    }).said('savedSearches.changedSince', { name: now!.name, version: now!.version, expectedVersion: String(input.expectedVersion) });
  }
  // Its subscribers (D31) start over from what a new query finds; unshared, it keeps only its owner's.
  await savedSearchChanged(ctx.app, ctx.db, row, { query: row.query !== before.query, unshared: before.shared && !row.shared });
  return dto(ctx, row);
}

/**
 * An administrator adopts a saved search whose owner was deleted (D72): it becomes theirs, to change as
 * its owner, view and all. Taken by the write itself, so of two administrators adopting it at once one
 * does, and the other is told it has an owner.
 */
export async function adoptSavedSearch(ctx: Ctx, id: string): Promise<SavedSearch> {
  requireScope(ctx, 'write');
  const [before] = await ctx.db.select().from(savedSearches).where(eq(savedSearches.id, id));
  if (!before || (before.ownerId !== ctx.actor.user.id && !before.shared && !isAdmin(ctx))) throw missing();
  if (!isAdmin(ctx)) throw before.ownerId === null ? ownerless() : forbidden('Only an administrator can adopt a saved search, and only one whose owner was deleted').said('savedSearches.adoptIsAdmins');
  const [row] = await ctx.db
    .update(savedSearches)
    .set({ ownerId: ctx.actor.user.id, version: sql`${savedSearches.version} + 1` })
    .where(and(eq(savedSearches.id, id), isNull(savedSearches.ownerId)))
    .returning();
  if (!row) {
    const [now] = await ctx.db.select().from(savedSearches).where(eq(savedSearches.id, id));
    if (!now) throw missing();
    const s = await ctx.app.schema.get();
    const owner = now.ownerId ? (s.users.get(now.ownerId)?.name ?? '') : '';
    throw conflict(`"${now.name}" has an owner: ${owner}`, 'Only a saved search whose owner was deleted can be adopted.').said('savedSearches.hasOwner', { name: now.name, owner });
  }
  return dto(ctx, row);
}

/**
 * Delete a saved search. Its baselines (D72) go with it, so one that has any is refused unless the
 * deletion says so (`confirm`), with how many. Its row is locked first: a baseline being taken of it
 * meanwhile either is counted or waits, and then finds it gone.
 */
export async function deleteSavedSearch(ctx: Ctx, id: string, opts: { confirm?: boolean } = {}): Promise<void> {
  requireScope(ctx, 'write');
  await ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(savedSearches).where(eq(savedSearches.id, id)).for('update');
    mayChange(ctx, row);
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(baselines).where(eq(baselines.savedSearchId, id));
    if (Number(n) > 0 && !opts.confirm) {
      const many = Number(n);
      throw conflict(
        `"${row!.name}" has ${many === 1 ? 'a baseline' : `${many} baselines`}, which would be deleted with it`,
        'Send confirm=true to delete them with it.',
        { baselines: many },
      ).said('savedSearches.hasBaselines', { name: row!.name, n: many });
    }
    await tx.delete(savedSearches).where(eq(savedSearches.id, id));
  });
}
