/**
 * An issue's history, rebuilt from its activity: when it began to exist and when it was deleted,
 * how it stood (its state, and whether that was resolved) from each change on, its estimate, and
 * which sprints it was in. Pure: the service loads the events, this orders and reads them.
 *
 * - An issue is known by its readable id (BACK-12), which every event carries and which is never
 *   used again; a deleted issue's rows lose their issue id but keep it.
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
}

const SHAPING = new Set(['issue.created', 'issue.updated', 'issue.deleted']);

/**
 * Timelines from events (any order). `openState` names the state an imported issue had before its
 * resolution, per readable id (the project's first open state).
 */
export function buildTimelines(events: HistoryEvent[], openState: (rid: string) => string | null = () => null): Map<string, Timeline> {
  const byIssue = new Map<string, HistoryEvent[]>();
  for (const e of events) {
    const list = byIssue.get(e.rid);
    if (list) list.push(e);
    else byIssue.set(e.rid, [e]);
  }
  const out = new Map<string, Timeline>();
  for (const [rid, list] of byIssue) {
    list.sort((a, b) => a.id - b.id);
    const created = list.find((e) => e.type === 'issue.created');
    const first = created ?? list.find((e) => SHAPING.has(e.type)) ?? list[0]!;
    let start = first.at;
    const t: Timeline = { rid, summary: '', start, end: null, standings: [], estimates: [], sprints: [] };
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
        push(start, openState(rid), false);
        push(Math.min(resolvedAt, created.at), created.state ?? null, true);
      } else {
        push(start, created.state ?? null, created.resolved ?? false);
      }
      if (created.estimate) t.estimates.push({ at: start, minutes: created.estimate.minutes });
    }
    for (const e of list) {
      if (e.summary) t.summary = e.summary;
      const at = Math.max(e.at, start);
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
    if (!t.standings.length) t.standings.push({ at: start, state: null, resolved: false });
    out.set(rid, t);
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

/** Did the issue exist just before `ms`? (Created before it, and not deleted before it.) */
export function existsBefore(t: Timeline, ms: number): boolean {
  return t.start < ms && (t.end === null || t.end >= ms);
}

/** How it stood just before `ms`: after every event earlier than it. */
export function standingBefore(t: Timeline, ms: number): Standing | null {
  return lastBefore(t.standings, ms) ?? null;
}

export function estimateBefore(t: Timeline, ms: number): number | null {
  return lastBefore(t.estimates, ms)?.minutes ?? null;
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
