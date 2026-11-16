import type { Comment, CommentVisibility, ReactionSummary } from '@a4a/shared';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { comments, helpdeskRequests, requesters } from '../db/schema';
import { publishActivities, recordActivity } from '../events/activity';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { excerpt } from '../lib/text';
import { assertCanCommentProject, assertCanWriteProject, projectAccess } from './access';
import { issueRefsById, readableId } from './issue-refs';
import { applyChanges, findVisibleIssue, resolveIssue } from './issues';
import { userRefDto } from './values';
import { reactionsOf } from './votes';
import { addWatchers, mentionsAdded, whoSees } from './watchers';

type CommentRow = typeof comments.$inferSelect;

async function requesterNames(db: Db, rows: CommentRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.requesterId).filter((id): id is string => Boolean(id)))];
  if (!ids.length) return new Map();
  const found = await db.select({ id: requesters.id, name: requesters.name }).from(requesters).where(inArray(requesters.id, ids));
  return new Map(found.map((r) => [r.id, r.name]));
}

export async function commentDto(
  ctx: Ctx,
  row: CommentRow,
  issueReadable?: string,
  names?: Map<string, string>,
  reactions?: Map<string, ReactionSummary[]>,
): Promise<Comment> {
  const s = await ctx.app.schema.get();
  const reacted = reactions ?? (await reactionsOf(ctx.db, s, row.issueId, ctx.actor.user.id));
  const author = row.authorId ? s.users.get(row.authorId) : undefined;
  const requesterName = row.requesterId ? ((names ?? (await requesterNames(ctx.db, [row]))).get(row.requesterId) ?? 'The requester') : null;
  return {
    id: row.id,
    issueId: issueReadable ?? row.issueId,
    author: author ? userRefDto(author) : null,
    text: row.text,
    channel: row.channel as Comment['channel'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    visibility: row.visibility as CommentVisibility,
    requester: requesterName !== null ? { name: requesterName } : null,
    reactions: reacted.get(`comment:${row.id}`) ?? [],
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
  const names = await requesterNames(ctx.db, rows);
  const reacted = await reactionsOf(ctx.db, s, issue.id, ctx.actor.user.id);
  return Promise.all(rows.map((r) => commentDto(ctx, r, rid, names, reacted)));
}

/**
 * Comment on an issue: anyone with a role in its project may (a viewer too), with the write scope.
 * A public comment answers a help desk's requester for the project and counts as its first
 * response, so it takes someone who may change the project's issues.
 */
export async function addComment(ctx: Ctx, issueId: string, text: string, opts: { visibility?: CommentVisibility } = {}): Promise<Comment> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const issue = await resolveIssue(ctx, issueId);
  await assertCanCommentProject(ctx, issue.projectId);
  const visibility = opts.visibility ?? 'internal';
  if (visibility === 'public') {
    // Only a help desk request has someone outside to send a public comment to.
    const [request] = await ctx.db.select({ issueId: helpdeskRequests.issueId }).from(helpdeskRequests).where(eq(helpdeskRequests.issueId, issue.id));
    if (!request) {
      throw badRequest(`${readableId(s, issue)} didn't come in through a help desk, so a comment on it can't be public`, 'Leave out "visibility", or send "internal".');
    }
    await assertCanWriteProject(ctx, issue.projectId);
  }
  const result = await ctx.db.transaction(async (tx) => applyChanges(tx as unknown as Db, ctx, issue, { comment: text, commentVisibility: visibility }));
  await publishActivities(ctx.app, result.activities);
  const created = result.activities.find((a) => a.type === 'comment.created');
  const commentId = (created?.payload as { data?: { commentId?: string } } | undefined)?.data?.commentId;
  const [row] = await ctx.db.select().from(comments).where(eq(comments.id, commentId ?? ''));
  if (!row) throw notFound('Comment');
  return commentDto(ctx, row, readableId(s, issue));
}

/**
 * A comment the caller may change: their own, or anyone's when they manage its project. A
 * comment on an issue they can't see is not found, exactly as one that doesn't exist.
 */
async function loadOwnComment(ctx: Ctx, id: string): Promise<CommentRow> {
  const [row] = await ctx.db.select().from(comments).where(and(eq(comments.id, id), isNull(comments.deletedAt)));
  const issue = row ? await findVisibleIssue(ctx, row.issueId) : undefined;
  if (!row || !issue) throw notFound('Comment');
  await assertCanCommentProject(ctx, issue.projectId);
  if (row.authorId !== ctx.actor.user.id && !(await projectAccess(ctx)).canManage(issue.projectId)) {
    throw forbidden('You can only change your own comments', 'Managers of the project can change anyone’s.');
  }
  return row;
}

export async function updateComment(ctx: Ctx, id: string, text: string): Promise<Comment> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const row = await loadOwnComment(ctx, id);
  const ref = (await issueRefsById(ctx.db, s, [row.issueId])).get(row.issueId);
  // People mentioned by the edit, and not before, are told and watch it, if they can see the project.
  const added = ctx.actor.channel === 'helpdesk' ? [] : mentionsAdded(s, row.text, text);
  const { updated, activity } = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [updated] = await tx.update(comments).set({ text, updatedAt: new Date() }).where(eq(comments.id, id)).returning();
    const issueRow = await resolveIssue(ctx, row.issueId, tx);
    const seeing = await whoSees(tx, s, issueRow.projectId, added);
    const mentions = added.filter((l) => seeing.has(l.toLowerCase()));
    await addWatchers(tx, s, issueRow, mentions.map((login) => ({ login, reason: 'mentioned' as const })), seeing);
    const activity = await recordActivity(tx, ctx, {
      type: 'comment.updated',
      projectId: issueRow.projectId,
      issueId: row.issueId,
      payload: { issue: ref, data: { commentId: id, text: excerpt(text, 1000), ...(mentions.length ? { mentions } : {}) } },
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
