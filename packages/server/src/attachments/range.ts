/**
 * Part of a file, as a Range header asks (RFC 9110, 14): what a player sends to seek, and what
 * Safari needs before it plays a video at all.
 */

export type WantedRange = { start: number; end: number } | 'unsatisfiable' | null;

/**
 * The one byte range asked for, resolved against the file's size: null for the whole file (no
 * Range, one this server doesn't serve, such as several ranges at once, or an If-Range that isn't
 * the file's current ETag), or "unsatisfiable" for one that starts past its end.
 */
export function wantedRange(header: string | undefined, ifRange: string | undefined, etag: string, size: number): WantedRange {
  if (!header) return null;
  // Asked "if it's still this version": a date, a weak tag or another one gets the whole file.
  if (ifRange !== undefined && ifRange.trim() !== etag) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return null;
  const [, first = '', last = ''] = m;
  if (!first && !last) return null;
  if (!first) {
    // The last n bytes.
    const n = Number(last);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(first);
  const end = last ? Number(last) : size - 1;
  if (last && end < start) return null; // not a range: ignored, as the RFC asks
  if (start >= size) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}
