/**
 * A whiteboard (D58): its canvas and its outline, who's looking, and what a team does on it. Every
 * change shows at once and is one batch to the server; others' changes come in over the whiteboard's
 * live stream, each merged by its seq. Each person's own undo and redo expects what they left, so it
 * never takes back someone else's change. Everything is done from the keyboard as well: Tab moves
 * through the elements in reading order, Space chooses, the arrow keys move what's chosen.
 */
import type { WhiteboardCard, WhiteboardDetail, WhiteboardElement, WhiteboardOp, WhiteboardTone } from '@a4a/shared';
import { WHITEBOARD_LIMITS } from '@a4a/shared/constants';
import { readingSequence } from '@a4a/shared/whiteboard';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { get, subscribeWhiteboard } from '../api/client';
import { useMe } from '../api/queries';
import { usePlaces } from '../app/places';
import { Avatar } from '../components/Who';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { Confirm } from '../features/common/Confirm';
import { deleteWhiteboard, renameWhiteboard, sendBatch, useWhiteboard, useWhiteboardCards, whiteboardKeys } from '../features/whiteboards/api';
import { SharingDialog } from '../features/whiteboards/SharingDialog';
import { Canvas, MAX_SCALE, MIN_SCALE, type View } from '../features/whiteboards/Canvas';
import { CardDialog, ConnectDialog, ConvertDialog, NoteDialog, TextDialog } from '../features/whiteboards/Dialogs';
import { addStep, applyOps, bounds, contentsOf, editStep, mergeServer, moveStep, newElementId, removeStep, SIZES, KIND_KEY, TONE_KEY, type Step } from '../features/whiteboards/model';
import { Outline } from '../features/whiteboards/Outline';
import { formatItems, formatNumber, problemWords, t } from '../i18n';

export default function WhiteboardPage() {
  const { id } = useParams();
  const detail = useWhiteboard(id);
  if (detail.isLoading) return <Loading what="loadingLine.whiteboard" />;
  if (detail.error || !detail.data) return <ErrorNote error={detail.error} />;
  return <WhiteboardView key={detail.data.whiteboard.id} detail={detail.data} />;
}

type Dialog =
  | { kind: 'note'; edit: WhiteboardElement | null; conflict: string | null }
  | { kind: 'text'; what: 'text' | 'section' | 'label' | 'rename'; edit: WhiteboardElement | null }
  | { kind: 'card' }
  | { kind: 'connect' }
  | { kind: 'convert' }
  | null;

const STEP = 16;

/**
 * A whiteboard drawn whole. On a guest's page (D64, `usePlaces().guest`) it reads and changes nothing:
 * nobody is shown looking, its cards open where a guest reads issues, and the way back is the guest's.
 */
export function WhiteboardView({ detail }: { detail: WhiteboardDetail }) {
  const places = usePlaces();
  const guest = places.guest;
  const board = detail.whiteboard;
  const me = useMe({ enabled: !guest }).data;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const uid = useId();
  const canEdit = board.access.edit;
  const [name, setName] = useState(board.name);
  const [server, setServer] = useState(() => new Map(detail.elements.map((e) => [e.id, e])));
  const [pending, setPending] = useState<{ key: number; ops: WhiteboardOp[] }[]>([]);
  const [preview, setPreview] = useState<Map<string, Partial<WhiteboardElement>> | null>(null);
  const [viewers, setViewers] = useState(detail.viewers);
  const [gone, setGone] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState<string | null>(null);
  const [view, setView] = useState<View>({ x: -40, y: -40, scale: 1 });
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [outline, setOutline] = useState(true);
  const [said, setSaid] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [sharing, setSharing] = useState(false);
  const streamSeq = useRef(board.seq);
  const undoStack = useRef<Step[]>([]);
  const redoStack = useRef<Step[]>([]);
  const counter = useRef(0);
  const client = useRef(crypto.randomUUID()).current;
  const focusNext = useRef<string | null>(null);
  const fitted = useRef(false);
  // Once it's gone, its cards aren't read again: there's nothing left to read.
  const cardsQuery = useWhiteboardCards(board.id, detail.cards, !gone);
  const cards = useMemo(() => new Map((cardsQuery.data ?? []).map((c) => [c.element, c])), [cardsQuery.data]);
  const cardsRef = useRef<ReadonlyMap<string, WhiteboardCard>>(cards);
  cardsRef.current = cards;

  const shown = useMemo(() => {
    let m = new Map(server);
    for (const p of pending) m = applyOps(m, p.ops);
    if (preview) for (const [id, change] of preview) if (m.has(id)) m.set(id, { ...m.get(id)!, ...change } as WhiteboardElement);
    return m;
  }, [server, pending, preview]);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const order = useMemo(() => readingSequence([...shown.values()]).map((e) => e.id), [shown]);

  const announce = (words: string) => setSaid(words);
  const readCards = useCallback(() => void qc.invalidateQueries({ queryKey: whiteboardKeys.cards(board.id) }), [qc, board.id]);

  // The live stream: others' changes, who's looking, a new name, and when it's gone.
  useEffect(
    () =>
      subscribeWhiteboard(board.id, () => streamSeq.current, {
        ready: () => {},
        change: (f) => {
          streamSeq.current = Math.max(streamSeq.current, f.seq);
          setServer((cur) => mergeServer(cur, f.elements, f.removed, f.seq));
          // A card new to the page (added, or a note just made an issue) is read for what it holds.
          if (f.elements.some((e) => (e.kind === 'issue' || e.kind === 'article') && !cardsRef.current.get(e.id)?.shown)) readCards();
        },
        viewers: setViewers,
        renamed: setName,
        gone: () => setGone(true),
        resync: () => {
          void get<WhiteboardDetail>(`/whiteboards/${board.id}`).then((d) => {
            streamSeq.current = d.whiteboard.seq;
            setServer(new Map(d.elements.map((e) => [e.id, e])));
            qc.setQueryData(whiteboardKeys.cards(board.id), d.cards);
          });
        },
      }),
    [board.id, qc, readCards],
  );

  // The focus follows `current` once it's drawn, and what it's on is brought into view.
  useEffect(() => {
    const id = focusNext.current;
    if (!id || !shown.has(id)) return;
    focusNext.current = null;
    const el = shown.get(id)!;
    if (el.kind !== 'arrow') {
      const w = size.width / view.scale;
      const h = size.height / view.scale;
      if (el.x < view.x || el.y < view.y || el.x + el.w > view.x + w || el.y + el.h > view.y + h) {
        setView((v) => ({ ...v, x: el.x + el.w / 2 - w / 2, y: el.y + el.h / 2 - h / 2 }));
      }
    }
    requestAnimationFrame(() => (document.querySelector(`[data-element="${CSS.escape(id)}"]`) as SVGGElement | null)?.focus());
  });

  const focusOn = (id: string) => {
    setCurrent(id);
    focusNext.current = id;
  };

  const fit = useCallback(
    (to = size) => {
      const b = bounds(shownRef.current.values());
      if (!b) return setView({ x: -40, y: -40, scale: 1 });
      const scale = Math.min(1, Math.max(MIN_SCALE, Math.min((to.width - 48) / b.w, (to.height - 48) / b.h)));
      setView({ scale, x: b.x + b.w / 2 - to.width / scale / 2, y: b.y + b.h / 2 - to.height / scale / 2 });
    },
    [size],
  );

  /** Send a batch: shown at once, merged by its answer; the person's step goes on their undo. */
  const send = async (ops: WhiteboardOp[], step: Step | null, words?: string) => {
    const key = ++counter.current;
    setPending((p) => [...p, { key, ops }]);
    try {
      const r = await sendBatch(board.id, { ops, client });
      setServer((cur) => mergeServer(mergeServer(cur, r.elements, r.removed, r.seq), r.refused.flatMap((x) => (x.element ? [x.element] : [])), [], 0));
      if (step && r.applied.length) {
        undoStack.current.push(step);
        redoStack.current = [];
      }
      if (r.refused.length) announce(t('page.whiteboard.said.refused', { n: r.refused.length }));
      else if (words) announce(words);
      if (ops.some((o) => o.op === 'add' && (o.kind === 'issue' || o.kind === 'article'))) readCards();
      return r;
    } catch (e) {
      announce(problemWords(e) ?? (e instanceof Error ? e.message : t('ui.states.somethingWentWrong')));
      throw e;
    } finally {
      setPending((p) => p.filter((x) => x.key !== key));
    }
  };
  const quietly = (ops: WhiteboardOp[], step: Step | null, words?: string) => void send(ops, step, words).catch(() => {});

  const undo = async () => {
    const step = undoStack.current.pop();
    if (!step) return announce(t('page.whiteboard.said.nothingToUndo'));
    redoStack.current.push(step);
    const r = await send(step.undo, null).catch(() => null);
    if (r && !r.refused.length) announce(t('page.whiteboard.said.undid', { what: step.what, n: step.n }));
    else if (r) announce(t('page.whiteboard.said.notUndone', { n: r.refused.length }));
  };
  const redo = async () => {
    const step = redoStack.current.pop();
    if (!step) return announce(t('page.whiteboard.said.nothingToRedo'));
    undoStack.current.push(step);
    const r = await send(step.redo, null).catch(() => null);
    if (r && !r.refused.length) announce(t('page.whiteboard.said.redid', { what: step.what, n: step.n }));
    else if (r) announce(t('page.whiteboard.said.notRedone', { n: r.refused.length }));
  };

  // Undo and redo from anywhere on the page but a field or a dialog.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (!(e.ctrlKey || e.metaKey) || target?.closest('input, textarea, select, dialog')) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        void undo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        void redo();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  // ---- words ----
  const toneWord = (tone: WhiteboardTone) => t(TONE_KEY[tone]);
  const kindOf = (e: WhiteboardElement): string => {
    const card = cards.get(e.id);
    if (e.kind === 'note') return t('whiteboards.kind.note', { tone: e.tone ?? 'plain' });
    if (e.kind === 'issue' || e.kind === 'article') return card?.shown ? t(KIND_KEY[e.kind], { id: card.id ?? '' }) : t('whiteboards.kind.card');
    if (e.kind === 'arrow') return e.linked ? t('whiteboards.kind.arrowLinked', { link: e.linked }) : t('whiteboards.kind.arrow');
    return t(KIND_KEY[e.kind]);
  };
  const wordsOf = (e: WhiteboardElement): string => {
    if (e.kind === 'note') return e.text?.trim() || t('whiteboards.note.empty');
    if (e.kind === 'text') return e.text ?? '';
    if (e.kind === 'section') return t('whiteboards.section.holds', { title: e.text?.trim() || t('whiteboards.section.untitled'), n: contentsOf(shown, e).length });
    if (e.kind === 'issue' || e.kind === 'article') {
      const card = cards.get(e.id);
      if (!card?.shown) return t('whiteboards.card.hidden');
      return formatItems([card.summary, card.state?.name, card.assignee ? (card.assignee.isBot ? card.assignee.login : card.assignee.name) : null].filter((x): x is string => Boolean(x)));
    }
    const end = (id: string | null) => {
      const x = id ? shown.get(id) : undefined;
      if (!x) return '?';
      const c = cards.get(x.id);
      return x.kind === 'issue' || x.kind === 'article' ? (c?.shown ? (c.id ?? '') : t('whiteboards.kind.card')) : x.kind === 'section' ? x.text || t('whiteboards.section.untitled') : (x.text ?? '').split('\n')[0]!.slice(0, 60);
    };
    return t('whiteboards.arrow.words', { from: end(e.from), to: end(e.to), label: e.label ?? '', hasLabel: e.label ? 'yes' : 'no' });
  };
  const describe = (e: WhiteboardElement) => t('whiteboards.element.label', { kind: kindOf(e), words: wordsOf(e) });

  // ---- doing things ----
  /** Where something new goes: the middle of the view, or the nearest place around it where it covers nothing. */
  const center = (w: number, h: number) => {
    const cx = view.x + size.width / view.scale / 2 - w / 2;
    const cy = view.y + size.height / view.scale / 2 - h / 2;
    const boxes = [...shown.values()].filter((e) => e.kind !== 'arrow' && e.kind !== 'section');
    const free = (x: number, y: number) => boxes.every((b) => x + w + 16 <= b.x || b.x + b.w + 16 <= x || y + h + 16 <= b.y || b.y + b.h + 16 <= y);
    for (let ring = 0; ring < 8; ring++) {
      for (let i = -ring; i <= ring; i++) {
        for (const [dx, dy] of [[i, -ring], [ring, i], [i, ring], [-ring, i]] as const) {
          const x = Math.round(cx + dx * (w + 24));
          const y = Math.round(cy + dy * (h + 24));
          if (free(x, y)) return { x, y };
        }
      }
    }
    return { x: Math.round(cx), y: Math.round(cy) };
  };
  const choose = (id: string | null, mode: 'only' | 'toggle') => {
    if (!id) {
      if (chosen.size) announce(t('page.whiteboard.said.chosen', { n: 0 }));
      return setChosen(new Set());
    }
    const next = mode === 'toggle' ? new Set(chosen) : new Set<string>();
    if (mode === 'toggle' && next.has(id)) next.delete(id);
    else next.add(id);
    setChosen(next);
    setCurrent(id);
    announce(t('page.whiteboard.said.chosen', { n: next.size }));
  };
  const targets = (id?: string) => (chosen.size ? [...chosen] : id ? [id] : current ? [current] : []).filter((x) => shown.has(x));
  const moving = (ids: string[]) => {
    const all = new Set<string>();
    for (const id of ids) {
      const e = shown.get(id);
      if (!e || e.kind === 'arrow') continue;
      all.add(id);
      if (e.kind === 'section') for (const inside of contentsOf(shown, e)) all.add(inside.id);
    }
    return [...all];
  };
  const commitMoves = (moves: { id: string; x: number; y: number }[], before: Map<string, WhiteboardElement>) => {
    setPreview(null);
    const real = moves.filter((m) => {
      const e = before.get(m.id);
      return e && (e.x !== m.x || e.y !== m.y);
    });
    if (!real.length) return;
    const { ops, step } = moveStep(before, real);
    quietly(ops, step, t('page.whiteboard.said.moved', { n: real.length }));
  };
  const dragStart = useRef<Map<string, WhiteboardElement> | null>(null);
  const onDrag = (moves: { id: string; x: number; y: number }[], done: boolean) => {
    if (!canEdit) return;
    if (!dragStart.current) dragStart.current = new Map(moves.flatMap((m) => (shown.get(m.id) ? [[m.id, shown.get(m.id)!] as const] : [])));
    if (!done) {
      setPreview(new Map(moves.map((m) => [m.id, { x: m.x, y: m.y }])));
      return;
    }
    const before = dragStart.current;
    dragStart.current = null;
    commitMoves(moves, before);
  };
  const onResize = (id: string, w: number, h: number, done: boolean) => {
    const e = shown.get(id);
    if (!e || !canEdit) return;
    if (!done) return setPreview(new Map([[id, { w, h }]]));
    setPreview(null);
    const before = server.get(id) ?? e;
    if (before.w === w && before.h === h) return;
    const { ops, step } = editStep(before, { w, h }, 'resize');
    quietly(ops, step, t('page.whiteboard.said.resized'));
  };
  // Arrow keys: each press moves at once; a burst of them is one change, sent when they stop.
  const nudge = useRef<{ start: Map<string, WhiteboardElement>; dx: number; dy: number; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const keyMove = (id: string, dx: number, dy: number) => {
    const ids = moving(targets(id));
    if (!ids.length) return;
    if (!nudge.current) nudge.current = { start: new Map(ids.map((x) => [x, shown.get(x)!])), dx: 0, dy: 0, timer: null };
    const n = nudge.current;
    n.dx += dx;
    n.dy += dy;
    const moves = [...n.start.values()].map((e) => ({ id: e.id, x: e.x + n.dx, y: e.y + n.dy }));
    setPreview(new Map(moves.map((m) => [m.id, { x: m.x, y: m.y }])));
    if (n.timer) clearTimeout(n.timer);
    n.timer = setTimeout(() => {
      nudge.current = null;
      commitMoves(moves, n.start);
    }, 450);
  };
  const remove = (id?: string) => {
    const ids = targets(id);
    if (!ids.length) return;
    const { ops, step } = removeStep(shown, ids, cards);
    setChosen(new Set());
    const i = order.indexOf(ids[0]!);
    const next = order.find((x, j) => j > i && !ids.includes(x)) ?? order.find((x) => !ids.includes(x));
    if (next) focusOn(next);
    quietly(ops, step, step ? t('page.whiteboard.said.removed', { n: ids.length }) : t('page.whiteboard.said.removedForGood', { n: ids.length }));
  };
  const add = (op: WhiteboardOp, what: 'add' | 'connect' = 'add') => {
    quietly([op], addStep([op], what), what === 'connect' ? t('page.whiteboard.said.connected') : t('page.whiteboard.said.added', { n: 1 }));
    focusOn(op.id);
  };
  const edit = (id: string) => {
    const e = shown.get(id);
    if (!e) return;
    if (e.kind === 'issue' || e.kind === 'article') {
      const card = cards.get(id);
      const href = card?.shown && card.id ? (e.kind === 'issue' ? places.issue(card.id) : places.article(card.id)) : null;
      if (href) navigate(href);
      return;
    }
    if (!canEdit) return announce(t('page.whiteboard.said.readOnly'));
    if (e.kind === 'note') setDialog({ kind: 'note', edit: e, conflict: null });
    else setDialog({ kind: 'text', what: e.kind === 'arrow' ? 'label' : e.kind === 'section' ? 'section' : 'text', edit: e });
  };
  const sectionAround = () => {
    const inside = targets().map((x) => shown.get(x)!).filter((e) => e.kind !== 'arrow');
    const b = bounds(inside);
    if (!b) {
      const s = SIZES.section;
      return { ...center(s.w, s.h), w: s.w, h: s.h };
    }
    return { x: b.x - 32, y: b.y - 56, w: Math.min(WHITEBOARD_LIMITS.maxSize, b.w + 64), h: Math.min(WHITEBOARD_LIMITS.maxSize, b.h + 88) };
  };

  const onKey = (e: React.KeyboardEvent<SVGGElement>, id: string) => {
    if (e.ctrlKey || e.metaKey) return;
    const el = shown.get(id);
    if (!el) return;
    const step = e.shiftKey ? STEP * 4 : STEP;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (e.key === 'Tab') {
      const i = order.indexOf(id);
      const next = order[e.shiftKey ? i - 1 : i + 1];
      if (next) {
        e.preventDefault();
        focusOn(next);
      }
    } else if (e.key === ' ') {
      e.preventDefault();
      choose(id, 'toggle');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      edit(id);
    } else if (e.key === 'Escape') {
      choose(null, 'only');
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (canEdit) remove(id);
    } else if (arrows[e.key]) {
      e.preventDefault();
      if (!canEdit) return;
      const [dx, dy] = arrows[e.key]!;
      if (e.altKey && (el.kind === 'note' || el.kind === 'section' || el.kind === 'text')) {
        const base = server.get(id) ?? el;
        const w = Math.max(40, el.w + dx);
        const h = Math.max(32, el.h + dy);
        setPreview(new Map([[id, { w, h }]]));
        const { ops, step: s } = editStep(base, { w, h }, 'resize');
        setPreview(null);
        quietly(ops, s, t('page.whiteboard.said.resized'));
      } else keyMove(id, dx, dy);
    } else if ((e.key === 'n' || e.key === 'N') && canEdit) {
      e.preventDefault();
      setDialog({ kind: 'note', edit: null, conflict: null });
    } else if ((e.key === 'c' || e.key === 'C') && canEdit) {
      e.preventDefault();
      setDialog({ kind: 'connect' });
    }
  };

  // ---- what the dialogs work on ----
  const chosenList = [...chosen].map((x) => shown.get(x)).filter((e): e is WhiteboardElement => Boolean(e));
  const options = order.map((x) => shown.get(x)!).filter((e) => e.kind !== 'arrow').map((e) => ({ id: e.id, words: t('whiteboards.element.label', { kind: kindOf(e), words: wordsOf(e).split('\n')[0]!.slice(0, 80) }) }));
  const connectFrom = chosenList.filter((e) => e.kind !== 'arrow').map((e) => e.id);
  const notesToConvert = (chosenList.length ? chosenList : current && shown.get(current) ? [shown.get(current)!] : []).filter((e) => e.kind === 'note');
  const convertible = new Set([...notesToConvert.map((n) => n.id), ...[...shown.values()].filter((e) => e.kind === 'issue' && cards.get(e.id)?.shown).map((e) => e.id)]);
  const arrowsToConvert = [...shown.values()]
    .filter((a) => a.kind === 'arrow' && a.from && a.to && convertible.has(a.from) && convertible.has(a.to) && (chosen.has(a.id) || chosen.has(a.from) || chosen.has(a.to) || current === a.id))
    .map((a) => ({ arrow: a, from: wordsOf(shown.get(a.from!)!).split('\n')[0]!.slice(0, 60), to: wordsOf(shown.get(a.to!)!).split('\n')[0]!.slice(0, 60) }));
  const endWords = (id: string) => {
    const e = shown.get(id)!;
    const c = cards.get(id);
    return e.kind === 'issue' && c?.shown ? (c.id ?? '') : wordsOf(e).split('\n')[0]!.slice(0, 60);
  };
  for (const a of arrowsToConvert) {
    a.from = endWords(a.arrow.from!);
    a.to = endWords(a.arrow.to!);
  }

  const noteSave = async (text: string, tone: WhiteboardTone) => {
    const d = dialog?.kind === 'note' ? dialog : null;
    if (!d) return;
    if (!d.edit) {
      const s = SIZES.note;
      add({ op: 'add', id: newElementId(), kind: 'note', ...center(s.w, s.h), text, tone });
      return setDialog(null);
    }
    const base = server.get(d.edit.id) ?? d.edit;
    const set: Record<string, string> = {};
    if (text !== (base.text ?? '')) set.text = text;
    if (tone !== (base.tone ?? 'plain')) set.tone = tone;
    if (!Object.keys(set).length) return setDialog(null);
    const { ops, step } = editStep(base, set);
    const r = await send(ops, step, t('page.whiteboard.said.saved')).catch(() => null);
    const refused = r?.refused.find((x) => x.id === base.id);
    if (refused?.element) setDialog({ kind: 'note', edit: refused.element, conflict: refused.element.text ?? '' });
    else if (refused) {
      setDialog(null);
      announce(t('page.whiteboard.said.refused', { n: 1 }));
    } else if (r) setDialog(null);
  };
  const textSave = async (text: string) => {
    const d = dialog?.kind === 'text' ? dialog : null;
    if (!d) return;
    setDialog(null);
    if (d.what === 'rename') {
      if (!text || text === name) return;
      try {
        const w = await renameWhiteboard(board.id, text);
        setName(w.name);
        void qc.invalidateQueries({ queryKey: whiteboardKeys.all });
        announce(t('page.whiteboard.said.saved'));
      } catch (e) {
        announce(problemWords(e) ?? t('ui.states.somethingWentWrong'));
      }
      return;
    }
    if (!d.edit) {
      if (d.what === 'section') {
        const at = sectionAround();
        const top = Math.min(0, ...[...shown.values()].map((e) => e.z)) - 1;
        add({ op: 'add', id: newElementId(), kind: 'section', ...at, z: top, text });
      } else {
        const s = SIZES.text;
        add({ op: 'add', id: newElementId(), kind: 'text', ...center(s.w, s.h), text });
      }
      return;
    }
    const base = server.get(d.edit.id) ?? d.edit;
    const field = d.what === 'label' ? 'label' : 'text';
    if ((base[field] ?? '') === text) return;
    const { ops, step } = editStep(base, { [field]: text });
    quietly(ops, step, t('page.whiteboard.said.saved'));
  };

  const zoomBy = (factor: number) =>
    setView((v) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
      const cx = v.x + size.width / v.scale / 2;
      const cy = v.y + size.height / v.scale / 2;
      return { scale, x: cx - size.width / scale / 2, y: cy - size.height / scale / 2 };
    });

  const textDialog = dialog?.kind === 'text' ? dialog : null;
  const textTitles = { text: textDialog?.edit ? 'whiteboards.textDialog.editText' : 'whiteboards.textDialog.addText', section: textDialog?.edit ? 'whiteboards.textDialog.renameSection' : 'whiteboards.textDialog.addSection', label: 'whiteboards.textDialog.labelArrow', rename: 'page.whiteboard.renameTitle' } as const;
  const textLabels = { text: 'whiteboards.textDialog.text', section: 'whiteboards.textDialog.title', label: 'whiteboards.textDialog.label', rename: 'page.whiteboard.name' } as const;
  const key = board.project?.key ?? '';

  if (gone) {
    return (
      <>
        <PageHead title={name} />
        <section className="card">
          <p className="note">{t('page.whiteboard.said.gone')}</p>
          {guest ? <Link to="/public">{t('page.guestPages.openToAnyone')}</Link> : <Link to="/whiteboards">{t('page.whiteboard.backToWhiteboards')}</Link>}
        </section>
      </>
    );
  }

  return (
    <>
      <PageHead
        title={name}
        crumbs={
          guest ? (
            <>
              <Link to={`/public?project=${encodeURIComponent(key)}`}>{board.project?.name}</Link>
              <span className="sep" aria-hidden="true">
                /
              </span>
            </>
          ) : board.project ? (
            <>
              <Link to="/whiteboards">{t('app.shell.whiteboards')}</Link>
              <span className="sep" aria-hidden="true">
                /
              </span>
              <Link to={`/whiteboards?project=${encodeURIComponent(key)}`}>{key}</Link>
              <span className="sep" aria-hidden="true">
                /
              </span>
            </>
          ) : (
            <>
              <Link to="/whiteboards">{t('app.shell.whiteboards')}</Link>
              <span className="sep" aria-hidden="true">
                /
              </span>
            </>
          )
        }
        about={guest ? t('page.guestPages.whiteboardReadOnly') : canEdit ? t('page.whiteboard.about') : board.project ? t('page.whiteboard.readOnly', { key }) : t('page.whiteboard.readOnlyPersonal', { owner: board.owner?.name ?? '' })}
        actions={
          <>
            {board.access.share ? (
              <button type="button" onClick={() => setSharing(true)}>
                {t('page.whiteboards.whoReadsIt')}
              </button>
            ) : null}
            {canEdit ? (
              <button type="button" onClick={() => setDialog({ kind: 'text', what: 'rename', edit: null })}>
                {t('page.whiteboard.rename')}
              </button>
            ) : null}
            {board.access.delete ? (
              <Confirm
                label={t('page.whiteboard.delete')}
                title={t('page.whiteboard.deleteTitle', { name })}
                about={t('page.whiteboard.deleteAbout')}
                confirm={t('page.whiteboard.deleteConfirm')}
                onConfirm={() => void deleteWhiteboard(board.id).then(() => (void qc.invalidateQueries({ queryKey: whiteboardKeys.all }), navigate('/whiteboards')))}
              />
            ) : null}
          </>
        }
      />
      {sharing ? <SharingDialog board={board} onClose={() => setSharing(false)} /> : null}
      <section className="whiteboard" aria-labelledby={`${uid}-canvas`}>
        <h2 id={`${uid}-canvas`} className="hidden">
          {t('page.whiteboard.canvas')}
        </h2>
        <div className="whiteboard-tools" role="toolbar" aria-label={t('page.whiteboard.tools')}>
          {canEdit ? (
            <>
              <button type="button" aria-keyshortcuts="N" onClick={() => setDialog({ kind: 'note', edit: null, conflict: null })}>
                {t('page.whiteboard.addNote')}
              </button>
              <button type="button" onClick={() => setDialog({ kind: 'text', what: 'text', edit: null })}>
                {t('page.whiteboard.addText')}
              </button>
              <button type="button" onClick={() => setDialog({ kind: 'card' })}>
                {t('page.whiteboard.addCard')}
              </button>
              <button type="button" onClick={() => setDialog({ kind: 'text', what: 'section', edit: null })}>
                {chosen.size ? t('page.whiteboard.group') : t('page.whiteboard.addSection')}
              </button>
              <button type="button" aria-keyshortcuts="C" onClick={() => setDialog({ kind: 'connect' })} disabled={shown.size < 2}>
                {t('page.whiteboard.connect')}
              </button>
              <button type="button" onClick={() => setDialog({ kind: 'convert' })}>
                {t('page.whiteboard.convert')}
              </button>
              <button type="button" onClick={() => current && edit(current)} disabled={!current}>
                {t('page.whiteboard.edit')}
              </button>
              <button type="button" className="danger" onClick={() => remove()} disabled={!chosen.size && !current}>
                {t('page.whiteboard.remove')}
              </button>
              <button type="button" onClick={() => void undo()}>
                {t('page.whiteboard.undo')}
              </button>
              <button type="button" onClick={() => void redo()}>
                {t('page.whiteboard.redo')}
              </button>
            </>
          ) : null}
          <div className="modes" role="group" aria-label={t('page.whiteboard.zoom')}>
            <button type="button" aria-label={t('page.whiteboard.zoomOut')} onClick={() => zoomBy(1 / 1.25)}>
              −
            </button>
            <button type="button" aria-label={t('page.whiteboard.fit', { percent: formatNumber(view.scale, { style: 'percent', maximumFractionDigits: 0 }) })} onClick={() => fit()}>
              {formatNumber(view.scale, { style: 'percent', maximumFractionDigits: 0 })}
            </button>
            <button type="button" aria-label={t('page.whiteboard.zoomIn')} onClick={() => zoomBy(1.25)}>
              +
            </button>
          </div>
          <button type="button" aria-pressed={outline} onClick={() => setOutline((o) => !o)}>
            {t('page.whiteboard.outline')}
          </button>
        </div>
        {guest ? null : (
          <ul className="whiteboard-viewers" aria-label={t('page.whiteboard.lookingNow')}>
            {viewers.map((v) => (
              <li key={v.user.id}>
                <Avatar kind={v.user.isBot ? 'agent' : 'person'} name={v.user.name} small />
                {v.user.id === me?.id ? t('page.whiteboard.you', { name: v.user.name }) : v.user.isBot ? v.user.login : v.user.name}
              </li>
            ))}
          </ul>
        )}
        <p className="note" id={`${uid}-keys`}>
          {canEdit ? t('page.whiteboard.keys') : t('page.whiteboard.keysReading')}
        </p>
        <p className="outcome" role="status">
          {said}
        </p>
        <div className={outline ? 'whiteboard-body with-outline' : 'whiteboard-body'}>
          <div className="whiteboard-frame">
            <Canvas
              label={t('whiteboards.canvas.label', { name, n: shown.size })}
              elements={shown}
              cards={cards}
              chosen={chosen}
              from={null}
              view={view}
              onView={setView}
              current={current ?? order[0] ?? null}
              onCurrent={setCurrent}
              onChoose={choose}
              onDrag={onDrag}
              onResize={onResize}
              onKey={onKey}
              onOpen={edit}
              describe={describe}
              canEdit={canEdit}
              words={{ hidden: t('whiteboards.card.hidden'), emptyNote: t('whiteboards.note.empty'), resize: '', tones: Object.fromEntries((['plain', 'idea', 'agreed', 'question', 'problem', 'parked'] as const).map((x) => [x, toneWord(x)])) }}
              onSize={(s) => {
                setSize(s);
                if (!fitted.current) {
                  fitted.current = true;
                  fit(s);
                }
              }}
            />
          </div>
          {outline ? (
            <Outline
              id={`${uid}-outline`}
              elements={shown}
              chosen={chosen}
              kindOf={kindOf}
              wordsOf={wordsOf}
              onPick={(id, toggle) => {
                choose(id, toggle ? 'toggle' : 'only');
                focusOn(id);
              }}
            />
          ) : null}
        </div>
      </section>
      <NoteDialog
        open={dialog?.kind === 'note'}
        title={dialog?.kind === 'note' && dialog.edit ? t('whiteboards.noteDialog.editTitle') : t('whiteboards.noteDialog.addTitle')}
        initial={{ text: dialog?.kind === 'note' && dialog.edit ? (dialog.edit.text ?? '') : '', tone: dialog?.kind === 'note' && dialog.edit ? (dialog.edit.tone ?? 'plain') : 'plain' }}
        conflict={dialog?.kind === 'note' ? dialog.conflict : null}
        onSave={(text, tone) => void noteSave(text, tone)}
        onClose={() => setDialog(null)}
      />
      <TextDialog
        open={Boolean(textDialog)}
        title={textDialog ? t(textTitles[textDialog.what]) : ''}
        label={textDialog ? t(textLabels[textDialog.what]) : ''}
        initial={textDialog?.what === 'rename' ? name : textDialog?.edit ? ((textDialog.what === 'label' ? textDialog.edit.label : textDialog.edit.text) ?? '') : ''}
        max={textDialog?.what === 'rename' ? WHITEBOARD_LIMITS.name : textDialog?.what === 'text' ? WHITEBOARD_LIMITS.text : WHITEBOARD_LIMITS.label}
        onSave={(text) => void textSave(text)}
        onClose={() => setDialog(null)}
      />
      <CardDialog
        open={dialog?.kind === 'card'}
        onClose={() => setDialog(null)}
        onAdd={async (kind, ref) => {
          const s = SIZES[kind];
          const op: WhiteboardOp = { op: 'add', id: newElementId(), kind, ...center(s.w, s.h), ...(kind === 'issue' ? { issue: ref } : { article: ref }) };
          await send([op], addStep([op]), t('page.whiteboard.said.added', { n: 1 }));
          setDialog(null);
          focusOn(op.id);
        }}
      />
      <ConnectDialog
        open={dialog?.kind === 'connect'}
        options={options}
        initial={{ from: connectFrom[0] ?? (current && shown.get(current)?.kind !== 'arrow' ? current : '') ?? '', to: connectFrom[1] ?? '' }}
        onClose={() => setDialog(null)}
        onConnect={(from, to, label) => {
          setDialog(null);
          add({ op: 'add', id: newElementId(), kind: 'arrow', x: 0, y: 0, from, to, ...(label ? { label } : {}) }, 'connect');
        }}
      />
      <ConvertDialog
        open={dialog?.kind === 'convert'}
        board={board.id}
        defaultProject={key}
        notes={notesToConvert}
        arrows={arrowsToConvert}
        wordsOf={(e) => wordsOf(e).split('\n')[0]!.slice(0, 80)}
        onClose={() => setDialog(null)}
        onDone={(r) => {
          readCards();
          announce(t('page.whiteboard.said.converted', { n: r.notes.filter((n) => n.ok && n.issue && !n.already).length, links: r.links.filter((l) => l.ok && l.made).length }));
        }}
      />
    </>
  );
}
