/**
 * Votes and reactions (D41). Anyone who may comment on an issue may vote for it, once, and react to
 * its description and its comments with a small fixed set of emoji (REACTIONS). Neither changes
 * the issue: no new version, no history, nobody told. They say how much people care, and that is
 * all. issues.votes keeps the count, so sorting by votes reads nothing else.
 */
import { REACTIONS, type Reaction, type ReactionSummary, type Vote } from '@a4a/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { comments, issues, issueVotes, reactions } from '../db/schema';
import { badRequest, notFound } from '../lib/errors';
import { assertCanCommentProject } from './access';
import { findVisibleIssue, resolveIssue } from './issues';
import type { SchemaSnapshot } from './schema-cache';
import { userRefDto } from './values';

export async function hasVoted(db: Db, issueId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ issueId: issueVotes.issueId })
    .from(issueVotes)
    .where(and(eq(issueVotes.issueId, issueId), eq(issueVotes.userId, userId)));
  return Boolean(row);
}

/** Vote for an issue (`on`), or take the vote back. Its reporter has said so already, by reporting it. */
export async function setVote(ctx: Ctx, idOrReadable: string, on: boolean): Promise<Vote> {
  requireScope(ctx, 'write');
  const issue = await resolveIssue(ctx, idOrReadable);
  await assertCanCommentProject(ctx, issue.projectId);
  const me = ctx.actor.user.id;
  if (on && issue.reporterId === me) throw badRequest("You reported it, so you can't vote for it", 'Votes count the people who want it besides its reporter.');
  return ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    if (on) {
      const added = await tx.insert(issueVotes).values({ issueId: issue.id, userId: me }).onConflictDoNothing().returning({ id: issueVotes.issueId });
      if (added.length) await tx.update(issues).set({ votes: sql`${issues.votes} + 1` }).where(eq(issues.id, issue.id));
    } else {
      const removed = await tx
        .delete(issueVotes)
        .where(and(eq(issueVotes.issueId, issue.id), eq(issueVotes.userId, me)))
        .returning({ id: issueVotes.issueId });
      if (removed.length) await tx.update(issues).set({ votes: sql`greatest(${issues.votes} - 1, 0)` }).where(eq(issues.id, issue.id));
    }
    const [row] = await tx.select({ votes: issues.votes }).from(issues).where(eq(issues.id, issue.id));
    return { votes: row?.votes ?? 0, voted: on };
  });
}

type Target = { kind: 'issue' | 'comment'; id: string };
const keyOf = (t: Target) => `${t.kind}:${t.id}`;

/** Every reaction on an issue (its description, and each of its comments), by target ("issue:<id>", "comment:<id>"). */
export async function reactionsOf(db: Db, s: SchemaSnapshot, issueId: string, meId: string): Promise<Map<string, ReactionSummary[]>> {
  const rows = await db.select().from(reactions).where(eq(reactions.issueId, issueId)).orderBy(reactions.createdAt);
  const byTarget = new Map<string, Map<string, string[]>>();
  for (const r of rows) {
    const key = keyOf({ kind: r.targetKind as Target['kind'], id: r.targetId });
    const emojis = byTarget.get(key) ?? new Map<string, string[]>();
    emojis.set(r.emoji, [...(emojis.get(r.emoji) ?? []), r.userId]);
    byTarget.set(key, emojis);
  }
  const out = new Map<string, ReactionSummary[]>();
  for (const [key, emojis] of byTarget) {
    out.set(
      key,
      REACTIONS.filter((e) => emojis.get(e)?.length).map((emoji) => {
        const who = emojis.get(emoji)!;
        const people = who.flatMap((id) => {
          const u = s.users.get(id);
          return u ? [userRefDto(u)] : [];
        });
        return { emoji, count: who.length, mine: who.includes(meId), people };
      }),
    );
  }
  return out;
}

/** Add a reaction, or take it back if it's there: to an issue's description, or to one of its comments. */
async function toggle(ctx: Ctx, issue: { id: string; projectId: string }, target: Target, emoji: Reaction): Promise<ReactionSummary[]> {
  if (!REACTIONS.includes(emoji)) throw badRequest(`"${emoji}" isn't a reaction`, `Reactions: ${REACTIONS.join(' ')}`);
  await assertCanCommentProject(ctx, issue.projectId);
  const me = ctx.actor.user.id;
  const where = and(eq(reactions.targetKind, target.kind), eq(reactions.targetId, target.id), eq(reactions.emoji, emoji), eq(reactions.userId, me));
  const removed = await ctx.db.delete(reactions).where(where).returning({ id: reactions.targetId });
  if (!removed.length) {
    await ctx.db.insert(reactions).values({ targetKind: target.kind, targetId: target.id, issueId: issue.id, emoji, userId: me }).onConflictDoNothing();
  }
  const s = await ctx.app.schema.get();
  return (await reactionsOf(ctx.db, s, issue.id, me)).get(keyOf(target)) ?? [];
}

export async function reactToIssue(ctx: Ctx, idOrReadable: string, emoji: Reaction): Promise<ReactionSummary[]> {
  requireScope(ctx, 'write');
  const issue = await resolveIssue(ctx, idOrReadable);
  return toggle(ctx, issue, { kind: 'issue', id: issue.id }, emoji);
}

export async function reactToComment(ctx: Ctx, commentId: string, emoji: Reaction): Promise<ReactionSummary[]> {
  requireScope(ctx, 'write');
  const [row] = await ctx.db.select().from(comments).where(and(eq(comments.id, commentId), isNull(comments.deletedAt)));
  const issue = row ? await findVisibleIssue(ctx, row.issueId) : undefined;
  if (!row || !issue) throw notFound('Comment');
  return toggle(ctx, issue, { kind: 'comment', id: row.id }, emoji);
}
