import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Context } from 'hono';
import type { HttpEnv } from '../http/env';
import { errorBody } from '../http/middleware';
import { mcpChallenge, oauthOn } from '../oauth/common';

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
        oauthOn(config) ? 'Sign in with OAuth, as MCP clients do, or create a token in a4a: Profile → API tokens.' : 'Create a token in a4a: Profile → API tokens.',
      ),
      401,
    );
  }
  if (c.req.method === 'GET' || c.req.method === 'DELETE') {
    // No server-initiated streams or sessions in stateless mode.
    return c.json(errorBody('method_not_allowed', 'Use POST for MCP requests'), 405);
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
