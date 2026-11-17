/**
 * Where attachments' bytes live, behind one small interface: local disk under
 * DATA_DIR/attachments, or an S3-compatible bucket (s3.ts; docs/architecture.md, D18
 * and D35).
 *
 * Keys are a4a's own (a random id, sharded by its first two characters), never a
 * file's name, so nothing a person uploads decides where it's written.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AppServices } from '../context';
import { newId } from '../lib/ids';
import { BlobNotFound, KEY, type BlobStorage } from './blob';
import { S3Storage } from './s3';

export { BlobNotFound, KEY, StorageUnavailable, type BlobStorage } from './blob';

/** A new key: 24 random characters, under a folder named by the first two. */
export function newBlobKey(): string {
  const id = newId(24);
  return `${id.slice(0, 2)}/${id}`;
}

/**
 * Files under a root folder. A write goes to a part file in `.tmp`, is flushed to disk,
 * and only then renamed into place, so a crash never leaves half a file under a key.
 */
export class LocalDiskStorage implements BlobStorage {
  readonly kind = 'local';

  constructor(readonly root: string) {}

  private file(key: string): string {
    // Keys are ours, but check anyway: nothing outside the root is ever touched.
    if (!KEY.test(key)) throw new Error(`Not a storage key: ${JSON.stringify(key)}`);
    const [shard, id] = key.split('/');
    return path.join(this.root, shard!, id!);
  }

  async write(key: string, source: Readable): Promise<void> {
    const final = this.file(key);
    const tmpDir = path.join(this.root, '.tmp');
    await mkdir(tmpDir, { recursive: true });
    await mkdir(path.dirname(final), { recursive: true });
    const tmp = path.join(tmpDir, `${key.replace('/', '-')}.${newId(6)}.part`);
    try {
      await pipeline(source, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
      // On disk before anything points at it: a sync of the file, through a new descriptor.
      const handle = await open(tmp, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    await rename(tmp, final);
  }

  async read(key: string, range?: { start: number; end: number }): Promise<Readable> {
    const file = this.file(key);
    try {
      await stat(file);
    } catch {
      throw new BlobNotFound(key);
    }
    return createReadStream(file, range ? { start: range.start, end: range.end } : undefined);
  }

  async remove(key: string): Promise<void> {
    await rm(this.file(key), { force: true });
  }

  async sweepPartial(olderThanMs: number): Promise<number> {
    const tmpDir = path.join(this.root, '.tmp');
    let names: string[];
    try {
      names = await readdir(tmpDir);
    } catch {
      return 0;
    }
    let removed = 0;
    const cutoff = Date.now() - olderThanMs;
    for (const name of names) {
      if (!name.endsWith('.part')) continue;
      const p = path.join(tmpDir, name);
      const info = await stat(p).catch(() => null);
      if (info && info.mtimeMs < cutoff) {
        await rm(p, { force: true });
        removed++;
      }
    }
    return removed;
  }
}

const stores = new WeakMap<AppServices, BlobStorage>();

/** The folder local disk keeps files in, which the copy to S3 reads from. */
export function localAttachmentsDir(dataDir: string): string {
  return path.join(dataDir, 'attachments');
}

/** The store this server keeps attachments in: ATTACHMENT_STORAGE's. */
export function attachmentStorage(app: AppServices): BlobStorage {
  let store = stores.get(app);
  if (!store) {
    const { attachmentStorage: kind, s3, dataDir } = app.config;
    store = kind === 's3' && s3 ? new S3Storage(s3) : new LocalDiskStorage(localAttachmentsDir(dataDir));
    stores.set(app, store);
  }
  return store;
}

/** Use another store (tests). */
export function setAttachmentStorage(app: AppServices, store: BlobStorage): void {
  stores.set(app, store);
}

/**
 * Before the server takes requests: a bucket that can't be reached, or refuses a4a, stops it
 * with what to check, rather than failing every upload later. Local disk needs nothing.
 */
export async function checkAttachmentStorage(app: AppServices): Promise<void> {
  const store = attachmentStorage(app);
  if (store instanceof S3Storage) await store.check();
}
