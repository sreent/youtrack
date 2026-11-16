import { describe, expect, it } from 'vitest';
import { computeCosts, computeSchedule } from '../../src/planning';
import type { PlanInput, PlanResource } from '../../src/planning';
import { anna, ben, calendar, get, hours, plan, task } from './fixtures';

const carl: PlanResource = { id: 'u-carl', login: 'carl', name: 'Carl Jung', capacityHoursPerDay: 8, hourlyRate: null };

/**
 * T1 (Anna, €100/h): 8h estimate, done; 6h logged at her rate + 4h at a frozen €120/h; €200 fixed.
 * T2 (Ben, €80/h): 16h estimate, in progress with 4h logged.
 * T3 (Carl, no rate): 8h estimate, not started; €500 fixed.
 */
function costPlan(fields: Partial<PlanInput> = {}): PlanInput {
  return plan(
    [
      task('T1', { assigneeId: 'u-anna', effortMinutes: hours(8), resolved: true, firstWorkDate: '2026-11-02', resolvedAt: '2026-11-10', spentMinutes: hours(10), fixedCost: 200 }),
      task('T2', { assigneeId: 'u-ben', effortMinutes: hours(16), firstWorkDate: '2026-11-12', spentMinutes: hours(4) }),
      task('T3', { assigneeId: 'u-carl', effortMinutes: hours(8), fixedCost: 500 }),
    ],
    {
      calendar: calendar({ budget: 3000 }),
      resources: [anna, ben, carl],
      workItems: [
        { taskId: 'T1', authorId: 'u-anna', date: '2026-11-02', minutes: hours(6), hourlyRate: null },
        { taskId: 'T1', authorId: 'u-anna', date: '2026-11-03', minutes: hours(4), hourlyRate: 120 },
        { taskId: 'T2', authorId: 'u-ben', date: '2026-11-12', minutes: hours(4), hourlyRate: null },
      ],
      ...fields,
    },
  );
}

const baseline = {
  id: 'bl-1',
  name: 'Kick-off',
  tasks: [
    { id: 'T1', start: '2026-11-02', finish: '2026-11-06', effortMinutes: hours(8), cost: 1000 },
    { id: 'T2', start: '2026-11-12', finish: '2026-11-18', effortMinutes: hours(16), cost: 1280 },
    { id: 'T3', start: '2026-11-23', finish: '2026-11-23', effortMinutes: hours(8), cost: 500 },
    { id: 'OLD-1', start: '2026-11-02', finish: '2026-11-03', effortMinutes: hours(4), cost: 999 }, // no longer planned
  ],
};

describe('computeCosts', () => {
  it('computes planned, actual and forecast cost per task, per person and in total', () => {
    const input = costPlan();
    const report = computeCosts(input, computeSchedule(input));
    expect(report.byTask.map((t) => [t.id, t.plannedCost, t.actualCost, t.fixedCost])).toEqual([
      ['T1', 1000, 1280, 200], // 8h × 100 + 200;  6h × 100 + 4h × 120 + 200 (done)
      ['T2', 1280, 320, 0], //    16h × 80;        4h × 80
      ['T3', 500, 0, 500], //     8h × 0 + 500;    fixed cost not yet incurred
    ]);
    // Forecast: T1 actual 1280 + T2 (320 + 12h × 80) + T3 500.
    expect([report.plannedCost, report.actualCost, report.forecastCost]).toEqual([2780, 1600, 3060]);
    expect([report.currency, report.budget, report.budgetVariance]).toEqual(['EUR', 3000, -60]);
    expect(report.byPerson).toEqual([
      { resourceId: 'u-anna', hourlyRate: 100, plannedHours: 8, actualHours: 10, plannedCost: 800, actualCost: 1080 },
      { resourceId: 'u-ben', hourlyRate: 80, plannedHours: 16, actualHours: 4, plannedCost: 1280, actualCost: 320 },
      { resourceId: 'u-carl', hourlyRate: null, plannedHours: 8, actualHours: 0, plannedCost: 0, actualCost: 0 },
    ]);
    expect(report.warnings).toEqual(['Carl Jung has no hourly rate; their work counts as 0']);
    expect(report.evm).toBeNull();
  });

  it('computes earned value against a baseline', () => {
    const input = costPlan({ baseline });
    const report = computeCosts(input, computeSchedule(input));
    // PV: T1 done by plan (1000) + T2 3 of 5 working days (0.6 × 1280) + T3 not yet due (0).
    // EV: T1 100% × 1000 + T2 25% × 1280 + T3 0%.  AC: 1600.
    expect(report.evm).toEqual({
      asOf: '2026-11-16',
      bac: 2780,
      pv: 1768,
      ev: 1320,
      ac: 1600,
      cv: -280,
      sv: -448,
      cpi: 0.825,
      spi: 0.747, // 1320 / 1768 = 0.7466…
      eac: 3369.7, // 2780 / 0.825 = 3369.697…
      etc: 1769.7,
      vac: -589.7,
    });
  });

  it('reports baseline variance per task and for the finish', () => {
    const input = costPlan({ baseline });
    input.tasks.push(task('T4', { isMilestone: true, predecessors: ['T3'] })); // added since the baseline
    const s = computeSchedule(input);
    expect(get(s, 'T1').variance).toEqual({ startDays: 0, finishDays: 2, effortMinutes: 0, cost: 0 });
    expect(get(s, 'T2').variance).toEqual({ startDays: 0, finishDays: -1, effortMinutes: 0, cost: 0 });
    expect(get(s, 'T3')).toMatchObject({
      baseline: { start: '2026-11-23', finish: '2026-11-23', effortMinutes: hours(8), cost: 500 },
      variance: { startDays: -4, finishDays: -4, effortMinutes: 0, cost: 0 },
    });
    expect(get(s, 'T4')).toMatchObject({ baseline: null, variance: null });
    expect(s.baseline).toEqual({ id: 'bl-1', name: 'Kick-off', finish: '2026-11-23', finishVarianceDays: -3 });
    expect([get(s, 'T1').plannedCost, get(s, 'T1').actualCost]).toEqual([1000, 1280]);
  });

  it('rolls costs up to summary tasks without counting anything twice', () => {
    const input = costPlan();
    input.tasks.push(task('S', { fixedCost: 50, spentMinutes: 60 }));
    for (const t of input.tasks) if (t.id === 'T1' || t.id === 'T2') t.parent = 'S';
    input.workItems.push({ taskId: 'S', authorId: 'u-anna', date: '2026-11-13', minutes: 60, hourlyRate: null });
    const s = computeSchedule(input);
    expect([get(s, 'S').plannedCost, get(s, 'S').actualCost, get(s, 'S').spentMinutes]).toEqual([
      2330, // 50 + 1000 + 1280
      1700, // 1h logged on S (100) + 1280 + 320; S's fixed cost is not incurred until it is resolved
      hours(15), // 1h on S + 10h + 4h
    ]);
    const report = computeCosts(input, s);
    expect([report.plannedCost, report.actualCost, report.forecastCost]).toEqual([2830, 1700, 3210]);
    expect(report.byTask.map((t) => t.id)).toEqual(['T1', 'T2', 'T3']);
  });
});
