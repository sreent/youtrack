/**
 * The foundation of planning as views (D72), on a real installation: today's schedules are plans of a
 * search as the contract has them (it adds only optional fields), and a new installation's Depend is
 * the one link type plans read as a dependency.
 */
import { PlanScheduleSchema } from '@a4a/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminCtx } from '../src/app-services';
import { seedDemo } from '../src/db/seed';
import { linkTypes } from '../src/db/schema';
import { getSchedule, listBaselines, whatIfSchedule } from '../src/services/planning';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
beforeAll(async () => {
  w = await createWorld({ projects: false, people: false });
  await seedDemo(w.app, w.admin);
});
afterAll(async () => w?.close());

describe('the plan contract over the demo data', () => {
  it("reads today's schedule, with a baseline and after a what-if, as a plan of a search", async () => {
    const ctx = adminCtx(w.app, w.admin);
    const [baseline] = await listBaselines(ctx, 'MIG');
    const schedule = await getSchedule(ctx, 'MIG', { baseline: baseline!.id });
    expect(schedule.tasks.length).toBeGreaterThan(0);
    const parsed = PlanScheduleSchema.safeParse(schedule);
    expect(parsed.success, parsed.error?.message).toBe(true);
    const leaf = schedule.tasks.find((t) => !t.isSummary)!;
    const after = await whatIfSchedule(ctx, 'MIG', { overrides: [{ issue: leaf.issue.id, delayDays: 2 }] });
    expect(PlanScheduleSchema.safeParse(after.after).success).toBe(true);
  });

  it('knows Depend as the dependency, and no other type', async () => {
    const flagged = await w.app.db.select({ name: linkTypes.name, outward: linkTypes.outward }).from(linkTypes).where(eq(linkTypes.dependency, true));
    expect(flagged).toEqual([{ name: 'Depend', outward: 'depends on' }]);
  });
});
