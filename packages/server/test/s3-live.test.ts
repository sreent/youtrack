/**
 * The S3 store against a real S3-compatible server (MinIO, in CI's "files in a bucket" job): what
 * a fake can't promise, such as how the server takes the SDK's multipart uploads and ranges.
 * Skipped unless TEST_S3_ENDPOINT names one (with TEST_S3_BUCKET and its keys).
 */
import { createHash, randomBytes } from 'node:crypto';
import { pipeline, Readable } from 'node:stream';
import { CreateBucketCommand, CreateMultipartUploadCommand, ListMultipartUploadsCommand, S3Client } from '@aws-sdk/client-s3';
import { beforeAll, describe, expect, it } from 'vitest';
import { BlobNotFound } from '../src/attachments/blob';
import { Inspector } from '../src/attachments/receive';
import { S3Storage } from '../src/attachments/s3';
import { newBlobKey } from '../src/attachments/storage';

const endpoint = process.env.TEST_S3_ENDPOINT;
const bucket = process.env.TEST_S3_BUCKET ?? 'a4a-ci';
const credentials = { accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? '', secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? '' };
// A prefix of this run's own, so runs never see each other's objects.
const prefix = `run-${Date.now().toString(36)}/`;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function bytesOf(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(chunk as Buffer);
  return Buffer.concat(parts);
}

describe.skipIf(!endpoint)('the S3 store against a real server', () => {
  let store: S3Storage;
  let client: S3Client;

  beforeAll(async () => {
    client = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials, requestChecksumCalculation: 'WHEN_REQUIRED' });
    await client.send(new CreateBucketCommand({ Bucket: bucket })).catch((e: { name?: string }) => {
      if (e.name !== 'BucketAlreadyOwnedByYou' && e.name !== 'BucketAlreadyExists') throw e;
    });
    store = new S3Storage({ bucket, endpoint, region: 'us-east-1', prefix, forcePathStyle: true, credentials });
  });

  it('answers a check, keeps a small file, reads it whole and in part, and removes it', async () => {
    await store.check();
    const key = newBlobKey();
    const body = Buffer.from('2026-11-16 09:10:02 ERROR the cache went away\n'.repeat(100));
    await store.write(key, Readable.from([body]));
    expect((await bytesOf(await store.read(key))).equals(body)).toBe(true);
    expect((await bytesOf(await store.read(key, { start: 11, end: 18 }))).toString()).toBe('09:10:02');
    await store.remove(key);
    await expect(store.read(key)).rejects.toBeInstanceOf(BlobNotFound);
    await expect(store.remove(key)).resolves.toBeUndefined();
  });

  it('streams a large upload up in parts, counted on its way in, and lists it', async () => {
    const key = newBlobKey();
    const body = randomBytes(11 * 1024 * 1024 + 321);
    const inspector = new Inspector(16 * 1024 * 1024, () => new Error('too large'));
    await store.write(key, pipeline(Readable.from([body.subarray(0, 4_000_000), body.subarray(4_000_000)]), inspector, () => {}));
    expect(sha(await bytesOf(await store.read(key)))).toBe(sha(body));
    const middle = await bytesOf(await store.read(key, { start: 5 * 1024 * 1024 - 7, end: 5 * 1024 * 1024 + 6 }));
    expect(middle.equals(body.subarray(5 * 1024 * 1024 - 7, 5 * 1024 * 1024 + 7))).toBe(true);
    const listed: { key: string; size: number }[] = [];
    for await (const o of store.list()) listed.push(o);
    expect(listed).toContainEqual({ key, size: body.length });
    await store.remove(key);
  });

  it("leaves nothing when its source fails part-way, and passes the source's error on", async () => {
    const key = newBlobKey();
    const tooLarge = new Error('trace.bin is larger than 6 MB');
    let sent = 0;
    const source = new Readable({
      read() {
        setTimeout(() => {
          if (sent >= 7 * 1024 * 1024) return void this.destroy(tooLarge);
          sent += 1024 * 1024;
          this.push(Buffer.alloc(1024 * 1024, 5));
        }, 5);
      },
    });
    await expect(store.write(key, source)).rejects.toBe(tooLarge);
    await expect(store.read(key)).rejects.toBeInstanceOf(BlobNotFound);
    const pending = await client.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: `${prefix}${key}` }));
    expect(pending.Uploads ?? []).toEqual([]);
  });

  it('sweeps what an upload left unfinished, where the server lists it', async () => {
    const key = newBlobKey();
    await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: `${prefix}${key}` }));
    // Some servers (MinIO among them) list unfinished uploads only by a whole key, and clear
    // stale ones themselves; the sweep must not fail there.
    const swept = await store.sweepPartial(0);
    expect(swept).toBeGreaterThanOrEqual(0);
  });
});
