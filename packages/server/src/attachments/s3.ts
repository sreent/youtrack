/**
 * Attachments in an S3-compatible bucket: S3 itself, MinIO, R2 and the like (docs/architecture.md,
 * D35). The same three calls as local disk:
 *
 * - write streams the upload on as it comes, as a multipart upload when it's larger than a part
 *   (lib-storage's Upload holds at most two parts in memory). The object appears only when the
 *   upload completes, so a failed or cut-short one leaves nothing under the key, and its parts
 *   are aborted.
 * - read is a GetObject, with its Range when a part is asked for.
 * - remove is a DeleteObject, which answers the same whether or not the object was there.
 *
 * Downloads still come through a4a, which checks who may see a file and sends the headers that
 * keep it from running (D18): the bucket is never handed out.
 *
 * The SDK is loaded when the store is first used, so a server on local disk never loads it.
 */
import { PassThrough, pipeline, type Readable } from 'node:stream';
import type { ListObjectsV2CommandOutput, S3Client } from '@aws-sdk/client-s3';
import type { S3Config } from '../config';
import { BlobNotFound, KEY, StorageUnavailable, type BlobStorage } from './blob';

/** S3's smallest part but the last: 5 MiB. Two of them in flight keep an upload's memory near 10 MiB. */
const PART_SIZE = 5 * 1024 * 1024;
const PARTS_IN_FLIGHT = 2;

type Sdk = typeof import('@aws-sdk/client-s3');
type Lib = typeof import('@aws-sdk/lib-storage');

interface Loaded {
  sdk: Sdk;
  lib: Lib;
  client: S3Client;
}

/** What went wrong at the store, in words for the server's log: which bucket, where, and what to check. */
function describe(config: S3Config, e: unknown): string {
  const where = `bucket ${config.bucket}${config.endpoint ? ` at ${config.endpoint}` : ''}`;
  const err = e as { name?: string; message?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  const status = err.$metadata?.httpStatusCode;
  const name = err.name ?? 'Error';
  if (name === 'NoSuchBucket' || (name === 'NotFound' && status === 404)) return `The ${where} doesn't exist: create it, or set S3_BUCKET to one that does`;
  if (['AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'Forbidden', 'ExpiredToken', 'InvalidToken'].includes(name) || status === 403) {
    return `The ${where} refused a4a (${name}): check S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or what the machine's role may do there`;
  }
  if (name === 'CredentialsProviderError') return `a4a has no keys for the ${where}: set S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or give the machine a role (${err.message ?? ''})`;
  const code = err.code ?? (e as { cause?: { code?: string } })?.cause?.code;
  if (code && /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)$/.test(code)) {
    return `a4a can't reach the ${where} (${code}): check S3_ENDPOINT and the network`;
  }
  return `The ${where} failed${status ? ` (${status})` : ''}: ${name}${err.message && err.message !== name ? `, ${err.message}` : ''}`;
}

const isMissing = (e: unknown) => {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return err.name === 'NoSuchKey' || (err.name === 'NotFound' && err.$metadata?.httpStatusCode === 404);
};

export class S3Storage implements BlobStorage {
  readonly kind = 's3';
  private loaded: Promise<Loaded> | null = null;

  constructor(
    readonly config: S3Config,
    private readonly options: { maxAttempts?: number } = {},
  ) {}

  /** Where it is, for people: "s3://files/a4a/" or "files/a4a/ at http://minio:9000". */
  get where(): string {
    return this.config.endpoint ? `${this.config.bucket}/${this.config.prefix} at ${this.config.endpoint}` : `s3://${this.config.bucket}/${this.config.prefix}`;
  }

  private load(): Promise<Loaded> {
    this.loaded ??= (async () => {
      const [sdk, lib] = await Promise.all([import('@aws-sdk/client-s3'), import('@aws-sdk/lib-storage')]);
      const { config } = this;
      const client = new sdk.S3Client({
        region: config.region,
        endpoint: config.endpoint,
        forcePathStyle: config.forcePathStyle,
        ...(config.credentials ? { credentials: config.credentials } : {}),
        maxAttempts: this.options.maxAttempts ?? 3,
        // Stores other than AWS don't all take the checksums the SDK adds by default (aws-chunked
        // bodies with trailers): send them only where an operation needs one. TLS keeps the bytes
        // whole on their way, and the copy command reads each file back to check it.
        ...(config.endpoint ? { requestChecksumCalculation: 'WHEN_REQUIRED' as const, responseChecksumValidation: 'WHEN_REQUIRED' as const } : {}),
      });
      return { sdk, lib, client };
    })();
    return this.loaded;
  }

  /** The object's name in the bucket: the prefix, then a4a's key. */
  objectKey(key: string): string {
    // Keys are ours, but check anyway: nothing outside the prefix is ever touched.
    if (!KEY.test(key)) throw new Error(`Not a storage key: ${JSON.stringify(key)}`);
    return `${this.config.prefix}${key}`;
  }

  private unavailable(e: unknown): StorageUnavailable {
    return new StorageUnavailable(describe(this.config, e), { cause: e });
  }

  async write(key: string, source: Readable): Promise<void> {
    const Key = this.objectKey(key);
    // An error of the source's own (the file over its limit, the client gone) is the caller's
    // to report, as it is; anything else came from the store.
    let sourceError: unknown = null;
    const noteError = (e: unknown) => {
      sourceError ??= e;
    };
    source.once('error', noteError);
    let loaded: Loaded;
    try {
      loaded = await this.load();
    } catch (e) {
      source.destroy();
      throw this.unavailable(e);
    }
    // lib-storage takes a body's length from its size, length or byteLength, if it has one, and
    // then expects that many parts: a stream that counts what passed (`size`) would mislead it.
    // A plain stream between has none, so the length is what arrives. Its source's error ends it.
    const body = new PassThrough();
    pipeline(source, body, () => {});
    const upload = new loaded.lib.Upload({
      client: loaded.client,
      params: { Bucket: this.config.bucket, Key, Body: body, ContentType: 'application/octet-stream' },
      partSize: PART_SIZE,
      queueSize: PARTS_IN_FLIGHT,
      leavePartsOnError: false,
    });
    try {
      await upload.done();
    } catch (e) {
      // Stop reading what's left of the source, as local disk's pipeline does, so the request
      // behind it stops too.
      if (!source.destroyed) source.destroy();
      if (sourceError) throw sourceError;
      throw this.unavailable(e);
    } finally {
      source.off('error', noteError);
    }
  }

  async read(key: string, range?: { start: number; end: number }): Promise<Readable> {
    const Key = this.objectKey(key);
    try {
      const { sdk, client } = await this.load();
      const out = await client.send(new sdk.GetObjectCommand({ Bucket: this.config.bucket, Key, ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) }));
      return out.Body as Readable;
    } catch (e) {
      if (isMissing(e)) throw new BlobNotFound(key);
      throw this.unavailable(e);
    }
  }

  async remove(key: string): Promise<void> {
    const Key = this.objectKey(key);
    try {
      const { sdk, client } = await this.load();
      await client.send(new sdk.DeleteObjectCommand({ Bucket: this.config.bucket, Key }));
    } catch (e) {
      if (isMissing(e)) return;
      throw this.unavailable(e);
    }
  }

  /**
   * Multipart uploads under the prefix begun before the cut-off and never finished: what a
   * crash mid-upload leaves, as part files are on disk. Aborting one frees its parts.
   */
  async sweepPartial(olderThanMs: number): Promise<number> {
    const { sdk, client } = await this.load();
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    try {
      for (;;) {
        const page = await client.send(
          new sdk.ListMultipartUploadsCommand({ Bucket: this.config.bucket, Prefix: this.config.prefix || undefined, KeyMarker: keyMarker, UploadIdMarker: uploadIdMarker }),
        );
        for (const u of page.Uploads ?? []) {
          if (!u.Key || !u.UploadId || !u.Initiated || u.Initiated.getTime() >= cutoff) continue;
          if (!KEY.test(u.Key.slice(this.config.prefix.length))) continue; // not one of a4a's
          await client.send(new sdk.AbortMultipartUploadCommand({ Bucket: this.config.bucket, Key: u.Key, UploadId: u.UploadId }));
          removed++;
        }
        if (!page.IsTruncated) break;
        keyMarker = page.NextKeyMarker;
        uploadIdMarker = page.NextUploadIdMarker;
      }
    } catch (e) {
      throw this.unavailable(e);
    }
    return removed;
  }

  /** a4a's keys in the bucket, with each object's size: what the copy command needn't send again. */
  async *list(): AsyncGenerator<{ key: string; size: number }> {
    const { sdk, client } = await this.load();
    let token: string | undefined;
    for (;;) {
      let page: ListObjectsV2CommandOutput;
      try {
        page = await client.send(new sdk.ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: this.config.prefix || undefined, ContinuationToken: token }));
      } catch (e) {
        throw this.unavailable(e);
      }
      for (const o of page.Contents ?? []) {
        const key = o.Key?.slice(this.config.prefix.length);
        if (key && KEY.test(key)) yield { key, size: o.Size ?? 0 };
      }
      if (!page.IsTruncated) return;
      token = page.NextContinuationToken;
    }
  }

  /** The bucket answers, and lets a4a in; otherwise what to check, as an error. */
  async check(): Promise<void> {
    try {
      const { sdk, client } = await this.load();
      await client.send(new sdk.HeadBucketCommand({ Bucket: this.config.bucket }));
    } catch (e) {
      throw this.unavailable(e);
    }
  }
}
