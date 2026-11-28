/**
 * The demo's plans for the golden record (see golden.ts), built once through the planning service on a
 * seeded PGlite database, as a reader's plan is: MIG with its plan of record, BACK and WEB. The demo has
 * nobody away, no part-time week and only Monday to Friday, so MIG is also kept with those: the same plan,
 * changed only in what it's handed.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { adminCtx } from '../../../src/app-services';
import { seedDemo } from '../../../src/db/seed';
import { addDays } from '../../../src/lib/dates';
import type { PlanInput } from '../../../src/planning/index';
import { listBaselines, loadPlan } from '../../../src/services/planning';
import { createWorld, type TestWorld } from '../../helpers';
import { madeUpOverrides, madeUpWindows, writeEntry } from './golden';

let w: TestWorld;
beforeAll(async () => {
  w = await createWorld({ projects: false, people: false });
  await seedDemo(w.app, w.admin);
});
afterAll(async () => w?.close());

function keep(name: string, source: string, input: PlanInput): void {
  writeEntry(name, { source, input, overrides: madeUpOverrides(input), windows: madeUpWindows(input) });
}

it('records the demo plans as the service builds them', async () => {
  const ctx = adminCtx(w.app, w.admin);
  const [baseline] = await listBaselines(ctx, 'MIG');
  expect(baseline?.name).toBe('Plan of record');
  const mig = (await loadPlan(ctx, 'MIG', { baselineId: baseline!.id })).input;
  expect(mig.tasks.length).toBeGreaterThan(15);
  keep('demo-MIG', 'the demo: MIG with its plan of record', mig);
  for (const key of ['BACK', 'WEB']) keep(`demo-${key}`, `the demo: ${key}`, (await loadPlan(ctx, key)).input);

  const id = (login: string): string => mig.resources.find((r) => r.login === login)!.id;
  const t = mig.today;
  const people: PlanInput = structuredClone(mig);
  people.absences = [
    { resourceId: id('anna'), from: addDays(t, 3), to: addDays(t, 5), half: null },
    { resourceId: id('chloe'), from: addDays(t, 1), to: addDays(t, 1), half: 'afternoon' },
    { resourceId: id('chloe'), from: addDays(t, 12), to: addDays(t, 13), half: null },
    { resourceId: id('ben'), from: addDays(t, -2), to: addDays(t, 1), half: null },
    { resourceId: id('diego'), from: addDays(t, 8), to: addDays(t, 8), half: 'morning' },
  ];
  for (const r of people.resources) {
    if (r.login === 'diego') r.week = [0, 6, 6, 6, 6, 3, 0]; // a short Friday
    if (r.login === 'anna') r.week = [0, 8, 8, 8, 8, 0, 0]; // four days a week
    if (r.login === 'chloe') r.week = [0, 8, 8, 8, 8, 8, 0]; // a week that changes nothing
  }
  keep('demo-MIG-people', 'the demo: MIG with days away and working weeks', people);

  const calendar: PlanInput = structuredClone(mig);
  calendar.calendar = { ...calendar.calendar, startDate: null, workingDays: [1, 2, 3, 4], hoursPerDay: 7.5, holidays: [addDays(t, 2), addDays(t, 9), addDays(t, 30)] };
  keep('demo-MIG-calendar', 'the demo: MIG on four days a week of 7.5 hours, with holidays and no start date of its own', calendar);
});
