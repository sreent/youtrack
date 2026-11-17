/**
 * The whiteboard's canvas (D58), as Ocean's Whiteboard draws it: SVG placed by its attributes alone,
 * since the page's policy runs no inline style; what a note or a card says is HTML in a foreignObject.
 * Pan and zoom are the viewBox: a drag on the canvas pans it, two fingers pinch it, the wheel scrolls it
 * and zooms it with Ctrl. Elements are dragged by a pointer, from their edges' handle resized, and
 * reached from the keyboard in reading order (the page hands their focus on: `current`).
 */
import type { WhiteboardCard, WhiteboardElement } from '@a4a/shared';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '../../components/Badges';
import { Avatar } from '../../components/Who';
import { arrowLine, contentsOf, TONE_CLASS, type Elements } from './model';

export interface View {
  x: number;
  y: number;
  scale: number;
}

export const MIN_SCALE = 0.2;
export const MAX_SCALE = 3;
const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

export interface CanvasWords {
  hidden: string;
  emptyNote: string;
  resize: string;
  tones: Record<string, string>;
}

interface Props {
  label: string;
  elements: Elements;
  cards: ReadonlyMap<string, WhiteboardCard>;
  chosen: ReadonlySet<string>;
  /** Where a new arrow starts, while its end is being chosen. */
  from: string | null;
  view: View;
  onView: (view: View) => void;
  current: string | null;
  onCurrent: (id: string) => void;
  onChoose: (id: string | null, mode: 'only' | 'toggle') => void;
  onDrag: (moves: { id: string; x: number; y: number }[], done: boolean) => void;
  onResize: (id: string, w: number, h: number, done: boolean) => void;
  onKey: (e: React.KeyboardEvent<SVGGElement>, id: string) => void;
  onOpen: (id: string) => void;
  describe: (e: WhiteboardElement) => string;
  canEdit: boolean;
  words: CanvasWords;
  /** Pixels on screen, for the page to place what it adds in view. */
  onSize?: (size: { width: number; height: number }) => void;
}

type Gesture =
  | { kind: 'pan'; pointer: number; startX: number; startY: number; view: View; moved: boolean }
  | { kind: 'pinch'; pointers: Map<number, { x: number; y: number }>; distance: number; view: View; mid: { x: number; y: number } }
  | { kind: 'drag'; pointer: number; startX: number; startY: number; start: Map<string, { x: number; y: number }>; moved: boolean; id: string; toggle: boolean }
  | { kind: 'resize'; pointer: number; startX: number; startY: number; id: string; w: number; h: number };

export function Canvas(p: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const [panning, setPanning] = useState(false);
  const latest = useRef(p);
  latest.current = p;

  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const next = { width: Math.max(1, r.width), height: Math.max(1, r.height) };
      setSize(next);
      latest.current.onSize?.(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // The wheel scrolls the canvas, and with Ctrl (a trackpad's pinch) zooms it where the pointer is.
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const { view, onView } = latest.current;
      if (e.ctrlKey || e.metaKey) {
        const at = toCanvas(e.clientX, e.clientY);
        const scale = clampScale(view.scale * Math.exp(-e.deltaY / 300));
        onView({ scale, x: at.x - (at.x - view.x) * (view.scale / scale), y: at.y - (at.y - view.y) * (view.scale / scale) });
      } else onView({ ...view, x: view.x + e.deltaX / view.scale, y: view.y + e.deltaY / view.scale });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener('wheel', wheel);
    };
  }, []);

  const toCanvas = (clientX: number, clientY: number) => {
    const el = svg.current;
    const r = el?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const { view } = latest.current;
    return { x: view.x + (clientX - r.left) / view.scale, y: view.y + (clientY - r.top) / view.scale };
  };

  const box = { x: p.view.x, y: p.view.y, w: size.width / p.view.scale, h: size.height / p.view.scale };

  const startPinch = () => {
    const pts = [...pointers.current.values()];
    if (pts.length < 2) return;
    const [a, b] = pts as [{ x: number; y: number }, { x: number; y: number }];
    gesture.current = { kind: 'pinch', pointers: new Map(pointers.current), distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, view: p.view, mid: toCanvas((a.x + b.x) / 2, (a.y + b.y) / 2) };
  };

  const down = (e: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    svg.current?.setPointerCapture?.(e.pointerId);
    if (pointers.current.size >= 2) {
      // A second finger: whatever the first was doing, the two pinch the canvas.
      if (gesture.current?.kind === 'drag' && gesture.current.moved) p.onDrag([], true);
      startPinch();
      return;
    }
    const target = (e.target as Element).closest('[data-element],[data-resize]');
    const resize = target?.getAttribute('data-resize');
    if (resize && p.canEdit) {
      const el = p.elements.get(resize);
      if (el) gesture.current = { kind: 'resize', pointer: e.pointerId, startX: e.clientX, startY: e.clientY, id: resize, w: el.w, h: el.h };
      return;
    }
    const id = target?.getAttribute('data-element');
    if (!id) {
      gesture.current = { kind: 'pan', pointer: e.pointerId, startX: e.clientX, startY: e.clientY, view: p.view, moved: false };
      return;
    }
    const el = p.elements.get(id);
    if (!el) return;
    const toggle = e.shiftKey || e.ctrlKey || e.metaKey;
    // Dragging something not chosen drags it alone; what's chosen goes together, a section with what lies in it.
    const ids = p.chosen.has(id) && !toggle ? [...p.chosen] : [id];
    const start = new Map<string, { x: number; y: number }>();
    for (const cid of ids) {
      const c = p.elements.get(cid);
      if (!c || c.kind === 'arrow') continue;
      start.set(c.id, { x: c.x, y: c.y });
      if (c.kind === 'section') for (const inside of contentsOf(p.elements, c)) start.set(inside.id, { x: inside.x, y: inside.y });
    }
    gesture.current = { kind: 'drag', pointer: e.pointerId, startX: e.clientX, startY: e.clientY, start, moved: false, id, toggle };
  };

  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pinch') {
      const pts = [...pointers.current.values()];
      if (pts.length < 2) return;
      const [a, b] = pts as [{ x: number; y: number }, { x: number; y: number }];
      const scale = clampScale(g.view.scale * (Math.hypot(a.x - b.x, a.y - b.y) / g.distance));
      const r = svg.current!.getBoundingClientRect();
      const mx = (a.x + b.x) / 2 - r.left;
      const my = (a.y + b.y) / 2 - r.top;
      p.onView({ scale, x: g.mid.x - mx / scale, y: g.mid.y - my / scale });
      return;
    }
    if (e.pointerId !== g.pointer) return;
    const dx = (e.clientX - g.startX) / p.view.scale;
    const dy = (e.clientY - g.startY) / p.view.scale;
    if (g.kind === 'pan') {
      if (!g.moved && Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < 3) return;
      g.moved = true;
      setPanning(true);
      p.onView({ ...g.view, x: g.view.x - (e.clientX - g.startX) / g.view.scale, y: g.view.y - (e.clientY - g.startY) / g.view.scale });
    } else if (g.kind === 'drag') {
      if (!p.canEdit) return;
      if (!g.moved && Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < 4) return;
      g.moved = true;
      p.onDrag([...g.start].map(([id, s]) => ({ id, x: Math.round(s.x + dx), y: Math.round(s.y + dy) })), false);
    } else if (g.kind === 'resize') {
      p.onResize(g.id, Math.max(40, Math.round(g.w + dx)), Math.max(32, Math.round(g.h + dy)), false);
    }
  };

  const up = (e: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pinch') {
      if (pointers.current.size < 2) gesture.current = null;
      return;
    }
    if (e.pointerId !== g.pointer) return;
    gesture.current = null;
    setPanning(false);
    const dx = (e.clientX - g.startX) / p.view.scale;
    const dy = (e.clientY - g.startY) / p.view.scale;
    if (g.kind === 'pan') {
      if (!g.moved) p.onChoose(null, 'only');
    } else if (g.kind === 'drag') {
      if (g.moved && p.canEdit) p.onDrag([...g.start].map(([id, s]) => ({ id, x: Math.round(s.x + dx), y: Math.round(s.y + dy) })), true);
      else p.onChoose(g.id, g.toggle ? 'toggle' : 'only');
    } else if (g.kind === 'resize') {
      p.onResize(g.id, Math.max(40, Math.round(g.w + dx)), Math.max(32, Math.round(g.h + dy)), true);
    }
  };

  const cancel = (e: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    gesture.current = null;
    setPanning(false);
    // A drag the browser took away goes back where it was.
    if (g?.kind === 'drag' && g.moved) p.onDrag([...g.start].map(([id, s]) => ({ id, ...s })), false);
  };

  const all = [...p.elements.values()];
  const painted = [
    ...all.filter((e) => e.kind === 'section').sort((a, b) => a.z - b.z),
    ...all.filter((e) => e.kind === 'arrow'),
    ...all.filter((e) => e.kind !== 'section' && e.kind !== 'arrow').sort((a, b) => a.z - b.z),
  ];

  return (
    <svg
      ref={svg}
      className={panning ? 'whiteboard-canvas panning' : 'whiteboard-canvas'}
      viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
      role="group"
      aria-label={p.label}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
    >
      <defs>
        <pattern id="wb-dots" width="24" height="24" patternUnits="userSpaceOnUse">
          <circle className="whiteboard-dot" cx="1" cy="1" r="1" />
        </pattern>
      </defs>
      <rect x={box.x} y={box.y} width={box.w} height={box.h} fill="url(#wb-dots)" />
      {painted.map((e) => (
        <Element key={e.id} e={e} p={p} />
      ))}
    </svg>
  );
}

function Element({ e, p }: { e: WhiteboardElement; p: Props }) {
  const chosen = p.chosen.has(e.id);
  const classes = ['whiteboard-element'];
  if (chosen) classes.push('chosen');
  if (p.from === e.id) classes.push('from');
  const focus = {
    tabIndex: p.current === e.id ? 0 : -1,
    role: 'button',
    'aria-pressed': chosen,
    'aria-label': p.describe(e),
    'data-element': e.id,
    onKeyDown: (k: React.KeyboardEvent<SVGGElement>) => p.onKey(k, e.id),
    onFocus: () => p.onCurrent(e.id),
    onDoubleClick: () => p.onOpen(e.id),
  } as const;
  if (e.kind === 'arrow') {
    const line = arrowLine(p.elements, e);
    if (!line) return null;
    const d = `M${line.x1} ${line.y1} L${line.x2} ${line.y2}`;
    const angle = (Math.atan2(line.y2 - line.y1, line.x2 - line.x1) * 180) / Math.PI;
    const words = [e.label, e.linked].filter(Boolean).join(' · ');
    if (e.linked) classes.push('linked');
    return (
      <g className={[...classes, 'whiteboard-arrow'].join(' ')} {...focus}>
        <path className="whiteboard-arrow-hit" d={d} />
        <path className="whiteboard-ring" d={d} />
        <path className="whiteboard-arrow-line" d={d} />
        <path className="whiteboard-arrow-head" d={`M${line.x2} ${line.y2} l-12 -6 v12 z`} transform={`rotate(${angle} ${line.x2} ${line.y2})`} />
        {words ? (
          <foreignObject x={(line.x1 + line.x2) / 2 - 100} y={(line.y1 + line.y2) / 2 - 13} width={200} height={26}>
            <div className="whiteboard-arrow-label">
              <span>{words}</span>
            </div>
          </foreignObject>
        ) : null}
      </g>
    );
  }
  const ring = <rect className="whiteboard-ring" x={-4} y={-4} width={e.w + 8} height={e.h + 8} rx={e.kind === 'note' || e.kind === 'text' ? 8 : 12} />;
  const handle =
    chosen && p.canEdit && (e.kind === 'note' || e.kind === 'section' || e.kind === 'text') ? (
      <rect className="whiteboard-handle" data-resize={e.id} x={e.w - 6} y={e.h - 6} width={12} height={12} rx={2} />
    ) : null;
  const at = `translate(${e.x} ${e.y})`;
  if (e.kind === 'section') {
    return (
      <g className={[...classes, 'whiteboard-section'].join(' ')} transform={at} {...focus}>
        {ring}
        <rect className="whiteboard-box" width={e.w} height={e.h} rx={10} />
        <text className="whiteboard-section-title" x={14} y={24}>
          {e.text}
        </text>
        {handle}
      </g>
    );
  }
  if (e.kind === 'note') {
    const tone = e.tone ?? 'plain';
    const cls = TONE_CLASS[tone];
    return (
      <g className={[...classes, 'whiteboard-note', cls].filter(Boolean).join(' ')} transform={at} {...focus}>
        {ring}
        <rect className="whiteboard-box" width={e.w} height={e.h} rx={6} />
        <rect className="whiteboard-band" width={e.w} height={6} rx={3} />
        <foreignObject width={e.w} height={e.h}>
          <div className={e.text?.trim() ? 'whiteboard-words' : 'whiteboard-words empty'}>
            {tone !== 'plain' ? <span className={`badge ${cls}`}>{p.words.tones[tone]}</span> : null}
            {e.text?.trim() ? e.text : p.words.emptyNote}
          </div>
        </foreignObject>
        {handle}
      </g>
    );
  }
  if (e.kind === 'text') {
    return (
      <g className={[...classes, 'whiteboard-text'].join(' ')} transform={at} {...focus}>
        {ring}
        <foreignObject width={e.w} height={e.h}>
          <div className="whiteboard-words">{e.text}</div>
        </foreignObject>
        {handle}
      </g>
    );
  }
  const card = p.cards.get(e.id);
  const shown = card?.shown ? card : null;
  classes.push('whiteboard-card');
  if (!shown) classes.push('hidden-card');
  if (shown?.resolved) classes.push('resolved');
  return (
    <g className={classes.join(' ')} transform={at} {...focus}>
      {ring}
      <rect className="whiteboard-box" width={e.w} height={e.h} rx={10} />
      <foreignObject width={e.w} height={e.h}>
        {shown ? (
          <div className="whiteboard-card-body">
            <span className="whiteboard-card-id">{shown.id}</span>
            <span className="whiteboard-card-summary">{shown.summary}</span>
            {shown.state || shown.assignee ? (
              <span className="whiteboard-card-facts">
                {shown.state ? <Badge tone={shown.state.tone}>{shown.state.name}</Badge> : null}
                {shown.assignee ? (
                  <span className="who">
                    <Avatar kind={shown.assignee.isBot ? 'agent' : 'person'} name={shown.assignee.name} small />
                    <span className="who-name">{shown.assignee.isBot ? shown.assignee.login : shown.assignee.name}</span>
                  </span>
                ) : null}
              </span>
            ) : null}
          </div>
        ) : (
          <div className="whiteboard-card-body">{card ? p.words.hidden : '…'}</div>
        )}
      </foreignObject>
    </g>
  );
}
