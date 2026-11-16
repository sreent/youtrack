import { describe, expect, it } from 'vitest';
import { whatIf } from '../../src/planning';
import { hours, plan, span, task } from './fixtures';

// A (3 days) and B (1 day) both feed C. A–C is critical; B has 2 days of slack.
// Baseline: A Mon 16 – Wed 18, B Mon 16, C Fri 20 (Thu 19 is a holiday).
const branches = () =>
  plan([
    task('A', { summary: 'Build', effortMinutes: hours(24) }),
    task('B', { summary: 'Docs', effortMinutes: hours(8) }),
    task('C', { summary: 'Release', effortMinutes: hours(8), predecessors: ['A', 'B'] }),
  ]);

describe('whatIf', () => {
  it('absorbs a delay within slack without moving the finish', () => {
    const r = whatIf(branches(), [{ id: 'B', delayDays: 1 }]);
    expect(r.before).toEqual({ finish: '2026-11-20', criticalPath: ['A', 'C'] });
    expect(r.after.finish).toBe('2026-11-20');
    expect(r.finishDeltaDays).toBe(0);
    expect(r.impacted).toEqual([{ id: 'B', summary: 'Docs', startDeltaDays: 1, finishDeltaDays: 1 }]);
  });

  it('moves the finish when a critical task slips, listing every task that moved', () => {
    const r = whatIf(branches(), [{ id: 'A', delayDays: 1 }]);
    expect(span(r.after, 'A')).toEqual(['2026-11-17', '2026-11-20']);
    expect(r.after.finish).toBe('2026-11-23');
    expect(r.finishDeltaDays).toBe(1);
    expect(r.impacted).toEqual([
      { id: 'A', summary: 'Build', startDeltaDays: 1, finishDeltaDays: 1 },
      { id: 'C', summary: 'Release', startDeltaDays: 1, finishDeltaDays: 1 },
    ]);
  });

  it('replaces estimates, assignees and start dates', () => {
    const shorter = whatIf(branches(), [{ id: 'A', effortMinutes: hours(8) }]);
    expect(shorter.after.finish).toBe('2026-11-17');
    expect(shorter.finishDeltaDays).toBe(-2);

    const halfTime = { id: 'u-half', login: 'half', name: 'Half Time', capacityHoursPerDay: 4, hourlyRate: null };
    const input = { ...branches(), resources: [halfTime] };
    const slower = whatIf(input, [{ id: 'A', assigneeId: 'u-half' }]);
    expect(span(slower.after, 'A')).toEqual(['2026-11-16', '2026-11-24']); // 24h at 4h a day
    expect(slower.finishDeltaDays).toBe(3);

    const later = whatIf(branches(), [{ id: 'B', start: '2026-11-24' }, { id: 'NOPE-1', delayDays: 2 }]);
    expect(span(later.after, 'B')).toEqual(['2026-11-24', '2026-11-24']);
    expect(later.after.finish).toBe('2026-11-25');
    expect(later.after.warnings).toContain('Override for NOPE-1 ignored: it is not in this plan');
  });

  it('delays a summary by shifting its first subtasks once, the rest follow', () => {
    const r = whatIf(
      plan([
        task('S'),
        task('K1', { parent: 'S', effortMinutes: hours(8) }),
        task('K2', { parent: 'S', effortMinutes: hours(8), predecessors: ['K1'] }),
        task('X', { effortMinutes: hours(8) }),
      ]),
      [{ id: 'S', delayDays: 2 }],
    );
    expect(span(r.after, 'K1')).toEqual(['2026-11-18', '2026-11-18']);
    expect(span(r.after, 'K2')).toEqual(['2026-11-20', '2026-11-20']);
    expect(r.impacted.map((i) => [i.id, i.startDeltaDays, i.finishDeltaDays])).toEqual([
      ['S', 2, 2],
      ['K1', 2, 2],
      ['K2', 2, 2],
    ]);
  });
});
