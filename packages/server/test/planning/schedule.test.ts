import { describe, expect, it } from 'vitest';
import { computeSchedule } from '../../src/planning';
import { get, hours, plan, span, task } from './fixtures';

// Working days: Mon 16, Tue 17, Wed 18, (Thu 19 holiday), Fri 20, Mon 23, Tue 24, Wed 25, Thu 26 …

describe('computeSchedule: leaf tasks', () => {
  it('chains finish-to-start dependencies over weekends and holidays', () => {
    const s = computeSchedule(
      plan([
        task('A', { assigneeId: 'u-anna', effortMinutes: hours(16) }),
        task('B', { assigneeId: 'u-anna', effortMinutes: hours(8), predecessors: ['A'] }),
        task('C', { effortMinutes: hours(24), predecessors: ['B'] }),
      ]),
    );
    expect(span(s, 'A')).toEqual(['2026-11-16', '2026-11-17']);
    expect(span(s, 'B')).toEqual(['2026-11-18', '2026-11-18']);
    expect(span(s, 'C')).toEqual(['2026-11-20', '2026-11-24']); // skips Thu 19 and the weekend
    expect(s.tasks.map((t) => t.durationDays)).toEqual([2, 1, 3]);
    expect(s.tasks.map((t) => t.scheduledFrom)).toEqual(['project_start', 'dependencies', 'dependencies']);
    expect([s.start, s.finish]).toEqual(['2026-11-16', '2026-11-24']);
    expect(s.criticalPath).toEqual(['A', 'B', 'C']);
    expect(s.tasks.every((t) => t.slackDays === 0)).toBe(true);
    expect(s.warnings).toEqual([]);
  });

  it('caps daily hours at the assignee capacity', () => {
    const part = { id: 'u-part', login: 'part', name: 'Part Timer', capacityHoursPerDay: 6, hourlyRate: null };
    const s = computeSchedule(
      plan([task('A', { assigneeId: 'u-part', effortMinutes: hours(16) })], { resources: [part] }),
    );
    expect(get(s, 'A').durationDays).toBe(3); // ceil(16h / 6h)
  });

  it('gives the shorter parallel branch slack and keeps the longer one critical', () => {
    const s = computeSchedule(
      plan([
        task('A', { effortMinutes: hours(24) }),
        task('B', { effortMinutes: hours(8) }),
        task('C', { effortMinutes: hours(8), predecessors: ['A', 'B'] }),
      ]),
    );
    expect(span(s, 'C')).toEqual(['2026-11-20', '2026-11-20']);
    const b = get(s, 'B');
    expect([b.slackDays, b.lateStart, b.lateFinish, b.critical]).toEqual([2, '2026-11-18', '2026-11-18', false]);
    expect(get(s, 'A').slackDays).toBe(0);
    expect(s.criticalPath).toEqual(['A', 'C']);
  });

  it('honours start dates, flags late tasks and plans start-to-due windows', () => {
    const s = computeSchedule(
      plan([
        // Start no earlier than Saturday 21st → Monday 23rd; 2 days → Tuesday, past its Monday due date.
        task('X', { effortMinutes: hours(16), startConstraint: '2026-11-21', deadline: '2026-11-23' }),
        // No estimate, but a start and a due date: it fills Tue 24 – Thu 26.
        task('Y', { startConstraint: '2026-11-24', deadline: '2026-11-26' }),
        task('Z', { effortMinutes: hours(8), deadline: '2026-11-30' }),
      ]),
    );
    const x = get(s, 'X');
    expect([x.start, x.finish, x.scheduledFrom, x.late]).toEqual(['2026-11-23', '2026-11-24', 'start', true]);
    expect([x.lateFinish, x.slackDays, x.critical]).toEqual(['2026-11-23', -1, true]); // the due date forces lateness
    const y = get(s, 'Y');
    expect([y.start, y.finish, y.durationDays, y.scheduledFrom, y.late]).toEqual(['2026-11-24', '2026-11-26', 3, 'fixed', false]);
    expect(get(s, 'Z').late).toBe(false);
    expect(s.warnings).toEqual([]);
  });

  it('plans a task without an estimate as one day, with a warning', () => {
    const s = computeSchedule(plan([task('MIG-4')]));
    expect(span(s, 'MIG-4')).toEqual(['2026-11-16', '2026-11-16']);
    expect(s.warnings).toEqual(['MIG-4 has no estimate; planned as 1 day']);
  });

  it('places milestones on their predecessors’ finish, with zero duration', () => {
    const s = computeSchedule(
      plan([
        task('A', { effortMinutes: hours(16) }),
        task('M', { isMilestone: true, predecessors: ['A'] }),
        task('B', { effortMinutes: hours(8), predecessors: ['M'] }),
      ]),
    );
    const m = get(s, 'M');
    expect([m.start, m.finish, m.durationDays, m.slackDays]).toEqual(['2026-11-17', '2026-11-17', 0, 0]);
    expect(span(s, 'B')).toEqual(['2026-11-18', '2026-11-18']);
    expect(s.criticalPath).toEqual(['A', 'M', 'B']);

    const onHoliday = computeSchedule(plan([task('GATE', { isMilestone: true, startConstraint: '2026-11-19' })]));
    expect(span(onHoliday, 'GATE')).toEqual(['2026-11-20', '2026-11-20']);
  });

  it('uses actual dates for resolved work and remaining work for tasks in progress', () => {
    const s = computeSchedule(
      plan([
        task('R', { resolved: true, firstWorkDate: '2026-11-02', resolvedAt: '2026-11-10', effortMinutes: hours(16), spentMinutes: hours(16) }),
        // Started Thu 12th, 8h of 24h done: 16h left at 8h/day → Mon 16 – Tue 17.
        task('P', { assigneeId: 'u-anna', firstWorkDate: '2026-11-12', effortMinutes: hours(24), spentMinutes: hours(8), predecessors: ['R'] }),
        task('S', { effortMinutes: hours(8), predecessors: ['P'] }),
        task('O', { firstWorkDate: '2026-11-13', effortMinutes: hours(8), spentMinutes: hours(10) }),
      ]),
    );
    const r = get(s, 'R');
    expect([r.start, r.finish, r.scheduledFrom, r.percentComplete, r.slackDays, r.critical]).toEqual([
      '2026-11-02',
      '2026-11-10',
      'actual',
      100,
      0,
      false,
    ]);
    expect([r.lateStart, r.lateFinish, r.durationDays]).toEqual(['2026-11-02', '2026-11-10', 7]);
    const p = get(s, 'P');
    expect([p.start, p.finish, p.scheduledFrom, p.percentComplete, p.remainingMinutes]).toEqual([
      '2026-11-12',
      '2026-11-17',
      'actual',
      33,
      hours(16),
    ]);
    expect(span(s, 'S')).toEqual(['2026-11-18', '2026-11-18']);
    expect(s.criticalPath).toEqual(['P', 'S']);
    const o = get(s, 'O'); // overran its estimate: 95%, one more day
    expect([o.percentComplete, o.finish]).toEqual([95, '2026-11-16']);
    expect(s.start).toBe('2026-11-02');
  });

  it('ignores predecessors outside the plan, with a warning', () => {
    const s = computeSchedule(plan([task('MIG-4', { effortMinutes: hours(8), predecessors: ['WEB-7'] })]));
    expect(get(s, 'MIG-4')).toMatchObject({ start: '2026-11-16', predecessors: [] });
    expect(s.warnings).toEqual(['MIG-4 depends on WEB-7, which is outside this plan']);
  });

  it('breaks a dependency cycle, warns, and still schedules every task', () => {
    const s = computeSchedule(
      plan([
        task('MIG-2', { effortMinutes: hours(8), predecessors: ['MIG-5'] }),
        task('MIG-5', { effortMinutes: hours(8), predecessors: ['MIG-2'] }),
      ]),
    );
    expect(s.warnings).toEqual(['Dependency cycle: MIG-2 → MIG-5 → MIG-2']);
    expect(span(s, 'MIG-5')).toEqual(['2026-11-16', '2026-11-16']);
    expect(span(s, 'MIG-2')).toEqual(['2026-11-17', '2026-11-17']);
    expect(get(s, 'MIG-5').predecessors).toEqual(['MIG-2']); // still shown, just not scheduled on
  });

  it('survives implausible dates without hitting the calendar step limit', () => {
    const s = computeSchedule(
      plan([
        task('P', { firstWorkDate: '1900-01-01', effortMinutes: hours(8) }),
        task('Q', { effortMinutes: hours(8), deadline: '1900-01-01' }),
      ]),
    );
    expect(get(s, 'P')).toMatchObject({ start: '1900-01-01', finish: '2026-11-16', lateStart: '1900-01-01', slackDays: 0 });
    expect(get(s, 'Q').slackDays).toBeLessThan(-30_000);
  });
});

describe('computeSchedule: summary tasks', () => {
  it('rolls a three-level hierarchy up from its leaves', () => {
    const s = computeSchedule(
      plan([
        task('E', { effortMinutes: hours(10) }),
        task('F', { parent: 'E' }),
        task('T1', { parent: 'F', resolved: true, firstWorkDate: '2026-11-09', resolvedAt: '2026-11-10', effortMinutes: hours(8), spentMinutes: hours(8) }),
        task('T2', { parent: 'F', effortMinutes: hours(16), predecessors: ['T1'] }),
        task('T3', { parent: 'E', effortMinutes: hours(8) }),
      ]),
    );
    expect(s.tasks.map((t) => [t.id, t.depth, t.isSummary])).toEqual([
      ['E', 0, true],
      ['F', 1, true],
      ['T1', 2, false],
      ['T2', 2, false],
      ['T3', 1, false],
    ]);
    const f = get(s, 'F');
    expect([f.start, f.finish, f.effortMinutes, f.spentMinutes, f.percentComplete]).toEqual([
      '2026-11-09',
      '2026-11-17',
      hours(24),
      hours(8),
      33, // (100% × 8h + 0% × 16h) / 24h
    ]);
    expect([f.resolved, f.critical, f.scheduledFrom, f.slackDays]).toEqual([false, true, 'actual', 0]);
    const e = get(s, 'E');
    expect([e.start, e.finish, e.effortMinutes, e.percentComplete, e.durationDays]).toEqual([
      '2026-11-09',
      '2026-11-17',
      hours(32),
      25,
      7,
    ]);
    expect(get(s, 'T3').slackDays).toBe(1);
    expect(s.criticalPath).toEqual(['T2']);
    expect(s.warnings).toEqual(['E is a summary task; its own estimate is ignored']);
  });

  it('applies a summary’s predecessors to each of its leaf descendants', () => {
    const s = computeSchedule(
      plan([
        task('X', { effortMinutes: hours(16) }),
        task('S', { predecessors: ['X'] }),
        task('K1', { parent: 'S', effortMinutes: hours(8) }),
        task('K2', { parent: 'S', effortMinutes: hours(16) }),
        task('S2', { parent: 'S' }),
        task('K3', { parent: 'S2', effortMinutes: hours(8) }),
        task('Y', { effortMinutes: hours(8), predecessors: ['S'] }),
      ]),
    );
    for (const id of ['K1', 'K2', 'K3']) {
      expect(get(s, id)).toMatchObject({ start: '2026-11-18', scheduledFrom: 'dependencies', predecessors: [] });
    }
    expect(span(s, 'S')).toEqual(['2026-11-18', '2026-11-20']);
    expect(get(s, 'S').predecessors).toEqual(['X']);
    expect(span(s, 'Y')).toEqual(['2026-11-23', '2026-11-23']); // after the whole summary
    expect(s.tasks.map((t) => t.id)).toEqual(['X', 'S', 'K1', 'K2', 'S2', 'K3', 'Y']);
  });

  it('applies a summary’s start date and due date to its subtasks', () => {
    const s = computeSchedule(
      plan([
        task('S', { startConstraint: '2026-11-23', deadline: '2026-11-23' }),
        task('K', { parent: 'S', effortMinutes: hours(16) }),
      ]),
    );
    expect(get(s, 'K')).toMatchObject({ start: '2026-11-23', finish: '2026-11-24', scheduledFrom: 'start', late: false });
    expect(get(s, 'K').slackDays).toBe(-1); // the summary's due date caps its late finish
    expect(get(s, 'S').late).toBe(true);
  });
});
