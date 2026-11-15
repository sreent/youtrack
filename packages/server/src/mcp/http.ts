import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Context } from 'hono';
import type { HttpEnv } from '../http/env';
import { errorBody } from '../http/middleware';

/**
 * Streamable HTTP, stateless: every request gets a fresh server bound to the
 * caller's token, so there is no session to pin or lose across instances.
 */
export async function handleMcp(c: Context<HttpEnv>): Promise<Response> {
  const ctx = c.get('ctx');
  if (!ctx) {
    c.header('www-authenticate', 'Bearer realm="tracklet"');
    return c.json(errorBody('unauthorized', 'MCP needs "Authorization: Bearer <token>"', 'Create a token in tracklet: Profile → API tokens.'), 401);
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
