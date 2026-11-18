/**
 * The portal's own sign-in (D63): each way end to end, a desk that takes only some (the others
 * refused, keyed for the requester's language), desks kept apart, a member's email used by a
 * requester, the sign-in throttle and the proof of work, links to set a password reused or stale,
 * a provider's unverified email, a customer group tied to a provider, and tracking links and CCs as
 * they were. Single sign-on runs against the fake identity provider D16's tests use.
 */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activities, requesterSignIns, requesters, users } from '../src/db/schema';
import { OutboxWorker } from '../src/events/worker';
import { helpdeskConsumer } from '../src/helpdesk/consumer';
import { createHttpApp } from '../src/http/app';
import { MailWorker } from '../src/mail/outbox';
import { notifierConsumer } from '../src/notify/notifier';
import { createCustomerGroup, updateCustomerGroup } from '../src/services/customer-groups';
import { mintTrackingToken, openRequest } from '../src/services/helpdesk';
import { createPortalProvider, deletePortalProvider, listPortalProviders } from '../src/services/portal-sign-in';
import { updateProject } from '../src/services/projects';
import { AppError, checkProblemWords } from '../src/lib/errors';
import { addCc } from '../src/services/request-ccs';
import { FakeIdp, type Person } from './fake-idp';
import { createWorld, type TestWorld } from './helpers';
import { fakeSmtp, type FakeSmtp } from './smtp';

const BASE = 'http://portal.test';
let w: TestWorld;
let smtp: FakeSmtp;
let http: ReturnType<typeof createHttpApp>;
let outbox: OutboxWorker;
let mailer: MailWorker;
const idp = new FakeIdp();
let provider: { id: string };

async function flush() {
  await outbox.drain();
  await mailer.drain();
}

/** A browser: its own address and a cookie jar, posting from the portal's origin unless told otherwise. */
function browser(ip: string) {
  const jar = new Map<string, string>();
  const req = async (method: string, path: string, body?: unknown, opts: { origin?: string | null } = {}) => {
    const headers: Record<string, string> = { 'x-forwarded-for': ip };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (opts.origin !== null && method !== 'GET') headers.origin = opts.origin ?? BASE;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await http.request(path.startsWith('/api/') ? path : `/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const set of res.headers.getSetCookie()) {
      const [pair] = set.split(';');
      const at = pair!.indexOf('=');
      const name = pair!.slice(0, at);
      const value = pair!.slice(at + 1);
      if (!value || /max-age=0/i.test(set)) jar.delete(name);
      else jar.set(name, value);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json as any, location: res.headers.get('location'), retryAfter: res.headers.get('retry-after') };
  };
  return { req, jar };
}

/** The newest email to this address whose text matches, and the token in it. */
function mailed(to: string, pattern: RegExp): { text: string; subject: string; token: string } {
  const mail = [...smtp.messages].reverse().find((m) => m.to.includes(to) && pattern.test(m.text));
  if (!mail) throw new Error(`no email to ${to} matching ${pattern}`);
  return { text: mail.text, subject: mail.headers.get('subject') ?? '', token: pattern.exec(mail.text)![1] ?? '' };
}
const PASSWORD_LINK = /\/portal(?:\?desk=[A-Z]+)?#(hdp_[A-Za-z0-9_-]{43})/;
const SIGN_IN_LINK = /\/portal#(hdl_[A-Za-z0-9_-]{43})/;

/** Ask for a link to set a password, and set it with the token it carries. */
async function setPassword(b: ReturnType<typeof browser>, email: string, password: string, desk = 'BACK') {
  expect((await b.req('POST', '/portal/password/link', { email, desk })).status).toBe(202);
  await flush();
  const { token } = mailed(email, PASSWORD_LINK);
  const set = await b.req('POST', '/portal/password/set', { token, password });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  return set;
}

/** Sign in through the fake provider, as the browser does: there, the person signs in, and back. */
async function throughProvider(b: ReturnType<typeof browser>, person: Person, desk = 'BACK', id = provider.id) {
  const start = await b.req('GET', `/portal/sso/${id}/start?desk=${desk}`);
  expect(start.status).toBe(302);
  if (!start.location!.startsWith(idp.url)) return start;
  const back = new URL(idp.approve(start.location!, person));
  return b.req('GET', `${back.pathname}${back.search}`);
}

const desk = async (key: string) => (await w.app.schema.get()).projectsByKey.get(key)!;
const ways = (link: boolean, password: boolean, providers: string[] = []) => ({ link, password, providers });

beforeAll(async () => {
  await idp.start();
  smtp = await fakeSmtp();
  w = await createWorld({ config: { smtpUrl: smtp.url, publicUrl: BASE, notifyWindowMs: 60_000, trustProxy: 1 } });
  await w.app.db.update(users).set({ email: 'ada@example.com', emailVerified: true }).where(eq(users.id, w.admin.id));
  w.app.schema.invalidate();
  provider = await createPortalProvider(w.adminCtx, { name: 'Acme SSO', issuer: idp.url, clientId: idp.clientId, clientSecret: idp.clientSecret, domains: ['acme.com', 'example.com'] });
  await updateProject(w.adminCtx, 'BACK', { lead: 'anna', settings: { helpdesk: { enabled: true, signIn: ways(true, true, [provider.id]) } } });
  await updateProject(w.adminCtx, 'WEB', { settings: { helpdesk: { enabled: true } } });
  http = createHttpApp(w.app);
  outbox = new OutboxWorker(w.app, [notifierConsumer(w.app), helpdeskConsumer(w.app)], {}, [], () => {});
  mailer = new MailWorker(w.app, () => new Date(Date.now() + 10 * 60_000));
});

afterAll(async () => {
  await w?.close();
  await smtp?.close();
  await idp.stop();
});

describe("a desk's choice", () => {
  it('says the ways a desk takes, and takes the emailed link alone by default', async () => {
    const b = browser('10.3.0.1');
    const back = (await b.req('GET', '/portal/sign-in-methods?desk=back')).body;
    expect(back).toMatchObject({ desk: { key: 'BACK' }, link: true, password: true, providers: [{ id: provider.id, name: 'Acme SSO', start: `/api/v1/portal/sso/${provider.id}/start?desk=BACK` }], captcha: null, mail: true });
    expect((await b.req('GET', '/portal/sign-in-methods?desk=WEB')).body).toMatchObject({ desk: { key: 'WEB' }, link: true, password: false, providers: [] });
    // No desk, or one that takes no requests: the ways some desk takes, and no customer's provider named.
    for (const q of ['', '?desk=NOPE', '?desk=CORE']) expect((await b.req('GET', `/portal/sign-in-methods${q}`)).body).toMatchObject({ desk: null, link: true, password: true, providers: [] });
  });

  it('refuses the ways a desk doesn’t take, keyed for the page to say in its language', async () => {
    const b = browser('10.3.1.1');
    const password = await b.req('POST', '/portal/password/sign-in', { email: 'zed@other.org', password: 'whatever-1', desk: 'WEB' });
    expect(password.status).toBe(403);
    expect(password.body.error).toMatchObject({ key: 'portal.passwordsOff', values: { desk: 'Web app' } });
    expect((await b.req('POST', '/portal/password/link', { email: 'zed@other.org', desk: 'WEB' })).body.error.key).toBe('portal.passwordsOff');
    await updateProject(w.adminCtx, 'WEB', { settings: { helpdesk: { signIn: ways(false, true) } } });
    const link = await b.req('POST', '/portal/sign-in', { email: 'zed@other.org', desk: 'WEB' });
    expect(link.status).toBe(403);
    expect(link.body.error).toMatchObject({ key: 'portal.linksOff', values: { desk: 'Web app' } });
    await updateProject(w.adminCtx, 'WEB', { settings: { helpdesk: { signIn: ways(true, false) } } });
    // A provider the desk doesn't offer: back to the portal, saying so.
    const sso = await b.req('GET', `/portal/sso/${provider.id}/start?desk=WEB`);
    expect(sso.location).toBe('/portal?sso=refused&desk=WEB');
    expect((await b.req('GET', '/portal/sso/nope/start')).location).toBe('/portal?sso=refused');
  });

  it('keeps one way at least, providers that exist, and records the change in the desk’s history', async () => {
    await expect(updateProject(w.adminCtx, 'WEB', { settings: { helpdesk: { signIn: ways(false, false) } } })).rejects.toMatchObject({ status: 400, words: { key: 'portalSignIn.oneWayAtLeast' } });
    await expect(updateProject(w.adminCtx, 'WEB', { settings: { helpdesk: { signIn: ways(true, false, ['nope']) } } })).rejects.toMatchObject({ status: 400, words: { key: 'portalSignIn.unknownProvider' } });
    // A desk's members can't choose: it's its managers' setting, as its others are.
    await expect(updateProject(w.as(w.anna), 'WEB', { settings: { helpdesk: { signIn: ways(true, true) } } })).rejects.toMatchObject({ status: 403 });
    await updateProject(w.adminCtx, 'WEB', { settings: { helpdesk: { signIn: ways(true, true) } } });
    await updateProject(w.adminCtx, 'WEB', { settings: { helpdesk: { signIn: ways(true, false) } } });
    const web = await desk('WEB');
    const logged = await w.app.db.select().from(activities).where(and(eq(activities.projectId, web.id), eq(activities.type, 'project.portal_sign_in.changed')));
    expect(logged.map((a) => (a.payload as { data: { to: unknown } }).data.to)).toEqual([
      { link: false, password: true, providers: [] },
      { link: true, password: false, providers: [] },
      { link: true, password: true, providers: [] },
      { link: true, password: false, providers: [] },
    ]);
  });
});

describe('a password', () => {
  it('is set by a link to their email, signs them out and back in, and shows their requests', async () => {
    const mine = await openRequest(w.app, await desk('BACK'), { name: 'Pia', email: 'pia@example.org', summary: 'Printer jams', description: '', via: 'form' });
    const b = browser('10.3.2.1');
    const set = await setPassword(b, 'pia@example.org', 'correct horse battery');
    expect(set.body).toMatchObject({ email: 'pia@example.org', password: true, signedInWith: { method: 'password', provider: null } });
    // The email to set it said what it was for, and they're told a password now signs them in.
    await flush();
    expect(mailed('pia@example.org', PASSWORD_LINK).subject).toBe("Set a password for Backend's help desk");
    expect(mailed('pia@example.org', /(A password was set for pia@example\.org)/).subject).toBe('A password now signs you in to the help desk');
    expect((await b.req('POST', '/portal/sign-out')).status).toBe(204);
    expect((await b.req('GET', '/portal/me')).body).toBeNull();
    const wrong = await b.req('POST', '/portal/password/sign-in', { email: 'pia@example.org', password: 'wrong horse battery', desk: 'BACK' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.key).toBe('portal.wrongPassword');
    // An address with no password, or none at all, is refused the same.
    for (const email of ['nobody@example.org', 'pia@example.org'.toUpperCase()]) {
      const other = await b.req('POST', '/portal/password/sign-in', { email, password: 'wrong horse battery' });
      expect([other.status, other.body.error.message]).toEqual([401, 'Wrong email or password']);
    }
    const again = await b.req('POST', '/portal/password/sign-in', { email: 'Pia@Example.org', password: 'correct horse battery', desk: 'BACK' });
    expect(again.status).toBe(200);
    expect(((await b.req('GET', '/portal/requests')).body as { id: string }[]).map((r) => r.id)).toEqual([mine.id]);
    // From another site: refused.
    expect((await browser('10.3.2.2').req('POST', '/portal/password/sign-in', { email: 'pia@example.org', password: 'correct horse battery' }, { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('is changed with the one they have, ending their other sessions', async () => {
    const one = browser('10.3.3.1');
    const two = browser('10.3.3.2');
    await setPassword(one, 'quinn@example.org', 'first password 1');
    expect((await two.req('POST', '/portal/password/sign-in', { email: 'quinn@example.org', password: 'first password 1' })).status).toBe(200);
    const bad = await one.req('PUT', '/portal/me/password', { current: 'not it at all', password: 'second password 2' });
    expect([bad.status, bad.body.error.key]).toEqual([400, 'portal.wrongCurrentPassword']);
    expect((await one.req('PUT', '/portal/me/password', { current: 'first password 1', password: 'second password 2' })).status).toBe(200);
    expect((await one.req('GET', '/portal/me')).body.email).toBe('quinn@example.org');
    expect((await two.req('GET', '/portal/me')).body).toBeNull();
    expect((await two.req('POST', '/portal/password/sign-in', { email: 'quinn@example.org', password: 'first password 1' })).status).toBe(401);
    expect((await two.req('POST', '/portal/password/sign-in', { email: 'quinn@example.org', password: 'second password 2' })).status).toBe(200);
    await flush();
    expect(mailed('quinn@example.org', /(The password for quinn@example\.org was changed)/).subject).toBe('Your help desk password was changed');
    // Too short is refused before anything is checked.
    expect((await one.req('PUT', '/portal/me/password', { current: 'second password 2', password: 'short' })).status).toBe(400);
  });

  it('takes a link once, never stale, and only the newest after a password is set', async () => {
    const b = browser('10.3.4.1');
    expect((await b.req('POST', '/portal/password/link', { email: 'rae@example.org', desk: 'BACK' })).status).toBe(202);
    await flush();
    const older = mailed('rae@example.org', PASSWORD_LINK).token;
    expect((await b.req('POST', '/portal/password/link', { email: 'rae@example.org', desk: 'BACK' })).status).toBe(202);
    await flush();
    const newer = mailed('rae@example.org', PASSWORD_LINK).token;
    expect(newer).not.toBe(older);
    expect((await b.req('POST', '/portal/password/set', { token: newer, password: 'rae password 1' })).status).toBe(200);
    // Used: no good again. Sent before it was used: no good either.
    for (const token of [newer, older]) {
      const res = await b.req('POST', '/portal/password/set', { token, password: 'rae password 2' });
      expect([res.status, res.body.error.key]).toEqual([401, 'portal.passwordLinkExpired']);
    }
    // A sign-in link is no password link, nor the reverse.
    expect((await b.req('POST', '/portal/sign-in/redeem', { token: newer })).status).toBe(401);
    // Stale: past its 20 minutes.
    expect((await b.req('POST', '/portal/password/link', { email: 'sam@example.org' })).status).toBe(202);
    await flush();
    const stale = mailed('sam@example.org', PASSWORD_LINK).token;
    await w.app.db.update(requesterSignIns).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(requesterSignIns.tokenHash, createHash('sha256').update(stale).digest('hex')));
    expect((await b.req('POST', '/portal/password/set', { token: stale, password: 'sam password 1' })).body.error.key).toBe('portal.passwordLinkExpired');
    // Two at once with one link: one sets it.
    expect((await b.req('POST', '/portal/password/link', { email: 'tia@example.org' })).status).toBe(202);
    await flush();
    const once = mailed('tia@example.org', PASSWORD_LINK).token;
    const both = await Promise.all([browser('10.3.4.2').req('POST', '/portal/password/set', { token: once, password: 'tia password 1' }), browser('10.3.4.3').req('POST', '/portal/password/set', { token: once, password: 'tia password 2' })]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('is locked out as members’ sign-ins are, per email, and the right password waits too', async () => {
    const b = browser('10.3.5.1');
    await setPassword(b, 'uma@example.org', 'uma password 1');
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await browser(`10.3.5.${10 + i}`).req('POST', '/portal/password/sign-in', { email: 'uma@example.org', password: `guess ${i} xxxx` })).status);
    expect(codes).toEqual([...Array(10).fill(401), 429]);
    const locked = await browser('10.3.5.99').req('POST', '/portal/password/sign-in', { email: 'uma@example.org', password: 'uma password 1' });
    expect(locked.status).toBe(429);
    expect(locked.body.error.key).toBe('portal.tooManyTries');
    expect(Number(locked.retryAfter)).toBeGreaterThan(0);
    // A member whose login is the same text is a key of its own.
    const member = await http.request('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, 'x-forwarded-for': '10.3.5.98' }, body: JSON.stringify({ login: 'uma@example.org', password: 'x' }) });
    expect(member.status).toBe(401);
  });

  it('asks for the desks’ proof of work when a desk that takes passwords asks its form for one', async () => {
    await updateProject(w.adminCtx, 'BACK', { settings: { helpdesk: { captcha: true } } });
    try {
      const b = browser('10.3.6.1');
      await setPassword(b, 'vic@example.org', 'vic password 1');
      const methods = (await b.req('GET', '/portal/sign-in-methods?desk=BACK')).body;
      expect(methods.captcha).toMatchObject({ algorithm: 'SHA-256', salt: expect.stringContaining('desk=*') });
      const without = await b.req('POST', '/portal/password/sign-in', { email: 'vic@example.org', password: 'vic password 1' });
      expect([without.status, without.body.error.key]).toEqual([400, 'helpdesk.captchaFailed']);
      // Solved as the browser solves it: the number whose SHA-256 with the salt is the challenge.
      const c = methods.captcha as { salt: string; challenge: string; signature: string; maxnumber: number };
      let number = 0;
      while (createHash('sha256').update(`${c.salt}${number}`).digest('hex') !== c.challenge) number++;
      const answer = { salt: c.salt, challenge: c.challenge, signature: c.signature, number };
      expect((await b.req('POST', '/portal/password/sign-in', { email: 'vic@example.org', password: 'vic password 1', captcha: answer })).status).toBe(200);
      // Taken once.
      expect((await b.req('POST', '/portal/password/sign-in', { email: 'vic@example.org', password: 'vic password 1', captcha: answer })).body.error.key).toBe('helpdesk.captchaFailed');
    } finally {
      await updateProject(w.adminCtx, 'BACK', { settings: { helpdesk: { captcha: false } } });
    }
  });

  it('never crosses to the team’s side: a requester with a member’s email, and a member’s password at the portal', async () => {
    const b = browser('10.3.7.1');
    await setPassword(b, 'ada@example.com', 'requester ada pass');
    const login = (body: unknown) => http.request('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, 'x-forwarded-for': '10.3.7.2' }, body: JSON.stringify(body) });
    expect((await login({ login: 'admin', password: 'requester ada pass' })).status).toBe(401);
    expect((await login({ login: 'ada@example.com', password: 'requester ada pass' })).status).toBe(401);
    expect((await login({ login: 'admin', password: 'password-admin' })).status).toBe(200);
    const portal = await browser('10.3.7.3').req('POST', '/portal/password/sign-in', { email: 'ada@example.com', password: 'password-admin' });
    expect(portal.status).toBe(401);
    // The portal's cookie opens nothing of the team's.
    expect((await b.req('GET', '/me')).status).toBe(401);
    expect((await b.req('GET', '/issues')).status).toBe(401);
    const [requester] = await w.app.db.select().from(requesters).where(eq(requesters.email, 'ada@example.com'));
    const [admin] = await w.app.db.select().from(users).where(eq(users.id, w.admin.id));
    expect(requester!.passwordHash).not.toBe(admin!.passwordHash);
  });
});

describe('desks kept apart', () => {
  it('opens only the desks that take the way a session was opened, and says how the others sign in', async () => {
    const atBack = await openRequest(w.app, await desk('BACK'), { name: 'Wes', email: 'wes@example.org', summary: 'VPN drops', description: '', via: 'form' });
    const atWeb = await openRequest(w.app, await desk('WEB'), { name: 'Wes', email: 'wes@example.org', summary: 'Site is slow', description: '', via: 'form' });
    const b = browser('10.3.8.1');
    const me = (await setPassword(b, 'wes@example.org', 'wes password 1')).body;
    expect(me.elsewhere).toEqual([{ desk: { key: 'WEB', name: 'Web app' }, link: true, password: false, providers: [] }]);
    expect(((await b.req('GET', '/portal/requests')).body as { id: string }[]).map((r) => r.id)).toEqual([atBack.id]);
    const web = await b.req('GET', `/portal/requests/${atWeb.id}`);
    expect([web.status, web.body.error.message]).toEqual([404, "There's no request here"]);
    expect((await b.req('POST', `/portal/requests/${atWeb.id}/replies`, { text: 'Hello?' })).status).toBe(404);
    expect(((await b.req('GET', '/portal/desks')).body as { key: string }[]).map((d) => d.key)).toEqual(['BACK']);
    const ask = await b.req('POST', '/portal/requests', { desk: 'WEB', summary: 'Another', description: '' });
    expect([ask.status, ask.body.error.key]).toEqual([403, 'portal.deskSignsInAnotherWay']);
    // A link session opens both: each desk takes links.
    const l = browser('10.3.8.2');
    expect((await l.req('POST', '/portal/sign-in', { email: 'wes@example.org' })).status).toBe(202);
    await flush();
    expect((await l.req('POST', '/portal/sign-in/redeem', { token: mailed('wes@example.org', SIGN_IN_LINK).token })).status).toBe(200);
    expect(((await l.req('GET', '/portal/requests')).body as { id: string }[]).map((r) => r.id).sort()).toEqual([atBack.id, atWeb.id].sort());
    // A desk that stops taking passwords closes its requests to password sessions at once.
    await updateProject(w.adminCtx, 'BACK', { settings: { helpdesk: { signIn: ways(true, false, [provider.id]) } } });
    try {
      expect((await b.req('GET', '/portal/requests')).body).toEqual([]);
      expect((await b.req('GET', '/portal/me')).body.elsewhere.map((d: { desk: { key: string } }) => d.desk.key)).toEqual(['BACK', 'WEB']);
    } finally {
      await updateProject(w.adminCtx, 'BACK', { settings: { helpdesk: { signIn: ways(true, true, [provider.id]) } } });
    }
  });
});

describe('single sign-on through a requesters’ provider', () => {
  it('signs a requester in by the email the provider verified, and tells them the first time', async () => {
    const mine = await openRequest(w.app, await desk('BACK'), { name: 'Xia', email: 'xia@example.com', summary: 'Laptop is slow', description: '', via: 'form' });
    const b = browser('10.3.9.1');
    const back = await throughProvider(b, { sub: 'xia-1', email: 'Xia@Example.com', email_verified: true, name: 'Xia Xu' });
    expect(back.status).toBe(302);
    expect(back.location).toBe('/portal?desk=BACK');
    expect(b.jar.has('a4a_portal')).toBe(true);
    expect(b.jar.has('a4a_portal_sso')).toBe(false);
    const me = (await b.req('GET', '/portal/me')).body;
    expect(me).toMatchObject({ email: 'xia@example.com', signedInWith: { method: 'sso', provider: { id: provider.id, name: 'Acme SSO' } } });
    expect(((await b.req('GET', '/portal/requests')).body as { id: string }[]).map((r) => r.id)).toEqual([mine.id]);
    await flush();
    expect(mailed('xia@example.com', /(Acme SSO signed you in to the help desk's portal as xia@example\.com)/).subject).toBe('Acme SSO now signs you in to the help desk');
    // The next time is nothing new: no email.
    const before = smtp.messages.length;
    expect((await throughProvider(browser('10.3.9.2'), { sub: 'xia-1', email: 'xia@example.com', email_verified: true })).location).toBe('/portal?desk=BACK');
    await flush();
    expect(smtp.messages.length).toBe(before);
    // Its session opens nothing of the team's.
    expect((await b.req('GET', '/issues')).status).toBe(401);
  });

  it('refuses an email the provider hasn’t verified, one outside its domains, and a state used twice or from another browser', async () => {
    const unverified = await throughProvider(browser('10.3.10.1'), { sub: 'yan-1', email: 'yan@example.com', email_verified: 'true' });
    expect(unverified.location).toBe('/portal?sso=unverified&desk=BACK');
    expect((await throughProvider(browser('10.3.10.2'), { sub: 'yan-2', email: 'yan@example.com' })).location).toBe('/portal?sso=unverified&desk=BACK');
    expect((await throughProvider(browser('10.3.10.3'), { sub: 'yan-3', email: 'yan@elsewhere.org', email_verified: true })).location).toBe('/portal?sso=domain&desk=BACK');
    // Entra ID's word for it counts.
    expect((await throughProvider(browser('10.3.10.4'), { sub: 'yan-4', email: 'yan@example.com', xms_edov: true })).location).toBe('/portal?desk=BACK');
    // The state is this browser's, once.
    const b = browser('10.3.10.5');
    const start = await b.req('GET', `/portal/sso/${provider.id}/start?desk=BACK`);
    const callback = new URL(idp.approve(start.location!, { sub: 'zoe-1', email: 'zoe@example.com', email_verified: true }));
    const thief = browser('10.3.10.6');
    expect((await thief.req('GET', `${callback.pathname}${callback.search}`)).location).toBe('/portal?sso=expired');
    expect((await b.req('GET', `${callback.pathname}${callback.search}`)).location).toBe('/portal?desk=BACK');
    const cookie = b.jar.get('a4a_portal');
    b.jar.set('a4a_portal_sso', new URL(start.location!).searchParams.get('state')!);
    expect((await b.req('GET', `${callback.pathname}${callback.search}`)).location).toBe('/portal?sso=expired');
    expect(b.jar.get('a4a_portal')).toBe(cookie);
    // Cancelled at the provider.
    const c = browser('10.3.10.7');
    const s2 = await c.req('GET', `/portal/sso/${provider.id}/start`);
    const denied = new URL(idp.deny(s2.location!));
    expect((await c.req('GET', `${denied.pathname}${denied.search}`)).location).toBe('/portal?sso=cancelled');
  });

  it('ties a customer group to the provider: its people see the desk’s requests only through it', async () => {
    const group = await createCustomerGroup(w.adminCtx, 'BACK', { name: 'Acme', domains: ['acme.com'], sharing: 'read', provider: provider.id });
    expect(group.provider).toEqual({ id: provider.id, name: 'Acme SSO' });
    try {
      const filed = await openRequest(w.app, await desk('BACK'), { name: 'Rita', email: 'rita@acme.com', summary: 'Invoices are late', description: '', via: 'form' });
      const colleague = await openRequest(w.app, await desk('BACK'), { name: 'Carl', email: 'carl@acme.com', summary: 'Badge reader', description: '', via: 'form' });
      const pw = browser('10.3.11.1');
      const me = (await setPassword(pw, 'rita@acme.com', 'rita password 1')).body;
      expect(me.elsewhere).toEqual([{ desk: { key: 'BACK', name: 'Backend' }, link: false, password: false, providers: [{ id: provider.id, name: 'Acme SSO' }] }]);
      expect((await pw.req('GET', '/portal/requests')).body).toEqual([]);
      expect((await pw.req('GET', `/portal/requests/${filed.id}`)).status).toBe(404);
      const sso = browser('10.3.11.2');
      await throughProvider(sso, { sub: 'rita-1', email: 'rita@acme.com', email_verified: true });
      expect(((await sso.req('GET', '/portal/requests')).body as { id: string }[]).map((r) => r.id).sort()).toEqual([filed.id, colleague.id].sort());
      // Left out, the group keeps its provider; a provider the desk doesn't offer is refused; the desk can't take it away from under the group.
      expect((await updateCustomerGroup(w.adminCtx, 'BACK', group.id, { name: 'Acme', domains: ['acme.com'], sharing: 'read' })).provider?.id).toBe(provider.id);
      await expect(createCustomerGroup(w.adminCtx, 'WEB', { name: 'Globex', provider: provider.id })).rejects.toMatchObject({ status: 400, words: { key: 'customerGroups.providerNotOffered' } });
      await expect(updateProject(w.adminCtx, 'BACK', { settings: { helpdesk: { signIn: ways(true, true) } } })).rejects.toMatchObject({ status: 409, words: { key: 'portalSignIn.groupSignsInThrough' } });
    } finally {
      await updateCustomerGroup(w.adminCtx, 'BACK', group.id, { name: 'Acme', domains: ['acme.com'], sharing: 'read', provider: null });
    }
  });

  it('is an administrator’s to add and remove, and a desk’s managers’ to read', async () => {
    await expect(createPortalProvider(w.as(w.anna), { name: 'Rogue', issuer: idp.url, clientId: 'x' })).rejects.toMatchObject({ status: 403 });
    await expect(listPortalProviders(w.as(w.ben))).rejects.toMatchObject({ status: 403, words: { key: 'portalSignIn.providersForManagers' } });
    const listed = await listPortalProviders(w.adminCtx);
    expect(listed[0]).toMatchObject({ name: 'Acme SSO', hasSecret: true, redirectUri: `${BASE}/api/v1/portal/sso/callback`, desks: ['BACK'] });
    expect(JSON.stringify(listed)).not.toContain(idp.clientSecret);
    await expect(createPortalProvider(w.adminCtx, { name: 'Plain', issuer: 'http://login.example.org', clientId: 'x' })).rejects.toMatchObject({ words: { key: 'portalSignIn.issuerNotHttps' } });
    await expect(createPortalProvider(w.adminCtx, { name: 'Down', issuer: 'http://127.0.0.1:9', clientId: 'x' })).rejects.toMatchObject({ status: 400, words: { key: 'portalSignIn.providerUnreachable' } });
    await expect(createPortalProvider(w.adminCtx, { name: 'acme sso', issuer: idp.url, clientId: 'x' })).rejects.toMatchObject({ status: 409 });
    await expect(deletePortalProvider(w.adminCtx, provider.id)).rejects.toMatchObject({ status: 409, words: { key: 'portalSignIn.providerInUse' } });
    const spare = await createPortalProvider(w.adminCtx, { name: 'Spare', issuer: idp.url, clientId: idp.clientId, clientSecret: idp.clientSecret });
    await deletePortalProvider(w.adminCtx, spare.id);
    expect((await listPortalProviders(w.adminCtx)).map((p) => p.name)).toEqual(['Acme SSO']);
  });
});

describe('its words', () => {
  it('says each refusal the services make as the catalogs do, word for word', async () => {
    const refusals = await Promise.all(
      [
        updateProject(w.adminCtx, 'WEB', { settings: { helpdesk: { signIn: ways(false, false) } } }),
        updateProject(w.adminCtx, 'WEB', { settings: { helpdesk: { signIn: ways(true, false, ['nope']) } } }),
        listPortalProviders(w.as(w.ben)),
        createPortalProvider(w.adminCtx, { name: 'Plain', issuer: 'http://login.example.org', clientId: 'x' }),
        createPortalProvider(w.adminCtx, { name: 'Shaped', issuer: 'https://user:pw@login.example.org', clientId: 'x' }),
        createPortalProvider(w.adminCtx, { name: 'Down', issuer: 'http://127.0.0.1:9', clientId: 'x' }),
        createPortalProvider(w.adminCtx, { name: 'acme sso', issuer: idp.url, clientId: 'x' }),
        deletePortalProvider(w.adminCtx, provider.id),
        deletePortalProvider(w.adminCtx, 'nope'),
        createCustomerGroup(w.adminCtx, 'WEB', { name: 'Initech', provider: provider.id }),
      ].map((p) => p.then(() => null, (e: unknown) => e as AppError)),
    );
    for (const e of refusals) {
      expect(e).toBeInstanceOf(AppError);
      expect(() => checkProblemWords(e!.message, e!.hint, e!.words!)).not.toThrow();
    }
    expect(refusals.map((e) => e!.words!.key)).toEqual([
      'portalSignIn.oneWayAtLeast',
      'portalSignIn.unknownProvider',
      'portalSignIn.providersForManagers',
      'portalSignIn.issuerNotHttps',
      'portalSignIn.issuerShape',
      'portalSignIn.providerUnreachable',
      'portalSignIn.providerNameTaken',
      'portalSignIn.providerInUse',
      'portalSignIn.providerNotFound',
      'customerGroups.providerNotOffered',
    ]);
  });
});

describe('what stays', () => {
  it('keeps tracking links and CCs working, whatever a desk takes', async () => {
    const req = await openRequest(w.app, await desk('BACK'), { name: 'Abe', email: 'abe@example.org', summary: 'Keyboard', description: '', via: 'form' });
    await addCc(w.adminCtx, req.id, { email: 'cy@example.com' });
    await updateProject(w.adminCtx, 'BACK', { settings: { helpdesk: { signIn: ways(false, false, [provider.id]) } } });
    try {
      // The tracking link is the request's own, as before.
      const token = await mintTrackingToken(w.app.db, req.uid);
      const tracked = await http.request('/api/v1/help/requests/by-token', { headers: { 'x-tracking-token': token, 'x-forwarded-for': '10.3.12.1' } });
      expect(tracked.status).toBe(200);
      // Someone copied signs in as the desk takes: through its provider, by the address copied.
      const cc = browser('10.3.12.2');
      await throughProvider(cc, { sub: 'cy-1', email: 'cy@example.com', email_verified: true });
      const seen = await cc.req('GET', `/portal/requests/${req.id}`);
      expect(seen.status).toBe(200);
      expect(seen.body).toMatchObject({ copied: true, canReply: true });
      // A link isn't how this desk signs anyone in now.
      expect((await cc.req('POST', '/portal/sign-in', { email: 'cy@example.com', desk: 'BACK' })).body.error.key).toBe('portal.linksOff');
    } finally {
      await updateProject(w.adminCtx, 'BACK', { settings: { helpdesk: { signIn: ways(true, true, [provider.id]) } } });
    }
  });

  it('words its emails in the help desk’s language', async () => {
    const was = w.app.config.defaultLocale;
    (w.app.config as { defaultLocale: string }).defaultLocale = 'de';
    try {
      const b = browser('10.3.13.1');
      expect((await b.req('POST', '/portal/password/link', { email: 'dora@example.org', desk: 'BACK' })).status).toBe(202);
      await flush();
      expect(mailed('dora@example.org', PASSWORD_LINK).subject).toBe('Passwort beim Helpdesk von Backend festlegen');
    } finally {
      (w.app.config as { defaultLocale: string }).defaultLocale = was;
    }
  });
});
