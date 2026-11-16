/**
 * Single sign-on with OpenID Connect: the authorization code flow with PKCE, state and nonce,
 * through openid-client (see docs/architecture.md, D16).
 *
 * - The provider is found by discovery, and its issuer must be the one configured.
 * - The ID token is checked in full: its signature against the provider's keys (JWKS), its
 *   issuer, audience, expiry and nonce. openid-client leaves the signature to TLS by default for
 *   tokens from the token endpoint; a4a asks for it too (`enableNonRepudiationChecks`).
 * - The redirect URI is the configured one, sent the same both times; nothing from the request
 *   chooses it.
 * - A state is bound to the browser that started (a cookie) and used once (its row is taken).
 * - People are found by the provider's subject; the first time, by a verified email only, and
 *   only an account whose own email an administrator set or a provider verified.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { SignIn } from '@a4a/shared';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import * as oidc from 'openid-client';
import type { AppServices } from '../context';
import type { OidcConfig } from '../config';
import type { Db } from '../db/client';
import { authStates, userIdentities, users } from '../db/schema';
import { sha256 } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { newId } from '../lib/ids';
import { accessChanged } from './access';
import { startSession } from './auth';
import { providerGroupNames, syncProviderGroups } from './groups';
import type { UserRow } from './schema-cache';
import { insertUser } from './users';

/** How long someone has between leaving for the provider and coming back. */
export const SSO_STATE_TTL_MS = 10 * 60_000;
export const SSO_STATE_COOKIE = 'a4a_sso';

/** Why a sign-in didn't work, as a code the sign-in page turns into words. */
export type SsoFailure = 'cancelled' | 'expired' | 'failed' | 'unverified' | 'domain' | 'no_account' | 'unconfirmed' | 'ambiguous' | 'refused' | 'unlinked';

export class SsoError extends AppError {
  constructor(
    readonly failure: SsoFailure,
    message: string,
  ) {
    super(failure === 'failed' ? 502 : 403, `sso_${failure}`, message);
  }
}

const configurations = new WeakMap<OidcConfig, Promise<oidc.Configuration>>();

function loopback(url: URL): boolean {
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/** The provider, discovered once (and again after a failure, so a provider that was down is found later). */
export function providerConfiguration(cfg: OidcConfig): Promise<oidc.Configuration> {
  const hit = configurations.get(cfg);
  if (hit) return hit;
  const issuer = new URL(cfg.issuer);
  const execute: ((c: oidc.Configuration) => void)[] = [oidc.enableNonRepudiationChecks];
  // Plain http only for a provider on this machine (development and tests); config refuses it otherwise.
  if (loopback(issuer)) execute.push(oidc.allowInsecureRequests);
  const found = oidc.discovery(issuer, cfg.clientId, cfg.clientSecret ?? undefined, cfg.clientSecret ? oidc.ClientSecretBasic(cfg.clientSecret) : oidc.None(), {
    execute,
    timeout: 10,
  });
  configurations.set(cfg, found);
  found.catch(() => {
    if (configurations.get(cfg) === found) configurations.delete(cfg);
  });
  return found;
}

/** Only a path on this site, so a sign-in can't be made to send someone elsewhere. */
export function safeReturnTo(raw: string | undefined | null): string {
  const v = (raw ?? '').trim();
  if (!v.startsWith('/') || v.startsWith('//') || v.includes('\\') || /[\u0000-\u001f]/.test(v) || v.startsWith('/api/')) return '/issues';
  return v.slice(0, 500);
}

function sameText(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

/** Begin: remember what the callback must check, and send the browser to the provider. */
export async function startSignIn(app: AppServices, returnTo: string | undefined): Promise<{ url: string; state: string }> {
  const cfg = app.config.oidc;
  if (!cfg) throw new SsoError('refused', 'Single sign-on is not set up on this server');
  const configuration = await providerConfiguration(cfg).catch((e: unknown) => {
    console.error(`sso: discovery of ${cfg.issuer} failed: ${e instanceof Error ? e.message : String(e)}`);
    throw new SsoError('failed', `${cfg.name} can't be reached just now. Try again in a moment.`);
  });
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const now = Date.now();
  await app.db.delete(authStates).where(lt(authStates.expiresAt, new Date(now)));
  await app.db.insert(authStates).values({
    id: sha256(state),
    codeVerifier,
    nonce,
    returnTo: safeReturnTo(returnTo),
    expiresAt: new Date(now + SSO_STATE_TTL_MS),
  });
  const url = oidc.buildAuthorizationUrl(configuration, {
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes,
    response_type: 'code',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return { url: url.href, state };
}

export interface SignedIn {
  user: UserRow;
  token: string;
  expiresAt: Date;
  returnTo: string;
}

/**
 * The provider sent the browser back. Check everything, find or make the person, and start a
 * new session. `query` is the callback's query string as received; `browserState` is the cookie.
 */
export async function finishSignIn(app: AppServices, query: URLSearchParams, browserState: string | undefined, userAgent?: string): Promise<SignedIn> {
  const cfg = app.config.oidc;
  if (!cfg) throw new SsoError('refused', 'Single sign-on is not set up on this server');
  const state = query.get('state') ?? '';
  if (query.get('error')) {
    // Still take the state, so it can't be used after this.
    if (state) await app.db.delete(authStates).where(eq(authStates.id, sha256(state)));
    const cancelled = query.get('error') === 'access_denied';
    throw new SsoError(cancelled ? 'cancelled' : 'failed', cancelled ? `Signing in with ${cfg.name} was cancelled` : `${cfg.name} didn't sign you in`);
  }
  // The state must be the one this browser was given when it left, and is good once.
  if (!state || !browserState || !sameText(state, browserState)) {
    throw new SsoError('expired', 'This sign-in was started in another browser or tab, or has run out of time');
  }
  const [pending] = await app.db.delete(authStates).where(eq(authStates.id, sha256(state))).returning();
  if (!pending || pending.expiresAt.getTime() < Date.now()) {
    throw new SsoError('expired', 'This sign-in has already been used, or has run out of time');
  }
  const configuration = await providerConfiguration(cfg).catch(() => {
    throw new SsoError('failed', `${cfg.name} can't be reached just now`);
  });
  // The URL the provider sent the browser to, as the provider knows it: the configured redirect
  // URI with the query it added (never the Host this request arrived with, which a proxy changes).
  // openid-client sends it to the token endpoint without the query: the very redirect_uri sent at the start.
  const current = new URL(cfg.redirectUri);
  current.search = query.toString();
  let claims: oidc.IDToken | undefined;
  try {
    const tokens = await oidc.authorizationCodeGrant(
      configuration,
      current,
      { pkceCodeVerifier: pending.codeVerifier, expectedState: state, expectedNonce: pending.nonce, idTokenExpected: true },
    );
    claims = tokens.claims();
  } catch (e) {
    console.warn(`sso: a sign-in with ${cfg.name} was refused: ${e instanceof Error ? e.message : String(e)}`);
    throw new SsoError('failed', `${cfg.name} didn't confirm who you are`);
  }
  if (!claims?.sub) throw new SsoError('failed', `${cfg.name} didn't say who you are`);
  const user = await personFor(app, cfg, claims);
  const session = await startSession(app.db, user.id, app.config.sessionTtlDays, userAgent);
  return { user, ...session, returnTo: pending.returnTo };
}

function claimText(claims: oidc.IDToken, name: string): string | null {
  const v = claims[name];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** The person an OpenID Connect provider vouches for; and, when configured, the provider's groups they're in. */
async function personFor(app: AppServices, cfg: OidcConfig, claims: oidc.IDToken): Promise<UserRow> {
  const email = claimText(claims, 'email')?.toLowerCase() ?? null;
  const user = await personFromProvider(
    app,
    { key: cfg.issuer, name: cfg.name, allowedDomains: cfg.allowedDomains, createUsers: cfg.createUsers, createWithUnverifiedEmail: false },
    {
      subject: claims.sub,
      email,
      // Only a provider's own "verified" counts; a string or a missing claim does not. Microsoft
      // Entra ID never sends email_verified: its word is the optional claim xms_edov, that the
      // email's domain is one the tenant has verified (D16).
      emailVerified: email !== null && (claims.email_verified === true || claims.xms_edov === true),
      login: claimText(claims, 'preferred_username') ?? (email ? email.slice(0, email.indexOf('@')) : null),
      name: claimText(claims, 'name') ?? ([claimText(claims, 'given_name'), claimText(claims, 'family_name')].filter(Boolean).join(' ') || email),
    },
  );
  if (cfg.groupsClaim) await syncProviderGroups(app, user.id, providerGroupNames(claims[cfg.groupsClaim]));
  return user;
}

/** What an identity provider says about who signed in, whichever protocol it speaks. */
export interface Vouched {
  /** Who they are at the provider: OIDC's `sub`, SAML's NameID. */
  subject: string;
  /** Lower-cased. */
  email: string | null;
  /** The provider vouches for the email: OIDC's `email_verified`, or SAML when SAML_TRUST_EMAIL is on. */
  emailVerified: boolean;
  /** A login to try for a new account. */
  login: string | null;
  name: string | null;
}

/** How a4a treats the people one provider vouches for. */
export interface ProviderPolicy {
  /** What its identities are kept under: the OIDC issuer, or "saml:" and the provider's entity id. */
  key: string;
  name: string;
  allowedDomains: string[];
  createUsers: boolean;
  /**
   * Whether someone new gets an account when the provider doesn't vouch for their email (it stays
   * unconfirmed). OIDC: no. SAML, which has no email_verified: yes, since its NameID links them.
   */
  createWithUnverifiedEmail: boolean;
}

/**
 * Find the person a provider vouches for, link them the first time, or give them an account (D16,
 * D27): by the provider's subject; the first time, by an email the provider vouches for, and only
 * to an account whose own email an administrator set or a provider verified.
 */
export async function personFromProvider(app: AppServices, p: ProviderPolicy, who: Vouched, retry = true): Promise<UserRow> {
  const { email, emailVerified: verified } = who;
  if (p.allowedDomains.length) {
    if (!verified || !email) throw new SsoError('unverified', `${p.name} hasn't verified your email, so a4a can't tell whether you may sign in`);
    const domain = email.slice(email.lastIndexOf('@') + 1);
    if (!p.allowedDomains.includes(domain)) throw new SsoError('domain', `Accounts at ${domain} can't sign in here`);
  }

  const [link] = await app.db
    .select()
    .from(userIdentities)
    .where(and(eq(userIdentities.provider, p.key), eq(userIdentities.subject, who.subject)));
  if (link) {
    const [user] = await app.db.select().from(users).where(eq(users.id, link.userId));
    if (!user || user.banned || user.isBot) throw new SsoError('refused', 'This account can’t sign in');
    await app.db.update(userIdentities).set({ lastSignInAt: new Date(), email }).where(eq(userIdentities.id, link.id));
    return user;
  }

  if (!verified && !p.createWithUnverifiedEmail) throw new SsoError('unverified', `${p.name} hasn't verified your email, so a4a can't find your account by it`);
  const matches = email ? await app.db.select().from(users).where(sql`lower(${users.email}) = ${email}`) : [];
  try {
    if (verified && matches.length > 1) throw new SsoError('ambiguous', 'More than one account has your email');
    if (verified && matches.length === 1) {
      const user = matches[0]!;
      if (user.banned || user.isBot) throw new SsoError('refused', 'This account can’t sign in');
      // An email someone typed for themselves proves nothing: link only one an administrator
      // set, or a provider verified.
      if (!user.emailVerified) throw new SsoError('unconfirmed', 'An account has your email, but an administrator hasn’t confirmed it');
      // One account at the provider per person: a second one with the same email (a reused
      // address, say) doesn't take over the account the first one signs in to.
      const [other] = await app.db
        .select({ id: userIdentities.id })
        .from(userIdentities)
        .where(and(eq(userIdentities.userId, user.id), eq(userIdentities.provider, p.key)));
      if (other) throw new SsoError('refused', `The account with your email signs in with another ${p.name} account`);
      await app.db.insert(userIdentities).values({ id: newId(), provider: p.key, subject: who.subject, userId: user.id, email, lastSignInAt: new Date() });
      return user;
    }
    // An email the provider doesn't vouch for links nothing, and gives nobody a second account with it.
    if (!verified && matches.length) {
      throw new SsoError('unlinked', `${p.name} doesn't vouch for your email, and an a4a account already has it`);
    }
    if (!p.createUsers) throw new SsoError('no_account', `There's no a4a account for ${email ?? 'you'}`);
    const created = await app.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      // One person's first sign-ins at once (two tabs, a double click) take turns here: the
      // first makes the account, and the next finds it linked.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`a4a:sso:${p.key}|${who.subject}`}))`);
      const [linked] = await tx
        .select({ user: users })
        .from(userIdentities)
        .innerJoin(users, eq(users.id, userIdentities.userId))
        .where(and(eq(userIdentities.provider, p.key), eq(userIdentities.subject, who.subject)));
      if (linked) {
        if (linked.user.banned || linked.user.isBot) throw new SsoError('refused', 'This account can’t sign in');
        return linked.user;
      }
      const login = await freeLogin(tx, who.login ?? (email ? email.slice(0, email.indexOf('@')) : 'user'));
      const name = who.name ?? email ?? login;
      const user = await insertUser(tx, { login, name: name.slice(0, 100), email, role: 'member' });
      if (verified) await tx.update(users).set({ emailVerified: true }).where(eq(users.id, user.id));
      await tx.insert(userIdentities).values({ id: newId(), provider: p.key, subject: who.subject, userId: user.id, email, lastSignInAt: new Date() });
      return { ...user, emailVerified: verified };
    });
    app.schema.invalidate();
    accessChanged(app);
    return created;
  } catch (e) {
    // Two first sign-ins at once: the other one linked or made the account, or took the
    // login this one chose (someone else, at the same moment). Look again, once.
    const pgCode = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
    if (retry && (pgCode === '23505' || pgCode === 'login_taken')) return personFromProvider(app, p, who, false);
    throw e;
  }
}

/** A login like theirs that nobody has: "anna", or "anna2" and on. */
async function freeLogin(db: Db, wanted: string): Promise<string> {
  const base = (wanted.normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '').replace(/^[._-]+/, '').slice(0, 36) || 'user').toLowerCase();
  const padded = base.length >= 2 ? base : `${base}user`;
  const taken = new Set(
    (await db.select({ login: users.login }).from(users).where(sql`lower(${users.login}) LIKE ${`${padded}%`}`)).map((r) => r.login.toLowerCase()),
  );
  if (!taken.has(padded)) return padded;
  for (let n = 2; n < 10_000; n++) if (!taken.has(`${padded}${n}`)) return `${padded}${n}`;
  return `${padded}-${newId(6).toLowerCase()}`;
}

/** How each person signs in, for administrators. */
export async function signInsOf(app: AppServices, db: Db, people: UserRow[]): Promise<Map<string, SignIn>> {
  const out = new Map<string, SignIn>();
  const links = people.length ? await db.select().from(userIdentities).where(inArray(userIdentities.userId, people.map((u) => u.id))) : [];
  const providerName = (issuer: string) => {
    if (app.config.oidc?.issuer === issuer) return app.config.oidc.name;
    // SAML identities are kept under "saml:" and the provider's entity id.
    if (issuer.startsWith('saml:')) return app.config.saml?.name ?? 'SAML';
    try {
      return new URL(issuer).hostname;
    } catch {
      return issuer;
    }
  };
  for (const u of people) {
    out.set(u.id, {
      password: Boolean(u.passwordHash),
      emailConfirmed: Boolean(u.email) && u.emailVerified,
      identities: links
        .filter((l) => l.userId === u.id)
        .map((l) => ({ provider: providerName(l.provider), email: l.email, linkedAt: l.createdAt.toISOString(), lastSignInAt: l.lastSignInAt?.toISOString() ?? null })),
    });
  }
  return out;
}
