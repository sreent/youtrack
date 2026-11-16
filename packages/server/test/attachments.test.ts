import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { contentDisposition, safeFileName, sniffContentType } from '../src/attachments/sniff';
import { LocalDiskStorage, setAttachmentStorage } from '../src/attachments/storage';
import { attachmentBlobs, attachments } from '../src/db/schema';
import { createHttpApp } from '../src/http/app';
import { issueActivity } from '../src/services/activity';
import { sweepAttachments } from '../src/services/attachments';
import { issueTokenFor } from '../src/services/auth';
import { addComment, deleteComment } from '../src/services/comments';
import { createIssue, deleteIssue } from '../src/services/issues';
import { createWorld, type TestWorld } from './helpers';

// The access seam, with projects that can be hidden from one person: what another agent's
// per-project permissions will do inside services/access.ts.
const seam = vi.hoisted(() => ({ hidden: new Map<string, Set<string>>() }));
vi.mock('../src/services/access', async () => {
  const { requireScope } = await import('../src/context');
  const { notFound } = await import('../src/lib/errors');
  type C = import('../src/context').Ctx;
  const visibleProjectIds = async (ctx: C) => {
    const hide = seam.hidden.get(ctx.actor.user.id);
    if (!hide) return null;
    const s = await ctx.app.schema.get();
    return [...s.projects.keys()].filter((id) => !hide.has(id));
  };
  const canReadProject = async (ctx: C, projectId: string) => {
    const visible = await visibleProjectIds(ctx);
    return visible === null || visible.includes(projectId);
  };
  const assertCanReadProject = async (ctx: C, projectId: string) => {
    requireScope(ctx, 'read');
    if (!(await canReadProject(ctx, projectId))) throw notFound('Project');
  };
  const assertCanWriteProject = async (ctx: C, projectId: string) => {
    await assertCanReadProject(ctx, projectId);
    requireScope(ctx, 'write');
  };
  return { visibleProjectIds, canReadProject, assertCanReadProject, assertCanWriteProject };
});

const MAX = 64 * 1024;
const CAP = 160 * 1024;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 7)]);

let w: TestWorld;
let app: ReturnType<typeof createHttpApp>;
let root: string;
const tokens: Record<string, string> = {};
let issue: string;
let other: string;

async function call(method: string, url: string, opts: { as?: string; body?: unknown; form?: FormData; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.as !== 'nobody') headers.authorization = `Bearer ${tokens[opts.as ?? 'anna']}`;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await app.request(`/api/v1${url}`, { method, headers, body });
  const type = res.headers.get('content-type') ?? '';
  const raw = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, raw, body: type.includes('application/json') && raw.length ? JSON.parse(raw.toString('utf8')) : null };
}

function fileForm(name: string, bytes: Buffer | string) {
  const form = new FormData();
  form.append('file', new Blob([typeof bytes === 'string' ? Buffer.from(bytes) : bytes]), name);
  return form;
}

const upload = (to: string, name: string, bytes: Buffer | string, as = 'anna', headers?: Record<string, string>) =>
  call('POST', to, { as, form: fileForm(name, bytes), headers });

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

beforeAll(async () => {
  w = await createWorld();
  Object.assign(w.app.config, { attachmentMaxBytes: MAX, attachmentsPerIssueMaxBytes: CAP, publicUrl: 'http://a4a.test' });
  root = mkdtempSync(path.join(tmpdir(), 'a4a-files-'));
  setAttachmentStorage(w.app, new LocalDiskStorage(root));
  app = createHttpApp(w.app);
  tokens.anna = (await issueTokenFor(w.app.db, w.anna.id, { name: 'anna-ci', scopes: ['read', 'write'] })).token;
  tokens.ben = (await issueTokenFor(w.app.db, w.ben.id, { name: 'ben-ci', scopes: ['read', 'write'] })).token;
  tokens.vera = (await issueTokenFor(w.app.db, w.viewer.id, { name: 'vera', scopes: ['read', 'write'] })).token;
  tokens.annaRead = (await issueTokenFor(w.app.db, w.anna.id, { name: 'anna-read', scopes: ['read'] })).token;
  issue = (await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Crash on start' })).id;
  other = (await createIssue(w.as(w.anna), { project: 'WEB', summary: 'Blank page' })).id;
});

afterAll(async () => {
  await w.close();
  rmSync(root, { recursive: true, force: true });
});

describe('telling what a file is, and naming it', () => {
  it('reads the type from the bytes', () => {
    expect(sniffContentType(PNG)).toBe('image/png');
    expect(sniffContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toBe('image/jpeg');
    expect(sniffContentType(Buffer.from('GIF89a……'))).toBe('image/gif');
    expect(sniffContentType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))).toBe('image/webp');
    expect(sniffContentType(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniffContentType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0]))).toBe('application/zip');
    expect(sniffContentType(Buffer.from('  <!DOCTYPE html><html><body>hi</body></html>'))).toBe('text/html');
    expect(sniffContentType(Buffer.from('<p>a paragraph</p>'))).toBe('text/html');
    expect(sniffContentType(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml');
    expect(sniffContentType(Buffer.from('<?xml version="1.0"?><feed/>'))).toBe('application/xml');
    expect(sniffContentType(Buffer.from('2026-11-16 ERROR naïve café ☕\n'))).toBe('text/plain; charset=utf-8');
    expect(sniffContentType(Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))).toBe('text/plain; charset=utf-16le');
    expect(sniffContentType(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x99]))).toBe('application/octet-stream');
  });

  it('keeps only a safe name: no folders, controls or disguised extensions', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('..\\..\\windows\\win.ini')).toBe('win.ini');
    expect(safeFileName('C:\\Users\\anna\\report.pdf')).toBe('report.pdf');
    expect(safeFileName('..')).toBe('file');
    expect(safeFileName('.env')).toBe('env');
    expect(safeFileName('inv\u202Efdp.exe')).toBe('invfdp.exe');
    expect(safeFileName('a\u0000b\nc\r.txt')).toBe('abc.txt');
    expect(safeFileName('what?<now>|"x".log')).toBe('what__now___x_.log');
    expect(safeFileName(`${'a'.repeat(300)}.tar.gz`)).toMatch(/^a+\.gz$/);
    expect(safeFileName(`${'a'.repeat(300)}.tar.gz`).length).toBe(200);
    expect(contentDisposition('attachment', 'Résumé "final".pdf')).toBe(`attachment; filename="Resume _final_.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22.pdf`);
  });
});

describe('uploading, serving and deleting', () => {
  it('stores an image, checksums it and serves it in place, cached', async () => {
    const res = await upload(`/issues/${issue}/attachments`, 'screen shot.png', PNG);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'screen shot.png',
      contentType: 'image/png',
      size: PNG.length,
      sha256: createHash('sha256').update(PNG).digest('hex'),
      inline: true,
      text: false,
      issue,
      comment: null,
      uploadedBy: { login: 'anna' },
      channel: 'api',
    });
    expect(res.body.url).toBe(`http://a4a.test/api/v1/attachments/${res.body.id}/content`);

    const got = await call('GET', `/attachments/${res.body.id}/content`);
    expect(got.status).toBe(200);
    expect(got.raw.equals(PNG)).toBe(true);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('content-disposition')).toBe(`inline; filename="screen shot.png"; filename*=UTF-8''screen%20shot.png`);
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(got.headers.get('content-security-policy')).toBe('sandbox');
    expect(got.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(got.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    const etag = got.headers.get('etag');
    expect(etag).toBe(`"${res.body.sha256}"`);
    expect((await call('GET', `/attachments/${res.body.id}/content`, { headers: { 'if-none-match': etag! } })).status).toBe(304);
    const asDownload = await call('GET', `/attachments/${res.body.id}/content?download=1`);
    expect(asDownload.headers.get('content-disposition')).toMatch(/^attachment; /);

    const list = await call('GET', `/issues/${issue}/attachments`);
    expect(list.body.map((a: { id: string }) => a.id)).toContain(res.body.id);
    const history = await issueActivity(w.as(w.anna), issue);
    const added = history.find((e) => e.type === 'attachment.added');
    expect(added?.data).toMatchObject({ attachment: { id: res.body.id, name: 'screen shot.png', size: PNG.length } });
    expect(added?.actor).toMatchObject({ login: 'anna', channel: 'api', token: 'anna-ci' });
  });

  it('serves an HTML file named .png as a download in a sandbox, whatever its name says', async () => {
    const res = await upload(`/issues/${issue}/attachments`, 'cute-cat.png', '<!DOCTYPE html><html><script>fetch("/api/v1/me")</script></html>');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ contentType: 'text/html', inline: false });
    const got = await call('GET', `/attachments/${res.body.id}/content`);
    expect(got.headers.get('content-type')).toBe('text/html');
    expect(got.headers.get('content-disposition')).toMatch(/^attachment; filename="cute-cat\.png"/);
    // The page's own policy (script-src 'self') must not replace the file's sandbox.
    expect(got.headers.get('content-security-policy')).toBe('sandbox');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves SVG as a download, never in place', async () => {
    const res = await upload(`/issues/${issue}/attachments`, 'logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><circle r="4"/></svg>');
    expect(res.body).toMatchObject({ contentType: 'image/svg+xml', inline: false, text: true });
    const got = await call('GET', `/attachments/${res.body.id}/content`);
    expect(got.headers.get('content-disposition')).toMatch(/^attachment; /);
  });

  it('keeps names safe, and every byte inside the store', async () => {
    const res = await upload(`/issues/${issue}/attachments`, '../../../../tmp/evil.sh', '#!/bin/sh\necho hi\n');
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('evil.sh');
    expect(existsSync('/tmp/evil.sh')).toBe(false);
    const [row] = await w.app.db.select().from(attachments).where(eq(attachments.id, res.body.id));
    expect(row!.blobKey).toMatch(/^[0-9a-z]{2}\/[0-9a-z]{24}$/);
    expect(filesUnder(root).every((f) => f.startsWith(root))).toBe(true);
    expect(existsSync(path.join(root, ...row!.blobKey.split('/')))).toBe(true);
  });

  it('refuses a file over the limit, and leaves nothing behind', async () => {
    const before = await w.app.db.select().from(attachmentBlobs);
    const files = filesUnder(root).length;
    const big = await upload(`/issues/${other}/attachments`, 'big.bin', Buffer.alloc(MAX + 1, 1));
    expect(big.status).toBe(413);
    expect(big.body.error.message).toContain('larger than 64 KB');
    expect(await w.app.db.select().from(attachmentBlobs)).toHaveLength(before.length);
    expect(filesUnder(root)).toHaveLength(files);
    const declared = await call('POST', `/issues/${other}/attachments`, {
      form: fileForm('small.txt', 'x'),
      headers: { 'content-length': String(MAX * 4) },
    });
    expect(declared.status).toBe(413);
    const exact = await upload(`/issues/${other}/attachments`, 'exact.bin', Buffer.alloc(MAX, 1));
    expect(exact.status).toBe(201);
  });

  it('caps what one issue holds, even when uploads race', async () => {
    const fresh = (await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Full of files' })).id;
    const part = Buffer.alloc(60 * 1024, 2);
    expect((await upload(`/issues/${fresh}/attachments`, 'a.bin', part)).status).toBe(201);
    expect((await upload(`/issues/${fresh}/attachments`, 'b.bin', part)).status).toBe(201);
    const third = await upload(`/issues/${fresh}/attachments`, 'c.bin', part);
    expect(third.status).toBe(413);
    expect(third.body.error.message).toContain("doesn't fit");
    const racing = (await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Racing uploads' })).id;
    const both = await Promise.all([1, 2, 3].map((n) => upload(`/issues/${racing}/attachments`, `r${n}.bin`, part)));
    expect(both.map((r) => r.status).sort()).toEqual([201, 201, 413]);
    const held = (await call('GET', `/issues/${racing}/attachments`)).body.reduce((n: number, a: { size: number }) => n + a.size, 0);
    expect(held).toBeLessThanOrEqual(CAP);
  });

  it('lets the uploader or a writer delete, and records it', async () => {
    const mine = (await upload(`/issues/${issue}/attachments`, 'mine.txt', 'mine')).body;
    const [row] = await w.app.db.select().from(attachments).where(eq(attachments.id, mine.id));
    const file = path.join(root, ...row!.blobKey.split('/'));
    expect((await call('DELETE', `/attachments/${mine.id}`, { as: 'vera' })).status).toBe(403);
    expect((await call('DELETE', `/attachments/${mine.id}`, { as: 'annaRead' })).status).toBe(403);
    expect((await call('DELETE', `/attachments/${mine.id}`, { as: 'anna' })).status).toBe(204);
    expect(existsSync(file)).toBe(false);
    expect((await call('GET', `/attachments/${mine.id}/content`)).status).toBe(404);
    expect((await call('DELETE', `/attachments/${mine.id}`)).status).toBe(404);
    const theirs = (await upload(`/issues/${issue}/attachments`, 'theirs.txt', 'theirs')).body;
    expect((await call('DELETE', `/attachments/${theirs.id}`, { as: 'ben' })).status).toBe(204);
    const history = await issueActivity(w.as(w.anna), issue);
    const removed = history.filter((e) => e.type === 'attachment.removed').map((e) => [e.actor.login, (e.data.attachment as { name: string }).name]);
    expect(removed).toEqual([
      ['anna', 'mine.txt'],
      ['ben', 'theirs.txt'],
    ]);
  });

  it('refuses whoever may not, before reading the file', async () => {
    expect((await upload(`/issues/${issue}/attachments`, 'x.txt', 'x', 'vera')).status).toBe(403);
    expect((await upload(`/issues/${issue}/attachments`, 'x.txt', 'x', 'annaRead')).status).toBe(403);
    expect((await upload(`/issues/${issue}/attachments`, 'x.txt', 'x', 'nobody')).status).toBe(401);
    expect((await upload('/issues/BACK-999/attachments', 'x.txt', 'x')).status).toBe(404);
    const notMultipart = await call('POST', `/issues/${issue}/attachments`, { body: { file: 'x' } });
    expect(notMultipart.status).toBe(400);
    expect(notMultipart.body.error.message).toContain('multipart/form-data');
    const form = new FormData();
    form.append('note', 'no file here');
    const noFile = await call('POST', `/issues/${issue}/attachments`, { form });
    expect(noFile.status).toBe(400);
    expect(noFile.body.error.message).toContain('No file');
  });

  it("keeps a hidden project's files hidden, through the access seam", async () => {
    const shown = (await upload(`/issues/${other}/attachments`, 'web.txt', 'web')).body;
    const webId = (await w.app.schema.get()).projectsByKey.get('WEB')!.id;
    seam.hidden.set(w.ben.id, new Set([webId]));
    try {
      expect((await call('GET', `/attachments/${shown.id}/content`, { as: 'ben' })).status).toBe(404);
      expect((await call('GET', `/attachments/${shown.id}`, { as: 'ben' })).status).toBe(404);
      expect((await call('GET', `/issues/${other}/attachments`, { as: 'ben' })).status).toBe(404);
      expect((await upload(`/issues/${other}/attachments`, 'x.txt', 'x', 'ben')).status).toBe(404);
      expect((await call('DELETE', `/attachments/${shown.id}`, { as: 'ben' })).status).toBe(404);
      expect((await call('GET', `/attachments/${shown.id}/content`, { as: 'anna' })).status).toBe(200);
    } finally {
      seam.hidden.clear();
    }
  });

  it('replays a retried upload with the same Idempotency-Key', async () => {
    const before = (await call('GET', `/issues/${other}/attachments`)).body.length;
    const first = await upload(`/issues/${other}/attachments`, 'retry.txt', 'once', 'anna', { 'idempotency-key': 'upload-1' });
    const again = await upload(`/issues/${other}/attachments`, 'retry.txt', 'once', 'anna', { 'idempotency-key': 'upload-1' });
    expect(again.status).toBe(201);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(again.body.id).toBe(first.body.id);
    expect((await call('GET', `/issues/${other}/attachments`)).body).toHaveLength(before + 1);
  });
});

describe('files on comments', () => {
  it("takes files from the comment's author, and lets them go with the comment", async () => {
    const comment = await addComment(w.as(w.anna), issue, 'Log attached.');
    const res = await upload(`/comments/${comment.id}/attachments`, 'server.log', 'INFO start\nERROR boom\n');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ comment: comment.id, issue, contentType: 'text/plain; charset=utf-8', text: true });
    expect((await upload(`/comments/${comment.id}/attachments`, 'x.log', 'x', 'ben')).status).toBe(403);
    const [row] = await w.app.db.select().from(attachments).where(eq(attachments.id, res.body.id));
    const file = path.join(root, ...row!.blobKey.split('/'));

    await deleteComment(w.as(w.anna), comment.id);
    expect((await call('GET', `/issues/${issue}/attachments`)).body.map((a: { id: string }) => a.id)).not.toContain(res.body.id);
    expect((await call('GET', `/attachments/${res.body.id}/content`)).status).toBe(404);
    await sweepAttachments(w.app);
    expect(existsSync(file)).toBe(false);
    expect(await w.app.db.select().from(attachments).where(eq(attachments.id, res.body.id))).toHaveLength(0);
  });
});

describe('reading text', () => {
  it('reads a log from its end, cut on whole characters', async () => {
    const log = `${'line ok\n'.repeat(500)}ERROR: café crashed ☕ at the end\n`;
    const res = (await upload(`/issues/${issue}/attachments`, 'app.log', log)).body;
    const tail = await call('GET', `/attachments/${res.id}/text?tail=true&maxBytes=40`);
    expect(tail.status).toBe(200);
    expect(tail.body.truncated).toBe(true);
    expect(tail.body.to).toBe(Buffer.byteLength(log));
    expect(tail.body.text).toContain('☕ at the end');
    expect(tail.body.text).not.toContain('\uFFFD');
    // Starting inside "é" (two bytes) skips to the next whole character.
    const cafe = Buffer.from(log).indexOf('é');
    const mid = await call('GET', `/attachments/${res.id}/text?offset=${cafe + 1}&maxBytes=12`);
    expect(mid.body.text.startsWith(' crashed')).toBe(true);
    expect(mid.body.from).toBe(cafe + 2);
    const first = await call('GET', `/attachments/${res.id}/text?maxBytes=16`);
    expect(first.body).toMatchObject({ from: 0, to: 16, text: 'line ok\nline ok\n', truncated: true });
  });

  it("won't read an image as text", async () => {
    const png = (await upload(`/issues/${issue}/attachments`, 'img.png', PNG)).body;
    const res = await call('GET', `/attachments/${png.id}/text`);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('an image (PNG), not text');
  });
});

describe('sweeping', () => {
  it('removes abandoned uploads and the files of deleted issues', async () => {
    const doomed = (await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Soon gone' })).id;
    const res = (await upload(`/issues/${doomed}/attachments`, 'gone.txt', 'bye')).body;
    const [row] = await w.app.db.select().from(attachments).where(eq(attachments.id, res.id));
    const file = path.join(root, ...row!.blobKey.split('/'));
    await deleteIssue(w.as(w.anna), doomed);
    // An upload that crashed half-way: its record says "uploading", and it's old.
    const store = new LocalDiskStorage(root);
    const key = 'zz/abandonedabandonedabando';
    const { Readable } = await import('node:stream');
    await store.write(key, Readable.from([Buffer.from('half')]));
    await w.app.db.insert(attachmentBlobs).values({ key, state: 'uploading', createdAt: new Date(Date.now() - 7 * 3600_000) });
    const recent = 'zz/stilluploadingstilluploa';
    await w.app.db.insert(attachmentBlobs).values({ key: recent, state: 'uploading' });

    const swept = await sweepAttachments(w.app);
    expect(swept.removed).toBeGreaterThanOrEqual(2);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(path.join(root, 'zz', 'abandonedabandonedabando'))).toBe(false);
    const keys = (await w.app.db.select().from(attachmentBlobs)).map((b) => b.key);
    expect(keys).not.toContain(key);
    expect(keys).toContain(recent);
    // Every stored file still has its row, and every row its file.
    const rows = await w.app.db.select().from(attachments);
    for (const r of rows) expect(existsSync(path.join(root, ...r.blobKey.split('/')))).toBe(true);
  });
});

describe('MCP', () => {
  async function client(token: string) {
    const transport = new StreamableHTTPClientTransport(new URL('http://a4a.test/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (input, init) => app.request(String(input), init as RequestInit),
    });
    const c = new Client({ name: 'test', version: '1.0.0' });
    await c.connect(transport);
    return c;
  }
  const json = (r: { content: unknown }) => JSON.parse((r.content as { text: string }[])[0]!.text);
  const text = (r: { content: unknown }) => (r.content as { text: string }[])[0]!.text;

  it('lists files on get_issue, reads a log and attaches a small file', async () => {
    const c = await client(tokens.anna!);
    const log = (await upload(`/issues/${other}/attachments`, 'ci.log', 'step 1 ok\nstep 2 FAILED: timeout\n')).body;
    const got = json(await c.callTool({ name: 'get_issue', arguments: { issue: other } }));
    expect(got.attachments.find((a: { id: string }) => a.id === log.id)).toMatchObject({ name: 'ci.log', text: true, by: 'anna' });
    const read = json(await c.callTool({ name: 'read_attachment', arguments: { attachment: log.id, tail: true } }));
    expect(read.text).toContain('FAILED: timeout');
    const made = await c.callTool({ name: 'attach_file', arguments: { to: other, name: 'repro.sh', text: 'curl -i /api/x\n' } });
    expect(json(made)).toMatchObject({ name: 'repro.sh', type: 'text/plain; charset=utf-8', on: other });
    const history = await issueActivity(w.as(w.anna), other);
    expect(history.at(-1)).toMatchObject({ type: 'attachment.added', actor: { channel: 'mcp', token: 'anna-ci' } });
    const big = await c.callTool({ name: 'attach_file', arguments: { to: other, name: 'big.txt', text: 'x'.repeat(300 * 1024) } });
    expect(big.isError).toBe(true);
    expect(text(big)).toContain('over MCP a file may be 256 KB at most');
    const both = await c.callTool({ name: 'attach_file', arguments: { to: other, name: 'x', text: 'a', base64: 'YQ==' } });
    expect(both.isError).toBe(true);
    await c.close();
  });

  it('keeps a read-only token from attaching', async () => {
    const c = await client(tokens.annaRead!);
    const res = await c.callTool({ name: 'attach_file', arguments: { to: other, name: 'x.txt', text: 'x' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('write');
    await c.close();
  });
});
