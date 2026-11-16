/** Push notifications to people's devices (docs/architecture.md, D47). */
import type { OpenAPIHono } from '@hono/zod-openapi';
import { PushDeviceSchema, PushKeySchema, PushSubscriptionBody, PushTestResultSchema } from '@a4a/shared';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import { sha256 } from '../../lib/crypto';
import { listDevices, pushKey, registerDevice, removeDevice, sendTestPush } from '../../push/service';
import { SESSION_COOKIE } from '../../services/auth';
import type { HttpEnv } from '../env';
import { route } from '../route';

const tags = ['Push'];

export function pushRoutes(app: OpenAPIHono<HttpEnv>) {
  route(
    app,
    {
      method: 'get',
      path: '/push/key',
      tags,
      summary: "The server's key for push notifications",
      description: "The VAPID public key a browser subscribes with (pushManager.subscribe's applicationServerKey), and whether this server sends push notifications at all.",
      response: PushKeySchema,
    },
    ({ ctx }) => pushKey(ctx.app),
  );
  route(
    app,
    {
      method: 'get',
      path: '/push/devices',
      tags,
      summary: 'The devices you turned push notifications on for',
      description: 'Give `endpoint` (your browser\'s push subscription\'s) to have that device marked as `current`.',
      query: z.object({ endpoint: z.string().max(2000).optional() }),
      response: z.array(PushDeviceSchema),
    },
    ({ ctx, query }) => listDevices(ctx, query.endpoint),
  );
  route(
    app,
    {
      method: 'post',
      path: '/push/devices',
      tags,
      summary: 'Turn push notifications on for this device',
      description:
        "The browser's PushSubscription, as its toJSON() gives it. It's kept while the sign-in that sends it lasts: signing out there ends it. Only a browser signed in can send it, and only to a push service a4a knows (PUSH_HOSTS).",
      body: PushSubscriptionBody,
      response: PushDeviceSchema,
    },
    ({ c, ctx, body }) => {
      const cookie = getCookie(c, SESSION_COOKIE);
      return registerDevice(ctx, cookie ? sha256(cookie) : null, body, c.req.header('user-agent'));
    },
  );
  route(
    app,
    { method: 'delete', path: '/push/devices/{id}', tags, summary: 'Stop push notifications to one of your devices', params: z.object({ id: z.string() }), status: 204 },
    async ({ ctx, params }) => {
      await removeDevice(ctx, params.id);
      return null;
    },
  );
  route(
    app,
    { method: 'post', path: '/push/test', tags, summary: 'Send a push notification to each of your devices now', bodyOptional: true, response: PushTestResultSchema, status: 200 },
    ({ ctx }) => sendTestPush(ctx),
  );
}
