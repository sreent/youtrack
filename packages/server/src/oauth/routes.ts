/**
 * Where OAuth for remote MCP is reached (D28). The protocol's own endpoints sit at the root, as
 * its metadata names them, and answer in its words ({ error, error_description }): the two
 * metadata documents, registration, the token endpoint and revocation. They alone answer any
 * origin (CORS), with no credentials, so an MCP client running in a browser can use them; /mcp
 * and the REST API stay same-origin. The consent page is the web app's, at /oauth/authorize, and
 * asks the REST API (signed in, like any page) under /api/v1/oauth.
 */
import { OAuthAuthorizationSchema, OAuthDecisionBody, OAuthGrantSchema, OAuthRedirectSchema, OAuthRequestSchema, OAUTH_SCOPES } from '@a4a/shared';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { Runtime } from '../app-services';
import type { HttpEnv } from '../http/env';
import { clientIp, RateLimiter } from '../http/middleware';
import { route } from '../http/route';
import { checkAuthorization, decideAuthorization } from './authorize';
import { registerClient } from './clients';
import { OAuthError, oauthErrorBody, oauthOn, oauthUrls } from './common';
import { listGrants, revokeGrant } from './grants';
import { revokeRequest, tokenRequest } from './tokens';

/** What the consent page and Agents and tokens ask, under /api/v1. */
export function oauthRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['OAuth for MCP'];
  route(
    app,
    {
      method: 'get',
      path: '/oauth/authorize',
      tags,
      summary: 'Check an app’s authorization request, for the consent page',
      description:
        'The query is the one the app sent the browser to /oauth/authorize with. The answer says who asks, where it sends you back and for what, or why the request doesn’t hold, and whether that error may go back to the app. Signed-in people only.',
      query: z.object(OAuthRequestSchema.shape),
      response: OAuthAuthorizationSchema,
    },
    ({ ctx, query }) => checkAuthorization(ctx, query),
  );
  route(
    app,
    {
      method: 'post',
      path: '/oauth/authorize',
      tags,
      summary: 'Allow an app, or decline it',
      description:
        'Allowed, the app gets a code at the address it registered, for the scopes and projects chosen (never more than it asked for, or your role allows); declined, it hears access_denied. The answer is where the browser goes next. Only from a4a’s own page, signed in: not with a token.',
      body: OAuthDecisionBody,
      response: OAuthRedirectSchema,
      status: 200,
    },
    ({ ctx, body }) => decideAuthorization(ctx, body),
  );
  route(
    app,
    { method: 'get', path: '/me/oauth-grants', tags: ['API tokens'], summary: 'Apps you allowed to use MCP as you', response: z.array(OAuthGrantSchema) },
    ({ ctx }) => listGrants(ctx),
  );
  route(
    app,
    {
      method: 'delete',
      path: '/me/oauth-grants/{id}',
      tags: ['API tokens'],
      summary: 'Revoke an app: every token it holds stops working at once',
      params: z.object({ id: z.string() }),
      status: 204,
    },
    ({ ctx, params }) => revokeGrant(ctx, params.id),
  );
}

/** A form (or JSON) body as plain strings; files and repeated keys are left out. */
async function formOf(c: Context<HttpEnv>): Promise<Record<string, string>> {
  const type = (c.req.header('content-type') ?? '').toLowerCase();
  const out: Record<string, string> = {};
  if (type.startsWith('application/json')) {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    for (const [k, v] of Object.entries(body ?? {})) if (typeof v === 'string') out[k] = v;
    return out;
  }
  if (!type.startsWith('application/x-www-form-urlencoded')) throw new OAuthError('invalid_request', 'Send the request as application/x-www-form-urlencoded');
  const body = await c.req.parseBody();
  for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out[k] = v;
  return out;
}

/** A public client may name itself in Basic authentication, with an empty secret. */
function basicClientId(c: Context<HttpEnv>): string | null {
  const header = c.req.header('authorization');
  if (!header?.toLowerCase().startsWith('basic ')) return null;
  try {
    const [id] = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8').split(':');
    return id ? decodeURIComponent(id) : null;
  } catch {
    return null;
  }
}

const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };

function failed(c: Context<HttpEnv>, e: unknown): Response {
  if (e instanceof OAuthError) return c.json(oauthErrorBody(e), e.status as ContentfulStatusCode, NO_STORE);
  throw e;
}

/** The protocol's endpoints and documents, at the root, as OAuth's metadata names them. */
export function mountOAuth(root: Hono<HttpEnv>, runtime: Runtime) {
  const { config } = runtime;
  const anyOrigin = cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Authorization', 'MCP-Protocol-Version'], maxAge: 86400 });
  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/*',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-authorization-server/*',
    '/oauth/register',
    '/oauth/token',
    '/oauth/revoke',
  ]) {
    root.use(path, anyOrigin);
  }
  const off = (c: Context<HttpEnv>) =>
    c.json({ error: 'not_found', error_description: 'This a4a doesn’t let apps sign in with OAuth: connect with an API token' }, 404);

  // RFC 9728: what /mcp is, and who issues its tokens. At the path-specific address the 401's
  // WWW-Authenticate names, and at the root, which clients try when they're given none.
  const resource = (c: Context<HttpEnv>) => {
    if (!oauthOn(config)) return off(c);
    const urls = oauthUrls(config);
    c.header('cache-control', 'public, max-age=300');
    return c.json({
      resource: urls.resource,
      authorization_servers: [urls.issuer],
      scopes_supported: [...OAUTH_SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: 'a4a',
      resource_documentation: `${urls.issuer}/api/docs`,
    });
  };
  root.get('/.well-known/oauth-protected-resource', resource);
  root.get('/.well-known/oauth-protected-resource/mcp', resource);

  // RFC 8414: how to sign in. Public clients with PKCE (S256), codes and refresh tokens.
  root.get('/.well-known/oauth-authorization-server', (c) => {
    if (!oauthOn(config)) return off(c);
    const urls = oauthUrls(config);
    c.header('cache-control', 'public, max-age=300');
    return c.json({
      issuer: urls.issuer,
      authorization_endpoint: urls.authorize,
      token_endpoint: urls.token,
      registration_endpoint: urls.register,
      revocation_endpoint: urls.revoke,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [...OAUTH_SCOPES],
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${urls.issuer}/api/docs`,
    });
  });

  // Registration is open, as MCP clients register themselves, and gives nothing until a person
  // allows the app. Limited per address (per instance, as the API's limits are), and by size.
  const registrations = new RateLimiter(20, 3_600_000);
  const tokens = new RateLimiter(120, 60_000);
  const small = (kb: number) =>
    bodyLimit({ maxSize: kb * 1024, onError: (c) => c.json({ error: 'invalid_request', error_description: `Send at most ${kb} KB` }, 413) });
  const limited = (limiter: RateLimiter, c: Context<HttpEnv>) => {
    const wait = limiter.hit(`ip:${clientIp(c, config.trustProxy)}`);
    if (!wait) return null;
    c.header('retry-after', String(wait));
    return c.json({ error: 'slow_down', error_description: `Too many requests: retry in ${wait}s` }, 429, NO_STORE);
  };

  root.post('/oauth/register', small(16), async (c) => {
    if (!oauthOn(config)) return off(c);
    const slow = limited(registrations, c);
    if (slow) return slow;
    try {
      const body = await c.req.json().catch(() => {
        throw new OAuthError('invalid_client_metadata', 'Send the app’s metadata as JSON');
      });
      return c.json(await registerClient(runtime.db, body), 201, NO_STORE);
    } catch (e) {
      return failed(c, e);
    }
  });

  root.post('/oauth/token', small(8), async (c) => {
    if (!oauthOn(config)) return off(c);
    const slow = limited(tokens, c);
    if (slow) return slow;
    try {
      return c.json(await tokenRequest(runtime, await formOf(c), basicClientId(c)), 200, NO_STORE);
    } catch (e) {
      return failed(c, e);
    }
  });

  root.post('/oauth/revoke', small(8), async (c) => {
    if (!oauthOn(config)) return off(c);
    const slow = limited(tokens, c);
    if (slow) return slow;
    try {
      await revokeRequest(runtime, await formOf(c), basicClientId(c));
      return c.body(null, 200, NO_STORE);
    } catch (e) {
      return failed(c, e);
    }
  });

  for (const path of ['/oauth/register', '/oauth/token', '/oauth/revoke']) {
    root.all(path, (c) => c.json({ error: 'invalid_request', error_description: `Use POST for ${path}` }, 405, { allow: 'POST, OPTIONS' }));
  }
  // Any other well-known document is missing, in JSON: never the web app's page in its place.
  root.all('/.well-known/*', (c) => c.json({ error: 'not_found', error_description: `No ${c.req.path} here` }, 404));
}
