/**
 * Subscriptions by kind (D45): which kinds of change tell a person, and by which way. For what they
 * watch, and their subscriptions' default; a subscription may choose for itself. Being mentioned or
 * assigned, a rule's message and a new request for a desk's lead always tell them, as before.
 */
import { NOTIFY_KINDS, type NotificationKind, type NotifyKind, type NotifyKinds, type NotifyKindsSettings, type TrackerEvent } from '@a4a/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { notifyKinds, subscriptions } from '../db/schema';
import { notFound } from '../lib/errors';

type Choice = { inbox: boolean; email: boolean };
const ALL: Choice = { inbox: true, email: true };
/** Reasons that call on the person: their choices of kinds don't stop these. */
const ALWAYS = new Set<NotificationKind>(['mentioned', 'assigned', 'rule', 'request']);

/** The kind of change an event is, as a person chooses them. */
export function kindOfEvent(event: Pick<TrackerEvent, 'type' | 'changes' | 'data'>): NotifyKind {
  switch (event.type) {
    case 'issue.created':
      return 'created';
    case 'comment.created':
    case 'comment.updated':
      return 'commented';
    case 'link.created':
    case 'link.deleted':
      return 'linked';
    case 'attachment.added':
    case 'attachment.removed':
      return 'attachments';
    case 'sla.warning':
    case 'sla.breached':
      return 'sla';
    case 'issue.updated': {
      const names = (event.changes ?? []).map((c) => c.field.toLowerCase());
      if ((event.data as { sla?: unknown } | undefined)?.sla || (names.length && names.every((n) => n === 'sla status'))) return 'sla';
      if (names.includes('state')) return 'state';
      if (names.includes('assignee')) return 'assigned';
      return 'fields';
    }
    default:
      return 'fields';
  }
}

function filled(kinds: NotifyKinds | null | undefined): Record<NotifyKind, Choice> {
  return Object.fromEntries(NOTIFY_KINDS.map((k) => [k, kinds?.[k] ?? ALL])) as Record<NotifyKind, Choice>;
}

/** Each recipient's choice for this event: whether it reaches their inbox, and their email. */
export async function choicesFor(
  db: Db,
  event: Pick<TrackerEvent, 'type' | 'changes' | 'data'>,
  recipients: Map<string, NotificationKind>,
  subscribed: Map<string, { id: string }>,
): Promise<Map<string, Choice>> {
  const kind = kindOfEvent(event);
  const ids = [...recipients.keys()];
  const out = new Map<string, Choice>();
  if (!ids.length) return out;
  const prefs = new Map((await db.select().from(notifyKinds).where(inArray(notifyKinds.userId, ids))).map((r) => [r.userId, r]));
  const subIds = [...subscribed.values()].map((s) => s.id);
  const subKinds = new Map(subIds.length ? (await db.select({ id: subscriptions.id, kinds: subscriptions.kinds }).from(subscriptions).where(inArray(subscriptions.id, subIds))).map((r) => [r.id, r.kinds]) : []);
  for (const [userId, reason] of recipients) {
    if (ALWAYS.has(reason)) {
      out.set(userId, ALL);
      continue;
    }
    const mine = prefs.get(userId);
    const choice =
      reason === 'subscribed'
        ? ((subKinds.get(subscribed.get(userId)?.id ?? '') as NotifyKinds | null | undefined)?.[kind] ?? (mine?.defaults as NotifyKinds | undefined)?.[kind] ?? ALL)
        : ((mine?.watching as NotifyKinds | undefined)?.[kind] ?? ALL);
    out.set(userId, choice);
  }
  return out;
}

export async function myKinds(ctx: Ctx): Promise<NotifyKindsSettings> {
  requireScope(ctx, 'read');
  const [row] = await ctx.db.select().from(notifyKinds).where(eq(notifyKinds.userId, ctx.actor.user.id));
  const subs = await ctx.db.select({ id: subscriptions.id, kinds: subscriptions.kinds }).from(subscriptions).where(eq(subscriptions.userId, ctx.actor.user.id));
  return {
    watching: filled(row?.watching as NotifyKinds | undefined),
    defaults: filled(row?.defaults as NotifyKinds | undefined),
    always: ['being mentioned', 'being assigned', "a rule's message to you", 'a new request at a desk you lead'],
    subscriptions: subs.map((s) => ({ id: s.id, kinds: (s.kinds as NotifyKinds | null) ?? null })),
  };
}

export async function setMyKinds(ctx: Ctx, input: { watching?: NotifyKinds; defaults?: NotifyKinds }): Promise<NotifyKindsSettings> {
  requireScope(ctx, 'write');
  const [row] = await ctx.db.select().from(notifyKinds).where(eq(notifyKinds.userId, ctx.actor.user.id));
  const watching = { ...((row?.watching as NotifyKinds | undefined) ?? {}), ...(input.watching ?? {}) };
  const defaults = { ...((row?.defaults as NotifyKinds | undefined) ?? {}), ...(input.defaults ?? {}) };
  await ctx.db
    .insert(notifyKinds)
    .values({ userId: ctx.actor.user.id, watching, defaults })
    .onConflictDoUpdate({ target: notifyKinds.userId, set: { watching, defaults, updatedAt: new Date() } });
  return myKinds(ctx);
}

/** A subscription's own choice of kinds, or null to follow the person's defaults. Theirs alone. */
export async function setSubscriptionKinds(ctx: Ctx, id: string, kinds: NotifyKinds | null): Promise<NotifyKindsSettings> {
  requireScope(ctx, 'write');
  const [row] = await ctx.db.update(subscriptions).set({ kinds, updatedAt: new Date() }).where(and(eq(subscriptions.id, id), eq(subscriptions.userId, ctx.actor.user.id))).returning();
  if (!row) throw notFound('Subscription', 'It may have ended: reload your subscriptions.').said('notify.subscriptionNotFound');
  return myKinds(ctx);
}
