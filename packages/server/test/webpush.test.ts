/** Web Push's cryptography (D47): RFC 8291's worked example, a round trip, and VAPID's token. */
import { createECDH, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptPayload, generateVapidKeys, MAX_PAYLOAD, vapidAuthorization, vapidPairMatches, validPublicKey } from '../src/push/webpush';
import { decryptAes128gcm, readVapid } from './fake-push';

describe('message encryption (RFC 8291)', () => {
  it("gives the RFC's worked example, byte for byte", () => {
    const out = encryptPayload(
      { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
      Buffer.from('When I grow up, I want to be a watermelon'),
      { salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), ephemeral: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url') },
    );
    expect(out.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('decrypts on the device, and differs each time it is sent', () => {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const device = { keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') }, privateKey: ecdh.getPrivateKey() };
    const text = JSON.stringify({ title: 'BACK-12: Sign-in page times out', body: 'Anna Schmidt mentioned you' });
    const a = encryptPayload(device.keys, Buffer.from(text));
    const b = encryptPayload(device.keys, Buffer.from(text));
    expect(a.equals(b)).toBe(false);
    expect(decryptAes128gcm(a, device)?.toString('utf8')).toBe(text);
    // Another device's keys read nothing.
    const other = createECDH('prime256v1');
    other.generateKeys();
    expect(decryptAes128gcm(a, { keys: { p256dh: other.getPublicKey().toString('base64url'), auth: device.keys.auth }, privateKey: other.getPrivateKey() })).toBeNull();
  });

  it('holds one record, and refuses more', () => {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
    expect(encryptPayload(keys, Buffer.alloc(MAX_PAYLOAD, 0x61)).length).toBeLessThanOrEqual(4096);
    expect(() => encryptPayload(keys, Buffer.alloc(MAX_PAYLOAD + 1, 0x61))).toThrow(/at most/);
  });
});

describe('VAPID (RFC 8292)', () => {
  it('signs a token for the push service, good for at most a day', () => {
    const keys = generateVapidKeys();
    expect(validPublicKey(keys.publicKey)).toBe(true);
    expect(vapidPairMatches(keys)).toBe(true);
    const now = Date.UTC(2026, 10, 16, 12);
    const claims = readVapid(vapidAuthorization(keys, 'https://fcm.googleapis.com', 'mailto:a4a@example.com', now, 48 * 3600));
    expect(claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: now / 1000 + 24 * 3600, sub: 'mailto:a4a@example.com', key: keys.publicKey });
  });

  it("knows a pair that doesn't belong together, and a key that isn't a point", () => {
    const a = generateVapidKeys();
    const b = generateVapidKeys();
    expect(vapidPairMatches({ publicKey: a.publicKey, privateKey: b.privateKey })).toBe(false);
    expect(validPublicKey(Buffer.alloc(65, 4).toString('base64url'))).toBe(false);
    expect(validPublicKey('not-a-key')).toBe(false);
  });
});
