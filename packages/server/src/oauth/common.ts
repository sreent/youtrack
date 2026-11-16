/**
 * OAuth 2.1 for remote MCP (docs/architecture.md, D28): what the authorization server, the
 * resource server (/mcp) and the consent page share. Every address comes from PUBLIC_URL; nothing
 * in a request chooses one.
 */
import { OAUTH_SCOPES, type OAuthScope } from '@a4a/shared';
import { secureOrLocal, type Config } from '../config';

/** Authorization codes, access tokens and refresh tokens, told apart from API tokens (a4a_) by their prefix. */
export const CODE_PREFIX = 'a4c_';
export const ACCESS_PREFIX = 'a4o_';
export const REFRESH_PREFIX = 'a4r_';

/** A code lasts two minutes: an app exchanges it as soon as the browser brings it back. */
export const CODE_TTL_MS = 2 * 60_000;
/** An access token lasts an hour; the app renews it with its refresh token. */
export const ACCESS_TTL_S = 3600;
/** A refresh token lasts 30 days, and each use gives the next: an app in use stays signed in. */
export const REFRESH_TTL_MS = 30 * 86_400_000;
/** What a person allowed an app is remembered while the app is used: 90 days unused, and it asks again. */
export const REMEMBER_MS = 90 * 86_400_000;

export interface OAuthUrls {
  /** The authorization server's issuer identifier (RFC 8414): PUBLIC_URL itself. */
  issuer: string;
  /** The MCP server's canonical URI (RFC 8707): what every access token is for. */
  resource: string;
  authorize: string;
  token: string;
  register: string;
  revoke: string;
  /** The protected resource metadata for /mcp (RFC 9728), named in a 401's WWW-Authenticate. */
  resourceMetadata: string;
}

/** Whether a4a signs MCP clients in with OAuth: MCP_OAUTH, and only over https (or http on this machine). */
export function oauthOn(config: Config): boolean {
  return config.mcpOAuth && secureOrLocal(config.publicUrl);
}

export function oauthUrls(config: Config): OAuthUrls {
  const base = config.publicUrl.replace(/\/+$/, '');
  return {
    issuer: base,
    resource: `${base}/mcp`,
    authorize: `${base}/oauth/authorize`,
    token: `${base}/oauth/token`,
    register: `${base}/oauth/register`,
    revoke: `${base}/oauth/revoke`,
    resourceMetadata: `${base}/.well-known/oauth-protected-resource/mcp`,
  };
}

/** An OAuth error, in the protocol's own words: a code from its registry and a description. */
export class OAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export const oauthErrorBody = (e: OAuthError) => ({ error: e.code, error_description: e.message });

/** A value someone sent, short enough to repeat back in a message. */
export const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The scopes an app asks for, of a4a's own: reading always, and writing when asked. Words a4a
 * doesn't know (openid, offline_access, an app's own) are left out rather than refused, so a
 * client that asks for more than a4a has still gets what a4a can give, and the token says what.
 */
export function askedScopes(scope: string | undefined): OAuthScope[] {
  const words = (scope ?? '').split(/\s+/).filter(Boolean);
  const known = words.filter((w): w is OAuthScope => (OAUTH_SCOPES as readonly string[]).includes(w));
  if (!known.length) return ['read', 'write'];
  return known.includes('write') ? ['read', 'write'] : ['read'];
}

/**
 * Whether a resource indicator names this server's MCP endpoint. Its canonical URI is
 * PUBLIC_URL/mcp; the server's own address is taken to mean it too, as it holds nothing else an
 * app could ask for. A trailing slash and the case of scheme and host don't matter.
 */
export function resourceMatches(urls: OAuthUrls, resource: string): boolean {
  let asked: URL;
  let mine: URL;
  try {
    asked = new URL(resource);
    mine = new URL(urls.resource);
  } catch {
    return false;
  }
  if (asked.origin !== mine.origin || asked.search || asked.hash) return false;
  const path = asked.pathname.replace(/\/+$/, '');
  return path === mine.pathname.replace(/\/+$/, '') || path === new URL(urls.issuer).pathname.replace(/\/+$/, '');
}

/**
 * The WWW-Authenticate challenge of a 401 from /mcp: with OAuth on, it names the protected resource
 * metadata (RFC 9728), so a client can find where to sign in, and the scopes there are.
 */
export function mcpChallenge(config: Config, error?: { code: 'invalid_token' | 'insufficient_scope'; description: string; scope?: string }): string {
  const parts = ['Bearer realm="a4a"'];
  if (error) parts.push(`error="${error.code}"`, `error_description="${error.description.replace(/["\\]/g, '')}"`);
  // The scopes to ask for: all of them, or, to step up (D38), those the call needs.
  if (oauthOn(config)) parts.push(`resource_metadata="${oauthUrls(config).resourceMetadata}"`, `scope="${error?.scope ?? OAUTH_SCOPES.join(' ')}"`);
  return parts.join(', ');
}
