import { describe, expect, it } from 'vitest';
import { CsvError, CsvParser, parseCsv, parseCsvStream, type CsvRecord } from '../../src/imports/csv';

/** Feed text in pieces of `size` characters, as a stream would cut it. */
function inPieces(text: string, size: number): CsvRecord[] {
  const out: CsvRecord[] = [];
  const p = new CsvParser((r) => out.push(r));
  for (let i = 0; i < text.length; i += size) p.push(text.slice(i, i + size));
  p.end();
  return out;
}

function stream(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, i + size));
      i += size;
    },
  });
}

// A Jira Cloud export, as it writes one: repeated columns, a quoted description over several
// lines with commas and doubled quotes, a comment in Jira's "date;author;text" form, CRLF.
const JIRA = [
  'Summary,Issue key,Issue id,Issue Type,Status,Priority,Assignee,Reporter,Created,Updated,Resolved,Labels,Labels,Description,Comment,Outward issue link (Blocks)',
  'Login fails on Safari,ABC-1,10001,Bug,In Progress,High,Anna Schmidt,Ben Okafor,12/Mar/24 2:15 PM,14/Mar/24 9:00 AM,,regression,sso,"Steps:\r\n1. Open Safari, sign in\r\n2. See ""blank page""",13/Mar/24 10:00 AM;ben;I can reproduce it,ABC-2',
  'Rotate keys,ABC-2,10002,Task,Done,Medium,,Anna Schmidt,01/Mar/24 9:00 AM,05/Mar/24 5:30 PM,05/Mar/24 5:30 PM,,,,,',
].join('\r\n');

describe('the CSV parser', () => {
  it('reads quotes, commas and line breaks inside fields, as RFC 4180 has them', () => {
    expect(parseCsv('a,"b,c","d ""e""",f\r\n1,"two\r\nlines",3,\r\n')).toEqual([
      ['a', 'b,c', 'd "e"', 'f'],
      ['1', 'two\nlines', '3', ''],
    ]);
  });

  it('drops a byte order mark, and takes LF, CR or CRLF to end a record', () => {
    expect(parseCsv('﻿Name,Key\nx,1\ry,2\r\nz,3')).toEqual([
      ['Name', 'Key'],
      ['x', '1'],
      ['y', '2'],
      ['z', '3'],
    ]);
  });

  it('gives the same records however the text is cut, even through a CRLF or a doubled quote', () => {
    const whole = parseCsv(JIRA);
    for (const size of [1, 2, 3, 7, 64]) expect(inPieces(JIRA, size).map((r) => r.cells)).toEqual(whole);
    expect(whole).toHaveLength(3);
    expect(whole[1]![13]).toBe('Steps:\n1. Open Safari, sign in\n2. See "blank page"');
    expect(whole[1]![11]).toBe('regression');
    expect(whole[1]![12]).toBe('sso');
  });

  it('says which line each record starts on, past fields that span lines', () => {
    const records = inPieces(JIRA, 5);
    expect(records.map((r) => [r.record, r.line])).toEqual([
      [1, 1],
      [2, 2],
      [3, 5],
    ]);
  });

  it('reads an empty file as no records, and skips blank lines', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('﻿')).toEqual([]);
    expect(parseCsv('a,b\n\n\nc,d\n\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    // A record of one empty quoted field is a record, not a blank line.
    expect(parseCsv('a\n""\n')).toEqual([['a'], ['']]);
  });

  it('is lenient where exports are sloppy', () => {
    expect(parseCsv('say "hi",x\n"quoted"tail,y')).toEqual([
      ['say "hi"', 'x'],
      ['quotedtail', 'y'],
    ]);
  });

  it('fails, saying where, on a quoted field that never closes or one past the limit', () => {
    expect(() => parseCsv('a,b\n1,"never closed\n2,3\n')).toThrow(/starts on line 2/);
    expect(() => parseCsv(`a\n"${'x'.repeat(50)}"`, { maxField: 10 })).toThrow(CsvError);
    expect(() => parseCsv('a,b,c,d', { maxColumns: 3 })).toThrow(/more than 3 fields/);
  });

  it('streams bytes, splitting UTF-8 characters across chunks, and counts what isn\'t UTF-8', async () => {
    const text = 'Name,Note\r\nChloé,"Ü, ß and 漢字"\r\n';
    const bytes = new TextEncoder().encode(text);
    const got: string[][] = [];
    const res = await parseCsvStream(stream(bytes, 3), async (rs) => {
      for (const r of rs) got.push(r.cells);
    });
    expect(got).toEqual([
      ['Name', 'Note'],
      ['Chloé', 'Ü, ß and 漢字'],
    ]);
    expect(res).toMatchObject({ bytes: bytes.length, replaced: 0, records: 2 });
    const latin1 = new Uint8Array([0x61, 0x0a, 0xe9, 0x0a]); // "a\né\n" in Latin-1
    const bad = await parseCsvStream(stream(latin1, 2), async () => {});
    expect(bad.replaced).toBe(1);
    await expect(parseCsvStream(stream(bytes, 4), async () => {}, { maxBytes: 8 })).rejects.toThrow(/larger than/);
  });

  it('keeps up with a large file', () => {
    const row = 'Fix the thing,ABC-1,"a description, with a comma\nand a line",Open\n';
    const big = `Summary,Key,Description,Status\n${row.repeat(50_000)}`;
    const start = Date.now();
    let n = 0;
    const p = new CsvParser(() => n++);
    for (let i = 0; i < big.length; i += 65_536) p.push(big.slice(i, i + 65_536));
    p.end();
    expect(n).toBe(50_001);
    expect(Date.now() - start).toBeLessThan(3000);
  });
});
