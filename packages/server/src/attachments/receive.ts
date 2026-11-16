/**
 * An upload as a stream: the one file in a multipart/form-data body, read as it
 * arrives, counted, hashed and sniffed on its way to storage. Nothing holds the whole
 * file in memory, and reading stops as soon as it's over the limit.
 */
import { createHash } from 'node:crypto';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import busboy from 'busboy';
import { AppError, badRequest } from '../lib/errors';
import { SNIFF_BYTES } from './sniff';

export interface IncomingFile {
  /** The name as the uploader gave it; make it safe before keeping it. */
  name: string;
  stream: Readable;
  /** Stop reading the request: the rest of it is not wanted. */
  abort(): void;
}

/** Room for the multipart framing around the file: boundaries, part headers, small fields. */
const FRAMING_BYTES = 64 * 1024;

export const tooLarge = (message: string, hint?: string) => new AppError(413, 'too_large', message, hint);

/**
 * The part named "file" of a multipart/form-data request, as soon as it starts. Other
 * parts are skipped; a second file is refused. Rejects before reading when the body
 * says it's longer than the limit allows.
 */
export function receiveFile(req: Request, opts: { maxBytes: number; tooLargeMessage: string }): Promise<IncomingFile> {
  const type = req.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data\s*;/i.test(type)) {
    return Promise.reject(badRequest('Send the file as multipart/form-data, in a part named "file"', 'With curl: curl -F file=@build.log …'));
  }
  const length = Number(req.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(length) && length > opts.maxBytes + FRAMING_BYTES) {
    return Promise.reject(tooLarge(opts.tooLargeMessage, 'Compress it, or split it into parts.'));
  }
  if (!req.body) return Promise.reject(badRequest('The request has no body', 'Send the file in a part named "file".'));

  return new Promise<IncomingFile>((resolve, reject) => {
    let parser: busboy.Busboy;
    try {
      parser = busboy({
        headers: { 'content-type': type },
        defParamCharset: 'utf8',
        limits: { files: 1, fileSize: opts.maxBytes + 1, fields: 10, fieldSize: 1024, parts: 20, headerPairs: 50 },
      });
    } catch {
      reject(badRequest('The multipart body has no boundary', 'Let your HTTP client build the multipart body.'));
      return;
    }
    const body = Readable.fromWeb(req.body as unknown as WebReadableStream<Uint8Array>);
    let file: Readable | null = null;
    let settled = false;
    const abort = () => {
      body.unpipe(parser);
      body.destroy();
    };
    parser.on('file', (field, stream, info) => {
      if (field !== 'file' || file) {
        stream.resume();
        return;
      }
      file = stream;
      settled = true;
      // Whoever takes the file reads it only after a few database round trips. If the client
      // goes away meanwhile, the error must not be left unhandled, which would end the
      // process. The stream keeps it as its error, so the pipeline that reads it still fails.
      stream.on('error', () => {});
      resolve({ name: info.filename ?? 'file', stream, abort });
    });
    parser.on('filesLimit', () => file?.destroy(badRequest('Send one file per request', 'Upload each file on its own.')));
    parser.on('error', (e: unknown) => {
      const err = badRequest(`The multipart body could not be read: ${e instanceof Error ? e.message : String(e)}`);
      if (!settled) {
        settled = true;
        reject(err);
      } else file?.destroy(err);
      abort();
    });
    parser.on('close', () => {
      if (!settled) {
        settled = true;
        reject(badRequest('No file in the request', 'Send the file in a part named "file".'));
      }
    });
    body.on('error', (e) => {
      // The client went away mid-upload.
      if (!settled) {
        settled = true;
        reject(badRequest(`The upload was cut short: ${e.message}`));
      } else file?.destroy(e);
    });
    body.pipe(parser);
  });
}

/**
 * Counts, hashes and keeps the first bytes of what passes through. Fails the stream the
 * moment it's over `maxBytes`, with the error `onTooLarge` makes.
 */
export class Inspector extends Transform {
  size = 0;
  private hash = createHash('sha256');
  private head: Buffer[] = [];
  private headLength = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly onTooLarge: () => Error,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.size += chunk.length;
    if (this.size > this.maxBytes) {
      done(this.onTooLarge());
      return;
    }
    this.hash.update(chunk);
    if (this.headLength < SNIFF_BYTES) {
      const part = Buffer.from(chunk.subarray(0, SNIFF_BYTES - this.headLength));
      this.head.push(part);
      this.headLength += part.length;
    }
    done(null, chunk);
  }

  /** The SHA-256 of everything that passed, in hex. Call once, at the end. */
  digest(): string {
    return this.hash.digest('hex');
  }

  /** The file's first bytes, for telling what it is. */
  firstBytes(): Buffer {
    return Buffer.concat(this.head);
  }
}
