/**
 * Passkeys (docs/architecture.md, D62): signing in with one from the sign-in page, one in place of a
 * code after a password, and a person's own from their profile; an administrator's removal; and the
 * "this wasn't me" link their mails carry. Signing in is a browser's, so MCP has no tools for it.
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  AddPasskeyBody,
  ConfirmedSchema,
  ConfirmItsYouBody,
  MeSchema,
  MyPasskeysSchema,
  PasskeyAlertSchema,
  PasskeyOptionsSchema,
  PasskeySchema,
  PasskeySignInBody,
  RenamePasskeyBody,
} from '@a4a/shared';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Runtime } from '../../app-services';
import { requireScope, type Ctx } from '../../context';
import { users } from '../../db/schema';
import { randomToken, verifyPassword } from '../../lib/crypto';
import { AppError, badRequest, forbidden, unauthorized } from '../../lib/errors';
import { SESSION_COOKIE } from '../../services/auth';
import { beginLoginAttempt, waitInWords } from '../../services/login-throttle';
import {
  addPasskey,
  browserOnly,
  CHALLENGE_TTL_MS,
  confirmOptions,
  confirmWithPasskey,
  describeAlert,
  followAlert,
  markVerified,
  myPasskeys,
  PASSKEY_TICKET_COOKIE,
  PASSKEY_TICKET_PATH,
  passkeysOf,
  registrationOptions,
  removePasskey,
  removePasskeysOf,
  renamePasskey,
  secondStepOptions,
  secondStepWithPasskey,
  sessionRef,
  signInOptions,
  signInWithPasskey,
  type SessionRef,
} from '../../services/passkeys';
import type { UserRow } from '../../services/schema-cache';
import { endTicket, hasTwoFactor, peekTicket, takeSecondFactor, TICKET_COOKIE, TICKET_COOKIE_PATH, useTicket, wrongCode } from '../../services/two-factor';
import type { HttpEnv } from '../env';
import { clientIp, RateLimiter } from '../middleware';
import { route } from '../route';
import { startSessionFor } from './auth';

const signInAgain = () => unauthorized('This sign-in timed out', 'Sign in again with your login and password.').said('signIn.timedOut');

/** Challenges are rows: a page asks for one at a time, so an address asking for more is held back. */
const optionsPerAddress = new RateLimiter(30, 60_000);

function holdBack(c: Context<HttpEnv>, runtime: Runtime): void {
  const wait = optionsPerAddress.hit(`ip:${clientIp(c, runtime.config.trustProxy)}`);
  if (wait) {
    c.header('retry-after', String(wait));
    throw new AppError(429, 'rate_limited', 'Too many requests', `Retry in ${wait}s`).said('rateLimited', { seconds: wait });
  }
}

/** A passkey ceremony is a4a's page's: a request that says it comes from another site is refused. */
function fromHere(c: Context<HttpEnv>, runtime: Runtime): void {
  const origin = c.req.header('origin');
  if (origin && origin !== new URL(runtime.config.publicUrl).origin) throw forbidden('Cross-site request refused', 'Passkeys are used on a4a’s own pages.').said('passkeys.crossSite');
}

/** Tries count in the sign-in throttle, per address and per passkey or person, as passwords' do. */
async function attempt(c: Context<HttpEnv>, runtime: Runtime, key: string) {
  const a = await beginLoginAttempt(runtime.db, clientIp(c, runtime.config.trustProxy), key);
  if (a.wait) {
    c.header('retry-after', String(a.wait));
    throw new AppError(429, 'rate_limited', 'Too many sign-in attempts', `Try again in ${waitInWords(a.wait)}`).said('tooManySignIns', { minutes: Math.max(1, Math.ceil(a.wait / 60)) });
  }
  return a;
}

/** The ticket that binds a sign-in's challenge to this browser: the one it has, or a new one. */
function ticketFor(c: Context<HttpEnv>, runtime: Runtime): string {
  const held = getCookie(c, PASSKEY_TICKET_COOKIE);
  const ticket = held && /^a4p_[A-Za-z0-9_-]{43}$/.test(held) ? held : randomToken('a4p_', 32);
  setCookie(c, PASSKEY_TICKET_COOKIE, ticket, {
    httpOnly: true,
    sameSite: 'Strict',
    path: PASSKEY_TICKET_PATH,
    secure: runtime.config.publicUrl.startsWith('https://'),
    expires: new Date(Date.now() + CHALLENGE_TTL_MS + 60_000),
  });
  return ticket;
}

/** The signed-in browser's session: what only it may do, a token can't. */
async function browserSession(c: Context<HttpEnv>, ctx: Ctx): Promise<SessionRef> {
  if (ctx.actor.authMethod !== 'session') throw browserOnly();
  const session = await sessionRef(ctx.db, getCookie(c, SESSION_COOKIE));
  if (!session) throw browserOnly();
  return session;
}

async function signInUser(runtime: Runtime, userId: string): Promise<UserRow | null> {
  const [user] = await runtime.db.select().from(users).where(eq(users.id, userId));
  return user && !user.banned && !user.isBot ? user : null;
}

const first = (user: UserRow) => (user.passwordHash ? 'password' : 'ldap');

export function passkeyRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Passkeys'];

  // --- Signing in, from the sign-in page ---------------------------------------------------------

  route(
    app,
    {
      method: 'post',
      path: '/auth/passkey/options',
      tags,
      summary: 'Start signing in with a passkey: a challenge for navigator.credentials.get()',
      description:
        'Names nobody: the browser offers the passkeys it holds for this a4a, in its autofill or its own dialog. The challenge is bound to this browser by a short-lived cookie, and works once, for five minutes. Finish with `POST /auth/passkey`.',
      auth: 'none',
      response: PasskeyOptionsSchema,
      status: 200,
    },
    async ({ c }) => {
      const runtime = c.get('runtime');
      fromHere(c, runtime);
      holdBack(c, runtime);
      return signInOptions(runtime, ticketFor(c, runtime));
    },
  );

  route(
    app,
    {
      method: 'post',
      path: '/auth/passkey',
      tags,
      summary: 'Sign in with a passkey (sets a session cookie)',
      description: 'The passkey verified its person, so it is both factors: no password, and no code, even where two-factor sign-in is asked of everyone.',
      auth: 'none',
      body: PasskeySignInBody,
      response: MeSchema,
      status: 200,
    },
    async ({ c, body }) => {
      const runtime = c.get('runtime');
      fromHere(c, runtime);
      const tries = await attempt(c, runtime, `passkey:${body.response.id.slice(0, 48)}`);
      const { user, passkeyId } = await signInWithPasskey(runtime, getCookie(c, PASSKEY_TICKET_COOKIE), body.response as AuthenticationResponseJSON);
      await tries.succeeded();
      deleteCookie(c, PASSKEY_TICKET_COOKIE, { path: PASSKEY_TICKET_PATH });
      return startSessionFor(c, runtime, user, { with: 'passkey', passkeyId });
    },
  );

  // --- In place of a code, after a password -----------------------------------------------------

  route(
    app,
    {
      method: 'post',
      path: '/auth/two-factor/passkey/options',
      tags,
      summary: 'A passkey instead of a code: a challenge for the person whose password was right',
      description: 'After `POST /auth/login` answered `{ "step": "two_factor", "passkey": true }`. Finish with `POST /auth/two-factor/passkey`.',
      auth: 'none',
      response: PasskeyOptionsSchema,
      status: 200,
    },
    async ({ c }) => {
      const runtime = c.get('runtime');
      fromHere(c, runtime);
      holdBack(c, runtime);
      const ticket = await peekTicket(runtime.db, getCookie(c, TICKET_COOKIE), 'verify');
      const user = ticket && (await signInUser(runtime, ticket.userId));
      if (!ticket || !user) throw signInAgain();
      return secondStepOptions(runtime, ticket.id, user);
    },
  );

  route(
    app,
    {
      method: 'post',
      path: '/auth/two-factor/passkey',
      tags,
      summary: 'Finish signing in with one of your passkeys, in place of a code',
      description: 'Five tries, as with codes; the sign-in lasts ten minutes.',
      auth: 'none',
      body: PasskeySignInBody,
      response: MeSchema,
      status: 200,
    },
    async ({ c, body }) => {
      const runtime = c.get('runtime');
      fromHere(c, runtime);
      const token = getCookie(c, TICKET_COOKIE);
      const ticket = await useTicket(runtime.db, token, 'verify');
      const user = ticket && (await signInUser(runtime, ticket.userId));
      if (!token || !ticket || !user) throw signInAgain();
      const tries = await attempt(c, runtime, `passkey:${user.id}`);
      const { passkeyId } = await secondStepWithPasskey(runtime, ticket.id, user, body.response as AuthenticationResponseJSON);
      await tries.succeeded();
      await endTicket(runtime.db, token);
      deleteCookie(c, TICKET_COOKIE, { path: TICKET_COOKIE_PATH });
      return startSessionFor(c, runtime, user, { with: `${first(user)}+passkey`, passkeyId });
    },
  );

  // --- A person's own, from their profile -------------------------------------------------------

  route(app, { method: 'get', path: '/me/passkeys', tags, summary: 'Your passkeys, and whether this session may add and remove them now', response: MyPasskeysSchema }, async ({ c, ctx }) => {
    requireScope(ctx, 'read');
    const session = ctx.actor.authMethod === 'session' ? await sessionRef(ctx.db, getCookie(c, SESSION_COOKIE)) : null;
    return myPasskeys(ctx.app, ctx.actor.user, session, await hasTwoFactor(ctx.db, ctx.actor.user.id));
  });

  route(
    app,
    {
      method: 'post',
      path: '/me/passkeys/options',
      tags,
      summary: 'Start adding a passkey: a challenge for navigator.credentials.create()',
      description: 'A signed-in browser only, from a sign-in in the last ten minutes or after `POST /me/confirm`. Finish with `POST /me/passkeys`.',
      response: PasskeyOptionsSchema,
      status: 200,
    },
    async ({ c, ctx }) => registrationOptions(ctx.app, ctx.actor.user, await browserSession(c, ctx)),
  );

  route(
    app,
    {
      method: 'post',
      path: '/me/passkeys',
      tags,
      summary: 'Add a passkey, from what the browser made',
      description: 'It must verify its person, and be made for this address. Without `name`, it is named after what the authenticator says it is, or the browser. Its person is emailed.',
      body: AddPasskeyBody,
      response: PasskeySchema,
    },
    async ({ c, ctx, body }) =>
      addPasskey(ctx.app, ctx.actor.user, await browserSession(c, ctx), { response: body.response as RegistrationResponseJSON, name: body.name }, c.req.header('user-agent')),
  );

  route(
    app,
    { method: 'patch', path: '/me/passkeys/{id}', tags, summary: 'Rename one of your passkeys', params: z.object({ id: z.string().max(40) }), body: RenamePasskeyBody, response: PasskeySchema },
    async ({ c, ctx, params, body }) => {
      await browserSession(c, ctx);
      return renamePasskey(ctx.app, ctx.actor.user, params.id, body.name);
    },
  );

  route(
    app,
    {
      method: 'delete',
      path: '/me/passkeys/{id}',
      tags,
      summary: 'Remove one of your passkeys',
      description: 'From a recent sign-in, as adding one. The sessions it signed in end, but this one; its person is emailed.',
      params: z.object({ id: z.string().max(40) }),
      status: 204,
    },
    async ({ c, ctx, params }) => {
      await removePasskey(ctx.app, ctx.actor.user, await browserSession(c, ctx), params.id);
      return null;
    },
  );

  route(
    app,
    {
      method: 'post',
      path: '/me/confirm',
      tags,
      summary: 'Confirm it’s you with your password, and a code if two-factor sign-in is on',
      description: 'Lets this session add and remove passkeys for ten minutes. Counts in the sign-in throttle, as signing in does.',
      body: ConfirmItsYouBody,
      response: ConfirmedSchema,
      status: 200,
    },
    async ({ c, ctx, body }) => {
      const session = await browserSession(c, ctx);
      const runtime = c.get('runtime');
      const user = ctx.actor.user;
      const tries = await attempt(c, runtime, user.login);
      if (!user.passwordHash || !(await verifyPassword(body.password, user.passwordHash))) throw forbidden('Current password is incorrect').said('users.wrongPassword');
      if (await hasTwoFactor(ctx.db, user.id)) {
        if (!body.code) throw badRequest('Type a code from your authenticator app too', 'Two-factor sign-in is on for you: confirming it’s you takes a code, as signing in does.').said('passkeys.codeNeeded');
        if (!(await takeSecondFactor(runtime, user.id, body.code))) throw wrongCode();
      }
      await tries.succeeded();
      return { confirmedUntil: (await markVerified(ctx.db, session.id)).toISOString() };
    },
  );

  route(
    app,
    { method: 'post', path: '/me/confirm/passkey/options', tags, summary: 'Confirm it’s you with one of your passkeys: a challenge', response: PasskeyOptionsSchema, status: 200 },
    async ({ c, ctx }) => {
      const session = await browserSession(c, ctx);
      holdBack(c, c.get('runtime'));
      return confirmOptions(ctx.app, ctx.actor.user, session);
    },
  );

  route(
    app,
    {
      method: 'post',
      path: '/me/confirm/passkey',
      tags,
      summary: 'Confirm it’s you with one of your passkeys',
      description: 'Lets this session add and remove passkeys for ten minutes.',
      body: PasskeySignInBody,
      response: ConfirmedSchema,
      status: 200,
    },
    async ({ c, ctx, body }) => {
      const session = await browserSession(c, ctx);
      const tries = await attempt(c, c.get('runtime'), `passkey:${ctx.actor.user.id}`);
      const until = await confirmWithPasskey(ctx.app, ctx.actor.user, session, body.response as AuthenticationResponseJSON);
      await tries.succeeded();
      return { confirmedUntil: until.toISOString() };
    },
  );

  // --- An administrator's ------------------------------------------------------------------------

  route(app, { method: 'get', path: '/users/{id}/passkeys', tags: ['Users'], summary: 'Someone’s passkeys (admin)', params: z.object({ id: z.string() }), response: z.array(PasskeySchema) }, async ({ ctx, params }) =>
    passkeysOf(ctx, params.id),
  );

  route(
    app,
    {
      method: 'delete',
      path: '/users/{id}/passkeys',
      tags: ['Users'],
      summary: 'Remove someone’s passkeys (admin), for a lost device',
      description: 'Every one of theirs, and every session one signed in. Their password, and two-factor, still sign them in; they are emailed.',
      params: z.object({ id: z.string() }),
      status: 204,
    },
    async ({ ctx, params }) => {
      await removePasskeysOf(ctx, params.id);
      return null;
    },
  );

  // --- "This wasn't me" --------------------------------------------------------------------------

  const token = z.object({ token: z.string().min(10).max(100) });
  route(
    app,
    { method: 'get', path: '/not-me', tags, summary: 'What a mail’s “this wasn’t me” link is about (opening it changes nothing)', auth: 'none', query: token, response: PasskeyAlertSchema },
    async ({ c, query }) => describeAlert(c.get('runtime'), query.token),
  );

  route(
    app,
    {
      method: 'post',
      path: '/not-me',
      tags,
      summary: 'Say a change to your passkeys wasn’t you',
      description: 'Signs you out everywhere, and the passkey it names (with any added after it) signs nobody in. It takes access away, never gives it, so the mail is enough: no sign-in. Once.',
      auth: 'none',
      query: token,
      response: PasskeyAlertSchema,
      status: 200,
    },
    async ({ c, query }) => {
      fromHere(c, c.get('runtime'));
      return followAlert(c.get('runtime'), query.token);
    },
  );
}
