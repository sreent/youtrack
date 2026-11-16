/**
 * Who an event reaches because they subscribed (D31), and why.
 *
 * - To a project: its new issues reach every subscriber; its changes, comments, links, files and
 *   deletions reach those who asked for every change. What reaches watchers reaches them.
 * - To a saved search: an issue coming into the search reaches those who asked for that; a change to
 *   an issue in it, the one that takes it out included, reaches those who asked for every change.
 *   Each subscription keeps the issues its search found for its person, and every change to an issue
 *   (an import's too) is checked against it, so an issue already in the search isn't told as new.
 *
 * Whether the person may see the issue is decided where everyone's is (notifier.ts), and whoever made
 * the change isn't told of it.
 */
import type { TrackerEvent } from '@a4a/shared';
import { and, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import type { AppServices } from '../context';
import { savedSearches, subscriptionIssues, subscriptions } from '../db/schema';
import { prepareQuery } from '../search/service';
import { projectRolesOf } from '../services/access';
import { personCtx } from '../services/subscriptions';
import { meets } from '../workflow/match';

export interface Subscribed {
  userId: string;
  subscriptionId: string;
  /** Whether this subscription emails too. */
  email: boolean;
  target: 'project' | 'search';
}

/** What tells someone of "every change": what tells an issue's watchers. A comment's files go with the comment. */
const EVERY_CHANGE = new Set<string>(['issue.created', 'issue.updated', 'issue.moved', 'issue.deleted', 'comment.created', 'link.created', 'link.deleted', 'attachment.added', 'attachment.removed']);

function isChange(event: TrackerEvent): boolean {
  if (!EVERY_CHANGE.has(event.type)) return false;
  return !(event.type.startsWith('attachment.') && (event.data as { commentId?: unknown } | undefined)?.commentId);
}

/**
 * What can move an issue into a saved search or out of it: any change of its own. The notifier takes
 * these so the searches' subscriptions keep up; only "every change" and coming in are told.
 */
export const SEARCH_EVENT_TYPES = [
  'issue.created',
  'issue.updated',
  'comment.created',
  'comment.updated',
  'comment.deleted',
  'link.created',
  'link.deleted',
  'attachment.added',
  'attachment.removed',
  'work.logged',
  'work.deleted',
  'sprint.issue_added',
  'sprint.issue_removed',
] as const;

/** A project's subscribers this event reaches. */
export async function projectSubscribed(app: AppServices, event: TrackerEvent, projectId: string): Promise<Subscribed[]> {
  if (!isChange(event)) return [];
  const rows = await app.db
    .select({ id: subscriptions.id, userId: subscriptions.userId, events: subscriptions.events, email: subscriptions.email })
    .from(subscriptions)
    .where(eq(subscriptions.projectId, projectId));
  return rows
    .filter((r) => r.events === 'all' || event.type === 'issue.created')
    .map((r) => ({ userId: r.userId, subscriptionId: r.id, email: r.email, target: 'project' as const }));
}

/**
 * Check one issue against every saved-search subscription, after a change of its own: keep each
 * one's issues, and say whom the change reaches. An import's changes are kept too, and tell nobody.
 */
export async function searchSubscribed(app: AppServices, event: TrackerEvent, issueId: string, projectId: string): Promise<Subscribed[]> {
  const subs = await app.db
    .select({
      id: subscriptions.id,
      userId: subscriptions.userId,
      events: subscriptions.events,
      email: subscriptions.email,
      query: savedSearches.query,
      ownerId: savedSearches.ownerId,
      shared: savedSearches.shared,
    })
    .from(subscriptions)
    .innerJoin(savedSearches, eq(savedSearches.id, subscriptions.savedSearchId))
    .where(isNotNull(subscriptions.savedSearchId));
  // A search no longer shared with someone has nothing for them to follow.
  const live = subs.filter((r) => r.shared || r.ownerId === r.userId);
  if (!live.length) return [];
  const s = await app.schema.get();
  // Who can't see the issue's project can't have it in their search: it's out for them.
  const seeing = await projectRolesOf(app.db, projectId, live.map((r) => r.userId));
  const checks: { sub: (typeof live)[number]; where: SQL }[] = [];
  for (const sub of live) {
    const user = s.users.get(sub.userId);
    if (!user || user.banned) continue;
    if (!seeing.has(sub.userId)) {
      checks.push({ sub, where: sql`FALSE` });
      continue;
    }
    // As its person would see it signing in: their projects, "me" as them, dates where they are.
    const prepared = await prepareQuery(personCtx(app, user), sub.query);
    // A search that no longer reads for them (a value renamed since) says nothing, and keeps its issues.
    if (prepared.compiled.problems.length) continue;
    checks.push({ sub, where: prepared.compiled.where ?? sql`TRUE` });
  }
  if (!checks.length) return [];
  const now = await meets(app.db, issueId, checks.map((c) => c.where));
  const had = new Set(
    (
      await app.db
        .select({ id: subscriptionIssues.subscriptionId })
        .from(subscriptionIssues)
        .where(and(eq(subscriptionIssues.issueId, issueId), inArray(subscriptionIssues.subscriptionId, checks.map((c) => c.sub.id))))
    ).map((r) => r.id),
  );
  const cameIn: string[] = [];
  const wentOut: string[] = [];
  const out: Subscribed[] = [];
  const change = isChange(event);
  checks.forEach(({ sub }, i) => {
    const isIn = now[i] === true;
    const wasIn = had.has(sub.id);
    if (isIn && !wasIn) cameIn.push(sub.id);
    if (!isIn && wasIn) wentOut.push(sub.id);
    const tells = sub.events === 'all' ? change && (isIn || wasIn) : isIn && !wasIn;
    if (tells) out.push({ userId: sub.userId, subscriptionId: sub.id, email: sub.email, target: 'search' });
  });
  if (cameIn.length) await app.db.insert(subscriptionIssues).values(cameIn.map((subscriptionId) => ({ subscriptionId, issueId }))).onConflictDoNothing();
  if (wentOut.length) {
    await app.db.delete(subscriptionIssues).where(and(eq(subscriptionIssues.issueId, issueId), inArray(subscriptionIssues.subscriptionId, wentOut)));
  }
  return out;
}
