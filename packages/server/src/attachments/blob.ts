/**
 * What every store of attachments' bytes is (storage.ts and s3.ts), and how one fails.
 */
import type { Readable } from 'node:stream';

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

/** A storage key: two characters, a slash, and the 24 random ones they start. */
export const KEY = /^[0-9a-z]{2}\/[0-9a-z]{24}$/;

export class BlobNotFound extends Error {
  constructor(key: string) {
    super(`No stored file under ${key}`);
  }
}

/**
 * The store itself failed: unreachable, refusing a4a's credentials, its bucket gone. Not the
 * person's doing, so it answers 503 and its words go to the server's log, not to them.
 */
export class StorageUnavailable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageUnavailable';
  }
}
