# What the API and MCP server can do

The product is **a4a** (agenda): a YouTrack-style tracker of issues, boards and plans, in the family of a7c (autonomic), a5s (agentos) and a3t (ambit).

This document is the capability design for the two programmatic surfaces:

- the **REST API**, for scripts, integrations and the web UI itself, and
- the **MCP server**, for AI agents (Claude Code, Claude Desktop, Cursor, custom agents).

Items marked **(later)** are deliberately out of v1 and listed under [Open questions](#9-open-questions).

---

## 1. Who talks to a4a

| Client | Surface | Typical jobs |
|---|---|---|
| People in the browser | Web UI → REST API | Everything. The UI has no private endpoints. |
| Scripts and integrations | REST API + webhooks | CI files a bug when a build breaks; a commit hook resolves `PROJ-12`; importers; dashboards and reports |
| Coding agents (Claude Code, Cursor) | MCP | Pick up an issue, move it to *In Progress*, comment progress, link follow-ups, resolve it when done |
| Assistant agents (Claude Desktop, custom) | MCP | Triage the backlog, write status reports and release notes, find duplicates, plan sprints |
| Event-driven agents | Webhooks / SSE + MCP or REST | React when something happens: triage new issues, notify on blockers |
| Project managers (waterfall or hybrid) | Web UI + REST + MCP | Gantt timeline with critical path, resource levelling, cost tracking against a budget, baselines and earned value |
| The built-in AI assistant | Same tool layer as MCP | Chat with your projects; it asks before it changes anything |

## 2. Design principles

1. **API-first.** Anything you can do in the UI you can do over REST. An OpenAPI 3.1 spec is served at `/api/v1/openapi.json`, with interactive docs at `/api/docs`.
2. **MCP is curated for agents, not a mirror of REST.** About 22 task-shaped tools instead of ~100 endpoints. They take readable IDs (`PROJ-12`) and names (`"Priority": "Critical"`), not internal IDs. Output is compact and agent-readable. Errors tell the agent how to fix the call (for example *"Unknown value 'Fixd' for State. Did you mean 'Fixed'?"*).
3. **One tool layer, three surfaces.** The MCP tools and the in-app assistant's tools are the same code, running over the same services as REST, with the same validation and permission checks.
4. **One permission model.** Every API token belongs to a user and acts as that user. Token scopes (`read`, `write`, `admin`) can only narrow what the user may do.
5. **Safe by default for agents.**
   - MCP cannot delete issues.
   - Commands support `dry_run`.
   - Bulk commands are capped at 50 issues per call.
   - Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`), so a client can auto-approve reads and ask before writes.
   - The in-app assistant asks the user before every write.
6. **Everything is attributed.** The activity log records who made each change and through which channel: `web`, `api`, `mcp`, `assistant`, `automation` or `system`, plus the token name. History reads *"anna (via MCP · token 'claude-code') changed State: Open → In Progress"*.
7. **Built for retries and concurrent editors.**
   - Any `POST` accepts an `Idempotency-Key` header, so a retried request doesn't create a second issue.
   - Issue updates accept `expectedVersion` and return `409 Conflict` when someone else changed the issue first, so an agent can't silently overwrite a human's edit.

## 3. Two small languages shared by every surface

The YouTrack-style **query language** and **command language** are the backbone. The UI search bar, `GET /issues?query=`, the MCP `search_issues` and `apply_command` tools, and the AI features all use them.

**Search queries**

```text
project: BACK #Unresolved Priority: Critical, Major for: me sort by: updated desc
Type: Bug created: -7d .. today -State: Duplicate "login page"
depends on: BACK-12 or subtask of: BACK-3
has: -Assignee tag: regression
```

- Fields are referenced by name, and multi-word values work without quotes (`State: In Progress`).
- Supported: ranges (`a .. b`, `*`), negation (`-value`), `and` / `or` / parentheses, and relative dates (`today`, `{this week}`, `-14d`).
- Free text is searched across summaries, descriptions and comments.
- `sort by:` accepts several keys.

**Commands** (applied to one or more issues)

```text
State Fixed Assignee john tag regression
Critical In Progress            # field names can be omitted when the value is unambiguous
subtask of BACK-3 Estimation 2d
remove tag needs-info duplicates BACK-7
```

- Every command can be **previewed** (`dryRun`), which returns the exact field changes per issue without applying them.
- A command can carry a comment, which is posted together with the changes.

## 4. REST API (v1)

**Base path:** `/api/v1`

**Authentication**

- Session cookie for the web UI.
- `Authorization: Bearer a4a_…` for API tokens.

**Conventions**

- **Errors:** `{ "error": { "code", "message", "hint?", "details?" } }`.
- **Lists:** paginated as `?offset=&limit=` → `{ total, items }`.
- **IDs:** readable issue IDs are accepted everywhere.
- **Custom fields:** set by name, as `{"fields": {"Priority": "Critical", "Assignee": "anna"}}`.

| Area | Endpoints | What it enables |
|---|---|---|
| Auth and setup | `POST /auth/login`, `POST /auth/logout`, `GET/POST /auth/setup`, `GET/PATCH /me` | First-run admin setup, sessions, profile |
| API tokens | `GET/POST /me/tokens`, `DELETE /me/tokens/{id}` | Personal tokens with scopes and expiry; the secret is shown once and stored hashed; last-used time is tracked |
| Users | `GET/POST /users`, `GET/PATCH/DELETE /users/{id}` | Admin user management, roles (`admin`, `member`, `viewer`), bot users |
| Projects | `GET/POST /projects`, `GET/PATCH/DELETE /projects/{key}` | Projects with short keys (`BACK`), leads, and AI triage mode |
| Project schema | `GET /projects/{key}/fields`, `PUT/DELETE /projects/{key}/fields/{fieldId}` | Which custom fields a project uses, which are required, and their defaults |
| Custom fields | `GET/POST /fields`, `PATCH/DELETE /fields/{id}`, `POST/PATCH/DELETE /fields/{id}/values[/{valueId}]` | Field types: enum, state (with *resolved* flag), user, version, string, text, integer, float, date, period. Values can be shared or per-project, ordered and colored |
| Issues | `GET /issues?query=&sort=`, `POST /issues`, `GET/PATCH/DELETE /issues/{id}` | Search with the query language; create with fields, tags, parent and links in one call; partial updates with `expectedVersion` |
| Comments | `GET/POST /issues/{id}/comments`, `PATCH/DELETE /comments/{id}` | Markdown comments |
| Links | `GET/POST /issues/{id}/links`, `DELETE /links/{id}`, `GET /link-types` | Relates, depends on / is required for, duplicates, subtask of / parent for |
| Tags | `GET/POST /tags`, `PATCH/DELETE /tags/{id}`, plus `addTags` / `removeTags` on issues | Colored tags |
| Time tracking | `GET/POST /issues/{id}/work-items`, `DELETE /work-items/{id}` | Log work (`1h 30m`); spent time is rolled up on the issue |
| Activity | `GET /issues/{id}/activity` | Full change history with actor and channel |
| Search helpers | `POST /search/parse`, `GET /search/suggest`, `POST /search/count` | Validate and explain a query, autocomplete, and counts grouped by any field (dashboards, reports) |
| Commands | `POST /commands`, `POST /commands/parse` | Apply or preview a command on up to 50 issues |
| Saved searches | `GET/POST /saved-searches`, `PATCH/DELETE /saved-searches/{id}` | Personal and shared saved queries |
| Agile boards | `GET/POST /boards`, `GET/PATCH/DELETE /boards/{id}`, `GET /boards/{id}/view?sprint=` | Kanban or scrum boards: columns mapped to State values, WIP limits, swimlanes, board filter query |
| Sprints | `GET/POST /boards/{id}/sprints`, `PATCH/DELETE /sprints/{id}`, `POST /sprints/{id}/issues` | Sprint planning |
| Schedule (Gantt) | `GET /projects/{key}/schedule?query=&baseline=`, `POST /projects/{key}/schedule/what-if` | Critical-path schedule: early/late dates, slack, critical path, summary roll-ups, dependency cycles, finish date. *What-if* takes overrides (delay, estimate, assignee) and returns the impact without saving |
| Resources | `GET /projects/{key}/resources?from=&to=`, `POST /projects/{key}/level` | Per-person daily load against capacity, over-allocated days, levelling preview (`dryRun`, default) or apply (`within_slack`, the default, or `allow_delay`). Applying writes the Start date of the tasks moved for resources, in one transaction; pass the preview's `starts` as `expect` and nothing is applied if the plan changed since (409) |
| Costs | `GET /projects/{key}/costs?baseline=` | Budget, planned and actual cost by task and by person; earned value (PV, EV, AC, CPI, SPI, EAC) against a baseline |
| Baselines | `GET/POST /projects/{key}/baselines`, `GET/DELETE /baselines/{id}` | Snapshot the plan, then compare start, finish, effort and cost variance per task |
| Plan settings | `PATCH /projects/{key}` (`plan`), `PATCH /users/{id}` (`hourlyRate`, `capacityHoursPerDay`) | Working days, hours per day, holidays, project start, budget and currency; per-person rate and capacity |
| Events | `GET /events?after=`, `GET /events/stream` (SSE) | A durable change feed: poll it, or stream it live |
| Webhooks | `GET/POST /webhooks`, `PATCH/DELETE /webhooks/{id}`, `GET /webhooks/{id}/deliveries`, `POST /webhooks/{id}/test` | Signed push notifications with retries and a delivery log |
| AI | see [section 7](#7-ai-endpoints) | Triage, duplicates, natural language → query or command, summaries, chat |
| Settings | `GET/PATCH /settings` | Instance name, default AI triage mode |
| System | `GET /health`, `GET /openapi.json` | Probes, spec |

**Example: what scripts can do with it**

- **CI bot**
  1. On a red build it sends `POST /issues` with `Idempotency-Key: build-4711`, `Type: Bug` and `tag: ci-failure`, so a retry never duplicates the issue.
  2. When the build goes green again it sends `POST /commands` with `State Fixed`.
- **Commit hook.** A message like `BACK-12 #Fixed` becomes `POST /commands {issues:["BACK-12"], command:"State Fixed", comment:"Fixed in a1b2c3"}`.
- **Weekly report.** `POST /search/count {query:"project: BACK #Unresolved", groupBy:"Priority"}`.
- **Chat bot.** Read `GET /events/stream` and post "BACK-12 moved to In Progress by anna".

## 5. MCP server

**Transport and auth**

- **Endpoint:** `POST /mcp` on the same server, using Streamable HTTP (stateless) with `Authorization: Bearer a4a_…`. The tool calls act as the token's user.
- **stdio:** for clients that only speak stdio, the `a4a-mcp` bridge connects stdio to `/mcp` using `A4A_URL` + `A4A_TOKEN`.

### 5.1 Tools

| Tool | What it does | Kind |
|---|---|---|
| `get_current_user` | Who the agent is acting as: role and token scopes | read |
| `list_projects` | Projects with key, name, description, open-issue counts | read |
| `get_project` | A project's fields and allowed values (states marked resolved/unresolved), link types, tags, people | read |
| `search_issues` | Run a query. Returns total + compact rows (id, summary, state, priority, type, assignee, updated). Invalid queries return the error position and a suggestion | read |
| `get_issue` | One issue in full: fields, description, links (subtasks, blockers, duplicates), recent comments, spent time, pending AI triage suggestions | read |
| `count_issues` | Count issues matching a query, optionally grouped by a field ("open bugs by priority") | read |
| `get_activity` | Recent changes: who changed what and when, filtered by issue, project, query or time ("what happened since yesterday?") | read |
| `find_similar_issues` | Rank existing issues by similarity to some text. Use before filing an issue to avoid duplicates | read |
| `list_users` | Find people by name or login, for assignment | read |
| `get_board` | Board columns with their cards for a sprint: a status overview | read |
| `create_issue` | Create an issue with fields, tags, parent and links. The result includes likely duplicates so the agent can link or close | write |
| `update_issue` | Change summary, description or fields; add or remove tags | write (idempotent) |
| `apply_command` | Apply a command to 1–50 issues, with optional comment. Use `dry_run` to preview | write |
| `add_comment` | Comment on an issue (Markdown) | write |
| `link_issues` / `unlink_issues` | `"BACK-5 depends on BACK-2"`, `"BACK-9 duplicates BACK-1"`, `"BACK-7 subtask of BACK-3"` | write |
| `log_work` | Log time on an issue (`"1h 30m"`, optional date and note) | write |
| `get_schedule` | The project plan: finish date, critical path, slack, late tasks, and variance against a baseline. Optional `what_if` overrides answer *"what slips if BACK-12 slips 3 days?"* without saving anything | read |
| `get_resource_load` | Who is over-allocated, and on which days | read |
| `get_cost_report` | Budget vs. planned vs. actual cost, plus earned value against a baseline | read |
| `level_resources` | Propose (`dry_run`, default) or apply a levelled schedule that resolves over-allocation; `expect` applies only the proposal the person agreed to | write |
| `create_baseline` | Snapshot the current plan under a name | write |

Deliberately **not** exposed over MCP in v1: deleting issues, user and permission admin, webhooks, settings.

### 5.2 Resources (read-only context a client can attach)

| URI | Content |
|---|---|
| `a4a://guide/query-language` | The search syntax reference, with examples |
| `a4a://guide/commands` | The command syntax reference |
| `a4a://projects/{key}` | A project's schema: fields, values, link types |
| `a4a://issues/{id}` | An issue rendered as Markdown (lists the 50 most recently updated) |

### 5.3 Prompts (reusable workflows; appear as slash commands in Claude Code)

| Prompt | Arguments | Workflow |
|---|---|---|
| `work_on_issue` | `issue_id` | Read the issue and its links, assign to me + *In Progress*, plan, comment progress, link follow-ups, resolve with a summary when done |
| `triage_backlog` | `project` | Review untriaged issues, propose Type, Priority, Assignee and tags, flag duplicates, apply after confirmation |
| `report_bug` | `description` | Search for duplicates first, then file a well-structured bug (steps, expected vs. actual, environment) |
| `status_report` | `project`, `since?` | Summarize progress, blockers and risks from activity and counts |
| `release_notes` | `project`, `query?` | Write release notes from resolved issues, grouped by type |
| `schedule_review` | `project`, `baseline?` | Review the plan: critical path, over-allocated people, slipping tasks and cost variance against the baseline, then recommend actions (levelling, re-assignments, scope cuts) |

### 5.4 Example agent sessions

- **Claude Code, end to end.** `/mcp__tracklet__work_on_issue BACK-12` → `get_issue` → `apply_command("for me In Progress")` → work in the repo → `add_comment("Root cause: …")` → `create_issue(... parent BACK-12)` for a follow-up → `apply_command("State Fixed", comment: "Fixed in PR #123")`.
- **Bug intake.** "Users can't log in with SSO on Safari" → `find_similar_issues` → `BACK-40` looks the same → `link_issues(BACK-40 relates to ...)` or `add_comment` with the new report instead of filing a duplicate.
- **Monday report.** `count_issues(project: BACK #Unresolved, group_by: State)` + `get_activity(since: -7d)` → a summary.

### 5.5 Connecting clients

```bash
# Claude Code
claude mcp add --transport http a4a http://localhost:3000/mcp \
  --header "Authorization: Bearer a4a_your_token"
```

```jsonc
// Cursor / other HTTP clients (mcp.json)
{ "mcpServers": { "a4a": { "url": "http://localhost:3000/mcp",
    "headers": { "Authorization": "Bearer a4a_your_token" } } } }

// Claude Desktop and other stdio-only clients (claude_desktop_config.json)
{ "mcpServers": { "a4a": { "command": "npx", "args": ["a4a-mcp"],
    "env": { "A4A_URL": "http://localhost:3000", "A4A_TOKEN": "a4a_your_token" } } } }
```

The web UI has a **Connect an agent** page that creates a token and fills in these snippets for you.

## 6. Events and webhooks

An agent or integration can react to changes instead of polling.

**Event types**

- `issue.created`, `issue.updated` (with the list of field changes), `issue.deleted`
- `comment.created`, `comment.updated`, `comment.deleted`
- `link.created`, `link.deleted`
- `work.logged`
- `ai.triage.completed`

**Payload**

```json
{ "id": 1042, "type": "issue.updated", "occurredAt": "2026-11-15T10:12:00Z",
  "actor": { "login": "anna", "channel": "mcp", "token": "claude-code" },
  "project": "BACK", "issue": { "id": "BACK-12", "summary": "…", "url": "…" },
  "changes": [ { "field": "State", "from": "Open", "to": "In Progress" } ] }
```

**Delivery**

- **Webhooks:** filtered by event type and project, signed with `X-A4A-Signature: sha256=<HMAC of body>`, retried up to 3 times with backoff, every attempt logged.
- **`GET /events/stream`:** the same payloads over SSE.
- **`GET /events?after=<id>`:** a durable feed to catch up after downtime.

## 7. AI endpoints

These are powered by Claude (`claude-opus-5-5`) and enabled when `ANTHROPIC_API_KEY` is set. Without a key they return `503 ai_disabled`, and the non-AI parts keep working (lexical similar-issue search included).

| Endpoint | What it does |
|---|---|
| `POST /ai/query` | Natural language → query. *"critical bugs assigned to me updated this week"* → `Type: Bug Priority: Critical for: me updated: {this week}`. The query is validated by the real parser; on a parse error the model gets the error and retries once |
| `POST /ai/command` | Natural language → command for the selected issues, returned with a dry-run preview. *"close as duplicate of BACK-7 and assign to anna"* |
| `POST /ai/similar` | Duplicate check while typing. Lexical candidates (Postgres full-text + trigram) are returned instantly; with `judge: true` Claude labels each as *duplicate*, *related* or *different*, with a reason |
| `POST /issues/{id}/triage` | Suggests Type, Priority, Subsystem, Assignee and tags, plus possible duplicates, with confidence and rationale. Runs automatically on new issues when the project's triage mode is `suggest` or `auto`. `auto` fills only empty fields, attributed to the *AI Assistant* bot |
| `GET /issues/{id}/suggestions`, `POST /suggestions/{id}/apply \| dismiss` | Review triage suggestions: apply all, apply some, or dismiss |
| `GET /ai/suggestions?project=` | Everything agents propose that waits on a person, across issues (the Decide page) |
| `GET /ai/tools` | The tool catalogue agents get over MCP and in the assistant, each tagged `reads` or `changes` |
| `POST /issues/{id}/summarize` | A short summary of a long issue thread |
| `GET/POST /ai/conversations`, `POST /ai/conversations/{id}/messages` (SSE), `POST /ai/conversations/{id}/approve` (SSE) | The project chat assistant. It streams text and tool calls and uses the MCP tool layer. Writes pause for **Approve / Reject** by default. History is stored and resumable |

## 8. Security model for agents

- **Tokens.**
  - Random, prefixed `a4a_`, and shown once; only a SHA-256 hash is stored.
  - Each has a name, scopes, an optional expiry and a last-used time, and can be revoked at any time.
  - A read-only token is the safest way to let an agent explore.
- **Prompt injection.** Issue text is untrusted, since anyone who can file an issue can write instructions into it.
  - The assistant's system prompt treats tool output as data.
  - Writes need approval in the in-app assistant.
  - MCP write tools are annotated so clients prompt before running them.
- **Blast radius.**
  - No deletes over MCP.
  - Bulk commands are capped at 50 issues, with `dry_run` available.
  - Result sizes are capped.
  - A per-token rate limit applies.
- **Audit.** Every change records actor, channel and token, so you can always answer *"which agent did this?"*.

## 9. Open questions

These are the decisions worth thinking through together. v1 ships with the defaults in brackets.

1. **Deletes over MCP.** Should agents ever delete issues? [No. Agents resolve instead, for example `State Obsolete`.]
2. **Agents as teammates** (later). Assignable bot users that pick up issues assigned to them and report back, triggered by webhooks. This was the AI feature not picked for v1; the event feed and MCP make it a small step.
3. **OAuth 2.1 for remote MCP** (later). Needed for claude.ai custom connectors and one-click sign-in from MCP clients. [v1 uses bearer tokens.]
4. **Per-project token restrictions** (later). For example, a token that can only touch `BACK`. [v1 has scopes only.]
5. **VCS integration** (later). An inbound GitHub/GitLab webhook that turns `BACK-12 #Fixed` in commit messages into commands and links PRs to issues.
6. **Partial responses** (later). A YouTrack-style `?fields=id,summary,fields(State)` selector for heavy integrations.
7. **Agent-specific limits.** Should MCP writes be rate-limited separately from humans, or require a second human approval for bulk changes over N issues?
