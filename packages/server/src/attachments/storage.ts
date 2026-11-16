/**
 * Where attachments' bytes live, behind one small interface. Local disk under
 * DATA_DIR/attachments is the store today; an S3-compatible one implements the same
 * three calls (docs/architecture.md, D14, says what that takes).
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

export interface BlobStorage {
  readonly kind: string;
  /**
   * Store the stream's bytes under `key`, reading it as it comes. Resolves once they're
   * durable; if the stream fails or is cut short, nothing is left under the key.
   */
  write(key: string, source: Readable): Promise<void>;
  /** The bytes under `key`, or those from `start` to `end`, both included. */
  read(key: string, range?: { start: number; end: number }): Promise<Readable>;
  /** Gone afterwards, whether or not it was there. */
  remove(key: string): Promise<void>;
  /** Clear what interrupted writes left behind, older than `olderThanMs`. Optional. */
  sweepPartial?(olderThanMs: number): Promise<number>;
}

const KEY = /^[0-9a-z]{2}\/[0-9a-z]{24}$/;

/** A new key: 24 random characters, under a folder named by the first two. */
export function newBlobKey(): string {
  const id = newId(24);
  return `${id.slice(0, 2)}/${id}`;
}

export class BlobNotFound extends Error {
  constructor(key: string) {
    super(`No stored file under ${key}`);
  }
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

/** The store this server keeps attachments in. */
export function attachmentStorage(app: AppServices): BlobStorage {
  let store = stores.get(app);
  if (!store) {
    store = new LocalDiskStorage(path.join(app.config.dataDir, 'attachments'));
    stores.set(app, store);
  }
  return store;
}

/** Use another store (tests, and the S3 store once there is one). */
export function setAttachmentStorage(app: AppServices, store: BlobStorage): void {
  stores.set(app, store);
}
