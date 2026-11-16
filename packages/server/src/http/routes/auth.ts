import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  ApiTokenCreatedSchema,
  ApiTokenSchema,
  CreateTokenBody,
  LoginBody,
  MeSchema,
  SetupBody,
  SetupStatusSchema,
  SignInStepSchema,
  UpdateMeBody,
  UpdateTokenBody,
  type Me,
  type SignInStep,
} from '@a4a/shared';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { adminCtx, type Runtime } from '../../app-services';
import { effectiveScopes, type Ctx } from '../../context';
import { users } from '../../db/schema';
import { seedDemo } from '../../db/seed';
import { serverTimeZone } from '../../reports/tz';
import { AppError, badRequest, unauthorized } from '../../lib/errors';
import { projectAccess } from '../../services/access';
import { createToken, listTokens, login, logout, needsSetup, passwordUser, revokeToken, SESSION_COOKIE, startSession, updateToken } from '../../services/auth';
import { ldapSignIn } from '../../services/ldap';
import type { UserRow } from '../../services/schema-cache';
import { issueTicket, secondStepFor, TICKET_COOKIE, TICKET_COOKIE_PATH } from '../../services/two-factor';
import { beginLoginAttempt, waitInWords } from '../../services/login-throttle';
import { getSetting, setSetting } from '../../services/settings';
import { insertUser, updateMe, userDto } from '../../services/users';
import { APP_NAME } from '@a4a/shared';
import { isLocale } from '@a4a/shared/i18n';
import { getCookie } from 'hono/cookie';
import type { HttpEnv } from '../env';
import { clientIp, errorBody } from '../middleware';
import { route } from '../route';
import { oauthOn } from '../../oauth/common';

export async function meDto(ctx: Ctx): Promise<Me> {
  const view = await projectAccess(ctx);
  return {
    ...userDto(ctx.actor.user),
    timeZone: ctx.actor.user.timeZone ?? null,
    serverTimeZone: serverTimeZone(),
    locale: isLocale(ctx.actor.user.locale) ? ctx.actor.user.locale : null,
    defaultLocale: ctx.app.config.defaultLocale,
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
        ldap: runtime.config.ldap ? { name: runtime.config.ldap.name } : null,
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

  route(
    app,
    {
      method: 'post',
      path: '/auth/login',
      tags,
      summary: 'Sign in with login and password (sets a session cookie)',
      description:
        'The password is a4a’s own, or one an LDAP directory checks. When two-factor sign-in is on for the person, or this server asks it of everyone, the answer is `{ "step": "two_factor" }` or `{ "step": "two_factor_setup" }` and a short-lived cookie; finish with `POST /auth/two-factor/verify`, or `/auth/two-factor/setup` then `/auth/two-factor/setup/confirm`.',
      auth: 'none',
      body: LoginBody,
      response: z.union([MeSchema, SignInStepSchema]),
      status: 200,
    },
    async ({ c, body }) => {
      const runtime = c.get('runtime');
      const ldap = runtime.config.ldap;
      if (!runtime.config.passwordLogin && !ldap) {
        throw new AppError(403, 'password_login_off', 'Signing in with a password is turned off here', `Sign in with ${runtime.config.oidc?.name ?? runtime.config.saml?.name ?? 'single sign-on'}.`).said('passwordLoginOff', { provider: runtime.config.oidc?.name ?? runtime.config.saml?.name ?? 'Single Sign-on' });
      }
      // Counted in Postgres before the password is checked, so the limit holds across
      // instances, restarts and parallel guesses; a wrong password leaves its count.
      const attempt = await beginLoginAttempt(runtime.db, clientIp(c, runtime.config.trustProxy), body.login);
      if (attempt.wait) {
        c.header('retry-after', String(attempt.wait));
        return c.json(errorBody('rate_limited', 'Too many sign-in attempts', `Try again in ${waitInWords(attempt.wait)}`, undefined, { key: 'tooManySignIns', values: { minutes: Math.max(1, Math.ceil(attempt.wait / 60)) } }), 429);
      }
      // a4a's own password first, then the directory's (D38).
      const user = (runtime.config.passwordLogin ? await passwordUser(runtime.db, body.login, body.password) : null) ?? (ldap ? await ldapSignIn(runtime, ldap, body.login, body.password) : null);
      if (!user) throw unauthorized('Wrong login or password').said('wrongLogin');
      await attempt.succeeded();
      return afterPassword(c, runtime, user);
    },
  );

  route(app, { method: 'post', path: '/auth/logout', tags, summary: 'Sign out', status: 204 }, async ({ c }) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await logout(c.get('runtime').db, token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return null;
  });

  route(app, { method: 'get', path: '/me', tags, summary: 'Who you are, and what this session or token may do', response: MeSchema }, async ({ ctx }) => meDto(ctx));

  route(app, { method: 'patch', path: '/me', tags, summary: 'Change your name, email, password, time zone or working week', body: UpdateMeBody, response: MeSchema }, async ({ ctx, body }) => {
    const user = await updateMe(ctx, body);
    // Answer with you as saved: the row the request began with is from before the change.
    const [row] = await ctx.db.select().from(users).where(eq(users.id, ctx.actor.user.id));
    return { ...(await meDto(row ? { ...ctx, actor: { ...ctx.actor, user: row } } : ctx)), ...user };
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

/** A password was right: a session, or first the step two-factor sign-in still asks for (D38). */
async function afterPassword(c: Context<HttpEnv>, runtime: Runtime, user: UserRow): Promise<Me | SignInStep> {
  const step = await secondStepFor(runtime.db, user.id);
  if (!step) return startSessionFor(c, runtime, user);
  const ticket = await issueTicket(runtime.db, user.id, step);
  setCookie(c, TICKET_COOKIE, ticket.token, {
    httpOnly: true,
    sameSite: 'Strict',
    path: TICKET_COOKIE_PATH,
    secure: runtime.config.publicUrl.startsWith('https://'),
    expires: ticket.expiresAt,
  });
  return { step: step === 'verify' ? 'two_factor' : 'two_factor_setup' };
}

/** Signed in: a new session, its cookie, and who they are. */
export async function startSessionFor(c: Context<HttpEnv>, runtime: Runtime, user: UserRow): Promise<Me> {
  const session = await startSession(runtime.db, user.id, runtime.config.sessionTtlDays, c.req.header('user-agent'));
  setSessionCookie(c, runtime.config.publicUrl, session.token, session.expiresAt);
  return meDto({
    app: runtime,
    db: runtime.db,
    actor: { user, scopes: effectiveScopes(user.role), channel: 'web', tokenId: null, tokenName: null, authMethod: 'session' },
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
