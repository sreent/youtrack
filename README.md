# a4a · agenda

A YouTrack-style tracker of issues, boards and plans, with a REST API, an MCP server for agents, and AI built in. It joins **a7c** (autonomic), **a5s** (agentos) and **a3t** (ambit), and wears their shared look, [Ocean](https://github.com/sreent/ocean).

a4a's own pieces (issue list, query and command bars, field panel, board, Gantt, load grid, cost panel and more) are proposed to Ocean in [sreent/ocean#7](https://github.com/sreent/ocean/pull/7). The app pins that branch until it merges.

## What it does

- **Issues with typed custom fields** per project: State, Priority, Type, Assignee, Subsystem, Fix versions, Estimation, Start date, Due date, Fixed cost.
  - Values carry Ocean's tones, so resolved reads as a tick and blocked as a clock. Priority is a meter, not a colour.
- **The query language**, as in YouTrack: `project: BACK #Unresolved for: me Priority: Critical, Major sort by: updated desc`.
  - Autocomplete as you type.
  - Problems are underlined where they are, with the fix one click away: *Unknown value "Fixd" for State · Did you mean Fixed?* The API gives agents the same fix as data.
  - Or ask in words: an agent turns them into a query, and shows the query it read before it runs.
- **Commands** change many issues at once: `State Fixed Assignee anna tag regression`, `subtask of BACK-3`. The web app shows what a command changes on each issue before it applies. It can also take the command in words.
- **Agile boards** with sprints, WIP limits and swimlanes.
- **Planning** for waterfall and hybrid projects:
  - a Gantt schedule with the critical path and *what-if* ("what slips if MIG-12 slips 3 days?");
  - resource load and levelling, which is proposed first and applies exactly what was proposed, or nothing if the plan changed meanwhile;
  - cost tracking against a budget;
  - baselines with earned value (CPI, SPI, EAC).
- **AI with Claude**:
  - Triage of new issues: it only suggests, or applies confident values to fields left at their defaults. Its values wait, dashed, on the issue, and a person accepts each one they agree with.
  - Duplicate detection.
  - Search and commands in plain words.
  - Issue summaries.
  - An assistant that works through the same tools as MCP and asks before it changes anything.
- **For integrations**:
  - a REST API (OpenAPI 3.1, docs at `/api/docs`);
  - signed webhooks with at-least-once delivery, and a durable event feed with live SSE;
  - `Idempotency-Key` on POSTs, and `expectedVersion` against lost updates.
- **For agents**: an MCP server at `/mcp` with 22 tools, 4 resources and 6 prompts, plus `a4a-mcp`, a stdio bridge for stdio-only clients.

## Quick start

Needs Node 20+ and pnpm.

```bash
pnpm install
```

```bash
pnpm dev
```

Open <http://localhost:5173>. The first visit creates the administrator, and optionally three demo projects:

- a backlog with a likely duplicate;
- a sprint board;
- a data-center migration plan with a baseline, an over-allocated engineer and a deadline at risk.

The database is embedded (PGlite in `packages/server/data`), so nothing else is needed.

To turn on the AI features, set a Claude API key before `pnpm dev`:

```bash
export ANTHROPIC_API_KEY=sk-ant-…
```

## Connect an agent (MCP)

1. Create a token: **Agents and tokens** in the app, or `POST /api/v1/me/tokens`.
   - A read-only token is the safe way to let an agent explore.
2. Point your client at it.

**Claude Code**

```bash
claude mcp add --transport http a4a http://localhost:3000/mcp --header "Authorization: Bearer a4a_your_token"
```

**Cursor, and other clients that speak HTTP** (`mcp.json`):

```json
{ "mcpServers": { "a4a": { "url": "http://localhost:3000/mcp", "headers": { "Authorization": "Bearer a4a_your_token" } } } }
```

**Claude Desktop, and other stdio-only clients**: use the bridge.

```json
{ "mcpServers": { "a4a": { "command": "npx", "args": ["a4a-mcp"], "env": { "A4A_URL": "http://localhost:3000", "A4A_TOKEN": "a4a_your_token" } } } }
```

The bridge isn't published to npm yet. Until it is, build it with `pnpm build` and use `"command": "node", "args": ["<repo>/packages/mcp-bridge/dist/index.js"]`.

What agents get is described in [docs/mcp-and-api.md](docs/mcp-and-api.md):

- tools such as `search_issues`, `apply_command` (with `dry_run`), `get_schedule` (with `what_if`) and `level_resources`;
- the query and command guides, as resources;
- prompts such as `work_on_issue` and `schedule_review`.

Every change an agent makes is recorded with the token's name, and agents cannot delete issues.

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | API, MCP and (in production) the web UI |
| `PUBLIC_URL` | `http://localhost:$PORT` | Used in links, MCP snippets and the CSRF check |
| `DATABASE_URL` | empty | A Postgres URL. When empty, the embedded PGlite database in `DATA_DIR` is used, which is for one process only |
| `DATA_DIR` | `./data` | Where the embedded database lives |
| `ANTHROPIC_API_KEY` | empty | Turns on the AI features |
| `AI_MODEL` | `claude-opus-5-5` | The Claude model used |
| `AI_TRIAGE_MAX_PER_HOUR` | `120` | Cap on automatic triage runs |
| `ADMIN_LOGIN`, `ADMIN_PASSWORD` | empty | Create the first administrator without the setup page (containers, CI) |
| `SEED_DEMO` | `true` | With `ADMIN_*`, also create the demo projects |

## Production

```bash
docker compose up --build
```

This runs a4a with Postgres 16 on port 3000. See [`docker-compose.yml`](docker-compose.yml) and [`Dockerfile`](Dockerfile).

Without Docker, with `DATABASE_URL` pointing at Postgres:

```bash
pnpm build
```

```bash
pnpm start
```

`pnpm start` serves the built UI too. Put it behind HTTPS and set `PUBLIC_URL`; session cookies are then `Secure`.

## Development

```bash
pnpm test
```

This runs the web app's design check (a4a's look is all Ocean's: its stylesheets may hold no rules of their own), then the server's tests on in-memory PGlite. To run them against a real Postgres server, where each test file gets its own database:

```bash
TEST_DATABASE_URL=postgres://user@localhost:5432/postgres pnpm test
```

```bash
pnpm typecheck
```

| Path | What |
| --- | --- |
| `packages/shared` | The contract: zod schemas for every request and response, used for validation, OpenAPI and the UI's types |
| `packages/server` | Services, the query and command languages, the planning engine, AI, MCP, the HTTP API, the outbox worker |
| `packages/mcp-bridge` | `a4a-mcp`, the stdio bridge |
| `apps/web` | The web UI on Ocean |
| `docs/` | [What the API and MCP can do](docs/mcp-and-api.md) and [the architecture and its decisions](docs/architecture.md) |

The schema lives in `packages/server/src/db/schema.ts`. Migrations are generated with:

```bash
pnpm db:generate
```

They run on start.
