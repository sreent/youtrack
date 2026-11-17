import type { DiffLine } from '@a4a/shared';

/** Past this many lines added and removed, a diff says the text was replaced instead. */
const MAX_EDITS = 1000;

const same = (text: string): DiffLine => ({ op: 'same', text });
const add = (text: string): DiffLine => ({ op: 'add', text });
const del = (text: string): DiffLine => ({ op: 'del', text });

/**
 * Lines of `before` and `after`, in order: kept, removed and added (Myers' diff, the one
 * git uses by default). Lines common to both ends are set aside first, so an edit in a
 * long article costs what the edit is, not what the article is.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  // An empty text has no lines, rather than one empty line.
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return [...a.slice(0, start).map(same), ...myers(a.slice(start, endA), b.slice(start, endB)), ...a.slice(endA).map(same)];
}

function myers(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map(add);
  if (!m) return a.map(del);
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, offset);
    }
  }
  // Too different to say line by line: all of it went, and all of this came.
  return [...a.map(del), ...b.map(add)];
}

function backtrack(trace: Int32Array[], a: string[], b: string[], offset: number): DiffLine[] {
  const out: DiffLine[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : v[offset + prevK]!;
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push(same(a[x - 1]!));
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) out.push(add(b[y - 1]!));
      else out.push(del(a[x - 1]!));
    }
    x = prevX;
    y = prevY;
  }
  return out.reverse();
}

/** "3 lines added, 1 removed", for a change's line in history and in previews. */
export function diffStats(lines: DiffLine[]): { added: number; removed: number; words: string } {
  const added = lines.filter((l) => l.op === 'add').length;
  const removed = lines.filter((l) => l.op === 'del').length;
  const part = (n: number, what: string) => `${n} ${n === 1 ? 'line' : 'lines'} ${what}`;
  const words =
    added && removed
      ? `${part(added, 'added')}, ${removed} removed`
      : added
        ? part(added, 'added')
        : removed
          ? part(removed, 'removed')
          : 'no lines changed';
  return { added, removed, words };
}
