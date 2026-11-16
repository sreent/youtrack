import type { Comment } from '@a4a/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { isAdmin, requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { comments } from '../db/schema';
import { publishActivities, recordActivity } from '../events/activity';
import { forbidden, notFound } from '../lib/errors';
import { excerpt } from '../lib/text';
import { issueRefsById, readableId } from './issue-refs';
import { applyChanges, resolveIssue } from './issues';
import { userRefDto } from './values';

type CommentRow = typeof comments.$inferSelect;

export async function commentDto(ctx: Ctx, row: CommentRow, issueReadable?: string): Promise<Comment> {
  const s = await ctx.app.schema.get();
  const author = row.authorId ? s.users.get(row.authorId) : undefined;
  return {
    id: row.id,
    issueId: issueReadable ?? row.issueId,
    author: author ? userRefDto(author) : null,
    text: row.text,
    channel: row.channel as Comment['channel'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listComments(ctx: Ctx, issueId: string): Promise<Comment[]> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const issue = await resolveIssue(ctx, issueId);
  const rows = await ctx.db
    .select()
    .from(comments)
    .where(and(eq(comments.issueId, issue.id), isNull(comments.deletedAt)))
    .orderBy(asc(comments.createdAt));
  const rid = readableId(s, issue);
  return Promise.all(rows.map((r) => commentDto(ctx, r, rid)));
}

export async function addComment(ctx: Ctx, issueId: string, text: string): Promise<Comment> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const issue = await resolveIssue(ctx, issueId);
  const result = await ctx.db.transaction(async (tx) => applyChanges(tx as unknown as Db, ctx, issue, { comment: text }));
  await publishActivities(ctx.app, result.activities);
  const created = result.activities.find((a) => a.type === 'comment.created');
  const commentId = (created?.payload as { data?: { commentId?: string } } | undefined)?.data?.commentId;
  const [row] = await ctx.db.select().from(comments).where(eq(comments.id, commentId ?? ''));
  if (!row) throw notFound('Comment');
  return commentDto(ctx, row, readableId(s, issue));
}

async function loadOwnComment(ctx: Ctx, id: string): Promise<CommentRow> {
  const [row] = await ctx.db.select().from(comments).where(and(eq(comments.id, id), isNull(comments.deletedAt)));
  if (!row) throw notFound('Comment');
  if (row.authorId !== ctx.actor.user.id && !isAdmin(ctx)) throw forbidden('You can only change your own comments');
  return row;
}

export async function updateComment(ctx: Ctx, id: string, text: string): Promise<Comment> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const row = await loadOwnComment(ctx, id);
  const ref = (await issueRefsById(ctx.db, s, [row.issueId])).get(row.issueId);
  const { updated, activity } = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [updated] = await tx.update(comments).set({ text, updatedAt: new Date() }).where(eq(comments.id, id)).returning();
    const issueRow = await resolveIssue(ctx, row.issueId, tx);
    const activity = await recordActivity(tx, ctx, {
      type: 'comment.updated',
      projectId: issueRow.projectId,
      issueId: row.issueId,
      payload: { issue: ref, data: { commentId: id, text: excerpt(text, 1000) } },
    });
    return { updated: updated!, activity };
  });
  await publishActivities(ctx.app, [activity]);
  return commentDto(ctx, updated, ref?.id);
}

export async function deleteComment(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const row = await loadOwnComment(ctx, id);
  const ref = (await issueRefsById(ctx.db, s, [row.issueId])).get(row.issueId);
  const activity = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, id));
    const issueRow = await resolveIssue(ctx, row.issueId, tx);
    return recordActivity(tx, ctx, {
      type: 'comment.deleted',
      projectId: issueRow.projectId,
      issueId: row.issueId,
      payload: { issue: ref, data: { commentId: id } },
    });
  });
  await publishActivities(ctx.app, [activity]);
}
