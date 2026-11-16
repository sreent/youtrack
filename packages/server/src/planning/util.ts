/** Small helpers shared by the planning modules. */
import { isISODate } from '../lib/dates';

/** Rounds half away from zero to `places` decimals; never returns -0 or NaN. */
export function round(value: number, places: number): number {
  if (!Number.isFinite(value)) return 0;
  const f = 10 ** places;
  const r = Math.round(Math.abs(value) * f * (1 + Number.EPSILON)) / f;
  return value < 0 && r !== 0 ? -r : r;
}

/** Money is rounded to cents, at the output boundary only. */
export const money = (value: number): number => round(value, 2);

/** Hours are reported to two decimals. */
export const hours2 = (value: number): number => round(value, 2);

/** `Math.ceil` that ignores floating-point dust (16.000000001 → 16). */
export function ceilSafe(value: number): number {
  return Math.ceil(value - 1e-9);
}

/** A finite number, or `fallback`. */
export function finite(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const CHUNKS = /\d+|\D+/g;

/** Natural order for readable ids: MIG-2 < MIG-10 < WEB-1. */
export function compareIds(a: string, b: string): number {
  const xs = a.match(CHUNKS) ?? [];
  const ys = b.match(CHUNKS) ?? [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    const x = xs[i]!;
    const y = ys[i]!;
    if (x === y) continue;
    const xNum = /^\d/.test(x);
    const yNum = /^\d/.test(y);
    if (xNum && yNum && Number(x) !== Number(y)) return Number(x) - Number(y);
    return x < y ? -1 : 1;
  }
  return xs.length - ys.length || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * An ISO date, or null. Accepts a timestamp's date part ("2026-03-01T09:00Z");
 * anything else is reported through `onInvalid` and dropped.
 */
export function cleanDate(value: string | null | undefined, onInvalid: (raw: string) => void): string | null {
  if (value == null || value === '') return null;
  const day = value.length > 10 && value[10] === 'T' ? value.slice(0, 10) : value;
  if (isISODate(day)) return day;
  onInvalid(value);
  return null;
}

/** Ordered, de-duplicated warnings. */
export class Warnings {
  private readonly seen = new Set<string>();
  readonly list: string[] = [];

  add = (message: string): void => {
    if (this.seen.has(message)) return;
    this.seen.add(message);
    this.list.push(message);
  };
}

/** Pushes `value` onto the array stored under `key`. */
export function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
