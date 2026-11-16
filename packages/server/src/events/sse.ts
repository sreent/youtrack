import type { TrackerEvent } from '@a4a/shared';
import { and, asc, gt, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { AppServices } from '../context';
import { activities } from '../db/schema';
import { toEventDto } from './activity';
import { OrderedLog, type OrderedLogOptions } from './ordered-log';
import { maxId } from './signals';

type Listener = (event: TrackerEvent) => void;

export interface LiveEventsOptions extends OrderedLogOptions {
  /** How often the log is read without a signal: the backstop for signals that were lost. */
  backstopMs?: number;
  /** While a missing id holds events back, how often to look again. */
  recheckMs?: number;
}

/** Which events a stream wants. `projectIds` null: every project. */
export interface EventFilter {
  projectIds: string[] | null;
  types: string[] | null;
  matches(event: TrackerEvent): boolean;
}

const PAGE = 500;

/**
 * Live events for browsers and agents, the same on every instance.
 *
 * The activity log is the only source: each instance reads it in id order (see
 * OrderedLog) and hands every event to its listeners once, in order. A read is
 * triggered by a local commit (the bus), by another instance's NOTIFY, by a LISTEN
 * reconnect, and by a slow backstop poll for signals that were lost. All of them
 * only say "look"; the cursor makes sure nothing is sent twice or out of order, so
 * a client that resumes after its last event id misses nothing.
 */
export class LiveEvents {
  private listeners = new Set<Listener>();
  private closers = new Map<Listener, () => void>();
  /** Every event up to this id has been handed out, or will never exist. */
  private cursor = 0;
  private started: Promise<void> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private backstop: NodeJS.Timeout | null = null;
  private recheck: NodeJS.Timeout | null = null;
  private unsubscribers: (() => void)[] = [];
  private log: OrderedLog;

  constructor(
    private app: AppServices,
    private opts: LiveEventsOptions = {},
  ) {
    this.log = new OrderedLog(app.db, opts);
  }

  /** Start reading at the end of the log. Safe to call more than once. */
  start(): Promise<void> {
    this.started ??= (async () => {
      const [{ max } = { max: 0 }] = await this.app.db.select({ max: sql<number>`coalesce(max(${activities.id}), 0)` }).from(activities);
      this.cursor = Number(max);
      this.unsubscribers.push(this.app.bus.subscribe(() => this.poke()));
      this.unsubscribers.push(
        this.app.signals.subscribe((s) => {
          if (s.kind === 'resync' || (s.kind === 'events' && maxId(s) > this.cursor)) this.poke();
        }),
      );
      this.backstop = setInterval(() => this.poke(), this.opts.backstopMs ?? 10_000);
      this.backstop.unref?.();
    })();
    return this.started;
  }

  /** Stop reading, and end every listener (their streams close; clients resume elsewhere). */
  stop(): void {
    this.stopped = true;
    if (this.backstop) clearInterval(this.backstop);
    if (this.recheck) clearTimeout(this.recheck);
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    const closers = [...this.closers.values()];
    this.listeners.clear();
    this.closers.clear();
    for (const close of closers) {
      try {
        close();
      } catch {
        // closing one stream must not stop the others from closing
      }
    }
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Every event up to this id has been handed to listeners. A new listener starts after it. */
  get position(): number {
    return this.cursor;
  }

  /** Listen to every event after `position` (read it in the same tick). `onEnd` runs if the feed stops. */
  subscribe(listener: Listener, onEnd?: () => void): () => void {
    this.listeners.add(listener);
    if (onEnd) this.closers.set(listener, onEnd);
    return () => {
      this.listeners.delete(listener);
      this.closers.delete(listener);
    };
  }

  get size(): number {
    return this.listeners.size;
  }

  /** Read the log now. Pokes during a read make one more read, not one each. */
  poke(): void {
    if (this.stopped || !this.started) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.pump()
      .catch((e) => console.error('live events: reading the log failed', e))
      .finally(() => {
        this.running = null;
        if (this.again) {
          this.again = false;
          this.poke();
        }
      });
  }

  /** Wait for reads in progress (tests). */
  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  /**
   * Events after `after`, up to and including `upto`, from the log: what a client
   * that resumes missed. Rows up to `position` are final, so this matches what
   * listeners were handed.
   */
  async replay(after: number, upto: number, filter: EventFilter, limit: number): Promise<TrackerEvent[]> {
    if (upto <= after) return [];
    const conds: SQL[] = [gt(activities.id, after), lte(activities.id, upto)];
    if (filter.projectIds) conds.push(filter.projectIds.length ? inArray(activities.projectId, filter.projectIds) : sql`false`);
    if (filter.types?.length) conds.push(inArray(activities.type, filter.types));
    const rows = await this.app.db
      .select()
      .from(activities)
      .where(and(...conds))
      .orderBy(asc(activities.id))
      .limit(limit);
    if (!rows.length) return [];
    const s = await this.app.schema.get();
    return rows.map((r) => toEventDto(s, r)).filter((e) => filter.matches(e));
  }

  private async pump(): Promise<void> {
    await this.started;
    for (;;) {
      if (this.stopped) return;
      const { rows, waiting } = await this.log.read(this.cursor, PAGE);
      if (rows.length) {
        const s = await this.app.schema.get();
        // No await from here to the end of the loop: a listener that subscribes sees a
        // position that matches exactly what it will be handed.
        for (const row of rows) {
          this.cursor = row.id;
          this.emit(toEventDto(s, row));
        }
      }
      if (waiting) {
        this.scheduleRecheck();
        return;
      }
      if (rows.length < PAGE) return;
    }
  }

  private scheduleRecheck() {
    if (this.recheck || this.stopped) return;
    this.recheck = setTimeout(() => {
      this.recheck = null;
      this.poke();
    }, this.opts.recheckMs ?? 100);
    this.recheck.unref?.();
  }

  private emit(event: TrackerEvent) {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // a broken listener must not affect the others
      }
    }
  }
}
