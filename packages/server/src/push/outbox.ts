/**
 * Pushes to send (D47), as mail is sent (mail/outbox.ts): a row per device, written in the
 * notifier's transaction, claimed by any instance a few at a time (FOR UPDATE SKIP LOCKED, with a
 * lease), sent at least once and retried with backoff.
 *
 * - When: a moment after the notification is made (PUSH_SETTLE_MS), so a burst of changes to one
 *   issue goes as one push; and again only if the notification comes to call on the person more (a
 *   mention folding into what they watch). On the device, pushes about one issue replace each other.
 * - What: worked out when it's sent, from what's true then. Nothing goes if the notification was
 *   read meanwhile, if the person no longer wants pushes of its kind, if they can no longer see it
 *   (the project, or the issue limited away from them, D37), or if the device's sign-in has ended.
 */
import type { EmailLevel, IssueRef, NotificationKind } from '@a4a/shared';
import { and, asc, eq, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { effectiveScopes, type AppServices, type Ctx } from '../context';
import type { Db } from '../db/client';
import { notifications, notificationSettings, pushOutbox, pushSubscriptions, users } from '../db/schema';
import { newId } from '../lib/ids';
import { eventDetail, notificationTitle } from '../notify/words';
import { accessFor, eventFor, eventSeen } from '../services/access';
import { eventsOf, unreadCount } from '../services/notifications';
import { deviceSignedIn, noteOutcome, sendPush, topicFor, type DeviceRow, type PushOptions, type PushPayload } from './service';
import { localeOfPerson, translatorFor } from '../i18n';

/** How long after a notification is made its push waits, so what follows at once goes with it. */
export const PUSH_SETTLE_MS = 5_000;
const POLL_MS = 5_000;
const BATCH = 20;
const LEASE_MS = 60_000;
/** Waits after each failed attempt; after the last, it gives up: a push hours late is no use. */
export const PUSH_BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];
export const MAX_PUSH_ATTEMPTS = PUSH_BACKOFF_MS.length + 1;

type PushRow = typeof pushOutbox.$inferSelect;

/** Whether the person's push level sends this kind: as email's does, but "all" takes what they subscribed to too. */
export function pushSends(level: EmailLevel, kind: NotificationKind): boolean {
  if (level === 'none') return false;
  if (kind === 'watching' || kind === 'subscribed') return level === 'all';
  return true;
}

/** What wakes this process's sender, when one runs in it. */
const kicks = new WeakMap<AppServices, () => void>();

/** Wake the sender once what was just queued is due. */
export function kickPushSoon(app: AppServices, delayMs = PUSH_SETTLE_MS + 50): void {
  const kick = kicks.get(app);
  if (!kick) return;
  setTimeout(kick, delayMs).unref?.();
}

/**
 * Queue a notification's push to each of its person's devices, in the notifier's transaction.
 * Once per notification, device and kind: the same kind folding in again pushes nothing new.
 */
export async function enqueuePushes(tx: Db, app: AppServices, n: { id: string; userId: string; kind: NotificationKind }, level: EmailLevel): Promise<number> {
  if (!app.config.push.enabled || !pushSends(level, n.kind)) return 0;
  const devices = await tx.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, n.userId));
  if (!devices.length) return 0;
  const sendAfter = new Date(Date.now() + PUSH_SETTLE_MS);
  const rows = await tx
    .insert(pushOutbox)
    .values(devices.map((d) => ({ id: newId(), dedupeKey: `n:${n.id}:${n.kind}:${d.id}`, subscriptionId: d.id, notificationId: n.id, sendAfter })))
    .onConflictDoNothing()
    .returning({ id: pushOutbox.id });
  return rows.length;
}

const URGENT: NotificationKind[] = ['assigned', 'mentioned', 'request'];

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** What a notification's push says, from what's true now; null when it should say nothing. */
export async function renderNotificationPush(app: AppServices, notificationId: string, userId: string): Promise<{ payload: PushPayload; options: PushOptions } | null> {
  const [n] = await app.db.select().from(notifications).where(eq(notifications.id, notificationId));
  if (!n || n.readAt || n.userId !== userId) return null;
  const [user] = await app.db.select().from(users).where(eq(users.id, userId));
  if (!user || user.banned || user.isBot) return null;
  const kind = n.kind as NotificationKind;
  const [prefs] = await app.db.select({ push: notificationSettings.push }).from(notificationSettings).where(eq(notificationSettings.userId, userId));
  if (!pushSends(((prefs?.push ?? 'direct') as EmailLevel), kind)) return null;
  // What the person may see now, as they would signing in: the project, and each event in it.
  const view = await accessFor(app.db, user);
  if (!n.projectId || !view.canRead(n.projectId)) return null;
  const s = await app.schema.get();
  // Read fresh: a push goes seconds after the change, within the moment access keeps what it read.
  const { events, reasons } = (await eventsOf(app.db, s, [n.id], { visible: (e) => eventSeen(view, app.db, s, e, { fresh: true }), shape: (e) => eventFor(view, s, e) })).get(n.id) ?? { events: [], reasons: new Map() };
  if (!events.length) return null;
  const issue = n.issue as IssueRef;
  const tr = translatorFor(localeOfPerson(app, user));
  const said = notificationTitle(tr, kind, events, reasons);
  const latest = events[events.length - 1]!;
  const detail = eventDetail(tr, latest)[0];
  // The badge: what's unread for them, counted as their inbox counts it.
  const asThem: Ctx = { app, db: app.db, actor: { user, scopes: effectiveScopes(user.role), channel: 'web', tokenId: null, tokenName: null, authMethod: 'system' } };
  const unread = await unreadCount(asThem).catch(() => null);
  return {
    payload: {
      title: clip(`${issue.id}: ${issue.summary}`, 120),
      body: detail ? `${clip(said, 120)}\n${clip(detail, 160)}` : clip(said, 120),
      tag: `issue-${n.issueId ?? n.id}`,
      url: n.issueId ? `/issues/${encodeURIComponent(issue.id)}` : '/inbox',
      unread,
      renotify: true,
    },
    options: { urgency: URGENT.includes(kind) ? 'high' : 'normal', topic: topicFor(n.issueId ?? n.id) },
  };
}

/** Claim the due pushes: at most `limit` rows, leased to this sender. */
async function claim(db: Db, now: Date, limit: number): Promise<PushRow[]> {
  const due = db
    .select({ id: pushOutbox.id })
    .from(pushOutbox)
    .where(and(eq(pushOutbox.status, 'pending'), lte(pushOutbox.sendAfter, now), or(isNull(pushOutbox.lockedUntil), lt(pushOutbox.lockedUntil, now))))
    .orderBy(asc(pushOutbox.sendAfter))
    .limit(limit)
    .for('update', { skipLocked: true });
  return db
    .update(pushOutbox)
    .set({ lockedUntil: new Date(now.getTime() + LEASE_MS), attempts: sql`${pushOutbox.attempts} + 1` })
    .where(inArray(pushOutbox.id, due))
    .returning();
}

async function settle(app: AppServices, row: PushRow, status: 'sent' | 'skipped' | 'failed', error: string | null = null): Promise<void> {
  await app.db
    .update(pushOutbox)
    .set({ status, lockedUntil: null, lastError: error, ...(status === 'sent' ? { sentAt: new Date() } : {}) })
    .where(eq(pushOutbox.id, row.id));
}

/** Render, send and record one claimed push. */
export async function sendOnePush(app: AppServices, row: PushRow, now: Date): Promise<'sent' | 'skipped' | 'retry' | 'failed'> {
  const [device] = await app.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, row.subscriptionId));
  if (!device) return 'skipped'; // forgotten meanwhile: its rows went with it
  if (!(await deviceSignedIn(app, device))) {
    await app.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, device.id));
    return 'skipped';
  }
  const rendered = await renderNotificationPush(app, row.notificationId, device.userId);
  if (!rendered) {
    await settle(app, row, 'skipped');
    return 'skipped';
  }
  const outcome = await sendPush(app, device as DeviceRow, rendered.payload, rendered.options);
  const noted = await noteOutcome(app, device, outcome);
  if (outcome.ok) {
    await settle(app, row, 'sent');
    return 'sent';
  }
  if (noted === 'ended') return 'failed'; // the device is forgotten, and its rows with it
  if (outcome.permanent || row.attempts >= MAX_PUSH_ATTEMPTS) {
    await settle(app, row, 'failed', outcome.error);
    return 'failed';
  }
  const wait = Math.max(outcome.retryAfterMs ?? 0, PUSH_BACKOFF_MS[Math.min(row.attempts, PUSH_BACKOFF_MS.length) - 1] ?? PUSH_BACKOFF_MS[0]!);
  await app.db
    .update(pushOutbox)
    .set({ sendAfter: new Date(now.getTime() + wait), lockedUntil: null, lastError: outcome.error })
    .where(eq(pushOutbox.id, row.id));
  return 'retry';
}

/** Sent or settled pushes are kept a week, for what a device last refused; then they go. A chore of the lease holder's. */
export async function prunePush(app: AppServices, now: Date = new Date()): Promise<void> {
  await app.db.delete(pushOutbox).where(and(ne(pushOutbox.status, 'pending'), lt(pushOutbox.createdAt, new Date(now.getTime() - 7 * 86_400_000))));
}

/**
 * Sends what's due, every few seconds and when woken. One per instance, as mail's: the claims keep
 * instances apart, so pushes go out as long as any of them runs.
 */
export class PushWorker {
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
      .catch((e) => console.error('push sender tick failed', e))
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
    if (!this.app.config.push.enabled) return;
    const now = this.clock();
    for (;;) {
      if (this.stopped) return;
      const batch = await claim(this.app.db, now, BATCH);
      for (const row of batch) {
        try {
          await sendOnePush(this.app, row, now);
        } catch (e) {
          // One push's failure (the database, a key that won't open) mustn't stop the rest: it's tried
          // again when its lease runs out, until its attempts are spent.
          console.error(`push ${row.id} failed`, e);
          if (row.attempts >= MAX_PUSH_ATTEMPTS) await settle(this.app, row, 'failed', e instanceof Error ? e.message : String(e)).catch(() => {});
        }
      }
      if (batch.length < BATCH) return;
    }
  }
}
