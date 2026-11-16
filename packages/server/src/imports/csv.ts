/**
 * CSV in, as RFC 4180 has it, and as Jira and YouTrack write it: fields separated by commas, a
 * field in double quotes may hold commas, line breaks and quotes (doubled), and records end with
 * CRLF, LF or CR. A byte order mark at the start is dropped. It streams: text goes in by the
 * chunk, as it arrives, and each record comes out as soon as it's complete, so a large file is
 * never held whole. Line breaks inside a field come out as LF.
 *
 * It is lenient where exports are sloppy (a quote inside an unquoted field is kept as it is, and
 * text after a closing quote joins the field) and strict where guessing would lose data: a file
 * that ends inside a quoted field, or a field past the size limit, is an error that says where.
 */

export class CsvError extends Error {
  constructor(
    message: string,
    public readonly line: number,
  ) {
    super(message);
  }
}

export interface CsvOptions {
  /** Longest field, in characters. */
  maxField?: number;
  /** Most fields in a record. */
  maxColumns?: number;
}

export interface CsvRecord {
  cells: string[];
  /** The line it starts on, counting from 1. */
  line: number;
  /** Which record it is, counting from 1 (the header is record 1). */
  record: number;
}

export class CsvParser {
  private field = '';
  private cells: string[] = [];
  /** Inside a quoted field. */
  private quoted = false;
  /** Just read a quote inside a quoted field: either its end, or the first of a doubled quote. */
  private quoteHeld = false;
  /** The last chunk ended on CR: an LF first in the next one is the rest of that line break. */
  private cr = false;
  /** Something of the current field has been read, so a quote now is just a character. */
  private touched = false;
  /** Something of the current record has been read. */
  private started = false;
  private first = true;
  private line = 1;
  private recordLine = 1;
  private quoteLine = 1;
  private records = 0;
  private readonly maxField: number;
  private readonly maxColumns: number;

  constructor(
    private readonly onRecord: (r: CsvRecord) => void,
    opts: CsvOptions = {},
  ) {
    this.maxField = opts.maxField ?? 1_000_000;
    this.maxColumns = opts.maxColumns ?? 1000;
  }

  push(chunk: string): void {
    const n = chunk.length;
    let i = 0;
    if (this.first && n) {
      this.first = false;
      if (chunk.charCodeAt(0) === 0xfeff) i = 1;
    }
    while (i < n) {
      const ch = chunk[i]!;
      if (this.cr) {
        this.cr = false;
        if (ch === '\n') {
          i++;
          continue;
        }
      }
      if (this.quoted) {
        if (this.quoteHeld) {
          this.quoteHeld = false;
          if (ch === '"') {
            this.field += '"';
            i++;
            continue;
          }
          this.quoted = false; // that quote closed the field: read this character outside it
          continue;
        }
        if (ch === '"') {
          this.quoteHeld = true;
          i++;
        } else if (ch === '\r' || ch === '\n') {
          this.field += '\n';
          this.line++;
          i = this.skipLineFeed(chunk, i, ch);
        } else {
          let j = i + 1;
          while (j < n && chunk[j] !== '"' && chunk[j] !== '\r' && chunk[j] !== '\n') j++;
          this.field += chunk.slice(i, j);
          this.checkSize();
          i = j;
        }
        continue;
      }
      if (ch === ',') {
        this.endField();
        this.started = true;
        i++;
      } else if (ch === '\r' || ch === '\n') {
        this.endRecord();
        this.line++;
        this.recordLine = this.line;
        i = this.skipLineFeed(chunk, i, ch);
      } else if (ch === '"' && !this.touched) {
        this.quoted = true;
        this.touched = true;
        this.started = true;
        this.quoteLine = this.line;
        i++;
      } else {
        let j = i + 1;
        while (j < n && chunk[j] !== ',' && chunk[j] !== '\r' && chunk[j] !== '\n') j++;
        this.field += chunk.slice(i, j);
        this.touched = true;
        this.started = true;
        this.checkSize();
        i = j;
      }
    }
  }

  /** The input is complete: emit the last record, or fail if a quoted field never closed. */
  end(): void {
    if (this.quoted && !this.quoteHeld) {
      throw new CsvError(`The file ends inside a quoted field that starts on line ${this.quoteLine}`, this.quoteLine);
    }
    this.quoted = false;
    this.quoteHeld = false;
    this.endRecord();
  }

  get count(): number {
    return this.records;
  }

  /** After a CR or LF at `i`: past a CRLF's LF, or remember a CR that ends the chunk. */
  private skipLineFeed(chunk: string, i: number, ch: string): number {
    if (ch === '\r') {
      if (i + 1 < chunk.length) return chunk[i + 1] === '\n' ? i + 2 : i + 1;
      this.cr = true;
    }
    return i + 1;
  }

  private checkSize(): void {
    if (this.field.length > this.maxField) {
      throw new CsvError(`A field on line ${this.recordLine} is longer than ${this.maxField.toLocaleString('en')} characters`, this.recordLine);
    }
  }

  private endField(): void {
    this.cells.push(this.field);
    this.field = '';
    this.touched = false;
    if (this.cells.length > this.maxColumns) {
      throw new CsvError(`Line ${this.recordLine} has more than ${this.maxColumns} fields`, this.recordLine);
    }
  }

  private endRecord(): void {
    // A line with nothing on it is not a record (exports end with one).
    if (this.started || this.field !== '' || this.cells.length) {
      this.endField();
      this.records++;
      this.onRecord({ cells: this.cells, line: this.recordLine, record: this.records });
    }
    this.cells = [];
    this.field = '';
    this.touched = false;
    this.started = false;
  }
}

/** Parse a whole string (tests, small files). */
export function parseCsv(text: string, opts?: CsvOptions): string[][] {
  const out: string[][] = [];
  const p = new CsvParser((r) => out.push(r.cells), opts);
  p.push(text);
  p.end();
  return out;
}

/**
 * Parse a byte stream as UTF-8, record by record. `onRecords` is awaited before the next chunk is
 * read, so writing rows to the database paces the upload and memory stays flat. Stops with an
 * error past `maxBytes`. Says how many bytes were read and how many characters weren't UTF-8.
 */
export async function parseCsvStream(
  stream: ReadableStream<Uint8Array>,
  onRecords: (records: CsvRecord[]) => Promise<void>,
  opts: CsvOptions & { maxBytes?: number } = {},
): Promise<{ bytes: number; replaced: number; records: number }> {
  const maxBytes = opts.maxBytes ?? 64 * 1024 * 1024;
  const decoder = new TextDecoder('utf-8');
  let pending: CsvRecord[] = [];
  const parser = new CsvParser((r) => pending.push(r), opts);
  let bytes = 0;
  let replaced = 0;
  const reader = stream.getReader();
  const flush = async () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    await onRecords(batch);
  };
  const count = (text: string) => {
    for (let i = text.indexOf('�'); i >= 0; i = text.indexOf('�', i + 1)) replaced++;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new CsvError(`The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`, 0);
      const text = decoder.decode(value, { stream: true });
      count(text);
      parser.push(text);
      await flush();
    }
    const tail = decoder.decode();
    count(tail);
    if (tail) parser.push(tail);
    parser.end();
    await flush();
  } finally {
    reader.releaseLock();
  }
  return { bytes, replaced, records: parser.count };
}
