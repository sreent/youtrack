import { sql } from 'drizzle-orm';
import pg from 'pg';
import type { Db } from '../db/client';

/**
 * What instances tell each other. Signals carry ids, never data: a receiver reads
 * what changed from the database, so a lost or repeated signal costs a little
 * latency or one extra read, never a wrong answer.
 */
export type Signal =
  /** Activities committed, as id ranges (inclusive). */
  | { kind: 'events'; origin: string; ranges: [number, number][] }
  /** Reference data (fields, values, projects, tags, link types, users) changed. */
  | { kind: 'schema'; origin: string }
  /** Signals may have been missed (the LISTEN connection was lost): catch up from the database. */
  | { kind: 'resync' }
  /** These people's notifications changed on another instance: their open inboxes count again. */
  | { kind: 'inbox'; origin: string; users: string[] }
  /** These whiteboards changed on another instance, or who looks at them did (D58): their open streams read them again. */
  | { kind: 'whiteboard'; origin: string; ids: string[] };

export type SignalHandler = (signal: Signal) => void;

export interface Signals {
  /** 'postgres': LISTEN/NOTIFY between instances. 'local': this process only (PGlite). */
  readonly mode: 'postgres' | 'local';
  /** This instance's name in the signals it sends. */
  readonly origin: string;
  /** Whether signals from other instances are arriving now. Always true when local. */
  readonly listening: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(handler: SignalHandler): () => void;
  /** After commit: tell every instance, this one included, which activities committed. */
  announceEvents(ids: number[]): Promise<void>;
  /**
   * Tell every instance that reference data changed. Without `tx` it is sent now, so
   * call it after the change committed. With `tx` it is sent when that transaction
   * commits, to this instance too, and not at all if it rolls back.
   */
  announceSchemaChange(tx?: Db): Promise<void>;
  /** After commit: tell the other instances whose notifications changed (this one tells its own streams). */
  announceInbox(userIds: string[]): Promise<void>;
  /** After commit: tell the other instances which whiteboards changed (this one tells its own streams). */
  announceWhiteboards(ids: string[]): Promise<void>;
}

export const CHANNELS = { events: 'a4a_events', schema: 'a4a_schema', ping: 'a4a_ping', inbox: 'a4a_inbox', whiteboard: 'a4a_whiteboard' } as const;

/** NOTIFY payloads must stay under 8000 bytes. */
const MAX_PAYLOAD = 7_000;

/** "12-15,18": sorted, merged ranges. */
export function encodeRanges(ids: number[]): string {
  const sorted = [...new Set(ids)].filter((n) => Number.isSafeInteger(n) && n > 0).sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(i === j ? String(sorted[i]) : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  const text = parts.join(',');
  // Too many separate ids for one notification: their span says enough, since receivers read by cursor.
  return text.length <= MAX_PAYLOAD ? text : `${sorted[0]}-${sorted[sorted.length - 1]}`;
}

export function decodeRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const part of text.split(',')) {
    const [a, b = a] = part.split('-');
    const from = Number(a);
    const to = Number(b);
    if (Number.isSafeInteger(from) && Number.isSafeInteger(to) && from > 0 && to >= from) out.push([from, to]);
  }
  return out;
}

export function maxId(signal: Extract<Signal, { kind: 'events' }>): number {
  return signal.ranges.reduce((m, [, to]) => Math.max(m, to), 0);
}

class Fanout {
  private handlers = new Set<SignalHandler>();

  subscribe(handler: SignalHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  dispatch(signal: Signal): void {
    for (const h of this.handlers) {
      try {
        h(signal);
      } catch {
        // one broken handler must not affect the others
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}

/**
 * One process (PGlite, which is single-process by design): there is nobody else to
 * tell. Local writes already reach the live feed, the worker and the cache directly.
 */
export class LocalSignals implements Signals {
  readonly mode = 'local' as const;
  readonly listening = true;
  private fanout = new Fanout();

  constructor(readonly origin: string) {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    this.fanout.clear();
  }

  subscribe(handler: SignalHandler): () => void {
    return this.fanout.subscribe(handler);
  }

  async announceEvents(): Promise<void> {}

  async announceSchemaChange(): Promise<void> {}

  async announceInbox(): Promise<void> {}

  async announceWhiteboards(): Promise<void> {}
}

export interface PgSignalsOptions {
  /** How often the LISTEN connection proves it still hears (a NOTIFY to itself). */
  pingMs?: number;
  /** How long a ping may take before the connection counts as dead. */
  pingTimeoutMs?: number;
  /** First reconnect delay; doubles up to maxRetryMs. */
  retryMs?: number;
  maxRetryMs?: number;
  log?: (message: string) => void;
}

/**
 * LISTEN/NOTIFY on Postgres. One dedicated connection listens; notifications are
 * sent through the pool. A notification sent while the listening connection is down
 * is lost, so every reconnect dispatches `resync` and receivers catch up from the
 * database. A connection can also die without an error (a dropped network path, a
 * pooler that does not pass LISTEN through), so the listener pings itself and
 * reconnects when its own ping doesn't come back.
 */
export class PgSignals implements Signals {
  readonly mode = 'postgres' as const;
  private fanout = new Fanout();
  private client: pg.Client | null = null;
  private stopped = false;
  private connecting = false;
  private retryMs: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pending: { token: string; sentAt: number } | null = null;
  private pingSeq = 0;
  private hasConnected = false;
  private warned = false;
  /** The listening connection's backend, for diagnostics (pg_stat_activity) and tests. */
  backendPid: number | null = null;

  constructor(
    private url: string,
    private db: Db,
    readonly origin: string,
    private opts: PgSignalsOptions = {},
  ) {
    this.retryMs = opts.retryMs ?? 500;
  }

  get listening(): boolean {
    return this.client !== null;
  }

  private log(message: string) {
    (this.opts.log ?? ((m: string) => console.warn(m)))(message);
  }

  async start(): Promise<void> {
    this.stopped = false;
    try {
      await this.connect();
    } catch (e) {
      this.log(`live events: could not LISTEN yet (${errorText(e)}); retrying, and polling meanwhile`);
      this.scheduleReconnect();
    }
    const pingMs = this.opts.pingMs ?? 30_000;
    this.pingTimer = setInterval(() => void this.ping(), pingMs);
    this.pingTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.fanout.clear();
    const client = this.client;
    this.client = null;
    if (client) await closeClient(client);
  }

  subscribe(handler: SignalHandler): () => void {
    return this.fanout.subscribe(handler);
  }

  async announceEvents(ids: number[]): Promise<void> {
    if (!ids.length) return;
    await this.notify(this.db, CHANNELS.events, `${this.origin} ${encodeRanges(ids)}`);
  }

  async announceSchemaChange(tx?: Db): Promise<void> {
    // "tx": sent on commit, so this instance needs it too (it may have reloaded before the commit).
    await this.notify(tx ?? this.db, CHANNELS.schema, tx ? `${this.origin} tx` : this.origin);
  }

  async announceInbox(userIds: string[]): Promise<void> {
    // Ids, comma-separated, as many to a notification as fit.
    let batch: string[] = [];
    let size = 0;
    for (const id of new Set(userIds)) {
      if (batch.length && size + id.length + 1 > MAX_PAYLOAD) {
        await this.notify(this.db, CHANNELS.inbox, `${this.origin} ${batch.join(',')}`);
        batch = [];
        size = 0;
      }
      batch.push(id);
      size += id.length + 1;
    }
    if (batch.length) await this.notify(this.db, CHANNELS.inbox, `${this.origin} ${batch.join(',')}`);
  }

  async announceWhiteboards(ids: string[]): Promise<void> {
    const unique = [...new Set(ids)];
    // A whiteboard's id is 16 characters: hundreds fit in one notification, and a change names one or two.
    for (let i = 0; i < unique.length; i += 300) await this.notify(this.db, CHANNELS.whiteboard, `${this.origin} ${unique.slice(i, i + 300).join(',')}`);
  }

  private async notify(db: Db, channel: string, payload: string): Promise<void> {
    await db.execute(sql`select pg_notify(${channel}, ${payload})`);
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.stopped) return;
    this.connecting = true;
    const client = new pg.Client({ connectionString: this.url, keepAlive: true, application_name: `a4a listen ${this.origin}`.slice(0, 63) });
    let dead = false;
    try {
      client.on('error', (err) => {
        dead = true;
        this.lost(client, err);
      });
      client.on('end', () => {
        dead = true;
        this.lost(client);
      });
      client.on('notification', (msg) => this.received(msg.channel, msg.payload ?? ''));
      await client.connect();
      await client.query(`LISTEN ${CHANNELS.events}; LISTEN ${CHANNELS.schema}; LISTEN ${CHANNELS.ping}; LISTEN ${CHANNELS.inbox}; LISTEN ${CHANNELS.whiteboard}`);
      const pid = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
      if (dead) throw new Error('the connection closed while it started listening');
      if (this.stopped) {
        detach(client);
        await closeClient(client);
        return;
      }
      this.client = client;
      this.backendPid = pid.rows[0]?.pid ?? null;
      this.retryMs = this.opts.retryMs ?? 500;
      this.pending = null;
      if (this.warned) this.log('live events: listening again');
      this.warned = false;
      // Anything sent while nobody listened is in the database; tell receivers to look.
      if (this.hasConnected) this.fanout.dispatch({ kind: 'resync' });
      this.hasConnected = true;
    } catch (e) {
      detach(client);
      void closeClient(client);
      throw e;
    } finally {
      this.connecting = false;
    }
  }

  private lost(client: pg.Client, err?: Error) {
    if (client !== this.client) return;
    this.client = null;
    this.backendPid = null;
    detach(client);
    void closeClient(client);
    if (this.stopped) return;
    if (!this.warned) this.log(`live events: lost the LISTEN connection${err ? ` (${err.message})` : ''}; reconnecting`);
    this.warned = true;
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, this.opts.maxRetryMs ?? 10_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((e) => {
        if (!this.warned) this.log(`live events: LISTEN failed (${errorText(e)}); retrying`);
        this.warned = true;
        this.scheduleReconnect();
      });
    }, wait);
    this.reconnectTimer.unref?.();
  }

  /** Prove the connection still hears: our own NOTIFY must come back in time. */
  private async ping(): Promise<void> {
    const client = this.client;
    if (!client || this.stopped || this.pending) return;
    const timeout = this.opts.pingTimeoutMs ?? 10_000;
    const token = String(++this.pingSeq);
    this.pending = { token, sentAt: Date.now() };
    try {
      await this.notify(this.db, CHANNELS.ping, `${this.origin} ${token}`);
    } catch {
      // The pool can't reach the database either; the listener's own error will follow.
      this.pending = null;
      return;
    }
    const check = setTimeout(() => {
      if (this.pending?.token !== token || this.client !== client) return;
      this.pending = null;
      this.lost(
        client,
        new Error(
          `its own notification did not come back within ${timeout} ms; a pooler in transaction mode drops LISTEN, so point DATABASE_LISTEN_URL straight at Postgres`,
        ),
      );
    }, timeout);
    check.unref?.();
  }

  private received(channel: string, payload: string) {
    const space = payload.indexOf(' ');
    const origin = space < 0 ? payload : payload.slice(0, space);
    const rest = space < 0 ? '' : payload.slice(space + 1);
    if (channel === CHANNELS.events) {
      const ranges = decodeRanges(rest);
      if (ranges.length) this.fanout.dispatch({ kind: 'events', origin, ranges });
    } else if (channel === CHANNELS.schema) {
      // Our own change was already applied here, unless it was sent on commit.
      if (origin !== this.origin || rest === 'tx') this.fanout.dispatch({ kind: 'schema', origin });
    } else if (channel === CHANNELS.ping) {
      if (origin === this.origin && this.pending?.token === rest) this.pending = null;
    } else if (channel === CHANNELS.inbox) {
      const users = rest.split(',').filter(Boolean);
      if (origin !== this.origin && users.length) this.fanout.dispatch({ kind: 'inbox', origin, users });
    } else if (channel === CHANNELS.whiteboard) {
      const ids = rest.split(',').filter(Boolean);
      if (origin !== this.origin && ids.length) this.fanout.dispatch({ kind: 'whiteboard', origin, ids });
    }
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Stop reacting to a client we are done with; an error it raises later must not crash the process. */
function detach(client: pg.Client) {
  client.removeAllListeners();
  client.on('error', () => {});
}

/** End a client without waiting on a socket that may never answer. */
async function closeClient(client: pg.Client): Promise<void> {
  const stream = (client as unknown as { connection?: { stream?: { destroy?: () => void } } }).connection?.stream;
  const ended = client.end().catch(() => {});
  const timer = setTimeout(() => stream?.destroy?.(), 1_000);
  timer.unref?.();
  await Promise.race([ended, new Promise<void>((r) => setTimeout(r, 1_100).unref?.())]);
  clearTimeout(timer);
}
