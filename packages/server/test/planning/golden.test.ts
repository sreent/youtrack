/**
 * The golden record (D73): every plan recorded before the engine knew several calendars (the engine's own
 * tests' plans, and the demo's, built through the service) gets the same answers, byte for byte. That is
 * the promise that a plan of one project comes out as it always has. golden/golden.ts says how it was made.
 */
import { describe, expect, it } from 'vitest';
import { answers, readEntries, readOutput, render } from './golden/golden';

const entries = readEntries();

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
});
