/**
 * A requester's language (docs/architecture.md, D63's revisit): chosen on the portal and kept on the
 * requester, over the browser's, on every device; every email to them follows it, then their browser's,
 * then the desk's (here the server's default is French, so each is told apart); a choice made signed
 * out is theirs at sign-in only when they had none; asking for a link changes nobody; and the team, an
 * agent too, sees it on the request.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requesters } from '../src/db/schema';
import { OutboxWorker } from '../src/events/worker';
import { helpdeskConsumer } from '../src/helpdesk/consumer';
import { relayConsumer } from '../src/helpdesk/relay';
import { createHttpApp } from '../src/http/app';
import { MailWorker, type MailRow } from '../src/mail/outbox';
import { notifierConsumer } from '../src/notify/notifier';
import { issueTokenFor } from '../src/services/auth';
import { addComment } from '../src/services/comments';
import { openRequest, requestOf } from '../src/services/helpdesk';
import { renderPortalPasskeyMail } from '../src/services/portal-passkeys';
import { createPortalProvider } from '../src/services/portal-sign-in';
import { updateProject } from '../src/services/projects';
import { addCc } from '../src/services/request-ccs';
import { toolByName } from '../src/tools/registry';
import { FakeIdp } from './fake-idp';
import { createWorld, type TestWorld } from './helpers';
import { fakeSmtp, type FakeSmtp, type Received } from './smtp';

const BASE = 'http://portal.test';
const ON_POSTGRES = Boolean(process.env.TEST_DATABASE_URL);
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

type Headers = Record<string, string>;

/** A browser: its own address, its languages, and a cookie jar, posting from the portal's origin. */
function browser(ip: string, languages: Headers = {}) {
  const jar = new Map<string, string>();
  const req = async (method: string, path: string, body?: unknown, more: Headers = {}) => {
    const headers: Headers = { 'x-forwarded-for': ip, ...languages, ...more };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET') headers.origin = BASE;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await http.request(path.startsWith('/api/') ? path : `/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const set of res.headers.getSetCookie()) {
      const [pair] = set.split(';');
      const at = pair!.indexOf('=');
      const value = pair!.slice(at + 1);
      if (!value || /max-age=0/i.test(set)) jar.delete(pair!.slice(0, at));
      else jar.set(pair!.slice(0, at), value);
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, location: res.headers.get('location') };
  };
  return { req, jar };
}

/** The newest email to this address whose text matches. */
function newest(to: string, pattern: RegExp = /./): Received {
  const mail = [...smtp.messages].reverse().find((m) => m.to.includes(to) && pattern.test(m.text));
  if (!mail) throw new Error(`no email to ${to} matching ${pattern}`);
  return mail;
}
/** The language an email is written in, as its page says it to a screen reader. */
const langOf = (m: Received) => /<html lang="([^"]+)"/.exec(m.html)?.[1];
const SIGN_IN = /\/portal#(hdl_[A-Za-z0-9_-]{43})/;
const PASSWORD = /\/portal(?:\?desk=[A-Z]+)?#(hdp_[A-Za-z0-9_-]{43})/;
const tokenIn = (m: Received, pattern: RegExp) => pattern.exec(m.text)![1]!;

/** Sign in by an emailed link, in a browser that asks for these languages, sending a language chosen on the page if one is given. */
async function signIn(email: string, ip: string, languages: Headers = {}, locale?: string) {
  const b = browser(ip, languages);
  expect((await b.req('POST', '/portal/sign-in', { email, desk: 'BACK' })).status).toBe(202);
  await flush();
  const res = await b.req('POST', '/portal/sign-in/redeem', { token: tokenIn(newest(email, SIGN_IN), SIGN_IN), ...(locale ? { locale } : {}) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  // As the page does once signed in: it reads who it is, and its browser's languages are kept (D63's revisit).
  expect((await b.req('GET', '/portal/me')).body.email).toBe(email);
  return { b, me: res.body };
}

const row = async (email: string) => (await w.app.db.select().from(requesters).where(sql`lower(${requesters.email}) = ${email}`))[0];
const desk = async (key: string) => (await w.app.schema.get()).projectsByKey.get(key)!;

beforeAll(async () => {
  await idp.start();
  smtp = await fakeSmtp();
  // The server writes French to whoever a4a knows no language for: the desk's, told apart from anyone's own.
  w = await createWorld({ config: { smtpUrl: smtp.url, publicUrl: BASE, notifyWindowMs: 60_000, trustProxy: 1, defaultLocale: 'fr' } });
  provider = await createPortalProvider(w.adminCtx, { name: 'Acme SSO', issuer: idp.url, clientId: idp.clientId, clientSecret: idp.clientSecret, domains: ['example.com'] });
  await updateProject(w.adminCtx, 'BACK', { lead: 'anna', settings: { helpdesk: { enabled: true, ccsRelay: true, signIn: { link: true, password: true, providers: [provider.id] } } } });
  http = createHttpApp(w.app);
  outbox = new OutboxWorker(w.app, [notifierConsumer(w.app), helpdeskConsumer(w.app), relayConsumer(w.app)], {}, [], () => {});
  mailer = new MailWorker(w.app, () => new Date(Date.now() + 10 * 60_000));
});

afterAll(async () => {
  await w?.close();
  await smtp?.close();
  await idp.stop();
});

async function file(email: string, summary: string) {
  return openRequest(w.app, await desk('BACK'), { name: email.split('@')[0]!, email, summary, description: 'It stopped.', via: 'form' });
}

describe("a requester's language (D63's revisit)", () => {
  it("is their choice, kept on the requester over their browser's, on every device; null gives their browser's back", async () => {
    const req = await file('linh@example.org', 'The VPN drops');
    await flush();
    // Nothing known yet: the acknowledgement is the desk's.
    expect(langOf(newest('linh@example.org'))).toBe('fr');
    const phone = await signIn('linh@example.org', '10.20.0.1', { 'accept-language': 'en-GB,en;q=0.8' });
    expect(phone.me).toMatchObject({ locale: null, defaultLocale: 'fr' });
    expect(await row('linh@example.org')).toMatchObject({ locale: 'en', chosenLocale: null });

    // She chooses Tiếng Việt: kept on her, her browser's kept beside it.
    const chose = await phone.b.req('PATCH', '/portal/me', { locale: 'vi' });
    expect(chose.status).toBe(200);
    expect(chose.body.locale).toBe('vi');
    expect(await row('linh@example.org')).toMatchObject({ locale: 'en', chosenLocale: 'vi' });

    // A second device, its browser in German, reads her choice; and the first still does.
    const laptop = await signIn('linh@example.org', '10.20.0.2', { 'accept-language': 'de-DE' });
    expect(laptop.me.locale).toBe('vi');
    expect((await phone.b.req('GET', '/portal/me')).body.locale).toBe('vi');
    expect(await row('linh@example.org')).toMatchObject({ locale: 'en', chosenLocale: 'vi' });

    // The team's reply reaches her in it.
    await addComment(w.as(w.anna), req.id, 'We are on it.', { visibility: 'public' });
    await flush();
    expect(langOf(newest('linh@example.org', /We are on it/))).toBe('vi');

    // Her browser's again: the choice comes off, and the next email follows the browser that last asked.
    const off = await laptop.b.req('PATCH', '/portal/me', { locale: null });
    expect(off.body.locale).toBeNull();
    expect((await laptop.b.req('GET', '/portal/me')).body.locale).toBeNull();
    expect(await row('linh@example.org')).toMatchObject({ locale: 'de', chosenLocale: null });
    await addComment(w.as(w.anna), req.id, 'Fixed now.', { visibility: 'public' });
    await flush();
    expect(langOf(newest('linh@example.org', /Fixed now/))).toBe('de');
    // The name still changes on its own, the language left as it is.
    expect((await laptop.b.req('PATCH', '/portal/me', { name: 'Linh Tran' })).body).toMatchObject({ name: 'Linh Tran', locale: null });
  });

  it("refuses a language a4a doesn't speak, wherever one is taken", async () => {
    const { b } = await signIn('refuse@example.org', '10.20.1.1');
    for (const locale of ['xx', 'vi-VN', 'zh-Hant', '', 7]) {
      expect((await b.req('PATCH', '/portal/me', { locale })).status, String(locale)).toBe(400);
    }
    expect((await row('refuse@example.org'))!.chosenLocale).toBeNull();
    expect((await b.req('POST', '/portal/sign-in', { email: 'refuse@example.org' })).status).toBe(202);
    await flush();
    const token = tokenIn(newest('refuse@example.org', SIGN_IN), SIGN_IN);
    expect((await browser('10.20.1.2').req('POST', '/portal/sign-in/redeem', { token, locale: 'klingon' })).status).toBe(400);
    expect((await browser('10.20.1.3').req('GET', `/portal/sso/${provider.id}/start?desk=BACK&locale=xx`)).status).toBe(400);
    // Refused before it was read: the link still works once.
    expect((await browser('10.20.1.2').req('POST', '/portal/sign-in/redeem', { token })).status).toBe(200);
  });

  it('takes a choice made signed out at sign-in, only when they had chosen none: by a link, a password and a provider', async () => {
    // By a link: chosen on the sign-in page, theirs once signed in.
    const first = await signIn('pick@example.org', '10.20.2.1', {}, 'th');
    expect(first.me.locale).toBe('th');
    expect((await row('pick@example.org'))!.chosenLocale).toBe('th');
    // Signed out and in again from a page in another language: the choice they made stands.
    expect((await first.b.req('POST', '/portal/sign-out')).status).toBe(204);
    expect((await signIn('pick@example.org', '10.20.2.2', {}, 'ja')).me.locale).toBe('th');

    // By a password: set from its link with a choice, then signed in with another one.
    const b = browser('10.20.2.3');
    expect((await b.req('POST', '/portal/password/link', { email: 'pw@example.org', desk: 'BACK' })).status).toBe(202);
    await flush();
    const set = await b.req('POST', '/portal/password/set', { token: tokenIn(newest('pw@example.org', PASSWORD), PASSWORD), password: 'a long portal password', locale: 'id' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.locale).toBe('id');
    await flush();
    // The word that a password was set is in it too.
    expect(langOf(newest('pw@example.org', /pw@example\.org/))).toBe('id');
    const again = await browser('10.20.2.4').req('POST', '/portal/password/sign-in', { email: 'pw@example.org', password: 'a long portal password', desk: 'BACK', locale: 'ko' });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.locale).toBe('id');

    // Through a provider: the choice waits with the sign-in's state, and the first sign-in's email is in it.
    const p = browser('10.20.2.5');
    const start = await p.req('GET', `/portal/sso/${provider.id}/start?desk=BACK&locale=ko`);
    expect(start.status).toBe(302);
    const back = new URL(idp.approve(start.location!, { sub: 'sso-ko', email: 'sso@example.com', email_verified: true }));
    expect((await p.req('GET', `${back.pathname}${back.search}`)).location).toBe('/portal?desk=BACK');
    expect((await p.req('GET', '/portal/me')).body.locale).toBe('ko');
    await flush();
    expect(langOf(newest('sso@example.com'))).toBe('ko');
  });

  it("writes to someone the help form meets first in the form's page's language; someone it knows keeps theirs", async () => {
    const b = browser('203.0.113.71');
    const form = await b.req('GET', '/help/BACK');
    expect(form.status).toBe(200);
    // New to a4a, on a form in Vietnamese: kept as their browser's, so the first email, and the next, are in it.
    const fresh = 'lan.form@example.org';
    const sent = await b.req('POST', '/help/BACK/requests', { name: 'Lan', email: fresh, summary: 'Hóa đơn chưa đến', description: '', csrf: form.body.csrf }, { 'x-a4a-locale': 'vi' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    await flush();
    expect(langOf(newest(fresh))).toBe('vi');
    expect(await row(fresh)).toMatchObject({ locale: 'vi', chosenLocale: null });
    // Known already, in Japanese: a form in Vietnamese, anyone's to post, changes nothing of theirs.
    const known = 'ken.form@example.org';
    await file(known, 'First');
    await w.app.db.update(requesters).set({ locale: 'ja' }).where(eq(requesters.email, known));
    const again = await b.req('POST', '/help/BACK/requests', { name: 'Ken', email: known, summary: 'Second', description: '', csrf: form.body.csrf }, { 'x-a4a-locale': 'vi' });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    await flush();
    expect(await row(known)).toMatchObject({ locale: 'ja', chosenLocale: null });
    expect(langOf(newest(known, /Second/))).toBe('ja');
  });

  it("asking for a link changes nobody: the mail is in their language, or for an address with none, the asking page's", async () => {
    // Known by her browser's German, and signed out.
    const known = await signIn('greta@example.org', '10.20.3.1', { 'accept-language': 'de' });
    await known.b.req('POST', '/portal/sign-out');
    const before = await row('greta@example.org');
    expect(before).toMatchObject({ locale: 'de', chosenLocale: null });
    // Someone asks for her link from a page in Japanese: her row is as it was, and the link is in German.
    const stranger = browser('10.20.3.2', { 'accept-language': 'ja', 'x-a4a-locale': 'ja' });
    expect((await stranger.req('POST', '/portal/sign-in', { email: 'greta@example.org' })).status).toBe(202);
    expect((await stranger.req('POST', '/portal/password/link', { email: 'greta@example.org' })).status).toBe(202);
    await flush();
    expect(await row('greta@example.org')).toEqual(before);
    expect(langOf(newest('greta@example.org', SIGN_IN))).toBe('de');
    expect(langOf(newest('greta@example.org', PASSWORD))).toBe('de');

    // An address a4a has no language for: the asking page's, carried with the mail, kept nowhere.
    expect((await stranger.req('POST', '/portal/sign-in', { email: 'kenji@example.org' })).status).toBe(202);
    expect((await browser('10.20.3.3', { 'x-a4a-locale': 'es' }).req('POST', '/portal/password/link', { email: 'sofia@example.org' })).status).toBe(202);
    await flush();
    expect(langOf(newest('kenji@example.org', SIGN_IN))).toBe('ja');
    expect(langOf(newest('sofia@example.org', PASSWORD))).toBe('es');
    expect(await row('kenji@example.org')).toMatchObject({ locale: null, chosenLocale: null });

    // The team's invitation carries no page's language: theirs, else the desk's.
    const req = await file('noemi@example.org', 'Printer offline');
    const { token } = await issueTokenFor(w.app.db, w.anna.id, { name: 'invite', scopes: ['read', 'write'] });
    const invited = await http.request(`/api/v1/issues/${req.id}/request/invite`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-a4a-locale': 'ja' } });
    expect(invited.status).toBe(204);
    await flush();
    expect(langOf(newest('noemi@example.org', SIGN_IN))).toBe('fr');
  });

  it("writes every email in each reader's language: replies, copies, relayed words, passwords and passkeys", async () => {
    // Yui chose Japanese; Min, copied, is a requester who chose Korean; Pat, copied, is unknown to a4a.
    const yui = await signIn('yui@example.org', '10.20.4.1');
    await yui.b.req('PATCH', '/portal/me', { locale: 'ja' });
    const min = await signIn('min@example.org', '10.20.4.2');
    await min.b.req('PATCH', '/portal/me', { locale: 'ko' });
    const req = await file('yui@example.org', 'Badge reader broken');
    await addCc(w.as(w.anna), req.id, { email: 'min@example.org' });
    await addCc(w.as(w.anna), req.id, { email: 'pat@example.net' });
    await flush();
    expect(langOf(newest('yui@example.org', /Badge reader broken/))).toBe('ja');

    await addComment(w.as(w.anna), req.id, 'A technician is on the way.', { visibility: 'public' });
    await flush();
    expect(langOf(newest('yui@example.org', /technician/))).toBe('ja');
    expect(langOf(newest('min@example.org', /technician/))).toBe('ko');
    expect(langOf(newest('pat@example.net', /technician/))).toBe('fr');

    // Her words on the portal, relayed to the others on it, each in theirs.
    expect((await yui.b.req('POST', `/portal/requests/${req.id}/replies`, { text: 'It beeps twice now.' })).status).toBe(200);
    await flush();
    expect(langOf(newest('min@example.org', /beeps twice/))).toBe('ko');
    expect(langOf(newest('pat@example.net', /beeps twice/))).toBe('fr');

    // What a4a tells her of her passkeys, rendered as the outbox would.
    const r = await row('yui@example.org');
    const mail = await renderPortalPasskeyMail(w.app, { payload: { requesterId: r!.id, change: 'removed-by-team', name: 'Phone', n: 1, desk: 'Backend', at: new Date().toISOString() } } as unknown as MailRow);
    expect(mail?.html).toMatch(/<html lang="ja">/);
  });

  it('shows the team the language, and whether they chose it, on the request; an agent reads it in get_issue', async () => {
    const chose = await file('yui@example.org', 'Second badge reader');
    const browsed = await file('greta@example.org', 'Monitor flickers');
    const unknown = await file('nobody-yet@example.org', 'Keyboard missing');
    const anna = w.as(w.anna);
    expect((await requestOf(anna, chose.id)).requester.language).toEqual({ locale: 'ja', chosen: true });
    expect((await requestOf(anna, browsed.id)).requester.language).toEqual({ locale: 'de', chosen: false });
    expect((await requestOf(anna, unknown.id)).requester.language).toBeNull();
    const { token } = await issueTokenFor(w.app.db, w.anna.id, { name: 'read', scopes: ['read'] });
    const res = await http.request(`/api/v1/issues/${chose.id}/request`, { headers: { authorization: `Bearer ${token}` } });
    expect(((await res.json()) as { requester: unknown }).requester).toMatchObject({ email: 'yui@example.org', language: { locale: 'ja', chosen: true } });
    const tool = toolByName('get_issue')!;
    const got = (await tool.run(anna, tool.input.parse({ issue: chose.id }) as never)) as { data: { request: { requester: unknown } } };
    expect(got.data.request.requester).toMatchObject({ language: { locale: 'ja', chosen: true } });
  });

  // A choice made elsewhere at the very moment a sign-in brings one from its page: the sign-in's waits
  // for it, and then finds them with a choice. Without the condition in startPortalSession's one
  // statement, the sign-in's choice overwrote the one made meanwhile.
  it.runIf(ON_POSTGRES)('never lets a sign-in overwrite a choice made at the same moment, on Postgres', async () => {
    await signIn('race@example.org', '10.20.5.1');
    const b = browser('10.20.5.2');
    expect((await b.req('POST', '/portal/sign-in', { email: 'race@example.org' })).status).toBe(202);
    await flush();
    const token = tokenIn(newest('race@example.org', SIGN_IN), SIGN_IN);
    const r = await row('race@example.org');
    let signing: ReturnType<typeof b.req> | undefined;
    await w.app.db.transaction(async (tx) => {
      // Chosen on another device, not yet committed: the sign-in's update waits on this row.
      await tx.update(requesters).set({ chosenLocale: 'ja' }).where(eq(requesters.id, r!.id));
      signing = b.req('POST', '/portal/sign-in/redeem', { token, locale: 'vi' });
      await new Promise((done) => setTimeout(done, 400));
    });
    const signed = await signing!;
    expect(signed.status).toBe(200);
    expect(signed.body.locale).toBe('ja');
    expect((await row('race@example.org'))!.chosenLocale).toBe('ja');
  });
});
