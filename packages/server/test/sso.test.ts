/**
 * Single sign-on (OpenID Connect) against a provider made for the test: the good path, and each
 * way a sign-in must fail.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '../src/app-services';
import { loadConfig, type OidcConfig } from '../src/config';
import { openDatabase, type Database } from '../src/db/client';
import { groupMembers, groups } from '../src/db/schema';
import { createHttpApp } from '../src/http/app';
import { newId } from '../src/lib/ids';
import { FakeIdp, type Person } from './fake-idp';
import { freshPostgres } from './helpers';

const BASE = 'http://localhost:3999';
const idp = new FakeIdp();
let runtime: Runtime;
let database: Database;
let pg: Awaited<ReturnType<typeof freshPostgres>>;
let app: ReturnType<typeof createHttpApp>;
let adminCookie = '';

function oidc(extra: Partial<OidcConfig> = {}): OidcConfig {
  return {
    issuer: idp.url,
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    scopes: 'openid email profile',
    name: 'Corp ID',
    allowedDomains: [],
    createUsers: true,
    redirectUri: `${BASE}/api/v1/auth/oidc/callback`,
    ...extra,
  };
}

const cookieOf = (res: Response, name: string) => {
  const all = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  const hit = all.find((c) => c.startsWith(`${name}=`));
  return hit ? hit.split(';')[0]! : '';
};

let browsers = 0;

/** Start a sign-in: where the browser is sent, and the state cookie it carries. Each comes from its own address. */
async function begin(next?: string) {
  const res = await app.request(`/api/v1/auth/oidc/start${next ? `?next=${encodeURIComponent(next)}` : ''}`, { headers: { 'x-forwarded-for': `10.0.0.${++browsers}` } });
  expect(res.status).toBe(302);
  return { location: res.headers.get('location')!, cookie: cookieOf(res, 'a4a_sso') };
}

/** Come back from the provider to a4a's callback, as the browser does. */
async function back(url: string, cookie: string) {
  const u = new URL(url);
  const res = await app.request(`${u.pathname}${u.search}`, { headers: cookie ? { cookie } : {} });
  return { status: res.status, location: res.headers.get('location') ?? '', session: cookieOf(res, 'a4a_session') };
}

/** A whole sign-in as `person`; `tamper` gets the provider to misbehave once. */
async function signIn(person: Person, opts: { next?: string; tamper?: FakeIdp['next'] } = {}) {
  const start = await begin(opts.next);
  if (opts.tamper) idp.next = opts.tamper;
  return back(idp.approve(start.location, person), start.cookie);
}

async function me(session: string) {
  const res = await app.request('/api/v1/me', { headers: { cookie: session } });
  return { status: res.status, body: res.status === 200 ? JSON.parse(await res.text()) : null };
}

beforeAll(async () => {
  await idp.start();
  // Browsers are told apart by the address one proxy in front adds, as behind a load balancer.
  const config = loadConfig({ aiEnabled: false, seedDemo: false, publicUrl: BASE, webDist: undefined, oidc: oidc(), passwordLogin: true, trustProxy: 1 });
  pg = await freshPostgres();
  database = await openDatabase(pg ? { url: pg.url } : { memory: true });
  runtime = await createRuntime(config, database);
  app = createHttpApp(runtime);
  const setup = await app.request('/api/v1/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'ada', name: 'Ada Admin', email: 'ada@corp.com', password: 'correct horse battery', seedDemo: false }),
  });
  adminCookie = cookieOf(setup, 'a4a_session');
});

beforeEach(() => {
  runtime.config.oidc = oidc();
  runtime.config.passwordLogin = true;
  idp.next = {};
});

afterAll(async () => {
  await database?.close();
  await pg?.drop();
  await idp.stop();
});

describe('signing in with the provider', () => {
  it('says on the sign-in page that it can', async () => {
    const res = await app.request('/api/v1/auth/setup');
    expect(await res.json()).toMatchObject({ signIn: { password: true, sso: { name: 'Corp ID', url: '/api/v1/auth/oidc/start' } } });
  });

  it('sends the browser with PKCE, a state, a nonce and the exact redirect URI', async () => {
    const { location, cookie } = await begin();
    const p = new URL(location).searchParams;
    expect(p.get('redirect_uri')).toBe(`${BASE}/api/v1/auth/oidc/callback`);
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('scope')).toBe('openid email profile');
    expect(cookie).toBe(`a4a_sso=${p.get('state')}`);
    expect(p.get('nonce')).toBeTruthy();
  });

  it('signs a new person in, with an account of their own, and back where they started', async () => {
    const res = await signIn({ sub: 'p-1', email: 'Nia@Corp.com', email_verified: true, name: 'Nia Okoro', preferred_username: 'nia' }, { next: '/issues/BACK-1' });
    expect(res).toMatchObject({ status: 302, location: '/issues/BACK-1' });
    expect(res.session).toMatch(/^a4a_session=tls_/);
    // The token endpoint got the same redirect URI and the PKCE verifier.
    expect(idp.lastTokenRequest!.get('redirect_uri')).toBe(`${BASE}/api/v1/auth/oidc/callback`);
    expect(idp.lastTokenRequest!.get('code_verifier')).toBeTruthy();
    const who = await me(res.session);
    expect(who.body).toMatchObject({ login: 'nia', name: 'Nia Okoro', email: 'nia@corp.com', role: 'member' });
    // The next time, they're found by the provider's subject, whatever their email says.
    const again = await signIn({ sub: 'p-1', email: 'nia.okoro@corp.com', email_verified: true });
    expect((await me(again.session)).body.login).toBe('nia');
    expect(again.session).not.toBe(res.session);
  });

  it('makes one account when the same new person comes back twice at once', async () => {
    const [a, b] = [await begin(), await begin()];
    const someone = { sub: 'p-twice', email: 'yara@corp.com', email_verified: true, name: 'Yara' };
    const [x, y] = await Promise.all([back(idp.approve(a.location, someone), a.cookie), back(idp.approve(b.location, someone), b.cookie)]);
    const [mx, my] = [await me(x.session), await me(y.session)];
    expect(mx.body.id).toBe(my.body.id);
    const people = JSON.parse(await (await app.request('/api/v1/users?search=yara', { headers: { cookie: adminCookie } })).text());
    expect(people).toHaveLength(1);
  });

  it('starts a new session each time, ending the one the browser had', async () => {
    const first = await signIn({ sub: 'p-2', email: 'omar@corp.com', email_verified: true, name: 'Omar' });
    const start = await begin();
    const url = new URL(idp.approve(start.location, { sub: 'p-2', email: 'omar@corp.com', email_verified: true }));
    const res = await app.request(`${url.pathname}${url.search}`, { headers: { cookie: `${start.cookie}; ${first.session}` } });
    const second = cookieOf(res, 'a4a_session');
    expect(second).not.toBe(first.session);
    expect((await me(first.session)).status).toBe(401);
    expect((await me(second)).status).toBe(200);
  });

  it('signs in to an existing account by an email the provider verified', async () => {
    const made = await app.request('/api/v1/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: BASE },
      body: JSON.stringify({ login: 'pia', name: 'Pia Persson', email: 'pia@corp.com', password: 'pia-password-1' }),
    });
    expect(made.status).toBe(201);
    const res = await signIn({ sub: 'p-3', email: 'PIA@corp.com', email_verified: true });
    expect((await me(res.session)).body).toMatchObject({ login: 'pia', name: 'Pia Persson' });
    // Administrators see how she signs in now.
    const people = await app.request('/api/v1/users?search=pia', { headers: { cookie: adminCookie } });
    const [pia] = (await people.json()) as { signIn: unknown }[];
    expect(pia!.signIn).toMatchObject({ password: true, emailConfirmed: true, identities: [{ provider: 'Corp ID', email: 'pia@corp.com' }] });
  });

  it('never links by an email the person typed for themselves', async () => {
    // Quinn (a member) sets someone else's address as theirs; it doesn't count until an administrator confirms it.
    const made = await app.request('/api/v1/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: BASE },
      body: JSON.stringify({ login: 'quinn', name: 'Quinn', password: 'quinn-password-1' }),
    });
    expect(made.status).toBe(201);
    const login = await app.request('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'quinn', password: 'quinn-password-1' }) });
    const quinn = cookieOf(login, 'a4a_session');
    const set = await app.request('/api/v1/me', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: quinn, origin: BASE }, body: JSON.stringify({ email: 'rosa@corp.com' }) });
    expect(set.status).toBe(200);
    const res = await signIn({ sub: 'p-rosa', email: 'rosa@corp.com', email_verified: true });
    expect(res).toMatchObject({ status: 302, location: '/login?sso=unconfirmed', session: '' });
  });

  it('refuses an email the provider has not verified', async () => {
    for (const verified of [false, 'true', undefined]) {
      const res = await signIn({ sub: `p-unv-${String(verified)}`, email: 'sam@corp.com', email_verified: verified });
      expect(res).toMatchObject({ location: '/login?sso=unverified', session: '' });
    }
  });

  it('refuses a domain that is not allowed', async () => {
    runtime.config.oidc = oidc({ allowedDomains: ['corp.com'] });
    const res = await signIn({ sub: 'p-out', email: 'tess@elsewhere.org', email_verified: true });
    expect(res).toMatchObject({ location: '/login?sso=domain', session: '' });
    const ok = await signIn({ sub: 'p-in', email: 'tess@corp.com', email_verified: true });
    expect(ok.location).toBe('/issues');
  });

  it('gives no account to someone unknown when accounts are not made on first sign-in', async () => {
    runtime.config.oidc = oidc({ createUsers: false });
    const res = await signIn({ sub: 'p-new', email: 'uma@corp.com', email_verified: true });
    expect(res).toMatchObject({ location: '/login?sso=no_account', session: '' });
  });

  it('puts them in the groups from the provider that its groups claim names, at every sign-in (D27)', async () => {
    runtime.config.oidc = oidc({ groupsClaim: 'groups' });
    const platform = newId();
    await database.db.insert(groups).values([
      { id: platform, name: 'Platform', providerName: 'platform' },
      { id: newId(), name: 'platform-by-hand' },
    ]);
    const members = async () => (await database.db.select().from(groupMembers).where(eq(groupMembers.groupId, platform))).map((m) => m.userId);
    const res = await signIn({ sub: 'p-groups', email: 'gita@corp.com', email_verified: true, name: 'Gita', groups: ['PLATFORM', 'platform-by-hand', 'unknown'] });
    const gita = (await me(res.session)).body;
    expect(await members()).toEqual([gita.id]);
    // A claim that's one string still counts; one gone takes them out.
    await signIn({ sub: 'p-groups', email: 'gita@corp.com', email_verified: true, groups: 'platform' });
    expect(await members()).toEqual([gita.id]);
    await signIn({ sub: 'p-groups', email: 'gita@corp.com', email_verified: true });
    expect(await members()).toEqual([]);
  });
});

describe('each way a sign-in must fail', () => {
  const person: Person = { sub: 'p-fail', email: 'vic@corp.com', email_verified: true, name: 'Vic' };

  it('a state that is not the one this browser was given', async () => {
    const a = await begin();
    const b = await begin();
    const res = await back(idp.approve(a.location, person), b.cookie);
    expect(res).toMatchObject({ location: '/login?sso=expired', session: '' });
    expect((await back(idp.approve(a.location, person), '')).location).toBe('/login?sso=expired');
  });

  it('a state used twice', async () => {
    const start = await begin();
    const url = idp.approve(start.location, person);
    expect((await back(url, start.cookie)).session).toMatch(/^a4a_session=/);
    expect(await back(url, start.cookie)).toMatchObject({ location: '/login?sso=expired', session: '' });
  });

  it('a wrong nonce', async () => {
    expect(await signIn(person, { tamper: { nonce: 'not-the-nonce' } })).toMatchObject({ location: '/login?sso=failed', session: '' });
  });

  it('an expired token', async () => {
    expect(await signIn(person, { tamper: { expiresIn: -600 } })).toMatchObject({ location: '/login?sso=failed', session: '' });
  });

  it('a bad signature', async () => {
    expect(await signIn(person, { tamper: { wrongKey: true } })).toMatchObject({ location: '/login?sso=failed', session: '' });
  });

  it('the wrong audience', async () => {
    expect(await signIn(person, { tamper: { audience: 'someone-else' } })).toMatchObject({ location: '/login?sso=failed', session: '' });
  });

  it('the wrong issuer', async () => {
    expect(await signIn(person, { tamper: { issuer: 'https://evil.example' } })).toMatchObject({ location: '/login?sso=failed', session: '' });
  });

  it('the person saying no at the provider', async () => {
    const start = await begin();
    expect(await back(idp.deny(start.location), start.cookie)).toMatchObject({ location: '/login?sso=cancelled', session: '' });
  });

  it('a way back that leads off the site', async () => {
    for (const next of ['https://evil.example/x', '//evil.example', '/\\evil.example', '/api/v1/me']) {
      const res = await signIn({ sub: 'p-redirect', email: 'xena@corp.com', email_verified: true }, { next });
      expect(res.location).toBe('/issues');
    }
  });

  it('a second account at the provider with the email of one already linked (a reused address)', async () => {
    expect(await signIn({ sub: 'p-fail-2', email: 'vic@corp.com', email_verified: true })).toMatchObject({ location: '/login?sso=refused', session: '' });
  });

  it('too many sign-ins started from one address', async () => {
    const from = { headers: { 'x-forwarded-for': '10.9.9.9' } };
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await app.request('/api/v1/auth/oidc/start', from)).status);
    expect(statuses.slice(0, 30).every((s) => s === 302)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it('a banned account', async () => {
    const res = await signIn({ sub: 'p-ban', email: 'wes@corp.com', email_verified: true, name: 'Wes' });
    const who = await me(res.session);
    const ban = await app.request(`/api/v1/users/${who.body.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: adminCookie, origin: BASE }, body: JSON.stringify({ banned: true }) });
    expect(ban.status).toBe(200);
    expect(await signIn({ sub: 'p-ban', email: 'wes@corp.com', email_verified: true })).toMatchObject({ location: '/login?sso=refused', session: '' });
  });
});

describe('with passwords turned off', () => {
  it('refuses a password, but signs in with the provider', async () => {
    runtime.config.passwordLogin = false;
    const status = JSON.parse(await (await app.request('/api/v1/auth/setup')).text());
    expect(status.signIn).toMatchObject({ password: false, sso: { name: 'Corp ID' } });
    const res = await app.request('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'ada', password: 'correct horse battery' }) });
    expect(res.status).toBe(403);
    expect(JSON.parse(await res.text()).error).toMatchObject({ code: 'password_login_off', hint: 'Sign in with Corp ID.' });
    // The first administrator signs in with the provider, found by the email they gave at setup.
    const sso = await signIn({ sub: 'p-ada', email: 'ada@corp.com', email_verified: true });
    const who = await me(sso.session);
    expect(who.body).toMatchObject({ login: 'ada', role: 'admin' });
    const pw = await app.request('/api/v1/me', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: sso.session, origin: BASE }, body: JSON.stringify({ password: 'another-password' }) });
    expect(pw.status).toBe(400);
  });
});
