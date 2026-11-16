/**
 * The help desk by email, and its form's proof of work (D30): reading messages as mail clients
 * write them, threading replies to their requests, setting aside mail no person wrote, the
 * provider's webhook, the shared mailbox (its client stood in for), and the captcha.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CaptchaChallenge } from '@a4a/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemCtx } from '../src/app-services';
import type { Ctx, UserRow } from '../src/context';
import { helpdeskImapState, helpdeskInbound, issues, mailOutbox, notifications, users } from '../src/db/schema';
import { OutboxWorker } from '../src/events/worker';
import { CAPTCHA_TTL_MS, captchaChallenge, checkCaptcha } from '../src/helpdesk/captcha';
import { helpdeskConsumer } from '../src/helpdesk/consumer';
import { pollMailbox, type MailboxClient } from '../src/helpdesk/imap';
import { receiveMail } from '../src/helpdesk/inbound';
import { readMail, stripReply } from '../src/helpdesk/reading';
import { createHttpApp } from '../src/http/app';
import { MailWorker } from '../src/mail/outbox';
import { notifierConsumer } from '../src/notify/notifier';
import { listIssueAttachments } from '../src/services/attachments';
import { listComments } from '../src/services/comments';
import { requestOf } from '../src/services/helpdesk';
import { deskMail, inboundLog, newMailSecret, setDeskAddress } from '../src/services/helpdesk-mail';
import { getIssue } from '../src/services/issues';
import { updateProject } from '../src/services/projects';
import { projectByKey, type ProjectRow } from '../src/services/schema-cache';
import { createWorld, type TestWorld } from './helpers';
import { fakeSmtp, type FakeSmtp } from './smtp';

const BASE = 'http://desk.test';
const DESK = 'support@desk.test';
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mail');

let w: TestWorld;
let smtp: FakeSmtp;
let http: ReturnType<typeof createHttpApp>;
let outbox: OutboxWorker;
let mailer: MailWorker;
let back: ProjectRow;

const as = (u: UserRow): Ctx => systemCtx(w.app, u, 'web');
let serial = 0;
const freshId = () => `m${Date.now().toString(36)}${++serial}`;

/** A fixture, with its {{placeholders}} filled in. */
function mail(name: string, vars: Record<string, string> = {}): Buffer {
  let text = readFileSync(path.join(FIXTURES, name), 'utf8');
  for (const [k, v] of Object.entries({ DESK, TO: DESK, ID: freshId(), IN_REPLY_TO: '', REFERENCES: '', ...vars })) text = text.replaceAll(`{{${k}}}`, v);
  return Buffer.from(text);
}

/** A short message of our own making. */
function simple(opts: { from: string; to?: string; subject: string; body: string; headers?: string[]; inReplyTo?: string }): Buffer {
  return Buffer.from(
    [
      `From: ${opts.from}`,
      `To: ${opts.to ?? DESK}`,
      `Subject: ${opts.subject}`,
      `Message-ID: <${freshId()}@example.com>`,
      ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`, `References: ${opts.inReplyTo}`] : []),
      ...(opts.headers ?? []),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      opts.body,
      '',
    ].join('\r\n'),
  );
}

async function flush() {
  await outbox.drain();
  await mailer.drain();
}

async function issueOf(summary: string) {
  const [row] = await w.app.db.select().from(issues).where(eq(issues.summary, summary));
  if (!row) throw new Error(`no issue "${summary}"`);
  return getIssue(w.adminCtx, row.id);
}

/** The newest email to this address, as the requester's client would see it. */
function newestTo(address: string) {
  const m = [...smtp.messages].reverse().find((x) => x.to.includes(address));
  if (!m) throw new Error(`nothing mailed to ${address}`);
  return { subject: m.headers.get('subject') ?? '', replyTo: m.headers.get('reply-to') ?? '', messageId: m.headers.get('message-id') ?? '', inReplyTo: m.headers.get('in-reply-to') ?? '', text: m.text };
}

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
function solve(c: CaptchaChallenge): number {
  for (let n = 0; n <= c.maxnumber; n++) if (sha256hex(`${c.salt}${n}`) === c.challenge) return n;
  throw new Error('no number makes this challenge');
}

beforeAll(async () => {
  // helpdesk.test.ts has 3539 and notifications.test.ts 2525; files run side by side.
  smtp = await fakeSmtp(3541);
  w = await createWorld({ config: { smtpUrl: smtp.url, publicUrl: BASE, mailFrom: 'a4a <a4a@desk.test>', notifyWindowMs: 60_000, trustProxy: 1, helpdeskCaptchaMaxNumber: 2000 } });
  await w.app.db.update(users).set({ email: 'anna@example.com' }).where(eq(users.id, w.anna.id));
  w.app.schema.invalidate();
  await updateProject(w.adminCtx, 'BACK', { lead: 'anna', settings: { helpdesk: { enabled: true, firstResponseHours: 4, intro: '' } } });
  await setDeskAddress(w.adminCtx, 'BACK', DESK);
  back = projectByKey(await w.app.schema.get(), 'BACK')!;
  http = createHttpApp(w.app);
  outbox = new OutboxWorker(w.app, [notifierConsumer(w.app), helpdeskConsumer(w.app)], {}, [], () => {});
  await outbox.drain();
  mailer = new MailWorker(w.app, () => new Date(Date.now() + 10 * 60_000));
});

afterAll(async () => {
  await w?.close();
  await smtp?.close();
});

describe('reading a message', () => {
  it('reads who sent a request and to whom, and its words, with and without the signature', async () => {
    const m = await readMail(mail('plain-request.eml'));
    expect(m.from).toEqual({ address: 'jane@example.com', name: 'Jane Doe' });
    expect(m.subject).toBe('Password reset email never arrives');
    expect(m.recipients).toContain(DESK);
    expect(m.htmlOnly).toBe(false);
    expect(m.text).toContain('nothing came, not even in spam');
    expect(m.text).toContain('Head of Finance');
    expect(m.reply).toBe('Hello,\n\nI asked for a password reset twice this morning and nothing came, not even in spam. My account is jane@example.com.\n\nThanks,\nJane');
    expect([m.automatic, m.failedSenderChecks]).toEqual([null, false]);
  });

  it('reads an HTML-only message as words, with none of its markup, scripts or pictures', async () => {
    const m = await readMail(mail('html-only.eml'));
    expect(m.htmlOnly).toBe(true);
    expect(m.text).toContain('names longer than 30 characters are cut off');
    expect(m.text).toContain('Open Customers');
    expect(m.text).toContain('the screenshot <https://example.org/screens/42>');
    for (const gone of ['<b>', 'alert(1)', 'color: red', 'pixel.gif']) expect(m.text).not.toContain(gone);
    expect(m.reply).not.toContain('Example Org');
  });

  it('keeps the files someone meant to send, and leaves out signatures and logos', async () => {
    const m = await readMail(mail('with-attachments.eml'));
    expect(m.text).toBe('The invoice for November opens as a blank page. The log and the invoice are attached.');
    expect(m.files.map((f) => [f.name, f.contentType])).toEqual([
      ['render.log', 'text/plain'],
      ['invoice-2026-11.pdf', 'application/pdf'],
    ]);
    expect(m.skipped).toEqual(["logo.png: a small picture in the message, such as a signature's"]);
  });

  it('reads what a reply says, above what it quotes, as Gmail and Outlook quote', async () => {
    const vars = { FROM: 'jane@example.com', IN_REPLY_TO: '<x@desk.test>', REFERENCES: '<x@desk.test>' };
    expect((await readMail(mail('gmail-reply.eml', vars))).reply).toBe('It came through now, thank you! The link worked.');
    expect((await readMail(mail('outlook-reply.eml', vars))).reply).toBe('Sorry, it stopped again this afternoon. Same account.\n\nJane');
    expect((await readMail(mail('outlook-html-reply.eml', vars))).reply).toBe('Here is the error text: SMTP 421, try later.');
    const answers = (await readMail(mail('gmail-reply.eml', { ...vars, REFERENCES: '<a@desk.test> <x@desk.test>' }))).answers;
    expect(answers).toEqual(['<x@desk.test>', '<a@desk.test>']);
  });

  it('cuts signatures, phones’ lines and trailing quotes, and keeps answers written between quotes', () => {
    expect(stripReply('Fine now.\n\n-- \nJane Doe\nExample Ltd')).toBe('Fine now.');
    expect(stripReply('Fine now.\n\nSent from my iPhone')).toBe('Fine now.');
    expect(stripReply('Fine now.\n\n> Did it work?\n> Anna')).toBe('Fine now.');
    expect(stripReply('> Which browser?\nSafari 18.\n> And the version?\n2.4.1')).toBe('> Which browser?\nSafari 18.\n> And the version?\n2.4.1');
    expect(stripReply('Am 16.11.2026 um 11:40 schrieb Anna <a4a@desk.test>:\n> alt')).toBe('');
  });

  it('names mail no person wrote', async () => {
    const vars = { FROM: 'jane@example.com', IN_REPLY_TO: '<x@desk.test>', REFERENCES: '<x@desk.test>' };
    expect((await readMail(mail('auto-reply.eml', vars))).automatic).toBe('an automatic reply');
    expect((await readMail(mail('bounce.eml'))).automatic).toBe('a delivery report (a bounce)');
    expect((await readMail(mail('list.eml'))).automatic).toBe('bulk or list mail');
    const noreply = await readMail(simple({ from: 'Shop <no-reply@shop.example>', subject: 'Your order', body: 'Shipped.' }));
    expect(noreply.automatic).toBe('from an address that takes no replies');
  });

  it("trusts only the receiving server's own word on DMARC: the topmost Authentication-Results", async () => {
    const failed = await readMail(simple({ from: 'ceo@example.com', subject: 'Urgent', body: 'Pay this.', headers: ['Authentication-Results: mx.desk.test; spf=fail; dmarc=fail header.from=example.com'] }));
    expect(failed.failedSenderChecks).toBe(true);
    const below = await readMail(
      simple({ from: 'ceo@example.com', subject: 'Urgent', body: 'Pay this.', headers: ['Authentication-Results: mx.desk.test; dmarc=pass', 'Authentication-Results: relay.example; dmarc=fail'] }),
    );
    expect(below.failedSenderChecks).toBe(false);
  });
});

describe('mail into a desk', () => {
  let ack: ReturnType<typeof newestTo>;
  let requestId = '';
  let requestUid = '';

  it('files a new request from an email, threads the answer under it, and gives that a reply address', async () => {
    const raw = mail('plain-request.eml', { ID: 'first-request' });
    const got = await receiveMail(w.app, raw, { via: 'webhook', desk: back });
    expect(got).toMatchObject({ outcome: 'request', reason: 'a new request' });
    const issue = await issueOf('Password reset email never arrives');
    requestId = issue.id;
    requestUid = issue.uid;
    expect(issue.reporter).toMatchObject({ login: 'helpdesk', isBot: true });
    expect(issue.description).toContain('nothing came, not even in spam');
    expect(issue.description).not.toContain('Head of Finance');
    expect(await requestOf(w.adminCtx, issue.id)).toMatchObject({ requester: { name: 'Jane Doe', email: 'jane@example.com' }, via: 'email' });

    await flush();
    ack = newestTo('jane@example.com');
    expect(ack.subject).toBe('Re: Password reset email never arrives');
    expect(ack.inReplyTo).toBe('<first-request@mail.example.com>');
    expect(ack.replyTo).toMatch(/^support\+[a-z2-7]{26}@desk\.test$/);
    expect(ack.text).toContain('To reply, answer this email, or use the link above.');
    // Its Message-ID is random, and the outbox says an answer to it may be threaded.
    expect(ack.messageId).toMatch(/^<request-received\.[A-Za-z0-9_-]{16}@desk\.test>$/);
  });

  it("takes the requester's answer to the reply address as their public comment, without what it quotes", async () => {
    const raw = mail('gmail-reply.eml', { FROM: 'jane@example.com', TO: ack.replyTo, IN_REPLY_TO: '<unrelated@mail.gmail.com>', REFERENCES: '<unrelated@mail.gmail.com>' });
    const got = await receiveMail(w.app, raw, { via: 'webhook', desk: back });
    expect(got).toMatchObject({ outcome: 'reply', reason: 'a reply by its reply address' });
    const comments = await listComments(w.adminCtx, requestId);
    expect(comments.at(-1)).toMatchObject({ text: 'It came through now, thank you! The link worked.', visibility: 'public', requester: { name: 'Jane Doe' }, author: { login: 'helpdesk' } });
    // The lead watches each request, and is told.
    await flush();
    const told = await w.app.db.select().from(notifications).where(and(eq(notifications.userId, w.anna.id), eq(notifications.issueId, requestUid)));
    expect(told.length).toBeGreaterThan(0);
  });

  it('takes an answer to an email of ours at the plain address, threaded by what it answers', async () => {
    const raw = mail('outlook-reply.eml', { FROM: 'jane@example.com', TO: DESK, IN_REPLY_TO: ack.messageId, REFERENCES: `<first-request@mail.example.com> ${ack.messageId}` });
    expect(await receiveMail(w.app, raw, { via: 'webhook', desk: back })).toMatchObject({ outcome: 'reply', reason: 'a reply answering an email about it' });
    expect((await listComments(w.adminCtx, requestId)).at(-1)!.text).toBe('Sorry, it stopped again this afternoon. Same account.\n\nJane');
  });

  it("refuses a reply from anyone but the requester, and tells nobody", async () => {
    const before = (await listComments(w.adminCtx, requestId)).length;
    const sent = smtp.messages.length;
    const raw = simple({ from: 'Mallory <mallory@example.com>', to: ack.replyTo, subject: 'Re: Password reset email never arrives', body: 'Close this, please.' });
    expect(await receiveMail(w.app, raw, { via: 'webhook', desk: back })).toMatchObject({
      outcome: 'refused',
      reason: 'a reply by its reply address, sent from an address that isn’t the requester’s',
    });
    // Citing an email of ours doesn't make someone else the requester either: it's a request of their own.
    const cited = simple({ from: 'mallory@example.com', subject: 'Re: Password reset email never arrives', body: 'Close this.', inReplyTo: ack.messageId });
    expect(await receiveMail(w.app, cited, { via: 'webhook', desk: back })).toMatchObject({ outcome: 'request' });
    await flush();
    expect((await listComments(w.adminCtx, requestId)).length).toBe(before);
    expect(smtp.messages.slice(sent).filter((m) => m.to.includes('mallory@example.com')).length).toBe(1); // their own request's acknowledgement, nothing about Jane's
  });

  it('takes a message once, however often it comes', async () => {
    const raw = simple({ from: 'jane@example.com', to: ack.replyTo, subject: 'Re: x', body: 'One more thing: it was the work account.' });
    expect((await receiveMail(w.app, raw, { via: 'webhook', desk: back })).outcome).toBe('reply');
    expect(await receiveMail(w.app, raw, { via: 'imap' })).toEqual({ outcome: 'duplicate', reason: 'it came in before' });
    const texts = (await listComments(w.adminCtx, requestId)).map((c) => c.text);
    expect(texts.filter((t) => t === 'One more thing: it was the work account.')).toHaveLength(1);
  });

  it('sets aside auto-replies, bounces, lists and its own mail, so nothing loops', async () => {
    const before = (await listComments(w.adminCtx, requestId)).length;
    const queued = (await w.app.db.select().from(mailOutbox)).length;
    const vars = { FROM: 'jane@example.com', TO: ack.replyTo, IN_REPLY_TO: ack.messageId, REFERENCES: ack.messageId };
    expect(await receiveMail(w.app, mail('auto-reply.eml', vars), { via: 'webhook', desk: back })).toMatchObject({ outcome: 'ignored', reason: 'an automatic reply' });
    expect(await receiveMail(w.app, mail('bounce.eml'), { via: 'webhook', desk: back })).toMatchObject({ outcome: 'ignored', reason: 'a delivery report (a bounce)' });
    expect(await receiveMail(w.app, mail('list.eml'), { via: 'webhook', desk: back })).toMatchObject({ outcome: 'ignored', reason: 'bulk or list mail' });
    const ours = simple({ from: 'a4a <a4a@desk.test>', subject: 'Re: Password reset email never arrives', body: 'anna replied.' });
    expect(await receiveMail(w.app, ours, { via: 'webhook', desk: back })).toMatchObject({ outcome: 'ignored', reason: 'sent by a4a or a help desk itself' });
    await flush();
    expect((await listComments(w.adminCtx, requestId)).length).toBe(before);
    expect((await w.app.db.select().from(mailOutbox)).length).toBe(queued);
  });

  it("refuses a message whose own server says it failed DMARC", async () => {
    const raw = simple({ from: 'jane@example.com', subject: 'Reset my password', body: 'Please.', headers: ['Authentication-Results: mx.desk.test; dmarc=fail header.from=example.com'] });
    expect(await receiveMail(w.app, raw, { via: 'webhook', desk: back })).toMatchObject({ outcome: 'refused', reason: 'its own server says it failed DMARC, so it may not be from who it says' });
  });

  it('keeps files on the request, and the original message when its words came from HTML', async () => {
    expect((await receiveMail(w.app, mail('with-attachments.eml'), { via: 'webhook', desk: back })).outcome).toBe('request');
    const invoice = await issueOf('Invoice PDF is blank');
    expect((await listIssueAttachments(w.adminCtx, invoice.id)).map((a) => [a.name, a.contentType])).toEqual([
      ['render.log', 'text/plain; charset=utf-8'],
      ['invoice-2026-11.pdf', 'application/pdf'],
    ]);
    const got = await receiveMail(w.app, mail('html-only.eml'), { via: 'webhook', desk: back });
    expect(got.outcome).toBe('request');
    const csv = await issueOf('Export to CSV cuts off long names');
    expect(csv.description).toContain('names longer than 30 characters are cut off');
    expect((await listIssueAttachments(w.adminCtx, csv.id)).map((a) => a.name)).toEqual(['original-message.eml']);
  });

  it('takes answers, but no new requests, while the desk is closed', async () => {
    await updateProject(w.adminCtx, 'BACK', { settings: { helpdesk: { enabled: false } } });
    back = projectByKey(await w.app.schema.get(), 'BACK')!;
    try {
      const fresh = simple({ from: 'sam@example.com', subject: 'Can I get a refund?', body: 'Order 1234.' });
      expect(await receiveMail(w.app, fresh, { via: 'webhook', desk: back })).toMatchObject({ outcome: 'refused', reason: 'the help desk is closed to new requests' });
      const reply = simple({ from: 'jane@example.com', to: ack.replyTo, subject: 'Re: x', body: 'Still fine, thanks.' });
      expect((await receiveMail(w.app, reply, { via: 'webhook', desk: back })).outcome).toBe('reply');
    } finally {
      await updateProject(w.adminCtx, 'BACK', { settings: { helpdesk: { enabled: true } } });
      back = projectByKey(await w.app.schema.get(), 'BACK')!;
    }
  });

  it('takes five new requests an hour from one sender', async () => {
    const outcomes: string[] = [];
    for (let i = 1; i <= 6; i++) outcomes.push((await receiveMail(w.app, simple({ from: 'busy@example.com', subject: `Question ${i}`, body: 'Hi.' }), { via: 'webhook', desk: back })).outcome);
    expect(outcomes).toEqual(['request', 'request', 'request', 'request', 'request', 'refused']);
  });

  it("logs what came in for the desk's managers, with what became of it", async () => {
    const log = await inboundLog(w.adminCtx, 'BACK');
    expect(log[0]).toMatchObject({ outcome: 'refused', reason: 'too many requests from this address in an hour', sender: 'busy@example.com', issue: null });
    const first = log.find((l) => l.subject === 'Password reset email never arrives' && l.outcome === 'request')!;
    expect(first).toMatchObject({ via: 'webhook', sender: 'jane@example.com', issue: expect.stringMatching(/^BACK-\d+$/) });
    expect(log.some((l) => l.outcome === 'ignored' && l.reason === 'a delivery report (a bounce)')).toBe(true);
    // The log is setup: its managers', not every member's.
    await expect(inboundLog(as(w.ben), 'BACK')).rejects.toMatchObject({ status: 403 });
  });
});

describe("a desk's address and webhook", () => {
  it("is set by the project's managers, one address a desk, without a + part", async () => {
    await expect(setDeskAddress(as(w.ben), 'BACK', 'help@desk.test')).rejects.toMatchObject({ status: 403 });
    await expect(setDeskAddress(w.adminCtx, 'WEB', 'support+web@desk.test')).rejects.toMatchObject({ status: 400, message: 'Leave out the “+” part: a4a adds one to each reply address' });
    await expect(setDeskAddress(w.adminCtx, 'WEB', 'SUPPORT@desk.test')).rejects.toMatchObject({ status: 409, code: 'address_taken' });
    const tooLong = `${'x'.repeat(40)}@desk.test`;
    await expect(setDeskAddress(w.adminCtx, 'WEB', tooLong)).rejects.toMatchObject({ status: 400 });
    const mailbox = await deskMail(w.adminCtx, 'BACK');
    expect(mailbox).toMatchObject({ address: DESK, replyAddress: 'support+k7q2x9…@desk.test', inbound: { url: `${BASE}/api/v1/mail/inbound/BACK`, secretPrefix: null }, imap: { configured: false } });
  });

  it('takes posts only with its secret, as HTTP Basic, and answers alike for any other', async () => {
    const made = await newMailSecret(w.adminCtx, 'BACK');
    expect(made.secret).toMatch(/^hdm_[A-Za-z0-9_-]{32}$/);
    expect(made.url).toBe(`http://a4a:${made.secret}@desk.test/api/v1/mail/inbound/BACK`);
    expect((await deskMail(w.adminCtx, 'BACK')).inbound.secretPrefix).toBe(made.secret.slice(0, 8));

    const post = async (key: string, auth: string | null, body: string | Uint8Array, type = 'message/rfc822', ip = '10.9.0.1') =>
      http.request(`/api/v1/mail/inbound/${key}`, { method: 'POST', headers: { 'content-type': type, 'x-forwarded-for': ip, ...(auth ? { authorization: auth } : {}) }, body });
    const basic = (secret: string) => `Basic ${Buffer.from(`a4a:${secret}`).toString('base64')}`;
    const raw = simple({ from: 'Ira <ira@example.com>', subject: 'The API returns 500 on /orders', body: 'Since this morning.' });

    const none = await post('BACK', null, raw);
    const wrong = await post('BACK', basic('hdm_wrong'), raw);
    const nowhere = await post('NOPE', basic(made.secret), raw);
    const noSecret = await post('WEB', basic(made.secret), raw);
    expect([none.status, wrong.status, nowhere.status, noSecret.status]).toEqual([401, 401, 401, 401]);
    expect(none.headers.get('www-authenticate')).toBe('Basic realm="a4a help desk mail"');
    const bodies = await Promise.all([none, wrong, nowhere, noSecret].map((r) => r.json()));
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);

    const ok = await post('BACK', basic(made.secret), raw);
    expect([ok.status, await ok.json()]).toEqual([200, { outcome: 'request', reason: 'a new request' }]);
    const again = await post('BACK', basic(made.secret), raw);
    expect(await again.json()).toEqual({ outcome: 'duplicate', reason: 'it came in before' });

    // As SendGrid (a form's "email") and Postmark (JSON's "RawEmail") send it.
    const form = new FormData();
    form.set('email', simple({ from: 'kim@example.com', subject: 'Login loops on Safari', body: 'Every time.' }).toString('utf8'));
    expect(await (await http.request('/api/v1/mail/inbound/BACK', { method: 'POST', headers: { authorization: basic(made.secret) }, body: form })).json()).toMatchObject({ outcome: 'request' });
    const json = JSON.stringify({ RawEmail: simple({ from: 'lou@example.com', subject: 'Webhooks arrive twice', body: 'See the log.' }).toString('utf8') });
    expect(await (await post('BACK', basic(made.secret), json, 'application/json')).json()).toMatchObject({ outcome: 'request' });

    const empty = await post('BACK', basic(made.secret), '');
    expect(empty.status).toBe(400);
    const max = w.app.config.helpdeskMailMaxBytes;
    w.app.config.helpdeskMailMaxBytes = 2048;
    try {
      const big = await post('BACK', basic(made.secret), Buffer.alloc(4 * 1024 * 1024, 'a'));
      expect(big.status).toBe(413);
      const over = await post('BACK', basic(made.secret), simple({ from: 'big@example.com', subject: 'Big', body: 'b'.repeat(4000) }));
      expect(await over.json()).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('larger than the 2 KB a help desk takes') });
    } finally {
      w.app.config.helpdeskMailMaxBytes = max;
    }
  });

  it('limits posts without the secret, per address', async () => {
    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (await http.request('/api/v1/mail/inbound/BACK', { method: 'POST', headers: { 'x-forwarded-for': '10.9.9.9', 'content-type': 'message/rfc822' }, body: 'x' })).status;
    }
    expect(last).toBe(429);
  });
});

/** A mailbox in memory, as imapflow would show it. */
function fakeMailbox(validity = 7) {
  const box = {
    validity,
    messages: new Map<number, { raw: Buffer; size?: number }>(),
    seen: new Set<number>(),
    fetched: [] as number[],
    failOnce: new Set<number>(),
    closed: 0,
  };
  const client: MailboxClient = {
    open: async () => box.validity,
    uidsAfter: async (uid) => [...box.messages.keys()].filter((u) => u > uid).sort((a, b) => a - b),
    newest: async () => Math.max(0, ...box.messages.keys()),
    size: async (uid) => box.messages.get(uid)!.size ?? box.messages.get(uid)!.raw.length,
    source: async (uid) => {
      if (box.failOnce.delete(uid)) throw new Error('connection reset');
      box.fetched.push(uid);
      return box.messages.get(uid)!.raw;
    },
    markSeen: async (uid) => void box.seen.add(uid),
    close: async () => void box.closed++,
  };
  return { box, client };
}

describe('the shared mailbox', () => {
  it('starts after what was there before, then reads what comes, to the desk it was sent to', async () => {
    const { box, client } = fakeMailbox();
    box.messages.set(1, { raw: simple({ from: 'old@example.com', subject: 'An old question', body: 'From last year.' }) });
    box.messages.set(2, { raw: simple({ from: 'old@example.com', subject: 'Another old one', body: 'Also old.' }) });
    expect(await pollMailbox(w.app, client, 'mbox-a')).toEqual({ read: 0, outcomes: {} });
    expect((await w.app.db.select().from(helpdeskImapState).where(eq(helpdeskImapState.mailbox, 'mbox-a')))[0]).toMatchObject({ uidValidity: 7, lastUid: 2 });

    box.messages.set(3, { raw: simple({ from: 'Noor <noor@example.com>', subject: 'Charts are empty on the dashboard', body: 'Since the update.' }) });
    box.messages.set(4, { raw: simple({ from: 'x@example.com', to: 'sales@elsewhere.test', subject: 'Not for a desk', body: 'Hi.' }) });
    box.messages.set(5, { raw: simple({ from: 'y@example.com', subject: 'Huge', body: 'y' }), size: w.app.config.helpdeskMailMaxBytes + 1 });
    const got = await pollMailbox(w.app, client, 'mbox-a');
    expect(got).toEqual({ read: 3, outcomes: { request: 1, ignored: 1, refused: 1 } });
    expect(box.fetched).toEqual([3, 4]); // the huge one isn't downloaded
    expect([...box.seen].sort()).toEqual([3, 4, 5]);
    expect((await issueOf('Charts are empty on the dashboard')).project.key).toBe('BACK');
    const [unrouted] = await w.app.db.select().from(helpdeskInbound).where(eq(helpdeskInbound.subject, 'Not for a desk'));
    expect(unrouted).toMatchObject({ projectId: null, outcome: 'ignored', reason: 'it was not sent to any help desk’s address', via: 'imap' });
  });

  it("stops at a failure of its own, and tries that message again next time", async () => {
    const { box, client } = fakeMailbox();
    await pollMailbox(w.app, client, 'mbox-b');
    box.messages.set(1, { raw: simple({ from: 'pat@example.com', subject: 'Search ignores accents', body: 'café vs cafe' }) });
    box.messages.set(2, { raw: simple({ from: 'pat@example.com', subject: 'Search ignores umlauts', body: 'Müller vs Muller' }) });
    box.failOnce.add(1);
    await expect(pollMailbox(w.app, client, 'mbox-b')).rejects.toThrow('connection reset');
    expect((await w.app.db.select().from(helpdeskImapState).where(eq(helpdeskImapState.mailbox, 'mbox-b')))[0]!.lastUid).toBe(0);
    expect(await pollMailbox(w.app, client, 'mbox-b')).toMatchObject({ read: 2, outcomes: { request: 2 } });
    expect(box.closed).toBe(3); // closed every time, failure or not
  });

  it('reads nothing once the lease is gone, and starts again after a renumbering', async () => {
    const { box, client } = fakeMailbox();
    await pollMailbox(w.app, client, 'mbox-c');
    box.messages.set(1, { raw: simple({ from: 'q@example.com', subject: 'Not read yet', body: '.' }) });
    expect(await pollMailbox(w.app, client, 'mbox-c', { stillHolder: () => false })).toEqual({ read: 0, outcomes: {} });
    box.validity = 8;
    expect(await pollMailbox(w.app, client, 'mbox-c')).toEqual({ read: 0, outcomes: {} });
    expect((await w.app.db.select().from(helpdeskImapState).where(eq(helpdeskImapState.mailbox, 'mbox-c')))[0]).toMatchObject({ uidValidity: 8, lastUid: 1 });
  });
});

describe("the form's proof of work", () => {
  it('takes a right answer once, for its desk, while it is good', async () => {
    const c = await captchaChallenge(w.app, 'BACK');
    expect(c).toMatchObject({ algorithm: 'SHA-256', maxnumber: 2000 });
    const answer = { salt: c.salt, challenge: c.challenge, signature: c.signature, number: solve(c) };
    expect(await checkCaptcha(w.app, 'WEB', answer)).toBe('wrong');
    expect(await checkCaptcha(w.app, 'BACK', { ...answer, number: answer.number + 1 })).toBe('wrong');
    expect(await checkCaptcha(w.app, 'BACK', { ...answer, signature: `${answer.signature.slice(0, -2)}xx` })).toBe('wrong');
    expect(await checkCaptcha(w.app, 'BACK', answer, Date.now() + CAPTCHA_TTL_MS + 5_000)).toBe('expired');
    expect(await checkCaptcha(w.app, 'BACK', answer)).toBe('ok');
    expect(await checkCaptcha(w.app, 'BACK', answer)).toBe('used');
    // A salt changed to last longer no longer makes the signed challenge.
    const later = answer.salt.replace(/expires=\d+/, 'expires=9999999999');
    expect(await checkCaptcha(w.app, 'BACK', { ...answer, salt: later })).toBe('wrong');
  });

  it('is asked of the form when the desk turns it on', async () => {
    await updateProject(w.adminCtx, 'BACK', { settings: { helpdesk: { captcha: true } } });
    let cookie = '';
    const req = async (method: string, p: string, body?: unknown) => {
      const headers: Record<string, string> = { 'x-forwarded-for': '10.7.0.1', origin: BASE };
      if (cookie) headers.cookie = cookie;
      if (body) headers['content-type'] = 'application/json';
      const res = await http.request(`/api/v1${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0]!;
      return { status: res.status, body: (await res.json()) as any };
    };
    const form = await req('GET', '/help/BACK');
    expect(form.body.captcha).toMatchObject({ algorithm: 'SHA-256', maxnumber: 2000 });
    expect(form.body.email).toBe(DESK);
    const fields = { name: 'Rae', email: 'rae@example.com', summary: 'Two-factor codes arrive late', description: '', csrf: form.body.csrf };
    expect(await req('POST', '/help/BACK/requests', fields)).toMatchObject({ status: 400, body: { error: { code: 'captcha_failed' } } });
    const c = form.body.captcha as CaptchaChallenge;
    const captcha = { salt: c.salt, challenge: c.challenge, signature: c.signature, number: solve(c) };
    expect((await req('POST', '/help/BACK/requests', { ...fields, captcha })).status).toBe(201);
    expect(await req('POST', '/help/BACK/requests', { ...fields, summary: 'Again', captcha })).toMatchObject({ status: 400, body: { error: { code: 'captcha_failed' } } });
    await updateProject(w.adminCtx, 'BACK', { settings: { helpdesk: { captcha: false } } });
  });
});
