/**
 * CSV out, as RFC 4180 has it: fields quoted when they hold a comma, a quote or a line break, quotes
 * doubled, lines ended by CRLF, with a byte order mark so spreadsheets read it as UTF-8. Text that
 * a spreadsheet would run as a formula (=, +, -, @, a tab or a carriage return first) is prefixed
 * with an apostrophe, so an issue's summary can't become a formula on someone's machine.
 */

export type Cell = string | number | boolean | null | undefined;

export function csvCell(value: Cell, text = false): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : String(value);
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A whole file: the header, then each row. `text` names the columns people write, which get the formula guard. */
export function toCsv(header: string[], rows: Cell[][], text: Set<number> = new Set()): string {
  const lines = [header.map((h) => csvCell(h, true)).join(',')];
  for (const row of rows) lines.push(row.map((v, i) => csvCell(v, text.has(i))).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** A CSV download, named for what it holds. */
export function csvResponse(csv: string, fileName: string): Response {
  const safe = fileName.replace(/[^A-Za-z0-9._-]+/g, '-');
  return new Response(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${safe}"`,
      'cache-control': 'no-store',
    },
  });
}
