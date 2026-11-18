/**
 * A card's place on a board, as a fractional key (docs/architecture.md, D65): a string that sorts by
 * its bytes, as Postgres's "C" collation and JavaScript's `<` both compare them, with a key always
 * to be had between any two others. The server makes every key, under the board's lock; the page and
 * the server share this arithmetic, so a place is worked out one way.
 *
 * A key is an integer part and a fraction. The integer part is a head, which says how many digits
 * follow (`a` one, `b` two … `z` twenty-six; `Z` one … `A` twenty-six, for the integers below zero),
 * and those digits; the fraction is any digits after it, never ending in the smallest. Base 62, in
 * the digits' byte order, so a key's order is its bytes' order. Appending at either end steps the
 * integer part, which grows by a digit only every 62, 3,844, 238,328 … steps; placing between two
 * keys halves the gap in the fraction, about a digit every six times at one spot. That alone has no
 * end, so a key past `RANK_KEY_LIMIT` is never written: the board's keys are written afresh, in their
 * order, as `keyAt(0)`, `keyAt(1)` …, which are four characters for a quarter of a million cards.
 *
 * The scheme is David Greenspan's ("Implementing Fractional Indexing", 2020), written here from his
 * description: a few dozen lines, so a dependency would bring more than it saves.
 */

/** The digits, in their byte order. */
export const RANK_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = RANK_DIGITS.length;
const ZERO = RANK_DIGITS[0]!;
const TOP = RANK_DIGITS[BASE - 1]!;
/** The smallest integer part, which nothing can come before: kept out of every key. */
const SMALLEST = 'A' + ZERO.repeat(26);

/**
 * The longest key a board keeps. A move whose key would be longer has the board's keys (or its
 * lane's) written afresh first, under the board's lock: so a key is at most this long, however
 * often people place cards at one spot.
 */
export const RANK_KEY_LIMIT = 64;

const digit = (c: string): number => RANK_DIGITS.indexOf(c);

/** How long the integer part a head begins is, the head included; 0 for a character that's no head. */
function integerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  return 0;
}

/** Whether a string is a key this arithmetic makes: a head, its digits, and a fraction not ending in the smallest digit. */
export function isRankKey(key: unknown): key is string {
  if (typeof key !== 'string' || !key) return false;
  const n = integerLength(key[0]!);
  if (!n || key.length < n) return false;
  for (let i = 1; i < key.length; i++) if (digit(key[i]!) < 0) return false;
  if (key.slice(0, n) === SMALLEST) return false;
  return key.length === n || key[key.length - 1] !== ZERO;
}

function check(key: string): void {
  if (!isRankKey(key)) throw new Error(`Not a rank key: ${JSON.stringify(key)}`);
}

/**
 * A fraction strictly between two, as digits after the point: `a` may be empty (zero), `b` null
 * (one). Neither ends in the smallest digit, and a < b.
 */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    // The common prefix stays; `a` reads as zeros past its end.
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? digit(a[0]!) : 0;
  const db = b !== null ? digit(b[0]!) : BASE;
  if (db - da > 1) return RANK_DIGITS[Math.round((da + db) / 2)]!;
  // Neighbouring digits: b's first digit alone is between when b goes on past it, else a's digit and
  // a fraction between the rest of a and one.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return RANK_DIGITS[da]! + midpoint(a.slice(1), null);
}

/** The next integer part, or null past the largest. */
function increment(int: string): string | null {
  const head = int[0]!;
  const digits = int.slice(1).split('');
  let i = digits.length - 1;
  for (; i >= 0; i--) {
    const d = digit(digits[i]!) + 1;
    if (d < BASE) {
      digits[i] = RANK_DIGITS[d]!;
      return head + digits.join('');
    }
    digits[i] = ZERO;
  }
  // Every digit rolled over: a head with one more digit (or, below zero, one fewer).
  if (head === 'Z') return 'a' + ZERO;
  if (head === 'z') return null;
  const next = String.fromCharCode(head.charCodeAt(0) + 1);
  if (next > 'a') digits.push(ZERO);
  else digits.pop();
  return next + digits.join('');
}

/** The integer part before, or null below the smallest. */
function decrement(int: string): string | null {
  const head = int[0]!;
  const digits = int.slice(1).split('');
  let i = digits.length - 1;
  for (; i >= 0; i--) {
    const d = digit(digits[i]!) - 1;
    if (d >= 0) {
      digits[i] = RANK_DIGITS[d]!;
      return head + digits.join('');
    }
    digits[i] = TOP;
  }
  if (head === 'a') return 'Z' + TOP;
  if (head === 'A') return null;
  const next = String.fromCharCode(head.charCodeAt(0) - 1);
  if (next < 'Z') digits.push(TOP);
  else digits.pop();
  return next + digits.join('');
}

const parts = (key: string): [string, string] => {
  const n = integerLength(key[0]!);
  return [key.slice(0, n), key.slice(n)];
};

/**
 * A key strictly between `a` and `b`: after `a`, or first, when `b` is null; before `b`, or last, when
 * `a` is null; `a0` for an empty order. Throws on what isn't a key, or `a` not before `b`.
 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null) check(a);
  if (b !== null) check(b);
  if (a !== null && b !== null && a >= b) throw new Error(`${a} is not before ${b}`);
  if (a === null && b === null) return 'a' + ZERO;
  if (a === null) {
    const [ib, fb] = parts(b!);
    if (ib === SMALLEST) return ib + midpoint('', fb);
    if (fb) return ib;
    const below = decrement(ib);
    if (below === null) throw new Error('Nothing comes before the smallest key');
    return below;
  }
  const [ia, fa] = parts(a);
  if (b === null) return increment(ia) ?? ia + midpoint(fa, null);
  const [ib, fb] = parts(b);
  if (ia === ib) return ia + midpoint(fa, fb);
  const next = increment(ia);
  if (next !== null && next < b) return next;
  return ia + midpoint(fa, null);
}

/**
 * `n` keys in order, strictly between `a` and `b` (either null for that end), spread so each is
 * short: one after another at an end, halving the gap between two.
 */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  if (b === null || a === null) {
    const out: string[] = [];
    if (b === null) {
      let prev = a;
      for (let i = 0; i < n; i++) out.push((prev = keyBetween(prev, null)));
      return out;
    }
    let next = b;
    for (let i = 0; i < n; i++) out.unshift((next = keyBetween(null, next)));
    return out;
  }
  const mid = Math.floor(n / 2);
  const c = keyBetween(a, b);
  return [...keysBetween(a, c, mid), c, ...keysBetween(c, b, n - mid - 1)];
}

/** Where the integer parts of each length start, counting from `a0`: 0, 62, 3,906, 242,234 … */
const STARTS: number[] = (() => {
  const out = [0];
  for (let len = 1; len < 9; len++) out.push(out[len - 1]! + BASE ** len);
  return out;
})();

/**
 * The `n`th key of a board written afresh: `a0`, `a1` … `az`, `b00` … , the integers from zero, each
 * the one after the last (so `keyAt(n + 1)` is `keyBetween(keyAt(n), null)`). The migration and a
 * board's rewrite make the same keys in SQL (`rankKeySql` on the server).
 */
export function keyAt(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`No key at ${n}`);
  let len = 1;
  while (len < STARTS.length - 1 && n >= STARTS[len]!) len++;
  let rest = n - STARTS[len - 1]!;
  let digits = '';
  for (let i = 0; i < len; i++) {
    digits = RANK_DIGITS[rest % BASE]! + digits;
    rest = Math.floor(rest / BASE);
  }
  return String.fromCharCode('a'.charCodeAt(0) + len - 1) + digits;
}

/** Where each integer part's length starts, for the same keys in SQL: [start, digits] by length. */
export const RANK_KEY_CLASSES: readonly { head: string; from: number; digits: number }[] = STARTS.slice(0, 5).map((from, i) => ({
  head: String.fromCharCode('a'.charCodeAt(0) + i),
  from,
  digits: i + 1,
}));
