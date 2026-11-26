/**
 * People connecting their own accounts at GitHub, GitLab, Bitbucket (docs/architecture.md, D46), and
 * Forgejo or Gitea (D54), which are self-hosted: an administrator gives a4a the instance's address
 * beside its OAuth app, and it's one provider in a4a, `gitea`, as their webhooks are.
 *
 * D33 lets an administrator record a person's login at a provider. Here a person proves an account
 * is theirs instead, by signing in there: OAuth's authorization code (with PKCE where the provider
 * takes it), exchanged by the server with the provider app's secret, then the provider asked who the
 * token is. That account becomes their provider login, with the provider's own id for it, so their
 * commits and pull requests are theirs without anyone recording it. The token is used for that one
 * question and dropped: nothing a4a does later needs it.
 *
 * The state binds the round trip to the person who started it, as a hash, for ten minutes, once:
 * the callback must come back to the same signed-in person, so nobody can connect their own account
 * to someone else's a4a by sending them a link.
 *
 * Forgejo's and Gitea's tokens are narrowed where the instance lets a4a (D66): what the instance
 * advertises in its OpenID discovery document says whether it revokes (RFC 7009) and introspects
 * (RFC 7662). A token that says it reaches more than `read:user` is refused; one the instance can take
 * back is, as soon as it has been asked who you are; where it can't, the profile says so first.
 */
import { CODE_HOSTS, type CodeHost, type CodeHostInfo, type ProviderLogin } from '@a4a/shared';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import type { CodeHostApp } from '../config';
import { requireScope, type AppServices, type Ctx } from '../context';
import { providerLogins, providerLinkStates } from '../db/schema';
import { sha256 } from '../lib/crypto';
import { AppError, badRequest, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { loginKey } from './authors';
import { listProviderLogins } from './logins';

const TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 10_000;
export const CODE_HOST_NAMES: Record<CodeHost, string> = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket', gitea: 'Forgejo/Gitea' };
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const underTest = () => Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';

/** Why a connection didn't happen, for the profile page to say (`?connect=`). */
export class ConnectError extends Error {
  constructor(
    readonly failure: 'expired' | 'denied' | 'refused' | 'taken' | 'unreachable' | 'mismatch' | 'wide',
    message: string,
  ) {
    super(message);
  }
}

export function callbackUrl(app: AppServices, provider: CodeHost): string {
  return `${app.config.publicUrl}/api/v1/auth/code-hosts/${provider}/callback`;
}

function appFor(app: AppServices, provider: string): { provider: CodeHost; host: CodeHostApp } {
  if (!(CODE_HOSTS as readonly string[]).includes(provider)) throw notFound(`Code host ${provider}`, `a4a connects accounts at ${CODE_HOSTS.join(', ')}.`).said('vcs.unknownCodeHost', { host: provider, hosts: [...CODE_HOSTS] });
  const host = app.config.codeHosts[provider as CodeHost];
  if (!host && provider === 'gitea') {
    throw badRequest('Connecting an account at Forgejo or Gitea isn’t set up here', 'An administrator gives a4a its address and an OAuth app there (FORGEJO_URL, FORGEJO_CLIENT_ID and _SECRET; or GITEA_*).').said('vcs.connectNotSetUpForge');
  }
  if (!host) throw badRequest(`Connecting an account at ${CODE_HOST_NAMES[provider as CodeHost]} isn't set up here`, `An administrator gives a4a an OAuth app there (${provider.toUpperCase()}_CLIENT_ID and _SECRET).`).said('vcs.connectNotSetUp', { host: CODE_HOST_NAMES[provider as CodeHost], prefix: provider.toUpperCase() });
  return { provider: provider as CodeHost, host };
}

/** Only https, from configuration; plain http to this machine in tests (VCS_ALLOW_HTTP_LOOPBACK). */
function checked(app: AppServices, raw: string): string {
  const url = new URL(raw);
  const loopback = url.protocol === 'http:' && LOOPBACK.has(url.hostname) && (underTest() || app.config.vcsAllowHttpLoopback);
  if (url.protocol !== 'https:' && !loopback) throw new ConnectError('unreachable', `${url.host} isn't https`);
  return url.href;
}

/** What people call a code host here: Forgejo or Gitea by which one an administrator set up. */
const nameOf = (app: AppServices, provider: CodeHost) => app.config.codeHosts[provider]?.name ?? CODE_HOST_NAMES[provider];

/** What an instance says it offers (OpenID Connect Discovery, RFC 8414's names): only addresses on its own origin. */
interface Offered {
  revocation: string | null;
  introspection: string | null;
}
const DISCOVERY_TTL_MS = 60 * 60_000;
const DISCOVERY_RETRY_MS = 5 * 60_000;
const offered = new Map<string, { at: Offered; until: number }>();
const Discovery = z.object({ revocation_endpoint: z.string().nullish(), introspection_endpoint: z.string().nullish() });

/**
 * Whether a Forgejo or Gitea revokes and introspects tokens, as its discovery document says
 * (`/.well-known/openid-configuration`): kept an hour, or five minutes when it didn't answer. An
 * address on another origin is taken as none, so the instance can't send a token elsewhere.
 */
export async function offeredBy(app: AppServices, host: CodeHostApp): Promise<Offered> {
  const web = host.webUrl.replace(/\/$/, '');
  const kept = offered.get(web);
  if (kept && kept.until > Date.now()) return kept.at;
  const origin = new URL(web).origin;
  const same = (v: string | null | undefined) => {
    if (!v) return null;
    try {
      return new URL(v).origin === origin ? new URL(v).href : null;
    } catch {
      return null;
    }
  };
  try {
    const d = Discovery.parse(await call(app, `${web}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } }));
    const at = { revocation: same(d.revocation_endpoint), introspection: same(d.introspection_endpoint) };
    offered.set(web, { at, until: Date.now() + DISCOVERY_TTL_MS });
    return at;
  } catch (e) {
    if (!(e instanceof ConnectError) && !(e instanceof z.ZodError)) throw e;
    const at = { revocation: null, introspection: null };
    offered.set(web, { at, until: Date.now() + DISCOVERY_RETRY_MS });
    return at;
  }
}

/** Forget what instances said they offer (tests). */
export function forgetOffered(): void {
  offered.clear();
}

export async function codeHosts(app: AppServices): Promise<CodeHostInfo[]> {
  return Promise.all(
    CODE_HOSTS.map(async (provider) => {
      const host = app.config.codeHosts[provider];
      // GitHub's, GitLab's and Bitbucket's tokens read who you are and nothing more: there's nothing to say.
      const revokes = provider === 'gitea' && host ? Boolean((await offeredBy(app, host)).revocation) : null;
      return { provider, name: nameOf(app, provider), available: Boolean(host), revokes };
    }),
  );
}

const b64url = (b: Buffer) => b.toString('base64url');

/** Start connecting: the provider's page to sign in at, with a state only this person's round trip carries. */
export async function startConnect(ctx: Ctx, provider: string): Promise<{ url: string }> {
  requireScope(ctx, 'write');
  if (ctx.actor.channel !== 'web') throw badRequest('Connect an account from your profile, signed in', 'It takes your browser, to sign in at the provider.').said('vcs.connectFromProfile');
  const { host, provider: p } = appFor(ctx.app, provider);
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  await ctx.db.delete(providerLinkStates).where(lt(providerLinkStates.expiresAt, new Date()));
  await ctx.db.insert(providerLinkStates).values({ stateHash: sha256(state), userId: ctx.actor.user.id, provider: p, verifier, expiresAt: new Date(Date.now() + TTL_MS) });
  const redirect = callbackUrl(ctx.app, p);
  const q = new URLSearchParams({ client_id: host.clientId, state });
  const web = checked(ctx.app, host.webUrl).replace(/\/$/, '');
  if (p === 'github') {
    q.set('redirect_uri', redirect);
    q.set('scope', 'read:user');
    q.set('allow_signup', 'false');
    q.set('code_challenge', challenge);
    q.set('code_challenge_method', 'S256');
    return { url: `${web}/login/oauth/authorize?${q}` };
  }
  if (p === 'gitlab') {
    q.set('redirect_uri', redirect);
    q.set('response_type', 'code');
    q.set('scope', 'read_user');
    q.set('code_challenge', challenge);
    q.set('code_challenge_method', 'S256');
    return { url: `${web}/oauth/authorize?${q}` };
  }
  if (p === 'gitea') {
    // Forgejo and Gitea: an authorization code with PKCE, as GitHub's. An instance that grants scopes
    // reads read:user as only reading who you are; one that doesn't grants the token its default.
    q.set('redirect_uri', redirect);
    q.set('response_type', 'code');
    q.set('scope', 'read:user');
    q.set('code_challenge', challenge);
    q.set('code_challenge_method', 'S256');
    return { url: `${web}/login/oauth/authorize?${q}` };
  }
  // Bitbucket Cloud's consumer has its callback set where it's made; it takes no PKCE.
  q.set('response_type', 'code');
  return { url: `${web}/site/oauth2/authorize?${q}` };
}

async function call(app: AppServices, url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(checked(app, url), { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    if (e instanceof ConnectError) throw e;
    throw new ConnectError('unreachable', `${new URL(url).host} couldn't be reached`);
  }
  const text = await res.text();
  if (!res.ok) throw new ConnectError('refused', `${new URL(url).host} answered ${res.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new ConnectError('refused', `${new URL(url).host} didn't answer in JSON`);
  }
}

const Token = z.object({ access_token: z.string().min(1) });
/** Forgejo's and Gitea's answer: the refresh token too, to take back, and what it says of the scope it granted. */
const ForgeToken = Token.extend({ refresh_token: z.string().nullish(), scope: z.string().nullish() });

interface Granted {
  token: string;
  refresh: string | null;
  scope: string | null;
}

/** The code for a token, with the app's secret: only to ask who it is. */
async function exchange(app: AppServices, provider: CodeHost, host: CodeHostApp, code: string, verifier: string, redirect: string): Promise<Granted> {
  const one = (token: string): Granted => ({ token, refresh: null, scope: null });
  const web = host.webUrl.replace(/\/$/, '');
  if (provider === 'github') {
    const got = await call(app, `${web}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: host.clientId, client_secret: host.clientSecret, code, redirect_uri: redirect, code_verifier: verifier }),
    });
    const parsed = Token.safeParse(got);
    if (!parsed.success) throw new ConnectError('refused', 'GitHub gave no token for the code');
    return one(parsed.data.access_token);
  }
  if (provider === 'gitlab' || provider === 'gitea') {
    const got = await call(app, provider === 'gitlab' ? `${web}/oauth/token` : `${web}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: host.clientId, client_secret: host.clientSecret, code, redirect_uri: redirect, code_verifier: verifier }),
    });
    const parsed = ForgeToken.safeParse(got);
    if (!parsed.success) throw new ConnectError('refused', `${host.name ?? CODE_HOST_NAMES[provider]} gave no token for the code`);
    return provider === 'gitea' ? { token: parsed.data.access_token, refresh: parsed.data.refresh_token ?? null, scope: parsed.data.scope ?? null } : one(parsed.data.access_token);
  }
  const got = await call(app, `${web}/site/oauth2/access_token`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${host.clientId}:${host.clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code }),
  });
  const parsed = Token.safeParse(got);
  if (!parsed.success) throw new ConnectError('refused', 'Bitbucket gave no token for the code');
  return one(parsed.data.access_token);
}

/** Scopes that reach no API: OpenID Connect's, which shape only the ID token and the user's info. */
const ASKED = new Set(['read:user', 'openid', 'profile', 'email', 'groups']);
const clientAuth = (host: CodeHostApp) => `Basic ${Buffer.from(`${encodeURIComponent(host.clientId)}:${encodeURIComponent(host.clientSecret)}`).toString('base64')}`;
const Introspected = z.object({ active: z.boolean(), scope: z.string().nullish() });

/**
 * Where the instance says what it granted (the token's answer, else its introspection, RFC 7662),
 * the token must reach no more than `read:user`; one that says more, or that the instance says isn't
 * active, is refused before it's used. Where it says nothing, the instance takes no scopes, and the
 * profile said what that means before the person went on.
 */
async function checkScope(app: AppServices, host: CodeHostApp, granted: Granted, at: Offered): Promise<void> {
  let scope = granted.scope;
  if (scope === null && at.introspection) {
    const got = Introspected.safeParse(
      await call(app, at.introspection, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', authorization: clientAuth(host) },
        body: new URLSearchParams({ token: granted.token, token_type_hint: 'access_token' }),
      }),
    );
    if (!got.success || !got.data.active) throw new ConnectError('refused', `${host.name ?? 'Forgejo'} says the token it gave isn't good`);
    scope = got.data.scope ?? null;
  }
  if (scope === null) return;
  const wider = scope.split(/[\s,]+/).filter((s) => s && !ASKED.has(s));
  if (wider.length) throw new ConnectError('wide', `${host.name ?? 'Forgejo'} gave a token that reaches more than reading who you are (${wider.join(' ')}), so a4a didn't use it`);
}

/**
 * Take the token back (RFC 7009), as soon as it has been used, where the instance offers it: the
 * refresh token first, which ends its grant's access tokens where the server does so, then the access
 * token. What goes wrong is logged without the token, and changes nothing the person sees: they were
 * told before they went on.
 */
async function takeBack(app: AppServices, host: CodeHostApp, granted: Granted, at: Offered): Promise<void> {
  if (!at.revocation) return;
  const tokens: [string, string][] = [...(granted.refresh ? [[granted.refresh, 'refresh_token'] as [string, string]] : []), [granted.token, 'access_token']];
  for (const [token, hint] of tokens) {
    try {
      await call(app, at.revocation, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', authorization: clientAuth(host) },
        body: new URLSearchParams({ token, token_type_hint: hint }),
      }).catch((e: unknown) => {
        // RFC 7009 answers 200 with an empty body: that's the token taken back.
        if (e instanceof ConnectError && /didn't answer in JSON/.test(e.message)) return null;
        throw e;
      });
    } catch (e) {
      console.warn(`connect: ${new URL(at.revocation).host} didn't take back a ${hint} (${e instanceof Error ? e.message : 'unknown'})`);
    }
  }
}

/** Who the token is, there: the provider's own id, and the login commits name them by. */
async function whoIs(app: AppServices, provider: CodeHost, host: CodeHostApp, token: string): Promise<{ id: string; login: string }> {
  const api = host.apiUrl.replace(/\/$/, '');
  const headers = { accept: 'application/json', authorization: `Bearer ${token}` };
  if (provider === 'github' || provider === 'gitea') {
    // Forgejo's and Gitea's GET /api/v1/user answers as GitHub's does: the account's id and login.
    const u = z.object({ id: z.number(), login: z.string().min(1) }).safeParse(await call(app, `${api}/user`, { headers }));
    if (!u.success) throw new ConnectError('refused', `${host.name ?? CODE_HOST_NAMES[provider]} didn't say who you are`);
    return { id: String(u.data.id), login: u.data.login };
  }
  if (provider === 'gitlab') {
    const u = z.object({ id: z.number(), username: z.string().min(1) }).safeParse(await call(app, `${api}/user`, { headers }));
    if (!u.success) throw new ConnectError('refused', "GitLab didn't say who you are");
    return { id: String(u.data.id), login: u.data.username };
  }
  // Bitbucket Cloud's nicknames aren't unique: its account id names a commit's author (D33).
  const u = z.object({ uuid: z.string().min(1), account_id: z.string().nullish() }).safeParse(await call(app, `${api}/2.0/user`, { headers }));
  if (!u.success) throw new ConnectError('refused', "Bitbucket didn't say who you are");
  return { id: u.data.uuid.replace(/^\{(.*)\}$/, '$1'), login: u.data.account_id || u.data.uuid };
}

/**
 * Back from the provider: the state checked against who's signed in, the code exchanged, and the
 * account they proved theirs recorded as their login there. Throws ConnectError with why.
 */
export async function finishConnect(app: AppServices, ctx: Ctx | null, provider: string, params: URLSearchParams): Promise<ProviderLogin> {
  const state = params.get('state') ?? '';
  const [row] = state ? await app.db.delete(providerLinkStates).where(eq(providerLinkStates.stateHash, sha256(state))).returning() : [];
  if (!row || row.expiresAt.getTime() < Date.now() || row.provider !== provider) throw new ConnectError('expired', 'The sign-in there took too long, or was started elsewhere: connect again.');
  if (!ctx || ctx.actor.user.id !== row.userId) throw new ConnectError('mismatch', 'It came back to someone other than who started it: connect again, signed in as yourself.');
  if (params.get('error')) throw new ConnectError('denied', 'You said no there, so nothing is connected.');
  const code = params.get('code');
  if (!code) throw new ConnectError('refused', 'The provider sent no code back.');
  const { host, provider: p } = appFor(app, provider);
  const granted = await exchange(app, p, host, code, row.verifier, callbackUrl(app, p));
  // Forgejo and Gitea (D66): no wider than asked, and taken back as soon as it's been used.
  const at = p === 'gitea' ? await offeredBy(app, host) : null;
  let who: { id: string; login: string };
  try {
    if (at) await checkScope(app, host, granted, at);
    who = await whoIs(app, p, host, granted.token);
  } finally {
    if (at) await takeBack(app, host, granted, at);
  }
  const matchKey = loginKey(p, who.login);
  const [taken] = await app.db.select().from(providerLogins).where(and(eq(providerLogins.provider, p), eq(providerLogins.matchKey, matchKey)));
  if (taken && taken.userId !== row.userId) throw new ConnectError('taken', `That ${nameOf(app, p)} account is someone else's in a4a: an administrator can move it.`);
  if (taken) {
    await app.db.update(providerLogins).set({ providerUserId: who.id, login: who.login }).where(eq(providerLogins.id, taken.id));
  } else {
    await app.db.insert(providerLogins).values({ id: newId(), userId: row.userId, provider: p, login: who.login, matchKey, addedById: row.userId, providerUserId: who.id });
  }
  const mine = await listProviderLogins(ctx, row.userId);
  const made = mine.find((l) => l.provider === p && loginKey(p, l.login) === matchKey);
  if (!made) throw new AppError(500, 'internal', 'The account was connected, and then not found').said('vcs.connectedThenGone');
  return made;
}
