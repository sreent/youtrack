import type { OpenAPIHono } from '@hono/zod-openapi';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { logout, SESSION_COOKIE } from '../../services/auth';
import { finishSignIn, SSO_STATE_COOKIE, SSO_STATE_TTL_MS, SsoError, startSignIn } from '../../services/sso';
import type { HttpEnv } from '../env';
import { clientIp, errorBody, RateLimiter } from '../middleware';
import { route } from '../route';
import { setSessionCookie } from './auth';

const COOKIE_PATH = '/api/v1/auth/oidc';
// Starting a sign-in stores a row, so it is limited per address like signing in with a password.
const startLimiter = new RateLimiter(30, 15 * 60_000);

/** Single sign-on with OpenID Connect: two browser redirects, there and back. */
export function ssoRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Auth'];
  route(
    app,
    {
      method: 'get',
      path: '/auth/oidc/start',
      tags,
      summary: 'Sign in with the identity provider: sends the browser there',
      description:
        'For browsers, not scripts. Redirects to the provider with PKCE, a state and a nonce, and sets a short-lived cookie that binds the state to this browser. `next` is a path on this site to come back to.',
      auth: 'none',
      query: z.object({ next: z.string().max(500).optional() }),
      status: 302,
    },
    async ({ c, query }) => {
      const runtime = c.get('runtime');
      // Behind a proxy, the address is the one TRUST_PROXY says to read, as for every limit.
      const wait = startLimiter.hit(clientIp(c, runtime.config.trustProxy));
      if (wait) {
        c.header('retry-after', String(wait));
        return c.json(errorBody('rate_limited', 'Too many sign-ins started', `Try again in ${Math.ceil(wait / 60)} minutes`), 429);
      }
      try {
        const { url, state } = await startSignIn(runtime, query.next);
        setCookie(c, SSO_STATE_COOKIE, state, {
          httpOnly: true,
          sameSite: 'Lax',
          path: COOKIE_PATH,
          secure: runtime.config.publicUrl.startsWith('https://'),
          maxAge: Math.floor(SSO_STATE_TTL_MS / 1000),
        });
        return c.redirect(url, 302);
      } catch (e) {
        if (e instanceof SsoError) return c.redirect(`/login?sso=${e.failure}`, 302);
        throw e;
      }
    },
  );

  route(
    app,
    {
      method: 'get',
      path: '/auth/oidc/callback',
      tags,
      summary: 'Where the identity provider sends the browser back (the redirect URI)',
      description:
        'Register exactly `PUBLIC_URL/api/v1/auth/oidc/callback` with the provider. On success a new session starts and the browser goes where it started; otherwise to the sign-in page, with `?sso=` saying why.',
      auth: 'none',
      status: 302,
    },
    async ({ c }) => {
      const runtime = c.get('runtime');
      const browserState = getCookie(c, SSO_STATE_COOKIE);
      deleteCookie(c, SSO_STATE_COOKIE, { path: COOKIE_PATH });
      try {
        const signed = await finishSignIn(runtime, new URL(c.req.url).searchParams, browserState, c.req.header('user-agent'));
        // Signing in starts afresh: whatever session this browser had ends.
        const old = getCookie(c, SESSION_COOKIE);
        if (old) await logout(runtime.db, old);
        setSessionCookie(c, runtime.config.publicUrl, signed.token, signed.expiresAt);
        return c.redirect(signed.returnTo, 302);
      } catch (e) {
        if (e instanceof SsoError) return c.redirect(`/login?sso=${e.failure}`, 302);
        console.error('sso: the callback failed', e);
        return c.redirect('/login?sso=failed', 302);
      }
    },
  );
}
