import { describe, expect, it } from 'vitest';
import { computeLoad, computeSchedule, levelResources } from '../../src/planning';
import { hours, plan, span, task } from './fixtures';

describe('computeLoad', () => {
  // Anna has A (2 days) and B (1 day) from Monday: 16h on Monday.
  const input = plan([
    task('A', { assigneeId: 'u-anna', effortMinutes: hours(16) }),
    task('B', { assigneeId: 'u-anna', effortMinutes: hours(8) }),
    task('U', { effortMinutes: hours(8) }),
  ]);
  const schedule = computeSchedule(input);

  it('spreads remaining hours over working days and flags over-allocation', () => {
    const load = computeLoad(input, schedule);
    expect([load.from, load.to, load.unassignedHours]).toEqual(['2026-11-16', '2026-11-17', 8]);
    const anna = load.resources.find((r) => r.resourceId === 'u-anna')!;
    expect(anna.days).toEqual([
      { date: '2026-11-16', hours: 16, capacity: 8, tasks: [{ issue: 'A', hours: 8 }, { issue: 'B', hours: 8 }] },
      { date: '2026-11-17', hours: 8, capacity: 8, tasks: [{ issue: 'A', hours: 8 }] },
    ]);
    expect([anna.totalHours, anna.overallocatedDays, anna.peakLoadPct]).toEqual([24, 1, 200]);
    const ben = load.resources.find((r) => r.resourceId === 'u-ben')!;
    expect([ben.totalHours, ben.overallocatedDays, ben.peakLoadPct, ben.days.length]).toEqual([0, 0, 0, 2]);
  });

  it('reports an explicit window, working days only', () => {
    const load = computeLoad(input, schedule, '2026-11-17', '2026-11-22');
    const anna = load.resources.find((r) => r.resourceId === 'u-anna')!;
    expect(anna.days.map((d) => [d.date, d.hours])).toEqual([
      ['2026-11-17', 8],
      ['2026-11-18', 0],
      ['2026-11-20', 0],
    ]);
  });

  it('places the remaining work of a task in progress from today on', () => {
    const started = plan([
      task('P', { assigneeId: 'u-anna', firstWorkDate: '2026-11-12', effortMinutes: hours(24), spentMinutes: hours(8) }),
    ]);
    const schedule = computeSchedule(started);
    const byDefault = computeLoad(started, schedule); // the default window starts today
    expect([byDefault.from, byDefault.to]).toEqual(['2026-11-16', '2026-11-17']);
    const fromStart = computeLoad(started, schedule, '2026-11-12');
    const anna = fromStart.resources.find((r) => r.resourceId === 'u-anna')!;
    expect(anna.days.map((d) => [d.date, d.hours])).toEqual([
      ['2026-11-12', 0],
      ['2026-11-13', 0],
      ['2026-11-16', 8], // 16h left over the two days still to go
      ['2026-11-17', 8],
    ]);
  });
});

describe('levelResources', () => {
  // Anna: A → C and D → E are equal critical chains (C, E unassigned); B has 4 days of slack.
  // Unlevelled, A, B and D all start Monday 16th: 24h then 16h of work for Anna.
  const input = plan([
    task('A', { assigneeId: 'u-anna', effortMinutes: hours(16) }),
    task('C', { effortMinutes: hours(24), predecessors: ['A'] }),
    task('D', { assigneeId: 'u-anna', effortMinutes: hours(16) }),
    task('E', { effortMinutes: hours(24), predecessors: ['D'] }),
    task('B', { assigneeId: 'u-anna', effortMinutes: hours(8) }),
  ]);

  it('allow_delay removes the over-allocation and may move the finish', () => {
    const r = levelResources(input, 'allow_delay');
    expect([r.finishBefore, r.finishAfter]).toEqual(['2026-11-23', '2026-11-25']);
    expect([r.overallocatedDaysBefore, r.overallocatedDaysAfter]).toEqual([2, 0]);
    expect(r.changes).toEqual([
      { id: 'B', summary: 'Task B', assigneeId: 'u-anna', fromStart: '2026-11-16', fromFinish: '2026-11-16', toStart: '2026-11-23', toFinish: '2026-11-23', delayDays: 4, movedBy: 'resources' },
      { id: 'D', summary: 'Task D', assigneeId: 'u-anna', fromStart: '2026-11-16', fromFinish: '2026-11-17', toStart: '2026-11-18', toFinish: '2026-11-20', delayDays: 2, movedBy: 'resources' },
      // E is unassigned: it moves only because its predecessor did.
      { id: 'E', summary: 'Task E', assigneeId: null, fromStart: '2026-11-18', fromFinish: '2026-11-23', toStart: '2026-11-23', toFinish: '2026-11-25', delayDays: 2, movedBy: 'dependencies' },
    ]);
    expect(r.unresolved).toEqual([]);
    expect(r.levelledStarts).toEqual({ B: '2026-11-23', D: '2026-11-18' });
  });

  it('applying the levelled Start dates reproduces the proposal', () => {
    const withDueDate = plan([...input.tasks, task('F', { deadline: '2026-12-18', predecessors: ['D'] })]);
    const r = levelResources(withDueDate, 'allow_delay');
    const applied = computeSchedule(withDueDate, Object.entries(r.levelledStarts).map(([id, start]) => ({ id, start })));
    expect(applied.finish).toBe(r.finishAfter);
    for (const c of r.changes) expect([c.id, ...span(applied, c.id)]).toEqual([c.id, c.toStart, c.toFinish]);
    expect(r.changes.find((c) => c.id === 'F')).toMatchObject({ toStart: '2026-11-23', toFinish: '2026-11-23', movedBy: 'dependencies' });
  });

  it('within_slack never moves the finish and reports what it could not level', () => {
    const r = levelResources(input, 'within_slack');
    expect([r.finishBefore, r.finishAfter]).toEqual(['2026-11-23', '2026-11-23']);
    expect(r.changes.map((c) => [c.id, c.toStart, c.delayDays])).toEqual([['B', '2026-11-18', 2]]);
    expect(r.unresolved).toEqual(['D']); // no slack: it stays on Monday, clashing with A
    expect([r.overallocatedDaysBefore, r.overallocatedDaysAfter]).toEqual([2, 2]);
  });

  it('gives the earlier slot to the more important task', () => {
    const r = levelResources(
      plan([
        task('P1', { assigneeId: 'u-anna', effortMinutes: hours(8), priorityOrdinal: 2 }),
        task('P2', { assigneeId: 'u-anna', effortMinutes: hours(8), priorityOrdinal: 0 }),
      ]),
      'allow_delay',
    );
    expect(r.changes.map((c) => [c.id, c.toStart])).toEqual([['P1', '2026-11-17']]);
  });
});
