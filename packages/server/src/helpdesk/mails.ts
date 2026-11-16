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
import { mintReplyToken, replyAddress } from './addresses';

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
  const desk = project ? `${project.name}'s help desk` : 'the help desk';

  let subject = `Re: ${issue.summary}`;
  let lead: string;
  let quote: string | undefined;
  let head: string | undefined;
  if (row.kind === 'request-received') {
    subject = issue.summary;
    lead = `We have your request, ${requester.name}. The team will reply on its page, and we'll email you when they do.`;
    head = 'You asked:';
    const asked = issue.description.trim();
    quote = [issue.summary, asked.length > 4000 ? `${asked.slice(0, 3999)}…` : asked].filter(Boolean).join('\n\n');
  } else if (row.kind === 'request-reply') {
    const [comment] = await app.db
      .select()
      .from(comments)
      .where(and(eq(comments.id, String(p.commentId ?? '')), eq(comments.visibility, 'public'), isNull(comments.deletedAt)));
    if (!comment) return null; // deleted, or made internal, before it went
    const author = comment.authorId ? s.users.get(comment.authorId) : undefined;
    const who = author ? (author.isBot ? author.login : author.name) : 'The team';
    lead = `${who} replied to your request.`;
    quote = comment.text;
  } else {
    lead = p.resolved ? `Your request is resolved: ${p.to ?? 'done'}.` : `Your request is now ${p.to ?? 'changed'}${p.from ? ` (it was ${p.from})` : ''}.`;
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
    sections: quote || head ? [{ head: head ?? 'They wrote:', quote }] : [],
    action: { label: 'See your request and reply', url: trackingUrl(app, token) },
    why: replyToken
      ? `You get this because you asked ${desk} for help. To reply, answer this email, or use the link above.`
      : `You get this because you asked ${desk} for help. To reply, use the link above: replies to this email don't reach anyone.`,
    ...(row.kind === 'request-received' ? {} : { stop: { label: 'Stop emails about this request', url: `${base}/unsubscribe?token=${encodeURIComponent(stop)}` } }),
  });
  // Everything threads under the request's first message: the requester's own, when they wrote in.
  const thread = request.threadId ?? `<request-${issue.id}@${mailHost(app)}>`;
  const threaded = row.kind !== 'request-received' || request.via === 'email';
  return {
    to: requester.email,
    subject: row.kind === 'request-received' && request.via === 'email' ? `Re: ${issue.summary}` : subject,
    text,
    html,
    headers: {
      ...AUTOMATIC,
      ...(threaded ? threadHeaders(thread) : {}),
      ...(replyToken && deskMail ? { 'Reply-To': replyAddress(deskMail, replyToken) } : {}),
      ...unsubscribeHeaders(`${base}/api/v1/unsubscribe?token=${encodeURIComponent(stop)}`),
    },
    onFailed: async () => {
      await app.db.delete(helpdeskTokens).where(eq(helpdeskTokens.tokenHash, sha256(token)));
      if (replyToken) await app.db.delete(helpdeskReplyTokens).where(eq(helpdeskReplyTokens.tokenHash, sha256(replyToken)));
    },
  };
}
