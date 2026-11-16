/**
 * Web Push's two pieces of cryptography, with Node's own crypto and nothing else (D47):
 *
 * - VAPID (RFC 8292): a4a says who it is to a push service with a JWT signed by its key (ES256),
 *   and the service sends only for the key a subscription was made with.
 * - Message encryption (RFC 8291, aes128gcm of RFC 8188): each message is encrypted to the
 *   device's own key, so the push service carries what it can't read.
 *
 * Keys travel as browsers give them: base64url, a public key as its 65-byte uncompressed point,
 * a private key as its 32-byte scalar.
 */
import { createECDH, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, createCipheriv, randomBytes, sign, type KeyObject } from 'node:crypto';

export interface VapidKeys {
  /** The 65-byte uncompressed point, base64url: what a browser's pushManager.subscribe takes. */
  publicKey: string;
  /** The 32-byte scalar, base64url. */
  privateKey: string;
}

export interface DeviceKeys {
  /** The device's public key (p256dh), base64url. */
  p256dh: string;
  /** The device's 16-byte authentication secret, base64url. */
  auth: string;
}

const b64 = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), unb64(jwk.x!), unb64(jwk.y!)]);
  return { publicKey: b64(point), privateKey: jwk.d! };
}

/** Whether a public key is a P-256 point a browser gave: 65 bytes, uncompressed, on the curve. */
export function validPublicKey(key: string, length = 65): boolean {
  try {
    const raw = unb64(key);
    if (raw.length !== length || raw[0] !== 4) return false;
    createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64(raw.subarray(1, 33)), y: b64(raw.subarray(33, 65)) }, format: 'jwk' });
    return true;
  } catch {
    return false;
  }
}

function privateKeyObject(keys: VapidKeys): KeyObject {
  const point = unb64(keys.publicKey);
  return createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64(point.subarray(1, 33)), y: b64(point.subarray(33, 65)) },
    format: 'jwk',
  });
}

/** Whether a pair belongs together, so a key set in the environment is checked once, at start. */
export function vapidPairMatches(keys: VapidKeys): boolean {
  try {
    // The public point worked out from the private scalar: a JWK's x and y would be taken on trust.
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(unb64(keys.privateKey));
    return b64(ecdh.getPublicKey()) === keys.publicKey;
  } catch {
    return false;
  }
}

/**
 * The Authorization header for one push service (its origin is the token's audience): a JWT good
 * for `ttlSeconds` (at most a day, RFC 8292), signed ES256, with the public key beside it.
 */
export function vapidAuthorization(keys: VapidKeys, audience: string, subject: string, now = Date.now(), ttlSeconds = 12 * 3600): string {
  const header = b64(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64(Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + Math.min(ttlSeconds, 24 * 3600), sub: subject })));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: privateKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64(signature)}, k=${keys.publicKey}`;
}

/** The record size a4a declares: one record holds any payload it sends. */
const RECORD_SIZE = 4096;

/** The largest payload one record carries: 4096, less the header (86), the tag (16) and the delimiter (1). */
export const MAX_PAYLOAD = RECORD_SIZE - 86 - 16 - 1;

/**
 * Encrypt a payload to a device (RFC 8291): an ephemeral key per message, its secret with the
 * device's key, keyed by the device's authentication secret. One record, with the delimiter that
 * says it's the last. `salt` and `ephemeral` are for the RFC's worked example; leave them out.
 */
export function encryptPayload(device: DeviceKeys, payload: Buffer, opts: { salt?: Buffer; ephemeral?: Buffer } = {}): Buffer {
  if (payload.length > MAX_PAYLOAD) throw new Error(`A push message holds ${MAX_PAYLOAD} bytes at most`);
  const uaPublic = unb64(device.p256dh);
  const authSecret = unb64(device.auth);
  const ecdh = createECDH('prime256v1');
  if (opts.ephemeral) ecdh.setPrivateKey(opts.ephemeral);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = opts.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}
