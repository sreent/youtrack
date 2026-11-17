import { EVENT_TYPES, type TrackerEvent, type Webhook } from '@a4a/shared';
import { and, desc, eq } from 'drizzle-orm';
import { requireScope, type AppServices, type Ctx } from '../context';
import { rules, webhookDeliveries, webhooks } from '../db/schema';
import { hmacSha256, randomToken } from '../lib/crypto';
import { badRequest, conflict, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { eventLimited } from '../services/access';
import { projectByKey } from '../services/schema-cache';
import type { OutboxConsumer } from './worker';

type WebhookRow = typeof webhooks.$inferSelect;

const ATTEMPTS = 3;
const BACKOFF_MS = [0, 1_000, 4_000];
const TIMEOUT_MS = 10_000;

async function dto(ctx: Ctx, row: WebhookRow): Promise<Webhook> {
  const s = await ctx.app.schema.get();
  return {
    id: row.id,
    url: row.url,
    events: row.events,
    project: row.projectId ? (s.projects.get(row.projectId)?.key ?? null) : null,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  };
}

/** What a webhook can listen for: a rule's call goes only to the webhook the rule names. */
const SUBSCRIBABLE = EVENT_TYPES.filter((t) => t !== 'rule.called');

function validateEvents(events: string[]): string[] {
  const known = new Set<string>(SUBSCRIBABLE);
  for (const e of events) {
    if (e === 'rule.called') throw badRequest('A rule calls only the webhook it names, so a webhook can\'t listen for "rule.called"', 'Choose this webhook in the rule instead.').said('webhooks.ruleCalledNotListenable');
    if (e !== '*' && !known.has(e)) throw badRequest(`Unknown event type "${e}"`, `Use "*" or one of: ${SUBSCRIBABLE.join(', ')}`).said('webhooks.unknownEvent', { event: e, events: SUBSCRIBABLE.join(', ') });
  }
  return [...new Set(events)];
}

export async function listWebhooks(ctx: Ctx): Promise<Webhook[]> {
  requireScope(ctx, 'admin');
  const rows = await ctx.db.select().from(webhooks).orderBy(desc(webhooks.createdAt));
  return Promise.all(rows.map((r) => dto(ctx, r)));
}

export async function createWebhook(
  ctx: Ctx,
  input: { url: string; events: string[]; project?: string | null; active?: boolean },
): Promise<Webhook & { secret: string }> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const project = input.project ? projectByKey(s, input.project) : undefined;
  if (input.project && !project) throw notFound(`Project ${input.project}`).said('notFound.project', { id: input.project });
  if (!/^https?:\/\//i.test(input.url)) throw badRequest('Webhook URLs must be http(s)').said('webhooks.urlScheme');
  const secret = randomToken('whsec_', 24);
  const [row] = await ctx.db
    .insert(webhooks)
    .values({
      id: newId(),
      url: input.url,
      secret,
      events: validateEvents(input.events),
      projectId: project?.id ?? null,
      active: input.active ?? true,
      createdById: ctx.actor.user.id,
    })
    .returning();
  return { ...(await dto(ctx, row!)), secret };
}

export async function updateWebhook(
  ctx: Ctx,
  id: string,
  input: { url?: string; events?: string[]; project?: string | null; active?: boolean },
): Promise<Webhook> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  let projectId: string | null | undefined;
  if (input.project === null) projectId = null;
  else if (input.project) {
    const p = projectByKey(s, input.project);
    if (!p) throw notFound(`Project ${input.project}`).said('notFound.project', { id: input.project });
    projectId = p.id;
  }
  const [row] = await ctx.db
    .update(webhooks)
    .set({
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.events !== undefined ? { events: validateEvents(input.events) } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    })
    .where(eq(webhooks.id, id))
    .returning();
  if (!row) throw notFound('Webhook').said('webhooks.notFound');
  return dto(ctx, row);
}

export async function deleteWebhook(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'admin');
  // A rule that calls it would lose its call without a word: it has to let go of the webhook first.
  const callers = await ctx.db.select({ name: rules.name }).from(rules).where(eq(rules.callWebhookId, id)).limit(3);
  if (callers.length) {
    throw conflict(
      `The rule${callers.length > 1 ? 's' : ''} ${callers.map((r) => `"${r.name}"`).join(', ')} call${callers.length > 1 ? '' : 's'} this webhook`,
      'Change the rule so it calls another webhook, or none, then remove this one.',
    ).said('webhooks.calledByRules', { count: callers.length, rules: callers.map((r) => `"${r.name}"`).join(', ') });
  }
  const res = await ctx.db.delete(webhooks).where(eq(webhooks.id, id)).returning({ id: webhooks.id });
  if (!res.length) throw notFound('Webhook').said('webhooks.notFound');
}

/** Where a webhook is, without its path or anything secret in it: "https://ops.example.com". */
export function webhookOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Whether a rule may call this address: https, or plain http to this machine itself. A rule calls on
 * its own, every time it acts, with what it knows of an issue, so it never sends that in the clear
 * over a network.
 */
export function callableUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && LOOPBACK.has(u.hostname);
  } catch {
    return false;
  }
}

export async function listDeliveries(ctx: Ctx, id: string) {
  requireScope(ctx, 'admin');
  const rows = await ctx.db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.webhookId, id))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(100);
  return rows.map((r) => ({
    id: r.id,
    eventId: r.eventId,
    eventType: r.eventType,
    statusCode: r.statusCode,
    success: r.success,
    attempt: r.attempt,
    durationMs: r.durationMs,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Send one event to one webhook, with retries; every attempt is logged. */
export async function deliver(app: AppServices, hook: WebhookRow, event: TrackerEvent): Promise<boolean> {
  const body = JSON.stringify(event);
  const signature = `sha256=${hmacSha256(hook.secret, body)}`;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const wait = BACKOFF_MS[attempt - 1] ?? 0;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const deliveryId = newId();
    const started = Date.now();
    let statusCode: number | null = null;
    let error: string | null = null;
    try {
      const res = await fetch(hook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'a4a-webhooks/1',
          'x-a4a-event': event.type,
          'x-a4a-event-id': String(event.id),
          'x-a4a-delivery': deliveryId,
          'x-a4a-signature': signature,
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'manual',
      });
      statusCode = res.status;
      await res.body?.cancel().catch(() => {});
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const success = error === null;
    await app.db.insert(webhookDeliveries).values({
      id: deliveryId,
      webhookId: hook.id,
      eventId: event.id > 0 ? event.id : null,
      eventType: event.type,
      statusCode,
      success,
      attempt,
      durationMs: Date.now() - started,
      error,
    });
    if (success) return true;
    // 4xx other than timeouts/rate limits won't get better by retrying.
    if (statusCode !== null && statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429) return false;
  }
  return false;
}

export function webhookConsumer(app: AppServices): OutboxConsumer {
  return {
    name: 'webhooks',
    async handle(event) {
      // A rule's call is for the one webhook it names, whatever that webhook listens for.
      const s = await app.schema.get();
      // A webhook's address is outside a4a, where nobody's access is known: what's limited to some
      // people (D37) isn't sent there, a rule's call included.
      if (await eventLimited(app.db, s, event)) return;
      if (event.type === 'rule.called') return callFromRule(app, event);
      const hooks = await app.db.select().from(webhooks).where(eq(webhooks.active, true));
      const matching = hooks.filter((h) => {
        if (!h.events.includes('*') && !h.events.includes(event.type)) return false;
        if (!h.projectId) return true;
        // By the project, not its key: an event worded before a rename names a key it had (D52).
        return event.project !== null && projectByKey(s, event.project)?.id === h.projectId;
      });
      await Promise.all(matching.map((h) => deliver(app, h, event)));
    },
  };
}

/**
 * A workflow rule's call (workflow/engine.ts writes it with the change it goes with): sent to the
 * webhook it names, signed with that webhook's secret, and logged with its deliveries. A paused
 * webhook sends nothing, as for any other event; an address that stopped being https isn't called.
 */
async function callFromRule(app: AppServices, event: TrackerEvent): Promise<void> {
  const id = (event.data as { webhook?: unknown }).webhook;
  if (typeof id !== 'string') return;
  const [hook] = await app.db.select().from(webhooks).where(eq(webhooks.id, id));
  if (!hook || !hook.active) return;
  if (!callableUrl(hook.url)) {
    console.warn(`webhooks: a rule's call to webhook ${hook.id} was not sent: its address is not https`);
    return;
  }
  await deliver(app, hook, event);
}

export async function testWebhook(ctx: Ctx, id: string): Promise<{ delivered: boolean }> {
  requireScope(ctx, 'admin');
  const [hook] = await ctx.db.select().from(webhooks).where(and(eq(webhooks.id, id)));
  if (!hook) throw notFound('Webhook').said('webhooks.notFound');
  const event: TrackerEvent = {
    id: 0,
    type: 'issue.updated',
    occurredAt: new Date().toISOString(),
    actor: {
      id: ctx.actor.user.id,
      login: ctx.actor.user.login,
      name: ctx.actor.user.name,
      channel: ctx.actor.channel,
      token: ctx.actor.tokenName,
      isBot: ctx.actor.user.isBot,
    },
    project: null,
    issue: null,
    changes: [],
    data: { test: true, message: 'This is a test delivery from a4a.' },
  };
  return { delivered: await deliver(ctx.app, hook, event) };
}
