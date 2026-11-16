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
                 │ worker       webhooks · AI triage · live events ◀─┘                            │
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

### D14. Files stream to a small store, and come back as downloads

Files sit on issues, on comments (the author's own) and on knowledge base articles.

**Uploading.** An upload is `multipart/form-data`, read as a stream (busboy) and never held whole in memory:

1. Who may put a file there is settled before a byte of it is read.
2. A record of the storage key is written (`attachment_blobs`, "uploading") before the first byte, so a crash mid-upload leaves something to sweep.
3. The file streams through a transform that counts it, hashes it (SHA-256) and keeps its first 8 KB, and on to storage. Past the limit it stops at once and reading the request stops with it: the limit is the smaller of `ATTACHMENT_MAX_MB` (20) and the room left in the owner's cap (`ATTACHMENTS_PER_ISSUE_MB`, 100, for an issue with its comments, or an article).
4. The type is read from those first bytes (magic numbers, then text and what kind: HTML, SVG, XML), never from the name or the request. The name is made safe: no folders, no control or direction-changing characters, nothing file systems reserve, 200 characters at most. Storage never uses it.
5. One transaction locks the owner's row, checks the cap again (two uploads at once can't both squeeze in), writes the row, marks the blob "stored", touches the issue's `updatedAt` (not its `version`: a file doesn't conflict with an edit to a field) and records `attachment.added`.

If anything fails after the bytes are stored, they're removed; what a crash leaves, the sweeper removes.

**The store** is three calls, `write(key, stream)`, `read(key, range?)` and `remove(key)`, behind `BlobStorage`. Local disk (`DATA_DIR/attachments`) writes to a part file, syncs it, and renames it into place, so a key never holds half a file. Keys are random and sharded by their first two characters.

An S3-compatible store (S3, MinIO, R2) would be one class:

- `write` with `@aws-sdk/lib-storage`'s `Upload`, which streams a body of unknown length as a multipart upload, so memory stays at a few parts; a bucket lifecycle rule aborts multipart uploads left incomplete.
- `read` with `GetObject` and its `Range`; `remove` with `DeleteObject`.
- Config: `ATTACHMENT_STORAGE=s3`, a bucket, an endpoint and a region, credentials from the usual AWS chain.

Downloads would keep coming through a4a, so the access check and the headers stay ours; presigned URLs, with `response-content-disposition` and `response-content-type` set by a4a, are the step after, for large files. The sweeper needs nothing new.

**Serving.** `GET /attachments/{id}/content` reads the project through `services/access.ts`; a hidden one looks like a missing file.

- PNG, JPEG, GIF and WebP come `inline`, so they show in place. Everything else, SVG and HTML included, is an `attachment`, whatever its name says: an HTML page named `cat.png` downloads as `cat.png`, typed `text/html`.
- Every file comes with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox` and `Cross-Origin-Resource-Policy: same-origin`. The page middleware no longer puts the app's own policy over a response that brings one, so an HTML file keeps its sandbox.
- `Cache-Control: private, max-age=86400`, with the SHA-256 as the ETag (`If-None-Match` gets 304): a file's bytes never change under its id, but who may see them can, so only the browser keeps them.

**Cleaning up.** Rows go with their issue, comment, article or project, by cascade or by the sweeper, but bytes don't. The sweeper removes blobs nothing points at: "stored" ones whose row is gone, and "uploading" ones older than six hours. It also removes a deleted comment's files, and part files a crash left. It runs as an outbox consumer after the events that can leave files behind (`attachment.removed`, `issue.deleted`, `comment.deleted`, `article.deleted`), and once when the server starts. It's safe to run anywhere and more than once at a time.

**Retries.** An upload sent again with the same `Idempotency-Key` is replayed. Its body isn't read twice, so the key is matched on the request's length rather than a hash of the body.

- **Costs:** a project's deletion leaves its files until the next sweep. Thumbnails are the images themselves, scaled by the browser.
- **Revisit when:** files are large or many. Make server-side thumbnails then, and serve through presigned URLs.

### D15. The knowledge base: articles per project, ids no issue can have, whole versions, mentions from the outbox

**Per project, no global space.** An article belongs to a project, and the project's access is the article's: when per-project permissions land in `services/access.ts`, the knowledge base follows with no change. A global space would need a second policy of its own (who reads it, who writes it) and a second kind of id. A team that wants documents beyond one project makes a project for them, which costs nothing.

**Ids.** `BACK-A-3`, as YouTrack writes them: numbered per project from a counter row, gap-free and never reused, so a link to an article never comes to mean another.

An article's id can't be read as an issue's, and the reverse:

- Issue ids have no third part, and a project key is at least two characters, so the `A-3` inside `BACK-A-3` is no issue.
- One reading of ids in text, `findRefs` in `@a4a/shared`, serves the web app's links and the server's mentions, so what links is what counts. It leaves out ids in code and in addresses.
- The query and command languages' issue-id parsing refuses `BACK-A-3`; as free text it's a search.

**The tree.** Each article has a parent (or none) and a dense position among its siblings. Changes to a project's tree (creating, moving, deleting) take that project's counter row as a lock, and moving under a descendant is refused by walking up from the new parent. Two moves at once can't make a cycle between them. An article with articles under it can't be deleted: they're moved first.

**Versions.** Every save that changes the title or body writes the whole text as a new version, with who, when, the channel and the token. Diffs are worked out when read (Myers' algorithm, line by line), so a version is never wrong because a diff was. `expectedVersion` gives 409 instead of overwriting a newer save; bringing an old version back saves it as a new one.

**Search.** As for issues: a generated `tsvector` (title weighted A, body B) with prefix matching, and trigram word similarity on titles for near misses, with `ts_headline` snippets whose matches are marked.

**Mentions.** Ids in an article, in an issue's description or in a comment are recorded in `mentions`, with the target as written (`BACK-A-3`), since readable ids are permanent; a mention of an article written before the article exists counts once it does.

- An article's mentions are written in the transaction that saves it.
- An issue's description and its comments are read by an outbox consumer, from the events their write path already records. So `applyChanges` needs to know nothing of the knowledge base.
- The consumer reads the text as it is when it runs, so running twice, or late, lands in the same place.
- A deleted comment's mentions stop counting at once, at read time, before the consumer removes them.

- **Costs:** an issue's new mention of an article shows on the article a few seconds later, after the outbox settles. Issue text from before the knowledge base existed isn't indexed until it's next edited. Versions keep whole texts, which is more space than diffs.
- **Revisit when:** articles are long and edited often. Store diffs between occasional whole versions then.

## Consistency and concurrency

| Concern | Guarantee |
| --- | --- |
| Two people edit one issue | Changes serialise on the issue row. With `expectedVersion`, the second gets 409 and the current version. The web app always sends it and re-reads the issue on 409 |
| Levelling while the plan changes | `expect` (the proposal's starts) makes applying conditional: 409 instead of a different plan than the one agreed |
| Issue numbers | `UPDATE projects SET next_number = next_number + 1 … RETURNING` inside the creating transaction: gap-free per project, safe under concurrency |
| Article numbers and the tree | The project's row in `article_counters`, upserted in the transaction: gap-free numbers, and one change to a project's tree at a time, so no two moves make a cycle |
| Two uploads to a full issue | The issue's (or article's) row is locked while the cap is checked again with the file's real size: one of them gets 413 |
| Files whose rows are gone | A blob record is written before the first byte; the sweeper removes stored bytes nothing points at, and uploads older than six hours that never finished |
| A history entry without its change, or the reverse | Impossible: same transaction |
| Webhooks and triage | At least once, from the outbox, by one worker at a time |
| Retried `POST` | `Idempotency-Key`: the key is claimed before the work, the stored response is replayed, and a key reused with a different body gets 422 |
| Reference data (fields, values, users) | Cached in memory per instance and invalidated after local writes. A generation counter stops a slow reload from overwriting a newer invalidation. Other instances see changes within 60s |

## Security

- **Passwords:** scrypt with a per-user salt.
- **Sessions:** random 256-bit tokens, stored as SHA-256 hashes. The cookie is `HttpOnly; SameSite=Lax`, plus `Secure` behind HTTPS.
- **CSRF:** cookie-authenticated unsafe requests must come from the server's own origin (Origin/Referer check). Bearer-token requests are not CSRF-able.
- **API tokens:** `a4a_` plus 256 random bits, stored as SHA-256 hashes, shown once. Each has scopes, an optional expiry, a last-used time, and can be revoked.
- **Login:** throttled per IP and login.
- **The browser:** strict Content-Security-Policy; no inline script or style; fonts are bundled, nothing loads from outside; Markdown is rendered without raw HTML.
- **Uploaded files:** their type is read from their bytes; only raster images are shown in place; everything else is a download, served with `nosniff`, `Content-Security-Policy: sandbox` and `Cross-Origin-Resource-Policy: same-origin`. Names are made safe, and storage keys are random, so no name reaches the file system.
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
- **Files are on one disk.** Several instances need `DATA_DIR/attachments` on a shared volume until there's an S3 store (D14); back it up with the database.

## Not yet

Planned, with the seams already in place:

- per-project roles, and tokens limited to projects (`services/access.ts`);
- OAuth 2.1 for remote MCP;
- notifications;
- a VCS integration (`BACK-12 #Fixed` in commits);
- `LISTEN/NOTIFY` for multi-instance live events;
- agents as assignees, and tokens issued to a bot user, so an agent can act as itself rather than for a person;
- undo for a change an agent made on its own (the assistant at Acts);
- in the web app: column heads that stay in view on boards with lanes, a chosen window for the load grid, and absences (today a day off is a day of zero capacity).
