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

### D18. Workflow rules: an outbox consumer that acts, and guards inside the write path

A rule belongs to a project (or, for administrators, to every project) and is one of three kinds. All three are the query language for *which issues* and the command language for *what to change*, so a rule is checked, previewed and explained the way a query or a command is.

**Rules on a change and scheduled rules act afterwards, as the workflow agent.**

- Rules on a change run in the outbox worker, as a consumer of `issue.created`, `issue.updated` and `comment.created`. Each rule the event sets off acts when the issue, as it is when the rule runs, matches the rule's query. All of them are evaluated in one read, against the issue as the change left it.
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

### D19. Version control: verified deliveries, idempotent links, commands as the verified author

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

## Consistency and concurrency

| Concern | Guarantee |
| --- | --- |
| Two people edit one issue | Changes serialise on the issue row. With `expectedVersion`, the second gets 409 and the current version. The web app always sends it and re-reads the issue on 409 |
| Levelling while the plan changes | `expect` (the proposal's starts) makes applying conditional: 409 instead of a different plan than the one agreed |
| Issue numbers | `UPDATE projects SET next_number = next_number + 1 … RETURNING` inside the creating transaction: gap-free per project, safe under concurrency |
| A history entry without its change, or the reverse | Impossible: same transaction |
| Webhooks and triage | At least once, in id order, from the outbox, by the one instance that holds the lease. The lease runs on the database's clock and is renewed while a consumer is busy; a cursor moves only while its lease holds |
| Retried `POST` | `Idempotency-Key`: the key is claimed before the work, on any instance; the stored response is replayed, and a key reused with a different body gets 422. A claim left by an instance that died mid-request can be claimed again after 5 minutes |
| Reference data (fields, values, users, workflow rules) | Cached in memory per instance, and reloaded on every instance after a change on any (`NOTIFY`; a change made inside a transaction is sent on its commit). A generation counter stops a slow reload from overwriting a newer invalidation. The 60s reload remains, for a notification that was lost |
| Live events, several instances | Every instance sends every event once, in id order, within about a second of its commit. A stream resumes from its last event id on any instance, missing and repeating nothing. A missed `NOTIFY` (a dropped `LISTEN` connection, a crash before sending it) is caught up from the log: on reconnect, or by the 10-second backstop |
| An id that commits late, or never | Readers of the log stop at a missing id until it appears, or until no transaction that was writing to the log when it went missing is running; one held for a minute is passed with a warning |
| Sign-in throttle | Shared in Postgres, per IP and per login, and kept across restarts. An attempt is counted before its password is checked, so parallel guesses can't pass the limit |
| Sessions | Rows in Postgres: valid on every instance; signing out ends a session everywhere |
| Instances starting together | Migrations, defaults and the unattended first administrator run under an advisory lock: one instance at a time. So does `POST /auth/setup` |
| A guard and the change it checks | Same transaction: the change is checked after it's written and before commit, and refused all or nothing (D18) |
| A rule acting on a replayed event, or a loop of rules | Once per (rule, issue, change that started the chain), claimed in the rule's own transaction; chains stop three rules deep |
| A scheduled rule's turn | Claimed by moving its next run on, conditionally, by the instance holding the worker's lease |
| A delivery from version control sent twice | Its delivery id is claimed before the work; links are unique per issue and commit (or pull request), so even a second delivery id changes nothing twice |

## Security

- **Passwords:** scrypt with a per-user salt.
- **Sessions:** random 256-bit tokens, stored as SHA-256 hashes. The cookie is `HttpOnly; SameSite=Lax`, plus `Secure` behind HTTPS.
- **CSRF:** cookie-authenticated unsafe requests must come from the server's own origin (Origin/Referer check). Bearer-token requests are not CSRF-able.
- **API tokens:** `a4a_` plus 256 random bits, stored as SHA-256 hashes, shown once. Each has scopes, an optional expiry, a last-used time, and can be revoked.
- **Login:** failed sign-ins are counted in Postgres per IP (50) and per login (10) in 15-minute windows, shared by every instance and kept across restarts. Starting a single sign-on is throttled per IP too, on each instance. The address comes from `X-Forwarded-For` only through the `TRUST_PROXY` proxies in front; otherwise the header is ignored, since clients can send it.
- **Single sign-on:** see D16.
- **Project access:** see D15. What can't be seen answers exactly as what doesn't exist.
- **The browser:** strict Content-Security-Policy; no inline script or style; fonts are bundled, nothing loads from outside; Markdown is rendered without raw HTML.
- **Webhooks:** signed with HMAC-SHA256 over the raw body. Only admins can create them, because the server will POST to the URL given (server-side request forgery to internal addresses is the admin's call).
- **Deliveries from version control:** checked (signature or token, in constant time) before anything is read; rate-limited; refusals logged at a bounded rate. Commands in commits run only as a person whose email is confirmed, and only where they can change issues (D19). Links from a payload are shown only if they are http(s).
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
- **An assistant conversation whose instance dies mid-answer** stays "running", so it can't take another message; a new conversation can. Fixing it belongs to the assistant (a claim that expires, as idempotency keys now have).
- **Time zone.** Dates in queries ("today", "{this week}") use the server's time zone. Per-user time zones are future work.
- **Readable ids** (`BACK-12`) are permanent because project keys can't be renamed. Renaming would need an alias table, as YouTrack keeps.

## Not yet

Planned, with the seams already in place:

- groups of people with a role in a project (D15);
- OAuth 2.1 for remote MCP (what it takes is in D16);
- attachments;
- a knowledge base;
- notifications;
- agents as assignees, and tokens issued to a bot user, so an agent can act as itself rather than for a person;
- undo for a change an agent made on its own (the assistant at Acts);
- in the web app: column heads that stay in view on boards with lanes, a chosen window for the load grid, and absences (today a day off is a day of zero capacity).
