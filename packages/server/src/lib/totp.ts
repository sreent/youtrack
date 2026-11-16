/**
 * Time-based one-time passwords (RFC 6238, over RFC 4226's HOTP), as authenticator apps make them:
 * HMAC-SHA1, six digits, a 30-second step. A code is taken from the step before or after too, for
 * a clock a little off, and never twice: the caller keeps the last step taken.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_STEP_S = 30;
export const TOTP_DIGITS = 6;
/** Steps either side of now a code is taken from. */
export const TOTP_WINDOW = 1;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('Not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret: 160 bits, as RFC 4226 recommends, in base32 as apps take it. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function stepAt(ms: number): number {
  return Math.floor(ms / 1000 / TOTP_STEP_S);
}

/** The code for one step. */
export function codeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * The step a code belongs to, if it is right now (give or take a step) and later than `lastStep`;
 * otherwise null. Compared in constant time.
 */
export function checkCode(secret: string, code: string, nowMs: number, lastStep: number | null): number | null {
  const given = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const now = stepAt(nowMs);
  for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d++) {
    const step = now + d;
    if (lastStep !== null && step <= lastStep) continue;
    const want = Buffer.from(codeAt(secret, step));
    if (timingSafeEqual(want, Buffer.from(given))) return step;
  }
  return null;
}

/** The address an authenticator app reads from the QR code: "otpauth://totp/a4a:anna?secret=…&issuer=a4a". */
export function otpauthUri(secret: string, issuer: string, account: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_S) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
