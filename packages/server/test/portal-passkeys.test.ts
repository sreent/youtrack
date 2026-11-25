/**
 * Requesters' passkeys (D69), each ceremony end to end over HTTP with a software authenticator, as
 * D62's tests make one: a P-256 key from node's crypto, its authenticator data and attestation written
 * as WebAuthn says. Then the sides kept apart (a member's passkey refused on the portal, a requester's
 * on the team's side, one credential id on one side only); a desk that doesn't take passkeys, and a
 * session's reach across desks; challenges reused, stale, from another ceremony or browser; a sign
 * count that goes back; the mails and their "this wasn't me"; the throttles; and the team's removal.
 */
import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { and, eq } from 'drizzle-orm';
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { activities, requesterPasskeys, requesterSessions, requesterSignIns, requesters } from '../src/db/schema';
import { createHttpApp } from '../src/http/app';
import { AppError, checkProblemWords } from '../src/lib/errors';
import { MailWorker } from '../src/mail/outbox';
import { portalSessionOpens } from '../src/services/access';
import { issueTokenFor } from '../src/services/auth';
import { openRequest } from '../src/services/helpdesk';
import { addMember } from '../src/services/members';
import { removeRequesterPasskeys } from '../src/services/portal-passkeys';
import { projectSettings, updateProject } from '../src/services/projects';
import { insertUser } from '../src/services/users';
import { createWorld, type TestWorld } from './helpers';
import { fakeSmtp, type FakeSmtp } from './smtp';

const BASE = 'https://a4a.test';
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest();

/** A software authenticator: one discoverable credential, for one relying party and person. */
class Authenticator {
  id = randomBytes(16);
  private readonly key: { publicKey: KeyObject; privateKey: KeyObject } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  count = 0;
  userHandle = '';
  constructor(private readonly opts: { counts?: boolean } = {}) {}

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
      parts.push(Buffer.alloc(16), len, this.id, Buffer.from(this.cose()));
    }
    return Buffer.concat(parts);
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  register(options: PublicKeyCredentialCreationOptionsJSON, o: { origin?: string; uv?: boolean } = {}): RegistrationResponseJSON {
    this.userHandle = options.user.id;
    const authData = this.authData(options.rp.id!, { uv: o.uv ?? true, attested: true, counter: this.count });
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

  sign(options: PublicKeyCredentialRequestOptionsJSON, o: { origin?: string; uv?: boolean; counter?: number; handle?: string | null } = {}): AuthenticationResponseJSON {
    if (this.opts.counts && o.counter === undefined) this.count++;
    const authData = this.authData(options.rpId!, { uv: o.uv ?? true, attested: false, counter: o.counter ?? (this.opts.counts ? this.count : 0) });
    const clientData = this.clientData('webauthn.get', options.challenge, o.origin ?? BASE);
    const signature = createSign('sha256').update(Buffer.concat([authData, sha(clientData)])).sign(this.key.privateKey);
    const handle = o.handle === undefined ? this.userHandle : o.handle;
    return {
      id: b64(this.id),
      rawId: b64(this.id),
      type: 'public-key',
      response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(signature), ...(handle ? { userHandle: handle } : {}) },
      clientExtensionResults: {},
    };
  }
}

let w: TestWorld;
let smtp: FakeSmtp;
let http: ReturnType<typeof createHttpApp>;
let mailer: MailWorker;
let adminToken = '';

/** A browser: its own address and a cookie jar, posting from a4a's origin unless told otherwise. */
function browser(ip: string) {
  const jar = new Map<string, string>();
  const cookies: string[] = [];
  const req = async (method: string, path: string, body?: unknown, opts: { origin?: string | null; bearer?: string } = {}) => {
    const headers: Record<string, string> = { 'x-forwarded-for': ip };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (opts.origin !== null && method !== 'GET') headers.origin = opts.origin ?? BASE;
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await http.request(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const set of res.headers.getSetCookie()) {
      cookies.push(set);
      const [pair] = set.split(';');
      const at = pair!.indexOf('=');
      const name = pair!.slice(0, at);
      const value = pair!.slice(at + 1);
      if (!value || /max-age=0/i.test(set)) jar.delete(name);
      else jar.set(name, value);
    }
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as any };
  };
  return { req, jar, cookies };
}
type Browser = ReturnType<typeof browser>;

function mailed(to: string, pattern: RegExp): { text: string; subject: string; token: string } {
  const mail = [...smtp.messages].reverse().find((m) => m.to.includes(to) && pattern.test(m.text));
  if (!mail) throw new Error(`no email to ${to} matching ${pattern}`);
  return { text: mail.text, subject: mail.headers.get('subject') ?? '', token: pattern.exec(mail.text)![1] ?? '' };
}
const SIGN_IN_LINK = /\/portal#(hdl_[A-Za-z0-9_-]{43})/;
const ALERT_LINK = /\/portal#(hdk_[A-Za-z0-9_-]{43})/;

let ips = 0;
const nextIp = () => `10.6.${Math.floor(++ips / 250)}.${(ips % 250) + 1}`;

/** Signed in by a link emailed to them: what proves their mailbox, and lets them add a passkey for ten minutes. */
async function byLink(email: string, b: Browser = browser(nextIp())): Promise<Browser> {
  expect((await b.req('POST', '/portal/sign-in', { email })).status).toBe(202);
  await mailer.drain();
  const redeemed = await b.req('POST', '/portal/sign-in/redeem', { token: mailed(email, SIGN_IN_LINK).token });
  expect(redeemed.status, JSON.stringify(redeemed.body)).toBe(200);
  return b;
}

/** Add a passkey on the portal's account page, from a session recent enough. */
async function addKey(b: Browser, key: Authenticator, name?: string) {
  const options = await b.req('POST', '/portal/me/passkeys/options', {});
  expect(options.status, JSON.stringify(options.body)).toBe(200);
  return b.req('POST', '/portal/me/passkeys', { response: key.register(options.body), ...(name ? { name } : {}) });
}

/** Sign in from the portal's sign-in page: options, then the browser's answer, with the ticket cookie between. */
async function withKey(key: Authenticator, o: Parameters<Authenticator['sign']>[1] & { desk?: string } = {}, b: Browser = browser(nextIp())) {
  const options = await b.req('POST', '/portal/passkey/options', o.desk ? { desk: o.desk } : {});
  if (options.status !== 200) return { ...options, b, options: null as any };
  const r = await b.req('POST', '/portal/passkey', { response: key.sign(options.body, o), ...(o.desk ? { desk: o.desk } : {}) });
  return { ...r, b, options: options.body };
}

const desk = async (key: string) => (await w.app.schema.get()).projectsByKey.get(key)!;
const ways = (link: boolean, password: boolean, passkey?: boolean) => ({ link, password, providers: [] as string[], ...(passkey === undefined ? {} : { passkey }) });
const requesterId = async (email: string) => (await w.app.db.select().from(requesters).where(eq(requesters.email, email)))[0]!.id;

beforeAll(async () => {
  smtp = await fakeSmtp();
  w = await createWorld({ config: { smtpUrl: smtp.url, publicUrl: BASE, trustProxy: 1, secretKey: 'the test instance key' } });
  await updateProject(w.adminCtx, 'BACK', { settings: { helpdesk: { enabled: true, signIn: ways(true, true, true) } } });
  await updateProject(w.adminCtx, 'WEB', { settings: { helpdesk: { enabled: true } } });
  http = createHttpApp(w.app);
  mailer = new MailWorker(w.app, () => new Date(Date.now() + 10 * 60_000));
  adminToken = (await issueTokenFor(w.app.db, w.admin.id, { name: 'admin', scopes: ['read', 'write', 'admin'] })).token;
});

afterAll(async () => {
  await w?.close();
  await smtp?.close();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a desk's choice", () => {
  it('takes passkeys beside another way, never alone, and keeps its choice when a script leaves it out', async () => {
    await expect(updateProject(w.adminCtx, 'WEB', { settings: { helpdesk: { signIn: ways(false, false, true) } } })).rejects.toMatchObject({ status: 400, words: { key: 'portalSignIn.passkeyNotAlone' } });
    // A script from before D69 sends the three ways it knew: the desk keeps taking passkeys.
    await updateProject(w.adminCtx, 'BACK', { settings: { helpdesk: { signIn: ways(true, true) } } });
    expect(projectSettings(await desk('BACK')).helpdesk.signIn).toEqual({ link: true, password: true, providers: [], passkey: true });
    const logged = await w.app.db.select().from(activities).where(and(eq(activities.projectId, (await desk('BACK')).id), eq(activities.type, 'project.portal_sign_in.changed')));
    expect((logged.at(-1)!.payload as { data: { to: unknown } }).data.to).toEqual({ link: true, password: true, providers: [], passkey: true });
    const b = browser(nextIp());
    expect((await b.req('GET', '/portal/sign-in-methods?desk=BACK')).body).toMatchObject({ desk: { key: 'BACK' }, passkey: true });
    expect((await b.req('GET', '/portal/sign-in-methods?desk=WEB')).body).toMatchObject({ desk: { key: 'WEB' }, passkey: false });
    // The portal's own page, if some desk takes them; a desk that doesn't exist offers none.
    expect((await b.req('GET', '/portal/sign-in-methods')).body.passkey).toBe(true);
    expect((await b.req('GET', '/portal/sign-in-methods?desk=NOPE')).body.passkey).toBe(false);
  });

  it('opens a session made by a passkey only at desks that take passkeys, and never past a customer group’s provider', () => {
    const passkey = { method: 'passkey' as const, providerId: null };
    expect(portalSessionOpens({ ...ways(true, false, true) }, null, passkey)).toBe(true);
    expect(portalSessionOpens({ ...ways(true, true, false) }, null, passkey)).toBe(false);
    expect(portalSessionOpens({ ...ways(true, true) }, null, passkey)).toBe(false);
    // A group tied to its provider (D63): its people come through it, and a passkey would outlive its say.
    expect(portalSessionOpens({ link: true, password: false, providers: ['acme'], passkey: true }, 'acme', passkey)).toBe(false);
    expect(portalSessionOpens({ link: true, password: false, providers: ['acme'], passkey: true }, 'acme', { method: 'sso', providerId: 'acme' })).toBe(true);
  });
});

describe('adding one', () => {
  it('adds one from a session an emailed link opened, under a handle no member’s can be, and mails the requester', async () => {
    await openRequest(w.app, await desk('BACK'), { name: 'Pia', email: 'pia@example.org', summary: 'Printer jams', description: '', via: 'form' });
    const b = await byLink('pia@example.org');
    const mine = await b.req('GET', '/portal/me/passkeys');
    expect(mine.body).toMatchObject({ passkeys: [], on: true, off: null, confirmWith: { passkey: false, link: true } });
    expect(new Date(mine.body.confirmedUntil).getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    const options = await b.req('POST', '/portal/me/passkeys/options', {});
    expect(options.body).toMatchObject({
      rp: { id: 'a4a.test' },
      user: { name: 'pia@example.org', displayName: 'Pia (help desk)' },
      attestation: 'none',
      excludeCredentials: [],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      timeout: 300_000,
    });
    expect(Buffer.from(options.body.user.id, 'base64url').toString()).toBe(`hdr:${await requesterId('pia@example.org')}`);
    const key = new Authenticator();
    const added = await b.req('POST', '/portal/me/passkeys', { response: key.register(options.body), name: 'Pia’s phone' });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ name: 'Pia’s phone', copied: false, lastUsedAt: null, elsewhere: null });
    // The same answer again: its challenge was taken.
    expect((await b.req('POST', '/portal/me/passkeys', { response: key.register(options.body) })).body.error.code).toBe('passkey_stale');
    expect((await b.req('POST', '/portal/me/passkeys/options', {})).body.excludeCredentials).toEqual([{ id: b64(key.id), type: 'public-key', transports: ['internal', 'hybrid'] }]);
    await mailer.drain();
    const told = mailed('pia@example.org', ALERT_LINK);
    expect(told.subject).toBe('A passkey now signs you in to the help desk');
    expect(told.text).toContain('“Pia’s phone”');
    // A device that didn't check its person makes no passkey.
    const options2 = await b.req('POST', '/portal/me/passkeys/options', {});
    expect((await b.req('POST', '/portal/me/passkeys', { response: new Authenticator().register(options2.body, { uv: false }) })).body.error.code).toBe('user_not_verified');
  });

  it('takes proof of the mailbox: a password’s session confirms with a passkey first, or signs in again by a link', async () => {
    const pw = browser(nextIp());
    // The link that sets a password proves the mailbox too: its session may add one at once.
    expect((await pw.req('POST', '/portal/password/link', { email: 'quinn@example.org', desk: 'BACK' })).status).toBe(202);
    await mailer.drain();
    const set = await pw.req('POST', '/portal/password/set', { token: mailed('quinn@example.org', /\/portal\?desk=BACK#(hdp_[A-Za-z0-9_-]{43})/).token, password: 'quinn password 1' });
    expect(set.status).toBe(200);
    const key = new Authenticator();
    expect((await addKey(pw, key, 'Laptop')).status).toBe(201);
    // A sign-in by the password alone doesn't: a passkey opens desks a password doesn't.
    const later = browser(nextIp());
    expect((await later.req('POST', '/portal/password/sign-in', { email: 'quinn@example.org', password: 'quinn password 1' })).status).toBe(200);
    const refused = await later.req('POST', '/portal/me/passkeys/options', {});
    expect([refused.status, refused.body.error.code, refused.body.error.key]).toEqual([403, 'confirm_needed', 'portalPasskeys.confirmFirst']);
    expect((await later.req('GET', '/portal/me/passkeys')).body).toMatchObject({ confirmedUntil: null, confirmWith: { passkey: true, link: true } });
    const passkeyId = (await later.req('GET', '/portal/me/passkeys')).body.passkeys[0].id;
    expect((await later.req('DELETE', `/portal/me/passkeys/${passkeyId}`)).body.error.code).toBe('confirm_needed');
    // Renaming takes nothing.
    expect((await later.req('PATCH', `/portal/me/passkeys/${passkeyId}`, { name: 'Work laptop' })).body.name).toBe('Work laptop');
    // One of their passkeys confirms it, for ten minutes.
    const confirm = await later.req('POST', '/portal/me/confirm/passkey/options', {});
    expect(confirm.body.allowCredentials).toEqual([{ id: b64(key.id), type: 'public-key', transports: ['internal', 'hybrid'] }]);
    const confirmed = await later.req('POST', '/portal/me/confirm/passkey', { response: key.sign(confirm.body) });
    expect(confirmed.status).toBe(200);
    expect(new Date(confirmed.body.confirmedUntil).getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect((await later.req('POST', '/portal/me/passkeys/options', {})).status).toBe(200);
    // Eleven minutes on, it's no longer recent, even for a link's session.
    const linked = await byLink('quinn@example.org');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect((await linked.req('POST', '/portal/me/passkeys/options', {})).body.error.code).toBe('confirm_needed');
  });

  it('removes one: the sessions it opened end, but not the one that removes it', async () => {
    const b = await byLink('rae@example.org');
    const key = new Authenticator();
    const added = await addKey(b, key);
    const signedIn = await withKey(key);
    expect(signedIn.status).toBe(200);
    expect((await b.req('DELETE', `/portal/me/passkeys/${added.body.id}`)).status).toBe(204);
    expect((await signedIn.b.req('GET', '/portal/me')).body).toBeNull();
    expect((await b.req('GET', '/portal/me')).body.email).toBe('rae@example.org');
    const after = await withKey(key);
    expect([after.status, after.body.error.key]).toEqual([401, 'portalPasskeys.notKnown']);
    // Another requester's passkey is missing to them.
    const other = await byLink('sam@example.org');
    const theirs = await addKey(other, new Authenticator());
    expect((await b.req('PATCH', `/portal/me/passkeys/${theirs.body.id}`, { name: 'Mine now' })).status).toBe(404);
    expect((await b.req('DELETE', `/portal/me/passkeys/${theirs.body.id}`)).status).toBe(404);
  });
});

describe('signing in', () => {
  it('signs in with a passkey alone, and opens only the desks that take passkeys', async () => {
    const atBack = await openRequest(w.app, await desk('BACK'), { name: 'Wes', email: 'wes@example.org', summary: 'VPN drops', description: '', via: 'form' });
    const atWeb = await openRequest(w.app, await desk('WEB'), { name: 'Wes', email: 'wes@example.org', summary: 'Site is slow', description: '', via: 'form' });
    const key = new Authenticator();
    expect((await addKey(await byLink('wes@example.org'), key)).status).toBe(201);
    const r = await withKey(key, { desk: 'BACK' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.options).toMatchObject({ rpId: 'a4a.test', userVerification: 'required', timeout: 300_000 });
    expect(r.options.allowCredentials ?? []).toEqual([]);
    // The ticket is this browser's, for the portal's passkey routes alone, and goes once used.
    expect(r.b.cookies.find((c) => c.startsWith('a4a_portal_pk=hdq_'))).toMatch(/Path=\/api\/v1\/portal\/passkey;.*HttpOnly.*SameSite=Strict/i);
    expect(r.b.jar.has('a4a_portal_pk')).toBe(false);
    expect(r.body).toMatchObject({ email: 'wes@example.org', signedInWith: { method: 'passkey', provider: null } });
    expect(r.body.elsewhere).toEqual([{ desk: { key: 'WEB', name: 'Web app' }, link: true, password: false, passkey: false, providers: [] }]);
    expect(((await r.b.req('GET', '/portal/requests')).body as { id: string }[]).map((x) => x.id)).toEqual([atBack.id]);
    expect((await r.b.req('GET', `/portal/requests/${atWeb.id}`)).status).toBe(404);
    const [session] = await w.app.db.select().from(requesterSessions).where(and(eq(requesterSessions.requesterId, await requesterId('wes@example.org')), eq(requesterSessions.method, 'passkey')));
    expect(session!.passkeyId).toBeTruthy();
    expect((await w.app.db.select().from(requesterPasskeys).where(eq(requesterPasskeys.id, session!.passkeyId!)))[0]!.lastUsedAt).toBeInstanceOf(Date);
    // Its session may add another for ten minutes: a passkey is as good as the mailbox it was made with.
    expect((await r.b.req('POST', '/portal/me/passkeys/options', {})).status).toBe(200);
    // A desk that doesn't take passkeys says so, on its page; and when it stops, its requests close at once.
    const web = await withKey(key, { desk: 'WEB' });
    expect([web.status, web.body.error.key, web.body.error.values]).toEqual([403, 'portal.passkeysOff', { desk: 'Web app' }]);
    await updateProject(w.adminCtx, 'BACK', { settings: { helpdesk: { signIn: ways(true, true, false) } } });
    try {
      expect((await r.b.req('GET', '/portal/requests')).body).toEqual([]);
      const nowhere = await withKey(key);
      expect([nowhere.status, nowhere.body.error.key]).toEqual([403, 'portal.passkeysOffEverywhere']);
      expect((await r.b.req('GET', '/portal/me/passkeys')).body).toMatchObject({ on: false, off: 'desks' });
    } finally {
      await updateProject(w.adminCtx, 'BACK', { settings: { helpdesk: { signIn: ways(true, true, true) } } });
    }
  });

  it('refuses a challenge used twice, run out, from another browser or ceremony, another origin, and a device that didn’t verify its person', async () => {
    const key = new Authenticator();
    const b = await byLink('tia@example.org');
    expect((await addKey(b, key)).status).toBe(201);
    // Used twice.
    const one = browser(nextIp());
    const options = await one.req('POST', '/portal/passkey/options', {});
    const answer = key.sign(options.body);
    expect((await one.req('POST', '/portal/passkey', { response: answer })).status).toBe(200);
    expect((await one.req('POST', '/portal/passkey', { response: answer })).body.error.code).toBe('passkey_stale');
    // Another browser's ticket, and none at all.
    const theirs = await browser(nextIp()).req('POST', '/portal/passkey/options', {});
    expect((await browser(nextIp()).req('POST', '/portal/passkey', { response: key.sign(theirs.body) })).body.error.code).toBe('passkey_stale');
    const mine = browser(nextIp());
    await mine.req('POST', '/portal/passkey/options', {});
    expect((await mine.req('POST', '/portal/passkey', { response: key.sign(theirs.body) })).body.error.code).toBe('passkey_stale');
    // Another ceremony's challenge: adding one, or the team's sign-in.
    const adding = await b.req('POST', '/portal/me/passkeys/options', {});
    const ticket = browser(nextIp());
    const signIn = await ticket.req('POST', '/portal/passkey/options', {});
    expect((await ticket.req('POST', '/portal/passkey', { response: key.sign({ ...signIn.body, challenge: adding.body.challenge }) })).body.error.code).toBe('passkey_stale');
    const team = await ticket.req('POST', '/auth/passkey/options', {});
    expect((await ticket.req('POST', '/portal/passkey', { response: key.sign({ ...signIn.body, challenge: team.body.challenge }) })).body.error.code).toBe('passkey_stale');
    // Run out: five minutes pass.
    const late = browser(nextIp());
    const lateOptions = await late.req('POST', '/portal/passkey/options', {});
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect((await late.req('POST', '/portal/passkey', { response: key.sign(lateOptions.body) })).body.error.code).toBe('passkey_stale');
    vi.useRealTimers();
    // A page elsewhere asked the authenticator; or a request that says it comes from another site.
    expect((await withKey(key, { origin: 'https://evil.test' })).body.error).toMatchObject({ code: 'passkey_origin', values: { origin: BASE } });
    expect((await browser(nextIp()).req('POST', '/portal/passkey/options', {}, { origin: 'https://evil.test' })).status).toBe(403);
    expect((await withKey(key, { uv: false })).body.error).toMatchObject({ code: 'user_not_verified', key: 'passkeys.notVerified' });
    // A signature that isn't the key's.
    const impostor = new Authenticator();
    impostor.id = key.id;
    impostor.userHandle = key.userHandle;
    expect((await withKey(impostor)).body.error.code).toBe('passkey_refused');
    // Still signing in after all that.
    expect((await withKey(key)).status).toBe(200);
  });

  it('stops a passkey whose sign count goes back: its sessions end, and the requester is told', async () => {
    const counter = new Authenticator({ counts: true });
    const b = await byLink('una@example.org');
    expect((await addKey(b, counter, 'Security key')).status).toBe(201);
    const first = await withKey(counter);
    expect(first.status).toBe(200);
    expect((await withKey(counter)).status).toBe(200);
    const copy = await withKey(counter, { counter: 1 });
    expect([copy.status, copy.body.error.code, copy.body.error.key]).toEqual([401, 'passkey_copied', 'portalPasskeys.copied']);
    expect((await first.b.req('GET', '/portal/me')).body).toBeNull();
    expect((await b.req('GET', '/portal/me')).body.email).toBe('una@example.org');
    expect((await withKey(counter, { counter: 50 })).body.error.code).toBe('passkey_copied');
    expect((await b.req('GET', '/portal/me/passkeys')).body.passkeys[0]).toMatchObject({ copied: true });
    await mailer.drain();
    const told = mailed('una@example.org', /(may have been copied)/);
    expect(told.subject).toBe('One of your help desk passkeys stopped working');
    // Its link removes that passkey, and signs them out everywhere.
    const link = ALERT_LINK.exec(told.text)![1]!;
    expect((await browser(nextIp()).req('POST', `/portal/not-me?token=${link}`)).body).toMatchObject({ change: 'copied', done: true });
    expect((await b.req('GET', '/portal/me')).body).toBeNull();
    expect(await w.app.db.select().from(requesterPasskeys).where(eq(requesterPasskeys.requesterId, await requesterId('una@example.org')))).toEqual([]);
  });
});

describe('kept apart from the team’s', () => {
  it('refuses a member’s passkey on the portal, a requester’s on the team’s side, and one credential id on both', async () => {
    await insertUser(w.app.db, { login: 'pat', name: 'Pat Member', role: 'member', password: 'pat-password-1', email: 'pat@example.org', emailVerified: true });
    w.app.schema.invalidate();
    // Pat, a member, adds a passkey for the team; and as a requester, by the same email, one for the portal.
    const team = browser(nextIp());
    expect((await team.req('POST', '/auth/login', { login: 'pat', password: 'pat-password-1' })).status).toBe(200);
    const memberKey = new Authenticator();
    const memberOptions = await team.req('POST', '/me/passkeys/options');
    expect((await team.req('POST', '/me/passkeys', { response: memberKey.register(memberOptions.body) })).status).toBe(201);
    const portal = await byLink('pat@example.org');
    const requesterKey = new Authenticator();
    expect((await addKey(portal, requesterKey)).status).toBe(201);
    // The handles differ, so an authenticator keeps both.
    expect(requesterKey.userHandle).not.toBe(memberKey.userHandle);
    expect(Buffer.from(requesterKey.userHandle, 'base64url').toString()).toMatch(/^hdr:/);

    // The member's passkey on the portal: said for what it is by its handle, and never looked up.
    const member = await withKey(memberKey);
    expect([member.status, member.body.error.key]).toEqual([401, 'portalPasskeys.teamPasskey']);
    expect((await withKey(memberKey, { handle: null })).body.error.key).toBe('portalPasskeys.notKnown');
    // The requester's on the team's sign-in page: a4a's team doesn't know it.
    const t = browser(nextIp());
    const teamOptions = await t.req('POST', '/auth/passkey/options');
    const onTeam = await t.req('POST', '/auth/passkey', { response: requesterKey.sign(teamOptions.body) });
    expect([onTeam.status, onTeam.body.error.code]).toEqual([401, 'passkey_unknown']);
    // A credential id already a member's can't be a requester's, nor the reverse.
    const clash = new Authenticator();
    clash.id = memberKey.id;
    const taken = await addKey(portal, clash);
    expect([taken.status, taken.body.error.key]).toEqual([409, 'passkeys.already']);
    const reverse = new Authenticator();
    reverse.id = requesterKey.id;
    const teamAgain = await team.req('POST', '/me/passkeys/options');
    const takenThere = await team.req('POST', '/me/passkeys', { response: reverse.register(teamAgain.body) });
    expect([takenThere.status, takenThere.body.error.key]).toEqual([409, 'passkeys.already']);
    // The portal's passkey session opens nothing of the team's.
    const signedIn = await withKey(requesterKey);
    expect(signedIn.status).toBe(200);
    expect((await signedIn.b.req('GET', '/me')).status).toBe(401);
    expect((await signedIn.b.req('GET', '/issues')).status).toBe(401);
  });
});

describe('one credential, one side, at once', () => {
  it('lets one of two additions of one credential id through when they come together, one on each side', async () => {
    await insertUser(w.app.db, { login: 'quill', name: 'Quill Member', role: 'member', password: 'quill-password-1', email: 'quill@corp.test', emailVerified: true });
    w.app.schema.invalidate();
    const team = browser(nextIp());
    expect((await team.req('POST', '/auth/login', { login: 'quill', password: 'quill-password-1' })).status).toBe(200);
    const portal = await byLink('quill@example.org');
    // Several rounds, each a fresh id: without the lock on the id, both sides find the other's table empty.
    for (let round = 0; round < 6; round++) {
      const member = new Authenticator();
      const requester = new Authenticator();
      requester.id = member.id;
      const [teamOptions, portalOptions] = await Promise.all([team.req('POST', '/me/passkeys/options'), portal.req('POST', '/portal/me/passkeys/options', {})]);
      const both = await Promise.all([
        team.req('POST', '/me/passkeys', { response: member.register(teamOptions.body) }),
        portal.req('POST', '/portal/me/passkeys', { response: requester.register(portalOptions.body) }),
      ]);
      expect(both.map((r) => r.status).sort(), JSON.stringify(both.map((r) => r.body))).toEqual([201, 409]);
    }
  });
});

describe('emails, and “this wasn’t me”', () => {
  it('mails each change in the desk’s language, with a link that signs them out everywhere and removes the passkey', async () => {
    const was = w.app.config.defaultLocale;
    (w.app.config as { defaultLocale: string }).defaultLocale = 'de';
    try {
      const b = await byLink('vic@example.org');
      const intruder = await addKey(b, new Authenticator(), 'Not mine');
      await addKey(b, new Authenticator(), 'Also not mine');
      const signedIn = await withKey(new Authenticator());
      expect(signedIn.status).toBe(401);
      // A pending link to sign in, which the intruder may have asked for too.
      expect((await browser(nextIp()).req('POST', '/portal/sign-in', { email: 'vic@example.org' })).status).toBe(202);
      await mailer.drain();
      const told = [...smtp.messages].filter((m) => m.to.includes('vic@example.org') && m.text.includes('„Not mine“'));
      expect(told).toHaveLength(1);
      expect(told[0]!.headers.get('subject')).toBe('Sie melden sich jetzt mit einem Passkey beim Helpdesk an');
      const link = ALERT_LINK.exec(told[0]!.text)![1]!;
      // Opening it changes nothing; following it does, once.
      const described = await browser(nextIp()).req('GET', `/portal/not-me?token=${link}`);
      expect(described.body).toMatchObject({ change: 'added', name: 'Not mine', email: 'vic@example.org', done: false });
      expect((await b.req('GET', '/portal/me')).body.email).toBe('vic@example.org');
      expect((await browser(nextIp()).req('POST', `/portal/not-me?token=${link}`, undefined, { origin: 'https://evil.test' })).status).toBe(403);
      expect((await browser(nextIp()).req('POST', `/portal/not-me?token=${link}`)).body).toMatchObject({ done: true });
      expect((await b.req('GET', '/portal/me')).body).toBeNull();
      const id = await requesterId('vic@example.org');
      expect((await w.app.db.select().from(requesterPasskeys).where(eq(requesterPasskeys.requesterId, id))).map((p) => p.name)).toEqual([]);
      expect(await w.app.db.select().from(requesterSignIns).where(and(eq(requesterSignIns.requesterId, id)))).toSatisfy((rows: { usedAt: Date | null }[]) => rows.every((r) => r.usedAt !== null));
      expect((await browser(nextIp()).req('POST', `/portal/not-me?token=${link}`)).body.done).toBe(true);
      expect((await browser(nextIp()).req('GET', '/portal/not-me?token=not-a-token-at-all')).status).toBe(404);
    } finally {
      (w.app.config as { defaultLocale: string }).defaultLocale = was;
    }
  });
});

describe('the throttles', () => {
  it('counts passkey sign-ins in the sign-in throttle, per passkey', async () => {
    const stranger = new Authenticator();
    stranger.userHandle = b64(Buffer.from('hdr:nobody'));
    const ip = '10.9.9.9';
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await withKey(stranger, {}, browser(ip))).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('holds every kind of challenge to 30 a minute per address', async () => {
    const b = await byLink('xia@example.org', browser('10.9.8.7'));
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await b.req('POST', i % 2 ? '/portal/passkey/options' : '/portal/me/passkeys/options', {})).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

describe('the team’s side', () => {
  it('says how many passkeys a request’s requester has, and lets an administrator or the desk’s manager remove them', async () => {
    const request = await openRequest(w.app, await desk('BACK'), { name: 'Yan', email: 'yan@example.org', summary: 'Badge reader', description: '', via: 'form' });
    const b = await byLink('yan@example.org');
    const one = new Authenticator();
    const added = await addKey(b, one, 'Phone');
    await addKey(b, new Authenticator(), 'Laptop');
    const signedIn = await withKey(one);
    expect(signedIn.status).toBe(200);
    const asAnna = (await issueTokenFor(w.app.db, w.anna.id, { name: 'anna', scopes: ['read', 'write'] })).token;
    const seen = await browser(nextIp()).req('GET', `/issues/${request.id}/request`, undefined, { bearer: asAnna });
    expect(seen.body.requester).toEqual({ name: 'Yan', email: 'yan@example.org', passkeys: 2, language: null });
    expect(JSON.stringify(seen.body)).not.toContain('Phone');
    // A member who doesn't manage the desk can't; a viewer's token can't write at all.
    const anna = await browser(nextIp()).req('DELETE', `/issues/${request.id}/request/passkeys`, undefined, { bearer: asAnna });
    expect([anna.status, anna.body.error.key]).toEqual([403, 'portalPasskeys.forManagers']);
    await expect(removeRequesterPasskeys(w.as(w.anna), request.id)).rejects.toMatchObject({ status: 403 });
    // The desk's manager can: every one of them, and the sessions they opened; they're told, without a link.
    await addMember(w.adminCtx, 'BACK', { user: 'ben', role: 'manager' });
    const asBen = (await issueTokenFor(w.app.db, w.ben.id, { name: 'ben', scopes: ['read', 'write'] })).token;
    const removed = await browser(nextIp()).req('DELETE', `/issues/${request.id}/request/passkeys`, undefined, { bearer: asBen });
    expect([removed.status, removed.body]).toEqual([200, { removed: 2 }]);
    expect((await signedIn.b.req('GET', '/portal/me')).body).toBeNull();
    expect((await b.req('GET', '/portal/me')).body.email).toBe('yan@example.org');
    expect((await withKey(one)).body.error.key).toBe('portalPasskeys.notKnown');
    expect((await b.req('GET', `/portal/me/passkeys`)).body.passkeys).toEqual([]);
    expect(added.status).toBe(201);
    await mailer.drain();
    const told = mailed('yan@example.org', /(The team at Backend removed your 2 passkeys)/);
    expect(told.subject).toBe('The team removed your help desk passkeys');
    expect(told.text).not.toMatch(/#hdk_/);
    // An administrator can too; nothing left, nothing to say.
    expect((await browser(nextIp()).req('DELETE', `/issues/${request.id}/request/passkeys`, undefined, { bearer: adminToken })).body).toEqual({ removed: 0 });
    // An issue that isn't a request, and one that doesn't exist.
    expect((await browser(nextIp()).req('DELETE', '/issues/BACK-999/request/passkeys', undefined, { bearer: adminToken })).status).toBe(404);
  });
});

describe('its words', () => {
  it('says each refusal the services make as the catalogs do, word for word', async () => {
    const request = await openRequest(w.app, await desk('BACK'), { name: 'Zoe', email: 'zoe@example.org', summary: 'Keyboard', description: '', via: 'form' });
    const refusals = await Promise.all(
      [updateProject(w.adminCtx, 'WEB', { settings: { helpdesk: { signIn: ways(false, false, true) } } }), removeRequesterPasskeys(w.as(w.anna), request.id)].map((p) =>
        p.then(() => null, (e: unknown) => e as AppError),
      ),
    );
    for (const e of refusals) expect(() => checkProblemWords(e!.message, e!.hint, e!.words!)).not.toThrow();
  });
});
