/**
 * CCs on help desk requests (docs/architecture.md, D57, D67): the team copies people on a request and
 * takes them off; the requester copies people on the portal, takes anyone off, and confirms or drops
 * those a new request's Cc named, there or by the link in its acknowledgement. Taking oneself off is
 * the unsubscribe link in each email (routes/notifications.ts).
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import { CcConfirmationBody, CcConfirmationSchema, CcConfirmedSchema, PortalCcQuery, PortalHeldCcBody, PortalRequestDetailSchema, REQUEST_CCS_CEILING, REQUEST_CCS_MAX, RequestCcBody, RequestCcQuery, RequestCcSchema } from '@a4a/shared';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import { PORTAL_COOKIE, portalCopy, portalRequester, portalSettleHeld, portalUncopy } from '../../services/portal';
import { addCc, ccConfirmation, listCcs, removeCc, useCcConfirmation } from '../../services/request-ccs';
import type { HttpEnv } from '../env';
import { route } from '../route';
import { hit, ip, sameOrigin } from './helpdesk';

/** The header the link that confirms a new request's Cc gives the API its token in (D67): in the link it sits in the fragment. */
export const CC_CONFIRM_HEADER = 'x-cc-confirmation';

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
      description: `Someone who may change the project’s issues, as a public reply takes. From now on they get each public reply and change of state the requester gets, by email, and may answer by email. Copying someone already copied changes nothing; one taken off before is copied again; one a new request’s Cc held is copied, and held no longer. At most the desk’s cap at once (its settings’ ccsMax: ${REQUEST_CCS_MAX} unless its managers chose another, up to ${REQUEST_CCS_CEILING}). Not a4a’s or a desk’s own addresses, the team’s, or the requester’s.`,
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
  route(
    app,
    {
      method: 'delete',
      path: '/portal/requests/{id}/ccs',
      tags: ['Help desk portal'],
      summary: 'Stop copying someone on a request of mine',
      description:
        'Its requester alone, signed in to the portal (D67): anyone copied on it, whoever copied them. They’re told nothing more of it, and their replies by email are refused; an email’s Cc doesn’t copy them again, though the team or the requester may. The request’s history names the requester. A colleague or someone copied is refused. Taking off someone not copied changes nothing.',
      auth: 'none',
      params: Id,
      query: PortalCcQuery,
      response: PortalRequestDetailSchema,
      status: 200,
    },
    async ({ c, params, query }) => {
      sameOrigin(c);
      const runtime = c.get('runtime');
      const r = await portalRequester(runtime, getCookie(c, PORTAL_COOKIE));
      await hit(c, [['portalAct', r.id]], 'Too many changes just now', 'helpdesk.tooManyChangesNow');
      return portalUncopy(runtime, r, params.id, query.email);
    },
  );
  route(
    app,
    {
      method: 'post',
      path: '/portal/requests/{id}/held-ccs',
      tags: ['Help desk portal'],
      summary: 'Copy or drop someone the Cc of my new request named',
      description:
        'Its requester alone, signed in to the portal (D67). A new request by email whose sender a4a couldn’t trust has its Cc held: nobody held is told anything until the requester copies them here, or by the link in their acknowledgement. Dropped, they’re told nothing. Limited with replies (30 an hour).',
      auth: 'none',
      params: Id,
      body: PortalHeldCcBody,
      response: PortalRequestDetailSchema,
      status: 200,
    },
    async ({ c, params, body }) => {
      sameOrigin(c);
      const runtime = c.get('runtime');
      const r = await portalRequester(runtime, getCookie(c, PORTAL_COOKIE));
      await hit(c, [['portalAct', r.id]], 'Too many changes just now', 'helpdesk.tooManyChangesNow');
      return portalSettleHeld(runtime, r, params.id, body.email, body.copy);
    },
  );
  route(
    app,
    {
      method: 'get',
      path: '/portal/cc-confirmation',
      tags: ['Help desk portal'],
      summary: 'Whom the link in an acknowledgement confirms',
      description: `The token from the link’s fragment goes in the ${CC_CONFIRM_HEADER} header. Opening it changes nothing; one that has expired, was used or doesn’t exist answers the same 401. Good once for 3 days (D67).`,
      auth: 'none',
      response: CcConfirmationSchema,
    },
    async ({ c }) => {
      await hit(c, [['ccConfirm', ip(c)]], 'Too many tries just now', 'helpdesk.tooManyTriesNow');
      c.header('cache-control', 'no-store');
      return ccConfirmation(c.get('runtime'), c.req.header(CC_CONFIRM_HEADER));
    },
  );
  route(
    app,
    {
      method: 'post',
      path: '/portal/cc-confirmation',
      tags: ['Help desk portal'],
      summary: 'Copy whom my new request’s Cc named, by the link in its acknowledgement',
      description: `Once (D67): those in \`copy\` are copied on the request, the others held are dropped, and the link is used. The token goes in the ${CC_CONFIRM_HEADER} header. No sign-in: the link came to the requester’s address.`,
      auth: 'none',
      body: CcConfirmationBody,
      response: CcConfirmedSchema,
      status: 200,
    },
    async ({ c, body }) => {
      sameOrigin(c);
      await hit(c, [['ccConfirm', ip(c)]], 'Too many tries just now', 'helpdesk.tooManyTriesNow');
      return useCcConfirmation(c.get('runtime'), c.req.header(CC_CONFIRM_HEADER), body.copy);
    },
  );
}
