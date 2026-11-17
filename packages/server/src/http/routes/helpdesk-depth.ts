/**
 * The help desk in depth (docs/architecture.md, D45): SLA policies and their report, a desk's own
 * mailbox, the requesters' portal, and the kinds of change a person is told of.
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  PortalDeskSchema,
  PortalMeSchema,
  PortalNameBody,
  PortalNewRequestBody,
  PortalRedeemBody,
  PortalReplyBody,
  PortalRequestDetailSchema,
  PortalRequestSchema,
  PortalRequestUpdateBody,
  PortalSignInBody,
  DeskMailboxBody,
  DeskMailboxSchema,
  NotifyKindsBody,
  NotifyKindsSettingsSchema,
  SlaPolicyBody,
  SlaPolicyOrderBody,
  SubscriptionKindsBody,
  SlaPolicySchema,
  SlaReportSchema,
} from '@a4a/shared';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { requireScope } from '../../context';
import { assertCanWriteProject } from '../../services/access';
import { resolveIssue } from '../../services/issues';
import {
  inviteRequester,
  PORTAL_COOKIE,
  PORTAL_SESSION_MS,
  portalDesks,
  portalMe,
  portalNewRequest,
  portalReply,
  portalRequest,
  portalRequester,
  portalRequests,
  portalSetPrivate,
  redeemSignIn,
  renameRequester,
  requestSignIn,
  signOut,
} from '../../services/portal';
import { myKinds, setMyKinds, setSubscriptionKinds } from '../../notify/kinds';
import { deskMailbox, setDeskMailbox } from '../../services/desk-mailbox';
import { createPolicy, deletePolicy, listPolicies, reorderPolicies, slaReport, updatePolicy } from '../../services/sla';
import type { HttpEnv } from '../env';
import { route } from '../route';
import { hit, ip, sameOrigin } from './helpdesk';

const Key = z.object({ key: z.string().min(1).max(10) });
const KeyId = Key.extend({ id: z.string().min(1) });

export function helpdeskDepthRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Help desk'];

  route(
    app,
    { method: 'get', path: '/projects/{key}/sla-policies', tags, summary: "A desk's SLA policies, in the order they're tried", params: Key, response: z.array(SlaPolicySchema) },
    ({ ctx, params }) => listPolicies(ctx, params.key),
  );
  route(
    app,
    {
      method: 'post',
      path: '/projects/{key}/sla-policies',
      tags,
      summary: 'Add an SLA policy',
      description:
        "The project's managers. Targets are business minutes, in the desk's working hours (`settings.helpdesk.businessHours`). The first policy also puts the \"SLA status\" field on the project, which the help desk's agent keeps.",
      params: Key,
      body: SlaPolicyBody,
      response: SlaPolicySchema,
      status: 201,
    },
    ({ ctx, params, body }) => createPolicy(ctx, params.key, body),
  );
  route(
    app,
    { method: 'put', path: '/projects/{key}/sla-policies/{id}', tags, summary: 'Change an SLA policy', description: 'Its open requests follow it now.', params: KeyId, body: SlaPolicyBody, response: SlaPolicySchema },
    ({ ctx, params, body }) => updatePolicy(ctx, params.key, params.id, body),
  );
  route(
    app,
    { method: 'delete', path: '/projects/{key}/sla-policies/{id}', tags, summary: 'Delete an SLA policy', description: "Targets it stopped stay as they were; ones still counting follow the desk's other policies.", params: KeyId, status: 204 },
    async ({ ctx, params }) => {
      await deletePolicy(ctx, params.key, params.id);
      return null;
    },
  );
  route(
    app,
    { method: 'put', path: '/projects/{key}/sla-policies-order', tags, summary: 'Order the SLA policies', params: Key, body: SlaPolicyOrderBody, response: z.array(SlaPolicySchema) },
    ({ ctx, params, body }) => reorderPolicies(ctx, params.key, body.ids),
  );
  route(
    app,
    {
      method: 'get',
      path: '/projects/{key}/sla-report',
      tags,
      summary: 'Met and breached, by policy, per week',
      description: "Each target counts in the week it was met or went past. Weeks start on Monday, in `tz` (the desk's working hours' zone by default). Twelve weeks to `to` (today) unless `from` says.",
      params: Key,
      query: z.object({ from: z.string().optional(), to: z.string().optional(), tz: z.string().optional() }),
      response: SlaReportSchema,
    },
    ({ ctx, params, query }) => slaReport(ctx, params.key, { from: query.from, to: query.to, timeZone: query.tz }),
  );

  route(
    app,
    { method: 'get', path: '/projects/{key}/helpdesk/mailbox', tags, summary: "A desk's own mailbox, and the name its mail comes from", params: Key, response: DeskMailboxSchema },
    ({ ctx, params }) => deskMailbox(ctx, params.key),
  );
  route(
    app,
    {
      method: 'put',
      path: '/projects/{key}/helpdesk/mailbox',
      tags,
      summary: "Set a desk's own mailbox, or its name",
      description: 'The IMAP address is an administrator\'s to set, and is kept sealed; the name, the desk\'s managers\'. Left out keeps it; null removes it.',
      params: Key,
      body: DeskMailboxBody,
      response: DeskMailboxSchema,
    },
    ({ ctx, params, body }) => setDeskMailbox(ctx, params.key, body),
  );

  // Subscriptions by kind (D45)
  const me = ['Notifications'];
  route(app, { method: 'get', path: '/me/notification-kinds', tags: me, summary: 'The kinds of change that tell me, and how', response: NotifyKindsSettingsSchema }, ({ ctx }) => myKinds(ctx));
  route(
    app,
    { method: 'put', path: '/me/notification-kinds', tags: me, summary: 'Choose the kinds of change that tell me', description: 'Kinds left out keep their choice. Being mentioned or assigned always tells you.', body: NotifyKindsBody, response: NotifyKindsSettingsSchema },
    ({ ctx, body }) => setMyKinds(ctx, body),
  );
  route(
    app,
    { method: 'put', path: '/subscriptions/{id}/kinds', tags: me, summary: "A subscription's own choice of kinds", description: 'null follows your defaults.', params: z.object({ id: z.string() }), body: SubscriptionKindsBody, response: NotifyKindsSettingsSchema },
    ({ ctx, params, body }) => setSubscriptionKinds(ctx, params.id, body.kinds),
  );
}

/** The requesters' portal (D45): signed in by a link sent to their email, with a cookie of its own. */
export function portalRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Help desk portal'];
  const session = (c: Context<HttpEnv>) => getCookie(c, PORTAL_COOKIE);
  const who = (c: Context<HttpEnv>) => portalRequester(c.get('runtime'), session(c));
  const Id = z.object({ id: z.string().min(1).max(40) });

  route(
    app,
    {
      method: 'post',
      path: '/portal/sign-in',
      tags,
      summary: 'Email me a link to sign in',
      description: 'Public. Answers alike whether or not the address has asked for help before. Limited per address (10 in 15 minutes) and per email (3 an hour). The link works once, for 20 minutes.',
      auth: 'none',
      body: PortalSignInBody,
      response: z.object({ sent: z.literal(true) }),
      status: 202,
    },
    async ({ c, body }) => {
      sameOrigin(c);
      await hit(c, [['portalIp', ip(c)]], 'Too many sign-in links from your address', 'helpdesk.tooManyLinksFromAddress');
      await hit(c, [['portalEmail', body.email]], 'Too many sign-in links for this email address', 'helpdesk.tooManyLinksForEmail');
      await requestSignIn(c.get('runtime'), body.email, body.desk);
      return { sent: true as const };
    },
  );
  route(
    app,
    {
      method: 'post',
      path: '/portal/sign-in/redeem',
      tags,
      summary: "Sign in with a link's token",
      description: `Public. Sets the \`${PORTAL_COOKIE}\` cookie (HttpOnly, SameSite=Strict, 30 days).`,
      auth: 'none',
      body: PortalRedeemBody,
      response: PortalMeSchema,
      status: 200,
    },
    async ({ c, body }) => {
      const runtime = c.get('runtime');
      sameOrigin(c);
      await hit(c, [['portalIp', ip(c)]], 'Too many sign-ins from your address', 'helpdesk.tooManySignIns');
      const { session: token, me } = await redeemSignIn(runtime, body.token);
      setCookie(c, PORTAL_COOKIE, token, {
        httpOnly: true,
        sameSite: 'Strict',
        path: '/api/v1/portal',
        secure: runtime.config.publicUrl.startsWith('https://'),
        maxAge: Math.floor(PORTAL_SESSION_MS / 1000),
      });
      return me;
    },
  );
  route(app, { method: 'post', path: '/portal/sign-out', tags, summary: 'Sign out of the portal', auth: 'none', status: 204 }, async ({ c }) => {
    sameOrigin(c);
    await signOut(c.get('runtime'), session(c));
    deleteCookie(c, PORTAL_COOKIE, { path: '/api/v1/portal' });
    return null;
  });
  route(
    app,
    { method: 'get', path: '/portal/me', tags, summary: 'Who is signed in to the portal', description: 'null when nobody is: the page then asks for an email.', auth: 'none', response: PortalMeSchema.nullable() },
    async ({ c }) => {
      c.header('cache-control', 'no-store');
      const r = await who(c).catch(() => null);
      return r ? portalMe(c.get('runtime'), r) : null;
    },
  );
  route(app, { method: 'patch', path: '/portal/me', tags, summary: 'Change the name the team sees', auth: 'none', body: PortalNameBody, response: PortalMeSchema }, async ({ c, body }) => {
    sameOrigin(c);
    return renameRequester(c.get('runtime'), await who(c), body.name);
  });
  route(app, { method: 'get', path: '/portal/desks', tags, summary: 'The desks a requester can ask from the portal', auth: 'none', response: z.array(PortalDeskSchema) }, async ({ c }) =>
    portalDesks(c.get('runtime'), await who(c)),
  );
  route(
    app,
    { method: 'get', path: '/portal/requests', tags, summary: 'My requests, and my customer group’s where it shares them', auth: 'none', response: z.array(PortalRequestSchema) },
    async ({ c }) => {
      c.header('cache-control', 'no-store');
      return portalRequests(c.get('runtime'), await who(c));
    },
  );
  route(
    app,
    { method: 'get', path: '/portal/requests/{id}', tags, summary: 'A request and its public conversation', auth: 'none', params: Id, response: PortalRequestDetailSchema },
    async ({ c, params }) => {
      c.header('cache-control', 'no-store');
      return portalRequest(c.get('runtime'), await who(c), params.id);
    },
  );
  route(
    app,
    { method: 'post', path: '/portal/requests/{id}/replies', tags, summary: 'Reply to a request of mine, or of my customer group where it lets its members answer', description: 'A public comment in their name; the team is told, and a colleague’s reply reaches the request’s requester by email.', auth: 'none', params: Id, body: PortalReplyBody, response: PortalRequestDetailSchema, status: 200 },
    async ({ c, params, body }) => {
      sameOrigin(c);
      const r = await who(c);
      await hit(c, [['portalAct', r.id]], 'Too many replies just now', 'helpdesk.tooManyRepliesNow');
      return portalReply(c.get('runtime'), r, params.id, body.text);
    },
  );
  route(
    app,
    { method: 'post', path: '/portal/requests', tags, summary: 'Ask a desk for help', description: 'As the form does, without its proof of work: they are signed in.', auth: 'none', body: PortalNewRequestBody, response: PortalRequestDetailSchema, status: 201 },
    async ({ c, body }) => {
      sameOrigin(c);
      const r = await who(c);
      await hit(c, [['portalAct', r.id]], 'Too many requests just now', 'helpdesk.tooManyRequestsNow');
      return portalNewRequest(c.get('runtime'), r, { desk: body.desk, summary: body.summary, description: body.description ?? '', private: body.private ?? false });
    },
  );
  route(
    app,
    {
      method: 'patch',
      path: '/portal/requests/{id}',
      tags,
      summary: 'Keep a request of mine from my customer group, or share it again',
      description: "Its requester's alone (D56); the team keeps one private on its page. In the request's history.",
      auth: 'none',
      params: Id,
      body: PortalRequestUpdateBody,
      response: PortalRequestDetailSchema,
    },
    async ({ c, params, body }) => {
      sameOrigin(c);
      const r = await who(c);
      await hit(c, [['portalAct', r.id]], 'Too many replies just now', 'helpdesk.tooManyRepliesNow');
      return portalSetPrivate(c.get('runtime'), r, params.id, body.private);
    },
  );
  route(
    app,
    {
      method: 'post',
      path: '/issues/{id}/request/invite',
      tags: ['Help desk'],
      summary: "Email a request's requester a link to the portal",
      description: 'Someone who may change the project’s issues.',
      params: Id,
      status: 204,
    },
    async ({ ctx, params }) => {
      requireScope(ctx, 'write');
      const issue = await resolveIssue(ctx, params.id);
      await assertCanWriteProject(ctx, issue.projectId);
      const s = await ctx.app.schema.get();
      await inviteRequester(ctx.app, issue.id, s.projects.get(issue.projectId)?.key ?? '');
      return null;
    },
  );
}
