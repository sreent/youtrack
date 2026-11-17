/**
 * Mail to a requester: that their request came in, a public reply, a new state. Each carries a
 * fresh tracking token, minted as it is sent and kept only as a hash, so no token waits in the
 * outbox in plain text; one minted for an attempt that failed is forgotten.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { AppServices } from '../context';
import { comments, helpdeskReplyTokens, helpdeskRequests, helpdeskTokens, issues, requesters } from '../db/schema';
import { AUTOMATIC, composeMail, threadHeaders, unsubscribeHeaders, type RenderedMail } from '../mail/compose';
import { mailHost, type MailRow } from '../mail/outbox';
import { sha256 } from '../lib/crypto';
import { deskAddress, mintTrackingToken, trackingUrl } from '../services/helpdesk';
import { unsubscribeToken } from '../services/notifications';
import { deskSender } from '../services/desk-mailbox';
import { mintReplyToken, replyAddress } from './addresses';
import { translatorFor } from '../i18n';

export async function renderRequestMail(app: AppServices, row: MailRow): Promise<RenderedMail | null> {
  const p = row.payload as { issueId?: string; commentId?: string; from?: string | null; to?: string | null; resolved?: boolean };
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
  // A requester has no profile: the server's language (D49).
  const tr = translatorFor(app.config.defaultLocale);
  const desk = project ? tr.t('server.helpdesk.deskOf', { project: project.name }) : tr.t('server.helpdesk.theDesk');

  let subject = `Re: ${issue.summary}`;
  let lead: string;
  let quote: string | undefined;
  let head: string | undefined;
  if (row.kind === 'request-received') {
    subject = issue.summary;
    lead = tr.t('server.helpdesk.received', { name: requester.name });
    head = tr.t('server.helpdesk.youAsked');
    const asked = issue.description.trim();
    quote = [issue.summary, asked.length > 4000 ? `${asked.slice(0, 3999)}…` : asked].filter(Boolean).join('\n\n');
  } else if (row.kind === 'request-reply') {
    const [comment] = await app.db
      .select()
      .from(comments)
      .where(and(eq(comments.id, String(p.commentId ?? '')), eq(comments.visibility, 'public'), isNull(comments.deletedAt)));
    if (!comment) return null; // deleted, or made internal, before it went
    const author = comment.authorId ? s.users.get(comment.authorId) : undefined;
    const who = author ? (author.isBot ? author.login : author.name) : tr.t('server.helpdesk.theTeam');
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
  const base = app.config.publicUrl;
  const { text, html } = composeMail(subject, {
    lead,
    sections: quote || head ? [{ head: head ?? tr.t('server.helpdesk.theyWrote'), quote }] : [],
    action: { label: tr.t('server.helpdesk.seeRequest'), url: trackingUrl(app, token) },
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
    },
  };
}
