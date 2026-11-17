import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Context } from 'hono';
import type { HttpEnv } from '../http/env';
import { errorBody } from '../http/middleware';
import { scopesForRole, type Ctx } from '../context';
import { mcpChallenge, oauthOn } from '../oauth/common';
import { TOOLS } from '../tools/registry';

const CHANGING = new Set(TOOLS.filter((t) => t.kind === 'changes').map((t) => t.name));

/**
 * The tool an app allowed only to read calls to change something, when its person could allow it
 * more: MCP's step-up (D38). Null otherwise: a token's own scopes are its person's choice, and a
 * person who can't write gets the tool's own refusal.
 */
async function needsWrite(ctx: Ctx, req: Request): Promise<string | null> {
  if (!ctx.actor.tokenId?.startsWith('oauth:') || ctx.actor.scopes.includes('write')) return null;
  if (!scopesForRole(ctx.actor.user.role).includes('write')) return null;
  let body: unknown;
  try {
    body = await req.clone().json();
  } catch {
    return null;
  }
  for (const m of Array.isArray(body) ? body : [body]) {
    const msg = m as { method?: unknown; params?: { name?: unknown } } | null;
    if (msg?.method === 'tools/call' && typeof msg.params?.name === 'string' && CHANGING.has(msg.params.name)) return msg.params.name;
  }
  return null;
}

/**
 * Streamable HTTP, stateless: every request gets a fresh server bound to the
 * caller's token, so there is no session to pin or lose across instances.
 */
export async function handleMcp(c: Context<HttpEnv>): Promise<Response> {
  const ctx = c.get('ctx');
  if (!ctx) {
    // With OAuth on, the challenge names where to sign in (RFC 9728), so a client can do it itself.
    const config = c.get('runtime').config;
    c.header('www-authenticate', mcpChallenge(config));
    return c.json(
      errorBody(
        'unauthorized',
        'MCP needs "Authorization: Bearer <token>"',
        oauthOn(config) ? 'Sign in with OAuth, as MCP clients do, or create a token in a4a, under Agents and tokens.' : 'Create a token in a4a, under Agents and tokens.',
      ),
      401,
    );
  }
  if (c.req.method === 'GET' || c.req.method === 'DELETE') {
    // No server-initiated streams or sessions in stateless mode.
    return c.json(errorBody('method_not_allowed', 'Use POST for MCP requests'), 405);
  }
  const tool = await needsWrite(ctx, c.req.raw);
  if (tool) {
    // 403 with the scope it needs: the client asks its person again, for write this time.
    const description = `${tool} changes things, and this app was allowed only to read`;
    c.header('www-authenticate', mcpChallenge(c.get('runtime').config, { code: 'insufficient_scope', description, scope: 'read write' }));
    return c.json(errorBody('insufficient_scope', description, 'Allow the app to make changes too: it asks you again when it signs in.'), 403);
  }
  const { createMcpServer } = await import('./server');
  const server = createMcpServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw);
  } finally {
    // Close after the response is produced (JSON mode resolves once it's complete).
    queueMicrotask(() => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
  }
}
