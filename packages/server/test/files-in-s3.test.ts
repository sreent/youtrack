import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFilesToS3, manifestFor } from '../src/attachments/copy-to-s3';
import { wantedRange } from '../src/attachments/range';
import { S3Storage } from '../src/attachments/s3';
import { playableAs, sniffContentType } from '../src/attachments/sniff';
import { LocalDiskStorage, setAttachmentStorage } from '../src/attachments/storage';
import { attachmentBlobs, attachments } from '../src/db/schema';
import { createHttpApp } from '../src/http/app';
import { issueUploadTarget, storeAttachment, sweepAttachments } from '../src/services/attachments';
import { issueTokenFor } from '../src/services/auth';
import { createIssue } from '../src/services/issues';
import { startFakeS3, type FakeS3 } from './fake-s3';
import { createWorld, type TestWorld } from './helpers';

const MB = 1024 * 1024;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let fake: FakeS3;

function bucket(prefix: string): S3Storage {
  return new S3Storage(
    {
      bucket: fake.bucket,
      endpoint: fake.endpoint,
      region: 'us-east-1',
      prefix,
      forcePathStyle: true,
      credentials: { accessKeyId: fake.accessKeyId, secretAccessKey: fake.secretAccessKey },
    },
    { maxAttempts: 2 },
  );
}

function client(app: ReturnType<typeof createHttpApp>, token: string) {
  return async (method: string, url: string, opts: { form?: FormData; headers?: Record<string, string> } = {}) => {
    const res = await app.request(`/api/v1${url}`, { method, headers: { authorization: `Bearer ${token}`, ...(opts.headers ?? {}) }, body: opts.form });
    const raw = Buffer.from(await res.arrayBuffer());
    const json = (res.headers.get('content-type') ?? '').includes('application/json') && raw.length ? JSON.parse(raw.toString('utf8')) : null;
    return { status: res.status, headers: res.headers, raw, body: json };
  };
}

function fileForm(name: string, bytes: Buffer | string) {
  const form = new FormData();
  form.append('file', new Blob([typeof bytes === 'string' ? Buffer.from(bytes) : bytes]), name);
  return form;
}

beforeAll(async () => {
  fake = await startFakeS3();
});

afterAll(async () => {
  await fake.close();
});

beforeEach(() => {
  fake.heal();
});

describe('a range of a file', () => {
  it('resolves one byte range against the size, and ignores what it does not serve', () => {
    const etag = '"abc"';
    expect(wantedRange(undefined, undefined, etag, 1000)).toBeNull();
    expect(wantedRange('bytes=0-99', undefined, etag, 1000)).toEqual({ start: 0, end: 99 });
    expect(wantedRange('bytes=900-', undefined, etag, 1000)).toEqual({ start: 900, end: 999 });
    expect(wantedRange('bytes=-100', undefined, etag, 1000)).toEqual({ start: 900, end: 999 });
    expect(wantedRange('bytes=-5000', undefined, etag, 1000)).toEqual({ start: 0, end: 999 });
    expect(wantedRange('bytes=990-5000', undefined, etag, 1000)).toEqual({ start: 990, end: 999 });
    expect(wantedRange('bytes=1000-', undefined, etag, 1000)).toBe('unsatisfiable');
    expect(wantedRange('bytes=-0', undefined, etag, 1000)).toBe('unsatisfiable');
    expect(wantedRange('bytes=0-', undefined, etag, 0)).toBe('unsatisfiable');
    // Not served, so the whole file: several ranges, other units, nonsense, backwards.
    expect(wantedRange('bytes=0-1,5-6', undefined, etag, 1000)).toBeNull();
    expect(wantedRange('items=0-1', undefined, etag, 1000)).toBeNull();
    expect(wantedRange('bytes=abc', undefined, etag, 1000)).toBeNull();
    expect(wantedRange('bytes=50-10', undefined, etag, 1000)).toBeNull();
    // If-Range: only this version's own ETag keeps the range.
    expect(wantedRange('bytes=0-9', '"abc"', etag, 1000)).toEqual({ start: 0, end: 9 });
    expect(wantedRange('bytes=0-9', '"old"', etag, 1000)).toBeNull();
    expect(wantedRange('bytes=0-9', 'Wed, 21 Oct 2025 07:28:00 GMT', etag, 1000)).toBeNull();
  });
});

describe('what plays in the page', () => {
  const ebml = (docType: string) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]), Buffer.from(docType), Buffer.alloc(40)]);
  it('tells sound and video from their bytes, and plays only what browsers all decode', () => {
    expect(sniffContentType(ebml('webm'))).toBe('video/webm');
    expect(sniffContentType(ebml('matroska'))).toBe('video/x-matroska');
    expect(sniffContentType(Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]))).toBe('audio/mpeg');
    expect(sniffContentType(Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f, 0xfc, 0x21]))).toBe('audio/aac');
    expect(sniffContentType(Buffer.from('OggS\0\x02'))).toBe('audio/ogg');
    expect(sniffContentType(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(20)]))).toBe('video/mp4');
    // A UTF-16 text's mark looks like a frame's start, and isn't one.
    expect(sniffContentType(Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))).toBe('text/plain; charset=utf-16le');
    // A bad bitrate, or a reserved sample rate, isn't a frame either.
    expect(sniffContentType(Buffer.from([0xff, 0xfb, 0xf0, 0x64, 0, 0, 0, 0]))).not.toBe('audio/mpeg');
    expect(sniffContentType(Buffer.from([0xff, 0xfb, 0x9c, 0x64, 0, 0, 0, 0]))).not.toBe('audio/mpeg');

    expect(playableAs('audio/mpeg')).toBe('audio');
    expect(playableAs('audio/ogg')).toBe('audio');
    expect(playableAs('video/webm')).toBe('video');
    expect(playableAs('video/mp4')).toBe('video');
    for (const t of ['video/quicktime', 'video/x-matroska', 'video/x-msvideo', 'application/pdf', 'text/html', 'image/png']) expect(playableAs(t)).toBeNull();
  });
});

describe('files in a bucket', () => {
  let w: TestWorld;
  let app: ReturnType<typeof createHttpApp>;
  let call: ReturnType<typeof client>;
  let issue: string;

  const blobKeyOf = async (id: string) => (await w.app.db.select().from(attachments).where(eq(attachments.id, id)))[0]!.blobKey;
  const inBucket = () => [...fake.objects().keys()].filter((k) => k.startsWith('a4a/'));

  beforeAll(async () => {
    w = await createWorld();
    Object.assign(w.app.config, { attachmentMaxBytes: 6 * MB, attachmentsPerIssueMaxBytes: 40 * MB, publicUrl: 'http://a4a.test' });
    setAttachmentStorage(w.app, bucket('a4a/'));
    app = createHttpApp(w.app);
    call = client(app, (await issueTokenFor(w.app.db, w.anna.id, { name: 'anna-ci', scopes: ['read', 'write'] })).token);
    issue = (await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Crash on start' })).id;
  });

  afterAll(async () => {
    await w.close();
  });

  it('keeps an upload in the bucket, and serves it whole, in part, and as text', async () => {
    const log = Buffer.from(Array.from({ length: 400 }, (_, i) => `2026-11-16 09:${String(i % 60).padStart(2, '0')} line ${i}\n`).join(''));
    const up = await call('POST', `/issues/${issue}/attachments`, { form: fileForm('server.log', log) });
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ name: 'server.log', size: log.length, text: true, play: null, sha256: sha(log) });
    const key = await blobKeyOf(up.body.id);
    expect(fake.objects().get(`a4a/${key}`)?.body.equals(log)).toBe(true);

    const whole = await call('GET', `/attachments/${up.body.id}/content`);
    expect(whole.status).toBe(200);
    expect(whole.raw.equals(log)).toBe(true);
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(whole.headers.get('x-content-type-options')).toBe('nosniff');
    expect(whole.headers.get('content-security-policy')).toBe('sandbox');

    const first = await call('GET', `/attachments/${up.body.id}/content`, { headers: { range: 'bytes=0-99' } });
    expect(first.status).toBe(206);
    expect(first.headers.get('content-range')).toBe(`bytes 0-99/${log.length}`);
    expect(first.headers.get('content-length')).toBe('100');
    expect(first.raw.equals(log.subarray(0, 100))).toBe(true);
    expect(fake.requests.at(-1)).toMatchObject({ op: 'GetObject', range: 'bytes=0-99' });

    const last = await call('GET', `/attachments/${up.body.id}/content`, { headers: { range: 'bytes=-50' } });
    expect(last.status).toBe(206);
    expect(last.raw.equals(log.subarray(log.length - 50))).toBe(true);
    const stale = await call('GET', `/attachments/${up.body.id}/content`, { headers: { range: 'bytes=0-9', 'if-range': '"another-version"' } });
    expect([stale.status, stale.raw.length]).toEqual([200, log.length]);
    const past = await call('GET', `/attachments/${up.body.id}/content`, { headers: { range: `bytes=${log.length}-` } });
    expect([past.status, past.headers.get('content-range')]).toEqual([416, `bytes */${log.length}`]);
    const several = await call('GET', `/attachments/${up.body.id}/content`, { headers: { range: 'bytes=0-1,5-6' } });
    expect([several.status, several.raw.length]).toEqual([200, log.length]);

    const tail = await call('GET', `/attachments/${up.body.id}/text?tail=true&maxBytes=200`);
    expect(tail.status).toBe(200);
    expect(tail.body.text.endsWith('line 399\n')).toBe(true);

    expect((await call('DELETE', `/attachments/${up.body.id}`)).status).toBe(204);
    expect(fake.objects().has(`a4a/${key}`)).toBe(false);
  });

  it('streams a large file up in parts, and serves any part of it', async () => {
    const big = randomBytes(5 * MB + 700_000);
    const before = fake.requests.length;
    const up = await call('POST', `/issues/${issue}/attachments`, { form: fileForm('trace.bin', big) });
    expect(up.status).toBe(201);
    const ops = fake.requests.slice(before).map((r) => r.op);
    expect(ops).toContain('CreateMultipartUpload');
    expect(ops.filter((o) => o === 'UploadPart')).toHaveLength(2);
    expect(sha(fake.objects().get(`a4a/${await blobKeyOf(up.body.id)}`)!.body)).toBe(sha(big));
    const middle = await call('GET', `/attachments/${up.body.id}/content`, { headers: { range: `bytes=${5 * MB - 3}-${5 * MB + 2}` } });
    expect(middle.status).toBe(206);
    expect(middle.raw.equals(big.subarray(5 * MB - 3, 5 * MB + 3))).toBe(true);
  });

  it('refuses a file over the limit part-way, and leaves nothing in the bucket', async () => {
    const objects = inBucket().length;
    const blobs = (await w.app.db.select().from(attachmentBlobs)).length;
    const over = await call('POST', `/issues/${issue}/attachments`, { form: fileForm('huge.bin', Buffer.alloc(7 * MB, 3)) });
    expect(over.status).toBe(413);
    expect(over.body.error.message).toContain('larger than 6 MB');
    expect(inBucket()).toHaveLength(objects);
    expect(fake.uploads.size).toBe(0);
    expect(await w.app.db.select().from(attachmentBlobs)).toHaveLength(blobs);
  });

  it('answers 503 while the bucket fails, logs why, and sweeps what it left once it answers', async () => {
    const kept = await call('POST', `/issues/${issue}/attachments`, { form: fileForm('kept.txt', 'still here') });
    expect(kept.status).toBe(201);
    const blobs = (await w.app.db.select().from(attachmentBlobs)).length;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      fake.failNext('*', { status: 503, code: 'ServiceUnavailable', message: 'Service is unable to handle request.' }, 1000);
      const up = await call('POST', `/issues/${issue}/attachments`, { form: fileForm('report.txt', 'quarterly') });
      expect(up.status).toBe(503);
      expect(up.body.error).toMatchObject({ code: 'storage_unavailable', message: "Files can't be reached right now" });
      expect(up.body.error.hint).toContain("server's log");
      // Nothing about the bucket reaches the person; the log names it.
      expect(JSON.stringify(up.body)).not.toContain(fake.endpoint);
      expect(logged.mock.calls.flat().join(' ')).toMatch(/attachment storage, storing report\.txt: The bucket files at http:\/\/127\.0\.0\.1:\d+ failed \(503\)/);

      const down = await call('GET', `/attachments/${kept.body.id}/content`);
      expect(down.status).toBe(503);
    } finally {
      logged.mockRestore();
      fake.heal();
    }
    // The upload's record stayed, as its bytes couldn't be removed; the sweeper takes it now.
    expect(await w.app.db.select().from(attachmentBlobs)).toHaveLength(blobs + 1);
    await sweepAttachments(w.app, { abandonedAfterMs: 0 });
    expect(await w.app.db.select().from(attachmentBlobs)).toHaveLength(blobs);
    expect((await call('GET', `/attachments/${kept.body.id}/content`)).raw.toString()).toBe('still here');
  });

  it('says which files play, from their bytes', async () => {
    const ogg = await call('POST', `/issues/${issue}/attachments`, { form: fileForm('voice.ogg', Buffer.concat([Buffer.from('OggS\0\x02'), Buffer.alloc(200)])) });
    expect(ogg.body).toMatchObject({ play: 'audio', inline: false, text: false });
    const mkv = await call('POST', `/issues/${issue}/attachments`, {
      form: fileForm('screen.webm', Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('matroska'), Buffer.alloc(200)])),
    });
    expect(mkv.body).toMatchObject({ contentType: 'video/x-matroska', play: null });
    const down = await call('GET', `/attachments/${mkv.body.id}/content`);
    expect(down.headers.get('content-disposition')).toMatch(/^attachment;/);
  });
});

describe('copying files from disk to a bucket', () => {
  let w: TestWorld;
  let root: string;
  let issue: string;
  const files: Record<string, { id: string; key: string; bytes: Buffer }> = {};
  const lines: string[] = [];
  const log = (line: string) => void lines.push(line);
  let manifest: string;
  let s3: S3Storage;

  const onDisk = (key: string) => path.join(root, ...key.split('/'));
  const add = async (name: string, bytes: Buffer) => {
    const ctx = w.as(w.anna);
    const stored = await storeAttachment(ctx, await issueUploadTarget(ctx, issue), { name, stream: Readable.from([bytes]) });
    const [row] = await w.app.db.select().from(attachments).where(eq(attachments.id, stored.id));
    files[name] = { id: stored.id, key: row!.blobKey, bytes };
  };
  const inBucket = (name: string) => fake.objects().get(`moved/${files[name]!.key}`)?.body;

  beforeAll(async () => {
    w = await createWorld();
    Object.assign(w.app.config, { attachmentMaxBytes: 8 * MB, attachmentsPerIssueMaxBytes: 40 * MB });
    root = mkdtempSync(path.join(tmpdir(), 'a4a-to-s3-'));
    setAttachmentStorage(w.app, new LocalDiskStorage(root));
    issue = (await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Moving house' })).id;
    await add('build.log', Buffer.from('compiling…\n'.repeat(3000)));
    await add('core.dump', randomBytes(5 * MB + 1234));
    await add('changed.txt', Buffer.from('as uploaded'));
    await add('lost.txt', Buffer.from('gone from disk'));
    s3 = bucket('moved/');
    manifest = manifestFor(root, s3.config);
  });

  afterAll(async () => {
    await w.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('copies every file, checking each against its checksum, and says what it could not copy', async () => {
    // What a disk can do to files meanwhile: one changed behind a4a's back, one lost.
    writeFileSync(onDisk(files['changed.txt']!.key), 'changed on disk');
    unlinkSync(onDisk(files['lost.txt']!.key));

    const dry = await copyFilesToS3(w.app.db, new LocalDiskStorage(root), s3, { manifest, dryRun: true, log });
    expect(dry).toMatchObject({ files: 4, toCopy: 4, toCheck: 0, copied: 0, failed: [] });
    expect([...fake.objects().keys()].filter((k) => k.startsWith('moved/'))).toEqual([]);

    const first = await copyFilesToS3(w.app.db, new LocalDiskStorage(root), s3, { manifest, log });
    expect(first).toMatchObject({ files: 4, copied: 2, already: 0, checked: 0, stopped: null });
    expect(first.failed.map((f) => [f.name, f.why]).sort()).toEqual([
      ['changed.txt', "its file on disk doesn't match the checksum taken when it was uploaded"],
      ['lost.txt', 'its file is missing from disk'],
    ]);
    expect(inBucket('build.log')?.equals(files['build.log']!.bytes)).toBe(true);
    expect(sha(inBucket('core.dump')!)).toBe(sha(files['core.dump']!.bytes));
    // A file that doesn't match its checksum isn't left in the bucket.
    expect(inBucket('changed.txt')).toBeUndefined();
    expect(readFileSync(manifest, 'utf8').trim().split('\n').sort()).toEqual(
      [`${files['build.log']!.key} ${sha(files['build.log']!.bytes)}`, `${files['core.dump']!.key} ${sha(files['core.dump']!.bytes)}`].sort(),
    );
    expect(lines.join('\n')).toMatch(/4 files \(5\.0 MB\) for files\/moved\/ at http:\/\/127\.0\.0\.1:\d+: 0 already there and verified, 4 to copy, 0 there to check\./);
  });

  it('carries on where a run stopped: verified files are skipped, files in flight are checked', async () => {
    const again = await copyFilesToS3(w.app.db, new LocalDiskStorage(root), s3, { manifest, log });
    expect(again).toMatchObject({ already: 2, copied: 0, checked: 0, toCopy: 2 });
    expect(fake.requests.filter((r) => r.op === 'PutObject' && r.key === `moved/${files['build.log']!.key}`)).toHaveLength(1);

    // A run cut off after copying two files, before writing either down; and one copy in the
    // bucket that isn't what was sent.
    writeFileSync(manifest, '');
    fake.objects().get(`moved/${files['build.log']!.key}`)!.body = Buffer.from('half a file');
    const resumed = await copyFilesToS3(w.app.db, new LocalDiskStorage(root), s3, { manifest, log });
    expect(resumed).toMatchObject({ already: 0, checked: 1, copied: 1, toCheck: 2 });
    expect(inBucket('build.log')?.equals(files['build.log']!.bytes)).toBe(true);
    expect(readFileSync(manifest, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('stops when the bucket fails, and finishes when it answers again', async () => {
    await add('late.txt', Buffer.from('uploaded while the copy ran'));
    fake.failNext('PutObject', { status: 500, code: 'InternalError', message: 'We encountered an internal error.' }, 1000);
    const stopped = await copyFilesToS3(w.app.db, new LocalDiskStorage(root), s3, { manifest, log });
    expect(stopped.stopped).toMatch(/The bucket files at .* failed \(500\): InternalError/);
    expect(stopped.copied).toBe(0);
    fake.heal();
    const done = await copyFilesToS3(w.app.db, new LocalDiskStorage(root), s3, { manifest, log });
    expect(done).toMatchObject({ copied: 1, already: 2, stopped: null });
    expect(inBucket('late.txt')?.toString()).toBe('uploaded while the copy ran');
  });

  it('leaves the server serving the same bytes from the bucket', async () => {
    setAttachmentStorage(w.app, s3);
    const app = createHttpApp(w.app);
    const call = client(app, (await issueTokenFor(w.app.db, w.anna.id, { name: 'after-move', scopes: ['read'] })).token);
    for (const name of ['build.log', 'core.dump', 'late.txt']) {
      const got = await call('GET', `/attachments/${files[name]!.id}/content`);
      expect([name, got.status, sha(got.raw)]).toEqual([name, 200, sha(files[name]!.bytes)]);
    }
    // The file that couldn't be copied says so, rather than failing quietly.
    expect((await call('GET', `/attachments/${files['lost.txt']!.id}/content`)).status).toBe(410);
  });
});
