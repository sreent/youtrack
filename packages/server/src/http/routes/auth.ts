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
  type Me,
} from '@tracklet/shared';
import { deleteCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { adminCtx } from '../../app-services';
import { effectiveScopes, type Ctx } from '../../context';
import { seedDemo } from '../../db/seed';
import { AppError, badRequest } from '../../lib/errors';
import { createToken, listTokens, login, logout, needsSetup, revokeToken, SESSION_COOKIE } from '../../services/auth';
import { getSetting, setSetting } from '../../services/settings';
import { insertUser, updateMe, userDto } from '../../services/users';
import { APP_NAME } from '@tracklet/shared';
import { getCookie } from 'hono/cookie';
import type { HttpEnv } from '../env';
import { clientIp, errorBody, RateLimiter } from '../middleware';
import { route } from '../route';

const loginLimiter = new RateLimiter(10, 15 * 60_000);

export function meDto(ctx: Ctx): Me {
  return {
    ...userDto(ctx.actor.user),
    auth: {
      method: ctx.actor.authMethod === 'token' ? 'token' : 'session',
      scopes: ctx.actor.scopes,
      tokenName: ctx.actor.tokenName,
    },
  };
}

export function authRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Auth'];

  route(app, { method: 'get', path: '/auth/setup', tags, summary: 'Whether the first administrator still has to be created', auth: 'none', response: SetupStatusSchema }, async ({ c }) => {
    const runtime = c.get('runtime');
    return {
      needsSetup: await needsSetup(runtime.db),
      instanceName: ((await getSetting(runtime.db, 'instanceName')) as string | undefined) ?? APP_NAME,
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
      if (!(await needsSetup(runtime.db))) throw new AppError(409, 'already_set_up', 'This server already has an administrator');
      const admin = await insertUser(runtime.db, { login: body.login, name: body.name, email: body.email ?? null, password: body.password, role: 'admin' });
      runtime.schema.invalidate();
      if (body.seedDemo) await seedDemo(runtime, admin);
      await setSetting(runtime.db, 'setupAt', new Date().toISOString());
      const session = await login(runtime.db, body.login, body.password, runtime.config.sessionTtlDays, c.req.header('user-agent'));
      setSessionCookie(c, runtime.config.publicUrl, session.token, session.expiresAt);
      const ctx = adminCtx(runtime, admin, 'web');
      ctx.actor.authMethod = 'session';
      return meDto(ctx);
    },
  );

  route(app, { method: 'post', path: '/auth/login', tags, summary: 'Sign in with login and password (sets a session cookie)', auth: 'none', body: LoginBody, response: MeSchema, status: 200 }, async ({ c, body }) => {
    const runtime = c.get('runtime');
    const key = `${clientIp(c)}|${body.login.toLowerCase()}`;
    const wait = loginLimiter.hit(key);
    if (wait) {
      c.header('retry-after', String(wait));
      return c.json(errorBody('rate_limited', 'Too many sign-in attempts', `Try again in ${Math.ceil(wait / 60)} minutes`), 429);
    }
    const session = await login(runtime.db, body.login, body.password, runtime.config.sessionTtlDays, c.req.header('user-agent'));
    loginLimiter.reset(key);
    setSessionCookie(c, runtime.config.publicUrl, session.token, session.expiresAt);
    return meDto({
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
    return { ...meDto(ctx), ...user };
  });

  route(app, { method: 'get', path: '/me/tokens', tags: ['API tokens'], summary: 'Your API tokens', response: z.array(ApiTokenSchema) }, async ({ ctx }) => listTokens(ctx));

  route(
    app,
    {
      method: 'post',
      path: '/me/tokens',
      tags: ['API tokens'],
      summary: 'Create an API token (the secret is returned once)',
      description: 'Scopes narrow what the token may do; they never exceed your role. Use a read-only token to let an agent explore safely.',
      body: CreateTokenBody,
      response: ApiTokenCreatedSchema,
    },
    async ({ ctx, body }) => {
      if (!body.scopes.length) throw badRequest('Choose at least one scope');
      return createToken(ctx, body);
    },
  );

  route(app, { method: 'delete', path: '/me/tokens/{id}', tags: ['API tokens'], summary: 'Revoke an API token', params: z.object({ id: z.string() }), status: 204 }, async ({ ctx, params }) => {
    await revokeToken(ctx, params.id);
    return null;
  });
}

function setSessionCookie(c: Parameters<typeof setCookie>[0], publicUrl: string, token: string, expiresAt: Date) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: publicUrl.startsWith('https://'),
    expires: expiresAt,
  });
}
