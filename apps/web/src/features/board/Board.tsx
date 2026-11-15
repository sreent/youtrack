/**
 * Ocean's Board (components/Board): the sprint's head, a column for each state with its count
 * or its limit, lanes when the board has them, and cards. A card moves by dragging it, which
 * shows where it would land and what dropping it does, or from the keyboard by a command
 * (its id opens the CommandBar). A move shows at once and is taken back if the server refuses it.
 */
import type { BoardView, UserRef } from '@a4a/shared';
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
import { Avatar } from '../../components/Who';
import { localToday, spanWords, workCalendar } from '../plan/dates';
import { plural } from '../plan/format';
import { useCardMoves, useProjectFieldLists } from './api';
import {
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
import './board.css';

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
    return n <= 0 ? 'Starts on the next working day' : `Starts in ${plural(n, 'working day')}`;
  }
  if (today > end) return 'Ended';
  const left = cal.inclusive(today, end);
  return left === 0 ? 'Ends today' : `${plural(left, 'working day')} left`;
}

function SprintHead({ view, headingId }: { view: BoardView; headingId: string }) {
  const s = view.sprint!;
  const left = sprintLeft(s.startDate, s.endDate);
  return (
    <div className="sprint">
      <div className="sprint-title">
        <h2 id={headingId}>{s.name}</h2>
        {s.startDate && s.endDate ? <span className="sprint-dates">{spanWords(s.startDate, s.endDate)}</span> : null}
        {left ? <span className="chip">{s.archived ? 'Archived' : left}</span> : null}
      </div>
      {s.goal ? (
        <p className="sprint-goal">
          <strong>Goal:</strong> {s.goal}
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
            aria-label={`Move ${issue.id} with a command`}
            title="Move it with a command"
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
        <span className="hidden">{assignee ? `Assignee: ${assignee.name}` : 'Nobody is assigned'}</span>
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
    <li ref={setNodeRef} className={cls} aria-hidden={moving || undefined} {...listeners}>
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

function ColumnHead({ name, count, limit }: { name: string; count: number; limit: number | null }) {
  const load = columnLoad(count, limit);
  return (
    <div className="board-col-head">
      <h3>{name}</h3>
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
  if (kind === 'user') return lane.value ? `give ${it} to ${lane.label}` : `leave ${it} with nobody assigned`;
  return lane.value ? `set ${its} ${field} to ${lane.value}` : `clear ${its} ${field}`;
}

function dropWords(view: BoardView, lanes: Lane[], kind: LaneKind | null, counts: number[], card: Placed, to: Target): string {
  const id = card.issue.id;
  const column = view.columns[to.column]!;
  const moves = to.column !== card.column;
  const relanes = kind !== null && lanes.length > 0 && to.lane !== card.lane;
  const count = (counts[to.column] ?? 0) + (moves ? 1 : 0);
  const load = column.wipLimit !== null ? `: ${columnLoad(count, column.wipLimit).text}` : '';
  const as = moves && column.values.length > 1 ? `, as ${column.values[0]}` : '';
  const field = view.board.swimlaneField ?? '';
  if (moves && relanes) return `Drop it to move ${id} to ${column.name}${as} and ${laneWords(lanes[to.lane]!, kind!, field, id, true)}${load}`;
  if (moves) return `Drop it to move ${id} to ${column.name}${as}${load}`;
  if (relanes) return `Drop it to ${laneWords(lanes[to.lane]!, kind!, field, id, false)}`;
  return `Drop it to leave ${id} where it was`;
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
      text: `Someone changed ${id} while you were moving it, so it stayed ${where}.`,
      hint: 'The board now shows it as it is. Move it again if you still want to.',
    };
  }
  if (e instanceof ApiError) return { text: `${id} didn't move, so it stayed ${where}: ${e.message}`, hint: e.hint };
  return { text: `${id} didn't move, so it stayed ${where}. a4a couldn't reach the server.`, hint: 'Check the connection and try again.' };
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

export function Board({ view, onCommand }: { view: BoardView; onCommand: (ask: CommandAsk) => void }) {
  const users = useUsers();
  const projectFields = useProjectFieldLists(useMemo(() => view.board.projects.map((p) => p.key), [view.board.projects]));
  const book = useMemo(() => valueBook(view, projectFields, (users.data ?? []) as UserRef[]), [view, projectFields, users.data]);
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
      if (!to) return `${cardId} isn't over a column.`;
      return dropWords(view, lanes, kind, counts, card, to);
    },
    [cards, view, lanes, kind, counts],
  );
  const announcements: Announcements = {
    onDragStart: ({ active: a }) => `Picked up ${a.id}.`,
    onDragOver: ({ active: a, over: o }) => wordsFor(String(a.id), targetOf(o?.id)),
    onDragEnd: ({ active: a, over: o }) => {
      const to = targetOf(o?.id);
      return to ? `${wordsFor(String(a.id), to).replace(/^Drop it to /, 'Dropped: ')}.` : `${a.id} was put back.`;
    },
    onDragCancel: ({ active: a }) => `Moving ${a.id} was cancelled; it stayed where it was.`,
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
  const failure = failed ? failureWords(failed, failedCard >= 0 ? `in ${view.columns[failedCard]!.name}` : 'where it was') : null;

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
        {isTarget && active ? <DropSlot card={active} words={dropWords(view, lanes, kind, counts, active, over)} /> : null}
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
        <div className="a4-error a4-board-failed" role="alert">
          <div className="a4-grow">
            <p>{failure.text}</p>
            {failure.hint ? <p className="note">{failure.hint}</p> : null}
          </div>
          <button type="button" className="link" onClick={dismiss}>
            Dismiss
          </button>
        </div>
      ) : null}
      <p className="note" id={hintId}>
        Drag a card to another column to move it, or choose its id to move it with a command.
      </p>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        accessibility={{ announcements, screenReaderInstructions: { draggable: 'Choose a card’s id to move it with a command.' } }}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={endDrag}
      >
        <div className={dragging ? 'board-scroll a4-dragging' : 'board-scroll'} tabIndex={0} role="group" aria-label={`${title}'s columns`} aria-describedby={hintId}>
          <div className="board-grid">
            <div className="board-cols">
              {view.columns.map((c, i) => (
                <ColumnHead key={c.name} name={c.name} count={counts[i] ?? 0} limit={c.wipLimit} />
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
