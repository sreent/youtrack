import type { DiffLine } from '@a4a/shared';
import { t, tr } from '../../i18n';

const CONTEXT = 2;

type Row = DiffLine | { op: 'gap'; count: number };

/** Changed lines with a little of what's around them; long runs of the same, folded into one line. */
function rows(lines: DiffLine[]): Row[] {
  const keep = lines.map((l) => l.op !== 'same');
  lines.forEach((l, i) => {
    if (l.op === 'same') return;
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(lines.length - 1, i + CONTEXT); j++) keep[j] = true;
  });
  const out: Row[] = [];
  for (let i = 0; i < lines.length; ) {
    if (keep[i]) {
      out.push(lines[i]!);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && !keep[j]) j++;
    // A fold of one or two lines hides less than it says; show them.
    if (j - i <= 2) out.push(...lines.slice(i, j));
    else out.push({ op: 'gap', count: j - i });
    i = j;
  }
  return out;
}

/**
 * Ocean's diff (ArticlePage): a version's lines against the one before, each with its sign so it
 * reads without colour. Screen readers hear "Added" and "Removed" in place of the signs.
 */
export function Diff({ lines, label }: { lines: DiffLine[]; label: string }) {
  if (!lines.some((l) => l.op !== 'same')) return <p className="note">{t('articles.diff.theTextIsTheSame')}</p>;
  return (
    <ol className="diff" aria-label={label}>
      {rows(lines).map((r, i) =>
        r.op === 'gap' ? (
          <li key={i} className="gap">
            <span className="diff-sign" aria-hidden="true">
              ⋯
            </span>
            <span className="diff-text">{tr('articles.diff.linesTheSame', { count: r.count })}</span>
          </li>
        ) : r.op === 'add' ? (
          <li key={i} className="add">
            <span className="diff-sign" aria-hidden="true">
              +
            </span>
            <ins className="diff-text">
              <span className="hidden">{t('articles.diff.added')}</span>
              {r.text || ' '}
            </ins>
          </li>
        ) : r.op === 'del' ? (
          <li key={i} className="del">
            <span className="diff-sign" aria-hidden="true">
              −
            </span>
            <del className="diff-text">
              <span className="hidden">{t('articles.diff.removed')}</span>
              {r.text || ' '}
            </del>
          </li>
        ) : (
          <li key={i} className="same">
            <span className="diff-sign" aria-hidden="true">
              {' '}
            </span>
            <span className="diff-text">{r.text || ' '}</span>
          </li>
        ),
      )}
    </ol>
  );
}

/** "3 lines added, 1 removed". */
export function diffWords(lines: DiffLine[]): string {
  const added = lines.filter((l) => l.op === 'add').length;
  const removed = lines.filter((l) => l.op === 'del').length;
  const n = (k: number, what: string) => `${k} ${k === 1 ? 'line' : 'lines'} ${what}`;
  if (added && removed) return `${n(added, 'added')}, ${removed} removed`;
  if (added) return n(added, 'added');
  if (removed) return n(removed, 'removed');
  return 'no lines changed';
}
