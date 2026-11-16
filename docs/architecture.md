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
                 │ worker       webhooks · triage · notifier · SSE ◀─┘                          │
                 │ mail sender  the mail outbox ─────────────────────▶ SMTP (SMTP_URL)          │
  people outside▶│ /help /request  the help desk's public pages (no sign-in)                    │
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

The notifier and the help desk's mail are consumers too (D14, D16), registered like triage (`notify/register.ts`).

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

### D14. Notifications come from the outbox, once per person per event, a burst at a time

People watch what they report, are assigned, comment on or are mentioned in (`@login`), and what they choose to. Watching starts in the transaction that made the change (`applyChanges`, `createIssue`, `updateComment`), not in a consumer, so unwatching right after commenting holds. Unwatching lasts until the person takes part again, as GitHub's does. Agents never watch: they're told only when assigned or mentioned.

The change's activity says what notifications need, as logins, worked out against the issue before the change: `data.assigned` (new assignees), `data.mentions` (people newly mentioned, not those mentioned already), and on deletion `data.watchers`, whose rows go with the issue. Text from a help desk's requester mentions nobody.

The notifier is an outbox consumer (`notify/notifier.ts`). For each event it finds who it concerns, with the strongest reason (`assigned` over `mentioned` over `request` over `watching`), and leaves out whoever acted and whoever can't read the project (`canReadProject`, the seam). Each person's delivery is one transaction:

1. **Once.** `notification_events (user_id, event_id)` is the key. An event the outbox hands over twice, or two instances deliver at once, reaches a person once.
2. **A burst is one.** An unread notification about the same issue, begun within `NOTIFY_WINDOW_SECONDS` of this event (by the events' own times, so a replay folds the same way) and not yet sealed by its email, takes the event under `FOR UPDATE`; otherwise a new one starts. A read one never takes more: what came after you read it is new.
3. **Its email** is queued in the same transaction if the person wants this kind (D15), due when the window has passed.

What a notification shows is its events, read from the activity log, so there's one account of what happened. The inbox lists only projects the reader can still read. Marking read takes `until` (the latest event the reader saw), so what arrived since stays unread.

Watching, reading and email preferences are the person's own, like their tokens: no activity, no webhook, nothing in the issue's history. A viewer may watch what they can read; a token needs `write` to change any of it, and `read` to see the inbox.

The unread count is live: the notifier tells this process's open streams (`GET /notifications/stream`), and each stream also counts again every 15 seconds for what other instances delivered.

- **Costs:** a row per person per event in `notification_events`; read notifications are kept 180 days.
- **Revisit when:** a team wants per-project or per-kind subscriptions. Today it's per issue, plus the email level.

### D15. Mail is an outbox too: rendered when sent, at least once

Mail is a row in `mail_outbox` first, written in the transaction that calls for it, with a `dedupe_key` that makes queueing idempotent: one mail per notification, per person per digest day, per help desk event. Without `SMTP_URL` nothing is queued and nothing is sent; no request ever waits on SMTP.

- **Sending.** A sender (`MailWorker`, one per process) claims a few due rows with `FOR UPDATE SKIP LOCKED` and a two-minute lease, so instances never send one at once, and a sender that dies loses its lease to another. At least once: a crash after the server accepted a mail sends it again, under the same `Message-ID`, so clients show one.
- **Retries.** A failure waits 1, 5 and 15 minutes, then 1, 3, 6 and 12 hours, then gives up; a permanent refusal (SMTP 5xx) gives up at once.
- **Rendered when sent,** from the row's payload, so a mail says what is true then: a notification's email seals it first (it takes no more events), and isn't sent if it was read in the app meanwhile, or the person no longer wants that kind. A digest with nothing unread isn't sent.
- **Plain text and simple HTML,** the same lines, the HTML escaped, links only: no images, scripts or styles, nothing loaded. What people wrote is quoted as written, never rendered.
- **Unsubscribe** is one click per kind (RFC 8058: `List-Unsubscribe` and `List-Unsubscribe-Post`), signed with HMAC-SHA256 by a key kept in settings (`notifySecret`), checked in constant time. Email levels nest (`all`, `direct`, `none`), so stopping the emails about watched issues leaves mentions and assignments. Opening the link changes nothing (scanners open links); the page's button, or the client's POST, does.
- **Threading.** Mail about one issue references `<issue-…@host>`; a help desk request's, its confirmation.
- **Why nodemailer:** it is the SMTP client for Node, with pooling, TLS and the RFC details right, and nothing else in the stack does SMTP. Tests run it against a real SMTP server (`smtp-server`).
- **Costs:** a mail can go twice after a crash; sent mail is kept 30 days.
- **Revisit when:** volume needs a provider's API (SES, Postmark). That is another transport behind the same outbox.

### D16. A help desk for people who aren't users

A project can open a help desk: a public form at `/help/<KEY>` that files an issue, and a page per request (`/request#<token>`) where the requester follows the public conversation and answers it.

- **A requester isn't a user.** They're a row of their own (`requesters`: email and name), so they can't sign in, never appear among people to assign or mention, and can be found and forgotten by email. Their issue is reported by the `helpdesk` agent through the `helpdesk` channel, and its history names them. The help desk acts with an elevated system context, in the one project whose help desk is open.
- **Tracking tokens are hashed, and minted as they're sent.** Each email to the requester carries a fresh 256-bit token, made while the email is rendered and kept only as its SHA-256 hash, so no token waits in plain text, in the outbox or anywhere; one minted for a failed attempt is deleted. Every token stays good for the request. Only without SMTP does the form's answer carry one, once, since no email will. In a link the token sits in the fragment; to the API, in a header.
- **Comments are internal unless made public.** A comment's `visibility` is `internal` by default, on every channel; `public` is allowed only on a request, and is the only thing the requester's page and email show. The requester's own replies are public comments by the `helpdesk` agent, with `requester_id`, and tell the issue's watchers. The project's lead watches each new request and is told of it (`request`).
- **The first-response target** is per project, in hours round the clock; the deadline in force when a request was filed is kept on it. The first public reply from the team answers it, and so does resolving it without one; it's worked out when read (`slaOf`, and the same in SQL for `sla:`), so nothing has to be updated when a reply comes.
- **Public routes reveal nothing beyond the one request,** and answer alike whether a project, request or token is missing or just not theirs. The form's posts need an `Origin` of this server and a signed form token tied to a `SameSite=Strict` cookie; anything anonymous may post is small (body limits), limited per address, per email and per help desk, and a hidden field catches bots. Turning the help desk off closes the form; requests already filed keep their pages.
- **Costs:** no captcha, no proof the email is the requester's, limits per instance (docs/mcp-and-api.md, 8a); first-response hours count round the clock, not working hours.
- **Revisit when:** a desk gets spam a honeypot doesn't stop (add a captcha), or requesters want to reply by email (inbound mail into the same reply path).

## Consistency and concurrency

| Concern | Guarantee |
| --- | --- |
| Two people edit one issue | Changes serialise on the issue row. With `expectedVersion`, the second gets 409 and the current version. The web app always sends it and re-reads the issue on 409 |
| Levelling while the plan changes | `expect` (the proposal's starts) makes applying conditional: 409 instead of a different plan than the one agreed |
| Issue numbers | `UPDATE projects SET next_number = next_number + 1 … RETURNING` inside the creating transaction: gap-free per project, safe under concurrency |
| A history entry without its change, or the reverse | Impossible: same transaction |
| Webhooks and triage | At least once, from the outbox, by one worker at a time |
| Notifications | At least once in, once out: `notification_events` keys each person's events, so a redelivered event reaches nobody twice. Folding into an unread notification and its email sealing it are serialised on the notification's row |
| Mail | At least once, idempotent per notification, digest day and help desk event (`dedupe_key`); claimed with `SKIP LOCKED` and a lease, so two senders never send one at once |
| Unwatching just after commenting | Holds: watching starts in the change's own transaction, not later in a consumer |
| Retried `POST` | `Idempotency-Key`: the key is claimed before the work, the stored response is replayed, and a key reused with a different body gets 422 |
| Reference data (fields, values, users) | Cached in memory per instance and invalidated after local writes. A generation counter stops a slow reload from overwriting a newer invalidation. Other instances see changes within 60s |

## Security

- **Passwords:** scrypt with a per-user salt.
- **Sessions:** random 256-bit tokens, stored as SHA-256 hashes. The cookie is `HttpOnly; SameSite=Lax`, plus `Secure` behind HTTPS.
- **CSRF:** cookie-authenticated unsafe requests must come from the server's own origin (Origin/Referer check). Bearer-token requests are not CSRF-able.
- **API tokens:** `a4a_` plus 256 random bits, stored as SHA-256 hashes, shown once. Each has scopes, an optional expiry, a last-used time, and can be revoked.
- **Login:** throttled per IP and login.
- **The browser:** strict Content-Security-Policy; no inline script or style; fonts are bundled, nothing loads from outside; Markdown is rendered without raw HTML.
- **Webhooks:** signed with HMAC-SHA256 over the raw body. Only admins can create them, because the server will POST to the URL given (server-side request forgery to internal addresses is the admin's call).
- **Email:** unsubscribe links are signed (HMAC-SHA256, a key in settings) and checked in constant time; they only ever stop email. HTML email carries no images, scripts or styles, and quotes what people wrote as written.
- **The help desk:** its public routes need no sign-in and reveal nothing beyond one request (D16); tracking tokens are hashed; its form has a CSRF token tied to a `SameSite=Strict` cookie and an Origin check; anonymous posts are size-limited and rate-limited, and a hidden field catches bots. docs/mcp-and-api.md (8a) says what's missing.
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
- the help desk by email (replies by mail), and a captcha for its form;
- per-project subscriptions, and per-person time zones for the digest;
- a VCS integration (`BACK-12 #Fixed` in commits);
- `LISTEN/NOTIFY` for multi-instance live events;
- agents as assignees, and tokens issued to a bot user, so an agent can act as itself rather than for a person;
- undo for a change an agent made on its own (the assistant at Acts);
- in the web app: column heads that stay in view on boards with lanes, a chosen window for the load grid, and absences (today a day off is a day of zero capacity).
