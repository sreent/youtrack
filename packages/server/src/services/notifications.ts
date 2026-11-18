/**
 * A person's notifications: their inbox, what they've read, and what they want by email. All of
 * it is their own: nobody else's inbox can be read or changed, and none of it is an issue's history.
 */
import type {
  EmailLevel,
  IssueRef,
  Notification,
  NotificationKind,
  NotificationList,
  NotificationSettings,
  TrackerEvent,
  Unsubscribe,
} from '@a4a/shared';
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { requireScope, type AppServices, type Ctx } from '../context';
import type { Db } from '../db/client';
import { activities, helpdeskRequests, notificationEvents, notifications, notificationSettings, subscriptions } from '../db/schema';
import { toEventDto } from '../events/activity';
import { badRequest, notFound } from '../lib/errors';
import { DEFAULT_PREFS, emailPrefs } from '../notify/notifier';
import { inboxChanged, mailConfigured, sign, verify } from '../notify/state';
import { notificationTitle } from '../notify/words';
import { eventFor, eventSeen, goneIssueSql, issueSeenSql, projectAccess, visibleProjectIds } from './access';
import { findVisibleIssue } from './issues';
import type { SchemaSnapshot } from './schema-cache';
import { aboutInline, aboutSubscriptions } from './subscriptions';
import { ccById, stopCopy } from './request-ccs';
import { zoneOf } from './time-zones';
import { requirePersonal } from './watchers';
import { translatorFor } from '../i18n';

type NotificationRow = typeof notifications.$inferSelect;

/**
 * The events each notification folds together, oldest first, with why each reached its person: the
 * last 20, of those `visible` lets through (what its reader may see now; a link to an issue they
 * can't see is left out, as it is from the issue's history).
 */
export async function eventsOf(
  db: Db,
  s: SchemaSnapshot,
  ids: string[],
  opts: {
    last?: number;
    visible?: (e: TrackerEvent) => boolean | Promise<boolean>;
    /** The event as its reader may read it, or null to leave it out: changes to private fields kept from them taken out (D50). */
    shape?: (e: TrackerEvent) => TrackerEvent | null;
  } = {},
): Promise<Map<string, { events: TrackerEvent[]; reasons: Map<number, NotificationKind> }>> {
  const last = opts.last ?? 20;
  const out = new Map<string, { events: TrackerEvent[]; reasons: Map<number, NotificationKind> }>();
  if (!ids.length) return out;
  const rows = await db
    .select({ notificationId: notificationEvents.notificationId, reason: notificationEvents.reason, activity: activities })
    .from(notificationEvents)
    .innerJoin(activities, eq(activities.id, notificationEvents.eventId))
    .where(inArray(notificationEvents.notificationId, ids))
    .orderBy(asc(activities.id));
  for (const r of rows) {
    const dto = toEventDto(s, r.activity);
    if (opts.visible && !(await opts.visible(dto))) continue;
    const event = opts.shape ? opts.shape(dto) : dto;
    if (!event) continue;
    let entry = out.get(r.notificationId);
    if (!entry) out.set(r.notificationId, (entry = { events: [], reasons: new Map() }));
    entry.events.push(event);
    entry.reasons.set(r.activity.id, r.reason as NotificationKind);
  }
  for (const entry of out.values()) if (entry.events.length > last) entry.events = entry.events.slice(-last);
  return out;
}

async function dtos(ctx: Ctx, rows: NotificationRow[]): Promise<Notification[]> {
  const s = await ctx.app.schema.get();
  const view = await projectAccess(ctx);
  const events = await eventsOf(ctx.db, s, rows.map((r) => r.id), { visible: (e) => eventSeen(view, ctx.db, s, e), shape: (e) => eventFor(view, s, e) });
  // What a subscribed one came for (D31), while that subscription lasts.
  const subscribed = rows.filter((r) => r.kind === 'subscribed' && r.subscriptionId);
  const abouts = await aboutSubscriptions(ctx.db, s, subscribed.map((r) => r.subscriptionId!));
  return rows.map((r) => {
    const sub = r.kind === 'subscribed' && r.subscriptionId ? abouts.get(r.subscriptionId) : undefined;
    const e = events.get(r.id) ?? { events: [], reasons: new Map() };
    const project = r.projectId ? s.projects.get(r.projectId) : undefined;
    return {
      id: r.id,
      kind: r.kind as NotificationKind,
      title: notificationTitle(translatorFor(ctx.locale), r.kind as NotificationKind, e.events, e.reasons),
      issue: r.issue as IssueRef,
      project: project?.key ?? null,
      issueDeleted: r.issueId === null,
      events: e.events,
      eventCount: r.eventCount,
      firstAt: r.firstEventAt.toISOString(),
      lastAt: r.lastEventAt.toISOString(),
      readAt: r.readAt?.toISOString() ?? null,
      subscription: sub && sub.userId === r.userId ? { id: r.subscriptionId!, about: aboutInline(sub.about), target: sub.target, events: sub.events, name: sub.name } : null,
    };
  });
}

/** Yours, in projects you can still read (a project you've lost access to drops out of your inbox). */
async function mine(ctx: Ctx): Promise<SQL> {
  const conds: SQL[] = [eq(notifications.userId, ctx.actor.user.id)];
  const visible = await visibleProjectIds(ctx);
  if (visible !== null) {
    conds.push(visible.length ? inArray(notifications.projectId, visible) : sql`FALSE`);
  }
  // Nor an issue limited away from you since (D37): it drops out as its project would.
  const seen = issueSeenSql(await projectAccess(ctx), await ctx.app.schema.get(), 'seen_ni');
  if (seen) conds.push(sql`NOT EXISTS (SELECT 1 FROM issues seen_ni WHERE seen_ni.id = ${notifications.issueId} AND NOT ${seen})`);
  // Nor one deleted while it was limited, which stays as hidden once gone (D37).
  const gone = goneIssueSql(await projectAccess(ctx), sql`${notifications.issue}->>'id'`, sql`${notifications.projectId}`);
  if (gone) conds.push(sql`NOT (${notifications.issueId} IS NULL AND ${gone})`);
  return and(...conds)!;
}

export async function unreadCount(ctx: Ctx): Promise<number> {
  requirePersonalRead(ctx);
  const [row] = await ctx.db.select({ n: count() }).from(notifications).where(and(await mine(ctx), isNull(notifications.readAt)));
  return Number(row?.n ?? 0);
}

/** Reading your inbox needs only "read": an agent with a read-only token may see what waits for its person. */
function requirePersonalRead(ctx: Ctx): void {
  requireScope(ctx, 'read');
}

export async function listNotifications(
  ctx: Ctx,
  opts: { unread?: boolean; issue?: string; offset?: number; limit?: number } = {},
): Promise<NotificationList> {
  requirePersonalRead(ctx);
  const conds: SQL[] = [await mine(ctx)];
  if (opts.unread) conds.push(isNull(notifications.readAt));
  if (opts.issue) {
    // An issue the caller can't see is not found, in the words used for one that doesn't exist.
    const row = await findVisibleIssue(ctx, opts.issue);
    if (!row) throw notFound(`Issue ${opts.issue}`, 'Use a readable id such as BACK-12.').said('notifications.issueNotFound', { id: opts.issue });
    conds.push(eq(notifications.issueId, row.id));
  }
  const where = and(...conds);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const [rows, [total], unread] = await Promise.all([
    ctx.db
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.lastEventAt), desc(notifications.id))
      .limit(limit)
      .offset(opts.offset ?? 0),
    ctx.db.select({ n: count() }).from(notifications).where(where),
    unreadCount(ctx),
  ]);
  return { unread, total: Number(total?.n ?? 0), items: await dtos(ctx, rows) };
}

export async function getNotification(ctx: Ctx, id: string): Promise<Notification> {
  requirePersonalRead(ctx);
  const [row] = await ctx.db.select().from(notifications).where(and(await mine(ctx), eq(notifications.id, id)));
  if (!row) throw notFound('Notification', 'Notifications are only ever their own person\'s: list yours with GET /notifications.').said('notifications.notificationNotFound');
  return (await dtos(ctx, [row]))[0]!;
}

/**
 * Mark notifications read (or unread again). With `until`, only those whose latest event came no
 * later, so a change that arrived after the person looked stays unread for them to see.
 */
export async function markNotifications(
  ctx: Ctx,
  input: { ids?: string[]; issue?: string; all?: boolean; until?: string; read?: boolean },
): Promise<{ changed: number; unread: number }> {
  requirePersonal(ctx);
  if (!input.ids?.length && !input.issue && !input.all) throw badRequest('Say which notifications', 'Send "ids", an "issue", or "all": true.').said('notifications.sayWhich');
  const read = input.read ?? true;
  // Only what the caller's inbox shows: a token limited to some projects marks nothing elsewhere.
  const conds: SQL[] = [await mine(ctx), read ? isNull(notifications.readAt) : isNotNull(notifications.readAt)];
  if (input.ids?.length) conds.push(inArray(notifications.id, input.ids));
  if (input.issue) {
    const row = await findVisibleIssue(ctx, input.issue);
    if (!row) throw notFound(`Issue ${input.issue}`, 'Use a readable id such as BACK-12.').said('notifications.issueNotFound', { id: input.issue });
    conds.push(eq(notifications.issueId, row.id));
  }
  if (input.until) {
    const until = new Date(input.until);
    if (Number.isNaN(until.getTime())) throw badRequest(`"until" isn't a time: ${input.until}`).said('notifications.untilNotATime', { until: input.until });
    conds.push(lte(notifications.lastEventAt, until));
  }
  const changed = await ctx.db
    .update(notifications)
    .set({ readAt: read ? new Date() : null })
    .where(and(...conds))
    .returning({ id: notifications.id });
  if (changed.length) inboxChanged(ctx.app, ctx.actor.user.id);
  return { changed: changed.length, unread: await unreadCount(ctx) };
}

// ---------------------------------------------------------------------------
// What a person wants by email
// ---------------------------------------------------------------------------

export async function getNotificationSettings(ctx: Ctx): Promise<NotificationSettings> {
  requirePersonalRead(ctx);
  const prefs = await emailPrefs(ctx.db, ctx.actor.user.id);
  return { ...prefs, address: ctx.actor.user.email, mailConfigured: mailConfigured(ctx.app), digestHour: ctx.app.config.digestHour, timeZone: zoneOf(ctx) };
}

export async function updateNotificationSettings(ctx: Ctx, input: { email?: EmailLevel; push?: EmailLevel; digest?: boolean }): Promise<NotificationSettings> {
  requirePersonal(ctx);
  await saveSettings(ctx.db, ctx.actor.user.id, input);
  return getNotificationSettings(ctx);
}

async function saveSettings(db: Db, userId: string, input: { email?: EmailLevel; push?: EmailLevel; digest?: boolean }): Promise<void> {
  const now = new Date();
  await db
    .insert(notificationSettings)
    .values({ userId, email: input.email ?? DEFAULT_PREFS.email, push: input.push ?? DEFAULT_PREFS.push, digest: input.digest ?? DEFAULT_PREFS.digest, updatedAt: now })
    .onConflictDoUpdate({
      target: notificationSettings.userId,
      set: {
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.push !== undefined ? { push: input.push } : {}),
        ...(input.digest !== undefined ? { digest: input.digest } : {}),
        updatedAt: now,
      },
    });
}

// ---------------------------------------------------------------------------
// One-click unsubscribe (RFC 8058): a signed link per kind of email, which works without signing in
// ---------------------------------------------------------------------------

/**
 * What a link stops. Email levels nest (all, direct, none), so stopping the emails about issues you
 * watch leaves mentions and assignments, and stopping those stops email about issues altogether.
 * A subscription's link stops that subscription's emails, and leaves it telling your inbox (D31).
 * A requester's link stops email about their one request. Someone copied on a request (D57) stops
 * being copied: they're told nothing more of it, and their replies by email are refused.
 */
export type UnsubscribeKind = 'watching' | 'direct' | 'digest' | 'request' | 'subscription' | 'cc';
const KINDS: UnsubscribeKind[] = ['watching', 'direct', 'digest', 'request', 'subscription', 'cc'];

const WORDS: Record<Exclude<UnsubscribeKind, 'subscription'>, string> = {
  watching: 'Emails about changes and comments on issues you watch. Mentions and assignments still come by email.',
  direct: 'Emails about issues, mentions and assignments too. Your inbox in a4a keeps everything.',
  digest: 'The daily digest.',
  request: 'Emails about this request. Its page still shows every reply.',
  cc: 'Emails about this request: you stop being copied on it.',
};

/** What a link stops, in words: a subscription's, by what it tells of. */
async function wordsFor(app: AppServices, kind: UnsubscribeKind, subject: string): Promise<Pick<Unsubscribe, 'what' | 'subscription'>> {
  if (kind !== 'subscription') return { what: WORDS[kind], subscription: null };
  const about = (await aboutSubscriptions(app.db, await app.schema.get(), [subject])).get(subject);
  if (!about) return { what: 'Emails from a subscription that has ended.', subscription: null };
  return { what: `Emails about ${aboutInline(about.about)}. Your inbox in a4a still has them.`, subscription: { target: about.target, events: about.events, name: about.name } };
}

/** For a person's kinds, `subject` is their user id; for a subscription's, its id; for a requester's, the request's issue id; for a CC's, its row's id. */
export async function unsubscribeToken(app: AppServices, kind: UnsubscribeKind, subject: string): Promise<string> {
  return `${kind}.${subject}.${await sign(app, 'unsubscribe', `${kind}.${subject}`)}`;
}

async function readToken(app: AppServices, token: string): Promise<{ kind: UnsubscribeKind; subject: string }> {
  const [kind, subject, sig, ...rest] = token.split('.');
  const bad = () => notFound('This unsubscribe link', 'It may have been copied only in part. Choose what a4a emails you under Your profile.').said('notifications.unsubscribeLinkBroken');
  if (rest.length || !kind || !subject || !sig || !KINDS.includes(kind as UnsubscribeKind)) throw bad();
  if (!(await verify(app, 'unsubscribe', `${kind}.${subject}`, sig))) throw bad();
  return { kind: kind as UnsubscribeKind, subject };
}

export async function describeUnsubscribe(app: AppServices, token: string): Promise<Unsubscribe> {
  const { kind, subject } = await readToken(app, token);
  return { kind, ...(await wordsFor(app, kind, subject)), done: await isStopped(app.db, kind, subject) };
}

async function isStopped(db: Db, kind: UnsubscribeKind, subject: string): Promise<boolean> {
  if (kind === 'subscription') {
    const [sub] = await db.select({ email: subscriptions.email }).from(subscriptions).where(eq(subscriptions.id, subject));
    return !sub?.email;
  }
  if (kind === 'request') {
    const [r] = await db.select({ muted: helpdeskRequests.emailMutedAt }).from(helpdeskRequests).where(eq(helpdeskRequests.issueId, subject));
    return Boolean(r?.muted);
  }
  // Taken off the request, by the team or themselves, or the request is gone: nothing comes.
  if (kind === 'cc') {
    const cc = await ccById(db, subject);
    return !cc || cc.removedAt !== null;
  }
  const prefs = await emailPrefs(db, subject);
  if (kind === 'digest') return !prefs.digest;
  if (kind === 'watching') return prefs.email !== 'all';
  return prefs.email === 'none';
}

/** Stop what the link stops. Doing it twice is the same as once. */
export async function applyUnsubscribe(app: AppServices, token: string): Promise<Unsubscribe> {
  const { kind, subject } = await readToken(app, token);
  if (kind === 'subscription') {
    // One that has ended sends nothing already: done all the same.
    await app.db.update(subscriptions).set({ email: false, updatedAt: new Date() }).where(eq(subscriptions.id, subject));
  } else if (kind === 'request') {
    await app.db
      .update(helpdeskRequests)
      .set({ emailMutedAt: new Date() })
      .where(and(eq(helpdeskRequests.issueId, subject), isNull(helpdeskRequests.emailMutedAt)));
  } else if (kind === 'cc') {
    // They stop being copied (D57), and the request's history says they did.
    await stopCopy(app, subject);
  } else {
    const s = await app.schema.get();
    if (!s.users.get(subject)) throw notFound('This unsubscribe link').said('notifications.unsubscribeLinkNotFound');
    const prefs = await emailPrefs(app.db, subject);
    if (kind === 'digest') await saveSettings(app.db, subject, { digest: false });
    else if (kind === 'watching' && prefs.email === 'all') await saveSettings(app.db, subject, { email: 'direct' });
    else if (kind === 'direct') await saveSettings(app.db, subject, { email: 'none' });
  }
  return { kind, ...(await wordsFor(app, kind, subject)), done: true };
}

/** Notifications of a person, unread and not emailed, whose latest event falls in (since, until]: a digest's. */
export async function digestRows(db: Db, userId: string, since: Date, until: Date): Promise<NotificationRow[]> {
  return db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        isNull(notifications.emailedAt),
        gt(notifications.lastEventAt, since),
        lte(notifications.lastEventAt, until),
      ),
    )
    .orderBy(desc(notifications.lastEventAt))
    .limit(200);
}
