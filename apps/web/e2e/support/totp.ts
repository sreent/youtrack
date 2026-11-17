/**
 * An authenticator app, for the tests: the code for a secret (RFC 6238, as a4a and the apps make
 * it), now or some 30-second steps from now. The server's clock decides, not the page's.
 */
import { createHmac } from 'node:crypto';
import type { Page } from '@playwright/test';
import { BASE_URL } from './env';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decode(secret: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of secret.toUpperCase().replace(/[\s=-]/g, '')) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(secret: string, stepsFromNow = 0): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + stepsFromNow));
  const mac = createHmac('sha1', decode(secret)).update(counter).digest();
  const at = mac[mac.length - 1]! & 0x0f;
  const n = ((mac[at]! & 0x7f) << 24) | (mac[at + 1]! << 16) | (mac[at + 2]! << 8) | mac[at + 3]!;
  return String(n % 1_000_000).padStart(6, '0');
}

/**
 * Sign `page`'s browser in as someone and turn their two-factor sign-in on, as they would from
 * their profile. Leaves them signed out; returns the secret their app holds.
 */
export async function withTwoFactor(page: Page, login: string, password: string): Promise<string> {
  const headers = { origin: BASE_URL };
  const signedIn = await page.request.post('/api/v1/auth/login', { data: { login, password } });
  if (!signedIn.ok()) throw new Error(`sign-in: ${signedIn.status()}`);
  const started = await page.request.post('/api/v1/me/two-factor/setup', { headers });
  if (!started.ok()) throw new Error(`setup: ${started.status()}`);
  const secret = new URL(((await started.json()) as { otpauthUri: string }).otpauthUri).searchParams.get('secret')!;
  const on = await page.request.post('/api/v1/me/two-factor/confirm', { data: { code: totp(secret) }, headers });
  if (!on.ok()) throw new Error(`confirm: ${on.status()}`);
  await page.request.post('/api/v1/auth/logout', { headers });
  await page.context().clearCookies();
  return secret;
}
