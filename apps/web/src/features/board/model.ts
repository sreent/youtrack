/**
 * A board as the cards on it: which column and lane each card is in, as the server grouped
 * them, with any moves still on their way laid over them, and what a move writes.
 *
 * Columns come from the board's column field (State, usually): a card is in the column that
 * lists its value, and moving it there sets the field to the column's first value. Lanes, when
 * the board has them, come from its swimlane field: the server lists them in order, the last
 * being nobody ("Unassigned") for a person field, or no value ("No value") for any other.
 */
import type { BoardView, Issue, IssueField, IssueFieldValue, OptionValue, ProjectField, UserRef } from '@a4a/shared';
import { t } from '../../i18n';

export type LaneKind = 'user' | 'option';

export interface Lane {
  /** Stable, for ids and keys. */
  key: string;
  /** What the lane field becomes when a card lands here: a login, a value's name, or nothing. */
  value: string | null;
  label: string;
  user: UserRef | null;
}

export interface PendingMove {
  issue: string;
  version: number;
  column: number;
  lane: number;
  /** What the PATCH writes, by field name. */
  fields: Record<string, string | null>;
}

export interface Placed {
  issue: Issue;
  column: number;
  lane: number;
  resolved: boolean;
  /** Moved here by the person, and not saved yet. */
  pending: boolean;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function fieldNamed(issue: Issue, name: string): IssueField | undefined {
  return issue.fields.find((f) => same(f.name, name));
}

function isUser(v: unknown): v is UserRef {
  return typeof v === 'object' && v !== null && 'login' in v;
}

function isOption(v: unknown): v is OptionValue {
  return typeof v === 'object' && v !== null && 'ordinal' in v && 'name' in v;
}

export function assigneeOf(issue: Issue): UserRef | null {
  const v = fieldNamed(issue, 'Assignee')?.value;
  return isUser(v) ? v : null;
}

/** People and option values seen on the board, and the projects' own lists, to show a move before it's saved. */
export interface ValueBook {
  user(login: string): UserRef | null;
  option(field: string, name: string): OptionValue | null;
  fieldType(field: string): string | null;
}

export function valueBook(view: BoardView, projectFields: ProjectField[], people: UserRef[]): ValueBook {
  const users = new Map<string, UserRef>();
  for (const p of people) users.set(p.login, p);
  const options = new Map<string, OptionValue>();
  const types = new Map<string, string>();
  const key = (field: string, name: string) => `${field.toLowerCase()}\u0000${name.toLowerCase()}`;
  for (const pf of projectFields) {
    types.set(pf.name.toLowerCase(), pf.type);
    for (const v of pf.values) {
      if (!options.has(key(pf.name, v.name))) {
        options.set(key(pf.name, v.name), { id: v.id, name: v.name, tone: v.tone, isResolved: v.isResolved, ordinal: v.ordinal });
      }
    }
  }
  for (const col of view.columns) {
    for (const issue of col.issues) {
      for (const f of issue.fields) {
        types.set(f.name.toLowerCase(), f.type);
        for (const v of Array.isArray(f.value) ? f.value : [f.value]) {
          if (isUser(v)) users.set(v.login, v);
          else if (isOption(v)) options.set(key(f.name, v.name), v);
        }
      }
    }
  }
  return {
    user: (login) => users.get(login) ?? null,
    option: (field, name) => options.get(key(field, name)) ?? null,
    fieldType: (field) => types.get(field.toLowerCase()) ?? null,
  };
}

export function laneKindOf(view: BoardView, book: ValueBook): LaneKind | null {
  const field = view.board.swimlaneField;
  if (!field || view.swimlanes.length === 0) return null;
  const type = book.fieldType(field);
  if (type) return type === 'user' ? 'user' : 'option';
  return view.swimlanes[view.swimlanes.length - 1] === 'Unassigned' ? 'user' : 'option';
}

export function lanesOf(view: BoardView, kind: LaneKind | null, book: ValueBook): Lane[] {
  if (!kind) return [];
  const last = view.swimlanes.length - 1;
  return view.swimlanes.map((name, i) => {
    const none = i === last;
    if (kind === 'user') {
      const user = none ? null : book.user(name);
      return { key: `lane-${i}`, value: none ? null : name, label: none ? t('board.model.unassigned') : (user?.name ?? name), user };
    }
    return { key: `lane-${i}`, value: none ? null : name, label: none ? t('board.model.noValue') : name, user: null };
  });
}

/** The value a card's lane field holds: a login, an option's name, or nothing. */
function laneValue(issue: Issue, field: string): string | null {
  const v = fieldNamed(issue, field)?.value;
  const first = Array.isArray(v) ? v[0] : v;
  if (first === null || first === undefined) return null;
  if (isUser(first)) return first.login;
  if (isOption(first)) return first.name;
  if (typeof first === 'object') return null;
  return String(first);
}

export function laneIndexOf(issue: Issue, field: string, lanes: Lane[]): number {
  const value = laneValue(issue, field);
  const at = value === null ? -1 : lanes.findIndex((l) => l.value !== null && same(l.value, value));
  return at >= 0 ? at : lanes.length - 1;
}

/** The card as it will be once its move is saved: its lane field and, from its column, whether it's resolved. */
function moved(issue: Issue, move: PendingMove, book: ValueBook): { issue: Issue; resolved: boolean | null } {
  let resolved: boolean | null = null;
  const fields = issue.fields.map((f) => {
    const name = Object.keys(move.fields).find((n) => same(n, f.name));
    if (name === undefined) return f;
    const raw = move.fields[name] ?? null;
    let value: IssueFieldValue = null;
    if (raw !== null) {
      const known = f.type === 'user' ? book.user(raw) : book.option(f.name, raw);
      if (!known) return f; // can't show it yet; the board shows it once it's saved
      value = f.multi ? ([known] as IssueFieldValue) : known;
      if (isOption(known) && f.type === 'state') resolved = known.isResolved;
    }
    return { ...f, value };
  });
  return { issue: { ...issue, fields }, resolved };
}

/** The card as it would be once `move` is saved: for the copy that shows where it would land. */
export function asMoved(card: Placed, move: PendingMove, book: ValueBook): Placed {
  const m = moved(card.issue, move, book);
  return { ...card, issue: m.issue, column: move.column, lane: move.lane, resolved: m.resolved ?? card.resolved };
}

/** Every card, where it is or where the person just put it. */
export function placeCards(view: BoardView, lanes: Lane[], pending: ReadonlyMap<string, PendingMove>, book: ValueBook): Placed[] {
  const laneField = view.board.swimlaneField;
  const seen = new Set<string>();
  const out: Placed[] = [];
  view.columns.forEach((col, c) => {
    for (const issue of col.issues) {
      if (seen.has(issue.id)) continue; // a value listed by two columns: the first one shows it
      seen.add(issue.id);
      const lane = laneField && lanes.length ? laneIndexOf(issue, laneField, lanes) : 0;
      const move = pending.get(issue.id);
      if (move) {
        const m = moved(issue, move, book);
        out.push({ issue: m.issue, column: move.column, lane: move.lane, resolved: m.resolved ?? issue.resolvedAt !== null, pending: true });
      } else {
        out.push({ issue, column: c, lane, resolved: issue.resolvedAt !== null, pending: false });
      }
    }
  });
  return out;
}

/** What moving a card to (column, lane) writes, or null when it stays where it is. */
export function moveFor(view: BoardView, lanes: Lane[], card: Placed, column: number, lane: number): PendingMove | null {
  const fields: Record<string, string | null> = {};
  if (column !== card.column) {
    const value = view.columns[column]?.values[0];
    if (!value) return null;
    fields[view.board.columnField] = value;
  }
  if (lanes.length && lane !== card.lane && view.board.swimlaneField) {
    fields[view.board.swimlaneField] = lanes[lane]?.value ?? null;
  }
  if (!Object.keys(fields).length) return null;
  return { issue: card.issue.id, version: card.issue.version, column, lane, fields };
}

export const cellId = (lane: number, column: number) => `cell:${lane}:${column}`;

export function parseCellId(id: string | number): { lane: number; column: number } | null {
  const m = /^cell:(\d+):(\d+)$/.exec(String(id));
  return m ? { lane: Number(m[1]), column: Number(m[2]) } : null;
}

/** How a column stands: "3", "4 of 5", or "3 of 2, 1 over the limit". */
export function columnLoad(count: number, limit: number | null): { text: string; over: boolean } {
  if (limit === null || limit === undefined) return { text: String(count), over: false };
  if (count > limit) return { text: t('board.model.ofOverTheLimit', { count: count, limit: limit, v: count - limit }), over: true };
  return { text: `${count} of ${limit}`, over: false };
}
