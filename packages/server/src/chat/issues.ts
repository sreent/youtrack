/**
 * Issues made from Teams and Slack messages (D60): Slack's message shortcut and Teams' message action
 * open a form; sent, it makes the issue as the person, through the one write path, with where it came
 * from kept beside it (chat_issue_sources) rather than in its description.
 *
 * - The form is a draft row, written when it opens, naming who opened it: only they send it, within an
 *   hour, once. The row is claimed in the transaction that makes the issue, so a form sent twice, or a
 *   request replayed, makes one issue.
 * - What the person may create in is all the form offers; anything else is refused as missing.
 * - Someone makes at most CHAT_ISSUE_LIMIT issues from chat in ten minutes, counted under a lock of
 *   theirs, so two forms sent at once can't both pass.
 * - The message's author, linked to an a4a account who may see the issue, watches it.
 * - A link in the thread follows D42's line (threadMayHear).
 */
import type { ChatPlatform, IssueDetail } from '@a4a/shared';
import type { Translator } from '@a4a/shared/i18n';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { Ctx, UserRow } from '../context';
import type { Db } from '../db/client';
import { chatIssueSources, chatRequestsSeen, chatSubscriptions, type ChatSourceFile } from '../db/schema';
import { problemFor } from '../i18n';
import { AppError } from '../lib/errors';
import { newId } from '../lib/ids';
import { projectAccess } from '../services/access';
import { createIssue, getIssue } from '../services/issues';
import { keyNow, projectByKey } from '../services/schema-cache';
import { addWatchers, whoSees } from '../services/watchers';
import { escapeMd, cutTo, firstLine, FORM_MAX } from './markdown';
import { whyNotFor } from './service';

/** How long a form stays open. */
export const FORM_TTL_MS = 60 * 60_000;
/** Replies from a thread a description takes, and files a source links. */
export const REPLIES_MAX = 20;
export const FILES_MAX = 10;
/** The window issues from chat are counted in, per person. */
export const RATE_WINDOW_MS = 10 * 60_000;
/** The description with its replies, at most: well within an issue's 100,000 characters. */
const DESCRIPTION_MAX = 60_000;

type DraftRow = typeof chatIssueSources.$inferSelect;

/** A message as its chat gave it, read and converted, before a form is opened on it. */
export interface ChatMessage {
  platform: ChatPlatform;
  workspace: { id: string | null; name: string };
  channel: { id: string | null; name: string };
  ref: string;
  thread: string;
  url: string | null;
  author: { name: string; externalId: string | null; userId: string | null };
  sentAt: Date | null;
  /** The message as Markdown, whole. */
  markdown: string;
  files: ChatSourceFile[];
  moreFiles: number;
}

/** What a form says, worded by its chat's own code. */
export interface IssueForm {
  draft: string;
  projects: { key: string; name: string }[];
  /** The project chosen for them: the one the channel is told of, when it's one they may create in. */
  project: string | null;
  summary: string;
  description: string;
  /** Whether the description was cut to fit the form. */
  cut: boolean;
  files: number;
}

/** Why a form wasn't taken, in its person's language, and which of its parts it's about. */
export interface Refusal {
  refused: true;
  field: 'project' | 'summary' | 'form';
  text: string;
}

export const refusal = (field: Refusal['field'], text: string): Refusal => ({ refused: true, field, text });
export const isRefusal = (x: unknown): x is Refusal => typeof x === 'object' && x !== null && (x as Refusal).refused === true;

/** The projects someone may create issues in, by name: all a form offers. */
export async function creatableProjects(ctx: Ctx): Promise<{ id: string; key: string; name: string }[]> {
  const s = await ctx.app.schema.get();
  const view = await projectAccess(ctx);
  return [...s.projects.values()]
    .filter((p) => !p.archived && view.allows(p.id, 'create'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({ id: p.id, key: p.key, name: p.name }));
}

/** Issues someone made from chat in the last ten minutes. */
async function madeLately(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(chatIssueSources)
    .where(and(eq(chatIssueSources.createdById, userId), gt(chatIssueSources.madeAt, new Date(Date.now() - RATE_WINDOW_MS))));
  return Number(row?.n ?? 0);
}

const tooFast = (ctx: Ctx, tr: Translator) => refusal('form', tr.t('server.chat.issue.tooFast', { n: ctx.app.config.chatIssueLimit }));

/**
 * Open a form on a message, for someone acting as themselves: refused when they make issues too fast,
 * or may create them nowhere. `externalUserId` is who they are in the chat: only they may send it.
 */
export async function openIssueForm(ctx: Ctx, externalUserId: string, msg: ChatMessage, tr: Translator): Promise<IssueForm | Refusal> {
  const me = ctx.actor.user;
  if ((await madeLately(ctx.db, me.id)) >= ctx.app.config.chatIssueLimit) return tooFast(ctx, tr);
  const projects = await creatableProjects(ctx);
  if (!projects.length) return refusal('form', tr.t('server.chat.issue.noProjects'));
  // The project the channel is told of, when it's one: what the message is most likely about.
  let project: string | null = null;
  if (msg.channel.id) {
    const told = await ctx.db
      .select({ projectId: chatSubscriptions.projectId })
      .from(chatSubscriptions)
      .where(and(eq(chatSubscriptions.channelId, msg.channel.id), isNull(chatSubscriptions.endedAt)));
    const keys = [...new Set(told.map((t) => projects.find((p) => p.id === t.projectId)?.key).filter((k): k is string => Boolean(k)))];
    if (keys.length === 1) project = keys[0]!;
  }
  const description = cutTo(msg.markdown, FORM_MAX);
  const id = newId();
  await ctx.db.insert(chatIssueSources).values({
    id,
    platform: msg.platform,
    workspaceId: msg.workspace.id,
    workspaceName: msg.workspace.name.slice(0, 200),
    channelId: msg.channel.id,
    channelName: msg.channel.name.slice(0, 200),
    messageRef: msg.ref,
    threadRef: msg.thread,
    url: msg.url,
    authorName: (msg.author.name || '?').slice(0, 200),
    authorExternalId: msg.author.externalId,
    authorUserId: msg.author.userId,
    sentAt: msg.sentAt,
    files: msg.files.slice(0, FILES_MAX),
    moreFiles: msg.moreFiles + Math.max(0, msg.files.length - FILES_MAX),
    cut: description.cut,
    createdById: me.id,
    createdByExternalId: externalUserId,
    expiresAt: new Date(Date.now() + FORM_TTL_MS),
  });
  return {
    draft: id,
    projects: projects.map((p) => ({ key: p.key, name: p.name })),
    project,
    summary: firstLine(msg.markdown),
    description: description.text,
    cut: description.cut,
    files: Math.min(msg.files.length, FILES_MAX),
  };
}

/** The form someone sends: theirs, from the chat they opened it in, and open still (or made already). Null otherwise. */
export async function draftFor(db: Db, id: string, platform: ChatPlatform, user: UserRow, externalUserId: string): Promise<DraftRow | null> {
  if (!id) return null;
  const [row] = await db.select().from(chatIssueSources).where(eq(chatIssueSources.id, id));
  if (!row || row.platform !== platform || row.createdById !== user.id || row.createdByExternalId !== externalUserId) return null;
  if (!row.issueId && row.expiresAt.getTime() < Date.now()) return null;
  return row;
}

/**
 * What can be checked before the chat is asked anything more: a project they may create in (any other
 * is missing, in the words a request for it gets), a summary, and not too many issues lately.
 */
export async function checkIssueForm(ctx: Ctx, input: { project: string; summary: string }, tr: Translator): Promise<{ key: string } | Refusal> {
  const projects = await creatableProjects(ctx);
  const s = await ctx.app.schema.get();
  const named = input.project.trim();
  const project = named ? projectByKey(s, keyNow(s, named)) : undefined;
  const mine = project ? projects.find((p) => p.id === project.id) : undefined;
  if (!named) return refusal('project', tr.t('server.chat.issue.projectNeeded'));
  if (!mine) {
    // One they can't see, or may not create in, is missing: as the API says it.
    const open = projects.map((p) => p.key);
    return refusal('project', tr.t('problem.issues.projectNotFound', { project: named.slice(0, 50), n: open.length, projects: open.join(', ') }));
  }
  if (!input.summary.trim()) return refusal('summary', tr.t('server.chat.issue.summaryNeeded'));
  if ((await madeLately(ctx.db, ctx.actor.user.id)) >= ctx.app.config.chatIssueLimit) return tooFast(ctx, tr);
  return { key: mine.key };
}

/** A reply in the thread, read from the chat when the form is sent. */
export interface ChatReply {
  author: string;
  markdown: string;
}

/**
 * The description: what the form held, then the thread's replies, each quoted under its author's name.
 * No words of a4a's own go in, so it reads the same in every language.
 */
export function describeWithReplies(description: string, replies: ChatReply[]): { text: string; cut: boolean } {
  if (!replies.length) return { text: description.trim(), cut: false };
  let cut = false;
  const quoted = replies.map((r) => {
    const one = cutTo(r.markdown, FORM_MAX);
    cut ||= one.cut;
    const body = one.text
      .split('\n')
      .map((l) => (l ? `> ${l}` : '>'))
      .join('\n');
    return `**${escapeMd(r.author)}**\n\n${body}`;
  });
  const whole = cutTo([description.trim(), '---', ...quoted].filter(Boolean).join('\n\n'), DESCRIPTION_MAX);
  return { text: whole.text, cut: cut || whole.cut };
}

/** Thrown inside the making transaction, to roll it back. */
class NotMade extends Error {
  constructor(readonly why: 'again' | 'tooFast') {
    super(why);
  }
}

/** The issue a form made, and whether it was made just now or before. */
export interface MadeIssue {
  issue: IssueDetail;
  again: boolean;
}

/**
 * Make the issue a form asks for, as its person, through the one write path: its source claimed in the
 * same transaction, so a form makes one issue however often it's sent; how many they made lately counted
 * again under a lock of theirs; and the message's author watching it, when they're linked and see it.
 * Its `issue.created` event says where it came from (`data.chat`), with no more of the message than the
 * issue holds.
 */
export async function makeChatIssue(
  ctx: Ctx,
  draft: DraftRow,
  input: { project: string; summary: string; description: string; replies: number; cut: boolean },
  tr: Translator,
): Promise<MadeIssue | Refusal> {
  if (draft.issueId) return { issue: await getIssue(ctx, draft.issueId), again: true };
  const me = ctx.actor.user;
  const limit = ctx.app.config.chatIssueLimit;
  const source = {
    platform: draft.platform,
    workspace: draft.workspaceName,
    channel: draft.channelName,
    url: draft.url,
    author: draft.authorName,
    sentAt: draft.sentAt?.toISOString() ?? null,
  };
  try {
    const issue = await createIssue(
      ctx,
      { project: input.project, summary: input.summary.trim().slice(0, 500), description: input.description },
      {
        data: { chat: source },
        inTransaction: async (tx, row) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`chat-issues:${me.id}`}))`);
          if ((await madeLately(tx, me.id)) >= limit) throw new NotMade('tooFast');
          const claimed = await tx
            .update(chatIssueSources)
            .set({ issueId: row.id, madeAt: new Date(), replies: input.replies, cut: draft.cut || input.cut })
            .where(and(eq(chatIssueSources.id, draft.id), isNull(chatIssueSources.issueId)))
            .returning({ id: chatIssueSources.id });
          if (!claimed.length) throw new NotMade('again');
          // The message is theirs: they hear what becomes of it, when they're someone a4a knows who sees it.
          const s = await ctx.app.schema.get(tx);
          const author = draft.authorUserId ? s.users.get(draft.authorUserId) : undefined;
          if (author) await addWatchers(tx, s, row, [{ login: author.login, reason: 'message' }], await whoSees(tx, s, row.projectId, [author.login], row));
        },
      },
    );
    return { issue, again: false };
  } catch (e) {
    if (e instanceof NotMade && e.why === 'tooFast') return tooFast(ctx, tr);
    if (e instanceof NotMade) {
      const [made] = await ctx.db.select({ issueId: chatIssueSources.issueId }).from(chatIssueSources).where(eq(chatIssueSources.id, draft.id));
      if (made?.issueId) return { issue: await getIssue(ctx, made.issueId), again: true };
    }
    // What the project asks of a new issue (a required field, a guard) is said as it would be anywhere.
    if (e instanceof AppError) return refusal('form', problemFor(tr, e));
    throw e;
  }
}

/**
 * Whether the message's thread may be told of the issue, by a link everyone in the channel reads: D42's
 * line, as a subscription draws it. The issue isn't limited to some people, and whoever made it may vouch
 * for the channel's people for its project: one open to everyone, which they read; one open to its
 * members alone, which they manage. Otherwise nothing is posted, and only they are told.
 */
export async function threadMayHear(ctx: Ctx, issue: IssueDetail): Promise<boolean> {
  if (issue.limited) return false;
  const s = await ctx.app.schema.get();
  const project = projectByKey(s, issue.project.key);
  if (!project) return false;
  return !(await whyNotFor(ctx.db, ctx.actor.user.id, project.id, project.name));
}

/**
 * A request from Teams or Slack seen for the first time: true, and kept until `until`; false when it was
 * seen before, a replay.
 */
export async function firstTime(db: Db, key: string, until: Date): Promise<boolean> {
  const rows = await db.insert(chatRequestsSeen).values({ key, expiresAt: until }).onConflictDoNothing().returning({ key: chatRequestsSeen.key });
  return rows.length > 0;
}

/** Forms never sent, and requests past their window: a chore of the lease holder's. */
export async function pruneChatIssues(db: Db, now = new Date()): Promise<void> {
  await db.delete(chatIssueSources).where(and(isNull(chatIssueSources.issueId), lt(chatIssueSources.expiresAt, now)));
  await db.delete(chatRequestsSeen).where(lt(chatRequestsSeen.expiresAt, now));
}
