/**
 * Subscriptions (D31). A person asks to be told of a project's new issues, or of every change in it;
 * or of an issue coming into a saved search, or of any change to one in it. They are a person's own,
 * as watching is: nobody else's can be listed or changed. The notifier tells them (notify/subscribed.ts).
 *
 * A saved-search subscription keeps the issues its search finds for its person (subscription_issues),
 * so that an issue coming into the search can be told from one that was in it already. It finds them
 * as its person would signing in, whatever token or channel made it, because that's how the notifier
 * reads it afterwards.
 */
import type { Subscription, SubscriptionEvents } from '@a4a/shared';
import { and, asc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { effectiveScopes, requireScope, type AppServices, type Ctx, type UserRow } from '../context';
import type { Db } from '../db/client';
import { issues, projects, savedSearches, subscriptionIssues, subscriptions } from '../db/schema';
import { asSentence, badRequest, notFound, saidProblems } from '../lib/errors';
import { newId } from '../lib/ids';
import { prepareQuery } from '../search/service';
import { projectAccess, requireProject } from './access';
import { keyNow, type SchemaSnapshot } from './schema-cache';
import { requirePersonal } from './watchers';

type Row = typeof subscriptions.$inferSelect;
type SearchRow = typeof savedSearches.$inferSelect;

/** A person as they would sign in: their role's scopes, no token's limits. For reading their searches away from any request. */
export function personCtx(app: AppServices, user: UserRow, db: Db = app.db): Ctx {
  return {
    app,
    db,
    actor: { user, scopes: effectiveScopes(user.role), channel: 'system', tokenId: null, tokenName: null, authMethod: 'session', projectIds: null },
  };
}

/** What a subscription tells of, in words, starting with a capital: "New issues in Backend". */
export function aboutWords(target: { project?: { name: string } | null; search?: { name: string } | null }, events: SubscriptionEvents): string {
  if (target.project) return events === 'all' ? `Every change in ${target.project.name}` : `New issues in ${target.project.name}`;
  const name = `“${target.search?.name ?? 'a saved search'}”`;
  return events === 'all' ? `Changes to issues in ${name}` : `Issues coming into ${name}`;
}

/** The same words inside a sentence: "you subscribed to new issues in Backend". */
export function aboutInline(about: string): string {
  return about.charAt(0).toLowerCase() + about.slice(1);
}

function eventsOf(row: Pick<Row, 'events'>): SubscriptionEvents {
  return row.events === 'all' ? 'all' : 'new';
}

function dto(row: Row, project: { key: string; name: string } | null, search: SearchRow | null): Subscription {
  const target = project ? { project } : { search: search ? { name: search.name } : null };
  return {
    id: row.id,
    target: project ? 'project' : 'search',
    project,
    search: search ? { id: search.id, name: search.name, query: search.query } : null,
    events: eventsOf(row),
    email: row.email,
    about: aboutWords(target, eventsOf(row)),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Whether a person may follow a saved search: their own, or one shared with everyone. */
function followable(search: SearchRow, userId: string): boolean {
  return search.ownerId === userId || search.shared;
}

/**
 * Whether whoever asks may see a saved search at all: their own, or a shared one that reads for them.
 * One that names a project or a value they can't see is hidden, as GET /saved-searches hides it, so
 * its words don't give that project away; to them it answers as one that doesn't exist.
 */
async function seen(ctx: Ctx, search: SearchRow): Promise<boolean> {
  if (search.ownerId === ctx.actor.user.id) return true;
  if (!search.shared) return false;
  return (await prepareQuery(ctx, search.query)).compiled.problems.length === 0;
}

/**
 * A person's subscriptions as they may see them now: one to a project they no longer see is left out
 * (it tells them nothing either), and so is one to a search no longer shared with them, or one that
 * names what they can't see.
 */
async function visible(ctx: Ctx, rows: { sub: Row; search: SearchRow | null }[]): Promise<Subscription[]> {
  const view = await projectAccess(ctx);
  const s = await ctx.app.schema.get();
  const out: Subscription[] = [];
  for (const { sub, search } of rows) {
    if (sub.projectId) {
      const p = s.projects.get(sub.projectId);
      if (!p || !view.canRead(p.id)) continue;
      out.push(dto(sub, { key: p.key, name: p.name }, null));
    } else if (search && followable(search, sub.userId) && (await seen(ctx, search))) {
      out.push(dto(sub, null, search));
    }
  }
  return out;
}

async function rowsOf(db: Db, where: SQL | undefined): Promise<{ sub: Row; search: SearchRow | null }[]> {
  const rows = await db
    .select({ sub: subscriptions, search: savedSearches })
    .from(subscriptions)
    .leftJoin(savedSearches, eq(savedSearches.id, subscriptions.savedSearchId))
    .where(where)
    .orderBy(asc(subscriptions.createdAt), asc(subscriptions.id));
  return rows;
}

/** Your subscriptions, oldest first. Reading them needs only "read", as reading your inbox does. */
export async function listSubscriptions(ctx: Ctx): Promise<Subscription[]> {
  requireScope(ctx, 'read');
  return visible(ctx, await rowsOf(ctx.db, eq(subscriptions.userId, ctx.actor.user.id)));
}

async function own(ctx: Ctx, id: string): Promise<Subscription> {
  const found = await visible(ctx, await rowsOf(ctx.db, and(eq(subscriptions.id, id), eq(subscriptions.userId, ctx.actor.user.id))));
  if (!found[0]) throw notFound('Subscription', "Subscriptions are only ever their own person's: list yours with GET /subscriptions.").said('subscriptions.notFoundList');
  return found[0];
}

export async function getSubscription(ctx: Ctx, id: string): Promise<Subscription> {
  requireScope(ctx, 'read');
  return own(ctx, id);
}

/**
 * Fill a saved-search subscription's issues with what its search finds now, for its person. What
 * was in it already isn't news: only what comes in afterwards is told.
 */
async function fill(app: AppServices, db: Db, sub: Pick<Row, 'id' | 'userId'>, search: SearchRow): Promise<void> {
  await db.delete(subscriptionIssues).where(eq(subscriptionIssues.subscriptionId, sub.id));
  const s = await app.schema.get();
  const user = s.users.get(sub.userId);
  if (!user || user.banned || !followable(search, sub.userId)) return;
  const prepared = await prepareQuery(personCtx(app, user, db), search.query);
  if (prepared.compiled.problems.length) return;
  const where = prepared.compiled.where ?? sql`TRUE`;
  await db.execute(
    sql`INSERT INTO subscription_issues (subscription_id, issue_id) SELECT ${sub.id}, ${issues.id} FROM ${issues} WHERE ${where} ON CONFLICT DO NOTHING`,
  );
}

/**
 * Subscribe to a project or to a saved search, or change what an existing subscription to it tells.
 * The same call twice is the same subscription.
 */
export async function subscribe(
  ctx: Ctx,
  input: { project?: string; savedSearch?: string; events?: SubscriptionEvents; email?: boolean },
): Promise<Subscription> {
  requirePersonal(ctx);
  if (Boolean(input.project) === Boolean(input.savedSearch)) {
    throw badRequest('Say what to subscribe to', 'Send a project\'s key as "project", or a saved search\'s id as "savedSearch": one of them.').said('subscriptions.sayWhat');
  }
  const events: SubscriptionEvents = input.events === 'all' ? 'all' : 'new';
  const email = input.email ?? true;
  const userId = ctx.actor.user.id;
  if (input.project) {
    // A project you can't see is not found, in the words used for one that doesn't exist.
    const p = await requireProject(ctx, input.project, 'read');
    const [row] = await ctx.db
      .insert(subscriptions)
      .values({ id: newId(), userId, projectId: p.id, events, email })
      .onConflictDoUpdate({ target: [subscriptions.userId, subscriptions.projectId], set: { events, email, updatedAt: new Date() } })
      .returning();
    return own(ctx, row!.id);
  }
  const id = input.savedSearch!;
  const [search] = await ctx.db.select().from(savedSearches).where(eq(savedSearches.id, id));
  const missing = () => notFound('Saved search', 'List the ones you can follow with GET /saved-searches.').said('subscriptions.searchNotFoundList');
  // Someone else's search that isn't shared, or names what you can't see, is not found, as one that doesn't exist.
  if (!search || !followable(search, userId) || !(await seen(ctx, search))) throw missing();
  // Your own search that no longer reads (a value renamed since) can't say what comes into it: fix it first.
  const prepared = await prepareQuery(ctx, search.query);
  if (prepared.compiled.problems.length) {
    const problems = asSentence(prepared.compiled.problems.map((p) => p.message).join('; '));
    throw badRequest(`“${search.name}” doesn't read`, `${problems} Change it on the Issues page first.`).said('subscriptions.searchDoesntReadSaying', { search: search.name, problems: saidProblems(prepared.compiled.problems) });
  }
  const subId = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [had] = await tx
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), eq(subscriptions.savedSearchId, search.id)))
      .for('update');
    if (had) {
      await tx.update(subscriptions).set({ events, email, updatedAt: new Date() }).where(eq(subscriptions.id, had.id));
      return had.id;
    }
    const [row] = await tx
      .insert(subscriptions)
      .values({ id: newId(), userId, savedSearchId: search.id, events, email })
      .onConflictDoNothing()
      .returning();
    // Two at once: the other one made it, and filled it.
    if (!row) return null;
    await fill(ctx.app, tx, row, search);
    return row.id;
  });
  if (subId) return own(ctx, subId);
  const [made] = await ctx.db.select().from(subscriptions).where(and(eq(subscriptions.userId, userId), eq(subscriptions.savedSearchId, search.id)));
  if (!made) throw notFound('Subscription').said('subscriptions.notFound');
  await ctx.db.update(subscriptions).set({ events, email, updatedAt: new Date() }).where(eq(subscriptions.id, made.id));
  return own(ctx, made.id);
}

/**
 * A saved search you may follow, by its id or its name (yours, or a shared one): what an agent knows
 * a search by. Several of one name are refused with their names; one you can't follow isn't found.
 */
export async function findFollowableSearch(ctx: Ctx, idOrName: string): Promise<SearchRow> {
  const userId = ctx.actor.user.id;
  const [byId] = await ctx.db.select().from(savedSearches).where(eq(savedSearches.id, idOrName));
  if (byId && followable(byId, userId) && (await seen(ctx, byId))) return byId;
  const wanted = idOrName.trim().toLowerCase();
  const named: SearchRow[] = [];
  // Only those you may see: one hidden from you doesn't even make a name ambiguous.
  for (const r of await ctx.db.select().from(savedSearches).where(sql`lower(${savedSearches.name}) = ${wanted}`)) {
    if (followable(r, userId) && (await seen(ctx, r))) named.push(r);
  }
  // Your own first, as the issues page lists them.
  const mine = named.filter((r) => r.ownerId === userId);
  const pick = mine.length ? mine : named;
  if (pick.length === 1) return pick[0]!;
  if (pick.length > 1) throw badRequest(`Several saved searches are called “${idOrName}”`, 'Use the id of the one you mean.').said('subscriptions.searchAmbiguous', { name: idOrName });
  throw notFound(`Saved search “${idOrName}”`, 'Use the name or id of one of yours, or of a shared one.').said('subscriptions.searchNotFound', { name: idOrName });
}

/** Your subscription to a project or a saved search, if you have one. */
export async function subscriptionTo(ctx: Ctx, target: { project?: string; savedSearch?: string }): Promise<Subscription | null> {
  const mine = await listSubscriptions(ctx);
  // Named by a key it had before it was renamed (D52), it's the same project.
  if (target.project) {
    const key = keyNow(await ctx.app.schema.get(), target.project.trim()).toUpperCase();
    return mine.find((s) => s.project?.key.toUpperCase() === key) ?? null;
  }
  return mine.find((s) => s.search?.id === target.savedSearch) ?? null;
}

/** Change what one of your subscriptions tells, or whether it emails. */
export async function updateSubscription(ctx: Ctx, id: string, input: { events?: SubscriptionEvents; email?: boolean }): Promise<Subscription> {
  requirePersonal(ctx);
  await own(ctx, id);
  await ctx.db
    .update(subscriptions)
    .set({ ...(input.events !== undefined ? { events: input.events } : {}), ...(input.email !== undefined ? { email: input.email } : {}), updatedAt: new Date() })
    .where(and(eq(subscriptions.id, id), eq(subscriptions.userId, ctx.actor.user.id)));
  return own(ctx, id);
}

/** End one of your subscriptions. What it brought stays in your inbox. */
export async function unsubscribe(ctx: Ctx, id: string): Promise<void> {
  requirePersonal(ctx);
  await own(ctx, id);
  await ctx.db.delete(subscriptions).where(and(eq(subscriptions.id, id), eq(subscriptions.userId, ctx.actor.user.id)));
}

// ---------------------------------------------------------------------------
// When a saved search changes
// ---------------------------------------------------------------------------

/**
 * A saved search's query changed: each subscription to it starts over from what it finds now, quietly
 * (what the new query finds was there before anyone said "come in"). One no longer shared leaves only
 * its owner subscribed.
 */
export async function savedSearchChanged(app: AppServices, db: Db, search: SearchRow, change: { query: boolean; unshared: boolean }): Promise<void> {
  if (change.unshared) {
    // One with no owner (D72) leaves nobody subscribed.
    await db.delete(subscriptions).where(and(eq(subscriptions.savedSearchId, search.id), search.ownerId ? ne(subscriptions.userId, search.ownerId) : undefined));
  }
  if (!change.query) return;
  const subs = await db.select({ id: subscriptions.id, userId: subscriptions.userId }).from(subscriptions).where(eq(subscriptions.savedSearchId, search.id));
  for (const sub of subs) await fill(app, db, sub, search);
}

// ---------------------------------------------------------------------------
// For the inbox and email: what brought a notification
// ---------------------------------------------------------------------------

/** What brought a notification: a subscription, said in English for the API, and what a page or an email words it from (D49). */
export interface SubscriptionAbout {
  /** "New issues in Backend". */
  about: string;
  target: 'project' | 'search';
  events: SubscriptionEvents;
  /** The project's name, or the saved search's. */
  name: string;
  userId: string;
  email: boolean;
}

/** What each of these subscriptions tells of, by id. Ended ones are left out. */
export async function aboutSubscriptions(db: Db, s: SchemaSnapshot, ids: string[]): Promise<Map<string, SubscriptionAbout>> {
  const out = new Map<string, SubscriptionAbout>();
  const unique = [...new Set(ids)];
  if (!unique.length) return out;
  const rows = await db
    .select({ sub: subscriptions, search: savedSearches, project: { key: projects.key, name: projects.name } })
    .from(subscriptions)
    .leftJoin(savedSearches, eq(savedSearches.id, subscriptions.savedSearchId))
    .leftJoin(projects, eq(projects.id, subscriptions.projectId))
    .where(inArray(subscriptions.id, unique));
  for (const r of rows) {
    if (r.sub.savedSearchId && (!r.search || !followable(r.search, r.sub.userId))) continue;
    const project = r.sub.projectId ? (s.projects.get(r.sub.projectId) ?? r.project) : null;
    out.set(r.sub.id, {
      about: aboutWords(project ? { project } : { search: r.search }, eventsOf(r.sub)),
      target: project ? 'project' : 'search',
      events: eventsOf(r.sub),
      name: project ? project.name : r.search!.name,
      userId: r.sub.userId,
      email: r.sub.email,
    });
  }
  return out;
}
