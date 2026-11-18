/**
 * The portal's own sign-in over HTTP (docs/architecture.md, D63): the ways a desk's sign-in page
 * offers, a password, single sign-on through a requesters' identity provider, and the providers an
 * administrator keeps. Public routes answer alike for any address, and are limited as the portal's
 * links are (services/help-throttle.ts) and as members' sign-ins are (services/login-throttle.ts).
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  PortalMeSchema,
  PortalPasswordChangeBody,
  PortalPasswordLinkBody,
  PortalPasswordSetBody,
  PortalPasswordSignInBody,
  PortalProviderBody,
  PortalProviderSchema,
  PortalProviderUpdateBody,
  PortalSignInMethodsSchema,
} from '@a4a/shared';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Runtime } from '../../app-services';
import { AppError } from '../../lib/errors';
import { beginLoginAttempt, waitInWords } from '../../services/login-throttle';
import { PORTAL_COOKIE, PORTAL_SESSION_MS, portalMe, portalRequester } from '../../services/portal';
import {
  changePassword,
  checkPortalCaptcha,
  createPortalProvider,
  deletePortalProvider,
  finishPortalSso,
  listPortalProviders,
  PORTAL_SSO_COOKIE,
  PORTAL_SSO_PATH,
  PORTAL_SSO_TTL_MS,
  PortalSsoError,
  assertWayTaken,
  requestPasswordLink,
  requesterByPassword,
  setPasswordWithLink,
  signInMethods,
  startPortalSession,
  startPortalSso,
  updatePortalProvider,
  wrongPassword,
} from '../../services/portal-sign-in';
import type { HttpEnv } from '../env';
import { route } from '../route';
import { hit, ip, sameOrigin } from './helpdesk';

/** The portal's session cookie, as signing in by a link sets it (D45): HttpOnly, SameSite=Strict, the portal's API alone. */
export function setPortalSession(c: Context<HttpEnv>, runtime: Runtime, token: string): void {
  setCookie(c, PORTAL_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/api/v1/portal',
    secure: runtime.config.publicUrl.startsWith('https://'),
    maxAge: Math.floor(PORTAL_SESSION_MS / 1000),
  });
}

/**
 * Counted as members' sign-ins are, in Postgres, before the password is checked: per address, and
 * per email under a key no member's login can have, so neither side locks the other out.
 */
async function passwordAttempt(c: Context<HttpEnv>, email: string) {
  const attempt = await beginLoginAttempt(c.get('runtime').db, ip(c), `portal:${email.trim().toLowerCase()}`);
  if (attempt.wait) {
    c.header('retry-after', String(attempt.wait));
    const unit = attempt.wait < 60 ? 'second' : 'minute';
    throw new AppError(429, 'rate_limited', 'Too many sign-in attempts for this email address', `Try again in ${waitInWords(attempt.wait)}.`).said('portal.tooManyTries', {
      unit,
      n: attempt.wait < 60 ? attempt.wait : Math.ceil(attempt.wait / 60),
    });
  }
  return attempt;
}

const Id = z.object({ id: z.string().min(1).max(40) });

export function portalSignInRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Help desk portal'];
  const session = (c: Context<HttpEnv>) => getCookie(c, PORTAL_COOKIE);

  route(
    app,
    {
      method: 'get',
      path: '/portal/sign-in-methods',
      tags,
      summary: 'The ways the portal signs someone in, for a desk or for the portal as a whole',
      description:
        "Public. With `desk`, that desk's choice and its identity providers; without one, or for one that takes no requests, the ways some desk takes, and no providers. A `captcha` comes when a desk that takes passwords asks for a proof of work: solve it, and send it with the password.",
      auth: 'none',
      query: z.object({ desk: z.string().trim().max(20).optional() }),
      response: PortalSignInMethodsSchema,
    },
    async ({ c, query }) => {
      await hit(c, [['form', ip(c)]], 'Too many requests for this form', 'helpdesk.tooManyForForm');
      c.header('cache-control', 'no-store');
      return signInMethods(c.get('runtime'), query.desk);
    },
  );

  route(
    app,
    {
      method: 'post',
      path: '/portal/password/sign-in',
      tags,
      summary: 'Sign in to the portal with a password',
      description: `Public. A requester's password, never a member's: it opens the portal alone. Limited as members' sign-ins are (10 wrong a quarter of an hour per email, 50 per address), and refused where the desk named takes no passwords. Sets the \`${PORTAL_COOKIE}\` cookie.`,
      auth: 'none',
      body: PortalPasswordSignInBody,
      response: PortalMeSchema,
      status: 200,
    },
    async ({ c, body }) => {
      const runtime = c.get('runtime');
      sameOrigin(c);
      if (body.desk) await assertWayTaken(runtime, body.desk, 'password');
      const attempt = await passwordAttempt(c, body.email);
      await checkPortalCaptcha(runtime, body.captcha);
      const requester = await requesterByPassword(runtime.db, body.email, body.password);
      if (!requester) throw wrongPassword();
      await attempt.succeeded();
      const token = await startPortalSession(runtime.db, requester.id, { method: 'password', providerId: null }, PORTAL_SESSION_MS);
      setPortalSession(c, runtime, token);
      return portalMe(runtime, { ...requester, signedIn: { method: 'password', providerId: null } });
    },
  );

  route(
    app,
    {
      method: 'post',
      path: '/portal/password/link',
      tags,
      summary: 'Email me a link to set my password',
      description: 'Public. A first password, or a new one for one forgotten. Answers alike whether or not the address is known; limited with sign-in links (10 in 15 minutes per address, 3 an hour per email). The link works once, for 20 minutes.',
      auth: 'none',
      body: PortalPasswordLinkBody,
      response: z.object({ sent: z.literal(true) }),
      status: 202,
    },
    async ({ c, body }) => {
      sameOrigin(c);
      await hit(c, [['portalIp', ip(c)]], 'Too many sign-in links from your address', 'helpdesk.tooManyLinksFromAddress');
      await hit(c, [['portalEmail', body.email]], 'Too many sign-in links for this email address', 'helpdesk.tooManyLinksForEmail');
      await requestPasswordLink(c.get('runtime'), body.email, body.desk);
      return { sent: true as const };
    },
  );

  route(
    app,
    {
      method: 'post',
      path: '/portal/password/set',
      tags,
      summary: "Set my password with a link's token",
      description: `Public. The link works once; every session the requester had ends, and so do the other links to set one. Starts a session (the \`${PORTAL_COOKIE}\` cookie), and emails them that a password now signs them in.`,
      auth: 'none',
      body: PortalPasswordSetBody,
      response: PortalMeSchema,
      status: 200,
    },
    async ({ c, body }) => {
      const runtime = c.get('runtime');
      sameOrigin(c);
      await hit(c, [['portalIp', ip(c)]], 'Too many sign-ins from your address', 'helpdesk.tooManySignIns');
      const { session: token } = await setPasswordWithLink(runtime, body.token, body.password, PORTAL_SESSION_MS);
      setPortalSession(c, runtime, token);
      return portalMe(runtime, await portalRequester(runtime, token));
    },
  );

  route(
    app,
    {
      method: 'put',
      path: '/portal/me/password',
      tags,
      summary: 'Change my password',
      description: 'Signed in to the portal. The current password first, counted as sign-ins are. Their other sessions end; this one stays.',
      auth: 'none',
      body: PortalPasswordChangeBody,
      response: PortalMeSchema,
    },
    async ({ c, body }) => {
      const runtime = c.get('runtime');
      sameOrigin(c);
      const r = await portalRequester(runtime, session(c));
      const attempt = await passwordAttempt(c, r.email);
      await changePassword(runtime, r.id, session(c)!, body.current, body.password);
      await attempt.succeeded();
      return portalMe(runtime, await portalRequester(runtime, session(c)));
    },
  );

  // Single sign-on through a requesters' identity provider: two browser redirects, there and back.
  const back = (failure: string, desk: string | null | undefined) => `/portal?sso=${failure}${desk ? `&desk=${encodeURIComponent(desk)}` : ''}`;
  route(
    app,
    {
      method: 'get',
      path: '/portal/sso/{id}/start',
      tags,
      summary: 'Sign in through an identity provider: sends the browser there',
      description:
        'For browsers. Only a provider the desk named (or some desk) offers. Redirects with PKCE, a state and a nonce, and sets a short-lived cookie binding the state to this browser; on a problem, back to the portal with `?sso=` saying why.',
      auth: 'none',
      params: Id,
      query: z.object({ desk: z.string().trim().max(20).optional() }),
      status: 302,
    },
    async ({ c, params, query }) => {
      const runtime = c.get('runtime');
      await hit(c, [['portalSso', ip(c)]], 'Too many sign-ins from your address', 'helpdesk.tooManySignIns');
      try {
        const { url, state } = await startPortalSso(runtime, params.id, query.desk);
        setCookie(c, PORTAL_SSO_COOKIE, state, {
          httpOnly: true,
          // The provider sends the browser back from its own site: Lax lets this top-level GET carry it.
          sameSite: 'Lax',
          path: PORTAL_SSO_PATH,
          secure: runtime.config.publicUrl.startsWith('https://'),
          maxAge: Math.floor(PORTAL_SSO_TTL_MS / 1000),
        });
        return c.redirect(url, 302);
      } catch (e) {
        if (e instanceof PortalSsoError) return c.redirect(back(e.failure, query.desk), 302);
        throw e;
      }
    },
  );
  route(
    app,
    {
      method: 'get',
      path: '/portal/sso/callback',
      tags,
      summary: 'Where a requesters’ identity provider sends the browser back (the redirect URI)',
      description:
        'Register exactly `PUBLIC_URL/api/v1/portal/sso/callback` with each provider. On success a portal session starts, opened through that provider, and the browser goes back to the portal; otherwise to it with `?sso=` saying why.',
      auth: 'none',
      status: 302,
    },
    async ({ c }) => {
      const runtime = c.get('runtime');
      const browserState = getCookie(c, PORTAL_SSO_COOKIE);
      deleteCookie(c, PORTAL_SSO_COOKIE, { path: PORTAL_SSO_PATH });
      try {
        const done = await finishPortalSso(runtime, new URL(c.req.url).searchParams, browserState, PORTAL_SESSION_MS);
        setPortalSession(c, runtime, done.session);
        return c.redirect(`/portal${done.desk ? `?desk=${encodeURIComponent(done.desk)}` : ''}`, 302);
      } catch (e) {
        if (e instanceof PortalSsoError) return c.redirect(back(e.failure, e.desk), 302);
        console.error('portal sso: the callback failed', e);
        return c.redirect(back('failed', null), 302);
      }
    },
  );

  // The providers: the server's, kept by administrators, read by desks' managers to choose their own.
  const admin = ['Help desk'];
  route(
    app,
    { method: 'get', path: '/portal-providers', tags: admin, summary: 'Identity providers for requesters', description: "Administrators and desks' managers. Never a client secret.", response: z.array(PortalProviderSchema) },
    ({ ctx }) => listPortalProviders(ctx),
  );
  route(
    app,
    {
      method: 'post',
      path: '/portal-providers',
      tags: admin,
      summary: 'Add an identity provider for requesters',
      description:
        "Administrators. OpenID Connect: the issuer is found by discovery before it's kept. `domains` limits the addresses it may vouch for. Register `redirectUri` with the provider; a desk then offers it in `settings.helpdesk.signIn.providers`.",
      body: PortalProviderBody,
      response: PortalProviderSchema,
      status: 201,
    },
    ({ ctx, body }) => createPortalProvider(ctx, body),
  );
  route(
    app,
    { method: 'patch', path: '/portal-providers/{id}', tags: admin, summary: 'Change an identity provider for requesters', description: 'Administrators. Left out keeps it; a null `clientSecret` removes it.', params: Id, body: PortalProviderUpdateBody, response: PortalProviderSchema },
    ({ ctx, params, body }) => updatePortalProvider(ctx, params.id, body),
  );
  route(
    app,
    { method: 'delete', path: '/portal-providers/{id}', tags: admin, summary: 'Remove an identity provider for requesters', description: 'Administrators, once no desk offers it. Its sessions end.', params: Id, status: 204 },
    async ({ ctx, params }) => {
      await deletePortalProvider(ctx, params.id);
      return null;
    },
  );
}
