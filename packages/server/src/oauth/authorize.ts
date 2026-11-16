/**
 * The authorization endpoint, as a4a's consent page asks it (D28). The page is the web app's, at
 * /oauth/authorize: it signs the person in if they aren't, asks this module whether the request
 * holds, shows who asks and for what, and sends the person's decision back. The answer is a code
 * for the app, at the address it registered, and nowhere else.
 */
import type { OAuthAuthorization, OAuthDecision, OAuthRequest, OAuthScope } from '@a4a/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { scopesForRole, type AppServices, type Ctx } from '../context';
import { oauthClients, oauthCodes, oauthGrants } from '../db/schema';
import { randomToken, sha256 } from '../lib/crypto';
import { AppError, badRequest, forbidden } from '../lib/errors';
import { newId } from '../lib/ids';
import { projectAccess, requireProject } from '../services/access';
import { findClient, isDocumentId } from './client-documents';
import { isLoopback, matchRedirect, type ClientRow } from './clients';
import { askedScopes, clip, CODE_PREFIX, CODE_TTL_MS, OAuthError, oauthOn, oauthUrls, REMEMBER_MS, resourceMatches } from './common';

export type GrantRow = typeof oauthGrants.$inferSelect;

type Checked =
  | { ok: false; error: string; message: string; hint?: string; redirect: string | null }
  | { ok: true; client: ClientRow; redirectUri: string; challenge: string; asked: OAuthScope[] };

/** The redirect URI with the answer added to its query, keeping what it had there. */
function answer(redirectUri: string, params: Record<string, string | undefined>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * Whether a request holds. Until the app and the address it goes back to are known to be its own,
 * an error is shown on a4a's page and sent nowhere: an address the app didn't register could be
 * anyone's (an open redirect). After that, errors go back to the app, as OAuth says.
 */
async function check(app: AppServices, req: OAuthRequest): Promise<Checked> {
  const fatal = (error: string, message: string, hint?: string): Checked => ({ ok: false, error, message, hint, redirect: null });
  if (!oauthOn(app.config)) {
    return fatal('temporarily_unavailable', 'This a4a doesn’t let apps sign in with OAuth', 'Connect the app with an API token, from Agents and tokens.');
  }
  const clientId = req.client_id?.trim();
  if (!clientId) return fatal('invalid_request', 'The app didn’t say which app it is (client_id)', 'Start connecting again, from the app.');
  // An app that registered, or one whose client_id is its metadata document's address (D38).
  let client: ClientRow | null;
  try {
    client = await findClient(app, clientId, { read: true });
  } catch (e) {
    if (e instanceof OAuthError) return fatal('invalid_client', e.message, 'The app’s maker can fix its metadata document; meanwhile, connect it with an API token, from Agents and tokens.');
    throw e;
  }
  if (!client) {
    return fatal(
      'invalid_client',
      'This app isn’t registered with a4a, or its registration was removed after going unused',
      'Start connecting again, from the app: it registers itself anew.',
    );
  }
  const asked = req.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : undefined);
  if (!asked) return fatal('invalid_request', 'The app didn’t say where to send you back (redirect_uri)', 'Start connecting again, from the app.');
  const redirectUri = matchRedirect(client.redirectUris, asked);
  if (!redirectUri) {
    return fatal(
      'invalid_request',
      'The app asked to send you back to an address it didn’t register',
      `a4a sends an app its answer only at an address the app registered, and ${clip(asked)} isn’t one. Start connecting again, from the app.`,
    );
  }
  const issuer = oauthUrls(app.config).issuer;
  const back = (error: string, message: string): Checked => ({
    ok: false,
    error,
    message,
    redirect: answer(redirectUri, { error, error_description: message, state: req.state, iss: issuer }),
  });
  if (req.response_type !== 'code') return back('unsupported_response_type', 'a4a answers with an authorization code only: response_type=code');
  if (!req.code_challenge || req.code_challenge_method !== 'S256') {
    return back('invalid_request', 'PKCE is required, with S256: send code_challenge and code_challenge_method=S256');
  }
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(req.code_challenge)) {
    return back('invalid_request', 'code_challenge isn’t a PKCE challenge: 43 to 128 characters of letters, digits and - . _ ~');
  }
  if (req.resource !== undefined && !resourceMatches(oauthUrls(app.config), req.resource)) {
    return back('invalid_target', `a4a gives tokens for its MCP server, ${oauthUrls(app.config).resource}, and not for ${clip(req.resource)}`);
  }
  return { ok: true, client, redirectUri, challenge: req.code_challenge, asked: askedScopes(req.scope) };
}

/** Only a person, signed in on a4a's own page, allows an app: never a token, nor another app. */
function requireSession(ctx: Ctx) {
  if (ctx.actor.authMethod !== 'session') {
    throw forbidden('Only a person signed in to a4a can allow an app', 'Open the link the app gave you in your browser.');
  }
}

async function liveGrant(ctx: Ctx, clientId: string): Promise<GrantRow | undefined> {
  const [g] = await ctx.db
    .select()
    .from(oauthGrants)
    .where(and(eq(oauthGrants.clientId, clientId), eq(oauthGrants.userId, ctx.actor.user.id), isNull(oauthGrants.revokedAt)));
  return g;
}

const canWrite = (ctx: Ctx) => scopesForRole(ctx.actor.user.role).includes('write');

/** A grant's projects by key, as the person sees them now: one gone out of sight is left out. */
async function keysOf(ctx: Ctx, ids: string[] | null): Promise<string[] | null> {
  if (!ids) return null;
  const view = await projectAccess(ctx);
  return ids.filter((id) => view.canRead(id)).map((id) => view.keyOf(id)!);
}

/** What the consent page shows: who asks, for what, and whether the person decided this before. */
export async function checkAuthorization(ctx: Ctx, req: OAuthRequest): Promise<OAuthAuthorization> {
  requireSession(ctx);
  const c = await check(ctx.app, req);
  if (!c.ok) return c;
  const grant = await liveGrant(ctx, c.client.id);
  const remembered = grant ? { scopes: grant.scopes as OAuthScope[], projects: await keysOf(ctx, grant.projectIds) } : null;
  const recent = grant ? Date.now() - (grant.lastUsedAt ?? grant.updatedAt).getTime() < REMEMBER_MS : false;
  // Remembered: the app asks for nothing it didn't ask before, and the projects allowed are still there.
  const ready = Boolean(grant && recent && c.asked.every((s) => grant.asked.includes(s)) && (remembered?.projects === null || remembered!.projects!.length > 0));
  const target = new URL(c.redirectUri);
  return {
    ok: true,
    client: {
      id: c.client.id,
      name: c.client.name,
      redirectUri: c.redirectUri,
      redirectHost: target.host,
      documentHost: isDocumentId(c.client.id) ? new URL(c.client.id).host : null,
      local: isLoopback(target),
      registeredAt: c.client.createdAt.toISOString(),
    },
    asked: c.asked,
    canWrite: canWrite(ctx),
    remembered,
    ready,
  };
}

/** Project keys to ids: each one the person can see (one they can't is "not found", as a missing one). */
async function projectIds(ctx: Ctx, keys: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const key of keys) ids.push((await requireProject(ctx, key)).id);
  return [...new Set(ids)];
}

/** The live grant, made or changed as decided. Two decisions at once agree on one row. */
async function saveGrant(ctx: Ctx, clientId: string, scopes: OAuthScope[], asked: OAuthScope[], ids: string[] | null): Promise<GrantRow> {
  const [row] = await ctx.db
    .insert(oauthGrants)
    .values({ id: newId(), clientId, userId: ctx.actor.user.id, scopes, asked, projectIds: ids })
    .onConflictDoUpdate({
      target: [oauthGrants.clientId, oauthGrants.userId],
      targetWhere: sql`${oauthGrants.revokedAt} IS NULL`,
      set: { scopes, asked, projectIds: ids, updatedAt: new Date() },
    })
    .returning();
  return row!;
}

/**
 * The person's decision. Declined: the app hears access_denied. Allowed: a grant with what they
 * chose, never more than the app asked for or their role allows, and a code for the app.
 */
export async function decideAuthorization(ctx: Ctx, decision: OAuthDecision): Promise<{ redirect: string }> {
  requireSession(ctx);
  const c = await check(ctx.app, decision.request);
  if (!c.ok) {
    if (c.redirect) return { redirect: c.redirect };
    throw new AppError(400, c.error, c.message, c.hint);
  }
  const issuer = oauthUrls(ctx.app.config).issuer;
  const back = (params: Record<string, string | undefined>) => ({ redirect: answer(c.redirectUri, { ...params, state: decision.request.state, iss: issuer }) });
  if (!decision.allow) return back({ error: 'access_denied', error_description: 'The person declined' });

  const write = (decision.scopes ?? []).includes('write') && c.asked.includes('write') && canWrite(ctx);
  const scopes: OAuthScope[] = write ? ['read', 'write'] : ['read'];
  const keys = decision.projects ?? null;
  const ids = keys === null ? null : await projectIds(ctx, keys);
  if (ids && !ids.length) throw badRequest('Choose at least one project, or every project', 'The app can’t do anything with no project.');
  const grant = await saveGrant(ctx, c.client.id, scopes, c.asked, ids);

  const code = randomToken(CODE_PREFIX, 32);
  await ctx.db.insert(oauthCodes).values({
    id: sha256(code),
    grantId: grant.id,
    redirectUri: c.redirectUri,
    codeChallenge: c.challenge,
    resource: oauthUrls(ctx.app.config).resource,
    scopes,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  await ctx.db.update(oauthClients).set({ lastUsedAt: new Date() }).where(eq(oauthClients.id, c.client.id));
  return back({ code });
}
