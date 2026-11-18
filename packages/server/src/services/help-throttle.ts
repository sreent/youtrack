/**
 * Limits on what anyone may do at a help desk without signing in, shared by every instance through
 * Postgres and kept across restarts, as the sign-in throttle is: a spammer behind a load balancer
 * gets no more than one instance would give them.
 *
 * Each limit counts in a fixed window of its own. A hit is counted in the statement that checks it,
 * so parallel posts can't slip past between a check and a write. Emails and tracking tokens are
 * counted by their hash, so neither is kept here in plain text.
 */
import { CC_RELAY_LIMITS } from '@a4a/shared';
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
  /** A proof of work's answer is taken once (D30): its challenge, for as long as it is good. */
  captcha: { limit: 1, windowMs: 30 * 60_000 },
  /** New requests by email, per sender (D30). */
  mailSender: { limit: 5, windowMs: 60 * 60_000 },
  /** Messages by email, per help desk, from everyone. */
  mailDesk: { limit: 300, windowMs: 60 * 60_000 },
  /** Replies by email, per request. */
  mailReply: { limit: 30, windowMs: 60 * 60_000 },
  /** Posts to a desk's mail webhook without its secret, per address. */
  mailAuth: { limit: 20, windowMs: 10 * 60_000 },
  /** Sign-in links to the portal (D45), per address. */
  portalIp: { limit: 10, windowMs: 15 * 60_000 },
  /** Sign-in links to the portal, per email address. */
  portalEmail: { limit: 3, windowMs: 60 * 60_000 },
  /** What a signed-in requester does on the portal: replies and new requests, per requester. */
  portalAct: { limit: 30, windowMs: 60 * 60_000 },
  /** Sign-ins started through a requesters' identity provider (D63), per address: each stores a row. */
  portalSso: { limit: 30, windowMs: 15 * 60_000 },
  /** Team replies by email (D45), per person. */
  teamReply: { limit: 60, windowMs: 60 * 60_000 },
  /** Words relayed among everyone on a request (D67), per request: each is an email to everyone on it. */
  relayRequest: { limit: CC_RELAY_LIMITS.perRequest, windowMs: 60 * 60_000 },
  /** Words relayed from one sender (by their address), across every request (D67). */
  relaySender: { limit: CC_RELAY_LIMITS.perSender, windowMs: 60 * 60_000 },
  /** What the link that confirms a new request's Cc is tried with (D67), per address: its token is guessed at no faster. */
  ccConfirm: { limit: 30, windowMs: 15 * 60_000 },
} as const;

export type HelpLimit = keyof typeof HELP_THROTTLE;

/** How a value is kept as a key: addresses and ids as they are (capped), emails and tokens hashed. */
export function throttleKey(limit: HelpLimit, value: string): string {
  const hashed = limit === 'submitEmail' || limit === 'replyRequest' || limit === 'mailSender' || limit === 'captcha' || limit === 'portalEmail' || limit === 'relaySender';
  return `${limit}:${hashed ? sha256(value.trim().toLowerCase()) : value.trim().slice(0, 64)}`;
}

/**
 * Count one hit on each limit, for its value, and say how long to wait: seconds until the latest
 * window over its limit ends, or 0 when all of them allow it.
 */
export async function helpHit(db: Db, hits: [HelpLimit, string][]): Promise<number> {
  return countHits(db, new Map(hits.map(([limit, value]) => [throttleKey(limit, value), HELP_THROTTLE[limit]])));
}

/**
 * The same count, for a limit of a4a's own beyond the help desk's (each key named by what it limits,
 * such as `aiWriting:<user id>`, D59): seconds to wait, or 0 while every limit allows it.
 */
export async function countHits(db: Db, limits: Map<string, { limit: number; windowMs: number }>): Promise<number> {
  if (!limits.size) return 0;
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
  for (const r of rows) {
    const l = limits.get(r.key);
    // Never longer than the window: an ask whose transaction began just before the one that opened it
    // reads a now() a moment earlier, and so a window a moment longer.
    if (l && r.hits > l.limit) wait = Math.max(wait, Math.min(Number(r.wait), Math.ceil(l.windowMs / 1000)));
  }
  return wait;
}

/** Housekeeping: forget windows that have passed. */
export async function pruneHelpThrottle(db: Db): Promise<void> {
  await db.delete(helpThrottle).where(lt(helpThrottle.windowEnds, sql`now()`));
}
