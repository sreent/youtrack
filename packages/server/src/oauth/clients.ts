/**
 * Dynamic client registration (RFC 7591), for public clients only: an MCP client registers itself
 * and gets an id, never a secret, since an app on someone's computer can't keep one. Registering
 * gives nothing by itself: a person has to allow the app first. What an app says of itself (its
 * name) is shown as its own word, and a4a never fetches anything it names (a logo, a policy), so
 * registering can't make the server reach anywhere.
 */
import { and, count, eq, gt, isNull, notExists, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { oauthClients, oauthGrants } from '../db/schema';
import { randomToken } from '../lib/crypto';
import { clip, OAuthError } from './common';

const MAX_REDIRECTS = 10;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
/** Apps registered in a day and never allowed by anyone, beyond which registration waits: a backstop to the rate limit. */
const MAX_UNUSED_PER_DAY = 5000;

export type ClientRow = typeof oauthClients.$inferSelect;

/** Whether an address is a program on this computer: plain http to a loopback host (RFC 8252). */
export function isLoopback(u: URL): boolean {
  return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname);
}

/**
 * Why a redirect URI can't be registered, or null when it can: https anywhere, or http to this
 * computer, as MCP clients on a desktop listen on a loopback port. No fragment, no credentials,
 * no other scheme.
 */
export function redirectProblem(raw: string): string | null {
  if (raw.length > 2000) return 'A redirect URI may be 2000 characters at most';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `${clip(raw)} isn't an absolute URL`;
  }
  if (raw.includes('#')) return `${clip(raw)} has a fragment (#…), which a redirect URI can't have`;
  if (u.username || u.password) return `${clip(raw)} carries a user name or password`;
  if (u.protocol === 'https:' || isLoopback(u)) return null;
  return `${clip(raw)} is neither https nor http to this computer (127.0.0.1, [::1] or localhost)`;
}

/**
 * The registered redirect URI a request's matches, or null. Exactly, except that a loopback
 * address may come back on another port (RFC 8252, 7.3): a desktop app listens on whichever port
 * is free when it asks. Scheme, host, path and query must still be the same.
 */
export function matchRedirect(registered: string[], asked: string): string | null {
  if (registered.includes(asked)) return asked;
  let u: URL;
  try {
    u = new URL(asked);
  } catch {
    return null;
  }
  if (!isLoopback(u) || asked.includes('#')) return null;
  const portless = (x: URL) => `${x.protocol}//${x.hostname}${x.pathname}${x.search}`;
  for (const r of registered) {
    try {
      const ru = new URL(r);
      if (isLoopback(ru) && portless(ru) === portless(u)) return asked;
    } catch {
      // never registered: every registered URI was checked
    }
  }
  return null;
}

/** Text an app gave about itself: one line, without control characters, cut to length; empty is none. */
function said(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const one = value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  return one ? one.slice(0, max) : null;
}

export interface Registration {
  client_id: string;
  client_id_issued_at: number;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: 'none';
  scope?: string;
  software_id?: string;
  software_version?: string;
}

export function registrationOf(row: ClientRow): Registration {
  return {
    client_id: row.id,
    client_id_issued_at: Math.floor(row.createdAt.getTime() / 1000),
    ...(row.name ? { client_name: row.name } : {}),
    redirect_uris: row.redirectUris,
    grant_types: row.grantTypes,
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...(row.scope ? { scope: row.scope } : {}),
    ...(row.softwareId ? { software_id: row.softwareId } : {}),
    ...(row.softwareVersion ? { software_version: row.softwareVersion } : {}),
  };
}

/** Register an app from its metadata, as RFC 7591 sends it. Errors are its own: invalid_redirect_uri, invalid_client_metadata. */
export async function registerClient(db: Db, body: unknown): Promise<Registration> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OAuthError('invalid_client_metadata', 'Send the app’s metadata as a JSON object');
  const b = body as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || !uris.every((u): u is string => typeof u === 'string')) {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uris must list at least one address to send people back to');
  }
  if (uris.length > MAX_REDIRECTS) throw new OAuthError('invalid_redirect_uri', `An app may register ${MAX_REDIRECTS} redirect URIs at most`);
  for (const u of uris) {
    const problem = redirectProblem(u);
    if (problem) throw new OAuthError('invalid_redirect_uri', problem);
  }
  const grantTypes = b.grant_types === undefined ? ['authorization_code', 'refresh_token'] : b.grant_types;
  if (
    !Array.isArray(grantTypes) ||
    !grantTypes.includes('authorization_code') ||
    grantTypes.some((g) => g !== 'authorization_code' && g !== 'refresh_token')
  ) {
    throw new OAuthError('invalid_client_metadata', 'grant_types may hold authorization_code and refresh_token only, and must hold authorization_code');
  }
  const responseTypes = b.response_types === undefined ? ['code'] : b.response_types;
  if (!Array.isArray(responseTypes) || responseTypes.some((r) => r !== 'code')) {
    throw new OAuthError('invalid_client_metadata', 'response_types may hold code only');
  }
  // A public client: whatever way of authenticating it asks for, it gets none (RFC 7591 lets the
  // server substitute its own value), and the answer says so.
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(oauthClients)
    .where(
      and(
        gt(oauthClients.createdAt, sql`now() - interval '1 day'`),
        isNull(oauthClients.lastUsedAt),
        notExists(db.select({ one: sql`1` }).from(oauthGrants).where(eq(oauthGrants.clientId, oauthClients.id))),
      ),
    );
  if (Number(n) >= MAX_UNUSED_PER_DAY) throw new OAuthError('temporarily_unavailable', 'Too many apps registered today and never used: try again tomorrow', 503);
  const [row] = await db
    .insert(oauthClients)
    .values({
      id: randomToken('a4a-app-', 18),
      name: said(b.client_name, 80),
      redirectUris: [...new Set(uris)],
      grantTypes: [...new Set(grantTypes as string[])],
      scope: said(b.scope, 200),
      softwareId: said(b.software_id, 100),
      softwareVersion: said(b.software_version, 50),
    })
    .returning();
  return registrationOf(row!);
}

/** Whether a registered app renews its tokens: it registered refresh_token, or no grant types at all (both). */
export const refreshes = (row: ClientRow) => row.grantTypes.includes('refresh_token');
