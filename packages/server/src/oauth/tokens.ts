/**
 * The token endpoint and revocation (D28). A code becomes an access token and a refresh token,
 * once; a refresh token becomes the next pair, once. Every token since one code is a family: a
 * code or refresh token that comes back a second time means someone else has it, so the whole
 * family is revoked (RFC 6749 4.1.2, and RFC 9700's refresh token rotation). Tokens are kept as
 * SHA-256 hashes, as API tokens are, and an access token works at this server's /mcp alone.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { OAUTH_SCOPES, type OAuthScope } from '@a4a/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { effectiveScopes, type Actor, type AppServices } from '../context';
import type { Db } from '../db/client';
import { oauthClients, oauthCodes, oauthGrants, oauthTokens, users } from '../db/schema';
import { randomToken, sha256 } from '../lib/crypto';
import { newId } from '../lib/ids';
import { refreshes, type ClientRow } from './clients';
import { ACCESS_PREFIX, ACCESS_TTL_S, OAuthError, oauthOn, oauthUrls, REFRESH_PREFIX, REFRESH_TTL_MS, resourceMatches } from './common';

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

/** PKCE's S256: the verifier hashes to the challenge (compared in constant time). */
function pkceHolds(verifier: string, challenge: string): boolean {
  const made = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const want = Buffer.from(challenge);
  return made.length === want.length && timingSafeEqual(made, want);
}

/** Every token of a family, revoked at once. */
export async function revokeFamily(db: Db, familyId: string): Promise<void> {
  await db.update(oauthTokens).set({ revokedAt: new Date() }).where(and(eq(oauthTokens.familyId, familyId), isNull(oauthTokens.revokedAt)));
}

const clientLabel = (client: ClientRow) => client.name ?? `app ${client.id.slice(8, 14)}`;

async function appOf(app: AppServices, clientId: string | undefined): Promise<ClientRow> {
  if (!clientId) throw new OAuthError('invalid_client', 'Say which app you are: client_id', 401);
  const [client] = await app.db.select().from(oauthClients).where(eq(oauthClients.id, clientId));
  if (!client) throw new OAuthError('invalid_client', 'This app isn’t registered with a4a; register it again', 401);
  return client;
}

/** The live grant a token or code belongs to, if it is this app's and its person may still sign in. */
async function grantFor(app: AppServices, grantId: string, client: ClientRow) {
  const [row] = await app.db
    .select({ grant: oauthGrants, user: users })
    .from(oauthGrants)
    .innerJoin(users, eq(users.id, oauthGrants.userId))
    .where(and(eq(oauthGrants.id, grantId), isNull(oauthGrants.revokedAt)));
  if (!row || row.grant.clientId !== client.id) throw new OAuthError('invalid_grant', 'This isn’t this app’s, or it was revoked');
  if (row.user.banned) throw new OAuthError('invalid_grant', 'The person who allowed this app can’t sign in any more');
  return row.grant;
}

async function issue(app: AppServices, client: ClientRow, grantId: string, familyId: string, scopes: OAuthScope[]): Promise<TokenResponse> {
  const access = randomToken(ACCESS_PREFIX, 32);
  const refresh = refreshes(client) ? randomToken(REFRESH_PREFIX, 32) : null;
  const now = Date.now();
  const resource = oauthUrls(app.config).resource;
  await app.db.insert(oauthTokens).values([
    { id: sha256(access), kind: 'access', grantId, familyId, resource, scopes, expiresAt: new Date(now + ACCESS_TTL_S * 1000) },
    ...(refresh ? [{ id: sha256(refresh), kind: 'refresh', grantId, familyId, resource, scopes, expiresAt: new Date(now + REFRESH_TTL_MS) }] : []),
  ]);
  const at = new Date(now);
  await app.db.update(oauthGrants).set({ lastUsedAt: at }).where(eq(oauthGrants.id, grantId));
  await app.db.update(oauthClients).set({ lastUsedAt: at }).where(eq(oauthClients.id, client.id));
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, ...(refresh ? { refresh_token: refresh } : {}), scope: scopes.join(' ') };
}

function checkResource(app: AppServices, resource: string | undefined) {
  if (resource !== undefined && !resourceMatches(oauthUrls(app.config), resource)) {
    throw new OAuthError('invalid_target', `a4a gives tokens for its MCP server, ${oauthUrls(app.config).resource}, only`);
  }
}

async function fromCode(app: AppServices, client: ClientRow, form: Record<string, string>): Promise<TokenResponse> {
  const code = form.code;
  const verifier = form.code_verifier;
  if (!code) throw new OAuthError('invalid_request', 'Send the code the browser brought back: code');
  if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthError('invalid_request', 'Send the PKCE verifier: code_verifier, 43 to 128 characters');
  checkResource(app, form.resource);
  // Claimed in one statement, so a code works once, on any instance. A claim that fails a check
  // below still uses it up: the app starts again, and nobody gets a second try with it.
  const familyId = newId();
  const [row] = await app.db
    .update(oauthCodes)
    .set({ usedAt: new Date(), familyId })
    .where(and(eq(oauthCodes.id, sha256(code)), isNull(oauthCodes.usedAt)))
    .returning();
  if (!row) {
    const [used] = await app.db.select().from(oauthCodes).where(eq(oauthCodes.id, sha256(code)));
    if (used?.familyId) await revokeFamily(app.db, used.familyId);
    throw new OAuthError('invalid_grant', 'The code is unknown, or was used already');
  }
  if (row.expiresAt < new Date()) throw new OAuthError('invalid_grant', 'The code expired: exchange it within two minutes');
  const grant = await grantFor(app, row.grantId, client);
  if (form.redirect_uri !== undefined && form.redirect_uri !== row.redirectUri) {
    throw new OAuthError('invalid_grant', 'redirect_uri isn’t the one the code was sent to');
  }
  if (!pkceHolds(verifier, row.codeChallenge)) throw new OAuthError('invalid_grant', 'code_verifier doesn’t match the code’s challenge');
  return issue(app, client, grant.id, familyId, row.scopes as OAuthScope[]);
}

async function fromRefresh(app: AppServices, client: ClientRow, form: Record<string, string>): Promise<TokenResponse> {
  const token = form.refresh_token;
  if (!token) throw new OAuthError('invalid_request', 'Send the refresh token: refresh_token');
  checkResource(app, form.resource);
  const id = sha256(token);
  const [row] = await app.db
    .update(oauthTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(oauthTokens.id, id), eq(oauthTokens.kind, 'refresh'), isNull(oauthTokens.usedAt), isNull(oauthTokens.revokedAt)))
    .returning();
  if (!row) {
    const [seen] = await app.db.select().from(oauthTokens).where(and(eq(oauthTokens.id, id), eq(oauthTokens.kind, 'refresh')));
    if (seen?.usedAt && !seen.revokedAt) {
      // A refresh token used twice: one of the two holders isn't the app. Neither keeps anything.
      await revokeFamily(app.db, seen.familyId);
      throw new OAuthError('invalid_grant', 'This refresh token was used already, so every token from it is revoked: sign in again');
    }
    throw new OAuthError('invalid_grant', 'The refresh token is unknown, or revoked');
  }
  if (row.expiresAt < new Date()) throw new OAuthError('invalid_grant', 'The refresh token expired: sign in again');
  const grant = await grantFor(app, row.grantId, client);
  // A refresh may ask for less than the token had, never more (RFC 6749 6).
  let scopes = row.scopes as OAuthScope[];
  if (form.scope) {
    const asked = form.scope.split(/\s+/).filter(Boolean);
    if (asked.some((s) => !scopes.includes(s as OAuthScope))) throw new OAuthError('invalid_scope', `This token can have ${scopes.join(' and ')} at most`);
    scopes = asked.includes('write') ? ['read', 'write'] : ['read'];
  }
  return issue(app, client, grant.id, row.familyId, scopes);
}

/** POST /oauth/token: a code or a refresh token for tokens. The app is a public client, known by its id alone. */
export async function tokenRequest(app: AppServices, form: Record<string, string>, basicId: string | null): Promise<TokenResponse> {
  if (!oauthOn(app.config)) throw new OAuthError('unsupported_grant_type', 'This a4a doesn’t let apps sign in with OAuth');
  if (form.client_id && basicId && form.client_id !== basicId) throw new OAuthError('invalid_request', 'Say which app you are once: client_id and Basic disagree');
  const client = await appOf(app, form.client_id || basicId || undefined);
  if (form.grant_type === 'authorization_code') return fromCode(app, client, form);
  if (form.grant_type === 'refresh_token') {
    if (!refreshes(client)) throw new OAuthError('unauthorized_client', 'This app registered without refresh_token');
    return fromRefresh(app, client, form);
  }
  throw new OAuthError('unsupported_grant_type', 'a4a takes grant_type authorization_code or refresh_token');
}

/**
 * POST /oauth/revoke (RFC 7009): a refresh token revokes its family, an access token itself. An
 * unknown token, or another app's, is answered as revoked, as the RFC asks: nothing is said of it.
 */
export async function revokeRequest(app: AppServices, form: Record<string, string>, basicId: string | null): Promise<void> {
  if (!form.token) throw new OAuthError('invalid_request', 'Send the token to revoke: token');
  const client = await appOf(app, form.client_id || basicId || undefined);
  const [row] = await app.db
    .select({ token: oauthTokens, clientId: oauthGrants.clientId })
    .from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
    .where(eq(oauthTokens.id, sha256(form.token)));
  if (!row || row.clientId !== client.id) return;
  if (row.token.kind === 'refresh') await revokeFamily(app.db, row.token.familyId);
  else await app.db.update(oauthTokens).set({ revokedAt: new Date() }).where(eq(oauthTokens.id, row.token.id));
}

/** Per instance on purpose, as for API tokens: it only spares the database a write per request. */
const lastUsedWrites = new Map<string, number>();

/**
 * Who an access token acts for, at /mcp: its person, with what they allowed the app, never beyond
 * their role, and only in the projects they chose. Null for a token that is unknown, expired,
 * revoked, for another resource, or whose person was banned.
 */
export async function actorFromOAuthToken(app: AppServices, bearer: string): Promise<Actor | null> {
  if (!bearer.startsWith(ACCESS_PREFIX) || !oauthOn(app.config)) return null;
  const [row] = await app.db
    .select({ token: oauthTokens, grant: oauthGrants, client: oauthClients, user: users })
    .from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
    .innerJoin(users, eq(users.id, oauthGrants.userId))
    .where(and(eq(oauthTokens.id, sha256(bearer)), eq(oauthTokens.kind, 'access'), isNull(oauthTokens.revokedAt), isNull(oauthGrants.revokedAt)));
  if (!row || row.user.banned || row.token.expiresAt < new Date()) return null;
  if (row.token.resource !== oauthUrls(app.config).resource) return null;
  const now = Date.now();
  if ((lastUsedWrites.get(row.grant.id) ?? 0) < now - 60_000) {
    lastUsedWrites.set(row.grant.id, now);
    const at = new Date(now);
    void app.db
      .update(oauthGrants)
      .set({ lastUsedAt: at })
      .where(eq(oauthGrants.id, row.grant.id))
      .then(() => app.db.update(oauthClients).set({ lastUsedAt: at }).where(eq(oauthClients.id, row.client.id)))
      .catch(() => {});
  }
  // What the app was given, as the person allows it now: a grant narrowed since narrows its tokens.
  const granted = row.token.scopes.filter((s) => row.grant.scopes.includes(s) && (OAUTH_SCOPES as readonly string[]).includes(s));
  return {
    user: row.user,
    scopes: effectiveScopes(row.user.role, granted),
    channel: 'mcp',
    tokenId: `oauth:${row.grant.id}`,
    tokenName: clientLabel(row.client),
    authMethod: 'token',
    projectIds: row.grant.projectIds ?? null,
  };
}
