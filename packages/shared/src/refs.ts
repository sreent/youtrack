/**
 * Readable ids in running text: issues (`BACK-12`) and knowledge base articles (`BACK-A-3`).
 * One reading for everyone, so the web app's links and the server's mentions agree.
 *
 * An article's id puts the letter A between the project key and its number. An issue's id
 * never has a third part, and a project key is at least two characters, so neither can be
 * read as the other: `BACK-A-3` is no issue (`A` can't be a key), and `BACK-12` is no article.
 */

export type RefKind = 'issue' | 'article';

export interface TextRef {
  kind: RefKind;
  /** As written: `BACK-12`, `BACK-A-3`. */
  id: string;
  key: string;
  number: number;
  start: number;
  end: number;
}

/** Keys as projects have them (2 to 10 characters), written in capitals, as ids are quoted. */
const REF = /\b([A-Z][A-Z0-9]{1,9})-(A-)?(\d{1,9})\b/g;
/** Fenced blocks and inline code: what's in them is code, not a mention. */
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;

/** Every issue and article id in the text, outside code, in order. */
export function findRefs(text: string): TextRef[] {
  const code: [number, number][] = [];
  for (const m of text.matchAll(CODE)) code.push([m.index, m.index + m[0].length]);
  const out: TextRef[] = [];
  for (const m of text.matchAll(REF)) {
    const start = m.index;
    if (code.some(([a, b]) => start >= a && start < b)) continue;
    out.push({
      kind: m[2] ? 'article' : 'issue',
      id: m[0],
      key: m[1]!,
      number: Number(m[3]),
      start,
      end: start + m[0].length,
    });
  }
  return out;
}

/** "BACK-A-3" (in any case) as its key and number; null for anything else, issue ids included. */
export function parseArticleId(id: string): { key: string; number: number } | null {
  const m = /^([A-Za-z][A-Za-z0-9]*)-A-(\d{1,9})$/i.exec(id.trim());
  if (!m) return null;
  return { key: m[1]!.toUpperCase(), number: parseInt(m[2]!, 10) };
}

export function articleId(key: string, number: number): string {
  return `${key}-A-${number}`;
}
