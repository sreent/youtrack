/**
 * A whiteboard on the page (D58): what the server last said of each element, the changes on their way
 * over it, and each person's own undo and redo.
 *
 * - The server's elements are kept by their `seq`: a change from the batch's answer or from the live
 *   stream replaces an element only if it's newer than what's here, so the two arriving in either order
 *   come to the same thing, and nobody's change is undone by an older echo.
 * - A batch shows at once (optimistic) and is dropped when its answer comes; what the server refused
 *   comes back as the element it is now.
 * - Undo sends the opposite of what the person did, expecting what they left: if someone has changed
 *   it since, that element is refused and stays as they made it.
 */
import type { WhiteboardCard, WhiteboardElement, WhiteboardKind, WhiteboardOp, WhiteboardTone } from '@a4a/shared';
import { inSection } from '@a4a/shared/whiteboard';

export type Elements = ReadonlyMap<string, WhiteboardElement>;

/** Each kind's size when it's added, as the server gives it. */
export const SIZES: Record<WhiteboardKind, { w: number; h: number }> = {
  note: { w: 200, h: 140 },
  text: { w: 240, h: 48 },
  issue: { w: 240, h: 112 },
  article: { w: 240, h: 112 },
  section: { w: 520, h: 360 },
  arrow: { w: 8, h: 8 },
  ink: { w: 160, h: 120 },
  image: { w: 320, h: 240 },
};

/** Each tone's word, as its message. */
export const TONE_KEY: Record<WhiteboardTone, string> = {
  plain: 'whiteboards.tone.plain',
  idea: 'whiteboards.tone.idea',
  agreed: 'whiteboards.tone.agreed',
  question: 'whiteboards.tone.question',
  problem: 'whiteboards.tone.problem',
  parked: 'whiteboards.tone.parked',
};

/** Each kind's word, as its message, where it's said alone; a note's and a card's take more. */
export const KIND_KEY = { text: 'whiteboards.kind.text', section: 'whiteboards.kind.section', issue: 'whiteboards.kind.issue', article: 'whiteboards.kind.article', ink: 'whiteboards.kind.ink', image: 'whiteboards.kind.image' } as const;

/** a4a's tone of a note, as Ocean's meaning (components/Whiteboard). */
export const TONE_CLASS: Record<WhiteboardTone, string> = { plain: '', idea: 'writes', agreed: 'good', question: 'warn', problem: 'bad', parked: 'idle' };

export function newElementId(): string {
  return crypto.randomUUID();
}

/** The server's word on some elements: newer than what's here replaces it; a removal takes what's older. */
export function mergeServer(current: Elements, elements: readonly WhiteboardElement[], removed: readonly string[], seq: number): Map<string, WhiteboardElement> {
  const next = new Map(current);
  for (const e of elements) {
    const here = next.get(e.id);
    if (!here || here.seq <= e.seq) next.set(e.id, e);
  }
  for (const id of removed) {
    const here = next.get(id);
    if (here && here.seq < seq) next.delete(id);
  }
  return next;
}

/** As the server compares: no words is no words, kept as empty or as nothing. */
const norm = (v: unknown) => (v === '' || v === undefined ? null : v);
const holds = (e: WhiteboardElement, expect: Partial<Record<string, unknown>> | undefined) =>
  !expect || Object.entries(expect).every(([k, v]) => norm((e as unknown as Record<string, unknown>)[k]) === norm(v));

/** What a batch does to the elements shown, before the server says so. */
export function applyOps(current: Elements, ops: readonly WhiteboardOp[]): Map<string, WhiteboardElement> {
  const next = new Map(current);
  let top = Math.max(0, ...[...next.values()].map((e) => e.z));
  for (const op of ops) {
    if (op.op === 'add') {
      if (next.has(op.id)) continue;
      const size = SIZES[op.kind];
      next.set(op.id, {
        id: op.id,
        kind: op.kind,
        x: op.kind === 'arrow' ? 0 : op.x,
        y: op.kind === 'arrow' ? 0 : op.y,
        w: op.w ?? size.w,
        h: op.h ?? size.h,
        z: op.z ?? (top += 1),
        text: op.kind === 'note' || op.kind === 'text' || op.kind === 'section' ? (op.text ?? '') : null,
        tone: op.kind === 'note' ? (op.tone ?? 'plain') : null,
        label: op.kind === 'arrow' ? op.label || null : null,
        from: op.from ?? null,
        to: op.to ?? null,
        linked: null,
        points: op.kind === 'ink' ? (op.points ?? '') : null,
        attachment: op.kind === 'image' ? (op.attachment ?? null) : null,
        seq: 0,
        version: 0,
        updatedAt: new Date().toISOString(),
        updatedBy: null,
      });
    } else if (op.op === 'update') {
      const e = next.get(op.id);
      if (e && holds(e, op.expect)) next.set(op.id, { ...e, ...op.set } as WhiteboardElement);
    } else {
      const e = next.get(op.id);
      if (!e || !holds(e, op.expect)) continue;
      next.delete(op.id);
      for (const a of [...next.values()]) if (a.kind === 'arrow' && (a.from === op.id || a.to === op.id)) next.delete(a.id);
    }
  }
  return next;
}

/** One thing a person did: what it sent, what undoes it, and what does it again after an undo. */
export interface Step {
  /** For the page to say what was undone: "Undid moving 2 elements". */
  what: 'move' | 'add' | 'remove' | 'edit' | 'connect' | 'resize';
  n: number;
  undo: WhiteboardOp[];
  redo: WhiteboardOp[];
}

/** Moving elements: the move, and its undo expecting each where it was put. */
export function moveStep(before: Elements, moves: readonly { id: string; x: number; y: number }[]): { ops: WhiteboardOp[]; step: Step } {
  const ops: WhiteboardOp[] = moves.map((m) => ({ op: 'update', id: m.id, set: { x: m.x, y: m.y } }));
  const undo: WhiteboardOp[] = moves.flatMap((m) => {
    const e = before.get(m.id);
    return e ? [{ op: 'update' as const, id: m.id, set: { x: e.x, y: e.y }, expect: { x: m.x, y: m.y } }] : [];
  });
  const redo: WhiteboardOp[] = moves.flatMap((m) => {
    const e = before.get(m.id);
    return e ? [{ op: 'update' as const, id: m.id, set: { x: m.x, y: m.y }, expect: { x: e.x, y: e.y } }] : [];
  });
  return { ops, step: { what: 'move', n: moves.length, undo, redo } };
}

/** An element as an add, to put it back as it was: a card by what it holds, which only someone who sees it can. */
export function addOf(e: WhiteboardElement, cards: ReadonlyMap<string, WhiteboardCard>): WhiteboardOp | null {
  const base = { op: 'add' as const, id: e.id, kind: e.kind, x: e.x, y: e.y, w: e.w, h: e.h, z: e.z };
  if (e.kind === 'note') return { ...base, text: e.text ?? '', tone: e.tone ?? 'plain' };
  if (e.kind === 'text' || e.kind === 'section') return { ...base, text: e.text ?? '' };
  if (e.kind === 'arrow') return { ...base, x: 0, y: 0, w: undefined, h: undefined, from: e.from ?? undefined, to: e.to ?? undefined, ...(e.label ? { label: e.label } : {}) };
  const card = cards.get(e.id);
  if (!card?.shown || !card.id) return null;
  return e.kind === 'issue' ? { ...base, issue: card.id } : { ...base, article: card.id };
}

/** Words an element holds, which an undo expects to find as the person left them. */
const wordsOf = (e: WhiteboardElement) => (e.kind === 'arrow' ? { label: e.label ?? '' } : e.kind === 'issue' || e.kind === 'article' ? {} : { text: e.text ?? '' });

/** Adding elements: their undo removes them, unless someone has changed their words since. */
export function addStep(ops: WhiteboardOp[], what: 'add' | 'connect' = 'add'): Step {
  const adds = ops.filter((o): o is Extract<WhiteboardOp, { op: 'add' }> => o.op === 'add');
  return {
    what,
    n: adds.length,
    undo: [...adds].reverse().map((a) => ({ op: 'remove', id: a.id, expect: a.kind === 'arrow' ? { label: a.label ?? '' } : a.kind === 'issue' || a.kind === 'article' ? undefined : { text: a.text ?? '' } })),
    redo: adds,
  };
}

/**
 * Removing elements, and the arrows that go with them: their undo adds them back as they were. A card
 * someone can't see can't be put back by them, so a removal holding one can't be undone (null).
 */
export function removeStep(before: Elements, ids: readonly string[], cards: ReadonlyMap<string, WhiteboardCard>): { ops: WhiteboardOp[]; step: Step | null } {
  const going = new Set(ids);
  for (const e of before.values()) if (e.kind === 'arrow' && ((e.from && going.has(e.from)) || (e.to && going.has(e.to)))) going.add(e.id);
  const ops: WhiteboardOp[] = ids.map((id) => ({ op: 'remove', id }));
  const back = [...going].map((id) => before.get(id)).filter((e): e is WhiteboardElement => Boolean(e));
  // Arrows come back after what they join.
  back.sort((a, b) => Number(a.kind === 'arrow') - Number(b.kind === 'arrow'));
  const undo = back.map((e) => addOf(e, cards));
  if (undo.some((o) => !o)) return { ops, step: null };
  const redo: WhiteboardOp[] = ids.map((id) => {
    const e = before.get(id);
    return { op: 'remove', id, ...(e ? { expect: wordsOf(e) } : {}) };
  });
  return { ops, step: { what: 'remove', n: ids.length, undo: undo as WhiteboardOp[], redo } };
}

/** Changing an element's words, tone or size: sent expecting what the person began from, and undone the same way. */
export function editStep(e: WhiteboardElement, set: Partial<Record<'text' | 'tone' | 'label' | 'w' | 'h', string | number>>, what: 'edit' | 'resize' = 'edit'): { ops: WhiteboardOp[]; step: Step } {
  const was = Object.fromEntries(Object.keys(set).map((k) => [k, (e as unknown as Record<string, unknown>)[k] ?? (k === 'label' ? '' : null)]));
  const op = (from: Record<string, unknown>, to: Record<string, unknown>): WhiteboardOp => ({ op: 'update', id: e.id, set: to as never, expect: from as never });
  return { ops: [op(was, set)], step: { what, n: 1, undo: [op(set, was)], redo: [op(was, set)] } };
}

/** The elements that lie in a section, which move with it. */
export function contentsOf(els: Elements, section: WhiteboardElement): WhiteboardElement[] {
  return [...els.values()].filter((e) => e.id !== section.id && e.kind !== 'arrow' && e.kind !== 'section' && inSection(section, e));
}

/** Where an arrow's line meets the edge of a box, going from its centre toward (tx, ty). */
export function edgePoint(box: { x: number; y: number; w: number; h: number }, tx: number, ty: number): { x: number; y: number } {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const sx = dx ? box.w / 2 / Math.abs(dx) : Infinity;
  const sy = dy ? box.h / 2 / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

/** An arrow's line, from the edge of what it starts at to the edge of what it ends at. */
export function arrowLine(els: Elements, a: WhiteboardElement): { x1: number; y1: number; x2: number; y2: number } | null {
  const from = a.from ? els.get(a.from) : undefined;
  const to = a.to ? els.get(a.to) : undefined;
  if (!from || !to) return null;
  const start = edgePoint(from, to.x + to.w / 2, to.y + to.h / 2);
  const end = edgePoint(to, from.x + from.w / 2, from.y + from.h / 2);
  return { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
}

/** The box that holds every element, for "fit". */
export function bounds(els: Iterable<WhiteboardElement>): { x: number; y: number; w: number; h: number } | null {
  let [x1, y1, x2, y2] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const e of els) {
    if (e.kind === 'arrow') continue;
    x1 = Math.min(x1, e.x);
    y1 = Math.min(y1, e.y);
    x2 = Math.max(x2, e.x + e.w);
    y2 = Math.max(y2, e.y + e.h);
  }
  return Number.isFinite(x1) ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
}
