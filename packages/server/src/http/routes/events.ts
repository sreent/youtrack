import type { OpenAPIHono } from '@hono/zod-openapi';
import { EventSchema, WebhookBody, WebhookCreatedSchema, WebhookDeliverySchema, WebhookSchema, type TrackerEvent,
  patchBody,
} from '@a4a/shared';
import { sql } from 'drizzle-orm';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { requireScope, type Ctx } from '../../context';
import { activities } from '../../db/schema';
import type { EventFilter } from '../../events/sse';
import { createWebhook, deleteWebhook, listDeliveries, listWebhooks, testWebhook, updateWebhook } from '../../events/webhooks';
import { AppError, badRequest } from '../../lib/errors';
import { visibleProjectIds } from '../../services/access';
import { eventFeed } from '../../services/activity';
import { projectByKey } from '../../services/schema-cache';
import type { HttpEnv } from '../env';
import { route } from '../route';

const Id = z.object({ id: z.string() });

/** Missed events a reconnecting stream replays; beyond this it gets `resync`. */
const REPLAY_MAX = 1_000;
/** Events waiting for a slow client before its stream is closed (it reconnects and replays). */
const MAX_QUEUE = 5_000;

/** What a stream may see and asked for, as SQL (replay) and as a test (live). */
async function streamFilter(ctx: Ctx, project: string | undefined, types: string | undefined): Promise<EventFilter> {
  const s = await ctx.app.schema.get();
  const typeList = types?.split(',').map((t) => t.trim()).filter(Boolean) ?? [];
  let projectIds: string[] | null = null;
  if (project) {
    const p = projectByKey(s, project);
    if (!p) throw badRequest(`Unknown project ${project}`);
    projectIds = [p.id];
  }
  const visible = await visibleProjectIds(ctx);
  if (visible) projectIds = projectIds ? projectIds.filter((id) => visible.includes(id)) : visible;
  const keys = projectIds ? new Set(projectIds.map((id) => s.projects.get(id)?.key.toUpperCase()).filter((k): k is string => Boolean(k))) : null;
  return {
    projectIds,
    types: typeList.length ? typeList : null,
    matches: (e) => (!keys || (e.project !== null && keys.has(e.project.toUpperCase()))) && (!typeList.length || typeList.includes(e.type)),
  };
}

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
      description:
        'Every event, in order, from whichever instance serves the stream. Each carries its id; on reconnect, send it back as `Last-Event-ID` (browsers do this themselves) or as `after`, and the stream first replays what you missed. ' +
        `If more than ${REPLAY_MAX} events were missed, a \`resync\` event says so instead: re-read what you show, or page through GET /events?after=<id>.`,
      query: z.object({
        project: z.string().optional(),
        types: z.string().optional(),
        after: z.coerce.number().int().min(0).optional().describe('Resume after this event id (the Last-Event-ID header wins when both are sent)'),
      }),
    },
    async ({ c, ctx, query }) => {
      requireScope(ctx, 'read');
      const runtime = c.get('runtime');
      await runtime.live.start();
      if (runtime.live.isStopped) throw new AppError(503, 'unavailable', 'This server is shutting down', 'Reconnect: another instance serves the stream and resumes it.');
      const filter = await streamFilter(ctx, query.project, query.types);
      const header = c.req.header('last-event-id')?.trim();
      const resume = header && /^\d+$/.test(header) ? Number(header) : (query.after ?? null);
      // Proxies such as nginx buffer responses unless told not to; a buffered stream isn't live.
      c.header('x-accel-buffering', 'no');
      return streamSSE(c, async (stream) => {
        const queue: TrackerEvent[] = [];
        let wake: (() => void) | null = null;
        // Read the position and subscribe in one tick: every event after `position` reaches the queue.
        const position = runtime.live.position;
        const unsubscribe = runtime.live.subscribe(
          (event) => {
            if (!filter.matches(event)) return;
            // A client this far behind is better served by reconnecting and replaying from the log.
            if (queue.length >= MAX_QUEUE) stream.abort();
            else queue.push(event);
            wake?.();
          },
          () => {
            stream.abort();
            wake?.();
          },
        );
        stream.onAbort(() => {
          unsubscribe();
          wake?.();
        });
        await stream.writeSSE({ event: 'ready', data: JSON.stringify({ ok: true }) });
        // Live events up to here are already covered: replayed, or seen by the client.
        let sent = position;
        if (resume !== null && resume < position) {
          const missed = await runtime.live.replay(resume, position, filter, REPLAY_MAX + 1);
          if (missed.length > REPLAY_MAX) {
            await stream.writeSSE({
              event: 'resync',
              id: String(position),
              data: JSON.stringify({
                after: resume,
                upTo: position,
                message: `More than ${REPLAY_MAX} events were missed. Re-read what you show, or page through GET /events?after=${resume}.`,
              }),
            });
          } else {
            for (const event of missed) {
              if (stream.aborted) break;
              await stream.writeSSE({ id: String(event.id), event: event.type, data: JSON.stringify(event) });
            }
          }
        } else if (resume !== null && resume > position) {
          // The client saw events this instance hasn't read yet (it was on a faster one): skip
          // those. A resume point past the end of the log is not ours, so it is ignored.
          const [{ max } = { max: 0 }] = await runtime.db.select({ max: sql<number>`coalesce(max(${activities.id}), 0)` }).from(activities);
          if (resume <= Number(max)) sent = resume;
        }
        while (!stream.aborted && !stream.closed) {
          while (queue.length && !stream.aborted) {
            const event = queue.shift()!;
            if (event.id <= sent) continue;
            await stream.writeSSE({ id: String(event.id), event: event.type, data: JSON.stringify(event) });
            sent = event.id;
          }
          if (stream.aborted) break;
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
  route(app, { method: 'patch', path: '/webhooks/{id}', tags: hooks, summary: 'Change a webhook', params: Id, body: patchBody(WebhookBody), response: WebhookSchema }, ({ ctx, params, body }) => updateWebhook(ctx, params.id, body));
  route(app, { method: 'delete', path: '/webhooks/{id}', tags: hooks, summary: 'Delete a webhook', params: Id, status: 204 }, async ({ ctx, params }) => {
    await deleteWebhook(ctx, params.id);
    return null;
  });
  route(app, { method: 'get', path: '/webhooks/{id}/deliveries', tags: hooks, summary: 'Recent delivery attempts', params: Id, response: z.array(WebhookDeliverySchema) }, ({ ctx, params }) => listDeliveries(ctx, params.id));
  route(app, { method: 'post', path: '/webhooks/{id}/test', tags: hooks, summary: 'Send a test delivery', params: Id, response: z.object({ delivered: z.boolean() }), status: 200 }, ({ ctx, params }) => testWebhook(ctx, params.id));
}
