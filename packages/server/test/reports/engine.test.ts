import { describe, expect, it } from 'vitest';
import { burndown, createdResolved, cumulativeFlow, cycleTimes, histogram, percentile, type Bucket, type StateInfo } from '../../src/reports/engine';
import { buildTimelines, existsBefore, standingBefore, type HistoryEvent } from '../../src/reports/history';
import { dayBounds, dayIndex, localDate, startOfDay } from '../../src/reports/tz';

const T = (iso: string) => Date.parse(iso);
let seq = 0;
const ev = (rid: string, at: string, type: string, extra: Partial<HistoryEvent> = {}): HistoryEvent => ({ id: ++seq, at: T(at), type, rid, summary: rid, ...extra });
const created = (rid: string, at: string, state = 'Open', minutes: number | null = null, resolved = false) =>
  ev(rid, at, 'issue.created', { state, resolved, estimate: { minutes } });
const moved = (rid: string, at: string, state: string, resolved = false) => ev(rid, at, 'issue.updated', { state, resolved });
const estimated = (rid: string, at: string, state: string, minutes: number | null) => ev(rid, at, 'issue.updated', { state, resolved: false, estimate: { minutes } });
const deleted = (rid: string, at: string, state = 'Open') => ev(rid, at, 'issue.deleted', { state, resolved: false });
const joined = (rid: string, at: string, sprintId = 'sp') => ev(rid, at, 'sprint.issue_added', { sprintId });
const left = (rid: string, at: string, sprintId = 'sp') => ev(rid, at, 'sprint.issue_removed', { sprintId });

const STATES: StateInfo[] = [
  { name: 'Open', resolved: false, tone: null, current: true },
  { name: 'In Progress', resolved: false, tone: null, current: true },
  { name: 'Fixed', resolved: true, tone: 'good', current: true },
];

describe('days in a time zone', () => {
  it('starts a day at local midnight, across a change of clocks', () => {
    expect(new Date(startOfDay('2026-11-10', 'UTC')).toISOString()).toBe('2026-11-10T00:00:00.000Z');
    expect(new Date(startOfDay('2026-11-10', 'Europe/Berlin')).toISOString()).toBe('2026-11-09T23:00:00.000Z');
    expect(new Date(startOfDay('2026-07-10', 'Europe/Berlin')).toISOString()).toBe('2026-07-09T22:00:00.000Z');
    expect(new Date(startOfDay('2026-11-10', 'America/New_York')).toISOString()).toBe('2026-11-10T05:00:00.000Z');
    // Berlin's clocks went back on 25 Oct 2026: that day is 25 hours long.
    const b = dayBounds('2026-10-25', '2026-10-26', 'Europe/Berlin');
    expect(b.ends[0]! - b.starts[0]!).toBe(25 * 3_600_000);
    // and forward on 29 Mar 2026: 23 hours.
    const f = dayBounds('2026-03-29', '2026-03-29', 'Europe/Berlin');
    expect(f.ends[0]! - f.starts[0]!).toBe(23 * 3_600_000);
  });

  it('puts an instant near midnight on the day its reader is in', () => {
    const late = T('2026-11-10T23:30:00Z');
    expect(localDate(late, 'UTC')).toBe('2026-11-10');
    expect(localDate(late, 'Europe/Berlin')).toBe('2026-11-11');
    expect(localDate(late, 'America/New_York')).toBe('2026-11-10');
    const b = dayBounds('2026-11-10', '2026-11-11', 'Europe/Berlin');
    expect(dayIndex(b, late)).toBe(1);
    // Exactly midnight belongs to the day it begins.
    expect(dayIndex(b, startOfDay('2026-11-11', 'Europe/Berlin'))).toBe(1);
    expect(dayIndex(b, startOfDay('2026-11-11', 'Europe/Berlin') - 1)).toBe(0);
    expect(dayIndex(b, T('2026-11-01T00:00:00Z'))).toBe(-1);
    expect(dayIndex(b, T('2026-12-01T00:00:00Z'))).toBe(2);
  });
});

describe('rebuilding an issue\'s history', () => {
  it('reads how it stood after each event, and when it was deleted', () => {
    const tl = buildTimelines([created('A-1', '2026-11-01T09:00:00Z'), moved('A-1', '2026-11-03T09:00:00Z', 'In Progress'), deleted('A-1', '2026-11-05T09:00:00Z', 'In Progress')]).get('A-1')!;
    expect(existsBefore(tl, T('2026-11-01T09:00:00Z'))).toBe(false);
    expect(existsBefore(tl, T('2026-11-01T09:00:01Z'))).toBe(true);
    expect(standingBefore(tl, T('2026-11-03T09:00:00Z'))?.state).toBe('Open');
    expect(standingBefore(tl, T('2026-11-03T10:00:00Z'))?.state).toBe('In Progress');
    expect(existsBefore(tl, T('2026-11-05T09:00:00Z'))).toBe(true);
    expect(existsBefore(tl, T('2026-11-05T09:00:01Z'))).toBe(false);
  });

  it('starts an imported issue at its own created date, open until it was resolved', () => {
    const imported = ev('A-9', '2026-11-10T12:00:00Z', 'issue.created', {
      state: 'Fixed',
      resolved: true,
      estimate: { minutes: 120 },
      imported: { createdAt: T('2026-10-01T08:00:00Z'), resolvedAt: T('2026-10-04T08:00:00Z') },
    });
    const tl = buildTimelines([imported], () => 'Open').get('A-9')!;
    expect(tl.start).toBe(T('2026-10-01T08:00:00Z'));
    expect(standingBefore(tl, T('2026-10-02T00:00:00Z'))).toMatchObject({ state: 'Open', resolved: false });
    expect(standingBefore(tl, T('2026-10-05T00:00:00Z'))).toMatchObject({ state: 'Fixed', resolved: true });
  });
});

describe('cumulative flow', () => {
  it('counts each issue in its state at the end of each day: before the window, inside it, and deleted', () => {
    const tz = 'UTC';
    const events = [
      created('A-1', '2026-10-20T10:00:00Z'), // before the window
      moved('A-1', '2026-11-02T10:00:00Z', 'In Progress'),
      moved('A-1', '2026-11-03T10:00:00Z', 'Fixed', true),
      created('A-2', '2026-11-02T15:00:00Z'),
      deleted('A-2', '2026-11-03T08:00:00Z'), // gone on day 3
      created('A-3', '2026-11-05T10:00:00Z'), // after the window
    ];
    const bounds = dayBounds('2026-11-01', '2026-11-03', tz);
    const res = cumulativeFlow(buildTimelines(events).values(), bounds, T('2026-11-10T00:00:00Z'), STATES);
    expect(res.days.map((d) => [d.date, ...d.counts])).toEqual([
      ['2026-11-01', 1, 0, 0],
      ['2026-11-02', 1, 1, 0],
      ['2026-11-03', 0, 0, 1],
    ]);
  });

  it('keeps a state history knows under its old name, and takes today as it is now', () => {
    const events = [created('A-1', '2026-11-01T10:00:00Z', 'Doing')];
    const bounds = dayBounds('2026-11-01', '2026-11-03', 'UTC');
    const res = cumulativeFlow(buildTimelines(events).values(), bounds, T('2026-11-02T12:00:00Z'), STATES);
    expect(res.states.map((s) => [s.name, s.current])).toContainEqual(['Doing', false]);
    expect(res.days.map((d) => d.date)).toEqual(['2026-11-01', '2026-11-02']); // nothing for days to come
  });
});

describe('created against resolved', () => {
  it('counts a reopened issue as resolved twice and reopened once', () => {
    const events = [
      created('A-1', '2026-11-01T10:00:00Z'),
      moved('A-1', '2026-11-02T10:00:00Z', 'Fixed', true),
      moved('A-1', '2026-11-02T18:00:00Z', 'Open'),
      moved('A-1', '2026-11-03T10:00:00Z', 'Fixed', true),
      created('A-2', '2026-11-03T11:00:00Z', 'Fixed', null, true), // created resolved
    ];
    const b = dayBounds('2026-11-01', '2026-11-03', 'UTC');
    const buckets: Bucket[] = b.dates.map((d, i) => ({ from: d, to: d, start: b.starts[i]!, end: b.ends[i]! }));
    const rows = createdResolved(buildTimelines(events).values(), buckets, T('2026-11-20T00:00:00Z'));
    expect(rows.map((r) => [r.from, r.created, r.resolved, r.reopened, r.open])).toEqual([
      ['2026-11-01', 1, 0, 0, 1],
      ['2026-11-02', 0, 1, 1, 1],
      ['2026-11-03', 1, 2, 0, 0],
    ]);
  });

  it('puts a resolution just before midnight on the day it was in the reader\'s zone', () => {
    const events = [created('A-1', '2026-11-01T10:00:00Z'), moved('A-1', '2026-11-02T23:30:00Z', 'Fixed', true)];
    const count = (tz: string) => {
      const b = dayBounds('2026-11-02', '2026-11-03', tz);
      const buckets: Bucket[] = b.dates.map((d, i) => ({ from: d, to: d, start: b.starts[i]!, end: b.ends[i]! }));
      return createdResolved(buildTimelines(events).values(), buckets, T('2026-11-20T00:00:00Z')).map((r) => r.resolved);
    };
    expect(count('UTC')).toEqual([1, 0]);
    expect(count('Europe/Berlin')).toEqual([0, 1]); // 00:30 on the 3rd in Berlin
    expect(count('America/Los_Angeles')).toEqual([1, 0]);
  });
});

describe('cycle time', () => {
  it('runs from the first start state to the last resolution, and leaves out what never started', () => {
    const events = [
      created('A-1', '2026-11-01T00:00:00Z'),
      moved('A-1', '2026-11-02T00:00:00Z', 'In Progress'),
      moved('A-1', '2026-11-04T12:00:00Z', 'Fixed', true), // 2.5 days
      created('A-2', '2026-11-01T00:00:00Z'),
      moved('A-2', '2026-11-03T00:00:00Z', 'In Progress'),
      moved('A-2', '2026-11-04T00:00:00Z', 'Fixed', true),
      moved('A-2', '2026-11-05T00:00:00Z', 'In Progress'), // reopened
      moved('A-2', '2026-11-07T00:00:00Z', 'Fixed', true), // 4 days from the first start
      created('A-3', '2026-11-01T00:00:00Z'),
      moved('A-3', '2026-11-02T00:00:00Z', 'Fixed', true), // never started
      created('A-4', '2026-11-01T00:00:00Z'),
      moved('A-4', '2026-11-02T00:00:00Z', 'In Progress'),
      moved('A-4', '2026-11-20T00:00:00Z', 'Fixed', true), // after the window
    ];
    const res = cycleTimes(buildTimelines(events).values(), T('2026-11-01T00:00:00Z'), T('2026-11-10T00:00:00Z'), ['in progress']);
    expect(res.items.map((i) => [i.rid, i.days, i.reopened])).toEqual([
      ['A-1', 2.5, false],
      ['A-2', 4, true],
    ]);
    expect(res.notStarted.map((i) => i.rid)).toEqual(['A-3']);
  });

  it('takes percentiles by nearest rank, and buckets of one width', () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(v, 50)).toBe(5);
    expect(percentile(v, 85)).toBe(9);
    expect(percentile(v, 95)).toBe(10);
    expect(percentile([], 50)).toBeNull();
    const h = histogram([0.5, 1.2, 1.9, 7]);
    expect(h.width).toBe(0.5);
    expect(h.buckets.reduce((n, b) => n + b.count, 0)).toBe(4);
    expect(histogram([30, 1]).buckets.length).toBeLessThanOrEqual(20);
  });
});

describe('sprint burndown', () => {
  const tz = 'UTC';
  // Mon 2 Nov to Fri 13 Nov 2026: ten working days.
  const workDays = ['02', '03', '04', '05', '06', '09', '10', '11', '12', '13'].map((d) => `2026-11-${d}`);
  const days = workDays.map((date) => ({ date, start: startOfDay(date, tz), end: startOfDay(date, tz) + 86_400_000 }));
  const start = startOfDay('2026-11-02', tz);
  const end = startOfDay('2026-11-14', tz);
  const run = (events: HistoryEvent[], now: string, by: 'estimate' | 'count' = 'estimate', legacy = new Map<string, number>()) =>
    burndown({ timelines: [...buildTimelines(events).values()], sprintId: 'sp', legacy, days, start, end, now: T(now), by });

  it('commits what is in the sprint at its start, and burns it down by estimate with the ideal line', () => {
    const events = [
      created('A-1', '2026-10-28T09:00:00Z', 'Open', 600),
      joined('A-1', '2026-10-30T09:00:00Z'),
      created('A-2', '2026-10-28T09:00:00Z', 'Open', 600),
      joined('A-2', '2026-10-30T09:00:00Z'),
      moved('A-1', '2026-11-03T15:00:00Z', 'Fixed', true),
    ];
    const res = run(events, '2026-11-20T00:00:00Z');
    expect(res.start).toBe(1200);
    expect(res.days[0]!.remaining).toBe(1200);
    expect(res.days[1]).toMatchObject({ date: '2026-11-03', remaining: 600, completed: 600 });
    expect(res.days.map((d) => d.ideal)).toEqual([1080, 960, 840, 720, 600, 480, 360, 240, 120, 0]);
    expect(res.remaining).toBe(600);
  });

  it('shows scope added mid-sprint, estimates raised, a reopened issue and a deleted one', () => {
    const events = [
      created('A-1', '2026-10-28T09:00:00Z', 'Open', 480),
      joined('A-1', '2026-10-30T09:00:00Z'),
      created('A-2', '2026-11-04T09:00:00Z', 'Open', 240),
      joined('A-2', '2026-11-04T10:00:00Z'), // added on day 3
      estimated('A-1', '2026-11-05T09:00:00Z', 'Open', 600), // raised by 2h on day 4
      moved('A-1', '2026-11-06T09:00:00Z', 'Fixed', true), // done on day 5
      moved('A-1', '2026-11-07T09:00:00Z', 'Open'), // reopened on Saturday: counts on Monday
      deleted('A-2', '2026-11-10T09:00:00Z'), // deleted on day 7
    ];
    const res = run(events, '2026-11-20T00:00:00Z');
    expect(res.start).toBe(480);
    expect(res.days[2]).toMatchObject({ date: '2026-11-04', added: 240, remaining: 720 });
    expect(res.days[3]).toMatchObject({ date: '2026-11-05', added: 120, remaining: 840 });
    expect(res.days[4]).toMatchObject({ date: '2026-11-06', completed: 600, remaining: 240 });
    expect(res.days[5]).toMatchObject({ date: '2026-11-09', reopened: 600, remaining: 840 });
    expect(res.days[6]).toMatchObject({ date: '2026-11-10', removed: 240, remaining: 600 });
    expect(res.changes.map((c) => [c.rid, c.kind, c.amount])).toEqual([
      ['A-2', 'added', 240],
      ['A-1', 'estimate', 120],
      ['A-1', 'resolved', -600],
      ['A-1', 'reopened', 600],
      ['A-2', 'deleted', -240],
    ]);
    // Every day's figure follows from the one before and its changes.
    let prev = res.start;
    for (const d of res.days) {
      expect(d.remaining).toBe(prev + d.added - d.removed - d.completed + d.reopened);
      prev = d.remaining!;
    }
  });

  it('counts issues instead of estimates, and treats legacy members as there from the start', () => {
    const events = [created('A-1', '2026-10-28T09:00:00Z'), created('A-2', '2026-10-28T09:00:00Z'), moved('A-2', '2026-11-05T09:00:00Z', 'Fixed', true)];
    const legacy = new Map([
      ['A-1', start - 1],
      ['A-2', start - 1],
    ]);
    const res = run(events, '2026-11-06T12:00:00Z', 'count', legacy);
    expect(res.start).toBe(2);
    expect(res.days.slice(0, 5).map((d) => d.remaining)).toEqual([2, 2, 2, 1, 1]);
    expect(res.days.slice(5).every((d) => d.remaining === null)).toBe(true); // days to come
    expect(res.remaining).toBe(1);
    expect(res.open).toBe(1);
  });

  it('has nothing to burn in an empty sprint', () => {
    const res = run([], '2026-11-05T12:00:00Z');
    expect(res.start).toBe(0);
    expect(res.members).toEqual([]);
    expect(res.days.filter((d) => d.remaining !== null).every((d) => d.remaining === 0)).toBe(true);
    expect(res.days.every((d) => d.ideal === 0)).toBe(true);
  });

  it('leaves out an issue that left the sprint before it began, and counts one that left during it', () => {
    const events = [
      created('A-1', '2026-10-28T09:00:00Z', 'Open', 60),
      joined('A-1', '2026-10-29T09:00:00Z'),
      left('A-1', '2026-10-31T09:00:00Z'),
      created('A-2', '2026-10-28T09:00:00Z', 'Open', 60),
      joined('A-2', '2026-10-29T09:00:00Z'),
      left('A-2', '2026-11-03T09:00:00Z'),
      joined('A-2', '2026-11-03T10:00:00Z', 'other'),
    ];
    const res = run(events, '2026-11-20T00:00:00Z');
    expect(res.start).toBe(60);
    expect(res.days[1]).toMatchObject({ removed: 60, remaining: 0 });
    expect(res.members).toEqual(['A-2']);
  });
});
