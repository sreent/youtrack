/**
 * Who watches an issue. People watch what they chose to, and what they took part in: the issue
 * they reported, were assigned, commented on or were mentioned in. Unwatching removes them until
 * they take part again (as GitHub does), so a later comment or assignment watches it again.
 *
 * Watching is the person's own business, like their tokens: it is not a change to the issue, so it
 * goes into no history and no webhook, and a viewer may watch what they can read.
 */
import { findMentions, newMentions, type WatchReason, type Watchers } from '@a4a/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { issueWatchers } from '../db/schema';
import { resolveIssue } from './issues';
import { fieldByName, type FieldRow, type SchemaSnapshot } from './schema-cache';
import type { ResolvedValue } from './values';
import { userRefDto } from './values';

/** Personal state (watching, notifications, email): any signed-in role may keep its own; a token needs "write". */
export function requirePersonal(ctx: Ctx): void {
  requireScope(ctx, 'read');
  if (ctx.actor.authMethod === 'token') requireScope(ctx, 'write');
}

/** The field that says who does the work: "Assignee", or else the first person field. */
export function assigneeFieldOf(s: SchemaSnapshot): FieldRow | undefined {
  const named = fieldByName(s, 'Assignee');
  if (named?.type === 'user') return named;
  for (const f of s.fields.values()) if (f.type === 'user') return f;
  return undefined;
}

/** A login as typed, as stored, for people who can be told: known and not banned. */
export function knownLogin(s: SchemaSnapshot): (login: string) => string | null {
  return (login) => {
    const u = s.usersByLogin.get(login.toLowerCase());
    return u && !u.banned ? u.login : null;
  };
}

export function mentionsIn(s: SchemaSnapshot, text: string): string[] {
  return findMentions(text, knownLogin(s));
}

export function mentionsAdded(s: SchemaSnapshot, before: string, after: string): string[] {
  return newMentions(before, after, knownLogin(s));
}

/** Logins of people a set of values names, in order. */
export function loginsOf(s: SchemaSnapshot, values: ResolvedValue[] | undefined): string[] {
  return (values ?? []).map((v) => (v.userId ? s.users.get(v.userId)?.login : undefined)).filter((l): l is string => Boolean(l));
}

/**
 * Watch an issue for these people, inside the caller's transaction. Someone already watching keeps
 * their first reason. Agents (bot users) and banned people never watch: an agent is told only when
 * it is mentioned or assigned.
 */
export async function addWatchers(tx: Db, s: SchemaSnapshot, issueId: string, entries: { login: string; reason: WatchReason }[]): Promise<void> {
  const seen = new Set<string>();
  const rows: (typeof issueWatchers.$inferInsert)[] = [];
  for (const e of entries) {
    const u = s.usersByLogin.get(e.login.toLowerCase());
    if (!u || u.isBot || u.banned || seen.has(u.id)) continue;
    seen.add(u.id);
    rows.push({ issueId, userId: u.id, reason: e.reason });
  }
  if (rows.length) await tx.insert(issueWatchers).values(rows).onConflictDoNothing();
}

export async function watcherIds(db: Db, issueId: string): Promise<string[]> {
  const rows = await db.select({ userId: issueWatchers.userId }).from(issueWatchers).where(eq(issueWatchers.issueId, issueId));
  return rows.map((r) => r.userId);
}

/** Whether `userId` watches each of these issues (for lists). */
export async function watchedAmong(db: Db, userId: string, issueIds: string[]): Promise<Set<string>> {
  if (!issueIds.length) return new Set();
  const rows = await db
    .select({ issueId: issueWatchers.issueId })
    .from(issueWatchers)
    .where(and(eq(issueWatchers.userId, userId), inArray(issueWatchers.issueId, issueIds)));
  return new Set(rows.map((r) => r.issueId));
}

async function watchersOf(ctx: Ctx, issueId: string): Promise<Watchers> {
  const s = await ctx.app.schema.get();
  const rows = await ctx.db.select().from(issueWatchers).where(eq(issueWatchers.issueId, issueId)).orderBy(asc(issueWatchers.createdAt));
  const watchers = rows
    .map((r) => {
      const u = s.users.get(r.userId);
      return u ? { user: userRefDto(u), reason: r.reason as WatchReason, since: r.createdAt.toISOString() } : null;
    })
    .filter((w): w is NonNullable<typeof w> => w !== null);
  return { watching: rows.some((r) => r.userId === ctx.actor.user.id), watchers };
}

export async function listWatchers(ctx: Ctx, issue: string): Promise<Watchers> {
  requireScope(ctx, 'read');
  const row = await resolveIssue(ctx, issue);
  return watchersOf(ctx, row.id);
}

/** Watch an issue yourself. Watching it already (say, as its reporter) changes nothing. */
export async function watchIssue(ctx: Ctx, issue: string): Promise<Watchers> {
  requirePersonal(ctx);
  const row = await resolveIssue(ctx, issue);
  if (ctx.actor.user.isBot) return watchersOf(ctx, row.id);
  await ctx.db.insert(issueWatchers).values({ issueId: row.id, userId: ctx.actor.user.id, reason: 'explicit' }).onConflictDoNothing();
  return watchersOf(ctx, row.id);
}

/** Stop watching an issue, until you take part in it again. Not watching it already changes nothing. */
export async function unwatchIssue(ctx: Ctx, issue: string): Promise<Watchers> {
  requirePersonal(ctx);
  const row = await resolveIssue(ctx, issue);
  await ctx.db.delete(issueWatchers).where(and(eq(issueWatchers.issueId, row.id), eq(issueWatchers.userId, ctx.actor.user.id)));
  return watchersOf(ctx, row.id);
}
