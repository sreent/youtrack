/**
 * Everyone on a request hearing each other (D67), where its desk turns it on: the requester, the
 * people copied on it (D57), and colleagues of its customer group who answered it (D56) are emailed
 * each other's public words. That is a4a carrying outside words to addresses, which D57 refused, so
 * only words a4a can trust who wrote are passed on: written on the portal, signed in, or by email
 * whose sender's domain passed DMARC at a mail server the administrator names (helpdesk/trust.ts).
 *
 * - Decided as the words come in (`relayChoice`), so the desk's log can say why words weren't
 *   passed on; the comment's event then says `relay: true`, and the consumer passes it on, at least
 *   once, an email per person, each deduplicated by event and person.
 * - Limited per request and per sender each hour, in the help desk's shared throttle (D30).
 * - A relayed email comes from the desk, with a reply address of its own (D57), says who wrote, and
 *   quotes nothing older. It never carries files: it says how many came, and where to see them.
 * - What isn't passed on stays on the request's page and in the team's view, as before.
 */
import { CC_RELAY_LIMITS, type TrackerEvent } from '@a4a/shared';
import { langTag } from '@a4a/shared/i18n';
import { and, eq, isNull, lte, ne, sql } from 'drizzle-orm';
import type { AppServices } from '../context';
import type { Db } from '../db/client';
import { activities, comments, helpdeskInbound, helpdeskReplyTokens, helpdeskTokens, issues, requestRelayStops, requesters } from '../db/schema';
import type { OutboxConsumer } from '../events/worker';
import { sha256 } from '../lib/crypto';
import { newId } from '../lib/ids';
import { AUTOMATIC, composeMail, threadHeaders, unsubscribeHeaders, type RenderedMail } from '../mail/compose';
import { enqueueMail, kickMail, mailHost, type MailRow } from '../mail/outbox';
import { mailConfigured } from '../notify/state';
import { commentingColleague } from '../services/customer-groups';
import { deskSender } from '../services/desk-mailbox';
import { helpHit } from '../services/help-throttle';
import { deskAddress, mintTrackingToken, requestMessageId, requestWithRequester, trackingUrl } from '../services/helpdesk';
import { readableId } from '../services/issue-refs';
import { unsubscribeToken } from '../services/notifications';
import { projectSettings } from '../services/projects';
import { ccById, ccsToTell, copyStanding, groupStopSubject } from '../services/request-ccs';
import { mintReplyToken, replyAddress } from './addresses';
import { deskTranslator } from './mails';
import { untrustedWords, type Untrusted } from './trust';

type IssueRow = typeof issues.$inferSelect;
type Found = NonNullable<Awaited<ReturnType<typeof requestWithRequester>>>;

/** How words came in, and whether a4a can trust who wrote them: `on` the portal signed in, the tracking page, or email. */
export type RelayHow = { on: 'email' | 'page' | 'portal'; sender: string } & ({ trusted: true } | { trusted: false; why: Untrusted | 'page' });
/** Why words weren't passed on. */
export type RelayWhy = Untrusted | 'page' | 'requestLimit' | 'senderLimit';
/** Whether they are; `why` null when there was nothing to decide (the desk doesn't relay, or nobody else is on it). */
export type RelayChoice = { relay: true } | { relay: false; why: RelayWhy | null };

const lower = (s: string) => s.trim().toLowerCase();

/** Who hears words on a request, besides whoever wrote them. */
export interface Hearer {
  key: string;
  kind: 'requester' | 'cc' | 'colleague';
  id: string;
  email: string;
}

/**
 * Colleagues of its customer group (D56) who answered it before `at`, and still may: not its
 * requester, not anyone ever copied on it (they hear as CCs, or were taken off), and not one who
 * stopped hearing it.
 */
async function colleaguesWhoAnswered(db: Db, found: Found, at: Date): Promise<{ id: string; email: string; name: string }[]> {
  const rows = await db
    .selectDistinct({ id: requesters.id, email: requesters.email, name: requesters.name })
    .from(comments)
    .innerJoin(requesters, eq(requesters.id, comments.requesterId))
    .where(
      and(
        eq(comments.issueId, found.issue.id),
        eq(comments.visibility, 'public'),
        isNull(comments.deletedAt),
        lte(comments.createdAt, at),
        ne(comments.requesterId, found.request.requesterId),
        sql`NOT EXISTS (SELECT 1 FROM request_ccs x WHERE x.issue_id = ${comments.issueId} AND lower(x.email) = lower(${requesters.email}))`,
        sql`NOT EXISTS (SELECT 1 FROM request_relay_stops t WHERE t.issue_id = ${comments.issueId} AND t.requester_id = ${requesters.id})`,
      ),
    );
  const out: { id: string; email: string; name: string }[] = [];
  for (const r of rows) if (await commentingColleague(db, found.request, r.email, r.name)) out.push(r);
  return out;
}

/**
 * Everyone on a request who hears its outside words at `at`, but whoever wrote them: its requester,
 * unless they stopped its emails, or the writer is a colleague (D56 tells its requester of those
 * already); each copied on it then; and the colleagues who answered it. One each, by address.
 */
export async function hearersOf(db: Db, found: Found, at: Date, speaker: string, speakerIsColleague: boolean): Promise<Hearer[]> {
  const who = lower(speaker);
  const out: Hearer[] = [];
  if (!speakerIsColleague && !found.request.emailMutedAt) out.push({ key: 'requester', kind: 'requester', id: found.requester.id, email: found.requester.email });
  for (const cc of await ccsToTell(db, found.issue.id, at)) out.push({ key: `cc:${cc.id}`, kind: 'cc', id: cc.id, email: cc.email });
  for (const c of await colleaguesWhoAnswered(db, found, at)) out.push({ key: `colleague:${c.id}`, kind: 'colleague', id: c.id, email: c.email });
  const seen = new Set([who]);
  return out.filter((h) => !seen.has(lower(h.email)) && Boolean(seen.add(lower(h.email))));
}

/**
 * Whether words coming in now are passed on to everyone else on the request: the desk relays, mail
 * goes out, someone else is on it, a4a can trust who wrote them, and neither limit is reached. A
 * relay is counted only when it would go: first the sender's, then the request's.
 */
export async function relayChoice(app: AppServices, issue: IssueRow, how: RelayHow, speakerIsColleague = false): Promise<RelayChoice> {
  const desk = (await app.schema.get()).projects.get(issue.projectId);
  if (!desk || !projectSettings(desk).helpdesk.ccsRelay || !mailConfigured(app)) return { relay: false, why: null };
  const found = await requestWithRequester(app.db, issue.id);
  if (!found || !(await hearersOf(app.db, found, new Date(), how.sender, speakerIsColleague)).length) return { relay: false, why: null };
  if (!how.trusted) return { relay: false, why: how.why };
  if (await helpHit(app.db, [['relaySender', how.sender]])) return { relay: false, why: 'senderLimit' };
  if (await helpHit(app.db, [['relayRequest', issue.id]])) return { relay: false, why: 'requestLimit' };
  return { relay: true };
}

/** The desk's log's words for a relay choice: null when there was nothing to decide. */
export function relaySaid(choice: RelayChoice): string | null {
  if (choice.relay) return 'relayed to the others on it';
  if (!choice.why) return null;
  switch (choice.why) {
    case 'page':
      return 'not relayed: written by its tracking link, not signed in to the portal';
    case 'senderLimit':
      return `not relayed: its sender’s words were relayed ${CC_RELAY_LIMITS.perSender} times within the hour, the most a sender’s may be`;
    case 'requestLimit':
      return `not relayed: this request relayed ${CC_RELAY_LIMITS.perRequest} messages within the hour, the most it may`;
    default:
      return `not relayed: ${untrustedWords(choice.why)}`;
  }
}

/** A line in the desk's log for words written on a page that a desk that relays didn't pass on (D67): mail has a line of its own. */
export async function noteNotRelayed(app: AppServices, issue: IssueRow, how: RelayHow, commentId: string | null, why: RelayWhy): Promise<void> {
  const where = how.on === 'portal' ? 'a reply on the portal' : 'a reply on its tracking page';
  await app.db
    .insert(helpdeskInbound)
    .values({
      projectId: issue.projectId,
      messageId: `<${how.on}.${commentId ?? newId()}@relay.a4a>`,
      via: how.on,
      sender: how.sender,
      subject: issue.summary.slice(0, 300),
      outcome: 'reply',
      reason: `${where}; ${relaySaid({ relay: false, why })}`.slice(0, 500),
      issueId: issue.id,
      commentId,
    })
    .onConflictDoNothing();
}

/** What someone wrote, without anything older they quoted in it: a relay quotes nothing older (D67). */
export function ownWords(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Passing them on, from the outbox
// ---------------------------------------------------------------------------

export function relayConsumer(app: AppServices): OutboxConsumer {
  return { name: 'helpdesk-relay', types: ['comment.created'], handle: (event) => relayToEveryone(app, event) };
}

/** Queue an email to each who hears a comment marked to be passed on, at least once: deduplicated by event and person. */
export async function relayToEveryone(app: AppServices, event: TrackerEvent): Promise<void> {
  if (!mailConfigured(app)) return;
  const data = event.data as { visibility?: string; relay?: unknown; commentId?: unknown; colleague?: unknown; files?: unknown };
  if (data.visibility !== 'public' || data.relay !== true || typeof data.commentId !== 'string') return;
  const [row] = await app.db.select({ issueId: activities.issueId }).from(activities).where(eq(activities.id, event.id));
  if (!row?.issueId) return;
  const found = await requestWithRequester(app.db, row.issueId);
  if (!found) return;
  const [comment] = await app.db
    .select({ id: comments.id, requesterId: comments.requesterId })
    .from(comments)
    .where(and(eq(comments.id, data.commentId), eq(comments.visibility, 'public'), isNull(comments.deletedAt)));
  if (!comment?.requesterId) return;
  const [speaker] = await app.db.select({ email: requesters.email }).from(requesters).where(eq(requesters.id, comment.requesterId));
  if (!speaker) return;
  let queued = false;
  for (const h of await hearersOf(app.db, found, new Date(event.occurredAt), speaker.email, data.colleague === true)) {
    const one = await enqueueMail(app.db, app, {
      kind: 'request-relay',
      dedupeKey: `request-relay:${event.id}:${h.key}`,
      // `replyable`: its Message-ID is random, so an answer that cites it is its reader's (D30).
      payload: { issueId: row.issueId, eventId: event.id, commentId: comment.id, to: { kind: h.kind, id: h.id }, files: typeof data.files === 'number' ? data.files : 0, replyable: true },
      messageId: requestMessageId('request-relay'),
    });
    queued ||= one;
  }
  if (queued) kickMail(app);
}

type Payload = { issueId?: string; commentId?: string; to?: { kind?: string; id?: string }; files?: number };

/**
 * A relayed email (D67), rendered as it's sent, so whoever stopped hearing since, words made internal
 * or deleted since, and a desk that stopped relaying since, send nothing. From the desk's address,
 * with a reply address of its own for its reader; never a file, only how many came.
 */
export async function renderRelayMail(app: AppServices, row: MailRow): Promise<RenderedMail | null> {
  const p = row.payload as Payload;
  const found = await requestWithRequester(app.db, String(p.issueId ?? ''));
  if (!found) return null;
  const { request, requester, issue } = found;
  const s = await app.schema.get();
  const project = s.projects.get(issue.projectId);
  if (!project || !projectSettings(project).helpdesk.ccsRelay) return null;
  const [comment] = await app.db
    .select()
    .from(comments)
    .where(and(eq(comments.id, String(p.commentId ?? '')), eq(comments.issueId, issue.id), eq(comments.visibility, 'public'), isNull(comments.deletedAt)));
  if (!comment?.requesterId) return null;
  const [speaker] = await app.db.select().from(requesters).where(eq(requesters.id, comment.requesterId));
  const words = ownWords(comment.text);
  if (!speaker || !words) return null;

  const tr = deskTranslator(app);
  const base = app.config.publicUrl;
  const portal = { label: tr.t('server.helpdesk.cc.seeRequest'), url: `${base}/portal?request=${encodeURIComponent(readableId(s, issue))}` };
  const id = String(p.to?.id ?? '');
  let to: string;
  let replyFor: string | null;
  let whose: 'yours' | 'theirs' = 'theirs';
  let tracking: string | null = null;
  let action = portal;
  let stop: { label: string; url: string };
  let oneClick: string;
  // One of its customer group's people, copied by it (D56's revisit): told why, and an address to reply to only where they may answer.
  let grouped: { name: string; sharing: string } | null = null;
  if (p.to?.kind === 'requester') {
    if (request.emailMutedAt || id !== requester.id) return null;
    to = requester.email;
    replyFor = null;
    whose = 'yours';
    tracking = await mintTrackingToken(app.db, issue.id);
    action = { label: tr.t('server.helpdesk.seeRequest'), url: trackingUrl(app, tracking) };
    const token = await unsubscribeToken(app, 'request', issue.id);
    stop = { label: tr.t('server.helpdesk.stop'), url: `${base}/unsubscribe?token=${encodeURIComponent(token)}` };
    oneClick = token;
  } else if (p.to?.kind === 'cc') {
    const cc = await ccById(app.db, id);
    if (!cc || cc.removedAt || cc.issueId !== issue.id) return null;
    // A group's copy hears only while the group shares this request with them, as its own emails do.
    const standing = await copyStanding(app.db, cc);
    if (!standing.hears) return null;
    to = cc.email;
    replyFor = cc.email;
    if (standing.group && standing.requesterId) {
      grouped = standing.group;
      const token = await unsubscribeToken(app, 'group', groupStopSubject(standing.group.id, standing.requesterId));
      stop = { label: tr.t('server.helpdesk.groupCopy.stop', { group: standing.group.name }), url: `${base}/unsubscribe?token=${encodeURIComponent(token)}` };
      oneClick = token;
      if (standing.group.sharing !== 'comment') action = { ...portal, label: tr.t('server.helpdesk.groupCopy.seeRequest') };
    } else {
      const token = await unsubscribeToken(app, 'cc', cc.id);
      stop = { label: tr.t('server.helpdesk.cc.stop'), url: `${base}/unsubscribe?token=${encodeURIComponent(token)}` };
      oneClick = token;
    }
  } else if (p.to?.kind === 'colleague') {
    const [q] = await app.db.select().from(requesters).where(eq(requesters.id, id));
    if (!q) return null;
    const [stopped] = await app.db.select().from(requestRelayStops).where(and(eq(requestRelayStops.issueId, issue.id), eq(requestRelayStops.requesterId, q.id)));
    if (stopped || !(await commentingColleague(app.db, request, q.email, q.name))) return null;
    to = q.email;
    replyFor = q.email;
    const token = await unsubscribeToken(app, 'relay', `${issue.id}-${q.id}`);
    stop = { label: tr.t('server.helpdesk.relay.stop'), url: `${base}/unsubscribe?token=${encodeURIComponent(token)}` };
    oneClick = token;
  } else return null;
  // Never their own words back to them.
  if (lower(to) === lower(speaker.email)) return null;

  const deskMail = await deskAddress(app, issue.projectId);
  const answers = !grouped || grouped.sharing === 'comment';
  const replyToken = deskMail && answers ? await mintReplyToken(app.db, issue.id, replyFor) : null;
  const desk = tr.t('server.helpdesk.deskOf', { project: project.name });
  const name = speaker.name || speaker.email;
  const files = Math.max(0, Math.floor(Number(p.files ?? 0)));
  const subject = `Re: ${issue.summary}`;
  const { text, html } = composeMail(subject, {
    lang: langTag(tr.locale),
    lead: tr.t('server.helpdesk.relay.lead', { name, whose, requester: requester.name }),
    sections: [{ head: tr.t('server.helpdesk.relay.wrote', { name }), quote: words }, ...(files ? [{ head: tr.t('server.helpdesk.relay.files', { count: files }) }] : [])],
    action,
    why: grouped
      ? tr.t('server.helpdesk.groupCopy.why', { group: grouped.name, desk, how: !answers ? 'read' : replyToken ? 'email' : 'portal' })
      : replyToken
        ? tr.t('server.helpdesk.relay.whyAnswer', { desk, whose, requester: requester.name })
        : tr.t('server.helpdesk.relay.whyLink', { desk, whose, requester: requester.name }),
    stop,
  });
  const from = await deskSender(app, project.id, project.name);
  return {
    to,
    ...(from ? { from } : {}),
    subject,
    text,
    html,
    headers: {
      ...AUTOMATIC,
      ...threadHeaders(request.threadId ?? `<request-${issue.id}@${mailHost(app)}>`),
      ...(replyToken && deskMail ? { 'Reply-To' /* not words: a header */: replyAddress(deskMail, replyToken) } : {}),
      ...unsubscribeHeaders(`${base}/api/v1/unsubscribe?token=${encodeURIComponent(oneClick)}`),
    },
    onFailed: async () => {
      if (tracking) await app.db.delete(helpdeskTokens).where(eq(helpdeskTokens.tokenHash, sha256(tracking)));
      if (replyToken) await app.db.delete(helpdeskReplyTokens).where(eq(helpdeskReplyTokens.tokenHash, sha256(replyToken)));
    },
  };
}
