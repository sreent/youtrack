/**
 * CCs on help desk requests (docs/architecture.md, D57): the team copies people on a request and
 * takes them off; the requester copies people on the portal. Taking oneself off is the unsubscribe
 * link in each email (routes/notifications.ts).
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import { PortalRequestDetailSchema, RequestCcBody, RequestCcQuery, RequestCcSchema } from '@a4a/shared';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import { PORTAL_COOKIE, portalCopy, portalRequester } from '../../services/portal';
import { addCc, listCcs, removeCc } from '../../services/request-ccs';
import type { HttpEnv } from '../env';
import { route } from '../route';
import { hit, sameOrigin } from './helpdesk';

export function requestCcRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Help desk'];
  const Id = z.object({ id: z.string().min(1).max(40).describe('The request’s issue, e.g. BACK-12') });

  route(
    app,
    {
      method: 'get',
      path: '/issues/{id}/request/ccs',
      tags,
      summary: 'Who is copied on a help desk request',
      description: 'Everyone who reads the request. They are told of its public replies and changes of state by email, and may answer by email (D57).',
      params: Id,
      response: z.array(RequestCcSchema),
    },
    ({ ctx, params }) => listCcs(ctx, params.id),
  );
  route(
    app,
    {
      method: 'post',
      path: '/issues/{id}/request/ccs',
      tags,
      summary: 'Copy someone on a help desk request',
      description: `Someone who may change the project’s issues, as a public reply takes. From now on they get each public reply and change of state the requester gets, by email, and may answer by email. Copying someone already copied changes nothing; one taken off before is copied again. At most 20 at once. Not a4a’s or a desk’s own addresses, the team’s, or the requester’s.`,
      params: Id,
      body: RequestCcBody,
      response: z.array(RequestCcSchema),
      status: 200,
    },
    ({ ctx, params, body }) => addCc(ctx, params.id, body),
  );
  route(
    app,
    {
      method: 'delete',
      path: '/issues/{id}/request/ccs',
      tags,
      summary: 'Stop copying someone on a help desk request',
      description: 'Someone who may change the project’s issues. They’re told nothing more of it, and their replies by email are refused; an email’s Cc doesn’t copy them again. Taking off someone not copied changes nothing.',
      params: Id,
      query: RequestCcQuery,
      response: z.array(RequestCcSchema),
      status: 200,
    },
    ({ ctx, params, query }) => removeCc(ctx, params.id, query.email),
  );

  route(
    app,
    {
      method: 'post',
      path: '/portal/requests/{id}/ccs',
      tags: ['Help desk portal'],
      summary: 'Copy someone on a request of mine',
      description: 'Its requester alone, signed in to the portal: anyone they choose, except someone who asked to stop emails about it. Limited with replies (30 an hour).',
      auth: 'none',
      params: Id,
      body: RequestCcBody,
      response: PortalRequestDetailSchema,
      status: 200,
    },
    async ({ c, params, body }) => {
      sameOrigin(c);
      const runtime = c.get('runtime');
      const r = await portalRequester(runtime, getCookie(c, PORTAL_COOKIE));
      await hit(c, [['portalAct', r.id]], 'Too many changes just now', 'helpdesk.tooManyChangesNow');
      return portalCopy(runtime, r, params.id, body);
    },
  );
}
