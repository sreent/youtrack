/**
 * The team replying to a notification email (D45): a reply address per email and person; the
 * comment is theirs, from their address only; internal on a request unless what they answered was
 * public, or they say #public; refused, without a word, for a stolen token, a forged sender, or an
 * issue they can't see now.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { comments, notificationSettings, users } from '../src/db/schema';
import { OutboxWorker } from '../src/events/worker';
import { helpdeskConsumer } from '../src/helpdesk/consumer';
import { receiveMail } from '../src/helpdesk/inbound';
import { MailWorker } from '../src/mail/outbox';
import { notifierConsumer } from '../src/notify/notifier';
import { addComment } from '../src/services/comments';
import { openRequest, postRequesterReply, requestWithRequester } from '../src/services/helpdesk';
import { createIssue, getIssue, setIssueVisibility, updateIssue } from '../src/services/issues';
import { updateProject } from '../src/services/projects';
import { createWorld, type TestWorld } from './helpers';
import { fakeSmtp, type FakeSmtp } from './smtp';

let w: TestWorld;
let smtp: FakeSmtp;
let outbox: OutboxWorker;
let mailer: MailWorker;

async function flush() {
  await outbox.drain();
  await mailer.drain();
}

/** The Reply-To of the newest notification email to this address about this issue. */
function replyToFor(to: string, issueId: string): string {
  const mail = [...smtp.messages].reverse().find((m) => m.to.includes(to) && m.headers.get('subject')?.startsWith(`${issueId}:`));
  const reply = mail?.headers.get('reply-to');
  if (!reply) throw new Error(`no reply address mailed to ${to} about ${issueId}`);
  return /<([^>]+)>/.exec(reply)?.[1] ?? reply.trim();
}

function reply(opts: { from: string; to: string; body: string; headers?: string[] }) {
  return Buffer.from(
    [
      `From: ${opts.from}`,
      `To: ${opts.to}`,
      'Subject: Re: about the issue',
      `Message-ID: <${randomUUID()}@mail.example.com>`,
      ...(opts.headers ?? []),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      opts.body,
      '',
      'On Mon, 23 Nov 2026 at 10:00, a4a <a4a@team.test> wrote:',
      '> What was said before.',
      '',
    ].join('\r\n'),
  );
}

beforeAll(async () => {
  smtp = await fakeSmtp();
  w = await createWorld({ config: { smtpUrl: smtp.url, publicUrl: 'http://team.test', notifyWindowMs: 60_000, mailReplyAddress: 'replies@team.test' } });
  await w.app.db.update(users).set({ email: 'anna@team.test' }).where(eq(users.id, w.anna.id));
  await w.app.db.update(users).set({ email: 'ben@team.test' }).where(eq(users.id, w.ben.id));
  await w.app.db.insert(notificationSettings).values({ userId: w.anna.id, email: 'all' });
  w.app.schema.invalidate();
  await updateProject(w.adminCtx, 'BACK', { lead: 'anna', settings: { helpdesk: { enabled: true } } });
  outbox = new OutboxWorker(w.app, [notifierConsumer(w.app), helpdeskConsumer(w.app)], {}, [], () => {});
  await outbox.drain();
  mailer = new MailWorker(w.app, () => new Date(Date.now() + 10 * 60_000));
});

afterAll(async () => {
  await w?.close();
  await smtp?.close();
});

const commentsOf = async (uid: string) => w.app.db.select().from(comments).where(eq(comments.issueId, uid));

describe('replying to a notification email', () => {
  it('adds a comment by its person, cut from what it quoted', async () => {
    const issue = await createIssue(w.as(w.ben), { project: 'BACK', summary: 'Queue backs up at night', fields: { Assignee: 'anna' } });
    await addComment(w.as(w.ben), issue.id, 'It happened again at 3am.');
    await flush();
    const to = replyToFor('anna@team.test', issue.id);
    expect(to).toMatch(/^replies\+[a-z2-7]{26}@team\.test$/);
    const res = await receiveMail(w.app, reply({ from: 'Anna <anna@team.test>', to, body: 'I will look at the cron job.' }), { via: 'imap' });
    expect(res).toMatchObject({ outcome: 'reply', reason: 'an internal comment by email' });
    const uid = (await getIssue(w.adminCtx, issue.id)).uid;
    const mine = (await commentsOf(uid)).find((c) => c.authorId === w.anna.id)!;
    expect(mine).toMatchObject({ text: 'I will look at the cron job.', channel: 'email', visibility: 'internal' });
  });

  it('refuses a stolen token, a forged sender, and an issue its person can no longer see', async () => {
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Disk fills up', fields: { Assignee: 'ben' } });
    await addComment(w.as(w.anna), issue.id, 'Down to 2%.');
    await flush();
    const to = replyToFor('ben@team.test', issue.id);
    // Anna has Ben's reply address: her mail isn't his.
    expect(await receiveMail(w.app, reply({ from: 'anna@team.test', to, body: 'Speaking for Ben.' }), { via: 'imap' })).toMatchObject({ outcome: 'refused' });
    expect(await receiveMail(w.app, reply({ from: 'ben@team.test', to: 'replies+aaaaaaaaaaaaaaaaaaaaaaaaaa@team.test', body: 'Guessed.' }), { via: 'imap' })).toMatchObject({ outcome: 'refused' });
    expect(
      await receiveMail(w.app, reply({ from: 'ben@team.test', to, body: 'Forged.', headers: ['Authentication-Results: mx.team.test; dmarc=fail header.from=team.test'] }), { via: 'imap' }),
    ).toMatchObject({ outcome: 'refused' });
    // Limited to Anna since: Ben's reply is refused, and nothing says why to anyone.
    await updateIssue(w.as(w.anna), issue.id, { fields: { Assignee: null } });
    await setIssueVisibility(w.as(w.anna), issue.id, { visibleTo: { users: ['anna'], groups: [] } });
    const before = smtp.messages.length;
    expect(await receiveMail(w.app, reply({ from: 'ben@team.test', to, body: 'Still here?' }), { via: 'imap' })).toMatchObject({ outcome: 'refused', reason: 'about an issue its person can’t see now' });
    await flush();
    expect(smtp.messages.slice(before).filter((m) => m.to.includes('ben@team.test'))).toEqual([]);
    const uid = (await getIssue(w.adminCtx, issue.id)).uid;
    expect((await commentsOf(uid)).filter((c) => c.authorId === w.ben.id)).toEqual([]);
  });

  it('answers the requester when what it replied to was public, and keeps a note internal otherwise', async () => {
    const desk = (await w.app.schema.get()).projectsByKey.get('BACK')!;
    const req = await openRequest(w.app, desk, { name: 'Rita', email: 'rita@example.org', summary: 'Refund please', description: 'Order 42.', via: 'form' });
    const uid = (await getIssue(w.adminCtx, req.id)).uid;
    const { issue: row, requester } = (await requestWithRequester(w.app.db, uid))!;
    // The requester writes: Anna, the desk's lead, is told by email, and answers it.
    await postRequesterReply(w.app, row, { id: requester.id, name: requester.name }, 'Any news?', 'page');
    await flush();
    let to = replyToFor('anna@team.test', req.id);
    expect(await receiveMail(w.app, reply({ from: 'anna@team.test', to, body: 'Refunded today, Rita.' }), { via: 'imap' })).toMatchObject({ outcome: 'reply', reason: 'a public reply by email' });
    // An internal note answered stays internal, unless she says #public.
    await addComment(w.as(w.ben), req.id, 'Internal: finance confirmed.');
    await flush();
    to = replyToFor('anna@team.test', req.id);
    expect(await receiveMail(w.app, reply({ from: 'anna@team.test', to, body: 'Thanks Ben.' }), { via: 'imap' })).toMatchObject({ reason: 'an internal comment by email' });
    expect(await receiveMail(w.app, reply({ from: 'anna@team.test', to, body: '#public\nIt should reach you in three days.' }), { via: 'imap' })).toMatchObject({ reason: 'a public reply by email' });
    const byAnna = (await commentsOf(uid)).filter((c) => c.authorId === w.anna.id).map((c) => [c.visibility, c.text]);
    expect(byAnna).toEqual([
      ['public', 'Refunded today, Rita.'],
      ['internal', 'Thanks Ben.'],
      ['public', 'It should reach you in three days.'],
    ]);
  });
});
