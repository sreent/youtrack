/**
 * An issue's history, rebuilt from its activity: when it began to exist and when it was deleted,
 * how it stood (its state, and whether that was resolved) from each change on, its estimate, and
 * which sprints it was in. Pure: the service loads the events, this orders and reads them.
 *
 * - An issue is known by its readable id (BACK-12), which every event carries; a deleted issue's
 *   rows lose their issue id but keep it. Moving it to another project (D41) gives it a new id,
 *   and the move's event names both, so the events under either are one history, known by the id
 *   it last had in the report's projects.
 * - Where it was: a moved issue counts, at each instant, only while it was in the report's
 *   projects. Moved in, it arrives (it isn't created there, nor resolved by arriving resolved);
 *   moved out, it leaves (it isn't deleted, nor resolved, there).
 * - What an event says about the issue is how it stood after the event (its ref's state and
 *   resolved flag), so a renamed field never hides a change. A value renamed later keeps its old
 *   name for the days before.
 * - An imported issue began when the other tracker says it was created. If it came in resolved,
 *   on a date after that, it was open until then, in the project's first open state, since the
 *   export doesn't say how it moved.
 */

export interface HistoryEvent {
  /** The activity's id: the order of events on one issue. */
  id: number;
  /** When it happened, ms since the epoch. */
  at: number;
  type: string;
  rid: string;
  summary?: string | null;
  /** How the issue stood after it; undefined when the event doesn't say. */
  state?: string | null;
  resolved?: boolean;
  /** Set when the event set the estimate (an issue.created gives the first one). */
  estimate?: { minutes: number | null };
  sprintId?: string | null;
  /** An imported issue's own dates, from the other tracker. */
  imported?: { createdAt?: number | null; resolvedAt?: number | null } | null;
  /**
   * A move to another project (D41): the ids and project keys either side, the sprints it left
   * (by name), and when the issue was created, when the history before the move isn't loaded.
   */
  move?: { from: string; to: string; fromProject: string; toProject: string; leftSprints?: string[]; created?: number | null };
  /** The field a report follows, when the event set it: its value as shown after it (null: emptied). */
  value?: { to: string | null };
}

export interface Standing {
  at: number;
  state: string | null;
  resolved: boolean;
}

export interface Timeline {
  rid: string;
  summary: string;
  /** When it began to exist. */
  start: number;
  /** When it was deleted, or null. */
  end: number | null;
  /** How it stood, from each instant on, in order. */
  standings: Standing[];
  estimates: { at: number; minutes: number | null }[];
  sprints: { at: number; sprintId: string; added: boolean }[];
  /** When it was in another project than the report's: just before any instant in (from, to]. */
  outside: { from: number; to: number | null }[];
  /** Created in the report's projects, rather than moved in. */
  bornInside: boolean;
  /** The followed field's value as shown, from each instant on (empty when no field is followed). */
  values: { at: number; value: string | null }[];
  /** Its project, by key, from each instant on: where it began, then each move's. */
  projects: { at: number; key: string }[];
}

/** The project key of a readable id: BACK of BACK-12. */
const keyOf = (rid: string) => rid.slice(0, Math.max(0, rid.lastIndexOf('-'))).toUpperCase();

const SHAPING = new Set(['issue.created', 'issue.updated', 'issue.deleted', 'issue.moved']);

/** The sprint id a move's leaving of a sprint is filed under, until the service knows the sprint. */
export const leftSprint = (name: string) => `left:${name.trim().toLowerCase()}`;

export interface TimelineOptions {
  /** Whether a project, by key, is one of the report's. Without it, all of them are. */
  inScope?: (projectKey: string) => boolean;
}

/**
 * Timelines from events (any order). `openState` names the state an imported issue had before its
 * resolution, per readable id (the project's first open state).
 */
export function buildTimelines(
  events: HistoryEvent[],
  openState: (rid: string) => string | null = () => null,
  opts: TimelineOptions = {},
): Map<string, Timeline> {
  // One history per issue across its moves: each move joins the id it left to the one it took.
  const parent = new Map<string, string>();
  const root = (rid: string): string => {
    let r = rid;
    while (parent.has(r)) r = parent.get(r)!;
    return r;
  };
  for (const e of [...events].sort((a, b) => a.id - b.id)) {
    if (!e.move) continue;
    const a = root(e.move.from);
    const b = root(e.move.to);
    if (a !== b) parent.set(a, b);
  }
  const byIssue = new Map<string, HistoryEvent[]>();
  for (const e of events) {
    const key = parent.size ? root(e.rid) : e.rid;
    const list = byIssue.get(key);
    if (list) list.push(e);
    else byIssue.set(key, [e]);
  }
  const out = new Map<string, Timeline>();
  for (const list of byIssue.values()) {
    list.sort((a, b) => a.id - b.id);
    const created = list.find((e) => e.type === 'issue.created');
    const first = created ?? list.find((e) => SHAPING.has(e.type)) ?? list[0]!;
    let start = first.at;
    const firstMove = list.find((e) => e.move);
    if (!created && firstMove?.move?.created != null) start = Math.min(start, firstMove.move.created);
    // Where it was before its first move: where that move took it from.
    let project: string | null = firstMove ? firstMove.move!.fromProject : null;
    const inside = () => project === null || !opts.inScope || opts.inScope(project);
    const t: Timeline = {
      rid: list[list.length - 1]!.rid,
      summary: '',
      start,
      end: null,
      standings: [],
      estimates: [],
      sprints: [],
      outside: inside() ? [] : [{ from: Number.NEGATIVE_INFINITY, to: null }],
      bornInside: created ? inside() : !firstMove,
      values: [],
      projects: [{ at: start, key: project ?? keyOf(first.rid) }],
    };
    const push = (at: number, state: string | null, resolved: boolean) => {
      const last = t.standings[t.standings.length - 1];
      if (last && last.state === state && last.resolved === resolved) return;
      if (last && at < last.at) at = last.at;
      t.standings.push({ at, state, resolved });
    };
    if (created?.imported?.createdAt !== undefined && created.imported.createdAt !== null) {
      start = Math.min(created.imported.createdAt, created.at);
      t.start = start;
      const resolvedAt = created.imported.resolvedAt ?? null;
      if (created.resolved && resolvedAt !== null && resolvedAt > start) {
        push(start, openState(created.rid), false);
        push(Math.min(resolvedAt, created.at), created.state ?? null, true);
      } else {
        push(start, created.state ?? null, created.resolved ?? false);
      }
      if (created.estimate) t.estimates.push({ at: start, minutes: created.estimate.minutes });
    }
    let seenInside = false;
    let lastSummary = '';
    for (const e of list) {
      const at = Math.max(e.at, start);
      if (e.move) {
        const was = inside();
        project = e.move.toProject;
        const now = inside();
        if (was && !now) t.outside.push({ from: at, to: null });
        else if (!was && now) t.outside[t.outside.length - 1]!.to = at;
        t.projects.push({ at, key: e.move.toProject.toUpperCase() });
        for (const name of e.move.leftSprints ?? []) t.sprints.push({ at, sprintId: leftSprint(name), added: false });
      }
      if (e.summary) lastSummary = e.summary;
      if (inside()) {
        // Known by the id, and summary, it had in the report's projects.
        t.rid = e.rid;
        if (e.summary) t.summary = e.summary;
        seenInside = true;
      }
      if (e.value) {
        const v = e.value.to;
        if (t.values[t.values.length - 1]?.value !== v || !t.values.length) t.values.push({ at, value: v });
      }
      if (e.type === 'sprint.issue_added' || e.type === 'sprint.issue_removed') {
        if (e.sprintId) t.sprints.push({ at, sprintId: e.sprintId, added: e.type === 'sprint.issue_added' });
        continue;
      }
      if (!SHAPING.has(e.type)) continue;
      if (e.type === 'issue.deleted') {
        t.end = at;
        continue;
      }
      if (e === created && created.imported?.createdAt != null) continue; // already placed at its own dates
      if (e.state !== undefined || e.resolved !== undefined) {
        const last = t.standings[t.standings.length - 1];
        push(at, e.state === undefined ? (last?.state ?? null) : e.state, e.resolved ?? last?.resolved ?? false);
      }
      if (e.estimate) t.estimates.push({ at, minutes: e.estimate.minutes });
    }
    if (!seenInside) t.summary = lastSummary;
    if (!t.standings.length) t.standings.push({ at: start, state: null, resolved: false });
    out.set(t.rid, t);
  }
  return out;
}

/** The last entry at or after which `ms` falls: what held just before the instant `ms`. */
function lastBefore<T extends { at: number }>(list: T[], ms: number): T | undefined {
  let lo = 0;
  let hi = list.length - 1;
  let found: T | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.at < ms) {
      found = list[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Was it in the report's projects just before `ms`? (Always, for an issue that never moved.) */
export function insideBefore(t: Timeline, ms: number): boolean {
  for (const o of t.outside) if (o.from < ms && (o.to === null || ms <= o.to)) return false;
  return true;
}

/** Was it in the report's projects at some instant in (start, end]? */
export function insideDuring(t: Timeline, start: number, end: number): boolean {
  return !t.outside.some((o) => o.from <= start && (o.to === null || o.to >= end));
}

/** The first instant in [a, b) from which it was in the report's projects, or null. */
export function firstInside(t: Timeline, a: number, b: number): number | null {
  let x = a;
  for (const o of t.outside) {
    if (o.from <= x && (o.to === null || o.to > x)) {
      if (o.to === null) return null;
      x = o.to;
    }
  }
  return x < b ? x : null;
}

/** Did the issue exist just before `ms`, wherever it was? (Created before it, and not deleted before it.) */
export function aliveBefore(t: Timeline, ms: number): boolean {
  return t.start < ms && (t.end === null || t.end >= ms);
}

/** Did the issue exist just before `ms`, in the report's projects? */
export function existsBefore(t: Timeline, ms: number): boolean {
  return aliveBefore(t, ms) && insideBefore(t, ms);
}

/**
 * Does a change at `at` count in the report's projects: made there, and not by arriving there?
 * Its creation counts when it was created there.
 */
export function changedInside(t: Timeline, at: number): boolean {
  return insideBefore(t, at + 1) && (at === t.start ? t.bornInside : insideBefore(t, at));
}

/** How it stood just before `ms`: after every event earlier than it. */
export function standingBefore(t: Timeline, ms: number): Standing | null {
  return lastBefore(t.standings, ms) ?? null;
}

export function estimateBefore(t: Timeline, ms: number): number | null {
  return lastBefore(t.estimates, ms)?.minutes ?? null;
}

/** Its project's key just before `ms`. */
export function projectBefore(t: Timeline, ms: number): string {
  return (lastBefore(t.projects, ms) ?? t.projects[0]!).key;
}

/** The followed field's value as shown just before `ms`; null when it had none. */
export function valueBefore(t: Timeline, ms: number): string | null {
  return lastBefore(t.values, ms)?.value ?? null;
}

/**
 * Whether the issue was in the sprint just before `ms`. `legacy` issues are in it now without any
 * record of joining (they joined before a4a recorded sprint changes): they count from `since`.
 */
export function inSprintBefore(t: Timeline, sprintId: string, ms: number, legacySince: number | null): boolean {
  let member = legacySince !== null && legacySince < ms;
  for (const s of t.sprints) {
    if (s.at >= ms) break;
    if (s.sprintId === sprintId) member = s.added;
  }
  return member;
}
