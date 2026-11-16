/**
 * Requester accounts and the portal (D45): signing in with a link sent by email, once, for a
 * while; seeing only their own requests, or their organization's where a desk shares them; public
 * comments only; replying on their own; asking without the proof of work; never a member.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users } from '../src/db/schema';
import { OutboxWorker } from '../src/events/worker';
import { helpdeskConsumer } from '../src/helpdesk/consumer';
import { createHttpApp } from '../src/http/app';
import { MailWorker } from '../src/mail/outbox';
import { notifierConsumer } from '../src/notify/notifier';
import { addComment } from '../src/services/comments';
import { openRequest } from '../src/services/helpdesk';
import { updateProject } from '../src/services/projects';
import { createWorld, type TestWorld } from './helpers';
import { fakeSmtp, type FakeSmtp } from './smtp';

const BASE = 'http://portal.test';
let w: TestWorld;
let smtp: FakeSmtp;
let http: ReturnType<typeof createHttpApp>;
let outbox: OutboxWorker;
let mailer: MailWorker;

async function flush() {
  await outbox.drain();
  await mailer.drain();
}

function browser(ip: string) {
  let cookie = '';
  const req = async (method: string, path: string, body?: unknown, opts: { origin?: string | null } = {}) => {
    const headers: Record<string, string> = { 'x-forwarded-for': ip };
    if (cookie) headers.cookie = cookie;
    if (opts.origin !== null && method !== 'GET') headers.origin = opts.origin ?? BASE;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await http.request(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, cookie: set };
  };
  return { req };
}

/** The sign-in link in the newest email to this address. */
function signInToken(to: string): string {
  const mail = [...smtp.messages].reverse().find((m) => m.to.includes(to) && m.text.includes('/portal#'));
  const m = mail && /\/portal#(hdl_[A-Za-z0-9_-]{43})/.exec(mail.text);
  if (!m) throw new Error(`no sign-in link mailed to ${to}`);
  return m[1]!;
}

async function signedIn(email: string, ip: string) {
  const b = browser(ip);
  expect((await b.req('POST', '/portal/sign-in', { email, desk: 'BACK' })).status).toBe(202);
  await flush();
  const res = await b.req('POST', '/portal/sign-in/redeem', { token: signInToken(email) });
  expect(res.status).toBe(200);
  expect(res.cookie).toMatch(/HttpOnly/i);
  expect(res.cookie).toMatch(/SameSite=Strict/i);
  return b;
}

const desk = async (key: string) => (await w.app.schema.get()).projectsByKey.get(key)!;

beforeAll(async () => {
  smtp = await fakeSmtp();
  w = await createWorld({ config: { smtpUrl: smtp.url, publicUrl: BASE, notifyWindowMs: 60_000, trustProxy: 1 } });
  await w.app.db.update(users).set({ email: 'anna@example.com' }).where(eq(users.id, w.anna.id));
  w.app.schema.invalidate();
  await updateProject(w.adminCtx, 'BACK', { lead: 'anna', settings: { helpdesk: { enabled: true, organizations: ['acme.com'], captcha: true } } });
  await updateProject(w.adminCtx, 'WEB', { settings: { helpdesk: { enabled: true } } });
  http = createHttpApp(w.app);
  outbox = new OutboxWorker(w.app, [notifierConsumer(w.app), helpdeskConsumer(w.app)], {}, [], () => {});
  mailer = new MailWorker(w.app, () => new Date(Date.now() + 10 * 60_000));
});

afterAll(async () => {
  await w?.close();
  await smtp?.close();
});

describe('the portal', () => {
  it('signs a requester in with a link that works once, and answers alike for any address', async () => {
    const b = browser('10.1.0.1');
    expect((await b.req('GET', '/portal/me')).status).toBe(401);
    expect((await b.req('POST', '/portal/sign-in', { email: 'new@example.org' })).body).toEqual({ sent: true });
    // From another site: refused.
    expect((await b.req('POST', '/portal/sign-in', { email: 'new@example.org' }, { origin: 'https://evil.example' })).status).toBe(403);
    await flush();
    const token = signInToken('new@example.org');
    const first = await b.req('POST', '/portal/sign-in/redeem', { token });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ email: 'new@example.org', name: 'new', organization: null });
    expect((await b.req('GET', '/portal/me')).body.email).toBe('new@example.org');
    // Used once: a second time, or by someone else, it's no good.
    expect((await browser('10.1.0.2').req('POST', '/portal/sign-in/redeem', { token })).status).toBe(401);
    expect((await b.req('PATCH', '/portal/me', { name: 'Nia New' })).body.name).toBe('Nia New');
    expect((await b.req('POST', '/portal/sign-out')).status).toBe(204);
    expect((await b.req('GET', '/portal/me')).status).toBe(401);
  });

  it('limits sign-in links per address and per email', async () => {
    const b = browser('10.1.1.1');
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await b.req('POST', '/portal/sign-in', { email: 'flood@example.org' })).status);
    expect(codes).toEqual([202, 202, 202, 429]);
  });

  it('shows their own requests with public comments only, and a colleague’s where the desk shares them', async () => {
    const mine = await openRequest(w.app, await desk('BACK'), { name: 'Rita', email: 'rita@acme.com', summary: 'Invoices are late', description: 'Since Monday.', via: 'form' });
    const colleague = await openRequest(w.app, await desk('BACK'), { name: 'Carl', email: 'carl@acme.com', summary: 'Printer is jammed', description: '', via: 'form' });
    const elsewhere = await openRequest(w.app, await desk('WEB'), { name: 'Carl', email: 'carl@acme.com', summary: 'Site is down', description: '', via: 'form' });
    const stranger = await openRequest(w.app, await desk('BACK'), { name: 'Zed', email: 'zed@other.org', summary: 'Password reset', description: '', via: 'form' });
    await addComment(w.as(w.anna), mine.id, 'Internal: the bank is slow.');
    await addComment(w.as(w.anna), mine.id, 'We are on it, Rita.', { visibility: 'public' });

    const rita = await signedIn('rita@acme.com', '10.1.2.1');
    expect((await rita.req('GET', '/portal/me')).body.organization).toBe('acme.com');
    const list = (await rita.req('GET', '/portal/requests')).body as { id: string; requester: { mine: boolean } }[];
    expect(list.map((r) => r.id).sort()).toEqual([mine.id, colleague.id].sort());
    expect(list.find((r) => r.id === colleague.id)!.requester.mine).toBe(false);
    // WEB shares nothing; a stranger's request is nobody's business: both missing, alike.
    for (const id of [elsewhere.id, stranger.id, 'BACK-9999', 'NOPE-1']) {
      const res = await rita.req('GET', `/portal/requests/${id}`);
      expect(res.status).toBe(404);
      expect(res.body.error.message).toBe("There's no request here");
    }
    const detail = (await rita.req('GET', `/portal/requests/${mine.id}`)).body as { messages: { from: string; text: string }[] };
    expect(detail.messages.map((m) => [m.from, m.text])).toEqual([['team', 'We are on it, Rita.']]);

    // Replies go on their own request; a colleague's they read.
    const replied = await rita.req('POST', `/portal/requests/${mine.id}/replies`, { text: 'Thanks!' });
    expect(replied.status).toBe(200);
    expect(replied.body.messages.at(-1)).toMatchObject({ from: 'you', text: 'Thanks!' });
    expect((await rita.req('POST', `/portal/requests/${colleague.id}/replies`, { text: 'Me too' })).status).toBe(403);
  });

  it('opens a request without the desk’s proof of work, and is never a member', async () => {
    const rita = await signedIn('rita@acme.com', '10.1.3.1');
    expect(((await rita.req('GET', '/portal/desks')).body as { key: string }[]).map((d) => d.key)).toEqual(['BACK']);
    const made = await rita.req('POST', '/portal/requests', { desk: 'BACK', summary: 'VPN drops', description: 'Every hour.' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ summary: 'VPN drops', requester: { name: 'Rita', mine: true } });
    // The portal's cookie opens nothing else: the team's API answers as to anyone signed out.
    expect((await rita.req('GET', '/issues')).status).toBe(401);
    expect((await rita.req('GET', `/issues/${made.body.id}`)).status).toBe(401);
  });

  it('lets the team invite a requester, by email', async () => {
    const req = await openRequest(w.app, await desk('BACK'), { name: 'Ida', email: 'ida@example.net', summary: 'Need access', description: '', via: 'form' });
    const token = (await (await import('../src/services/auth')).issueTokenFor(w.app.db, w.anna.id, { name: 'anna', scopes: ['read', 'write'] })).token;
    const res = await http.request(`/api/v1/issues/${req.id}/request/invite`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(204);
    await flush();
    expect(signInToken('ida@example.net')).toMatch(/^hdl_/);
  });
});
