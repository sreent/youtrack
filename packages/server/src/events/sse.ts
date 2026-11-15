import type { TrackerEvent } from '@tracklet/shared';
import { and, asc, gt, lt, sql } from 'drizzle-orm';
import type { AppServices } from '../context';
import { activities } from '../db/schema';
import { toEventDto } from './activity';

type Listener = (event: TrackerEvent) => void;

const TAIL_MS = 3_000;
const SETTLE_MS = 3_000;
const SEEN_MAX = 5_000;

/**
 * Live events for browsers and agents. Local commits arrive at once through the
 * bus; a light tail of the activity log picks up what other instances wrote.
 * Ids already sent are remembered so nothing is sent twice. Best effort: clients
 * re-read state after a reconnect.
 */
export class LiveEvents {
  private listeners = new Set<Listener>();
  private seen = new Set<number>();
  private seenOrder: number[] = [];
  private cursor = 0;
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private app: AppServices) {}

  async start(): Promise<void> {
    const [{ max } = { max: 0 }] = await this.app.db
      .select({ max: sql<number>`coalesce(max(${activities.id}), 0)` })
      .from(activities);
    this.cursor = Number(max);
    this.unsubscribe = this.app.bus.subscribe((e) => this.emit(e));
    this.timer = setInterval(() => void this.tail().catch(() => {}), TAIL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    this.listeners.clear();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get size(): number {
    return this.listeners.size;
  }

  private emit(event: TrackerEvent) {
    if (event.id > 0) {
      if (this.seen.has(event.id)) return;
      this.seen.add(event.id);
      this.seenOrder.push(event.id);
      if (this.seenOrder.length > SEEN_MAX) this.seen.delete(this.seenOrder.shift()!);
    }
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // a broken listener must not affect the others
      }
    }
  }

  private async tail(): Promise<void> {
    if (!this.listeners.size) return;
    const rows = await this.app.db
      .select()
      .from(activities)
      .where(and(gt(activities.id, this.cursor), lt(activities.createdAt, new Date(Date.now() - SETTLE_MS))))
      .orderBy(asc(activities.id))
      .limit(500);
    if (!rows.length) return;
    const s = await this.app.schema.get();
    for (const row of rows) this.emit(toEventDto(s, row));
    this.cursor = rows[rows.length - 1]!.id;
  }
}
