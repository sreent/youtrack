#!/usr/bin/env node
/**
 * tracklet-mcp: connect an MCP client that only speaks stdio (e.g. Claude Desktop)
 * to a tracklet server's MCP endpoint over Streamable HTTP.
 *
 *   TRACKLET_URL=http://localhost:3000 TRACKLET_TOKEN=trk_… tracklet-mcp
 *
 * It forwards JSON-RPC messages both ways and holds no state of its own.
 */
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

function fail(message: string): never {
  process.stderr.write(`tracklet-mcp: ${message}\n`);
  process.exit(1);
}

const baseUrl = (process.env.TRACKLET_URL ?? process.argv[2] ?? '').replace(/\/$/, '');
const token = process.env.TRACKLET_TOKEN ?? '';
if (!baseUrl) fail('set TRACKLET_URL (for example http://localhost:3000)');
if (!token) fail('set TRACKLET_TOKEN to an API token from Profile → API tokens');

let endpoint: URL;
try {
  endpoint = new URL(`${baseUrl}/mcp`);
} catch {
  fail(`TRACKLET_URL is not a URL: ${baseUrl}`);
}

const remote = new StreamableHTTPClientTransport(endpoint, {
  requestInit: { headers: { authorization: `Bearer ${token}`, 'user-agent': 'tracklet-mcp/0.1' } },
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
    process.stderr.write(`tracklet-mcp: request to ${endpoint.href} failed: ${text}\n`);
    // Answer requests with a JSON-RPC error so the client doesn't wait forever.
    if ('id' in message && 'method' in message) {
      void local.send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: `tracklet is unreachable: ${text}` } });
    }
  });
};
remote.onmessage = (message) => {
  void local.send(message);
};
remote.onerror = (err) => process.stderr.write(`tracklet-mcp: ${err.message}\n`);
local.onclose = () => void shutdown(0);
remote.onclose = () => void shutdown(0);

await remote.start();
await local.start();
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
