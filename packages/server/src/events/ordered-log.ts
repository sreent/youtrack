import { asc, gt, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { activities } from '../db/schema';
import type { ActivityRow } from './activity';

export interface OrderedLogOptions {
  /** How long after a gap is seen before the log's writers are listed (see `settle`); none is needed. */
  settleMs?: number;
  /** A gap held longer than this is passed with a warning, so a transaction left open can't stall the log. */
  maxWaitMs?: number;
  log?: (message: string) => void;
  now?: () => number;
}

export interface LogRead {
  rows: ActivityRow[];
  /** A missing id holds back what follows it: read again soon. */
  waiting: boolean;
}

/**
 * Reads the activity log in id order without passing a row that may still commit.
 *
 * Ids come from a sequence when a row is inserted, but transactions commit in their
 * own order: 41 can become visible after 42, and an id taken by a transaction that
 * rolls back never appears. A reader that moved past 41 when it saw 42 would never
 * hand 41 out, and a client resuming "after 42" would miss it. So a read stops at a
 * missing id, and the id is passed only once it can no longer appear: every
 * transaction that was writing to the log when the gap was seen has ended (Postgres's
 * lock table says which). A rolled-back id is passed at the next read; a late commit
 * is waited for, up to `maxWaitMs`.
 */
export class OrderedLog {
  /** Every id up to this one is either visible or will never be. */
  private settled = 0;
  /** A gap was seen below `horizon` (the highest id then visible) at `at`. */
  private probe: { horizon: number; at: number } | null = null;
  /** Transactions that were running after the probe settled; once all have ended, ids up to `horizon` are final. */
  private waitFor: { horizon: number; xids: Set<string> } | null = null;
  /** First time each held id was seen missing, for `maxWaitMs`. */
  private stalls = new Map<number, number>();

  constructor(
    private db: Db,
    private opts: OrderedLogOptions = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private get settleMs(): number {
    return this.opts.settleMs ?? 0;
  }

  /** Up to `limit` rows after `after`, in order, stopping at a gap that may still fill. */
  async read(after: number, limit: number): Promise<LogRead> {
    const started = this.now();
    if (this.waitFor || (this.probe && started - this.probe.at >= this.settleMs)) await this.settle(started);
    const rows = await this.db.select().from(activities).where(gt(activities.id, after)).orderBy(asc(activities.id)).limit(limit);
    const out: ActivityRow[] = [];
    let expected = after + 1;
    for (const row of rows) {
      if (row.id > expected && row.id - 1 > this.settled && !this.passStalled(Math.max(expected, this.settled + 1), row.id - 1)) {
        this.probe ??= { horizon: rows[rows.length - 1]!.id, at: this.now() };
        return { rows: out, waiting: true };
      }
      out.push(row);
      expected = row.id + 1;
    }
    return { rows: out, waiting: false };
  }

  /**
   * Wait until every id taken so far is final: the transactions writing to the log now
   * have ended. A reader that starts at the end of the log calls this after reading
   * where the end is, or an earlier id committing late would fall behind its cursor.
   * Gives up after `maxWaitMs`.
   */
  async untilWritersFinish(maxWaitMs: number): Promise<void> {
    const deadline = this.now() + maxWaitMs;
    const first = await this.writers();
    while (first.size && this.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      const now = await this.writers();
      for (const tx of first) if (!now.has(tx)) first.delete(tx);
    }
  }

  /**
   * Every id up to a probe's horizon was taken before the probe (a higher id was
   * already visible), so whoever took one and still runs is writing to the log now.
   * When none of the writers seen after the probe is running any more, a missing id up
   * to the horizon is final.
   */
  private async settle(started: number): Promise<void> {
    const writing = await this.writers();
    if (this.waitFor && ![...this.waitFor.xids].some((x) => writing.has(x))) {
      this.settled = Math.max(this.settled, this.waitFor.horizon);
      this.waitFor = null;
    }
    if (!this.waitFor && this.probe && started - this.probe.at >= this.settleMs) {
      if (writing.size) this.waitFor = { horizon: this.probe.horizon, xids: writing };
      else this.settled = Math.max(this.settled, this.probe.horizon);
      this.probe = null;
    }
    for (const id of this.stalls.keys()) if (id <= this.settled) this.stalls.delete(id);
  }

  /**
   * The transactions writing to the activity log now. An INSERT holds a row-exclusive
   * lock on the table from before it takes its id (the lock comes with parsing, the id
   * with executing) until its transaction ends, so these are exactly the transactions
   * that may still hold a missing id; unrelated work, here or in other databases,
   * doesn't count. Not pg_current_snapshot(): its list of running transactions leaves
   * out one whose id is newer than every finished one, which is just the one that took
   * a missing id last.
   */
  private async writers(): Promise<Set<string>> {
    const res = await this.db.execute(sql`
      select distinct l.virtualtransaction as tx from pg_locks l
      where l.locktype = 'relation' and l.granted and l.mode not in ('AccessShareLock', 'RowShareLock')
        and l.database = (select oid from pg_database where datname = current_database())
        and l.relation = to_regclass('activities')`);
    return new Set((res as unknown as { rows: { tx: string }[] }).rows.map((r) => r.tx));
  }

  /** Whether the gap from..to has been held too long and is passed now. */
  private passStalled(from: number, to: number): boolean {
    const now = this.now();
    if (!this.stalls.has(from)) {
      if (this.stalls.size > 1_000) this.stalls.clear();
      this.stalls.set(from, now);
    }
    const maxWait = this.opts.maxWaitMs ?? 60_000;
    if (now - this.stalls.get(from)! < maxWait) return false;
    (this.opts.log ?? ((m: string) => console.warn(m)))(
      `outbox: passing activity ${from === to ? from : `${from}-${to}`} after ${Math.round(maxWait / 1000)}s: a transaction holding it is still open, so it won't be sent live or to consumers`,
    );
    this.settled = Math.max(this.settled, to);
    this.stalls.delete(from);
    return true;
  }
}
