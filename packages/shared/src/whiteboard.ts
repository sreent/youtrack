/**
 * A whiteboard read in order (D58): what a screen reader's outline lists, what the keyboard moves
 * through, and what an agent reads, the same everywhere. Sections first, each with what lies inside it,
 * then what lies in none, then the arrows; each group top to bottom, and left to right along a row.
 */

/** The little of an element its place in the order needs. */
export interface Placed {
  id: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  from?: string | null;
  to?: string | null;
}

/** Elements whose tops are this close read as one row, left to right. */
const ROW = 48;

/** Whether an element lies in a section: its centre is inside the section's box. */
export function inSection(section: Placed, e: Placed): boolean {
  const cx = e.x + e.w / 2;
  const cy = e.y + e.h / 2;
  return cx >= section.x && cx <= section.x + section.w && cy >= section.y && cy <= section.y + section.h;
}

const byId = (a: Placed, b: Placed) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Top to bottom, and left to right along a row. */
export function readingOrder<E extends Placed>(items: readonly E[]): E[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x || byId(a, b));
  const rows: E[][] = [];
  for (const e of sorted) {
    const row = rows.at(-1);
    if (row && e.y - row[0]!.y < ROW) row.push(e);
    else rows.push([e]);
  }
  return rows.flatMap((r) => r.sort((a, b) => a.x - b.x || a.y - b.y || byId(a, b)));
}

export interface WhiteboardOutline<E extends Placed> {
  sections: { section: E; inside: E[] }[];
  /** What lies in no section. */
  loose: E[];
  /** In the order of what they start from, then of what they end at. */
  arrows: E[];
}

/** The whiteboard as its outline reads it. An element in sections that overlap is in the smallest. */
export function whiteboardOutline<E extends Placed>(elements: readonly E[]): WhiteboardOutline<E> {
  const sections = readingOrder(elements.filter((e) => e.kind === 'section'));
  const inside = new Map<string, E[]>(sections.map((s) => [s.id, []]));
  const loose: E[] = [];
  for (const e of elements) {
    if (e.kind === 'section' || e.kind === 'arrow') continue;
    let best: E | null = null;
    for (const s of sections) if (inSection(s, e) && (!best || s.w * s.h < best.w * best.h)) best = s;
    if (best) inside.get(best.id)!.push(e);
    else loose.push(e);
  }
  const placed = [...sections.flatMap((s) => [s, ...readingOrder(inside.get(s.id)!)]), ...readingOrder(loose)];
  const at = new Map(placed.map((e, i) => [e.id, i]));
  const where = (id: string | null | undefined) => (id ? (at.get(id) ?? placed.length) : placed.length);
  const arrows = elements.filter((e) => e.kind === 'arrow').sort((a, b) => where(a.from) - where(b.from) || where(a.to) - where(b.to) || byId(a, b));
  return { sections: sections.map((s) => ({ section: s, inside: readingOrder(inside.get(s.id)!) })), loose: readingOrder(loose), arrows };
}

/** Every element once, in the outline's order: the keyboard's order on the canvas too. */
export function readingSequence<E extends Placed>(elements: readonly E[]): E[] {
  const o = whiteboardOutline(elements);
  return [...o.sections.flatMap((s) => [s.section, ...s.inside]), ...o.loose, ...o.arrows];
}

/** A note's words as an issue: its first line the summary (cut where it's long), the rest the description. */
export function noteAsIssue(text: string, max = 255): { summary: string; description: string } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex((l) => l.trim());
  if (first < 0) return { summary: '', description: '' };
  const line = lines[first]!.trim().replace(/\s+/g, ' ');
  const rest = lines.slice(first + 1).join('\n').trim();
  if (line.length <= max) return { summary: line, description: rest };
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  // Cut where it's long, at a word where there's one, and keep every word in the description.
  return { summary: `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`, description: text.trim() };
}
