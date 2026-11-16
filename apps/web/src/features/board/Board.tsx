/**
 * Ocean's Board (components/Board): the sprint's head, a column for each state with its count
 * or its limit, lanes when the board has them, and cards. A card moves by dragging it, which
 * shows where it would land and what dropping it does, or from the keyboard by a command
 * (its id opens the CommandBar). A move shows at once and is taken back if the server refuses it.
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
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../../api/client';
import { useUsers } from '../../api/queries';
import { Badge, PriorityMeter } from '../../components/Badges';
import { Icon } from '../../components/Icon';
import { Avatar } from '../../components/Who';
import { localToday, spanWords, workCalendar } from '../plan/dates';
import { plural } from '../plan/format';
import { useCardMoves, useProjectFieldLists } from './api';
import {
  asMoved,
  assigneeOf,
  cellId,
  columnLoad,
  laneKindOf,
  lanesOf,
  moveFor,
  parseCellId,
  placeCards,
  valueBook,
  type Lane,
  type LaneKind,
  type Placed,
} from './model';
import { t, tr } from '../../i18n';
import type { ReactNode } from 'react';

interface Target {
  lane: number;
  column: number;
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
    return n <= 0 ? t('board.board.startsOnTheNextWorking') : t('board.board.startsIn', { plural: plural(n, 'working day') });
  }
  if (today > end) return t('board.board.ended');
  const left = cal.inclusive(today, end);
  return left === 0 ? t('board.board.endsToday') : t('board.board.left', { plural: plural(left, 'working day') });
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

function CardInside({ card, onCommand, asCopy, quiet }: { card: Placed; onCommand?: () => void; asCopy?: boolean; quiet?: boolean }) {
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
            title={t('board.board.moveItWithACommand')}
            tabIndex={quiet ? -1 : undefined}
            onClick={onCommand}
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

function Card({ card, moving, onCommand }: { card: Placed; moving: boolean; onCommand: () => void }) {
  const { setNodeRef, listeners } = useDraggable({
    id: card.issue.id,
    data: { lane: card.lane, column: card.column },
    disabled: card.pending,
  });
  const cls = ['board-card', card.resolved ? 'resolved' : '', moving ? 'moving' : ''].filter(Boolean).join(' ');
  return (
    <li ref={setNodeRef} className={cls} data-issue={card.issue.id} aria-hidden={moving || undefined} {...listeners}>
      <CardInside card={card} onCommand={onCommand} quiet={moving} />
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
    <ol ref={setNodeRef} className="board-cell" aria-label={label}>
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
          {count}
          <span className="hidden"> {count === 1 ? 'issue' : 'issues'}</span>
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
      <span className="note">{plural(count, 'issue')}</span>
    </h3>
  );
}

// ---------------------------------------------------------------------------
// What dropping does, in words
// ---------------------------------------------------------------------------

function laneWords(lane: Lane, kind: LaneKind, field: string, id: string, joined: boolean): string {
  const it = joined ? 'it' : id;
  const its = joined ? 'its' : `${id}'s`;
  if (kind === 'user') return lane.value ? t('board.board.giveTo', { it: it, label: lane.label }) : t('board.board.leaveWithNobodyAssigned', { it: it });
  return lane.value ? t('board.board.setTo', { its: its, field: field, value: lane.value }) : t('board.board.clear', { its: its, field: field });
}

function dropWords(view: BoardView, lanes: Lane[], kind: LaneKind | null, counts: number[], card: Placed, to: Target): string {
  const id = card.issue.id;
  const column = view.columns[to.column]!;
  const moves = to.column !== card.column;
  const relanes = kind !== null && lanes.length > 0 && to.lane !== card.lane;
  const count = (counts[to.column] ?? 0) + (moves ? 1 : 0);
  const load = column.wipLimit !== null ? `: ${columnLoad(count, column.wipLimit).text}` : '';
  const as = moves && column.values.length > 1 ? t('board.board.as', { v: column.values[0] }) : '';
  const field = view.board.swimlaneField ?? '';
  if (moves && relanes) return t('board.board.dropItToMoveTo', { id: id, name: column.name, as: as, laneWords: laneWords(lanes[to.lane]!, kind!, field, id, true), load: load });
  if (moves) return t('board.board.dropItToMoveTo2', { id: id, name: column.name, as: as, load: load });
  if (relanes) return t('board.board.dropItTo', { laneWords: laneWords(lanes[to.lane]!, kind!, field, id, false) });
  return t('board.board.dropItToLeaveWhere', { id: id });
}

/** The command a card's id starts from: its next column's value, which the person can change. */
function nextColumnCommand(view: BoardView, card: Placed): string {
  const next = view.columns[card.column + 1] ?? null;
  const field = view.board.columnField;
  return next?.values[0] ? `${field} ${next.values[0]}` : `${field} `;
}

function failureWords(failed: { move: { issue: string; fields: Record<string, string | null> }; error: unknown }, where: string): { text: string; hint?: string } {
  const id = failed.move.issue;
  const e = failed.error;
  if (e instanceof ApiError && e.status === 409) {
    return {
      text: t('board.board.someoneChangedWhileYouWere', { id: id, where: where }),
      hint: t('board.board.theBoardNowShowsIt'),
    };
  }
  if (e instanceof ApiError) return { text: t('board.board.didnTMoveSoIt', { id: id, where: where, message: e.message }), hint: e.hint };
  return { text: t('board.board.didnTMoveSoIt2', { id: id, where: where }), hint: t('board.board.checkTheConnectionAndTry') };
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

export function Board({ view, onCommand }: { view: BoardView; onCommand: (ask: CommandAsk) => void }) {
  const users = useUsers();
  const projectFields = useProjectFieldLists(useMemo(() => view.board.projects.map((p) => p.key), [view.board.projects]));
  const book = useMemo(() => valueBook(view, projectFields, users.data ?? []), [view, projectFields, users.data]);
  const kind = laneKindOf(view, book);
  const lanes = useMemo(() => lanesOf(view, kind, book), [view, kind, book]);
  const { pending, failed, move, dismiss } = useCardMoves();
  const cards = useMemo(() => placeCards(view, lanes, pending, book), [view, lanes, pending, book]);

  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<Target | null>(null);
  const uid = useId();
  const headingId = `${uid}-board`;
  const hintId = `${uid}-hint`;
  const title = view.sprint?.name ?? view.board.name;

  const counts = useMemo(() => view.columns.map((_, c) => cards.filter((x) => x.column === c).length), [view.columns, cards]);
  const byCell = useMemo(() => {
    const m = new Map<string, Placed[]>();
    for (const c of cards) {
      const k = cellId(lanes.length ? c.lane : 0, c.column);
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return m;
  }, [cards, lanes.length]);
  const active = dragging ? (cards.find((c) => c.issue.id === dragging) ?? null) : null;

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

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
  );

  const targetOf = useCallback((id: string | number | undefined | null): Target | null => (id === undefined || id === null ? null : parseCellId(id)), []);
  const wordsFor = useCallback(
    (cardId: string, to: Target | null): string => {
      const card = cards.find((c) => c.issue.id === cardId);
      if (!card) return '';
      if (!to) return t('board.board.isnTOverAColumn', { cardId: cardId });
      return dropWords(view, lanes, kind, counts, card, to);
    },
    [cards, view, lanes, kind, counts],
  );
  const announcements: Announcements = {
    onDragStart: ({ active: a }) => t('board.board.pickedUp', { id: a.id }),
    onDragOver: ({ active: a, over: o }) => wordsFor(String(a.id), targetOf(o?.id)),
    onDragEnd: ({ active: a, over: o }) => {
      const to = targetOf(o?.id);
      return to ? `${wordsFor(String(a.id), to).replace(/^Drop it to /, 'Dropped: ')}.` : t('board.board.wasPutBack', { id: a.id });
    },
    onDragCancel: ({ active: a }) => t('board.board.movingWasCancelledItStayed', { id: a.id }),
  };

  const onDragStart = (e: DragStartEvent) => {
    setDragging(String(e.active.id));
    setOver(null);
  };
  const onDragOver = (e: DragOverEvent) => setOver(targetOf(e.over?.id));
  const onDragEnd = (e: DragEndEvent) => {
    const id = String(e.active.id);
    const to = targetOf(e.over?.id);
    endDrag();
    const card = cards.find((c) => c.issue.id === id);
    if (!card || !to) return;
    const m = moveFor(view, lanes, card, to.column, lanes.length ? to.lane : card.lane);
    if (m) void move(m);
  };

  const failedCard = failed ? view.columns.findIndex((c) => c.issues.some((i) => i.id === failed.move.issue)) : -1;
  const failure = failed ? failureWords(failed, failedCard >= 0 ? t('board.board.in', { name: view.columns[failedCard]!.name }) : t('board.board.whereItWas')) : null;

  /** The card as dropping it there would leave it: its lane's value, and resolved in a column that resolves it. */
  const landed = (card: Placed, to: Target): Placed => {
    const m = moveFor(view, lanes, card, to.column, lanes.length ? to.lane : card.lane);
    return m ? asMoved(card, m, book) : card;
  };

  const renderCell = (lane: number, column: number, laneLabel: string | null) => {
    const col = view.columns[column]!;
    const here = byCell.get(cellId(lane, column)) ?? [];
    const isTarget = active && over && over.lane === lane && over.column === column && !(active.lane === lane && active.column === column);
    const label = laneLabel ? `${col.name}, ${laneLabel}` : col.name;
    return (
      <Cell key={column} lane={lane} column={column} label={label}>
        {here.map((card) => (
          <Card
            key={card.issue.id}
            card={card}
            moving={dragging === card.issue.id}
            onCommand={() => onCommand({ issues: [{ id: card.issue.id, summary: card.issue.summary }], initial: nextColumnCommand(view, card) })}
          />
        ))}
        {isTarget && active ? <DropSlot card={landed(active, over)} words={dropWords(view, lanes, kind, counts, active, over)} /> : null}
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
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        accessibility={{ announcements, screenReaderInstructions: { draggable: t('board.board.chooseACardSId') } }}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
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
