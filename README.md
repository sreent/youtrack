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
- **Workflow rules**, written in the same two languages and read as sentences:
  - when an issue is created, changes or gets a comment, and then matches a query, a command changes it: *When an issue is created, if it matches `Type: Bug Priority: Critical`, then apply `Assignee anna tag urgent`*;
  - on a schedule, every issue that matches gets the command: *every day at 09:00, `#Unresolved Due date: Overdue` gets `tag overdue`*;
  - a guard refuses a change that would break it, and the change leaves nothing behind: *State Won't fix needs a comment*.
  - Each is previewed before it's saved (its problems where they are, the issues it would touch now, and what it would change on a few), acts as the workflow agent, and keeps a log of what it did. Rules that set off rules stop three steps deep.
  - A project's managers make its rules, and everyone who can see the project can read them. A rule acts only in its own project.
- **Version control**: GitHub and GitLab send pushes and pull requests.
  - A commit or pull request that mentions `BACK-12` is linked to it, and shows on the issue with its state (open, merged, closed).
  - `BACK-12 #Fixed` in a commit message applies the command as its author, when their email is confirmed (by an administrator, or by single sign-on) and they can change the project's issues; otherwise the commit is linked and the issue says why.
  - Deliveries are checked (GitHub's signature, GitLab's token), handled once, rate-limited and logged.
- **Agile boards** with sprints, WIP limits and swimlanes.
- **Planning** for waterfall and hybrid projects:
  - a Gantt schedule with the critical path and *what-if* ("what slips if MIG-12 slips 3 days?");
  - resource load and levelling, which is proposed first and applies exactly what was proposed, or nothing if the plan changed meanwhile;
  - cost tracking against a budget;
  - baselines with earned value (CPI, SPI, EAC).
- **Files** on issues, comments and articles: dropped or chosen, with progress; images shown in place, everything else (SVG and HTML included) downloaded, whatever its name says. Each file's type is read from its bytes and its SHA-256 kept; uploads stream to disk or to an S3-compatible bucket (S3, MinIO, R2), with a size limit per file and a cap per issue.
  - Text files (logs, code, CSV, JSON, Markdown, and HTML as its source) open in place, from their start or their end. Sound and video play in the browser's own player, served in ranges.
  - `files:to-s3` moves the files on disk to a bucket, checking each copy against its checksum, and carries on where a run stopped.
- **A knowledge base** per project: articles in a tree (`BACK-A-3`), written in Markdown with a preview beside it, every saved version kept with its diff, full-text search, and mentions both ways: an article lists the issues that name it, and an issue the articles.
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
- **Notifications** of what concerns you:
  - You watch what you report, are assigned, comment on or are mentioned in (`@anna`), and what you choose to; `watcher: me` finds it.
  - An inbox under Work, by issue, its unread count live in the sidebar. Changes close together on one issue are one notification, and nobody hears of their own changes.
  - Email if you want it: everything, mentions and assignments only, or never, and a daily digest. Each email stops its kind in one click.
- **A help desk** per project: a public form at `/help/<KEY>` for people who aren't users, a page of their own for each request, where they follow the public replies and answer them, and a first-response target (`sla: overdue`). Comments stay internal unless the team makes one public.
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
- **For agents**: an MCP server at `/mcp` with 37 tools, 5 resources and 6 prompts, plus `a4a-mcp`, a stdio bridge for stdio-only clients. Agents can read a log attached to an issue, attach small files, and write documentation in the knowledge base, previewed first. `list_notifications` shows an agent what's waiting for its person. Agents can list and preview workflow rules; people make them.
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
| `DATA_DIR` | `./data` | Where the embedded database and attached files live |
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
| `ATTACHMENT_MAX_MB` | `20` | The largest file one upload may carry (1 MB = 1024 × 1024 bytes) |
| `ATTACHMENTS_PER_ISSUE_MB` | `100` | All the files on one issue, its comments' included, or on one article |
| `ATTACHMENT_STORAGE` | `local` | Where files go: `local` keeps them under `DATA_DIR/attachments`; `s3`, in the bucket below. Back it up with the database |
| `S3_BUCKET` | empty | The bucket files go in with `ATTACHMENT_STORAGE=s3`, and where `files:to-s3` copies them. a4a checks it as it starts |
| `S3_ENDPOINT` | empty | A store other than AWS's: MinIO's, R2's or another's address, e.g. `http://minio:9000` |
| `S3_REGION` | `us-east-1` | The bucket's region (else `AWS_REGION`); R2 takes `auto` |
| `S3_PREFIX` | empty | Before every key, so a bucket can hold more than a4a's files, e.g. `a4a/` |
| `S3_FORCE_PATH_STYLE` | `true` with an endpoint | The bucket in the path (`http://host/bucket/key`), as most stores other than AWS want |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | empty | The bucket's keys (`S3_SESSION_TOKEN` with temporary ones). Without them, the AWS chain gives them: its environment, a profile, or the machine's role |
| `SMTP_URL` | empty | An SMTP server for email, e.g. `smtp://user:pass@mail.example.com:587` (`smtps://` for TLS from the start). Without it, a4a sends no email and nothing fails: the inbox still has everything |
| `MAIL_FROM` | `a4a <a4a@your host>` | Who email comes from |
| `NOTIFY_WINDOW_SECONDS` | `120` | Changes to one issue within this long are one notification, and one email |
| `DIGEST_HOUR` | `8` | The hour, in the server's time zone, the daily digest goes out |

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
- a proxy that doesn't buffer `text/event-stream`. Caddy doesn't, and nginx doesn't for a4a's streams, which send `X-Accel-Buffering: no`; their keep-alive every 25 seconds stays within nginx's default read timeout;
- the same files: a bucket (`ATTACHMENT_STORAGE=s3`), or `DATA_DIR/attachments` on a volume they all mount.

`GET /api/v1/health` names the instance that answered and whether it runs the background work (`"worker": "active"` on one, `"standby"` on the rest). How the instances agree, and what is per instance on purpose, is in [docs/architecture.md](docs/architecture.md) (D17).

### Files in a bucket

Set `ATTACHMENT_STORAGE=s3` and the `S3_*` settings above. A bucket that can't be reached, or refuses a4a, stops the server as it starts, saying what to check. Downloads still come through a4a, which checks who may see a file, so the bucket needs no public access.

To move the files a server already keeps on disk, run the copy with the server's own settings. First run it while the server still runs on disk:

```bash
pnpm --filter @a4a/server files:to-s3
```

Then stop the server and run it again: it copies only what came since. It checks each copy against the checksum taken at upload, says what it couldn't copy and why, and carries on where a run stopped. Start the server with `ATTACHMENT_STORAGE=s3` once it has copied everything. From a build, it's `node packages/server/dist/files-to-s3.js`; `--dry-run` counts what it would copy. Nothing on disk is deleted. With the embedded database, stop the server before either run: one process at a time may open it.

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

The S3 store's tests run against a fake S3 server they start themselves. `test/s3-live.test.ts` runs against a real one when `TEST_S3_ENDPOINT` names it, with `TEST_S3_BUCKET`, `TEST_S3_ACCESS_KEY_ID` and `TEST_S3_SECRET_ACCESS_KEY`; CI gives it MinIO. Without them it is skipped.

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

## End-to-end tests

Playwright drives Chromium through the web app as people use it, against the production build: the real server serves the built UI under its real CSP, on a fresh embedded database with the demo projects, started for the run and removed after it. AI is off on that server; where a flow needs it, the browser's requests to the AI endpoints are answered by the test (the server's own AI is tested by its vitest suite).

Once, for the browser:

```bash
pnpm --filter @a4a/web exec playwright install --with-deps chromium
```

Then, which builds first:

```bash
pnpm test:e2e
```

- `pnpm --filter @a4a/web test:e2e` runs them without building again.
- Arguments go to Playwright: `pnpm test:e2e issue.spec.ts`, `pnpm test:e2e -g "levelling"`, `pnpm test:e2e --headed`.
- The server listens on a free port; set `E2E_PORT` to choose it, and `E2E_HOOK_PORT` for the webhook receiver the tests start.

What it covers, in `apps/web/e2e`:

- **The tour**: every page, light, dark and at 390px, with no console errors, no CSP violations, no sideways scroll, and nothing axe finds against WCAG 2.2 AA. It includes what only the AI fills (a conversation waiting on its approvals, triage's suggestions), stood in for.
- **Issues**: a query's problem and its fix, suggestions from the keyboard, rows chosen from the keyboard and a command previewed then applied, saved searches, a query read from words.
- **An issue**: a field changed from the keyboard, links, comments, logged time, triage's values accepted one at a time, the summary, and a save refused (409) when someone changed the issue first.
- **Reporting**: similar issues while typing, and a retry that doesn't duplicate (`Idempotency-Key`).
- **Boards**: dragging (saved with `expectedVersion`), moving from the keyboard, and a move refused.
- **Plans**: the what-if, baselines, levelling, and levelling refused (409).
- **Management**: tokens (one limited to projects too) and the MCP setup, webhooks (a test delivery, checked against its signature, and pausing), fields, projects, people and passwords.
- **Access**: a manager makes a project members only and gives someone a role in it; to someone outside, it and its issues don't exist; a viewer reads and comments, and is offered nothing that would change an issue.
- **The assistant**: a streamed answer, its approval cards, the decisions and the result.

To see what a test did, record a trace and open it:

```bash
pnpm test:e2e issue.spec.ts --trace on
```

```bash
pnpm --filter @a4a/web exec playwright show-trace test-results/<the test>/trace.zip
```

In CI (`CI` set), a failed test is retried twice, its first retry is traced, and the HTML report is written to `apps/web/playwright-report`.

A new page joins the tour with one line in `tour.spec.ts`. A new flow is a spec that takes `test` from `e2e/support/fixtures.ts`, so its page's clock is fixed and its console is watched; makes a project of its own (`uniqueKey`), so it runs beside the others; and finds things by their roles and labels.
