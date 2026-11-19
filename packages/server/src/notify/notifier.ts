/**
 * Turns committed events into notifications, one per person per burst of activity on an issue.
 *
 * - Who: the new assignee, people newly mentioned, a project's lead for a new help desk request,
 *   and the issue's watchers for changes, comments, links, files and deletion. Never whoever acted, and
 *   never someone who can't read the project as they would signing in (access.ts decides, as for
 *   everything else), nor, for a link, the issue at its other end.
 * - Volume: events on one issue within the window (NOTIFY_WINDOW_SECONDS) fold into one unread
 *   notification, which takes the strongest reason among them; its email waits for the window.
 * - At least once in, once out: the outbox may hand an event over twice, and notification_events
 *   remembers who it reached, so nobody gets the same event twice.
 * - What time alone brings into a saved search (D31): a chore the lease holder runs reads the
 *   searches whose words read the clock again, and tells their 'new' subscribers what came in.
 */
import { choicesFor } from './kinds';
import { EMAIL_LEVELS, NOTIFICATION_KINDS, type EmailLevel, type IssueRef, type NotificationKind, type TrackerEvent } from '@a4a/shared';
import { and, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { AppServices } from '../context';
import type { Db } from '../db/client';
import { activities, issues, notificationEvents, notifications, notificationSettings, savedSearches, subscriptionIssues, subscriptions, users } from '../db/schema';
import type { OutboxConsumer } from '../events/worker';
import { newId } from '../lib/ids';
import { enqueueMail } from '../mail/outbox';
import { enqueuePushes, kickPushSoon } from '../push/outbox';
import { accessFor, eventFor, eventSeen, keyOfReadableId, projectRolesOf } from '../services/access';
import { watcherIds } from '../services/watchers';
import { inboxChanged, mailConfigured } from './state';
import { prepareQuery } from '../search/service';
import { issueRefsById } from '../services/issue-refs';
import { personCtx } from '../services/subscriptions';
import { projectSubscribed, SEARCH_EVENT_TYPES, searchSubscribed } from './subscribed';

const RANK: Record<NotificationKind, number> = Object.fromEntries(NOTIFICATION_KINDS.map((k, i) => [k, i])) as Record<NotificationKind, number>;

export function strongerKind(a: NotificationKind, b: NotificationKind): NotificationKind {
  return RANK[b] > RANK[a] ? b : a;
}

/**
 * Whether an email level sends this kind: direct sends what calls on the person, all adds issues they
 * watch. What they subscribed to says for itself whether it emails (D31), and "none" stops that too.
 */
export function levelSends(level: EmailLevel, kind: NotificationKind): boolean {
  if (level === 'none' || kind === 'subscribed') return false;
  if (kind === 'watching') return level === 'all';
  return true;
}

/** Whether a notification is emailed: as the level sends its kind, or as the subscription that brought it asks. */
export function emailSends(level: EmailLevel, kind: NotificationKind, subscription: { email: boolean } | null | undefined): boolean {
  return levelSends(level, kind) || (level !== 'none' && Boolean(subscription?.email));
}

export interface EmailPrefs {
  email: EmailLevel;
  /** The same levels, for push to the person's devices (D47). */
  push: EmailLevel;
  digest: boolean;
}

export const DEFAULT_PREFS: EmailPrefs = { email: 'direct', push: 'direct', digest: false };

const level = (v: string, fallback: EmailLevel): EmailLevel => ((EMAIL_LEVELS as readonly string[]).includes(v) ? (v as EmailLevel) : fallback);

export async function emailPrefs(db: Db, userId: string): Promise<EmailPrefs> {
  const [row] = await db.select().from(notificationSettings).where(eq(notificationSettings.userId, userId));
  if (!row) return DEFAULT_PREFS;
  return { email: level(row.email, DEFAULT_PREFS.email), push: level(row.push, DEFAULT_PREFS.push), digest: row.digest };
}

/** Margin past the window before a notification's email goes, so events still settling in the outbox fold in. */
export const SEAL_MARGIN_MS = 10_000;

type Facts = { assigned?: string[]; mentions?: string[]; watchers?: string[]; requester?: { name?: string } };

/** Who an event reaches, and why: the strongest reason each person has. */
async function recipientsOf(app: AppServices, event: TrackerEvent, issueId: string | null, projectId: string | null): Promise<Map<string, NotificationKind>> {
  const s = await app.schema.get();
  const out = new Map<string, NotificationKind>();
  const add = (userId: string | undefined, kind: NotificationKind) => {
    if (!userId) return;
    const had = out.get(userId);
    out.set(userId, had ? strongerKind(had, kind) : kind);
  };
  const byLogin = (login: string) => s.usersByLogin.get(login.toLowerCase())?.id;
  const facts = event.data as Facts;
  const watchers = async () => {
    if (issueId) for (const id of await watcherIds(app.db, issueId)) add(id, 'watching');
  };
  switch (event.type) {
    case 'issue.created': {
      for (const l of facts.assigned ?? []) add(byLogin(l), 'assigned');
      for (const l of facts.mentions ?? []) add(byLogin(l), 'mentioned');
      // A new help desk request: its project's lead is told, and watches it (services/helpdesk.ts).
      const lead = projectId ? s.projects.get(projectId)?.leadId : null;
      if (facts.requester && lead) add(lead, 'request');
      break;
    }
    case 'issue.updated':
      for (const l of facts.assigned ?? []) add(byLogin(l), 'assigned');
      for (const l of facts.mentions ?? []) add(byLogin(l), 'mentioned');
      await watchers();
      break;
    case 'comment.created':
      for (const l of facts.mentions ?? []) add(byLogin(l), 'mentioned');
      await watchers();
      break;
    case 'comment.updated':
      for (const l of facts.mentions ?? []) add(byLogin(l), 'mentioned');
      break;
    case 'link.created':
    case 'link.deleted':
    case 'issue.moved':
      await watchers();
      break;
    case 'attachment.added':
    case 'attachment.removed':
      // A comment's files go with the comment, whose own event told its watchers.
      if (!(event.data as { commentId?: unknown }).commentId) await watchers();
      break;
    case 'issue.deleted':
      for (const l of facts.watchers ?? []) add(byLogin(l), 'watching');
      break;
    case 'sla.warning':
    case 'sla.breached':
      // What time brings to a request's targets (D45): who watches it (its desk's lead does).
      await watchers();
      break;
    case 'rule.notified': {
      // A workflow rule's message: to the people it worked out when it acted (workflow/tell.ts).
      const people = (event.data as { people?: unknown }).people;
      if (Array.isArray(people)) for (const l of people) if (typeof l === 'string') add(byLogin(l), 'rule');
      break;
    }
    default:
      break;
  }
  return out;
}

const WATCHED_TYPES = ['issue.created', 'issue.updated', 'issue.moved', 'issue.deleted', 'comment.created', 'comment.updated', 'link.created', 'link.deleted', 'attachment.added', 'attachment.removed', 'sla.warning', 'sla.breached'];
const SEARCH_TYPES = new Set<string>(SEARCH_EVENT_TYPES);

export function notifierConsumer(app: AppServices): OutboxConsumer {
  return {
    name: 'notifications',
    // What tells people, and what moves an issue in or out of a saved search someone subscribed to,
    // and a workflow rule's message to the people it names (D32).
    types: [...new Set([...WATCHED_TYPES, ...SEARCH_EVENT_TYPES, 'rule.notified'])] as TrackerEvent['type'][],
    handle: (event) => notifyEvent(app, event),
  };
}

export async function notifyEvent(app: AppServices, event: TrackerEvent): Promise<void> {
  // An import brings history, not news: what it writes is in each issue's history, and tells nobody.
  const imported = Boolean((event.data as { imported?: unknown } | undefined)?.imported);
  if (imported && !SEARCH_TYPES.has(event.type)) return;
  // The activity row has what the event's public shape leaves out: the issue's and project's ids.
  const [row] = await app.db
    .select({ issueId: activities.issueId, projectId: activities.projectId, actorId: activities.actorId })
    .from(activities)
    .where(eq(activities.id, event.id));
  if (!row || !event.issue) return;
  // An event about an issue belongs to its project; without one, nobody but an administrator could see it.
  if (!row.projectId) return;
  // Saved searches' subscriptions keep up with every change to an issue, an import's too, so what an
  // import brought in isn't told later as if it had just come into a search.
  const fromSearches = row.issueId && SEARCH_TYPES.has(event.type) ? await searchSubscribed(app, event, row.issueId, row.projectId) : [];
  if (imported) return;
  // The SLA status field's own change says what an sla.* event says already (D45): it moves
  // searches, and tells nobody else.
  const slaField = Boolean((event.data as { sla?: unknown } | undefined)?.sla);
  const recipients = slaField ? new Map<string, NotificationKind>() : await recipientsOf(app, event, row.issueId, row.projectId);
  // Subscribers (D31): the weakest reason. A search's subscription is named before a project's, as
  // the more particular, and a person is emailed if any of theirs asks for it.
  const subscribed = new Map<string, { id: string; email: boolean }>();
  for (const r of [...fromSearches, ...(await projectSubscribed(app, event, row.projectId))]) {
    const had = recipients.get(r.userId);
    recipients.set(r.userId, had ? strongerKind(had, 'subscribed') : 'subscribed');
    const known = subscribed.get(r.userId);
    subscribed.set(r.userId, known ? { id: known.id, email: known.email || r.email } : { id: r.subscriptionId, email: r.email });
  }
  if (row.actorId) recipients.delete(row.actorId); // never whoever acted
  if (!recipients.size) return;
  const s = await app.schema.get();
  const ids = [...recipients.keys()];
  const seeing = [await projectRolesOf(app.db, row.projectId, ids)];
  if (event.type === 'link.created' || event.type === 'link.deleted') {
    // A link names the issue at its other end: only who can see that one too hears of it.
    const key = keyOfReadableId((event.data as { target?: { id?: unknown } } | undefined)?.target?.id);
    const other = key ? s.projectsByKey.get(key) : undefined;
    if (!other) return;
    seeing.push(await projectRolesOf(app.db, other.id, ids));
  }
  // Each person's choice of the kinds of change that tell them, and how (D45).
  const choices = await choicesFor(app.db, event, recipients, subscribed);
  const told: string[] = [];
  for (const [userId, kind] of recipients) {
    const choice = choices.get(userId);
    if (choice && !choice.inbox) continue;
    const user = s.users.get(userId);
    if (!user || user.banned) continue;
    if (!seeing.every((roles) => roles.has(userId))) continue;
    // The issue, the comment or the link's other end limited away from them (D37): not theirs to hear of.
    const view = await accessFor(app.db, user);
    if (!(await eventSeen(view, app.db, s, event))) continue;
    // Nor a change only to private fields kept from them (D50).
    if (!eventFor(view, s, event)) continue;
    try {
      if (await deliver(app, event, event.issue, userId, kind, row.issueId, row.projectId, subscribed.get(userId) ?? null, choice?.email ?? true)) told.push(userId);
    } catch (e) {
      // Another instance delivered it at the same moment (its lease ran out mid-batch): it's done.
      const code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code;
      if (code === '23505') continue;
      // One person's failure mustn't keep the event from the others; the outbox moves on.
      console.error(`notifications: event ${event.id} for user ${userId} failed`, e);
    }
  }
  inboxChanged(app, told);
}

/**
 * The chore that reads the searches again (D31): what time alone brings into them, an issue
 * becoming overdue or a day rolling past 'today'. Only a search whose words read the clock is read
 * (its dates, or an SLA state), as its person would read it, and only its 'new' subscribers are
 * told: an issue coming in by time is news, not a change, so 'every change' subscribers hear nothing.
 * What each search finds is kept as the events keep it, so what time takes out is not told as
 * coming back in later. Returns how many people were told.
 */
export async function recheckSearches(app: AppServices): Promise<number> {
  const subs = await app.db
    .select({ id: subscriptions.id, userId: subscriptions.userId, email: subscriptions.email, query: savedSearches.query, ownerId: savedSearches.ownerId, shared: savedSearches.shared })
    .from(subscriptions)
    .innerJoin(savedSearches, eq(savedSearches.id, subscriptions.savedSearchId))
    .where(and(isNotNull(subscriptions.savedSearchId), eq(subscriptions.events, 'new')));
  // A search no longer shared with someone has nothing for them to follow.
  const live = subs.filter((r) => r.shared || r.ownerId === r.userId);
  if (!live.length) return 0;
  const s = await app.schema.get();
  let told = 0;
  for (const sub of live) {
    const user = s.users.get(sub.userId);
    if (!user || user.banned) continue;
    const prepared = await prepareQuery(personCtx(app, user), sub.query);
    if (prepared.compiled.problems.length) continue;
    if (!prepared.compiled.readsDates && !prepared.compiled.readsNow) continue;
    const found = await app.db
      .select({ id: issues.id, projectId: issues.projectId })
      .from(issues)
      .where(prepared.compiled.where ?? sql`TRUE`);
    const inSearch = new Set(found.map((r) => r.id));
    const had = new Set(
      (await app.db.select({ issueId: subscriptionIssues.issueId }).from(subscriptionIssues).where(eq(subscriptionIssues.subscriptionId, sub.id))).map((r) => r.issueId),
    );
    const wentOut = [...had].filter((id) => !inSearch.has(id));
    if (wentOut.length) {
      await app.db.delete(subscriptionIssues).where(and(eq(subscriptionIssues.subscriptionId, sub.id), inArray(subscriptionIssues.issueId, wentOut)));
    }
    const cameIn = found.filter((r) => !had.has(r.id));
    if (!cameIn.length) continue;
    await app.db.insert(subscriptionIssues).values(cameIn.map((r) => ({ subscriptionId: sub.id, issueId: r.id }))).onConflictDoNothing();
    const refs = await issueRefsById(app.db, s, cameIn.map((r) => r.id));
    for (const row of cameIn) {
      const ref = refs.get(row.id);
      if (!ref) continue;
      // A fact of its own, no event to fold: its notification says what time did, in the words
      // the title has for a search with no event behind it.
      const fact = { id: null, occurredAt: new Date().toISOString() };
      if (await deliver(app, fact, ref, sub.userId, 'subscribed', row.id, row.projectId, { id: sub.id, email: sub.email })) told++;
    }
  }
  return told;
}

/** Fold one event into one person's inbox. False when it had reached them already. */
export async function deliver(
  app: AppServices,
  /** An event, or a fact of time with no event behind it (id null): what the search chore tells of. */
  event: Pick<TrackerEvent, 'occurredAt'> & { id: number | null },
  issue: IssueRef,
  userId: string,
  kind: NotificationKind,
  issueId: string | null,
  projectId: string | null,
  /** The subscription that brought it, when one did: named in the inbox, and it may ask for email. */
  subscription: { id: string; email: boolean } | null = null,
  /** Whether this kind of change may email them, as they chose (D45). */
  emailKind = true,
): Promise<boolean> {
  const at = new Date(event.occurredAt);
  const window = app.config.notifyWindowMs;
  const eventId = event.id;
  let pushed = false;
  const delivered = await app.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    if (eventId === null) {
      // A fact of time has no event to have reached them already.
    } else {
      const [done] = await tx
        .select({ id: notificationEvents.eventId })
        .from(notificationEvents)
        .where(and(eq(notificationEvents.userId, userId), eq(notificationEvents.eventId, eventId)));
      if (done) return false;
    }
    // An unread one about the same issue, begun within the window and not yet emailed, takes it.
    const [open] =
      issueId && window > 0
        ? await tx
            .select()
            .from(notifications)
            .where(
              and(
                eq(notifications.userId, userId),
                eq(notifications.issueId, issueId),
                isNull(notifications.readAt),
                isNull(notifications.sealedAt),
                gt(notifications.firstEventAt, new Date(at.getTime() - window)),
              ),
            )
            .orderBy(desc(notifications.firstEventAt))
            .limit(1)
            .for('update')
        : [];
    let notificationId: string;
    let notificationKind: NotificationKind;
    let firstAt: Date;
    if (open) {
      notificationId = open.id;
      notificationKind = strongerKind(open.kind as NotificationKind, kind);
      firstAt = open.firstEventAt;
      await tx
        .update(notifications)
        .set({
          kind: notificationKind,
          issue,
          eventCount: sql`${notifications.eventCount} + 1`,
          lastEventAt: sql`greatest(${notifications.lastEventAt}, ${at})`,
          ...(subscription ? { subscriptionId: sql`coalesce(${notifications.subscriptionId}, ${subscription.id})` } : {}),
        })
        .where(eq(notifications.id, open.id));
    } else {
      notificationId = newId();
      notificationKind = kind;
      firstAt = at;
      await tx.insert(notifications).values({
        id: notificationId,
        userId,
        issueId,
        projectId,
        kind,
        issue,
        eventCount: 1,
        firstEventAt: at,
        lastEventAt: at,
        subscriptionId: subscription?.id ?? null,
      });
    }
    // With no event behind it (a fact of time), there is nothing to remember: the chore's own
    // keeping of what each search finds is what makes it once.
    if (eventId !== null) await tx.insert(notificationEvents).values({ userId, eventId, notificationId, reason: kind });
    const prefs = await emailPrefs(tx, userId);

    // Its push to each of their devices, a moment from now, if their level sends its kind (D47).
    if (await enqueuePushes(tx, app, { id: notificationId, userId, kind: notificationKind }, prefs.push)) pushed = true;

    // Its email, if this person wants this kind: sent once the window has passed, as one message.
    if (mailConfigured(app)) {
      const [user] = await tx.select({ email: users.email, isBot: users.isBot }).from(users).where(eq(users.id, userId));
      if (emailKind && user?.email && !user.isBot && emailSends(prefs.email, notificationKind, subscription)) {
        await enqueueMail(tx, app, {
          kind: 'notification',
          dedupeKey: `notification:${notificationId}`,
          userId,
          payload: { notificationId },
          sendAfter: new Date(firstAt.getTime() + window + SEAL_MARGIN_MS),
          messageId: `n-${notificationId}`,
        });
      }
    }
    return true;
  });
  // Committed: the sender here goes once the push is due.
  if (pushed) kickPushSoon(app);
  return delivered;
}
