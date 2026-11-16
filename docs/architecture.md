# Architecture

This is how a4a is put together, and why. Each decision says what it costs and when to revisit it, so the next change can argue with it instead of guessing.

## The system

```text
                 ┌──────────── each instance (one, or several behind a proxy: D17) ─────────────┐
  browser ──────▶│ /            web UI (React SPA, Ocean)            static files, strict CSP   │
  scripts ──────▶│ /api/v1/*    REST + OpenAPI (Hono, zod)  ─┐                                   │
  MCP clients ──▶│ /mcp         MCP, Streamable HTTP          ├─▶ services ──▶ Postgres / PGlite│
  stdio clients ─│  (a4a-mcp bridge ─▶ /mcp)            │      ▲  │                         │
                 │ assistant    Claude tool loop ─────────────┘      │  └─▶ activities (outbox)  │
                 │ worker       webhooks · rules · triage · notifier · SSE ◀─┘                  │
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

- **Costs:** PGlite has one connection and runs in-process, so it is for development, demos and a single team, not for load. It is also one process: a lock file stops a second one from opening its directory. Several instances need Postgres (D17).
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

- holds a lease in `worker_leases`, so exactly one instance delivers webhooks and runs triage (D17 says how the lease stays single);
- keeps a cursor per consumer in `outbox_cursors`, and advances it only after it handled the rows;
- reads the log in id order, never past a row that may still commit (D17);
- is woken by a commit on any instance (the in-process bus here, `NOTIFY` from the others), and polls every 2 seconds otherwise.

Delivery is **at least once**. Webhook receivers dedupe on the event `id` in the payload and the `X-A4A-Event-Id` header.

- **Costs:** a webhook can arrive twice when the lease changes hands mid-event: the old holder's last event, handled again by the new one from the saved cursor.
- **Revisit when:** one instance can't keep up with the consumers. Then split them by consumer, each with its own lease.

The notifier and the help desk's mail are consumers too (D22, D24), registered like triage (`notify/register.ts`).

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

All project visibility goes through one module (`services/access.ts`): see D15 for what it decides.

### D8. MCP is a curated tool layer, shared with the assistant

`tools/` defines about 20 task-shaped tools once, each with:

- a zod schema;
- a handler over the services;
- MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`);
- an Ocean grammar tag (`reads`, `changes`) used by the UI.

The MCP server registers them, and the in-app assistant gives the same ones to Claude. Results are compact text and JSON with readable ids, sized for an agent's context.

The transport is stateless Streamable HTTP: a new `McpServer` per request, authenticated by bearer token. Nothing to sticky-route, and it restarts safely.

There are no deletes over MCP. Bulk commands are capped at 50 issues and have `dry_run`.

### D9. AI: Claude first, guarded

All AI calls go through `ai/client.ts`.

**Model and SDK**

- The model is `claude-opus-5-5` (override with `AI_MODEL`), via the official `@anthropic-ai/sdk`. Other services that speak the same API get the portable subset of each request (D14).
- Calls use the beta Messages API with server-side refusal fallbacks (`fallbacks: "default"`), so a false-positive classifier decline doesn't become an outage.

**Structured features (triage, query from words, command from words)**

- They use structured outputs (elsewhere, a forced tool call: D14), with schemas built per project, so enum values are exactly the project's own.
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
- A plan with no start date of its own begins at its earliest task's Start date. Written, the levelled starts could become that date and take every undated task with them. When they would, applying also sets the plan's start where it began, in the same transaction, and the proposal says so beforehand (`keepsStart`).
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

### D14. Other models get the portable subset

a4a is built for Claude and gets every feature from it. It also runs on services that speak Anthropic's Messages API: DeepSeek, Qwen, or another with `AI_PROVIDER=compatible`. They go through the same SDK and the same code; the provider changes the request, not the features.

- **One path.** Triage, the assistant and the rest use one client and one tool loop whoever serves them, so a live run on any provider exercises the code Claude runs. A second SDK would have been a second path that no Claude test touches.
- **What's left out elsewhere:** Claude's own request features, namely refusal fallbacks, thinking shown as progress notes, automatic caching and structured outputs. The rest is the portable API: tools, streaming, adaptive thinking and effort.
- **Structured answers come by tool.** DeepSeek accepts structured outputs and ignores them, answering in prose. So elsewhere, the answer is the input of a tool the model must call.
  - It is checked against the same zod schema, with one repair round in plain words ("reason: missing").
  - Thinking is off for these calls: DeepSeek refuses a forced tool while thinking, and they are classifications.
  - Qwen leaves out a key whose answer is null. The schema requires the key and allows null, so the null is put back before checking.
- **Raw reasoning stays out of sight.** Another service's thinking is its raw reasoning, not notes written to be read. It is stored, to send back on the next turn, and never shown.
- **Thinking is bound to its model.** A conversation records the provider and model its thinking came from. When either changes, the stored thinking is dropped once, as when the prompt changes.
- **Chosen, never inferred.** The AI sends issue text to whoever serves it.
  - `AI_PROVIDER` names the provider, whatever keys are set.
  - A mistake there turns the AI off and says why (`GET /ai/status`); the tracker keeps working.
  - A key is passed only to its own service. The SDK then reads no Anthropic key from the environment, so none is sent elsewhere (tested).
  - The assistant's facts show who it runs on.
- **Tested live.** `pnpm --filter @a4a/server test:live` runs every AI feature against the configured provider, on the demo data, and checks what must hold whatever the wording. CI runs it on `main` for each provider whose key is a repository secret. On DeepSeek V4 Pro and Qwen 3.8 Max it found the faults above, and three in a4a itself:
  - a command that repeated its own comment posted it twice;
  - an issue id in a command got a generic problem with no fix (now named, with a fix that takes it out, D13);
  - the command guide's inline `comment` clause invited the model to put the comment in both places (an inline comment now moves to the comment field).
### D15. Projects have their own people; what you can't see doesn't exist

Every project is **open** (everyone works in it) or **members only** (only its people and administrators see it at all). Its people have roles:

| Role | May |
| --- | --- |
| viewer | read its issues, and comment |
| member | also change its issues: fields, links, work, sprints, levelling |
| manager | also change its settings, fields, people, visibility, boards and baselines |

- **Someone's role in a project** is, in order: manager if they're an administrator or its lead; otherwise the highest of the role the project gives them and the roles it gives groups they're in (D27); otherwise member, if it is open. So an open project can still keep someone to reading, by naming them a viewer, and the lead can never lock themselves out.
- **Scopes still cap it.** Reading needs `read`; commenting, changing issues and managing need `write`. A read-only account or token never writes, whatever its role in a project.
- **Commenting counts as a write** for scopes (it changes the record, notifies, fires webhooks), but a viewer's role is enough for it. A manager may change or delete anyone's comment in their project.
- **A link needs write access to both ends**, because it shows on both issues and changes both histories. Its other end must be visible to be named at all.
- **People set in a user field** (an assignee) of a members-only project must be able to see it.
- **Boards span projects.** A board is visible when one of its projects is, and shows only the issues and values of the projects the viewer can see. Changing a board or its sprints is for managers of all its projects; putting an issue in a sprint is work on the issue (a member).
- **Tokens can be limited to projects.** Their access is the person's access to those projects only. A limited token can't hold the admin scope (administration reaches every project), and can only make tokens as limited as itself, with no more scopes.

**Not found, not forbidden.** A project, issue, comment, link, board, sprint, baseline or suggestion the caller can't see answers 404 in the very words used for one that doesn't exist; the query language calls a hidden project an unknown word, as it does a misspelt one, and offers no "did you mean". Only what the caller can see but may not change answers 403, and says who can.

**How it is enforced.** Services ask the seam; no route or tool decides:

- `projectAccess(ctx)` works out, in one query, the caller's role in every project. A request keeps it for two seconds at most, or until something on this instance changes it (`accessChanged`), so a long-lived context (an SSE stream, the worker) sees changes, and someone taken off a project loses it at once.
- `assertCanReadProject` / `assertCanCommentProject` / `assertCanWriteProject` / `assertCanManageProject`, `requireProject(ctx, key, need)`, and `visibleProjectIds` for searches.
- `visibleSchema(ctx)` is the reference data as the caller sees it: the query language, completion and every prompt to Claude are built from it, so a hidden project's name and its own values never reach them.
- The event feed and issue history filter in SQL (`eventsVisibleSql`), so pages stay full and a consumer's cursor never stalls behind events it can't see. Link events are dropped when their other end is hidden. SSE checks each event as it is sent.
- Triage offers Claude possible duplicates only from projects every reader of the issue can see (its own, and open ones), and every suggestion is filtered again as it is read, because visibility can change after it was made.
- `projectRolesOf(db, projectId, userIds)` answers who can see a project, for whoever decides whom to tell or assign.

- **Costs:** one small query per request; every list that names other issues (links, events, suggestions, boards) filters as it reads.
- **Not done:** tags stay instance-wide, so a tag's name is seen by everyone; a webhook delivers everything (only administrators make them).
- **Groups** came as this section planned (D27): a `project_group_roles` table joins the same query, and the rest stayed as it was.

### D16. Single sign-on with OpenID Connect, through openid-client

People can sign in with their organisation's identity provider: the authorization code flow with PKCE (S256), a state and a nonce, configured from `OIDC_*` in the environment.

**The choice: `openid-client` (v6), not `jose` and our own code.** Both are by the same author; `jose` would do the cryptography well, but the protocol around it would be ours: discovery and its issuer check, building the request, the token request and client authentication, RFC 9207's `iss`, the order and meaning of every claim check. openid-client is certified by the OpenID Foundation for the relying-party profiles, and turns the flow into a few calls that each check what the specification says. What is left to a4a (about 300 lines, with its routes) is mostly deciding who someone is. One default had to change: for an ID token received straight from the token endpoint, openid-client relies on TLS and doesn't check the signature; a4a turns that check on (`enableNonRepudiationChecks`), so the token's signature is verified against the provider's keys, as well as its issuer, audience, expiry and nonce. The tests sign tokens with `jose` in a provider made for them.

- **The redirect URI** is `PUBLIC_URL/api/v1/auth/oidc/callback`, sent the same at both steps; nothing in a request chooses it, and the URL handed to the library is built from it, not from the request's Host.
- **The state** is bound to the browser that started (an HttpOnly cookie) and stored with the PKCE verifier and nonce, keyed by its hash, for ten minutes. The callback takes the row (a `DELETE … RETURNING`), so a state works once.
- **Who someone is:** found by the provider's issuer and subject (`user_identities`). The first time, by email only when the provider says `email_verified: true`, and only to an account whose own email an administrator set or a provider verified (`users.email_verified`). An email people type for themselves never links: otherwise anyone could claim an address before its owner first signs in. An account already linked to another subject at the same provider isn't taken over by a second one with the same email (a reused address).
- **Optionally:** allowed email domains, accounts made on first sign-in, and password sign-in turned off (only while single sign-on is on).
- **Each sign-in starts a new session**, and ends the one the browser had.

- **Costs:** a provider's keys are cached; one that rotates a key under the same key id fails sign-ins until the cache expires (ten minutes). Back-channel logout and SCIM are not done: an account removed at the provider keeps its a4a sessions until they expire, or until an administrator bans it.
- **Revisit when:** several providers are needed (the table already keys identities by provider).

**OAuth for remote MCP** is D28: a4a is the authorization server for `/mcp`, and signs the person in on the way with a password or this single sign-on.

### D17. Several instances on one Postgres behave as one

a4a runs as one process or as several behind a load balancer, on one Postgres, and behaves the same either way. Nothing is sticky: any instance can serve any request. What was per process is now shared, or is per process on purpose:

| What | How |
| --- | --- |
| Live events (SSE) | Each instance reads the activity log in id order and hands every event to its streams once. After commit, the writer sends `NOTIFY a4a_events` with the new ids (ids, never data), so the others read within milliseconds |
| The reference-data cache | `NOTIFY a4a_schema` after a change. A change inside a transaction (a tag created with an issue) is sent in it, so it arrives on commit and never on rollback. The 60-second reload stays as the safety net |
| The sign-in throttle | One table, `login_throttle`: a row per IP and per login, one upsert per attempt |
| The outbox worker | One lease row, on the database's clock |
| Sessions, tokens, idempotency keys, webhook deliveries | Already rows in Postgres; checked below |
| General rate limits | Per instance, on purpose; below |
| Migrations, defaults, the first administrator | Under an advisory lock, one instance at a time, so replicas starting together on an empty database don't race |

**Reading the log in order.** Ids come from a sequence at insert, but transactions commit in their own order: 41 can become visible after 42, and an id taken by a transaction that rolls back never appears. A reader that moved past 41 when it saw 42 would never send it, and a client resuming "after 42" would miss it. Before, the worker and the tail took only rows older than 3 seconds and moved past anything missing, so a transaction that took longer lost its events for good. Now the live feed and the worker stop at a missing id, and pass it once it can no longer appear: every transaction that was writing to the log when the gap was seen has ended.

- Postgres's lock table says which those are: an insert holds a lock on `activities` from before it takes its id (the lock comes with parsing, the id with executing) until its transaction ends. Unrelated work, even a session left open, doesn't count.
- `pg_current_snapshot()` would not do: its list of running transactions leaves out one whose id is newer than every finished one, which is just the one that took the missing id last.
- A rolled-back id holds live events for about a tenth of a second, until the next read.
- A gap held for a minute is passed with a warning, so a transaction left open after writing to the log can't stall it. Its event stays in `GET /events`.

**Signals are doorbells.** A notification only says "look"; every reader works from the log and its own cursor. That is also the dedupe: an event is sent only when it is the next id after the cursor, so the bus, `NOTIFY`, a reconnect and the backstop can all wake the feed without anything being sent twice. And it makes a lost notification cheap, which matters, since `NOTIFY` is not durable:

- Each instance listens on a connection of its own. After a reconnect it tells every reader to catch up from the log.
- That connection pings itself every 30 seconds, and reconnects when its own notification doesn't come back: a network path that died without an error, or a pooler in transaction mode, which drops `LISTEN` (point `DATABASE_LISTEN_URL` past it).
- **The polling tail stays, as a backstop**, every 10 seconds instead of 3. It covers what the two above don't: a process that died between its commit and its `NOTIFY`, or a write path that forgot to publish. It costs one indexed read per instance every 10 seconds that usually finds nothing, and it bounds the worst case at 10 seconds instead of "until the next event".

**Resuming a stream.** Each frame's `id` is its event's id. Since every instance sends events in id order, it is a true watermark: everything up to it was sent, or never existed. A client that reconnects, to any instance, sends it back (`Last-Event-ID`, which browsers send by themselves, or `?after=`), and the stream replays the log after it before going live. Past 1000 missed events it sends `resync` instead, with the id to go on from: re-read, or page through `GET /events`. An instance that shuts down ends its streams, so their clients reconnect elsewhere and resume.

**The worker lease.** One row in `worker_leases`, taken with one upsert that succeeds for the holder, or for anyone once the lease has expired.

- Its times are the database's (`now()`), never an instance's, so instances whose clocks disagree can't both believe they hold it. Before, each side compared its own clock.
- The holder renews it on every pass, and every 10 seconds while a consumer is busy. Before, a webhook with its retries (up to 35 seconds) outlived the 30-second lease, and a second instance started the same work.
- The holder stops handing out events once its own deadline passes without a renewal, and a cursor moves only while the lease is still the holder's in the database. So a holder that stalled can't move its successor's cursor.
- A holder that stops cleanly releases the lease, after at most 5 seconds for the event in hand, and the next instance takes it at its next poll. One that dies is replaced within the lease (30 seconds) plus one poll (2 seconds).
- Periodic upkeep (expired sessions, sign-in windows that have passed) runs on the holder, so it runs once.

**The sign-in throttle.** Failures count per IP (50 per 15 minutes) and per login (10), in a fixed window, with one upsert for both rows.

- An attempt is counted before the password is checked, so parallel guesses on several instances can't slip past the limit between a check and a write. A correct password takes its count back.
- A fixed window lets twice the limit straddle a window's edge. The average holds, and a sliding window would need a second count per row for little gain.
- The price of a per-login limit: someone who knows a login can keep it locked by failing ten times a window. Its owner waits for the window, as the 429 says.

**General rate limits stay per instance.** A shared limit would add a write, to a hot row per caller, to every request. That would be the most frequent write in the system, to guard capacity that is per instance anyway: a runaway script exhausts the instance it hits, not the cluster. These limits are not a security boundary; the sign-in throttle, which guards accounts, is shared. Behind N instances a client gets between one and N times the limit (`API_RATE_LIMIT`, 1200 a minute; `MCP_RATE_LIMIT`, 600). Set them to each instance's share, or limit at the proxy when one number must hold.

**Client addresses.** Behind a proxy, every request comes from the proxy, and `X-Forwarded-For` is whatever the client sent plus what the proxies added. `TRUST_PROXY` says how many proxies append to it; the client is the entry the outermost one added. With 0, the default, the header is ignored. Before, its first entry was trusted, so a client could choose its own address and walk around the per-IP limits.

**Checked, and right already.** Sessions and tokens are rows: a session made on one instance works on all, and signing out ends it everywhere. An `Idempotency-Key` is claimed by inserting its primary key, so two instances can't both run it, and a retry on the other instance replays the answer. One gap was there: a claim left by an instance that died mid-request answered 409 for a day; it can now be claimed again after 5 minutes. Webhooks are delivered by the lease holder only.

- **Costs:** each instance holds its pool plus one `LISTEN` connection, and reads the log once per write anywhere (one indexed read). A rolled-back id holds live events for about a tenth of a second, and an event waits for a slower, concurrent commit before it: ordered delivery is what makes resuming exact.
- **Revisit when:** writes reach hundreds a second, where every instance reading every write adds up; fan out from one reader then. Or when one number must limit every request: use the proxy's limiter or a shared store.

### D18. Files stream to a small store, and come back as downloads

Files sit on issues, on comments (the author's own) and on knowledge base articles.

**Uploading.** An upload is `multipart/form-data`, read as a stream (busboy) and never held whole in memory:

1. Who may put a file there is settled before a byte of it is read.
2. A record of the storage key is written (`attachment_blobs`, "uploading") before the first byte, so a crash mid-upload leaves something to sweep.
3. The file streams through a transform that counts it, hashes it (SHA-256) and keeps its first 8 KB, and on to storage. Past the limit it stops at once and reading the request stops with it: the limit is the smaller of `ATTACHMENT_MAX_MB` (20) and the room left in the owner's cap (`ATTACHMENTS_PER_ISSUE_MB`, 100, for an issue with its comments, or an article).
4. The type is read from those first bytes (magic numbers, then text and what kind: HTML, SVG, XML), never from the name or the request. The name is made safe: no folders, no control or direction-changing characters, nothing file systems reserve, 200 characters at most. Storage never uses it.
5. One transaction locks the owner's row, checks the cap again (two uploads at once can't both squeeze in), writes the row, marks the blob "stored", touches the issue's `updatedAt` (not its `version`: a file doesn't conflict with an edit to a field) and records `attachment.added`.

If anything fails after the bytes are stored, they're removed; what a crash leaves, the sweeper removes.

**The store** is three calls, `write(key, stream)`, `read(key, range?)` and `remove(key)`, behind `BlobStorage`. Local disk (`DATA_DIR/attachments`) writes to a part file, syncs it, and renames it into place, so a key never holds half a file. Keys are random and sharded by their first two characters.

An S3-compatible store (S3, MinIO, R2) is one class, `ATTACHMENT_STORAGE=s3` (D35):

- `write` with `@aws-sdk/lib-storage`'s `Upload`, which streams a body of unknown length as a multipart upload, so memory stays at a few parts.
- `read` with `GetObject` and its `Range`; `remove` with `DeleteObject`.
- Config: a bucket, an endpoint and a region, and keys or the usual AWS chain.

Downloads keep coming through a4a, so the access check and the headers stay ours; presigned URLs, with `response-content-disposition` and `response-content-type` set by a4a, are the step after, for large files. The sweeper also aborts multipart uploads left unfinished.

**Serving.** `GET /attachments/{id}/content` reads the project through `services/access.ts`; a hidden one looks like a missing file.

- PNG, JPEG, GIF and WebP come `inline`, so they show in place. Everything else, SVG and HTML included, is an `attachment`, whatever its name says: an HTML page named `cat.png` downloads as `cat.png`, typed `text/html`.
- Every file comes with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox` and `Cross-Origin-Resource-Policy: same-origin`. The page middleware no longer puts the app's own policy over a response that brings one, so an HTML file keeps its sandbox.
- `Cache-Control: private, max-age=86400`, with the SHA-256 as the ETag (`If-None-Match` gets 304): a file's bytes never change under its id, but who may see them can, so only the browser keeps them.

**Cleaning up.** Rows go with their issue, comment, article or project, by cascade or by the sweeper, but bytes don't. The sweeper removes blobs nothing points at: "stored" ones whose row is gone, and "uploading" ones older than six hours. It also removes a deleted comment's files, and part files a crash left. It runs as an outbox consumer after the events that can leave files behind (`attachment.removed`, `issue.deleted`, `comment.deleted`, `article.deleted`), and once when the server starts. It's safe to run anywhere and more than once at a time.

**Retries.** An upload sent again with the same `Idempotency-Key` is replayed. Its body isn't read twice, so the key is matched on the request's length rather than a hash of the body.

- **Costs:** a project's deletion leaves its files until the next sweep. Thumbnails are the images themselves, scaled by the browser.
- **Revisit when:** files are large or many. Make server-side thumbnails then, and serve through presigned URLs.

### D19. The knowledge base: articles per project, ids no issue can have, whole versions, mentions from the outbox

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

### D20. End-to-end tests run the production build, with the AI stood in for in the browser

`apps/web/e2e` drives Chromium against what ships: the built server serving the built UI, under its real CSP, on a fresh embedded database with the demo data. A dev server would hide what only the build does (the CSP over every page, the bundled assets, the server serving them).

- **Isolation by data, not by server.** One server per run; each spec file makes its own projects, boards and people, with keys no other file or retry has, so files run in parallel. Specs that only read (the tour) hold the live feed, so other specs' writes can't redraw a page mid-check.
- **Two administrators**, one taking the tour and one for the flows, because the server allows each person 1200 API requests a minute, and the two together came to about 900 on four workers. The limit (`API_RATE_LIMIT`) is held at its default rather than raised, so a page that starts asking too much shows up as a 429 in its console.
- **People of their own** for what a role changes: a spec makes the person, gives them their role, and signs in as them, so the administrators' sessions are never the ones signed out or kept out.
- **What happens meanwhile** is made real: a spec changes an issue or a plan through the API between a page reading and saving, with the page's live feed held, to get the 409s people would get.
- **Callers from outside come without a cookie.** A delivery from GitHub is sent from a request context of its own, signed as GitHub signs it: the page's own requests carry the session, and a cookie-authenticated POST with no Origin is refused as CSRF (403), which GitHub never meets.
- **AI is answered in the browser** (`page.route`), typed by the contract, because the server has no key in CI and the model's answers aren't the UI's to test. The server's AI is tested in vitest with a fake client.
- **Every page is watched**: a console error or a CSP violation fails the test, unless the test names the one it provokes. The page's clock is fixed at the run's start.
- **Costs:** it needs `pnpm build` first (the script does it), and it can't catch what only the real model does.
- **Revisit when:** a run takes more than a few minutes. Shard it across CI machines (`--shard`), each with a server of its own.

### D21. Reports read the history; imports are known by the other tracker's key

**Reports are worked out from the activity log when asked, with no snapshot table.** Every change to an issue is already an activity, in the transaction that made it (D4, D5), and each carries the issue as it stood after it (readable id, summary, state, resolved) with the fields it changed. A report loads the events of the issues in its scope, oldest first, rebuilds each issue's timeline (when it existed, its state and estimate at each instant, when it joined or left a sprint) and reads the timelines at each day's end (`reports/history.ts`, `reports/engine.ts`, pure and tested on hand-made histories).

- **Which issues:** a project's, those of every project the caller can see, or what a query matches now. By project, a deleted issue counts on the days it existed: its activities keep its readable id when it goes (the foreign key is set null). By query, deleted issues are out, since a query matches only what is there; the report says which it did (`includesDeleted`).
- **Days** begin and end in a time zone: the caller's (`timeZone`; the web app sends the browser's), or the server's. A day's figure is how things stood at its end, so an event at exactly midnight belongs to the day it begins. Today is as it is now; days to come are null, not zero. A change at 23:30 UTC is on the next day in Berlin, and the tests say so.
- **A sprint's membership is history too:** `sprint.issue_added` and `sprint.issue_removed`, recorded in the transaction that changes it. Issues in a sprint from before those events existed count from its start, and the report says so. What was committed is what was in the sprint, open, at the start of its first working day; a change on a weekend belongs to the next working day. How it stands compares what's left with the ideal as today began, within 10% (and at least an issue, or an hour).
- **Cycle time** runs from an issue's first entry into a start state (In Progress unless told otherwise) to its final resolution, in calendar days, with percentiles by nearest rank. One resolved without ever starting is listed apart, not counted; one reopened counts to its last resolution.
- **Imported issues** start at their original creation, in the project's first open state until they were resolved, so a report reads the time before the import as it was.

**Why no snapshot table.** A row per issue per day would make each report a read of a few rows, but it would be a second record of the truth: written by a job, wrong for a day the job missed, cut in one time zone, and to be rebuilt whenever a state is renamed or an issue moves. The log already is the truth. Taking only the parts of each payload a report reads, in SQL (`payload->'issue'->>'state'` and the like), and estimates only for a burndown, keeps it fast: on in-memory PGlite, 90 days of cumulative flow or cycle time over 3,000 issues and 12,000 events takes about 220 ms (a test holds it under a bound). One partial index, `activities_sprint` on `(payload->'data'->>'sprintId', id)` for the two sprint events, finds a sprint's history without a scan. A report past 400,000 events asks for a narrower scope instead of working for minutes.

- **Access:** a report counts only the projects the caller can see, and naming a hidden one is the error for a missing one (D15). A burndown counts the sprint's issues in the projects the caller can see, as the board shows them; a sprint on a board none of whose projects they see is a missing sprint.
- **Costs:** a report costs what the history of its issues costs, not what the days asked for cost.
- **Revisit when:** a scope's history runs to millions of events. Then keep a row per issue per day, written from the outbox by the worker (the timelines are the code to write it with), and read reports from it.

**Dashboards** are rows (`dashboards`: owner, name, shared, widgets as JSON, version, changed with `expectedVersion`). A widget keeps its parameters, never its figures: it is worked out for whoever looks, under their access. A shared dashboard shows each viewer only the widgets that name what they can see, by the rule shared saved searches follow (a query that names a project or value they can't see), so its owner's words never give a hidden project away; its owner and administrators see it whole. A private one is its owner's alone, and answers as a missing one to anyone else, administrators included. Someone with none gets a default, worked out and not saved: their open issues, a current sprint they can see, created against resolved, and cycle time.

**Imports** take a Jira or YouTrack CSV export into a project.

- **The file is parsed as it streams** (RFC 4180: quoted fields, doubled quotes, newlines inside quotes, CRLF, LF or CR, a BOM; split anywhere between chunks; 64 MB and 50,000 rows at most) into `import_rows`, with each column's samples and distinct values, so mapping never reads the file again. Columns are found from Jira's and YouTrack's headers (repeated ones, such as Labels or Comment, too), values by name and synonym, people by email, then login, then name; a person maps the rest, and leaving a value unmapped says what it means ("Unassigned", "The project's default, Open").
- **Known by the other tracker's key.** `external_issues` maps (project, source, key) to the issue, with the values the import last wrote. A rerun changes a field only where the export changed it since, so an edit made here to a field the export didn't change stays; it skips a row that didn't change, and never makes an issue twice (two runs racing meet the key's primary key).
- **History as it was.** An issue keeps its created and updated dates and its reporter, and its `issue.created` says it was imported (`data.imported`: source, key, original dates), as do its comments and work. Triage, notifications (D22), rules on a change and guards (D25) leave them alone: an import brings history in, and isn't a change happening now. Only the importer can set those, through `createIssueInTx`'s import option: no request can.
- **A dry run changes nothing:** the same reading and checks as a run, with the problems row by row and what applies to many rows said once.
- **The run is a job:** one per project at a time, claimed by a conditional update, each row in its own transaction, then links and parents in a second pass by key, so a row can name one later in the file. Its progress and heartbeat are on its row, so every instance shows it; one whose heartbeat has stopped for a minute (its instance died) reads as stopped, and running it again carries on, since rows done already are matched by key.
- **Undo** deletes, in one transaction, the issues the import made that nobody has touched since (no activity but the import's), and says why it keeps each of the others. It doesn't take back what it changed on issues that were already here: that would write old values over what happened since.
- **Who:** importing writes history as others made it, so it is managing the project: its managers, and administrators. In a members-only project, only its people can be its reporters, assignees and comment authors; anyone else in the file is left empty, and choosing them is refused.

- **Costs:** an upload is kept as rows until it is forgotten (`DELETE /imports/{id}`), about the file's size again.
- **Revisit when:** a YouTrack REST importer is wanted (not done): it would fill the same rows from the API instead of a file, and the rest stays.

### D22. Notifications come from the outbox, once per person per event, a burst at a time

People watch what they report, are assigned, comment on or are mentioned in (`@login`), and what they choose to. Watching starts in the transaction that made the change (`applyChanges`, `createIssue`, `updateComment`), not in a consumer, so unwatching right after commenting holds. Unwatching lasts until the person takes part again, as GitHub's does. Agents never watch: they're told only when assigned or mentioned. Watchers hear of changes, comments, links and files on the issue (a comment's own files go with the comment), and of its deletion.

The change's activity says what notifications need, as logins, worked out against the issue before the change: `data.assigned` (new assignees), `data.mentions` (people newly mentioned, not those mentioned already), and on deletion `data.watchers`, whose rows go with the issue. Text from a help desk's requester mentions nobody.

The notifier is an outbox consumer (`notify/notifier.ts`). For each event it finds who it concerns, with the strongest reason (`assigned` over `mentioned` over `request` over `watching` over `subscribed`, D31), and leaves out whoever acted and whoever can't see the project as they would signing in (`projectRolesOf`), and, for a link, the issue at its other end. Each person's delivery is one transaction:

1. **Once.** `notification_events (user_id, event_id)` is the key. An event the outbox hands over twice, or two instances deliver at once, reaches a person once.
2. **A burst is one.** An unread notification about the same issue, begun within `NOTIFY_WINDOW_SECONDS` of this event (by the events' own times, so a replay folds the same way) and not yet sealed by its email, takes the event under `FOR UPDATE`; otherwise a new one starts. A read one never takes more: what came after you read it is new.
3. **Its email** is queued in the same transaction if the person wants this kind (D23), due when the window has passed.

What a notification shows is its events, read from the activity log, so there's one account of what happened. The inbox lists only projects the reader can still read. Marking read takes `until` (the latest event the reader saw), so what arrived since stays unread.

Watching, reading and email preferences are the person's own, like their tokens: no activity, no webhook, nothing in the issue's history. A viewer may watch what they can read; a token needs `write` to change any of it, and `read` to see the inbox.

**Access.** What reaches a person is checked against their own access, never the actor's:

- Someone mentioned in a members-only project they aren't in is told nothing and doesn't watch it; the change's `data.mentions` names only the people it told. The composer offers only the project's people.
- A watcher who loses sight of a project keeps their row, but isn't listed or told, its notifications leave their inbox, and their queued email isn't sent (it's checked again as it's rendered). Given access again, it all comes back.
- A notification's events are shown as the issue's history would show them to its reader: a link to an issue they can't see is left out.
- A token limited to some projects reads and marks only those projects' notifications. An issue the caller can't see answers 404, in the words used for one that doesn't exist.

The unread count is live on every instance: a change tells this process's open streams (`GET /notifications/stream`) and, by `NOTIFY` on `a4a_inbox` with the people's ids only, every other instance's. Each stream also counts again every 15 seconds, and after `LISTEN` reconnects, for a notification that was lost. A stream ends when its instance stops, and the client reconnects, to any instance: it carries a count, not events, so there's nothing to resume.

- **Costs:** a row per person per event in `notification_events`; read notifications are kept 180 days.
- **Revisit when:** a team wants subscriptions by kind of change. Subscriptions to a project or a saved search are D31.

### D23. Mail is an outbox too: rendered when sent, at least once

Mail is a row in `mail_outbox` first, written in the transaction that calls for it, with a `dedupe_key` that makes queueing idempotent: one mail per notification, per person per digest day, per help desk event. Without `SMTP_URL` nothing is queued and nothing is sent; no request ever waits on SMTP.

- **Sending.** A sender (`MailWorker`, one per instance) claims a few due rows with `FOR UPDATE SKIP LOCKED` and a two-minute lease, so instances never send one at once, and a sender that dies loses its lease to another. At least once: a crash after the server accepted a mail sends it again, under the same `Message-ID`, so clients show one. Queueing the day's digests and pruning are the lease holder's chores, done once for every instance.
- **Retries.** A failure waits 1, 5 and 15 minutes, then 1, 3, 6 and 12 hours, then gives up; a permanent refusal (SMTP 5xx) gives up at once.
- **Rendered when sent,** from the row's payload, so a mail says what is true then: a notification's email seals it first (it takes no more events), and isn't sent if it was read in the app meanwhile, or the person no longer wants that kind. A digest with nothing unread isn't sent.
- **Plain text and simple HTML,** the same lines, the HTML escaped, links only: no images, scripts or styles, nothing loaded. What people wrote is quoted as written, never rendered.
- **Unsubscribe** is one click per kind (RFC 8058: `List-Unsubscribe` and `List-Unsubscribe-Post`), signed with HMAC-SHA256 by a key kept in settings (`notifySecret`), checked in constant time. Email levels nest (`all`, `direct`, `none`), so stopping the emails about watched issues leaves mentions and assignments. A subscription's email stops that subscription's email alone (D31). Opening the link changes nothing (scanners open links); the page's button, or the client's POST, does.
- **Threading.** Mail about one issue references `<issue-…@host>`; a help desk request's, its confirmation.
- **Why nodemailer:** it is the SMTP client for Node, with pooling, TLS and the RFC details right, and nothing else in the stack does SMTP. Tests run it against a real SMTP server (`smtp-server`).
- **Costs:** a mail can go twice after a crash; sent mail is kept 30 days.
- **Revisit when:** volume needs a provider's API (SES, Postmark). That is another transport behind the same outbox.

### D24. A help desk for people who aren't users

A project can open a help desk: a public form at `/help/<KEY>` that files an issue, and a page per request (`/request#<token>`) where the requester follows the public conversation and answers it.

- **A requester isn't a user.** They're a row of their own (`requesters`: email and name), so they can't sign in, never appear among people to assign or mention, and can be found and forgotten by email. Their issue is reported by the `helpdesk` agent through the `helpdesk` channel, and its history names them. The agent acts with an elevated system context that reaches the request's project only (`actor.projectIds`), so it works in a members-only project and nowhere else.
- **Tracking tokens are hashed, and minted as they're sent.** Each email to the requester carries a fresh 256-bit token, made while the email is rendered and kept only as its SHA-256 hash, so no token waits in plain text, in the outbox or anywhere; one minted for a failed attempt is deleted. Every token stays good for the request. Only without SMTP does the form's answer carry one, once, since no email will. In a link the token sits in the fragment; to the API, in a header.
- **Comments are internal unless made public.** A comment's `visibility` is `internal` by default, on every channel; `public` is allowed only on a request, and is the only thing the requester's page and email show. The requester's own replies are public comments by the `helpdesk` agent, with `requester_id`, and tell the issue's watchers. The project's lead watches each new request and is told of it (`request`).
- **The first-response target** is per project, in hours round the clock; the deadline in force when a request was filed is kept on it. The first public reply from the team answers it, and so does resolving it without one; it's worked out when read (`slaOf`, and the same in SQL for `sla:`), so nothing has to be updated when a reply comes.
- **Public routes reveal nothing beyond the one request,** and answer alike whether a project, request or token is missing or just not theirs. The form's posts need an `Origin` of this server and a signed form token tied to a `SameSite=Strict` cookie; anything anonymous may post is small (body limits), limited per address, per email and per help desk, and a hidden field catches bots. Turning the help desk off closes the form; requests already filed keep their pages.
- **Who does what.** A project's managers set its help desk up, like its other settings. A public reply answers the requester for the project and counts as the first response, so it takes someone who may change the project's issues; a viewer's comments on a request stay internal. On a members-only project the form shows the project's name and intro to anyone with its address; that is what opening it means, and the settings say so.
- **Limits are shared** by every instance, in Postgres (`help_throttle`, fixed windows, emails and tokens counted by their hash), as the sign-in throttle is, so a spammer behind a load balancer gets what one instance would give.
- **Costs:** no proof the email is the requester's (docs/mcp-and-api.md, 8a); first-response hours count round the clock, not working hours.
- **Since:** requests and replies by email, and a proof of work a desk can ask its form for, are D30.
### D25. Workflow rules: an outbox consumer that acts, and guards inside the write path

A rule belongs to a project (or, for administrators, to every project) and is one of three kinds. All three are the query language for *which issues* and the command language for *what to change*, so a rule is checked, previewed and explained the way a query or a command is.

**Rules on a change and scheduled rules act afterwards, as the workflow agent.**

- Rules on a change run in the outbox worker, as a consumer of `issue.created`, `issue.updated` and `comment.created`. Each rule the event sets off acts when the issue, as it is when the rule runs, matches the rule's query. All of them are evaluated in one read, against the issue as the change left it. An import's events set none off (D21).
- Scheduled rules (every hour, day or weekday, at a time, in the server's time zone) run as one of the worker's chores, which only the instance holding the worker's lease runs (D17). A turn is claimed by moving the rule's next run on (a conditional update), so it runs once even if the lease changes hands. Issues are read in pages by id, up to 2,000 a run, and a run stops between pages if the lease has gone to another instance.
- Both apply through the command executor's own step (`commandSpec`, then `applyChanges`), as the `workflow` bot with channel `automation`, with "me" standing for whoever made the change that set them off. The bot runs as triage's does: administrator scopes, limited (`actor.projectIds`) to the project of the issue it acts on, members only or not. So a rule never reads, links to or changes another project's issues: a link changes both its issues, and a rule's command may link only within its project, which is checked when the rule is saved.
- A rule that fails is written in its run log with why, and never stops the others or the outbox.

**Who sees rules, and who makes them.**

- Reading a project's rules and their run log needs only reading the project, and a rule of a project someone can't see answers as one that doesn't exist (404, in the same words). Making, changing, turning off and deleting them needs one of the project's managers (D15); a rule for every project needs an administrator whose token reaches every project.
- A project's rule reads only its own project's names (`ruleWorld`, over `scopeSchema`): another project, its values and its issues are unknown words to it, as they are to someone who can't see them. So checking or previewing a rule can't probe another project, and a rule runs as it was checked. A rule for every project is checked and previewed over the projects the person can see, and counts only their issues.
- Such a rule writes some runs for no one project: how a scheduled run went everywhere, or that it no longer reads. They count and name things in every project, so only those who see every project see them; the others see its runs on issues they can see.
- Rules act for the project's managers, not for whoever sets them off. A viewer may comment, and a rule may act on that comment (a reply that reopens an issue waiting for one is the usual case): what it changes is the managers' choice, and "me" is all the viewer brings to it. A viewer can't make, change or turn off a rule.

**Loops stop at a fixed depth, with each rule acting once per chain.** Every change a rule makes records its cause on every activity it writes (`data.automation`: the rule, the change that started the chain, how deep it is). Rules a rule sets off act one step deeper, up to three steps. And a rule acts on an issue at most once for each change that starts a chain: the run log's unique key (rule, issue, origin) is claimed in the same transaction as the rule's change. The same key makes a replayed event, which at-least-once delivery allows, do nothing. Chains are useful (a scheduled rule tags an issue overdue; a rule on that change raises its priority); the key guarantees they end, and the depth bounds how far they reach.

**Guards are checked inside `applyChanges`, in the same transaction.** A guard says: a change that makes an issue match Q must leave it matching R. Before writing, `applyChanges` reads whether each of the project's guards holds; after writing everything (fields, tags, links, the comment) and before commit, it reads again. A change that takes the issue from keeping a guard to breaking it is refused (422), and the transaction takes all of it back. An issue that broke a guard before the guard existed can still be changed in other ways: a guard refuses only what makes things worse. A new issue has no "before", so `createIssue` checks its guards at the end of its own transaction, and a refused issue doesn't even use up its number.

**Keeping the write path fast, and free of deadlocks.**

- Rules are reference data: they load with the schema snapshot, so a project without guards pays a filter over memory and no query, and a rule change invalidates the snapshot like any other.
- With guards, the two checks are one SELECT each, over every guard at once, on the transaction's own connection. Reads take no row locks and never wait on one (MVCC), so the checks add no edge to the wait-for graph: they can't take part in a deadlock. A snapshot reload inside the transaction runs on the transaction's connection (see `SchemaCache.get`), never the pool, so on PGlite it can't wait on itself.
- A refusal is written to the run log on the pool and not awaited. The refused transaction never waits on it: on PGlite it queues behind the transaction, and on Postgres it waits for the issue's row lock, which the refused transaction releases as it ends.
- The rule engine's own writes take the issue's row lock first, as every write to an issue does, then claim the run.

**What it costs.** A rule acts a few seconds after a change (the outbox's settle time), not inside it, so a person sees their own change first and the rule's a moment later, each in the history under its own name. Dry runs don't evaluate guards (they write nothing to evaluate), so a command's preview can't say a guard will refuse it; applying it does, per issue. Guards see changes made through the write path: deleting a comment or logging work isn't checked. A new or changed guard holds on another instance once its snapshot reloads: at once, when the change's `NOTIFY` arrives, or within a minute if a notification is lost.

**Agents can't make rules.** They list them and preview them over MCP. A rule acts later, on its own, on every issue that ever matches it: it would outlive the conversation and the caps on an agent's commands, and agents read text anyone can write.

**Revisit when:** rules need to read more than one issue (a parent's state, a sprint's), or to do something other than a command (notify, call out): then a small expression language over the issue, still evaluated by the same engine.

### D26. Version control: verified deliveries, idempotent links, commands as the verified author

GitHub and GitLab post pushes and pull (merge) requests to `/api/v1/vcs/hooks/{integration}`.

- **Who sent it.** GitHub's `X-Hub-Signature-256`, an HMAC-SHA256 of the raw body, is recomputed and compared in constant time; GitLab's `X-Gitlab-Token` is hashed and compared in constant time. The raw bytes are read before anything parses them. GitHub's secret is an HMAC key, so a4a keeps it to check signatures (as it keeps its own webhooks' secrets to sign); GitLab's token is kept only as a SHA-256. Neither is shown after it's made.
- **How often.** Deliveries are rate-limited per integration; refusals are rate-limited per address, and those over the limit aren't logged, so the log can't be flooded. Like the general limits (D17), these are per instance.
- **Once.** The provider's delivery id is claimed before the work. One sent again is answered as a duplicate. One that failed (or died, after ten minutes) may be handled again, which is safe because linking is idempotent per (issue, commit) and per (issue, pull request), held by unique keys.
- **Commands.** `BACK-12 #Fixed` applies the command after `#` as the person whose *verified* email wrote the commit, with their own access as they would sign in, and only if they can change the project's issues (asked through `services/access.ts`): a viewer's command, or that of someone outside a members-only project, links and isn't applied. Like a token limited to projects, it reaches only the integration's projects, so a command can't link to an issue elsewhere. A commit's author email is whatever the committer typed, and a4a's own emails are whatever people typed, so an email counts only when it is confirmed: set or confirmed by an administrator, or verified by the identity provider (`users.email_verified`, the same flag single sign-on trusts, D16; a person changing their own clears it). Each (commit, issue) is one transaction that locks the issue first; the command runs in a savepoint, so a command that fails, or a guard that refuses it, leaves the link and says why.
- **History.** Linking records `commit.linked`, `pull_request.linked` and `pull_request.updated`, on a new channel, `vcs`, as the matched person or as the integration itself, so the issue's history, the event feed and webhooks see it.
- **Reach.** Linking needs no one's access in a4a: an integration links the issues of the projects an administrator gave it, and "every project" means members-only ones too. A commit's message and a pull request's title are their authors' words, shown as written, as a comment is.
- **What the provider is told.** GitHub and GitLab show a delivery's reply to the repository's administrators, who aren't a4a's. So the reply names no issue and no person, and says nothing of who may do what in a4a: only what kind of delivery it was and how many links and commands came of it. a4a's own log of deliveries, which its administrators read, says the rest.

**Costs.** One email per person, so commits under a provider's no-reply address run no commands. A push reads its first 500 commits.

**Revisit when:** people need several emails, or a mapping from provider logins; or a4a should fetch what a delivery leaves out (a push delivery carries at most 2,048 commits).

### D27. Groups, and SAML sign-in beside OpenID Connect

**Groups.** A group is some people. A project gives a group a role (viewer, member, manager) as it gives one to a person, and everyone in the group has at least that role there. Someone's role is the highest of their own and their groups' (their own, when they're the same), after administrator and lead and before an open project's member. So an open project can keep a group to reading, as it keeps a person.

- **The seam held** (D15). `projectAccess` still works out every project's role in one query: a lateral join picks the best role a group of theirs has there, and that group's name, for "as one of …". `projectRolesOf`, which decides whom to tell and who may be assigned, reads groups' roles beside people's. Nothing else reads the tables. Every change calls `accessChanged`, so someone taken out of a group loses what it gave them at once on this instance, and within two seconds on others (D17).
- **Who changes what.** Administrators make groups and say who is in them; a project's managers give groups roles in it, as they give people roles. Anyone signed in sees groups and who is in them, as they see people; a group's roles are listed and counted only in projects the reader can see.
- **History.** A group's role in a project is in the project's history (`project.group.added`, `.changed`, `.removed`; deleting a group writes a removal in each project it had a role in). Who is in a group isn't, as changes to people's accounts aren't.
- **Agents.** `list_project_members` lists the groups with a role, and who is in each, so an agent assigns a members-only project's issues only to people who see it.

**Groups from the identity provider.** A group with a name at the provider (`providerName`) takes its people from there. At each sign-in, the OIDC claim `OIDC_GROUPS_CLAIM` names, or the SAML attribute `SAML_GROUPS_ATTRIBUTE` names, lists the groups the person is in; a4a puts them in exactly the provider groups of those names (case aside), and takes them out of the others.

- Groups kept by hand are never touched, whatever they're called. Names a4a has no group for are ignored, so a provider can't make groups, and a list of hundreds costs nothing.
- A provider that leaves the claim out says the person is in none.
- Who is in a provider's group can't be changed by hand. A group kept by hand that starts coming from the provider, or one given another name there, is emptied, and fills as people sign in; one that stops keeps its people, by hand from then on.

**SAML 2.0, started by a4a.** An AuthnRequest goes by the HTTP-Redirect binding, and the response is posted to `/api/v1/auth/saml/acs`. The provider comes from its metadata (`SAML_IDP_METADATA_URL`, https, fetched at most hourly), or is set out by hand: its entity id, its sign-in URL, and its certificates (several, during a key rollover).

- **The choice: @node-saml/node-saml (v5), not xml-crypto and code of our own**, for the reason D16 chose openid-client. XML signatures are where SAML implementations fail: a signed assertion wrapped around or beside an attacker's, a comment that cuts a NameID short, a second assertion. node-saml's v5 is hardened against exactly these. It verifies the signature over the assertion, or over the whole response, against the configured certificates; it returns only the assertion the signature covers, and refuses a response with more than one; and it checks the issuer, the audience and the time window, with a minute's skew. The tests sign responses with a key and certificate made for the test, and try each of those attacks.
- **Shared by every instance.** The library's cache is in Postgres (`saml_cache`): each request's id from the start until its response comes back, taken in one statement, and each assertion's id until it would expire. So any instance takes the response, and none is accepted twice, whether or not it answers a request.
- **What a4a adds.** The assertion must be for this endpoint: a bearer confirmation whose Recipient is the assertion consumer URL, and no other Destination on the response (node-saml v5 only warns). The response must come back to the browser that started, by a cookie, as with OIDC's state, checked against a hash kept beside the request's id. The provider posts from its own site, so over https the cookie is `SameSite=None; Secure`. The assertion consumer takes posts from another site by design, so the CSRF check passes it by; what it is sent is checked as above.
- **Sign-in started at the provider** answers no request and matches no browser, so a response stolen from one person could be posted for another (login CSRF). It is refused unless `SAML_ALLOW_IDP_INITIATED`; when allowed, each assertion still works once.
- **Who someone is**, as with OIDC: one function serves both. Identities are kept under `saml:` and the provider's entity id, with the NameID, and a first sign-in race is made safe the same way. SAML has no `email_verified`, so an asserted email counts as verified only with `SAML_TRUST_EMAIL`. Without it, an email links no existing account, and gives no second account an address one already has (the sign-in page says so: `unlinked`); a new account's email stays unconfirmed, and its NameID links it from then on. Allowed domains need it.

- **Costs:** encrypted assertions aren't read, a4a's AuthnRequests aren't signed, and there's no single logout, so an account removed at the provider keeps its a4a sessions until they end or an administrator bans it, as with OIDC. One SAML provider at most, beside one OIDC provider. Groups follow the provider at sign-in only: someone it takes out of a group keeps that group in a4a until they next sign in.
- **Revisit when:** a provider must encrypt assertions or wants signed requests (node-saml does both, given a key of a4a's); membership must follow the provider between sign-ins (SCIM); or people sign in with LDAP.

### D28. Remote MCP signs in with OAuth 2.1, and a4a is its own authorization server

An MCP client such as Claude or Claude Code needs only `PUBLIC_URL/mcp`. The first request has no token, so `/mcp` answers 401, and its `WWW-Authenticate` names the protected resource metadata. The client follows it, registers itself, and sends the person's browser to a4a, which asks them what the app may do. The app gets a code back at its own address and exchanges it for tokens that work at `/mcp` alone. This follows the MCP authorization specification (the 2025-06-18 revision), and with it RFCs 9728, 8414, 7591, 7636, 8707, 9207, 7009 and 9700. API tokens stay for clients that don't sign in by themselves, and the stdio bridge uses one.

**The choice: a4a issues the tokens, not the identity provider of D16.**

- A token has to say what a4a's tokens say: read, or read and write, and in which projects (D15). No provider knows those.
- MCP clients register themselves, and few providers take registrations from anyone.
- An instance may have no provider at all.
- The person still signs in on the way, with a password or that single sign-on, and the consent page is a4a's own.

**Discovery.**

- The protected resource metadata (RFC 9728) is served at `/.well-known/oauth-protected-resource/mcp`, the address the 401 names, and at the root form, which clients try when given none.
- The authorization server metadata (RFC 8414) is at `/.well-known/oauth-authorization-server`. The issuer is `PUBLIC_URL`.
- Any other `/.well-known/` address answers 404 in JSON, never the web app's page in its place.

**Registration (RFC 7591).**

- It is open, as MCP clients expect, and for public clients only. An app gets an id and never a secret; whatever authentication it asks for, the answer says `none`.
- Redirect URIs must be https, or plain http to this computer's loopback, where desktop clients listen. Fragments, credentials and other schemes are refused.
- An app's name is cleaned to one line (no control or direction-changing characters). It is shown as the app's own word for itself, which a4a can't check.
- a4a never fetches anything a registration names, such as a logo or a policy, so registering can't make the server reach anywhere.
- Registering gives nothing until a person allows the app. It is limited to 20 an hour per address, with a backstop on registrations nobody uses. An app nobody allowed within a day is pruned.

**Asking the person.**

- The consent page is the web app's, at `/oauth/authorize`. It signs the person in first if needed, then asks the REST API whether the request holds.
- Until the app and the address it wants to go back to are known to be its own, an error is shown on a4a's page and sent nowhere: an unregistered address could be anyone's (an open redirect). After that, errors go back to the app with its `state` and `iss` (RFC 9207).
- PKCE with S256 is required.
- A redirect must match the registered one exactly. A loopback one may come back on another port, since a desktop app listens on whichever port is free (RFC 8252).
- The `resource` (RFC 8707) must name `/mcp`. The server's own address is taken to mean it too, as it holds nothing else an app could ask for. Every token is bound to `/mcp`.
- The page is Ocean's ApprovalCard as the page's one card, striped `outside`, since what the app reads leaves a4a. It shows:
  - who asks, by the app's own name, said to be its own;
  - where it sends the person back, or that it's a program on this computer;
  - what it may do: reading always, and changes if the app asks and the person's role allows;
  - where: every project, or the ones chosen, exactly as a token limited to projects.
- Only a person signed in on a4a's own page decides. A token can't, nor can a page elsewhere (the CSRF check).

**Remembered.** What a person allowed an app is one live grant per person and app. While the app asks for nothing it didn't ask for when they decided, and it was used in the last 90 days, the consent page carries on without asking. Asking for more asks again.

**Tokens.**

- **Codes** last two minutes and work once: a code is claimed in one statement, on any instance. A code that comes back revokes what it gave (RFC 6749, 4.1.2).
- **Access tokens** last an hour.
- **Refresh tokens** last 30 days and rotate with each use. Every token since one code is a family, and a refresh token used twice revokes its whole family (RFC 9700): one of its two holders isn't the app.
- All three are stored as SHA-256 hashes. Their prefixes (`a4c_`, `a4o_`, `a4r_`) set them apart from API tokens.
- An access token works at `/mcp` and nowhere else; the REST API refuses it. That makes it audience-bound, and no token is ever passed on.

**Acting.**

- A token acts as its person, with what the grant allows as their role allows it now: a role narrowed since narrows the app at once.
- It reaches only the projects chosen. It never has the admin scope: administration reaches every project, as for tokens limited to projects.
- The activity records the change as the person's, on the `mcp` channel, under the app's name.
- A person revokes an app under Agents and tokens, which ends its grant and every token at once. An app revokes its own tokens (RFC 7009). A banned person's apps stop.

**CORS.** Only the protocol's own endpoints (the metadata, registration, the token endpoint and revocation) answer any origin, and without credentials, so an MCP client in a browser can use them. `/mcp` and the REST API stay same-origin.

**Costs.**

- Rotation is strict. A client that retries a refresh after losing the answer is signed out, and its next sign-in goes through the remembered grant without a question.
- OAuth's limits are per instance, as the API's are (D17).
- An app with a private-use redirect scheme (`cursor://…`) can't register: it uses a token.
- OAuth needs an https `PUBLIC_URL` (or this computer, for development). Over plain http to another host it stays off, and `/mcp` asks for a token as before. `MCP_OAUTH=false` turns it off anyway.

**Revisit when:**

- MCP clients move to client ID metadata documents. a4a would then fetch a document the client names, with the care any outbound request takes.
- An organisation wants its own provider to issue the tokens. a4a would then check that provider's tokens for audience `/mcp` and map their scopes.
- A tool should ask for writing only when it needs it (step-up, with `insufficient_scope`).

### D30. The help desk by email: one path for every message, threaded by what only the requester has

A desk can have an address, and then people write to it as well as fill in its form, and answer the team's emails as well as their request's page. Mail reaches a4a two ways, and both go down one path (`helpdesk/inbound.ts`):

- **A mail provider posts it** (SendGrid, Mailgun, Postmark, a Cloudflare Email Worker, a script) to `/api/v1/mail/inbound/<KEY>`, raw: as the body, as a form's `email` or `body-mime`, or as JSON's `RawEmail`. The desk's secret is HTTP Basic's password, the place providers put a URL's credentials, so it stays out of addresses servers log. It's random, kept as a hash, shown once, and compared in constant time; a desk that doesn't exist, takes no mail, or has another secret answers the same 401, limited per address.
- **The server reads a shared mailbox** (`HELPDESK_IMAP_URL`) as one of the worker's chores, so only the lease holder does (D17). A poll runs in the background, so the outbox never waits on a mail server, and checks the lease between messages. How far it has read is kept by UID within the folder's UIDVALIDITY, in Postgres, so a new holder carries on where the last stopped. The first time it sees a mailbox, or a renumbered one, it starts after the newest message: mail from before a4a read it isn't anyone's request now. Each message goes to the desk whose address it was sent to (To, Cc and the delivery headers); if it names two desks, the first. Credentials never cross the network in the clear: `imap://` must upgrade with STARTTLS, except on loopback.

**What a message becomes.**

- **Once.** A message is known by its Message-ID within its desk, and claimed in the log before the work. One posted again, or read twice, is a duplicate. One whose work failed, or died (ten minutes on), may be handled again. A failure of a4a's own answers the provider 5xx, so it tries again, and ends a poll there, so the next tries it again; a message a4a can't take for a reason in it (unreadable, too large) is logged and passed.
- **A reply** is the requester's when it comes from their address and either goes to a reply address whose token is the request's (`support+<token>@…`, each email to them minting one, kept as a hash, as tracking tokens are), or answers an email a4a sent them about it (In-Reply-To or References). Help desk mail now has random Message-IDs (`replyable` in the outbox), so citing one shows the email was had; older ones could be guessed and don't count. A reply becomes the requester's public comment, by the `helpdesk` agent, the same path as a reply on their page.
- **A new request** is anything else to the desk's plain address, while the desk is open: the subject is its summary, the words its description, the sender its requester, their message the root its emails thread under (and the first answers it as "Re:").
- **Words.** A reply's are what's above its quoted history and signature, cut as Gmail, Outlook, Apple Mail and a few languages write them ("On … wrote:", Outlook's header block and reply div, a cited blockquote, "-- ", "Sent from my iPhone"); answers written between quotes stay. HTML-only mail is read as words, its quoted parts dropped first; none of its markup survives, as none of anyone's does anywhere in a4a. A new request keeps its quoted history (a forwarded message is often the request) and loses its signature.
- **Files** go through the usual checks (the type read from the bytes, the per-file and per-issue limits), on the request or on the reply's comment; signatures, Outlook's wrappers and small inline pictures (a signature's logo) are left out, and at most 20 come from one message. The original goes with them as `original-message.eml` when what's shown isn't all of it: words read from HTML, or cut for length.

**What never becomes anything.** Mail no person wrote: `Auto-Submitted` other than `no` (RFC 3834), the auto-reply headers, `Precedence: bulk`, list headers, delivery reports, a null return path, `mailer-daemon`, and no-reply senders. Mail from a4a's own address or a desk's. Every email a4a sends says `Auto-Submitted: auto-generated`, so an out-of-office answering one is set aside too, and nothing loops. A message whose receiving server says it failed DMARC is refused: only the topmost `Authentication-Results` counts, being that server's own. A reply from anyone but the requester is refused, even with the token, since it would speak in their name. Nobody is ever told of what's set aside or refused, so a forged sender gets no mail.

**Limits:** 5 new requests per sender an hour, 30 replies per request, 300 messages per desk, in the help desk's shared throttle; 25 MB a message (`HELPDESK_MAIL_MAX_MB`). The log keeps 30 days, for the desk's managers: when, from whom, the subject, and what became of it, in words.

**A proof of work, when a desk asks for one.** The form comes with a challenge the server signed (ALTCHA's scheme): find the number up to `maxnumber` whose SHA-256 with the salt is the challenge. The browser finds it with WebCrypto in a worker, a file of the site's own, so the page's policy lets it run; it starts when the form loads, so it's usually done before the person is. The salt says which desk and until when (30 minutes), the signature that the server made it, so the server keeps nothing until an answer comes; then it takes the answer once, counted in the shared throttle. No puzzle, no third party, nothing loaded from outside. It doesn't stop a determined bot; it makes each request cost one a moment, with the honeypot, the form token and the limits beside it.

**Costs.** The desk's mail server must deliver plus addresses to the same mailbox (Google's, Microsoft's and most others do); without them, replies thread by what they answer alone. A sender can still be forged where DMARC isn't checked: the request is filed, and its confirmation goes to the real owner of the address, as with the form. One mailbox serves every desk.

**Revisit when:** a desk wants a mailbox of its own (`HELPDESK_IMAP_URL` per desk, its password kept encrypted), people other than the requester should answer by email (as the request's CCs), or a determined bot gets past the proof of work (raise `HELPDESK_CAPTCHA_MAX_NUMBER`, or a challenge per address).

### D31. Subscriptions keep their search's issues; dates are read where the person is

**Subscriptions.** A person subscribes to a project: its new issues (`new`), or every change in it too (`all`: what watchers hear of, D22). Or to a saved search, theirs or a shared one: an issue coming into it (`new`), or any change to an issue in it, the one that takes it out included (`all`). The notifier tells them with a reason of its own, `subscribed`, the weakest, so being assigned, mentioned or watching names a notification first. Where a person subscribes to both, a search's subscription is named before a project's, as the more particular.

- **Coming into a search.** An event can't say whether an issue came in: a query is SQL over the issues as they are, not as they were. So each search subscription keeps the issues its search finds for its person (`subscription_issues`). It's filled when the subscription starts, since what's in the search already isn't news, and again when its search's query changes. Every change to an issue, an import's, a logged hour's and a sprint's included, is checked against every search subscription in one read, as the rules engine reads its rules (D25), and the subscriptions it came into or went out of are written down. Only then are imports left out (D21), so an issue an import brought in isn't told as new at its next change.
- **As its person sees it.** A search is read as its person would read it signing in: their projects, "me" as them, dates in their zone. Someone who can't see an issue's project can't find it, and the notifier checks everyone's access again before telling them (D22). A shared search that is unshared leaves only its owner subscribed, and one deleted ends its subscriptions. A project subscription to a project its person no longer sees tells them nothing, and isn't listed; in the same words as one that doesn't exist.
- **Email.** A subscription says for itself whether it emails (`email`), and the person's level still rules: "none" stops it. The levels keep their meaning for what calls on you and for what you watch. A subscription's email links to stopping that subscription's email alone, and its entry in the inbox says which subscription brought it.
- **Agents** list their person's subscriptions and subscribe them (`list_subscriptions`, `subscribe`, taking a saved search by its name), as they watch issues for them. Subscriptions are personal, as watching is: no activity, nothing in any history.

**Time zones.** A person's time zone is on their profile: an IANA name, kept canonical, with the browser's offered. `zoneOf(ctx)` gives the zone a call reads dates in: its person's own, or the server's.

- **What it decides:**
  - "today", "{this week}", "-7d" and "Overdue" in searches, and the bounds of a day for created, updated and resolved. A day runs from local midnight to local midnight: 23 or 25 hours where clocks change (`startOfDay`, as reports work out their days, D21).
  - "today" typed for a date field, in a form or a command.
  - The day logged work falls on when no date is given.
  - When their digest comes: at `DIGEST_HOUR` where they are, once per day of theirs.
  - The times in their email, with the zone named.
  - "today" in the assistant's prompt.
- **It says so.** A search whose dates depend on the zone says which: "… (dates in Asia/Tokyo)".
- **What reads the server's zone:**
  - rules and guards, so a rule means the same whoever's change sets it off;
  - scheduled work, and agents with no person of their own (the workflow agent, triage);
  - plans, whose calendar is the project's.
- **Agents acting for a person** (the assistant, a token over MCP) read dates in that person's zone.
- **The web app** shows times in the browser's zone, as it did. Someone travelling sees the local time, while their dates stay in their own zone until they change it.

**Costs.** A search subscription keeps a row per issue its search finds. Each change to an issue compiles each search subscription's query for its person, and reads them all for that issue in one query: fine at a team's scale (Limits). An issue that comes into a search by time alone (one becoming overdue), or by a change to another issue (a link), is told at its own next change.

**Revisit when:** many people subscribe to large searches. Compile each subscription once per schema version, and check changes in batches. Or when someone wants subscriptions by kind of change (only resolutions), or to hear of what time alone brings into a search: a chore that reads the searches again.

### D32. Rules across issues, and rules that tell people or call out: the same sentence, the same once

D25's rules read and changed one issue. The classic workflow needs more: "when the last subtask is resolved, fix the parent". So a change or scheduled rule now has three more parts. Each is a word in its sentence, not an expression language:

> When an issue's State changes, if it matches `#Resolved` and all of its parent's subtasks match `#Resolved`, then apply `State Fixed` to its parent and tell its parent's watchers “All its subtasks are done.”

- **A further condition** ("and …"): its parent, its subtasks, its parent's subtasks, or the issues linked to it by a phrase ("depends on", "is required for"), matching a query: all of them or any one. "All" needs at least one, so an issue without subtasks doesn't count as having them all resolved. The query is compiled by the query language's own compiler, inside a subquery over `issue_links` correlated to the issue the rule acts for (`workflow/match.ts`). So one SQL condition serves a change (one issue), a scheduled run (pages of issues) and a preview (a count). Subtask links are said as a parent and subtasks, never as a phrase.
- **What it acts on** ("to its parent"): the issue itself, its parent, its subtasks, or the issues linked to it by a phrase, at most 200 per issue.
- **What it does**, besides a command and a comment:
  - **Tell people**: its assignee, its reporter, its watchers, the project's managers (its lead and members with the manager role, not every administrator), and people by login, in the rule's own words.
  - **Call a webhook**: one of the webhooks an administrator made.

**The guarantees are D25's, per issue acted on.** The run log's unique (rule, issue, change that started the chain) is claimed in the same transaction as everything the rule does to that issue: its command, its message and its call. If the claim loses, all of it is taken back. A replay therefore tells nobody twice and calls nothing twice, and a loop between linked issues stops at its second turn. The chain's depth carries through related issues, so a cascade up a hierarchy stops three rules deep. The run log then says so on the issue the rule would have changed, since the issue that set it off may already have been acted on in that chain.

**Telling is an event, and the notifier delivers it.** The rule writes `rule.notified`, naming the people it worked out (`workflow/tell.ts`). The notifier tells exactly those, as for any event: in their inbox with a new reason, `rule`, ranked above watching; folded into that issue's burst; and by email at their level (`direct` sends it). The people are worked out after the command, so "its assignee" is whoever the rule just assigned. Two filters apply, by D15 and the notifier's own rule, at the rule and again at delivery:
- whoever set the rule off is never told;
- nor is anyone who can't see the issue as they would signing in.

A project's rule that names someone who could never see the project is refused when it's saved.

**Calling is an event, and the webhook sender sends it.** The rule writes `rule.called`, naming its webhook. The webhook consumer sends it to that one webhook, whatever the webhook listens for: signed with its secret, retried, and in its delivery log, like every other delivery. A webhook can't listen for `rule.called`, so no other one hears a rule's call.

Three things keep a call deliberate:
- Only administrators make, change or delete a rule that calls out, because a webhook's address and secret are theirs. A project's manager can still turn one off.
- Only an https webhook is called, or plain http to this machine. The address is checked when the rule is saved, and again each time it acts, so a webhook moved to plain http is skipped with a note in the run.
- A webhook a rule calls can't be deleted until the rule lets it go.

A rule's sentence shows the webhook's origin, never its path, which can hold a secret.

**A project's rule reads and acts only in its project** (D15, D25). Related issues in other projects aren't there for its further condition. It leaves related issues in other projects alone, and the run of the issue it acted for says it left them alone, without naming them or their project.

**What it costs.**
- Each issue a rule acts for adds a query for its targets, and each it acts on is its own transaction with its own run.
- A rule that tells people writes one more event per issue.
- The parts are fixed words, so a condition the sentence can't say isn't possible yet, such as "when its sprint ends" or "if two of its subtasks…".

**Revisit when:** rules need conditions on other kinds of thing, such as a sprint, a board or a date, or counts ("more than three subtasks"). Then the related issues' query would gain a small expression language, still compiled by the query language. Revisit too when a call needs a body of its own, not the event.

### D34. Agents act as themselves; what they change on their own, a person undoes

Until now an agent over MCP acted for a person, with that person's token: its changes read "claude-code for Anna Schmidt", and it could take no work of its own. Now an agent can be an account of its own.

**Agents of their own.** An agent is a bot account an administrator adds. a4a's own agents (`triage`, `workflow`, `helpdesk`, in `OWN_AGENTS`) act for a4a itself: they take no tokens and no work, and their logins are a4a's to make.

- **Tokens.** An administrator issues an agent its tokens (`POST /users/{agent}/tokens`), with scopes, an expiry and, if wanted, projects, as any token has. A token never does more than its agent's role allows, and a token limited to a project the agent can't see is refused with how to fix it, since it would reach nothing there. The agent never makes its own tokens: a token that leaked can't make itself another. Banning the agent stops all of them.
- **As itself.** With such a token, the agent's changes are its own. The event's actor says so (`isBot`), the history reads "claude · via MCP" for no one, `me` in a query is the agent, and `get_current_user` says `agent: true`.
- **Assignees.** An agent can be assigned issues, as a person can: by anyone who may change the issue, and in a members-only project once it is one of the project's people. `for: me #Unresolved` over its token is its work. a4a's own agents are refused as values of a person field, with what to choose instead. Agents don't watch issues, so they get no notifications: an agent finds its work by searching.

**Undo.** A change an agent made on its own can be undone by a person who may change the issue, from the issue's history or `POST /events/{id}/undo`.

- **An agent's change.** It is made by an agent's account (one of its own, or a4a's: triage applying, a rule), or by an agent for a person: over MCP, or the assistant. A person's change on the web or through the API isn't one, nor are a commit's command, a requester's words, or an import.
- **What it keeps.** The write path keeps, in the change's own transaction, what undoing it puts back (`agent_changes`): each field's values before and after as stored, by field id; the summary; the description before, whole (its activity holds 2,000 characters of it), and a hash of what it became; the tags it added and took off; a link's two ends. Changes made before this was kept can't be undone.
- **What it undoes.** Fields, the summary, the description, tags and links. A comment is not undone: it is something said, deleted as any comment is. Creating an issue is not undone either: that would be deleting it, which isn't an agent's to make easy.
- **All or nothing, and never over someone.** Undo first checks that the issue still is as the agent left it: each field it changed holds what it set, the summary and description are its own, its tags are as it left them, its link is (or isn't) there. If anything differs, nothing is undone, and the answer (409 `changed_since`) says what changed since and who changed it: "State is In Progress now: Ben Okafor changed it since". What the agent didn't touch may have changed freely.
- **As the person, once.** The undo goes through the write path as the person asking, with their access, so guards and the history apply as to any change; its events say which change they undo (`data.undoes`). It claims the change's row under the issue's lock, so it happens once (409 `already_undone`), from either issue's history for a link.
- **Rules don't redo it.** Rules on a change skip an undo's events: they saw the issue that way already, and a rule acting again could redo at once what a person just undid.
- **The history says where each stands.** Each agent's change in an issue's history carries `undo`: `possible`, `changed_since` (with what), or `undone` (by whom). The web app offers Undo on the first, to people who may change the issue.
- **Agents can't undo.** Undoing is a person's decision, so an agent (its own account, or for a person over MCP, or the assistant) is refused, and there's no MCP tool for it.

**Costs.** A row per change an agent makes, with the values it replaced; a rewritten description is kept whole. Undo refuses rather than merges: someone who changed the issue since has to be asked, not overwritten.

**Revisit when:** an agent's comments should be withdrawable by people, or agents should be told of their work (a notification for an assigned agent, a webhook to wake it), or a change an agent made long ago should be undone across later ones (a merge, field by field).

### D35. Files in an S3-compatible bucket, served in ranges, and shown in place

D18's store, still three calls, can be a bucket: S3, MinIO, R2 and the like, chosen with `ATTACHMENT_STORAGE=s3` and `S3_*`. Then several instances share files without a shared volume.

**Writing.** An upload streams on as it arrives, through the same counting and hashing, into lib-storage's `Upload`: one `PutObject` under 5 MiB, a multipart upload past it, with two 5 MiB parts in flight, so an upload holds about 10 MiB of memory. An object appears only when its upload completes. So a file over its limit, or a client that goes away, leaves nothing under its key: the parts are aborted, and the store passes the source's own error on (a 413 stays a 413). Two things learned on the way:

- lib-storage takes a body's length from its `size`, `length` or `byteLength`, if it has one, and then expects that many parts. The upload path's counter has a `size`, which is 0 when the upload starts, so a large upload was refused for the parts that came. The store hands lib-storage a plain stream between.
- By default the SDK sends checksums as `aws-chunked` bodies with trailers, which not every S3-compatible store takes. With an endpoint other than AWS's, it sends them only where an operation needs one. TLS keeps the bytes whole on their way, and the copy command reads every file back.

**Reading, removing, sweeping.** `GetObject` (with its `Range`) and `DeleteObject`. The sweep aborts multipart uploads under a4a's prefix left unfinished for six hours, as it removes part files from disk. Servers that list unfinished uploads only by a whole key (MinIO among them) clear stale ones themselves. With `S3_PREFIX` a bucket can hold more than a4a's files; only keys of a4a's own shape are ever touched.

**Downloads still come through a4a.** The access check and the headers that keep a file from running (D18) stay a4a's. The bucket is never handed out, so it needs no public access and no CORS.

**When the bucket fails.**

- At start, a bucket that can't be reached, doesn't exist or refuses a4a stops the server, saying which bucket and what to check: the keys, `S3_ENDPOINT`, the machine's role.
- Later, a failing store answers 503, `storage_unavailable`: "Files can't be reached right now". Why goes to the server's log, naming the bucket, and never to the person.
- An upload whose bytes the store couldn't remove keeps its record, so the sweeper takes it once the store answers.

**Moving from disk.** `pnpm --filter @a4a/server files:to-s3` (`node packages/server/dist/files-to-s3.js` from a build) copies every file a4a points at:

1. Each file is read from disk and hashed on its way up; then its copy is read back and hashed again. Only a copy whose SHA-256 is the one taken at upload counts. A file on disk that doesn't match its own checksum is reported, and not copied.
2. Verified copies go in a manifest beside the files, one key and checksum a line. A rerun skips them. A file in the bucket but not in the manifest (in flight when a run stopped) is read back, and copied again if it doesn't match. A bucket that fails stops the run, and the next carries on.
3. Run it while the server still runs on disk; stop the server and run it again, which copies only what came since; then start with `ATTACHMENT_STORAGE=s3`. Nothing on disk is deleted.

**Ranges.** `GET /attachments/{id}/content` answers one byte range with 206 and `Content-Range`, from either store: players seek with ranges, and Safari plays no video without them. It says `Accept-Ranges: bytes`, answers 416 past the end, and honours `If-Range`; several ranges at once get the whole file.

**Shown in place.** A file on an issue or an article can be shown under its row, when asked for:

- **Text** (`text`: logs, code, CSV, JSON, Markdown, and HTML and SVG as their source) comes through `GET /attachments/{id}/text`: the first 64 KB, or the last. It's React text in a `<pre>`, so nothing in it is markup. A character that changes the direction text reads in shows as its code (`U+202E`), so a line can't pass for another.
- **Sound and video** (`play`, from the bytes: MP3, AAC, M4A, Ogg, WAV, FLAC; MP4 and WebM) play in the browser's own player, from the same URL, with `nosniff`. The page's policy gains `media-src 'self'`.
- QuickTime, AVI and Matroska download, since browsers don't all play them. Sniffing now tells WebM from Matroska by its DocType, and knows MP3 without an ID3 tag and AAC in ADTS frames.

**Not shown in place:**

- **PDFs.** A browser shows a PDF in its own viewer, in a frame. Under the file's `sandbox` policy Chrome's viewer refuses, and lifting the sandbox would let a PDF's scripts run as a4a. pdf.js in the page would cost a megabyte and a worker. PDFs download.
- **Thumbnails made on the server.** They would mean decoding untrusted images on the server (a native library, and its bugs) for what `loading="lazy"` and the browser's scaling already do. Images show as themselves.

- **Costs:** every download crosses a4a's bandwidth as well as the bucket's. A copy reads each file twice, up and back. The SDK loads only when the bucket is first used, so a server on disk never loads it.
- **Revisit when:** files are large or many: presigned URLs then, with a4a setting the response's type and disposition. Or when people ask for PDFs in place: pdf.js in a worker.

### D36. Days away: each person's work on their own days, and why is theirs

A person's days away are whole days, or the morning or the afternoon of one. The person enters them, or a manager of a project they work in, or an administrator. Plans then do each person's work on their own days.

- **The engine.**
  - Each person works on the plan's calendar with their whole days away taken out, and gives half their hours on a half day.
  - Someone never away works on the plan's calendar itself, the same object, so a plan where nobody is away comes out exactly as it did.
  - A task starts on a day its assignee is there. It takes as many of their days as its hours need, each giving its share, and its slack is counted on their days.
  - A start-to-due window that falls while they're away is planned for when they're back, with a warning.
  - Milestones, and work nobody is assigned, keep the plan's calendar. Plans' holidays are as they were.
- **Levelling** looks for room on the assignee's own days, at each day's capacity, half of it on a half day. It calls a move levelling only when it moves work for resources, not when work just waits for its person.
- **What it looks at:** days away from a year before today to five years after. Beyond that everyone is there, so someone away for good can't run the engine out of days.
- **The load** gives each day's capacity (none on a day away, half on a half day) and whether someone is away (`away`: day, morning, afternoon). It never says why. The grid says "away", and dashes half a day with what's left of it.
- **Costs.** A day away books no hours, so it costs nothing, and a task that waits for its person costs what its estimate does. Earned value follows the baseline as saved: a day away added later doesn't rewrite the plan of record.
- **Who sees what.**
  - Anyone who may read sees when someone is away, as a team's calendar shows it; plans show it anyway.
  - Why (holiday, sick, training, something else, and a note) only the person, administrators and whoever entered it see: sickness is the person's own.
  - Days away aren't events. The feed (webhooks, the live stream, MCP's event tools) reaches everyone who can read it, so who entered each, and when, is kept on the absence instead.
- **Who enters them:** the person; an administrator; or a manager of a project the person can work in, as they would signing in. In an open project, that's anyone who may change its issues.
- **What's refused**, each saying how to put it right:
  - dates out of order;
  - more than a year (enter it a year at a time);
  - half of several days;
  - days that overlap the person's others, checked under a per-person advisory lock so two entered at once can't both pass;
  - an agent's: agents are never away.

  A change checks the version read.
- **The load grid's window** is each person's choice: two weeks, a month or a quarter from today, the plan's end, or two dates. It's kept for them in `user_preferences`, the same on every plan and every device. Choosing it needs only reading, as notification settings do, so a viewer chooses what they see too.
- **A board with lanes** scrolls in a frame of its own, at most the window's height, so its column heads stay in view (Ocean's `.held`). It already scrolled sideways in its frame, so its heads could only stay in view within it.

**What it costs.**
- A task's length depends on where it lands when its assignee has days away, so a what-if or a levelling move counts it again.
- The backward pass reuses the forward pass's length. That's off only when a half day falls between the earliest and the latest a task could start.
- A plan's people's days away are read with the plan: one query.

**Revisit when:** people work part time on a pattern (every Friday off), which wants each person's own working week rather than an absence a week; or days away should come from an HR system (iCal or its API), as the same rows.

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
| Webhooks and triage | At least once, in id order, from the outbox, by the one instance that holds the lease. The lease runs on the database's clock and is renewed while a consumer is busy; a cursor moves only while its lease holds |
| Notifications | At least once in, once out: `notification_events` keys each person's events, so a redelivered event reaches nobody twice. Folding into an unread notification and its email sealing it are serialised on the notification's row |
| The issues a search subscription knows | Kept by the notifier, one event at a time in id order, by the one instance holding the lease (D31). An event handed over twice finds its issue already written down, so it tells nobody twice |
| Mail | At least once, idempotent per notification, digest day and help desk event (`dedupe_key`); claimed with `SKIP LOCKED` and a lease, so two senders never send one at once |
| Unwatching just after commenting | Holds: watching starts in the change's own transaction, not later in a consumer |
| Retried `POST` | `Idempotency-Key`: the key is claimed before the work, on any instance; the stored response is replayed, and a key reused with a different body gets 422. A claim left by an instance that died mid-request can be claimed again after 5 minutes |
| Reference data (fields, values, users, workflow rules) | Cached in memory per instance, and reloaded on every instance after a change on any (`NOTIFY`; a change made inside a transaction is sent on its commit). A generation counter stops a slow reload from overwriting a newer invalidation. The 60s reload remains, for a notification that was lost |
| Live events, several instances | Every instance sends every event once, in id order, within about a second of its commit. A stream resumes from its last event id on any instance, missing and repeating nothing. A missed `NOTIFY` (a dropped `LISTEN` connection, a crash before sending it) is caught up from the log: on reconnect, or by the 10-second backstop |
| An id that commits late, or never | Readers of the log stop at a missing id until it appears, or until no transaction that was writing to the log when it went missing is running; one held for a minute is passed with a warning |
| Sign-in throttle | Shared in Postgres, per IP and per login, and kept across restarts. An attempt is counted before its password is checked, so parallel guesses can't pass the limit |
| Sessions | Rows in Postgres: valid on every instance; signing out ends a session everywhere |
| Instances starting together | Migrations, defaults and the unattended first administrator run under an advisory lock: one instance at a time. So does `POST /auth/setup` |
| An import run twice, or stopped halfway | Each issue is known by (project, source, key): a rerun updates or skips it, never makes it twice. Each row commits on its own, so a run that stopped carries on where it was |
| Two people arrange one dashboard | `expectedVersion`: the second gets 409 and the current version |
| A guard and the change it checks | Same transaction: the change is checked after it's written and before commit, and refused all or nothing (D25) |
| A rule acting on a replayed event, or a loop of rules | Once per (rule, issue, change that started the chain), claimed in the rule's own transaction; chains stop three rules deep |
| A rule acting on related issues, telling people, calling a webhook | Each issue it acts on is its own transaction: the command, the message (`rule.notified`) and the call (`rule.called`) commit with the run's claim, or none of them do (D32) |
| A scheduled rule's turn | Claimed by moving its next run on, conditionally, by the instance holding the worker's lease |
| A delivery from version control sent twice | Its delivery id is claimed before the work; links are unique per issue and commit (or pull request), so even a second delivery id changes nothing twice |
| A message to a help desk posted twice, or read twice | Known by its Message-ID within its desk, claimed in the log before the work; a failed claim, or one ten minutes stale, may be handled again (D30) |
| The shared help desk mailbox, read by a new lease holder | Its place is a UID within its UIDVALIDITY, in Postgres, and only ever moves on; a message read twice is a duplicate by its Message-ID |
| Two people undo one agent's change, or someone changes the issue as it's undone | The undo locks the change's row, then the issue, and checks the issue is as the agent left it under those locks: the second undo gets 409 `already_undone`, and a change that got in first makes it refuse with what changed (D34) |

## Security

- **Passwords:** scrypt with a per-user salt.
- **Sessions:** random 256-bit tokens, stored as SHA-256 hashes. The cookie is `HttpOnly; SameSite=Lax`, plus `Secure` behind HTTPS.
- **CSRF:** cookie-authenticated unsafe requests must come from the server's own origin (Origin/Referer check). Bearer-token requests are not CSRF-able.
- **API tokens:** `a4a_` plus 256 random bits, stored as SHA-256 hashes, shown once. Each has scopes, an optional expiry, a last-used time, and can be revoked.
- **Apps over OAuth (D28):**
  - Codes, access tokens and refresh tokens are 256 random bits, stored as SHA-256 hashes.
  - PKCE with S256 is required, and codes go only to a redirect the app registered.
  - An access token works at `/mcp` alone, and lasts an hour.
  - A code or refresh token used twice revokes everything issued since.
  - Only a person signed in on a4a's own page allows an app, and never with the admin scope.
- **Login:** failed sign-ins are counted in Postgres per IP (50) and per login (10) in 15-minute windows, shared by every instance and kept across restarts. Starting a single sign-on is throttled per IP too, on each instance. The address comes from `X-Forwarded-For` only through the `TRUST_PROXY` proxies in front; otherwise the header is ignored, since clients can send it.
- **Single sign-on:** see D16, and D27 for SAML.
- **Project access:** see D15. What can't be seen answers exactly as what doesn't exist.
- **The browser:** strict Content-Security-Policy; no inline script or style; fonts are bundled, nothing loads from outside; Markdown is rendered without raw HTML.
- **Uploaded files:** their type is read from their bytes. Only raster images open in place. Text shows as text, never as markup, and sound and video play in the browser's own player (D35). Everything else is a download. All are served with `nosniff`, `Content-Security-Policy: sandbox` and `Cross-Origin-Resource-Policy: same-origin`. Names are made safe, and storage keys are random, so no name reaches the file system or a bucket's keys.
- **Webhooks:** signed with HMAC-SHA256 over the raw body. Only admins can create them, because the server will POST to the URL given (server-side request forgery to internal addresses is the admin's call). A workflow rule calls only a webhook an administrator chose for it, only over https (or to this machine), and only an administrator makes such a rule (D32).
- **Email:** unsubscribe links are signed (HMAC-SHA256, a key in settings) and checked in constant time; they only ever stop email. HTML email carries no images, scripts or styles, and quotes what people wrote as written.
- **The help desk:** its public routes need no sign-in and reveal nothing beyond one request (D24); tracking tokens are hashed; its form has a CSRF token tied to a `SameSite=Strict` cookie and an Origin check; anonymous posts are size-limited and rate-limited, and a hidden field catches bots. docs/mcp-and-api.md (8a) says what's missing.
- **Deliveries from version control:** checked (signature or token, in constant time) before anything is read; rate-limited; refusals logged at a bounded rate. Commands in commits run only as a person whose email is confirmed, and only where they can change issues (D26). Links from a payload are shown only if they are http(s).
- **Mail into a help desk:** a provider's post needs the desk's secret (HTTP Basic, hashed, constant time), and refusals are limited per address. A reply speaks for the requester only from their address and with what only they had (a reply address's token, or an email's random Message-ID). Nothing set aside or refused is answered, so forged senders get no mail; a receiving server's DMARC failure is refused. Mail's HTML is read as words, never shown (D30).
- **Agents:**
  - An agent's own tokens are issued by administrators, never by the agent; an agent can't undo, and a person's undo never overwrites a later change (D34).
  - Issue text is untrusted, so the assistant asks before writes.
  - MCP writes are annotated, so clients can ask too.
  - There are no deletes over MCP.
  - Every change records actor, channel and token.

## Limits and assumptions

- **Teams, not internet scale.** Users, tags, fields and values are held in memory per instance (thousands of each is fine), and every instance reloads them after any change to them.
- **Several instances need Postgres**, a `LISTEN` connection each beside the pool (not through a pooler in transaction mode: set `DATABASE_LISTEN_URL`), and a proxy that passes `text/event-stream` through unbuffered. `docker-compose.cluster.yml` runs two behind Caddy.
- **A live stream replays up to 1000 missed events** on reconnect; past that it sends `resync` and the client re-reads.
- **An event whose transaction stays open for more than a minute** is passed over by live streams and consumers, with a warning; it stays in `GET /events`.
- **Pagination.** Search results use offset pagination (sortable by any field); the event feed uses a cursor (`after`).
- **General rate limits are per instance**, in memory (D17): behind N instances a client gets up to N × 1200 API requests a minute and N × 600 MCP requests. `API_RATE_LIMIT` and `MCP_RATE_LIMIT` set each instance's share. OAuth's limits are per instance too: 20 app registrations an hour and 120 token requests a minute per address (D28). The sign-in throttle is shared.
- **A token's last-used time** is written at most once a minute per instance.
- **An assistant conversation whose instance dies mid-answer** takes messages again two minutes later: a turn claims its conversation in one statement and refreshes the claim every 30 s while it runs, so a claim left stale was cut off. The same claim stops two decisions sent at once from both running the changes.
- **Time zones.** Dates in a person's searches ("today", "{this week}"), their digest's hour and their email's times follow their own time zone, or the server's when they set none; rules and agents with no person read dates in the server's (D31). The web app shows times in the browser's zone.
- **Reports' days** are in the time zone asked for (the web app sends the browser's), each day as it stood at its end. A report reads at most 400,000 events. A sprint's working days and holidays are those of the plan of the first of its board's projects the reader can see, so a board whose projects keep different calendars draws on the first's.
- **An import** takes a CSV of 64 MB and 50,000 rows at most, one run per project at a time.
- **Days away** count from a year before today to five years after; the engine plans everyone as there beyond that (D36).
- **Readable ids** (`BACK-12`) are permanent because project keys can't be renamed. Renaming would need an alias table, as YouTrack keeps.
- **Files are on one disk, or in a bucket.** Several instances need a bucket (`ATTACHMENT_STORAGE=s3`, D35) or `DATA_DIR/attachments` on a shared volume. Back either up with the database: a file's row and its bytes go together.
- **One shared help desk mailbox,** read once a minute by default; desks are told apart by the address mail was sent to, and a desk's replies need its mail server to deliver plus addresses (D30).

## Not yet

Planned, with the seams already in place:

- LDAP sign-in, and SCIM, so people and groups follow the identity provider between sign-ins (D27);
- client ID metadata documents for MCP clients, beside registration, and asking for writing only when a tool needs it (D28);
- an importer that reads YouTrack's REST API, and Jira's (the CSV importer's rows are the seam);
- subscriptions by kind of change (only resolutions, only comments), and being told what time alone brings into a saved search (an issue becoming overdue) (D31);
- matching a commit's author by their provider login as well as by email, and Bitbucket beside GitHub and GitLab (D26);
- each person's own working week (part time, every Friday off), and days away from an HR calendar (D36).
