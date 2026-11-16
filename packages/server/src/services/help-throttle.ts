/**
 * Limits on what anyone may do at a help desk without signing in, shared by every instance through
 * Postgres and kept across restarts, as the sign-in throttle is: a spammer behind a load balancer
 * gets no more than one instance would give them.
 *
 * Each limit counts in a fixed window of its own. A hit is counted in the statement that checks it,
 * so parallel posts can't slip past between a check and a write. Emails and tracking tokens are
 * counted by their hash, so neither is kept here in plain text.
 */
import { lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { helpThrottle } from '../db/schema';
import { sha256 } from '../lib/crypto';

export const HELP_THROTTLE = {
  /** Opening the form, per address. */
  form: { limit: 60, windowMs: 10 * 60_000 },
  /** Requests, per address. */
  submitIp: { limit: 5, windowMs: 15 * 60_000 },
  /** Requests, per email address. */
  submitEmail: { limit: 3, windowMs: 60 * 60_000 },
  /** Requests, per help desk, from everyone. */
  submitDesk: { limit: 120, windowMs: 60 * 60_000 },
  /** Opening a tracking page, per address. */
  track: { limit: 120, windowMs: 10 * 60_000 },
  /** Replies, per address. */
  replyIp: { limit: 10, windowMs: 10 * 60_000 },
  /** Replies, per request (by its token). */
  replyRequest: { limit: 30, windowMs: 60 * 60_000 },
} as const;

export type HelpLimit = keyof typeof HELP_THROTTLE;

/** How a value is kept as a key: addresses and ids as they are (capped), emails and tokens hashed. */
export function throttleKey(limit: HelpLimit, value: string): string {
  const hashed = limit === 'submitEmail' || limit === 'replyRequest';
  return `${limit}:${hashed ? sha256(value.trim().toLowerCase()) : value.trim().slice(0, 64)}`;
}

/**
 * Count one hit on each limit, for its value, and say how long to wait: seconds until the latest
 * window over its limit ends, or 0 when all of them allow it.
 */
export async function helpHit(db: Db, hits: [HelpLimit, string][]): Promise<number> {
  if (!hits.length) return 0;
  const limits = new Map(hits.map(([limit, value]) => [throttleKey(limit, value), HELP_THROTTLE[limit]]));
  const expired = sql`${helpThrottle.windowEnds} <= now()`;
  const rows = await db
    .insert(helpThrottle)
    .values([...limits].map(([key, l]) => ({ key, windowEnds: sql`now() + ${l.windowMs}::integer * interval '1 millisecond'`, hits: 1 })))
    .onConflictDoUpdate({
      target: helpThrottle.key,
      // Both read the row as it was: a window that has passed starts again with this hit.
      set: {
        hits: sql`case when ${expired} then 1 else ${helpThrottle.hits} + 1 end`,
        windowEnds: sql`case when ${expired} then excluded.window_ends else ${helpThrottle.windowEnds} end`,
      },
    })
    .returning({
      key: helpThrottle.key,
      hits: helpThrottle.hits,
      wait: sql<number>`greatest(1, ceil(extract(epoch from (${helpThrottle.windowEnds} - now()))))::integer`,
    });
  let wait = 0;
  for (const r of rows) if (r.hits > (limits.get(r.key)?.limit ?? Infinity)) wait = Math.max(wait, Number(r.wait));
  return wait;
}

/** Housekeeping: forget windows that have passed. */
export async function pruneHelpThrottle(db: Db): Promise<void> {
  await db.delete(helpThrottle).where(lt(helpThrottle.windowEnds, sql`now()`));
}
