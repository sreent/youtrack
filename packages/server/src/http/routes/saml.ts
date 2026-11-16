import type { OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { logout, SESSION_COOKIE } from '../../services/auth';
import { finishSamlSignIn, SAML_COOKIE, SAML_REQUEST_TTL_MS, spMetadata, startSamlSignIn } from '../../services/saml';
import { SsoError } from '../../services/sso';
import type { HttpEnv } from '../env';
import { clientIp, errorBody, RateLimiter } from '../middleware';
import { route } from '../route';
import { setSessionCookie } from './auth';

const COOKIE_PATH = '/api/v1/auth/saml';
/** A response with a signed assertion and the person's groups fits easily; anything larger isn't one. */
const MAX_RESPONSE = 256 * 1024;
// Starting a sign-in stores a row, so it is limited per address like signing in with a password.
const startLimiter = new RateLimiter(30, 15 * 60_000);

/** Single sign-on with SAML 2.0 (docs/architecture.md, D27): there by redirect, back by a posted form. */
export function samlRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Auth'];
  route(
    app,
    {
      method: 'get',
      path: '/auth/saml/start',
      tags,
      summary: 'Sign in with the SAML identity provider: sends the browser there',
      description:
        'For browsers, not scripts. Redirects to the provider with an AuthnRequest (HTTP-Redirect binding), and sets a short-lived cookie that ties the response to this browser. `next` is a path on this site to come back to.',
      auth: 'none',
      query: z.object({ next: z.string().max(500).optional() }),
      status: 302,
    },
    async ({ c, query }) => {
      const runtime = c.get('runtime');
      const wait = startLimiter.hit(clientIp(c, runtime.config.trustProxy));
      if (wait) {
        c.header('retry-after', String(wait));
        return c.json(errorBody('rate_limited', 'Too many sign-ins started', `Try again in ${Math.ceil(wait / 60)} minutes`), 429);
      }
      try {
        const { url, browser } = await startSamlSignIn(runtime, query.next);
        const https = runtime.config.publicUrl.startsWith('https://');
        // The provider posts the response back from its own site, which a SameSite=Lax cookie
        // wouldn't come with. None needs Secure, so over plain http (development) it stays Lax.
        setCookie(c, SAML_COOKIE, browser, {
          httpOnly: true,
          sameSite: https ? 'None' : 'Lax',
          secure: https,
          path: COOKIE_PATH,
          maxAge: Math.floor(SAML_REQUEST_TTL_MS / 1000),
        });
        return c.redirect(url, 302);
      } catch (e) {
        if (e instanceof SsoError) return c.redirect(`/login?sso=${e.failure}`, 302);
        throw e;
      }
    },
  );

  app.use('/auth/saml/acs', bodyLimit({ maxSize: MAX_RESPONSE, onError: (c) => c.redirect('/login?sso=failed', 302) }));
  route(
    app,
    {
      method: 'post',
      path: '/auth/saml/acs',
      tags,
      summary: 'Where the SAML identity provider posts its response (the assertion consumer service)',
      description:
        'Register exactly `PUBLIC_URL/api/v1/auth/saml/acs` with the provider, HTTP-POST binding. On success a new session starts and the browser goes where it started; otherwise to the sign-in page, with `?sso=` saying why.',
      auth: 'none',
      status: 302,
    },
    async ({ c }) => {
      const runtime = c.get('runtime');
      const browser = getCookie(c, SAML_COOKIE);
      deleteCookie(c, SAML_COOKIE, { path: COOKIE_PATH, secure: runtime.config.publicUrl.startsWith('https://') });
      try {
        const body = await c.req.parseBody();
        const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
        const signed = await finishSamlSignIn(runtime, { SAMLResponse: text(body.SAMLResponse), RelayState: text(body.RelayState) }, browser, c.req.header('user-agent'));
        // Signing in starts afresh: whatever session this browser had ends.
        const old = getCookie(c, SESSION_COOKIE);
        if (old) await logout(runtime.db, old);
        setSessionCookie(c, runtime.config.publicUrl, signed.token, signed.expiresAt);
        return c.redirect(signed.returnTo, 302);
      } catch (e) {
        if (e instanceof SsoError) return c.redirect(`/login?sso=${e.failure}`, 302);
        console.error('saml: the response could not be handled', e);
        return c.redirect('/login?sso=failed', 302);
      }
    },
  );

  route(
    app,
    {
      method: 'get',
      path: '/auth/saml/metadata',
      tags,
      summary: "a4a's SAML service-provider metadata",
      description: 'Its entity id (`SAML_SP_ENTITY_ID`, this URL by default) and its assertion consumer service, for the identity provider to load.',
      auth: 'none',
    },
    async ({ c }) => {
      const runtime = c.get('runtime');
      if (!runtime.config.saml) return c.json(errorBody('not_found', 'SAML sign-in is not set up on this server'), 404);
      return c.body(await spMetadata(runtime), 200, { 'content-type': 'application/samlmetadata+xml; charset=utf-8' });
    },
  );
}
