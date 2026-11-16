/**
 * More than one email per person (D33): a link a4a mails confirms one, only for the person who
 * asked, once, within a day; an administrator may confirm one instead; a confirmed email is one
 * person's; and a commit under any confirmed email is its person's.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx, UserRow } from '../src/context';
import { emailConfirmations, mailOutbox, users } from '../src/db/schema';
import { createHttpApp } from '../src/http/app';
import type { AppError } from '../src/lib/errors';
import { MailWorker } from '../src/mail/outbox';
import { issueTokenFor } from '../src/services/auth';
import { addEmailFor, addMyEmail, confirmEmail, emailLink, makePrimary, personEmails, removeEmailFor, removeMyEmail, sendEmailLink } from '../src/services/emails';
import { createIssue } from '../src/services/issues';
import { insertUser, updateMe, updateUser } from '../src/services/users';
import { createIntegration } from '../src/vcs/integrations';
import { issueVcs } from '../src/vcs/links';
import { createWorld, type TestWorld } from './helpers';
import { fakeSmtp, type FakeSmtp } from './smtp';

let smtp: FakeSmtp;
let w: TestWorld;
let mailer: MailWorker;
let http: ReturnType<typeof createHttpApp>;
let hook: { id: string; secret: string };

const failure = async (p: Promise<unknown>): Promise<AppError> => {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected a refusal');
};

/** The link in the last mail a4a sent to `to`. */
async function linkTo(to: string): Promise<string> {
  await mailer.drain();
  const mail = [...smtp.messages].reverse().find((m) => m.to.includes(to));
  if (!mail) throw new Error(`no mail to ${to}`);
  const m = /\/emails\/confirm\?token=([A-Za-z0-9_-]+)/.exec(mail.text);
  if (!m) throw new Error('no link in the mail');
  return m[1]!;
}

const fresh = async (u: UserRow) => (await w.app.db.select().from(users).where(eq(users.id, u.id)))[0]!;
const as = (u: UserRow) => w.as(u);

/** A commit by `email` giving BACK-n a command, pushed through the GitHub integration. */
async function pushAs(email: string, issue: string, command: string) {
  const body = JSON.stringify({
    ref: 'refs/heads/main',
    repository: { full_name: 'acme/mail' },
    commits: [{ id: randomUUID().replace(/-/g, '').padEnd(40, '0'), message: `Work on it\n\n${issue} #${command}`, author: { name: 'Someone', email } }],
  });
  const res = await http.request(`/api/v1/vcs/hooks/${hook.id}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'push',
      'x-github-delivery': randomUUID(),
      'x-hub-signature-256': `sha256=${createHmac('sha256', hook.secret).update(body).digest('hex')}`,
    },
    body,
  });
  expect(res.status).toBe(200);
  return (await issueVcs(w.adminCtx, issue)).commits[0]!;
}

beforeAll(async () => {
  smtp = await fakeSmtp(0);
  w = await createWorld({ config: { smtpUrl: smtp.url, publicUrl: 'http://a4a.test' } });
  http = createHttpApp(w.app);
  await updateUser(w.adminCtx, 'anna', { email: 'anna@example.com' }); // an administrator's: confirmed
  await updateMe(w.as(w.ben), { email: 'ben@example.com' }); // his own: not yet
  w.anna = await fresh(w.anna);
  w.ben = await fresh(w.ben);
  for (const summary of ['One', 'Two', 'Three', 'Four']) await createIssue(w.as(w.anna), { project: 'BACK', summary });
  const gh = await createIntegration(w.adminCtx, { provider: 'github', name: 'acme/mail', projects: ['BACK'] });
  hook = { id: gh.id, secret: gh.secret };
  mailer = new MailWorker(w.app);
});

afterAll(async () => {
  await w?.close();
  await smtp?.close();
});

describe('a link to confirm an email', () => {
  it('goes to an email a person adds, and confirms it for them alone, once', async () => {
    const added = await addMyEmail(as(w.anna), 'anna.s@personal.example');
    expect(added.canSendLinks).toBe(true);
    expect(added.emails).toMatchObject([
      { id: null, email: 'anna@example.com', primary: true, confirmed: true, linkSentAt: null },
      { email: 'anna.s@personal.example', primary: false, confirmed: false, confirmedBy: null },
    ]);
    expect(added.emails[1]!.linkSentAt).not.toBeNull();

    const token = await linkTo('anna.s@personal.example');
    const mail = smtp.messages.find((m) => m.to.includes('anna.s@personal.example'))!;
    expect(mail.headers.get('subject')).toBe('Confirm your email for a4a');
    expect(mail.headers.get('auto-submitted')).toBe('auto-generated');
    expect(mail.text).toContain('Anna Schmidt (anna) added this email to their account in a4a.');
    expect(mail.text).toContain(`Confirm it: http://a4a.test/emails/confirm?token=${token}`);
    // Only its hash is kept.
    const kept = await w.app.db.select().from(emailConfirmations);
    expect(kept.map((k) => k.tokenHash)).not.toContain(token);
    expect(JSON.stringify(await w.app.db.select().from(mailOutbox))).not.toContain(token);

    expect(await emailLink(as(w.anna), token)).toEqual({ email: 'anna.s@personal.example', confirmed: false });
    // Someone else holding the link can't use it, nor learn whose it is.
    const other = await failure(confirmEmail(as(w.ben), token));
    expect([other.status, other.message]).toEqual([403, 'This link is for another account in a4a']);

    expect(await confirmEmail(as(w.anna), token)).toEqual({ email: 'anna.s@personal.example', confirmed: true });
    expect((await personEmails(as(w.anna), 'anna')).emails[1]).toMatchObject({ confirmed: true, confirmedBy: { login: 'anna' }, linkSentAt: null });
    const spent = await failure(confirmEmail(as(w.anna), token));
    expect([spent.status, spent.message]).toEqual([404, 'This link isn’t valid']);
  });

  it('makes a commit under the confirmed email its person’s; removed, the email no longer does', async () => {
    const commit = await pushAs('anna.s@personal.example', 'BACK-1', 'In Progress');
    expect(commit).toMatchObject({ applied: true, author: { user: { login: 'anna' } } });

    const id = (await personEmails(as(w.anna), 'anna')).emails.find((e) => e.email === 'anna.s@personal.example')!.id!;
    await removeMyEmail(as(w.anna), id);
    expect((await pushAs('anna.s@personal.example', 'BACK-2', 'In Progress')).note).toBe('Not applied: a4a doesn’t know who wrote it');
  });

  it('confirms a primary email too, so a person can vouch for the one they typed themselves', async () => {
    expect((await pushAs('ben@example.com', 'BACK-3', 'In Progress')).note).toBe('Not applied: Ben Okafor’s email isn’t confirmed yet');
    await sendEmailLink(as(w.ben), 'ben@example.com');
    const token = await linkTo('ben@example.com');
    expect(await confirmEmail(as(w.ben), token)).toEqual({ email: 'ben@example.com', confirmed: true });
    expect((await fresh(w.ben)).emailVerified).toBe(true);
    expect(await pushAs('ben@example.com', 'BACK-3', 'In Progress')).toMatchObject({ applied: true, author: { user: { login: 'ben' } } });
  });

  it('says why a link no longer works: expired, or a new one asked for too soon', async () => {
    await addMyEmail(as(w.ben), 'ben@home.example');
    const token = await linkTo('ben@home.example');
    await w.app.db.update(emailConfirmations).set({ expiresAt: new Date(Date.now() - 1000) });
    const expired = await failure(emailLink(as(w.ben), token));
    expect([expired.status, expired.hint]).toEqual([404, 'It works once, for 24 hours: send a new one from your profile.']);
    const soon = await failure(sendEmailLink(as(w.ben), 'ben@home.example'));
    expect([soon.status, soon.message]).toEqual([429, 'A link went to it a moment ago']);
  });

  it('goes at most five times an hour for one person', async () => {
    const chloe = await insertUser(w.app.db, { login: 'chloe', name: 'Chloé Martin', email: 'chloe@example.com', emailVerified: true });
    w.app.schema.invalidate();
    for (let i = 1; i <= 5; i++) await addMyEmail(as(chloe), `chloe${i}@example.org`);
    const sixth = await failure(addMyEmail(as(chloe), 'chloe6@example.org'));
    expect([sixth.status, sixth.message]).toEqual([429, 'a4a has sent you enough links for now']);
    // Refused, it wasn't added either.
    expect((await personEmails(as(chloe), 'chloe')).emails.map((e) => e.email)).not.toContain('chloe6@example.org');
  });

  it('is not sent when the email was confirmed or removed before it went', async () => {
    const dana = await insertUser(w.app.db, { login: 'dana', name: 'Dana Reyes', email: 'dana@example.com', emailVerified: true });
    w.app.schema.invalidate();
    await addMyEmail(as(dana), 'dana@side.example');
    await addEmailFor(w.adminCtx, 'dana', 'dana@side.example');
    const before = smtp.messages.length;
    await mailer.drain();
    expect(smtp.messages.slice(before).filter((m) => m.to.includes('dana@side.example'))).toEqual([]);
  });
});

describe('which emails are whose', () => {
  it('makes a confirmed email the primary one, and keeps the old one, confirmed', async () => {
    await addEmailFor(w.adminCtx, 'anna', 'anna@new.example');
    const unconfirmed = await addMyEmail(as(w.anna), 'anna@later.example');
    expect(unconfirmed.emails.find((e) => e.email === 'anna@later.example')).toMatchObject({ confirmed: false });
    const notYet = await failure(makePrimary(as(w.anna), 'anna@later.example'));
    expect([notYet.status, notYet.message]).toEqual([400, 'Confirm it first']);

    const after = await makePrimary(as(w.anna), 'anna@new.example');
    expect(after.emails[0]).toMatchObject({ email: 'anna@new.example', primary: true, confirmed: true });
    expect(after.emails.find((e) => e.email === 'anna@example.com')).toMatchObject({ primary: false, confirmed: true });
    expect(await fresh(w.anna)).toMatchObject({ email: 'anna@new.example', emailVerified: true });
    // Both still name her in a commit.
    expect((await pushAs('anna@example.com', 'BACK-4', 'In Progress')).author.user?.login).toBe('anna');
  });

  it('keeps a confirmed email one person’s', async () => {
    const admin = await failure(addEmailFor(w.adminCtx, 'ben', 'anna@new.example'));
    expect([admin.status, admin.message]).toEqual([409, 'Anna Schmidt has this email confirmed already']);

    // Two people may claim one email, and a link goes for each; once one confirms it, the other's can't.
    await addMyEmail(as(w.ben), 'shared@example.org');
    const bens = await linkTo('shared@example.org');
    await addMyEmail(as(w.anna), 'shared@example.org');
    const annas = await linkTo('shared@example.org');
    expect(annas).not.toBe(bens);
    expect(await confirmEmail(as(w.anna), annas)).toEqual({ email: 'shared@example.org', confirmed: true });
    const late = await failure(confirmEmail(as(w.ben), bens));
    expect([late.status, late.message, late.hint]).toEqual([409, 'This email is confirmed for someone else in a4a', 'An administrator can move it to you.']);
    // A commit under it is Anna's alone.
    expect((await pushAs('shared@example.org', 'BACK-4', 'Open')).author.user?.login).toBe('anna');
  });

  it('is changed signed in, never with a token, and administrators change anyone’s', async () => {
    const asToken: Ctx = { ...as(w.ben), actor: { ...as(w.ben).actor, authMethod: 'token', tokenId: 't', tokenName: 'script' } };
    const token = await failure(addMyEmail(asToken, 'ben@script.example'));
    expect([token.status, token.message]).toEqual([403, 'Your emails are changed signed in, not with a token']);
    const someoneElse = await failure(personEmails(as(w.ben), 'anna'));
    expect(someoneElse.status).toBe(403);
    const remove = await failure(removeEmailFor(as(w.ben), 'anna', 'x'));
    expect(remove.status).toBe(403);

    // Over HTTP: a token reads its person's emails, and can't add one.
    const issued = await issueTokenFor(w.app.db, w.ben.id, { name: 'script', scopes: ['read', 'write'] });
    const auth = { authorization: `Bearer ${issued.token}`, 'content-type': 'application/json' };
    expect((await http.request('/api/v1/me/emails', { headers: auth })).status).toBe(200);
    const res = await http.request('/api/v1/me/emails', { method: 'POST', headers: auth, body: JSON.stringify({ email: 'ben@script.example' }) });
    expect(res.status).toBe(403);
    expect((await http.request('/api/v1/me/emails')).status).toBe(401);
  });
});

describe('without email set up', () => {
  it('adds an email unconfirmed, sends no link, and leaves confirming to an administrator', async () => {
    const quiet = await createWorld();
    try {
      // Her first email is her primary one.
      const added = await addMyEmail(quiet.as(quiet.anna), 'anna@quiet.example');
      expect(added).toMatchObject({ canSendLinks: false, emails: [{ id: null, email: 'anna@quiet.example', primary: true, confirmed: false, linkSentAt: null }] });
      const other = await addMyEmail(quiet.as(quiet.anna), 'anna@side.example');
      expect(other.emails[1]).toMatchObject({ email: 'anna@side.example', primary: false, confirmed: false, linkSentAt: null });
      const send = await failure(sendEmailLink(quiet.as(quiet.anna), 'anna@side.example'));
      expect([send.status, send.message]).toEqual([400, 'a4a can’t send email here']);
      await addEmailFor(quiet.adminCtx, 'anna', 'anna@quiet.example');
      const confirmed = await addEmailFor(quiet.adminCtx, 'anna', 'anna@side.example');
      expect(confirmed.emails).toMatchObject([
        { email: 'anna@quiet.example', primary: true, confirmed: true },
        { email: 'anna@side.example', confirmed: true, confirmedBy: { login: 'admin' } },
      ]);
    } finally {
      await quiet.close();
    }
  });
});
