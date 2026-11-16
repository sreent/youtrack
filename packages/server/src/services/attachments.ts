/**
 * Files on issues, comments and articles. An upload streams to storage while it's
 * counted, hashed and sniffed; only then, in one transaction, is the row written,
 * the owner's cap checked under its lock, and the activity recorded.
 */
import type { ArticleRef, Attachment, AttachmentLimits, AttachmentText, IssueRef } from '@a4a/shared';
import { INLINE_IMAGE_TYPES } from '@a4a/shared';
import { and, asc, eq, exists, isNotNull, isNull, lt, notExists, or, sql } from 'drizzle-orm';
import { pipeline, type Readable } from 'node:stream';
import { isAdmin, requireScope, type AppServices, type Ctx } from '../context';
import type { Db } from '../db/client';
import { articles, attachmentBlobs, attachments, comments, issues } from '../db/schema';
import { publishActivities, recordActivity } from '../events/activity';
import type { OutboxConsumer } from '../events/worker';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { Inspector, tooLarge } from '../attachments/receive';
import { baseType, describeType, formatBytes, isInline, isText, safeFileName, sniffContentType } from '../attachments/sniff';
import { attachmentStorage, BlobNotFound, newBlobKey } from '../attachments/storage';
import { assertCanReadProject, assertCanWriteProject } from './access';
import { articleReadableId, articleRef, articleRefsById, resolveArticle, type ArticleRow } from './article-refs';
import { issueRefsById, readableId, type IssueRow } from './issue-refs';
import { resolveIssue } from './issues';
import { userRefDto } from './values';

export type AttachmentRow = typeof attachments.$inferSelect;

/** Where an upload goes, once the actor may put it there. */
export type UploadTarget =
  | { kind: 'issue'; issue: IssueRow }
  | { kind: 'comment'; issue: IssueRow; commentId: string }
  | { kind: 'article'; article: ArticleRow };

export interface UploadSource {
  name: string;
  stream: Readable;
  /** Stop reading the rest of the request, when the upload is refused part-way. */
  abort?(): void;
}

/** What an agent may send in one call over MCP, once decoded. */
export const AGENT_UPLOAD_MAX_BYTES = 256 * 1024;

export function attachmentLimits(ctx: Ctx): AttachmentLimits {
  requireScope(ctx, 'read');
  return {
    maxBytes: ctx.app.config.attachmentMaxBytes,
    perIssueMaxBytes: ctx.app.config.attachmentsPerIssueMaxBytes,
    inlineTypes: [...INLINE_IMAGE_TYPES],
  };
}

export function contentUrl(app: AppServices, id: string): string {
  return `${app.config.publicUrl}/api/v1/attachments/${id}/content`;
}

async function toDtos(ctx: Ctx, rows: AttachmentRow[]): Promise<Attachment[]> {
  if (!rows.length) return [];
  const s = await ctx.app.schema.get();
  const issueIds = rows.map((r) => r.issueId).filter((x): x is string => Boolean(x));
  const articleIds = rows.map((r) => r.articleId).filter((x): x is string => Boolean(x));
  const [issueRefs, articleRefs] = await Promise.all([issueRefsById(ctx.db, s, issueIds), articleRefsById(ctx.db, s, articleIds)]);
  return rows.map((r) => {
    const by = r.uploadedById ? s.users.get(r.uploadedById) : undefined;
    return {
      id: r.id,
      name: r.name,
      contentType: r.contentType,
      size: r.size,
      sha256: r.sha256,
      inline: isInline(r.contentType),
      text: isText(r.contentType),
      issue: r.issueId ? (issueRefs.get(r.issueId)?.id ?? null) : null,
      comment: r.commentId,
      article: r.articleId ? (articleRefs.get(r.articleId)?.id ?? null) : null,
      uploadedBy: by ? userRefDto(by) : null,
      channel: r.channel as Attachment['channel'],
      token: r.tokenName,
      createdAt: r.createdAt.toISOString(),
      url: contentUrl(ctx.app, r.id),
    };
  });
}

/** Files still in view: a deleted comment's go with it. */
const visibleOnIssue = (issueId: string) => and(eq(attachments.issueId, issueId), or(isNull(attachments.commentId), isNull(comments.deletedAt)));

async function issueRows(db: Db, issueId: string): Promise<AttachmentRow[]> {
  const rows = await db
    .select({ a: attachments })
    .from(attachments)
    .leftJoin(comments, eq(comments.id, attachments.commentId))
    .where(visibleOnIssue(issueId))
    .orderBy(asc(attachments.createdAt));
  return rows.map((r) => r.a);
}

/** An issue's files, its comments' included (each says which comment). */
export async function listIssueAttachments(ctx: Ctx, issueId: string): Promise<Attachment[]> {
  requireScope(ctx, 'read');
  const issue = await resolveIssue(ctx, issueId);
  return toDtos(ctx, await issueRows(ctx.db, issue.id));
}

export async function listArticleAttachments(ctx: Ctx, articleId: string): Promise<Attachment[]> {
  requireScope(ctx, 'read');
  const article = await resolveArticle(ctx, articleId);
  const rows = await ctx.db.select().from(attachments).where(eq(attachments.articleId, article.id)).orderBy(asc(attachments.createdAt));
  return toDtos(ctx, rows);
}

/** The row, if the actor may read where it is; anything else looks like a missing file. */
async function loadVisible(ctx: Ctx, id: string): Promise<AttachmentRow> {
  requireScope(ctx, 'read');
  const [found] = await ctx.db
    .select({ a: attachments, deletedAt: comments.deletedAt })
    .from(attachments)
    .leftJoin(comments, eq(comments.id, attachments.commentId))
    .where(eq(attachments.id, id));
  if (!found || found.deletedAt) throw notFound('Attachment', 'List the files on the issue or article to find its id.');
  await assertCanReadProject(ctx, found.a.projectId).catch(() => {
    throw notFound('Attachment');
  });
  return found.a;
}

export async function getAttachment(ctx: Ctx, id: string): Promise<Attachment> {
  return (await toDtos(ctx, [await loadVisible(ctx, id)]))[0]!;
}

/** The row, to serve its bytes: the caller checks If-None-Match before opening them. */
export async function attachmentForDownload(ctx: Ctx, id: string): Promise<AttachmentRow> {
  return loadVisible(ctx, id);
}

export async function openAttachmentBytes(app: AppServices, row: AttachmentRow): Promise<Readable> {
  try {
    return await attachmentStorage(app).read(row.blobKey);
  } catch (e) {
    if (e instanceof BlobNotFound) throw new AppError(410, 'gone', `The file of ${row.name} is missing from storage`, 'Upload it again.');
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Uploading
// ---------------------------------------------------------------------------

export async function issueUploadTarget(ctx: Ctx, issueId: string): Promise<UploadTarget> {
  requireScope(ctx, 'write');
  const issue = await resolveIssue(ctx, issueId);
  await assertCanWriteProject(ctx, issue.projectId);
  return { kind: 'issue', issue };
}

/** A comment takes files from its author (or an administrator), as only they change its words. */
export async function commentUploadTarget(ctx: Ctx, commentId: string): Promise<UploadTarget> {
  requireScope(ctx, 'write');
  const [comment] = await ctx.db.select().from(comments).where(and(eq(comments.id, commentId), isNull(comments.deletedAt)));
  if (!comment) throw notFound('Comment');
  const issue = await resolveIssue(ctx, comment.issueId).catch(() => {
    throw notFound('Comment');
  });
  if (comment.authorId !== ctx.actor.user.id && !isAdmin(ctx)) {
    throw forbidden('You can only attach files to your own comments', 'Attach it to the issue instead.');
  }
  await assertCanWriteProject(ctx, issue.projectId);
  return { kind: 'comment', issue, commentId: comment.id };
}

export async function articleUploadTarget(ctx: Ctx, articleId: string): Promise<UploadTarget> {
  requireScope(ctx, 'write');
  const article = await resolveArticle(ctx, articleId);
  await assertCanWriteProject(ctx, article.projectId);
  return { kind: 'article', article };
}

/** Bytes of files the target's owner holds now (an issue counts its comments' files). */
async function usedBytes(db: Db, target: UploadTarget): Promise<number> {
  const [row] =
    target.kind === 'article'
      ? await db
          .select({ n: sql<string>`coalesce(sum(${attachments.size}), 0)` })
          .from(attachments)
          .where(eq(attachments.articleId, target.article.id))
      : await db
          .select({ n: sql<string>`coalesce(sum(${attachments.size}), 0)` })
          .from(attachments)
          .leftJoin(comments, eq(comments.id, attachments.commentId))
          .where(visibleOnIssue(target.issue.id));
  return Number(row?.n ?? 0);
}

function ownerId(s: Awaited<ReturnType<Ctx['app']['schema']['get']>>, target: UploadTarget): string {
  return target.kind === 'article' ? articleReadableId(s, target.article) : readableId(s, target.issue);
}

async function removeBlob(app: AppServices, key: string): Promise<void> {
  await attachmentStorage(app).remove(key);
  await app.db
    .delete(attachmentBlobs)
    .where(and(eq(attachmentBlobs.key, key), notExists(app.db.select({ k: attachments.blobKey }).from(attachments).where(eq(attachments.blobKey, key)))));
}

/**
 * Store an upload: stream it to storage, counting, hashing and sniffing it on the way,
 * then record it. The owner's cap is checked twice, before the first byte (to stop early)
 * and under the owner's row lock once the size is known (so two uploads at once can't
 * both squeeze in). Whatever fails, nothing is left behind.
 */
export async function storeAttachment(ctx: Ctx, target: UploadTarget, source: UploadSource): Promise<Attachment> {
  const s = await ctx.app.schema.get();
  const { attachmentMaxBytes: maxFile, attachmentsPerIssueMaxBytes: cap } = ctx.app.config;
  const name = safeFileName(source.name);
  const owner = ownerId(s, target);
  const refuse = (e: Error) => {
    source.abort?.();
    source.stream.resume();
    return e;
  };

  const used = await usedBytes(ctx.db, target);
  const room = cap - used;
  if (room <= 0) {
    throw refuse(tooLarge(`${owner} already holds ${formatBytes(used)} of files, as much as it may`, 'Remove files it no longer needs.'));
  }
  const max = Math.min(maxFile, room);
  const inspector = new Inspector(max, () =>
    max < maxFile
      ? tooLarge(`${name} doesn't fit: ${owner} has ${formatBytes(room)} left of its ${formatBytes(cap)} for files`, 'Remove files it no longer needs, or attach this one elsewhere.')
      : tooLarge(`${name} is larger than ${formatBytes(maxFile)}, the most one file may be`, 'Compress it, or split it into parts.'),
  );

  const storage = attachmentStorage(ctx.app);
  const key = newBlobKey();
  // Recorded before the first byte is written, so a crash mid-upload leaves something to sweep.
  await ctx.db.insert(attachmentBlobs).values({ key, state: 'uploading' });
  const cleanUp = async () => {
    await storage.remove(key).catch(() => {});
    await ctx.db.delete(attachmentBlobs).where(eq(attachmentBlobs.key, key)).catch(() => {});
  };

  try {
    const counted = pipeline(source.stream, inspector, (err) => {
      if (err) source.abort?.();
    });
    await storage.write(key, counted);
  } catch (e) {
    await cleanUp();
    if (e instanceof AppError) throw e;
    throw badRequest(`The upload of ${name} didn't finish: ${e instanceof Error ? e.message : String(e)}`, 'Try again.');
  }

  const size = inspector.size;
  const sha256 = inspector.digest();
  const contentType = sniffContentType(inspector.firstBytes());

  let result: { row: AttachmentRow; activity: Awaited<ReturnType<typeof recordActivity>> };
  try {
    result = await ctx.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      let issueRef: IssueRef | undefined;
      let article: ArticleRef | undefined;
      if (target.kind === 'article') {
        const [locked] = await tx.select({ id: articles.id }).from(articles).where(eq(articles.id, target.article.id)).for('update');
        if (!locked) throw notFound(`Article ${owner}`, 'It was deleted while the file was uploading.');
        article = articleRef(s, target.article);
      } else {
        const [locked] = await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, target.issue.id)).for('update');
        if (!locked) throw notFound(`Issue ${owner}`, 'It was deleted while the file was uploading.');
        if (target.kind === 'comment') {
          const [c] = await tx.select({ deletedAt: comments.deletedAt }).from(comments).where(eq(comments.id, target.commentId));
          if (!c || c.deletedAt) throw notFound('Comment', 'It was deleted while the file was uploading.');
        }
        issueRef = (await issueRefsById(tx, s, [target.issue.id])).get(target.issue.id);
      }
      const usedNow = await usedBytes(tx, target);
      if (usedNow + size > cap) {
        throw tooLarge(`${name} doesn't fit: ${owner} has ${formatBytes(Math.max(cap - usedNow, 0))} left of its ${formatBytes(cap)} for files`, 'Remove files it no longer needs.');
      }
      await tx.update(attachmentBlobs).set({ state: 'stored' }).where(eq(attachmentBlobs.key, key));
      const [row] = await tx
        .insert(attachments)
        .values({
          id: newId(),
          projectId: target.kind === 'article' ? target.article.projectId : target.issue.projectId,
          issueId: target.kind === 'article' ? null : target.issue.id,
          commentId: target.kind === 'comment' ? target.commentId : null,
          articleId: target.kind === 'article' ? target.article.id : null,
          name,
          contentType,
          size,
          sha256,
          blobKey: key,
          uploadedById: ctx.actor.user.id,
          channel: ctx.actor.channel,
          tokenName: ctx.actor.tokenName,
        })
        .returning();
      if (target.kind !== 'article') await tx.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, target.issue.id));
      const activity = await recordActivity(tx, ctx, {
        type: 'attachment.added',
        projectId: row!.projectId,
        issueId: row!.issueId,
        payload: {
          ...(issueRef ? { issue: issueRef } : {}),
          data: {
            attachment: { id: row!.id, name, size, contentType, sha256, url: contentUrl(ctx.app, row!.id) },
            ...(row!.commentId ? { commentId: row!.commentId } : {}),
            ...(article ? { article } : {}),
          },
        },
      });
      return { row: row!, activity };
    });
  } catch (e) {
    await cleanUp();
    throw e;
  }
  await publishActivities(ctx.app, [result.activity]);
  return (await toDtos(ctx, [result.row]))[0]!;
}

// ---------------------------------------------------------------------------
// Reading as text, deleting, sweeping
// ---------------------------------------------------------------------------

async function collect(stream: Readable, max: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const chunk of stream) {
    const b = chunk as Buffer;
    parts.push(b);
    n += b.length;
    if (n >= max) break;
  }
  stream.destroy();
  return Buffer.concat(parts).subarray(0, max);
}

/** Where the last whole UTF-8 character ends, so a cut never splits one. */
function wholeUtf8End(b: Buffer): number {
  for (let back = 1; back <= Math.min(4, b.length); back++) {
    const x = b[b.length - back]!;
    if ((x & 0xc0) === 0x80) continue; // a continuation byte: keep looking for its lead
    const need = x >= 0xf0 ? 4 : x >= 0xe0 ? 3 : x >= 0xc0 ? 2 : 1;
    return need > back ? b.length - back : b.length;
  }
  return b.length;
}

/**
 * Part of a text file, as text: from a byte offset, or its end ("tail", for logs), at most
 * `maxBytes` (128 KB), cut on whole characters.
 */
export async function readAttachmentText(ctx: Ctx, id: string, opts: { offset?: number; maxBytes?: number; tail?: boolean } = {}): Promise<AttachmentText> {
  const row = await loadVisible(ctx, id);
  if (!isText(row.contentType)) {
    throw badRequest(`${row.name} is ${describeType(row.contentType)}, not text`, `Download it instead: ${contentUrl(ctx.app, row.id)}`);
  }
  const max = Math.min(Math.max(opts.maxBytes ?? 32_768, 1), 131_072);
  let from = opts.tail ? Math.max(0, row.size - max) : Math.min(Math.max(opts.offset ?? 0, 0), row.size);
  let to = Math.min(row.size, from + max);
  if (to <= from) return { id: row.id, name: row.name, size: row.size, from, to: from, truncated: from > 0, text: '' };
  let stream: Readable;
  try {
    stream = await attachmentStorage(ctx.app).read(row.blobKey, { start: from, end: to - 1 });
  } catch (e) {
    if (e instanceof BlobNotFound) throw new AppError(410, 'gone', `The file of ${row.name} is missing from storage`, 'Upload it again.');
    throw e;
  }
  const buf = await collect(stream, to - from);
  const charset = /charset=([\w-]+)/i.exec(row.contentType)?.[1]?.toLowerCase() ?? 'utf-8';
  let text: string;
  if (charset === 'utf-16le' || charset === 'utf-16be') {
    let a = from % 2;
    const b = buf.length - ((buf.length - a) % 2);
    if (from === 0 && b - a >= 2) a += 2; // the byte-order mark
    const part = Buffer.from(buf.subarray(a, b));
    text = (charset === 'utf-16be' ? part.swap16() : part).toString('utf16le');
    to = from + b;
    from += a;
  } else if (charset === 'utf-8') {
    let a = 0;
    if (from > 0) while (a < Math.min(buf.length, 3) && (buf[a]! & 0xc0) === 0x80) a++;
    const b = to < row.size ? wholeUtf8End(buf) : buf.length;
    text = new TextDecoder('utf-8').decode(buf.subarray(a, b));
    if (from === 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    to = from + b;
    from += a;
  } else {
    text = buf.toString('latin1');
  }
  return { id: row.id, name: row.name, size: row.size, from, to, truncated: from > 0 || to < row.size, text };
}

/** The uploader may delete a file, or anyone who may change its project. */
export async function deleteAttachment(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const row = await loadVisible(ctx, id);
  if (row.uploadedById !== ctx.actor.user.id) {
    await assertCanWriteProject(ctx, row.projectId).catch((e) => {
      throw e instanceof AppError && e.status === 404
        ? notFound('Attachment')
        : forbidden('Only the person who added a file, or someone who may change the project, can delete it');
    });
  }
  const activity = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [gone] = await tx.delete(attachments).where(eq(attachments.id, id)).returning();
    if (!gone) throw notFound('Attachment', 'It was deleted just now.');
    let issueRef: IssueRef | undefined;
    let article: ArticleRef | undefined;
    if (gone.issueId) {
      await tx.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, gone.issueId));
      issueRef = (await issueRefsById(tx, s, [gone.issueId])).get(gone.issueId);
    }
    if (gone.articleId) article = (await articleRefsById(tx, s, [gone.articleId])).get(gone.articleId);
    return recordActivity(tx, ctx, {
      type: 'attachment.removed',
      projectId: gone.projectId,
      issueId: gone.issueId,
      payload: {
        ...(issueRef ? { issue: issueRef } : {}),
        data: {
          attachment: { id: gone.id, name: gone.name, size: gone.size, contentType: gone.contentType, sha256: gone.sha256 },
          ...(gone.commentId ? { commentId: gone.commentId } : {}),
          ...(article ? { article } : {}),
        },
      },
    });
  });
  await publishActivities(ctx.app, [activity]);
  // Best effort now; the sweeper takes whatever this leaves.
  await removeBlob(ctx.app, row.blobKey).catch(() => {});
}

/** How long an upload may take before its half-written file counts as abandoned. */
export const ABANDONED_UPLOAD_MS = 6 * 60 * 60 * 1000;

/**
 * Remove files nothing points at any more: those of deleted comments; those whose row went
 * (deleted, or with its issue, article or project); and uploads that never finished. Safe
 * to run anywhere, any time, and more than once at a time.
 */
export async function sweepAttachments(app: AppServices, opts: { abandonedAfterMs?: number; limit?: number } = {}): Promise<{ removed: number }> {
  const db = app.db;
  const storage = attachmentStorage(app);
  // A deleted comment's files go with it.
  await db
    .delete(attachments)
    .where(
      and(
        isNotNull(attachments.commentId),
        exists(db.select({ id: comments.id }).from(comments).where(and(eq(comments.id, attachments.commentId), isNotNull(comments.deletedAt)))),
      ),
    );
  const cutoff = new Date(Date.now() - (opts.abandonedAfterMs ?? ABANDONED_UPLOAD_MS));
  const orphans = await db
    .select({ key: attachmentBlobs.key })
    .from(attachmentBlobs)
    .where(
      and(
        or(eq(attachmentBlobs.state, 'stored'), lt(attachmentBlobs.createdAt, cutoff)),
        notExists(db.select({ k: attachments.blobKey }).from(attachments).where(eq(attachments.blobKey, attachmentBlobs.key))),
      ),
    )
    .limit(opts.limit ?? 500);
  let removed = 0;
  for (const { key } of orphans) {
    try {
      await removeBlob(app, key);
      removed++;
    } catch {
      // still referenced, or storage is unreachable: the next sweep tries again
    }
  }
  await storage.sweepPartial?.(opts.abandonedAfterMs ?? ABANDONED_UPLOAD_MS).catch(() => 0);
  return { removed };
}

/**
 * Sweeps after whatever can leave files behind: a file deleted, or an issue, comment or
 * article deleted with its files. The server also sweeps once as it starts, which takes
 * what a crash mid-upload left and what went with a deleted project.
 */
export function attachmentSweeper(app: AppServices): OutboxConsumer {
  return {
    name: 'attachment-sweeper',
    types: ['attachment.removed', 'issue.deleted', 'comment.deleted', 'article.deleted'],
    async handle() {
      await sweepAttachments(app);
    },
  };
}

/** For people: "screenshot.png, 120 KB, an image (PNG)". */
export function describeAttachment(a: Pick<Attachment, 'name' | 'size' | 'contentType'>): string {
  return `${a.name}, ${formatBytes(a.size)}, ${isText(a.contentType) ? 'text' : describeType(a.contentType)}`;
}

export { baseType, formatBytes };
