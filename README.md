# a4a · agenda

A YouTrack-style tracker of issues, boards and plans, with a REST API, an MCP server for agents, and AI built in. It joins **a7c** (autonomic), **a5s** (agentos) and **a3t** (ambit), and wears their shared look, [Ocean](https://github.com/sreent/ocean).

a4a's own pieces (issue list, query and command bars, field panel, board, Gantt, load grid, cost panel and more) are part of Ocean since [sreent/ocean#7](https://github.com/sreent/ocean/pull/7), and the app pins Ocean's `main` at that merge.

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
- **Reports**, worked out from each issue's history:
  - a sprint's burndown, by estimate or by count, with the ideal, every change to its scope, and how it stands in a sentence (linked from the sprint board);
  - cumulative flow, created against resolved, and cycle time with its percentiles;
  - time logged by person, issue, project and week, against estimates.
  - Each chart has its figures as a table beside it, and the tables download as CSV.
- **Dashboards**: a page of your own reports, saved searches and notes, private or shared. Each viewer sees what they may.
- **Importing from Jira or YouTrack** (CSV), for a project's managers:
  - columns and values are mapped for you where their names say what they are, and you map the rest;
  - a check says what would happen, row by row, before anything changes;
  - issues keep their original dates, reporters, comments, time and links;
  - running it again updates what changed and never makes an issue twice, and an import nobody has worked on since can be undone.
- **AI**, built for Claude, that also runs on DeepSeek or Qwen:
  - Triage of new issues: it only suggests, or applies confident values to fields left at their defaults. Its values wait, dashed, on the issue, and a person accepts each one they agree with.
  - Duplicate detection.
  - Search and commands in plain words.
  - Issue summaries.
  - An assistant that works through the same tools as MCP and asks before it changes anything.
- **Projects with their own people**:
  - a project is open to everyone, or seen only by its members and administrators;
  - in it, each person is a viewer (reads and comments), a member (also changes issues) or a manager (also its settings, people, boards and baselines);
  - what you can't see doesn't exist for you, everywhere: search, links, boards, plans, the event feed, MCP and what goes to Claude;
  - tokens can be limited to some projects.
- **Single sign-on** with your identity provider (OpenID Connect), with password sign-in optional.
  - Accounts are linked by a verified email, can be made on first sign-in, and can be kept to your email domains.
- **For integrations**:
  - a REST API (OpenAPI 3.1, docs at `/api/docs`);
  - signed webhooks with at-least-once delivery, and a durable event feed with live SSE that resumes from the last event id;
  - `Idempotency-Key` on POSTs, and `expectedVersion` against lost updates.
- **For agents**: an MCP server at `/mcp` with 24 tools, 4 resources and 6 prompts, plus `a4a-mcp`, a stdio bridge for stdio-only clients.
- **One process or several**: on Postgres, any number of instances behind a load balancer behave as one. Live events reach every instance within about a second, cached fields and values update everywhere at once, sign-in limits are shared, and exactly one instance runs the background work, with another taking over if it dies.

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

They also run on DeepSeek or Qwen, which speak the same API. What differs is in [D14](docs/architecture.md#d14-other-models-get-the-portable-subset). The AI sends issue text to whoever serves it, so the provider is named, never guessed from the keys that are set:

```bash
export AI_PROVIDER=deepseek DEEPSEEK_API_KEY=sk-…
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
| `DATABASE_POOL_SIZE` | `10` | Connections each instance keeps to Postgres; it holds one more for `LISTEN` |
| `DATABASE_LISTEN_URL` | `DATABASE_URL` | Where that `LISTEN` connection goes, when `DATABASE_URL` points at a pooler in transaction mode (PgBouncer), which drops `LISTEN` |
| `TRUST_PROXY` | `0` | How many proxies in front append to `X-Forwarded-For`; `1` behind one load balancer. With `0` the header is ignored, since clients can send it |
| `API_RATE_LIMIT`, `MCP_RATE_LIMIT` | `1200`, `600` | Requests a minute per token, user or address, on each instance |
| `DATA_DIR` | `./data` | Where the embedded database lives |
| `AI_PROVIDER` | `anthropic` | Who serves the model: `anthropic`, `deepseek`, `qwen`, or `compatible` for another service that speaks Anthropic's Messages API. Issue text the AI reads goes to them |
| `ANTHROPIC_API_KEY` | empty | Anthropic's key. A provider's key turns the AI features on |
| `DEEPSEEK_API_KEY`, `QWEN_API_KEY` (or `DASHSCOPE_API_KEY`), `AI_API_KEY` | empty | The key for DeepSeek, Qwen or a `compatible` service |
| `AI_BASE_URL` | the provider's | Where requests go. Needed for `compatible`; for Qwen in mainland China, `https://dashscope.aliyuncs.com/apps/anthropic` |
| `AI_MODEL` | `claude-opus-5-5`, `deepseek-v4-pro` or `qwen3.8-max` | The model used |
| `AI_TRIAGE_MAX_PER_HOUR` | `120` | Cap on automatic triage runs |
| `ADMIN_LOGIN`, `ADMIN_PASSWORD` | empty | Create the first administrator without the setup page (containers, CI) |
| `ADMIN_EMAIL` | empty | Their email, so single sign-on can find them by it |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID` | empty | Turn on single sign-on with an OpenID Connect provider: its issuer (https) and a4a's client id there. Register `PUBLIC_URL/api/v1/auth/oidc/callback` as the redirect URI, exactly |
| `OIDC_CLIENT_SECRET` | empty | The client's secret (empty for a public client) |
| `OIDC_NAME` | the issuer's host | What the sign-in page calls it: "Sign in with …" |
| `OIDC_SCOPES` | `openid email profile` | Scopes asked for |
| `OIDC_ALLOWED_DOMAINS` | empty | Comma-separated email domains allowed in; empty allows any the provider verifies |
| `OIDC_CREATE_USERS` | `false` | Give someone an account the first time they sign in |
| `PASSWORD_LOGIN` | `true` | `false` turns password sign-in off, while single sign-on is on |
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

### Several instances

On Postgres, run as many instances as you like behind a load balancer, with nothing sticky. [`docker-compose.cluster.yml`](docker-compose.cluster.yml) runs two behind Caddy ([`deploy/Caddyfile`](deploy/Caddyfile)):

```bash
docker compose -f docker-compose.cluster.yml up --build
```

What each instance needs:

- the same `DATABASE_URL` and `PUBLIC_URL` (the address people open, at the proxy);
- `TRUST_PROXY=1` behind one proxy, so sign-in limits count the client's address rather than the proxy's;
- a `LISTEN` connection straight to Postgres (`DATABASE_LISTEN_URL` if `DATABASE_URL` goes through a pooler in transaction mode);
- a proxy that doesn't buffer `text/event-stream`. Caddy doesn't, and nginx doesn't for a4a's streams, which send `X-Accel-Buffering: no`; their keep-alive every 25 seconds stays within nginx's default read timeout.

`GET /api/v1/health` names the instance that answered and whether it runs the background work (`"worker": "active"` on one, `"standby"` on the rest). How the instances agree, and what is per instance on purpose, is in [docs/architecture.md](docs/architecture.md) (D17).

## Development

```bash
pnpm test
```

This runs the web app's design check (a4a's look is all Ocean's: its stylesheets may hold no rules of their own), then the server's tests on in-memory PGlite. To run them against a real Postgres server, where each test file gets its own database:

```bash
TEST_DATABASE_URL=postgres://user@localhost:5432/postgres pnpm test
```

The role needs `CREATEDB`. With Postgres, `test/cluster.test.ts` also runs: two instances against one database (live events across them, the cache, the shared sign-in throttle, the worker lease and its handover). Without `TEST_DATABASE_URL` it is skipped. In CI, give the job a Postgres 16 service, for example on GitHub Actions:

```yaml
services:
  postgres:
    image: postgres:16
    env:
      POSTGRES_PASSWORD: postgres
    ports: ['5432:5432']
    options: --health-cmd pg_isready --health-interval 5s --health-retries 10
env:
  TEST_DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres
```

Then `pnpm install --frozen-lockfile` and `pnpm test` as usual. Running the suite once without `TEST_DATABASE_URL` as well keeps PGlite covered.

```bash
pnpm typecheck
```

The AI's tests use a scripted model. To run every AI feature against a real one, on the demo data, with the provider's key set as above (it costs a little):

```bash
pnpm --filter @a4a/server test:live
```

CI runs these on `main` for each provider whose key is a repository secret (`ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `QWEN_API_KEY`), and skips the rest.

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
