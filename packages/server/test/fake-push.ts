/**
 * A push service, on a port of its own, for tests: it keeps what's posted to it and answers as it's
 * told. It decrypts each message as a browser would (RFC 8291), with the keys of the "devices" it
 * hands out, by its own reading of the RFC (an HMAC chain, not the server's HKDF calls), so what
 * a4a sends is checked from the other side.
 */
import { createECDH, createDecipheriv, createHmac, randomBytes, verify as verifySignature, createPublicKey } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeDevice {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** The device's private key, to decrypt what's sent to it. */
  privateKey: Buffer;
}

export interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** The payload, decrypted with the device's keys; null when it doesn't decrypt. */
  payload: unknown;
  /** The VAPID token's claims, when its signature is good for the key sent beside it. */
  vapid: { aud: string; exp: number; sub: string; key: string } | null;
}

export interface FakePush {
  url: string;
  received: Received[];
  device(name?: string): FakeDevice;
  /** Answer the next posts to a device's path with these statuses, in order, then 201 again. */
  answer(device: FakeDevice, ...statuses: number[]): void;
  close(): Promise<void>;
}

const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

export function decryptAes128gcm(body: Buffer, device: { privateKey: Buffer; keys: { p256dh: string; auth: string } }): Buffer | null {
  try {
    const salt = body.subarray(0, 16);
    const idlen = body[20]!;
    const asPublic = body.subarray(21, 21 + idlen);
    const ciphertext = body.subarray(21 + idlen);
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(device.privateKey);
    const uaPublic = Buffer.from(device.keys.p256dh, 'base64url');
    const shared = ecdh.computeSecret(asPublic);
    const authSecret = Buffer.from(device.keys.auth, 'base64url');
    const prkKey = hmac(authSecret, shared);
    const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
    const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
    const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
    // The last record ends with 2, then any padding of zeros.
    let end = plain.length - 1;
    while (end >= 0 && plain[end] === 0) end--;
    if (plain[end] !== 2) return null;
    return plain.subarray(0, end);
  } catch {
    return null;
  }
}

/** The claims of `Authorization: vapid t=…, k=…`, when the token's signature is the key's. */
export function readVapid(header: string | undefined): Received['vapid'] {
  const m = /^vapid t=([^,]+),\s*k=(.+)$/.exec(header ?? '');
  if (!m) return null;
  const [token, key] = [m[1]!, m[2]!.trim()];
  const [h, c, s] = token.split('.');
  if (!h || !c || !s) return null;
  const point = Buffer.from(key, 'base64url');
  const publicKey = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33, 65).toString('base64url') },
    format: 'jwk',
  });
  const good = verifySignature('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  if (!good) return null;
  return { ...(JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as { aud: string; exp: number; sub: string }), key };
}

export async function fakePush(): Promise<FakePush> {
  const devices = new Map<string, FakeDevice>();
  const answers = new Map<string, number[]>();
  const received: Received[] = [];
  let n = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = req.url ?? '/';
      const body = Buffer.concat(chunks);
      const device = devices.get(path);
      const plain = device ? decryptAes128gcm(body, device) : null;
      let payload: unknown = null;
      try {
        payload = plain ? JSON.parse(plain.toString('utf8')) : null;
      } catch {
        payload = null;
      }
      received.push({ path, headers: req.headers, body, payload, vapid: readVapid(req.headers.authorization) });
      const queue = answers.get(path);
      const status = queue?.length ? queue.shift()! : device ? 201 : 404;
      if (status === 429) res.setHeader('retry-after', '1');
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    received,
    device(name) {
      const ecdh = createECDH('prime256v1');
      ecdh.generateKeys();
      const path = `/push/${name ?? `device-${++n}`}-${randomBytes(4).toString('hex')}`;
      const device: FakeDevice = {
        endpoint: `${url}${path}`,
        keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
        privateKey: ecdh.getPrivateKey(),
      };
      devices.set(path, device);
      return device;
    },
    answer(device, ...statuses) {
      answers.set(new URL(device.endpoint).pathname, statuses);
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
