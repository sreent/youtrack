/**
 * Passkeys in depth (D68), over HTTP: PASSKEY_RP_ID and related origins, a passkey made for a parent
 * domain signing in at a child host, passkeys required of everyone or of administrators with the guard
 * that keeps an administrator able to sign in, only some authenticators against a fake FIDO BLOB
 * (signed by a certificate chain made here, its attestations by another), accounts with passkeys and
 * no password, setup links, and their rate limits.
 */
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { and, eq } from 'drizzle-orm';
import { CompactSign } from 'jose';
import { createHash, createSign, generateKeyPairSync, KeyObject, randomBytes, webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { passkeyRpIdFromEnv, relatedOriginsFromEnv } from '../src/config';
import { mailOutbox, passkeys, passkeySetupLinks, sessions, users } from '../src/db/schema';
import { createHttpApp } from '../src/http/app';
import { codeAt, stepAt } from '../src/lib/totp';
import { renderMail } from '../src/mail/render';
import { setMailTransportForTests } from '../src/notify/state';
import { issueTokenFor } from '../src/services/auth';
import { insertUser } from '../src/services/users';
import { createWorld, type TestWorld } from './helpers';

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest();
const ZERO = '00000000-0000-0000-0000-000000000000';
const KEY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const KEY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const KEY_C = 'cccccccc-0000-4000-8000-00000000000c';
const ALG = { name: 'ECDSA', hash: 'SHA-256' } as const;

// ---------------------------------------------------------------------------
// Certificates: FIDO's root and its signer for the BLOB; a maker's root and an attestation batch's
// ---------------------------------------------------------------------------

interface Issued {
  cert: x509.X509Certificate;
  keys: CryptoKeyPair;
}

const day = 86_400_000;
const newKeys = () => webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;

async function rootCa(name: string): Promise<Issued> {
  const keys = await newKeys();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(8).toString('hex'),
    name: `CN=${name}, O=Test, C=US`,
    notBefore: new Date(Date.now() - day),
    notAfter: new Date(Date.now() + 365 * day),
    signingAlgorithm: ALG,
    keys,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true)],
  });
  return { cert, keys };
}

async function issue(by: Issued, subject: string): Promise<Issued> {
  const keys = await newKeys();
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: randomBytes(8).toString('hex'),
    subject,
    issuer: by.cert.subject,
    notBefore: new Date(Date.now() - day),
    notAfter: new Date(Date.now() + 365 * day),
    signingAlgorithm: ALG,
    publicKey: keys.publicKey,
    signingKey: by.keys.privateKey,
    extensions: [new x509.BasicConstraintsExtension(false, undefined, true)],
  });
  return { cert, keys };
}

const der = (c: x509.X509Certificate) => Buffer.from(c.rawData);

/** A metadata statement as FIDO's BLOB carries one, for a P-256 authenticator whose attestations chain to `root`. */
const statement = (aaguid: string, name: string, root: x509.X509Certificate) => ({
  legalHeader: 'Test',
  aaguid,
  description: name,
  authenticatorVersion: 1,
  protocolFamily: 'fido2',
  schema: 3,
  upv: [{ major: 1, minor: 0 }],
  authenticationAlgorithms: ['secp256r1_ecdsa_sha256_raw'],
  publicKeyAlgAndEncodings: ['cose'],
  attestationTypes: ['basic_full'],
  userVerificationDetails: [[{ userVerificationMethod: 'presence_internal' }]],
  keyProtection: ['hardware', 'secure_element'],
  matcherProtection: ['on_chip'],
  attachmentHint: ['external'],
  tcDisplay: [],
  attestationRootCertificates: [der(root).toString('base64')],
  icon: 'data:image/png;base64,iVBORw0KGgo=',
});

// ---------------------------------------------------------------------------
// A software authenticator: none, self or full (packed) attestation; synced or not
// ---------------------------------------------------------------------------

class Authenticator {
  readonly id = randomBytes(16);
  private readonly key = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  userHandle = '';
  constructor(private readonly opts: { aaguid?: string; batch?: Issued; synced?: boolean } = {}) {}

  private cose(): Uint8Array {
    const jwk = this.key.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    return isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))], [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))]]));
  }

  private authData(rpId: string, attested: boolean, uv = true): Buffer {
    const synced = this.opts.synced ?? false;
    const flags = 0x01 | (uv ? 0x04 : 0) | (synced ? 0x08 | 0x10 : 0) | (attested ? 0x40 : 0);
    const parts: Buffer[] = [sha(rpId), Buffer.from([flags]), Buffer.alloc(4)];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.id.length);
      parts.push(Buffer.from((this.opts.aaguid ?? ZERO).replace(/-/g, ''), 'hex'), len, this.id, Buffer.from(this.cose()));
    }
    return Buffer.concat(parts);
  }

  register(options: PublicKeyCredentialCreationOptionsJSON, o: { origin: string; fmt?: 'none' | 'packed' | 'self' }): RegistrationResponseJSON {
    this.userHandle = options.user.id;
    const authData = this.authData(options.rp.id!, true);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: o.origin, crossOrigin: false }));
    const fmt = o.fmt ?? (this.opts.batch ? 'packed' : 'none');
    const signed = Buffer.concat([authData, sha(clientData)]);
    let attStmt = new Map<string, unknown>();
    if (fmt === 'packed') {
      const batch = this.opts.batch!;
      const sig = createSign('sha256').update(signed).sign(KeyObject.from(batch.keys.privateKey));
      attStmt = new Map<string, unknown>([['alg', -7], ['sig', new Uint8Array(sig)], ['x5c', [new Uint8Array(der(batch.cert))]]]);
    } else if (fmt === 'self') {
      attStmt = new Map<string, unknown>([['alg', -7], ['sig', new Uint8Array(createSign('sha256').update(signed).sign(this.key.privateKey))]]);
    }
    const attestationObject = isoCBOR.encode(new Map<string, unknown>([['fmt', fmt === 'self' ? 'packed' : fmt], ['attStmt', attStmt], ['authData', new Uint8Array(authData)]]) as never);
    return {
      id: b64(this.id),
      rawId: b64(this.id),
      type: 'public-key',
      response: { clientDataJSON: b64(clientData), attestationObject: b64(attestationObject), transports: ['usb'] },
      clientExtensionResults: {},
      authenticatorAttachment: 'cross-platform',
    };
  }

  sign(options: PublicKeyCredentialRequestOptionsJSON, o: { origin: string }): AuthenticationResponseJSON {
    const authData = this.authData(options.rpId!, false);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: o.origin, crossOrigin: false }));
    const signature = createSign('sha256').update(Buffer.concat([authData, sha(clientData)])).sign(this.key.privateKey);
    return {
      id: b64(this.id),
      rawId: b64(this.id),
      type: 'public-key',
      response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(signature), userHandle: this.userHandle },
      clientExtensionResults: {},
    };
  }
}

// ---------------------------------------------------------------------------
// HTTP, as the browser would
// ---------------------------------------------------------------------------

function client(app: ReturnType<typeof createHttpApp>, base: string) {
  let n = 0;
  const cookieOf = (res: Response, name: string) => {
    const hit = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
    return hit ? hit.split(';')[0]! : '';
  };
  async function call(method: string, p: string, o: { body?: unknown; cookie?: string; bearer?: string; ip?: string } = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': o.ip ?? `10.6.${Math.floor(n / 250) % 250}.${(n++ % 250) + 1}`, origin: base };
    if (o.cookie) headers.cookie = o.cookie;
    if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
    const res = await app.request(p.startsWith('/.well-known') ? p : `/api/v1${p}`, { method, headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
    const text = await res.text();
    return { res, status: res.status, body: text ? JSON.parse(text) : null };
  }
  async function signIn(login: string, password: string) {
    const r = await call('POST', '/auth/login', { body: { login, password } });
    return { ...r, session: cookieOf(r.res, 'a4a_session'), ticket: cookieOf(r.res, 'a4a_2fa') };
  }
  async function addPasskey(session: string, key: Authenticator, fmt?: 'none' | 'packed' | 'self') {
    const options = await call('POST', '/me/passkeys/options', { cookie: session });
    if (options.status !== 200) return options;
    return call('POST', '/me/passkeys', { cookie: session, body: { response: key.register(options.body, { origin: base, fmt }) } });
  }
  async function passkeySignIn(key: Authenticator) {
    const options = await call('POST', '/auth/passkey/options');
    const ticket = cookieOf(options.res, 'a4a_pk');
    const r = await call('POST', '/auth/passkey', { cookie: ticket, body: { response: key.sign(options.body, { origin: base }) } });
    return { ...r, session: cookieOf(r.res, 'a4a_session'), options: options.body };
  }
  async function confirmWithPasskey(session: string, key: Authenticator) {
    const options = await call('POST', '/me/confirm/passkey/options', { cookie: session });
    return call('POST', '/me/confirm/passkey', { cookie: session, body: { response: key.sign(options.body, { origin: base }) } });
  }
  return { call, signIn, addPasskey, passkeySignIn, confirmWithPasskey, cookieOf };
}

// ---------------------------------------------------------------------------

describe('PASSKEY_RP_ID and PASSKEY_RELATED_ORIGINS, checked at start', () => {
  it('takes PUBLIC_URL’s host or a registrable parent of it, by the public suffix list', () => {
    expect(passkeyRpIdFromEnv(undefined, 'https://a4a.example.com', [])).toBeUndefined();
    expect(passkeyRpIdFromEnv('a4a.example.com', 'https://a4a.example.com', [])).toBe('a4a.example.com');
    expect(passkeyRpIdFromEnv('Example.COM.', 'https://a4a.example.com', [])).toBe('example.com');
    expect(passkeyRpIdFromEnv('example.co.uk', 'https://a4a.example.co.uk', [])).toBe('example.co.uk');
    expect(passkeyRpIdFromEnv('corp.github.io', 'https://a4a.corp.github.io', [])).toBe('corp.github.io');
    // A public suffix, ICANN's or a private one, is no relying party: anyone can register under it.
    expect(() => passkeyRpIdFromEnv('co.uk', 'https://a4a.example.co.uk', [])).toThrow(/public suffix.*such as example\.co\.uk/);
    expect(() => passkeyRpIdFromEnv('github.io', 'https://a4a.corp.github.io', [])).toThrow(/public suffix/);
    // Not a parent: a sibling, a longer name, another site, an address.
    expect(() => passkeyRpIdFromEnv('b.example.com', 'https://a4a.example.com', [])).toThrow(/must be PUBLIC_URL's host \(a4a\.example\.com\) or a parent domain of it.*PASSKEY_RELATED_ORIGINS/);
    expect(() => passkeyRpIdFromEnv('ample.com', 'https://a4a.example.com', [])).toThrow(/must be PUBLIC_URL's host/);
    expect(() => passkeyRpIdFromEnv('10.0.0.5', 'https://a4a.example.com', [])).toThrow(/an address/);
    // After a move: the old host, with PUBLIC_URL's origin among the related origins it serves.
    expect(passkeyRpIdFromEnv('a4a.old.com', 'https://a4a.new.com', ['https://a4a.new.com'])).toBe('a4a.old.com');
    expect(() => passkeyRpIdFromEnv('a4a.old.com', 'https://a4a.new.com', ['https://elsewhere.com'])).toThrow(/PASSKEY_RELATED_ORIGINS/);
  });

  it('takes https origins alone, within the five registrable domains browsers read', () => {
    expect(relatedOriginsFromEnv(' https://a4a.new.com , https://a4a.new.com/,http://localhost:3000')).toEqual(['https://a4a.new.com', 'http://localhost:3000']);
    expect(() => relatedOriginsFromEnv('http://a4a.new.com')).toThrow(/must be https/);
    expect(() => relatedOriginsFromEnv('https://a4a.new.com/login')).toThrow(/origin alone/);
    expect(() => relatedOriginsFromEnv('https://10.1.1.1')).toThrow(/address/);
    expect(() => relatedOriginsFromEnv('not a url')).toThrow(/isn't an address/);
    // Two hosts under one registrable domain are one label; six domains are too many.
    expect(relatedOriginsFromEnv('https://a.one.com,https://b.one.com,https://two.com,https://three.com,https://four.com,https://five.co.uk')).toHaveLength(6);
    expect(() => relatedOriginsFromEnv('https://one.com,https://two.com,https://three.com,https://four.com,https://five.com,https://six.com')).toThrow(/at most 5/);
  });
});

describe('an instance that moved: the old host stays the id, the new origin is related', () => {
  let w: TestWorld;
  let http: ReturnType<typeof client>;
  const NEW = 'https://a4a.new.test';
  beforeAll(async () => {
    w = await createWorld({ projects: false, people: false, config: { publicUrl: NEW, passkeyRpId: 'a4a.old.test', passkeyRelatedOrigins: [NEW], trustProxy: 1, secretKey: 'moved' } });
    http = client(createHttpApp(w.app), NEW);
  });
  afterAll(() => w.close());

  it('serves /.well-known/webauthn on whatever host asks, and ceremonies use the old host as the id', async () => {
    const known = await http.call('GET', '/.well-known/webauthn');
    expect(known.status).toBe(200);
    expect(known.body).toEqual({ origins: [NEW] });
    expect(known.res.headers.get('content-type')).toMatch(/application\/json/);
    expect(known.res.headers.get('access-control-allow-origin')).toBe('*');
    const { session } = await http.signIn('admin', 'password-admin');
    const key = new Authenticator();
    const added = await http.addPasskey(session, key);
    expect(added.status).toBe(201);
    const [row] = await w.app.db.select().from(passkeys).where(eq(passkeys.userId, w.admin.id));
    expect(row!.rpId).toBe('a4a.old.test');
    const signedIn = await http.passkeySignIn(key);
    expect(signedIn.options.rpId).toBe('a4a.old.test');
    expect(signedIn.status).toBe(200);
  });
});

describe('passkeys in depth over HTTP', () => {
  const BASE = 'https://a4a.corp.test';
  let w: TestWorld;
  let http: ReturnType<typeof client>;
  let adminToken = '';
  let dir = '';
  let blobFile = '';
  let fido: Issued;
  let signer: Issued;
  let maker: Issued;
  let batch: Issued;
  let stranger: Issued;
  let no = 10;
  const sent: { to: string; subject: string; text: string }[] = [];

  /** A BLOB as FIDO publishes one: entries, signed by a certificate that chains to `fido`. */
  async function blob(o: { no?: number; nextUpdate?: string; by?: Issued; entries?: unknown[] } = {}) {
    const entries = o.entries ?? [
      { aaguid: KEY_A, metadataStatement: statement(KEY_A, 'Test Key A', maker.cert), statusReports: [{ status: 'FIDO_CERTIFIED', effectiveDate: '2025-01-01' }], timeOfLastStatusChange: '2025-01-01' },
      { aaguid: KEY_B, metadataStatement: statement(KEY_B, 'Test Key B', maker.cert), statusReports: [{ status: 'FIDO_CERTIFIED' }, { status: 'ATTESTATION_KEY_COMPROMISE' }], timeOfLastStatusChange: '2025-06-01' },
    ];
    const payload = { legalHeader: 'Test', no: o.no ?? no, nextUpdate: o.nextUpdate ?? '2099-01-01', entries };
    const by = o.by ?? signer;
    return new CompactSign(new TextEncoder().encode(JSON.stringify(payload))).setProtectedHeader({ alg: 'ES256', typ: 'JWT', x5c: [der(by.cert).toString('base64')] }).sign(by.keys.privateKey);
  }
  const publish = async (o: Parameters<typeof blob>[0] = {}) => writeFileSync(blobFile, await blob(o));
  const refresh = () => http.call('POST', '/passkey-metadata/refresh', { bearer: adminToken });
  const settings = (body: unknown) => http.call('PATCH', '/settings', { bearer: adminToken, body });
  const mails = (userId: string, kind: string) => w.app.db.select().from(mailOutbox).where(and(eq(mailOutbox.userId, userId), eq(mailOutbox.kind, kind)));

  beforeAll(async () => {
    fido = await rootCa('Test FIDO Root');
    signer = await issue(fido, 'CN=Test MDS Signer, O=Test, C=US');
    maker = await rootCa('Test Maker Root');
    batch = await issue(maker, 'C=US, O=Test Maker, OU=Authenticator Attestation, CN=Test Key Batch');
    stranger = await issue(await rootCa('Someone Else Root'), 'C=US, O=Someone Else, OU=Authenticator Attestation, CN=Fake Batch');
    dir = mkdtempSync(path.join(tmpdir(), 'a4a-mds-'));
    blobFile = path.join(dir, 'blob.jwt');
    w = await createWorld({
      projects: false,
      people: false,
      config: {
        publicUrl: BASE,
        passkeyRpId: 'corp.test',
        trustProxy: 1,
        secretKey: 'the test instance key',
        passkeyMds: { url: 'https://mds.invalid/', file: blobFile, rootCerts: [fido.cert.toString('pem')], allowHttpLoopback: false },
      },
    });
    setMailTransportForTests(w.app, { send: async (m) => void sent.push({ to: String(m.to), subject: m.subject, text: m.text ?? '' }) });
    http = client(createHttpApp(w.app), BASE);
    adminToken = (await issueTokenFor(w.app.db, w.admin.id, { name: 'admin', scopes: ['read', 'write', 'admin'] })).token;
    await w.app.db.update(users).set({ email: 'admin@corp.test', emailVerified: true }).where(eq(users.id, w.admin.id));
    w.app.schema.invalidate();
  });
  afterAll(async () => {
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => vi.useRealTimers());

  it('signs in at the child host with a passkey made for the parent domain; one made for the host alone is listed as made elsewhere', async () => {
    const mira = await insertUser(w.app.db, { login: 'mira', name: 'Mira Parent', password: 'mira-password-1' });
    const { session } = await http.signIn('mira', 'mira-password-1');
    const options = await http.call('POST', '/me/passkeys/options', { cookie: session });
    expect(options.body.rp).toMatchObject({ id: 'corp.test' });
    const key = new Authenticator();
    expect((await http.call('POST', '/me/passkeys', { cookie: session, body: { response: key.register(options.body, { origin: BASE }) } })).status).toBe(201);
    const signedIn = await http.passkeySignIn(key);
    expect(signedIn.options.rpId).toBe('corp.test');
    expect(signedIn.status).toBe(200);
    // A passkey from before the id was the parent: the browser offers it only for its own host.
    await w.app.db.insert(passkeys).values({ id: 'pk-old-host', userId: mira.id, credentialId: 'old-host-credential', publicKey: Buffer.from([1]), name: 'Old laptop', rpId: 'a4a.corp.test' });
    const mine = await http.call('GET', '/me/passkeys', { cookie: session });
    expect(mine.body.passkeys.map((p: { name: string; elsewhere: string | null }) => [p.name, p.elsewhere])).toEqual([
      [mine.body.passkeys[0].name, null],
      ['Old laptop', 'a4a.corp.test'],
    ]);
    // And the answer of an authenticator that signed for another id fails its check.
    const wrongId = await http.call('POST', '/auth/passkey/options');
    const r = await http.call('POST', '/auth/passkey', { cookie: http.cookieOf(wrongId.res, 'a4a_pk'), body: { response: key.sign({ ...wrongId.body, rpId: 'a4a.corp.test' }, { origin: BASE }) } });
    expect(r.status).toBe(400);
  });

  it('requires passkeys of administrators: refused while none has one, then owed at an administrator’s sign-in, a code no stand-in, and never the last one locked out', async () => {
    const otto = await insertUser(w.app.db, { login: 'otto', name: 'Otto Admin', role: 'admin', password: 'otto-password-1' });
    await insertUser(w.app.db, { login: 'mel', name: 'Mel Member', password: 'mel-password-1' });
    w.app.schema.invalidate();
    // Nobody to sign in under it yet: refused, and said so.
    const early = await settings({ requirePasskeys: 'admins' });
    expect(early.status).toBe(409);
    expect(early.body.error).toMatchObject({ code: 'conflict', key: 'passkeys.wouldLockOut' });
    // The administrator adds one first; then it's taken.
    const admin = await http.signIn('admin', 'password-admin');
    const adminKey = new Authenticator();
    expect((await http.addPasskey(admin.session, adminKey)).status).toBe(201);
    expect((await settings({ requirePasskeys: 'admins' })).body.requirePasskeys).toBe('admins');
    // A member isn't asked; an administrator with one gives it, never a code.
    expect((await http.signIn('mel', 'mel-password-1')).body).toMatchObject({ login: 'mel' });
    const pw = await http.signIn('admin', 'password-admin');
    expect(pw.body).toEqual({ step: 'two_factor', code: false, passkey: true });
    const code = await http.call('POST', '/auth/two-factor/verify', { cookie: pw.ticket, body: { code: '123456' } });
    expect(code.status).toBe(403);
    expect(code.body.error.key).toBe('passkeys.requiredNotCode');
    // An administrator without one adds it as they sign in.
    const owed = await http.signIn('otto', 'otto-password-1');
    expect(owed.body).toEqual({ step: 'passkey_setup', code: false });
    expect(owed.session).toBe('');
    const options = await http.call('POST', '/auth/two-factor/passkey-setup/options', { cookie: owed.ticket });
    expect(options.status).toBe(200);
    const ottoKey = new Authenticator();
    const done = await http.call('POST', '/auth/two-factor/passkey-setup', { cookie: owed.ticket, body: { response: ottoKey.register(options.body, { origin: BASE }) } });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ login: 'otto' });
    const how = (await w.app.db.select().from(sessions).where(eq(sessions.userId, otto.id))).map((s) => s.signedInWith);
    expect(how).toEqual(['password+passkey']);
    expect((await mails(otto.id, 'passkey')).map((m) => (m.payload as { change: string }).change)).toEqual(['added']);
    // The ticket is spent: its options can't be asked again.
    expect((await http.call('POST', '/auth/two-factor/passkey-setup/options', { cookie: owed.ticket })).status).toBe(401);

    // The guard: Otto's passkey goes; then the administrator's own last one can't, nor Otto's exemption be taken back.
    expect((await http.call('DELETE', `/users/${otto.id}/passkeys`, { bearer: adminToken })).status).toBe(204);
    const adminPk = (await w.app.db.select().from(passkeys).where(eq(passkeys.userId, w.admin.id)))[0]!;
    const last = await http.call('DELETE', `/me/passkeys/${adminPk.id}`, { cookie: admin.session });
    expect(last.status).toBe(409);
    expect(last.body.error.key).toBe('passkeys.lastAdmin');
    expect(await w.app.db.select().from(passkeys).where(eq(passkeys.userId, w.admin.id))).toHaveLength(1);
    // Let off, Otto signs in with a password and a code: set up first, having none.
    expect((await http.call('PATCH', `/users/${otto.id}`, { bearer: adminToken, body: { passkeyExempt: true } })).body.signIn).toMatchObject({ passkeyExempt: true });
    expect((await http.signIn('otto', 'otto-password-1')).body).toEqual({ step: 'two_factor_setup' });
    expect((await http.call('DELETE', `/me/passkeys/${adminPk.id}`, { cookie: admin.session })).status).toBe(204);
    const lift = await http.call('PATCH', `/users/${otto.id}`, { bearer: adminToken, body: { passkeyExempt: false } });
    expect(lift.status).toBe(409);
    expect(lift.body.error.key).toBe('passkeys.lastAdmin');
    expect((await http.addPasskey((await http.signIn('mel', 'mel-password-1')).session, new Authenticator())).status).toBe(201);
    // Off, passkeys can't stay required; and requiring them can't be asked while they're off.
    const off = await settings({ passkeys: false });
    expect(off.body.error.key).toBe('passkeys.cantRequireWhileOff');
    expect((await settings({ requirePasskeys: 'off' })).status).toBe(200);
    expect((await settings({ passkeys: false })).status).toBe(200);
    expect((await settings({ requirePasskeys: 'everyone' })).body.error.key).toBe('passkeys.cantRequireWhileOff');
    expect((await settings({ passkeys: true })).status).toBe(200);
  });

  it('requires passkeys of everyone: a member adds one as they sign in, with a code where they have codes', async () => {
    const admin = await http.signIn('admin', 'password-admin');
    expect((await http.addPasskey(admin.session, new Authenticator())).status).toBe(201);
    expect((await settings({ requirePasskeys: 'everyone' })).status).toBe(200);
    try {
      const tess = await insertUser(w.app.db, { login: 'tess', name: 'Tess Codes', password: 'tess-password-1' });
      // Two-factor on, with a secret a4a seals; the code is the app's.
      const { session } = await (async () => {
        await settings({ requirePasskeys: 'off' });
        const s = await http.signIn('tess', 'tess-password-1');
        await settings({ requirePasskeys: 'everyone' });
        return s;
      })();
      const enrol = await http.call('POST', '/me/two-factor/setup', { cookie: session });
      const secret = (enrol.body.secret as string).replace(/\s/g, '');
      expect((await http.call('POST', '/me/two-factor/confirm', { cookie: session, body: { code: codeAt(secret, stepAt(Date.now())) } })).status).toBe(200);
      const owed = await http.signIn('tess', 'tess-password-1');
      expect(owed.body).toEqual({ step: 'passkey_setup', code: true });
      const options = await http.call('POST', '/auth/two-factor/passkey-setup/options', { cookie: owed.ticket });
      const key = new Authenticator();
      const noCode = await http.call('POST', '/auth/two-factor/passkey-setup', { cookie: owed.ticket, body: { response: key.register(options.body, { origin: BASE }) } });
      expect(noCode.body.error.key).toBe('passkeys.owedCodeNeeded');
      // The challenge wasn't taken by the refusal: the same answer goes with a code.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 31_000);
      const withCode = await http.call('POST', '/auth/two-factor/passkey-setup', { cookie: owed.ticket, body: { response: key.register(options.body, { origin: BASE }), code: codeAt(secret, stepAt(Date.now())) } });
      vi.useRealTimers();
      expect(withCode.status).toBe(200);
      expect((await w.app.db.select().from(passkeys).where(eq(passkeys.userId, tess.id)))).toHaveLength(1);
    } finally {
      await settings({ requirePasskeys: 'off' });
    }
  });

  it('takes only the authenticators chosen, by attestation checked against FIDO’s BLOB, and asks for attestation only then', async () => {
    const { session } = await http.signIn('mel', 'mel-password-1');
    // No list: no attestation asked, and the profile names none.
    expect((await http.call('POST', '/me/passkeys/options', { cookie: session })).body.attestation).toBe('none');
    const before = await http.call('GET', '/me/passkeys', { cookie: session });
    expect(before.body.authenticators).toBeNull();
    expect(before.body.passkeys[0]).toMatchObject({ attested: false, listed: null });

    // A list, before any BLOB was read: adding is refused, saying why; what's there still signs in.
    writeFileSync(blobFile, 'not yet');
    expect((await settings({ passkeyAuthenticators: [KEY_A.toUpperCase(), KEY_B, KEY_C] })).body.passkeyAuthenticators).toEqual([KEY_A, KEY_B, KEY_C]);
    await vi.waitFor(async () => expect((await http.call('GET', '/passkey-metadata', { bearer: adminToken })).body.failure).toBe('unreadable'));
    const none = await http.call('POST', '/me/passkeys/options', { cookie: session });
    expect(none.status).toBe(503);
    expect(none.body.error).toMatchObject({ code: 'passkey_metadata_missing', key: 'passkeys.noMetadata' });

    await publish();
    const read = await refresh();
    expect(read.body).toMatchObject({ source: 'file', no: no, nextUpdate: '2099-01-01', stale: false, failure: null });
    expect(read.body.authenticators).toEqual([
      { aaguid: KEY_A, name: 'Test Key A', revoked: false },
      { aaguid: KEY_B, name: 'Test Key B', revoked: true },
    ]);
    const mine = await http.call('GET', '/me/passkeys', { cookie: session });
    expect(mine.body.authenticators).toEqual(['Test Key A', 'Test Key B', KEY_C]);
    // What was added before the list keeps signing in, marked.
    expect(mine.body.passkeys[0]).toMatchObject({ attested: false, listed: false });

    // On the list, its maker's attestation chaining to the root the statement names: taken, and named by it.
    const options = await http.call('POST', '/me/passkeys/options', { cookie: session });
    expect(options.body.attestation).toBe('direct');
    const good = new Authenticator({ aaguid: KEY_A, batch });
    const added = await http.call('POST', '/me/passkeys', { cookie: session, body: { response: good.register(options.body, { origin: BASE }) } });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ name: 'Test Key A', attested: true, listed: true });
    expect((await http.passkeySignIn(good)).status).toBe(200);
    // `none`, and self attestation, prove nothing about the maker.
    const plain = await http.addPasskey(session, new Authenticator({ aaguid: KEY_A }), 'none');
    expect(plain.body.error).toMatchObject({ code: 'passkey_unattested', key: 'passkeys.unattested' });
    expect((await http.addPasskey(session, new Authenticator({ aaguid: KEY_A }), 'self')).body.error.code).toBe('passkey_unattested');
    // Off the list, whoever vouches.
    expect((await http.addPasskey(session, new Authenticator({ aaguid: '99999999-0000-4000-8000-000000000009', batch }))).body.error.key).toBe('passkeys.notListed');
    // On the list, but FIDO describes it not, or says it's compromised.
    expect((await http.addPasskey(session, new Authenticator({ aaguid: KEY_C, batch }))).body.error.key).toBe('passkeys.unknownMaker');
    const revoked = await http.addPasskey(session, new Authenticator({ aaguid: KEY_B, batch }));
    expect(revoked.body.error).toMatchObject({ key: 'passkeys.untrustedMaker', values: { name: 'Test Key B' } });
    // Claiming Key A, with a batch certificate of someone else's: the library's chain check refuses it.
    expect((await http.addPasskey(session, new Authenticator({ aaguid: KEY_A, batch: stranger }))).body.error.code).toBe('passkey_refused');
    expect((await w.app.db.select().from(passkeys).where(and(eq(passkeys.attested, true)))).map((p) => p.name)).toEqual(['Test Key A']);
  });

  it('keeps the last good BLOB, and says how old it is, when a newer one can’t be had or doesn’t check out', async () => {
    // Unreadable: kept, the failure beside it.
    writeFileSync(blobFile, 'garbage');
    let status = (await refresh()).body;
    expect(status).toMatchObject({ no, failure: 'unreadable', stale: false });
    expect(status.gotAt).not.toBeNull();
    // Signed by a certificate that doesn't chain to FIDO's root.
    const rogue = await issue(await rootCa('Rogue Root'), 'CN=Rogue Signer, O=Rogue, C=US');
    await publish({ no: no + 1, by: rogue });
    status = (await refresh()).body;
    expect(status).toMatchObject({ no, failure: 'unverified' });
    // An older number than the one in use: a replay, ignored.
    await publish({ no: no - 1 });
    expect((await refresh()).body).toMatchObject({ no, failure: 'older' });
    // A newer one, though stale already: taken, said to be stale, and used.
    no += 1;
    await publish({ no, nextUpdate: '2001-01-01' });
    status = (await refresh()).body;
    expect(status).toMatchObject({ no, failure: null, stale: true, nextUpdate: '2001-01-01' });
    const { session } = await http.signIn('mel', 'mel-password-1');
    expect((await http.addPasskey(session, new Authenticator({ aaguid: KEY_A, batch }))).status).toBe(201);
    // Gone altogether: still kept, still stale, and the try that failed says when.
    rmSync(blobFile);
    status = (await refresh()).body;
    expect(status).toMatchObject({ no, stale: true, failure: 'unreadable' });
    expect(new Date(status.failedAt).getTime()).toBeGreaterThan(new Date(status.gotAt).getTime() - 1);
    // Only administrators read or refresh it.
    const melToken = (await issueTokenFor(w.app.db, (await w.app.db.select().from(users).where(eq(users.login, 'mel')))[0]!.id, { name: 'm', scopes: ['read', 'write'] })).token;
    expect((await http.call('GET', '/passkey-metadata', { bearer: melToken })).status).toBe(403);
    expect((await settings({ passkeyAuthenticators: null })).body.passkeyAuthenticators).toBeNull();
  });

  it('lets someone with a spare remove their password after a passkey’s proof; then every door is a passkey’s, and tokens still work', async () => {
    const pia = await insertUser(w.app.db, { login: 'pia', name: 'Pia Passwordless', password: 'pia-password-1', email: 'pia@corp.test', emailVerified: true });
    const token = (await issueTokenFor(w.app.db, pia.id, { name: 'script', scopes: ['read', 'write'] })).token;
    const pw = await http.signIn('pia', 'pia-password-1');
    const first = new Authenticator();
    await http.addPasskey(pw.session, first);
    // One passkey, kept on one device: no spare.
    expect((await http.call('GET', '/me/passkeys', { cookie: pw.session })).body.password).toEqual({ set: true, removable: false, needs: 'spare' });
    expect((await http.call('DELETE', '/me/password', { cookie: pw.session })).body.error.key).toBe('passkeys.spareFirst');
    const second = new Authenticator();
    await http.addPasskey(pw.session, second);
    // Signed in by the password: a passkey must prove itself first.
    expect((await http.call('GET', '/me/passkeys', { cookie: pw.session })).body.password).toEqual({ set: true, removable: false, needs: 'passkey' });
    const unproved = await http.call('DELETE', '/me/password', { cookie: pw.session });
    expect(unproved.body.error).toMatchObject({ code: 'passkey_proof_needed', key: 'passkeys.proofFirst' });
    // A token can't.
    expect((await http.call('DELETE', '/me/password', { bearer: token })).body.error.key).toBe('passkeys.browserOnly');
    const other = await http.signIn('pia', 'pia-password-1');
    expect((await http.confirmWithPasskey(pw.session, first)).status).toBe(200);
    expect((await http.call('GET', '/me/passkeys', { cookie: pw.session })).body.password).toEqual({ set: true, removable: true, needs: null });
    expect((await http.call('DELETE', '/me/password', { cookie: pw.session })).status).toBe(204);
    const [row] = await w.app.db.select().from(users).where(eq(users.id, pia.id));
    expect(row).toMatchObject({ passwordHash: null, passkeysOnly: true });
    // The session the password opened elsewhere ends; this one stays.
    expect((await http.call('GET', '/me', { cookie: other.session })).status).toBe(401);
    expect((await http.call('GET', '/me', { cookie: pw.session })).status).toBe(200);
    const told = (await mails(pia.id, 'passkey')).find((m) => (m.payload as { change: string }).change === 'password-removed')!;
    const mail = (await renderMail(w.app, told))!;
    expect(mail.subject).toBe('Your a4a password was removed');
    expect(mail.text).toMatch(/\/not-me\?token=/);

    // Every door: a password sign-in, in its own words; codes; confirming by password.
    const login = await http.signIn('pia', 'pia-password-1');
    expect(login.status).toBe(401);
    expect(login.body.error).toMatchObject({ code: 'passkeys_only', key: 'passkeys.onlySignIn' });
    expect((await http.signIn('nobody-here', 'x')).body.error.key).toBe('wrongLogin');
    expect((await http.call('POST', '/me/two-factor/setup', { cookie: pw.session })).body.error.key).toBe('passkeys.codesFollowPasswords');
    expect((await http.call('POST', '/me/confirm', { cookie: pw.session, body: { password: 'pia-password-1' } })).body.error.key).toBe('passkeys.confirmWithOne');
    expect((await http.call('GET', '/me/passkeys', { cookie: pw.session })).body.confirmWith).toMatchObject({ password: false, code: false, passkey: true });
    // A passkey signs in; a token still reads and writes.
    expect((await http.passkeySignIn(second)).status).toBe(200);
    expect((await http.call('GET', '/me', { bearer: token })).status).toBe(200);
    // Its last passkey can't go, while it has no password.
    const ids = (await w.app.db.select().from(passkeys).where(eq(passkeys.userId, pia.id))).map((p) => p.id);
    expect((await http.call('DELETE', `/me/passkeys/${ids[0]}`, { cookie: pw.session })).status).toBe(204);
    const lastOne = await http.call('DELETE', `/me/passkeys/${ids[1]}`, { cookie: pw.session });
    expect(lastOne.body.error.key).toBe('passkeys.onlyWayIn');
    // A password again: from a recent sign-in, never a token; then it's an account with a password.
    expect((await http.call('PATCH', '/me', { bearer: token, body: { password: 'pia-password-2' } })).body.error.key).toBe('passkeys.browserOnly');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect((await http.call('PATCH', '/me', { cookie: pw.session, body: { password: 'pia-password-2' } })).body.error.key).toBe('passkeys.confirmFirst');
    vi.useRealTimers();
    expect((await http.call('PATCH', '/me', { cookie: pw.session, body: { password: 'pia-password-2' } })).status).toBe(200);
    expect((await w.app.db.select().from(users).where(eq(users.id, pia.id)))[0]).toMatchObject({ passkeysOnly: false });
    expect((await http.signIn('pia', 'pia-password-2')).status).toBe(200);
  });

  it('makes an account with no password, and its link adds the first passkey: once, for three days, for its own person', async () => {
    const made = await http.call('POST', '/users', { bearer: adminToken, body: { login: 'nora', name: 'Nora New', email: 'nora@corp.test', passkeysOnly: true } });
    expect(made.status).toBe(201);
    expect(made.body.signIn).toMatchObject({ password: false, passkeysOnly: true, passkeys: 0, passkeySetupUntil: null });
    expect((await http.call('POST', '/users', { bearer: adminToken, body: { login: 'nope', name: 'Nope', password: 'nope-password', passkeysOnly: true } })).body.error.key).toBe('passkeys.passwordOrPasskeys');
    // Not for an account with a password.
    const mel = (await w.app.db.select().from(users).where(eq(users.login, 'mel')))[0]!;
    expect((await http.call('POST', `/users/${mel.id}/passkey-setup`, { bearer: adminToken, body: {} })).body.error.key).toBe('passkeys.setupHasPassword');

    // Mailed: the token is minted as the mail is rendered, and kept as a hash.
    const mailed = await http.call('POST', `/users/${made.body.id}/passkey-setup`, { bearer: adminToken, body: {} });
    expect(mailed.body).toMatchObject({ mailed: true, url: null });
    const [queued] = await mails(made.body.id, 'passkey-setup');
    expect(JSON.stringify(queued!.payload)).not.toMatch(/a4k_/);
    const rendered = (await renderMail(w.app, queued!))!;
    expect(rendered.subject).toBe('Add a passkey to sign in to a4a');
    expect(rendered.text).toContain('Ada Admin made you an a4a account, nora.');
    const token = /\/passkey-setup#(a4k_[A-Za-z0-9_-]+)/.exec(rendered.text)![1]!;
    expect(await w.app.db.select().from(passkeySetupLinks).where(eq(passkeySetupLinks.tokenHash, token))).toEqual([]);
    expect((await http.call('GET', '/users', { bearer: adminToken })).body.find((u: { login: string }) => u.login === 'nora').signIn.passkeySetupUntil).not.toBeNull();

    // Opening it says what it's for, and changes nothing.
    expect((await http.call('POST', '/auth/passkey/setup/info', { body: { token } })).body).toMatchObject({ login: 'nora', name: 'Nora New', signedInAs: null });
    // The wrong person: someone signed in as another account.
    const melSession = (await http.signIn('mel', 'mel-password-1')).session;
    expect((await http.call('POST', '/auth/passkey/setup/info', { cookie: melSession, body: { token } })).body.signedInAs).toBe('mel');
    const wrong = await http.call('POST', '/auth/passkey/setup/options', { cookie: melSession, body: { token } });
    expect(wrong.body.error).toMatchObject({ key: 'passkeys.setupWrongPerson', values: { other: 'mel', login: 'nora' } });

    const options = await http.call('POST', '/auth/passkey/setup/options', { body: { token } });
    expect(options.status).toBe(200);
    expect(Buffer.from(options.body.user.id, 'base64url').toString()).toBe(made.body.id);
    const ticket = http.cookieOf(options.res, 'a4a_pk');
    const key = new Authenticator({ synced: true });
    const done = await http.call('POST', '/auth/passkey/setup', { cookie: ticket, body: { token, response: key.register(options.body, { origin: BASE }) } });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ login: 'nora' });
    expect(http.cookieOf(done.res, 'a4a_session')).toMatch(/^a4a_session=tls_/);
    expect((await http.passkeySignIn(key)).status).toBe(200);
    // Once.
    const again = await http.call('POST', '/auth/passkey/setup/info', { body: { token } });
    expect(again.status).toBe(404);
    expect(again.body.error.key).toBe('passkeys.setupGone');

    // Recovery: every passkey lost, an administrator removes them and sends a link again; using it ends every session.
    const noraSession = (await http.passkeySignIn(key)).session;
    expect((await http.call('DELETE', `/users/${made.body.id}/passkeys`, { bearer: adminToken })).status).toBe(204);
    const shown = await http.call('POST', `/users/${made.body.id}/passkey-setup`, { bearer: adminToken, body: { deliver: 'show' } });
    expect(shown.body).toMatchObject({ mailed: false });
    const shownToken = /#(a4k_.+)$/.exec(shown.body.url)![1]!;
    // A newer link voids the one before.
    const newer = await http.call('POST', `/users/${made.body.id}/passkey-setup`, { bearer: adminToken, body: { deliver: 'show' } });
    expect((await http.call('POST', '/auth/passkey/setup/info', { body: { token: shownToken } })).status).toBe(404);
    const newerToken = /#(a4k_.+)$/.exec(newer.body.url)![1]!;
    // Three days, and no more.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3 * 86_400_000 + 60_000);
    expect((await http.call('POST', '/auth/passkey/setup/info', { body: { token: newerToken } })).status).toBe(404);
    vi.useRealTimers();
    const last = /#(a4k_.+)$/.exec((await http.call('POST', `/users/${made.body.id}/passkey-setup`, { bearer: adminToken, body: { deliver: 'show' } })).body.url)![1]!;
    const o2 = await http.call('POST', '/auth/passkey/setup/options', { body: { token: last } });
    const recovered = await http.call('POST', '/auth/passkey/setup', { cookie: http.cookieOf(o2.res, 'a4a_pk'), body: { token: last, response: new Authenticator().register(o2.body, { origin: BASE }) } });
    expect(recovered.status).toBe(200);
    expect((await http.call('GET', '/me', { cookie: noraSession })).status).toBe(401);
    // Two answers for one link at once: one passkey comes of it.
    const both = /#(a4k_.+)$/.exec((await http.call('POST', `/users/${made.body.id}/passkey-setup`, { bearer: adminToken, body: { deliver: 'show' } })).body.url)![1]!;
    const [oa, ob] = await Promise.all([http.call('POST', '/auth/passkey/setup/options', { body: { token: both } }), http.call('POST', '/auth/passkey/setup/options', { body: { token: both } })]);
    const before = (await w.app.db.select().from(passkeys).where(eq(passkeys.userId, made.body.id))).length;
    const results = await Promise.all([
      http.call('POST', '/auth/passkey/setup', { cookie: http.cookieOf(oa.res, 'a4a_pk'), body: { token: both, response: new Authenticator().register(oa.body, { origin: BASE }) } }),
      http.call('POST', '/auth/passkey/setup', { cookie: http.cookieOf(ob.res, 'a4a_pk'), body: { token: both, response: new Authenticator().register(ob.body, { origin: BASE }) } }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
    expect((await w.app.db.select().from(passkeys).where(eq(passkeys.userId, made.body.id))).length).toBe(before + 1);
  });

  it('lets two removals at once take only one of the last two passkeys of an account with no password', async () => {
    const duo = await insertUser(w.app.db, { login: 'duo', name: 'Duo Keys', passkeysOnly: true });
    w.app.schema.invalidate();
    const url = (await http.call('POST', `/users/${duo.id}/passkey-setup`, { bearer: adminToken, body: { deliver: 'show' } })).body.url as string;
    const token = /#(a4k_.+)$/.exec(url)![1]!;
    const o = await http.call('POST', '/auth/passkey/setup/options', { body: { token } });
    const signedIn = await http.call('POST', '/auth/passkey/setup', { cookie: http.cookieOf(o.res, 'a4a_pk'), body: { token, response: new Authenticator().register(o.body, { origin: BASE }) } });
    const session = http.cookieOf(signedIn.res, 'a4a_session');
    expect((await http.addPasskey(session, new Authenticator())).status).toBe(201);
    const ids = (await w.app.db.select().from(passkeys).where(eq(passkeys.userId, duo.id))).map((p) => p.id);
    expect(ids).toHaveLength(2);
    // Each alone would leave one; both at once would leave none. The person's row is locked first, so the second sees the first.
    const both = await Promise.all(ids.map((id) => http.call('DELETE', `/me/passkeys/${id}`, { cookie: session })));
    expect(both.map((r) => r.status).sort()).toEqual([204, 409]);
    expect(await w.app.db.select().from(passkeys).where(eq(passkeys.userId, duo.id))).toHaveLength(1);
  });

  it('holds setup links to the challenge limit and the sign-in throttle', async () => {
    const quiet = await insertUser(w.app.db, { login: 'quiet', name: 'Quiet', passkeysOnly: true });
    w.app.schema.invalidate();
    const url = (await http.call('POST', `/users/${quiet.id}/passkey-setup`, { bearer: adminToken, body: { deliver: 'show' } })).body.url as string;
    const token = /#(a4k_.+)$/.exec(url)![1]!;
    const ip = '10.77.7.7';
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await http.call('POST', '/auth/passkey/setup/info', { ip, body: { token } })).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
    // Ten wrong answers for one link a window; the eleventh waits, even from elsewhere.
    const tries: number[] = [];
    for (let i = 0; i < 11; i++) {
      const forged = new Authenticator().register({ challenge: b64(randomBytes(32)), rp: { id: 'corp.test', name: 'a4a' }, user: { id: b64(Buffer.from(quiet.id)), name: 'quiet', displayName: 'Quiet' }, pubKeyCredParams: [] } as never, { origin: BASE });
      tries.push((await http.call('POST', '/auth/passkey/setup', { ip: `10.78.0.${i + 1}`, body: { token, response: forged } })).status);
    }
    expect(tries.slice(0, 10).every((s) => s === 404 || s === 400)).toBe(true);
    expect(tries[10]).toBe(429);
  });
});

describe('FIDO’s BLOB from an address', () => {
  let w: TestWorld;
  let server: Server;
  let body = '';
  beforeAll(async () => {
    const fido = await rootCa('Test FIDO Root');
    const signer = await issue(fido, 'CN=Test MDS Signer, O=Test, C=US');
    const maker = await rootCa('Maker');
    const payload = { legalHeader: 'Test', no: 3, nextUpdate: '2099-01-01', entries: [{ aaguid: KEY_A, metadataStatement: statement(KEY_A, 'Test Key A', maker.cert), statusReports: [] }] };
    body = await new CompactSign(new TextEncoder().encode(JSON.stringify(payload))).setProtectedHeader({ alg: 'ES256', typ: 'JWT', x5c: [der(signer.cert).toString('base64')] }).sign(signer.keys.privateKey);
    server = createServer((_req, res) => void res.writeHead(200, { 'content-type': 'application/jwt' }).end(body));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    w = await createWorld({ projects: false, people: false, config: { publicUrl: 'https://a4a.test', passkeyMds: { url, file: undefined, rootCerts: [fido.cert.toString('pem')], allowHttpLoopback: true } } });
  });
  afterAll(async () => {
    await w.close();
    server.close();
  });

  it('fetches and verifies it, and keeps it when the address stops answering', async () => {
    const { refreshMetadata } = await import('../src/services/passkey-metadata');
    expect(await refreshMetadata(w.app, { force: true })).toMatchObject({ source: 'url', no: 3, failure: null, authenticators: [{ aaguid: KEY_A, name: 'Test Key A' }] });
    await new Promise<void>((r) => server.close(() => r()));
    const kept = await refreshMetadata(w.app, { force: true });
    expect(kept).toMatchObject({ no: 3, failure: 'unreachable' });
    expect(kept.failureDetail).toMatch(/didn't answer/);
  });
});
