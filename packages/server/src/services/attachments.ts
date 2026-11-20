/**
 * Files on issues, comments and articles. An upload streams to storage while it's
 * counted, hashed and sniffed; only then, in one transaction, is the row written,
 * the owner's cap checked under its lock, and the activity recorded.
 */
import { requesterRequest, type PortalViewer } from './portal';
import type { ArticleRef, Attachment, AttachmentLimits, AttachmentText, IssueRef } from '@a4a/shared';
import { INLINE_IMAGE_TYPES } from '@a4a/shared';
import { and, asc, eq, exists, isNotNull, isNull, lt, notExists, or, sql, type SQL } from 'drizzle-orm';
import { pipeline, type Readable } from 'node:stream';
import { isAdmin, requireScope, type AppServices, type Ctx } from '../context';
import type { Db } from '../db/client';
import { articles, attachmentBlobs, attachments, comments, issues } from '../db/schema';
import { publishActivities, recordActivity } from '../events/activity';
import type { OutboxConsumer } from '../events/worker';
import { AppError, asSentence, badRequest, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { Inspector, tooLarge } from '../attachments/receive';
import { baseType, describeType, formatBytes, isInline, isText, playableAs, safeFileName, sniffContentType } from '../attachments/sniff';

/** describeType()'s kinds as codes, so a problem can say a file's kind in any language (D49); its English is the API's. */
function typeKind(contentType: string): { kind: string; format: string } {
  const t = baseType(contentType);
  if (t.startsWith('image/')) return { kind: 'image', format: t.slice(6).toUpperCase() };
  if (t.startsWith('video/')) return { kind: 'video', format: '' };
  if (t.startsWith('audio/')) return { kind: 'audio', format: '' };
  if (t === 'application/pdf') return { kind: 'pdf', format: '' };
  if (/zip|gzip|bzip2|xz|zstd|7z|rar|tar/.test(t)) return { kind: 'archive', format: '' };
  return { kind: 'binary', format: '' };
}
import { attachmentStorage, BlobNotFound, newBlobKey, StorageUnavailable } from '../attachments/storage';
import { assertCanCommentProject, assertCanReadProject, assertCanWriteProject, commentSeenSql, projectAccess, seenArticleIds, seesCommentRow } from './access';
import { articleReadableId, articleRef, articleRefsById, resolveArticle, type ArticleRow } from './article-refs';
import { issueRefsById, readableId, type IssueRow } from './issue-refs';
import { findVisibleIssue, resolveIssue } from './issues';
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

/**
 * The store failed (D35): its words go to the server's log, where whoever runs it can act on
 * them; the person is told it isn't their doing, and to try again.
 */
function storeFailed(e: StorageUnavailable, doing: string): AppError {
  console.error(`attachment storage, ${doing}: ${e.message}`);
  return new AppError(503, 'storage_unavailable', "Files can't be reached right now", "Try again in a minute. If it goes on, the server's log says why.").said('attachments.storageUnreachable');
}

/** A file's bytes as storage gives them: missing ones say so, a failing store answers 503. */
async function readBytes(app: AppServices, row: AttachmentRow, range?: { start: number; end: number }): Promise<Readable> {
  try {
    return await attachmentStorage(app).read(row.blobKey, range);
  } catch (e) {
    if (e instanceof BlobNotFound) throw new AppError(410, 'gone', `The file of ${row.name} is missing from storage`, 'Upload it again.').said('attachments.fileMissing', { name: row.name });
    if (e instanceof StorageUnavailable) throw storeFailed(e, `reading ${row.blobKey}`);
    throw e;
  }
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
      play: playableAs(r.contentType),
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

/** Files still in view: a deleted comment's go with it, and a comment's limited away from the caller (D37). */
const visibleOnIssue = (issueId: string, commentSeen: SQL | undefined) =>
  and(eq(attachments.issueId, issueId), or(isNull(attachments.commentId), and(isNull(comments.deletedAt), commentSeen)));

async function issueRows(db: Db, issueId: string, commentSeen: SQL | undefined): Promise<AttachmentRow[]> {
  const rows = await db
    .select({ a: attachments })
    .from(attachments)
    .leftJoin(comments, eq(comments.id, attachments.commentId))
    .where(visibleOnIssue(issueId, commentSeen))
    .orderBy(asc(attachments.createdAt));
  return rows.map((r) => r.a);
}

/** An issue's files, its comments' included (each says which comment). */
export async function listIssueAttachments(ctx: Ctx, issueId: string): Promise<Attachment[]> {
  requireScope(ctx, 'read');
  const issue = await resolveIssue(ctx, issueId);
  return toDtos(ctx, await issueRows(ctx.db, issue.id, commentSeenSql(await projectAccess(ctx), 'comments')));
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
    .select({ a: attachments, comment: comments })
    .from(attachments)
    .leftJoin(comments, eq(comments.id, attachments.commentId))
    .where(eq(attachments.id, id));
  const missing = () => notFound('Attachment', 'List the files on the issue or article to find its id.').said('attachments.notFoundListFiles');
  if (!found || found.comment?.deletedAt) throw missing();
  // One the caller can't see answers in the very words of one that doesn't exist.
  await assertCanReadProject(ctx, found.a.projectId).catch(() => {
    throw missing();
  });
  // So does one on an issue, or a comment, limited away from them (D37).
  if (found.a.issueId && !(await findVisibleIssue(ctx, found.a.issueId))) throw missing();
  if (found.comment && !seesCommentRow(await projectAccess(ctx), found.a.projectId, found.comment)) throw missing();
  // And one on an article limited away from them, or under one that is (D51): its preview and its bytes too.
  if (found.a.articleId && !(await seenArticleIds(ctx, [found.a.articleId])).has(found.a.articleId)) throw missing();
  return found.a;
}

export async function getAttachment(ctx: Ctx, id: string): Promise<Attachment> {
  return (await toDtos(ctx, [await loadVisible(ctx, id)]))[0]!;
}

/** The row, to serve its bytes: the caller checks If-None-Match before opening them. */
export async function attachmentForDownload(ctx: Ctx, id: string): Promise<AttachmentRow> {
  return loadVisible(ctx, id);
}

/**
 * The row of a file shown in place within text (D39): a raster image only. Any other file, SVG
 * and HTML included, answers in the very words of one that doesn't exist, so a picture in a
 * description can never be anything a browser would run or draw from markup.
 */
export async function attachmentForImage(ctx: Ctx, id: string): Promise<AttachmentRow> {
  const row = await loadVisible(ctx, id);
  if (!isInline(row.contentType)) throw notFound('Attachment', 'List the files on the issue or article to find its id.').said('attachments.notFoundListFiles');
  return row;
}

/** A request's picture, to whoever reads it on the portal (D39's revisit): the requester, a
 * colleague of theirs or someone copied on it, and to nobody else.
 */
export async function attachmentForRequester(app: AppServices, r: PortalViewer, id: string): Promise<AttachmentRow> {
  const [row] = await app.db.select().from(attachments).where(eq(attachments.id, id));
  if (!row || !row.issueId) throw notFound('Attachment', 'List the files on the issue or article to find its id.').said('attachments.notFoundListFiles');
  if (!isInline(row.contentType)) throw notFound('Attachment', 'List the files on the issue or article to find its id.').said('attachments.notFoundListFiles');
  // The portal's seam reads the request by its readable id: the file's column keeps its own.
  const s = await app.schema.get();
  const [issue] = await app.db.select({ projectId: issues.projectId, number: issues.number }).from(issues).where(eq(issues.id, row.issueId));
  if (!issue) throw notFound('Attachment', 'List the files on the issue or article to find its id.').said('attachments.notFoundListFiles');
  await requesterRequest(app, r, readableId(s, issue)); // missing to anyone who doesn't read the request
  return row;
}

/** Its bytes, or those from `start` to `end` (both included), for the content route. */
export function openAttachmentBytes(app: AppServices, row: AttachmentRow, range?: { start: number; end: number }): Promise<Readable> {
  return readBytes(app, row, range);
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
  if (!comment) throw notFound('Comment').said('notFound.commentUnnamed');
  const issue = await resolveIssue(ctx, comment.issueId).catch(() => {
    throw notFound('Comment').said('notFound.commentUnnamed');
  });
  if (comment.authorId !== ctx.actor.user.id && !isAdmin(ctx)) {
    throw forbidden('You can only attach files to your own comments', 'Attach it to the issue instead.').said('attachments.onlyOwnComments');
  }
  // As with its words: whoever may comment in the project, a viewer included.
  await assertCanCommentProject(ctx, issue.projectId);
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
          .where(visibleOnIssue(target.issue.id, undefined));
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
 * A file an import brings: who added it and when, as the other tracker says, and the import it
 * came with. It is recorded as imported, so nobody is told, and it leaves the issue's updated date
 * as the import set it.
 */
export interface ImportedFile {
  uploadedById: string;
  createdAt: Date;
  data: Record<string, unknown>;
}

/**
 * Store an upload: stream it to storage, counting, hashing and sniffing it on the way,
 * then record it. The owner's cap is checked twice, before the first byte (to stop early)
 * and under the owner's row lock once the size is known (so two uploads at once can't
 * both squeeze in). Whatever fails, nothing is left behind.
 */
export async function storeAttachment(ctx: Ctx, target: UploadTarget, source: UploadSource, opts: { imported?: ImportedFile; /** The portal's upload (D39's revisit): the requester's reply is its own activity, so the file adds none. */ quiet?: boolean } = {}): Promise<Attachment> {
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
    throw refuse(tooLarge(`${owner} already holds ${formatBytes(used)} of files, as much as it may`, 'Remove files it no longer needs.', { key: 'attachments.ownerFull', values: { owner, used: formatBytes(used) } }));
  }
  const max = Math.min(maxFile, room);
  const inspector = new Inspector(max, () =>
    max < maxFile
      ? tooLarge(`${name} doesn't fit: ${owner} has ${formatBytes(room)} left of its ${formatBytes(cap)} for files`, 'Remove files it no longer needs, or attach this one elsewhere.', {
          key: 'attachments.doesntFit',
          values: { name, owner, room: formatBytes(room), cap: formatBytes(cap) },
        })
      : tooLarge(`${name} is larger than ${formatBytes(maxFile)}, the most one file may be`, 'Compress it, or split it into parts.', { key: 'attachments.fileLargerThan', values: { name, max: formatBytes(maxFile) } }),
  );

  const storage = attachmentStorage(ctx.app);
  const key = newBlobKey();
  // Recorded before the first byte is written, so a crash mid-upload leaves something to sweep.
  await ctx.db.insert(attachmentBlobs).values({ key, state: 'uploading' });
  const cleanUp = async () => {
    // The record goes only with the bytes: one the store couldn't remove now stays for the
    // sweeper, which tries again once the upload counts as abandoned.
    const removed = await storage.remove(key).then(
      () => true,
      () => false,
    );
    if (removed) await ctx.db.delete(attachmentBlobs).where(eq(attachmentBlobs.key, key)).catch(() => {});
  };

  try {
    const counted = pipeline(source.stream, inspector, (err) => {
      if (err) source.abort?.();
    });
    await storage.write(key, counted);
  } catch (e) {
    await cleanUp();
    if (e instanceof AppError) throw e;
    if (e instanceof StorageUnavailable) {
      source.abort?.();
      throw storeFailed(e, `storing ${name}`);
    }
    throw badRequest(`The upload of ${name} didn't finish: ${e instanceof Error ? e.message : String(e)}`, 'Try again.').said('attachments.uploadDidNotFinishSaying', { name, reason: asSentence(e instanceof Error ? e.message : String(e)) });
  }

  const size = inspector.size;
  const sha256 = inspector.digest();
  const contentType = sniffContentType(inspector.firstBytes());

  let result: { row: AttachmentRow; activity: Awaited<ReturnType<typeof recordActivity>> | null };
  try {
    result = await ctx.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      let issueRef: IssueRef | undefined;
      let article: ArticleRef | undefined;
      if (target.kind === 'article') {
        const [locked] = await tx.select({ id: articles.id }).from(articles).where(eq(articles.id, target.article.id)).for('update');
        if (!locked) throw notFound(`Article ${owner}`, 'It was deleted while the file was uploading.').said('attachments.articleDeletedWhileUploading', { owner });
        article = articleRef(s, target.article);
      } else {
        const [locked] = await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, target.issue.id)).for('update');
        if (!locked) throw notFound(`Issue ${owner}`, 'It was deleted while the file was uploading.').said('attachments.issueDeletedWhileUploading', { owner });
        if (target.kind === 'comment') {
          const [c] = await tx.select({ deletedAt: comments.deletedAt }).from(comments).where(eq(comments.id, target.commentId));
          if (!c || c.deletedAt) throw notFound('Comment', 'It was deleted while the file was uploading.').said('attachments.commentDeletedWhileUploading');
        }
        issueRef = (await issueRefsById(tx, s, [target.issue.id])).get(target.issue.id);
      }
      const usedNow = await usedBytes(tx, target);
      if (usedNow + size > cap) {
        throw tooLarge(`${name} doesn't fit: ${owner} has ${formatBytes(Math.max(cap - usedNow, 0))} left of its ${formatBytes(cap)} for files`, 'Remove files it no longer needs.', {
          key: 'attachments.doesntFitNow',
          values: { name, owner, room: formatBytes(Math.max(cap - usedNow, 0)), cap: formatBytes(cap) },
        });
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
          // The portal's upload (quiet) is a requester's: a4a's people have no row for them, so nobody is named.
          uploadedById: opts.quiet ? null : (opts.imported?.uploadedById ?? ctx.actor.user.id),
          channel: ctx.actor.channel,
          tokenName: ctx.actor.tokenName,
          ...(opts.imported ? { createdAt: opts.imported.createdAt } : {}),
        })
        .returning();
      if (target.kind !== 'article' && !opts.imported) await tx.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, target.issue.id));
      const activity = opts.quiet ? null : await recordActivity(tx, ctx, {
        type: 'attachment.added',
        projectId: row!.projectId,
        issueId: row!.issueId,
        payload: {
          ...(issueRef ? { issue: issueRef } : {}),
          data: {
            attachment: { id: row!.id, name, size, contentType, sha256, url: contentUrl(ctx.app, row!.id) },
            ...(row!.commentId ? { commentId: row!.commentId } : {}),
            ...(article ? { article } : {}),
            ...(opts.imported ? { imported: opts.imported.data } : {}),
          },
        },
      });
      return { row: row!, activity };
    });
  } catch (e) {
    await cleanUp();
    throw e;
  }
  if (result.activity) await publishActivities(ctx.app, [result.activity]);
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
    throw badRequest(`${row.name} is ${describeType(row.contentType)}, not text`, `Download it instead: ${contentUrl(ctx.app, row.id)}`).said('attachments.notText', { name: row.name, ...typeKind(row.contentType), url: contentUrl(ctx.app, row.id) });
  }
  const max = Math.min(Math.max(opts.maxBytes ?? 32_768, 1), 131_072);
  let from = opts.tail ? Math.max(0, row.size - max) : Math.min(Math.max(opts.offset ?? 0, 0), row.size);
  let to = Math.min(row.size, from + max);
  if (to <= from) return { id: row.id, name: row.name, size: row.size, from, to: from, truncated: from > 0, text: '' };
  const stream = await readBytes(ctx.app, row, { start: from, end: to - 1 });
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
        ? notFound('Attachment').said('notFound.attachmentUnnamed')
        : forbidden('Only the person who added a file, or someone who may change the project, can delete it').said('attachments.onlyAdderDeletes');
    });
  }
  const activity = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [gone] = await tx.delete(attachments).where(eq(attachments.id, id)).returning();
    if (!gone) throw notFound('Attachment', 'It was deleted just now.').said('attachments.deletedJustNow');
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
