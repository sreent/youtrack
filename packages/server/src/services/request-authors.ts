/**
 * Who outside the team wrote a help desk request's comments, as every page that shows them says:
 * its requester; someone copied on it (D57), an address on its list of copies, now or before; or,
 * failing both, someone of its customer group answering it (D56).
 */
import { inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { helpdeskRequests, requestCcs, requesters } from '../db/schema';

export type OutsideAs = 'requester' | 'copied' | 'colleague';
export interface OutsideAuthor {
  name: string;
  email: string;
  as: OutsideAs;
}

/** The key `outsideAuthors` answers a comment by: its issue and its writer, since one person may ask one request and be copied on another. */
export const outsideKey = (issueId: string, requesterId: string) => `${issueId}:${requesterId}`;

/** For these comments, those written from outside the team: who wrote each, and as whom, by `outsideKey`. */
export async function outsideAuthors(db: Db, rows: readonly { issueId: string; requesterId: string | null }[]): Promise<Map<string, OutsideAuthor>> {
  const written = rows.filter((r): r is { issueId: string; requesterId: string } => Boolean(r.requesterId));
  if (!written.length) return new Map();
  const issueIds = [...new Set(written.map((r) => r.issueId))];
  const people = new Map(
    (
      await db
        .select({ id: requesters.id, name: requesters.name, email: requesters.email })
        .from(requesters)
        .where(inArray(requesters.id, [...new Set(written.map((r) => r.requesterId))]))
    ).map((p) => [p.id, p]),
  );
  const askers = new Map(
    (await db.select({ issueId: helpdeskRequests.issueId, requesterId: helpdeskRequests.requesterId }).from(helpdeskRequests).where(inArray(helpdeskRequests.issueId, issueIds))).map((r) => [
      r.issueId,
      r.requesterId,
    ]),
  );
  const listed = new Set(
    (await db.select({ issueId: requestCcs.issueId, email: requestCcs.email }).from(requestCcs).where(inArray(requestCcs.issueId, issueIds))).map((c) => `${c.issueId}:${c.email.toLowerCase()}`),
  );
  const out = new Map<string, OutsideAuthor>();
  for (const r of written) {
    const p = people.get(r.requesterId);
    if (!p) continue;
    const as: OutsideAs = askers.get(r.issueId) === r.requesterId ? 'requester' : listed.has(`${r.issueId}:${p.email.toLowerCase()}`) ? 'copied' : 'colleague';
    out.set(outsideKey(r.issueId, r.requesterId), { name: p.name, email: p.email, as });
  }
  return out;
}
