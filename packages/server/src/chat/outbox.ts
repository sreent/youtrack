/**
 * A channel's news (D42). The outbox's consumer finds the subscriptions an event reaches, checks it
 * against the line no post crosses, and writes one row per channel; a sender on every instance posts
 * the due rows, as mail goes (mail/outbox.ts), retrying what Teams or Slack asks it to wait for.
 *
 * The line: a channel holds people a4a can't vouch for, so it's told only what every reader of the
 * project may see. Nothing limited to some people (an issue, a comment, a link's other end), no help
 * desk internal comment, nothing an import brought; checked when the row is written and again when
 * it's sent, so an issue limited in between isn't posted, and isn't updated in the channel again.
 */
import type { ChatChangeKind, TrackerEvent } from '@a4a/shared';
import { and, asc, eq, inArray, isNull, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import type { AppServices } from '../context';
import type { Db } from '../db/client';
import { activities, chatChannels, chatOutbox, chatSubscriptions, chatWorkspaces, comments, helpdeskRequests, issues, savedSearches } from '../db/schema';
import type { OutboxConsumer } from '../events/worker';
import { newId } from '../lib/ids';
import { prepareQuery } from '../search/service';
import { assigneeFieldIdOf, eventFor, eventLimited } from '../services/access';
import { personCtx } from '../services/subscriptions';
import { meets } from '../workflow/match';
import { ChatCallError, stopError, stopReason } from './common';
import { issueForCard, markChannelGone, markWorkspaceRemoved, whyNotFor } from './service';
import { slackPost } from './slack';
import { teamsChannelPost, teamsSend } from './teams';

type Row = typeof chatOutbox.$inferSelect;

const EVENT_TYPES = ['issue.created', 'issue.updated', 'comment.created'] as const;
const POLL_MS = 5_000;
const BATCH = 10;
const LEASE_MS = 2 * 60_000;
/** Waits after each failed attempt; after the last, it gives up. */
export const CHAT_BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 2 * 3_600_000];
const MAX_ATTEMPTS = CHAT_BACKOFF_MS.length + 1;

/** The kinds of change an event is. */
export function kindsOf(app: AppServices, s: Awaited<ReturnType<AppServices['schema']['get']>>, event: TrackerEvent): ChatChangeKind[] {
  if (event.type === 'issue.created') return ['created'];
  if (event.type === 'comment.created') return ['commented'];
  if (event.type !== 'issue.updated') return [];
  const assignee = assigneeFieldIdOf(s);
  const assigneeName = assignee ? s.fields.get(assignee)?.name : undefined;
  const states = new Set([...s.fields.values()].filter((f) => f.type === 'state').map((f) => f.name));
  const kinds = new Set<ChatChangeKind>();
  for (const c of event.changes) kinds.add(states.has(c.field) ? 'state' : c.field === assigneeName ? 'assigned' : 'fields');
  return [...kinds];
}

/** Whether the event is one no channel may be told of, whoever subscribed it. */
async function offLimits(app: AppServices, event: TrackerEvent, issueId: string): Promise<boolean> {
  const s = await app.schema.get();
  if ((event.data as { imported?: unknown }).imported) return true;
  if (await eventLimited(app.db, s, event)) return true;
  const [issue] = await app.db.select({ limited: issues.limited }).from(issues).where(eq(issues.id, issueId));
  if (!issue || issue.limited) return true;
  if (event.type === 'comment.created') {
    const commentId = (event.data as { commentId?: unknown }).commentId;
    if (typeof commentId !== 'string') return true;
    const [c] = await app.db.select({ limited: comments.limited, visibility: comments.visibility, deletedAt: comments.deletedAt }).from(comments).where(eq(comments.id, commentId));
    if (!c || c.limited || c.deletedAt) return true;
    // On a help desk request, the team's internal notes stay the team's.
    const [request] = await app.db.select({ id: helpdeskRequests.issueId }).from(helpdeskRequests).where(eq(helpdeskRequests.issueId, issueId));
    if (request && c.visibility !== 'public') return true;
  }
  return false;
}

/** Wake this instance's sender. */
const kicks = new WeakMap<AppServices, () => void>();
export const kickChat = (app: AppServices) => kicks.get(app)?.();

export function chatConsumer(app: AppServices): OutboxConsumer {
  return {
    name: 'chat',
    types: [...EVENT_TYPES],
    handle: async (event) => {
      if (await queueChatPosts(app, event)) kickChat(app);
    },
  };
}

/** Write the rows an event calls for; how many. */
export async function queueChatPosts(app: AppServices, event: TrackerEvent): Promise<number> {
  const subs = await app.db
    .select({ sub: chatSubscriptions })
    .from(chatSubscriptions)
    .innerJoin(chatChannels, eq(chatChannels.id, chatSubscriptions.channelId))
    .innerJoin(chatWorkspaces, eq(chatWorkspaces.id, chatChannels.workspaceId))
    .where(and(isNull(chatSubscriptions.endedAt), isNull(chatChannels.goneAt), isNull(chatWorkspaces.removedAt)));
  if (!subs.length) return 0;
  const s = await app.schema.get();
  // What every reader may see of it: a change only to private fields is nothing to a channel (D50).
  const shown = eventFor(null, s, event);
  if (!shown) return 0;
  const kinds = kindsOf(app, s, shown);
  if (!kinds.length) return 0;
  const [row] = await app.db.select({ issueId: activities.issueId, projectId: activities.projectId }).from(activities).where(eq(activities.id, event.id));
  if (!row?.issueId || !row.projectId) return 0;
  if (await offLimits(app, event, row.issueId)) return 0;
  const project = s.projects.get(row.projectId);
  if (!project) return 0;
  let queued = 0;
  for (const { sub } of subs) {
    if (!sub.kinds.some((k) => kinds.includes(k as ChatChangeKind))) continue;
    // A channel hears of what happens from when it's subscribed, however late the outbox hands it over.
    if (new Date(event.occurredAt).getTime() < sub.createdAt.getTime()) continue;
    if (sub.projectId && sub.projectId !== row.projectId) continue;
    if (sub.savedSearchId && !(await inSearch(app, sub, row.issueId))) continue;
    // Its subscriber vouches for the channel: still, for this project?
    const why = await whyNotFor(app.db, sub.createdById, row.projectId, project.name);
    if (why) {
      // For a project's subscription that's the end of it; a search's only skips this project.
      if (sub.projectId) await app.db.update(chatSubscriptions).set({ endedAt: new Date(), endedReason: why.text, endedSaid: why.said }).where(eq(chatSubscriptions.id, sub.id));
      continue;
    }
    const inserted = await app.db
      .insert(chatOutbox)
      .values({ id: newId(), dedupeKey: `chat:${sub.channelId}:${event.id}`, channelId: sub.channelId, subscriptionId: sub.id, eventId: event.id, payload: { event: shown, issueId: row.issueId } })
      .onConflictDoNothing()
      .returning({ id: chatOutbox.id });
    queued += inserted.length;
  }
  return queued;
}

/** Whether an issue is in a saved search as the subscriber reads it. */
async function inSearch(app: AppServices, sub: typeof chatSubscriptions.$inferSelect, issueId: string): Promise<boolean> {
  if (!sub.createdById) return false;
  const s = await app.schema.get();
  const user = s.users.get(sub.createdById);
  if (!user || user.banned) return false;
  const [search] = await app.db.select().from(savedSearches).where(eq(savedSearches.id, sub.savedSearchId!));
  if (!search || !(search.shared || search.ownerId === user.id)) return false;
  // As every reader of the channel would read it: a search by a private field finds nothing for it (D50).
  const prepared = await prepareQuery(personCtx(app, user), search.query, { everyone: true });
  if (prepared.compiled.problems.length) return false;
  return (await meets(app.db, issueId, [prepared.compiled.where ?? sql`TRUE`]))[0] === true;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

async function claim(db: Db, now: Date): Promise<Row[]> {
  const due = db
    .select({ id: chatOutbox.id })
    .from(chatOutbox)
    .where(and(eq(chatOutbox.status, 'pending'), lte(chatOutbox.sendAfter, now), or(isNull(chatOutbox.lockedUntil), lt(chatOutbox.lockedUntil, now))))
    .orderBy(asc(chatOutbox.sendAfter), asc(chatOutbox.createdAt))
    .limit(BATCH)
    .for('update', { skipLocked: true });
  return db
    .update(chatOutbox)
    .set({ lockedUntil: new Date(now.getTime() + LEASE_MS), attempts: sql`${chatOutbox.attempts} + 1` })
    .where(inArray(chatOutbox.id, due))
    .returning();
}

const settle = (db: Db, id: string, set: Partial<Row>) => db.update(chatOutbox).set({ ...set, lockedUntil: null }).where(eq(chatOutbox.id, id));

/** Post one claimed row, as it stands now. */
export async function sendChatPost(app: AppServices, row: Row, now = new Date()): Promise<'sent' | 'skipped' | 'retry' | 'failed'> {
  const [where] = await app.db
    .select({ channel: chatChannels, workspace: chatWorkspaces })
    .from(chatChannels)
    .innerJoin(chatWorkspaces, eq(chatWorkspaces.id, chatChannels.workspaceId))
    .where(eq(chatChannels.id, row.channelId));
  const job = row.payload as { event: TrackerEvent; issueId: string };
  const [sub] = row.subscriptionId ? await app.db.select().from(chatSubscriptions).where(eq(chatSubscriptions.id, row.subscriptionId)) : [];
  const skip = async (why: string) => {
    await settle(app.db, row.id, { status: 'skipped', lastError: why });
    return 'skipped' as const;
  };
  if (!where || where.channel.goneAt || where.workspace.removedAt) return skip('The channel or the app is gone');
  if (!sub || sub.endedAt || !sub.createdById) return skip('The subscription stopped');
  // Checked again: limited, or a comment deleted, since it was written.
  if (await offLimits(app, job.event, job.issueId)) return skip('Not for a channel any more');
  const s = await app.schema.get();
  // Read again as every reader may see it: a field made private since isn't posted (D50).
  const event = eventFor(null, s, job.event);
  if (!event) return skip('Not for a channel any more');
  const subscriber = s.users.get(sub.createdById);
  if (!subscriber || subscriber.banned) return skip('Its subscriber can’t vouch for it any more');
  let issue;
  try {
    // The issue as its subscriber reads it, and only what everyone may: the channel hears what they vouch for, no more.
    issue = await issueForCard(personCtx(app, subscriber), job.issueId, { everyone: true });
  } catch {
    return skip('The issue is gone');
  }
  try {
    let ref: string | null;
    if (where.workspace.platform === 'teams') {
      if (!where.workspace.serviceUrl) throw stopError('removed', stopReason('The team has no service URL', 'chat.stop.noServiceUrl'));
      ref = await teamsSend(app, where.workspace.serviceUrl, where.channel.externalId, teamsChannelPost(app, issue, event));
    } else {
      ref = await slackPost(app, where.workspace, where.channel.externalId, issue, event);
    }
    await settle(app.db, row.id, { status: 'sent', sentAt: new Date(), messageRef: ref, lastError: null });
    return 'sent';
  } catch (e) {
    const err = e instanceof ChatCallError ? e : new ChatCallError(e instanceof Error ? e.message : String(e), 'retry');
    if (err.outcome === 'gone') await markChannelGone(app.db, where.channel.id, err.reason);
    if (err.outcome === 'removed') await markWorkspaceRemoved(app.db, where.workspace.id, err.reason);
    const giveUp = err.outcome !== 'retry' || row.attempts >= MAX_ATTEMPTS;
    const wait = Math.max(err.retryAfterMs ?? 0, CHAT_BACKOFF_MS[Math.min(row.attempts, CHAT_BACKOFF_MS.length) - 1] ?? CHAT_BACKOFF_MS[0]!);
    await settle(app.db, row.id, { status: giveUp ? 'failed' : 'pending', sendAfter: new Date(now.getTime() + wait), lastError: err.message.slice(0, 500) });
    console.warn(`chat: post ${row.id} attempt ${row.attempts} failed${giveUp ? ', giving up' : ''}: ${err.message}`);
    return giveUp ? 'failed' : 'retry';
  }
}

/** What's kept: posts sent or settled for 30 days. A chore of the lease holder's. */
export async function pruneChat(app: AppServices, now = new Date()): Promise<void> {
  await app.db.delete(chatOutbox).where(and(notInArray(chatOutbox.status, ['pending']), lt(chatOutbox.createdAt, new Date(now.getTime() - 30 * 86_400_000))));
}

/** Posts what's due, every few seconds and when woken; one per instance, kept apart by claims. */
export class ChatWorker {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private kicked = false;
  private stopped = false;

  constructor(
    private app: AppServices,
    private clock: () => Date = () => new Date(),
  ) {}

  start(): void {
    this.stopped = false;
    kicks.set(this.app, () => this.kick());
    this.timer = setInterval(() => this.kick(), POLL_MS);
    this.timer.unref?.();
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    kicks.delete(this.app);
    await this.running;
  }

  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.kicked = true;
      return;
    }
    this.running = this.tick()
      .catch((e) => console.error('chat sender tick failed', e))
      .finally(() => {
        this.running = null;
        if (this.kicked) {
          this.kicked = false;
          this.kick();
        }
      });
  }

  /** Send everything due now (tests). */
  async drain(): Promise<void> {
    await this.running;
    await this.tick();
  }

  private async tick(): Promise<void> {
    const now = this.clock();
    for (;;) {
      if (this.stopped) return;
      const batch = await claim(this.app.db, now);
      for (const row of batch) await sendChatPost(this.app, row, now);
      if (batch.length < BATCH) return;
    }
  }
}
