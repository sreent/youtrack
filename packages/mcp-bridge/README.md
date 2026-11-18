# a4a-mcp

Connects an MCP client that speaks only stdio, such as Claude Desktop, to an [a4a](https://github.com/sreent/youtrack) server's MCP endpoint (`/mcp`, over Streamable HTTP). It passes JSON-RPC messages both ways and keeps nothing of its own.

A client that speaks HTTP (Claude Code, Cursor, and most others) needs no bridge: point it at `https://your-a4a/mcp` with an `Authorization: Bearer` header.

## Use

Make an API token in a4a, under **Agents and tokens**, then give the client:

```json
{
  "mcpServers": {
    "a4a": {
      "command": "npx",
      "args": ["-y", "a4a-mcp"],
      "env": { "A4A_URL": "https://a4a.example.com", "A4A_TOKEN": "a4a_your_token" }
    }
  }
}
```

- `A4A_URL`: the address people open a4a at, without `/mcp`. It can also be the first argument.
- `A4A_TOKEN`: the token. The agent acts as its person, never beyond their role.

It needs Node 20.19 or later. Without either setting it says which is missing and exits. When a4a can't be reached, each request is answered with a JSON-RPC error saying so, rather than left waiting.

What the agent gets (tools, resources and prompts) is in a4a's [API and MCP document](https://github.com/sreent/youtrack/blob/main/docs/mcp-and-api.md).
