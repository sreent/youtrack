/**
 * Mail into a help desk (D30): the one path for a message, whether its desk's mail provider posted
 * it (http/routes/helpdesk-mail.ts) or the shared mailbox was read (helpdesk/imap.ts). It becomes
 * a request, the requester's reply on one, or nothing, and the desk's log says which and why.
 *
 * - Once: a message is known by its Message-ID within its desk, claimed before the work. One sent
 *   again, or read twice, is a duplicate; one whose work failed (or died, ten minutes on) may be
 *   handled again.
 * - A reply is the requester's when it's sent to a reply address whose token is the request's
 *   (support+token@…), or when it answers an email a4a sent them about it (In-Reply-To, References:
 *   those Message-IDs are random, so only someone who had the email can cite one). Either way it
 *   must come from the requester's address.
 * - Mail no person wrote (auto-replies, bounces, lists) and mail a4a or a desk sent itself is set
 *   aside, so nothing loops; a message whose own server says it failed DMARC is refused.
 * - Nobody is ever told of a message set aside or refused, so a forged sender gets no mail.
 */
import { Readable } from 'node:stream';
import { HELP_LIMITS, type HelpdeskInboundOutcome } from '@a4a/shared';
import { eq, lt, sql } from 'drizzle-orm';
import type { AppServices } from '../context';
import type { Db } from '../db/client';
import { helpdeskInbound, helpdeskMailboxes, issues } from '../db/schema';
import { AppError } from '../lib/errors';
import { formatBytes, storeAttachment, type UploadTarget } from '../services/attachments';
import { helpHit } from '../services/help-throttle';
import { botCtx, openRequest, postRequesterReply, requestWithRequester } from '../services/helpdesk';
import { projectSettings } from '../services/projects';
import type { ProjectRow } from '../services/schema-cache';
import { deskRecipient, requestOfReplyTokens, splitAddress } from './addresses';
import { clip, readMail, stripSignature, type MailFile, type ReadMail } from './reading';

export interface Inbound {
  via: 'webhook' | 'imap';
  /** The desk a provider posted it to; mail read from the shared mailbox finds its desk by address. */
  desk?: ProjectRow;
}

export interface InboundResult {
  outcome: HelpdeskInboundOutcome | 'duplicate';
  reason: string;
  issueId?: string | null;
  commentId?: string | null;
}

/** How long a claim stands before a message whose work died may be tried again. */
const STALE_CLAIM_MS = 10 * 60_000;
/** How long the log keeps what came in. */
export const INBOUND_KEEP_MS = 30 * 24 * 3_600_000;
/** Answers to mail that are a4a's own, and so may be cited by a reply. */
const REQUEST_MAIL = ['request-received', 'request-reply', 'request-state'];

type Mailbox = { projectId: string; address: string };

/** A message too large to take, noted without reading it. */
export async function refuseTooLarge(app: AppServices, inbound: Inbound, size: number): Promise<InboundResult> {
  const reason = `${formatBytes(size)}, larger than the ${formatBytes(app.config.helpdeskMailMaxBytes)} a help desk takes`;
  await note(app.db, inbound, inbound.desk?.id ?? null, null, 'refused', reason);
  return { outcome: 'refused', reason };
}

export async function receiveMail(app: AppServices, raw: Buffer, inbound: Inbound): Promise<InboundResult> {
  if (raw.length > app.config.helpdeskMailMaxBytes) return refuseTooLarge(app, inbound, raw.length);
  let mail: ReadMail;
  try {
    mail = await readMail(raw);
  } catch {
    const reason = 'it could not be read as an email';
    await note(app.db, inbound, inbound.desk?.id ?? null, null, 'refused', reason);
    return { outcome: 'refused', reason };
  }

  const s = await app.schema.get();
  const boxes: Mailbox[] = await app.db.select({ projectId: helpdeskMailboxes.projectId, address: helpdeskMailboxes.address }).from(helpdeskMailboxes);
  const { desk, tokens } = deskOf(s.projects, boxes, mail, inbound.desk);
  if (!desk) {
    const reason = 'it was not sent to any help desk’s address';
    await note(app.db, inbound, null, mail, 'ignored', reason);
    return { outcome: 'ignored', reason };
  }

  const claim = await claimMessage(app.db, desk.id, mail, inbound.via);
  if (claim === null) return { outcome: 'duplicate', reason: 'it came in before' };
  try {
    const result = await handle(app, desk, boxes, mail, tokens);
    await finish(app.db, claim, result);
    return result;
  } catch (e) {
    await finish(app.db, claim, { outcome: 'failed', reason: errorText(e) }).catch(() => {});
    throw e;
  }
}

/** The desk a message is for, and the reply tokens in its addresses to that desk. */
function deskOf(projects: Map<string, ProjectRow>, boxes: Mailbox[], mail: ReadMail, given: ProjectRow | undefined): { desk: ProjectRow | null; tokens: string[] } {
  let desk = given ?? null;
  const tokens: string[] = [];
  for (const recipient of mail.recipients) {
    for (const box of boxes) {
      if (desk && box.projectId !== desk.id) continue;
      const hit = deskRecipient(box.address, recipient);
      if (!hit) continue;
      // Read from the shared mailbox, a message goes to the first desk it names.
      desk ??= projects.get(box.projectId) ?? null;
      if (hit.token && desk?.id === box.projectId) tokens.push(hit.token);
    }
  }
  return { desk, tokens };
}

async function handle(app: AppServices, desk: ProjectRow, boxes: Mailbox[], mail: ReadMail, tokens: string[]): Promise<InboundResult> {
  const sender = mail.from?.address;
  if (!sender) return { outcome: 'ignored', reason: 'it has no sender' };
  const mailFrom = /<([^>]+)>/.exec(app.config.mailFrom)?.[1] ?? app.config.mailFrom;
  if (sender === mailFrom.toLowerCase() || boxes.some((b) => deskRecipient(b.address, sender))) {
    return { outcome: 'ignored', reason: 'sent by a4a or a help desk itself' };
  }
  if (mail.automatic) return { outcome: 'ignored', reason: mail.automatic };
  if (mail.failedSenderChecks) return { outcome: 'refused', reason: 'its own server says it failed DMARC, so it may not be from who it says' };
  if (await helpHit(app.db, [['mailDesk', desk.id]])) return { outcome: 'refused', reason: 'the help desk is taking too much mail just now' };

  const issueId = (await requestOfReplyTokens(app.db, tokens)) ?? (await answeredRequest(app.db, mail.answers, sender));
  const found = issueId ? await requestWithRequester(app.db, issueId) : null;
  if (found && found.issue.projectId === desk.id) {
    const how = tokens.length ? 'by its reply address' : 'answering an email about it';
    if (found.requester.email.toLowerCase() !== sender) {
      return { outcome: 'refused', reason: `a reply ${how}, sent from an address that isn’t the requester’s`, issueId: found.issue.id };
    }
    if (await helpHit(app.db, [['mailReply', found.issue.id]])) {
      return { outcome: 'refused', reason: 'too many replies to this request in an hour', issueId: found.issue.id };
    }
    const reply = clip(mail.reply, HELP_LIMITS.reply);
    if (!reply.text && !mail.files.length) return { outcome: 'ignored', reason: 'it held nothing but what it quoted', issueId: found.issue.id };
    const text = reply.text || `Sent ${mail.files.length === 1 ? 'a file' : `${mail.files.length} files`} by email.`;
    const { commentId } = await postRequesterReply(app, found.issue, { id: found.requester.id, name: found.requester.name }, text, 'email');
    const left = commentId ? await keepFiles(app, desk.id, { kind: 'comment', issue: found.issue, commentId }, mail, reply.cut) : [];
    return { outcome: 'reply', reason: withLeftOut(`a reply ${how}`, [...mail.skipped, ...left]), issueId: found.issue.id, commentId };
  }

  // A new request.
  const helpdesk = projectSettings(desk).helpdesk;
  if (!helpdesk.enabled || desk.archived) return { outcome: 'refused', reason: 'the help desk is closed to new requests' };
  if (await helpHit(app.db, [['mailSender', sender]])) return { outcome: 'refused', reason: 'too many requests from this address in an hour' };
  const description = clip(stripSignature(mail.text), HELP_LIMITS.description);
  const summary = clip(mail.subject || firstLine(description.text) || 'A request by email', HELP_LIMITS.summary).text;
  const name = clip(mail.from?.name || splitAddress(sender)?.local || sender, HELP_LIMITS.name).text;
  const issue = await openRequest(app, desk, { name, email: sender, summary, description: description.text, via: 'email', threadId: mail.messageId });
  const [row] = await app.db.select().from(issues).where(eq(issues.id, issue.uid));
  const left = row ? await keepFiles(app, desk.id, { kind: 'issue', issue: row }, mail, description.cut) : [];
  return { outcome: 'request', reason: withLeftOut('a new request', [...mail.skipped, ...left]), issueId: issue.uid };
}

/**
 * The request whose email this answers: one a4a sent this requester, about a request, with a
 * random Message-ID (`replyable`). Older emails' ids could be guessed, so they don't count.
 */
async function answeredRequest(db: Db, answers: string[], sender: string): Promise<string | null> {
  if (!answers.length) return null;
  const res = await db.execute(sql`
    SELECT payload->>'issueId' AS issue_id FROM mail_outbox
    WHERE message_id IN (${sql.join(
      answers.slice(0, 50).map((a) => sql`${a}`),
      sql`, `,
    )})
      AND kind IN (${sql.join(
        REQUEST_MAIL.map((k) => sql`${k}`),
        sql`, `,
      )})
      AND status = 'sent' AND payload->>'replyable' = 'true' AND lower(to_address) = ${sender}
    ORDER BY created_at DESC LIMIT 1`);
  const rows = (res as unknown as { rows: { issue_id: string | null }[] }).rows;
  return rows[0]?.issue_id ?? null;
}

/**
 * Keep a message's files on what it became, each through the usual checks (its type read from its
 * bytes, the per-file and per-issue limits). The original message goes with them when what's shown
 * isn't all of it: words read from HTML, or cut for length. Says what didn't fit.
 */
async function keepFiles(app: AppServices, projectId: string, target: UploadTarget, mail: ReadMail, cut: boolean): Promise<string[]> {
  const files: MailFile[] = [...mail.files];
  if (mail.htmlOnly || cut) files.push({ name: 'original-message.eml', contentType: 'message/rfc822', content: mail.raw });
  if (!files.length) return [];
  const ctx = await botCtx(app, projectId);
  const left: string[] = [];
  for (const f of files) {
    try {
      await storeAttachment(ctx, target, { name: f.name, stream: Readable.from(f.content) });
    } catch (e) {
      left.push(`${f.name}: ${errorText(e)}`);
    }
  }
  return left;
}

/** Why something failed, in the words a4a gives people; an unexpected error says only that it was one. */
function errorText(e: unknown): string {
  if (e instanceof AppError) return e.message;
  return 'an error on the server';
}

function withLeftOut(reason: string, left: string[]): string {
  return left.length ? `${reason}; left out ${left.join('; ')}`.slice(0, 500) : reason;
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim())?.trim() ?? '';
}

// ---------------------------------------------------------------------------
// The log: claimed before the work, finished after
// ---------------------------------------------------------------------------

async function claimMessage(db: Db, projectId: string, mail: ReadMail, via: Inbound['via']): Promise<number | null> {
  const res = await db.execute(sql`
    INSERT INTO helpdesk_inbound (project_id, message_id, via, sender, subject, outcome)
    VALUES (${projectId}, ${mail.messageId}, ${via}, ${mail.from?.address ?? ''}, ${mail.subject.slice(0, 300)}, 'received')
    ON CONFLICT (project_id, message_id) DO UPDATE SET outcome = 'received', reason = '', via = EXCLUDED.via, updated_at = now()
      WHERE helpdesk_inbound.outcome = 'failed'
         OR (helpdesk_inbound.outcome = 'received' AND helpdesk_inbound.updated_at < now() - make_interval(secs => ${STALE_CLAIM_MS / 1000}))
    RETURNING id`);
  const rows = (res as unknown as { rows: { id: number | string }[] }).rows;
  return rows[0] ? Number(rows[0].id) : null;
}

async function finish(db: Db, id: number, result: InboundResult): Promise<void> {
  await db
    .update(helpdeskInbound)
    .set({ outcome: result.outcome === 'duplicate' ? 'ignored' : result.outcome, reason: result.reason.slice(0, 500), issueId: result.issueId ?? null, commentId: result.commentId ?? null, updatedAt: new Date() })
    .where(eq(helpdeskInbound.id, id));
}

/** A line in the log for a message that never got as far as a claim. */
async function note(db: Db, inbound: Inbound, projectId: string | null, mail: ReadMail | null, outcome: HelpdeskInboundOutcome, reason: string): Promise<void> {
  await db
    .insert(helpdeskInbound)
    .values({
      projectId,
      messageId: mail?.messageId ?? `<unread-${Date.now()}-${Math.random().toString(36).slice(2)}@a4a>`,
      via: inbound.via,
      sender: mail?.from?.address ?? '',
      subject: (mail?.subject ?? '').slice(0, 300),
      outcome,
      reason,
    })
    .onConflictDoNothing();
}

/** Housekeeping: forget what came in more than 30 days ago. */
export async function pruneInbound(db: Db, now = new Date()): Promise<void> {
  await db.delete(helpdeskInbound).where(lt(helpdeskInbound.createdAt, new Date(now.getTime() - INBOUND_KEEP_MS)));
}
