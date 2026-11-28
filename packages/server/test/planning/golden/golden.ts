/**
 * The golden record of the planning engine (D73). Plans recorded once, at 86b3fdb, before the engine knew
 * several calendars: every plan the engine's own tests handed it, and the demo's plans built through the
 * service. Beside each is every answer the engine gave it then. The golden test asks the engine again and
 * wants the same bytes, so a plan of one project comes out as it always has.
 *
 * Recording again is for when an answer is meant to change, and the commit says why:
 *   pnpm --filter @a4a/server exec vitest run --config test/planning/golden/record.config.ts
 *   pnpm --filter @a4a/server exec tsx test/planning/golden/write-outputs.ts
 * The first writes `inputs/` (the engine's tests run with a recorder in place of the engine, and the demo is
 * seeded into PGlite), the second `outputs/`. Nothing here reads the clock: each input carries its own today.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDays } from '../../../src/lib/dates';
import { computeCosts, computeLoad, computeSchedule, levelResources, whatIf } from '../../../src/planning/index';
import type { PlanInput, PlanOverride, ScheduleResult } from '../../../src/planning/index';

export const GOLDEN_DIR = fileURLToPath(new URL('.', import.meta.url));
const INPUTS = join(GOLDEN_DIR, 'inputs');
const OUTPUTS = join(GOLDEN_DIR, 'outputs');

/** A recorded plan and the questions asked of it beyond the plain ones. */
export interface GoldenEntry {
  /** Where it came from: a test's name, or the demo project. */
  source: string;
  input: PlanInput;
  /** What-ifs to run (each also as a schedule with those overrides). */
  overrides: PlanOverride[][];
  /** Load windows beyond the default one: [from, to], either null for the default. */
  windows: [string | null, string | null][];
}

/** JSON as the fixtures are written: two spaces, a final newline. */
export function render(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const copy = <T>(value: T): T => structuredClone(value);

/** Every answer the engine gives a recorded plan: schedules, what-ifs, loads, levelling both ways, costs. */
export function answers(e: GoldenEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const attempt = <T>(name: string, ask: () => T): T | null => {
    try {
      const answer = ask();
      out[name] = answer;
      return answer;
    } catch (err) {
      out[name] = { error: err instanceof Error ? err.message : String(err) };
      return null;
    }
  };
  const schedule: ScheduleResult | null = attempt('computeSchedule', () => computeSchedule(copy(e.input)));
  e.overrides.forEach((o, i) => {
    attempt(`computeSchedule with overrides ${i + 1}`, () => computeSchedule(copy(e.input), copy(o)));
    attempt(`whatIf ${i + 1}`, () => whatIf(copy(e.input), copy(o)));
  });
  if (schedule) {
    attempt('computeLoad', () => computeLoad(copy(e.input), copy(schedule)));
    e.windows.forEach(([from, to], i) => attempt(`computeLoad window ${i + 1}`, () => computeLoad(copy(e.input), copy(schedule), from ?? undefined, to ?? undefined)));
  }
  attempt('levelResources within_slack', () => levelResources(copy(e.input), 'within_slack'));
  attempt('levelResources allow_delay', () => levelResources(copy(e.input), 'allow_delay'));
  if (schedule) attempt('computeCosts', () => computeCosts(copy(e.input), copy(schedule)));
  return out;
}

/**
 * What-ifs for a plan its test asked none of: its first open critical task two days late; and a mix (more
 * work on the first open task, a later start for the last, the third handed to someone else, the first
 * summary a day late). Made from the plan as the engine scheduled it when it was recorded, then kept.
 */
export function madeUpOverrides(input: PlanInput): PlanOverride[][] {
  let s: ScheduleResult;
  try {
    s = computeSchedule(copy(input));
  } catch {
    return [];
  }
  const open = s.tasks.filter((t) => !t.isSummary && !t.resolved);
  const sets: PlanOverride[][] = [];
  const critical = s.criticalPath.find((id) => open.some((t) => t.id === id));
  if (critical) sets.push([{ id: critical, delayDays: 2 }]);
  const mix: PlanOverride[] = [];
  const first = open[0];
  if (first) mix.push({ id: first.id, effortMinutes: (first.effortMinutes || 480) * 2 });
  const last = open[open.length - 1];
  if (last && open.length > 1) mix.push({ id: last.id, start: addDays(input.today, 3) });
  const third = open[2];
  if (third) {
    const other = input.resources.find((r) => r.id !== third.assigneeId);
    if (other) mix.push({ id: third.id, assigneeId: other.id });
  }
  const summary = s.tasks.find((t) => t.isSummary);
  if (summary) mix.push({ id: summary.id, delayDays: 1 });
  if (mix.length) sets.push(mix);
  return sets;
}

/** A window from the plan's start to its finish, as the engine scheduled it when it was recorded. */
export function madeUpWindows(input: PlanInput): [string | null, string | null][] {
  try {
    const s = computeSchedule(copy(input));
    return [[s.start, s.finish]];
  } catch {
    return [];
  }
}

/** Numbers JSON can't carry (NaN, ±Infinity) would change a plan on the way to its fixture. */
export function jsonSafe(value: unknown, path = '$'): string[] {
  if (typeof value === 'number') return Number.isFinite(value) ? [] : [path];
  if (Array.isArray(value)) return value.flatMap((v, i) => jsonSafe(v, `${path}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => jsonSafe(v, `${path}.${k}`));
  return [];
}

export function writeEntry(name: string, entry: GoldenEntry): void {
  const unsafe = jsonSafe(entry);
  if (unsafe.length) throw new Error(`${name} holds numbers JSON can't keep: ${unsafe.join(' ')}`);
  mkdirSync(INPUTS, { recursive: true });
  writeFileSync(join(INPUTS, `${name}.json`), render(entry));
}

export function readEntries(): { name: string; entry: GoldenEntry }[] {
  return readdirSync(INPUTS)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ name: f.slice(0, -'.json'.length), entry: JSON.parse(readFileSync(join(INPUTS, f), 'utf8')) as GoldenEntry }));
}

export function readOutput(name: string): string {
  return readFileSync(join(OUTPUTS, `${name}.json`), 'utf8');
}

export function writeOutput(name: string, text: string): void {
  mkdirSync(OUTPUTS, { recursive: true });
  writeFileSync(join(OUTPUTS, `${name}.json`), text);
}
