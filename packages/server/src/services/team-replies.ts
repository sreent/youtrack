/**
 * The team replying by email (D45): a notification email to someone on the team carries a reply
 * address whose token is theirs and the issue's (MAIL_REPLY_ADDRESS, plus the token), minted as
 * the email is sent and kept as a hash. Their answer comes in down D30's one path and becomes a
 * comment by them, with their access and permissions, if it's from an address of theirs.
 *
 * - On a help desk request, a reply is internal unless what they replied to was public (a
 *   requester's message, or a public reply); a line `#public` or `#internal` of its own says
 *   otherwise. A public one takes the permission to answer the requester, else it stays internal.
 * - A token from someone else's email, from another sender, or about an issue they can't see now,
 *   is refused without a word to anyone, as D30 refuses a forged requester.
 */
import { Readable } from 'node:stream';
import { HELP_LIMITS } from '@a4a/shared';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { systemCtx } from '../app-services';
import type { AppServices, UserRow } from '../context';
import type { Db } from '../db/client';
import { helpdeskRequests, teamReplyTokens, userEmails, users } from '../db/schema';
import { deskRecipient, newReplyToken, replyAddress } from '../helpdesk/addresses';
import { clip, type ReadMail } from '../helpdesk/reading';
import { sha256 } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { projectAccess } from './access';
import { storeAttachment } from './attachments';
import { addComment } from './comments';
import { helpHit } from './help-throttle';
import { resolveIssue } from './issues';

/** Mint the token a notification email's reply address carries; null when replies by email aren't set up. */
export async function mintTeamReplyAddress(app: AppServices, db: Db, userId: string, issueId: string, publicReply: boolean): Promise<string | null> {
  const address = app.config.mailReplyAddress;
  if (!address) return null;
  const token = newReplyToken();
  await db.insert(teamReplyTokens).values({ tokenHash: sha256(token), userId, issueId, publicReply });
  return replyAddress(address, token);
}

export async function forgetTeamReplyAddress(db: Db, address: string | null, app: AppServices): Promise<void> {
  const token = address && app.config.mailReplyAddress ? deskRecipient(app.config.mailReplyAddress, address)?.token : null;
  if (token) await db.delete(teamReplyTokens).where(eq(teamReplyTokens.tokenHash, sha256(token)));
}

/** The team reply tokens a message's recipients carry: none unless it's to the reply address. */
export function teamReplyTokensOf(app: AppServices, mail: ReadMail): string[] {
  const address = app.config.mailReplyAddress;
  if (!address) return [];
  return mail.recipients.map((r) => deskRecipient(address, r)?.token).filter((t): t is string => Boolean(t));
}

/** The project of the issue a team reply token names, for the log; null when it names none. */
export async function teamReplyProject(db: Db, tokens: string[]): Promise<string | null> {
  if (!tokens.length) return null;
  const res = await db.execute(sql`
    SELECT i.project_id FROM team_reply_tokens t JOIN issues i ON i.id = t.issue_id
    WHERE t.token_hash IN (${sql.join(tokens.slice(0, 5).map((t) => sql`${sha256(t)}`), sql`, `)}) LIMIT 1`);
  return (res as unknown as { rows: { project_id: string }[] }).rows[0]?.project_id ?? null;
}

export interface TeamReplyResult {
  outcome: 'reply' | 'refused' | 'ignored';
  reason: string;
  projectId: string | null;
  issueId?: string | null;
  commentId?: string | null;
}

async function addressesOf(db: Db, user: UserRow): Promise<Set<string>> {
  const confirmed = await db.select({ email: userEmails.email }).from(userEmails).where(and(eq(userEmails.userId, user.id), isNotNull(userEmails.confirmedAt)));
  return new Set([user.email, ...confirmed.map((c) => c.email)].filter((e): e is string => Boolean(e)).map((e) => e.toLowerCase()));
}

/** Words that say who sees the reply, on a line of their own, taken out of it. */
function visibilityWord(text: string): { text: string; say: 'public' | 'internal' | null } {
  let say: 'public' | 'internal' | null = null;
  const kept = text.split('\n').filter((line) => {
    const m = /^\s*#(public|internal)\s*$/i.exec(line);
    if (m) say = m[1]!.toLowerCase() as 'public' | 'internal';
    return !m;
  });
  return { text: kept.join('\n').trim(), say };
}

export async function handleTeamReply(app: AppServices, mail: ReadMail, tokens: string[]): Promise<TeamReplyResult> {
  const [token] = await app.db
    .select()
    .from(teamReplyTokens)
    .where(sql`${teamReplyTokens.tokenHash} IN (${sql.join(tokens.slice(0, 5).map((t) => sql`${sha256(t)}`), sql`, `)})`)
    .limit(1);
  if (!token) return { outcome: 'refused', reason: 'its reply address names no one a4a emailed', projectId: null };
  const [user] = await app.db.select().from(users).where(eq(users.id, token.userId));
  const [issueRow] = await app.db.execute(sql`SELECT project_id FROM issues WHERE id = ${token.issueId}`).then((r) => (r as unknown as { rows: { project_id: string }[] }).rows);
  const projectId = issueRow?.project_id ?? null;
  const sender = mail.from?.address ?? '';
  if (!user || user.banned || user.isBot) return { outcome: 'refused', reason: 'the person it was for can’t sign in now', projectId };
  if (mail.automatic) return { outcome: 'ignored', reason: mail.automatic, projectId };
  if (mail.failedSenderChecks) return { outcome: 'refused', reason: 'its own server says it failed DMARC, so it may not be from who it says', projectId };
  if (!(await addressesOf(app.db, user)).has(sender)) {
    return { outcome: 'refused', reason: 'a reply by a team reply address, sent from an address that isn’t its person’s', projectId };
  }
  if (await helpHit(app.db, [['teamReply', user.id]])) return { outcome: 'refused', reason: 'too many replies by email from this person in an hour', projectId };
  const ctx = systemCtx(app, user, 'email');
  let issue;
  try {
    issue = await resolveIssue(ctx, token.issueId);
  } catch {
    // Hidden or gone: nothing more is said, to them or anyone.
    return { outcome: 'refused', reason: 'about an issue its person can’t see now', projectId };
  }
  const access = await projectAccess(ctx);
  if (!access.canComment(issue.projectId)) return { outcome: 'refused', reason: 'its person can’t comment on this project now', projectId, issueId: issue.id };
  const clipped = clip(mail.reply, HELP_LIMITS.reply);
  const { text: words, say } = visibilityWord(clipped.text);
  if (!words && !mail.files.length) return { outcome: 'ignored', reason: 'it held nothing but what it quoted', projectId, issueId: issue.id };
  const [request] = await app.db.select({ issueId: helpdeskRequests.issueId }).from(helpdeskRequests).where(eq(helpdeskRequests.issueId, issue.id));
  const wantsPublic = Boolean(request) && (say ? say === 'public' : token.publicReply);
  // Answering the requester takes what answering on the page takes: the edit permission.
  const visibility = wantsPublic && access.canWrite(issue.projectId) ? 'public' : 'internal';
  const text = words || `Sent ${mail.files.length === 1 ? 'a file' : `${mail.files.length} files`} by email.`;
  let comment;
  try {
    comment = await addComment(ctx, issue.id, text, { visibility });
  } catch (e) {
    if (e instanceof AppError && e.status < 500) return { outcome: 'refused', reason: e.message, projectId, issueId: issue.id };
    throw e;
  }
  const left: string[] = [];
  for (const f of mail.files.slice(0, 20)) {
    try {
      await storeAttachment(ctx, { kind: 'comment', issue, commentId: comment.id }, { name: f.name, stream: Readable.from(f.content) });
    } catch (e) {
      left.push(`${f.name}: ${e instanceof AppError ? e.message : 'an error on the server'}`);
    }
  }
  const how = visibility === 'public' ? 'a public reply by email' : 'an internal comment by email';
  return { outcome: 'reply', reason: left.length ? `${how}; left out ${left.join('; ')}`.slice(0, 500) : how, projectId, issueId: issue.id, commentId: comment.id };
}

/** Forget reply tokens a month old (a chore): a reply that late is a new conversation. */
export async function pruneTeamReplyTokens(db: Db): Promise<void> {
  await db.delete(teamReplyTokens).where(sql`${teamReplyTokens.createdAt} < now() - interval '30 days'`);
}
