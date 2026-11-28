/**
 * The engine, as the engine's tests see it while the golden record is made (record.config.ts puts this
 * module where they import `../../src/planning`). It answers as the engine does, and notes each plan it is
 * handed, with the what-ifs and load windows asked of it; when the file's tests are done it writes them to
 * `inputs/`, one plan to a file, named after the test file and the order they came in.
 */
import { basename } from 'node:path';
import { afterAll, expect } from 'vitest';
import * as engine from '../../../src/planning/index';
import type { LevelingMode, PlanInput, PlanOverride, ScheduleResult } from '../../../src/planning/index';
import { madeUpOverrides, madeUpWindows, writeEntry, type GoldenEntry } from './golden';

export * from '../../../src/planning/index';

interface Seen {
  sources: string[];
  input: PlanInput;
  overrides: Map<string, PlanOverride[]>;
  windows: Map<string, [string | null, string | null]>;
}

const seen = new Map<string, Seen>();
let file = '';

function note(input: PlanInput, overrides: readonly PlanOverride[] = [], window?: [string | undefined, string | undefined]): void {
  const state = expect.getState();
  file ||= basename(state.testPath ?? 'unknown.test.ts', '.test.ts');
  const key = JSON.stringify(input);
  let s = seen.get(key);
  if (!s) {
    s = { sources: [], input: structuredClone(input), overrides: new Map(), windows: new Map() };
    seen.set(key, s);
  }
  const source = `${basename(state.testPath ?? '')} › ${state.currentTestName ?? ''}`;
  if (!s.sources.includes(source)) s.sources.push(source);
  if (overrides.length) s.overrides.set(JSON.stringify(overrides), structuredClone([...overrides]));
  if (window && (window[0] !== undefined || window[1] !== undefined)) {
    const w: [string | null, string | null] = [window[0] ?? null, window[1] ?? null];
    s.windows.set(JSON.stringify(w), w);
  }
}

/** A schedule the test computed some other way than from the plan alone would be a different question. */
function checkSchedule(input: PlanInput, schedule: ScheduleResult): void {
  if (JSON.stringify(engine.computeSchedule(structuredClone(input))) !== JSON.stringify(schedule)) {
    throw new Error('The golden record assumes the schedule passed is computeSchedule(input); this test passed another');
  }
}

export function computeSchedule(input: PlanInput, overrides: readonly PlanOverride[] = []): ScheduleResult {
  note(input, overrides);
  return engine.computeSchedule(input, overrides);
}

export function whatIf(input: PlanInput, overrides: readonly PlanOverride[]): ReturnType<typeof engine.whatIf> {
  note(input, overrides);
  return engine.whatIf(input, overrides);
}

export function computeLoad(input: PlanInput, schedule: ScheduleResult, from?: string, to?: string): ReturnType<typeof engine.computeLoad> {
  checkSchedule(input, schedule);
  note(input, [], [from, to]);
  return engine.computeLoad(input, schedule, from, to);
}

export function levelResources(input: PlanInput, mode: LevelingMode, overrides: readonly PlanOverride[] = []): ReturnType<typeof engine.levelResources> {
  note(input, overrides);
  return engine.levelResources(input, mode, overrides);
}

export function computeCosts(input: PlanInput, schedule: ScheduleResult): ReturnType<typeof engine.computeCosts> {
  checkSchedule(input, schedule);
  note(input);
  return engine.computeCosts(input, schedule);
}

afterAll(() => {
  let n = 0;
  for (const s of seen.values()) {
    n++;
    const overrides = [...s.overrides.values()];
    const entry: GoldenEntry = {
      source: s.sources.join('; '),
      input: s.input,
      overrides: overrides.length ? overrides : madeUpOverrides(s.input),
      windows: s.windows.size ? [...s.windows.values()] : madeUpWindows(s.input),
    };
    writeEntry(`${file}-${String(n).padStart(2, '0')}`, entry);
  }
});
