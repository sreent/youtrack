import { Readable } from 'node:stream';
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { AttachmentLimitsSchema, AttachmentSchema, AttachmentTextQuery, AttachmentTextSchema, ErrorSchema } from '@a4a/shared';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Ctx } from '../../context';
import { wantedRange } from '../../attachments/range';
import { receiveFile } from '../../attachments/receive';
import { getCookie } from 'hono/cookie';
import { contentDisposition, formatBytes, isInline } from '../../attachments/sniff';
import { AppError, unauthorized } from '../../lib/errors';
import {
  articleUploadTarget,
  attachmentForDownload,
  attachmentForImage,
  attachmentForRequester,
  attachmentLimits,
  commentUploadTarget,
  deleteAttachment,
  getAttachment,
  issueUploadTarget,
  listArticleAttachments,
  listIssueAttachments,
  openAttachmentBytes,
  readAttachmentText,
  storeAttachment,
  type AttachmentRow,
  type UploadTarget,
} from '../../services/attachments';
import { PORTAL_COOKIE, portalRequester } from '../../services/portal';
import type { HttpEnv } from '../env';
import { route } from '../route';

const tags = ['Attachments'];
const Id = z.object({ id: z.string() });
const errors = {
  400: { description: 'Not a multipart upload with a part named "file"', content: { 'application/json': { schema: ErrorSchema } } },
  401: { description: 'Not signed in', content: { 'application/json': { schema: ErrorSchema } } },
  403: { description: 'Not allowed for this role, token or comment', content: { 'application/json': { schema: ErrorSchema } } },
  404: { description: 'Not found, or not yours to see', content: { 'application/json': { schema: ErrorSchema } } },
  413: { description: 'Larger than one file may be, or more than its issue or article has room for', content: { 'application/json': { schema: ErrorSchema } } },
};
export const MultipartFile = z.object({ file: z.string().meta({ format: 'binary', description: 'The file. Its type is read from its bytes; its name is made safe.' }) });

function need(c: Context<HttpEnv>): Ctx {
  const ctx = c.get('ctx');
  if (!ctx) throw unauthorized('Sign in, or send "Authorization: Bearer <token>"', 'Create a token under Agents and tokens.').said('access.signInOrToken');
  return ctx;
}

/** Document a multipart upload in OpenAPI; the handler reads the body itself, as a stream. */
export function uploadRoute(app: OpenAPIHono<HttpEnv>, path: string, summary: string, description: string, target: (ctx: Ctx, id: string) => Promise<UploadTarget>) {
  app.openAPIRegistry.registerPath(
    createRoute({
      method: 'post',
      path,
      tags,
      summary,
      description,
      security: [{ bearerAuth: [] }, { cookieAuth: [] }],
      request: { params: Id, body: { content: { 'multipart/form-data': { schema: MultipartFile } }, required: true } },
      responses: { 201: { description: 'Stored', content: { 'application/json': { schema: AttachmentSchema } } }, ...errors },
    }),
  );
  app.post(path.replace('{id}', ':id'), async (c) => {
    const ctx = need(c);
    // Who may put a file there is settled before a byte of it is read.
    const where = await target(ctx, c.req.param('id') ?? '');
    const max = ctx.app.config.attachmentMaxBytes;
    const file = await receiveFile(c.req.raw, {
      maxBytes: max,
      tooLargeMessage: `Files can be at most ${formatBytes(max)}`,
      tooLargeWords: { key: 'attachments.fileTooLarge', values: { size: formatBytes(max) } },
    });
    return c.json(await storeAttachment(ctx, where, file), 201);
  });
}

function downloadHeaders(row: AttachmentRow, asDownload: boolean): Headers {
  const inline = isInline(row.contentType) && !asDownload;
  return new Headers({
    'content-type': row.contentType,
    'content-length': String(row.size),
    'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', row.name),
    // What's uploaded is never run here: no guessing at its type, and a sandbox if it's opened.
    'x-content-type-options': 'nosniff',
    'content-security-policy': 'sandbox',
    'cross-origin-resource-policy': 'same-origin',
    // Its bytes never change under its id; who may see them can, so caches are the browser's alone.
    'cache-control': 'private, max-age=86400',
    etag: `"${row.sha256}"`,
    'last-modified': row.createdAt.toUTCString(),
    // A player seeks with ranges; Safari plays no video without them.
    'accept-ranges': 'bytes',
  });
}

export function attachmentRoutes(app: OpenAPIHono<HttpEnv>) {
  route(
    app,
    { method: 'get', path: '/attachments/limits', guests: true, tags, summary: 'How large files may be, and which are shown in place', response: AttachmentLimitsSchema },
    async ({ ctx }) => attachmentLimits(ctx),
  );
  route(
    app,
    { method: 'get', path: '/issues/{id}/attachments', guests: true, tags, summary: "An issue's files, its comments' included", params: Id, response: z.array(AttachmentSchema) },
    ({ ctx, params }) => listIssueAttachments(ctx, params.id),
  );
  uploadRoute(
    app,
    '/issues/{id}/attachments',
    'Attach a file to an issue',
    'multipart/form-data with the file in a part named `file`, e.g. `curl -F file=@build.log`. One file per request, up to the server\'s limit (20 MB by default), and all of an issue\'s files together up to its cap (100 MB). The type is read from the bytes; the name is made safe.',
    (ctx, id) => issueUploadTarget(ctx, id),
  );
  uploadRoute(app, '/comments/{id}/attachments', 'Attach a file to your comment', 'As for an issue; a comment takes files from its author.', (ctx, id) => commentUploadTarget(ctx, id));
  route(
    app,
    { method: 'get', path: '/articles/{id}/attachments', guests: true, tags, summary: "An article's files", params: Id, response: z.array(AttachmentSchema) },
    ({ ctx, params }) => listArticleAttachments(ctx, params.id),
  );
  uploadRoute(app, '/articles/{id}/attachments', 'Attach a file to an article', 'As for an issue.', (ctx, id) => articleUploadTarget(ctx, id));

  route(app, { method: 'get', path: '/attachments/{id}', guests: true, tags, summary: 'A file: its name, type, size, checksum and who added it', params: Id, response: AttachmentSchema }, ({ ctx, params }) =>
    getAttachment(ctx, params.id),
  );
  route(
    app,
    {
      method: 'get',
      path: '/attachments/{id}/text', guests: true,
      tags,
      summary: 'Read a text file, or part of it',
      description: 'At most 128 KB at a time, cut on whole characters: from `offset`, or the end with `tail=true`, as for a log. Files that aren\'t text get 400.',
      params: Id,
      query: AttachmentTextQuery,
      response: AttachmentTextSchema,
    },
    ({ ctx, params, query }) => readAttachmentText(ctx, params.id, { offset: query.offset, maxBytes: query.maxBytes, tail: query.tail === 'true' }),
  );
  route(app, { method: 'delete', path: '/attachments/{id}', tags, summary: 'Delete a file (who added it, or anyone who may change its project)', params: Id, status: 204 }, async ({ ctx, params }) => {
    await deleteAttachment(ctx, params.id);
    return null;
  });

  app.openAPIRegistry.registerPath(
    createRoute({
      method: 'get',
      path: '/attachments/{id}/content',
      tags,
      summary: "A file's bytes",
      description:
        'PNG, JPEG, GIF and WebP images come `inline`; every other file, SVG and HTML included, as an `attachment` to download, and `download=1` makes images download too. Served with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox` and an ETag (the SHA-256), so `If-None-Match` gets 304. One byte range (`Range: bytes=…`, with `If-Range` if you like) gets 206 and that part, as players seek; several at once get the whole file.\n\nGuests read it too, sending no credentials, in the projects an administrator opened to anyone (D37, D64).',
      // An empty requirement: a guest may ask without credentials.
      security: [{ bearerAuth: [] }, { cookieAuth: [] }, {}],
      request: {
        params: Id,
        query: z.object({ download: z.string().optional().describe('Any value: download even an image') }),
        headers: z.object({ range: z.string().optional().describe('One byte range: bytes=0-1023, bytes=1024- or bytes=-500') }),
      },
      responses: {
        200: { description: 'The bytes', content: { 'application/octet-stream': { schema: z.string().meta({ format: 'binary' }) } } },
        206: { description: 'The part asked for, with Content-Range', content: { 'application/octet-stream': { schema: z.string().meta({ format: 'binary' }) } } },
        304: { description: 'Not changed since the ETag sent' },
        404: errors[404],
        410: { description: 'Its bytes are missing from storage', content: { 'application/json': { schema: ErrorSchema } } },
        416: { description: 'The range starts past the end of the file; Content-Range says its size' },
        503: { description: 'The store of files can’t be reached right now', content: { 'application/json': { schema: ErrorSchema } } },
      },
    }),
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: 'get',
      path: '/attachments/{id}/image',
      tags,
      summary: 'A picture, to show within text',
      description:
        'What a picture in Markdown points at (`![name](/api/v1/attachments/{id}/image)`, D39): the bytes of a PNG, JPEG, GIF or WebP image, `inline`. Any other file, SVG and HTML included, answers 404 in the words of a missing one, so a picture is only ever a raster image of a4a\'s own. The same headers and ETag as `/content`.',
      security: [{ bearerAuth: [] }, { cookieAuth: [] }],
      request: { params: Id },
      responses: {
        200: { description: 'The image', content: { 'image/png': { schema: z.string().meta({ format: 'binary' }) } } },
        304: { description: 'Not changed since the ETag sent' },
        404: errors[404],
        410: { description: 'Its bytes are missing from storage', content: { 'application/json': { schema: ErrorSchema } } },
        503: { description: 'The store of files can’t be reached right now', content: { 'application/json': { schema: ErrorSchema } } },
      },
    }),
  );
  app.get('/attachments/:id/image', async (c) => {
    let row: AttachmentRow;
    const ctx = need(c);
    try {
      row = await attachmentForImage(ctx, c.req.param('id'));
    } catch (e) {
      // A request's own pictures, to whoever reads it on the portal (D39's revisit): the portal's
      // cookie names them, and the file is theirs only when the request is.
      if (!(e instanceof AppError) || (e.status !== 401 && e.status !== 404)) throw e;
      const r = await portalRequester(c.get('runtime'), getCookie(c, PORTAL_COOKIE), c.req.header('accept-language')).catch(() => null);
      if (!r) throw e;
      row = await attachmentForRequester(c.get('runtime'), r, c.req.param('id'));
    }
    const headers = downloadHeaders(row, false);
    const etag = headers.get('etag')!;
    const sent = c.req.header('if-none-match');
    if (sent && sent.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)) {
      return new Response(null, { status: 304, headers: { etag, 'cache-control': headers.get('cache-control')! } });
    }
    if (c.req.method === 'HEAD') return new Response(null, { status: 200, headers });
    const bytes = await openAttachmentBytes(ctx.app, row);
    return new Response(Readable.toWeb(bytes) as ReadableStream, { status: 200, headers });
  });
  app.get('/attachments/:id/content', async (c) => {
    const ctx = need(c);
    const row = await attachmentForDownload(ctx, c.req.param('id'));
    const headers = downloadHeaders(row, c.req.query('download') !== undefined);
    const etag = headers.get('etag')!;
    const sent = c.req.header('if-none-match');
    if (sent && sent.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)) {
      return new Response(null, { status: 304, headers: { etag, 'cache-control': headers.get('cache-control')! } });
    }
    if (c.req.method === 'HEAD') return new Response(null, { status: 200, headers });
    const range = wantedRange(c.req.header('range'), c.req.header('if-range'), etag, row.size);
    if (range === 'unsatisfiable') {
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${row.size}`, 'accept-ranges': 'bytes', 'cache-control': 'no-store' } });
    }
    if (range) {
      headers.set('content-range', `bytes ${range.start}-${range.end}/${row.size}`);
      headers.set('content-length', String(range.end - range.start + 1));
      const part = await openAttachmentBytes(ctx.app, row, range);
      return new Response(Readable.toWeb(part) as ReadableStream, { status: 206, headers });
    }
    const bytes = await openAttachmentBytes(ctx.app, row);
    return new Response(Readable.toWeb(bytes) as ReadableStream, { status: 200, headers });
  });
}
