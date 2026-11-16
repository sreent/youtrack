import type { TrackerEvent } from '@a4a/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { AppServices } from '../context';
import { activities, outboxCursors, workerLeases } from '../db/schema';
import { newId } from '../lib/ids';
import { toEventDto } from './activity';
import { OrderedLog } from './ordered-log';

/** Something that reacts to committed tracker events, at least once, in order. */
export interface OutboxConsumer {
  name: string;
  /** Only events of these types are passed to handle(); others just advance the cursor. */
  types?: string[];
  handle(event: TrackerEvent): Promise<void>;
}

/** Periodic upkeep that must run on one instance only (it runs on the lease holder). */
export interface Chore {
  name: string;
  everyMs: number;
  run(): Promise<void>;
}

export interface WorkerOptions {
  /** How long a lease lasts without renewal: a dead holder is replaced within this, plus one poll. */
  leaseMs?: number;
  /** How often a standby tries for the lease, and the holder looks at the log unprompted. */
  pollMs?: number;
  batch?: number;
  /** Gap handling (see OrderedLog). */
  settleMs?: number;
  maxGapWaitMs?: number;
  /** The holder's name in `worker_leases`. Defaults to a random one. */
  holder?: string;
  /** Local clock, for the holder's own deadline only. The lease itself runs on the database's clock. */
  now?: () => number;
}

const LEASE_NAME = 'outbox';

/**
 * Drives every consumer from the activity log. Exactly one instance, the lease
 * holder, runs consumers at a time; the others stand by and take over when the lease
 * expires.
 *
 * - The lease is taken and checked on the database's clock, so instances whose clocks
 *   disagree can't both believe they hold it.
 * - The holder renews it every third of its length, also while a consumer is busy
 *   (a webhook with retries can take longer than the lease).
 * - The holder stops handing out events once its own deadline passes without a
 *   renewal, and a cursor only moves while its lease is still valid in the database,
 *   so a holder that stalled and lost the lease can't move a cursor its successor owns.
 * - Rows are read in id order without passing one that may still commit.
 */
export class OutboxWorker {
  readonly holder: string;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly batch: number;
  private readonly now: () => number;
  private readonly log: OrderedLog;
  /** Local time until which this instance may act as the holder; 0 when it doesn't hold the lease. */
  private leaseUntil = 0;
  private timer: NodeJS.Timeout | null = null;
  private renewTimer: NodeJS.Timeout | null = null;
  private recheck: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private kicked = false;
  private stopped = false;
  private unsubscribers: (() => void)[] = [];
  private choresDue = new Map<string, number>();

  constructor(
    private app: AppServices,
    private consumers: OutboxConsumer[],
    opts: WorkerOptions = {},
    private chores: Chore[] = [],
    private report: (msg: string, err?: unknown) => void = (m, e) => console.error(m, e ?? ''),
  ) {
    this.holder = opts.holder ?? `${process.pid}-${newId(8)}`;
    this.leaseMs = opts.leaseMs ?? 30_000;
    this.pollMs = opts.pollMs ?? 2_000;
    this.batch = opts.batch ?? 100;
    this.now = opts.now ?? Date.now;
    this.log = new OrderedLog(app.db, { settleMs: opts.settleMs, maxWaitMs: opts.maxGapWaitMs, now: this.now });
  }

  /** Whether this instance holds the lease now (by its own, cautious, reckoning). */
  get active(): boolean {
    return this.now() < this.leaseUntil;
  }

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => this.kick(), this.pollMs);
    this.timer.unref?.();
    this.renewTimer = setInterval(() => void this.renew(), Math.max(50, Math.floor(this.leaseMs / 3)));
    this.renewTimer.unref?.();
    // A commit here, or a NOTIFY from another instance, wakes the holder at once. Standbys
    // ignore them: they only wait for the lease, on the poll.
    this.unsubscribers.push(this.app.bus.subscribe(() => this.active && this.kick()));
    this.unsubscribers.push(this.app.signals.subscribe((s) => s.kind !== 'schema' && this.active && this.kick()));
    this.kick();
  }

  /**
   * Stop after the event in hand. `releaseLease: false` leaves the lease to expire, as a
   * crash would (tests).
   */
  async stop(opts: { releaseLease?: boolean } = {}): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.renewTimer) clearInterval(this.renewTimer);
    if (this.recheck) clearTimeout(this.recheck);
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    if (opts.releaseLease === false) {
      this.leaseUntil = 0;
      return;
    }
    await this.running;
    this.leaseUntil = 0;
    await this.app.db
      .delete(workerLeases)
      .where(and(eq(workerLeases.name, LEASE_NAME), eq(workerLeases.holder, this.holder)))
      .catch(() => {});
  }

  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.kicked = true;
      return;
    }
    this.running = this.tick()
      .catch((e) => this.report('outbox worker tick failed', e))
      .finally(() => {
        this.running = null;
        if (this.kicked) {
          this.kicked = false;
          this.kick();
        }
      });
  }

  /** Run one pass now and wait for it (tests). */
  async drain(): Promise<void> {
    while (this.running) await this.running;
    await this.tick();
  }

  /**
   * Take the lease, or renew it if it is ours. One statement, on the database's clock:
   * it succeeds only for the holder, or for anyone once the lease has expired.
   */
  private async acquire(): Promise<boolean> {
    const sentAt = this.now();
    const ms = this.leaseMs;
    const rows = await this.app.db
      .insert(workerLeases)
      .values({ name: LEASE_NAME, holder: this.holder, expiresAt: sql`now() + ${ms}::integer * interval '1 millisecond'` })
      .onConflictDoUpdate({
        target: workerLeases.name,
        set: { holder: sql`excluded.holder`, expiresAt: sql`excluded.expires_at` },
        setWhere: sql`${workerLeases.holder} = excluded.holder or ${workerLeases.expiresAt} < now()`,
      })
      .returning({ holder: workerLeases.holder });
    const held = rows.length === 1 && !this.stopped;
    // The database's expiry is at least `ms` after this statement started, which was after
    // `sentAt`; keep a margin for a slow round trip.
    this.leaseUntil = held ? sentAt + ms - Math.min(ms / 5, 5_000) : 0;
    return held;
  }

  /** Renew while holding, also while a consumer is busy. */
  private async renew(): Promise<void> {
    if (this.stopped || !this.active) return;
    try {
      await this.acquire();
    } catch {
      // Unreachable database: the deadline passes and this instance stops acting as holder.
    }
  }

  private async cursorFor(consumer: string): Promise<number> {
    const db = this.app.db;
    const [row] = await db.select().from(outboxCursors).where(eq(outboxCursors.consumer, consumer));
    if (row) return row.lastId;
    // A new consumer starts from now: it must not replay the whole history.
    const [{ max } = { max: 0 }] = await db.select({ max: sql<number>`coalesce(max(${activities.id}), 0)` }).from(activities);
    await db.insert(outboxCursors).values({ consumer, lastId: Number(max) }).onConflictDoNothing();
    const [again] = await db.select().from(outboxCursors).where(eq(outboxCursors.consumer, consumer));
    return again?.lastId ?? Number(max);
  }

  /** Move a consumer's cursor, only while the lease is ours in the database. */
  private async saveCursor(consumer: string, lastId: number): Promise<boolean> {
    const rows = await this.app.db
      .update(outboxCursors)
      .set({ lastId, updatedAt: new Date() })
      .where(
        and(
          eq(outboxCursors.consumer, consumer),
          sql`exists (select 1 from ${workerLeases} where ${workerLeases.name} = ${LEASE_NAME} and ${workerLeases.holder} = ${this.holder} and ${workerLeases.expiresAt} > now())`,
        ),
      )
      .returning({ consumer: outboxCursors.consumer });
    if (!rows.length) this.leaseUntil = 0;
    return rows.length > 0;
  }

  private async tick(): Promise<void> {
    if (this.stopped || !(await this.acquire())) return;
    let waiting = false;
    for (const consumer of this.consumers) {
      if (this.stopped || !this.active) return;
      if (await this.runConsumer(consumer)) waiting = true;
    }
    if (waiting) this.scheduleRecheck();
    await this.runChores();
  }

  /** Hand a consumer what it hasn't seen. Returns whether a missing id holds back more. */
  private async runConsumer(consumer: OutboxConsumer): Promise<boolean> {
    let cursor = await this.cursorFor(consumer.name);
    let saved = cursor;
    let savedAt = this.now();
    for (;;) {
      const { rows, waiting } = await this.log.read(cursor, this.batch);
      if (rows.length) {
        const s = await this.app.schema.get();
        for (const row of rows) {
          if (this.stopped || !this.active) break;
          if (!consumer.types || consumer.types.includes(row.type)) {
            try {
              await consumer.handle(toEventDto(s, row));
            } catch (e) {
              // A consumer handles its own retries; one bad event must not stall the log.
              this.report(`outbox consumer ${consumer.name} failed on event ${row.id}`, e);
            }
          }
          cursor = row.id;
          // A slow consumer saves as it goes, so a takeover repeats little.
          if (this.now() - savedAt >= 1_000) {
            if (!(await this.saveCursor(consumer.name, cursor))) return false;
            saved = cursor;
            savedAt = this.now();
          }
        }
      }
      if (cursor !== saved) {
        if (!(await this.saveCursor(consumer.name, cursor))) return false;
        saved = cursor;
        savedAt = this.now();
      }
      if (this.stopped || !this.active) return false;
      if (waiting) return true;
      if (rows.length < this.batch) return false;
    }
  }

  private async runChores(): Promise<void> {
    const now = this.now();
    for (const chore of this.chores) {
      if (this.stopped || !this.active) return;
      if ((this.choresDue.get(chore.name) ?? 0) > now) continue;
      this.choresDue.set(chore.name, now + chore.everyMs);
      try {
        await chore.run();
      } catch (e) {
        this.report(`chore ${chore.name} failed`, e);
      }
    }
  }

  private scheduleRecheck() {
    if (this.recheck || this.stopped) return;
    this.recheck = setTimeout(() => {
      this.recheck = null;
      this.kick();
    }, 100);
    this.recheck.unref?.();
  }
}
