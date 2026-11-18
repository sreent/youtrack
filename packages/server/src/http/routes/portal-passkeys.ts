/**
 * Requesters' passkeys over HTTP (docs/architecture.md, D69): signing in to the portal with one,
 * a requester's own on the portal's account page, the "this wasn't me" link their mails carry, and
 * the team's removal. Only the portal's routes read requesters' passkeys, and they open the portal's
 * cookie alone; the team's routes (routes/passkeys.ts) read only members'. Signing in is a browser's,
 * so MCP has no tools for it (D62, D63).
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  AddPasskeyBody,
  ConfirmedSchema,
  PasskeyOptionsSchema,
  PasskeySchema,
  PasskeySignInBody,
  PortalMeSchema,
  PortalPasskeyAlertSchema,
  PortalPasskeyOptionsBody,
  PortalPasskeySignInBody,
  PortalPasskeysSchema,
  RemovedPasskeysSchema,
  RenamePasskeyBody,
} from '@a4a/shared';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Runtime } from '../../app-services';
import { randomToken } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { beginLoginAttempt, waitInWords } from '../../services/login-throttle';
import { CHALLENGE_TTL_MS } from '../../services/passkeys';
import { PORTAL_COOKIE, PORTAL_SESSION_MS, portalMe, portalRequester, type PortalViewer } from '../../services/portal';
import {
  addPortalPasskey,
  confirmWithPortalPasskey,
  describePortalAlert,
  followPortalAlert,
  myPortalPasskeys,
  PORTAL_PASSKEY_PATH,
  PORTAL_PASSKEY_TICKET,
  portalConfirmOptions,
  portalRegistrationOptions,
  portalSessionRef,
  portalSignInOptions,
  removePortalPasskey,
  removeRequesterPasskeys,
  renamePortalPasskey,
  signInWithPortalPasskey,
  type PortalSessionRef,
} from '../../services/portal-passkeys';
import { startPortalSession } from '../../services/portal-sign-in';
import type { HttpEnv } from '../env';
import { clientIp, RateLimiter } from '../middleware';
import { route } from '../route';
import { sameOrigin } from './helpdesk';
import { setPortalSession } from './portal-sign-in';

/** Challenges are rows: a page asks for one at a time, so an address asking for more is held back, as D62's are. */
const optionsPerAddress = new RateLimiter(30, 60_000);

function holdBack(c: Context<HttpEnv>, runtime: Runtime): void {
  const wait = optionsPerAddress.hit(`ip:${clientIp(c, runtime.config.trustProxy)}`);
  if (wait) {
    c.header('retry-after', String(wait));
    throw new AppError(429, 'rate_limited', 'Too many requests', `Retry in ${wait}s`).said('rateLimited', { seconds: wait });
  }
}

/** Each try counts in the sign-in throttle, per address and per passkey or requester, under keys no login can have. */
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
  const held = getCookie(c, PORTAL_PASSKEY_TICKET);
  const ticket = held && /^hdq_[A-Za-z0-9_-]{43}$/.test(held) ? held : randomToken('hdq_', 32);
  setCookie(c, PORTAL_PASSKEY_TICKET, ticket, {
    httpOnly: true,
    sameSite: 'Strict',
    path: PORTAL_PASSKEY_PATH,
    secure: runtime.config.publicUrl.startsWith('https://'),
    expires: new Date(Date.now() + CHALLENGE_TTL_MS + 60_000),
  });
  return ticket;
}

const signedOut = () => new AppError(401, 'unauthenticated', 'Sign in to see your requests', 'Ask for a sign-in link with your email address.').said('portal.signInToSee');

export function portalPasskeyRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Help desk portal'];
  const cookie = (c: Context<HttpEnv>) => getCookie(c, PORTAL_COOKIE);
  /** The requester signed in, and their session, for what only a signed-in portal browser may do. */
  const signedIn = async (c: Context<HttpEnv>): Promise<{ r: PortalViewer; session: PortalSessionRef }> => {
    const runtime = c.get('runtime');
    const r = await portalRequester(runtime, cookie(c));
    const session = await portalSessionRef(runtime.db, cookie(c));
    if (!session || session.requesterId !== r.id) throw signedOut();
    return { r, session };
  };
  const Id = z.object({ id: z.string().min(1).max(40) });

  // --- Signing in, from the portal's sign-in page ------------------------------------------------

  route(
    app,
    {
      method: 'post',
      path: '/portal/passkey/options',
      tags,
      summary: 'Start signing in to the portal with a passkey: a challenge for navigator.credentials.get()',
      description:
        'Public. Names nobody: the browser offers the passkeys it holds for this address, in its autofill or its own dialog. With `desk`, that desk must take passkeys; without, some desk must. The challenge is bound to this browser by a short-lived cookie, and works once, for five minutes. Finish with `POST /portal/passkey`.',
      auth: 'none',
      body: PortalPasskeyOptionsBody,
      response: PasskeyOptionsSchema,
      status: 200,
    },
    async ({ c, body }) => {
      const runtime = c.get('runtime');
      sameOrigin(c);
      holdBack(c, runtime);
      return portalSignInOptions(runtime, ticketFor(c, runtime), body.desk);
    },
  );

  route(
    app,
    {
      method: 'post',
      path: '/portal/passkey',
      tags,
      summary: 'Sign in to the portal with a passkey',
      description: `Public. A requester's passkey, never a member's: it opens the portal's \`${PORTAL_COOKIE}\` cookie alone, and the session opens the requests of the desks that take passkeys. Each try counts in the sign-in throttle, per address and per passkey.`,
      auth: 'none',
      body: PortalPasskeySignInBody,
      response: PortalMeSchema,
      status: 200,
    },
    async ({ c, body }) => {
      const runtime = c.get('runtime');
      sameOrigin(c);
      const tries = await attempt(c, runtime, `portal-passkey:${body.response.id.slice(0, 48)}`);
      const { requester, passkeyId } = await signInWithPortalPasskey(runtime, getCookie(c, PORTAL_PASSKEY_TICKET), body.response as AuthenticationResponseJSON, body.desk);
      await tries.succeeded();
      deleteCookie(c, PORTAL_PASSKEY_TICKET, { path: PORTAL_PASSKEY_PATH });
      const token = await startPortalSession(runtime.db, requester.id, { method: 'passkey', providerId: null, passkeyId }, PORTAL_SESSION_MS);
      setPortalSession(c, runtime, token);
      return portalMe(runtime, { ...requester, signedIn: { method: 'passkey', providerId: null } });
    },
  );

  // --- A requester's own, on the portal's account page -------------------------------------------

  route(
    app,
    {
      method: 'get',
      path: '/portal/me/passkeys',
      tags,
      summary: 'My passkeys, and whether this session may add and remove them now',
      description: 'Signed in to the portal.',
      auth: 'none',
      response: PortalPasskeysSchema,
    },
    async ({ c }) => {
      c.header('cache-control', 'no-store');
      const { r, session } = await signedIn(c);
      return myPortalPasskeys(c.get('runtime'), r, session);
    },
  );

  route(
    app,
    {
      method: 'post',
      path: '/portal/me/passkeys/options',
      tags,
      summary: 'Start adding a passkey: a challenge for navigator.credentials.create()',
      description:
        'Signed in to the portal, by an emailed link or a passkey in the last ten minutes, or confirmed since with `POST /portal/me/confirm/passkey`; otherwise 403 `confirm_needed`. Finish with `POST /portal/me/passkeys`.',
      auth: 'none',
      body: z.object({}),
      response: PasskeyOptionsSchema,
      status: 200,
    },
    async ({ c }) => {
      const runtime = c.get('runtime');
      sameOrigin(c);
      const { r, session } = await signedIn(c);
      holdBack(c, runtime);
      return portalRegistrationOptions(runtime, r, session);
    },
  );

  route(
    app,
    {
      method: 'post',
      path: '/portal/me/passkeys',
      tags,
      summary: 'Add a passkey, from what the browser made',
      description: 'It must verify its person, and be made for this address. Without `name`, it is named after what the authenticator says it is, or the browser. The requester is emailed.',
      auth: 'none',
      body: AddPasskeyBody,
      response: PasskeySchema,
      status: 201,
    },
    async ({ c, body }) => {
      sameOrigin(c);
      const { r, session } = await signedIn(c);
      return addPortalPasskey(c.get('runtime'), r, session, { response: body.response as RegistrationResponseJSON, name: body.name }, c.req.header('user-agent'));
    },
  );

  route(
    app,
    { method: 'patch', path: '/portal/me/passkeys/{id}', tags, summary: 'Rename one of my passkeys', auth: 'none', params: Id, body: RenamePasskeyBody, response: PasskeySchema },
    async ({ c, params, body }) => {
      sameOrigin(c);
      const { r } = await signedIn(c);
      return renamePortalPasskey(c.get('runtime'), r, params.id, body.name);
    },
  );

  route(
    app,
    {
      method: 'delete',
      path: '/portal/me/passkeys/{id}',
      tags,
      summary: 'Remove one of my passkeys',
      description: 'From a recent sign-in, as adding one. The sessions it opened end, but this one; the requester is emailed.',
      auth: 'none',
      params: Id,
      status: 204,
    },
    async ({ c, params }) => {
      sameOrigin(c);
      const { r, session } = await signedIn(c);
      await removePortalPasskey(c.get('runtime'), r, session, params.id);
      return null;
    },
  );

  route(
    app,
    { method: 'post', path: '/portal/me/confirm/passkey/options', tags, summary: 'Confirm it’s me with one of my passkeys: a challenge', auth: 'none', body: z.object({}), response: PasskeyOptionsSchema, status: 200 },
    async ({ c }) => {
      const runtime = c.get('runtime');
      sameOrigin(c);
      const { r, session } = await signedIn(c);
      holdBack(c, runtime);
      return portalConfirmOptions(runtime, r, session);
    },
  );

  route(
    app,
    {
      method: 'post',
      path: '/portal/me/confirm/passkey',
      tags,
      summary: 'Confirm it’s me with one of my passkeys',
      description: 'Lets this session add and remove passkeys for ten minutes. Without a passkey, sign in again by an emailed link (`POST /portal/sign-in`): a session it opens may, for ten minutes.',
      auth: 'none',
      body: PasskeySignInBody,
      response: ConfirmedSchema,
      status: 200,
    },
    async ({ c, body }) => {
      const runtime = c.get('runtime');
      sameOrigin(c);
      const { r, session } = await signedIn(c);
      const tries = await attempt(c, runtime, `portal-passkey-confirm:${r.id}`);
      const until = await confirmWithPortalPasskey(runtime, r, session, body.response as AuthenticationResponseJSON);
      await tries.succeeded();
      return { confirmedUntil: until.toISOString() };
    },
  );

  // --- "This wasn't me" ----------------------------------------------------------------------------

  const token = z.object({ token: z.string().min(10).max(100) });
  route(
    app,
    { method: 'get', path: '/portal/not-me', tags, summary: 'What a mail’s “this wasn’t me” link is about (opening it changes nothing)', auth: 'none', query: token, response: PortalPasskeyAlertSchema },
    async ({ c, query }) => {
      c.header('cache-control', 'no-store');
      return describePortalAlert(c.get('runtime'), query.token);
    },
  );

  route(
    app,
    {
      method: 'post',
      path: '/portal/not-me',
      tags,
      summary: 'Say a change to my passkeys wasn’t me',
      description:
        'Signs the requester out of the portal everywhere, voids their unused links, and the passkey it names (with any added after it) signs nobody in. It takes access away, never gives it, so the mail is enough: no sign-in. Once.',
      auth: 'none',
      query: token,
      response: PortalPasskeyAlertSchema,
      status: 200,
    },
    async ({ c, query }) => {
      sameOrigin(c);
      return followPortalAlert(c.get('runtime'), query.token);
    },
  );

  // --- The team's ------------------------------------------------------------------------------------

  route(
    app,
    {
      method: 'delete',
      path: '/issues/{id}/request/passkeys',
      tags: ['Help desk'],
      summary: "Remove a request's requester's passkeys, for a lost device",
      description:
        "An administrator, or a manager of the request's desk. Every passkey of theirs goes, with every portal session one opened; their other ways in stay, and they're emailed. The team sees how many they have (`GET /issues/{id}/request`), never which.",
      params: z.object({ id: z.string() }),
      response: RemovedPasskeysSchema,
    },
    async ({ ctx, params }) => ({ removed: await removeRequesterPasskeys(ctx, params.id) }),
  );
}
