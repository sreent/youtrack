/**
 * The arithmetic of the history reports D44 adds: average age, and time in state. Pure and
 * deterministic like engine.ts: the service passes in "now", and a day's figure is how things
 * stood at its end (now, for today).
 */
import { aliveBefore, changedInside, existsBefore, insideBefore, standingBefore, type Timeline } from './history';
import type { DayBounds } from './tz';

const DAY = 86_400_000;

/** The instant a day's figure is taken at: its end, or now for today. Null for days to come. */
function asOf(bounds: DayBounds, i: number, now: number): number | null {
  if (bounds.starts[i]! > now) return null;
  return Math.min(bounds.ends[i]!, now + 1);
}

function median(sorted: number[]): number | null {
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ---------------------------------------------------------------------------
// Average age
// ---------------------------------------------------------------------------

export interface AgeDay {
  date: string;
  open: number;
  averageDays: number | null;
  medianDays: number | null;
}

export interface AgeByValue {
  /** The value as history shows it; '' for none. */
  value: string;
  open: number;
  averageDays: number | null;
  oldestDays: number | null;
  days: (number | null)[];
}

export interface AgeResult {
  days: AgeDay[];
  values: AgeByValue[];
  oldest: { rid: string; summary: string; created: number; days: number }[];
}

/**
 * Each day, the issues open at its end in the report's projects, and their age: days since each
 * was created (wherever that was). With `split`, also by the values the followed field had then:
 * an issue with several counts under each.
 */
export function averageAge(timelines: Timeline[], bounds: DayBounds, now: number, split?: (t: Timeline, at: number) => string[]): AgeResult {
  const days: AgeDay[] = [];
  const byValue = new Map<string, { sums: number[]; counts: number[]; oldest: number }>();
  let last: { t: Timeline; age: number }[] = [];
  const n = bounds.dates.length;
  for (let i = 0; i < n; i++) {
    const at = asOf(bounds, i, now);
    if (at === null) break;
    const ages: number[] = [];
    const open: { t: Timeline; age: number }[] = [];
    for (const t of timelines) {
      if (!existsBefore(t, at) || standingBefore(t, at)?.resolved) continue;
      const age = (Math.min(at, now) - t.start) / DAY;
      ages.push(age);
      open.push({ t, age });
      if (!split) continue;
      for (const v of new Set(split(t, at))) {
        let row = byValue.get(v);
        if (!row) byValue.set(v, (row = { sums: new Array(n).fill(0), counts: new Array(n).fill(0), oldest: 0 }));
        row.sums[i] += age;
        row.counts[i]++;
      }
    }
    ages.sort((a, b) => a - b);
    days.push({
      date: bounds.dates[i]!,
      open: ages.length,
      averageDays: ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : null,
      medianDays: median(ages),
    });
    last = open;
  }
  const lastDay = days.length - 1;
  const values: AgeByValue[] = [];
  if (split && lastDay >= 0) {
    for (const o of last) for (const v of new Set(split(o.t, asOf(bounds, lastDay, now)!))) {
      const row = byValue.get(v);
      if (row) row.oldest = Math.max(row.oldest, o.age);
    }
    for (const [value, row] of byValue) {
      const open = row.counts[lastDay] ?? 0;
      values.push({
        value,
        open,
        averageDays: open ? row.sums[lastDay]! / open : null,
        oldestDays: open ? row.oldest : null,
        days: days.map((_, i) => (row.counts[i] ? row.sums[i]! / row.counts[i]! : null)),
      });
    }
  }
  const oldest = [...last]
    .sort((a, b) => b.age - a.age)
    .slice(0, 10)
    .map((o) => ({ rid: o.t.rid, summary: o.t.summary, created: o.t.start, days: o.age }));
  return { days, values, oldest };
}

// ---------------------------------------------------------------------------
// Time in state
// ---------------------------------------------------------------------------

/** Where an issue was, from each instant on: a state, or a board's column; null for none of them. */
export type Track = (t: Timeline) => { at: number; key: string | null }[];

/** The issue's track by state. */
export const byState: Track = (t) => t.standings.map((s) => ({ at: s.at, key: s.state }));

/** Of [a, b), the time the issue spent in the report's projects. */
function insideMs(t: Timeline, a: number, b: number): number {
  if (b <= a) return 0;
  let ms = b - a;
  for (const o of t.outside) {
    const lo = Math.max(a, o.from);
    const hi = Math.min(b, o.to ?? Number.POSITIVE_INFINITY);
    if (hi > lo) ms -= hi - lo;
  }
  return Math.max(0, ms);
}

export interface StayIssue {
  rid: string;
  summary: string;
  resolved: number;
  /** Time in each key, ms. */
  ms: Map<string, number>;
}

export interface Ongoing {
  rid: string;
  summary: string;
  key: string;
  /** Since when it has been there (in the report's projects). */
  since: number;
  start: number;
}

/**
 * For each issue resolved in [from, to), resolved in the report's projects and still resolved at
 * the end: the time it spent in each state (or column) from its creation to that resolution, while
 * in the report's projects. And for each issue open there at `to`: where it is, and since when.
 */
export function timeInStates(timelines: Iterable<Timeline>, from: number, to: number, track: Track): { issues: StayIssue[]; ongoing: Ongoing[] } {
  const issues: StayIssue[] = [];
  const ongoing: Ongoing[] = [];
  for (const t of timelines) {
    if (!aliveBefore(t, to)) continue;
    const end = standingBefore(t, to);
    const path = track(t);
    if (!end?.resolved) {
      if (!insideBefore(t, to)) continue;
      // Where it is now, and since when: the start of its stay there, or its arrival.
      let key: string | null = null;
      let since = t.start;
      for (const p of path) {
        if (p.at >= to) break;
        if (p.key !== key) {
          key = p.key;
          since = p.at;
        }
      }
      const arrived = t.outside.filter((o) => o.to !== null && o.to < to).at(-1)?.to;
      if (key !== null) ongoing.push({ rid: t.rid, summary: t.summary, key, since: Math.max(since, arrived ?? since), start: t.start });
      continue;
    }
    let resolvedAt: number | null = null;
    let was = false;
    for (const s of t.standings) {
      if (s.at >= to) break;
      if (s.resolved && !was) resolvedAt = s.at;
      was = s.resolved;
    }
    if (resolvedAt === null || resolvedAt < from || !changedInside(t, resolvedAt)) continue;
    const ms = new Map<string, number>();
    for (let i = 0; i < path.length; i++) {
      const p = path[i]!;
      if (p.at >= resolvedAt) break;
      if (p.key === null) continue;
      const next = Math.min(path[i + 1]?.at ?? resolvedAt, resolvedAt);
      const spent = insideMs(t, Math.max(p.at, t.start), next);
      if (spent > 0) ms.set(p.key, (ms.get(p.key) ?? 0) + spent);
    }
    issues.push({ rid: t.rid, summary: t.summary, resolved: resolvedAt, ms });
  }
  issues.sort((a, b) => a.resolved - b.resolved);
  ongoing.sort((a, b) => a.since - b.since);
  return { issues, ongoing };
}

export const toDays = (ms: number) => ms / DAY;
