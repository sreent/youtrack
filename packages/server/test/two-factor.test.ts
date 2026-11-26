/**
 * Two-factor sign-in (D38): the codes themselves, the secret kept sealed, and the whole flow over
 * HTTP — setting it up from the profile, its step at sign-in, recovery codes, an administrator
 * asking it of everyone, and what it leaves alone.
 */
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { userTotp } from '../src/db/schema';
import { createHttpApp } from '../src/http/app';
import { open, seal } from '../src/lib/secret-box';
import { base32Decode, base32Encode, checkCode, codeAt, otpauthUri, stepAt } from '../src/lib/totp';
import { updateSettings } from '../src/services/settings';
import { insertUser } from '../src/services/users';
import { createWorld, type TestWorld } from './helpers';

const BASE = 'http://localhost:3999';

describe('codes (RFC 6238)', () => {
  // The RFC's own SHA-1 seed and times (Appendix B), cut to six digits.
  const seed = base32Encode(Buffer.from('12345678901234567890'));
  it('makes the RFC’s codes', () => {
    expect(codeAt(seed, stepAt(59_000))).toBe('287082');
    expect(codeAt(seed, stepAt(1_111_111_109_000))).toBe('081804');
    expect(codeAt(seed, stepAt(2_000_000_000_000))).toBe('279037');
    expect(base32Decode(seed).toString()).toBe('12345678901234567890');
  });

  it('takes a code from a step either side of now, and never one already taken', () => {
    const now = 1_700_000_000_000;
    const step = stepAt(now);
    expect(checkCode(seed, codeAt(seed, step - 1), now, null)).toBe(step - 1);
    expect(checkCode(seed, codeAt(seed, step + 1), now, null)).toBe(step + 1);
    expect(checkCode(seed, codeAt(seed, step - 2), now, null)).toBeNull();
    expect(checkCode(seed, codeAt(seed, step), now, step)).toBeNull();
    expect(checkCode(seed, codeAt(seed, step + 1), now, step)).toBe(step + 1);
    expect(checkCode(seed, '12345', now, null)).toBeNull();
    expect(checkCode(seed, 'abcdef', now, null)).toBeNull();
  });

  it('writes the address authenticator apps read', () => {
    expect(otpauthUri('JBSWY3DPEHPK3PXP', 'a4a', 'anna')).toBe('otpauth://totp/a4a:anna?secret=JBSWY3DPEHPK3PXP&issuer=a4a&algorithm=SHA1&digits=6&period=30');
  });
});

describe('the secret box', () => {
  const key = { secretKey: 'a key for the test, any text will do', dataDir: '/nonexistent' };
  it('opens what it sealed, and nothing tampered with or sealed under another key', () => {
    const sealed = seal(key, 'JBSWY3DPEHPK3PXP');
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(open(key, sealed)).toBe('JBSWY3DPEHPK3PXP');
    const parts = sealed.split('.');
    const flipped = [...parts.slice(0, 3), parts[3]!.slice(0, -2) + (parts[3]!.at(-2) === 'A' ? 'B' : 'A') + parts[3]!.slice(-1)].join('.');
    expect(open(key, flipped)).toBeNull();
    expect(open({ ...key, secretKey: 'another key' }, sealed)).toBeNull();
    expect(open(key, 'not sealed at all')).toBeNull();
  });
});

describe('two-factor sign-in over HTTP', () => {
  let w: TestWorld;
  let app: ReturnType<typeof createHttpApp>;
  let browsers = 0;

  const cookieOf = (res: Response, name: string) => {
    const hit = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
    return hit ? hit.split(';')[0]! : '';
  };

  async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; bearer?: string } = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': `10.1.0.${(browsers % 250) + 1}` };
    if (opts.cookie) {
      headers.cookie = opts.cookie;
      headers.origin = BASE;
    }
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    const res = await app.request(`/api/v1${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    const text = await res.text();
    return { res, status: res.status, body: text ? JSON.parse(text) : null };
  }

  async function signIn(login: string, password: string) {
    browsers++;
    const r = await call('POST', '/auth/login', { body: { login, password } });
    return { ...r, session: cookieOf(r.res, 'a4a_session'), ticket: cookieOf(r.res, 'a4a_2fa') };
  }

  /** The secret, as an app holding it would: from the enrolment's address. */
  const secretOf = (uri: string) => new URL(uri).searchParams.get('secret')!;
  const codeNow = (secret: string, offset = 0) => codeAt(secret, stepAt(Date.now()) + offset);

  beforeAll(async () => {
    w = await createWorld({ projects: false, config: { publicUrl: BASE, trustProxy: 1, secretKey: 'the test instance key' } });
    app = createHttpApp(w.app);
    await insertUser(w.app.db, { login: 'pat', name: 'Pat Password', role: 'member', password: 'pat-password-1', email: 'pat@corp.test', emailVerified: true });
    await insertUser(w.app.db, { login: 'quinn', name: 'Quinn', role: 'member', password: 'quinn-password-1' });
  });
  afterAll(async () => {
    await w.close();
  });
  beforeEach(() => {
    // Time stands still unless a test moves it, so a code's step is known.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  let patSecret = '';
  /** The code that confirmed Pat's setup, kept to replay: recomputed later, a step may have turned over. */
  let setupCode = '';
  let recovery: string[] = [];

  it('is set up from the profile with a QR code, and a code from the app turns it on', async () => {
    const first = await signIn('pat', 'pat-password-1');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ login: 'pat' });
    const session = first.session;
    expect((await call('GET', '/me/two-factor', { cookie: session })).body).toEqual({ enabled: false, enabledAt: null, recoveryCodesLeft: 0, required: false });

    const started = await call('POST', '/me/two-factor/setup', { cookie: session });
    expect(started.status).toBe(200);
    expect(started.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/a4a:pat\?secret=[A-Z2-7]{32}&issuer=a4a/);
    expect(started.body.secret.replace(/ /g, '')).toBe(secretOf(started.body.otpauthUri));
    // The QR code is an image made here: an SVG in a data address, which the page's CSP allows.
    expect(started.body.qrUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    const svg = Buffer.from(started.body.qrUrl.split(',')[1], 'base64').toString();
    expect(svg).toMatch(/^<svg[^>]*xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(svg).not.toMatch(/<script|style=|href=/);
    patSecret = secretOf(started.body.otpauthUri);
    // Kept sealed: the row doesn't hold the secret.
    const [row] = await w.app.db.select().from(userTotp).where(eq(userTotp.userId, (first.body as { id: string }).id));
    expect(row!.secret).not.toContain(patSecret);
    expect(row!.confirmedAt).toBeNull();

    const wrong = await call('POST', '/me/two-factor/confirm', { cookie: session, body: { code: codeNow(patSecret, 5) } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatchObject({ code: 'wrong_code' });
    setupCode = codeNow(patSecret, -1);
    const on = await call('POST', '/me/two-factor/confirm', { cookie: session, body: { code: setupCode } });
    expect(on.status).toBe(200);
    recovery = on.body.recoveryCodes;
    expect(recovery).toHaveLength(10);
    expect(new Set(recovery).size).toBe(10);
    for (const c of recovery) expect(c).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    expect((await call('GET', '/me/two-factor', { cookie: session })).body).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });
    // Setting it up again while it's on is refused.
    expect((await call('POST', '/me/two-factor/setup', { cookie: session })).status).toBe(409);
  });

  it('asks for a code after the password; the session comes only with it', async () => {
    const pw = await signIn('pat', 'pat-password-1');
    expect(pw.status).toBe(200);
    expect(pw.body).toEqual({ step: 'two_factor', code: true, passkey: false });
    expect(pw.session).toBe('');
    expect(pw.ticket).toMatch(/^a4a_2fa=a4t_/);
    expect(pw.res.headers.getSetCookie().find((c) => c.startsWith('a4a_2fa='))).toMatch(/Path=\/api\/v1\/auth\/two-factor; .*HttpOnly.*SameSite=Strict/);
    // The ticket isn't a session.
    expect((await call('GET', '/me', { cookie: pw.ticket })).status).toBe(401);
    // The code confirming the setup was taken; it can't be taken again: refused as used, or as stale
    // once its thirty seconds have passed.
    const replay = await call('POST', '/auth/two-factor/verify', { cookie: pw.ticket, body: { code: setupCode } });
    expect([400, 401]).toContain(replay.status);
    const done = await call('POST', '/auth/two-factor/verify', { cookie: pw.ticket, body: { code: codeNow(patSecret) } });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ login: 'pat', auth: { method: 'session' } });
    const session = cookieOf(done.res, 'a4a_session');
    expect((await call('GET', '/me', { cookie: session })).body).toMatchObject({ login: 'pat' });
    // The ticket is spent.
    expect((await call('POST', '/auth/two-factor/verify', { cookie: pw.ticket, body: { code: codeNow(patSecret, 1) } })).status).toBe(401);
  });

  it('takes a recovery code once', async () => {
    const pw = await signIn('pat', 'pat-password-1');
    const used = await call('POST', '/auth/two-factor/verify', { cookie: pw.ticket, body: { code: recovery[0]!.toLowerCase() } });
    expect(used.status).toBe(200);
    const again = await signIn('pat', 'pat-password-1');
    expect((await call('POST', '/auth/two-factor/verify', { cookie: again.ticket, body: { code: recovery[0] } })).status).toBe(400);
    const session = cookieOf(used.res, 'a4a_session');
    expect((await call('GET', '/me/two-factor', { cookie: session })).body).toMatchObject({ recoveryCodesLeft: 9 });
  });

  it('gives a sign-in five tries, then it must start again', async () => {
    const pw = await signIn('pat', 'pat-password-1');
    for (let i = 0; i < 5; i++) {
      expect((await call('POST', '/auth/two-factor/verify', { cookie: pw.ticket, body: { code: '000000' } })).status).toBe(400);
    }
    vi.setSystemTime(Date.now() + 90_000);
    const late = await call('POST', '/auth/two-factor/verify', { cookie: pw.ticket, body: { code: codeNow(patSecret) } });
    expect(late.status).toBe(401);
    expect(late.body.error.hint).toMatch(/Sign in again/);
    // A wrong password asks for no code: it is just wrong.
    expect((await signIn('pat', 'not-the-password')).status).toBe(401);
  });

  it('leaves API tokens alone, and a token can’t change how someone signs in', async () => {
    vi.setSystemTime(Date.now() + 180_000);
    const pw = await signIn('pat', 'pat-password-1');
    const done = await call('POST', '/auth/two-factor/verify', { cookie: pw.ticket, body: { code: codeNow(patSecret) } });
    const session = cookieOf(done.res, 'a4a_session');
    const made = await call('POST', '/me/tokens', { cookie: session, body: { name: 'script', scopes: ['read', 'write'] } });
    expect(made.status).toBe(201);
    const token = made.body.token as string;
    expect((await call('GET', '/me', { bearer: token })).body).toMatchObject({ login: 'pat', auth: { method: 'token' } });
    const tried = await call('POST', '/me/two-factor/disable', { bearer: token, body: { code: recovery[1] } });
    expect(tried.status).toBe(403);
    expect((await call('POST', '/me/two-factor/setup', { bearer: token })).status).toBe(403);
  });

  it('renews recovery codes and turns off with a code', async () => {
    vi.setSystemTime(Date.now() + 270_000);
    const pw = await signIn('pat', 'pat-password-1');
    const session = cookieOf((await call('POST', '/auth/two-factor/verify', { cookie: pw.ticket, body: { code: codeNow(patSecret) } })).res, 'a4a_session');
    const renewed = await call('POST', '/me/two-factor/recovery-codes', { cookie: session, body: { code: recovery[1] } });
    expect(renewed.status).toBe(200);
    expect(renewed.body.recoveryCodes).toHaveLength(10);
    expect(renewed.body.recoveryCodes).not.toContain(recovery[2]);
    // The old ones stopped working.
    expect((await call('POST', '/me/two-factor/disable', { cookie: session, body: { code: recovery[2] } })).status).toBe(400);
    const off = await call('POST', '/me/two-factor/disable', { cookie: session, body: { code: renewed.body.recoveryCodes[0] } });
    expect(off.status).toBe(204);
    expect((await signIn('pat', 'pat-password-1')).body).toMatchObject({ login: 'pat' });
  });

  it('when an administrator asks it of everyone, sign-in sets it up first; only they can reset it', async () => {
    await updateSettings(w.adminCtx, { requireTwoFactor: true });
    const pw = await signIn('quinn', 'quinn-password-1');
    expect(pw.body).toEqual({ step: 'two_factor_setup' });
    expect(pw.session).toBe('');
    // A ticket to set up is no ticket to verify.
    expect((await call('POST', '/auth/two-factor/verify', { cookie: pw.ticket, body: { code: '123456' } })).status).toBe(401);
    const started = await call('POST', '/auth/two-factor/setup', { cookie: pw.ticket });
    expect(started.status).toBe(200);
    const secret = secretOf(started.body.otpauthUri);
    const confirmed = await call('POST', '/auth/two-factor/setup/confirm', { cookie: pw.ticket, body: { code: codeNow(secret) } });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.recoveryCodes).toHaveLength(10);
    const session = cookieOf(confirmed.res, 'a4a_session');
    expect((await call('GET', '/me', { cookie: session })).body).toMatchObject({ login: 'quinn' });
    expect((await call('GET', '/me/two-factor', { cookie: session })).body).toMatchObject({ enabled: true, required: true });
    // They can't turn it off while it's required.
    const off = await call('POST', '/me/two-factor/disable', { cookie: session, body: { code: confirmed.body.recoveryCodes[0] } });
    expect(off.status).toBe(403);
    expect(off.body.error.code).toBe('two_factor_required');

    const quinnId = (await call('GET', '/me', { cookie: session })).body.id as string;
    expect((await call('DELETE', `/users/${quinnId}/two-factor`, { cookie: session })).status).toBe(403);
    const admin = await signIn('admin', 'password-admin');
    // The administrator is asked to set it up too.
    expect(admin.body).toEqual({ step: 'two_factor_setup' });
    await updateSettings(w.adminCtx, { requireTwoFactor: false });
    const adminIn = await signIn('admin', 'password-admin');
    expect((await call('DELETE', `/users/${quinnId}/two-factor`, { cookie: adminIn.session })).status).toBe(204);
    expect((await call('DELETE', '/users/nobody-at-all/two-factor', { cookie: adminIn.session })).status).toBe(404);
    expect((await signIn('quinn', 'quinn-password-1')).body).toMatchObject({ login: 'quinn' });
    const signIns = await call('GET', '/users', { cookie: adminIn.session });
    expect(signIns.status).toBe(200);
  });
});
