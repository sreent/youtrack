import type { OpenAPIHono } from '@hono/zod-openapi';
import { EventSchema, WebhookBody, WebhookCreatedSchema, WebhookDeliverySchema, WebhookSchema, type TrackerEvent } from '@a4a/shared';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { requireScope } from '../../context';
import { createWebhook, deleteWebhook, listDeliveries, listWebhooks, testWebhook, updateWebhook } from '../../events/webhooks';
import { eventFeed } from '../../services/activity';
import type { HttpEnv } from '../env';
import { route } from '../route';

const Id = z.object({ id: z.string() });

export function eventRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Events'];
  route(
    app,
    {
      method: 'get',
      path: '/events',
      tags,
      summary: 'The change feed',
      description:
        'Poll with `after=<last id you saw>` to receive every change in order, at least once, including after downtime. Without `after`, the newest events come first.',
      query: z.object({
        after: z.coerce.number().int().optional(),
        since: z.string().optional().describe('A date, a timestamp, or e.g. -7d'),
        project: z.string().optional(),
        issue: z.string().optional(),
        types: z.string().optional().describe('Comma-separated event types'),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      response: z.array(EventSchema),
    },
    ({ ctx, query }) =>
      eventFeed(ctx, {
        after: query.after,
        since: query.since,
        project: query.project,
        issue: query.issue,
        types: query.types?.split(',').map((t) => t.trim()).filter(Boolean),
        limit: query.limit,
        order: query.after !== undefined ? 'asc' : 'desc',
      }),
  );

  route(
    app,
    {
      method: 'get',
      path: '/events/stream',
      tags,
      summary: 'Live events over Server-Sent Events',
      description: 'Best effort and live only: after reconnecting, catch up with GET /events?after=<last id>.',
      query: z.object({ project: z.string().optional(), types: z.string().optional() }),
    },
    async ({ c, ctx, query }) => {
      requireScope(ctx, 'read');
      const runtime = c.get('runtime');
      const types = query.types?.split(',').map((t) => t.trim()).filter(Boolean);
      return streamSSE(c, async (stream) => {
        const queue: TrackerEvent[] = [];
        let wake: (() => void) | null = null;
        const unsubscribe = runtime.live.subscribe((event) => {
          if (query.project && event.project?.toUpperCase() !== query.project.toUpperCase()) return;
          if (types?.length && !types.includes(event.type)) return;
          queue.push(event);
          wake?.();
        });
        stream.onAbort(() => {
          unsubscribe();
          wake?.();
        });
        await stream.writeSSE({ event: 'ready', data: JSON.stringify({ ok: true }) });
        while (!stream.aborted && !stream.closed) {
          while (queue.length) {
            const event = queue.shift()!;
            await stream.writeSSE({ id: String(event.id), event: event.type, data: JSON.stringify(event) });
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 25_000).unref?.();
          });
          wake = null;
          if (!queue.length && !stream.aborted) await stream.write(': keep-alive\n\n');
        }
        unsubscribe();
      });
    },
  );

  const hooks = ['Webhooks'];
  route(app, { method: 'get', path: '/webhooks', tags: hooks, summary: 'List webhooks (admin)', response: z.array(WebhookSchema) }, ({ ctx }) => listWebhooks(ctx));
  route(
    app,
    {
      method: 'post',
      path: '/webhooks',
      tags: hooks,
      summary: 'Create a webhook (admin)',
      description:
        'Deliveries are POSTs of an Event, signed with `X-A4A-Signature: sha256=<HMAC-SHA256 of the body with the secret>`, retried up to 3 times, at least once: dedupe on `X-A4A-Event-Id`.',
      body: WebhookBody,
      response: WebhookCreatedSchema,
    },
    ({ ctx, body }) => createWebhook(ctx, body),
  );
  route(app, { method: 'patch', path: '/webhooks/{id}', tags: hooks, summary: 'Change a webhook', params: Id, body: WebhookBody.partial(), response: WebhookSchema }, ({ ctx, params, body }) => updateWebhook(ctx, params.id, body));
  route(app, { method: 'delete', path: '/webhooks/{id}', tags: hooks, summary: 'Delete a webhook', params: Id, status: 204 }, async ({ ctx, params }) => {
    await deleteWebhook(ctx, params.id);
    return null;
  });
  route(app, { method: 'get', path: '/webhooks/{id}/deliveries', tags: hooks, summary: 'Recent delivery attempts', params: Id, response: z.array(WebhookDeliverySchema) }, ({ ctx, params }) => listDeliveries(ctx, params.id));
  route(app, { method: 'post', path: '/webhooks/{id}/test', tags: hooks, summary: 'Send a test delivery', params: Id, response: z.object({ delivered: z.boolean() }), status: 200 }, ({ ctx, params }) => testWebhook(ctx, params.id));
}
