/**
 * A push service for the browser tests (D47), on a port of its own: it takes what a4a sends a
 * device and decrypts it as the device would (RFC 8291), with keys made here. The page is given a
 * PushManager that subscribes to it (fakePushManager), since a test browser has no real one to reach.
 */
import { createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface PushDevice {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushReceiver {
  device: PushDevice;
  /** What reached the device, decrypted. */
  received: unknown[];
  close(): Promise<void>;
}

const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

function decrypt(body: Buffer, privateKey: Buffer, keys: PushDevice['keys']): unknown {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(privateKey);
  const shared = ecdh.computeSecret(asPublic);
  const ikm = hmac(hmac(Buffer.from(keys.auth, 'base64url'), shared), Buffer.concat([Buffer.from('WebPush: info\0'), Buffer.from(keys.p256dh, 'base64url'), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString('utf8'));
}

export async function pushReceiver(): Promise<PushReceiver> {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
  const received: unknown[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        received.push(decrypt(Buffer.concat(chunks), ecdh.getPrivateKey(), keys));
        res.writeHead(201).end();
      } catch {
        res.writeHead(400).end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/push/${randomBytes(6).toString('hex')}`;
  return { device: { endpoint, keys }, received, close: () => new Promise((r) => server.close(() => r())) };
}

/**
 * For addInitScript: the page's PushManager subscribes to the receiver, and remembers so across
 * pages of the context (sessionStorage), as a browser keeps its subscription. And the person allows
 * notifications when asked: a headless browser says "denied" whatever it was granted.
 */
export function fakePushManager(device: PushDevice): void {
  const KEY = 'e2e.push.subscribed';
  Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
  Notification.requestPermission = async () => 'granted';
  const make = (applicationServerKey: string) => ({
    endpoint: device.endpoint,
    expirationTime: null,
    options: { userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(applicationServerKey), (c) => c.charCodeAt(0)).buffer },
    toJSON: () => ({ endpoint: device.endpoint, expirationTime: null, keys: device.keys }),
    unsubscribe: async () => {
      sessionStorage.removeItem(KEY);
      return true;
    },
  });
  const proto = PushManager.prototype as unknown as Record<string, unknown>;
  proto.subscribe = async function (options: { applicationServerKey: Uint8Array }) {
    const raw = btoa(String.fromCharCode(...new Uint8Array(options.applicationServerKey)));
    sessionStorage.setItem(KEY, raw);
    return make(raw);
  };
  proto.getSubscription = async function () {
    const raw = sessionStorage.getItem(KEY);
    return raw ? make(raw) : null;
  };
}
