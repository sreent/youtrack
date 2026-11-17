/**
 * Ocean's Board (components/Board): the sprint's head, a column for each state with its count
 * or its limit, lanes when the board has them, and cards in the board's order. A card is ranked
 * by dragging it to another place in its column, or into another column at a place (D53), which
 * shows where it would land and what dropping it does; from the keyboard, Alt and an arrow on its
 * id moves it a place or a column, and its id opens a command (the CommandBar). A move shows at
 * once, is said where a screen reader hears it once saved, and is taken back if the server
 * refuses it. On a touch screen a card is picked up by holding it; a finger that moves first is a
 * swipe through the columns.
 */
import type { BoardView } from '@a4a/shared';
import {
  DndContext,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../../api/client';
import { useUsers } from '../../api/queries';
import { Badge, PriorityMeter } from '../../components/Badges';
import { Icon } from '../../components/Icon';
import { Avatar } from '../../components/Who';
import { localToday, spanWords, workCalendar } from '../plan/dates';
import { useCardMoves, useProjectFieldLists } from './api';
import {
  asMoved,
  assigneeOf,
  cardsByCell,
  cellId,
  columnLoad,
  laneKindOf,
  lanesOf,
  moveFor,
  orderWith,
  parseCellId,
  placeAt,
  placeCards,
  valueBook,
  type Lane,
  type LaneKind,
  type PendingMove,
  type Place,
  type Placed,
} from './model';
import { problemWords, t, tr } from '../../i18n';
import type { ReactNode } from 'react';

interface Target {
  lane: number;
  column: number;
}

/** Where a dragged card would land: a cell, and its place among the cell's other cards. */
interface DropTarget extends Target {
  index: number;
}

/** What asking for a command on a card starts from: the card, and its next column's value. */
export interface CommandAsk {
  issues: { id: string; summary: string }[];
  initial: string;
}

// ---------------------------------------------------------------------------
// The sprint's head
// ---------------------------------------------------------------------------

/** "5 working days left", "Starts in 3 days", "Ended 2 days ago"; Monday to Friday. */
export function sprintLeft(start: string | null, end: string | null, today = localToday()): string | null {
  if (!end) return null;
  const cal = workCalendar();
  if (start && today < start) {
    const n = cal.inclusive(today, start) - (cal.isWorking(start) ? 1 : 0);
    return n <= 0 ? t('board.board.startsOnTheNextWorking') : t('board.board.startsInWorkingDays', { n });
  }
  if (today > end) return t('board.board.ended');
  const left = cal.inclusive(today, end);
  return left === 0 ? t('board.board.endsToday') : t('board.board.workingDaysLeft', { n: left });
}

function SprintHead({ view, headingId }: { view: BoardView; headingId: string }) {
  const s = view.sprint!;
  const left = sprintLeft(s.startDate, s.endDate);
  return (
    <div className="sprint">
      <div className="sprint-title">
        <h2 id={headingId}>{s.name}</h2>
        {s.startDate && s.endDate ? <span className="sprint-dates">{spanWords(s.startDate, s.endDate)}</span> : null}
        {left ? <span className="chip">{s.archived ? t('board.board.archived') : left}</span> : null}
      </div>
      {s.goal ? (
        <p className="sprint-goal">
          <strong>{t('board.board.goal')}</strong> {s.goal}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function CardInside({
  card,
  onCommand,
  onKeyDown,
  hintId,
  asCopy,
  quiet,
}: {
  card: Placed;
  onCommand?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  hintId?: string;
  asCopy?: boolean;
  quiet?: boolean;
}) {
  const { issue } = card;
  const assignee = assigneeOf(issue);
  return (
    <>
      <span className="board-card-head">
        {asCopy ? (
          <span className="issue-id">{issue.id}</span>
        ) : (
          <button
            type="button"
            className="issue-id"
            aria-label={t('board.board.moveWithACommand', { id: issue.id })}
            aria-describedby={hintId}
            title={t('board.board.moveItWithACommand')}
            tabIndex={quiet ? -1 : undefined}
            onClick={onCommand}
            onKeyDown={onKeyDown}
          >
            {issue.id}
          </button>
        )}
        {assignee ? <Avatar kind={assignee.isBot ? 'agent' : 'person'} name={assignee.isBot ? assignee.login : assignee.name} small /> : null}
      </span>
      {asCopy ? (
        <span className="board-card-summary">{issue.summary}</span>
      ) : (
        <Link className="board-card-summary" to={`/issues/${issue.id}`} draggable={false} tabIndex={quiet ? -1 : undefined}>
          {issue.summary}
        </Link>
      )}
      <span className="board-card-foot">
        <PriorityMeter fields={issue.fields} />
        {issue.tags.length ? (
          <span className="chips">
            {issue.tags.map((t) => (
              <span key={t.id} className="chip">
                {t.name}
              </span>
            ))}
          </span>
        ) : null}
        <span className="hidden">{assignee ? t('board.board.assignee', { name: assignee.name }) : t('board.board.nobodyIsAssigned')}</span>
      </span>
    </>
  );
}

function Card({ card, moving, hintId, onCommand, onKeyDown }: { card: Placed; moving: boolean; hintId: string; onCommand: () => void; onKeyDown: (e: React.KeyboardEvent) => void }) {
  const { setNodeRef, listeners } = useDraggable({
    id: card.issue.id,
    data: { lane: card.lane, column: card.column },
    disabled: card.pending,
  });
  const cls = ['board-card', card.resolved ? 'resolved' : '', moving ? 'moving' : ''].filter(Boolean).join(' ');
  return (
    <li ref={setNodeRef} className={cls} data-issue={card.issue.id} aria-hidden={moving || undefined} {...listeners}>
      <CardInside card={card} onCommand={onCommand} onKeyDown={onKeyDown} hintId={hintId} quiet={moving} />
    </li>
  );
}

function DropSlot({ card, words }: { card: Placed; words: string }) {
  return (
    <li className="board-drop">
      <div className={card.resolved ? 'board-card lifted resolved' : 'board-card lifted'} aria-hidden="true">
        <CardInside card={card} asCopy />
      </div>
      <p>{words}</p>
    </li>
  );
}

function Cell({ lane, column, label, children }: { lane: number; column: number; label: string; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id: cellId(lane, column), data: { lane, column } });
  return (
    <ol ref={setNodeRef} className="board-cell" aria-label={label} data-cell={cellId(lane, column)}>
      {children}
    </ol>
  );
}

function ColumnHead({ name, count, limit, points = null }: { name: string; count: number; limit: number | null; points?: number | null }) {
  const load = columnLoad(count, limit);
  return (
    <div className="board-col-head">
      <h3>{name}</h3>
      {points !== null ? <span className="board-points">{tr('board.board.ptsOfStoryPoints', { points: points, t0: (c: ReactNode) => <span className="hidden">{c}</span> })}</span> : null}
      {limit === null ? (
        <span className="board-count">
          {tr('board.board.issueCount', { n: count, t0: (c: ReactNode) => <span className="hidden">{c}</span> })}
        </span>
      ) : load.over ? (
        <Badge tone="warn">{load.text}</Badge>
      ) : (
        <span className="board-limit">{load.text}</span>
      )}
    </div>
  );
}

function LaneHead({ lane, id, count }: { lane: Lane; id: string; count: number }) {
  return (
    <h3 className="board-lane-head" id={id}>
      {lane.user ? <Avatar kind={lane.user.isBot ? 'agent' : 'person'} name={lane.user.name} small /> : null}
      {lane.label}
      <span className="note">{t('count.issues', { n: count })}</span>
    </h3>
  );
}

// ---------------------------------------------------------------------------
// What dropping does, in words
// ---------------------------------------------------------------------------

function laneWords(lane: Lane, kind: LaneKind, field: string, id: string, joined: boolean): string {
  // The card by "it" where the sentence already named it, by its id where not: a code, so each language words it.
  const named = { joined: joined ? 'yes' : 'no', id };
  if (kind === 'user') return lane.value ? t('board.board.giveItTo', { ...named, label: lane.label }) : t('board.board.leaveItWithNobody', named);
  return lane.value ? t('board.board.setItsFieldTo', { ...named, field: field, value: lane.value }) : t('board.board.clearItsField', { ...named, field: field });
}

/** Above or below which card a place puts it: a code each language words. */
function sideOf(place: Place | null): { side: 'above' | 'below'; id2: string } | null {
  if (place?.after) return { side: 'below', id2: place.after };
  if (place?.before) return { side: 'above', id2: place.before };
  return null;
}

function dropWords(view: BoardView, lanes: Lane[], kind: LaneKind | null, counts: number[], card: Placed, to: Target, place: Place | null): string {
  const id = card.issue.id;
  const column = view.columns[to.column]!;
  const moves = to.column !== card.column;
  const relanes = kind !== null && lanes.length > 0 && to.lane !== card.lane;
  const count = (counts[to.column] ?? 0) + (moves ? 1 : 0);
  const load = column.wipLimit !== null ? `: ${columnLoad(count, column.wipLimit).text}` : '';
  const as = moves && column.values.length > 1 ? t('board.board.as', { v: column.values[0] }) : '';
  const field = view.board.swimlaneField ?? '';
  const at = sideOf(place);
  if (moves && relanes) {
    const words = laneWords(lanes[to.lane]!, kind!, field, id, true);
    return at ? t('board.board.dropItToMoveToAtAnd', { id, name: column.name, as, ...at, laneWords: words, load }) : t('board.board.dropItToMoveTo', { id, name: column.name, as, laneWords: words, load });
  }
  if (moves) return at ? t('board.board.dropItToMoveToAt', { id, name: column.name, as, ...at, load }) : t('board.board.dropItToMoveTo2', { id, name: column.name, as, load });
  if (relanes) {
    const words = laneWords(lanes[to.lane]!, kind!, field, id, false);
    return at ? t('board.board.dropItToAt', { laneWords: words, ...at }) : t('board.board.dropItTo', { laneWords: words });
  }
  if (at) return t('board.board.dropItToPut', { id, ...at });
  return t('board.board.dropItToLeaveWhere', { id });
}

/** The command a card's id starts from: its next column's value, which the person can change. */
function nextColumnCommand(view: BoardView, card: Placed): string {
  const next = view.columns[card.column + 1] ?? null;
  const field = view.board.columnField;
  return next?.values[0] ? `${field} ${next.values[0]}` : `${field} `;
}

function failureWords(failed: { move: { issue: string }; error: unknown }, where: string): { text: string; hint?: string } {
  const id = failed.move.issue;
  const e = failed.error;
  if (e instanceof ApiError && e.status === 409) {
    return {
      text: t('board.board.someoneChangedWhileYouWere', { id: id, where: where }),
      hint: t('board.board.theBoardNowShowsIt'),
    };
  }
  if (e instanceof ApiError) {
    // A refusal with a key says itself in the page's language, fix and all (D49).
    const said = problemWords(e);
    return { text: t('board.board.didnTMoveSoIt', { id: id, where: where, message: said ?? e.message }), hint: said ? undefined : e.hint };
  }
  return { text: t('board.board.didnTMoveSoIt2', { id: id, where: where }), hint: t('board.board.checkTheConnectionAndTry') };
}

/** Where the pointer or finger is, from whichever event moved it. */
function pointOf(e: Event): { x: number; y: number } | null {
  const touch = 'touches' in e ? (e as TouchEvent).touches[0] : null;
  if (touch) return { x: touch.clientX, y: touch.clientY };
  if ('clientX' in e) return { x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY };
  return null;
}

/**
 * The cell under a point, and the place in it: how many of its other cards' middles are above the
 * point. Over the slot where it would land, it stays where it is, so the slot doesn't flicker as the
 * cards make room for it.
 */
function targetAt(point: { x: number; y: number }, dragged: string, current: DropTarget | null): DropTarget | null {
  const cell = document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>('.board-cell[data-cell]');
  const at = cell ? parseCellId(cell.dataset.cell ?? '') : null;
  if (!cell || !at) return null;
  const slot = cell.querySelector<HTMLElement>(':scope > li.board-drop');
  if (slot && current && current.lane === at.lane && current.column === at.column) {
    const r = slot.getBoundingClientRect();
    if (point.y >= r.top && point.y <= r.bottom) return current;
  }
  const others = [...cell.querySelectorAll<HTMLElement>(':scope > li.board-card[data-issue]')].filter((el) => el.dataset.issue !== dragged);
  const index = others.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.top + r.height / 2 < point.y;
  }).length;
  return { ...at, index };
}

const ARROWS: Record<string, 'up' | 'down' | 'left' | 'right'> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

export function Board({ view, onCommand }: { view: BoardView; onCommand: (ask: CommandAsk) => void }) {
  const users = useUsers();
  const projectFields = useProjectFieldLists(useMemo(() => view.board.projects.map((p) => p.key), [view.board.projects]));
  const book = useMemo(() => valueBook(view, projectFields, users.data ?? []), [view, projectFields, users.data]);
  const kind = laneKindOf(view, book);
  const lanes = useMemo(() => lanesOf(view, kind, book), [view, kind, book]);

  // What moved, said where a screen reader hears it, once it's saved (or why a key did nothing).
  const [said, setSaid] = useState('');
  const sayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = useCallback((words: string) => {
    // Cleared first, so the same words said twice are heard twice.
    setSaid('');
    if (sayTimer.current) clearTimeout(sayTimer.current);
    sayTimer.current = setTimeout(() => setSaid(words), 60);
  }, []);
  useEffect(() => () => void (sayTimer.current && clearTimeout(sayTimer.current)), []);

  const { pending, failed, move, dismiss } = useCardMoves(view, lanes, say);
  const cards = useMemo(() => placeCards(view, lanes, pending, book), [view, lanes, pending, book]);
  const order = useMemo(() => orderWith(view.order ?? cards.map((c) => c.issue.id), pending), [view.order, cards, pending]);

  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<DropTarget | null>(null);
  const overRef = useRef<DropTarget | null>(null);
  overRef.current = over;
  const uid = useId();
  const headingId = `${uid}-board`;
  const hintId = `${uid}-hint`;
  const title = view.sprint?.name ?? view.board.name;

  const counts = useMemo(() => view.columns.map((_, c) => cards.filter((x) => x.column === c).length), [view.columns, cards]);
  const byCell = useMemo(() => cardsByCell(cards, order, lanes.length > 0), [cards, order, lanes.length]);
  const cellOf = useCallback((lane: number, column: number) => byCell.get(cellId(lanes.length ? lane : 0, column)) ?? [], [byCell, lanes.length]);
  const active = dragging ? (cards.find((c) => c.issue.id === dragging) ?? null) : null;
  const cellLabel = useCallback((lane: number, column: number) => (lanes.length ? `${view.columns[column]!.name}, ${lanes[lane]!.label}` : view.columns[column]!.name), [lanes, view.columns]);

  // A drop ends with a click on whatever is under the pointer; it isn't one.
  const swallowClick = useRef(false);
  useEffect(() => {
    const stop = (e: MouseEvent) => {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('click', stop, true);
    return () => window.removeEventListener('click', stop, true);
  }, []);
  const endDrag = () => {
    swallowClick.current = true;
    setTimeout(() => (swallowClick.current = false), 0);
    setDragging(null);
    setOver(null);
  };

  // While a card is carried: where it would land, from the pointer or the finger, again as the
  // board scrolls under it; and no long-press menu over it.
  const point = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!dragging) return;
    const recompute = () => {
      if (!point.current) return;
      const next = targetAt(point.current, dragging, overRef.current);
      const now = overRef.current;
      if (next?.lane !== now?.lane || next?.column !== now?.column || next?.index !== now?.index) setOver(next);
    };
    const moved = (e: Event) => {
      point.current = pointOf(e) ?? point.current;
      recompute();
    };
    const menu = (e: Event) => e.preventDefault();
    window.addEventListener('pointermove', moved, { passive: true });
    window.addEventListener('touchmove', moved, { passive: true });
    window.addEventListener('scroll', recompute, { passive: true, capture: true });
    window.addEventListener('contextmenu', menu);
    recompute();
    return () => {
      window.removeEventListener('pointermove', moved);
      window.removeEventListener('touchmove', moved);
      window.removeEventListener('scroll', recompute, { capture: true });
      window.removeEventListener('contextmenu', menu);
    };
  }, [dragging]);

  // A mouse picks a card up once it has moved a little; a finger once it has held it still a
  // moment. A finger that moves first is a swipe: the columns scroll, and nothing is picked up.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
  );

  /** What dropping the card at a target does: its place, or null where it already is. */
  const dropAt = useCallback(
    (card: Placed, to: DropTarget): { place: Place; m: PendingMove } | null => {
      const lane = lanes.length ? to.lane : card.lane;
      const place = placeAt(cellOf(to.lane, to.column), card, to.index);
      if (!place) return null;
      const m = moveFor(view, lanes, card, to.column, lane, place);
      return m ? { place, m } : null;
    },
    [view, lanes, cellOf],
  );

  /** What saving a move says: above or below a card in its cell, or the cell it went to and where in it. */
  const savedWords = useCallback(
    (card: Placed, m: PendingMove): string => {
      const id = card.issue.id;
      const sameCell = m.column === card.column && (!lanes.length || m.lane === card.lane);
      if (sameCell && m.before) return t('page.sprintPlanning.movedAbove', { id, id2: m.before });
      if (sameCell && m.after) return t('page.sprintPlanning.movedBelow', { id, id2: m.after });
      // Where it lands among the cell's cards, by the board's order with this move laid over it.
      const at = new Map(orderWith(order, new Map([[m.issue, m]])).map((x, i) => [x, i]));
      const there = [...cellOf(m.lane, m.column).filter((c) => c.issue.id !== id), card].sort((a, b) => (at.get(a.issue.id) ?? Infinity) - (at.get(b.issue.id) ?? Infinity));
      const j = there.findIndex((c) => c.issue.id === id);
      const where = m.before ? 'above' : m.after ? 'below' : there.length === 1 ? 'alone' : j === 0 ? 'top' : 'below';
      const id2 = m.before ?? m.after ?? (j > 0 ? there[j - 1]!.issue.id : '');
      const relaned = lanes.length > 0 && m.lane !== card.lane;
      return t('board.board.movedTo', { id, name: view.columns[m.column]!.name, inLane: relaned ? 'yes' : 'no', lane: relaned ? lanes[m.lane]!.label : '', where, id2 });
    },
    [order, cellOf, lanes, view.columns],
  );

  const announcements: Announcements = {
    onDragStart: ({ active: a }) => t('board.board.pickedUp', { id: a.id }),
    onDragOver: ({ active: a }) => {
      const card = cards.find((c) => c.issue.id === String(a.id));
      const to = point.current ? targetAt(point.current, String(a.id), overRef.current) : overRef.current;
      if (!card) return '';
      if (!to) return t('board.board.isnTOverAColumn', { cardId: String(a.id) });
      return dropWords(view, lanes, kind, counts, card, to, placeAt(cellOf(to.lane, to.column), card, to.index));
    },
    // A drop that moves the card is said once it's saved; one that doesn't, at once.
    onDragEnd: ({ active: a }) => {
      const card = cards.find((c) => c.issue.id === String(a.id));
      const to = overRef.current;
      return card && to && dropAt(card, to) ? '' : t('board.board.wasPutBack', { id: a.id });
    },
    onDragCancel: ({ active: a }) => t('board.board.movingWasCancelledItStayed', { id: a.id }),
  };

  const onDragStart = (e: DragStartEvent) => {
    point.current = pointOf(e.activatorEvent);
    setDragging(String(e.active.id));
    setOver(null);
  };
  const onDragEnd = (e: DragEndEvent) => {
    const id = String(e.active.id);
    const to = overRef.current;
    endDrag();
    const card = cards.find((c) => c.issue.id === id);
    if (!card || !to) return;
    const drop = dropAt(card, to);
    if (drop) void move(drop.m, savedWords(card, drop.m));
  };

  // From the keyboard, the focus stays on the card's id as it moves, wherever the card goes.
  const follow = useRef<{ id: string; until: number } | null>(null);
  useLayoutEffect(() => {
    const f = follow.current;
    if (!f) return;
    if (Date.now() > f.until) {
      follow.current = null;
      return;
    }
    const button = document.querySelector<HTMLElement>(`li.board-card[data-issue="${CSS.escape(f.id)}"] button.issue-id`);
    const focused = document.activeElement;
    if (!button || focused === button) return;
    // Focus that went elsewhere was moved by the person; focus that fell to the page was the card's.
    if (focused && focused !== document.body) return;
    button.focus();
  });

  const keyMove = (e: React.KeyboardEvent, card: Placed) => {
    const dir = ARROWS[e.key];
    if (!dir || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    // Alt and Left or Right is also the browser's back and forward: on a card, it moves the card.
    e.preventDefault();
    const id = card.issue.id;
    follow.current = { id, until: Date.now() + 5000 };
    const lane = lanes.length ? card.lane : 0;
    const cell = cellOf(lane, card.column);
    const i = cell.findIndex((c) => c.issue.id === id);
    const name = cellLabel(lane, card.column);
    if (dir === 'up' || dir === 'down') {
      const other = cell[dir === 'up' ? i - 1 : i + 1];
      if (i < 0 || !other) return say(t('board.board.cantGoFurther', { id, end: dir === 'up' ? 'top' : 'bottom', name }));
      const m = moveFor(view, lanes, card, card.column, card.lane, dir === 'up' ? { before: other.issue.id } : { after: other.issue.id });
      if (m) void move(m, savedWords(card, m));
      return;
    }
    const to = card.column + (dir === 'left' ? -1 : 1);
    if (to < 0 || to >= view.columns.length) return say(t('board.board.cantGoFurther', { id, end: dir === 'left' ? 'first' : 'last', name }));
    // Into the next column it keeps its place in the board's order, as a command would leave it.
    const m = moveFor(view, lanes, card, to, card.lane);
    if (m) void move(m, savedWords(card, m));
  };

  const failedCard = failed ? view.columns.findIndex((c) => c.issues.some((i) => i.id === failed.move.issue)) : -1;
  const failure = failed ? failureWords(failed, failedCard >= 0 ? t('board.board.in', { name: view.columns[failedCard]!.name }) : t('board.board.whereItWas')) : null;

  /** The card as dropping it there would leave it: its lane's value, and resolved in a column that resolves it. */
  const landed = (card: Placed, m: PendingMove): Placed => asMoved(card, m, book);

  const renderCell = (lane: number, column: number, laneLabel: string | null) => {
    const here = cellOf(lane, column);
    const target = active && over && over.lane === lane && over.column === column ? over : null;
    const drop = active && target ? dropAt(active, target) : null;
    const nodes: ReactNode[] = [];
    let k = 0;
    const slot = () => (drop && active && target ? <DropSlot key="drop" card={landed(active, drop.m)} words={dropWords(view, lanes, kind, counts, active, target, drop.place)} /> : null);
    let slotted = false;
    for (const card of here) {
      const isActive = card.issue.id === active?.issue.id;
      if (drop && !slotted && !isActive && k === target!.index) {
        nodes.push(slot());
        slotted = true;
      }
      if (!isActive) k++;
      nodes.push(
        <Card
          key={card.issue.id}
          card={card}
          moving={dragging === card.issue.id}
          hintId={hintId}
          onCommand={() => onCommand({ issues: [{ id: card.issue.id, summary: card.issue.summary }], initial: nextColumnCommand(view, card) })}
          onKeyDown={(e) => keyMove(e, card)}
        />,
      );
    }
    if (drop && !slotted) nodes.push(slot());
    return (
      <Cell key={column} lane={lane} column={column} label={laneLabel ? `${view.columns[column]!.name}, ${laneLabel}` : view.columns[column]!.name}>
        {nodes}
      </Cell>
    );
  };

  return (
    <section className="board" aria-labelledby={headingId}>
      {view.sprint ? (
        <SprintHead view={view} headingId={headingId} />
      ) : (
        <h2 className="hidden" id={headingId}>
          {view.board.name}
        </h2>
      )}
      {failure ? (
        <div className="error-note" role="alert">
          <Icon name="cross" />
          <strong>{failure.text}</strong>
          {failure.hint ? <p>{failure.hint}</p> : null}
          <button type="button" className="link" onClick={dismiss}>{t('board.board.dismiss')}</button>
        </div>
      ) : null}
      <p className="note" id={hintId}>{t('board.board.dragACardToAnother')}</p>
      <p role="status" className="hidden">{said}</p>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        accessibility={{ announcements, screenReaderInstructions: { draggable: t('board.board.chooseACardSId') } }}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={endDrag}
      >
        {/* With lanes, the board runs long: it scrolls in its own frame, and its column heads stay in view (Ocean's .held). */}
        <div
          className={['board-scroll', lanes.length ? 'held' : '', dragging ? 'dragging' : ''].filter(Boolean).join(' ')}
          tabIndex={0}
          role="group"
          aria-label={t('board.board.sColumns', { title: title })}
          aria-describedby={hintId}
        >
          <div className="board-grid">
            <div className="board-cols">
              {view.columns.map((c, i) => (
                <ColumnHead key={c.name} name={c.name} count={counts[i] ?? 0} limit={c.wipLimit} points={c.points ?? null} />
              ))}
            </div>
            {lanes.length ? (
              lanes.map((lane, l) => {
                const id = `${uid}-${lane.key}`;
                const n = cards.filter((c) => c.lane === l).length;
                return (
                  <section key={lane.key} className="board-lane" aria-labelledby={id}>
                    <LaneHead lane={lane} id={id} count={n} />
                    <div className="board-cells">{view.columns.map((_, c) => renderCell(l, c, lane.label))}</div>
                  </section>
                );
              })
            ) : (
              <div className="board-cells">{view.columns.map((_, c) => renderCell(0, c, null))}</div>
            )}
          </div>
        </div>
      </DndContext>
    </section>
  );
}
