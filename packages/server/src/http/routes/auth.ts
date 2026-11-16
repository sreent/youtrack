import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  ApiTokenCreatedSchema,
  ApiTokenSchema,
  CreateTokenBody,
  LoginBody,
  MeSchema,
  SetupBody,
  SetupStatusSchema,
  UpdateMeBody,
  UpdateTokenBody,
  type Me,
} from '@a4a/shared';
import { deleteCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { adminCtx } from '../../app-services';
import { effectiveScopes, type Ctx } from '../../context';
import { seedDemo } from '../../db/seed';
import { AppError, badRequest } from '../../lib/errors';
import { projectAccess } from '../../services/access';
import { createToken, listTokens, login, logout, needsSetup, revokeToken, SESSION_COOKIE, updateToken } from '../../services/auth';
import { beginLoginAttempt, waitInWords } from '../../services/login-throttle';
import { getSetting, setSetting } from '../../services/settings';
import { insertUser, updateMe, userDto } from '../../services/users';
import { APP_NAME } from '@a4a/shared';
import { getCookie } from 'hono/cookie';
import type { HttpEnv } from '../env';
import { clientIp, errorBody } from '../middleware';
import { route } from '../route';
import { oauthOn } from '../../oauth/common';

export async function meDto(ctx: Ctx): Promise<Me> {
  const view = await projectAccess(ctx);
  return {
    ...userDto(ctx.actor.user),
    auth: {
      method: ctx.actor.authMethod === 'token' ? 'token' : 'session',
      scopes: ctx.actor.scopes,
      tokenName: ctx.actor.tokenName,
      projects: ctx.actor.projectIds ? ctx.actor.projectIds.filter((id) => view.canRead(id)).map((id) => view.keyOf(id)!) : null,
    },
  };
}

export function authRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Auth'];

  route(app, { method: 'get', path: '/auth/setup', tags, summary: 'Whether the first administrator still has to be created', auth: 'none', response: SetupStatusSchema }, async ({ c }) => {
    const runtime = c.get('runtime');
    const sso = runtime.config.oidc;
    const saml = runtime.config.saml;
    return {
      needsSetup: await needsSetup(runtime.db),
      instanceName: ((await getSetting(runtime.db, 'instanceName')) as string | undefined) ?? APP_NAME,
      signIn: {
        password: runtime.config.passwordLogin,
        sso: sso ? { name: sso.name, url: '/api/v1/auth/oidc/start' } : null,
        saml: saml ? { name: saml.name, url: '/api/v1/auth/saml/start' } : null,
      },
      mcpOAuth: oauthOn(runtime.config),
    };
  });

  route(
    app,
    {
      method: 'post',
      path: '/auth/setup',
      tags,
      summary: 'Create the first administrator (only before anyone exists)',
      auth: 'none',
      body: SetupBody,
      response: MeSchema,
    },
    async ({ c, body }) => {
      const runtime = c.get('runtime');
      // Exclusive across instances: two setups at once must not make two first administrators.
      const admin = await runtime.database.exclusive(async () => {
        if (!(await needsSetup(runtime.db))) throw new AppError(409, 'already_set_up', 'This server already has an administrator');
        if (!runtime.config.passwordLogin && !body.email) {
          throw badRequest('Give your email', `Passwords are off here: from now on you sign in with ${runtime.config.oidc?.name ?? runtime.config.saml?.name ?? 'single sign-on'}, which finds you by it.`);
        }
        // The first administrator vouches for their own email: single sign-on may find them by it.
        const created = await insertUser(runtime.db, { login: body.login, name: body.name, email: body.email ?? null, emailVerified: true, password: body.password, role: 'admin' });
        runtime.schema.invalidate();
        if (body.seedDemo) await seedDemo(runtime, created);
        return created;
      });
      await setSetting(runtime.db, 'setupAt', new Date().toISOString());
      const session = await login(runtime.db, body.login, body.password, runtime.config.sessionTtlDays, c.req.header('user-agent'));
      setSessionCookie(c, runtime.config.publicUrl, session.token, session.expiresAt);
      const ctx = adminCtx(runtime, admin, 'web');
      ctx.actor.authMethod = 'session';
      return await meDto(ctx);
    },
  );

  route(app, { method: 'post', path: '/auth/login', tags, summary: 'Sign in with login and password (sets a session cookie)', auth: 'none', body: LoginBody, response: MeSchema, status: 200 }, async ({ c, body }) => {
    const runtime = c.get('runtime');
    if (!runtime.config.passwordLogin) {
      throw new AppError(403, 'password_login_off', 'Signing in with a password is turned off here', `Sign in with ${runtime.config.oidc?.name ?? runtime.config.saml?.name ?? 'single sign-on'}.`);
    }
    // Counted in Postgres before the password is checked, so the limit holds across
    // instances, restarts and parallel guesses; a wrong password leaves its count.
    const attempt = await beginLoginAttempt(runtime.db, clientIp(c, runtime.config.trustProxy), body.login);
    if (attempt.wait) {
      c.header('retry-after', String(attempt.wait));
      return c.json(errorBody('rate_limited', 'Too many sign-in attempts', `Try again in ${waitInWords(attempt.wait)}`), 429);
    }
    const session = await login(runtime.db, body.login, body.password, runtime.config.sessionTtlDays, c.req.header('user-agent'));
    await attempt.succeeded();
    setSessionCookie(c, runtime.config.publicUrl, session.token, session.expiresAt);
    return await meDto({
      app: runtime,
      db: runtime.db,
      actor: { user: session.user, scopes: effectiveScopes(session.user.role), channel: 'web', tokenId: null, tokenName: null, authMethod: 'session' },
    });
  });

  route(app, { method: 'post', path: '/auth/logout', tags, summary: 'Sign out', status: 204 }, async ({ c }) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await logout(c.get('runtime').db, token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return null;
  });

  route(app, { method: 'get', path: '/me', tags, summary: 'Who you are, and what this session or token may do', response: MeSchema }, async ({ ctx }) => meDto(ctx));

  route(app, { method: 'patch', path: '/me', tags, summary: 'Change your name, email or password', body: UpdateMeBody, response: MeSchema }, async ({ ctx, body }) => {
    const user = await updateMe(ctx, body);
    return { ...(await meDto(ctx)), ...user };
  });

  route(app, { method: 'get', path: '/me/tokens', tags: ['API tokens'], summary: 'Your API tokens', response: z.array(ApiTokenSchema) }, async ({ ctx }) => listTokens(ctx));

  route(
    app,
    {
      method: 'post',
      path: '/me/tokens',
      tags: ['API tokens'],
      summary: 'Create an API token (the secret is returned once)',
      description:
        'Scopes narrow what the token may do; they never exceed your role. Use a read-only token to let an agent explore safely. `projects` limits it to some projects: there it may do what you may, and it reaches no other.',
      body: CreateTokenBody,
      response: ApiTokenCreatedSchema,
    },
    async ({ ctx, body }) => {
      if (!body.scopes.length) throw badRequest('Choose at least one scope');
      return createToken(ctx, body);
    },
  );

  route(
    app,
    {
      method: 'patch',
      path: '/me/tokens/{id}',
      tags: ['API tokens'],
      summary: 'Rename a token, or change the projects it reaches',
      description: '`projects: null` lets it reach every project you can see; a list limits it to those.',
      params: z.object({ id: z.string() }),
      body: UpdateTokenBody,
      response: ApiTokenSchema,
    },
    async ({ ctx, params, body }) => updateToken(ctx, params.id, body),
  );

  route(app, { method: 'delete', path: '/me/tokens/{id}', tags: ['API tokens'], summary: 'Revoke an API token', params: z.object({ id: z.string() }), status: 204 }, async ({ ctx, params }) => {
    await revokeToken(ctx, params.id);
    return null;
  });
}

export function setSessionCookie(c: Parameters<typeof setCookie>[0], publicUrl: string, token: string, expiresAt: Date) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: publicUrl.startsWith('https://'),
    expires: expiresAt,
  });
}
