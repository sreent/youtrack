import { EVENT_TYPES, type TrackerEvent, type Webhook } from '@tracklet/shared';
import { and, desc, eq } from 'drizzle-orm';
import { requireScope, type AppServices, type Ctx } from '../context';
import { webhookDeliveries, webhooks } from '../db/schema';
import { hmacSha256, randomToken } from '../lib/crypto';
import { badRequest, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
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

function validateEvents(events: string[]): string[] {
  const known = new Set<string>(EVENT_TYPES);
  for (const e of events) {
    if (e !== '*' && !known.has(e)) throw badRequest(`Unknown event type "${e}"`, `Use "*" or one of: ${EVENT_TYPES.join(', ')}`);
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
  if (input.project && !project) throw notFound(`Project ${input.project}`);
  if (!/^https?:\/\//i.test(input.url)) throw badRequest('Webhook URLs must be http(s)');
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
    if (!p) throw notFound(`Project ${input.project}`);
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
  if (!row) throw notFound('Webhook');
  return dto(ctx, row);
}

export async function deleteWebhook(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'admin');
  const res = await ctx.db.delete(webhooks).where(eq(webhooks.id, id)).returning({ id: webhooks.id });
  if (!res.length) throw notFound('Webhook');
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
          'user-agent': 'tracklet-webhooks/1',
          'x-tracklet-event': event.type,
          'x-tracklet-event-id': String(event.id),
          'x-tracklet-delivery': deliveryId,
          'x-tracklet-signature': signature,
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
      const hooks = await app.db.select().from(webhooks).where(eq(webhooks.active, true));
      const s = await app.schema.get();
      const matching = hooks.filter((h) => {
        if (!h.events.includes('*') && !h.events.includes(event.type)) return false;
        if (!h.projectId) return true;
        return s.projects.get(h.projectId)?.key === event.project;
      });
      await Promise.all(matching.map((h) => deliver(app, h, event)));
    },
  };
}

export async function testWebhook(ctx: Ctx, id: string): Promise<{ delivered: boolean }> {
  requireScope(ctx, 'admin');
  const [hook] = await ctx.db.select().from(webhooks).where(and(eq(webhooks.id, id)));
  if (!hook) throw notFound('Webhook');
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
    },
    project: null,
    issue: null,
    changes: [],
    data: { test: true, message: 'This is a test delivery from tracklet.' },
  };
  return { delivered: await deliver(ctx.app, hook, event) };
}
