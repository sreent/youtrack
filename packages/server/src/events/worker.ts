import type { TrackerEvent } from '@a4a/shared';
import { and, asc, eq, gt, lt, or, sql } from 'drizzle-orm';
import type { AppServices } from '../context';
import { activities, outboxCursors, workerLeases } from '../db/schema';
import { newId } from '../lib/ids';
import { toEventDto } from './activity';

/** Something that reacts to committed tracker events, at least once, in order. */
export interface OutboxConsumer {
  name: string;
  /** Only events of these types are passed to handle(); others just advance the cursor. */
  types?: string[];
  handle(event: TrackerEvent): Promise<void>;
}

const LEASE_NAME = 'outbox';
const LEASE_MS = 30_000;
const POLL_MS = 2_000;
const BATCH = 100;
/**
 * Rows are only consumed once they are this old. Ids come from a sequence at insert
 * time, so a transaction holding a lower id can commit after one holding a higher
 * id; waiting a moment past the (short) write transactions keeps the cursor from
 * skipping it.
 */
const SETTLE_MS = 3_000;

/**
 * Drives every consumer from the activity log. Exactly one instance (the lease
 * holder) runs consumers at a time; the others stand by and take over when the
 * lease expires.
 */
export class OutboxWorker {
  private readonly holder = `${process.pid}-${newId(8)}`;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private kicked = false;
  private stopped = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private app: AppServices,
    private consumers: OutboxConsumer[],
    private log: (msg: string, err?: unknown) => void = (m, e) => console.error(m, e ?? ''),
  ) {}

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => this.kick(), POLL_MS);
    this.timer.unref?.();
    // Local commits wake the worker; it still waits for rows to settle.
    this.unsubscribe = this.app.bus.subscribe(() => setTimeout(() => this.kick(), SETTLE_MS + 50).unref?.());
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    await this.running;
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
      .catch((e) => this.log('outbox worker tick failed', e))
      .finally(() => {
        this.running = null;
        if (this.kicked) {
          this.kicked = false;
          this.kick();
        }
      });
  }

  /** Run one pass synchronously (tests). */
  async drain(): Promise<void> {
    await this.running;
    await this.tick(true);
  }

  private async acquireLease(): Promise<boolean> {
    const db = this.app.db;
    const expires = new Date(Date.now() + LEASE_MS);
    await db
      .insert(workerLeases)
      .values({ name: LEASE_NAME, holder: this.holder, expiresAt: expires })
      .onConflictDoNothing();
    const rows = await db
      .update(workerLeases)
      .set({ holder: this.holder, expiresAt: expires })
      .where(
        and(
          eq(workerLeases.name, LEASE_NAME),
          or(eq(workerLeases.holder, this.holder), lt(workerLeases.expiresAt, new Date())),
        ),
      )
      .returning({ holder: workerLeases.holder });
    return rows.length === 1;
  }

  private async cursorFor(consumer: string): Promise<number> {
    const db = this.app.db;
    const [row] = await db.select().from(outboxCursors).where(eq(outboxCursors.consumer, consumer));
    if (row) return row.lastId;
    // A new consumer starts from now: it must not replay the whole history.
    const [{ max } = { max: 0 }] = await db.select({ max: sql<number>`coalesce(max(${activities.id}), 0)` }).from(activities);
    await db.insert(outboxCursors).values({ consumer, lastId: Number(max) }).onConflictDoNothing();
    return Number(max);
  }

  private async tick(ignoreSettle = false): Promise<void> {
    if (!(await this.acquireLease())) return;
    const s = await this.app.schema.get();
    const settledBefore = new Date(Date.now() - (ignoreSettle ? 0 : SETTLE_MS));
    for (const consumer of this.consumers) {
      if (this.stopped) return;
      let cursor = await this.cursorFor(consumer.name);
      for (;;) {
        const rows = await this.app.db
          .select()
          .from(activities)
          .where(and(gt(activities.id, cursor), lt(activities.createdAt, settledBefore)))
          .orderBy(asc(activities.id))
          .limit(BATCH);
        if (!rows.length) break;
        for (const row of rows) {
          if (!consumer.types || consumer.types.includes(row.type)) {
            try {
              await consumer.handle(toEventDto(s, row));
            } catch (e) {
              // A consumer handles its own retries; one bad event must not stall the log.
              this.log(`outbox consumer ${consumer.name} failed on event ${row.id}`, e);
            }
          }
          cursor = row.id;
        }
        await this.app.db
          .update(outboxCursors)
          .set({ lastId: cursor, updatedAt: new Date() })
          .where(eq(outboxCursors.consumer, consumer.name));
        if (rows.length < BATCH) break;
      }
    }
  }
}
