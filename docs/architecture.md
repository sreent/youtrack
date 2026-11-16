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

- **Someone's role in a project** is, in order: manager if they're an administrator or its lead; otherwise the role the project gives them; otherwise member, if it is open. So an open project can still keep someone to reading, by naming them a viewer, and the lead can never lock themselves out.
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
- **Not done:** groups (a project's people are individuals); tags stay instance-wide, so a tag's name is seen by everyone; a webhook delivers everything (only administrators make them).
- **Revisit when:** teams want groups. A `project_group_roles` table joins the same query, and the rest stays as it is.

### D16. Single sign-on with OpenID Connect, through openid-client

People can sign in with their organisation's identity provider: the authorization code flow with PKCE (S256), a state and a nonce, configured from `OIDC_*` in the environment.

**The choice: `openid-client` (v6), not `jose` and our own code.** Both are by the same author; `jose` would do the cryptography well, but the protocol around it would be ours: discovery and its issuer check, building the request, the token request and client authentication, RFC 9207's `iss`, the order and meaning of every claim check. openid-client is certified by the OpenID Foundation for the relying-party profiles, and turns the flow into a few calls that each check what the specification says. What is left to a4a (about 300 lines, with its routes) is mostly deciding who someone is. One default had to change: for an ID token received straight from the token endpoint, openid-client relies on TLS and doesn't check the signature; a4a turns that check on (`enableNonRepudiationChecks`), so the token's signature is verified against the provider's keys, as well as its issuer, audience, expiry and nonce. The tests sign tokens with `jose` in a provider made for them.

- **The redirect URI** is `PUBLIC_URL/api/v1/auth/oidc/callback`, sent the same at both steps; nothing in a request chooses it, and the URL handed to the library is built from it, not from the request's Host.
- **The state** is bound to the browser that started (an HttpOnly cookie) and stored with the PKCE verifier and nonce, keyed by its hash, for ten minutes. The callback takes the row (a `DELETE … RETURNING`), so a state works once.
- **Who someone is:** found by the provider's issuer and subject (`user_identities`). The first time, by email only when the provider says `email_verified: true`, and only to an account whose own email an administrator set or a provider verified (`users.email_verified`). An email people type for themselves never links: otherwise anyone could claim an address before its owner first signs in. An account already linked to another subject at the same provider isn't taken over by a second one with the same email (a reused address).
- **Optionally:** allowed email domains, accounts made on first sign-in, and password sign-in turned off (only while single sign-on is on).
- **Each sign-in starts a new session**, and ends the one the browser had.

- **Costs:** a provider's keys are cached; one that rotates a key under the same key id fails sign-ins until the cache expires (ten minutes). Back-channel logout and SCIM are not done: an account removed at the provider keeps its a4a sessions until they expire, or until an administrator bans it.
- **Revisit when:** several providers are needed (the table already keys identities by provider), or remote MCP needs OAuth (below).

**OAuth for remote MCP (not done).** What it would take: a4a as an OAuth 2.1 authorization server for `/mcp`, as the MCP authorization specification asks. Protected-resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource`, and `WWW-Authenticate` with `resource_metadata` on a 401 from `/mcp`; authorization-server metadata (RFC 8414); dynamic client registration (RFC 7591), since MCP clients register themselves; the authorization code flow with PKCE, signing the person in with a password or this single sign-on, and a consent page that names the client and lets the person choose scopes and projects, which become exactly a token limited to projects (D15); short-lived access tokens bound to the `/mcp` resource (RFC 8707) with refresh tokens, revocable from Agents and tokens; and rate limits on registration. The bearer tokens of today stay, for clients that don't speak OAuth.

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
- **History as it was.** An issue keeps its created and updated dates and its reporter, and its `issue.created` says it was imported (`data.imported`: source, key, original dates), as do its comments and work; triage leaves imported issues alone. Only the importer can set those, through `createIssueInTx`'s import option: no request can.
- **A dry run changes nothing:** the same reading and checks as a run, with the problems row by row and what applies to many rows said once.
- **The run is a job:** one per project at a time, claimed by a conditional update, each row in its own transaction, then links and parents in a second pass by key, so a row can name one later in the file. Its progress and heartbeat are on its row, so every instance shows it; one whose heartbeat has stopped for a minute (its instance died) reads as stopped, and running it again carries on, since rows done already are matched by key.
- **Undo** deletes, in one transaction, the issues the import made that nobody has touched since (no activity but the import's), and says why it keeps each of the others. It doesn't take back what it changed on issues that were already here: that would write old values over what happened since.
- **Who:** importing writes history as others made it, so it is managing the project: its managers, and administrators. In a members-only project, only its people can be its reporters, assignees and comment authors; anyone else in the file is left empty, and choosing them is refused.

- **Costs:** an upload is kept as rows until it is forgotten (`DELETE /imports/{id}`), about the file's size again.
- **Revisit when:** a YouTrack REST importer is wanted (not done): it would fill the same rows from the API instead of a file, and the rest stays.

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
| Retried `POST` | `Idempotency-Key`: the key is claimed before the work, on any instance; the stored response is replayed, and a key reused with a different body gets 422. A claim left by an instance that died mid-request can be claimed again after 5 minutes |
| Reference data (fields, values, users) | Cached in memory per instance, and reloaded on every instance after a change on any (`NOTIFY`; a change made inside a transaction is sent on its commit). A generation counter stops a slow reload from overwriting a newer invalidation. The 60s reload remains, for a notification that was lost |
| Live events, several instances | Every instance sends every event once, in id order, within about a second of its commit. A stream resumes from its last event id on any instance, missing and repeating nothing. A missed `NOTIFY` (a dropped `LISTEN` connection, a crash before sending it) is caught up from the log: on reconnect, or by the 10-second backstop |
| An id that commits late, or never | Readers of the log stop at a missing id until it appears, or until no transaction that was writing to the log when it went missing is running; one held for a minute is passed with a warning |
| Sign-in throttle | Shared in Postgres, per IP and per login, and kept across restarts. An attempt is counted before its password is checked, so parallel guesses can't pass the limit |
| Sessions | Rows in Postgres: valid on every instance; signing out ends a session everywhere |
| Instances starting together | Migrations, defaults and the unattended first administrator run under an advisory lock: one instance at a time. So does `POST /auth/setup` |
| An import run twice, or stopped halfway | Each issue is known by (project, source, key): a rerun updates or skips it, never makes it twice. Each row commits on its own, so a run that stopped carries on where it was |
| Two people arrange one dashboard | `expectedVersion`: the second gets 409 and the current version |

## Security

- **Passwords:** scrypt with a per-user salt.
- **Sessions:** random 256-bit tokens, stored as SHA-256 hashes. The cookie is `HttpOnly; SameSite=Lax`, plus `Secure` behind HTTPS.
- **CSRF:** cookie-authenticated unsafe requests must come from the server's own origin (Origin/Referer check). Bearer-token requests are not CSRF-able.
- **API tokens:** `a4a_` plus 256 random bits, stored as SHA-256 hashes, shown once. Each has scopes, an optional expiry, a last-used time, and can be revoked.
- **Login:** failed sign-ins are counted in Postgres per IP (50) and per login (10) in 15-minute windows, shared by every instance and kept across restarts. Starting a single sign-on is throttled per IP too, on each instance. The address comes from `X-Forwarded-For` only through the `TRUST_PROXY` proxies in front; otherwise the header is ignored, since clients can send it.
- **Single sign-on:** see D16.
- **Project access:** see D15. What can't be seen answers exactly as what doesn't exist.
- **The browser:** strict Content-Security-Policy; no inline script or style; fonts are bundled, nothing loads from outside; Markdown is rendered without raw HTML.
- **Uploaded files:** their type is read from their bytes; only raster images are shown in place; everything else is a download, served with `nosniff`, `Content-Security-Policy: sandbox` and `Cross-Origin-Resource-Policy: same-origin`. Names are made safe, and storage keys are random, so no name reaches the file system.
- **Webhooks:** signed with HMAC-SHA256 over the raw body. Only admins can create them, because the server will POST to the URL given (server-side request forgery to internal addresses is the admin's call).
- **Agents:**
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
- **General rate limits are per instance**, in memory (D17): behind N instances a client gets up to N × 1200 API requests a minute and N × 600 MCP requests. `API_RATE_LIMIT` and `MCP_RATE_LIMIT` set each instance's share. The sign-in throttle is shared.
- **A token's last-used time** is written at most once a minute per instance.
- **An assistant conversation whose instance dies mid-answer** takes messages again two minutes later: a turn claims its conversation in one statement and refreshes the claim every 30 s while it runs, so a claim left stale was cut off. The same claim stops two decisions sent at once from both running the changes.
- **Time zone.** Dates in queries ("today", "{this week}") use the server's time zone. Per-user time zones are future work.
- **Reports' days** are in the time zone asked for (the web app sends the browser's), each day as it stood at its end. A report reads at most 400,000 events. A sprint's working days and holidays are those of the plan of the first of its board's projects the reader can see, so a board whose projects keep different calendars draws on the first's.
- **An import** takes a CSV of 64 MB and 50,000 rows at most, one run per project at a time.
- **Readable ids** (`BACK-12`) are permanent because project keys can't be renamed. Renaming would need an alias table, as YouTrack keeps.
- **Files are on one disk.** Several instances need `DATA_DIR/attachments` on a shared volume until there's an S3 store (D18); back it up with the database.

## Not yet

Planned, with the seams already in place:

- groups of people with a role in a project (D15);
- OAuth 2.1 for remote MCP (what it takes is in D16);
- an importer that reads YouTrack's REST API, and Jira's (the CSV importer's rows are the seam);
- notifications;
- a VCS integration (`BACK-12 #Fixed` in commits);
- agents as assignees, and tokens issued to a bot user, so an agent can act as itself rather than for a person;
- undo for a change an agent made on its own (the assistant at Acts);
- in the web app: column heads that stay in view on boards with lanes, a chosen window for the load grid, and absences (today a day off is a day of zero capacity).
