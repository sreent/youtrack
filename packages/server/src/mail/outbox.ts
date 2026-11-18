/**
 * The mail outbox: mail is a row first, written in the transaction that calls for it, and sent
 * after, at least once. A sender claims a few due rows at a time (FOR UPDATE SKIP LOCKED, with a
 * lease), so any number of instances can send without sending one twice at once; a sender that
 * dies mid-send loses its lease and another tries again, under the same Message-ID.
 *
 * Without SMTP_URL nothing is enqueued and nothing is sent: email is never on the path a request
 * takes, so a mail server that's down or missing breaks nothing but email.
 */
import { and, asc, eq, inArray, isNull, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import type { AppServices } from '../context';
import type { Db } from '../db/client';
import { mailOutbox, notifications, notificationSettings, users } from '../db/schema';
import { newId } from '../lib/ids';
import { mailConfigured, mailTransport, notifyState } from '../notify/state';
import { localDate, zonedTime } from '../reports/tz';
import { zoneOfUser } from '../services/time-zones';
import { renderMail } from './render';
import { PermanentMailError } from './transport';

export type MailKind = 'notification' | 'digest' | 'request-received' | 'request-reply' | 'request-state' | 'request-relay' | 'email-confirm' | 'portal-sign-in' | 'portal-password' | 'portal-account' | 'passkey';
export type MailRow = typeof mailOutbox.$inferSelect;

const POLL_MS = 5_000;
const BATCH = 10;
/** How long a sender holds a claimed mail before another may try it. */
const LEASE_MS = 2 * 60_000;
/** Waits after each failed attempt; after the last, it gives up. */
export const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

export interface MailRequest {
  kind: MailKind;
  /** One mail per thing it is about: enqueueing the same key again does nothing. */
  dedupeKey: string;
  userId?: string | null;
  payload: Record<string, unknown>;
  sendAfter?: Date;
  /** The Message-ID's local part, e.g. "n-abc123"; the host comes from PUBLIC_URL. */
  messageId: string;
}

export function mailHost(app: AppServices): string {
  try {
    return new URL(app.config.publicUrl).hostname || 'localhost';
  } catch {
    return 'localhost';
  }
}

/** Queue a mail in the caller's transaction. False when there's no SMTP, or it was queued already. */
export async function enqueueMail(db: Db, app: AppServices, req: MailRequest): Promise<boolean> {
  if (!mailConfigured(app)) return false;
  const rows = await db
    .insert(mailOutbox)
    .values({
      id: newId(),
      dedupeKey: req.dedupeKey,
      kind: req.kind,
      userId: req.userId ?? null,
      payload: req.payload,
      sendAfter: req.sendAfter ?? new Date(),
      messageId: `<${req.messageId}@${mailHost(app)}>`,
    })
    .onConflictDoNothing()
    .returning({ id: mailOutbox.id });
  return rows.length > 0;
}

/** Wake this process's sender after a commit that queued mail. */
export function kickMail(app: AppServices): void {
  notifyState(app).kickMail?.();
}

/** Claim the due mail: at most `limit` rows, leased to this sender. */
async function claim(db: Db, now: Date, limit: number): Promise<MailRow[]> {
  const due = db
    .select({ id: mailOutbox.id })
    .from(mailOutbox)
    .where(and(eq(mailOutbox.status, 'pending'), lte(mailOutbox.sendAfter, now), or(isNull(mailOutbox.lockedUntil), lt(mailOutbox.lockedUntil, now))))
    .orderBy(asc(mailOutbox.sendAfter))
    .limit(limit)
    .for('update', { skipLocked: true });
  return db
    .update(mailOutbox)
    .set({ lockedUntil: new Date(now.getTime() + LEASE_MS), attempts: sql`${mailOutbox.attempts} + 1` })
    .where(inArray(mailOutbox.id, due))
    .returning();
}

/** Render, send and record one claimed mail. */
async function sendOne(app: AppServices, row: MailRow, now: Date): Promise<'sent' | 'skipped' | 'retry' | 'failed'> {
  const transport = mailTransport(app);
  if (!transport) return 'retry';
  let rendered;
  try {
    rendered = await renderMail(app, row);
  } catch (e) {
    return record(app, row, now, e);
  }
  if (!rendered) {
    await app.db.update(mailOutbox).set({ status: 'skipped', lockedUntil: null }).where(eq(mailOutbox.id, row.id));
    return 'skipped';
  }
  try {
    await transport.send({
      from: rendered.from ?? app.config.mailFrom,
      to: rendered.to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      messageId: row.messageId,
      headers: rendered.headers,
    });
  } catch (e) {
    await rendered.onFailed?.().catch(() => {});
    return record(app, row, now, e);
  }
  await app.db
    .update(mailOutbox)
    .set({ status: 'sent', sentAt: new Date(), toAddress: rendered.to, lockedUntil: null, lastError: null })
    .where(eq(mailOutbox.id, row.id));
  await rendered.onSent?.().catch((e) => console.error(`mail ${row.id}: after sending`, e));
  return 'sent';
}

async function record(app: AppServices, row: MailRow, now: Date, e: unknown): Promise<'retry' | 'failed'> {
  const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
  const giveUp = e instanceof PermanentMailError || row.attempts >= MAX_ATTEMPTS;
  const wait = BACKOFF_MS[Math.min(row.attempts, BACKOFF_MS.length) - 1] ?? BACKOFF_MS[0]!;
  await app.db
    .update(mailOutbox)
    .set({ status: giveUp ? 'failed' : 'pending', sendAfter: new Date(now.getTime() + wait), lockedUntil: null, lastError: message })
    .where(eq(mailOutbox.id, row.id));
  console.warn(`mail ${row.id} (${row.kind}) attempt ${row.attempts} failed${giveUp ? ', giving up' : ''}: ${message}`);
  return giveUp ? 'failed' : 'retry';
}

/**
 * Queue today's digest for everyone who wants one, once the digest hour has come where they are (D31:
 * their time zone, or the server's): once per person per day of theirs. The lease holder does it (a
 * chore, every ten minutes), and the dedupe key keeps it once should a new holder do it again.
 */
export async function scheduleDigests(app: AppServices, now: Date = new Date()): Promise<number> {
  if (!mailConfigured(app)) return 0;
  const wanting = await app.db
    .select({ userId: notificationSettings.userId, last: notificationSettings.lastDigestAt, timeZone: users.timeZone })
    .from(notificationSettings)
    .innerJoin(users, eq(users.id, notificationSettings.userId))
    .where(and(eq(notificationSettings.digest, true), eq(users.banned, false)));
  let queued = 0;
  for (const d of wanting) {
    const zone = zoneOfUser(d);
    const day = localDate(now.getTime(), zone);
    const [y, m, dd] = day.split('-').map(Number) as [number, number, number];
    // Today's digest hour where they are; where clocks skip it, the moment after.
    const due = zonedTime(y, m, dd, app.config.digestHour, 0, 0, zone);
    if (now.getTime() < due || (d.last && d.last.getTime() >= due)) continue;
    const since = d.last ?? new Date(now.getTime() - 24 * 3_600_000);
    const ok = await enqueueMail(app.db, app, {
      kind: 'digest',
      dedupeKey: `digest:${d.userId}:${day}`,
      userId: d.userId,
      payload: { userId: d.userId, since: since.toISOString(), until: now.toISOString() },
      messageId: `digest-${d.userId}-${day}`,
    });
    if (ok) queued++;
  }
  return queued;
}

/** What's kept: sent or settled mail for 30 days, read notifications for 180. A chore of the lease holder's. */
export async function pruneMail(app: AppServices, now: Date = new Date()): Promise<void> {
  await app.db
    .delete(mailOutbox)
    .where(and(notInArray(mailOutbox.status, ['pending']), lt(mailOutbox.createdAt, new Date(now.getTime() - 30 * 86_400_000))));
  await app.db.delete(notifications).where(lt(notifications.readAt, new Date(now.getTime() - 180 * 86_400_000)));
}

/**
 * Sends what's due, every few seconds and when woken. One per instance: the claims keep instances
 * apart, so mail goes out as long as any of them runs. Digests and pruning are the lease holder's
 * chores (notify/register.ts), done once for all.
 */
export class MailWorker {
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
    notifyState(this.app).kickMail = () => this.kick();
    this.timer = setInterval(() => this.kick(), POLL_MS);
    this.timer.unref?.();
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (notifyState(this.app).kickMail) notifyState(this.app).kickMail = null;
    await this.running;
    mailTransport(this.app)?.close?.();
  }

  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.kicked = true;
      return;
    }
    this.running = this.tick()
      .catch((e) => console.error('mail sender tick failed', e))
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
    if (!mailConfigured(this.app)) return;
    const now = this.clock();
    for (;;) {
      if (this.stopped) return;
      const batch = await claim(this.app.db, now, BATCH);
      for (const row of batch) await sendOne(this.app, row, now);
      if (batch.length < BATCH) return;
    }
  }
}
