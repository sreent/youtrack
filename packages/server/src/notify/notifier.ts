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
 */
import { EMAIL_LEVELS, NOTIFICATION_KINDS, type EmailLevel, type IssueRef, type NotificationKind, type TrackerEvent } from '@a4a/shared';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { AppServices } from '../context';
import type { Db } from '../db/client';
import { activities, notificationEvents, notifications, notificationSettings, users } from '../db/schema';
import type { OutboxConsumer } from '../events/worker';
import { newId } from '../lib/ids';
import { enqueueMail } from '../mail/outbox';
import { keyOfReadableId, projectRolesOf } from '../services/access';
import { watcherIds } from '../services/watchers';
import { inboxChanged, mailConfigured } from './state';

const RANK: Record<NotificationKind, number> = Object.fromEntries(NOTIFICATION_KINDS.map((k, i) => [k, i])) as Record<NotificationKind, number>;

export function strongerKind(a: NotificationKind, b: NotificationKind): NotificationKind {
  return RANK[b] > RANK[a] ? b : a;
}

/** Whether an email level sends this kind: direct sends what calls on the person, all sends everything. */
export function levelSends(level: EmailLevel, kind: NotificationKind): boolean {
  if (level === 'all') return true;
  if (level === 'direct') return kind !== 'watching';
  return false;
}

export interface EmailPrefs {
  email: EmailLevel;
  digest: boolean;
}

export const DEFAULT_PREFS: EmailPrefs = { email: 'direct', digest: false };

export async function emailPrefs(db: Db, userId: string): Promise<EmailPrefs> {
  const [row] = await db.select().from(notificationSettings).where(eq(notificationSettings.userId, userId));
  if (!row) return DEFAULT_PREFS;
  const email = (EMAIL_LEVELS as readonly string[]).includes(row.email) ? (row.email as EmailLevel) : DEFAULT_PREFS.email;
  return { email, digest: row.digest };
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

export function notifierConsumer(app: AppServices): OutboxConsumer {
  return {
    name: 'notifications',
    types: [
      'issue.created',
      'issue.updated',
      'issue.deleted',
      'comment.created',
      'comment.updated',
      'link.created',
      'link.deleted',
      'attachment.added',
      'attachment.removed',
      'rule.notified',
    ],
    handle: (event) => notifyEvent(app, event),
  };
}

export async function notifyEvent(app: AppServices, event: TrackerEvent): Promise<void> {
  // An import brings history, not news: what it writes is in each issue's history, and tells nobody.
  if ((event.data as { imported?: unknown } | undefined)?.imported) return;
  // The activity row has what the event's public shape leaves out: the issue's and project's ids.
  const [row] = await app.db
    .select({ issueId: activities.issueId, projectId: activities.projectId, actorId: activities.actorId })
    .from(activities)
    .where(eq(activities.id, event.id));
  if (!row || !event.issue) return;
  // An event about an issue belongs to its project; without one, nobody but an administrator could see it.
  if (!row.projectId) return;
  const recipients = await recipientsOf(app, event, row.issueId, row.projectId);
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
  const told: string[] = [];
  for (const [userId, kind] of recipients) {
    const user = s.users.get(userId);
    if (!user || user.banned) continue;
    if (!seeing.every((roles) => roles.has(userId))) continue;
    try {
      if (await deliver(app, event, event.issue, userId, kind, row.issueId, row.projectId)) told.push(userId);
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

/** Fold one event into one person's inbox. False when it had reached them already. */
async function deliver(
  app: AppServices,
  event: TrackerEvent,
  issue: IssueRef,
  userId: string,
  kind: NotificationKind,
  issueId: string | null,
  projectId: string | null,
): Promise<boolean> {
  const at = new Date(event.occurredAt);
  const window = app.config.notifyWindowMs;
  return app.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [done] = await tx
      .select({ id: notificationEvents.eventId })
      .from(notificationEvents)
      .where(and(eq(notificationEvents.userId, userId), eq(notificationEvents.eventId, event.id)));
    if (done) return false;
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
      });
    }
    await tx.insert(notificationEvents).values({ userId, eventId: event.id, notificationId, reason: kind });

    // Its email, if this person wants this kind: sent once the window has passed, as one message.
    if (mailConfigured(app)) {
      const [user] = await tx.select({ email: users.email, isBot: users.isBot }).from(users).where(eq(users.id, userId));
      const prefs = await emailPrefs(tx, userId);
      if (user?.email && !user.isBot && levelSends(prefs.email, notificationKind)) {
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
}
