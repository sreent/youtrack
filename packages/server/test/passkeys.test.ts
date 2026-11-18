/**
 * Passkeys (D62), each ceremony end to end over HTTP, with an authenticator made here: a P-256 key
 * from node's crypto, its authenticator data and attestation written as WebAuthn says, signed as an
 * authenticator signs. Then what must be refused: a challenge used twice or run out, another origin
 * or relying party, a device that didn't verify its person, a count that goes back, a removed passkey,
 * another person's; the throttle; the mails and their "this wasn't me" link; an administrator's
 * removal; and the instance's switch.
 */
import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { and, eq } from 'drizzle-orm';
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mailOutbox, passkeys, sessions, users } from '../src/db/schema';
import { createHttpApp } from '../src/http/app';
import { renderMail } from '../src/mail/render';
import { setMailTransportForTests } from '../src/notify/state';
import { issueTokenFor } from '../src/services/auth';
import { relyingParty } from '../src/services/passkeys';
import { insertUser } from '../src/services/users';
import { createWorld, type TestWorld } from './helpers';

const BASE = 'https://a4a.test';
const ICLOUD = 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd';
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest();

/** A software authenticator: one discoverable credential, for one relying party and person. */
class Authenticator {
  readonly id = randomBytes(16);
  private readonly key: { publicKey: KeyObject; privateKey: KeyObject } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  count = 0;
  userHandle = '';
  constructor(private readonly opts: { counts?: boolean; aaguid?: string } = {}) {}

  private cose(): Uint8Array {
    const jwk = this.key.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    return isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))],
        [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))],
      ]),
    );
  }

  private authData(rpId: string, o: { uv: boolean; attested: boolean; counter: number }): Buffer {
    const flags = 0x01 | (o.uv ? 0x04 : 0) | 0x08 | 0x10 | (o.attested ? 0x40 : 0);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(o.counter);
    const parts: Buffer[] = [sha(rpId), Buffer.from([flags]), counter];
    if (o.attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.id.length);
      parts.push(Buffer.from((this.opts.aaguid ?? '00000000-0000-0000-0000-000000000000').replace(/-/g, ''), 'hex'), len, this.id, Buffer.from(this.cose()));
    }
    return Buffer.concat(parts);
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** What navigator.credentials.create() answers. */
  register(options: PublicKeyCredentialCreationOptionsJSON, o: { origin?: string; rpId?: string; uv?: boolean } = {}): RegistrationResponseJSON {
    this.userHandle = options.user.id;
    const authData = this.authData(o.rpId ?? options.rp.id!, { uv: o.uv ?? true, attested: true, counter: this.count });
    const attestationObject = isoCBOR.encode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)]]) as never);
    return {
      id: b64(this.id),
      rawId: b64(this.id),
      type: 'public-key',
      response: { clientDataJSON: b64(this.clientData('webauthn.create', options.challenge, o.origin ?? BASE)), attestationObject: b64(attestationObject), transports: ['internal', 'hybrid'] },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** What navigator.credentials.get() answers: signed over the authenticator data and the client data's hash. */
  sign(options: PublicKeyCredentialRequestOptionsJSON, o: { origin?: string; rpId?: string; uv?: boolean; counter?: number } = {}): AuthenticationResponseJSON {
    if (this.opts.counts && o.counter === undefined) this.count++;
    const authData = this.authData(o.rpId ?? options.rpId!, { uv: o.uv ?? true, attested: false, counter: o.counter ?? (this.opts.counts ? this.count : 0) });
    const clientData = this.clientData('webauthn.get', options.challenge, o.origin ?? BASE);
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

describe('the relying party', () => {
  it('is PUBLIC_URL’s host, where a browser makes passkeys for it', () => {
    expect(relyingParty('https://a4a.example.com')).toEqual({ id: 'a4a.example.com', origin: 'https://a4a.example.com' });
    expect(relyingParty('https://a4a.example.com:8443')).toEqual({ id: 'a4a.example.com', origin: 'https://a4a.example.com:8443' });
    expect(relyingParty('http://localhost:3000')).toEqual({ id: 'localhost', origin: 'http://localhost:3000' });
    // Plain http elsewhere isn't a secure context, and an address isn't a domain.
    expect(relyingParty('http://a4a.lan')).toBeNull();
    expect(relyingParty('http://127.0.0.1:3000')).toBeNull();
    expect(relyingParty('https://10.0.0.5')).toBeNull();
  });
});

describe('passkeys over HTTP', () => {
  let w: TestWorld;
  let app: ReturnType<typeof createHttpApp>;
  let adminToken = '';
  let addresses = 0;
  const sent: string[] = [];

  const cookieOf = (res: Response, name: string) => {
    const hit = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
    return hit ? hit.split(';')[0]! : '';
  };

  async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; bearer?: string; origin?: string; ip?: string } = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': opts.ip ?? `10.2.0.${(addresses % 250) + 1}` };
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.cookie || opts.origin) headers.origin = opts.origin ?? BASE;
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    const res = await app.request(`/api/v1${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    const text = await res.text();
    return { res, status: res.status, body: text ? JSON.parse(text) : null };
  }

  async function signIn(login: string, password: string) {
    addresses++;
    const r = await call('POST', '/auth/login', { body: { login, password } });
    return { ...r, session: cookieOf(r.res, 'a4a_session'), ticket: cookieOf(r.res, 'a4a_2fa') };
  }

  /** Add a passkey from a signed-in session, as the profile does. */
  async function addPasskey(session: string, key: Authenticator, name?: string) {
    const options = await call('POST', '/me/passkeys/options', { cookie: session });
    expect(options.status).toBe(200);
    return call('POST', '/me/passkeys', { cookie: session, body: { response: key.register(options.body), ...(name ? { name } : {}) } });
  }

  /** Sign in from the sign-in page: options, then the browser's answer, with the ticket cookie between. */
  async function passkeySignIn(key: Authenticator, o: Parameters<Authenticator['sign']>[1] = {}) {
    addresses++;
    const options = await call('POST', '/auth/passkey/options', { origin: BASE });
    expect(options.status).toBe(200);
    const ticket = cookieOf(options.res, 'a4a_pk');
    const r = await call('POST', '/auth/passkey', { cookie: ticket, body: { response: key.sign(options.body, o) } });
    return { ...r, session: cookieOf(r.res, 'a4a_session'), options: options.body, ticket };
  }

  async function mails(userId: string) {
    return w.app.db.select().from(mailOutbox).where(and(eq(mailOutbox.userId, userId), eq(mailOutbox.kind, 'passkey')));
  }

  let pat = { id: '' };
  let quinn = { id: '' };
  const patKey = new Authenticator({ aaguid: ICLOUD });

  beforeAll(async () => {
    w = await createWorld({ projects: false, config: { publicUrl: BASE, trustProxy: 1, secretKey: 'the test instance key' } });
    // Mail goes nowhere, but it is queued, and rendered as it would be sent.
    setMailTransportForTests(w.app, { send: async (m) => void sent.push(m.subject) });
    app = createHttpApp(w.app);
    pat = await insertUser(w.app.db, { login: 'pat', name: 'Pat Passkey', role: 'member', password: 'pat-password-1', email: 'pat@corp.test', emailVerified: true });
    quinn = await insertUser(w.app.db, { login: 'quinn', name: 'Quinn', role: 'member', password: 'quinn-password-1', email: 'quinn@corp.test', emailVerified: true });
    await insertUser(w.app.db, { login: 'sam', name: 'Sam Single', role: 'member', email: 'sam@corp.test', emailVerified: true });
    adminToken = (await issueTokenFor(w.app.db, w.admin.id, { name: 'admin', scopes: ['read', 'write', 'admin'] })).token;
    w.app.schema.invalidate();
  });
  afterAll(async () => {
    await w.close();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds a passkey from the profile, named from what the authenticator says, and mails its person', async () => {
    const { session } = await signIn('pat', 'pat-password-1');
    const mine = await call('GET', '/me/passkeys', { cookie: session });
    expect(mine.body).toMatchObject({ passkeys: [], on: true, off: null, confirmWith: { password: true, code: false, passkey: false } });
    // A sign-in just now lets this session add one without confirming again.
    expect(new Date(mine.body.confirmedUntil).getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);

    const options = await call('POST', '/me/passkeys/options', { cookie: session });
    expect(options.body).toMatchObject({
      rp: { id: 'a4a.test', name: 'a4a' },
      user: { name: 'pat', displayName: 'Pat Passkey' },
      attestation: 'none',
      excludeCredentials: [],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      timeout: 300_000,
    });
    // The user handle is the person's id, which says nothing about them.
    expect(Buffer.from(options.body.user.id, 'base64url').toString()).toBe(pat.id);
    const added = await call('POST', '/me/passkeys', { cookie: session, body: { response: patKey.register(options.body) } });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ name: 'iCloud Keychain', synced: true, copied: false, lastUsedAt: null, elsewhere: null });
    const [row] = await w.app.db.select().from(passkeys).where(eq(passkeys.userId, pat.id));
    expect(row).toMatchObject({ credentialId: b64(patKey.id), rpId: 'a4a.test', transports: ['internal', 'hybrid'], signCount: 0 });

    // The same answer again: its challenge was taken.
    const again = await call('POST', '/me/passkeys', { cookie: session, body: { response: patKey.register(options.body) } });
    expect(again.status).toBe(400);
    expect(again.body.error).toMatchObject({ code: 'passkey_stale', key: 'passkeys.stale' });
    // Now the browser is told not to make another on the same authenticator.
    const next = await call('POST', '/me/passkeys/options', { cookie: session });
    expect(next.body.excludeCredentials).toEqual([{ id: b64(patKey.id), type: 'public-key', transports: ['internal', 'hybrid'] }]);

    const queued = await mails(pat.id);
    expect(queued.map((m) => (m.payload as { change: string }).change)).toEqual(['added']);
  });

  it('signs in with a passkey alone, from the sign-in page: no login, password or code, even where two-factor is asked of everyone', async () => {
    await call('PATCH', '/settings', { bearer: adminToken, body: { requireTwoFactor: true } });
    try {
      const setup = await call('GET', '/auth/setup');
      expect(setup.body.signIn.passkey).toBe(true);
      const r = await passkeySignIn(patKey);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ login: 'pat' });
      expect(r.options).toMatchObject({ rpId: 'a4a.test', userVerification: 'required', timeout: 300_000 });
      expect(r.options.allowCredentials ?? []).toEqual([]);
      expect(r.session).toMatch(/^a4a_session=tls_/);
      expect(r.res.headers.getSetCookie().join(';')).toMatch(/a4a_pk=;/);
      // The session says how, and with which passkey; the person's last sign-in and the passkey's use are kept.
      const all = await w.app.db.select().from(sessions).where(eq(sessions.userId, pat.id));
      const latest = all.find((x) => x.signedInWith === 'passkey')!;
      expect(latest.passkeyId).toBeTruthy();
      expect(all.map((x) => x.signedInWith)).toContain('password');
      const [u] = await w.app.db.select().from(users).where(eq(users.id, pat.id));
      expect(u!.lastSignInAt).toBeInstanceOf(Date);
      expect((await call('GET', '/me/passkeys', { cookie: r.session })).body.passkeys[0].lastUsedAt).not.toBeNull();

      // A password sign-in, with two-factor asked of everyone and no app set up: the passkey is the second step.
      const pw = await signIn('pat', 'pat-password-1');
      expect(pw.body).toEqual({ step: 'two_factor', code: false, passkey: true });
      const options = await call('POST', '/auth/two-factor/passkey/options', { cookie: pw.ticket });
      expect(options.status).toBe(200);
      expect(options.body.allowCredentials).toEqual([{ id: b64(patKey.id), type: 'public-key', transports: ['internal', 'hybrid'] }]);
      const done = await call('POST', '/auth/two-factor/passkey', { cookie: pw.ticket, body: { response: patKey.sign(options.body) } });
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({ login: 'pat' });
      const second = (await w.app.db.select().from(sessions).where(eq(sessions.userId, pat.id))).map((x) => x.signedInWith);
      expect(second).toContain('password+passkey');

      // Quinn, without a passkey, is asked to set an app up, as before.
      expect((await signIn('quinn', 'quinn-password-1')).body).toEqual({ step: 'two_factor_setup' });
    } finally {
      await call('PATCH', '/settings', { bearer: adminToken, body: { requireTwoFactor: false } });
    }
  });

  it('refuses a challenge used twice or run out, another origin or relying party, and a device that didn’t verify its person', async () => {
    // Used twice: the second answer finds its challenge taken.
    addresses++;
    const options = await call('POST', '/auth/passkey/options', { origin: BASE });
    const ticket = cookieOf(options.res, 'a4a_pk');
    const answer = patKey.sign(options.body);
    expect((await call('POST', '/auth/passkey', { cookie: ticket, body: { response: answer } })).status).toBe(200);
    const twice = await call('POST', '/auth/passkey', { cookie: ticket, body: { response: answer } });
    expect(twice.status).toBe(400);
    expect(twice.body.error.code).toBe('passkey_stale');

    // Another browser's ticket can't take this browser's challenge.
    const theirs = await call('POST', '/auth/passkey/options', { origin: BASE });
    const mine = await call('POST', '/auth/passkey/options', { origin: BASE });
    const stolen = await call('POST', '/auth/passkey', { cookie: cookieOf(mine.res, 'a4a_pk'), body: { response: patKey.sign(theirs.body) } });
    expect(stolen.body.error.code).toBe('passkey_stale');
    // Nor does an answer without a ticket at all.
    expect((await call('POST', '/auth/passkey', { body: { response: patKey.sign(theirs.body) } })).body.error.code).toBe('passkey_stale');

    // Run out: five minutes pass.
    const late = await call('POST', '/auth/passkey/options', { origin: BASE });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    const ranOut = await call('POST', '/auth/passkey', { cookie: cookieOf(late.res, 'a4a_pk'), body: { response: patKey.sign(late.body) } });
    expect(ranOut.body.error.code).toBe('passkey_stale');
    vi.useRealTimers();

    // Another origin: a page elsewhere asked the authenticator.
    const evil = await passkeySignIn(patKey, { origin: 'https://evil.test' });
    expect(evil.status).toBe(400);
    expect(evil.body.error).toMatchObject({ code: 'passkey_origin', values: { origin: BASE } });
    // A request that says it comes from another site is refused before anything.
    expect((await call('POST', '/auth/passkey/options', { origin: 'https://evil.test' })).status).toBe(403);
    // Another relying party: the authenticator signed for another host.
    const rp = await passkeySignIn(patKey, { rpId: 'evil.test' });
    expect(rp.status).toBe(400);
    expect(rp.body.error.code).toBe('passkey_refused');
    // The device didn't verify its person: a passkey is both factors only when it does.
    const uv = await passkeySignIn(patKey, { uv: false });
    expect(uv.status).toBe(400);
    expect(uv.body.error).toMatchObject({ code: 'user_not_verified', key: 'passkeys.notVerified' });
    const { session } = await signIn('quinn', 'quinn-password-1');
    const quinnKey = new Authenticator();
    const regOptions = await call('POST', '/me/passkeys/options', { cookie: session });
    const unverified = await call('POST', '/me/passkeys', { cookie: session, body: { response: quinnKey.register(regOptions.body, { uv: false }) } });
    expect(unverified.body.error.code).toBe('user_not_verified');
    // A signature that isn't the key's: another authenticator's, under pat's passkey's id.
    const impostor = new Authenticator();
    impostor.userHandle = patKey.userHandle;
    (impostor as unknown as { id: Buffer }).id = patKey.id;
    const forged = await passkeySignIn(impostor);
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe('passkey_refused');
    // Still signing in after all that: nothing above moved its count or stopped it.
    expect((await passkeySignIn(patKey)).status).toBe(200);
  });

  it('stops a passkey whose sign count goes back: its sessions end, and its person is told', async () => {
    const { session } = await signIn('quinn', 'quinn-password-1');
    const counter = new Authenticator({ counts: true });
    const added = await addPasskey(session, counter, 'Security key');
    expect(added.status).toBe(201);
    expect(added.body.name).toBe('Security key');
    const first = await passkeySignIn(counter);
    expect(first.status).toBe(200);
    expect((await passkeySignIn(counter)).status).toBe(200);
    expect((await w.app.db.select().from(passkeys).where(eq(passkeys.id, added.body.id)))[0]!.signCount).toBe(2);
    // A copy of the key, used with a count the passkey had passed.
    const copy = await passkeySignIn(counter, { counter: 1 });
    expect(copy.status).toBe(401);
    expect(copy.body.error).toMatchObject({ code: 'passkey_copied', key: 'passkeys.copied' });
    // The sessions it signed in are gone; the password's isn't.
    expect((await call('GET', '/me', { cookie: first.session })).status).toBe(401);
    expect((await call('GET', '/me', { cookie: session })).status).toBe(200);
    // And it signs nobody in again, whatever count comes next.
    expect((await passkeySignIn(counter, { counter: 50 })).body.error.code).toBe('passkey_copied');
    const listed = (await call('GET', '/me/passkeys', { cookie: session })).body.passkeys;
    expect(listed.find((p: { id: string }) => p.id === added.body.id)).toMatchObject({ copied: true });
    expect((await mails(quinn.id)).map((m) => (m.payload as { change: string }).change)).toEqual(['added', 'copied']);
    // Its mail's link removes that passkey alone, not one added after it, and signs them out everywhere.
    await addPasskey(session, new Authenticator(), 'Laptop');
    const row = (await mails(quinn.id)).find((m) => (m.payload as { change: string }).change === 'copied')!;
    const link = /https:\/\/a4a\.test\/not-me\?token=([A-Za-z0-9_-]+)/.exec((await renderMail(w.app, row))!.text)!;
    expect((await call('GET', `/not-me?token=${link[1]}`)).body).toMatchObject({ change: 'copied', name: 'Security key', done: false });
    expect((await call('POST', `/not-me?token=${link[1]}`)).body).toMatchObject({ done: true });
    expect((await call('GET', '/me', { cookie: session })).status).toBe(401);
    const left = (await w.app.db.select().from(passkeys).where(eq(passkeys.userId, quinn.id))).map((p) => p.name);
    expect(left).toContain('Laptop');
    expect(left).not.toContain('Security key');
  });

  it('refuses a removed passkey, and another person’s in place of a code', async () => {
    const { session } = await signIn('quinn', 'quinn-password-1');
    const gone = new Authenticator();
    const added = await addPasskey(session, gone);
    const signedIn = await passkeySignIn(gone);
    expect(signedIn.status).toBe(200);
    // Removing it ends the sessions it signed in, but not the one that removes it.
    expect((await call('DELETE', `/me/passkeys/${added.body.id}`, { cookie: session })).status).toBe(204);
    expect((await call('GET', '/me', { cookie: signedIn.session })).status).toBe(401);
    expect((await call('GET', '/me', { cookie: session })).status).toBe(200);
    const after = await passkeySignIn(gone);
    expect(after.status).toBe(401);
    expect(after.body.error).toMatchObject({ code: 'passkey_unknown', key: 'passkeys.notKnown' });
    // Another person's passkey, at Quinn's second step: it proves nothing about Quinn.
    await call('PATCH', '/settings', { bearer: adminToken, body: { requireTwoFactor: true } });
    try {
      const quinnKey = new Authenticator();
      await addPasskey(session, quinnKey);
      const pw = await signIn('quinn', 'quinn-password-1');
      expect(pw.body).toMatchObject({ step: 'two_factor', passkey: true });
      const options = await call('POST', '/auth/two-factor/passkey/options', { cookie: pw.ticket });
      const theirs = await call('POST', '/auth/two-factor/passkey', { cookie: pw.ticket, body: { response: patKey.sign({ ...options.body, rpId: 'a4a.test' }) } });
      expect(theirs.status).toBe(401);
      expect(theirs.body.error.code).toBe('passkey_unknown');
      // Someone else's id and nothing else (no ticket): sign in again.
      expect((await call('POST', '/auth/two-factor/passkey', { body: { response: quinnKey.sign(options.body) } })).status).toBe(401);
    } finally {
      await call('PATCH', '/settings', { bearer: adminToken, body: { requireTwoFactor: false } });
    }
    // Rename and remove are a person's own: another's passkey is missing to them.
    const patId = (await w.app.db.select().from(passkeys).where(eq(passkeys.userId, pat.id)))[0]!.id;
    expect((await call('PATCH', `/me/passkeys/${patId}`, { cookie: session, body: { name: 'Mine now' } })).status).toBe(404);
    expect((await call('DELETE', `/me/passkeys/${patId}`, { cookie: session })).status).toBe(404);
  });

  it('asks for a recent sign-in to add or remove one, and takes a password and code, or a passkey, to confirm', async () => {
    const { session } = await signIn('pat', 'pat-password-1');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const old = await call('POST', '/me/passkeys/options', { cookie: session });
    expect(old.status).toBe(403);
    expect(old.body.error).toMatchObject({ code: 'confirm_needed', key: 'passkeys.confirmFirst' });
    expect((await call('GET', '/me/passkeys', { cookie: session })).body).toMatchObject({ confirmedUntil: null, confirmWith: { password: true, passkey: true } });
    const wrong = await call('POST', '/me/confirm', { cookie: session, body: { password: 'not-it' } });
    expect(wrong.status).toBe(403);
    const right = await call('POST', '/me/confirm', { cookie: session, body: { password: 'pat-password-1' } });
    expect(right.status).toBe(200);
    expect(new Date(right.body.confirmedUntil).getTime()).toBeGreaterThan(Date.now());
    expect((await call('POST', '/me/passkeys/options', { cookie: session })).status).toBe(200);
    // Later again: a passkey of theirs confirms it as well.
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const options = await call('POST', '/me/confirm/passkey/options', { cookie: session });
    expect(options.body.allowCredentials).toHaveLength(1);
    const byPasskey = await call('POST', '/me/confirm/passkey', { cookie: session, body: { response: patKey.sign(options.body) } });
    expect(byPasskey.status).toBe(200);
    vi.useRealTimers();
    // A token can't change how anyone signs in, and an account single sign-on signs in has no passkeys here.
    const token = (await issueTokenFor(w.app.db, pat.id, { name: 'script', scopes: ['read', 'write'] })).token;
    const byToken = await call('POST', '/me/passkeys/options', { bearer: token });
    expect(byToken.status).toBe(403);
    expect(byToken.body.error.key).toBe('passkeys.browserOnly');
    expect((await call('GET', '/me/passkeys', { bearer: token })).body.confirmedUntil).toBeNull();
    const [sam] = await w.app.db.select().from(users).where(eq(users.login, 'sam'));
    const samToken = (await issueTokenFor(w.app.db, sam!.id, { name: 'script', scopes: ['read'] })).token;
    expect((await call('GET', '/me/passkeys', { bearer: samToken })).body).toMatchObject({ on: false, off: 'account', confirmWith: { password: false } });
  });

  it('counts a session from before a4a kept how it was signed in as not recent, until its person confirms', async () => {
    const { session } = await signIn('quinn', 'quinn-password-1');
    await w.app.db.update(sessions).set({ signedInWith: null }).where(eq(sessions.userId, quinn.id));
    expect((await call('POST', '/me/passkeys/options', { cookie: session })).body.error.code).toBe('confirm_needed');
    expect((await call('POST', '/me/confirm', { cookie: session, body: { password: 'quinn-password-1' } })).status).toBe(200);
    expect((await call('POST', '/me/passkeys/options', { cookie: session })).status).toBe(200);
  });

  it('holds passkey sign-ins to the sign-in throttle', async () => {
    const stranger = new Authenticator();
    stranger.userHandle = b64(Buffer.from(pat.id));
    const ip = '10.9.9.9';
    const options = await call('POST', '/auth/passkey/options', { origin: BASE, ip });
    const ticket = cookieOf(options.res, 'a4a_pk');
    const tries = [];
    for (let i = 0; i < 11; i++) tries.push((await call('POST', '/auth/passkey', { cookie: ticket, ip, body: { response: stranger.sign(options.body) } })).status);
    // Ten failures per passkey a window, as per login; the eleventh waits, and says how long.
    expect(tries.slice(0, 10).every((s) => s === 400 || s === 401)).toBe(true);
    expect(tries[10]).toBe(429);
  });

  it('mails each change in its person’s language, with a link that signs them out everywhere and stops the passkey', async () => {
    await w.app.db.update(users).set({ locale: 'de' }).where(eq(users.id, pat.id));
    const { session } = await signIn('pat', 'pat-password-1');
    const intruder = new Authenticator();
    const added = await addPasskey(session, intruder, 'Not mine');
    const later = new Authenticator();
    await addPasskey(session, later, 'Also not mine');
    const row = (await mails(pat.id)).find((m) => (m.payload as { passkeyId?: string }).passkeyId === added.body.id)!;
    const rendered = (await renderMail(w.app, row))!;
    expect(rendered.to).toBe('pat@corp.test');
    expect(rendered.subject).toBe('Ihrem a4a-Konto wurde ein Passkey hinzugefügt');
    expect(rendered.text).toContain('„Not mine“');
    const link = /https:\/\/a4a\.test\/not-me\?token=([A-Za-z0-9_-]+)/.exec(rendered.text)!;
    expect(link).toBeTruthy();
    // Opening it changes nothing; the button does, once.
    const described = await call('GET', `/not-me?token=${link[1]}`);
    expect(described.body).toMatchObject({ change: 'added', name: 'Not mine', login: 'pat', done: false });
    expect((await call('GET', '/me', { cookie: session })).status).toBe(200);
    const followed = await call('POST', `/not-me?token=${link[1]}`);
    expect(followed.body).toMatchObject({ done: true });
    expect((await call('GET', '/me', { cookie: session })).status).toBe(401);
    const left = await w.app.db.select().from(passkeys).where(eq(passkeys.userId, pat.id));
    expect(left.map((p) => p.name)).toEqual(['iCloud Keychain']);
    expect((await call('POST', `/not-me?token=${link[1]}`)).body.done).toBe(true);
    expect((await call('GET', '/not-me?token=not-a-token-at-all')).status).toBe(404);
    await w.app.db.update(users).set({ locale: null }).where(eq(users.id, pat.id));
  });

  it('lets an administrator see who has passkeys and remove someone’s, and turn them off for the instance', async () => {
    const people = await call('GET', '/users', { bearer: adminToken });
    const patRow = people.body.find((u: { login: string }) => u.login === 'pat');
    expect(patRow.signIn).toMatchObject({ passkeys: 1 });
    expect(patRow.signIn.lastSignInAt).not.toBeNull();
    expect((await call('GET', `/users/${pat.id}/passkeys`, { bearer: adminToken })).body).toHaveLength(1);
    const signedIn = await passkeySignIn(patKey);
    expect(signedIn.status).toBe(200);
    // Not someone else's to do.
    const quinnToken = (await issueTokenFor(w.app.db, quinn.id, { name: 'q', scopes: ['read', 'write'] })).token;
    expect((await call('DELETE', `/users/${pat.id}/passkeys`, { bearer: quinnToken })).status).toBe(403);

    // The switch: off, the sign-in page offers none, and passkeys sign nobody in; they're kept.
    await call('PATCH', '/settings', { bearer: adminToken, body: { passkeys: false } });
    expect((await call('GET', '/settings', { bearer: adminToken })).body.passkeys).toBe(false);
    expect((await call('GET', '/auth/setup')).body.signIn.passkey).toBe(false);
    const off = await call('POST', '/auth/passkey/options', { origin: BASE });
    expect(off.status).toBe(403);
    expect(off.body.error.key).toBe('passkeys.offInstance');
    expect((await call('GET', '/me/passkeys', { cookie: signedIn.session })).body).toMatchObject({ on: false, off: 'instance' });
    await call('PATCH', '/settings', { bearer: adminToken, body: { passkeys: true } });
    expect((await passkeySignIn(patKey)).status).toBe(200);

    // A lost phone: every passkey of theirs goes, with the sessions they signed in, and they're told.
    expect((await call('DELETE', `/users/${pat.id}/passkeys`, { bearer: adminToken })).status).toBe(204);
    expect(await w.app.db.select().from(passkeys).where(eq(passkeys.userId, pat.id))).toEqual([]);
    expect((await call('GET', '/me', { cookie: signedIn.session })).status).toBe(401);
    expect((await passkeySignIn(patKey)).body.error.code).toBe('passkey_unknown');
    const told = (await mails(pat.id)).filter((m) => (m.payload as { change: string }).change === 'removed-by-admin');
    expect(told).toHaveLength(1);
    const rendered = (await renderMail(w.app, told[0]!))!;
    expect(rendered.subject).toBe('An administrator removed your passkey');
    expect(rendered.text).not.toContain('/not-me');
    // The password still signs them in.
    expect((await signIn('pat', 'pat-password-1')).status).toBe(200);
  });
});
