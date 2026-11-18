/**
 * The arithmetic of a place (D65, `@a4a/shared/ranks`): a key between two, before the first, after the
 * last; many placed at one spot, kept in order and bounded by writing the order afresh; keys that sort
 * by their bytes; and the database making the same keys as `keyAt`, and ordering them as JavaScript does.
 */
import { RANK_DIGITS, RANK_KEY_LIMIT, isRankKey, keyAt, keyBetween, keysBetween } from '@a4a/shared/ranks';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rankKeySql } from '../src/services/rank-keys';
import { createWorld, type TestWorld } from './helpers';

/** Ordered and distinct, by JavaScript's comparison and by their bytes alike. */
function inOrder(keys: readonly string[]): boolean {
  for (let i = 1; i < keys.length; i++) {
    if (!(keys[i - 1]! < keys[i]!)) return false;
    if (Buffer.compare(Buffer.from(keys[i - 1]!), Buffer.from(keys[i]!)) >= 0) return false;
  }
  return true;
}

/** A seeded generator, so a failure can be run again. */
function random(seed: number): () => number {
  let x = seed;
  return () => ((x = (x * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
}

/**
 * An order kept as a board keeps it: a key between the neighbours, and, where it would pass the
 * limit, every key written afresh as `keyAt(i)` first. Returns how many times that happened.
 */
function placeAt(order: string[], index: number): number {
  const key = keyBetween(order[index - 1] ?? null, order[index] ?? null);
  if (key.length <= RANK_KEY_LIMIT) {
    order.splice(index, 0, key);
    return 0;
  }
  order.forEach((_, i) => (order[i] = keyAt(i)));
  order.splice(index, 0, keyBetween(order[index - 1] ?? null, order[index] ?? null));
  return 1;
}

describe('keys between', () => {
  it('starts an order, and goes after the last, before the first, and between two', () => {
    expect(keyBetween(null, null)).toBe('a0');
    expect(keyBetween('a0', null)).toBe('a1');
    expect(keyBetween('az', null)).toBe('b00');
    expect(keyBetween(null, 'a0')).toBe('Zz');
    expect(keyBetween(null, 'Z0')).toBe('Yzz');
    expect(keyBetween('a0', 'a1')).toBe('a0V');
    expect(keyBetween('a0', 'a0V')).toBe('a0G');
    expect(keyBetween('a0V', 'a1')).toBe('a0l');
    // Between a key and one that goes on past it, the shorter is enough.
    expect(keyBetween('a0V', 'a0W1')).toBe('a0W');
    for (const [a, b] of [
      ['a0', 'a1'],
      ['Zz', 'a0'],
      ['a0V', 'a0V1'],
      ['b00', 'b01'],
      ['a1', 'b00'],
    ] as const) {
      const k = keyBetween(a, b);
      expect(inOrder([a, k, b])).toBe(true);
      expect(isRankKey(k)).toBe(true);
    }
  });

  it('refuses what isn’t a key, and two out of order', () => {
    expect(() => keyBetween('a1', 'a0')).toThrow(/not before/);
    expect(() => keyBetween('a0', 'a0')).toThrow(/not before/);
    for (const bad of ['', 'a', 'a00', 'b0', '!x', 'a0 ', 'A' + '0'.repeat(26)]) {
      expect(isRankKey(bad)).toBe(false);
      expect(() => keyBetween(bad, null)).toThrow(/Not a rank key/);
    }
  });

  it('keeps order and stays short at either end, however many go there', () => {
    const tail = ['a0'];
    for (let i = 0; i < 100_000; i++) tail.push(keyBetween(tail.at(-1)!, null));
    expect(inOrder(tail)).toBe(true);
    expect(Math.max(...tail.map((k) => k.length))).toBe(4);
    const head = ['a0'];
    for (let i = 0; i < 10_000; i++) head.unshift(keyBetween(null, head[0]!));
    expect(inOrder(head)).toBe(true);
    expect(Math.max(...head.map((k) => k.length))).toBe(4);
  });

  it('keeps many placed at one spot in order, and bounded by writing the order afresh', () => {
    // Always just after the first card: the gap there halves each time, a character every six or so.
    const order = [keyAt(0), keyAt(1), keyAt(2)];
    let longest = 0;
    let rewrites = 0;
    let firstRewriteAt = -1;
    for (let i = 0; i < 5_000; i++) {
      const n = placeAt(order, 1);
      if (n && firstRewriteAt < 0) firstRewriteAt = i;
      rewrites += n;
      longest = Math.max(longest, ...order.map((k) => k.length));
    }
    expect(inOrder(order)).toBe(true);
    expect(order).toHaveLength(5_003);
    expect(longest).toBeLessThanOrEqual(RANK_KEY_LIMIT);
    // A board is written afresh only after hundreds of moves at one spot.
    expect(firstRewriteAt).toBeGreaterThan(300);
    expect(rewrites).toBeLessThan(5_000 / 300);
    // Just before one card, over and over, too.
    const before = [keyAt(0), keyAt(1)];
    for (let i = 0; i < 2_000; i++) placeAt(before, before.length - 1);
    expect(inOrder(before)).toBe(true);
    expect(Math.max(...before.map((k) => k.length))).toBeLessThanOrEqual(RANK_KEY_LIMIT);
  });

  it('keeps any order of places in order, at random', () => {
    const next = random(65);
    const order: string[] = [];
    for (let i = 0; i < 5_000; i++) placeAt(order, Math.floor(next() * (order.length + 1)));
    expect(inOrder(order)).toBe(true);
    expect(order.every(isRankKey)).toBe(true);
    expect(Math.max(...order.map((k) => k.length))).toBeLessThanOrEqual(RANK_KEY_LIMIT);
  });

  it('spreads several keys between two, or after the last', () => {
    for (const [a, b, n] of [
      ['a0', 'a1', 50],
      [null, 'a0', 7],
      ['a5', null, 20],
      [null, null, 3],
      ['a0V', 'a0W', 100],
    ] as const) {
      const keys = keysBetween(a, b, n);
      expect(keys).toHaveLength(n);
      expect(inOrder([...(a ? [a] : []), ...keys, ...(b ? [b] : [])])).toBe(true);
    }
    expect(keysBetween('a0', 'a1', 0)).toEqual([]);
  });
});

describe('a board written afresh', () => {
  it('numbers keys from a0, each the one after the last', () => {
    let k = keyAt(0);
    expect(k).toBe('a0');
    for (let n = 1; n < 5_000; n++) {
      k = keyBetween(k, null);
      expect(keyAt(n)).toBe(k);
    }
    expect([61, 62, 3_905, 3_906, 242_233, 242_234].map(keyAt)).toEqual(['az', 'b00', 'bzz', 'c000', 'czzz', 'd0000']);
    expect(keyAt(49_999)).toHaveLength(4);
    expect(() => keyAt(-1)).toThrow();
    expect(RANK_DIGITS).toHaveLength(62);
  });
});

describe('in the database', () => {
  let w: TestWorld;
  beforeAll(async () => {
    w = await createWorld({ projects: false });
  });
  afterAll(async () => w?.close());

  it('makes the keys keyAt makes', async () => {
    const ns = [0, 1, 61, 62, 63, 3_905, 3_906, 3_907, 49_999, 50_000, 242_233, 242_234, 15_018_569, 15_018_570, 20_000_000];
    const res = await w.app.db.execute(sql`SELECT n, ${rankKeySql(sql`n`)} AS key FROM unnest(${sql.raw(`ARRAY[${ns.join(',')}]::bigint[]`)}) AS n`);
    const got = (res as unknown as { rows: { n: string | number; key: string }[] }).rows.map((r) => [Number(r.n), r.key]);
    expect(got).toEqual(ns.map((n) => [n, keyAt(n)]));
  });

  it('orders keys by their bytes, as JavaScript does, whatever the database’s collation', async () => {
    const next = random(7);
    const order: string[] = [];
    for (let i = 0; i < 500; i++) placeAt(order, Math.floor(next() * (order.length + 1)));
    const shuffled = [...order].sort(() => next() - 0.5);
    const values = sql.join(
      shuffled.map((k) => sql`(${k})`),
      sql`, `,
    );
    const res = await w.app.db.execute(sql`SELECT k FROM (VALUES ${values}) AS v(k) ORDER BY k COLLATE "C"`);
    expect((res as unknown as { rows: { k: string }[] }).rows.map((r) => r.k)).toEqual(order);
  });
});
