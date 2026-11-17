/**
 * The reports' arithmetic over rebuilt histories (history.ts) and day boundaries (tz.ts). Pure
 * and deterministic: the service passes in "now", so a test can stand on any day.
 *
 * A day's figure is how things stood at its end: after every event before the next day began.
 * Today's is how they stand now; days to come have none.
 */
import { aliveBefore, changedInside, estimateBefore, existsBefore, firstInside, inSprintBefore, standingBefore, type Timeline } from './history';
import type { DayBounds } from './tz';

// ---------------------------------------------------------------------------
// Cumulative flow
// ---------------------------------------------------------------------------

export interface StateInfo {
  name: string;
  resolved: boolean;
  tone: 'good' | 'warn' | 'bad' | 'idle' | null;
  current: boolean;
}

export interface FlowResult {
  states: StateInfo[];
  days: { date: string; counts: number[]; total: number }[];
  noState: number;
}

/** The instant a day's figure is taken at: its end, or now for today. Null for days to come. */
function asOf(bounds: DayBounds, i: number, now: number): number | null {
  if (bounds.starts[i]! > now) return null;
  return Math.min(bounds.ends[i]!, now + 1);
}

/** Issues in each state at the end of each day. States history knows but the field doesn't come last. */
export function cumulativeFlow(timelines: Iterable<Timeline>, bounds: DayBounds, now: number, known: StateInfo[]): FlowResult {
  const states = [...known];
  const index = new Map(states.map((s, i) => [s.name.toLowerCase(), i]));
  const days = bounds.dates.map((date) => ({ date, counts: new Array<number>(states.length).fill(0), total: 0 }));
  let noState = 0;
  const lastDay = days.length - 1;
  for (const t of timelines) {
    for (let i = 0; i < days.length; i++) {
      const at = asOf(bounds, i, now);
      if (at === null) break;
      if (!existsBefore(t, at)) continue;
      const s = standingBefore(t, at);
      days[i]!.total++;
      if (!s?.state) {
        if (i === lastDay) noState++;
        continue;
      }
      let k = index.get(s.state.toLowerCase());
      if (k === undefined) {
        k = states.length;
        states.push({ name: s.state, resolved: s.resolved, tone: null, current: false });
        index.set(s.state.toLowerCase(), k);
        for (const d of days) d.counts.push(0);
      }
      days[i]!.counts[k]!++;
    }
  }
  // A state history knows but nobody was in during the window adds nothing; keep the field's own.
  const used = states.map((s, k) => s.current || days.some((d) => d.counts[k]! > 0));
  return {
    states: states.filter((_, k) => used[k]),
    days: days.filter((d, i) => asOf(bounds, i, now) !== null).map((d) => ({ ...d, counts: d.counts.filter((_, k) => used[k]) })),
    noState,
  };
}

// ---------------------------------------------------------------------------
// Created against resolved
// ---------------------------------------------------------------------------

export interface Bucket {
  from: string;
  to: string;
  start: number;
  end: number;
}

export interface CreatedResolvedRow {
  from: string;
  to: string;
  created: number;
  resolved: number;
  reopened: number;
  open: number;
}

function bucketOf(buckets: Bucket[], ms: number): number {
  let lo = 0;
  let hi = buckets.length - 1;
  if (!buckets.length || ms < buckets[0]!.start || ms >= buckets[hi]!.end) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (buckets[mid]!.start <= ms) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Per bucket: issues created, resolutions (an issue resolved, opened again and resolved again counts
 * twice, beside one reopening), and how many were open at its end. An issue created resolved counts
 * as created and resolved at once.
 */
export function createdResolved(timelines: Iterable<Timeline>, buckets: Bucket[], now: number): CreatedResolvedRow[] {
  const rows = buckets.map((b) => ({ from: b.from, to: b.to, created: 0, resolved: 0, reopened: 0, open: 0 }));
  const list = [...timelines];
  for (const t of list) {
    // Moved in, an issue arrives: it wasn't created here, nor resolved by arriving resolved (D41).
    const c = t.bornInside ? bucketOf(buckets, t.start) : -1;
    if (c >= 0) rows[c]!.created++;
    let wasResolved = false;
    for (const s of t.standings) {
      if (t.end !== null && s.at > t.end) break;
      if (s.resolved !== wasResolved) {
        const b = changedInside(t, s.at) ? bucketOf(buckets, s.at) : -1;
        if (b >= 0) rows[b]![s.resolved ? 'resolved' : 'reopened']++;
        wasResolved = s.resolved;
      }
    }
  }
  buckets.forEach((b, i) => {
    if (b.start > now) return;
    const at = Math.min(b.end, now + 1);
    rows[i]!.open = list.filter((t) => existsBefore(t, at) && !standingBefore(t, at)?.resolved).length;
  });
  return rows.filter((_, i) => buckets[i]!.start <= now);
}

// ---------------------------------------------------------------------------
// Cycle time
// ---------------------------------------------------------------------------

export interface CycleItem {
  rid: string;
  summary: string;
  started: number;
  resolved: number;
  days: number;
  reopened: boolean;
}

export interface CycleResult {
  items: CycleItem[];
  notStarted: { rid: string; summary: string; resolved: number }[];
}

/**
 * Issues resolved in [from, to) and still resolved at its end: from the first time each entered a
 * start state to its last resolution. Calendar time, in days.
 */
export function cycleTimes(timelines: Iterable<Timeline>, from: number, to: number, startStates: string[]): CycleResult {
  const starts = new Set(startStates.map((s) => s.trim().toLowerCase()));
  const items: CycleItem[] = [];
  const notStarted: CycleResult['notStarted'] = [];
  for (const t of timelines) {
    // Resolved here and moved away since, it still counts here; resolved elsewhere, it doesn't.
    if (!aliveBefore(t, to)) continue;
    const end = standingBefore(t, to);
    if (!end?.resolved) continue;
    // Its last resolution: the latest move from open to resolved (or its creation, resolved).
    let resolvedAt: number | null = null;
    let resolutions = 0;
    let was = false;
    for (const s of t.standings) {
      if (s.at >= to) break;
      if (s.resolved && !was) {
        resolvedAt = s.at;
        resolutions++;
      }
      was = s.resolved;
    }
    if (resolvedAt === null || resolvedAt < from || !changedInside(t, resolvedAt)) continue;
    // The clock starts the first time it was in a start state in the report's projects (D41).
    let started: number | null = null;
    for (let i = 0; i < t.standings.length && started === null; i++) {
      const s = t.standings[i]!;
      if (s.at > resolvedAt) break;
      if (s.state === null || !starts.has(s.state.toLowerCase())) continue;
      started = firstInside(t, s.at, Math.max(t.standings[i + 1]?.at ?? resolvedAt, s.at + 1));
    }
    if (started === null) {
      notStarted.push({ rid: t.rid, summary: t.summary, resolved: resolvedAt });
      continue;
    }
    items.push({
      rid: t.rid,
      summary: t.summary,
      started,
      resolved: resolvedAt,
      days: Math.round(((resolvedAt - started) / 86_400_000) * 100) / 100,
      reopened: resolutions > 1,
    });
  }
  items.sort((a, b) => a.resolved - b.resolved);
  notStarted.sort((a, b) => a.resolved - b.resolved);
  return { items, notStarted };
}

/** Nearest-rank percentile of sorted values: the smallest value with at least p% at or below it. */
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

const WIDTHS = [0.25, 0.5, 1, 2, 3, 5, 7, 14, 30, 60, 90, 180];

/** Equal buckets from 0 past the largest value, no more than 20 of them. */
export function histogram(values: number[]): { width: number; buckets: { from: number; to: number; count: number }[] } {
  if (!values.length) return { width: 1, buckets: [] };
  const max = Math.max(...values);
  const width = WIDTHS.find((w) => Math.floor(max / w) + 1 <= 20) ?? Math.ceil((max + 1) / 20);
  const n = Math.floor(max / width) + 1;
  const buckets = Array.from({ length: n }, (_, i) => ({ from: i * width, to: (i + 1) * width, count: 0 }));
  for (const v of values) buckets[Math.min(n - 1, Math.floor(v / width))]!.count++;
  return { width, buckets };
}

// ---------------------------------------------------------------------------
// Sprint burndown
// ---------------------------------------------------------------------------

export type BurnKind = 'added' | 'removed' | 'deleted' | 'resolved' | 'reopened' | 'estimate';

export interface BurnChange {
  at: number;
  rid: string;
  summary: string;
  kind: BurnKind;
  amount: number;
}

export interface BurnDay {
  date: string;
  remaining: number | null;
  ideal: number;
  completed: number;
  added: number;
  removed: number;
  reopened: number;
}

export interface BurnInput {
  timelines: Timeline[];
  sprintId: string;
  /** Issues in the sprint with no record of joining it: in it from this instant. */
  legacy: Map<string, number>;
  /** The sprint's working days, each with when it begins and ends. */
  days: { date: string; start: number; end: number }[];
  /** The start of the sprint's first day: what's in it then is what was committed. */
  start: number;
  /** The end of its last day. */
  end: number;
  now: number;
  by: 'estimate' | 'count';
}

export interface BurnResult {
  start: number;
  remaining: number;
  /** Issues in the sprint and open, now (or at its end): what "done" waits on, estimated or not. */
  open: number;
  days: BurnDay[];
  changes: BurnChange[];
  members: string[];
  unestimated: string[];
}

/** What an issue adds to what's left at an instant: nothing unless it's in the sprint, exists and is open. */
function share(t: Timeline, input: BurnInput, ms: number): number {
  if (!existsBefore(t, ms)) return 0;
  if (!inSprintBefore(t, input.sprintId, ms, input.legacy.get(t.rid) ?? null)) return 0;
  if (standingBefore(t, ms)?.resolved) return 0;
  return input.by === 'count' ? 1 : (estimateBefore(t, ms) ?? 0);
}

/**
 * What was committed, what's left at the end of each working day, the ideal line, and every change
 * of scope or progress between the sprint's start and now (or its end).
 */
export function burndown(input: BurnInput): BurnResult {
  const { timelines, start, now } = input;
  const until = Math.min(now + 1, input.end);
  const changes: BurnChange[] = [];
  const members: string[] = [];
  const unestimated: string[] = [];
  let committed = 0;
  for (const t of timelines) {
    committed += share(t, input, start);
    // Every instant something about this issue changed inside the sprint: see what that did.
    const instants = new Set<number>();
    for (const s of t.standings) if (s.at >= start && s.at < until) instants.add(s.at);
    for (const e of t.estimates) if (e.at >= start && e.at < until) instants.add(e.at);
    for (const s of t.sprints) if (s.sprintId === input.sprintId && s.at >= start && s.at < until) instants.add(s.at);
    if (t.start >= start && t.start < until) instants.add(t.start);
    if (t.end !== null && t.end >= start && t.end < until) instants.add(t.end);
    const legacy = input.legacy.get(t.rid);
    if (legacy !== undefined && legacy >= start && legacy < until) instants.add(legacy);
    let ever = share(t, input, start) > 0 || inSprintBefore(t, input.sprintId, start, legacy ?? null);
    for (const at of [...instants].sort((a, b) => a - b)) {
      const before = share(t, input, at);
      const after = share(t, input, at + 1);
      const inBefore = existsBefore(t, at) && inSprintBefore(t, input.sprintId, at, legacy ?? null);
      const inAfter = existsBefore(t, at + 1) && inSprintBefore(t, input.sprintId, at + 1, legacy ?? null);
      if (inAfter) ever = true;
      if (before === after) continue;
      const wasResolved = standingBefore(t, at)?.resolved ?? false;
      const isResolved = standingBefore(t, at + 1)?.resolved ?? false;
      let kind: BurnKind;
      if (inBefore && !inAfter) kind = t.end !== null && t.end === at ? 'deleted' : 'removed';
      else if (!inBefore && inAfter) kind = 'added';
      else if (!wasResolved && isResolved) kind = 'resolved';
      else if (wasResolved && !isResolved) kind = 'reopened';
      else kind = 'estimate';
      changes.push({ at, rid: t.rid, summary: t.summary, kind, amount: after - before });
    }
    if (ever) {
      members.push(t.rid);
      if (input.by === 'estimate' && existsBefore(t, until) && inSprintBefore(t, input.sprintId, until, legacy ?? null) && estimateBefore(t, until) === null) {
        unestimated.push(t.rid);
      }
    }
  }
  changes.sort((a, b) => a.at - b.at || a.rid.localeCompare(b.rid));

  const n = input.days.length;
  const days: BurnDay[] = input.days.map((d, i) => ({
    date: d.date,
    remaining: null,
    ideal: n ? Math.round(committed * (1 - (i + 1) / n) * 100) / 100 : 0,
    completed: 0,
    added: 0,
    removed: 0,
    reopened: 0,
  }));
  // A change belongs to the first working day that ends after it (a weekend's to the Monday).
  let k = 0;
  for (const c of changes) {
    while (k < n && input.days[k]!.end <= c.at) k++;
    const day = days[Math.min(k, n - 1)];
    if (!day) continue;
    if (c.kind === 'resolved') day.completed += -c.amount;
    else if (c.kind === 'reopened') day.reopened += c.amount;
    else if (c.amount > 0) day.added += c.amount;
    else day.removed += -c.amount;
  }
  input.days.forEach((d, i) => {
    if (d.start > now) return;
    const at = Math.min(d.end, now + 1);
    let left = 0;
    for (const t of timelines) left += share(t, input, at);
    days[i]!.remaining = round(left);
  });
  // What's left now: before the sprint, its scope as it stands; after it, what its end left.
  const at = start > now ? now + 1 : until;
  let remaining = 0;
  let open = 0;
  const byCount: BurnInput = { ...input, by: 'count' };
  for (const t of timelines) {
    remaining += share(t, input, at);
    open += share(t, byCount, at);
  }
  for (const d of days) {
    d.completed = round(d.completed);
    d.added = round(d.added);
    d.removed = round(d.removed);
    d.reopened = round(d.reopened);
  }
  return { start: round(committed), remaining: round(remaining), open, days, changes, members, unestimated };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
