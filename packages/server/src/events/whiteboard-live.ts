/**
 * Whiteboards' live streams (D58). An element's edit isn't an event: a drag would flood the event log,
 * every outbox consumer and every webhook. A whiteboard keeps its latest changes in a log of its own,
 * `whiteboard_changes`, numbered by its `seq`, which only grows under the whiteboard's row lock: change
 * n + 1 can't commit before n, so a reader who has seen n and reads what's after it misses nothing.
 *
 * Each instance keeps, for each whiteboard someone looks at through it, its streams and how far they've
 * been handed. A read is set off by a commit here (`changed`), another instance's NOTIFY, a LISTEN
 * reconnect and a slow backstop; each only says "look", as for the event feed (D17), so a lost signal
 * costs a few seconds, never a change.
 */
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { AppServices } from '../context';
import { whiteboardChanges } from '../db/schema';

export type WhiteboardChangeRow = typeof whiteboardChanges.$inferSelect;

/** A change to hand on; `look` asks a stream to read again who's looking and whether it may still see it. */
export type WhiteboardSignal = { kind: 'change'; row: WhiteboardChangeRow } | { kind: 'look' } | { kind: 'resync' };
type Listener = (signal: WhiteboardSignal) => void;

interface Watched {
  listeners: Set<Listener>;
  /** Every change up to this one has been handed to the listeners. */
  cursor: number;
  ready: Promise<void>;
  running: Promise<void> | null;
  again: boolean;
}

const PAGE = 200;

export class WhiteboardLive {
  private boards = new Map<string, Watched>();
  private unsubscribe: (() => void) | null = null;
  private backstop: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private app: AppServices,
    private backstopMs = 10_000,
  ) {}

  private start() {
    if (this.unsubscribe || this.stopped) return;
    this.unsubscribe = this.app.signals.subscribe((s) => {
      if (s.kind === 'whiteboard') for (const id of s.ids) this.look(id);
      else if (s.kind === 'resync') for (const id of this.boards.keys()) this.look(id);
    });
    this.backstop = setInterval(() => {
      for (const id of this.boards.keys()) this.look(id);
    }, this.backstopMs);
    this.backstop.unref?.();
  }

  /**
   * Hand `listener` every change after the position it returns, and each `look`. Read the position in
   * the same tick it's returned in: what came before it is the caller's to replay from the log.
   */
  async subscribe(id: string, listener: Listener): Promise<{ position: number; unsubscribe: () => void }> {
    this.start();
    let b = this.boards.get(id);
    if (!b) {
      const fresh: Watched = { listeners: new Set(), cursor: 0, ready: Promise.resolve(), running: null, again: false };
      fresh.ready = this.latest(id).then((seq) => {
        fresh.cursor = seq;
      });
      this.boards.set(id, fresh);
      b = fresh;
    }
    const watched = b;
    await watched.ready;
    watched.listeners.add(listener);
    return {
      position: watched.cursor,
      unsubscribe: () => {
        watched.listeners.delete(listener);
        if (!watched.listeners.size && this.boards.get(id) === watched) this.boards.delete(id);
      },
    };
  }

  /**
   * After commit: this instance's streams read the whiteboard's log, and the others are told to. `look`
   * also has them read again who's looking and whether they may still see it: for a change to those,
   * or to the whiteboard itself, not for a change to its elements, which each stream checks as it sends.
   */
  changed(ids: string[], opts: { look?: boolean } = {}): void {
    for (const id of ids) {
      const b = this.boards.get(id);
      if (!b) continue;
      if (opts.look !== false) this.emit(b, { kind: 'look' });
      this.poke(id, b);
    }
    this.app.signals.announceWhiteboards(ids).catch((e) => console.warn(`whiteboards: NOTIFY failed (${e instanceof Error ? e.message : e}); other instances read within 10 seconds`));
  }

  /** Read a whiteboard's log now, and ask its streams to look again. */
  look(id: string): void {
    const b = this.boards.get(id);
    if (!b) return;
    this.emit(b, { kind: 'look' });
    this.poke(id, b);
  }

  /** The changes after `after`, up to `upto`, from the log: what a stream that resumes missed. Null when some are no longer kept. */
  async replay(id: string, after: number, upto: number): Promise<WhiteboardChangeRow[] | null> {
    if (upto <= after) return [];
    const rows = await this.app.db
      .select()
      .from(whiteboardChanges)
      .where(and(eq(whiteboardChanges.whiteboardId, id), gt(whiteboardChanges.seq, after), sql`${whiteboardChanges.seq} <= ${upto}`))
      .orderBy(asc(whiteboardChanges.seq));
    if (rows.length !== upto - after) return null;
    return rows;
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.backstop) clearInterval(this.backstop);
    this.boards.clear();
  }

  /** Wait for reads in progress (tests). */
  async settled(): Promise<void> {
    for (const b of this.boards.values()) while (b.running) await b.running;
  }

  private async latest(id: string): Promise<number> {
    const [row] = await this.app.db
      .select({ seq: sql<number>`coalesce(max(${whiteboardChanges.seq}), 0)` })
      .from(whiteboardChanges)
      .where(eq(whiteboardChanges.whiteboardId, id));
    return Number(row?.seq ?? 0);
  }

  private poke(id: string, b: Watched) {
    if (b.running) {
      b.again = true;
      return;
    }
    b.running = this.pump(id, b)
      .catch((e) => console.error('whiteboards: reading the change log failed', e))
      .finally(() => {
        b.running = null;
        if (b.again && this.boards.get(id) === b) {
          b.again = false;
          this.poke(id, b);
        }
      });
  }

  private async pump(id: string, b: Watched): Promise<void> {
    await b.ready;
    for (;;) {
      const rows = await this.app.db
        .select()
        .from(whiteboardChanges)
        .where(and(eq(whiteboardChanges.whiteboardId, id), gt(whiteboardChanges.seq, b.cursor)))
        .orderBy(asc(whiteboardChanges.seq))
        .limit(PAGE);
      // No await from here to the end of the loop: a stream that subscribes now sees a position that
      // matches exactly what it will be handed.
      for (const row of rows) {
        // Kept changes are numbered without gaps; one missing was trimmed while this instance was behind.
        if (row.seq !== b.cursor + 1) this.emit(b, { kind: 'resync' });
        b.cursor = row.seq;
        this.emit(b, { kind: 'change', row });
      }
      if (rows.length < PAGE) return;
    }
  }

  private emit(b: Watched, signal: WhiteboardSignal) {
    for (const l of b.listeners) {
      try {
        l(signal);
      } catch {
        // a broken stream must not stop the others
      }
    }
  }
}

const hubs = new WeakMap<AppServices, WhiteboardLive>();

/** This instance's whiteboard streams, made when first wanted. */
export function whiteboardLive(app: AppServices): WhiteboardLive {
  let hub = hubs.get(app);
  if (!hub) {
    hub = new WhiteboardLive(app);
    hubs.set(app, hub);
  }
  return hub;
}

export function stopWhiteboardLive(app: AppServices): void {
  hubs.get(app)?.stop();
}
