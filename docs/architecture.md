# Architecture

This is how tracklet is put together, and why. Each decision says what it costs and when to revisit it, so the next change can argue with it instead of guessing.

## The system

```text
                 ┌────────────────────────────── one Node process ──────────────────────────────┐
  browser ──────▶│ /            web UI (React SPA, Ocean)            static files, strict CSP   │
  scripts ──────▶│ /api/v1/*    REST + OpenAPI (Hono, zod)  ─┐                                   │
  MCP clients ──▶│ /mcp         MCP, Streamable HTTP          ├─▶ services ──▶ Postgres / PGlite│
  stdio clients ─│  (tracklet-mcp bridge ─▶ /mcp)            │      ▲  │                         │
                 │ assistant    Claude tool loop ─────────────┘      │  └─▶ activities (outbox)  │
                 │ worker       webhooks · AI triage · live events ◀─┘                            │
                 └────────────────────────────────────────────────────────────────────────────┘
```

| Package | Role |
| --- | --- |
| `packages/shared` | The contract: zod schemas for every request and response, constants, period parsing. The server validates with them, generates OpenAPI from them, and the UI types itself from them. |
| `packages/server` | Services (the domain), the query and command languages, the planning engine, AI, MCP, HTTP, and the background worker. |
| `packages/mcp-bridge` | `tracklet-mcp`: a 60-line stdio-to-HTTP bridge for MCP clients that only speak stdio. |
| `apps/web` | The SPA, on the Ocean design system, pinned to a commit. |

## Decisions

### D1. One TypeScript monorepo, one contract

The API, the MCP server, the UI and the agents all describe the same objects. The zod schemas in `packages/shared` are the single definition. The server validates requests with them, the OpenAPI document is generated from them (component names from `.meta({ id })`), and the UI imports their inferred types.

- **Costs:** the contract package must stay free of server-only code.
- **Revisit when:** a client in another language needs an SDK. Generate it from `/api/v1/openapi.json`.

### D2. Postgres semantics everywhere; PGlite only for development and small teams

There is one SQL dialect, with Postgres full-text search and `pg_trgm` for similarity. Without `DATABASE_URL`, the server runs embedded PGlite (Postgres compiled to WASM) in `DATA_DIR`, so `pnpm dev` needs nothing installed. Production sets `DATABASE_URL` to real Postgres. The same Drizzle schema and migrations run on both, and the test suite runs against both.

- **Costs:** PGlite has one connection and runs in-process, so it is for development, demos and a single team, not for load.
- **Revisit when:** never for production. Use Postgres.

### D3. Custom fields as typed rows, not JSON

Every project picks its fields (State, Priority, Assignee, Estimation, Start date …) from a shared catalogue. Option values can be shared or scoped to one project. A value is stored as a row in `issue_field_values`, with typed columns (`value_id`, `user_id`, `number_value`, `date_value`, `text_value`).

- **Why:** queries and sorts need types (priority sorts by its order, not alphabetically), references need integrity (a deleted user can't linger as a string), and renaming a value must not rewrite every issue.
- **Costs:** a search term becomes a correlated `EXISTS`, so `(issue_id, field_id)`, `(field_id, value_id)` and `(field_id, user_id)` are indexed.
- **Revisit when:** a single project exceeds roughly a million issues. Consider denormalised sort keys then.

### D4. One write path

Every change to an issue goes through `applyChanges` in `services/issues.ts`, whichever channel it comes from: a REST `PATCH`, a command, an MCP tool, the assistant, or a triage that applies itself.

The function, in order:

1. Locks the issue row (`SELECT … FOR UPDATE`), so concurrent edits to a multi-value field serialise instead of losing updates.
2. Checks `expectedVersion` when one is sent, and returns 409 with the current version.
3. Validates every value against the project's schema, and fails with hints.
4. Writes the field rows, tags, links and comment, and bumps `version`.
5. Records the history entries in the same transaction.

Commands, dry runs and the AI's previews are this function with `dryRun`. So a preview is exactly what would happen, not an approximation.

### D5. The activity log is the event log (transactional outbox)

`activities` rows are written inside the transaction that made the change. Everything that reacts to change reads that table, never an in-memory callback:

- the issue history,
- `GET /events?after=`,
- the SSE stream,
- webhooks,
- AI triage.

The worker:

- takes a Postgres advisory lock, so exactly one instance delivers webhooks and runs triage;
- keeps a cursor per consumer in `settings`, and advances it only after it handled the rows;
- is woken immediately after local commits and polls every few seconds otherwise, for changes made by other instances.

Delivery is **at least once**. Webhook receivers dedupe on the event `id` in the payload and the `X-Tracklet-Event-Id` header.

- **Costs:** live events can lag by up to the poll interval across instances.
- **Revisit when:** multiple instances need sub-second fan-out. Use `LISTEN/NOTIFY` then.

### D6. The query and command languages compile to parameterised SQL

The lexer keeps positions, so problems point at characters. The parser is schema-aware, so `State: In Progress` and `fix versions: 2.0` work without quotes: it matches the longest known field name and value. The compiler emits Drizzle `sql` fragments, and every user value is a bound parameter. There is no `sql.raw` on input, so injection is impossible by construction.

Problems come back as `{message, start, end, hint}`, for example *Unknown value "Fixd" for State · Did you mean "Fixed"?*. The UI underlines them, and agents repair their own queries from them.

Commands reuse the lexer, resolve names per issue (values can be project-scoped), and run through D4.

### D7. Authorisation lives in services, and every channel is equal

```text
effective scopes = role scopes ∩ token scopes
```

| Role | Scopes |
| --- | --- |
| admin | read, write, admin |
| member | read, write |
| viewer | read |

Every service function checks the scope it needs (`requireScope`), so a REST route, an MCP tool and the assistant can't drift apart: there is no route-level permission logic to forget.

All project visibility goes through one module (`services/access.ts`). v1 makes every project visible to every user. Per-project roles, and tokens restricted to certain projects, change that module alone.

### D8. MCP is a curated tool layer, shared with the assistant

`tools/` defines about 20 task-shaped tools once, each with:

- a zod schema;
- a handler over the services;
- MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`);
- an Ocean grammar tag (`reads`, `changes`) used by the UI.

The MCP server registers them, and the in-app assistant gives the same ones to Claude. Results are compact text and JSON with readable ids, sized for an agent's context.

The transport is stateless Streamable HTTP: a new `McpServer` per request, authenticated by bearer token. Nothing to sticky-route, and it restarts safely.

There are no deletes over MCP. Bulk commands are capped at 50 issues and have `dry_run`.

### D9. AI: Claude, guarded

All AI calls go through `ai/client.ts`.

**Model and SDK**

- The model is `claude-opus-5-5` (override with `AI_MODEL`), via the official `@anthropic-ai/sdk`.
- Calls use the beta Messages API with server-side refusal fallbacks (`fallbacks: "default"`), so a false-positive classifier decline doesn't become an outage.

**Structured features (triage, query from words, command from words)**

- They use structured outputs, with schemas built per project, so enum values are exactly the project's own.
- The query and command are then checked by the real parser. A failure is sent back to the model once to repair.
- Effort is `low`, because these are classifications.

**The assistant**

- It is a streaming tool loop with **append-only** history: the server stores every content block verbatim, including thinking blocks, and never edits a past turn. That is what both prompt caching and Claude's thinking-block checks require.
- The system prompt and the tool list are fixed per conversation, so it is cached.
- Writes pause for the user's approval by default; that is the assistant's rung on Ocean's autonomy ladder.
- Tool results are treated as data, not instructions, because issue text is untrusted (prompt injection).

**Cost guards**

- Triage runs in the worker, one issue at a time, capped per hour (`AI_TRIAGE_MAX_PER_HOUR`, default 120).
- Triage only fills empty fields when it applies itself.

**Without a key**

- AI endpoints return `503 ai_disabled`.
- Lexical similar-issue search (full-text search plus trigram) keeps working.

### D10. Planning is a pure engine over a snapshot

The planning service loads a project's issues, fields, links, work items, people and calendar. It hands the engine plain data; the engine (`planning/*`) is pure functions:

- critical-path scheduling over working days;
- resource load;
- levelling;
- cost and earned value.

That makes it deterministic and unit-testable. A what-if is the same call with overrides.

Schedules are computed on request, never stored, so they can't go stale. Only **baselines** are stored, as snapshots.

Levelling is a priority-based serial heuristic, the same family MS Project uses. It is not an optimiser, and the docs say so.

### D11. The UI follows Ocean

The UI takes `@sreent/ocean` pinned to a commit and imports its tokens and component CSS. Tailwind's theme is mapped to Ocean's *meanings* (never its primitives), as `docs/products.md` in Ocean prescribes.

Consequences for the data model:

- Field values carry a semantic `tone` (`good`, `warn`, `bad`, `idle`, or none), not a hex colour, because Ocean's palette is closed and coral means a change or a failure.
- Tags are neutral chips.
- Priority is shown as a meter (shape), not a colour.
- Agents (the assistant, triage, MCP clients) appear as lagoon squares with the agent mark and their lower-case name, never a sparkle.
- Pages ship with a strict CSP and no inline styles. Bars and meters are SVG attributes, not `style=`.

## Consistency and concurrency

| Concern | Guarantee |
| --- | --- |
| Two people edit one issue | Changes serialise on the issue row. With `expectedVersion`, the second gets 409 and the current version |
| Issue numbers | `UPDATE projects SET next_number = next_number + 1 … RETURNING` inside the creating transaction: gap-free per project, safe under concurrency |
| A history entry without its change, or the reverse | Impossible: same transaction |
| Webhooks and triage | At least once, from the outbox, by one worker at a time |
| Retried `POST` | `Idempotency-Key`: the key is claimed before the work, the stored response is replayed, and a key reused with a different body gets 422 |
| Reference data (fields, values, users) | Cached in memory per instance and invalidated after local writes. A generation counter stops a slow reload from overwriting a newer invalidation. Other instances see changes within 60s |

## Security

- **Passwords:** scrypt with a per-user salt.
- **Sessions:** random 256-bit tokens, stored as SHA-256 hashes. The cookie is `HttpOnly; SameSite=Lax`, plus `Secure` behind HTTPS.
- **CSRF:** cookie-authenticated unsafe requests must come from the server's own origin (Origin/Referer check). Bearer-token requests are not CSRF-able.
- **API tokens:** `trk_` plus 256 random bits, stored as SHA-256 hashes, shown once. Each has scopes, an optional expiry, a last-used time, and can be revoked.
- **Login:** throttled per IP and login.
- **The browser:** strict Content-Security-Policy; no inline script or style; fonts are bundled, nothing loads from outside; Markdown is rendered without raw HTML.
- **Webhooks:** signed with HMAC-SHA256 over the raw body. Only admins can create them, because the server will POST to the URL given (server-side request forgery to internal addresses is the admin's call).
- **Agents:**
  - Issue text is untrusted, so the assistant asks before writes.
  - MCP writes are annotated, so clients can ask too.
  - There are no deletes over MCP.
  - Every change records actor, channel and token.

## Limits and assumptions

- **Teams, not internet scale.** Users, tags, fields and values are held in memory per instance (thousands of each is fine).
- **Pagination.** Search results use offset pagination (sortable by any field); the event feed uses a cursor (`after`).
- **Rate limits** are per instance, in memory.
- **Time zone.** Dates in queries ("today", "{this week}") use the server's time zone. Per-user time zones are future work.
- **Readable ids** (`BACK-12`) are permanent because project keys can't be renamed. Renaming would need an alias table, as YouTrack keeps.

## Not yet

Planned, with the seams already in place:

- per-project roles, and tokens limited to projects (`services/access.ts`);
- OAuth 2.1 for remote MCP;
- attachments;
- a knowledge base;
- notifications;
- a VCS integration (`BACK-12 #Fixed` in commits);
- `LISTEN/NOTIFY` for multi-instance live events;
- agents as assignees.
