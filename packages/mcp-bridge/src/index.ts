#!/usr/bin/env node
/**
 * a4a-mcp: connect an MCP client that only speaks stdio (e.g. Claude Desktop)
 * to an a4a server's MCP endpoint over Streamable HTTP.
 *
 *   A4A_URL=http://localhost:3000 A4A_TOKEN=a4a_… a4a-mcp
 *
 * It forwards JSON-RPC messages both ways and holds no state of its own.
 */
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

function fail(message: string): never {
  process.stderr.write(`a4a-mcp: ${message}\n`);
  process.exit(1);
}

const baseUrl = (process.env.A4A_URL ?? process.argv[2] ?? '').replace(/\/$/, '');
const token = process.env.A4A_TOKEN ?? '';
if (!baseUrl) fail('set A4A_URL (for example http://localhost:3000)');
if (!token) fail('set A4A_TOKEN to an API token from Profile → API tokens');

let endpoint: URL;
try {
  endpoint = new URL(`${baseUrl}/mcp`);
} catch {
  fail(`A4A_URL is not a URL: ${baseUrl}`);
}

const remote = new StreamableHTTPClientTransport(endpoint, {
  requestInit: { headers: { authorization: `Bearer ${token}`, 'user-agent': 'a4a-mcp/0.1' } },
});
const local = new StdioServerTransport();

let closing = false;
async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  await Promise.allSettled([remote.close(), local.close()]);
  process.exit(code);
}

local.onmessage = (message) => {
  remote.send(message).catch((err: unknown) => {
    const text = err instanceof Error ? err.message : String(err);
    process.stderr.write(`a4a-mcp: request to ${endpoint.href} failed: ${text}\n`);
    // Answer requests with a JSON-RPC error so the client doesn't wait forever.
    if ('id' in message && 'method' in message) {
      void local.send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: `a4a is unreachable: ${text}` } });
    }
  });
};
remote.onmessage = (message) => {
  void local.send(message);
};
remote.onerror = (err) => process.stderr.write(`a4a-mcp: ${err.message}\n`);
local.onclose = () => void shutdown(0);
remote.onclose = () => void shutdown(0);

await remote.start();
await local.start();
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
