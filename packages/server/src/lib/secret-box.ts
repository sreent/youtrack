/**
 * Secrets a4a has to read back (a TOTP secret, D38) are kept encrypted: AES-256-GCM, a fresh nonce
 * each time, the result as `v1.<nonce>.<tag>.<ciphertext>` in base64url. A copy of the database
 * alone doesn't give them away.
 *
 * The key comes from SECRET_KEY, the same on every instance. Without it, a4a makes one the first
 * time it needs it, in DATA_DIR/secret.key (readable by its owner alone), and keeps it there: then
 * back that file up with the database, or the secrets can't be read.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface KeySource {
  secretKey?: string;
  dataDir: string;
}

const keys = new Map<string, Buffer>();

/** 32 bytes: SECRET_KEY as base64 or hex of that length, or any other text hashed to it. */
function keyFrom(text: string): Buffer {
  const t = text.trim();
  if (/^[0-9a-f]{64}$/i.test(t)) return Buffer.from(t, 'hex');
  const b64 = Buffer.from(t, 'base64');
  if (b64.length === 32 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) return b64;
  return createHash('sha256').update(t, 'utf8').digest();
}

export function secretKey(source: KeySource): Buffer {
  const cacheKey = source.secretKey ? `env:${source.secretKey}` : `file:${source.dataDir}`;
  const hit = keys.get(cacheKey);
  if (hit) return hit;
  let key: Buffer;
  if (source.secretKey?.trim()) {
    key = keyFrom(source.secretKey);
  } else {
    const file = path.join(source.dataDir, 'secret.key');
    if (existsSync(file)) {
      key = keyFrom(readFileSync(file, 'utf8'));
    } else {
      mkdirSync(source.dataDir, { recursive: true });
      const made = randomBytes(32).toString('base64');
      // Only if nobody made one meanwhile: another process starting at once keeps theirs.
      try {
        writeFileSync(file, `${made}\n`, { flag: 'wx', mode: 0o600 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      try {
        chmodSync(file, 0o600);
      } catch {
        // a file system without permissions
      }
      key = keyFrom(readFileSync(file, 'utf8'));
    }
  }
  keys.set(cacheKey, key);
  return key;
}

export function seal(source: KeySource, plain: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(source), nonce);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

/** The plain text, or null when it was sealed with another key or changed since. */
export function open(source: KeySource, sealed: string): string | null {
  const [version, nonce, tag, body] = sealed.split('.');
  if (version !== 'v1' || !nonce || !tag || body === undefined) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', secretKey(source), Buffer.from(nonce, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
