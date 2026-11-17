import type { CaptchaChallenge } from '@a4a/shared';

const BATCH = 256;
const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The number from 0 to `maxnumber` whose SHA-256 of `salt + number` is the challenge, found with
 * WebCrypto a batch at a time; null if there's none (a challenge that wasn't the server's).
 */
export async function findNumber(c: Pick<CaptchaChallenge, 'salt' | 'challenge' | 'maxnumber'>, stopped: () => boolean = () => false): Promise<number | null> {
  for (let start = 0; start <= c.maxnumber; start += BATCH) {
    if (stopped()) return null;
    const end = Math.min(start + BATCH - 1, c.maxnumber);
    const numbers = Array.from({ length: end - start + 1 }, (_, i) => start + i);
    const hashes = await Promise.all(numbers.map((n) => crypto.subtle.digest('SHA-256', encoder.encode(`${c.salt}${n}`))));
    const found = hashes.findIndex((h) => hex(h) === c.challenge);
    if (found >= 0) return numbers[found]!;
  }
  return null;
}
