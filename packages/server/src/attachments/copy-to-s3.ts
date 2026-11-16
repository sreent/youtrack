/**
 * Moving files from local disk to an S3-compatible bucket (docs/architecture.md, D35): every file
 * a4a keeps, each copy verified against the checksum taken when it was uploaded, and resumable.
 *
 * - Each file is read from disk, hashed on its way up, and its copy read back from the bucket and
 *   hashed again. Only a copy whose SHA-256 is the one on record counts; a file on disk that
 *   doesn't match its own checksum is reported and not copied.
 * - A verified copy is written down in a manifest beside the files (one key and checksum a line).
 *   A run that stops, however it stops, is run again: files in the manifest and in the bucket are
 *   skipped; files in the bucket but not in the manifest (in flight when it stopped) are read back,
 *   and copied again if they don't match; the rest are copied.
 * - The bucket failing stops the run: it would fail every file after. Run it again once it answers.
 *
 * It never deletes anything from disk: once the server runs on the bucket, the folder can go.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline, Transform, type Readable } from 'node:stream';
import type { Db } from '../db/client';
import { attachments } from '../db/schema';
import { BlobNotFound, StorageUnavailable, type BlobStorage } from './blob';
import type { S3Storage } from './s3';
import { formatBytes } from './sniff';

export interface CopyFailure {
  key: string;
  name: string;
  why: string;
}

export interface CopyReport {
  files: number;
  bytes: number;
  /** In the bucket and in the manifest: verified by an earlier run. */
  already: number;
  /** Copied and verified by this run. */
  copied: number;
  copiedBytes: number;
  /** In the bucket but not in the manifest: read back, found whole, and written down. */
  checked: number;
  /** What a dry run would copy, and check. */
  toCopy: number;
  toCheck: number;
  failed: CopyFailure[];
  /** Why the run stopped before the end: the bucket failed. */
  stopped: string | null;
}

export interface CopyOptions {
  /** Where verified copies are written down, so a rerun skips them. */
  manifest: string;
  /** Files copied at once (4). */
  concurrency?: number;
  /** Count what would be copied and checked; copy nothing. */
  dryRun?: boolean;
  /** Read back every file already in the bucket, manifest or not. */
  verifyAll?: boolean;
  log?: (line: string) => void;
}

interface Row {
  key: string;
  sha256: string;
  size: number;
  name: string;
}

const LINE = /^([0-9a-z]{2}\/[0-9a-z]{24}) ([0-9a-f]{64})$/;

/** The manifest's file for a bucket: one per destination, so copying to a second bucket starts afresh. */
export function manifestFor(folder: string, s3: Pick<S3Storage['config'], 'endpoint' | 'bucket' | 'prefix'>): string {
  const id = createHash('sha256').update(`${s3.endpoint ?? 'aws'}|${s3.bucket}|${s3.prefix}`).digest('hex').slice(0, 10);
  return path.join(folder, `.copied-to-s3-${id}`);
}

async function readManifest(file: string): Promise<Map<string, string>> {
  const done = new Map<string, string>();
  const text = await readFile(file, 'utf8').catch(() => '');
  // A line cut short by a crash doesn't match, and its file is checked again.
  for (const line of text.split('\n')) {
    const m = LINE.exec(line.trim());
    if (m) done.set(m[1]!, m[2]!);
  }
  return done;
}

async function hashOf(stream: Readable): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: hash.digest('hex'), size };
}

/** Runs `work` over `items`, `n` at a time, until each is done or one throws. */
async function pool<T>(items: T[], n: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  const lane = async () => {
    while (failure === null && next < items.length) {
      const item = items[next++]!;
      try {
        await work(item);
      } catch (e) {
        failure ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, lane));
  if (failure !== null) throw failure;
}

export async function copyFilesToS3(db: Db, from: BlobStorage, to: S3Storage, opts: CopyOptions): Promise<CopyReport> {
  const log = opts.log ?? (() => {});
  const found = await db
    .select({ key: attachments.blobKey, sha256: attachments.sha256, size: attachments.size, name: attachments.name })
    .from(attachments)
    .orderBy(attachments.blobKey);
  const rows = [...new Map(found.map((r) => [r.key, r])).values()];
  const report: CopyReport = {
    files: rows.length,
    bytes: rows.reduce((n, r) => n + r.size, 0),
    already: 0,
    copied: 0,
    copiedBytes: 0,
    checked: 0,
    toCopy: 0,
    toCheck: 0,
    failed: [],
    stopped: null,
  };

  const done = await readManifest(opts.manifest);
  const there = new Map<string, number>();
  for await (const o of to.list()) there.set(o.key, o.size);

  const work: { row: Row; check: boolean }[] = [];
  for (const row of rows) {
    const size = there.get(row.key);
    if (size === undefined) work.push({ row, check: false });
    else if (size === row.size && done.get(row.key) === row.sha256 && !opts.verifyAll) report.already++;
    else work.push({ row, check: true });
  }
  report.toCopy = work.filter((w) => !w.check).length;
  report.toCheck = work.length - report.toCopy;
  const workBytes = work.reduce((n, w) => n + w.row.size, 0);
  log(
    `${rows.length} ${rows.length === 1 ? 'file' : 'files'} (${formatBytes(report.bytes)}) for ${to.where}: ${report.already} already there and verified, ` +
      `${report.toCopy} to copy, ${report.toCheck} there to check.`,
  );
  if (opts.dryRun || !work.length) return report;

  await mkdir(path.dirname(opts.manifest), { recursive: true });
  const verified = async (row: Row) => {
    await appendFile(opts.manifest, `${row.key} ${row.sha256}\n`);
  };
  const fail = (row: Row, why: string) => {
    report.failed.push({ key: row.key, name: row.name, why });
    log(`  not copied: ${row.name} (${row.key}): ${why}`);
  };

  const copy = async (row: Row) => {
    let source: Readable;
    try {
      source = await from.read(row.key);
    } catch (e) {
      if (e instanceof BlobNotFound) return fail(row, 'its file is missing from disk');
      return fail(row, `its file on disk can't be read: ${e instanceof Error ? e.message : String(e)}`);
    }
    const hash = createHash('sha256');
    let size = 0;
    const counted = pipeline(
      source,
      new Transform({
        transform(chunk: Buffer, _enc, next) {
          hash.update(chunk);
          size += chunk.length;
          next(null, chunk);
        },
      }),
      () => {},
    );
    try {
      await to.write(row.key, counted);
    } catch (e) {
      if (e instanceof StorageUnavailable) throw e;
      return fail(row, `its file on disk couldn't be read to the end: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (hash.digest('hex') !== row.sha256 || size !== row.size) {
      await to.remove(row.key);
      return fail(row, "its file on disk doesn't match the checksum taken when it was uploaded");
    }
    let back: { sha256: string };
    try {
      back = await hashOf(await to.read(row.key));
    } catch (e) {
      if (e instanceof BlobNotFound) return fail(row, 'its copy was gone from the bucket when read back; run the command again');
      throw e;
    }
    if (back.sha256 !== row.sha256) {
      await to.remove(row.key);
      return fail(row, "its copy in the bucket didn't read back the same; run the command again");
    }
    await verified(row);
    report.copied++;
    report.copiedBytes += row.size;
  };

  let finished = 0;
  let finishedBytes = 0;
  let said = Date.now();
  try {
    await pool(work, opts.concurrency ?? 4, async ({ row, check }) => {
      if (check) {
        let whole = false;
        try {
          whole = (await hashOf(await to.read(row.key))).sha256 === row.sha256;
        } catch (e) {
          if (!(e instanceof BlobNotFound)) throw e;
        }
        if (whole) {
          await verified(row);
          report.checked++;
        } else await copy(row);
      } else await copy(row);
      finished++;
      finishedBytes += row.size;
      if (Date.now() - said > 5000 || finished === work.length) {
        said = Date.now();
        log(`  ${finished} of ${work.length} (${formatBytes(finishedBytes)} of ${formatBytes(workBytes)})`);
      }
    });
  } catch (e) {
    if (!(e instanceof StorageUnavailable)) throw e;
    report.stopped = e.message;
    log(`Stopped: ${e.message}. Run it again once the bucket answers: it carries on where it stopped.`);
  }
  return report;
}
