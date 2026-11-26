/**
 * CCs in depth (D67): the requester taking people off on the portal, and a colleague or someone copied
 * refused; a desk's own cap at the email's, the team's and the portal's door; Authentication-Results
 * read as RFC 8601 writes it, and trusted only from a named server's topmost header; everyone on a
 * request hearing each other where the desk relays, only words a4a can trust, within limits, never a
 * file; a new request's Cc held until its requester confirms it, by a link (once, for a few days) or
 * on the portal; the SLA unchanged; and a CC taken off missing.
 */
import { CC_RELAY_LIMITS, REQUEST_CCS_MAX } from '@a4a/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { systemCtx } from '../src/app-services';
import type { Ctx, UserRow } from '../src/context';
import { helpdeskInbound, helpdeskMailboxes, helpThrottle, issues, requestCcConfirmations, requestCcHolds, requestCcs, requesters, users } from '../src/db/schema';
import { OutboxWorker } from '../src/events/worker';
import { helpdeskConsumer } from '../src/helpdesk/consumer';
import { receiveMail } from '../src/helpdesk/inbound';
import { relayConsumer } from '../src/helpdesk/relay';
import { parseAuthResults, senderTrust } from '../src/helpdesk/trust';
import { createHttpApp } from '../src/http/app';
import { sha256 } from '../src/lib/crypto';
import { MailWorker } from '../src/mail/outbox';
import { notifierConsumer } from '../src/notify/notifier';
import { issueActivity } from '../src/services/activity';
import { addComment, listComments } from '../src/services/comments';
import { createCustomerGroup, requesterByEmail } from '../src/services/customer-groups';
import { helpHit } from '../src/services/help-throttle';
import { replyToRequest, requestOf } from '../src/services/helpdesk';
import { newMailSecret, setDeskAddress } from '../src/services/helpdesk-mail';
import { applyUnsubscribe } from '../src/services/notifications';
import { portalReply, portalRequest, portalSettleHeld, portalUncopy } from '../src/services/portal';
import { startPortalSession } from '../src/services/portal-sign-in';
import { updateProject } from '../src/services/projects';
import { addCc, ccConfirmation, listCcs, useCcConfirmation } from '../src/services/request-ccs';
import { projectByKey, type ProjectRow } from '../src/services/schema-cache';
import { createWorld, type TestWorld } from './helpers';
import { fakeSmtp, type FakeSmtp } from './smtp';

const BASE = 'http://desk.test';
const DESK = 'support@desk.test';
const TRUSTED = 'mx.desk.test';

let w: TestWorld;
let smtp: FakeSmtp;
let http: ReturnType<typeof createHttpApp>;
let outbox: OutboxWorker;
let mailer: MailWorker;
let back: ProjectRow;
let serial = 0;

const as = (u: UserRow): Ctx => systemCtx(w.app, u, 'web');
const viewer = <R extends object>(r: R) => ({ ...r, signedIn: { method: 'link' as const, providerId: null } });

/** A plain email; `trusted` adds the named server's DMARC pass for its sender's domain, as that server would. */
function message(opts: { from: string; to?: string; cc?: string; subject: string; body: string; trusted?: boolean; headers?: string[]; inReplyTo?: string; file?: boolean }): Buffer {
  const domain = (/@([^>\s]+)>?\s*$/.exec(opts.from)?.[1] ?? '').toLowerCase();
  const head = [
    ...(opts.trusted ? [`Authentication-Results: ${TRUSTED}; dkim=pass header.d=${domain}; dmarc=pass (p=reject) header.from=${domain}`] : []),
    ...(opts.headers ?? []),
    `From: ${opts.from}`,
    `To: ${opts.to ?? DESK}`,
    ...(opts.cc ? [`Cc: ${opts.cc}`] : []),
    `Subject: ${opts.subject}`,
    `Message-ID: <depth${Date.now().toString(36)}${++serial}@mail.example.com>`,
    ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`] : []),
    'MIME-Version: 1.0',
  ];
  if (!opts.file) return Buffer.from([...head, 'Content-Type: text/plain; charset=utf-8', '', opts.body, ''].join('\r\n'));
  return Buffer.from(
    [
      ...head,
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain; charset=utf-8',
      '',
      opts.body,
      '--b1',
      'Content-Type: text/plain; name="log.txt"',
      'Content-Disposition: attachment; filename="log.txt"',
      '',
      'the printer log',
      '--b1--',
      '',
    ].join('\r\n'),
  );
}

/** Posted to the desk's webhook, as its provider posts it: the desk as it is now, its settings changed by a test included. */
const mailIn = async (raw: Buffer) => receiveMail(w.app, raw, { via: 'webhook', desk: (back = projectByKey(await w.app.schema.get(), 'BACK')!) });
async function flush() {
  await outbox.drain();
  await mailer.drain();
}
const mailsTo = (address: string) => smtp.messages.filter((m) => m.to.includes(address));
const newestTo = (address: string) => {
  const m = mailsTo(address).at(-1);
  if (!m) throw new Error(`nothing mailed to ${address}`);
  return m;
};
/** The reply address in the newest email to someone about the request with this summary. */
async function replyTo(address: string, summary: string): Promise<string> {
  await flush();
  const m = mailsTo(address).filter((x) => (x.headers.get('subject') ?? '').includes(summary)).at(-1);
  if (!m) throw new Error(`nothing mailed to ${address} about ${summary}`);
  return m.headers.get('reply-to')!;
}
async function issueOf(summary: string) {
  const [row] = await w.app.db.select().from(issues).where(eq(issues.summary, summary));
  if (!row) throw new Error(`no issue "${summary}"`);
  return { row, id: `BACK-${row.number}` };
}
const requester = async (email: string) => viewer((await w.app.db.select().from(requesters).where(eq(requesters.email, email)))[0]!);
const deskSettings = (helpdesk: Record<string, unknown>) => updateProject(w.adminCtx, 'BACK', { settings: { helpdesk } });

/** A call to the portal's API as a requester signed in, from the portal's own page. */
async function portalApi(method: string, path: string, requesterId: string, body?: unknown) {
  const session = await startPortalSession(w.app.db, requesterId, { method: 'link', providerId: null }, 3_600_000);
  const headers: Record<string, string> = { cookie: `a4a_portal=${session}`, origin: BASE };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await http.request(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  smtp = await fakeSmtp();
  w = await createWorld({ config: { smtpUrl: smtp.url, publicUrl: BASE, mailFrom: 'a4a <a4a@desk.test>', notifyWindowMs: 60_000, trustProxy: 1, helpdeskTrustedAuthservIds: [TRUSTED] } });
  await w.app.db.update(users).set({ email: 'anna@example.com' }).where(eq(users.id, w.anna.id));
  w.app.schema.invalidate();
  await updateProject(w.adminCtx, 'BACK', { lead: 'anna', settings: { helpdesk: { enabled: true, firstResponseHours: 4, intro: '' } } });
  await setDeskAddress(w.adminCtx, 'BACK', DESK);
  await newMailSecret(w.adminCtx, 'BACK');
  back = projectByKey(await w.app.schema.get(), 'BACK')!;
  http = createHttpApp(w.app);
  outbox = new OutboxWorker(w.app, [notifierConsumer(w.app), helpdeskConsumer(w.app), relayConsumer(w.app)], {}, [], () => {});
  await outbox.drain();
  mailer = new MailWorker(w.app, () => new Date(Date.now() + 10 * 60_000));
});

// Each test starts within D30's limits (five new requests an hour from one sender, and the rest), but those it sets itself.
beforeEach(async () => {
  await w.app.db.delete(helpThrottle);
});

afterAll(async () => {
  await w?.close();
  await smtp?.close();
});

describe('Authentication-Results, as RFC 8601 writes them', () => {
  const named = [TRUSTED];
  const gmail = `${TRUSTED};\r\n       dkim=pass header.i=@acme.example header.s=s1 header.b=AbCd/+12;\r\n       spf=pass (${TRUSTED}: domain of ana@acme.example designates 192.0.2.1 as permitted sender) smtp.mailfrom=ana@acme.example;\r\n       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=acme.example`;

  it('reads who checked and what each method found, through folding, comments and a version', () => {
    const read = parseAuthResults(gmail);
    expect(read?.authservId).toBe(TRUSTED);
    expect(read?.results.map((r) => [r.method, r.result])).toEqual([
      ['dkim', 'pass'],
      ['spf', 'pass'],
      ['dmarc', 'pass'],
    ]);
    expect(read?.results[2]!.props.get('header.from')).toBe('acme.example');
    expect(parseAuthResults(`${TRUSTED} 1; dmarc=pass header.from="acme.example"`)?.results[0]!.props.get('header.from')).toBe('acme.example');
    expect(parseAuthResults(`${TRUSTED}; none`)?.results).toEqual([]);
    // Exchange Online writes none of an authserv-id: it names no server, so it says nothing.
    expect(parseAuthResults('spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=acme.example; dmarc=pass action=none header.from=acme.example')).toBeNull();
    expect(parseAuthResults(`${TRUSTED}; dmarc=pass (unclosed comment header.from=acme.example`)).toBeNull();
  });

  it('trusts a DMARC pass for the sender’s domain from a named server, in any case or spacing', () => {
    expect(senderTrust([gmail], 'ana@acme.example', named)).toEqual({ trusted: true, by: TRUSTED });
    expect(senderTrust(['MX.Desk.TEST ;  DMARC = Pass  ( p=none )  Header.From = ACME.example'], 'Ana@Acme.Example', named).trusted).toBe(true);
    // A comment holding a semicolon or "fail" changes nothing.
    expect(senderTrust([`${TRUSTED}; dmarc=pass (policy; dmarc=fail) header.from=acme.example`], 'ana@acme.example', named).trusted).toBe(true);
  });

  it('counts only the topmost header from a named server: one forged below it, or from an unnamed server, says nothing', () => {
    const forgedBelow = `${TRUSTED}; dmarc=pass header.from=acme.example`;
    const real = `${TRUSTED}; dmarc=fail header.from=acme.example`;
    // The sender wrote a pass; the named server, above it, says it failed.
    expect(senderTrust([real, forgedBelow], 'ana@acme.example', named)).toEqual({ trusted: false, why: 'notPass' });
    // A server further in, which nobody named, above the named one: passed over, and the named one counts.
    expect(senderTrust(['relay.inside.test; dmarc=fail header.from=acme.example', forgedBelow], 'ana@acme.example', named).trusted).toBe(true);
    // Only an unnamed server's pass, or a look-alike's: nothing vouches.
    expect(senderTrust(['mx.elsewhere.test; dmarc=pass header.from=acme.example'], 'ana@acme.example', named)).toEqual({ trusted: false, why: 'noHeader' });
    expect(senderTrust([`${TRUSTED}.evil.test; dmarc=pass header.from=acme.example`], 'ana@acme.example', named)).toEqual({ trusted: false, why: 'noHeader' });
  });

  it('refuses a fail, a missing result, a pass for another domain, and anything when nobody is named', () => {
    expect(senderTrust([`${TRUSTED}; dmarc=fail (p=reject) header.from=acme.example`], 'ana@acme.example', named)).toEqual({ trusted: false, why: 'notPass' });
    expect(senderTrust([`${TRUSTED}; dmarc=none header.from=acme.example`], 'ana@acme.example', named)).toEqual({ trusted: false, why: 'notPass' });
    expect(senderTrust([`${TRUSTED}; spf=pass smtp.mailfrom=acme.example; dkim=pass header.d=acme.example`], 'ana@acme.example', named)).toEqual({ trusted: false, why: 'noDmarc' });
    expect(senderTrust([`${TRUSTED}; dmarc=pass`], 'ana@acme.example', named)).toEqual({ trusted: false, why: 'otherDomain' });
    expect(senderTrust([`${TRUSTED}; dmarc=pass header.from=evil.example`], 'ana@acme.example', named)).toEqual({ trusted: false, why: 'otherDomain' });
    expect(senderTrust([], 'ana@acme.example', named)).toEqual({ trusted: false, why: 'noHeader' });
    expect(senderTrust([gmail], 'ana@acme.example', [])).toEqual({ trusted: false, why: 'noneNamed' });
  });
});

describe('a new request’s Cc, held for its requester', () => {
  it('holds the Cc of an email a4a can’t trust, tells nobody held, and asks the requester by a link', async () => {
    const got = await mailIn(message({ from: 'Jane Doe <jane@example.com>', cc: 'Alice Ames <alice@example.org>, bob@example.org, anna@example.com', subject: 'Held: the fax is down', body: 'Since this morning.' }));
    expect(got.outcome).toBe('request');
    expect(got.reason).toContain('held alice@example.org, bob@example.org for its requester to confirm, since no mail server this server trusts checked it');
    expect(got.reason).toContain('anna@example.com (someone on the team)');
    const { id } = await issueOf('Held: the fax is down');
    expect(await listCcs(w.adminCtx, id)).toEqual([]);
    expect((await requestOf(w.adminCtx, id)).held.map((h) => [h.email, h.name])).toEqual([
      ['alice@example.org', 'Alice Ames'],
      ['bob@example.org', ''],
    ]);
    await flush();
    const ack = newestTo('jane@example.com');
    expect(ack.text).toContain('Alice Ames <alice@example.org>');
    expect(ack.text).toContain('They hear nothing until you confirm them');
    expect(ack.text).toMatch(/\/portal#hdc_[A-Za-z0-9_-]{43}/);
    expect(ack.text).toContain('/request#hdt_');
    // Nobody held is sent anything, the team's public reply included.
    await addComment(as(w.anna), id, 'We are on it.', { visibility: 'public' });
    await flush();
    expect(mailsTo('alice@example.org')).toHaveLength(0);
    expect(mailsTo('bob@example.org')).toHaveLength(0);
  });

  it('copies whom the link confirms and drops the rest, once: a reused or stale link answers alike', async () => {
    const { id, row } = await issueOf('Held: the fax is down');
    const token = mailsTo('jane@example.com')
      .map((m) => /\/portal#(hdc_[A-Za-z0-9_-]{43})/.exec(m.text)?.[1])
      .filter(Boolean)
      .at(-1)!;
    const shown = await ccConfirmation(w.app, token);
    expect(shown).toMatchObject({ request: { id, summary: 'Held: the fax is down' } });
    expect(shown.held.map((h) => h.email)).toEqual(['alice@example.org', 'bob@example.org']);
    // Opening it changed nothing; two uses at once: one settles the holds, the other is refused.
    const both = await Promise.allSettled([useCcConfirmation(w.app, token, ['ALICE@example.org']), useCcConfirmation(w.app, token, ['bob@example.org'])]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((both.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ status: 401, words: { key: 'requestCcs.confirmLinkExpired' } });
    const done = (both.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof useCcConfirmation>>>).value;
    expect(done.copied.length + done.dropped.length).toBe(2);
    expect((await requestOf(w.adminCtx, id)).held).toEqual([]);
    await expect(ccConfirmation(w.app, token)).rejects.toMatchObject({ status: 401 });
    // The history says the requester copied them, from their email, once they confirmed it.
    const added = (await issueActivity(w.adminCtx, id)).filter((e) => e.type === 'request.cc_added');
    expect(added.map((e) => [e.actor.channel, e.data.via, (e.data.requester as { name: string }).name])).toEqual([['helpdesk', 'confirmed', 'Jane Doe']]);
    // A link past its days answers as one used; so does one nobody minted.
    const stale = 'hdc_' + 'x'.repeat(43);
    await w.app.db.insert(requestCcConfirmations).values({ tokenHash: sha256(stale), issueId: row.id, expiresAt: new Date(Date.now() - 1000) });
    await expect(ccConfirmation(w.app, stale)).rejects.toMatchObject({ status: 401, words: { key: 'requestCcs.confirmLinkExpired' } });
    await expect(useCcConfirmation(w.app, 'hdc_' + 'y'.repeat(43), [])).rejects.toMatchObject({ status: 401 });
    await expect(ccConfirmation(w.app, 'not a token')).rejects.toMatchObject({ status: 401 });
  });

  it('shows the requester alone what’s held on the portal, to copy or drop, and copies a trusted sender’s Cc at once', async () => {
    await mailIn(message({ from: 'Jane Doe <jane@example.com>', cc: 'carl@example.org, dora@example.org', subject: 'Held: the badge reader', body: 'It beeps.' }));
    const { id } = await issueOf('Held: the badge reader');
    const jane = await requester('jane@example.com');
    const seen = await portalRequest(w.app, jane, id);
    expect(seen.held?.map((h) => h.email)).toEqual(['carl@example.org', 'dora@example.org']);
    expect((await portalSettleHeld(w.app, jane, id, 'carl@example.org', true)).ccs?.map((c) => c.email)).toEqual(['carl@example.org']);
    const dropped = await portalSettleHeld(w.app, jane, id, 'DORA@example.org', false);
    expect(dropped.held).toEqual([]);
    expect(dropped.ccs?.map((c) => c.email)).toEqual(['carl@example.org']);
    // Someone copied sees no holds, and settles none.
    const carl = await requesterByEmail(w.app.db, 'carl@example.org');
    expect((await portalRequest(w.app, viewer(carl), id)).held).toBeNull();
    await expect(portalSettleHeld(w.app, viewer(carl), id, 'x@example.org', true)).rejects.toMatchObject({ status: 403, words: { key: 'portal.onlyTheRequesterChangesCopies' } });
    // A sender a4a can trust: the Cc copies at once, as D57 does.
    const trusted = await mailIn(message({ from: 'Jane Doe <jane@example.com>', cc: 'erin@example.org', subject: 'Trusted: the lift', body: 'Stuck.', trusted: true }));
    expect(trusted.reason).toBe('a new request; copied erin@example.org');
    expect((await listCcs(w.adminCtx, (await issueOf('Trusted: the lift')).id)).map((c) => c.email)).toEqual(['erin@example.org']);
  });

  it('copies every Cc at once on a desk that holds none, and leaves those held before as they are', async () => {
    await mailIn(message({ from: 'Jane Doe <jane@example.com>', cc: 'fay@example.org', subject: 'Held: before the switch', body: 'One.' }));
    await deskSettings({ ccsConfirm: false });
    try {
      const got = await mailIn(message({ from: 'Jane Doe <jane@example.com>', cc: 'gus@example.org', subject: 'After the switch', body: 'Two.' }));
      expect(got.reason).toBe('a new request; copied gus@example.org');
      const before = await issueOf('Held: before the switch');
      expect((await requestOf(w.adminCtx, before.id)).held.map((h) => h.email)).toEqual(['fay@example.org']);
      expect(await listCcs(w.adminCtx, before.id)).toEqual([]);
      // The team may copy whom it holds: copied, they're held no longer.
      await addCc(as(w.anna), before.id, { email: 'fay@example.org' });
      expect(await w.app.db.select().from(requestCcHolds).where(eq(requestCcHolds.issueId, before.row.id))).toEqual([]);
    } finally {
      await deskSettings({ ccsConfirm: true });
    }
  });
});

describe('the requester takes people off', () => {
  let id = '';
  it('takes off each kind of CC on the portal, as the history says, and kept as D57 keeps them', async () => {
    await mailIn(message({ from: 'Jane Doe <jane@example.com>', cc: 'hal@example.org', subject: 'Off: the projector', body: 'No signal.', trusted: true }));
    id = (await issueOf('Off: the projector')).id;
    const jane = await requester('jane@example.com');
    const { portalCopy } = await import('../src/services/portal');
    await portalCopy(w.app, jane, id, { email: 'ivy@example.org' });
    await addCc(as(w.anna), id, { email: 'jon@example.org' });
    expect((await portalRequest(w.app, jane, id)).ccs?.map((c) => [c.email, c.byYou])).toEqual([
      ['hal@example.org', true],
      ['ivy@example.org', true],
      ['jon@example.org', false],
    ]);
    // From their email, on the portal, and the team's: each, by the requester.
    for (const email of ['hal@example.org', 'ivy@example.org', 'JON@example.org']) await portalUncopy(w.app, jane, id, email);
    expect(await listCcs(w.adminCtx, id)).toEqual([]);
    const removed = (await issueActivity(w.adminCtx, id)).filter((e) => e.type === 'request.cc_removed');
    expect(removed.map((e) => [e.actor.channel, e.data.via, (e.data.requester as { name: string }).name, (e.data.cc as { email: string }).email])).toEqual([
      ['helpdesk', 'portal', 'Jane Doe', 'hal@example.org'],
      ['helpdesk', 'portal', 'Jane Doe', 'ivy@example.org'],
      ['helpdesk', 'portal', 'Jane Doe', 'jon@example.org'],
    ]);
    const [row] = await w.app.db.select().from(requestCcs).where(and(eq(requestCcs.email, 'hal@example.org')));
    expect(row).toMatchObject({ removedVia: 'portal', removedById: null });
    // An email's Cc doesn't put them back; the requester and the team may.
    const again = await mailIn(message({ from: 'jane@example.com', to: await replyTo('jane@example.com', 'Off: the projector'), cc: 'hal@example.org', subject: 'Re: Off', body: 'And Hal.', trusted: true }));
    expect(again.reason).toContain('hal@example.org (taken off it before)');
    await portalCopy(w.app, jane, id, { email: 'hal@example.org' });
    expect((await listCcs(w.adminCtx, id)).map((c) => c.email)).toEqual(['hal@example.org']);
  });

  it('answers a CC taken off as missing, and refuses a colleague or someone copied, on the API too', async () => {
    const hal = viewer(await requesterByEmail(w.app.db, 'hal@example.org'));
    expect(await portalRequest(w.app, hal, id)).toMatchObject({ copied: true });
    await expect(portalUncopy(w.app, hal, id, 'hal@example.org')).rejects.toMatchObject({ status: 403, words: { key: 'portal.onlyTheRequesterChangesCopies' } });
    const jane = await requester('jane@example.com');
    const off = await portalApi('DELETE', `/portal/requests/${id}/ccs?email=hal@example.org`, jane.id);
    expect(off.status).toBe(200);
    expect(off.body.ccs).toEqual([]);
    // Taken off, it's missing to them, alike with one that doesn't exist.
    const gone = await portalApi('GET', `/portal/requests/${id}`, hal.id);
    expect(gone.status).toBe(404);
    expect(gone.body.error.key).toBe('portal.noRequestHere');
    expect((await portalApi('GET', '/portal/requests/BACK-9999', hal.id)).body.error).toEqual(gone.body.error);
    // A colleague of a group that shares to comment reads it, and takes no one off.
    const example = await createCustomerGroup(w.adminCtx, 'BACK', { name: 'Example', domains: ['example.com'], sharing: 'comment' });
    try {
      await mailIn(message({ from: 'Kim Lee <kim@example.com>', cc: 'lou@example.org', subject: 'Off: the kettle', body: 'Cold.', trusted: true }));
      const kettle = (await issueOf('Off: the kettle')).id;
      const colleague = await requesterByEmail(w.app.db, 'max@example.com', 'Max');
      // Whom it copies: the email's Cc, and the group's members (D56's revisit).
      const copied = (await listCcs(w.adminCtx, kettle)).map((c) => c.email);
      expect(copied).toContain('lou@example.org');
      const refused = await portalApi('DELETE', `/portal/requests/${kettle}/ccs?email=lou@example.org`, colleague.id);
      expect(refused.status).toBe(403);
      expect(refused.body.error.key).toBe('portal.onlyTheRequesterChangesCopies');
      expect((await listCcs(w.adminCtx, kettle)).map((c) => c.email)).toEqual(copied);
      // Without the portal's own page, or signed out, nothing changes.
      expect((await http.request(`/api/v1/portal/requests/${kettle}/ccs?email=lou@example.org`, { method: 'DELETE', headers: { origin: BASE } })).status).toBe(401);
    } finally {
      void example; // kept: the relay tests below read Kim and Max as colleagues through it
    }
  });
});

describe('a desk’s own cap', () => {
  // A requester of no customer group's, so the copies counted are the email's alone.
  it('stops new copies past it at the team’s, the portal’s and the email’s door, saying the cap, and takes no one off', async () => {
    await mailIn(message({ from: 'Pat Roe <pat@caps.example>', cc: 'm1@example.org, m2@example.org, m3@example.org', subject: 'Cap: the blinds', body: 'Stuck.', trusted: true }));
    const { id } = await issueOf('Cap: the blinds');
    await deskSettings({ ccsMax: 2 });
    try {
      expect((await listCcs(w.adminCtx, id)).length).toBe(3);
      expect((await requestOf(w.adminCtx, id)).ccsMax).toBe(2);
      await expect(addCc(as(w.anna), id, { email: 'm4@example.org' })).rejects.toMatchObject({ status: 409, words: { key: 'requestCcs.full', values: { max: 2 } }, message: 'A request copies at most 2 people' });
      const pat = await requester('pat@caps.example');
      const portal = await portalApi('POST', `/portal/requests/${id}/ccs`, pat.id, { email: 'm4@example.org' });
      expect(portal.status).toBe(409);
      expect(portal.body.error).toMatchObject({ key: 'requestCcs.full', values: { max: 2 } });
      expect((await portalRequest(w.app, pat, id)).ccsMax).toBe(2);
      const reply = await replyTo('pat@caps.example', 'Cap: the blinds');
      const mail = await mailIn(message({ from: 'pat@caps.example', to: reply, cc: 'm5@example.org', subject: 'Re: Cap', body: 'And five.', trusted: true }));
      expect(mail.reason).toContain('m5@example.org (the desk copies at most 2 on a request)');
      // Under the cap again, a copy goes in.
      await portalUncopy(w.app, pat, id, 'm1@example.org');
      await portalUncopy(w.app, pat, id, 'm2@example.org');
      expect((await addCc(as(w.anna), id, { email: 'm4@example.org' })).map((c) => c.email)).toEqual(['m3@example.org', 'm4@example.org']);
      // The setting is the desk's managers', from 1 to 50, in the desk's history.
      await expect(updateProject(as(w.anna), 'BACK', { settings: { helpdesk: { ccsMax: 51 } } })).rejects.toBeTruthy();
      const events = await w.app.db.execute(`SELECT payload FROM activities WHERE type = 'project.request_ccs.changed' ORDER BY id DESC LIMIT 1`);
      expect((events as unknown as { rows: { payload: { data: unknown } }[] }).rows[0]!.payload.data).toEqual({ from: { max: REQUEST_CCS_MAX, confirm: true, relay: false }, to: { max: 2, confirm: true, relay: false } });
    } finally {
      await deskSettings({ ccsMax: REQUEST_CCS_MAX });
    }
  });
});

describe('everyone on a request hearing each other', () => {
  let id = '';
  /** Relayed emails say who wrote on whose request; the team's replies say who replied. */
  const relayed = (address: string) => mailsTo(address).filter((m) => m.text.includes(' wrote on '));

  it('passes on nothing while the desk doesn’t relay', async () => {
    await mailIn(message({ from: 'Jane Doe <jane@example.com>', cc: 'Ana Kim <ana@acme.example>, Ben Ode <ben@acme.example>', subject: 'Relay: the printer', body: 'Jams.', trusted: true }));
    id = (await issueOf('Relay: the printer')).id;
    await addComment(as(w.anna), id, 'Which tray?', { visibility: 'public' });
    await flush();
    const ana = newestTo('ana@acme.example');
    const got = await mailIn(message({ from: 'Ana Kim <ana@acme.example>', to: ana.headers.get('reply-to')!, subject: 'Re: Relay', body: 'Tray two.', trusted: true }));
    expect(got.reason).toBe('a reply by its reply address, from someone copied on it');
    await flush();
    expect(relayed('ben@acme.example')).toHaveLength(0);
    expect(relayed('jane@example.com')).toHaveLength(0);
  });

  it('relays trusted words to everyone else on it, from the desk, saying who wrote, with no file and nothing older', async () => {
    await deskSettings({ ccsRelay: true });
    // A desk with a name of its own sends from its own address (D45), relays as all its mail.
    await w.app.db.update(helpdeskMailboxes).set({ fromName: 'Back office' }).where(eq(helpdeskMailboxes.projectId, back.id));
    const ana = newestTo('ana@acme.example');
    const got = await mailIn(
      message({ from: 'Ana Kim <ana@acme.example>', to: ana.headers.get('reply-to')!, subject: 'Re: Relay', body: 'The log is attached.\n\n> Which tray?', trusted: true, file: true }),
    );
    expect(got.reason).toBe('a reply by its reply address, from someone copied on it; relayed to the others on it');
    await flush();
    const toBen = relayed('ben@acme.example').at(-1)!;
    expect(toBen.text).toContain('Ana Kim wrote:');
    expect(toBen.text).toContain('The log is attached.');
    expect(toBen.text).not.toContain('Which tray?');
    expect(toBen.text).toContain('A file came with it: see it on the request’s page.');
    expect(toBen.raw).not.toMatch(/Content-Disposition: attachment/i);
    expect(toBen.raw).not.toContain('the printer log');
    expect(toBen.headers.get('from')).toContain(DESK);
    expect(toBen.headers.get('reply-to')).toMatch(/^support\+[a-z2-7]{26}@desk\.test$/);
    expect(toBen.headers.get('reply-to')).not.toBe(ana.headers.get('reply-to'));
    expect(toBen.headers.get('auto-submitted')).toBe('auto-generated');
    expect(toBen.text).toContain(`${BASE}/portal?request=${id}`);
    expect(relayed('jane@example.com').at(-1)!.text).toContain('Ana Kim wrote on your request.');
    // Never back to whoever wrote it.
    expect(relayed('ana@acme.example')).toHaveLength(0);
    // Ben answers the relay: his reply address answers for him, and his words go round too.
    const ben = await mailIn(message({ from: 'ben@acme.example', to: toBen.headers.get('reply-to')!, subject: 'Re: Relay', body: 'Thanks, Ana.', trusted: true }));
    expect(ben.outcome).toBe('reply');
    await flush();
    expect(relayed('ana@acme.example').at(-1)!.text).toContain('Thanks, Ana.');
  });

  it('keeps untrusted and tracking-link words on the request, and the desk’s log says why', async () => {
    const before = relayed('ben@acme.example').length;
    const ana = newestTo('ana@acme.example');
    const got = await mailIn(message({ from: 'Ana Kim <ana@acme.example>', to: ana.headers.get('reply-to')!, subject: 'Re: Relay', body: 'Unverified words.' }));
    expect(got.reason).toBe('a reply by its reply address, from someone copied on it; not relayed: no mail server this server trusts checked it');
    const tracking = /\/request#(hdt_[A-Za-z0-9_-]{43})/.exec(newestTo('jane@example.com').text)![1]!;
    await replyToRequest(w.app, tracking, 'Words by the tracking link.');
    await flush();
    expect(relayed('ben@acme.example')).toHaveLength(before);
    const texts = (await listComments(w.adminCtx, id)).map((c) => c.text);
    expect(texts).toEqual(expect.arrayContaining(['Unverified words.', 'Words by the tracking link.']));
    const [line] = await w.app.db.select().from(helpdeskInbound).where(and(eq(helpdeskInbound.via, 'page'), eq(helpdeskInbound.sender, 'jane@example.com')));
    expect(line).toMatchObject({ outcome: 'reply', reason: 'a reply on its tracking page; not relayed: written by its tracking link, not signed in to the portal' });
  });

  it('relays what a requester writes on the portal, signed in, and leaves the SLA as it was', async () => {
    const jane = await requester('jane@example.com');
    const fresh = await mailIn(message({ from: 'Jane Doe <jane@example.com>', cc: 'cy@acme.example', subject: 'Relay: SLA', body: 'Down.', trusted: true }));
    const sla = (await issueOf('Relay: SLA')).id;
    expect(fresh.outcome).toBe('request');
    await portalReply(w.app, jane, sla, 'Still down, signed in.');
    await flush();
    expect(relayed('cy@acme.example').at(-1)!.text).toContain('Still down, signed in.');
    expect((await requestOf(w.adminCtx, sla)).firstResponse).toMatchObject({ state: 'due', respondedAt: null });
    await addComment(as(w.anna), sla, 'Restarted it.', { visibility: 'public' });
    expect((await requestOf(w.adminCtx, sla)).firstResponse.state).toBe('met');
  });

  it(`relays at most ${CC_RELAY_LIMITS.perSender} from a sender an hour, and says so`, async () => {
    for (let i = 0; i < CC_RELAY_LIMITS.perSender; i++) await helpHit(w.app.db, [['relaySender', 'ben@acme.example']]);
    const ben = newestTo('ben@acme.example');
    const got = await mailIn(message({ from: 'ben@acme.example', to: ben.headers.get('reply-to')!, subject: 'Re: Relay', body: 'Over the limit.', trusted: true }));
    expect(got.reason).toBe(`a reply by its reply address, from someone copied on it; not relayed: its sender’s words were relayed ${CC_RELAY_LIMITS.perSender} times within the hour, the most a sender’s may be`);
    for (let i = 0; i < CC_RELAY_LIMITS.perRequest; i++) await helpHit(w.app.db, [['relayRequest', (await issueOf('Relay: the printer')).row.id]]);
    const ana = newestTo('ana@acme.example');
    const full = await mailIn(message({ from: 'Ana Kim <ana@acme.example>', to: ana.headers.get('reply-to')!, subject: 'Re: Relay', body: 'Request over its limit.', trusted: true }));
    expect(full.reason).toContain(`not relayed: this request relayed ${CC_RELAY_LIMITS.perRequest} messages within the hour, the most it may`);
  });

  it('lets a colleague who answered hear the others, until they stop it from its link', async () => {
    await mailIn(message({ from: 'Kim Lee <kim@example.com>', cc: 'nia@acme.example', subject: 'Relay: the group', body: 'Help.', trusted: true }));
    const { id: gid } = await issueOf('Relay: the group');
    // A colleague a4a meets only after the request came in, so its group's members copied on it
    // (D56's revisit) don't take her in: she hears it because she answered, as D67's colleague does.
    await requesterByEmail(w.app.db, 'zoe@example.com', 'Zoe');
    const max = await requester('zoe@example.com');
    await portalReply(w.app, max, gid, 'Same here, from Zoe.');
    await flush();
    // Zoe's words reach Kim by D56's email, and Nia by a relay; Kim hears no second copy of this
    // request's (she hears others', copied on them as her group's member, D56's revisit).
    expect(relayed('nia@acme.example').at(-1)!.text).toContain('Zoe wrote:');
    expect(relayed('kim@example.com').filter((m) => (m.headers.get('subject') ?? '').includes('Relay: the group'))).toHaveLength(0);
    const nia = newestTo('nia@acme.example');
    await mailIn(message({ from: 'nia@acme.example', to: nia.headers.get('reply-to')!, subject: 'Re: group', body: 'Nia here.', trusted: true }));
    await flush();
    const toMax = relayed('zoe@example.com').at(-1)!;
    expect(toMax.text).toContain('Nia here.');
    // Zoe answers the relay by its reply address: taken as a colleague's answer.
    const answer = await mailIn(message({ from: 'zoe@example.com', to: toMax.headers.get('reply-to')!, subject: 'Re: group', body: 'Zoe again.', trusted: true }));
    expect(answer.reason).toContain('from someone of its customer group');
    const token = decodeURIComponent(/token=([^>\s]+)/.exec(toMax.headers.get('list-unsubscribe')!)![1]!);
    expect(await applyUnsubscribe(w.app, token)).toMatchObject({ kind: 'relay', done: true });
    const had = relayed('zoe@example.com').length;
    await mailIn(message({ from: 'nia@acme.example', to: nia.headers.get('reply-to')!, subject: 'Re: group', body: 'Nia once more.', trusted: true }));
    await flush();
    expect(relayed('zoe@example.com')).toHaveLength(had);
    await deskSettings({ ccsRelay: false });
  });
});
