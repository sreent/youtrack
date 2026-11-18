import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemCtx } from '../src/app-services';
import type { Ctx, UserRow } from '../src/context';
import { comments, helpdeskRequests, helpdeskTokens, issues, notifications, slaClocks, users } from '../src/db/schema';
import { OutboxWorker } from '../src/events/worker';
import { helpdeskConsumer } from '../src/helpdesk/consumer';
import { createHttpApp } from '../src/http/app';
import { MailWorker } from '../src/mail/outbox';
import { notifierConsumer } from '../src/notify/notifier';
import { searchIssues } from '../src/search/service';
import { issueTokenFor } from '../src/services/auth';
import { addComment, listComments } from '../src/services/comments';
import { requestOf } from '../src/services/helpdesk';
import { getIssue, updateIssue } from '../src/services/issues';
import { listNotifications } from '../src/services/notifications';
import { updateProject } from '../src/services/projects';
import { listWatchers } from '../src/services/watchers';
import { createWorld, type TestWorld } from './helpers';
import { fakeSmtp, type FakeSmtp } from './smtp';

const BASE = 'http://desk.test';
let w: TestWorld;
let smtp: FakeSmtp;
let http: ReturnType<typeof createHttpApp>;
let outbox: OutboxWorker;
let mailer: MailWorker;
let adminToken = '';

const as = (u: UserRow): Ctx => systemCtx(w.app, u, 'web');
async function flush() {
  await outbox.drain();
  await mailer.drain();
}

/** A visitor's browser: its own address and cookie jar, on the help desk's pages. */
function visitor(ip: string) {
  let cookie = '';
  const req = async (method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; origin?: string | null } = {}) => {
    const headers: Record<string, string> = { 'x-forwarded-for': ip, ...(opts.headers ?? {}) };
    if (cookie) headers.cookie = cookie;
    if (opts.origin !== null && method !== 'GET') headers.origin = opts.origin ?? BASE;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await http.request(`/api/v1${path}`, { method, headers, body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body, headers: res.headers };
  };
  return {
    req,
    /** Open the form, then send it. */
    async ask(key: string, fields: Partial<{ name: string; email: string; summary: string; description: string; website: string }>) {
      const form = await req('GET', `/help/${key}`);
      if (form.status !== 200) return form;
      return req('POST', `/help/${key}/requests`, {
        body: { name: 'Jane Doe', email: 'jane@example.com', summary: 'Cannot sign in', description: '', ...fields, csrf: form.body.csrf },
      });
    },
    track: (token: string) => req('GET', '/help/requests/by-token', { headers: { 'x-tracking-token': token } }),
    reply: (token: string, text: string, origin?: string | null) => req('POST', '/help/requests/by-token/replies', { headers: { 'x-tracking-token': token }, body: { text }, origin }),
  };
}

/** The tracking token in the newest email to this address. */
function tokenIn(to: string): string {
  const mail = [...smtp.messages].reverse().find((m) => m.to.includes(to));
  const m = mail && /\/request#(hdt_[A-Za-z0-9_-]{43})/.exec(mail.text);
  if (!m) throw new Error(`no tracking link mailed to ${to}`);
  return m[1]!;
}

async function issueOf(summary: string) {
  const [row] = await w.app.db.select().from(issues).where(eq(issues.summary, summary));
  return getIssue(w.adminCtx, row!.id);
}

beforeAll(async () => {
  smtp = await fakeSmtp();
  w = await createWorld({ config: { smtpUrl: smtp.url, publicUrl: BASE, notifyWindowMs: 60_000, trustProxy: 1 } });
  await w.app.db.update(users).set({ email: 'anna@example.com' }).where(eq(users.id, w.anna.id));
  w.app.schema.invalidate();
  await updateProject(w.adminCtx, 'BACK', { lead: 'anna', settings: { helpdesk: { enabled: true, firstResponseHours: 4, intro: 'Ask the backend team.' } } });
  http = createHttpApp(w.app);
  outbox = new OutboxWorker(w.app, [notifierConsumer(w.app), helpdeskConsumer(w.app)], {}, [], () => {});
  await outbox.drain();
  mailer = new MailWorker(w.app, () => new Date(Date.now() + 10 * 60_000));
  adminToken = (await issueTokenFor(w.app.db, w.admin.id, { name: 'admin', scopes: ['read', 'write', 'admin'] })).token;
});

afterAll(async () => {
  await w?.close();
  await smtp?.close();
});

describe('the help desk', () => {
  it('is set on the project, by its managers', async () => {
    const res = await http.request('/api/v1/projects/WEB', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { helpdesk: { firstResponseHours: 8 } } }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { settings: { helpdesk: unknown } }).settings.helpdesk).toEqual({ enabled: false, firstResponseHours: 8, intro: '', captcha: false, businessHours: null, waitingStates: [], resumeState: null });
    // Anna is a member of WEB, not a manager; she leads BACK, so she manages it.
    await expect(updateProject(as(w.anna), 'WEB', { settings: { helpdesk: { enabled: true } } })).rejects.toMatchObject({ status: 403 });
    expect((await updateProject(as(w.anna), 'BACK', { settings: { helpdesk: { intro: 'Ask the backend team.' } } })).settings.helpdesk.enabled).toBe(true);
    // Changing something else keeps it.
    const p = await updateProject(w.adminCtx, 'BACK', { description: 'APIs and data.' });
    expect(p.settings.helpdesk).toEqual({ enabled: true, firstResponseHours: 4, intro: 'Ask the backend team.', captcha: false, businessHours: null, waitingStates: [], resumeState: null });
  });

  it('shows its form only where it is on, and says the same wherever it is not', async () => {
    const v = visitor('10.0.0.1');
    const form = await v.req('GET', '/help/back');
    expect(form.status).toBe(200);
    expect(form.body).toMatchObject({ project: { key: 'BACK', name: 'Backend' }, intro: 'Ask the backend team.', mail: true });
    expect(form.headers.get('set-cookie')).toMatch(/a4a_help=.+; Max-Age=21600; Path=\/api\/v1\/help; HttpOnly; SameSite=Strict/);
    const off = await v.req('GET', '/help/WEB');
    const missing = await v.req('GET', '/help/NOPE');
    expect(off.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(off.body).toEqual(missing.body);
  });

  it('files a request as an issue, reported for the requester, and mails them a tracking link', async () => {
    const v = visitor('10.0.0.2');
    const res = await v.ask('BACK', { name: 'Jane  Doe', email: 'jane@example.com', summary: 'Password reset email never arrives', description: 'Tried twice. @anna can you help? @ben too.' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ received: true, email: 'jane@example.com', tracking: null });
    const issue = await issueOf('Password reset email never arrives');
    expect(issue.project.key).toBe('BACK');
    expect(issue.reporter).toMatchObject({ login: 'helpdesk', isBot: true });
    const request = await requestOf(as(w.ben), issue.id);
    expect(request.requester).toEqual({ name: 'Jane Doe', email: 'jane@example.com' });
    expect(request.firstResponse.state).toBe('due');
    expect(new Date(request.firstResponse.dueAt!).getTime() - new Date(request.createdAt).getTime()).toBe(4 * 3_600_000);
    // The lead watches it and is told; what the requester wrote mentions nobody.
    expect((await listWatchers(as(w.anna), issue.id)).watchers.map((x) => [x.user.login, x.reason])).toEqual([['anna', 'lead']]);
    await flush();
    const lead = (await listNotifications(as(w.anna))).items.find((n) => n.issue.id === issue.id);
    expect(lead).toMatchObject({ kind: 'request', title: 'Jane Doe asked for help through the help desk' });
    expect((await listNotifications(as(w.ben))).items.find((n) => n.issue.id === issue.id)).toBeUndefined();
    // Its history names the requester, through the help desk.
    const history = await (await import('../src/services/activity')).issueActivity(w.adminCtx, issue.id);
    expect(history[0]).toMatchObject({ type: 'issue.created', actor: { login: 'helpdesk', channel: 'helpdesk' }, data: { requester: { name: 'Jane Doe' } } });
    const confirmation = smtp.messages.find((m) => m.to.includes('jane@example.com'))!;
    expect(confirmation.headers.get('subject')).toBe('Password reset email never arrives');
    expect(confirmation.text).toContain('We have your request, Jane Doe.');
    expect(confirmation.text).toMatch(new RegExp(`${BASE}/request#hdt_`));
    expect(confirmation.html).not.toMatch(/<script|<img|style=/i);
    // The token is kept only as its hash.
    const token = tokenIn('jane@example.com');
    const stored = await w.app.db.select().from(helpdeskTokens);
    expect(stored.map((t) => t.tokenHash)).not.toContain(token);
    expect(stored.every((t) => /^[0-9a-f]{64}$/.test(t.tokenHash))).toBe(true);
  });

  it('shows the requester only their request: its state and public conversation, never what is internal', async () => {
    const issue = await issueOf('Password reset email never arrives');
    const token = tokenIn('jane@example.com');
    await addComment(as(w.anna), issue.id, 'Internal: the mail queue on smtp-2 is stuck.');
    await addComment(as(w.anna), issue.id, 'We found the problem and are fixing it now.', { visibility: 'public' });
    const v = visitor('10.0.0.3');
    const tracked = await v.track(token);
    expect(tracked.status).toBe(200);
    expect(tracked.headers.get('cache-control')).toBe('no-store');
    expect(tracked.body).toMatchObject({
      project: { name: 'Backend' },
      summary: 'Password reset email never arrives',
      state: { name: 'Open', resolved: false },
      requester: { name: 'Jane Doe', email: 'jane@example.com' },
    });
    expect(tracked.body.messages.map((m: { from: string; name: string; text: string }) => [m.from, m.name, m.text])).toEqual([
      ['team', 'Anna Schmidt', 'We found the problem and are fixing it now.'],
    ]);
    expect(JSON.stringify(tracked.body)).not.toContain('smtp-2');
    expect(JSON.stringify(tracked.body)).not.toMatch(/BACK-|"id":"[a-z0-9]{16}","from":"team".*internal/i);
    // The first public reply answers the first-response target.
    expect((await requestOf(as(w.anna), issue.id)).firstResponse.state).toBe('met');
    // And it reaches the requester by email; the internal note doesn't.
    await flush();
    const replies = smtp.messages.filter((m) => m.to.includes('jane@example.com') && m.headers.get('subject') === 'Re: Password reset email never arrives');
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toContain('Anna Schmidt replied to your request.');
    expect(replies[0]!.text).toContain('We found the problem');
    expect(replies[0]!.text).not.toContain('smtp-2');
    expect(replies[0]!.headers.get('in-reply-to')).toMatch(/^<request-.+@desk\.test>$/);
  });

  it("lets a requester reply, which tells the issue's watchers, and refuses a reply from another site", async () => {
    const issue = await issueOf('Password reset email never arrives');
    const token = tokenIn('jane@example.com');
    const v = visitor('10.0.0.4');
    expect((await v.reply(token, 'It came through now, thanks.', 'https://evil.example')).status).toBe(403);
    expect((await v.reply(token, 'It came through now, thanks.', null)).status).toBe(403);
    const replied = await v.reply(token, 'It came through now, thanks. @ben');
    expect(replied.status).toBe(200);
    expect(replied.body.messages.at(-1)).toMatchObject({ from: 'you', name: 'Jane Doe', text: 'It came through now, thanks. @ben' });
    const all = await listComments(as(w.anna), issue.id);
    expect(all.at(-1)).toMatchObject({ visibility: 'public', requester: { name: 'Jane Doe' }, author: { login: 'helpdesk' }, channel: 'helpdesk' });
    await flush();
    const told = (await listNotifications(as(w.anna))).items.filter((n) => n.issue.id === issue.id);
    expect(told.some((n) => n.title === 'Jane Doe replied')).toBe(true);
    // A requester's @ben pages nobody.
    expect((await listNotifications(as(w.ben))).items.find((n) => n.issue.id === issue.id)).toBeUndefined();
    // The requester's own reply isn't mailed back to them.
    expect(smtp.messages.filter((m) => m.to.includes('jane@example.com') && m.text.includes('It came through now'))).toEqual([]);
  });

  it('mails the requester when the state changes', async () => {
    const issue = await issueOf('Password reset email never arrives');
    await updateIssue(as(w.anna), issue.id, { fields: { State: 'Fixed' } });
    await flush();
    const mail = smtp.messages.findLast((m) => m.to.includes('jane@example.com'))!;
    expect(mail.text).toContain('Your request is resolved: Fixed.');
    const token = tokenIn('jane@example.com');
    expect((await visitor('10.0.0.5').track(token)).body.state).toEqual({ name: 'Fixed', resolved: true });
  });

  it('keeps one request from another: each token opens its own, and nothing else opens any', async () => {
    const a = visitor('10.0.1.1');
    const b = visitor('10.0.1.2');
    expect((await a.ask('BACK', { name: 'Ann Other', email: 'ann@example.org', summary: 'Invoice PDF is blank' })).status).toBe(201);
    expect((await b.ask('BACK', { name: 'Bob Byte', email: 'bob@example.org', summary: 'API key page errors' })).status).toBe(201);
    await flush();
    const tokenA = tokenIn('ann@example.org');
    const tokenB = tokenIn('bob@example.org');
    // Bob, holding his own token, sees only his request…
    const own = await b.track(tokenB);
    expect(own.body.summary).toBe('API key page errors');
    expect(JSON.stringify(own.body)).not.toContain('Invoice');
    // …and Ann's token, wherever it comes from, opens only Ann's.
    expect((await b.track(tokenA)).body.summary).toBe('Invoice PDF is blank');
    await b.reply(tokenB, 'Still broken today.');
    expect((await a.track(tokenA)).body.messages).toEqual([]);
    // A token changed by a letter, a made-up one, none at all, or a request's issue id: all the same 404.
    const altered = tokenB.slice(0, -1) + (tokenB.endsWith('A') ? 'B' : 'A');
    const answers = await Promise.all([b.track(altered), b.track('hdt_' + 'x'.repeat(43)), b.track('not-a-token'), b.req('GET', '/help/requests/by-token')]);
    for (const r of answers) {
      expect(r.status).toBe(404);
      expect(r.body).toEqual(answers[0]!.body);
    }
    expect((await b.reply(altered, 'Let me in')).status).toBe(404);
    // Deleting the issue closes its link.
    const issue = await issueOf('Invoice PDF is blank');
    await (await import('../src/services/issues')).deleteIssue(w.adminCtx, issue.id);
    expect((await a.track(tokenA)).status).toBe(404);
  });

  it('refuses a forged or expired form, and keeps what it takes small', async () => {
    const v = visitor('10.0.2.1');
    const form = await v.req('GET', '/help/BACK');
    const body = { name: 'Mallory', email: 'm@example.org', summary: 'Forged', description: '', csrf: form.body.csrf };
    // From another site, or without an Origin at all.
    expect((await v.req('POST', '/help/BACK/requests', { body, origin: 'https://evil.example' })).status).toBe(403);
    expect((await v.req('POST', '/help/BACK/requests', { body, origin: null })).status).toBe(403);
    // Without the form's cookie (another browser), or with another form's token.
    const stranger = visitor('10.0.2.2');
    expect((await stranger.req('POST', '/help/BACK/requests', { body })).body.error.code).toBe('form_expired');
    expect((await v.req('POST', '/help/BACK/requests', { body: { ...body, csrf: `${Date.now()}.forged` } })).status).toBe(403);
    // An old token.
    const { formToken } = await import('../src/services/helpdesk');
    const nonce = /a4a_help=([^;]+)/.exec(form.headers.get('set-cookie')!)![1]!;
    const stale = await formToken(w.app, 'BACK', nonce, Date.now() - 7 * 3_600_000);
    expect((await v.req('POST', '/help/BACK/requests', { body: { ...body, csrf: stale } })).status).toBe(403);
    // Sizes.
    expect((await v.req('POST', '/help/BACK/requests', { body: { ...body, summary: 'x'.repeat(201) } })).status).toBe(400);
    expect((await v.req('POST', '/help/BACK/requests', { body: { ...body, email: 'not an email' } })).status).toBe(400);
    expect((await v.req('POST', '/help/BACK/requests', { body: { ...body, description: 'x'.repeat(60_000) } })).status).toBe(413);
    expect(await w.app.db.select().from(issues).where(eq(issues.summary, 'Forged'))).toEqual([]);
  });

  it('takes the bait in silence, and limits requests per address and per email', async () => {
    const bot = visitor('10.0.3.1');
    const before = (await w.app.db.select().from(issues)).length;
    const trapped = await bot.ask('BACK', { summary: 'Cheap watches', website: 'http://spam.example' });
    expect(trapped.status).toBe(201);
    expect(trapped.body).toMatchObject({ received: true });
    expect((await w.app.db.select().from(issues)).length).toBe(before);
    // Five requests in a quarter of an hour from one address; the sixth waits.
    const busy = visitor('10.0.3.2');
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await busy.ask('BACK', { email: `p${i}@example.org`, summary: `Request number ${i}` })).status);
    expect(codes).toEqual([201, 201, 201, 201, 201, 429]);
    // Three an hour from one email, whatever the address.
    const emails: number[] = [];
    for (let i = 0; i < 4; i++) emails.push((await visitor(`10.0.4.${i}`).ask('BACK', { email: 'same@example.org', summary: `Same person ${i}` })).status);
    expect(emails).toEqual([201, 201, 201, 429]);
  });

  it('marks public comments, allows them only on requests, and finds requests by their target', async () => {
    const v = visitor('10.0.5.1');
    await v.ask('BACK', { name: 'Sam Slow', email: 'sam@example.org', summary: 'Export never finishes' });
    const issue = await issueOf('Export never finishes');
    const plain = await (await import('../src/services/issues')).createIssue(as(w.anna), { project: 'BACK', summary: 'Not a request' });
    await expect(addComment(as(w.anna), plain.id, 'Hello outside', { visibility: 'public' })).rejects.toMatchObject({ status: 400 });
    expect((await searchIssues(as(w.anna), `has: request sla: due ${issue.id}`, 0, 10)).total).toBe(1);
    expect((await searchIssues(as(w.anna), 'requester: sam@example.org', 0, 10)).items.map((i) => i.id)).toEqual([issue.id]);
    // Past its target with no reply, it is overdue; replied to late, the target was missed.
    // Its clock started long ago (D45): the deadline it counts to is past.
    await w.app.db
      .update(slaClocks)
      .set({ runningSince: new Date(Date.now() - 1000 * 3_600_000), dueAt: new Date(Date.now() - 60_000), warnAt: new Date(Date.now() - 60_000) })
      .where(eq(slaClocks.issueId, issue.uid));
    expect((await requestOf(as(w.anna), issue.id)).firstResponse.state).toBe('overdue');
    expect((await searchIssues(as(w.anna), 'sla: overdue', 0, 50)).items.map((i) => i.id)).toContain(issue.id);
    expect((await searchIssues(as(w.anna), 'sla: overdeu', 0, 50).catch((e) => e)).details.fixed).toBe('sla: overdue');
    await addComment(as(w.anna), issue.id, 'Sorry for the wait: we are on it.', { visibility: 'public' });
    expect((await requestOf(as(w.anna), issue.id)).firstResponse.state).toBe('missed');
    expect((await searchIssues(as(w.anna), 'sla: missed', 0, 50)).items.map((i) => i.id)).toContain(issue.id);
    await expect(requestOf(as(w.anna), plain.id)).rejects.toMatchObject({ status: 404 });
  });

  it("stops a requester's emails from the link in one, and still shows them the page", async () => {
    const v = visitor('10.0.6.1');
    await v.ask('BACK', { name: 'Quinn Quiet', email: 'quinn@example.org', summary: 'Please stop emailing' });
    await flush();
    const issue = await issueOf('Please stop emailing');
    await addComment(as(w.anna), issue.id, 'Looking into it.', { visibility: 'public' });
    await flush();
    const mail = smtp.messages.findLast((m) => m.to.includes('quinn@example.org'))!;
    const link = /<(.+)>/.exec(mail.headers.get('list-unsubscribe')!)![1]!;
    const url = new URL(link);
    expect(url.searchParams.get('token')).toMatch(/^request\./);
    expect((await http.request(`${url.pathname}${url.search}`, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(200);
    expect((await requestOf(as(w.anna), issue.id)).emailMuted).toBe(true);
    const sent = smtp.messages.length;
    await addComment(as(w.anna), issue.id, 'Fixed now.', { visibility: 'public' });
    await updateIssue(as(w.anna), issue.id, { fields: { State: 'Fixed' } });
    await flush();
    expect(smtp.messages.slice(sent).filter((m) => m.to.includes('quinn@example.org'))).toEqual([]);
    const tracked = await v.track(tokenIn('quinn@example.org'));
    expect(tracked.body).toMatchObject({ emailMuted: true, state: { name: 'Fixed' } });
  });

  it('shows the tracking link once when the server sends no email', async () => {
    const quiet = await createWorld({ config: { publicUrl: BASE } });
    try {
      await updateProject(quiet.adminCtx, 'WEB', { settings: { helpdesk: { enabled: true } } });
      const app = createHttpApp(quiet.app);
      const form = await app.request('/api/v1/help/WEB');
      const cookie = form.headers.get('set-cookie')!.split(';')[0]!;
      const { csrf, mail } = (await form.json()) as { csrf: string; mail: boolean };
      expect(mail).toBe(false);
      const res = await app.request('/api/v1/help/WEB/requests', {
        method: 'POST',
        headers: { cookie, origin: BASE, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Nia', email: 'nia@example.org', summary: 'No mail here', csrf }),
      });
      expect(res.status).toBe(201);
      const { tracking } = (await res.json()) as { tracking: string };
      expect(tracking).toMatch(new RegExp(`^${BASE}/request#hdt_`));
      const tracked = await app.request('/api/v1/help/requests/by-token', { headers: { 'x-tracking-token': tracking.split('#')[1] } });
      expect(((await tracked.json()) as { summary: string }).summary).toBe('No mail here');
      const rows = await quiet.app.db.select().from(comments);
      expect(rows).toEqual([]);
      expect((await quiet.app.db.select().from(notifications)).length).toBe(0);
    } finally {
      await quiet.close();
    }
  });
});
