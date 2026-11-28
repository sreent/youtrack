/**
 * The golden record (D73): every plan recorded before the engine knew several calendars (the engine's own
 * tests' plans, and the demo's, built through the service) gets the same answers, byte for byte. That is
 * the promise that a plan of one project comes out as it always has. golden/golden.ts says how it was made.
 */
import { describe, expect, it } from 'vitest';
import type { CostResult, LevelingProposal } from '../../src/planning';
import { answers, readEntries, readOutput, render, type GoldenEntry } from './golden/golden';

const entries = readEntries();

/**
 * The same plan, its calendar handed as a project's (under a key every task names, as the loader of a plan
 * across projects hands it), and a plan's own calendar no task is on, unlike it in every way.
 */
function keyed(entry: GoldenEntry): GoldenEntry {
  const e = structuredClone(entry);
  e.input.calendars = { P: e.input.calendar };
  if (e.input.tasks.length) e.input.calendar = { startDate: '2001-01-01', workingDays: [0, 6], hoursPerDay: 3, holidays: [], budget: 1, currency: 'XXX' };
  for (const t of e.input.tasks) t.calendarId = 'P';
  return e;
}

/** A keyed plan's answers less what it says per calendar, after checking that agrees with the rest. */
function unkeyed(got: Record<string, unknown>): Record<string, unknown> {
  for (const [name, answer] of Object.entries(got)) {
    if (name.startsWith('levelResources')) {
      const p = answer as LevelingProposal;
      expect(p.keepStarts, name).toEqual(p.keepStart ? { P: p.keepStart } : {});
      delete p.keepStarts;
    }
    if (name === 'computeCosts') {
      const c = answer as CostResult;
      expect(c.byCalendar, name).toEqual([{ calendarId: 'P', currency: c.currency, budget: c.budget, plannedCost: c.plannedCost, actualCost: c.actualCost, forecastCost: c.forecastCost, budgetVariance: c.budgetVariance }]);
      expect(c.byCurrency, name).toEqual([{ currency: c.currency, plannedCost: c.plannedCost, actualCost: c.actualCost, forecastCost: c.forecastCost, evm: c.evm }]);
      delete c.byCalendar;
      delete c.byCurrency;
      for (const p of c.byPerson) {
        // Everyone with a row has work in the plan, so in its one currency, an estimate or not.
        expect(p.byCurrency, name).toEqual([{ currency: c.currency, plannedCost: p.plannedCost, actualCost: p.actualCost }]);
        delete p.byCurrency;
      }
    }
  }
  return got;
}

describe('the golden record', () => {
  it('holds the engine tests’ plans and the demo’s', () => {
    expect(entries.length).toBeGreaterThanOrEqual(56);
    const demo = entries.filter((e) => e.name.startsWith('demo-')).map((e) => e.name);
    expect(demo.sort()).toEqual(['demo-BACK', 'demo-MIG', 'demo-MIG-calendar', 'demo-MIG-people', 'demo-WEB']);
  });

  it.each(entries.map((e) => [e.name, e.entry] as const))('%s gets the answers it got', (name, entry) => {
    const want = readOutput(name);
    const got = render(answers(entry));
    if (got !== want) {
      // Say which answer moved before saying that the file did.
      const before = JSON.parse(want) as Record<string, unknown>;
      const after = JSON.parse(got) as Record<string, unknown>;
      for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
        expect(render(after[k] ?? null), `${name}: ${k}`).toBe(render(before[k] ?? null));
      }
    }
    expect(got).toBe(want);
  });

  it.each(entries.map((e) => [e.name, e.entry] as const))('%s, its calendar named as a project’s, gets them too', (name, entry) => {
    expect(render(unkeyed(answers(keyed(entry)))), name).toBe(readOutput(name));
  });
});
