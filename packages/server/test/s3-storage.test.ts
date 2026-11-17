import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { pipeline, Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BlobNotFound, StorageUnavailable } from '../src/attachments/blob';
import { Inspector } from '../src/attachments/receive';
import { S3Storage } from '../src/attachments/s3';
import { newBlobKey } from '../src/attachments/storage';
import { s3FromEnv, type S3Config } from '../src/config';
import { startFakeS3, type FakeS3 } from './fake-s3';

let fake: FakeS3;

function store(overrides: Partial<S3Config> = {}, maxAttempts = 2): S3Storage {
  return new S3Storage(
    {
      bucket: fake.bucket,
      endpoint: fake.endpoint,
      region: 'us-east-1',
      prefix: 'a4a/',
      forcePathStyle: true,
      credentials: { accessKeyId: fake.accessKeyId, secretAccessKey: fake.secretAccessKey },
      ...overrides,
    },
    { maxAttempts },
  );
}

async function bytesOf(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(chunk as Buffer);
  return Buffer.concat(parts);
}

/** Sends `total` bytes a megabyte at a time, as a network does (a moment apart), then fails with `error`. */
function failingAfter(total: number, error: Error): Readable {
  let sent = 0;
  return new Readable({
    read() {
      setTimeout(() => {
        if (sent >= total) {
          this.destroy(error);
          return;
        }
        const n = Math.min(1024 * 1024, total - sent);
        sent += n;
        this.push(Buffer.alloc(n, 7));
      }, 5);
    },
  });
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

beforeAll(async () => {
  fake = await startFakeS3();
});

afterAll(async () => {
  await fake.close();
});

beforeEach(() => {
  fake.heal();
  fake.requests.length = 0;
});

describe('the S3 store', () => {
  it('keeps a small file in one request, reads it whole and in part, and removes it', async () => {
    const s3 = store();
    const key = newBlobKey();
    const body = Buffer.from('2026-11-16 09:10:02 ERROR the cache went away\n'.repeat(40));
    await s3.write(key, Readable.from([body]));

    expect(fake.objects().get(`a4a/${key}`)?.body.equals(body)).toBe(true);
    expect(fake.requests.map((r) => r.op)).toEqual(['PutObject']);
    expect((await bytesOf(await s3.read(key))).equals(body)).toBe(true);
    expect((await bytesOf(await s3.read(key, { start: 11, end: 18 }))).toString()).toBe('09:10:02');
    expect(fake.requests.at(-1)).toMatchObject({ op: 'GetObject', range: 'bytes=11-18' });

    await s3.remove(key);
    expect(fake.objects().has(`a4a/${key}`)).toBe(false);
    await expect(s3.read(key)).rejects.toBeInstanceOf(BlobNotFound);
    // Gone afterwards, whether or not it was there.
    await expect(s3.remove(key)).resolves.toBeUndefined();
  });

  it('streams a large file up in parts, two at a time', async () => {
    const s3 = store();
    const key = newBlobKey();
    const body = randomBytes(11 * 1024 * 1024 + 123);
    // In pieces, as an upload arrives: nothing hands the store the whole file.
    const pieces = Array.from({ length: Math.ceil(body.length / 65_536) }, (_, i) => body.subarray(i * 65_536, (i + 1) * 65_536));
    await s3.write(key, Readable.from(pieces));

    const ops = fake.requests.map((r) => r.op);
    expect(ops[0]).toBe('CreateMultipartUpload');
    expect(ops.filter((o) => o === 'UploadPart')).toHaveLength(3);
    expect(ops.at(-1)).toBe('CompleteMultipartUpload');
    expect(sha(fake.objects().get(`a4a/${key}`)!.body)).toBe(sha(body));
    expect(fake.uploads.size).toBe(0);
    expect(sha(await bytesOf(await s3.read(key, { start: 5 * 1024 * 1024 - 10, end: 5 * 1024 * 1024 + 9 })))).toBe(
      sha(body.subarray(5 * 1024 * 1024 - 10, 5 * 1024 * 1024 + 10)),
    );
  });

  it('takes an upload counted on its way in, whatever the counter says its size is', async () => {
    // The upload path's own counter has a `size`, which starts at 0: lib-storage would take that
    // for the body's length, and refuse the parts that came.
    const s3 = store();
    const key = newBlobKey();
    const body = randomBytes(6 * 1024 * 1024 + 99);
    const inspector = new Inspector(8 * 1024 * 1024, () => new Error('too large'));
    const counted = pipeline(Readable.from([body.subarray(0, 3_000_000), body.subarray(3_000_000)]), inspector, () => {});
    await s3.write(key, counted);
    expect(inspector.size).toBe(body.length);
    expect(inspector.digest()).toBe(sha(body));
    expect(sha(fake.objects().get(`a4a/${key}`)!.body)).toBe(sha(body));
  });

  it("leaves nothing when its source fails part-way, and passes the source's own error on", async () => {
    const s3 = store();
    const key = newBlobKey();
    const tooLarge = new Error('build.log is larger than 20 MB');
    // Past the first part, so a multipart upload was under way.
    await expect(s3.write(key, failingAfter(6 * 1024 * 1024, tooLarge))).rejects.toBe(tooLarge);
    expect(fake.objects().has(`a4a/${key}`)).toBe(false);
    expect(fake.uploads.size).toBe(0);
    expect(fake.requests.map((r) => r.op)).toContain('AbortMultipartUpload');

    // And within the first part, before any request.
    const cut = new Error('The upload was cut short: aborted');
    const small = newBlobKey();
    await expect(s3.write(small, failingAfter(1024 * 1024, cut))).rejects.toBe(cut);
    expect(fake.objects().has(`a4a/${small}`)).toBe(false);
    expect(fake.requests.filter((r) => r.key === `a4a/${small}`)).toEqual([]);
  });

  it("calls the store's own failures StorageUnavailable, saying what to check", async () => {
    const key = newBlobKey();
    const failure = async (attempt: () => Promise<unknown>) => {
      const e = await attempt().then(
        () => null,
        (err: unknown) => err,
      );
      expect(e).toBeInstanceOf(StorageUnavailable);
      return (e as Error).message;
    };

    expect(await failure(() => store({ bucket: 'nowhere' }).write(key, Readable.from([Buffer.from('x')])))).toMatch(/bucket nowhere at http:\/\/127\.0\.0\.1:\d+ doesn't exist/);
    expect(await failure(() => store({ bucket: 'nowhere' }).read(key))).toMatch(/doesn't exist/);
    expect(await failure(() => store({ credentials: { accessKeyId: 'someone-else', secretAccessKey: 'x' } }).read(key))).toMatch(/refused a4a \(InvalidAccessKeyId\): check S3_ACCESS_KEY_ID/);
    expect(await failure(async () => store({ endpoint: `http://127.0.0.1:${await closedPort()}` }).write(key, Readable.from([Buffer.from('x')])))).toMatch(/can't reach the bucket files at .* \(ECONNREFUSED\)/);

    fake.failNext('*', { status: 500, code: 'InternalError', message: 'We encountered an internal error.' }, 10);
    expect(await failure(() => store().remove(key))).toMatch(/failed \(500\): InternalError/);
  });

  it('tries a request again when the store asks it to slow down', async () => {
    const s3 = store({}, 3);
    const key = newBlobKey();
    fake.failNext('PutObject', { status: 503, code: 'SlowDown', message: 'Please reduce your request rate.' }, 1);
    await s3.write(key, Readable.from([Buffer.from('after a pause')]));
    expect(fake.objects().get(`a4a/${key}`)?.body.toString()).toBe('after a pause');
    expect(fake.requests.filter((r) => r.op === 'PutObject')).toHaveLength(2);
  });

  it("keeps to its prefix: lists a4a's keys, and sweeps only its own unfinished uploads", async () => {
    const s3 = store({ prefix: 'listing/' });
    const keys = [newBlobKey(), newBlobKey(), newBlobKey()].sort();
    for (const k of keys) await s3.write(k, Readable.from([Buffer.from(k)]));
    fake.objects().set('listing/not-ours.txt', { body: Buffer.from('x'), etag: 'x', lastModified: new Date() });
    fake.objects().set('elsewhere/ab/abcdefghijklmnopqrstuvwx', { body: Buffer.from('x'), etag: 'x', lastModified: new Date() });

    const listed: { key: string; size: number }[] = [];
    for await (const o of s3.list()) listed.push(o);
    expect(listed).toEqual(keys.map((k) => ({ key: k, size: k.length })));

    const old = new Date(Date.now() - 7 * 3600_000);
    fake.uploads.set('stale', { bucket: fake.bucket, key: `listing/${newBlobKey()}`, initiated: old, parts: new Map() });
    fake.uploads.set('fresh', { bucket: fake.bucket, key: `listing/${newBlobKey()}`, initiated: new Date(), parts: new Map() });
    fake.uploads.set('not-ours', { bucket: fake.bucket, key: 'elsewhere/big.iso', initiated: old, parts: new Map() });
    expect(await s3.sweepPartial(6 * 3600_000)).toBe(1);
    expect([...fake.uploads.keys()].sort()).toEqual(['fresh', 'not-ours']);
    fake.uploads.clear();
  });

  it("touches only a4a's own keys", async () => {
    const s3 = store();
    await expect(s3.read('../../etc/passwd')).rejects.toThrow(/Not a storage key/);
    await expect(s3.remove('ab/../../x')).rejects.toThrow(/Not a storage key/);
    expect(fake.requests).toEqual([]);
  });

  it('checks the bucket before the server starts, saying what to check', async () => {
    await expect(store().check()).resolves.toBeUndefined();
    await expect(store({ bucket: 'missing' }).check()).rejects.toThrow(/bucket missing at .* doesn't exist: create it, or set S3_BUCKET/);
    await expect(store({ credentials: { accessKeyId: 'wrong', secretAccessKey: 'x' } }).check()).rejects.toThrow(/refused a4a/);
  });
});

describe('S3 settings', () => {
  it('reads the bucket from S3_*, and says at once what is missing', () => {
    expect(s3FromEnv({})).toBeNull();
    expect(s3FromEnv({ S3_BUCKET: 'files' })).toEqual({ bucket: 'files', endpoint: undefined, region: 'us-east-1', prefix: '', forcePathStyle: false, credentials: null });
    expect(
      s3FromEnv({ S3_BUCKET: 'files', S3_ENDPOINT: 'http://minio:9000/', S3_REGION: 'auto', S3_PREFIX: '/a4a', S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: 'secret' }),
    ).toEqual({
      bucket: 'files',
      endpoint: 'http://minio:9000',
      region: 'auto',
      prefix: 'a4a/',
      forcePathStyle: true,
      credentials: { accessKeyId: 'id', secretAccessKey: 'secret' },
    });
    expect(s3FromEnv({ S3_BUCKET: 'files', S3_ENDPOINT: 'https://r2.example.com', S3_FORCE_PATH_STYLE: 'false' })?.forcePathStyle).toBe(false);
    expect(s3FromEnv({ S3_BUCKET: 'files', AWS_REGION: 'eu-central-1' })?.region).toBe('eu-central-1');
    expect(() => s3FromEnv({ S3_BUCKET: 'files', S3_ACCESS_KEY_ID: 'id' })).toThrow(/both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither/);
    expect(() => s3FromEnv({ S3_BUCKET: 'files', S3_ENDPOINT: 'minio:9000' })).toThrow(/isn't an address/);
  });
});
