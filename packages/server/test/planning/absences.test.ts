/**
 * People's days away (D36): the engine schedules each person's work on their own days, levels
 * on them, and shows them in the load; plans with nobody away come out as they always have.
 */
import { describe, expect, it } from 'vitest';
import { computeCosts, computeLoad, computeSchedule, levelResources, whatIf } from '../../src/planning';
import type { PlanAbsence, ScheduledTask, ScheduleResult } from '../../src/planning';
import { anna, ben, hours, plan, task } from './fixtures';

const byId = (s: ScheduleResult): Record<string, ScheduledTask> => Object.fromEntries(s.tasks.map((t) => [t.id, t]));

// Mon 16 (today), Tue 17, Wed 18, (Thu 19 a holiday), Fri 20, Mon 23, Tue 24 …
const away = (from: string, to = from, half: PlanAbsence['half'] = null, who = anna.id): PlanAbsence => ({ resourceId: who, from, to, half });

describe('scheduling around days away', () => {
  it('moves a person’s work past a day they’re away, and what follows it', () => {
    const tasks = [task('A', { assigneeId: anna.id, effortMinutes: hours(24) }), task('B', { assigneeId: ben.id, effortMinutes: hours(8), predecessors: ['A'] })];
    const before = byId(computeSchedule(plan(tasks)));
    expect([before.A!.start, before.A!.finish, before.B!.start]).toEqual(['2026-11-16', '2026-11-18', '2026-11-20']);

    const after = byId(computeSchedule(plan(tasks, { absences: [away('2026-11-17')] })));
    // Mon, Wed and Fri: Tuesday she's away, Thursday is the plan's holiday.
    expect([after.A!.start, after.A!.finish, after.A!.durationDays]).toEqual(['2026-11-16', '2026-11-20', 3]);
    expect([after.B!.start, after.B!.finish]).toEqual(['2026-11-23', '2026-11-23']);
  });

  it('gives half a day’s work on a half day away', () => {
    const tasks = [task('A', { assigneeId: anna.id, effortMinutes: hours(16) })];
    const s = byId(computeSchedule(plan(tasks, { absences: [away('2026-11-17', '2026-11-17', 'afternoon')] })));
    // 8h on Monday, 4h on Tuesday morning, the last 4h on Wednesday.
    expect([s.A!.start, s.A!.finish, s.A!.durationDays]).toEqual(['2026-11-16', '2026-11-18', 3]);
  });

  it('starts work on the first day its assignee is back', () => {
    const tasks = [task('A', { assigneeId: anna.id, effortMinutes: hours(8) })];
    const s = byId(computeSchedule(plan(tasks, { absences: [away('2026-11-16', '2026-11-17')] })));
    expect([s.A!.start, s.A!.finish]).toEqual(['2026-11-18', '2026-11-18']);
  });

  it('counts a morning and an afternoon away on one day as the whole day', () => {
    const tasks = [task('A', { assigneeId: anna.id, effortMinutes: hours(8) })];
    const halves = [away('2026-11-16', '2026-11-16', 'morning'), away('2026-11-16', '2026-11-16', 'afternoon')];
    expect(byId(computeSchedule(plan(tasks, { absences: halves }))).A!.start).toBe('2026-11-17');
  });

  it('leaves everyone else, and the plan’s own days, as they were', () => {
    const tasks = [task('A', { assigneeId: anna.id, effortMinutes: hours(8) }), task('B', { assigneeId: ben.id, effortMinutes: hours(24) }), task('C', { effortMinutes: hours(16) })];
    const before = computeSchedule(plan(tasks));
    const after = computeSchedule(plan(tasks, { absences: [away('2026-12-01', '2026-12-05')] }));
    expect(after).toEqual(before);
    const s = byId(computeSchedule(plan(tasks, { absences: [away('2026-11-16')] })));
    expect([s.B!.start, s.B!.finish, s.C!.start, s.C!.finish]).toEqual(['2026-11-16', '2026-11-18', '2026-11-16', '2026-11-17']);
  });

  it('counts slack on its assignee’s own days', () => {
    // Ben's week sets the finish, Monday the 23rd; Anna's two days end Tuesday, and her slack is
    // the days she works until then: three, or two with Friday away.
    const tasks = [task('A', { assigneeId: anna.id, effortMinutes: hours(16) }), task('C', { assigneeId: ben.id, effortMinutes: hours(40) })];
    expect(byId(computeSchedule(plan(tasks))).A!.slackDays).toBe(3);
    const s = byId(computeSchedule(plan(tasks, { absences: [away('2026-11-20')] })));
    expect([s.A!.finish, s.A!.lateFinish, s.A!.slackDays, s.C!.finish]).toEqual(['2026-11-17', '2026-11-23', 2, '2026-11-23']);
  });

  it('plans a start-to-due window that falls while its assignee is away for when they’re back, and says so', () => {
    const tasks = [task('W', { assigneeId: anna.id, startConstraint: '2026-11-16', deadline: '2026-11-17' })];
    const s = computeSchedule(plan(tasks, { absences: [away('2026-11-16', '2026-11-17')] }));
    const w = byId(s).W!;
    expect([w.start, w.finish, w.late]).toEqual(['2026-11-18', '2026-11-18', true]);
    expect(s.warnings).toContain('W falls on days its assignee is away; planned for when they’re back');
  });

  it('runs the rest of work in progress on its assignee’s days', () => {
    const tasks = [task('P', { assigneeId: anna.id, effortMinutes: hours(24), spentMinutes: hours(8), firstWorkDate: '2026-11-12' })];
    const s = byId(computeSchedule(plan(tasks, { absences: [away('2026-11-16')] })));
    expect([s.P!.start, s.P!.finish]).toEqual(['2026-11-12', '2026-11-18']);
  });

  it('follows the new assignee’s days in a what-if', () => {
    const tasks = [task('A', { assigneeId: ben.id, effortMinutes: hours(16) })];
    const res = whatIf(plan(tasks, { absences: [away('2026-11-17')] }), [{ id: 'A', assigneeId: anna.id }]);
    expect([byId(res.after).A!.start, byId(res.after).A!.finish, res.finishDeltaDays]).toEqual(['2026-11-16', '2026-11-18', 1]);
  });

  it('takes no account of days away beyond what it looks at, and never runs out of days', () => {
    const tasks = [task('A', { assigneeId: anna.id, effortMinutes: hours(8) })];
    const s = byId(computeSchedule(plan(tasks, { absences: [away('2026-11-16', '2036-11-16')] })));
    expect(s.A!.start > '2031-01-01').toBe(true);
  });

  it('costs what its estimate does, however long it waits for its person', () => {
    const tasks = [task('A', { assigneeId: anna.id, effortMinutes: hours(16) })];
    const input = plan(tasks, { absences: [away('2026-11-16', '2026-11-20')] });
    const c = computeCosts(input, computeSchedule(input));
    expect(c.plannedCost).toBe(1600);
    expect(c.plannedCost).toBe(computeCosts(plan(tasks), computeSchedule(plan(tasks))).plannedCost);
  });
});

describe('load and levelling around days away', () => {
  it('shows a day away, and half a day, against what they can do that day', () => {
    const tasks = [task('A', { assigneeId: anna.id, effortMinutes: hours(16) })];
    const input = plan(tasks, { absences: [away('2026-11-17', '2026-11-17', 'afternoon'), away('2026-11-18')] });
    const load = computeLoad(input, computeSchedule(input), '2026-11-16', '2026-11-20');
    const row = load.resources.find((r) => r.resourceId === anna.id)!;
    expect(row.days.map((d) => [d.date, d.away, d.capacity, d.hours])).toEqual([
      ['2026-11-16', null, 8, 6.4],
      ['2026-11-17', 'afternoon', 4, 3.2],
      ['2026-11-18', 'day', 0, 0],
      ['2026-11-20', null, 8, 6.4],
    ]);
    expect([row.capacityHoursPerDay, row.overallocatedDays, row.totalHours]).toEqual([8, 0, 16]);
    expect(load.resources.find((r) => r.resourceId === ben.id)!.days.every((d) => d.away === null && d.capacity === 8)).toBe(true);
  });

  it('counts work booked on a day away as over what they can do', () => {
    // Logged work starts it on a day she then marks away: the rest still lands from today, on her days.
    const tasks = [task('A', { assigneeId: anna.id, effortMinutes: hours(8) }), task('B', { assigneeId: anna.id, effortMinutes: hours(8) })];
    const input = plan(tasks, { absences: [away('2026-11-17')] });
    const row = computeLoad(input, computeSchedule(input), '2026-11-16', '2026-11-18').resources.find((r) => r.resourceId === anna.id)!;
    expect(row.days.map((d) => [d.date, d.hours, d.capacity])).toEqual([
      ['2026-11-16', 16, 8],
      ['2026-11-17', 0, 0],
      ['2026-11-18', 0, 8],
    ]);
    expect(row.overallocatedDays).toBe(1);
  });

  it('levels onto the days its assignee is there', () => {
    const tasks = [task('A', { assigneeId: anna.id, effortMinutes: hours(8), priorityOrdinal: 1 }), task('B', { assigneeId: anna.id, effortMinutes: hours(8), priorityOrdinal: 2 })];
    const p = levelResources(plan(tasks, { absences: [away('2026-11-17')] }), 'allow_delay');
    expect(p.changes.map((c) => [c.id, c.toStart, c.toFinish, c.movedBy])).toEqual([['B', '2026-11-18', '2026-11-18', 'resources']]);
    expect([p.overallocatedDaysBefore, p.overallocatedDaysAfter]).toEqual([1, 0]);
    expect(p.levelledStarts).toEqual({ B: '2026-11-18' });
  });

  it('fits work into half a day away by its hours there', () => {
    // A fills Monday. B can start Tuesday: its morning gives 4h, Wednesday the rest.
    const tasks = [
      task('A', { assigneeId: anna.id, effortMinutes: hours(8), startConstraint: '2026-11-16', priorityOrdinal: 1 }),
      task('B', { assigneeId: anna.id, effortMinutes: hours(8), priorityOrdinal: 2 }),
    ];
    const input = plan(tasks, { absences: [away('2026-11-17', '2026-11-17', 'afternoon')] });
    const p = levelResources(input, 'allow_delay');
    expect(p.changes.map((c) => [c.id, c.toStart, c.toFinish])).toEqual([['B', '2026-11-17', '2026-11-18']]);
    expect(p.overallocatedDaysAfter).toBe(0);
    // Written as levelling writes it, the plan is the one proposed.
    const applied = byId(computeSchedule(input, Object.entries(p.levelledStarts).map(([id, start]) => ({ id, start }))));
    expect([applied.B!.start, applied.B!.finish]).toEqual(['2026-11-17', '2026-11-18']);
  });

  it('doesn’t call it levelling when work only waits for its person to be back', () => {
    const tasks = [task('A', { assigneeId: anna.id, effortMinutes: hours(8) })];
    const p = levelResources(plan(tasks, { absences: [away('2026-11-16')] }), 'within_slack');
    expect([p.changes, p.overallocatedDaysBefore, p.levelledStarts]).toEqual([[], 0, {}]);
  });
});
