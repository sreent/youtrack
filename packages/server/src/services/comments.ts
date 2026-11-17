import type { Comment, CommentVisibility, ReactionSummary, VisibleToInput } from '@a4a/shared';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { comments, helpdeskRequests, requesters } from '../db/schema';
import { publishActivities, recordActivity } from '../events/activity';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { excerpt } from '../lib/text';
import { assertCanCommentProject, assertCanWriteProject, projectAccess, seesCommentRow } from './access';
import { issueRefsById, readableId } from './issue-refs';
import { applyChanges, findVisibleIssue, resolveIssue } from './issues';
import { userRefDto } from './values';
import { reactionsOf } from './votes';
import { addWatchers, mentionsAdded, whoSees } from './watchers';
import { resolveVisibleTo, sameLimits, visibleToDtos } from './visibility';

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
  const reacted = reactions ?? (await reactionsOf(ctx.db, s, row.issueId, ctx.actor.user.id, { anonymous: Boolean(ctx.actor.guest) }));
  const author = row.authorId ? s.users.get(row.authorId) : undefined;
  const requesterName = row.requesterId ? ((names ?? (await requesterNames(ctx.db, [row]))).get(row.requesterId) ?? 'The requester') : null;
  const [visibleTo] = await visibleToDtos(ctx.db, s, [row]);
  return {
    id: row.id,
    issueId: issueReadable ?? row.issueId,
    author: author ? userRefDto(author) : null,
    text: row.text,
    channel: row.channel as Comment['channel'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
    visibility: row.visibility as CommentVisibility,
    // A help desk's requester is someone outside: a guest (D37) isn't told who.
    requester: requesterName !== null ? { name: ctx.actor.guest ? 'The requester' : requesterName } : null,
    reactions: reacted.get(`comment:${row.id}`) ?? [],
    visibleTo: visibleTo ?? null,
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
  // A comment limited away from the caller (D37) isn't there for them.
  const view = await projectAccess(ctx);
  const seen = rows.filter((r) => seesCommentRow(view, issue.projectId, r));
  const names = await requesterNames(ctx.db, seen);
  const reacted = await reactionsOf(ctx.db, s, issue.id, ctx.actor.user.id, { anonymous: Boolean(ctx.actor.guest) });
  return Promise.all(seen.map((r) => commentDto(ctx, r, rid, names, reacted)));
}

/**
 * Comment on an issue: anyone with a role in its project may (a viewer too), with the write scope.
 * A public comment answers a help desk's requester for the project and counts as its first
 * response, so it takes someone who may change the project's issues.
 */
export async function addComment(
  ctx: Ctx,
  issueId: string,
  text: string,
  opts: { visibility?: CommentVisibility; visibleTo?: VisibleToInput | null } = {},
): Promise<Comment> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const issue = await resolveIssue(ctx, issueId);
  await assertCanCommentProject(ctx, issue.projectId);
  const visibility = opts.visibility ?? 'internal';
  if (visibility === 'public') {
    // Only a help desk request has someone outside to send a public comment to.
    const [request] = await ctx.db.select({ issueId: helpdeskRequests.issueId }).from(helpdeskRequests).where(eq(helpdeskRequests.issueId, issue.id));
    if (!request) {
      throw badRequest(`${readableId(s, issue)} didn't come in through a help desk, so a comment on it can't be public`, 'Leave out "visibility", or send "internal".').said('comments.notFromHelpdesk', { id: readableId(s, issue) });
    }
    await assertCanWriteProject(ctx, issue.projectId);
  }
  const commentVisibleTo = await resolveVisibleTo(ctx.db, s, opts.visibleTo);
  if (commentVisibleTo.limited && visibility === 'public') {
    throw badRequest('A public comment goes to the requester, so it can’t be limited to some people too', 'Send it as internal to limit it, or leave out "visibleTo".').said('comments.publicCantBeLimited');
  }
  const result = await ctx.db.transaction(async (tx) =>
    applyChanges(tx as unknown as Db, ctx, issue, { comment: text, commentVisibility: visibility, commentVisibleTo }),
  );
  await publishActivities(ctx.app, result.activities);
  const created = result.activities.find((a) => a.type === 'comment.created');
  const commentId = (created?.payload as { data?: { commentId?: string } } | undefined)?.data?.commentId;
  const [row] = await ctx.db.select().from(comments).where(eq(comments.id, commentId ?? ''));
  if (!row) throw notFound('Comment').said('notFound.commentUnnamed');
  return commentDto(ctx, row, readableId(s, issue));
}

/**
 * A comment the caller may change: their own, or anyone's when they manage its project. A
 * comment on an issue they can't see is not found, exactly as one that doesn't exist.
 */
async function loadOwnComment(ctx: Ctx, id: string): Promise<CommentRow> {
  const [row] = await ctx.db.select().from(comments).where(and(eq(comments.id, id), isNull(comments.deletedAt)));
  const issue = row ? await findVisibleIssue(ctx, row.issueId) : undefined;
  if (!row || !issue || !seesCommentRow(await projectAccess(ctx), issue.projectId, row)) throw notFound('Comment').said('notFound.commentUnnamed');
  await assertCanCommentProject(ctx, issue.projectId);
  if (row.authorId !== ctx.actor.user.id && !(await projectAccess(ctx)).canManage(issue.projectId)) {
    throw forbidden('You can only change your own comments', 'Managers of the project can change anyone’s.').said('comments.onlyOwn');
  }
  return row;
}

/**
 * Change a comment's words. With `expectedVersion`, only the version the editor read: an edit made
 * meanwhile refuses this one (409) rather than being written over, as an issue's and an article's do.
 */
export async function updateComment(ctx: Ctx, id: string, text: string, expectedVersion?: number): Promise<Comment> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const row = await loadOwnComment(ctx, id);
  const ref = (await issueRefsById(ctx.db, s, [row.issueId])).get(row.issueId);
  // People mentioned by the edit, and not before, are told and watch it, if they can see the project.
  const added = ctx.actor.channel === 'helpdesk' ? [] : mentionsAdded(s, row.text, text);
  const { updated, activity } = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [updated] = await tx
      .update(comments)
      .set({ text, updatedAt: new Date(), version: sql`${comments.version} + 1` })
      .where(expectedVersion === undefined ? eq(comments.id, id) : and(eq(comments.id, id), eq(comments.version, expectedVersion)))
      .returning();
    if (!updated) {
      const [now] = await tx.select({ version: comments.version }).from(comments).where(eq(comments.id, id));
      throw conflict(`The comment was changed by someone else (version ${now?.version ?? '?'}, you sent ${expectedVersion})`, 'Reload the comment, then make your change again.', {
        version: now?.version ?? null,
      }).said('comments.changedBySomeoneElse', { version: now?.version ?? '?', expectedVersion: String(expectedVersion) });
    }
    const issueRow = await resolveIssue(ctx, row.issueId, tx);
    const seeing = await whoSees(tx, s, issueRow.projectId, added, issueRow, row);
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

/**
 * Limit who sees a comment to some people and groups, or lift the limit (D37). Its author may, and
 * whoever manages the project. A public comment went to a help desk's requester: it isn't limited.
 */
export async function setCommentVisibility(ctx: Ctx, id: string, input: VisibleToInput | null): Promise<Comment> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const row = await loadOwnComment(ctx, id);
  const limits = await resolveVisibleTo(ctx.db, s, input);
  if (limits.limited && row.visibility === 'public') {
    throw badRequest('This comment went to the requester, so it can’t be limited to some people', 'Leave it as it is, or delete it.').said('comments.wentToRequester');
  }
  const ref = (await issueRefsById(ctx.db, s, [row.issueId])).get(row.issueId);
  if (sameLimits(limits, row)) return commentDto(ctx, row, ref?.id);
  const { updated, activity } = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [updated] = await tx.update(comments).set(limits).where(eq(comments.id, id)).returning();
    const issueRow = await resolveIssue(ctx, row.issueId, tx);
    const activity = await recordActivity(tx, ctx, {
      type: 'comment.updated',
      projectId: issueRow.projectId,
      issueId: row.issueId,
      payload: { issue: ref, data: { commentId: id, text: excerpt(row.text, 1000), visibilityChanged: true, ...(limits.limited ? { limited: true } : {}) } },
    });
    return { updated: updated!, activity };
  });
  await publishActivities(ctx.app, [activity]);
  return commentDto(ctx, updated, ref?.id);
}
