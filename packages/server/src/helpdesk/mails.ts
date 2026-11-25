/**
 * Mail to a requester: that their request came in, a public reply, a new state. Each carries a
 * fresh tracking token, minted as it is sent and kept only as a hash, so no token waits in the
 * outbox in plain text; one minted for an attempt that failed is forgotten.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AppServices } from '../context';
import { comments, helpdeskReplyTokens, helpdeskRequests, helpdeskTokens, issues, requesters } from '../db/schema';
import { AUTOMATIC, composeMail, threadHeaders, unsubscribeHeaders, type RenderedMail } from '../mail/compose';
import { langTag } from '@a4a/shared/i18n';
import { mailHost, type MailRow } from '../mail/outbox';
import { sha256 } from '../lib/crypto';
import { deskAddress, mintTrackingToken, trackingUrl } from '../services/helpdesk';
import { unsubscribeToken } from '../services/notifications';
import { deskSender } from '../services/desk-mailbox';
import { mintReplyToken, replyAddress } from './addresses';
import type { Translator } from '@a4a/shared/i18n';
import { localeOfRequester, translatorFor, type RequesterLanguage } from '../i18n';
import type { Db } from '../db/client';
import { ccById, ccsToTell, forgetCcConfirmation, heldOf, mintCcConfirmation } from '../services/request-ccs';
import { readableId } from '../services/issue-refs';
import type { SchemaSnapshot } from '../services/schema-cache';

/**
 * The words of an email to someone outside the team, in their language (D63's revisit): a requester's
 * choice on the portal, else their browser's, else, for an address with neither, the language of the
 * page that asked for the mail (`asked`), else the desk's, the server's (D49). A desk has no language
 * of its own, so someone a4a knows nothing of reads the server's.
 */
export function deskTranslator(app: AppServices, who?: RequesterLanguage, asked?: string | null): Translator {
  return translatorFor(localeOfRequester(app, who, asked));
}

/**
 * What a4a knows of an address's language, when the address is a requester's: someone copied on a
 * request, or relayed to, is often one (D57, D67). Read, never made: an email to an address a4a
 * doesn't know makes no requester of it.
 */
export async function languageOfAddress(db: Db, email: string): Promise<RequesterLanguage> {
  const [r] = await db.select({ chosenLocale: requesters.chosenLocale, locale: requesters.locale }).from(requesters).where(sql`lower(${requesters.email}) = ${email.trim().toLowerCase()}`);
  return r;
}

type Payload = { issueId?: string; commentId?: string; from?: string | null; to?: string | null; resolved?: boolean; ccId?: string };

export async function renderRequestMail(app: AppServices, row: MailRow): Promise<RenderedMail | null> {
  const p = row.payload as Payload;
  if (p.ccId) return renderCcMail(app, row, p);
  const issueId = String(p.issueId ?? '');
  const [found] = await app.db
    .select({ request: helpdeskRequests, requester: requesters, issue: issues })
    .from(helpdeskRequests)
    .innerJoin(requesters, eq(requesters.id, helpdeskRequests.requesterId))
    .innerJoin(issues, eq(issues.id, helpdeskRequests.issueId))
    .where(eq(helpdeskRequests.issueId, issueId));
  if (!found) return null; // the issue was deleted
  const { request, requester, issue } = found;
  // Stopping email stops what follows; the first, that it came in, is what they asked for.
  if (row.kind !== 'request-received' && request.emailMutedAt) return null;
  const s = await app.schema.get();
  const project = s.projects.get(issue.projectId);
  // Their language (D63's revisit): their choice on the portal, else their browser's, else the desk's (D49).
  const tr = deskTranslator(app, requester);
  const desk = project ? tr.t('server.helpdesk.deskOf', { project: project.name }) : tr.t('server.helpdesk.theDesk');

  let subject = `Re: ${issue.summary}`;
  let lead: string;
  let quote: string | undefined;
  let head: string | undefined;
  let copied: string[] = [];
  let held: string[] = [];
  if (row.kind === 'request-received') {
    subject = issue.summary;
    lead = tr.t('server.helpdesk.received', { name: requester.name });
    head = tr.t('server.helpdesk.youAsked');
    const asked = issue.description.trim();
    quote = [issue.summary, asked.length > 4000 ? `${asked.slice(0, 3999)}…` : asked].filter(Boolean).join('\n\n');
    // Who their email copied (D57): the address's real owner sees who will hear the team's answers.
    copied = (await ccsToTell(app.db, issue.id, new Date())).map((c) => (c.name ? `${c.name} <${c.email}>` : c.email));
    // Whom it named but a4a couldn't vouch they meant (D67): held, told nothing, until they confirm them.
    held = (await heldOf(app.db, issue.id)).map((c) => (c.name ? `${c.name} <${c.email}>` : c.email));
  } else if (row.kind === 'request-reply') {
    const [comment] = await app.db
      .select()
      .from(comments)
      .where(and(eq(comments.id, String(p.commentId ?? '')), eq(comments.visibility, 'public'), isNull(comments.deletedAt)));
    if (!comment) return null; // deleted, or made internal, before it went
    const author = comment.authorId ? s.users.get(comment.authorId) : undefined;
    // Someone of its customer group answered it (D56): by their own name.
    const [colleague] = comment.requesterId ? await app.db.select({ name: requesters.name }).from(requesters).where(eq(requesters.id, comment.requesterId)) : [];
    const who = colleague ? colleague.name : author ? (author.isBot ? author.login : author.name) : tr.t('server.helpdesk.theTeam');
    lead = tr.t('server.helpdesk.replied', { who });
    quote = comment.text;
  } else {
    // Without the state it's in now, the line says so in a sentence of its own, not with a word in the state's place.
    if (p.resolved) lead = p.to ? tr.t('server.helpdesk.resolved', { to: p.to }) : tr.t('server.helpdesk.resolvedPlain');
    else if (p.to) lead = p.from ? tr.t('server.helpdesk.nowWas', { to: p.to, from: p.from }) : tr.t('server.helpdesk.now', { to: p.to });
    else lead = p.from ? tr.t('server.helpdesk.changedFrom', { from: p.from }) : tr.t('server.helpdesk.changedPlain');
  }

  const token = await mintTrackingToken(app.db, issue.id);
  const stop = await unsubscribeToken(app, 'request', issue.id);
  // A desk that takes mail gets answers by email too: each email's reply address carries a token
  // of its own, minted as it's sent, as the tracking link's is (D30).
  const deskMail = await deskAddress(app, issue.projectId);
  const replyToken = deskMail ? await mintReplyToken(app.db, issue.id) : null;
  // Its link to confirm whom it held, once, for a few days, kept as a hash (D67).
  const confirm = held.length ? await mintCcConfirmation(app.db, issue.id) : null;
  const base = app.config.publicUrl;
  const see = { label: tr.t('server.helpdesk.seeRequest'), url: trackingUrl(app, token) };
  const { text, html } = composeMail(subject, {
    lang: langTag(tr.locale),
    lead,
    sections: [
      ...(quote || head ? [{ head: head ?? tr.t('server.helpdesk.theyWrote'), quote }] : []),
      ...(copied.length ? [{ head: tr.t('server.helpdesk.copiedOnIt'), lines: copied }] : []),
      ...(held.length ? [{ head: tr.t('server.helpdesk.heldForYou', { count: held.length }), lines: held }] : []),
    ],
    action: confirm ? { label: tr.t('server.helpdesk.confirmCopied', { count: held.length }), url: `${base}/portal#${confirm}` } : see,
    ...(confirm ? { also: see } : {}),
    why: replyToken
      ? tr.t('server.helpdesk.whyAnswer', { desk })
      : tr.t('server.helpdesk.whyLink', { desk }),
    ...(row.kind === 'request-received' ? {} : { stop: { label: tr.t('server.helpdesk.stop'), url: `${base}/unsubscribe?token=${encodeURIComponent(stop)}` } }),
  });
  // Everything threads under the request's first message: the requester's own, when they wrote in.
  const thread = request.threadId ?? `<request-${issue.id}@${mailHost(app)}>`;
  const threaded = row.kind !== 'request-received' || request.via === 'email';
  // From the desk's own address and name, once it has a mailbox or a name of its own (D45).
  const from = project ? await deskSender(app, project.id, project.name) : undefined;
  return {
    to: requester.email,
    ...(from ? { from } : {}),
    subject: row.kind === 'request-received' && request.via === 'email' ? `Re: ${issue.summary}` : subject,
    text,
    html,
    headers: {
      ...AUTOMATIC,
      ...(threaded ? threadHeaders(thread) : {}),
      ...(replyToken && deskMail ? { 'Reply-To' /* not words: a header */: replyAddress(deskMail, replyToken) } : {}),
      ...unsubscribeHeaders(`${base}/api/v1/unsubscribe?token=${encodeURIComponent(stop)}`),
    },
    onFailed: async () => {
      await app.db.delete(helpdeskTokens).where(eq(helpdeskTokens.tokenHash, sha256(token)));
      if (replyToken) await app.db.delete(helpdeskReplyTokens).where(eq(helpdeskReplyTokens.tokenHash, sha256(replyToken)));
      if (confirm) await forgetCcConfirmation(app.db, confirm);
    },
  };
}

/** The team's public reply, as a line and its words; null when it's gone, no longer public, or not the team's (D57: only the team's words go out). */
async function publicReply(app: AppServices, s: SchemaSnapshot, tr: Translator, commentId: string): Promise<{ lead: string; quote: string } | null> {
  const [comment] = await app.db
    .select()
    .from(comments)
    .where(and(eq(comments.id, commentId), eq(comments.visibility, 'public'), isNull(comments.deletedAt), isNull(comments.requesterId)));
  if (!comment) return null;
  const author = comment.authorId ? s.users.get(comment.authorId) : undefined;
  return { lead: author ? (author.isBot ? author.login : author.name) : tr.t('server.helpdesk.theTeam'), quote: comment.text };
}

/**
 * Mail to someone copied on a request (D57): what its requester is told, the team's public replies
 * and its changes of state, said as someone else's request. Its reply address answers for them
 * alone, its link opens the request on the portal (never the requester's tracking link, which would
 * speak in the requester's name), and its unsubscribe link takes them off the request.
 */
async function renderCcMail(app: AppServices, row: MailRow, p: Payload): Promise<RenderedMail | null> {
  const cc = await ccById(app.db, String(p.ccId));
  // Taken off since it was queued: they hear nothing more.
  if (!cc || cc.removedAt) return null;
  const [found] = await app.db
    .select({ request: helpdeskRequests, requester: requesters, issue: issues })
    .from(helpdeskRequests)
    .innerJoin(requesters, eq(requesters.id, helpdeskRequests.requesterId))
    .innerJoin(issues, eq(issues.id, helpdeskRequests.issueId))
    .where(eq(helpdeskRequests.issueId, cc.issueId));
  if (!found) return null;
  const { request, requester, issue } = found;
  const s = await app.schema.get();
  const project = s.projects.get(issue.projectId);
  const tr = deskTranslator(app, await languageOfAddress(app.db, cc.email));
  const desk = project ? tr.t('server.helpdesk.deskOf', { project: project.name }) : tr.t('server.helpdesk.theDesk');
  const asker = requester.name;

  let lead: string;
  let quote: string | undefined;
  if (row.kind === 'request-reply') {
    const reply = await publicReply(app, s, tr, String(p.commentId ?? ''));
    if (!reply) return null; // deleted, or made internal, before it went
    lead = tr.t('server.helpdesk.cc.replied', { who: reply.lead, requester: asker });
    quote = reply.quote;
  } else if (row.kind === 'request-state') {
    if (p.resolved) lead = p.to ? tr.t('server.helpdesk.cc.resolved', { to: p.to, requester: asker }) : tr.t('server.helpdesk.cc.resolvedPlain', { requester: asker });
    else if (p.to) lead = p.from ? tr.t('server.helpdesk.cc.nowWas', { to: p.to, from: p.from, requester: asker }) : tr.t('server.helpdesk.cc.now', { to: p.to, requester: asker });
    else lead = p.from ? tr.t('server.helpdesk.cc.changedFrom', { from: p.from, requester: asker }) : tr.t('server.helpdesk.cc.changedPlain', { requester: asker });
  } else {
    return null; // only what follows: they don't get the requester's acknowledgement
  }

  const stop = await unsubscribeToken(app, 'cc', cc.id);
  const deskMail = await deskAddress(app, issue.projectId);
  const replyToken = deskMail ? await mintReplyToken(app.db, issue.id, cc.email) : null;
  const base = app.config.publicUrl;
  const subject = `Re: ${issue.summary}`;
  const { text, html } = composeMail(subject, {
    lang: langTag(tr.locale),
    lead,
    sections: quote ? [{ head: tr.t('server.helpdesk.theyWrote'), quote }] : [],
    action: { label: tr.t('server.helpdesk.cc.seeRequest'), url: `${base}/portal?request=${encodeURIComponent(readableId(s, issue))}` },
    why: replyToken ? tr.t('server.helpdesk.cc.whyAnswer', { desk, requester: asker }) : tr.t('server.helpdesk.cc.whyLink', { desk, requester: asker }),
    stop: { label: tr.t('server.helpdesk.cc.stop'), url: `${base}/unsubscribe?token=${encodeURIComponent(stop)}` },
  });
  const from = project ? await deskSender(app, project.id, project.name) : undefined;
  return {
    to: cc.email,
    ...(from ? { from } : {}),
    subject,
    text,
    html,
    headers: {
      ...AUTOMATIC,
      // In the conversation's thread: a CC from the requester's Cc has its first message.
      ...threadHeaders(request.threadId ?? `<request-${issue.id}@${mailHost(app)}>`),
      ...(replyToken && deskMail ? { 'Reply-To' /* not words: a header */: replyAddress(deskMail, replyToken) } : {}),
      ...unsubscribeHeaders(`${base}/api/v1/unsubscribe?token=${encodeURIComponent(stop)}`),
    },
    onFailed: async () => {
      if (replyToken) await app.db.delete(helpdeskReplyTokens).where(eq(helpdeskReplyTokens.tokenHash, sha256(replyToken)));
    },
  };
}
