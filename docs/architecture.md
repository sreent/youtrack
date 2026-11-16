# Architecture

This is how a4a is put together, and why. Each decision says what it costs and when to revisit it, so the next change can argue with it instead of guessing.

## The system

```text
                 ┌────────────────────────────── one Node process ──────────────────────────────┐
  browser ──────▶│ /            web UI (React SPA, Ocean)            static files, strict CSP   │
  scripts ──────▶│ /api/v1/*    REST + OpenAPI (Hono, zod)  ─┐                                   │
  MCP clients ──▶│ /mcp         MCP, Streamable HTTP          ├─▶ services ──▶ Postgres / PGlite│
  stdio clients ─│  (a4a-mcp bridge ─▶ /mcp)            │      ▲  │                         │
                 │ assistant    Claude tool loop ─────────────┘      │  └─▶ activities (outbox)  │
                 │ worker       webhooks · rules · AI triage · live events ◀─┘                    │
                 └────────────────────────────────────────────────────────────────────────────┘
```

| Package | Role |
| --- | --- |
| `packages/shared` | The contract: zod schemas for every request and response, constants, period parsing. The server validates with them, generates OpenAPI from them, and the UI types itself from them. |
| `packages/server` | Services (the domain), the query and command languages, the planning engine, AI, MCP, HTTP, and the background worker. |
| `packages/mcp-bridge` | `a4a-mcp`: a 60-line stdio-to-HTTP bridge for MCP clients that only speak stdio. |
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

Delivery is **at least once**. Webhook receivers dedupe on the event `id` in the payload and the `X-A4A-Event-Id` header.

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

Levelling is proposed before it is applied, and applying writes exactly what was proposed:

- Only the starts of tasks moved *for resources* are written. A task that moved because its predecessors did follows them by itself. Pinning its start would turn a task with a due date and no estimate into a start-to-due window, so the plan after applying would differ from the proposal.
- Applying is one transaction: the whole proposal or none of it.
- The caller sends back the proposal's `starts` as `expect`. If levelling would now write anything else, because the plan changed between seeing and applying, nothing is written and the answer is 409 with the new proposal. The web app, the API and the MCP tool all work this way.

### D11. The UI follows Ocean

The UI takes `@sreent/ocean` pinned to a commit and imports its tokens and component CSS. a4a's own pieces (the issue list, query and command bars, field panel, links, history, board, Gantt, load grid and cost panel) were added to Ocean first, each with its markup contract, and a4a's components emit that markup. That change is sreent/ocean#7, and the pin is Ocean's `main` at its merge.

a4a keeps no look of its own (Ocean's rule 7: take from Ocean, and extend Ocean where it has nothing, so there is one truth). Its one stylesheet imports Ocean, maps Tailwind's theme to Ocean's meanings, and lets React's root hold the frame (`#root`). How its pages place pieces is Ocean's too: stacks, clusters, a main column with an aside, forms. Tailwind's utilities carry a `tw:` prefix and place only structure, such as a grid's columns. The prefix matters: without it Tailwind turned the word "hidden" in the code into `display: none`, which took every screen-reader label out of the app. `apps/web/scripts/check-design.mjs`, part of `pnpm test`, fails on any other rule, and on any utility that would carry a look or space a piece. Tailwind's theme is mapped to Ocean's *meanings* (never its primitives), as `docs/products.md` in Ocean prescribes.

Consequences for the data model:

- Field values carry a semantic `tone` (`good`, `warn`, `bad`, `idle`, or none), not a hex colour, because Ocean's palette is closed and coral means a change or a failure.
- Tags are neutral chips.
- Priority is shown as a meter (shape), not a colour.
- Agents (the assistant, triage, MCP clients) appear as lagoon squares with the agent mark and their lower-case name, never a sparkle.
- Pages ship with a strict CSP and no inline styles. Bars and meters are SVG attributes, not `style=`.

### D12. Agents propose; people decide, a value at a time

What an agent works out is never in force until a person accepts it. Triage stores its fields, tags and possible duplicates as a suggestion.

- **Applied in parts.** A suggestion can be accepted one value at a time. It stays open while anything in it is still open on the issue *as it is now*, and is applied once nothing is. Status is derived from the issue, not counted, so a value someone set by hand also closes its part.
- **Its history says where it came from.** The change carries `acceptedFrom: "triage"` in its activity, so the issue's history reads "Anna Schmidt accepted what triage worked out".
- **Commands read from words.** When the assistant turns words into a command (`POST /ai/command`), the person sees what it would change on each issue first. Applying it records the channel as the assistant.

### D13. Problems carry their fix

A query or command problem names its span and, when there is a likely fix, the text that fixes it (`fix`). The text keeps the `-` or `#` typed before a value, and braces a value that needs it.

- The UI offers the fix as one click ("Did you mean Fixed?"), with no parsing of hint text.
- Agents over MCP or the API can apply it the same way.
- A misspelt value of several words ("State: In Progres") is read as one value with one fix, rather than an unknown word and some loose text. Suggestions replace all of a value of several words, from its first word.

### D14. Workflow rules: an outbox consumer that acts, and guards inside the write path

A rule belongs to a project (or, for administrators, to every project) and is one of three kinds. All three are the query language for *which issues* and the command language for *what to change*, so a rule is checked, previewed and explained the way a query or a command is.

**Rules on a change and scheduled rules act afterwards, as the workflow agent.**

- Rules on a change run in the outbox worker, as a consumer of `issue.created`, `issue.updated` and `comment.created`. Each rule the event sets off acts when the issue, as it is when the rule runs, matches the rule's query. All of them are evaluated in one read, against the issue as the change left it.
- Scheduled rules (every hour, day or weekday, at a time, in the server's time zone) run in the same worker's periodic step, which only the instance holding the worker's lease reaches. A turn is claimed by moving the rule's next run on (a conditional update), so it runs once even if the lease changes hands. Issues are read in pages by id, renewing the lease between pages, up to 2,000 a run.
- Both apply through the command executor's own step (`commandSpec`, then `applyChanges`), as the `workflow` bot with channel `automation`, with "me" standing for whoever made the change that set them off. The bot acts with administrator scopes, confined by the rule's own project scope; a rule's author must be able to see what its command links to.
- A rule that fails is written in its run log with why, and never stops the others or the outbox.

**Loops stop at a fixed depth, with each rule acting once per chain.** Every change a rule makes records its cause on every activity it writes (`data.automation`: the rule, the change that started the chain, how deep it is). Rules a rule sets off act one step deeper, up to three steps. And a rule acts on an issue at most once for each change that starts a chain: the run log's unique key (rule, issue, origin) is claimed in the same transaction as the rule's change. The same key makes a replayed event, which at-least-once delivery allows, do nothing. Chains are useful (a scheduled rule tags an issue overdue; a rule on that change raises its priority); the key guarantees they end, and the depth bounds how far they reach.

**Guards are checked inside `applyChanges`, in the same transaction.** A guard says: a change that makes an issue match Q must leave it matching R. Before writing, `applyChanges` reads whether each of the project's guards holds; after writing everything (fields, tags, links, the comment) and before commit, it reads again. A change that takes the issue from keeping a guard to breaking it is refused (422), and the transaction takes all of it back. An issue that broke a guard before the guard existed can still be changed in other ways: a guard refuses only what makes things worse. A new issue has no "before", so `createIssue` checks its guards at the end of its own transaction, and a refused issue doesn't even use up its number.

**Keeping the write path fast, and free of deadlocks.**

- Rules are reference data: they load with the schema snapshot, so a project without guards pays a filter over memory and no query, and a rule change invalidates the snapshot like any other.
- With guards, the two checks are one SELECT each, over every guard at once, on the transaction's own connection. Reads take no row locks and never wait on one (MVCC), so the checks add no edge to the wait-for graph: they can't take part in a deadlock. A snapshot reload inside the transaction runs on the transaction's connection (see `SchemaCache.get`), never the pool, so on PGlite it can't wait on itself.
- A refusal is written to the run log on the pool and not awaited. The refused transaction never waits on it: on PGlite it queues behind the transaction, and on Postgres it waits for the issue's row lock, which the refused transaction releases as it ends.
- The rule engine's own writes take the issue's row lock first, as every write to an issue does, then claim the run.

**What it costs.** A rule acts a few seconds after a change (the outbox's settle time), not inside it, so a person sees their own change first and the rule's a moment later, each in the history under its own name. Dry runs don't evaluate guards (they write nothing to evaluate), so a command's preview can't say a guard will refuse it; applying it does, per issue. Guards see changes made through the write path: deleting a comment or logging work isn't checked.

**Agents can't make rules.** They list them and preview them over MCP. A rule acts later, on its own, on every issue that ever matches it: it would outlive the conversation and the caps on an agent's commands, and agents read text anyone can write.

**Revisit when:** rules need to read more than one issue (a parent's state, a sprint's), or to do something other than a command (notify, call out): then a small expression language over the issue, still evaluated by the same engine.

### D15. Version control: verified deliveries, idempotent links, commands as the verified author

GitHub and GitLab post pushes and pull (merge) requests to `/api/v1/vcs/hooks/{integration}`.

- **Who sent it.** GitHub's `X-Hub-Signature-256`, an HMAC-SHA256 of the raw body, is recomputed and compared in constant time; GitLab's `X-Gitlab-Token` is hashed and compared in constant time. The raw bytes are read before anything parses them. GitHub's secret is an HMAC key, so a4a keeps it to check signatures (as it keeps its own webhooks' secrets to sign); GitLab's token is kept only as a SHA-256. Neither is shown after it's made.
- **How often.** Deliveries are rate-limited per integration; refusals are rate-limited per address, and those over the limit aren't logged, so the log can't be flooded.
- **Once.** The provider's delivery id is claimed before the work. One sent again is answered as a duplicate. One that failed (or died, after ten minutes) may be handled again, which is safe because linking is idempotent per (issue, commit) and per (issue, pull request), held by unique keys.
- **Commands.** `BACK-12 #Fixed` applies the command after `#` as the person whose *verified* email wrote the commit, and only if they can write to the project (asked through `services/access.ts`). A commit's author email is whatever the committer typed, and a4a's own emails are whatever people typed, so an email counts only when an administrator set or confirmed it (`users.email_verified_at`; a person changing their own clears it). Each (commit, issue) is one transaction that locks the issue first; the command runs in a savepoint, so a command that fails, or a guard that refuses it, leaves the link and says why.
- **History.** Linking records `commit.linked`, `pull_request.linked` and `pull_request.updated`, on a new channel, `vcs`, as the matched person or as the integration itself, so the issue's history, the event feed and webhooks see it.

**Costs.** One email per person, so commits under a provider's no-reply address run no commands. A push reads its first 500 commits.

**Revisit when:** people need several emails, or a mapping from provider logins; or a4a should fetch what a delivery leaves out (a push delivery carries at most 2,048 commits).

## Consistency and concurrency

| Concern | Guarantee |
| --- | --- |
| Two people edit one issue | Changes serialise on the issue row. With `expectedVersion`, the second gets 409 and the current version. The web app always sends it and re-reads the issue on 409 |
| Levelling while the plan changes | `expect` (the proposal's starts) makes applying conditional: 409 instead of a different plan than the one agreed |
| Issue numbers | `UPDATE projects SET next_number = next_number + 1 … RETURNING` inside the creating transaction: gap-free per project, safe under concurrency |
| A history entry without its change, or the reverse | Impossible: same transaction |
| Webhooks and triage | At least once, from the outbox, by one worker at a time |
| Retried `POST` | `Idempotency-Key`: the key is claimed before the work, the stored response is replayed, and a key reused with a different body gets 422 |
| Reference data (fields, values, users, workflow rules) | Cached in memory per instance and invalidated after local writes. A generation counter stops a slow reload from overwriting a newer invalidation. Other instances see changes within 60s |
| A guard and the change it checks | Same transaction: the change is checked after it's written and before commit, and refused all or nothing (D14) |
| A rule acting on a replayed event, or a loop of rules | Once per (rule, issue, change that started the chain), claimed in the rule's own transaction; chains stop three rules deep |
| A scheduled rule's turn | Claimed by moving its next run on, conditionally, by the instance holding the worker's lease |
| A delivery from version control sent twice | Its delivery id is claimed before the work; links are unique per issue and commit (or pull request), so even a second delivery id changes nothing twice |

## Security

- **Passwords:** scrypt with a per-user salt.
- **Sessions:** random 256-bit tokens, stored as SHA-256 hashes. The cookie is `HttpOnly; SameSite=Lax`, plus `Secure` behind HTTPS.
- **CSRF:** cookie-authenticated unsafe requests must come from the server's own origin (Origin/Referer check). Bearer-token requests are not CSRF-able.
- **API tokens:** `a4a_` plus 256 random bits, stored as SHA-256 hashes, shown once. Each has scopes, an optional expiry, a last-used time, and can be revoked.
- **Login:** throttled per IP and login.
- **The browser:** strict Content-Security-Policy; no inline script or style; fonts are bundled, nothing loads from outside; Markdown is rendered without raw HTML.
- **Webhooks:** signed with HMAC-SHA256 over the raw body. Only admins can create them, because the server will POST to the URL given (server-side request forgery to internal addresses is the admin's call).
- **Deliveries from version control:** checked (signature or token, in constant time) before anything is read; rate-limited; refusals logged at a bounded rate. Commands in commits run only as a person whose email an administrator vouched for, and only where they can write (D15). Links from a payload are shown only if they are http(s).
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
- `LISTEN/NOTIFY` for multi-instance live events;
- agents as assignees, and tokens issued to a bot user, so an agent can act as itself rather than for a person;
- undo for a change an agent made on its own (the assistant at Acts);
- in the web app: column heads that stay in view on boards with lanes, a chosen window for the load grid, and absences (today a day off is a day of zero capacity).
