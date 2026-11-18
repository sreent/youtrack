# a4a-mcp

Connects an MCP client that speaks only stdio, such as Claude Desktop, to an [a4a](https://github.com/sreent/youtrack) server's MCP endpoint (`/mcp`, over Streamable HTTP). It passes JSON-RPC messages both ways and keeps nothing of its own.

A client that speaks HTTP (Claude Code, Cursor, and most others) needs no bridge: point it at `https://your-a4a/mcp` with an `Authorization: Bearer` header.

## Use

a4a is internal, so the bridge isn't published to npm: build it in a checkout of a4a,

```bash
pnpm install
pnpm --filter a4a-mcp build
```

make an API token in a4a, under **Agents and tokens**, and give the client:

```json
{
  "mcpServers": {
    "a4a": {
      "command": "node",
      "args": ["/path/to/a4a/packages/mcp-bridge/dist/index.js"],
      "env": { "A4A_URL": "https://a4a.example.com", "A4A_TOKEN": "a4a_your_token" }
    }
  }
}
```

with the checkout's path in place of `/path/to/a4a`. Don't run it as `npx a4a-mcp`: that would fetch whatever someone else publishes under the name, and hand it your token.

- `A4A_URL`: the address people open a4a at, without `/mcp`. It can also be the first argument.
- `A4A_TOKEN`: the token. The agent acts as its person, never beyond their role.

It needs Node 20.19 or later. Without either setting it says which is missing and exits. When a4a can't be reached, each request is answered with a JSON-RPC error saying so, rather than left waiting.

What the agent gets (tools, resources and prompts) is in a4a's [API and MCP document](https://github.com/sreent/youtrack/blob/main/docs/mcp-and-api.md).
