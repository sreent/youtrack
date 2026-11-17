/**
 * Issues and articles mention each other by id in what people write. An article's
 * mentions are recorded in the transaction that saves it. An issue's description and
 * its comments are read by an outbox consumer, from the events their own write path
 * records, so that path needs to know nothing of the knowledge base.
 */
import { findRefs, type ArticleRef, type IssueRef } from '@a4a/shared';
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { AppServices, Ctx } from '../context';
import type { Db } from '../db/client';
import { comments, issues, mentions } from '../db/schema';
import type { OutboxConsumer } from '../events/worker';
import { commentSeenSql, projectAccess, seenArticleIds, seenIssueIds, visibleProjectIds } from './access';
import { currentIds } from './aliases';
import { articleRefsById } from './article-refs';
import { findIssue } from './issues';
import { issueRefsById, readableId } from './issue-refs';
import type { SchemaSnapshot } from './schema-cache';

export type MentionSource =
  | { type: 'issue'; id: string; projectId: string }
  | { type: 'comment'; id: string; issueId: string; projectId: string }
  | { type: 'article'; id: string; projectId: string };

/** A text names this many ids at most, so one paste can't fill the table. */
const MAX_MENTIONS = 200;

/**
 * Record the ids a text names, in place of what the same source named before. Only ids
 * of projects that exist count; the source's own id doesn't.
 */
export async function indexMentions(db: Db, s: SchemaSnapshot, source: MentionSource, text: string, self?: string): Promise<void> {
  await db.delete(mentions).where(and(eq(mentions.sourceType, source.type), eq(mentions.sourceId, source.id)));
  const seen = new Set<string>();
  const rows: (typeof mentions.$inferInsert)[] = [];
  const refs = findRefs(text);
  // An id an issue had before it moved names the issue by the id it has now (D41).
  const now = await currentIds(db, s, refs.filter((r) => r.kind === 'issue').map((r) => r.id));
  for (const found of refs) {
    const ref = found.kind === 'issue' && now.get(found.id) !== found.id ? { ...found, id: now.get(found.id)! } : found;
    if (seen.has(ref.id) || ref.id === self?.toUpperCase() || !s.projectsByKey.has(ref.key)) continue;
    seen.add(ref.id);
    rows.push({
      sourceType: source.type,
      sourceId: source.id,
      issueId: source.type === 'issue' ? source.id : source.type === 'comment' ? source.issueId : null,
      articleId: source.type === 'article' ? source.id : null,
      projectId: source.projectId,
      targetKind: ref.kind,
      target: ref.id,
    });
    if (rows.length >= MAX_MENTIONS) break;
  }
  if (rows.length) await db.insert(mentions).values(rows).onConflictDoNothing();
}

async function visibleCondition(ctx: Ctx): Promise<SQL | undefined> {
  const visible = await visibleProjectIds(ctx);
  if (visible === null) return undefined;
  return visible.length ? inArray(mentions.projectId, visible) : sql`FALSE`;
}

/** Issues (by their description or a comment still standing) and articles that mention `target`. */
export async function mentionsOf(ctx: Ctx, target: string, opts: { exceptArticle?: string } = {}): Promise<{ issues: IssueRef[]; articles: ArticleRef[] }> {
  const s = await ctx.app.schema.get();
  const rows = await ctx.db
    .select({ sourceType: mentions.sourceType, issueId: mentions.issueId, articleId: mentions.articleId })
    .from(mentions)
    .leftJoin(comments, and(eq(mentions.sourceType, 'comment'), eq(comments.id, mentions.sourceId)))
    .where(
      and(
        eq(mentions.target, target.toUpperCase()),
        // A comment that's gone, or limited away from the caller (D37), mentions nothing to them.
        or(sql`${mentions.sourceType} <> 'comment'`, and(isNull(comments.deletedAt), commentSeenSql(await projectAccess(ctx), 'comments'))),
        await visibleCondition(ctx),
      ),
    )
    .limit(500);
  const seen = await seenIssueIds(ctx, rows.map((r) => r.issueId).filter((x): x is string => Boolean(x)));
  const issueIds = [...seen];
  // An article limited away from the caller, or under one that is (D51), mentions nothing to them.
  const articleIds = [...(await seenArticleIds(ctx, rows.map((r) => r.articleId).filter((x): x is string => Boolean(x) && x !== opts.exceptArticle)))];
  const [issueRefs, articleRefs] = await Promise.all([issueRefsById(ctx.db, s, issueIds), articleRefsById(ctx.db, s, articleIds)]);
  const byId = (x: { id: string }, y: { id: string }) => x.id.localeCompare(y.id, undefined, { numeric: true });
  return { issues: [...issueRefs.values()].sort(byId).slice(0, 100), articles: [...articleRefs.values()].sort(byId).slice(0, 100) };
}

/** Read an issue's description again, as it is now. */
export async function reindexIssue(app: AppServices, readable: string): Promise<void> {
  const s = await app.schema.get();
  const issue = await findIssue(app.db, s, readable);
  if (!issue) return; // deleted since: its mentions went with it
  await indexMentions(app.db, s, { type: 'issue', id: issue.id, projectId: issue.projectId }, issue.description, readableId(s, issue));
}

/** Read a comment again, as it is now; a deleted one mentions nothing. */
export async function reindexComment(app: AppServices, commentId: string): Promise<void> {
  const s = await app.schema.get();
  const [row] = await app.db
    .select({ id: comments.id, issueId: comments.issueId, text: comments.text, deletedAt: comments.deletedAt, projectId: issues.projectId })
    .from(comments)
    .innerJoin(issues, eq(issues.id, comments.issueId))
    .where(eq(comments.id, commentId));
  if (!row || row.deletedAt) {
    await app.db.delete(mentions).where(and(eq(mentions.sourceType, 'comment'), eq(mentions.sourceId, commentId)));
    return;
  }
  await indexMentions(app.db, s, { type: 'comment', id: row.id, issueId: row.issueId, projectId: row.projectId }, row.text);
}

/**
 * Keeps issues' mentions as their text changes. It reads the text as it is when it runs, not
 * as the event carried it, so running twice, or late, lands in the same place.
 */
export function mentionsConsumer(app: AppServices): OutboxConsumer {
  return {
    name: 'mentions',
    types: ['issue.created', 'issue.updated', 'comment.created', 'comment.updated', 'comment.deleted'],
    async handle(event) {
      if (event.type === 'issue.created' || event.type === 'issue.updated') {
        if (event.type === 'issue.updated' && !event.changes.some((c) => c.field === 'Description')) return;
        if (event.issue) await reindexIssue(app, event.issue.id);
        return;
      }
      const commentId = typeof event.data.commentId === 'string' ? event.data.commentId : null;
      if (commentId) await reindexComment(app, commentId);
    },
  };
}
