/**
 * Two-factor sign-in (docs/architecture.md, D38): its step at sign-in, which a ticket cookie
 * carries from the password to the code, and setting it up from the profile.
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import { APP_NAME, MeSchema, RecoveryCodesSchema, TwoFactorCodeBody, TwoFactorEnrolmentSchema, TwoFactorStatusSchema, type TwoFactorEnrolment } from '@a4a/shared';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getCookie } from 'hono/cookie';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { Runtime } from '../../app-services';
import { requireScope, type Ctx } from '../../context';
import { users } from '../../db/schema';
import { AppError, conflict, forbidden, notFound, unauthorized } from '../../lib/errors';
import { beginLoginAttempt, waitInWords } from '../../services/login-throttle';
import type { UserRow } from '../../services/schema-cache';
import { getSetting } from '../../services/settings';
import {
  beginEnrolment,
  confirmEnrolment,
  disableTwoFactor,
  endTicket,
  peekTicket,
  removeTwoFactor,
  renewRecoveryCodes,
  TICKET_COOKIE,
  TICKET_COOKIE_PATH,
  twoFactorStatus,
  useTicket,
  wrongCode,
  takeSecondFactor,
} from '../../services/two-factor';
import type { HttpEnv } from '../env';
import { clientIp } from '../middleware';
import { route } from '../route';
import { startSessionFor } from './auth';

const signInAgain = () => unauthorized('This sign-in timed out', 'Sign in again with your login and password.');

/** Who a ticket is for, if they may still sign in. */
async function ticketUser(runtime: Runtime, userId: string): Promise<UserRow | null> {
  const [user] = await runtime.db.select().from(users).where(eq(users.id, userId));
  return user && !user.banned && !user.isBot ? user : null;
}

/**
 * Codes are guessed no faster than passwords: each try counts in the sign-in throttle, under a key
 * no login can have (logins have no colon).
 */
async function codeAttempt(c: Context<HttpEnv>, runtime: Runtime, userId: string) {
  const attempt = await beginLoginAttempt(runtime.db, clientIp(c, runtime.config.trustProxy), `totp:${userId}`);
  if (attempt.wait) {
    c.header('retry-after', String(attempt.wait));
    throw new AppError(429, 'rate_limited', 'Too many codes tried', `Try again in ${waitInWords(attempt.wait)}`).said('tooManyCodes', { minutes: Math.max(1, Math.ceil(attempt.wait / 60)) });
  }
  return attempt;
}

async function issuer(runtime: Runtime): Promise<string> {
  return ((await getSetting(runtime.db, 'instanceName')) as string | undefined) ?? APP_NAME;
}

/** A new secret, with its QR code as an image the page shows: drawn here, so nothing comes from outside. */
async function enrolment(runtime: Runtime, user: UserRow): Promise<TwoFactorEnrolment> {
  const started = await beginEnrolment(runtime, user, await issuer(runtime));
  const svg = await QRCode.toString(started.otpauthUri, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
  return { ...started, qrUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` };
}

/** Changing how someone signs in takes them, signed in, in a browser: a token can't. */
function inBrowser(ctx: Ctx, runtime: Runtime): void {
  if (ctx.actor.authMethod !== 'session') {
    throw forbidden('Two-factor sign-in is changed from a signed-in browser', 'Open Profile in a4a; a token can’t change how you sign in.');
  }
  if (!ctx.actor.user.passwordHash && !runtime.config.ldap) {
    throw conflict('You don’t sign in with a password here', 'Your identity provider asks for any second factor when you sign in with it.');
  }
}

export function twoFactorRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Auth'];

  // --- The step after the password, carried by the ticket cookie ---------------------------------

  route(
    app,
    {
      method: 'post',
      path: '/auth/two-factor/verify',
      tags,
      summary: 'Finish signing in with a code from your authenticator app, or a recovery code',
      description: 'After `POST /auth/login` answered `{ "step": "two_factor" }`. Five tries; the sign-in lasts ten minutes.',
      auth: 'none',
      body: TwoFactorCodeBody,
      response: MeSchema,
      status: 200,
    },
    async ({ c, body }) => {
      const runtime = c.get('runtime');
      const token = getCookie(c, TICKET_COOKIE);
      const ticket = await useTicket(runtime.db, token, 'verify');
      const user = ticket && (await ticketUser(runtime, ticket.userId));
      if (!token || !ticket || !user) throw signInAgain();
      const attempt = await codeAttempt(c, runtime, user.id);
      if (!(await takeSecondFactor(runtime, user.id, body.code))) throw wrongCode();
      await attempt.succeeded();
      await endTicket(runtime.db, token);
      deleteCookie(c, TICKET_COOKIE, { path: TICKET_COOKIE_PATH });
      return startSessionFor(c, runtime, user);
    },
  );

  route(
    app,
    {
      method: 'post',
      path: '/auth/two-factor/setup',
      tags,
      summary: 'Start setting up two-factor sign-in, which this server asks of everyone, while signing in',
      description: 'After `POST /auth/login` answered `{ "step": "two_factor_setup" }`.',
      auth: 'none',
      response: TwoFactorEnrolmentSchema,
      status: 200,
    },
    async ({ c }) => {
      const runtime = c.get('runtime');
      const ticket = await peekTicket(runtime.db, getCookie(c, TICKET_COOKIE), 'enroll');
      const user = ticket && (await ticketUser(runtime, ticket.userId));
      if (!ticket || !user) throw signInAgain();
      return enrolment(runtime, user);
    },
  );

  route(
    app,
    {
      method: 'post',
      path: '/auth/two-factor/setup/confirm',
      tags,
      summary: 'Confirm two-factor sign-in with a code from the app, and finish signing in',
      description: 'Answers with the recovery codes, shown this once; the session cookie is set.',
      auth: 'none',
      body: TwoFactorCodeBody,
      response: RecoveryCodesSchema,
      status: 200,
    },
    async ({ c, body }) => {
      const runtime = c.get('runtime');
      const token = getCookie(c, TICKET_COOKIE);
      const ticket = await useTicket(runtime.db, token, 'enroll');
      const user = ticket && (await ticketUser(runtime, ticket.userId));
      if (!token || !ticket || !user) throw signInAgain();
      const attempt = await codeAttempt(c, runtime, user.id);
      const recoveryCodes = await confirmEnrolment(runtime, user.id, body.code);
      await attempt.succeeded();
      await endTicket(runtime.db, token);
      deleteCookie(c, TICKET_COOKIE, { path: TICKET_COOKIE_PATH });
      await startSessionFor(c, runtime, user);
      return { recoveryCodes };
    },
  );

  // --- From the profile -----------------------------------------------------------------------

  route(app, { method: 'get', path: '/me/two-factor', tags, summary: 'Whether your password sign-in asks for a code too', response: TwoFactorStatusSchema }, async ({ ctx }) =>
    twoFactorStatus(ctx.db, ctx.actor.user.id),
  );

  route(
    app,
    { method: 'post', path: '/me/two-factor/setup', tags, summary: 'Start setting up two-factor sign-in: a new secret and its QR code', response: TwoFactorEnrolmentSchema, status: 200 },
    async ({ c, ctx }) => {
      const runtime = c.get('runtime');
      inBrowser(ctx, runtime);
      return enrolment(runtime, ctx.actor.user);
    },
  );

  route(
    app,
    {
      method: 'post',
      path: '/me/two-factor/confirm',
      tags,
      summary: 'Turn two-factor sign-in on with a code from the app',
      description: 'Answers with the recovery codes, shown this once.',
      body: TwoFactorCodeBody,
      response: RecoveryCodesSchema,
      status: 200,
    },
    async ({ c, ctx, body }) => {
      const runtime = c.get('runtime');
      inBrowser(ctx, runtime);
      const attempt = await codeAttempt(c, runtime, ctx.actor.user.id);
      const recoveryCodes = await confirmEnrolment(runtime, ctx.actor.user.id, body.code);
      await attempt.succeeded();
      return { recoveryCodes };
    },
  );

  route(
    app,
    {
      method: 'post',
      path: '/me/two-factor/recovery-codes',
      tags,
      summary: 'New recovery codes (the old ones stop working)',
      description: 'Takes a code from the app, or a recovery code.',
      body: TwoFactorCodeBody,
      response: RecoveryCodesSchema,
      status: 200,
    },
    async ({ c, ctx, body }) => {
      const runtime = c.get('runtime');
      inBrowser(ctx, runtime);
      const attempt = await codeAttempt(c, runtime, ctx.actor.user.id);
      const recoveryCodes = await renewRecoveryCodes(runtime, ctx.actor.user.id, body.code);
      await attempt.succeeded();
      return { recoveryCodes };
    },
  );

  route(
    app,
    { method: 'post', path: '/me/two-factor/disable', tags, summary: 'Turn two-factor sign-in off, with a code', body: TwoFactorCodeBody, status: 204 },
    async ({ c, ctx, body }) => {
      const runtime = c.get('runtime');
      inBrowser(ctx, runtime);
      const attempt = await codeAttempt(c, runtime, ctx.actor.user.id);
      await disableTwoFactor(runtime, ctx.actor.user.id, body.code);
      await attempt.succeeded();
      return null;
    },
  );

  route(
    app,
    {
      method: 'delete',
      path: '/users/{id}/two-factor',
      tags: ['Users'],
      summary: 'Reset someone’s two-factor sign-in (admin), for a lost phone and no recovery codes',
      description: 'Their next password sign-in has no second step, or sets one up again when this server asks it of everyone.',
      params: z.object({ id: z.string() }),
      status: 204,
    },
    async ({ ctx, params }) => {
      requireScope(ctx, 'admin');
      const [user] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.id, params.id));
      if (!user) throw notFound('User');
      await removeTwoFactor(ctx.db, user.id);
      return null;
    },
  );
}
