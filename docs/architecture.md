# Architecture

This is how a4a is put together, and why. Each decision says what it costs and when to revisit it, so the next change can argue with it instead of guessing.

## The system

```text
                 ┌──────────── each instance (one, or several behind a proxy: D17) ─────────────┐
  browser ──────▶│ /            web UI (React SPA, Ocean)            static files, strict CSP   │
  scripts ──────▶│ /api/v1/*    REST + OpenAPI (Hono, zod) ─┐                                   │
  MCP clients ──▶│ /mcp         MCP, Streamable HTTP ───────┼─▶ services ──▶ Postgres / PGlite  │
  stdio clients ─│ (a4a-mcp bridge ─▶ /mcp)                 │      │                            │
  directories ──▶│ /scim/v2     SCIM provisioning (D38) ────┤      └─▶ activities (outbox)      │
                 │ assistant    Claude tool loop ───────────┘                   │               │
                 │ worker       webhooks · rules · triage · notifier · chat ◀───┤               │
                 │ live feed    SSE, on every instance ◀────────────────────────┘               │
                 │ senders      mail, chat and push outboxes ─▶ SMTP · Teams · Slack · push     │
  people outside▶│ /help /request /portal  the help desk's form, tracking and portal (D24, D45) │
  guests ───────▶│ /public/*    projects open to guests, read without signing in (D37, D64)     │
                 └──────────────────────────────────────────────────────────────────────────────┘
```

| Package | Role |
| --- | --- |
| `packages/shared` | The contract: zod schemas for every request and response, and constants. The server validates with them, generates OpenAPI from them, and the UI types itself from them. Beside them, what the server and the web read alike: periods, ids in text, Markdown, and each language's catalog (`i18n/`, D49). |
| `packages/server` | Services (the domain), the query and command languages, the planning engine, AI, MCP, HTTP, and the background worker. |
| `packages/mcp-bridge` | `a4a-mcp`: a 60-line stdio-to-HTTP bridge for MCP clients that only speak stdio. |
| `packages/vscode` | a4a's extension for VS Code, which works through a4a's MCP tools (D46). |
| `apps/web` | The SPA, on the Ocean design system, pinned to a commit. |

## Decisions

### D1. One TypeScript monorepo, one contract

The API, the MCP server, the UI and the agents all describe the same objects. The zod schemas in `packages/shared` are the single definition. The server validates requests with them, the OpenAPI document is generated from them (component names from `.meta({ id })`), and the UI imports their inferred types.

- **Costs:** the contract package must stay free of server-only code.
- **Revisit when:** a client in another language needs an SDK. Generate it from `/api/v1/openapi.json`.

### D2. Postgres semantics everywhere; PGlite only for development and small teams

There is one SQL dialect, with Postgres full-text search and `pg_trgm` for similarity. Without `DATABASE_URL`, the server runs embedded PGlite (Postgres compiled to WASM) in `DATA_DIR`, so `pnpm dev` needs nothing installed. Production sets `DATABASE_URL` to real Postgres. The same Drizzle schema and migrations run on both, and the test suite runs against both.

- **Costs:** PGlite has one connection and runs in-process, so it is for development, demos and a single team, not for load. It is also one process: a lock file stops a second one on the same machine from opening its directory. The lock goes by process id, so containers sharing a volume, each its own process 1, don't see each other's. Several instances need Postgres (D17).
- **Revisit when:** never for production. Use Postgres.

### D3. Custom fields as typed rows, not JSON

Every project picks its fields (State, Priority, Assignee, Estimation, Start date …) from a shared catalogue. Option values can be shared or scoped to one project. A value is stored as a row in `issue_field_values`, with typed columns (`value_id`, `user_id`, `group_id`, `number_value`, `date_value`, `time_value`, `text_value`; the group and the instant came with D41's kinds).

- **Why:** queries and sorts need types (priority sorts by its order, not alphabetically), references need integrity (a deleted user can't linger as a string), and renaming a value must not rewrite every issue.
- **Costs:** a search term becomes a correlated `EXISTS`, so `(issue_id, field_id)`, `(field_id, value_id)`, `(field_id, user_id)` and `(field_id, group_id)` are indexed.
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

**Since:** the same function, in the same transaction, checks guards (D25), state machines (D40), fields' conditions (D41) and private fields (D50), keeps what undoing an agent's change needs (D34), and moves a help desk request's SLA clocks (D45).

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

The other consumers are workflow rules (D25), the knowledge base's mentions and the file sweeper (D19, D18), the notifier and the help desk's mail (D22, D24), and chat's posts (D42). Most register beside their feature, as triage does (`ai/register.ts`, `notify/register.ts`).

### D6. The query and command languages compile to parameterised SQL

The lexer keeps positions, so problems point at characters. The parser is schema-aware, so `State: In Progress` and `fix versions: 2.0` work without quotes: it matches the longest known field name and value. The compiler emits Drizzle `sql` fragments, and every user value is a bound parameter. There is no `sql.raw` on input, so injection is impossible by construction.

Problems come back as `{message, start, end, hint, fix}` (D13), for example *Unknown value "Fixd" for State · Did you mean "Fixed"?*, with a key and values a page says in its own language (D49). The UI underlines them, and agents repair their own queries from them.

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

Every service function checks the scope it needs (`requireScope`), so a REST route, an MCP tool and the assistant can't drift apart: there is no route-level permission logic to forget. Two lists at the edge only narrow which routes may be called at all, by a guest (D37, D64) or by an app's widget (D48); what a call reaches, the services still decide.

All project visibility goes through one module (`services/access.ts`): see D15 for what it decides.

### D8. MCP is a curated tool layer, shared with the assistant

`tools/` defines 60 task-shaped tools once (`summarize_issue` among them, offered only while the server has an AI provider: D59), each with:

- a zod schema;
- a handler over the services;
- MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`);
- an Ocean grammar tag (`reads`, `changes`) used by the UI.

The MCP server registers them, with 5 resources and 6 prompts, and the in-app assistant gives the same tools to Claude. Results are compact text and JSON with readable ids, sized for an agent's context.

The transport is stateless Streamable HTTP: a new `McpServer` per request, authenticated by bearer token. Nothing to sticky-route, and it restarts safely.

MCP deletes no issue, article, file or whiteboard; what an agent can take away (a link between issues, someone copied on a request, a chat channel's subscription) is put back as easily. Bulk commands are capped at 50 issues and have `dry_run`.

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
- Writing and reading help is capped per person per hour, and by the size of what it's sent (D59).

**Without a key**

- AI endpoints return `503 ai_disabled`.
- Lexical similar-issue search (full-text search plus trigram) keeps working.

### D10. Planning is a pure engine over a snapshot

The planning service loads a project's issues, fields, links, work items, people (with their working weeks, D43, and days away, D36) and calendar. It hands the engine plain data; the engine (`planning/*`) is pure functions:

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

The UI takes `@sreent/ocean` pinned to a commit and imports its tokens and component CSS. a4a's own pieces (the issue list, query and command bars, field panel, links, history, board, Gantt, load grid and cost panel) were added to Ocean first, each with its markup contract, and a4a's components emit that markup. The first of them came in sreent/ocean#7, and each piece since went into Ocean the same way; the pin is a commit of Ocean's `main`.

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
- **Tested live.** `pnpm --filter @a4a/server test:live` runs every AI feature against the configured provider, on the demo data, and checks what must hold whatever the wording. CI runs it on `main` for DeepSeek and Qwen, each when its key is a repository secret. CI doesn't run Claude live; the command does, wherever `ANTHROPIC_API_KEY` is set. On DeepSeek V4 Pro and Qwen 3.8 Max it found the faults above, and three in a4a itself:
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

- **Someone's role in a project** is, in order: manager if they're an administrator or its lead; otherwise the highest of the role the project gives them and the roles it gives groups they're in (D27); otherwise member, if it is open. So an open project can still keep someone to reading, by naming them a viewer, and the lead can never lock themselves out. (Roles became sets of permissions, custom ones too, and someone may do what all their roles there allow together: D37.)
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
- **Not done:** tags stay instance-wide, so a tag's name is seen by everyone; a webhook delivers every project's events, members-only ones included (only administrators make them), though never what's limited to some people (D37, D51) or a private field (D50).
- **Groups** came as this section planned (D27): a `project_group_roles` table joins the same query, and the rest stayed as it was.
- **Access in depth** came on the same seam (D37): roles as sets of permissions, issues and comments limited to some people, and guests.

### D16. Single sign-on with OpenID Connect, through openid-client

People can sign in with their organisation's identity provider: the authorization code flow with PKCE (S256), a state and a nonce, configured from `OIDC_*` in the environment.

**The choice: `openid-client` (v6), not `jose` and our own code.** Both are by the same author; `jose` would do the cryptography well, but the protocol around it would be ours: discovery and its issuer check, building the request, the token request and client authentication, RFC 9207's `iss`, the order and meaning of every claim check. openid-client is certified by the OpenID Foundation for the relying-party profiles, and turns the flow into a few calls that each check what the specification says. What is left to a4a (a few hundred lines, with its routes) is mostly deciding who someone is. One default had to change: for an ID token received straight from the token endpoint, openid-client relies on TLS and doesn't check the signature; a4a turns that check on (`enableNonRepudiationChecks`), so the token's signature is verified against the provider's keys, as well as its issuer, audience, expiry and nonce. The tests sign tokens with `jose` in a provider made for them.

- **The redirect URI** is `PUBLIC_URL/api/v1/auth/oidc/callback`, sent the same at both steps; nothing in a request chooses it, and the URL handed to the library is built from it, not from the request's Host.
- **The state** is bound to the browser that started (an HttpOnly cookie) and stored with the PKCE verifier and nonce, keyed by its hash, for ten minutes. The callback takes the row (a `DELETE … RETURNING`), so a state works once.
- **Who someone is:** found by the provider's issuer and subject (`user_identities`). The first time, by email only when the provider vouches for it, and only to an account whose own email an administrator set or a provider verified (`users.email_verified`; its person confirming it by a mailed link sets it too, D33). An email people type for themselves never links: otherwise anyone could claim an address before its owner first signs in. A provider vouches with `email_verified: true`; Microsoft Entra ID, which never sends that, vouches with its optional claim `xms_edov`, that the email's domain is one the tenant verified. Either must be a real `true`, not a string. An account already linked to another subject at the same provider isn't taken over by a second one with the same email (a reused address).
- **Optionally:** allowed email domains, accounts made on first sign-in, and password sign-in turned off (only while single sign-on, or a directory, is on: D38).
- **Each sign-in starts a new session**, and ends the one the browser had.

- **Costs:** a provider's keys are cached; one that rotates a key under the same key id fails sign-ins until the cache expires (ten minutes). Back-channel logout is not done: an account removed at the provider keeps its a4a sessions until they expire, until an administrator bans it, or until provisioning deactivates it (SCIM, D38).
- **Revisit when:** several providers are needed (the table already keys identities by provider). (Several came for the help desk's requesters only, kept apart from the team's: D63.)

**OAuth for remote MCP** is D28: a4a is the authorization server for `/mcp`, and signs the person in on the way with a password or this single sign-on.

### D17. Several instances on one Postgres behave as one

a4a runs as one process or as several behind a load balancer, on one Postgres, and behaves the same either way. Nothing is sticky: any instance can serve any request. What one process would keep to itself is shared, or is per process on purpose:

| What | How |
| --- | --- |
| Live events (SSE) | Each instance reads the activity log in id order and hands every event to its streams once. After commit, the writer sends `NOTIFY a4a_events` with the new ids (ids, never data), so the others read within milliseconds |
| The reference-data cache | `NOTIFY a4a_schema` after a change. A change inside a transaction (a tag created with an issue) is sent in it, so it arrives on commit and never on rollback. The 60-second reload stays as the safety net |
| The sign-in throttle | One table, `login_throttle`: a row per IP and per login, one upsert per attempt |
| The outbox worker | One lease row, on the database's clock |
| Sessions, tokens, idempotency keys, webhook deliveries | Already rows in Postgres; checked below |
| General rate limits | Per instance, on purpose; below |
| Migrations, defaults, the first administrator | Under an advisory lock, one instance at a time, so replicas starting together on an empty database don't race |

**Reading the log in order.** Ids come from a sequence at insert, but transactions commit in their own order: 41 can become visible after 42, and an id taken by a transaction that rolls back never appears. A reader that moved past 41 when it saw 42 would never send it, and a client resuming "after 42" would miss it. Taking only rows older than a few seconds, and moving past anything missing, would lose for good the events of a transaction that took longer. So the live feed and the worker stop at a missing id, and pass it once it can no longer appear: every transaction that was writing to the log when the gap was seen has ended.

- Postgres's lock table says which those are: an insert holds a lock on `activities` from before it takes its id (the lock comes with parsing, the id with executing) until its transaction ends. Unrelated work, even a session left open, doesn't count.
- `pg_current_snapshot()` would not do: its list of running transactions leaves out one whose id is newer than every finished one, which is just the one that took the missing id last.
- A rolled-back id holds live events for about a tenth of a second, until the next read.
- A gap held for a minute is passed with a warning, so a transaction left open after writing to the log can't stall it. Its event stays in `GET /events`.

**Signals are doorbells.** A notification only says "look"; every reader works from the log and its own cursor. That is also the dedupe: an event is sent only when it is the next id after the cursor, so the bus, `NOTIFY`, a reconnect and the backstop can all wake the feed without anything being sent twice. And it makes a lost notification cheap, which matters, since `NOTIFY` is not durable:

- Each instance listens on a connection of its own. After a reconnect it tells every reader to catch up from the log.
- That connection pings itself every 30 seconds, and reconnects when its own notification doesn't come back: a network path that died without an error, or a pooler in transaction mode, which drops `LISTEN` (point `DATABASE_LISTEN_URL` past it).
- **A polling tail is the backstop**, every 10 seconds. It covers what the two above don't: a process that died between its commit and its `NOTIFY`, or a write path that forgot to publish. It costs one indexed read per instance every 10 seconds that usually finds nothing, and it bounds the worst case at 10 seconds instead of "until the next event".

**Resuming a stream.** Each frame's `id` is its event's id. Since every instance sends events in id order, it is a true watermark: everything up to it was sent, or never existed. A client that reconnects, to any instance, sends it back (`Last-Event-ID`, which browsers send by themselves, or `?after=`), and the stream replays the log after it before going live. Past 1000 missed events it sends `resync` instead, with the id to go on from: re-read, or page through `GET /events`. An instance that shuts down ends its streams, so their clients reconnect elsewhere and resume.

**The worker lease.** One row in `worker_leases`, taken with one upsert that succeeds for the holder, or for anyone once the lease has expired.

- Its times are the database's (`now()`), never an instance's, so instances whose clocks disagree can't both believe they hold it.
- The holder renews it on every pass, and every 10 seconds while a consumer is busy: a webhook with its retries (up to 35 seconds) can outlast the 30-second lease, and a second instance would start the same work.
- The holder stops handing out events once its own deadline passes without a renewal, and a cursor moves only while the lease is still the holder's in the database. So a holder that stalled can't move its successor's cursor.
- A holder that stops cleanly releases the lease, after at most 5 seconds for the event in hand, and the next instance takes it at its next poll. One that dies is replaced within the lease (30 seconds) plus one poll (2 seconds).
- Periodic upkeep (expired sessions, sign-in windows that have passed) runs on the holder, so it runs once.

**The sign-in throttle.** Failures count per IP (50 per 15 minutes) and per login (10), in a fixed window, with one upsert for both rows.

- An attempt is counted before the password is checked, so parallel guesses on several instances can't slip past the limit between a check and a write. A correct password takes its count back.
- A fixed window lets twice the limit straddle a window's edge. The average holds, and a sliding window would need a second count per row for little gain.
- The price of a per-login limit: someone who knows a login can keep it locked by failing ten times a window. Its owner waits for the window, as the 429 says.

**General rate limits stay per instance.** A shared limit would add a write, to a hot row per caller, to every request. That would be the most frequent write in the system, to guard capacity that is per instance anyway: a runaway script exhausts the instance it hits, not the cluster. These limits are not a security boundary; the sign-in throttle, which guards accounts, is shared. Behind N instances a client gets between one and N times the limit (`API_RATE_LIMIT`, 1200 a minute; `MCP_RATE_LIMIT`, 600; `GUEST_RATE_LIMIT`, 300 per address, D37). Set them to each instance's share, or limit at the proxy when one number must hold.

**Client addresses.** Behind a proxy, every request comes from the proxy, and `X-Forwarded-For` is whatever the client sent plus what the proxies added. `TRUST_PROXY` says how many proxies append to it; the client is the entry the outermost one added. With 0, the default, the header is ignored. Taking its first entry instead would let a client choose its own address and walk around the per-IP limits.

**Checked, and right already.** Sessions and tokens are rows: a session made on one instance works on all, and signing out ends it everywhere. An `Idempotency-Key` is claimed by inserting its primary key, so two instances can't both run it, and a retry on the other instance replays the answer. A claim left by an instance that died mid-request can be claimed again after 5 minutes; until then a retry answers 409. Webhooks are delivered by the lease holder only.

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

The other store is an S3-compatible bucket (S3, MinIO, R2), chosen with `ATTACHMENT_STORAGE=s3`, behind the same three calls. Downloads still come through a4a, so the access check and the headers stay its own: D35.

**Serving.** `GET /attachments/{id}/content` reads the project through `services/access.ts`; a hidden one looks like a missing file.

- PNG, JPEG, GIF and WebP come `inline`, so they show in place. Everything else, SVG and HTML included, is an `attachment`, whatever its name says: an HTML page named `cat.png` downloads as `cat.png`, typed `text/html`.
- Every file comes with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox` and `Cross-Origin-Resource-Policy: same-origin`. The page middleware leaves a response's own policy in place, so an HTML file keeps its sandbox.
- `Cache-Control: private, max-age=86400`, with the SHA-256 as the ETag (`If-None-Match` gets 304): a file's bytes never change under its id, but who may see them can, so only the browser keeps them.

**Cleaning up.** Rows go with their issue, comment, article or project, by cascade or by the sweeper, but bytes don't. The sweeper removes blobs nothing points at: "stored" ones whose row is gone, and "uploading" ones older than six hours. It also removes a deleted comment's files, and part files a crash left. It runs as an outbox consumer after the events that can leave files behind (`attachment.removed`, `issue.deleted`, `comment.deleted`, `article.deleted`), and once when the server starts. It's safe to run anywhere and more than once at a time.

**Retries.** An upload sent again with the same `Idempotency-Key` is replayed. Its body isn't read twice, so the key is matched on the request's length rather than a hash of the body.

- **Costs:** a project's deletion leaves its files until the next sweep. Thumbnails are the images themselves, scaled by the browser.
- **Revisit when:** files are large or many. Make server-side thumbnails then, and serve through presigned URLs. (A bucket came, still served through a4a, and thumbnails made on the server were weighed and left out: D35.)

### D19. The knowledge base: articles per project, ids no issue can have, whole versions, mentions from the outbox

**Per project, no global space.** An article belongs to a project, and the project's access is the article's: the knowledge base reads it through `services/access.ts` (D15) and has no policy of its own. (Articles limited to some people came, checked up the tree: D51.) A global space would need a second policy of its own (who reads it, who writes it) and a second kind of id. A team that wants documents beyond one project makes a project for them, which costs nothing.

**Ids.** `BACK-A-3`, as YouTrack writes them: numbered per project from a counter row, gap-free and never reused, so a link to an article never comes to mean another.

An article's id can't be read as an issue's, and the reverse:

- Issue ids have no third part, and a project key is at least two characters, so the `A-3` inside `BACK-A-3` is no issue.
- One reading of ids in text, `findRefs` in `@a4a/shared`, serves the web app's links and the server's mentions, so what links is what counts. It leaves out ids in code and in addresses.
- The query and command languages' issue-id parsing refuses `BACK-A-3`; as free text it's a search.

**The tree.** Each article has a parent (or none) and a dense position among its siblings. Changes to a project's tree (creating, moving, deleting) take that project's counter row as a lock, and moving under a descendant is refused by walking up from the new parent. Two moves at once can't make a cycle between them. An article with articles under it can't be deleted: they're moved first.

**Versions.** Every save that changes the title or body writes the whole text as a new version, with who, when, the channel and the token. Diffs are worked out when read (Myers' algorithm, line by line), so a version is never wrong because a diff was. `expectedVersion` gives 409 instead of overwriting a newer save; bringing an old version back saves it as a new one.

**Search.** As for issues: a generated `tsvector` (title weighted A, body B) with prefix matching, and trigram word similarity on titles for near misses, with `ts_headline` snippets whose matches are marked.

**Mentions.** Ids in an article, in an issue's description or in a comment are recorded in `mentions`, with the target as written (`BACK-A-3`), or as it reads now for an issue that has moved (D41) or whose project's key was renamed (D52); a mention of an article written before the article exists counts once it does.

- An article's mentions are written in the transaction that saves it.
- An issue's description and its comments are read by an outbox consumer, from the events their write path already records. So `applyChanges` needs to know nothing of the knowledge base.
- The consumer reads the text as it is when it runs, so running twice, or late, lands in the same place.
- A deleted comment's mentions stop counting at once, at read time, before the consumer removes them.

- **Costs:** an issue's new mention of an article shows on the article a moment later, once the worker reads its event. Issue text from before the knowledge base existed isn't indexed until it's next edited. Versions keep whole texts, which is more space than diffs.
- **Revisit when:** articles are long and edited often. Store diffs between occasional whole versions then.

### D20. End-to-end tests run the production build, with the AI stood in for in the browser

`apps/web/e2e` drives Chromium against what ships: the built server serving the built UI, under its real CSP, on a fresh embedded database with the demo data. A dev server would hide what only the build does (the CSP over every page, the bundled assets, the server serving them).

- **Isolation by data, not by server.** One server per run; each spec file makes its own projects, boards and people, with keys no other file or retry has, so files run in parallel. Specs that only read (the tour) hold the live feed, so other specs' writes can't redraw a page mid-check.
- **Four administrators**, one taking the tour and three for the flows, each spec file signed in as one of them, because the server allows each person 1200 API requests a minute, and a browser session counts as its person: every file of one person's shares their allowance. The tour and the flows together came to about 900 when there were 140 tests; at 210, the flows alone passed 1200 on four workers; at 280, `admin`'s files did, and their pages logged 429s. A file reads what's personal to its page's person (saved searches, tokens) only through that person, and one whose page shows what the run's token changed under `admin`'s name stays with `admin`. The limit (`API_RATE_LIMIT`) is held at its default rather than raised, so a page that starts asking too much shows up as a 429 in its console.
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
- **Reading another tracker's API** fills the same rows instead of a file, and the rest stays: YouTrack's and Jira's (D29), GitHub Issues', Redmine's and Zendesk's (D46), Asana's and ClickUp's (D61).

### D22. Notifications come from the outbox, once per person per event, a burst at a time

People watch what they report, are assigned, comment on or are mentioned in (`@login`), and what they choose to. Watching starts in the transaction that made the change (`applyChanges`, `createIssue`, `updateComment`), not in a consumer, so unwatching right after commenting holds. Unwatching lasts until the person takes part again, as GitHub's does. Agents never watch: they're told only when assigned or mentioned. Watchers hear of changes, comments, links and files on the issue (a comment's own files go with the comment), and of its deletion.

The change's activity says what notifications need, as logins, worked out against the issue before the change: `data.assigned` (new assignees), `data.mentions` (people newly mentioned, not those mentioned already), and on deletion `data.watchers`, whose rows go with the issue. Text from a help desk's requester mentions nobody.

The notifier is an outbox consumer (`notify/notifier.ts`). For each event it finds who it concerns, with the strongest reason (`assigned` over `mentioned` over `request` over `rule` over `watching` over `subscribed`; `rule` is D32's, `subscribed` D31's), and leaves out whoever acted and whoever can't see the project as they would signing in (`projectRolesOf`), and, for a link, the issue at its other end. Each person's delivery is one transaction:

1. **Once.** `notification_events (user_id, event_id)` is the key. An event the outbox hands over twice, or two instances deliver at once, reaches a person once.
2. **A burst is one.** An unread notification about the same issue, begun within `NOTIFY_WINDOW_SECONDS` of this event (by the events' own times, so a replay folds the same way) and not yet sealed by its email, takes the event under `FOR UPDATE`; otherwise a new one starts. A read one never takes more: what came after you read it is new.
3. **Its email** is queued in the same transaction if the person wants this kind (D23), due when the window has passed. So is a push to each of their devices, by their push level (D47).

What a notification shows is its events, read from the activity log, so there's one account of what happened. The inbox lists only projects the reader can still read. Marking read takes `until` (the latest event the reader saw), so what arrived since stays unread.

Watching, reading and email preferences are the person's own, like their tokens: no activity, no webhook, nothing in the issue's history. A viewer may watch what they can read; a token needs `write` to change any of it, and `read` to see the inbox.

**Access.** What reaches a person is checked against their own access, never the actor's:

- Someone mentioned in a members-only project they aren't in is told nothing and doesn't watch it; the change's `data.mentions` names only the people it told. The composer offers only the project's people.
- A watcher who loses sight of a project keeps their row, but isn't listed or told, its notifications leave their inbox, and their queued email isn't sent (it's checked again as it's rendered). Given access again, it all comes back.
- A notification's events are shown as the issue's history would show them to its reader: a link to an issue they can't see is left out.
- A token limited to some projects reads and marks only those projects' notifications. An issue the caller can't see answers 404, in the words used for one that doesn't exist.

The unread count is live on every instance: a change tells this process's open streams (`GET /notifications/stream`) and, by `NOTIFY` on `a4a_inbox` with the people's ids only, every other instance's. Each stream also counts again every 15 seconds, and after `LISTEN` reconnects, for a notification that was lost. A stream ends when its instance stops, and the client reconnects, to any instance: it carries a count, not events, so there's nothing to resume.

- **Costs:** a row per person per event in `notification_events`; read notifications are kept 180 days.
- **Revisit when:** a team wants subscriptions by kind of change. Subscriptions to a project or a saved search are D31. (Subscriptions by kind came, each person's choice: D45.)

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

- **A requester isn't a user.** They're a row of their own (`requesters`: email and name), so they can't sign in (but to the portal, which opens nothing of the team's: D45, D63), never appear among people to assign or mention, and can be found and forgotten by email. Their issue is reported by the `helpdesk` agent through the `helpdesk` channel, and its history names them. The agent acts with an elevated system context that reaches the request's project only (`actor.projectIds`), so it works in a members-only project and nowhere else.
- **Tracking tokens are hashed, and minted as they're sent.** Each email to the requester carries a fresh 256-bit token, made while the email is rendered and kept only as its SHA-256 hash, so no token waits in plain text, in the outbox or anywhere; one minted for a failed attempt is deleted. Every token stays good for the request. Only without SMTP does the form's answer carry one, once, since no email will. In a link the token sits in the fragment; to the API, in a header.
- **Comments are internal unless made public.** A comment's `visibility` is `internal` by default, on every channel; `public` is allowed only on a request, and is the only thing the requester's page and email show. The requester's own replies are public comments by the `helpdesk` agent, with `requester_id`, and tell the issue's watchers. The project's lead watches each new request and is told of it (`request`).
- **The first-response target** is per project, in hours round the clock; the deadline in force when a request was filed is kept on it. The first public reply from the team answers it, and so does resolving it without one; it's worked out when read (`slaOf`, and the same in SQL for `sla:`), so nothing has to be updated when a reply comes.
- **Public routes reveal nothing beyond the one request,** and answer alike whether a project, request or token is missing or just not theirs. The form's posts need an `Origin` of this server and a signed form token tied to a `SameSite=Strict` cookie; anything anonymous may post is small (body limits), limited per address, per email and per help desk, and a hidden field catches bots. Turning the help desk off closes the form; requests already filed keep their pages.
- **Who does what.** A project's managers set its help desk up, like its other settings. A public reply answers the requester for the project and counts as the first response, so it takes someone who may change the project's issues; a viewer's comments on a request stay internal. On a members-only project the form shows the project's name and intro to anyone with its address; that is what opening it means, and the settings say so.
- **Limits are shared** by every instance, in Postgres (`help_throttle`, fixed windows, emails and tokens counted by their hash), as the sign-in throttle is, so a spammer behind a load balancer gets what one instance would give.
- **Costs:** no proof the email is the requester's (docs/mcp-and-api.md, 8a); first-response hours count round the clock, not working hours. (SLA policies in working hours came, and a desk without them keeps this one target: D45.)
- **Since:** requests and replies by email, and a proof of work a desk can ask its form for, are D30; SLAs, a mailbox per desk, requester accounts and a portal, and the team replying by email are D45; customer groups are D56, CCs D57, the portal's own sign-in D63, and its passkeys D69.

### D25. Workflow rules: an outbox consumer that acts, and guards inside the write path

A rule belongs to a project (or, for administrators, to every project) and is one of three kinds. All three are the query language for *which issues* and the command language for *what to change*, so a rule is checked, previewed and explained the way a query or a command is.

**Rules on a change and scheduled rules act afterwards, as the workflow agent.**

- Rules on a change run in the outbox worker, as a consumer of `issue.created`, `issue.updated` and `comment.created`. Each rule the event sets off acts when the issue, as it is when the rule runs, matches the rule's query. All of them are evaluated in one read, against the issue as the change left it. An import's events set none off (D21).
- Scheduled rules (every hour, day or weekday, at a time, in the server's time zone) run as one of the worker's chores, which only the instance holding the worker's lease runs (D17). A turn is claimed by moving the rule's next run on (a conditional update), so it runs once even if the lease changes hands. Issues are read in pages by id, up to 2,000 a run, and a run stops between pages if the lease has gone to another instance.
- Both apply through the command executor's own step (`commandSpec`, then `applyChanges`), as the `workflow` bot with channel `automation`, with "me" standing for whoever made the change that set them off. The bot runs as triage's does: administrator scopes, limited (`actor.projectIds`) to the project of the issue it acts on, members only or not. So a rule never reads, links to or changes another project's issues: a link changes both its issues, and a rule's command may link only within its project, which is checked when the rule is saved.
- A rule that fails is written in its run log with why, and never stops the others or the outbox.

**Who sees rules, and who makes them.**

- Reading a project's rules and their run log needs only reading the project, and a rule of a project someone can't see answers as one that doesn't exist (404, in the same words). Making, changing, turning off and deleting them needs one of the project's managers (D15); a rule for every project needs an administrator whose token reaches every project. (Only administrators make, change or delete a rule that calls a webhook or runs a script, which managers can still turn off: D32, D40.)
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

**What it costs.** A rule acts just after a change, once the worker reads its event (D17), not inside it, so a person sees their own change first and the rule's a moment later, each in the history under its own name. Dry runs don't evaluate guards (they write nothing to evaluate), so a command's preview can't say a guard will refuse it; applying it does, per issue. Guards see changes made through the write path: deleting a comment or logging work isn't checked. A new or changed guard holds on another instance once its snapshot reloads: at once, when the change's `NOTIFY` arrives, or within a minute if a notification is lost.

**Agents can't make rules.** They list them and preview them over MCP. A rule acts later, on its own, on every issue that ever matches it: it would outlive the conversation and the caps on an agent's commands, and agents read text anyone can write.

**Revisit when:** rules need to read more than one issue (a parent's state, a sprint's), or to do something other than a command (notify, call out): then a small expression language over the issue, still evaluated by the same engine. (Related issues, telling people and calling a webhook came as words in the rule's sentence rather than a language: D32. Rules written as scripts came: D40.)

### D26. Version control: verified deliveries, idempotent links, commands as the verified author

GitHub and GitLab post pushes and pull (merge) requests to `/api/v1/vcs/hooks/{integration}`.

- **Who sent it.** GitHub's `X-Hub-Signature-256`, an HMAC-SHA256 of the raw body, is recomputed and compared in constant time; GitLab's `X-Gitlab-Token` is hashed and compared in constant time. The raw bytes are read before anything parses them. GitHub's secret is an HMAC key, so a4a keeps it to check signatures (as it keeps its own webhooks' secrets to sign); GitLab's token is kept only as a SHA-256. Neither is shown after it's made.
- **How often.** Deliveries are rate-limited per integration; refusals are rate-limited per address, and those over the limit aren't logged, so the log can't be flooded. Like the general limits (D17), these are per instance.
- **Once.** The provider's delivery id is claimed before the work. One sent again is answered as a duplicate. One that failed (or died, after ten minutes) may be handled again, which is safe because linking is idempotent per (issue, commit) and per (issue, pull request), held by unique keys.
- **Commands.** `BACK-12 #Fixed` applies the command after `#` as the person whose *verified* email wrote the commit, with their own access as they would sign in, and only if they can change the project's issues (asked through `services/access.ts`): a viewer's command, or that of someone outside a members-only project, links and isn't applied. Like a token limited to projects, it reaches only the integration's projects, so a command can't link to an issue elsewhere. A commit's author email is whatever the committer typed, and a4a's own emails are whatever people typed, so an email counts only when it is confirmed: set or confirmed by an administrator, or verified by the identity provider (`users.email_verified`, the same flag single sign-on trusts, D16; a person changing their own clears it). (People confirm their own emails, several each, and logins count too: D33.) Each (commit, issue) is one transaction that locks the issue first; the command runs in a savepoint, so a command that fails, or a guard that refuses it, leaves the link and says why.
- **History.** Linking records `commit.linked`, `pull_request.linked` and `pull_request.updated`, on a new channel, `vcs`, as the matched person or as the integration itself, so the issue's history, the event feed and webhooks see it.
- **Reach.** Linking needs no one's access in a4a: an integration links the issues of the projects an administrator gave it, and "every project" means members-only ones too. A commit's message and a pull request's title are their authors' words, shown as written, as a comment is.
- **What the provider is told.** GitHub and GitLab show a delivery's reply to the repository's administrators, who aren't a4a's. So the reply names no issue and no person, and says nothing of who may do what in a4a: only what kind of delivery it was and how many links and commands came of it. a4a's own log of deliveries, which its administrators read, says the rest.

**Costs.** One email per person, so commits under a provider's no-reply address run no commands. A push reads its first 500 commits.

**Revisit when:** people need several emails, or a mapping from provider logins; or a4a should fetch what a delivery leaves out (a push delivery carries at most 2,048 commits). D33 does the first two, and fetches what Bitbucket's deliveries leave out.

### D27. Groups, and SAML sign-in beside OpenID Connect

**Groups.** A group is some people. A project gives a group a role (viewer, member, manager) as it gives one to a person, and everyone in the group has at least that role there. Someone's role is the highest of their own and their groups' (their own, when they're the same), after administrator and lead and before an open project's member. So an open project can keep a group to reading, as it keeps a person. (With roles as sets of permissions, someone may do what their own role and their groups' allow together: D37.)

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
- **Revisit when:** a provider must encrypt assertions or wants signed requests (node-saml does both, given a key of a4a's); membership must follow the provider between sign-ins (SCIM); or people sign in with LDAP. (Provisioning by SCIM and LDAP sign-in came: D38.)

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

- MCP clients move to client ID metadata documents. a4a would then fetch a document the client names, with the care any outbound request takes. (Client ID metadata documents came: D38.)
- An organisation wants its own provider to issue the tokens. a4a would then check that provider's tokens for audience `/mcp` and map their scopes.
- A tool should ask for writing only when it needs it (step-up, with `insufficient_scope`). (Step-up came: D38.)

### D29. Importing from YouTrack's and Jira's APIs: the CSV importer's rows, read with a token nobody keeps

D21's revisit. An import can read the issues a YouTrack query or a Jira JQL matches, from the tracker's REST API, instead of a file. The readers (`imports/readers.ts`) turn each issue into the columns its CSV export would have (YouTrack's `Issue Id`, `State` and link phrases; Jira's `Issue key`, `Status`, `Outward issue link (Blocks)`, custom fields by their names) and write them into `import_rows`. So the mapping finds them as it finds an export's, and the check, the run, running again and undo are the CSV importer's, unchanged.

- **What a file's cells can't hold** comes beside them, in the row's `extra`: comments, work items (YouTrack) or worklogs (Jira), and files, each with its id there.
  - A comment is known by that id, so one edited there since isn't added twice.
  - Work items come one by one, so the total of spent time doesn't come too.
  - Files are settled on the issue's record one by one as they're stored, so a run that stops part-way brings the rest next time and downloads nothing twice. A file over the size limit, or one an issue has no room for, is left out and says so. A file on a YouTrack comment goes on that comment here.
  - Jira's rich text becomes Markdown (`imports/markup.ts`): Atlassian Document Format from Cloud, wiki markup from Data Center. YouTrack writes Markdown already.
- **Paging as each API does:** YouTrack's `$top` and `$skip`, the query sorted by creation so pages don't shift; Jira Cloud's `/rest/api/3/search/jql` by `nextPageToken`; Data Center's `/rest/api/2/search` by `startAt`. Comments and worklogs past what a Jira search embeds are read from the issue.
  - 429 and 503 are waited out as `Retry-After` asks, ten minutes at most at a time; asked for longer, the fetch stops and says to carry on later.
  - A dropped connection, a 502 or a 504 is tried again.
- **The fetch is a job,** as the run is. Its progress and heartbeat are on the import, and each page's rows and the place after it commit together. A fetch that stopped (a restart, the other tracker gone quiet) carries on from its last page when someone gives the token again: it reads a page back and skips the keys it has, so nothing is read twice.
- **The token is used, never kept.** It lives in the job's memory while the fetch reads, and again while a run downloads files: `POST /imports/{id}/run` takes it, and won't start without it when files are to come. It is never in the database, a log, an error or an answer, and what the other tracker says back is shown with it taken out. The web app holds it in the page's memory, so nobody is asked twice; a reload forgets it.
- **Where the server may go.** The address is someone's to give, and the server fetches it: https only, and public addresses only.
  - The check is made as the connection is made: `dns.lookup` runs inside the request, every address it answers is checked, and only those allowed are offered to the connection. So a name can't resolve to one thing for a check and another for the request.
  - Redirects are followed by hand, each hop checked the same way.
  - Refused: private, loopback, link-local and reserved ranges, IPv4 inside IPv6 (mapped and NAT64), and with them the cloud's metadata service.
  - An administrator names the hosts inside the network that may be read (`IMPORT_ALLOW_HOSTS`). Plain http goes only to this machine, and only when `IMPORT_ALLOW_HTTP_LOOPBACK` is set, which is for tests.
  - The credentials go only to the origin they were given for: a redirect elsewhere (Jira Cloud serves files from Atlassian's media service) goes without them.
- **What only some may see there stays there.** Left out, with how many and which issues said:
  - YouTrack's issues and comments with limited visibility;
  - Jira's issues with a security level, and comments with a visibility.

  a4a can't tell whom they were for, and here they would reach everyone who can see the project.
- **Who:** as an upload, the project's managers and administrators. The token's account decides what is read; a4a's access decides where it goes.
- **Not over MCP.** An agent would pass the other tracker's token through a model's context. The web app and the REST API take it.

**Costs.**
- The issues are read into rows before anything is mapped, as a file's are: about their size again, until the import is forgotten.
- Files come during the run, so a run that brings them needs the token again and the other tracker reachable.
- A fetch reads every issue the query matches, up to the 50,000 an import takes. Jira comments past the search's page are read one issue at a time.

**Left out:** YouTrack's agile sprints (not an issue field; a sprint column, if there is one, maps as any), votes, watchers and visibility groups; Jira's changelog (an issue's own dates come, its states in between don't), votes, watchers, and Service Management's request types and timers.

**Revisit when:** a project should be kept in step rather than imported. Then a schedule fetches what changed since (YouTrack's `updated:`, Jira's `updated >=`) with a token the server keeps, encrypted: the decision this one avoids.

### D30. The help desk by email: one path for every message, threaded by what only the requester has

A desk can have an address, and then people write to it as well as fill in its form, and answer the team's emails as well as their request's page. Mail reaches a4a two ways, and both go down one path (`helpdesk/inbound.ts`):

- **A mail provider posts it** (SendGrid, Mailgun, Postmark, a Cloudflare Email Worker, a script) to `/api/v1/mail/inbound/<KEY>`, raw: as the body, as a form's `email` or `body-mime`, or as JSON's `RawEmail`. The desk's secret is HTTP Basic's password, the place providers put a URL's credentials, so it stays out of addresses servers log. It's random, kept as a hash, shown once, and compared in constant time; a desk that doesn't exist, takes no mail, or has another secret answers the same 401, limited per address.
- **The server reads a shared mailbox** (`HELPDESK_IMAP_URL`) as one of the worker's chores, so only the lease holder does (D17). A poll runs in the background, so the outbox never waits on a mail server, and checks the lease between messages. How far it has read is kept by UID within the folder's UIDVALIDITY, in Postgres, so a new holder carries on where the last stopped. The first time it sees a mailbox, or a renumbered one, it starts after the newest message: mail from before a4a read it isn't anyone's request now. Each message goes to the desk whose address it was sent to (To, Cc and the delivery headers); if it names two desks, the first. Credentials never cross the network in the clear: `imap://` must upgrade with STARTTLS, except on loopback.

**What a message becomes.**

- **Once.** A message is known by its Message-ID within its desk, and claimed in the log before the work. One posted again, or read twice, is a duplicate. One whose work failed, or died (ten minutes on), may be handled again. A failure of a4a's own answers the provider 5xx, so it tries again, and ends a poll there, so the next tries it again; a message a4a can't take for a reason in it (unreadable, too large) is logged and passed.
- **A reply** is the requester's when it comes from their address and either goes to a reply address whose token is the request's (`support+<token>@…`, each email to them minting one, kept as a hash, as tracking tokens are), or answers an email a4a sent them about it (In-Reply-To or References). Help desk mail has random Message-IDs (`replyable` in the outbox), so citing one shows the email was had; older ones could be guessed and don't count. A reply becomes the requester's public comment, by the `helpdesk` agent, the same path as a reply on their page.
- **A new request** is anything else to the desk's plain address, while the desk is open: the subject is its summary, the words its description, the sender its requester, their message the root its emails thread under (and the first answers it as "Re:").
- **Words.** A reply's are what's above its quoted history and signature, cut as Gmail, Outlook, Apple Mail and a few languages write them ("On … wrote:", Outlook's header block and reply div, a cited blockquote, "-- ", "Sent from my iPhone"); answers written between quotes stay. HTML-only mail is read as words, its quoted parts dropped first; none of its markup survives, as none of anyone's does anywhere in a4a. A new request keeps its quoted history (a forwarded message is often the request) and loses its signature.
- **Files** go through the usual checks (the type read from the bytes, the per-file and per-issue limits), on the request or on the reply's comment; signatures, Outlook's wrappers and small inline pictures (a signature's logo) are left out, and at most 20 come from one message. The original goes with them as `original-message.eml` when what's shown isn't all of it: words read from HTML, or cut for length.

**What never becomes anything.** Mail no person wrote: `Auto-Submitted` other than `no` (RFC 3834), the auto-reply headers, `Precedence: bulk`, list headers, delivery reports, a null return path, `mailer-daemon`, and no-reply senders. Mail from a4a's own address or a desk's. Every email a4a sends says `Auto-Submitted: auto-generated`, so an out-of-office answering one is set aside too, and nothing loops. A message whose receiving server says it failed DMARC is refused: only the topmost `Authentication-Results` counts, being that server's own. A reply from anyone but the requester is refused, even with the token, since it would speak in their name. (Colleagues who may answer it are taken, as themselves: D56. CCs and the team answer at reply addresses of their own: D57, D45.) Nobody is ever told of what's set aside or refused, so a forged sender gets no mail.

**Limits**, each an hour, in the help desk's shared throttle: 5 new requests per sender, 30 replies per request and 300 messages per desk; 25 MB a message (`HELPDESK_MAIL_MAX_MB`). The log keeps 30 days, for the desk's managers: when, from whom, the subject, and what became of it, in words.

**A proof of work, when a desk asks for one.** The form comes with a challenge the server signed (ALTCHA's scheme): find the number up to `maxnumber` whose SHA-256 with the salt is the challenge. The browser finds it with WebCrypto in a worker, a file of the site's own, so the page's policy lets it run; it starts when the form loads, so it's usually done before the person is. The salt says which desk and until when (30 minutes), the signature that the server made it, so the server keeps nothing until an answer comes; then it takes the answer once, counted in the shared throttle. No puzzle, no third party, nothing loaded from outside. It doesn't stop a determined bot; it makes each request cost one a moment, with the honeypot, the form token and the limits beside it.

**Costs.** The desk's mail server must deliver plus addresses to the same mailbox (Google's, Microsoft's and most others do); without them, replies thread by what they answer alone. A sender can still be forged where DMARC isn't checked: the request is filed, and its confirmation goes to the real owner of the address, as with the form. One mailbox serves every desk.

**Revisit when:** a desk wants a mailbox of its own (`HELPDESK_IMAP_URL` per desk, its password kept encrypted), people other than the requester should answer by email (as the request's CCs), or a determined bot gets past the proof of work (raise `HELPDESK_CAPTCHA_MAX_NUMBER`, or a challenge per address). (A mailbox per desk came, its password sealed: D45. CCs came, answering as themselves: D57.)

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

**Revisit when:** many people subscribe to large searches. Compile each subscription once per schema version, and check changes in batches. Or when someone wants subscriptions by kind of change (only resolutions), or to hear of what time alone brings into a search: a chore that reads the searches again. (Subscriptions by kind came, a subscription choosing for itself: D45.)

### D32. Rules across issues, and rules that tell people or call out: the same sentence, the same once

D25's rules read and changed one issue. The classic workflow needs more: "when the last subtask is resolved, fix the parent". So a change or scheduled rule now has three more parts. Each is a word in its sentence, not an expression language:

> When an issue's State changes, if it matches `#Resolved` and all of its parent's subtasks match `#Resolved`, then apply `State Fixed` to its parent and tell its parent's watchers “All its subtasks are done.”

- **A further condition** ("and …"): its parent, its subtasks, its parent's subtasks, or the issues linked to it by a phrase ("depends on", "is required for"), matching a query: all of them or any one. "All" needs at least one, so an issue without subtasks doesn't count as having them all resolved. The query is compiled by the query language's own compiler, inside a subquery over `issue_links` correlated to the issue the rule acts for (`workflow/match.ts`). So one SQL condition serves a change (one issue), a scheduled run (pages of issues) and a preview (a count). Subtask links are said as a parent and subtasks, never as a phrase.
- **What it acts on** ("to its parent"): the issue itself, its parent, its subtasks, or the issues linked to it by a phrase, at most 200 per issue.
- **What it does**, besides a command and a comment:
  - **Tell people**: its assignee, its reporter, its watchers, the project's managers (its lead, and those whose role there, or a group's, may manage it: not every administrator), and people by login, in the rule's own words.
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

### D33. Version control, wider: Bitbucket, Gitea and Forgejo; emails people confirm; logins administrators record

D26 took GitHub and GitLab, and knew a commit's author by one verified email. Bitbucket (Cloud and Data Center), Gitea and Forgejo now send to the same `/api/v1/vcs/hooks/{integration}`. A person is known by any email they confirm, or by their login at the provider.

- **Who sent it.** Each provider's own check, on the raw bytes, in constant time:
  - Bitbucket Cloud and Data Center sign with `X-Hub-Signature`: `sha256=` and the HMAC-SHA256 of the body.
  - Gitea and Forgejo sign with `X-Gitea-Signature` or `X-Forgejo-Signature`, the hex alone, and also send GitHub's `X-Hub-Signature-256`; any of them is checked. Gitea sends the header empty when its webhook has no secret, and that's refused like no header.
  - Each secret is an HMAC key, so a4a keeps it, as it keeps GitHub's.
- **Once.** Their delivery ids are claimed as D26's are: Bitbucket Cloud's `X-Request-UUID` (its braces dropped), Data Center's `X-Request-Id`, and Gitea's `X-Gitea-Delivery` (Forgejo's `X-Forgejo-Delivery`).
- **Data Center's Test connection** pings without a signature even when the webhook has a secret. An unsigned `diagnostics:ping` is answered, and nothing is read or logged; anything else unsigned is refused. a4a's own test signs its ping.
- **What a push carries.** A push is read branch by branch, since Bitbucket sends several in one.
  - Data Center's pushes name the commits a branch moved between, not what they say. Cloud's carry the latest five commits a branch got, and say when they cut more.
  - With an access token, a4a reads the rest from their REST APIs, a page at a time, up to the 500 one push reads: Cloud's `/2.0/repositories/{repository}/commits?include=…&exclude=…`, Data Center's `/rest/api/1.0/projects/{key}/repos/{slug}/commits?since=…&until=…`. A new branch is read from where it left the main branch.
  - Without a token, Cloud's five are read, and Data Center's pushes link nothing. The delivery's log says why, as it says when a token is refused or the address doesn't answer; the commits that came are linked all the same.
- **Where a4a goes.** Data Center's address is the one an administrator gives: https, kept without a trailing slash (plain http only to this machine, and only in tests).
  - Redirects aren't followed, and a page's link to the next must stay on that address, so no answer can send a4a elsewhere.
  - Like a webhook's URL, it may be an internal address: only administrators set it.
  - The token is kept as it's given, as signing keys are, since a4a must send it. It's never shown again. (D46 seals access tokens with `SECRET_KEY`.)
- **More emails.** A person's emails are their primary one (`users.email`) and others (`user_emails`). One counts once it's confirmed:
  - **By a link a4a mails to it.** Its token is minted as the mail is sent (D23) and kept as a SHA-256, so none waits in the outbox. It works once, for 24 hours, and only for the person who added the email, signed in. A stranger who adds your address can't use the link even if you open it, and the mail says whose account asked. The page it opens says what it confirms and asks first, since scanners open links.
  - **By an administrator,** who vouches for it: they add it confirmed, or confirm a primary as before.
  - **One person's.** A confirmed email names one person: an administrator can't confirm one someone else has, and a second person's link can't once the first has confirmed it.
  - A person's first email is their primary one. A confirmed one can become the primary; the old primary stays, as another.
  - Links go at most five an hour per person, and one a minute per email. Without SMTP none go, and an administrator confirms.
  - Changing your emails changes whose commits are yours, so it's done signed in: an API token reads them, and changes none.
- **Logins.** An administrator records a person's login at a provider (`provider_logins`), one person's at a time, matched without regard to case.
- **What each provider vouches for:**
  - A commit's email is whatever its committer typed: it counts when its person confirmed it.
  - GitHub, Gitea and Bitbucket name the account they matched a commit's email to, by their own confirmed emails. So a login vouches that the email is that account's: it's worth what a confirmed email is in a4a, and reaches emails a4a doesn't know, such as a provider's no-reply address. GitLab names no account for a commit, only a name and an email.
  - A pull request's author is the account that opened it, signed in at the provider. GitLab's merge requests name who acted, which is the author when one is opened.
  - Bitbucket Cloud's nicknames aren't unique, so there a login is the account id or the UUID, never the nickname.
- **Who wrote it.** The one person whose confirmed email the commit names, or whose login the provider vouches for. If the email names one person and the login another, or either names two, it's nobody: the command isn't applied, and the issue says why without naming anyone. The delivery's log, which only administrators read, names them.
- **Pull requests** take their author in a4a by login, and the issue shows them. Linking stays the integration's doing, since who opened a pull request isn't who merged it.

**Costs.**
- A login is matched as the provider sends it. A person who renames their account there needs the new one recorded, and the old one forgotten: someone else could take a freed name.
- A login names an account at a kind of provider, so two instances of one (two GitLabs) that give one login to two people can't be told apart.
- The pusher, whom the provider signed in, isn't the commit's author, and a4a doesn't ask that they be the same: pushing others' commits, or merging them, would stop working.
- Access tokens and signing keys are in the database as given. (Access tokens are sealed since D46.)

**Revisit when:** people should connect their own account at a provider (OAuth with it) rather than an administrator recording logins; or commands should need a signed commit, read from the provider's API. (Accounts people connect came, at GitHub, GitLab and Bitbucket: D46; at Forgejo and Gitea: D54.)

### D34. Agents act as themselves; what they change on their own, a person undoes

An agent over MCP can act for a person, with that person's token: its changes read "claude-code for Anna Schmidt", and it takes no work of its own. Or it can be an account of its own.

**Agents of their own.** An agent is a bot account an administrator adds. a4a's own agents (`triage`, `workflow`, `helpdesk`, and D46's `builds`, in `OWN_AGENTS`) act for a4a itself: they take no tokens and no work, and their logins are a4a's to make.

- **Tokens.** An administrator issues an agent its tokens (`POST /users/{agent}/tokens`), with scopes, an expiry and, if wanted, projects, as any token has. A token never does more than its agent's role allows, and a token limited to a project the agent can't see is refused with how to fix it, since it would reach nothing there. The agent never makes its own tokens: a token that leaked can't make itself another. Banning the agent stops all of them.
- **As itself.** With such a token, the agent's changes are its own. The event's actor says so (`isBot`), the history reads "claude, over MCP, as itself", `me` in a query is the agent, and `get_current_user` says `agent: true`.
- **Assignees.** An agent can be assigned issues, as a person can: by anyone who may change the issue, and in a members-only project once it is one of the project's people. `for: me #Unresolved` over its token is its work. a4a's own agents are refused as values of a person field, with what to choose instead. Agents don't watch issues: an agent assigned or mentioned finds a notification in its inbox (D22), never an email, and finds its work by searching.

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

**Revisit when:** an agent's comments should be withdrawable by people, or agents should be woken by their work (a webhook or a push to an agent when it's assigned or mentioned; it gets an inbox notification only), or a change an agent made long ago should be undone across later ones (a merge, field by field).

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
- QuickTime, AVI and Matroska download, since browsers don't all play them. Sniffing tells WebM from Matroska by its DocType, and knows MP3 without an ID3 tag and AAC in ADTS frames.

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
  - Milestones, and work nobody is assigned, keep the plan's calendar. The plan's holidays hold for everyone.
- **Levelling** looks for room on the assignee's own days, at each day's capacity, half of it on a half day. It calls a move levelling only when it moves work for resources, not when work just waits for its person.
- **What it looks at:** days away from a year before today to five years after. Beyond that everyone is there, so someone away for good can't run the engine out of days.
- **The load** gives each day's capacity (none on a day away, half on a half day) and whether someone is away (`away`: day, morning, afternoon). It never says why. The grid says "away", and dashes half a day with what's left of it.
- **Costs.** A day away books no hours, so it costs nothing, and a task that waits for its person costs what its estimate does. Earned value follows the baseline as saved: a day away added later doesn't rewrite the plan of record.
- **Who sees what.**
  - Anyone signed in who may read sees when someone is away, as a team's calendar shows it; plans show it anyway. A guest sees nobody's (D64).
  - Why (holiday, sick, training, something else, and a note) only the person, administrators and whoever entered it see: sickness is the person's own.
  - Days away aren't events. The feed (webhooks, the live stream, MCP's `get_activity`) reaches everyone who can read it, so who entered each, and when, is kept on the absence instead.
- **Who enters them:** the person; an administrator; or a manager of a project whose issues the person may change, as they would signing in. So a manager of an open project enters them for anyone who may change its issues.
- **What's refused**, each saying how to put it right:
  - dates out of order;
  - more than a year (enter it a year at a time);
  - half of several days;
  - days that overlap the person's others, checked under a per-person advisory lock so two entered at once can't both pass;
  - an agent's: agents are never away.

  A change checks the version read.
- **The load grid's window** is each person's choice: two weeks, a month or a quarter from today, the plan's end, or two dates. It's kept for them in `user_preferences`, the same on every plan and every device. Choosing it needs only reading, as notification settings do, so a viewer chooses what they see too.
- **A board with lanes** scrolls in a frame of its own, at most the window's height, so its column heads stay in view (Ocean's `.held`). It scrolls sideways in that frame too, so its heads can stay in view only within it.

**What it costs.**
- A task's length depends on where it lands when its assignee has days away, so a what-if or a levelling move counts it again.
- The backward pass reuses the forward pass's length. That's off only when a half day falls between the earliest and the latest a task could start.
- A plan's people's days away are read with the plan: one query.

**Revisit when:** days away should come from an HR system (iCal or its API), as the same rows. (People working part time on a pattern have a working week of their own: D43.)

### D37. Access in depth: who sees an issue or a comment, roles as permissions, and guests

Until now a project was the one unit of access: whoever could read it read all of it. Three things go further.

- **An issue or a comment limited to some people and groups** ("Visible to").
  - Its reporter and its assignee (a comment's author), the project's managers and administrators always see it, and so do the people and groups named. Nobody else does, guests included.
  - The reporter keeps it because they wrote it, the assignee because they're doing it, and managers because they answer for the project. Seeing is reading, so a manager's read-only token sees it too.
  - To anyone else it's missing, in the words used for one that doesn't exist, wherever issues and comments are read:
    - lookups, search and its counts, project counts, the query language's words and `commenter:` and `has: comments`;
    - links, whose other end is left out as a hidden project's is; and mentions, which keep the id as text and never show its summary;
    - the event feed and the live stream (an event of a limited issue or comment, or a link to one, is left out, as SQL so pages and the cursor stay whole), and an issue that was limited when it was deleted;
    - notifications, emails and digests, watchers and mentions (only who sees it is told, or made to watch), and a rule's message;
    - reports, plans and sprint counts, which count only what the caller sees; possible duplicates and triage's words; the assistant and writing help (D59), which work through the same services; whiteboards' cards (D58);
    - files on a limited comment, and attachments by id.
  - Webhooks carry none of it: their address is outside, where nobody's access is known. That includes a rule's call.
  - Limiting is a change to the issue like any other: through `applyChanges`, with its version and its history ("Visible to"), and it takes the edit permission. Nobody limits an issue away from themselves. A comment is limited by its author or a manager. A public comment, which went to a help desk's requester, can't be.
  - The check is in `services/access.ts`, twice: as SQL (`issueSeenSql`, `commentSeenSql`) and over a row (`seesIssueRow`, `seesCommentRow`). For whom to tell, it's `whoSeesIssue` and `whoSeesComment`.
- **Roles as sets of permissions.**
  - The permissions are read, comment, create, edit, delete, time, costs, boards and manage, and, for private fields, `readPrivate` and `editPrivate` (D50).
  - Viewer, member and manager are three such sets, as they were. Administrators define more (`/roles`), and projects give them to people and groups as they give the built-in ones.
  - Someone may do in a project what any of their roles there allows: their own and their groups'. A read-only account or token gets none of the permissions that change things, whatever its role.
  - Every check asks for a permission, never for a role by name, so a custom role works everywhere at once. A role nobody has can be deleted; one in use can't.
- **Guests.**
  - An administrator can open an open project to anyone (`guestAccess`). A project for its members only can't be, and making it so closes it to guests.
  - A request without credentials to one of the reading routes is then a guest's: the read permission in those projects and nowhere else, the read scope alone, so nothing writes.
  - The routes are projects, issues and their comments, links, history and files, search, articles, fields, tags and link types; and boards, reports, plans and whiteboards (D64). People, the event stream, notifications, tokens and MCP are refused, as for anyone not signed in.
  - Guests have their own rate limit per address (`GUEST_RATE_LIMIT`), apart from people who sign in. A help desk requester's name shows as "The requester".

**What it costs.**
- Search, counts and feeds carry one more condition for anyone who manages nothing in a project: an `OR` of the issue's lists, its reporter, and an `EXISTS` on its assignee.
- Telling people of an event reads each recipient's access as they'd sign in.
- An event's facts (its issue, comment and link's other end) are kept 10 seconds per event, so a limit changed just now can take that long to reach an open stream.
- A plan holds what its reader sees, so someone who sees less sees a plan computed without what they can't see; its managers, who level it, see it all.
- Permissions are checked in more places than roles were, so a custom role is only as narrow as the checks: costs gate logged time, the time report, the cost report and a plan's money (D64), and not an issue's total time spent.

**Revisit when:** fields should be limited too (a "Salary" field only HR sees); articles want their own limits; or guests should see boards, reports and plans. Each reads through the same seam, `services/access.ts`. (Fields came, by permission: D50. Articles' own limits came: D51. Guests on boards, reports, plans and whiteboards came: D64.)

**Fixed since:** once a limited issue was deleted, its earlier events, and the summary in them, reached everyone who reads its project: deleting it set their `issue_id` to null, and the feed lets an event without an issue through. So did a link naming it from the other end, a limited comment's events once its issue went, reports' history, and the inbox's notifications of it. Now its deletion keeps what was limited beside its event, never in what a reader gets: every id the issue had (from before it moved too, under every key its project had), and its comments that were limited. The feed, the live stream, webhooks, reports and the inbox leave all of it out for anyone who doesn't see all of its project, as they leave out the deletion itself, its own limit's people included (`goneEventsSql`, `goneIssueSql`, `goneEventSeen`; a partial index on deletions, migration 0034). An issue deleted before this kept only the id it had then: its events from before it moved still show, and so do a comment's limited after it was written. A rule's run log, and the last run on its card, also named runs on an issue limited away from their reader, with what each changed there, whether the issue stood or was deleted: a run on a standing issue now goes through `issueSeenSql`, and one on a deleted issue through `goneIssueSql`, by the id and project it kept.

### D38. Identity in depth: a second factor, a directory, provisioning, and apps that name themselves

Four pieces, each where people sign in or are kept, and each through the paths already there.

- **Two-factor sign-in** for password accounts: a code from an authenticator app after the password (TOTP, RFC 6238: six digits, a 30-second step, a step either side for a clock a little off).
  - It's set up from the profile, with a QR code a4a draws itself: an SVG in a `data:` address, so the page's CSP (`img-src 'self' data:`) holds and nothing comes from outside. A code from the app turns it on, and ten recovery codes are shown once.
  - The secret is sealed (AES-256-GCM) under `SECRET_KEY`, or under a key a4a writes to `DATA_DIR/secret.key` (mode 0600) the first time it needs one. A copy of the database alone doesn't hold it. Several instances need the same `SECRET_KEY`.
  - Recovery codes are kept as hashes, each good once.
  - A code is good once: the step it was taken in is kept, and taking it is one conditional update, so two requests with one code can't both pass.
  - **At sign-in**, a right password answers `{ "step": "two_factor" }` and a ticket cookie (`a4a_2fa`: sent only to `/api/v1/auth/two-factor`, SameSite Strict), not a session. The ticket is kept as a hash, for ten minutes and five tries. Each try also counts in the sign-in throttle, under a key no login can have. The session starts with the code, or with a passkey in its place (D62).
  - **Asking it of everyone** is an administrator's switch. From then on, a password sign-in with neither an app nor a passkey (D62) sets one up before its first session. Someone who knows only the password could set up their own app at that moment: that's the cost of asking at the next sign-in, as most products do. Required, it can't be turned off by its person; an administrator resets someone's for a lost phone.
  - **Left alone:** single sign-on, whose provider has its own checks (Entra's multi-factor), and API tokens. A token can't change how anyone signs in: setting it up, new recovery codes and turning it off take a signed-in browser.
- **LDAP sign-in**, through the same form.
  - a4a binds as its service account, finds the one person the filter names, and binds as them with the password they typed. That bind is the check: a4a never sees their hash. Nobody, or two people, and no password is tried.
  - What they typed goes into the filter escaped (RFC 4515), so it can't widen the search. An empty password is refused before anything is sent: many directories take a name with no password as an anonymous bind, which "succeeds".
  - Over ldaps, or StartTLS. Plain ldap only to this machine, since people's passwords go to the directory. `LDAP_CA_CERT` adds a certificate authority.
  - The person is found as single sign-on finds them: by the directory's id for them (objectGUID, entryUUID, or else the DN); the first time, by an email the directory vouches for (`LDAP_TRUST_EMAIL`); or made at the first sign-in, within `LDAP_ALLOWED_DOMAINS`.
  - memberOf, or a group search, fills the groups that follow the provider (D27), at each sign-in.
  - a4a's own passwords are tried first. `PASSWORD_LOGIN=false` turns those off; the directory's stay. The second step above asks the same of a directory's password.
- **Provisioning, by SCIM 2.0** (RFC 7643, RFC 7644) at `/scim/v2`: the identity provider makes, changes and deactivates people and groups between sign-ins.
  - Users and Groups, with GET, POST, PUT, PATCH and DELETE; the `eq` filter on `userName`, `externalId`, `emails.value` or `displayName`; paging; `excludedAttributes=members`; and ServiceProviderConfig, ResourceTypes and Schemas.
  - Written for what Entra sends: `Replace` for replace, `"False"` for false, `emails[type eq "work"].value` as a path, a value with no path that holds several attributes (some written `name.givenName`), and members added and removed by value or by `members[value eq "…"]`. Attributes a4a doesn't keep are let be.
  - It writes through the paths an administrator's changes take (createUser, updateUser, createGroup, updateGroup, deleteGroup), acting as the administrator who made its token, while they still are one. A SCIM token (`a4s_`) opens SCIM alone; API tokens and sessions don't open SCIM.
  - It sees the people and groups it provisioned, not everyone. Someone new whose email is on an account here, confirmed, is that account from then on. An unconfirmed match is refused, as single sign-on refuses it, with how to confirm it.
  - **Deactivating bans**, whether `active` turns false or the person is deleted: they can't sign in, their sessions end, and their account, history and what they wrote stay. A delete also takes them out of provisioned groups, and out of SCIM's sight.
  - **Provisioned groups follow the provider** (D27). Their provider name is their `externalId` (Entra's object id, the one its groups claim names), or else their name, so provisioning and a sign-in's claim say the same. Nobody adds people to them by hand.
  - Writes go one at a time, under the instances' advisory lock, so two requests for one userName can't make two people. Provisioning is a trickle, so the queue stays short.
- **MCP's newer client identification** (D28's revisit).
  - **Client ID metadata documents.** A client_id that is an https address names a JSON document saying what registration would have. a4a reads it when the app first comes, and again once the reading has run out: its Cache-Control, held between five minutes and a day. It's kept as a client row.
  - Reading an address an app gives is a request a4a makes for it, so it is held in as imports' are. https, with a path, and no credentials, fragment or dot segments. An IP must be a public one; a name is resolved as the connection is made, with only public addresses offered, so it can't be pointed inside the network between a check and the request. No redirect is followed. At most 5 KB of JSON, within five seconds.
  - The document must name itself (its `client_id` is the address it was read from) and be a public client's: no secret, `token_endpoint_auth_method` none. Its metadata passes registration's checks. The consent page names the host whose document describes the app; the name stays the app's own word. `MCP_OAUTH_CLIENT_DOCUMENTS=false` turns them off.
  - **Asking for writing only when a tool needs it.** An app allowed only to read that calls a tool that changes something gets 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="read write"`, as MCP's authorization asks, so the client asks its person again rather than failing. Only when the person could allow writing: a viewer's app gets the tool's own refusal.

**What it costs.**
- A password sign-in with two-factor is two requests.
- Each SCIM write opens a connection of its own, for the lock.
- An app known by its document waits for it, up to five seconds, at its first authorization and each time the reading has run out.
- Two-factor and provisioning don't record events: they're about accounts, not projects, as a person's other changes aren't.

**Revisit when:** passkeys (WebAuthn) are wanted beside codes, or instead of them; a directory is large enough that group searches at each sign-in are slow; provisioning comes in bulk (SCIM's `/Bulk`); or an MCP client wants to prove it is itself (`private_key_jwt`, with keys in its document). (Passkeys came, beside codes and in their place: D62.)

### D39. A visual editor over the Markdown a4a keeps

Descriptions, comments (help desk replies among them) and articles are written as they read, in a visual editor, or as Markdown, by a switch each person's browser remembers. Markdown stays the stored text: the API, MCP, search, mentions, email and the history all read what they read before.

- **The editor is Milkdown** (7.23, MIT), on ProseMirror, in its headless kit: no theme of its own, so Ocean draws it, and React 19 only hosts it.
  - It reads and writes Markdown with remark and remark-gfm, the parser a4a's pages render with (react-markdown), so a table, a checklist or a mention reads the same in the editor, on the page and to an agent.
  - Considered: TipTap with its Markdown extension, whose Markdown is a second grammar beside the page's; Lexical, whose Markdown transformers miss GFM tables. Both are maintained and work with React 19.
  - It's loaded on its own (110 KB gzipped), when someone first writes; pages that only read never fetch it.
- **Round trip.** A text nobody changed is handed back as it came, to the byte: the editor compares its document with the one the text read as, and writes Markdown only once something changed. What it writes is one style (`-` bullets, `_` and `**`, fenced code, padded tables). Milkdown writes an empty line as `<br />`; the editor writes it as a blank line, since a4a's pages show raw HTML as written.
- **Handed over as typed.** A text up to about 12,000 characters reaches the form as it's typed, as a text area's does, so Save, or a new issue's retry key, never acts on what was there before; a longer one when typing settles, and at once when the editor loses focus.
- **Under the CSP** (no style attributes): Milkdown's GFM tables say a cell's alignment with `style="text-align"`, so the editor's cells say it with `data-align`, which Ocean aligns by; ProseMirror's own styling goes through the CSSOM, which the policy allows. The browser suite fails on any violation, with the editor open.
- **Pictures within text** are a4a's own raster files and nothing else: `GET /attachments/{id}/image` serves PNG, JPEG, GIF and WebP, as `/content` does, and answers anything else (SVG included) as a missing file. The page draws `<img>` only for that path on its own origin; a picture from elsewhere is named, a link to it, never fetched, and any other is its name. The image path keeps the file's access: a members-only project's picture is missing to who can't see the project.
- **Pasted or dropped**, a picture is uploaded as one of the issue's or the article's files, through the upload a4a already has (sizes, room, kinds read from the bytes), and goes in the text where it was put, `Uploading…` marking the place meanwhile. A new comment's pictures are the issue's files, since the comment doesn't exist yet; other files dropped on the comment box are attached to the comment, as before. A file that isn't a picture, in a description or an article, goes in as a link to download it. A picture copied from a page comes with its HTML and no words, and is uploaded; words copied with a picture of them (from a sheet) paste as words. A new issue's description takes pictures once it's created.
- **Checklists** are ticked where they're read, by whoever may change the text: an issue's writers, a comment's author or the project's managers, an article's writers. A box is found by its place among the text's checklist items, read with the page's own grammar (`@a4a/shared/markdown`), so code blocks, quotes and nested lists can't throw the count; the tick changes that one character and is saved against the version read. If the text changed meanwhile, the tick is refused (409), the page says so and reloads. So comments now have a version, raised by every edit, and `PATCH /comments/{id}` takes `expectedVersion`, as issues and articles do. A ticked article item is a new version of it.
- **Mentions** work as the composer's always have: "@" offers the people a mention would reach, the arrows choose and Enter or Tab takes one, as `@login`.
- **Kept plain:** the help desk's public pages and its portal (D45), where requesters write, and the fields that aren't prose (rules, settings, the assistant).

**What it costs.** A dependency of some weight, loaded only to write. Serialising on each keystroke, for texts under the threshold. Milkdown's Markdown has its own opinions (a table's alignment row, its padding), applied whenever a text is changed in the editor. A picture pasted in a comment never sent stays among the issue's files.

**Revisit when:** someone needs to write something Markdown can't say (coloured text, merged cells), which would mean another stored format; or people write together in one text, which would mean collaborative editing (Milkdown's Yjs binding).

### D40. Scripted workflows: rules in JavaScript, state machines and custom actions

D25's rules say what they do in the query and command languages. Some workflows need more than a sentence: a computed value, a loop over subtasks, a decision on what changed. Three things now cover them: a rule can be a script, a state field can have a state machine, and a project can have named actions.

- **Scripts run in a sandbox.**
  - QuickJS, compiled to WebAssembly (`quickjs-emscripten`), in a pool of worker threads, with a new runtime for every run (`workflow/sandbox.ts`, `workflow/sandbox-worker.mjs`).
  - A script reaches nothing but what a4a hands it: no network, files, timers, modules or host objects. `fetch`, `setTimeout`, `require` and `process` don't exist in it.
  - Each run has a time limit (250 ms; a guard's, 60 ms, since it runs inside the write path) and a memory limit (16 MB). A run past either is stopped and says so. The time limit is hard: see "What it costs".
  - It's given three globals, as frozen data parsed inside the sandbox from text, so no host object crosses:
    - `issue`: its fields by name (people by login, numbers as numbers, a period in minutes, a date as YYYY-MM-DD), tags, links in its project with how each reads, its parent and subtasks, and its latest 20 comments;
    - `change`: who made the change and what changed, field by field, or the new comment, or that it's a scheduled turn, or an action;
    - `project`.
  - It has four functions, which only write down what it asks for: `apply(command[, issueId])`, `comment(text)`, `refuse(message)` and `log(...)`. A run asks for 20 commands and 5 comments at most, and each text is clipped at 2,000 characters.
- **A script's changes go the way every change goes (D4).**
  - Once the script ends, a4a reads each command in the command language and turns it into a change with the command executor.
  - It does so as whoever the script acts for: the workflow agent for a rule, with "me" as whoever set it off; the person for an action.
  - Then it applies them with `applyChanges`, in one transaction, so access, guards, state machines, the activity log and undo all hold.
  - A script changes its own issue, or one linked to it in its project (its parent, a subtask, a linked issue). It changes nothing it can't see from the issue it runs on.
- **D25's guarantees hold for scripted rules.**
  - A change or scheduled rule with a script runs it in place of its command. The query, if it has one, still picks the issues.
  - What the script asks for is applied in the same transaction that claims the run (`rule_runs`' unique rule, issue and origin). So a scripted rule acts on an issue once for each change that starts a chain, chains stop at `MAX_DEPTH`, and a replayed event does nothing.
  - The run log says what it changed, what it logged (the first five lines), and where it stopped, with the line ("Its script stopped: TypeError: … (line 2)").
  - `refuse()` in a rule that acts means "not this one": the run is `skipped`, with its words.
  - The preview runs the script on a few matching issues as a dry run. `POST /rules/test` runs it on one issue, as it is now, and says what it logged, refused and would change. Nothing is saved.
- **Scripted guards.**
  - A guard with a script runs after the change and before commit, inside the write path's transaction. It reads the issue as the change left it, from the transaction's own connection (on PGlite, reading on the pool would wait on itself).
  - `refuse(message)` refuses the change (422 `refused_by_rule`, in the script's words), and the transaction takes all of it back. A new issue is judged too.
  - A guard whose script fails, or whose query no longer reads, refuses nothing, and says so in its run log once an hour, as a guard that no longer reads does: a broken script mustn't stop every change in its project.
  - Imports aren't judged, as with D25's guards.
- **Who writes scripts: administrators.**
  - A script is code that runs on the server on every change it's set off by, as the workflow agent, which has administrator scopes in its project. A careless one costs everyone's writes in time, however well it's sandboxed.
  - Administrators already hold every power a script could use, so writing one gives nobody more than they have.
  - A project's managers see scripts, preview them and turn them off, as with a rule that calls a webhook (D32), but don't write, change or delete them.
  - Running a script by hand (`/rules/test`) is an administrator's too: it's for writing one.
  - Machines and command actions hold only queries and commands, which anyone who manages the project already writes, so they're the managers'.
- **State machines.**
  - For a state field (one value from a list) of a project: named transitions, each from some states (or `*`, any) to one, with an optional condition (a query the issue must match as the transition finds it) and an optional command (applied after the move, as whoever makes it, in the same transaction).
  - `applyChanges` asks which transition each change to a governed field makes, before writing. Every way of changing an issue goes through it: the issue page, a board, a command, an agent, a rule, a script. A change no transition allows is refused (422 `refused_by_state_machine`), saying where the issue can go from where it is.
  - A transition that names its state wins over one from `*`, so "Reopen from anywhere" sits beside "Accept from Submitted". Two transitions for the same move are refused when the machine is saved.
  - What's free:
    - a move from no value or to none, so a new issue starts wherever it's put;
    - an import, which is history;
    - an undo (D34), which puts back what was.
    Administrators are held to it like anyone.
  - A machine with problems (a state renamed since, say) refuses nothing until it's fixed, and says what to fix.
  - Each transition's name reads as a command ("Start work"). The issue page shows the moves out of the state the issue is in, as buttons. One whose condition the issue doesn't meet is shown but can't be pressed, with why.
- **Custom actions.**
  - Named, per project: a command, or a script (an administrator's), with an optional condition that says when it's offered.
  - An action runs as whoever runs it, who must be able to change the issue: from its button on the issue page (`POST /issues/{id}/actions/{action}`), or by its name in the command language, which reaches agents through `apply_command`.
  - A scripted action from its button may change the issue and issues linked to it, all or nothing. Through the command language, which works issue by issue, it changes only the issue it's applied to. `refuse()` in one answers 422 `refused_by_action`.
  - An action's name can't be a field, a value or a link's phrase, nor start with a word the command language starts a clause with, nor be a transition's name, so a command reads one way only.

**What it costs.**
- A run builds a fresh QuickJS runtime (about a millisecond) and reads the issue with a handful of queries.
- A project with no scripted guards pays nothing on the write path: the guards come from the schema snapshot in memory, and a filter finds none.
- A change to a governed field checks its machine's transitions and one condition, in the transaction.
- Scripts run in a pool of two worker threads (`SANDBOX_WORKERS`). Each loads QuickJS once, in 165 to 250 ms, as the server starts with scripts or the first is saved, and makes a new runtime for each run; start-up is never paid per run.
- A run costs 0.8 to 0.9 ms at the median and 1.5 to 1.9 ms on average (measured on an issue with 20 comments and 5 links), where it cost 0.6 ms and 1.1 ms in the main thread: the difference is handing the issue to the thread and back. The main thread never runs a script, so ten at once hold up nothing else, and a guard's run goes ahead of the others waiting. Each worker holds a thread and QuickJS's memory, 16 MB a run at most.
- The time limit is hard. QuickJS stops ordinary code at its limit, counted from when the worker starts the run, and the run says what it logged. A worker that hasn't answered 50 ms after the limit (`HARD_GRACE_MS`, for the handover to the thread, which a loaded machine can delay) is terminated and another started in its place, and the run fails, saying it ran past its limit. That ends what QuickJS can't: a built-in that allocates megabytes at once runs for seconds before it looks at its interrupt (measured: 4 to 15 s in the main thread), and is now ended within 300 ms, or 110 ms in a guard.

**Revisit when:** scripts need to call out (a webhook from a script, which would go through D32's signed call, never a raw `fetch`), share code between them (a library per project), or run longer than a request should wait, which wants a queue and a worker of their own.

### D41. Issues move, clone, take votes and reactions, and fields gain kinds and conditions

An issue can now leave its project, be copied, gather votes and reactions, and hold four more kinds of value. A field can be one a project shows only while its issue matches a search.

- **Moving.** An issue moves to another project and takes that project's next number, as a new issue would.
  - The id it had stays its own: `issue_aliases` keeps (old project, old number), so `BACK-12` still finds it in addresses, the API, MCP, Markdown and commit messages. `findIssue` falls back to the aliases, and the query language's ids (`issue id: BACK-12`, a bare `BACK-12`, `depends on: BACK-12`) read them too. A project never gives a number out twice, so an alias never meets a live issue. The web app shows the id it has now, and says which it had.
  - Mentions follow it: what named its old id names its new one, and an old id written later is recorded as the new.
  - Its values carry over by name: the same value where the other project has it, else one of the same name. Whatever doesn't carry is a problem with its fix, raised before anything moves: a value the other project lacks (with the ones it has), a person who can't see it, a field it requires and the issue lacks. The caller gives a value, or null, for each and asks again. `dryRun` shows the problems and what each field will hold. Fields the other project doesn't have are left behind, and said so.
  - It leaves the sprints of boards that show none of the project it joins. Comments, files, work, links, votes and watchers go with it.
  - It changes both projects, so it takes the right to change issues in both. It's one event, `issue.moved`, in the project it joins; its watchers are told.
  - A move isn't a change of fields: rules and guards don't judge it, and the history says what each field held before.
- **Cloning** copies the summary, description, values and tags into a new issue, in the same project or another, with a `clones` link back (a link type, Clone, made on start-up where it's missing) and the same parent. Comments, files, work, votes, reactions, watchers and other links stay with the original. In another project, values it lacks are left to its defaults. The person cloning is the reporter: it takes reading the original and filing in the project.
- **Votes.** Anyone who may comment may vote for an issue, once, except its reporter, who said so by reporting it. `issues.votes` keeps the count, so `sort by: votes desc` reads nothing else. `votes: 5 .. *`, `voter: me` and `has: votes` search them.
- **Reactions** are a fixed set of eight emoji on a description or a comment. Toggling one adds it or takes it back; each says how many and who.
- Neither votes nor reactions change the issue: no version, no history, nobody told. They say how much people care, and that's all.
- **New kinds of field.** Each works in fields, commands, the query language, imports, counts by field and MCP.
  - A *group* field holds groups (D27) by name, and offers every group as its choices.
  - A *build* field is a list of builds, as a version field is a list of versions. Adding a build that's there already returns it, so CI can report each build it makes, maybe twice, as it does (D46).
  - An *owned* field's values each have an owner: Subsystem, on a new installation. Given a value whose owner can see the project, an issue nobody has goes to the owner in the same change, unless the change says who has it. An enum field becomes owned, and back.
  - A *date and time* is an instant. It's typed in the person's own time zone (D31), or with an offset, or as `+2h`, `now` or `tomorrow 09:30`. Searches ask about it by the day, in the asker's days. History and email show it in UTC, the same for every reader.
- **Conditional fields.** A project's field can carry a condition, a search in the project's own words (`State: Fixed`), checked when it's saved, as a rule's are.
  - While the issue matches it, the field shows, and is required if the project requires it. While it doesn't, the field is hidden and nothing asks for it. An issue's fields say whether each applies now.
  - Required while a condition holds works as a guard does. A change that leaves the field empty while the condition holds is refused, unless that was so already before the change. A new issue needs every one. The web app asks for the field, and makes the change with it.
  - A condition that no longer reads (a value renamed since) holds always: the field behaves as though it had none.

**What it costs.** An issue's page reads its aliases, its votes and its reactions, and answers all its fields' conditions in one query. A list reads none of these: `votes` is on the issue's row.

**Revisit when:** nothing pending. (A project's key can now be renamed, with one alias for the key rather than one per issue: D52. CI reports builds itself: D46.)

### D42. Chat: Teams and Slack, told only what every reader may see, and people acting as themselves

The team works in Microsoft Teams, or Slack: an issue's news should reach them there, and they should be able to answer it there. Two things, in both: a channel is subscribed to a project's issues or a saved search's, and people talk to a4a's bot, which acts as them (`chat/`).

**The line no post crosses.** A channel holds people a4a can't vouch for: guests, people outside the project, people who joined after. So a channel is told only what every reader of the project may see.

- Never an issue or a comment limited to some people (D37), nor a link's other end that is, nor a private field (D50); never a help desk's internal note on a request, nor a requester's address; nothing an import brought.
- It's checked when the outbox's consumer writes a post, and again when the post is sent: an issue limited in between isn't posted, and isn't posted about again.
- Whoever subscribes a channel vouches for its people, and every post is read as they would read the issue. A project open to everyone takes anyone who reads it (a read-only account excepted); one open to its members alone, someone who manages it, since the channel's people may not be members. A subscriber who loses the project, or is banned, ends a project's subscription, saying why; a saved search's only stops telling of that project.
- What goes to one person (an answer, a card refreshed for them) follows their own access, as anywhere else in a4a: Slack's ephemeral messages, Teams' personal chat and `refresh.userIds`. A question asked in a Teams channel is answered in the asker's personal chat, with a word in the channel; only a subscription's confirmation is answered in the channel, since it says what the channel will hear.
- A channel hears of what happens from when it's subscribed, however late the outbox hands an event over.

**Posting.** As mail is (D23): the consumer writes one row per channel per event (`chat_outbox`, keyed so a second hand-over writes nothing), and a sender on every instance claims due rows (`FOR UPDATE SKIP LOCKED`, with a lease) and posts them, rendered from the issue as it is then. A 429 or a 5xx waits as long as the service asks (`Retry-After`), and at least 30 s, 2 min, 10 min, 30 min, then 2 h; a channel that's gone (Teams' `ConversationNotFound`, Slack's `channel_not_found`, `is_archived`, `not_in_channel`) is marked so and its subscriptions end, saying why; a revoked token or a bot taken out of a team ends every subscription in that workspace. Ended subscriptions stay on the page with their reason until someone takes them off.

**Teams.** A bot on Azure Bot Service, on a single-tenant Entra app (`TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`, `TEAMS_TENANT_ID`, from the environment: one bot per a4a).

- What Teams sends is checked before anything in it is read: Bot Framework's JWT, RS256, signed with a key from its OpenID metadata (cached a day, fetched again for a key id it doesn't know, at most once a minute), issued by `https://api.botframework.com`, for this bot, in date (five minutes' skew), its key endorsing `msteams`, and its `serviceurl` the activity's. Another tenant's activities are ignored.
- The bot calls Teams with a token from the tenant's token endpoint (client credentials), kept until five minutes before it expires, and only at Bot Framework's hosts (`smba.trafficmanager.net` and the government clouds', `TEAMS_SERVICE_HOSTS` to add one). The service URL is the signed token's, and checked against them too.
- Added to a team, the bot lists its channels; a channel created, renamed or deleted, and the team archived or deleted, are kept up with.
- Posts are Adaptive Cards 1.5 from Ocean's templates (`teams/cards/a4a-change.json`, `a4a-issue.json`), bound with a subset of Adaptive Cards' templating (`${…}`, `$when`, `$data`) and bundled into the server's build. Their actions are Universal Actions (`Action.Execute`): Assign to me, Move to… and Comment, done as whoever acts, answered with the issue card as they see it, refreshed for them alone. The channel's post stays as it was posted.
- An administrator downloads the app package (the manifest naming the bot and a4a's address, and its two icons, drawn in Ocean's blue) to upload in Teams' admin center.

**Slack.** One workspace per a4a, connected on the Chat page with its app's bot token and signing secret, both sealed (`SECRET_KEY`).

- Every request (slash commands, interactivity, events) is checked with the signing secret, `v0` HMAC-SHA256 over `v0:<timestamp>:<raw body>`, the timestamp within five minutes, before anything in it is read. Only Slack's Web API is called.
- Posts are Block Kit; `/a4a` answers ephemerally; a button's action is done as whoever pressed it and answered to them alone (`chat.postEphemeral`), within Slack's three seconds. A link to an issue is unfurled only for a linked person who sees it, and only an issue a channel may be told of, as they would vouch for it.
- Its channels are those it's in: listed when it's connected, added when it's invited (`member_joined_channel`) or asked in, gone when deleted, archived or left. `app_uninstalled` and `tokens_revoked` end everything, and forget the token and secret.

**People.** A chat account acts as the a4a account it's linked to, through the one write path, with that account's access and permissions: the history says it was them, "via Teams" or "via Slack" (channel `chat`). Someone a4a doesn't know is told how to link, and nothing else; an issue hidden from them answers as missing, in the same words.

- Teams names people by their Entra object id (`from.aadObjectId`). Someone who signs in to a4a through Entra ID is known by it: sign-in now keeps the ID token's `oid` and `tid` with their identity (D16), so the bot knows them from their next sign-in, without linking.
- Anyone else links once: the bot sends a sign-in link where only they read it (Slack: ephemerally; Teams: their personal chat, never a channel). It works once, for 15 minutes, is kept as a hash, and names the chat account it would link; whoever opens it, signed in on the web, confirms. A token or an agent can't link anyone. The bot then says it's done, where it sent the link. People see their chat accounts on their profile, and unlink them; an account banned, or an agent's, can't act from chat.

**MCP and REST.** `/chat/subscriptions` and four tools (`list_chat_channels`, `list_chat_subscriptions`, `subscribe_chat_channel`, `unsubscribe_chat_channel`), as the person: an agent can subscribe a channel as its person may, and can't link anyone.

**What it costs.**

- Each event of a kind a channel hears of costs a query for the active subscriptions; with any, a few more: the event's issue, its comment, its subscribers' access, and a saved search's query against the issue. With none, one query.
- A post is rendered from the issue as its subscriber reads it, when it's sent: one issue read per post.
- Teams' signing keys and the bot's token are fetched once a day and once an hour, per instance.
- A linked person who loses access in a4a loses it in chat at once; one who leaves the chat workspace stays linked until they or an administrator unlink them, which harms nothing, since it's the chat service that says who's speaking.
- Requests from Teams and Slack come through `/api` with no person's credentials, so they're counted by address, under the API's limit (`API_RATE_LIMIT`, 1200 a minute on each instance): a busy Slack workspace, whose requests come from few addresses, may need it raised.

**Revisit when:** a channel's posts should change in place as their issue changes (Teams' `updateActivity`, Slack's `chat.update`), which wants posts remembered by issue; Teams should unfurl links (a message extension, `composeExtension/queryLink`); more than one Slack workspace or Teams bot is needed; or another chat is (Google Chat, Mattermost).

### D43. Agile and time tracking: a backlog to plan sprints from, story points, timers and the timesheet

A board plans its sprints from a backlog, counts story points, and shows how much its sprints get done. People time their work, enter it by the week, and each has a working week of their own, which every plan uses.

- **The backlog** is a board's saved query: `backlog_query`, `#Unresolved` when the board doesn't say. It holds what that finds in the board's projects the caller can read, less the issues of the board's open sprints (not archived, and not over). An issue in a sprint that has ended comes back to it, so unfinished work isn't lost from view.
- **Rank.** An issue's place is the board's (`board_ranks`), one order shared by the backlog and the board's cards.
  - Ranks are numbers with gaps. A move takes the middle of the gap; when a gap runs out, the board's ranks are spaced out again in the same transaction. (Since D65, a rank is a fractional key, and a move reads only the keys beside its place.)
  - An issue without a rank comes after those with one, in the query's order. Placed next to one without a rank, the issue gives that one, and those without one shown above it, places after the ranked ones, in the order shown, so nothing on the screen jumps.
  - People rank by dragging, or from the keyboard: Alt and an arrow moves the issue a place, with what moved said where a screen reader hears it. Placing an issue is work on it: it takes being able to change its issues.
- **Into a sprint** by dragging an issue from the backlog onto a sprint, with `POST /sprints/{id}/issues`, or with the command `sprint Sprint 4` (and `remove sprint Sprint 4`).
  - The command finds the sprint by name on the boards of the issue's project that use sprints, and refuses a name two such sprints have, or an archived sprint for an issue going in. It joins the sprint in the same transaction as the command's other changes: all of it, or none.
  - "sprint" is a field's name where a project has a field called Sprint: then it's that field, as it was.
  - A rule's command can't move issues between sprints. Rules change fields; who plans a sprint is people.
- **Story points** are a number field the board chooses (`points_field_id`). The board sums them on each column and for the sprint shown, and the backlog for what it holds.
- **Velocity** is, per sprint that has begun (the last twelve), what it held when it started and what was resolved in it by its end, in points, estimated hours or issues; and the average done over the last three that are over. Both come from history, as the burndown's do (D21): the burndown's reading of a sprint is shared, and counts a board's points where it counted estimates. A sprint without dates has no velocity. An issue limited away from the reader (D37) counts for nothing in a sprint's burndown or velocity, as in its count.
- **A sprint's plan** sets its load against its people's capacity. Load is each assignee's remaining estimate on their unresolved issues in it (estimate less work logged); capacity is the hours they can work from its start (today, once it has begun) to its end, on the board's first project's calendar, their working week and their days away. Its people are its assignees; the unassigned are a row of their own, with no capacity.
- **Timers.** A person's timer on an issue starts, pauses and stops; one runs at a time per person (a partial unique index), so starting one pauses the other.
  - Stopping it logs the minutes it counted, rounded, as a work item, or a duration given instead, with a date (today where they are, D31), a note and a type. Under half a minute logs nothing.
  - The timer is taken before the work is logged, so stopping it twice at once logs the time once. When logging is refused (a type the project requires is missing), the timer is put back as it was.
  - A timer is the person's own: no event, nobody told, and a timer on an issue they can no longer see is out of sight.
  - Timing work, the timesheet and correcting logged work take the time permission in the issue's project, as logging it does (D37).
- **Work types** are a list per project, kept by its managers. Work is logged as one (`work_type_id`), and a project can require one on every work item (`settings.time.workTypeRequired`). A type that has been used is archived, not deleted: it stays on that work and is no longer offered.
- **The weekly timesheet** shows a person's week, Monday to Sunday, a row per issue and work type, with each day's total against their working hours that day.
  - Setting a cell logs an entry where there's none, corrects the one there (`work.updated`, a new event, with what it was), and deletes it at 0. A day of several entries is refused (409) and changed on the issue, one by one: a cell can't say which of them to change.
  - People see and change their own; administrators anyone's. A manager may log work for someone, as before, but a timesheet is a person's own week across projects.
  - Work logged in projects the reader can't see is left out, as everywhere.
- **The working week** is each person's (`users.work_week`): hours on each weekday, Sunday first, or none for the plan's working days at their capacity. They set it on their profile; an administrator can set anyone's.
  - The engine gives each person the plan's working days on which they have hours, and each of those days its share of their capacity, alongside their days away (D36). Someone whose week changes nothing (every working day, at their capacity) keeps the plan's own calendar, so plans come out exactly as they did.
  - Scheduling, levelling, the load grid, a sprint's capacity and the timesheet's hours all read it.
- **The Gantt draws days away** (D36): the schedule says, per assignee, their days away on the plan's working days between its start and finish, and the Gantt marks them on that person's bars. It never says why, and to a guest it says none (D64).

**What it costs.**
- The backlog is a search: at most 500 issues, the rest counted, like a board.
- A move reads the board's ranks, one query, and writes one row, or all of them when a gap runs out. Placing next to an unranked issue first reads the backlog.
- Velocity reads each sprint's history as a burndown does: twelve sprints are twelve burndowns' reading.
- A timesheet is one query for the week's work and one for the person's days away.

**Revisit when:** a team is more than a sprint's assignees (capacity for people with nothing in it yet); timesheets are submitted and approved; or a rule should plan sprints (`sprint` in a rule's command), which wants a decision about who plans. (Cards ranked by dragging on the board itself came with D53.)

### D44. More reports: issues per field, a matrix, average age and time in state

Four more reports, worked out on request as D21's are, each on the Reports page, as a dashboard widget, as CSV and in `get_report`. Two count issues as they are now; two read the history, each day as it stood.

- **Issues per field** counts the issues a query finds by any field's values, of any kind, or by Project. Dates, and dates and times, go by day, week or month: by their spread unless asked. A date and time falls on its day where the reader is. A multi-valued field counts an issue under each of its values, so the values can add up to more than the issues.
- **The matrix** crosses two such fields, with each row's and column's total, and the whole.
- **Each count opens its issues.** It carries the query that finds them now (`project: BACK (Type: Bug) Priority: Critical`, `Due date: {no value}`), which the web app opens in the issues list and an agent can run.
  - Values go by name, as the query language does, so a value two projects each have counts once.
  - Past 100 values (50 a side in a matrix), the fewest fold into one count, which no one query finds.
- **Average age.** Each day, the issues unresolved at its end, and their average and median age, from each one's creation. With a field, also by the value each had that day, as history showed it then: a value renamed since keeps its old name for the days before.
- **Time in state.** For the issues resolved in the window and still resolved at its end: the days each spent in each state until then, and per state the median and 85th percentile, among the issues that were there. Beside them, the open issues, by how long each has been where it is.
  - With a board, its columns instead. A column's time is its states' (or, when its column field isn't the state, that field's values', read from history).
- **Moved issues (D41).** History knew an issue by its readable id, which a move changes. Now the move's event joins the two, so its events under either id are one history, known by the id it last had in the report's projects.
  - With a project, a moved issue counts on the days it was there. Moved in, it arrives: it wasn't created there, and arriving resolved doesn't resolve it there. Moved out, it leaves, neither deleted nor resolved there. Cumulative flow, created against resolved, cycle time, average age and time in state all read it so. Cycle time and time in state count only the time it spent there; its age is its own.
  - With a query, the issues it matches now count over their whole history, in any project the caller can see.
  - A move that left a sprint leaves its burndown.
  - A move is filed under the project it joins, so a project's history also reads the moves out of it.
- **Access.** A project the caller can't see answers as one that doesn't exist. Fields are named from the report's own projects, so a field only a hidden project has is unknown, and the hint lists only the others. An issue limited away from the caller (D37) counts for nothing, as in the other reports: its history, its values and its counts are left out, wherever it has moved.

**What it costs.** Issues per field and the matrix read the issues in scope and one field's values: two queries, up to 100,000 issues. Average age and time in state read history as the other reports do, up to 400,000 events, with one more expression when a field is followed. Every history report now reads moves too, and joins their ids in memory.

**Revisit when:** a report follows a field over many issues often enough that replaying history is slow (keep each value's spans instead). (A renamed key, D52, reads as the key is now: moves' keys and ids too.)

### D45. The help desk in depth: SLAs in working hours, a mailbox per desk, a portal, the team by email, kinds of change

D24 gave a desk one target, the first response, counted round the clock. D30 took requests by email, and only the requester answered. Five pieces now, each through the paths already there.

**SLAs.**

- **Policies.** A desk's policies are tried in order; the first whose query a request matches covers it (`Priority: Critical`, or empty for every request), with a first-response target, a resolution target, or both, and how long before one it turns at risk. Changing a request so another policy matches it moves it to that one's targets, keeping the time used. A query that no longer reads covers nothing, rather than everything. A desk without policies keeps D24's hours as its one target.
- **Working hours** are wall-clock times in the desk's time zone, per day of the week, with holidays off (`helpdesk/business-time.ts`). They're worked out day by day as instants, so a day on which clocks change runs the hours its wall clock shows: a desk open round the clock has 23 hours that day, or 25, and nine to five is eight either way. A desk without hours counts every hour.
- **A clock per target** (`sla_clocks`): business time used before the stretch now counting, and while it counts, the instants it turns at risk and runs out. Those are fixed while it counts, so `sla:` and its kin compare them with now in SQL, and nothing has to tick to be right.
- **In the write path.** After any change to a request, in its transaction (services/sla.ts, called from `applyChanges`), its clocks follow: paused while it waits on its requester (one of the desk's waiting states, and they haven't answered since it began waiting), resumed when they answer, stopped when met, and the resolution's restarted with what's left of it when the request is reopened. A first response is the team's first public comment, as in D24, and resolving answers it too. A requester's answer can move a waiting request to the desk's resume state; a rule that refuses the move doesn't lose their words. Imports don't come here.
- **What time alone brings** the worker says, as the lease holder (D17), once a minute: `sla.warning` once a stretch, `sla.breached` once, by the help desk's agent as a4a's own doing (the `system` channel, so history and notifications say a4a, never the requester), in the request's history; who watches it is told (its desk's lead does), as a kind of change of its own.
- **A field.** "SLA status" (On track, At risk, Paused, Breached, Met: the worst of its targets) is made with a desk's first policy and kept by the help desk's agent, so boards, reports and rules read it as any field: a rule on `updated` with `SLA status: Breached` escalates. Its own change tells nobody; the sla.* events do. The field isn't named "SLA", so the built-in `sla:` keeps its meaning.
- **Search:** `sla: on track | at risk | paused | breached | met` (the status), `sla: overdue | due | missed` (any target); `first response:` and `resolution:` per target; `first response due:` and `resolution due:` as dates, while a target counts. **A report**: met and breached, by policy, per week, each target in the week it was met or went past.

**A mailbox per desk.** A desk can read its own IMAP mailbox beside the shared one, down D30's one path, with its own place by UID; what it reads is the desk's, whatever address it names. Its URL, password and all, is sealed with the server's key (lib/secret-box.ts) and shown again as host, user and folder. Setting it is an administrator's: it has the server connect to a host someone names, as `HELPDESK_IMAP_URL` does, and desk managers aren't trusted with that. A desk with a mailbox or a name of its own sends to its requesters from its address, under that name.

**Requester accounts and a portal** (`/portal`).

- By default a requester signs in with a link sent to their email: no password to forget. A desk can take a password or an identity provider too, or instead (D63). The link is minted as its email goes, kept as a hash, good once for twenty minutes; asking answers alike for any address, and is limited per address and per email. Signing in first makes the requester, named for their email until they say otherwise. The team can invite a request's requester.
- A session is a cookie of its own (`a4a_portal`: HttpOnly, SameSite=Strict, scoped to the portal's API), opening nothing of the team's: a requester is never a member, and has no projects, search, tokens or agents.
- They see the requests they made, with public comments only; their colleagues', where the customer group they're in at that desk shares them (D56); and those they're copied on (D57). A desk names a group's email domains, rather than sharing by any domain, because a requester at a webmail domain shares it with the world. They reply on their own, and on their group's where it lets them, and open requests at desks they've asked before without the proof of work, since they're known. What they see goes through the access seam (`requesterSees`); anything else answers as missing, alike.

**The team replying by email.** With `MAIL_REPLY_ADDRESS`, each notification email to someone on the team carries a reply address of its own (the address plus a token for that person and issue, minted as it's sent, kept as a hash). Their answer comes down D30's path, from the shared mailbox or any desk's webhook, and becomes a comment by them, with their access and permissions, cut from what it quoted, its files attached, on a channel of its own (`email`). It must come from an address of theirs (their email, or one they confirmed); one that failed DMARC, a guessed or someone else's token, and an issue they can't see now are refused, and nobody is told. On a request, a reply is internal unless what they answered was public (a requester's message, a public reply); a line `#public` or `#internal` of its own says otherwise, and a public one takes the edit permission, else it stays internal.

**Subscriptions by kind.** A person chooses which kinds of change reach their inbox and their email: created, commented, state, assigned, other fields, linked, attachments, SLA. For what they watch, and as their subscriptions' default; a subscription may choose for itself. Being mentioned or assigned, a rule's message and a new request for a desk's lead always tell them. Email still follows their level (D23).

**What it costs.**

- A change to a help desk request reads its policies, its state and two times from its comments, in its transaction; a policy's query is one more `EXISTS` on the issue. A change to any other issue costs one lookup by key. Working time is worked out day by day: a year open is 365 small steps, done when a clock stops or starts, not per read.
- A clock created late (a policy now matching an older request) counts from the request's filing, without the waits before it, which weren't kept.
- The status field changes in its own history entry, beside the change that made it, so a request's history shows a4a keeping it (the help desk's agent on the `system` channel: not the requester's doing through the help desk, and no agent's change to undo, D34); people can set the field by hand, and the agent puts it right at the next change or tick.
- Sign-in links mean the portal needs email: without SMTP, requesters keep their tracking links.
- Reply addresses need the mail server to deliver plus addresses to a4a, as D30's do.

**Since:** an SLA per customer and a calendar per organization are customer groups (D56), which took the organizations in.

**Revisit when:** a desk wants targets that pause on states other than waiting; requesters want passwords or single sign-on to the portal; colleagues should answer each other's requests; or reply addresses should work without plus addressing (a mailbox per conversation, or the Message-ID alone). (Colleagues answering each other's requests came, in customer groups: D56. Passwords and single sign-on came, as each desk chooses: D63.)

### D46. Integrations: builds from CI, three more importers, accounts people connect, and VS Code

Four pieces that bring the work around the code into a4a, each through a path a4a already has.

**Builds.** A build is a project's: its number or name, how it ended, a link, and the commits it holds. They come from a build source (`ci/builds.ts`), an administrator's, of one of these kinds, or a third, Forgejo's and Gitea's Actions, which come as GitHub's runs do (D55):

- **A GitHub integration's workflow runs.** The integration (D26) takes `workflow_run` deliveries, signed as its pushes are. A run of the source's workflow (by name or file) on its branch that finishes is a build. Its commits are those since the source's last passing build on that branch: asked of GitHub's compare API with the integration's access token or as its GitHub App (D54), or, without either, those a4a saw pushed to the branch since, by when they were made. The run's number names it; a source taking any workflow names it by the workflow too, since every workflow numbers its own runs.
- **Any other CI** (Jenkins, TeamCity, GitLab CI, a script) posts to its source's `/builds/hooks/{id}` with the source's token as a Bearer token: random, kept as a hash, shown once, checked in constant time. That path takes no other credential, as SCIM's doesn't (D38). The build names its commits: shas, `{ sha, message }` whose messages are read for issue ids too, or a range a4a asks GitHub about through a GitHub integration that has seen the repository, with its token or as its app. The answer gives counts, never an issue's id: a CI's log is read by whoever runs the CI.

What a build does:

- **One that passes** becomes a value of the project's build field (D41): the source's choice, else the project's "Fixed in build", else its one build field. A project with none gets "Fixed in build", made if it isn't there and given to the project, when the source is added.
- **The resolved issues its commits name** get it, through applyChanges, each in a transaction of its own with the issue's row lock, as a4a's builds agent on the `ci` channel: their history says "from a build" and names the source, and rules act on the change as on any other. Only the build's project's issues: a build is a project's.
- **The rest it leaves, and says why**, in `build_issues` beside the build: not resolved yet (a later report of the same build marks it once it is); naming a build already (the fix went out in that one; a multi-valued field takes the build too); refused by a guard or a permission.
- **One that fails or is cancelled** marks nothing and isn't a value, but keeps what it holds, so the same build run again and passing marks it all.
- **The same build reported again** (a re-run, a retried request) is the same build: one row per name in a project, what it holds now added to what it held.

Builds are listed on a project's builds page, under an issue's commits (the build it was fixed in), to agents (`list_builds`) and as `build.recorded` events. A search reads a build field's values in the order CI reported them, so `Fixed in build: 120 .. 130` is a range, its ends included.

**Three importers more**, beside YouTrack's and Jira's (D29) and through their path: a dry run first, people matched by email, external keys remembered so a run again makes nothing twice, files brought as the run goes, quiet events, a fetch that stops carrying on where it was. The token is for the fetch and the run, never kept (`imports/readers-more.ts`).

- **GitHub Issues**: a repository's issues, not its pull requests, page by page by its Link header; labels as tags, the milestone as Fix versions, how one was closed as its state (completed: Fixed; not planned: Won't fix; duplicate: Duplicate), and comments. GitHub names people by login: those a4a knows by theirs (an administrator's record, or an account they connected) come with their email, so the mapping finds them. Its rate limits are waited out: `x-ratelimit-reset`, and its secondary limit's 403 with Retry-After.
- **Redmine**: a project's issues, each read with its journals (private notes left out, counted), relations as links, custom fields, attachments and time entries. An API key goes as Basic's user name, which Redmine takes.
- **Zendesk**: tickets by its incremental export, into a help desk: each ticket's requester becomes the request's requester (D24), its comments keep who saw them there (public replies, internal notes), and the requester's own are theirs, as on the tracking page. The first comment is the description; deleted tickets stay out.

**Accounts people connect.** D33 has an administrator record a person's login at a provider. Now a person can prove an account theirs, from their profile, by signing in at GitHub, GitLab or Bitbucket, or at a Forgejo or Gitea (D54): OAuth's authorization code (`vcs/connect.ts`), with PKCE where the provider takes it (all but Bitbucket), exchanged by the server with the provider app's secret. The account becomes their provider login, with the provider's own id for it, so its commits and pull requests are theirs. The token is used to ask who it is, once, and dropped: nothing a4a does later needs it.

- **Bound to who started it.** The state is random, kept as a hash for ten minutes and taken once, and the callback must come back to the same signed-in person, so nobody can connect their own account to someone else's a4a by sending them a link.
- **One person's.** An account already someone else's is refused; an administrator can move it.
- **Theirs to undo.** A person disconnects an account they connected; one an administrator recorded stays the administrator's to remove.

**VS Code** (`packages/vscode`): an Issues view (a search, yours by default), an issue opened beside the code with a box for a command, an issue made from the selected code (where it is, and the code quoted), an issue named at the start of the commit message, and a4a's MCP server offered to VS Code's agent.

- **It speaks MCP.** An app's OAuth token works at /mcp alone (D28), and an API token works there too, so the extension calls a4a's tools: what an agent can do, it can do, with the same checks.
- **Signing in** is an MCP app's: dynamic registration as a public client, the browser sent to a4a's consent page, the code back to a loopback port only the extension listens on (RFC 8252), PKCE and the resource indicator. Or a personal API token. Either is kept in VS Code's secret storage, never in settings.
- **No CSS of its own.** The issue's webview is drawn with Ocean's stylesheet and fonts, copied into the extension when it's built, under a policy that lets in nothing else; its words are escaped, and its one script only sends a command back.
- **Access tokens kept sealed.** GitHub integrations now take an access token, for the compare. It and new Bitbucket tokens are sealed with SECRET_KEY (D38's secret box); one kept as given before is still read.

**What it costs.** A build reads the links of the commits it holds (one query per 500) and the issues their messages name, then takes each issue's row lock in turn, so a build of hundreds of fixes is that many small transactions, outside any request but the CI's. A run without an access token or an app holds what a4a saw pushed, by commit time: a commit pushed late, or rebased, can fall in the next build instead. GitHub's compare answers 250 commits; past that, a build holds those, and the delivery's log says the rest weren't read. The importers read each issue's comments (GitHub, Zendesk) or each issue in full (Redmine) one request at a time, so a large project takes a while, its heartbeat kept. A Zendesk import into a project that isn't a help desk brings the tickets as issues, without requesters. The extension's tests run against a stand-in for VS Code; nothing here runs VS Code itself.

**Revisit when:** a CI wants builds of several projects from one pipeline (a source per project today); a build should hold what it holds by the commit graph rather than by time (a4a would keep the pushes' parents); GitHub Issues' reactions should come along (they'd need each reaction's person, by login); people want GitLab's or Bitbucket's pipelines as GitHub's runs are; or the extension should work offline, or show boards.

### D47. a4a on a phone: installed from the browser, offline-shy, and pushing what the inbox gets

Not native apps: the web app is the product, and a phone can install it. What that takes is a manifest, a service worker, push, and pages made for a thumb.

- **Installable.** `manifest.webmanifest` names a4a, its icons (drawn from its mark by `apps/web/scripts/make-icons.mjs`, at the sizes Android and iOS ask for, and a maskable one), Ocean's page colours in light and dark, `display: standalone`, shortcuts to New issue and the inbox, and a share target: a page or text shared from another app opens New issue with it filled in (a GET to `/issues/new`, so no service worker reads a form).
- **What the service worker keeps** (`apps/web/sw/service-worker.js`, written by the build as `/sw.js` with the build's id and the files of its shell): the app shell alone, index.html and the build's own scripts, styles, fonts, icons and manifest. They are the same for everyone and hold nobody's data. The API (`/api`, `/mcp`, `/oauth`, `/scim`, `/.well-known`) is never kept, nor apps' files and their kit (`/app-files`, `/app-kit`, D48), so nothing outlives a sign-out and nothing of one person's is shown to another on a shared device. A page of a4a's own is the network's when it answers within four seconds, the kept shell's otherwise (a frame within one, an app's widget, is always the network's); opened offline, a4a says so and waits for the network (React Query asks again when it's back).
- **A new version** is fetched and kept beside the old one, and takes over on the next start; meanwhile a quiet notice above the page offers to reload into it. The worker and the manifest are served `no-cache`, and the worker registered with `updateViaCache: 'none'`.
- **Push.** A person turns push on per device from their profile. The browser's push subscription (its push service's address, and the device's key and secret) is kept as `push_subscriptions`, with the session that sent it: signing out there, a new password or an administrator ending the sign-in ends it, as does a push service saying the device is gone (404, 410), or five refusals in a row. The notifier queues a push to each device in the same transaction as the notification (`push_outbox`), by the person's push level (`all`, `direct`, `none`, as email's, `all` taking what they subscribe to). A sender on every instance sends it five seconds later, so a burst on one issue goes as one push; a notification pushes again only when it comes to call on them more (a mention folding into what they watch). What it says is worked out when it's sent: nothing once read, once they can't see it (the project, or the issue limited away from them, read fresh rather than from access's ten-second memory), or once the device's sign-in has ended.
- **Its cryptography is Node's own**: VAPID (RFC 8292) signs a short token for each push service with a key from `VAPID_*`, or made once and kept in the database, its private half sealed with `SECRET_KEY` as two-factor secrets are, so every instance signs alike; each message is encrypted to its device (RFC 8291, aes128gcm), checked in the tests against the RFC's worked example. The push service carries what it can't read.
- **Where pushes go** is the browser's choice, someone else's address: so only the browsers' push services (`PUSH_HOSTS`: FCM, Mozilla's, Apple's and Windows'), over https on 443, no credentials in the address, and a redirect is an answer, never a place to go. A test may use plain http on this machine (`PUSH_ALLOW_HTTP_LOOPBACK`).
- **On the device** a push is a notification per issue (its tag), alerting again as it's replaced; tapping it opens the issue in the a4a window already open, or a new one. The app's badge shows what's unread, from each push and from the page.
- **Pages for a thumb** (Ocean): on a touch screen everything to tap is 44px at the least; a dense row's links and boxes grow their target, not their look. The page reaches the screen's edges and keeps clear of the notch and the home indicator; the keyboard shortens the page rather than covering what's typed (`interactive-widget=resizes-content`); a board's columns are most of the screen wide, a swipe settling on each. The browser flows hold the issue list, an issue, New issue, the inbox and a board to that at 390px, in light and dark.

**What it costs.** The shell is fetched once per version: the app and every language's catalog, which alone are about 5.9 MB, 1.5 MB gzipped (D49). A push is a few queries to render and one request per device, and a sender's poll every five seconds on each instance. iOS and iPadOS push only to a4a added to the Home Screen and opened from there (16.4 and later); the profile says so. A headless browser can't subscribe to a real push service, so the browser flows use a push service of their own and the worker's notifications are checked as asked for, not as drawn.

**Revisit when:** people want to act from a notification (assign to me, a state) without opening a4a, which wants notification actions and a way to authenticate them from the worker; or to read and write offline, which wants a store on the device that's cleared at sign-out, and a way to reconcile what was written meanwhile; or a native app is wanted for what the web can't do there.

### D48. Apps: extensions installed with consent, in a sandbox, within a grant

Some teams need a4a to do one more thing their way: a panel that adds up time by person, a rule that reads a setting, a page of their own. An app is that thing, packaged: a zip whose `manifest.json` says what it adds and what it asks for. An administrator installs it from a file or from a catalog.

- **What an app adds.**
  - Widgets, at six places: an issue's side panel, below an issue's summary, a project's page, a page of its own in the menu, dashboards, an article's side. Each is an HTML file among its files.
  - Handlers, at `/api/v1/apps/{name}/handlers/{handler}`: scripts that run in D40's sandbox, with its limits. They answer with `respond(value)`, keep values with `store(key, value)`, and change the issue they're about with `apply()` and `comment()`.
  - Rules: D40 scripted rules, on a change or on a schedule, never guards (refusing people's changes stays the project's own). They're installed with the app, named after it, and go with it. They can be turned off on the Rules page, but not edited there.
  - Settings, for the app or for each project: text, number, yes or no, a choice, a secret.
- **What it asks for, exactly.** It asks to read or write issues, comments, articles, fields and time. Each widget, handler and rule says what it uses, and the app asks for exactly what its parts use. Asking for what no part uses is refused, and so is a part using what the app doesn't ask for. So what an administrator reads is what runs.
- **Consent, as OAuth's** (D28). Installing shows what it asks in words, what it adds and where, whether a trusted key signed it, and its digest. The administrator accepts exactly that and chooses where it runs: every project, or some. An update asks again only when it asks for more, and saying no keeps the version installed. Installing, updating and removing is a person's decision, made signed in: a token, an agent or MCP is refused.
- **Where it runs.** An app is on or off. It runs in every project or in those chosen, less those whose managers turned it off. Its rules act only there. Its widgets show only there. Its handlers answer only about issues and projects there.
- **As whom.**
  - Its rules act as its agent (D34), `app-<name>`, made when it's installed. The access seam gives that agent what the grant does, in the projects it runs in: reading, and each kind of writing it was granted. Nothing else.
    - It sees no issue or comment limited to some people (D37), nor a private field (D50), and reads comments only if it was granted them.
    - Its settings come with each run, the project's over the app's.
    - It takes no tokens, and isn't listed among the agents.
  - A person acts through it: what a widget asks for them, and a handler they call.
    - It's their own access, narrowed to the projects the app runs in and to the scopes its grant allows. So an app never shows or does for a person what they couldn't themselves.
    - History and the ledger say it came through the app (channel `app`, the app's title): "Anna Schmidt · via the Time by person app".
- **Widgets, safely.**
  - **The frame.** A widget's frame is sandboxed (`allow-scripts allow-forms`, no origin of its own). Its files are served under a policy that sandboxes them again, reaches nothing (`connect-src 'none'`) and may be framed only by a4a's pages. So opened on its own, a widget is still no part of a4a.
  - **Its files.** They come from addresses a4a signs for twelve hours (an HMAC from SECRET_KEY's key, naming the app and its version). They need no cookie, and an old version's address stops working at an update.
  - **What it can ask.** A widget talks to the page by postMessage, and the page hears only its own frame. A call goes to the API as the person, with `x-a4a-app` and `x-a4a-widget`. The server allows only what a widget may call (issues, comments, articles, fields, time, its own handlers and storage), each within the grant and what that widget said it uses.
  - **What it can do to the page.** Its words show as text in a status line. Its height stays between 80 and 800 pixels. It opens a page of a4a's only when the person agrees. The page offers it Ocean's stylesheet (and its fonts, with a CORS header), so it can look like a4a.
- **Packages, checked before anything is kept.**
  - A zip of at most APP_MAX_MB (5 MB), 200 files, 2 MB a file and 20 MB unzipped. Sizes are checked as the zip states them and again as they come out.
  - Files are named by plain relative paths, and only kinds a widget needs: HTML, scripts, styles, JSON, images, woff2 and text.
  - Scripts must compile. Files are kept in the database, never on disk.
  - `apps:pack` builds packages and a catalog from folders. Two examples are in `examples/apps`: Time by person (a widget and a handler) and Keyword tags (a rule and a project's setting).
- **Catalogs.** JSON indexes at addresses in APP_CATALOGS, read as the importers read other trackers (https, public addresses, each redirect checked).
  - Each app's package is named by its SHA-256, checked before anything in it is read.
  - A signature is Ed25519, by a key in APP_TRUSTED_KEYS, over `name@version` and the digest. A catalog that says it signs has every app checked, and an unsigned one, or one signed by a key a4a doesn't trust, is refused.
- **Storage and runs.**
  - An app keeps JSON by key, its own or a project's: 1 MB each, 64 KB a value. Writing a project's needs someone who may change its issues; writing the app's own needs an administrator.
  - Its handlers' runs are logged (the latest 200), beside its rules' runs.
- **Removing it** says what goes, then takes its rules, files, settings, storage, run log and project choices. Its agent goes too, or, when history names it, stays banned so that history still says who.
- **For agents** (MCP): `list_apps` says what's installed where they can see: what each adds, its handlers, and what it may do. They call handlers through the API. They can't install, update or remove apps.

**What it costs.**
- **Per run:** a handler call is a sandbox run (about a millisecond, D40) and a few queries. The run log is pruned as it's written.
- **Per page:** an issue's page asks once for its widgets, and each widget's frame loads its files and Ocean's stylesheet.
- **A widget's reach:** one that's sent something can send it on, by navigating its own frame. The grant limits what it can be sent, so grant reading only to apps you trust.
- **What updates lose:** an update replaces its rules, and their run log with them. A file address lasts twelve hours, so a page left open longer needs reloading for its widgets.
- **No events:** installing and removing an app records no event. They're about a4a, not a project, as a person's account changes are.

**Revisit when:** apps should call out to services of their own (a handler's webhook, through D32's signed call), share code between parts, or ship guards; a catalog wants a marketplace's reviews and ratings; widgets need a4a's live events; or apps should be installed per project by its managers.

### D49. Each person's language: catalogs, a translator, and problems with keys

People who use a4a don't all read English. a4a says its own words in each person's language and leaves theirs as they wrote them.

- **What's translated.** Every word the web says: pages, buttons, labels, empty states, problems, the names screen readers read. And what a4a sends people: emails, the inbox's titles, push notifications, and chat: the bot's replies, and the words on its Teams cards and Slack blocks. Not translated: the API's and MCP's own words (they're for programs and agents), the query and command languages' keywords, and what people named (projects, fields, values, states, tags, rules), so `State Fixed` reads the same in every language.
- **Catalogs.** One per language in `packages/shared/i18n/`, in ICU MessageFormat (`intl-messageformat`), English the source. Keys say what a message is for and where: `page.profile.language`, `server.notify.title.assigned`, `problem.wrongLogin`. Plurals and selects are each language's own. Dates, numbers, lists and relative times go through Intl, never through a message: in the person's language, by its Intl tag (`intlTag`), and in their time zone (D31). English writes dates and lists the British way (`en-GB`).
- **Which language.** The one on the person's profile (`users.locale`, null for none), else the browser's (the page's `x-a4a-locale`, else `Accept-Language`), else the server's `DEFAULT_LOCALE`. Pages a person reaches signed out (sign-in, the help desk's public pages, the portal) follow the browser. Emails, push and the inbox's titles are in their recipient's language. A requester has no profile, so the help desk's emails and the portal's sign-in link are in the server's default. In chat, a reply to a person and the card beside it are in theirs; what a channel's people read together (its posts, the bot's word that it's subscribed, an unfurled link) is in the server's; and someone a4a doesn't know yet reads its link in the language their Teams says, or the server's from Slack, which doesn't say. The bot's commands (`help`, `new`, `search`, `subscribe`) are the same in every language, as the command language's are.
- **The web.** `main.tsx` loads the page's one catalog, a chunk of its own, before the app's modules run, so a word at a module's top is already in the language and the first bundle holds no words. The page fetches the app's chunks and styles from its start (`modulepreload`, written into `index.html` by the build), so the catalog and the app download side by side, and the app runs once both are in. Changing language reloads the page: nothing has to say itself again. Every request says the page's language in `x-a4a-locale`. `/me` says the person's choice and the server's default, and the page keeps both, to choose before anything loads next time.
- **Problems.** An `AppError` can carry a key and values beside its English (`said()`), and the error body says them (`error.key`, `error.values`). A page in another language says `problem.<key>`; one without a key, or whose catalog lacks it, says the server's English. English pages say the server's words, as before; so does the chat bot, which says a keyed problem in its person's language the same way (`problemFor`). Every problem the server makes has a key, 830 of them, a not-found one per kind of thing (`notFound.issue`); the API's English stays word for word beside it. `check:problems`, in `pnpm test`, fails on a problem made without `.said()`, and on a key no catalog has. A problem only programs meet (a chat platform's or a mail provider's signed post, OAuth's protocol error, an MCP tool's input) is marked `// api only:` and stays English. Under tests, the error body checks a keyed problem's English in en.json against the API's, its message and then its fix, so the two, written in different places, can't drift: the check found the API sending people to "Profile → API tokens", a page the web no longer has. The query, command and rule languages' problems (a query's, a command's, a rule's, an action's, a state machine's, a script check's, a move's plan's) carry a key and values the same way, made through `keyedProblem` and checked where each is made, under `problem.query.*`, `problem.command.*`, `problem.rule.*` and `problem.move.*`; `check:problems` finds each one written without its key. A refusal that holds them (a query that doesn't read, a rule that needs fixing) gives the page the list, each said whole with its fix; one with no key, what the JavaScript engine says of a script, is said in the English it came in (`problem.inItsOwnWords`). The web says them where they're typed and shown (`problemSaid`), leaving out a "Did you mean …?" the page offers as a button of its own. Some values are free text from elsewhere, and stay as they came: another tracker's words, a script's refusal or what its engine said, a rule's own message.
- **What the server words for a page.** Where the server words something a page shows, it sends what it says as data beside its English, and the page words it from the catalogs; the English stays in the API word for word, for agents and programs:
  - the query's explanation, in pieces (`explained`: what it asks, how it sorts, its dates' time zone), so the issue list says "4 Vorgänge: im Projekt BACK", saying its noun once (Spanish, French and Portuguese put the count last, "Tickets dans le projet BACK : 4", so their plural never reads "0 ticket");
  - a rule's preview (`says`: what it shows or why it shows nothing, the rule's kind, trigger, schedule and target, and how many issues), and a script's test run (`says`: it stopped, refused, let a change through, or asked for commands). `packages/shared/src/notes.ts` words them, with a rule sentence's pieces; under tests, the page's English is the API's `note` word for word;
  - a command's errors on each issue (`errorWords`, beside `errors`) in its results, a preview's sample and a script's run: a keyed problem's words, or what a script's engine said in its own;
  - where an agent's change stands in the history (`noteWords`): who undid it, or each thing that changed since;
  - the rule form's reading of a part, and the command bar's: said on the server in the page's language (`describeCommand(ops, tr)`), as the explanation is.
  The chat bot says the same in its person's language: a command's problems, its errors on the issue, and what it changed.
- **Kept notes.** What a4a writes down, to show later, keeps its words beside its English: a key, the message's own (`builds.note.*`, `vcs.why.*`, `rules.run.*`) or `problem.<key>` for one said as a problem, and its values. They live in a `jsonb` column beside the English one (migrations 0028 and 0029): a build's note on an issue (`build_issues.said`); why a chat subscription ended, its channel went or its app was removed (`ended_said`, `gone_said`, `removed_said`); a commit's command note (`vcs_links.command_said`, and the `commit.linked` event's `said`); and a rule's run, a sentence each (`rule_runs.said`). A page says a kept note in its language, and an English page a problem's English as the API's. A list among a note's values, whom a rule told, is said as the language's list (`Intl.ListFormat`): "Anna, Ben and 3 others", 「Anna、Ben、ほか3人」. So is what a run changed: each field's change is a note of its own, and so is each other issue a script changed, its changes a list inside it ("Also changed BACK-12 (State → Fixed and Priority → High)", 「ほかにBACK-12（State → Fixed、Priority → High）を変更しました。」), where the server had joined them with "; " and English's colon. Rows from before keep only their English, and a page shows that as it was; so does what is someone's own words (a rule's message, a script's refusal), and a commit's note that lists only fields and values.
- **The server.** `translatorFor(locale)` gives one translator per language; `localeOfPerson()` is a recipient's language, `localeOfRequest()` a request's. The notifier's words (`notify/words.ts`) take a translator, and each language builds its own sentences: "Ada Admin hat ihn Ihnen zugewiesen", "2 Änderungen von Anna und Ben".
- **Said whole, from the source.** The code passes a message numbers, names and codes, never English words to fit in. A count is the message's own ICU plural, so each language counts by its own rules (French's "one" takes in 0, Portugal's Portuguese's doesn't, and Japanese has none); a built-in role's name is a message, and English alone gives it its article (`aRole()`: "is a viewer", "ist jetzt Betrachter"); a rule is one sentence a language can order, and a list is joined by `Intl.ListFormat`. Sizes and dates come from Intl, "12,3 Mo" in French. The query explanation on the issues list is said in the page's language when the page names one (`x-a4a-locale`, `ctx.pageLocale`): an agent or a script, whatever its person's profile says, gets English, as the API's other words are.
- **Checks**, in `pnpm test` (`check:words`): every catalog has English's keys and no others; each message parses, with English's placeholders and tags; every key the code says exists, and every English key is said; no words in JSX, in a label map, or in what the server sends people (its emails, push and chat cards, and what the chat bot says: a reply's text, an action's note); and no phrase of words anywhere a page's code isn't plainly code, nor a plural made by hand (`n === 1 ? 'issue' : 'issues'`). Run over the tree before that last rule, it found 127.
- **The languages.** Ten beside English, each with every message: **German**, in Sie; **Spanish**, in tú: one neutral Spanish for Spain and Latin America; **French**, in vous, with French typography's spaces; **Japanese**, in です・ます, an issue a 課題; **Korean**, in 합니다체, an issue an 이슈, with a particle after a value written both ways (을(를)) in the catalog and chosen as it's said, where the value ends in Hangul or a digit (`koreanParticles`: "BACK-12를"), and both kept after a Latin word; **Portuguese**, Portugal's (`pt-PT` its Intl tag and, by `langTag`, its page's `lang`), in the third person Portugal's software uses, with no *você*; **Vietnamese**, in bạn, an issue a vấn đề, its letters precomposed (NFC); **Indonesian**, in Anda, an issue an *isu*; **Thai**, polite with no speaker's particle, an issue an อิชชู, its years Gregorian and its digits Latin (`th-TH-u-ca-gregory-nu-latn`: the Buddhist era's 2569 would sit beside the 2026 people type) and its lists Intl's with และ set off from names and ids (`listParts`), as Thai sets Latin words off; and **Simplified Chinese**, in 你 (您 for the help desk's requesters), an issue a 问题, as Jira's Chinese says. docs/translating.md gives the voice, the terms and each language's words for them, how to check a language, and how to add one: a catalog, its place in `LOCALES` and the records keyed by locale beside it (`LOCALE_NAMES`, `SENTENCE_GAP`, the server's catalogs, writing help's language name), which the typecheck asks for.
- **Ocean.** Its stylesheets and charts draw no words of their own. Its Teams cards for a4a (`teams/cards/a4a-issue.json`, `a4a-change.json`, and D60's `a4a-new-issue.json`) hold none either: their buttons and labels come from a4a in the card's data (`words`), in the reader's language, and the state's field by its name (`stateField`). Right to left: Ocean's components mostly use logical properties (`margin-inline`, `padding-inline`, `inset-inline`, `border-inline`, `text-align: start` and `end`, about a hundred), so most of its layouts would mirror under `dir="rtl"`; about twenty-five physical ones wouldn't (`left:` and `right:` for placed things, a few `padding-left` and `border-left` accents, one `translateX`). a4a's own stylesheet adds none: its one rule is the frame's (D11). None of a4a's eleven languages is right to left.

**What it costs.**

- **Pieces.** Some messages are pieces a page joins ("{who} {did}" in an email, "an issue is created" after "When" in a rule), as the English was built. German reads well in most; a few joins are stiffer than a whole sentence would be. Making one whole is a change in the code and in every catalog.
- **Size.** A catalog is about 6,000 messages: 455 KB of script for English, 468 to 580 KB for the others but Thai, whose letters take three bytes each (789 KB), 123 to 145 KB gzipped (Thai the largest). A page loads one, after its entry and beside its app: a first page waits for the larger of the two, not both. The server holds every catalog, and so does the service worker (D47), which keeps the whole build for offline, so every device keeps all eleven: about 5.9 MB, fetched as 1.5 MB only where a proxy in front gzips them (a4a's server doesn't).
- **The reload.** Changing language reloads the page once. On a new device, a person whose profile's language isn't their browser's sees their browser's for one load, until `/me` says theirs.
- **English is the source.** A message added in English fails the check until every catalog has it, so a missing translation is never silent; until it's translated, the catalog can hold the English, which its pages then say.
- **Rows from before.** A note kept before a4a kept its words (a build's, a subscription's end, a commit's, a rule's run) stays English on every page: nothing rewrites it.
- **Still English.** Besides the API's and MCP's own words, a page shows a few the server writes for administrators: a version control delivery's log, and a test of an integration (the integrations page), and a webhook delivery's error, mostly the other end's own.

**Revisit when:** a right-to-left language comes; people want a project's own words (its states, its fields) in several languages; or the API should answer in its caller's language.

### D50. Fields only some people see: private in a project, two permissions, and absent to everyone else

YouTrack lets a project keep a field to some people: a private field, read only with "Read Issue Private Fields" and set only with "Update Issue Private Fields". D37 planned it ("a Salary field only HR sees"), with the seam in place. a4a now has it, the same way.

- **Permissions decide it, not roles.** Two permissions join D37's: `readPrivate` (see a project's private fields) and `editPrivate` (change them). Every check in a4a asks for a permission, never a role by name, so a role an administrator makes ("HR", "Team") works at once, as YouTrack's do.
  - A manager has both; the built-in viewer and member have neither. In an open project everyone who signs in is a member, so a member's permission would make "private" mean "not the viewers and guests", while D37 asked for a field only some people see. A team whose members should see one gives them a role that does.
  - `editPrivate` changes something, so a read-only account or token never has it; and it needs `readPrivate`, since a field one can't see is one one can't set. Seeing is reading: a manager's read-only token sees them.
  - Through an app (D48), a person's permissions lose both: an app is granted issues, not what a project keeps to some people. An app's agent never had them, and an app's script reads none.
- **Making one private** is a project's managers' to do, as attaching a field is: `private` on `PUT /projects/{key}/fields/{fieldId}`, the "Who sees it" column on the project's page. It's a setting of the field in that project, so a field can be private in one project and public in another. State and the assignee field can't be: a4a reads them for everyone (whether an issue is resolved, for `#Resolved` and boards' columns; who has it, for who sees a limited issue and whom to tell), so kept from some they'd still say what they hold.
- **Absent, as if it weren't there.** To someone who may not read it:
  - `visibleSchema` leaves it out of the project's fields (`scopeFields`), and out of everything, values and all, when it's kept from them in every project of theirs that has it. The query and command languages, completion, the field list, `get_project` and every prompt to Claude are built from that, so they answer it as a field that doesn't exist, in the same words, with no "did you mean".
  - A field kept from them in one project and public in another is a word they know. Its values in the project that keeps it read as empty wherever a value is read: every read of a field's values in the compiler, grouping and reports takes `fieldSeenSql`, so it doesn't match, sorts as empty and counts as none, and plans and boards (lanes, columns, points) do without it.
  - Issue reads leave it out: REST, MCP, lists, boards, the assistant, a chat card to a person, a whiteboard's card (D58). A private field someone does see says so (`private: true`), and the issue page marks it.
  - Its changes leave the history, the feed, the live stream, the inbox, email and push (`eventFor`); a change to nothing else isn't shown at all, left out as SQL (`eventsFieldsSql`) so a feed's pages and its cursor stay whole. A new issue's created event loses its value, and a move's keeps back what either project keeps.
  - History names a change by the name its field had then, so a renamed field keeps the names it had (`fields.former_names`), and its old changes stay kept.
  - A rule's run that changed it isn't in their run log, since the run's words say the change, and a commit's command note says no change to it.
  - A field everyone sees can't show and hide by a private field's value (D41): its condition can't read one, and a field a public condition reads can't turn private, each refused saying what to do instead. A condition from before either holds always for whoever can't see what it reads, as one that no longer reads does, so it says nothing of the value.
- **Changing it.** `applyChanges` refuses to set a private field. To someone who can't read it, the refusal is a field the project lacks, in those words; to someone who reads it only, 403, naming the permission. Every field named is checked, changed or not, so trying values tells nothing. That covers every channel: the command bar, the issue page, the API, MCP, chat, commits' commands and imports.
  - A required private field asks nothing of someone who can't see it, on a new issue or a change.
  - Moving an issue carries what the mover can't see without saying it; what doesn't carry is left behind, as a field the other project lacks is. A clone copies none of it.
  - Rules and scripts act as their bot, which sees and sets everything, and so does a state machine's own command.
- **Who's told.** Notifications follow each recipient's access as they would sign in, as for a limited issue (D37). A chat channel is told only what every reader may see (D42): never a private field, its changes or a card's fact, and a channel's saved search is read as everyone would read it.
- **Webhooks get what everyone may see.** An administrator makes a webhook, but its receiver is outside a4a, where nobody's access is known, the reason D37 keeps limited issues from it. So a webhook gets no private field: its changes are taken out, and a change to nothing else isn't sent. An administrator who wants private values elsewhere reads them with a token, which asks a4a as someone.
- **Triage** never reads or suggests a private field: what it writes, everyone who reads the issue reads. A suggestion made before a field turned private leaves it out.
- **Caching.** Nothing keeps a field's value by issue alone. Whether a field is private is reference data, reloaded on every instance after a change (D17), and who may read it is the access view (two seconds at most, or until `accessChanged`). The live stream's facts, kept 10 seconds an event (D37), are limits, not values: each stream trims each event as it sends it. So an open stream stops carrying a field's changes when the field turns private, on this instance at once and on others at the change's `NOTIFY`.

**What it costs.**
- A query by someone who can't read some project's private field carries a `project_id NOT IN (…)` for each read of that field's values. Nothing for whoever reads them all, nor where no field is private.
- A feed carries one more `NOT (…)` per project that keeps a field from its reader, and each event is trimmed as it's read.
- Built-in members don't see private fields: a team where they should needs a role of its own.
- A rule's run that touched a private field is left out whole for whoever it's kept from, its other changes with it.
- That a field exists isn't private where it's public in another project of theirs: only its values are, where it's private.
- A rule's own words (its message, a guard's refusal, a script's comment) are its author's, who may write a private value into them.

**Revisit when:** a field should be private to named people or groups rather than by permission; a private field's history should show that something changed without what; or private fields should reach a webhook an administrator marks as trusted.

### D51. Articles limited to some people: checked up the tree, and missing everywhere else

D37 let an issue or a comment be limited to some people and groups, and planned the same for articles. An article now can be, in the same words and with the same picker, so a person learns one idea.

- **Who sees a limited article.** The people and groups named, its author, the project's managers and administrators, as an issue's limit keeps its reporter and assignee. Nobody else: not who edited it since, who mentions it, or who wrote the articles under it; not guests.
  - The author keeps it because they wrote it, as an issue's reporter does, and managers because they answer for the project. An article has no assignee, so nobody stands in for one.
  - Editors don't keep it. Whoever edited it was inside the limit then; a limit narrowed has to take it from them, or narrowing would leave it with everyone who ever saved a version.
  - Who may change the limit: whoever may change the article (the edit permission, and seeing it), as for an issue, and never away from themselves. It's an activity like an issue's ("Visible to", from and to), and the article's content keeps its version.
- **Checked up the tree, not copied down.** An article is seen by who sees it and every article above it. Its own limit only narrows what those above allow, so a sub-article is never seen by someone who can't see its parent, by construction.
  - Copying a parent's limit down was the other way. It reads one row instead of a chain, but every change of a limit would rewrite a subtree, a sub-article narrowed further would lose its own limit or need rules to merge two, and the rule would still need checking up the tree: a sub-article's author always sees it, and may not be in its parent's limit.
  - So moving an article under a limited one hides it, and what's under it, at once, from everyone outside, and nothing is rewritten. Moving it out shows it to whoever its own limit lets, as moving a page in a wiki does: the move's form and `update_article`'s preview say who will see it there, and its history keeps the move. Whoever may move it may lift its limit too, so a move gives nobody a new power. A new sub-article starts with no limit of its own; its parent's covers it.
- **Missing everywhere else, in the same words.** To anyone else a limited article, and everything under it, answers as one that doesn't exist:
  - by id, and its versions and diffs, restoring, changing, moving and deleting it; and as a place to put another (the same 400 as an id that isn't there);
  - the tree, whose places and counts are among what the caller sees, so no gap shows something there, and a place they give counts the same way; search and its total;
  - mentions: an issue an article mentions doesn't list the article, and its id in an issue's or a comment's text stays as text, leading to a missing article, as D37 keeps a hidden issue's id; agents' words (triage's) have it taken out, "an article you can't see", as `redactUnseenIds` does an issue's;
  - its files, listed, read as text, downloaded or shown in place;
  - the event feed (as SQL, so pages and the cursor stay whole) and the live stream, its own events and its files', within D37's ten seconds of a change; webhooks carry none of them;
  - MCP's tools and resources, and so the assistant, which works through them; apps' widgets on it, which ask for it by id; a whiteboard's card of it (D58); and writing help, which reads it as its reader may (D59).
  - Deleted while limited, or under a limited one, its history stays hidden: its deletion says it was limited, and it and its earlier events go only to who see all of its project.
- **The seam.** `services/access.ts` has it twice, as for issues: as SQL, `articleSeenSql` (a recursive subquery from the few limited articles down, from a partial index), and over a row, `seesArticleRow` (one recursive query up). For whom to tell, it's `whoSeesArticle`. `eventSeen`, `eventsVisibleSql` and `eventLimited` ask `articleEventSeen`, `articleEventsSeenSql` and `articleEventLimited`, which know an article's events by the `data.article` they carry.
- **Nothing to tell yet.** Articles have no watchers, and send no notification, email or push; chat unfurls only issues' links, and nothing exports articles. So nothing there could tell of one; when something does, `whoSeesArticle` says to whom.

**What it costs.**
- Every list of articles and every page of the feed carries one more subquery for anyone who manages nothing: the articles limited away from them, and what's under those. A lookup walks up the tree once.
- Deleting an article with articles under it the caller can't see is refused (409) in words that say so, and never which or how many: the article can't go while they're there, and nothing else would explain why. That much the caller learns; a manager of the project sees them, and can move them.
- An article's history keeps its moves' places as they were among all its siblings ("Position: 3 → 1"), so whoever reads it can count siblings they don't see.
- Moving an article out from under a limited one widens who sees it, on purpose; the form says so before it's moved.
- A limit changed just now can take ten seconds to reach an open live stream, as an issue's (D37).

**Revisit when:** articles get watchers or notifications (`whoSeesArticle` says who's told); a knowledge base beyond one project comes (D19); or people want an article to keep its parent's limit when it moves out.

### D52. A project's key can be renamed, and the key it had stays its own

A project's key (`BACK`, the start of `BACK-12`) can now change, as YouTrack's project ID can. Its issues keep their numbers, so `BACK-12` becomes `CORE-12`, and the key it had stays the project's for good.

- **One alias for the key, not one for each issue.** `project_key_aliases` keeps (key, project): every key a project went by. D41 kept an alias per moved issue because a move changes its number; a rename changes no number, so `BACK-12` is `CORE-12` by the key alone, whether the issue was made before the rename or after.
- **Every reader finds it the same way.** The schema snapshot's `projectsByKey` holds former keys beside current ones, each mapping to the project, so whatever turns a key into a project finds it unchanged: `findIssue` (addresses, the API, MCP, the assistant, chat and Slack's unfurls), `requireProject` (`/projects/BACK`, the event stream's `?project=`, a help desk's `/help/BACK`), the query language (`project: BACK`, `issue id: BACK-12`, a bare `BACK-12`), and mentions in text. So saved searches, subscriptions, rules' queries, boards' and dashboards' queries and chat subscriptions read as they did, and nothing rewrites what people wrote. An issue that moved away from the project before is found by its old id under either key, since its alias is kept by project, not key. Suggestions ("did you mean") and lists name projects by their keys now.
- **Readers that compared keys as text compare projects now:** version control's and CI's lists of keys to look for in commits and branches (a commit naming `BACK-12` links to `CORE-12`), the event stream's and webhooks' project filters, the feed's check of a link's other end, a shared dashboard's check of a widget's project, and finding someone's subscription by a project's key.
- **History stays as it was written.** Activities keep the ids and keys they were recorded with (`issue.created` of `BACK-12`), and so do kept notes, chat posts, webhooks already sent, baselines' tasks, import rows, rule runs and app runs; each id finds its issue through the alias. Readers that join history read it as the issue is now: reports' timelines read `BACK-12` as `CORE-12` (one history, not two, and in its project's scope), a deleted issue's events are looked up under every key its project had, and a baseline's tasks meet the plan's by the issue. An event's `project` reads as the key is now. Only `mentions` is rewritten, in the rename's transaction, as a move rewrites it (D41): it's an index of what names what, read by the id an issue or article has now, not a record.
- **What isn't a4a's key is untouched.** An import knows its issues by the other tracker's key (D21), with the project by id, so running it again into the renamed project matches as before. The help desk threads by Message-IDs and tokens, and a web-form request's thread root is the issue's internal id, so a rename breaks no requester's thread.
- **One transaction, the project's row locked.** The key changes and the old one becomes an alias together, so nothing reads a project with no key, or a key with no project. The rename records `project.key.changed`, rewrites mentions, and tells every instance's cache to reload when it commits; this instance's live stream carries the event, and the web app reads everything again, since every id on screen changed. Renaming back to a key it had takes that key off its aliases.
- **Keys stay unique across both tables, without a lock of their own.** A key moves only from free to taken by being written to `projects.key` (a new project, or a rename to it), and the unique index on `upper(key)` settles two such writes at once: the loser gets the same "taken" as a check would give. A key becomes an alias only by having been a project's key, so it's never free in between. Creating a project and renaming one each check both tables inside their transaction, which a cache a moment stale can't fool. Two renames of one project queue on its row; the second, if it sent the key it saw (`expectedKey`, which the web app always sends), is refused with the key the project has now, otherwise it renames from there. An issue made, or moved in, during a rename waits for the row as its number does, and reads the key back from the row it updated, so its own event names it as it is.
- **Who.** A project's managers, as for its other settings, and administrators. Not administrators only: the key is the project's, renaming breaks nothing outside it (every id it gave out keeps working), and YouTrack lets a project's administrators change its ID. What it costs: a manager can take a free key, and each key a project leaves stays reserved for it, so renaming through several holds them all. The page asks for the new key typed again (Ocean's Confirm, which now takes a word to type), since everyone who reads its ids meets the change at once. The key is checked as a new project's is; "taken" says the same whoever has the key, so a manager learns of a project they can't see only that a key is used, which unique keys can't avoid.
- **Every channel.** `POST /projects/{key}/key` and MCP's `rename_project_key` (a change, previewed first) rename through the one service the web app uses.
- **The web app.** The project page shows the key, the keys it went by, and, to its managers, the rename. An issue's old address goes to its id now and says which it was asked for by; a project's old address goes to its key now. `formerIds` on an issue stay those of its moves; the keys are on the project (`formerKeys`).

**What it costs.** One more small table, in every snapshot. A former key stays reserved while its project exists; deleting the project frees it with its others. A rename rewrites the mentions of the project's ids, one statement over the table. Every history report maps the ids it reads, in memory.

**Revisit when:** keys become contested enough that administrators should release a former key, which would break the links that use it; or a tracker an import reads renames its own keys (match by its internal ids then, not its keys).

### D53. Ranking on the board itself: a card's place and its column in one change, one board at a time

A board already had one order, shared by its backlog and its cards (D43); only the backlog could change it. Now the board can: a card is dragged within its column, or into another column at a place, and its state and its place change together. Its keyboard, a phone and the API do the same.

- **One request, one transaction.** `POST /boards/{id}/rank`, the backlog's, takes the card's `column` (and its `lane`, the `sprint` shown, and the issue's `expectedVersion`) besides `after` or `before`.
  - Into another column, the board's column field becomes the first of that column's values the issue's project has, through `applyChanges`, the one write path. So a state machine, a guard, a field's condition or a version that has moved on refuses the whole move, its place included, and the card goes back saying why.
  - Within its column the card keeps its value, so one in a Done column of Fixed and Won't fix stays Won't fix, and its place alone needs no version: an edit to its description doesn't stop a rank.
  - With a column and neither after nor before (an empty column, or the keyboard's move to the next one), the card keeps its place in the board's order. Without a column it goes to the top, as the backlog's always did.
  - A move to where the card already is writes nothing and says nothing.
- **Concurrency.** Every move, the backlog's included, locks the board's row (`FOR NO KEY UPDATE`) before anything else, then the issue's (in `applyChanges`), always in that order.
  - Two people ranking one column at once both land: the second places its card among the ranks the first left, so two cards put just after the same one end up both after it, the later first.
  - When a gap is too small for a double to split (or two share a rank), the board's ranks are spaced out again in the same transaction, under the same lock, so a respacing never crosses another move. The server's test of two moves at once fails on Postgres without the lock, and passes with it.
  - `NO KEY UPDATE` rather than `UPDATE`, so making a sprint, whose foreign key only reads the board's row, doesn't wait for a move.
  - Ranks are written a thousand rows to a statement. Those that exist are updated in place, so one whose issue was deleted meanwhile is skipped; new ones are inserted after their issues are locked against deletion.
- **Swimlanes share the board's order.** A lane is the board's order filtered by a field's value, not an order of its own. The backlog has no lanes and shares the order, and a card that changes assignee shouldn't lose its place. So a card dropped into another lane at a place changes its lane's field and its place in the same change, and "just after X" is just after X in X's lane too.
- **Columns show cards in rank order**, as D43 made them, and the board's view now says its whole order (`order`), so a page places a moved card before the server answers. Placed next to a card without a rank, the rule is D43's, with what the board showed (its cards in the sprint shown) where the backlog uses its own list.
- **The keyboard does what the pointer does.** On a card's id, Alt and Up or Down moves it a place in its column (and lane); Alt and Left or Right moves it into the next column, keeping its place in the board's order, as a command would leave it.
  - Left and right keep its place because a state isn't a priority. Putting the card "at the same row" would rank it without anyone choosing where; moved, it can go up or down from there.
  - Alt and Left or Right is the browser's back and forward too. A card's id takes it, and nothing else on the page does.
  - The focus stays on the card's id as it moves, put back after each render when it fell to the page, and the card wears the focus ring whole (Ocean's Board), so it's seen wherever it lands.
  - Each move is said in a live region once saved, in the backlog's words ("Moved BACK-27 above BACK-31.") or the column's ("Moved BACK-27 to In Review, below BACK-19."). At an end, the region says why nothing moved.
  - Moves go one after another, and a card moved again before its last move is saved is sent with the version that move left. A refusal drops the moves queued behind it on the same card, which were made on top of it.
- **Touch: a drag waits, a swipe moves.** On a phone the columns are a row to swipe through (D47). A card held still for 220 ms is picked up; a finger that moves 6 px first is a swipe, and the row scrolls and snaps to a column.
  - Once a card is up, the page doesn't scroll under it, the board scrolls at its edge to the next column, and no long-press menu or text selection starts on it.
  - Time rather than a handle: a handle would be a second 44 px target on every card, and holding still is how phones pick things up.
  - The slot where a card would land holds still while the finger or pointer is over it, so it doesn't flicker as the cards make room.
- **Others see it live.** Each move records `board.issue_ranked` (the board in `data`) in its transaction, published after commit. The live stream carries it to whoever sees the issue, through the access seam (D37), and an open board re-reads its order, within about a second.
  - It's in the ledger and goes to webhooks that listen for it, and isn't in the issue's history: the place is the board's, not the issue's.
  - A move into another column is the issue's own `issue.updated` as well.
- **Permissions are the backlog's**: the edit permission in the issue's project, since placing an issue is work on it (D43).
  - Within its column a move asks nothing of its state, so someone a state machine or a guard keeps from moving a card to In Progress may still rank it among the Open ones. Into another column, the move takes whatever that change of state takes.
  - A viewer, and a read-only account or token, can't rank. An issue or an anchor the caller can't see is missing, in the words of one that doesn't exist.
- **MCP** has `rank_issue`, on the same service: a change, destructive (into another column it overwrites the state), and previewed by a dry run of the column's change.

**What it costs.**
- Moves on one board are one at a time: a few milliseconds each, longer when a state machine or a guard's script runs (up to D40's limits). Two boards never wait on each other.
- A move reads every rank of its board, as D43's did, and writes one row, or all of them when the board is spaced out again. The first move next to cards without a place first reads the board's order, one search.
- Each move is an event: the ledger has a line per rank, and a webhook listening for everything gets each one.
- A card's id takes Alt and Left or Right from the browser.

**Revisit when:** a board holds tens of thousands of ranks (read only a move's neighbours, and rank by fractional keys rather than doubles); people want a lane's own order; or a card's place should show in its issue's history. (All three came with D65: fractional keys and a move that reads only its neighbours, lanes that can keep their own order, and a line in an issue's history for a run of its card's moves.)

### D54. Git hosts as a4a itself: GitHub Apps, and Forgejo accounts people connect

A GitHub integration read GitHub (the commits a build holds, D46) with a person's access token, and people connected their GitHub, GitLab or Bitbucket accounts but not one at a Forgejo or Gitea. Now a GitHub integration can read as a GitHub App, and people connect a Forgejo or Gitea account as they do the others.

**GitHub as an App.** A person's token reads as that person: it stops when they leave or it expires, and reaches whatever they can. A GitHub App acts as itself, and reads only what each installation gave it.

- **Given, and checked first.** An administrator gives a GitHub integration an app: its id (or client id), one of its private keys, and its installation if a4a can't find it. a4a asks GitHub before keeping anything: the key is taken (`GET /app`); the installation is the one named, else the one on the repository the integration is named after (`GET /repos/{repository}/installation`), else the app's only one; it isn't suspended; and its token reads the repository. Each failure says what's wrong and what to do: a key GitHub refuses (the server's clock among the causes), an app not installed on the repository, several installations and no word which, an installation gone or suspended, an app that may not read contents, a repository its installation wasn't given.
- **Kept.** The private key is sealed with SECRET_KEY (D38's secret box) and never shown again; the app's name and the installation's account are kept, to show.
- **A token at a time.** a4a signs a JSON web token (RS256, issued a minute back for clocks that drift, ten minutes long, as GitHub asks) and trades it for the installation's token, asking for `contents: read` and nothing more. GitHub lets that token live an hour; a4a keeps it in memory, per integration, until five minutes before then, and never writes it down. Reads at once share one exchange. GitHub can end a token early (an installation removed, its permissions changed): a read refused with 401 drops it and takes another, once. Each instance takes its own.
- **One seam.** `readWith(app, integration, request)` in `vcs/tokens.ts` reads a provider's API as an integration, with its app or its token, and says in a ReadError what went wrong. Builds' compare reads through it, and so can whatever reads a provider next.
- **Its webhook.** A GitHub App has one webhook, for every repository it's installed on. It can be the integration's: the integration's URL and secret go in the app's settings, and its deliveries are signed as a repository's are, so nothing else changes. The integrations page says how: Contents, Pull requests and Actions read-only, and the Push, Pull request and Workflow run events.
- **Switching.** An integration reads with a token or as an app, never both: giving it an app removes its token, giving it a token removes the app, and both at once is refused. The integrations page says why to switch where a token is kept. A test of the integration takes a new token as the app, so an installation removed since shows at once; where a build reads, the delivery's log says it.
- GitHub Enterprise Server's API address works as before, for the app's calls too.

**Forgejo and Gitea accounts people connect.** D46's connect, at a Forgejo or a Gitea. Both are self-hosted, so an administrator gives the instance's address beside its OAuth app's id and secret (`FORGEJO_URL`, `FORGEJO_CLIENT_ID`, `FORGEJO_CLIENT_SECRET`, or `GITEA_*`), as GitLab's self-managed address is given; there's no default instance. They're one provider in a4a, `gitea`, as their webhooks are (D33): both answer the same OAuth2 and API, and what differs is only the name a person sees, the one the administrator set up.

- An authorization code with PKCE (S256), the app's secret sent by the server, and `read:user` asked for, which an instance that grants scopes reads as reading who you are.
- `GET /api/v1/user` says whose the token is: its id and login become the person's provider login, as D33's are, matched without regard to case. The token is dropped, and the refresh token with it.
- The state is bound to the person who started it, for ten minutes, once, as D46's is.

`VCS_ALLOW_HTTP_LOOPBACK` lets a GitHub API address and a Forgejo be plain http on this machine, for the browser suite, whose server runs as production does.

**What it costs.**
- An app is more to set up than a token: the app, its permissions and events, a key, an installation. The page walks through it.
- Each instance takes its own token, about one an hour per integration, against an installation's limit of at least 5,000 requests an hour.
- An integration reads through one installation. An app installed on several accounts, whose one webhook brings every repository's deliveries to one integration, reads only the repositories of that installation; for the others, a build holds the commits a4a saw pushed, and its log says why.
- A key sealed with one SECRET_KEY can't be opened with another: the integration then says to give it its app again.
- An instance that doesn't grant scopes gives the token its default reach; a4a uses it once, to ask who it is.

**Revisit when:** an app installed on several accounts should read each repository through its own installation; builds should report back to GitHub as the app (check runs); or Forgejo's tokens should be narrowed where an instance doesn't take scopes. (All three came: each repository through its own installation, check runs on pull requests naming their issues, and Forgejo's tokens refused when wider and taken back where the instance offers it: D66. A build's own result as a check run is still to come.)

### D55. Builds from Forgejo's Actions, as GitHub's workflow runs come

D46 took GitHub's workflow runs as builds, through the integration's own webhook, and left every other host's CI to post its builds with a token. Forgejo's Actions now come as GitHub's do: a build source of kind `gitea` takes a Gitea or Forgejo integration's runs, on a branch and a workflow, through the webhook a4a already receives and verifies (D33), so nobody sets up a second hook. GitLab's and Bitbucket's pipelines are still to come.

- **What Forgejo sends.** Its source says; its documentation shows no payload (`modules/webhook/type.go`, `modules/structs/action.go` and `hook.go`, `services/webhook/notifier.go`):
  - From Forgejo 17, `workflow_run_<status>` each time a run moves: waiting, blocked, running, then success, failure, cancelled or skipped. Its body is `{ action, run }`.
  - From Forgejo 12, `action_run_success` and `action_run_failure` once a run is done: any end but success is a failure there, and `run.status` says which. 17 still sends them beside the new ones. 12 to 16 also send `action_run_recover` beside a success that follows a failure, which a4a leaves, since the success says the same.
  - Forgejo 11 and before send nothing for a run. There a workflow's last step posts the build to "Any CI", as any CI can.
  - The run: its id; its number (`index_in_repo`); its workflow's file (`workflow_id`, `ci.yml`: Forgejo names no workflow by its name); its ref (`prettyref`: a branch's or a tag's name, or `#12` for a pull request); the commit it built; its status, times and page. And the payload of the event that started it, as a string of JSON: for a push, the push's own delivery, its commits and their messages.
  - Gitea sends `workflow_run` in GitHub's shape instead, read as GitHub's. It names the workflow's file with its ref (`ci.yml@refs/heads/main`), which a source matches by the file. a4a's one `gitea` provider is both, so Gitea's runs come along; the tests are Forgejo's shapes.
- **A run is a build once it finishes,** as GitHub's is: waiting, blocked and running are read and left, so no delivery, however late, makes a finished build run again. A skipped run (every job's condition said no) built nothing and isn't a build; nor, now, is GitHub's, which D46 recorded as a failure.
- **Its name** is the run's number, whichever workflows the source takes. Forgejo counts runs across a repository's workflows, so no two runs share a number, and it's the one Forgejo's pages show. A pull request's run is on its head branch, as GitHub's is, and named like any other; a source of `main` doesn't take it.
- **Which commits it holds**, by D46's rule: those since the source's last passing build on its branch. For GitHub, its compare, asked with the integration's token, is the exact answer. A Gitea or Forgejo integration holds no token (its deliveries carry what a4a reads), so a4a asks Forgejo nothing, and a run holds:
  - what a4a saw pushed to the branch since the last passing build's head commit, by when the commits were made, as GitHub's runs without a token do; one whose head's time isn't known counts from when it was recorded;
  - and the commits of the push that started the run, which Forgejo's run carries with their messages, so a run names its issues even when a4a missed the push.
  - Only a GitHub integration's token is sent to GitHub's compare, so a token another host's integration holds can't go to github.com.
- **The same delivery twice** is claimed once by its `X-Forgejo-Delivery` (D33). But one finished run comes as two deliveries on a webhook that takes every event (`workflow_run_success` and `action_run_success`), and a delivery sent again from Forgejo's page is a new one. So a build's reports are taken one at a time: an advisory lock on the project and the build's name, held in the short transaction that settles where the build stands and makes its value. A report that tells nothing new (the same status, link and commits) looks again only at the issues the build left open, as D46 has a later report do, and records no `build.recorded` unless it marks one. What a build marked stays marked, whatever a report beside it found.
- **Late states.** A success is final: it's a value, and it has marked issues. Otherwise a report older than the one the build holds, by when each says the run finished, leaves it as it is: an attempt's failure that comes after the re-run's success, or after a newer failure. A re-run is the same run, its number unchanged, so it's the same build, as GitHub's re-runs are. Any CI's reports, which seldom say when they finished, are taken in the order they come, as before.
- **Everywhere GitHub's go.** On the CI page an administrator chooses "Forgejo or Gitea Actions", the integration, the branch and the workflow's file; the integration's steps say which events to tick. The builds are a project's like any other: on its builds page, on its issues, in `list_builds`, as `build.recorded`, and in searches and reports by the build field.

**What it costs.** Without a token, a run holds what a4a saw pushed, by commit time, and its own push's commits: a commit pushed late, or rebased, can fall in the next build, as with GitHub's runs without one. A run of a pull request or a schedule carries no push, so it holds only what a4a saw pushed. Each report of a build takes one more short transaction and a lock. Forgejo 11 and before need a step that posts to "Any CI".

**Revisit when:** Gitea and Forgejo integrations hold a token and the server's address (D54 connects people's Forgejo and Gitea accounts), so a run reads its commits from Forgejo's compare, as GitHub's do; GitLab's and Bitbucket's pipelines should come as these runs do, through the webhooks a4a already verifies; or a build should show while it runs.

### D56. Customer groups: a desk's own, kept by each request, shared by choice, and missing to everyone else

D45 let a desk name email domains as organisations, whose requesters read each other's requests, and left an SLA per customer, a calendar per organisation and colleagues answering each other's requests for later. A desk's customer groups take all three.

- **A desk's own.** A group belongs to one help desk, as its SLA policies and working hours do, and the desk's managers keep it, as administrators can. The other way was a group for the whole instance that desks serve: one Acme everywhere. It isn't, because what a group decides is the desk's: which of its people take its requests, whose hours its SLA counts in, and above all who reads whose requests. A company's IT desk and its HR desk share a customer, not its requests, and one desk's managers mustn't change what another desk's requesters see.
- **Who's in it.** The email domains that put a requester in it by themselves (matched whole: `eu.acme.com` is a domain of its own), and requesters added by hand, by their email, before or after they first ask. A domain names one group at a desk, and a requester is in one group at a desk: added by hand to a group, they're in that one, whatever their domain says. So nobody is at two groups' domains: a domain another group has is refused, naming the group, and so is adding by hand someone another group has by hand. A requester is their address (D24): writing from a new one, they're someone new, in the group of its domain; the group they were added to by hand keeps the old address.
- **A request keeps the group it was filed under:** its requester's then, kept on the request as its project is. Joining or leaving a group, or a domain added or taken off, moves no request already filed, so last quarter's report counts what was so then. The team gives a request another group, or none, on its page: a change to the request through `applyChanges`, with the edit permission and its version, in its history ("Customer group").
- **Choosing by customer.** `customer: Acme` (and `has: customer`) reads a request's group by name, beside `requester:` and `sla:`. Support teams say "customer", and `group:` would read as a4a's groups of people (D27). So a desk's SLA policies, rules, saved searches, boards and reports choose by customer through the queries they already take. A name none of the asker's desks has is a problem with a guess drawn from the desks they read (`scopeSchema`), so it names no other desk's customers; a policy naming a group its desk hasn't is refused as it's written.
- **Its own hours.** A group can have working hours and holidays of its own, and its requests' SLAs count in them; everyone else's count in the desk's. A request that changes group keeps the time its clocks used: the stretch counting closes in the hours it had, and what's left counts in the new group's. A group's hours changed bring the desk's open requests to them at once, as a desk's do (D45).
- **Dedicated agents.** A group names people of the desk's project, in order. A new request from its members goes, in the transaction that files it, to whichever of them has the fewest open requests at the desk, the one named first between equals: the simplest rule that spreads the load and that a team can predict, where a rotation forgets who's swamped. It's the help desk's agent's change, as automation, in the request's history. Whoever can't be given one is passed over: someone who may no longer change the project's issues (taken out of it, a viewer, banned, a read-only account) or is away all day today (D36), and anyone a guard refuses. With nobody left, the request stays unassigned, as one without a group does, and the desk's lead hears of it as of any request. Requests filed together for one group take turns (an advisory lock per group), so each sees the other's agent. A request the team moves into a group gets an agent the same way. The desk never assigns over anyone: not a request with an assignee, nor one whose assignee anyone else ever set or cleared (a person, a rule, an agent for someone), as its history says.
- **Shared requests.** A group shares its members' requests with each other, or doesn't: `none`, the default, since sharing is a choice; `read`, as D45's organisations did; or `comment`. A member answering one writes a public comment as themselves (by the help desk's agent, with their requester id, as a requester's own reply is), on the portal or by email to the request's reply address (D30), from their own address, past DMARC. Its requester hears of it by email, as of the team's replies (those copied on it don't: a4a sends them only the team's words, D57), the team as of the requester's own, and it ends a wait as their answer would.
- **Kept private.** A request can be kept from its group, by its requester (on the portal, or as they ask) and by anyone who may change it (on its page), a change in its history either way. Its group's other members then find it missing; the team sees it as ever.
- **Through the seam.** What a requester sees is `requesterSees` in services/access.ts, over a request's group and privacy and what each of their groups shares with them; whether they may answer, `requesterMayComment`. Anyone outside the group, in a group that shares nothing, or kept from a private request gets the 404 of a request that doesn't exist, in its words. A group's count of open requests counts only those its reader sees, and so does the SLA report.
- **D45's organisations** are migrated once, at start, under the start's lock: each domain a desk named becomes a group of its own, named for it, sharing to read, and the desk's requests from that domain are filed under it; the desk's settings lose the list in the same transaction. A script that still sets them gets a 400 that says where they went.
- **Everywhere.** REST (`/projects/{key}/customer-groups`, `PATCH /issues/{id}/request`, `PATCH /portal/requests/{id}`), MCP (`list_customer_groups`, `set_request_customer_group`, and the group in `get_issue`), the desk's page, a request's card, the portal, and the SLA report's totals by group.

**What it costs.**

- A group holds the requests filed under it: one made today holds none from before, and a requester joining a group brings none of theirs, until the team files them.
- A customer that several desks serve is a group at each.
- A new request in a group with agents takes a lock and reads the agents' roles, days away and open requests, in its transaction: a few queries.
- A member answers by email only with a4a's email about the request in hand, its reply address intact: a4a writes to the requester alone, so in practice one forwarded whole.

**Revisit when:** many desks serve the same customers (a directory of customers desks pick from); a requester should be in several groups at a desk (a consultant for two customers); members should hear of their group's requests and answer a4a's own email about them (as the request's CCs, D57); or requests should go to agents by skill or by rotation rather than by load.

### D57. CCs on help desk requests: told what the requester is told, answering as themselves, and only the team's words go out

D30 let the requester alone answer by email, and named this as the next step: people other than the requester answering as the request's CCs. A request now keeps a list of addresses copied on it, at most `REQUEST_CCS_MAX` (20) at once, in `request_ccs`: one row per address and request, with how it came (`via`), who on the team copied it, and when.

**Who copies whom.**

- **The Cc of the requester's own email,** a new request's or a reply's, through D30's one path. Only the requester's own message: never mail no person wrote (D30's auto-replies, bounces, lists), never a CC's answer, never anyone else's. Never a4a's own addresses (`MAIL_FROM`, `MAIL_REPLY_ADDRESS`, any desk's, with their plus forms), so nothing loops; never someone on the team (their email or one they confirmed: they watch the issue instead), the requester, or an address that takes no replies. A new request's Cc is copied in the transaction that opens it, so the email that says it came in names who is copied: where DMARC isn't checked and the request was forged, the address's real owner sees who will hear the team's answers. What's left out is said in the desk's log.
- **The team,** on the request's page, `POST /issues/{id}/request/ccs` and `add_request_cc`: whoever may change the project's issues, as a public reply takes, since copying someone sends them the team's replies.
- **The requester, on the portal:** anyone they choose, not only colleagues. The request is theirs to share, as forwarding its emails would; a colleague rule by domain would let a requester at a webmail domain copy the world anyway (D45 says why desks name their domains); and a4a never sends a CC the requester's words (below), so copying someone makes a4a carry nothing the requester wrote but the request's summary in a subject, and that only when the team replies. Someone copied, or a colleague, can't copy others.
- **The cap:** each public reply sends one email per CC, each minting a reply token, so 20 bounds what one reply sends (21 emails with the requester's) and what one forged email's Cc can reach. A conversation rarely needs more than a few people, and a team's list address counts as one. Zendesk allows 48; this is room for a customer's team without making a4a a list server. Each change locks the request's row, so two at once can't pass it; the database's unique index on the address keeps one row each.

**Who takes them off.** The team (`DELETE …/ccs?email=`, `remove_request_cc`), and each of them: every email they get has an unsubscribe link, `kind: cc` on D23's page and its one-click POST, which takes them off. A row stays when it's taken off, so an email's Cc never puts back an address that was taken off, by the team or by itself; the team may copy them again, and the requester may, unless they stopped it themselves.

**What they're told.** Each public reply and change of state the requester is told of, each by an email of their own, in the desk's language (the server's: neither a requester nor a desk has one, D49). Not the requester's acknowledgement, and never anything internal: the consumer that emails the requester queues one email per CC copied when the event happened, re-checked when it's sent. The requester's own stopping isn't theirs.

- **A reply address of its own,** `support+<token>@…`: minted as the email is sent, kept as a hash in `helpdesk_reply_tokens` with the address it was sent to (`email`), so it answers for that address alone, and only while it's copied.
- **The request on the portal, never the requester's tracking link,** which would show the requester's address and reply in their name. The link opens `/portal?request=<id>`; they sign in by the address copied, in a way the desk takes (D63).
- **Only the team's words.** What a CC, the requester or a colleague of the requester's customer group (D56) writes isn't emailed to a CC, and what a CC writes isn't emailed to anyone. a4a sends people outside the team what its team wrote, so nobody outside it can make a4a carry their words to an address they name; they read each other on the request's page, and answering all from their own mail works as it always has.

**Their answers.** A CC answers to their reply address, by answering an email a4a sent them, or by answering the request's first message: the requester's own email, which a CC from its Cc already has and answers to all. Their words are cut from what they quote, as D30 cuts the requester's, and become a public comment by the help desk's agent, as their requester account: D45's, or made for their address, named as they sign their mail, else as they were copied, else for their address; a name they gave the portal stays. The first message counts for the requester too now: once CCs answer all on it, the requester's own answer to all is a reply, not a new request.

- **Refused, and nobody told,** as D30 refuses a stolen token: an answer to a CC's reply address from any other address (the requester's and another CC's included), one from someone no longer copied, and anything to the requester's reply address from anyone but the requester and their colleagues who may answer it (D56).
- **The SLA:** their answers are the customer's side, written with `requester_id`, like the requester's. They end a wait on the customer and move a waiting request to the desk's resume state (D45), and never count as the team's first response.
- **On the portal** they see the request while they're copied, marked as one they're copied on, and reply there as on email; taken off, it's missing to them, alike with one that doesn't exist. They don't see who else is copied; its requester does. `requesterSees(…, copied)` in the access seam decides.
- **Customer groups (D56)** are another grant: a group shares a desk's requests among people by their organisation, for as long as they're in it; a CC is one address on one request, copied by its requester or the team, for as long as it's copied. They don't depend on each other: someone in the requester's group who is also copied sees the request either way, and taken off it, still sees it through the group if D56 says so. Neither changes whom the other tells.

**The history** records each change as `request.cc_added` and `request.cc_removed`: by the person on the team, or by the help desk's agent for the requester (from their email, or on the portal) or for the CC (from their link). A guest isn't shown either, as they aren't shown who asked. Webhooks can listen for both.

**What it costs.** A row per address copied, kept after it's taken off; a reply token per email to a CC. Each event on a request reads its CCs. Where DMARC isn't checked, a forged email can copy its forger on a request filed in someone else's name, and the forger then gets the team's public replies: the page and the history say where each CC came from, and the address's real owner is told who is copied, but the team still checks who is asking before it sends anything private, as it must already. CCs need SMTP: without it they're a list nobody hears from, and only a password they already have or an identity provider signs them in to the portal (D63).

**Revisit when:** the requester wants to take off someone they copied (now the team's, and the CC's own); a desk wants its own cap; CCs should hear each other's and the requester's words (a4a would then relay outside words, and needs a sender it can trust, such as DMARC passing by a server it knows); or the Cc of a new request nobody vouches for should wait for the requester to confirm it. (All four came: the requester takes anyone off, a desk sets its own cap, CCs hear each other's words where a4a can trust who wrote them, by DMARC at a server the administrator names or the portal signed in, and a new request's Cc nobody vouches for waits for its requester: D67.)

### D58. Whiteboards: a project's canvas, edited live by several people, its notes made issues

YouTrack 2026.2 has whiteboards: a canvas beside the issues where a team plans and brainstorms, whose notes become issues in a click and whose arrows become links. a4a has them now, on every channel.

**Whose a whiteboard is: its project's.** Each belongs to one project: whoever reads the project reads its whiteboards, whoever may change its issues (the edit permission) changes them, and whoever made one, or manages the project, may delete it. To anyone else it's missing, in the words of one that doesn't exist, on every route, its live stream included.

- The other way was a person's whiteboard, shared with people and groups, as dashboards are shared. It would be a fifth kind of access beside projects, limits (D37, D51) and private fields (D50): its own lists, its own checks in the feed, the stream and every reader, and its own idea of who may convert a note into which project. A project already means who works together, and every seam a4a has (`projectAccess`, the feed's `eventsVisibleSql`, roles and their permissions, custom ones included) reads it already, so a whiteboard's events are filtered as any project's are, with nothing new to forget.
- What it costs: no private scratch board, and no board between two projects' teams that one project's readers can't see. A board can still hold cards from any project; each reader sees only theirs (below).

**What's on one.** Notes (words, and a tone from a short fixed set: plain, an idea, agreed, a question, a problem, parked, which Ocean draws as its meanings `writes`, `good`, `warn`, `bad`, `idle`, each with its word), text blocks, issue cards and article cards, arrows between any two of them with an optional label, and sections, frames that group what lies inside them (by its centre; the smallest, where they overlap). Each element keeps its place, size and stacking order. An element's id is chosen by whoever adds it, so a batch can add a note and an arrow to it at once, and undoing a removal adds it back under the same id.

- **Caps:** 500 elements on a whiteboard, 2,000 characters of words in each, 200 in a label, 500 operations in a batch, 50 notes and 50 arrows converted at once, places within 100,000 units of the origin and sizes from 8 to 4,000. A whiteboard is drawn whole as SVG and read whole by a screen reader's outline, and its answer stays under about 250 KB: past that it's a wall, not a team's canvas. The 501st element is a 409 that says so.

**Cards show only what their reader may see.** A card names its issue or article by internal id, never in an element: elements go to every reader, cards are read for each one (`cardsFor`, through `seenIssueIds` and `seenArticleIds`, and the issue's fields through `issueDtos`, so a private field is never there, D50). One a reader may not see, limited (D37, D51), in a project they don't read, or deleted, is `{ element, shown: false }` and nothing else, the same for every reason, its id unsent; the page draws a dashed card that says so. Removing a card removes the card: its issue or article stays as it is. Deleting the issue empties the card (`ON DELETE SET NULL`).

**Two people at once.** Every change is a batch of operations on elements (`add`, `update` with only what changes, `remove`), applied in order in one transaction under the whiteboard's row lock, which also numbers it: the whiteboard's `seq`, one more each time.

- Where something is, how big, its stacking, its tone and its words go to the last writer, property by property. So two people's changes to different elements both land, and so do changes to different properties of one (one moves a note while the other rewrites it); two moves of one note end where the later put it. No batch rewrites what it didn't name, so no edit to one element undoes another's.
- An operation can carry `expect`: values the element must still have. The page sends one with words (what they were when the person began typing) and with every undo and redo (what the person left). If someone changed them meanwhile, that operation alone is refused with the element as it is now, and the rest of the batch goes on: the page keeps the person's words in the box and says the note changed, and an undo of a move someone has moved since stays undone. Last writer wins was enough for places, which are cheap to redo and seen moving; words are not cheap to retype, so they are compared.
- The tests run real concurrency on Postgres: a dozen batches on different elements at once, a move and a rewrite of one note at once, and two rewrites of the same words at once, one let through and the other answered with what's there.

**Element edits aren't events.** A drag is one batch, and a workshop makes thousands an hour: as events they would grow the log every consumer reads (webhooks, rules, the notifier, reports' histories) for nothing an outside system acts on. So a whiteboard keeps its latest changes in its own log, `whiteboard_changes` (the elements each left, and what it removed, the last 500), and its own live stream sends them: `GET /whiteboards/{id}/stream`, beside a4a's live events and built the same way (`events/whiteboard-live.ts`). A change is read from the log on a commit here, on another instance's `NOTIFY` (a new channel, `a4a_whiteboard`), on a `LISTEN` reconnect and by a ten-second backstop; since `seq` only grows under the row lock, change n + 1 commits after n, and a stream that resumes after n (`Last-Event-ID`) misses nothing, or, more than 500 behind, is told to read the whiteboard again. Each frame is checked against the reader's access as it goes, so someone taken off the project hears `gone`. The event log hears what outside systems should: `whiteboard.created`, `whiteboard.renamed`, `whiteboard.deleted`, and `whiteboard.converted` (the issues and links made), in `EVENT_TYPES`, filtered by project like every event, and webhooks may listen for them.

**Who's looking.** Each open stream keeps a row in `whiteboard_viewers`, refreshed every 15 seconds and gone 45 seconds after it stops, so a crashed instance's viewers fade; a join or a leave pokes every stream to read the list again. `PUT /whiteboards/{id}/presence` says the same for 45 seconds for a client without the stream.

**Converting.** A note becomes an issue in a project the person may report in: its first line the summary (cut at 255 characters, with every word kept in the description then), the rest the description; and its card becomes that issue's, in place, so its arrows stay. Several notes convert at once, each in a transaction of its own (the issue through `createIssueInTx`, the card and the whiteboard's log in the same one), so one that fails says why in its own words and the others still convert. An arrow whose two ends are issues, or became issues in the same request, becomes a link of the type picked, through `applyChanges`, which never makes a link twice. Nothing is made twice by a retry either: a converted note is an issue card, and is answered `already`. Each new issue's `issue.created`, and each link's `link.created`, carries `data.whiteboard`, so its history says which whiteboard it came from; to a reader of the issue who can't read the whiteboard's project, its name is left out (`eventFor`), and `whiteboard.converted` names only the issues in projects its reader reads. A dry run does each conversion the same way and rolls it back, so the preview, the dialog's and MCP's, is exactly what would happen.

**Undo, the keyboard and screen readers.** Each person's own undo and redo, for the page's session: moving, adding, removing, editing, sizing and connecting, each sent expecting what the person left (above). A removal holding a card its person can't see can't be undone by them, since they can't name what it held, and the page says so. Everything is done from the keyboard: Tab goes through the elements in the outline's order (the page hands each element's focus on: SVG paints in document order, which is the stacking order, not the reading order), Space chooses one and another with it, the arrow keys move what's chosen (Alt sizes it), Enter edits or opens a card's issue, Delete removes, N adds a note, C connects two elements in a dialog, and the toolbar does all of it too. The outline lists the whiteboard in reading order (sections and what lies in each, what lies in none, then the arrows), one order the server's MCP reading and the page share (`@a4a/shared/whiteboard`). Each element is named by an SVG `title`, so its name always holds what it shows. On a phone a finger pans, two pinch, and the outline sits under the canvas.

**Ocean.** Ocean had no canvas to draw on without inline style. Its new Whiteboard piece is SVG placed by attributes (`x`, `y`, `width`, `height`, `transform`, `viewBox`), words in a `foreignObject`, tones named by meaning, and a check that text reads on every tone's background.

**Every channel.** REST through `route()`: the whiteboards (list, get, make, rename, delete), their elements in batches, their cards, converting, presence and the stream. MCP and the assistant: `list_whiteboards`, `get_whiteboard` (as structured text, in reading order, a hidden card only "hidden"), `add_to_whiteboard` and `convert_whiteboard_notes` (changes, each with a preview; converting previews by a dry run). Deleting a whiteboard stays off MCP (D8). Guests read a guest-open project's whiteboards and their streams, never who's looking (D64).

**What it costs.**
- Every batch locks its whiteboard's row: one whiteboard's changes are one at a time, a few milliseconds each; two whiteboards never wait on each other.
- A whiteboard's elements are read whole for each batch (500 rows at most), and a whiteboard's log keeps 500 changes.
- Each open stream refreshes its row every 15 seconds and reads who's looking on each change of it.
- Last writer wins on places: two people dragging one note at once see it jump to the later one's place.
- A card's facts follow their issue by the shell's live events, which read every card of an open whiteboard again on any change to an issue or article (one query, under a second).

**Revisit when:** a team wants a whiteboard of its own between projects, or one person's scratch board (a person's board, shared with people and groups, would join the seam as a fifth kind of access); words should merge character by character rather than refuse (a CRDT per text); freehand drawing, pictures or connectors that bend are wanted; or whiteboards grow past 500 elements (draw only what's in view, and page the outline).

### D59. Writing and reading help: suggestions beside what they'd replace, read through the seam, capped per person

YouTrack 2026.2's AI assistance helps people write and read. a4a's does too, on the rules it holds every agent to: the person decides (D12), and only what they may see goes to the model (D37).

- **What people ask.** In every text field a4a gives (an issue's description, a comment, an article, a reply to a requester), in the visual editor and in Markdown alike (D39):
  - fix spelling and grammar;
  - rewrite it shorter, clearer, more formal or friendlier;
  - carry it on, or draft it from a line: an article from a prompt, a reply from the request's conversation.

  A toolbar shows for what's selected, and a menu in the editor's bar works on the whole text; a request's composer, set to reply, offers "Draft a reply" itself. Reading: an issue, an article or a selection summarised, and a clearer summary (title) suggested for an issue.
- **Nothing is written without the person.**
  - Each answer is a suggestion beside what it would replace, as a change in Ocean's grammar: an ApprovalCard with the `writes` stripe, its lines removed and added as an article's versions show them. Accept puts it in the field, which is saved as ever; Edit opens it to change first; Discard leaves the text as it was.
  - Accepting checks the text is still as it was asked about (the same Markdown, or the visual editor's same document). If it isn't, nothing is replaced, and the page says to ask again.
  - A suggested summary (title) is a value's change, struck through and dashed as triage's are, saved against the version it was read at.
  - A summary is shown, never saved, until the reader posts it as a comment.
  - Every suggestion carries the assistant's lagoon mark and its name, never a sparkle, and says it's a suggestion.
  - Once accepted, the words are the person's: they took them, perhaps changed them, and saved them, so the history reads as their change, as a word a spell-checker offered would.
- **A summary posted is the assistant's.** `POST /issues/{id}/summary/comment` takes the summary with the token it came with, signed with the instances' shared secret over the person, the issue and the summary's words, good for an hour. So the comment holds the assistant's words exactly, posted through the assistant's channel, and the history reads "assistant for Anna Schmidt · asked in words". Words someone changed are a comment of their own. A summary that read a comment limited to some people (D37) comes with no token: a comment everyone reads mustn't carry it, and the page says why instead of offering it.
- **Only what the person may see.** Every context is read through the seam, as the person:
  - an issue by `getIssue`, missing in the words of one that doesn't exist when it's kept from them; its comments by `listComments`, without those limited away from them; an article by `getArticle` (D51);
  - an issue's fields everyone sees, never a private one, even for someone who reads it, since what it says may be posted (D50);
  - not an issue's links: another reader may not see what's at their other end;
  - an id in someone's text stays as text, as D37 keeps it, and nothing it names is fetched; an id the model writes that the reader can't see is taken out (`redactUnseenIds`), as triage's words are;
  - a reply, from what its requester reads (the request and its public conversation, by name, without addresses) and never an internal comment, so nothing internal is put in the requester's words.

  The server's tests send hidden things at each: a comment limited to someone else, a private field, a members-only project's issue named in the description and linked, a limited article.
- **People's text is data.** Each prompt wraps what people wrote in tags, and says it's data whose instructions are never followed (D9). Before an edit goes to the model, code, links' addresses, raw HTML, mentions and issue and article ids are put aside as placeholders (`⟦n⟧`): they come back to the byte, and no text can close the tags around it. An answer that loses or repeats one is sent back once, saying which (as D14's answers by tool are), and then refused (`ai.writing.unkept`).
- **Language.** An edit keeps the text's own language. A draft follows its line's, and a reply its requester's. A summary is in the reader's: the page's, else their profile's, else the server's (D49), and `language` asks for another. The prompts name it in English, as they say everything else.
- **Effort and length for each action.** A fix and the plainer rewrites are `low`, with room to give the text back; making it clearer, carrying it on and drafting are `medium`; summaries and a title are `low` and short. Other services get the same requests by tool, without thinking (D14).
- **Not streamed.** A suggestion is accepted whole, beside what it replaces: half of one can't be compared or accepted. The checks run on the whole answer (every placeholder back, ids the reader can't see taken out) before any of it reaches the reader. And the answer is structured output, or a forced tool's input elsewhere, which comes whole. Answers are kept short, so most arrive in seconds; a long article draft is waited for, the page saying the assistant is working on it.
- **Caps.**
  - Each person may ask `AI_WRITING_MAX_PER_HOUR` times an hour (100): every action and summary, on the web, the API and MCP alike. They're counted in Postgres (`help_throttle`'s fixed windows, keyed by the person) in the statement that checks them, so instances count as one (D17) and asks sent at once can't slip past. Past it, 429 `ai_writing_limit` says how many minutes to wait.
  - What someone sends is capped for each action: 12,000 characters to fix or rewrite, 40,000 to summarise, 2,000 for a line to draft from. Past it, 400 `ai_text_too_long` says to select less.
  - What a4a reads itself is cut instead: an issue to its description and its latest comments within 60,000 characters (`partial`, which the page says), an article to its start, a text carried on to its last 12,000.
- **Without a provider** the pages offer none of it, and the API says `503 ai_disabled`, as D9's features do.
- **MCP: `summarize_issue`, and no writing tools.** An agent is a model: it writes its own words, and writing help would be one model asking another. A summary is different. `get_issue` gives an agent at most an issue's latest 50 comments, so a longer thread's early decisions are out of its reach; `summarize_issue` reads the whole thread as the agent's person sees it, through the same seam, and changes nothing. It counts against that person's hour, is listed only while the server has a provider, and tells agents to read `get_issue` when they need the facts themselves.

**What it costs.**
- A model call for each ask, at the server's expense. The cap bounds each person, not the server: a hundred people asking their hundred is ten thousand calls an hour.
- Placeholders cost an edit some sense of what they stand for (a mention reads as `⟦1⟧`, not a name), and an answer that loses one twice is refused rather than mended by hand.
- A summary built from what its reader sees can't be posted for everyone once it read a limited comment, so a manager's summary of such a thread is shown only.
- A summary of a long thread leaves out its oldest comments, and says so.
- Accepted words read as the person's in the history: once someone takes them, a4a doesn't mark which words the assistant drafted.
- A long draft is waited for whole.

**Revisit when:** people want to see which saved words the assistant drafted (keep the suggestion with the save, as `acceptedFrom` does for triage); drafts grow long enough to wait for (stream plain text, checking each finished line); requesters want writing help on their own pages (the portal, D45); or a team wants a cap of its own, or the server one for everyone.

### D60. Issues from chat messages: a form on the message, made as the person, its source kept beside it

People decide in Slack and Teams that something is an issue, and YouTrack's Slack app makes an issue draft of a message. a4a makes the issue itself, from the message, as whoever asks, through D42's bot, whose rules all hold: what Teams and Slack send is checked before anything in it is read; people act as their linked a4a account through the one write path; someone a4a doesn't know is told how to link, and nothing else; a channel is told only what every reader of the project may see (`chat/issues.ts`, `chat/markdown.ts`).

**What people do.**

- **In Slack,** a message shortcut, "Create an a4a issue" (callback ID `a4a_create_issue`), on any message. a4a answers at once, and opens a modal with the shortcut's trigger within Slack's three seconds: the projects the person may create in, and no other; a summary from the message's first line; the message as the description; and, for a message with replies, whether to add the replies after it. Sent, the modal is answered within Slack's three seconds too: closed once the issue is made, or with what was wrong under its field (`response_action: errors`).
- **In Teams,** the same as a message action: a messaging extension whose `context` is `message` (`createIssue`, in the app package's manifest, its words in the server's language since the whole tenant reads one manifest). `composeExtension/fetchTask` opens a dialog, Ocean's `teams/cards/a4a-new-issue.json` with words from the catalogs; `composeExtension/submitAction` makes the issue, answered in the dialog with the issue's card (nothing to act on there), or with the form again and what was wrong above it.
- **As them:** channel `chat`, "via Slack" or "via Teams" in the history, with their access and permissions. The project is checked again when the form is sent: one they may not create in, or can't see, is refused in the words of one that doesn't exist (`problem.issues.projectNotFound`), as the API refuses it. A project whose new issues need a field the form doesn't ask for refuses as it would anywhere, saying which, and the issue is made on the web.

**The message as Markdown.** Slack's mrkdwn (bold, italic, struck, code, quotes, links, and its `<…>` people, channels, groups and dates) and Teams' HTML (read by html-to-text's parser: tags as Markdown's marks, `<at>` as people) become a4a's Markdown, reading as the message did. Nothing in it runs or reaches out:

- no raw HTML: what looked like a tag is text (`\<script\>`);
- links only to http, https and mailto, the rest their words;
- scripts, styles, frames, objects, forms and handlers left out; pictures never fetched, their words (an emoji, an alt) kept;
- what would make Markdown of itself (`*`, `_`, `[`, `` ` ``, a dash or a number starting a line) escaped, so it reads as typed.

People are named as the chat names them (Slack's `users.info`), with a word joiner after the "@": a Slack "anna" isn't a4a's anna, so a4a mentions nobody, and nobody is told. The form holds 3,000 characters, Slack's most for a text input, and Teams' form the same: a longer message is cut there, at a line or a word, and the form says so under the field; the source keeps that it was cut.

**A thread's replies,** in Slack, when asked for: read with `conversations.replies` as the form is sent, the first 20 after the message, each quoted under its author's name below a rule. a4a writes no words of its own into the description, so it reads the same in every language; the source counts the replies. Teams gives a bot a channel's replies only through Microsoft Graph, with a permission each team's owner consents to (`ChannelMessage.Read.Group`), and a token and a host a4a doesn't hold, so Teams' dialog takes the message alone.

**Files are linked, not brought.** The message's first ten files are listed with the source, as links where the chat keeps them: Slack's permalink, SharePoint's address, https on the chat's own hosts, or no link at all; more are counted. Why:

- a file in a private channel, copied into a project, reaches everyone who reads the project, a wider audience than the channel's; the person sees and edits the text they bring, and doesn't see the files go;
- Teams' files are SharePoint's and its pictures Graph's, neither of which a4a's bot can read;
- a download takes longer than Slack's three seconds, so it would be a second change to the issue after it's made.

Linked, a file stays under the chat's own access. Bringing one is a drop on the issue's page, through the upload checks (D18, D35).

**Where it came from** is kept as data, in `chat_issue_sources`, not in the description, so each reader's page says it in their language (D49): the chat, the workspace or team and the channel as they were named then, a link to the message (Slack's `chat.getPermalink`; Teams' `linkToMessage`, kept only on Teams' hosts), who sent it and when, its files, its replies, and whether it was cut. It's read with the issue (`issueDetail`), so it shows exactly where the issue does: `GET /issues/{id}` (`source`), MCP's `get_issue` (`source`) and the assistant, and the issue's page, in a side card: "From a Slack message in #eng". To someone the issue is limited away from, or in a project they can't see, it's missing with the issue.

**Events.** `issue.created` from a message carries `data.chat`: the chat, the workspace, the channel, the link, the author and when, and nothing of the message beyond what the issue holds, for webhooks and rules.

**Its author watches it,** when they're linked to an a4a account, or known by their Entra sign-in, that may see the issue (`whoSees`), with the reason `message`. The message is their report in all but name: watching tells them what becomes of it, through the notifications they've already chosen, and they stop it like any watching. They aren't told it was made, since being made a watcher isn't news. An agent's account or a banned one never watches.

**Back in the chat.**

- The person is told it's done, with the issue's id and link, where only they see it: Slack's ephemeral message; in Teams, the dialog's answer.
- A link in the message's thread, for everyone, as a channel's post is: the issue's card, "Anna Schmidt made an issue of this message", in the server's language, with only what every reader of the project may see. It's posted only when the issue isn't limited to some people, and its maker may vouch for the channel's people for its project, as subscribing the channel would ask of them, and as unfurling a link does (`whyNotFor`): a project open to everyone, which they read; one open to its members alone, which they manage. Otherwise nothing is posted in the channel, ever, and only they are told.

**A form makes one issue.** Opening a form writes its source as a draft, naming who opened it (their a4a account and their chat id), for an hour. Slack's `private_metadata` and the Teams card's data carry only its id; what's sent is checked against it, never trusted, and only its opener may send it. The issue claims the draft in the transaction that makes it, so a form sent twice, at once or after (an impatient Slack, a double click in Teams), makes one issue, and the second sending is told "BACK-12 was created from this message already".

**Refused,** each in the person's language, as a modal, under a field, or in the dialog:

- someone a4a doesn't know: the sign-in link, as D42 sends it (Slack: in a modal, which only they see; Teams: their personal chat, and the dialog says so);
- a project they may not create in, or can't see: not offered, and missing if sent anyway;
- a message too long: cut, saying so;
- a channel a4a isn't in (Slack's `conversations.info`, or a private channel's `channel_not_found`; in Teams, a team a4a isn't in): it couldn't read the message again, its thread, or answer there, so it says to invite it. A direct message, or a group chat: only channels' messages, where someone vouches for who reads the answer;
- a deleted message: Slack's tombstone, or a message gone from its thread when the form is sent; Teams' `deleted`;
- too many issues too fast: `CHAT_ISSUE_LIMIT` (10) from chat per person in ten minutes, counted from the sources, so across Slack, Teams and every instance, and counted again under an advisory lock of theirs in the transaction that makes one, so two forms sent at once can't both pass;
- a request replayed: a signed Slack request is taken once (its signature's hash, kept for its five minutes); a Teams activity once (its id, kept for its token's hour). Bot Framework's token doesn't sign the activity, so its id is what a4a can hold it to. A replay is refused as a forgery is, 401 with no words: nobody it came from reads them.

**What it costs.**

- Opening a form: three calls to Slack side by side, within its three seconds (the channel, the permalink, people's names), and a draft row. Sending one: one call for the thread, and names for its replies, then one transaction.
- Reading an issue in full (`GET /issues/{id}`, `get_issue`, the page) looks its source up too: one more query, by the issue's id.
- A row per form opened, pruned once an hour after it expires unsent; a row per Slack request and Teams activity, pruned once an hour after its window. The chat's prune runs hourly now, not daily.
- The thread, and the files, are as the chat holds them when the form is sent: an edit after isn't followed.
- Slack's modal lists 100 projects, by name: someone who may create in more sees the first 100. Teams' list filters as they type.
- Slack's app needs three more scopes (`channels:history`, `groups:history` for the thread, `users:read` for names) and the shortcut; Teams' app package is uploaded again for the message action.

**Revisit when:** Teams' replies are wanted (Graph, with the team's consent); people want files brought (downloaded after the issue is made, through the upload checks, as a change of its own); someone needs more than Slack's 100 projects (an external select, Slack's `block_suggestion`); or a project's required fields should be asked for, which wants the form to grow per project, or a draft opened on the web.

### D61. Importing from Asana and ClickUp: tasks as issues, a section or a status as the state, followers as watchers

Two more importers beside YouTrack's and Jira's (D29) and GitHub's, Redmine's and Zendesk's (D46), through their path, so everything D29 promises holds: a dry run first; people matched by email; the other tracker's ids remembered, so a run again makes nothing twice; files brought as the run goes, under the upload's checks and caps; quiet events (`data.imported`); a fetch that's a job and carries on from its last page; 429 and 5xx waited out; the token used and never kept; the address guard; and what the token can't see left out (`imports/readers-tasks.ts`).

- **Asana** (REST API 1.0, a personal access token): a project, by its address or its id. Its tasks come page by page by `offset`, each task's subtasks below it (five levels), with its comments (stories of type comment, who and when) and its files.
  - **The state.** A task's section is the column its board shows it in, so it fills the State column by name ("To do", "In progress"). A completed task says "Completed" there instead, which the mapping finds as Done, and it's resolved when it was completed. The section keeps a column of its own, for a project whose sections are areas rather than steps: mapping that to State instead is one choice.
  - **People** by email where Asana gives it; someone it gives a name alone for is matched by name, or left empty. They are the assignee, the creator as reporter, followers as watchers, and a people field's people.
  - **Custom fields** by their names: options and multiple options by name, numbers, text, dates, people. One named as a column of the reader's own keeps "(field)" after its name.
  - **Links:** a subtask is a subtask of its parent, and a dependency is "depends on".
  - **Rich text** (`html_notes`, `html_text`, a small XML dialect) becomes Markdown (`imports/markup.ts`): headings, emphasis, lists, quotes, code, tables and links. A mention keeps its words, since its link is Asana's alone.
  - **Files** kept in Asana come; one it links to elsewhere (Google Drive, Dropbox) stays there. A file's download address lasts minutes, so the run asks Asana for it again as each file comes (`Remote.setLocate`), and downloads it without the token: it's on another origin.
- **ClickUp** (API v2, a personal token, which is the header itself, or an OAuth token): a List, by its address or its id. Its tasks come page by page, oldest first, subtasks and closed ones included, with their comments (Quill's blocks, as Markdown), their time tracked and their files.
  - **The state** is its status, keeping its name ("in progress", "complete"), found as a4a's by name or synonym; a closed one is resolved when it was done. Priorities urgent, high, normal and low are found as Show-stopper, Critical, Normal and Minor.
  - **People** by email. The first assignee is the assignee, since a4a's Assignee is one person; the others watch it, with its watchers.
  - **Time:** the estimate; and each interval tracked as a work item, as Jira's worklogs come, so its total doesn't come too.
  - **Links:** waiting on a task "depends on" it, blocking one "is required for" it, and a linked task "relates to" it.
  - **Checklists come as Markdown checklists in the description**, each under its name, items ticked and nested as they were. a4a has no checklist of its own, and a description's checklist is ticked in place on the issue (D39), so they stay what they were: the steps of one task. As subtasks they'd be issues, each with a state, an assignee and a history nobody gave them. Who an item was assigned to doesn't come, and a run again that finds a checklist changed there writes the description again, as any field changed there is.
  - **A field ClickUp hides from guests** comes as a column marked "(hidden from guests)", which no field takes until someone maps it: here it would reach everyone who sees the project, unless it's mapped to a private field (D50).
- **Watchers, a target every import has now.** A column named Watchers or Followers maps to the issue's watchers, people matched by email, login or name, and each is made to watch it quietly, as its reporter and assignee are. A run again adds whoever watches it there since, and makes nobody stop: that's theirs to choose.
- **Keys.** A task is known by its id there (Asana's gid, ClickUp's task id), which its subtasks and links name it by.
- **Carrying on.** Each page commits with the place after it, as D29's do. Asana's offset may have expired by the time someone gives the token again, so a page it refuses then reads from the first; ClickUp's page number steps one back. Either way the reader is told the keys kept (`Reader.skip`), so it doesn't read their comments, time, files or subtasks again.
- **What the token can't see** stays out. A project or List it can't open answers in the same words as one that isn't there. A subtask it can't read is left out and counted with the issues only some may see; a dependency or link to a task it can't read is left out and counted as a link to a key not in the import.
- **Rate limits.** Asana's 429 says Retry-After. ClickUp's says when its minute resets (`X-RateLimit-Reset`), which a 429 without Retry-After is now waited out until.

**What it costs.** A task takes one to three requests more: Asana's stories, files and subtasks; ClickUp's comments (25 at a time), its time and, when files come, the task itself, since a List's pages don't carry them. ClickUp allows 100 requests a minute on most plans, so a List of a thousand tasks takes most of half an hour to read, waiting as it's told. Left out: Asana's time tracking, likes and approvals' outcomes (an approval comes as a task of type Approval); ClickUp's comment threads, reactions and docs.

**Revisit when:** someone wants Asana's time tracking (its entries, a request per task), ClickUp's comment threads, or a project kept in step rather than imported (D29's revisit).

### D62. Passkeys: both factors at once, beside a4a's own password, and every change told to its person

People sign in with a passkey (WebAuthn) from the sign-in page, without a login, a password or a code, or use one in place of the code after a password. Through `@simplewebauthn/server` and `@simplewebauthn/browser` (pinned exactly), not CBOR and COSE of a4a's own, for the reason D16 chose openid-client: the specification's checks, in its order, by people who do nothing else.

- **The relying party is PUBLIC_URL.** Its host is the id and its origin the only one taken: the client data's origin and type, and the authenticator's hash of the id, are checked on every answer, and a request that says it comes from another site is refused before anything. Browsers make passkeys only for a domain in a secure context, so they're on where PUBLIC_URL is https, or http on localhost; at an IP address, or on plain http elsewhere, they're off and the profile says why.
- **A passkey is both factors.** Every ceremony requires user verification (a fingerprint, a face, a PIN), and an answer whose authenticator didn't verify its person is refused with what to do. So a passkey signs in alone, even where two-factor is asked of everyone; after a password it's the second step in place of the code (`{ "step": "two_factor", "passkey": true }`); and where two-factor is required, someone with a passkey and no app isn't made to set one up.
- **Discoverable credentials.** The sign-in page names nobody: the browser offers the passkeys it holds for a4a in the login field's autofill, where it can (conditional mediation, asked again every four minutes so its challenge never runs out under it), and from a button.
- **Challenges** are 32 random bytes made by the server, kept as a SHA-256 for five minutes, and taken once (`DELETE … RETURNING`) whatever happens after: by the ceremony they were made for (adding, signing in, the second step, confirming), for the person they were made for, from the browser that asked: its session; at the second step, the password's ticket (`a4a_2fa`, D38); or, signing in from the sign-in page, a ticket cookie of its own (`a4a_pk`: HttpOnly, SameSite Strict, sent only to `/api/v1/auth/passkey`). A page elsewhere can't post an answer for this browser, so a passkey can't sign someone into another's account (login CSRF).
- **What's kept:** the credential's id (unique: a credential is one person's), its public key, its sign count, transports, whether it may sync and whether it is, its AAGUID, a name, the relying party id it was made for, and when it was added and last used. **Attestation is `none`:** a4a takes whatever authenticator its person chooses, so asking the maker to vouch would cost people's privacy and a store of certificates, for a check a4a has no use for. The AAGUID is a hint for a name ("iCloud Keychain", "Windows Hello"), never trusted; without one a4a knows, the passkey is named after the browser that made it, and its person renames it.
- **The sign count** is checked by a4a, not the library, so a4a knows what it saw: a count that goes back (or stands still, on an authenticator that counts) means two authenticators hold the key. a4a can't tell which is its person's, so the passkey signs nobody in again (`copied_at`), the sessions it signed in end, and its person is mailed; it stays listed, marked, until they remove it. The count moves on in one conditional update, so two sign-ins with one count can't both pass, and one beaten to a higher count is refused without marking anything. Synced passkeys count nothing (always 0): for them, the challenge taken once is what stops a replay.
- **Who has them.** People a4a's own password signs in. Single sign-on and directory accounts sign in where their provider checks them (D16, D27, D38); a passkey kept by a4a would let them in without the provider, even after it had turned them away, so they have none, and the profile says why. For the same reason passkeys are off while a4a's own passwords are (`PASSWORD_LOGIN=false`).
- **Adding or removing one takes a recent sign-in**: one in the last ten minutes, or proving it's you again (`POST /me/confirm`: the password, with a code where two-factor is on; or `POST /me/confirm/passkey`: one of your passkeys). So a session left open on a shared computer, or a stolen cookie, can't add a key of its own that outlives the session, or take away the person's. Renaming takes nothing. A signed-in browser only: a token can't change how anyone signs in, as with two-factor (D38).
- **Removing one** ends the sessions it signed in, but not the one that removes it. Each session now says how it was signed in (`sessions.signed_in_with`: `password` or `ldap`, with `+totp`, `+recovery` or `+passkey` after a second step; `oidc`; `saml`; or `passkey`), and with which passkey; and each person's last sign-in is kept, whichever way, and shown to administrators.
- **Told of changes.** An addition, a removal or a copy is mailed to its person in their language, with a "This wasn't me" link ("Sign out everywhere" for a copy): a token minted as the mail is sent (D33's way), kept as a hash, good once, for two weeks. Its page asks first, since scanners open links; then every session of theirs ends, and a passkey the mail told of goes: one added, with any added after it, or one copied. It takes access away and never gives it, so the mail is enough: no sign-in, which whoever had the account may have changed. An administrator's removal is mailed too, saying an administrator did it, without the link.
- **Losing one.** The password, and two-factor where it's on, still sign in. An administrator removes someone's passkeys (all of them, with the sessions they signed in), as they reset two-factor. An account whose only way in was a passkey, its person having forgotten the password, has the recovery any forgotten password has: an administrator sets a new one. No email link restores access: it would make a mailbox a way in past both factors.
- **Administrators** turn passkeys off for the instance (they're kept, and sign nobody in until they're on again) and see who has them, and how many, beside two-factor. Nothing more: two-factor required already counts a passkey, and requiring passkeys alone would lock out whoever's device can't make one.
- **Rate limits** as passwords': each try counts in the sign-in throttle, per address and per passkey (per person at the second step and when confirming), before it's checked. Making challenges, which are rows, is held to 30 a minute per address on each instance.
- **Every channel:** REST through `route()`, in OpenAPI under Passkeys; no MCP tools, since signing in is a browser's; the sign-in page, its second step, the profile, the people table and the instance's settings. They're account changes, not projects': no events, as two-factor's (D38).

**What it costs.**
- Passkeys are bound to the relying party's id. When an instance moves to another address, its passkeys stop working: browsers don't offer them there, and an answer for the old host fails its check. People sign in with their password and add new ones; the old ones stay listed, marked with the address they were made for, until removed.
- An instance on plain http, other than localhost, or at an IP address, has no passkeys.
- A copied passkey stops for both holders, its person included: they add a new one.
- Sessions from before this say nothing of how they were signed in, so they're never recent: one adds or removes a passkey only once its person confirms it's them.

**Revisit when:** an instance must move without losing its passkeys (an id that is a parent domain, or WebAuthn's related origins at `/.well-known/webauthn`); an organisation wants passkeys required, or only some authenticators (attestation, and FIDO's metadata service); people want an account with passkeys and no password; or the help desk portal's requesters sign in (D45). (Requesters' own sign-in came, by a password or a provider, without passkeys: D63. An id chosen ahead of a move and related origins, passkeys required and only some authenticators, and accounts with passkeys and no password came: D68. Their passkeys came, at the desks that take them, made with the requester's mailbox: D69.)

### D63. The portal's own sign-in: a password or the customer's identity provider, beside the emailed link, as each desk chooses

D45 signed requesters in to the portal with a link sent to their email, and named passwords and single sign-on as what came next. A desk now chooses how its requesters sign in: the emailed link (the default, and every desk's until it says otherwise), a password, identity providers for requesters, or several (`settings.helpdesk.signIn`: `link`, `password` and `providers`, one way at least).

- **A session remembers how it was opened** (`requester_sessions.method`, with its provider) **and opens only the desks that take that way.** A requester is one person at every desk (D24), so their portal spans desks: a password session doesn't open a desk that takes only links, nor a provider's session a desk that doesn't offer it. `portalSessionOpens`, in the access seam beside `requesterSees`, decides before any request is read, and the SQL that finds them asks only those desks. What a session doesn't open is missing, in the words of a request that doesn't exist. The choice is read at each request, so a desk that stops taking a way closes it at once, to sessions already open too. `GET /portal/me` names the desks with requests of theirs that this session doesn't open, and how each signs them in (`elsewhere`); the page offers to sign in there.
- **A password** is set by a link sent to their email (`hdp_`, kept as a hash, good once for twenty minutes), asked for on the sign-in page or the account page; the same link resets a forgotten one. It's scrypt, as members' passwords are, but kept on the requester, checked by a route of its own, and it opens the portal's cookie alone: a member's password never opens the portal, nor a requester's the team's side, whatever email either has. Setting one ends every session the requester had and voids their other links to set one, since a reset says the old one may be known; the requester's row is locked meanwhile, so two links used at once can't both win. Changing it on the portal takes the current one, and ends their other sessions. Sign-ins are counted as members' are, in the shared throttle, per address and per email (under a key no login can have), before the password is checked: ten wrong for one email, or fifty from one address, in a quarter of an hour lock it until that window ends, the right password included. An unknown email, or one with no password, takes as long to refuse as a wrong password. Where a desk that takes passwords asks its form for the proof of work (D30), password sign-ins solve one too, a challenge bound to no desk's form; while one such desk asks, every password sign-in does, since a session opens every desk that takes passwords.
- **Identity providers for requesters** speak OpenID Connect, through openid-client as the team's provider does (D16): PKCE, a state bound to the browser by a cookie and taken once, a nonce, and the ID token's signature checked against the provider's keys. They're kept in the database (`portal_providers`), the client secret sealed with the server's key, and one redirect URI serves them all (`/api/v1/portal/sso/callback`), the state saying which provider it was. A requester is known by the email the provider verified (`email_verified`, or Entra's `xms_edov`, a real `true`), and only within the provider's domains when it names some. Its sessions open the portal alone; whom it signed in is kept apart from the team's identities (`requester_identities`), to tell the requester the first time.
- **One provider serves several desks, and administrators keep them.** A provider vouches for who someone is, and a requester is one address at every desk: what it says is true at every desk or at none, so trusting it is the instance's call, as trusting the team's provider is. A desk's manager who could add one could have it vouch for any address, and read that address's requests at every desk that offers it, or post as anyone at their own. a4a also reaches the provider's host (discovery, tokens, keys), which D45 left to administrators to name, as it did a desk's mailbox. So an administrator adds a provider (its discovery must answer first) and limits the domains it may vouch for, and any desk's managers offer it; a customer that several desks serve signs in through one registration at its provider. A provider can't be removed while a desk offers it or a group signs in through it.
- **A customer group tied to a provider** (D56): its people, by its domains or added by hand, see that desk's requests through that provider and no other way, their own included. For a customer with an identity provider of its own, someone it disables loses the portal with it, though their mailbox, or a password they set, lives on. The provider must be one the desk offers, and the desk can't take it off while a group is tied to it.
- **What stays.** Tracking links (D24), replies by email (D30) and CCs (D57) work as they did: a tracking link is the request's own, whatever the desk takes. Someone copied reads the request on the portal by signing in as the desk takes, by the address copied; where it takes only a provider that doesn't know them, they answer by email. The team invites a requester the way the desk takes them: a sign-in link, else a link to set a password; through a provider alone there's nothing to send, and the invitation says so.
- **Emails**, the link to set a password and the word that a password was set or changed or that a provider signed them in for the first time, are in the help desk's language, as its other emails to a requester are (D49: a requester has no profile, so the desk's are the server's).
- **Every channel.** REST: `GET /portal/sign-in-methods`, `POST /portal/password/sign-in`, `/link` and `/set`, `PUT /portal/me/password`, `GET /portal/sso/{id}/start` and its callback, and `/portal-providers`; a desk's choice is `settings.helpdesk.signIn`, a group's provider its `provider`. The web: the portal's sign-in page offers what the desk takes, its account page sets or changes a password, and the desk's page chooses its ways and, for administrators, keeps the providers. **No MCP tool.** No desk setting is a tool: MCP is for work on issues (D8). Sign-in is security configuration, where a mistake locks requesters out or opens a desk's requests to a weaker way, and an agent reads untrusted text: a person chooses, on a page that says what each way means, or a script with an administrator's token does.
- **Events.** A desk's choice is in its history, `project.portal_sign_in.changed` (from and to, providers by name), as `project.visibility.changed` is: it decides who reaches its requests. A requester's account records none, as people's accounts don't (D38): passwords, sessions and providers' sign-ins are told to the requester, by email.

**What it costs.**

- Each read on the portal reads the requester's groups and the desks' choices first: a query more.
- A requester whose desks take different ways signs in to each in turn, one session at a time.
- A desk that takes passwords still lets in anyone who holds the requester's mailbox, by a reset: a password is a convenience, not a second factor. A provider is what keeps a departed employee out.
- Once one desk that takes passwords asks for the proof of work, every password sign-in solves one.
- No SAML for requesters. D27's SAML is one provider from the environment, and its cache and checks are written for it; a provider per customer in the database would need an assertion consumer and metadata of its own per provider.
- A group tied to a provider while its desk takes that provider off, at the same moment, can leave the group tied to a provider the desk no longer offers: its people then open nothing at the desk until one of them changes. It fails closed.

**Revisit when:** a customer's provider speaks only SAML; a desk should add a provider of its own, limited to its customers' domains; requesters want the desk's emails in their own language; one session should hold several ways in; or a password should take a second factor (passkeys, beside D38's codes). (Passkeys came, in place of the link or the password rather than after it, since requesters have no codes: D69.)

### D64. Guests beyond issues: boards, reports, plans and whiteboards, without the team's money or its people

D37 let an administrator open a project to anyone: a guest, sending no credentials, read its issues, comments, files and articles, and nothing else. Now a guest reads its boards, its reports, its plan and its whiteboards too, through the same seam, so a project run in the open shows its work the way its team sees it, less what is the team's own.

- **The same seam, the same answers.** A guest's access is D37's: the read permission in the projects open to guests, the read scope alone, the guest rate limit per address. The reading routes of the four surfaces now answer a request without credentials (`guestMayRequest`), and each reads through `projectAccess`, `issueSeenSql` and `seenIssueIds`, `scopeFields` and `articleSeenSql` as it does for anyone. So what a guest may not see answers as if it didn't exist: a board, a whiteboard or a plan of another project is 404 in the words of a missing one, a report naming one is the error for a project that doesn't exist, a limited issue or article is no card and no count, and a private field (D50) is in no lane, column, point or report. Every write is refused (401, "Sign in to do that"), as before, since a guest holds no write scope.
- **Boards** show their columns and the cards a guest may see, in the board's order, and nothing else: no backlog, velocity or sprint plan, no ranking, moving or sprint changes. A board across several projects shows only the guest-open ones' cards, names only them, and counts only them. Its queries are its managers' words, and could name a project or a value a guest can't see: to anyone who doesn't see every project on a board (a guest, or a person who sees some of them), a query is shown only when it names nothing they can't see, by the rule shared saved searches and dashboards follow, and otherwise left out (null). A board whose query names something they can't see shows them no cards and says only that, in words that don't repeat the query (`boards.queryNamesUnseen`); the query's own refusal would have named what's hidden.
- **Reports** are all of D21's and D44's but the time report, which is people's logged work and takes the costs permission: each counts only the issues a guest sees, over the projects open to them or the one named, and comes as CSV too.
- **Plans: the dates are the team's, the money and the people aren't.**
  - A guest reads the schedule (the Gantt and its timeline): its tasks, the dates, the critical path, slack and what's late.
  - **Money takes the costs permission**, wherever a plan shows it: a task's planned and actual cost, a baseline's and a variance's cost, and the plan's budget, on the schedule and on the project, are null without it; a project's managers see the budget they keep, since a plan's settings saved without it would save it as none. A guest never has it. Neither does a custom role without it: costs now gate a plan's money as they gate the cost report (D37), and the check asks for the permission, never for a guest.
  - **Days away are people's**, and a guest reaches no people (D37: who reacted, never who): the schedule lists nobody's days away for a guest, and leaves out the warning that says someone's window falls while they're away. People's loads (the load grid, a sprint's plan) stay closed.
  - **Baselines are the team's record of what it planned and what it would cost**: the plan of record, named and noted by its managers for the team, and its variance the team's measure of itself. On a public page it would read as a promise to the public that nobody made, and it carries cost. So a guest reads the plan as it stands; a baseline asked for answers as a missing one, whichever id is given, and the baselines, the cost report, the load, the what-if and levelling stay closed.
  - The rest a guest sees on the issues already: who an issue is assigned to, its estimate, its total time spent (D37 keeps that ungated).
  - What it costs: a guest's dates are worked out on everyone's own days, as the team's are, since a plan whose dates differ by reader would mislead whoever compares them. So a bar that stretches over a week tells a guest its assignee has fewer days then, though never which, nor why.
- **Whiteboards**, read only. Cards as each guest may see them: one they may not is `shown: false`, a dashed card that says only that it's hidden (D58). A guest gets the live stream, and not who's looking.
  - The stream, because a whiteboard is read as its team works on it; without it a guest reads it again and again under the rate limit, or sees it stale. It carries each change as a person's does, with who made it, as an issue's history names who changed it.
  - Not presence: who has a whiteboard open is what people are doing now, which is the team's to know, not anyone's who passes; and a guest, nobody in particular, is no one to show the team either. So a guest is told nobody's looking, isn't counted among the lookers, and `GET`/`PUT /whiteboards/{id}/presence` are refused.
  - A stream is one request however long it stays open, so the rate limit alone would let one address hold hundreds, each read again on every change. A guest holds four open streams per address, and guests together four hundred, on each instance; past either, 429 says to close one or sign in. The team's streams never run out for it.
  - A card's facts follow their issue on the team's pages through the shell's live events, which guests don't get: a guest's cards are as fresh as the page.
- **OpenAPI says which routes answer a guest**: their security lists an empty requirement beside the token and the cookie, and their description says so. A test holds that list and `guestMayRequest` to the same routes, D37's included, so neither drifts.
- **The web**: the guest home's project lists its plan, its reports, its boards and its whiteboards, and each opens on a guest's page (`/public/boards/{id}`, `/public/reports/{kind}`, `/public/plan/{key}`, `/public/whiteboards/{id}`), on the lone page as wide as the window. The pages are the team's own views, drawn read-only: a board with no dragging and no commands (`ReadOnlyBoard`), the Reports page's charts, the timeline's facts and Gantt, and the whiteboard page in a guest's mode. Where their links lead comes from one place (`app/places.tsx`), so a card, a bar or a count opens a guest's own page, or nothing where a guest has none (an article, a report's list of issues), and never a page that asks them to sign in.
- **MCP** needs a sign-in, so it's unchanged; chat and email are the team's.

**What it costs.**
- Listing boards, or reading one, compiles its queries again for anyone who doesn't see every project on it.
- A custom role without the costs permission now reads a plan without its money, as a guest does.
- A guest's plan can hint at an assignee's fewer days by a bar's length (above).
- A guest's whiteboard cards don't follow their issues live, and four whiteboards at a time are live from one address.

**Revisit when:** guests should read articles on a page of their own (cards and counts would open them), or a count's issues in a list; a project should open only some of its boards or whiteboards to guests, rather than all; or guests should be counted, anonymously, among a whiteboard's lookers.

### D65. Boards at scale, lanes of their own, and a card's place in its history

D53 left three things for later: ranks for boards of tens of thousands, a lane's own order, and a card's place in its issue's history. They're here.

- **A rank is a key, and a move reads only its neighbours.** A card's place on a board is a string (`board_ranks.key`), a fractional index in base 62 whose order is its bytes' order. The column is `COLLATE "C"`, so Postgres compares keys as JavaScript's `<` does, whatever the database's own collation. A key can always be made between two others: `keyBetween` in `packages/shared/src/ranks.ts`, David Greenspan's scheme written from his description rather than taken as a dependency, since it's sixty lines and the server, the migration and the page share it.
  - A move reads its anchor's key and the next one on the side it goes (the first, for the top), through the index on (board, key), and writes one row. Nothing is spaced out again. Counted on a board of two thousand ranks, a move sends three statements that touch them: the anchor's key, the next, and the write; on 50,000, the plan reads the next through the index.
  - Placed next to a card without a place, D43's rule holds: that card, and those shown above it without one, take keys after the last placed one, in the order shown. That still reads what the board showed, one search, the first time only.
  - **Two moves at once both land, under the board's lock.** Each move still locks the board's row (`FOR NO KEY UPDATE`), as D53 has it. A tie-break in the keys was the other way, but two moves just after one card read the same neighbours, and a suffix that puts the later first needs a clock every instance agrees on. The lock costs little now that a move holds it for two index reads and a write, and rewriting a board's keys (below) needs it anyway. The test on Postgres makes two moves meet: the first holds the board while it waits for its row, which the test holds, and the second comes in meanwhile. Without the lock it fails, two keys tying; with it, both land just after the card, the later first.
  - **Keys are bounded.** Appending at either end steps a key's integer part, so keys there stay short: four characters for a quarter of a million cards. Placing between two keys halves the gap, about a character every six moves at one spot, which alone has no end. So a key longer than 64 characters is never written: the move first writes its board's keys afresh, in their order, as `a0`, `a1` … (`keyAt`), in one statement under the lock it holds, and places the card among them. Placing at one spot over and over, that's every 310 to 370 moves.
  - **The migration** (0044) turns every board's doubles into keys in the same order, ties by issue as a move read them, in one statement: a board's nth key is `keyAt(n)`, worked out by the database. `rankKeySql` says the same on the server, for a rewrite, and the tests hold the shared function, the server's SQL and the migration's to one answer. On a board of 50,000 ranks it took about 1 s on PGlite (0.93 to 0.99 s; 1.8 and 6.3 s while the whole suite ran beside other work) and 0.75 to 0.94 s on Postgres 16, here.
  - **Every reader reads keys:** the board's cards and its `order`, the backlog, sprint planning, guests' boards (D64), and a move. Nothing imports or exports a rank: an import from Jira leaves its rank field out as noise, and no export holds one.
- **A lane's own order.** A board can say its lanes keep their own order (`laneOrder`, off by default, so D53's one order stays what boards have). Its managers turn it on and off on the board itself, or with `PATCH /boards/{id}`; everyone else is told it's on.
  - With it on, a card has a place in its lane (`board_lane_ranks`: one per card per board, with the lane it was put in, a person by their id or a value by its name, or none). Alt and Up or Down moves it among its lane's cards; dragged within its lane, or into another at a place, it goes where it was dropped in that lane's order; the rank endpoint and MCP's `rank_issue` do the same for a move with `column`. A lane's places are kept as the board's are: the same arithmetic, the same lock, the same bound, a lane rewritten on its own.
  - The backlog has no lanes and keeps the board's own order, and so does a move without `column`. A lane's moves never change the board's order.
  - **A card new to a lane**, reassigned on its issue or by a rule, has no place there: it comes after the lane's placed cards, in the board's order, as an unranked issue comes after the ranked ones (D43). It isn't given one: a change made away from the board writes nothing to the board, and a place would rank it where nobody chose. Placed next to it, D43's rule gives it, and those without one above it, places in the order shown, so nothing jumps.
  - **Turning it on** changes nothing on screen: with no places yet, every lane shows the board's order. **Turning it off** shows the board's order again and keeps the lanes' places, unread, so turning it on brings each lane back as it was left; moves made meanwhile were the board's. Choosing another lane field forgets them in the same change: they were places in lanes the board no longer has.
  - A card has one place in a lane at a time: moved into another lane, its place in the old one goes with it.
  - Someone who can't see the lane field (D50) sees no lanes, and ranks in the board's order.
- **A card's place in its issue's history.** D53 kept `board.issue_ranked` out of an issue's history, since the place is the board's. It's there now, without the drags.
  - A move folds into the issue's latest line when that line is the same person's, through the same channel, on the same board, begun less than ten minutes before, and nothing else has happened to the issue since. Otherwise it starts a line. So rearranging a board is a line per card moved, and a line's time is within ten minutes of each move it holds: ten minutes from the line's first move rather than its last, so someone dragging on and off all afternoon gets a line every ten minutes, not one for the afternoon.
  - Each line (`board_moves`) keeps its last place as a kept note (D49): `boards.history.moved`, with where it went (`above`, `below`, `top`), the anchor's id and the board's name as they were. The page says it in the reader's language: "Theo Ruiz moved it above BACK-31 on Platform board".
  - It names the anchor and the board only to a reader who sees them now, through the seam (`seenIssueIds`, and a board's projects): an anchor limited away from them, or deleted, makes it "changed its place on Platform board"; a board they don't see any more, its projects changed, or one deleted, makes it "on a board", and the line then carries no board at all. Never "missing".
  - `GET /issues/{id}/activity` gives each line as its run's last `board.issue_ranked`, with `moves`, `firstAt`, `said` and `note`. The ledger (`GET /events`, MCP's `get_activity`) and webhooks are as they were: every move is an event.
  - Moves made before D65 have no line: their events kept no anchor to say.

**What it costs.**
- Moves on one board are still one at a time, now two index reads and a write each. A key that would pass 64 characters rewrites its board's (or lane's) keys, every row in one statement under the lock: on a board of 50,000, about as long as the migration's statement. Placing at one spot over and over does that every 310 to 370 moves.
- Keys take more room than doubles: a few bytes as a rule, 64 at most.
- A lane's order beside the board's is a second order to explain: the board page says when lanes keep their own, and the backlog shows the board's.
- The first placement next to a card without a place in a lane reads the board's cards with their fields, to know each card's lane.
- A history line is a row per run of moves, read beside the issue's events.
- The migration is edited by hand around what drizzle-kit generates: a column added `NOT NULL` to a table with rows fails, and the doubles must be read before they're dropped. Generating the migrations again keeps those statements only by hand.
- It's the first migration to drop a column: a version from before D65 fails to show or move a board's cards on a database past it, so an upgrade stops the older version first ([Upgrades](deploying.md#upgrades)).

**Revisit when:** one spot on a big board is placed at in bursts, so its rewrites show (then rewrite only the keys around the spot); a card's place in a lane should follow it to another lane and back; or people want every drag in an issue's history.

### D66. A GitHub App across its installations, check runs on pull requests, and Forgejo's tokens narrowed

D54 made a GitHub integration read as a GitHub App, through one installation, and connected people's Forgejo and Gitea accounts with a token used once. It left three things: an app installed on several accounts reads only one account's repositories; a4a tells GitHub nothing back; and a Forgejo that takes no scopes hands a4a a token that reaches everything its person can.

**Each repository through its own installation.** An app has one webhook, so every account it's installed on sends to one integration. Now a read for a repository (a build's compare, a CI's range) asks GitHub, as the app, for that repository's installation (`GET /repos/{repository}/installation`) and reads with that installation's token.

- **Kept in memory, as D54's tokens are.** Where a repository is installed, for an hour. Each installation's token, per purpose (reading contents, or writing checks), until five minutes before its hour is out; reads at once share one exchange, and a request refused with 401 takes a new token, once. An installation GitHub says is gone is looked up again, once, since the app may have been installed again; one it says is suspended answers as D54's do, for that repository, in the delivery's log, while the other accounts' repositories read as before.
- **Kept to show.** The installations a4a knows of are kept (`vcs_installations`): all of them when the app is given or tested, and each as a repository is read through it, with the last few repositories and what GitHub last said of it (suspended, gone). The integrations page lists them by account, and the badge no longer names one account.
- **The integration's own repository.** An integration named after a repository still has its app checked against it when the app is given: the name is the administrator's word of where it reads, so a wrong app or a missing install shows then rather than at the first build. A name that isn't a repository needs no installation in particular, and an app on several accounts is no longer a question (D54 asked which): the integration's own installation is the one given, else its repository's, else the app's first that isn't suspended, and it's what a read that names no repository goes through.

**Check runs on pull requests, as the app.** A GitHub integration with an app can report to each pull request as a check run named "a4a", off by default. Turning it on takes a token for `checks: write` first, so an app that may not is refused there, with where to give it the permission and that each installation must accept it; the page says the same beside the switch.

- **What it names.** The issues the pull request names, as D26 reads them: its title, its branch, its description, and its commits, read once per head as the app from GitHub's compare of its base and its head (contents read, the token a build's compare uses). Each with a link to it.
- **Whoever sees the repository reads it**, which may be the whole world and is never only a4a's team. So by default a check says ids and links alone: never an issue's summary or its state. A second switch adds each issue's state; a project that keeps its State private (D50) shows none. A summary goes only with an issue a guest may read (a project open to guests, through the access seam as a guest: D37, D64), whose words are public already, and its link opens the guest's page.
- **Never named.** An issue limited to some people (D37), or one whose project the integration isn't given (moved out of them since; a project not given is never read at all), is never named. It reads as an id that names nothing, exactly as one that doesn't exist does: not listed, and counted in one sentence, "2 more ids it names are no issue a4a can show here: there are none by them, or they aren't for everyone to see". So a check can't tell a limited issue from a missing one, and an issue limited since stops being named in the same words a deleted one does.
- **Its conclusion is `neutral`.** The integration's rule makes it `failure` while an issue it names isn't resolved, or an id names nothing a4a shows; the check then marks each issue that holds it back "not resolved", which the conclusion says anyway, and gives no state's name without the second switch. The rule is the integration's, not a project's: a check run's conclusion is what a repository's branch protection reads, the people who require it are the repository's administrators, who make a4a's integrations and whom a project's managers aren't; and a pull request can name several projects' issues, so a project's rule would make one check's conclusion depend on which projects it happened to name. What counts as resolved stays each project's own (its State's resolved values).
- **Kept current, through the outbox.** One row per pull request (`vcs_checks`). Its deliveries keep the row as the pull request is and make it due; a new head gets a run of its own. The outbox's consumer (D5) makes due the rows naming an issue that was created, changed, moved or deleted, and every row over a project whose key or guest access changed; marking is idempotent, so an event handed over twice marks once. A sender on every instance claims what's due (`SKIP LOCKED`, a two-minute lease), words it as it stands then, and writes only when the words changed: an event redelivered writes nothing. A row marked while it was written stays due (`marks`), so a change that raced a write isn't lost. Writes through one installation are counted in Postgres (`VCS_CHECKS_PER_MINUTE`, 20), so instances count as one; past it, or when GitHub says to wait (its rate limit, or Retry-After), the installation and its checks wait until then. A write that fails tries again after a minute, five, thirty and two hours, and the integrations page says why, in English, as a delivery’s log does (D49); a closed pull request's row stops being written, and is forgotten after 30 days.
- **In the server's language** (D49): whoever reads a check reads it together, as a channel's people do.
- **Idempotent on GitHub too.** A run is made with a4a's id for it (`external_id`); a write that died after GitHub made it finds it again by that id rather than making a second.

**Forgejo's tokens narrowed.** What a4a relied on, as Forgejo's and Gitea's own documentation says: their OAuth2 provider has an authorization endpoint, a token endpoint, the user's info and its keys, and an OpenID discovery document at `/.well-known/openid-configuration`; Gitea added token introspection (RFC 7662, `/login/oauth/introspect`, advertised in that document), which Forgejo inherited. Neither documents token revocation (RFC 7009): a person revokes an app's access in their settings, under Applications. Forgejo documents no scopes for OAuth2 tokens (each reaches all its person's resources); Gitea 1.23 grants the scopes asked for only with `[oauth2] ENABLE_ADDITIONAL_GRANT_SCOPES`, off by default. Neither documents a `scope` in the token's answer; Gitea's introspection says the grant's scope. So a4a reads what an instance says of itself, never a version it guesses:

- **Revoked where it's offered.** The discovery document's `revocation_endpoint`, on the instance's own origin, takes the refresh token and then the access token, with the app's credentials, as soon as the token has asked who the person is, whether connecting went or not. An instance that adds revocation later is used without a change.
- **Said where it isn't.** Where the document offers none (Forgejo and Gitea today, as documented), the profile says so before the person goes on: a4a uses the token once and forgets it, but it stays good there until it expires, reaching all of the account where the instance doesn't narrow tokens, and revoking a4a under Applications ends it at once.
- **Refused when wider.** Where the instance says what it granted (a `scope` in the token's answer, else its introspection), anything beyond `read:user` and OpenID Connect's own scopes (which open no API) is refused before the token is used, and taken back where it can be; the profile says why (`?connect=wide`). Where the instance says nothing, it takes no scopes, and the profile said what that means.
- What an instance offers is kept an hour (five minutes when it didn't answer), and an address on another origin counts as none, so an instance can't send a token elsewhere.

**What it costs.**
- A read for a repository a4a hasn't read lately asks GitHub where it's installed first: one more request an hour per repository per instance. A suspended installation is asked again on its repository's next read, once its token is refused.
- A check run says less than a4a knows, by design: a team that wants its issues' summaries on its checks opens the project to guests. A limited issue reads as a missing one, so the rule fails a pull request that names one until it's unlimited or no longer named.
- An issue whose project keeps its State private is named without a state, and the rule passes over it: a conclusion that turned with a private field would say it, so such an issue can't hold a pull request back.
- An integration's checks start with each pull request's next change: a4a lists no pull requests when they're turned on. A pull request whose head moved while a4a wasn't told (its delivery lost) keeps its old run until the next.
- Twenty writes a minute per installation, and fewer when GitHub says so: an issue a hundred open pull requests name takes five minutes to reach them all.
- Gitea's introspection says the grant's scope even where the instance doesn't enforce it, so on such an instance a token reads as narrowed when it isn't; a4a can check only what the instance says. Where nothing can be revoked, the token lives its hour there, which the profile says.
- The profile's list of code hosts asks a Forgejo or Gitea for its discovery document once an hour, and once in five minutes when it didn’t answer, waiting up to ten seconds for one that doesn’t.

**Revisit when:** a build should report its own result to GitHub as a check run (the seam is here: `vcs/checks.ts` writes as the app); GitLab's or Forgejo's pull requests want the same (commit statuses); a team wants a check's words in its project's language; or Forgejo documents revocation or scopes, which a4a already reads from its discovery document.

### D67. CCs in depth: the requester takes people off, a desk's own cap, CCs hearing each other where a4a can trust who wrote, and a new request's Cc waiting for its requester

D57 copied people on a request and left four things for later: the requester taking off whom they copied, a desk's own cap, CCs hearing each other's and the requester's words, and the Cc of a new request nobody vouches for waiting for its requester. All four come, and the third only where a4a can trust who wrote.

- **The requester takes people off.** On the portal, a request's requester takes off anyone copied on it: those they copied, those their email's Cc copied, and those the team copied. The other way was to leave the team's to the team. But what a CC is told is the team's answers to the requester's own matter, and the requester is who knows that a colleague has left, or that a manager shouldn't hear; the team keeps its say, since the history shows who took whom off and the team may copy them again. Kept as D57 keeps them: the row stays (`removed_via` `portal`), so an email's Cc doesn't put them back; the requester and the team may copy them again, and someone who stopped it themselves stays stopped. The history names the requester, through the help desk (`request.cc_removed`, `via: portal`). A colleague of their customer group (D56) and someone copied are refused, in words that say how to stop being copied oneself (any email's link). The API takes it with the portal's session, through `route()`: `DELETE /portal/requests/{id}/ccs?email=`, from the portal's own page, limited with the portal's other acts.
- **A desk's own cap.** `settings.helpdesk.ccsMax`, from 1 to 50, `REQUEST_CCS_MAX` (20) unless its managers choose another. 50 is Zendesk's 48, rounded: at it, one public reply sends 51 emails, each minting a reply token, and so does a relay; past it a desk wants a list address, which counts as one, rather than a4a acting as a list server. Lowering it takes no one off: each copy counts the request's CCs under its row's lock, as D57's did, and refuses past the desk's cap, at the team's page, the portal and the email's door alike, each saying the number (`requestCcs.full` with its `max`; the desk's log: "the desk copies at most 5 on a request"). The team's card and the portal say so when a request is full. The service refuses a cap outside 1 to 50 whoever calls; the change is in the desk's history.
- **Whom a4a trusts to have written something.** What someone wrote on the portal, signed in: each way in proves the address (D45, D63). And email whose sender's domain passed DMARC at a mail server the administrator names (`HELPDESK_TRUSTED_AUTHSERV_IDS`, by authserv-id), as that server's Authentication-Results header says (RFC 8601, `helpdesk/trust.ts`).
  - Only the topmost header from a named server counts. Each server adds its header above what came with a message, so whatever the sender wrote lies below the named server's own; RFC 8601 asks a server to remove headers claiming its id. A header from a server nobody named says nothing either way, nor does one with no authserv-id at all (Exchange Online writes those).
  - Its DMARC results must all be `pass`, one for the domain the message is from (`header.from`): a pass for another domain says nothing of this sender.
  - It reads as RFC 8601 writes it: comments (nested), quoted strings, folded lines, a version after the id, spaces around `=` and `;`, and keywords and the id in any case.
  - Mail by the inbound webhook (D30) counts only if the provider's own header is named the same way. The tracking page (D24) isn't trusted: its link is forwarded with the email that holds it, and lasts as long as the request.
- **CCs hear each other.** A desk's switch, `ccsRelay`, off by default and its managers' choice: relaying outside words to addresses is what D57 refused, so turning it on is in the desk's history (`project.request_ccs.changed`, with the cap and the hold), and the desk's page says what it does and whom this server trusts. Then everyone on a request hears each other's public words: its requester (unless they stopped its emails), those copied on it, and colleagues of its customer group who answered it and still may (D56).
  - **Decided as the words come in** (`relayChoice`), so the comment's event says `relay: true` and the desk's log says why not: an email's line says it was relayed, or why not; words on the tracking page that a desk that relays didn't pass on get a line of their own (`via: page`), as do portal words past a limit. What isn't relayed stays on the request's page and in the team's view, as before.
  - **A consumer of its own** (`helpdesk-relay`) queues an email per person, once per event and person, and each is checked again as it's sent: a desk that stopped relaying, words made internal or deleted, or a reader taken off or stopped, sends nothing.
  - **The email** comes from the desk, as its other mail does (its own address once it has a mailbox or a name, D45), with a reply address of its own for its reader (D57's tokens; a colleague's now answers for them, taken as a colleague's answer). It says who wrote, "Ana Kim wrote:", by the name they gave the portal or signed their mail with, and quotes nothing older: lines they quoted are left out. It never carries files, so nothing from outside becomes an attachment others get from a4a: it says how many came and links to where they are. Its writer never gets their own words back, and a colleague's words reach the requester by D56's email only.
  - **Stopping:** the requester by stopping the request's emails, someone copied by being taken off, a colleague by its own link (`kind: relay`, kept in `request_relay_stops`).
  - **Limits**, in the help desk's shared throttle (D30): 20 relays a request and 10 from one sender each hour (`CC_RELAY_LIMITS`). A relay is counted only when it would go, the sender's first; words nobody else would hear aren't counted.
- **A new request's Cc waits for its requester.** A new request by email whose sender a4a can't trust has its Cc held, not copied: in a table of its own (`request_cc_holds`), not as CCs, so nothing that reads CCs can take someone held for someone copied, and nobody held is sent anything. The same addresses are left out as a copy leaves out, up to the desk's cap.
  - **The acknowledgement** names them and asks the requester to confirm them, by a link minted as the email is sent and kept as a hash, good once for three days (`hdc_`, `request_cc_confirmations`). Opening it changes nothing, so a mail scanner's visit tells nobody anything; its page lists them, all chosen, and copies those the requester keeps and drops the rest. Its use is claimed in one statement, so two at once can't both settle. A stale, used or unknown link answers alike.
  - **The portal** shows its requester what's held, to copy or drop each, for 30 days (`CC_HOLD_DAYS`), after which a hold is forgotten. Copied, they're the requester's ("copied … from their email, once they confirmed it", `via: confirmed`); dropped, they're told nothing. The team's card shows who waits, and the team may copy one, which settles the hold.
  - **A trusted sender's Cc** copies at once, as D57's did. A desk can turn holding off (`ccsConfirm`, on by default): every new request's Cc then copies at once, as D57's did, and those already held stay held until their requester decides, since turning it off vouches for nobody already named.
- **Every channel.** REST: `DELETE /portal/requests/{id}/ccs`, `POST /portal/requests/{id}/held-ccs`, `GET` and `POST /portal/cc-confirmation` (the token in `x-cc-confirmation`, as a tracking token goes in a header), and `ccsMax` and `held` on a request for the team and on the portal for its requester. MCP: `get_issue`'s request shows the cap and who waits, and `add_request_cc` says the desk's cap. No tool sets the switches: as D63 says of sign-in, a desk's settings aren't work on issues, and relaying outside words is a person's choice on a page that says what it trusts. The web: the portal, the link's page, the request's card and the desk's card.

**What it costs.**

- A desk whose mail reaches a4a through no server the administrator names, or one that writes no Authentication-Results, or writes them without an authserv-id (Exchange Online), has no email a4a can trust: only portal words are relayed, and every new request's Cc waits for its requester. Naming a server trusts that all of a desk's mail reaches a4a through it, and that it removes headers that claim its id.
- DMARC vouches for a domain, not a person: anyone who can send from the domain can send as someone else there, and at a webmail domain it vouches for the provider. Mail through a list or a forward often fails it; those words stay on the page.
- Each reply from outside reads who else is on its request, to decide, and the relay reads them again for each event.
- A requester who wrote by email and never confirms loses whom they copied after 30 days, and their words on the tracking page are never relayed; signed in to the portal, they are.

**Revisit when:** forwarded mail should be vouched for by ARC (RFC 8617); a desk should name trusted servers of its own; colleagues should hear the team's replies too (D56's members told of their group's requests); relays should carry files; or a reply's Cc, not only a new request's, should wait for its requester.

### D68. Passkeys in depth: an id chosen for a move, passkeys required with an administrator's escape, some authenticators by attestation, and accounts with no password

D62 bound passkeys to PUBLIC_URL's host, took any authenticator, required them of nobody and kept a password beside every one. Each of those now has a way further, and each way keeps D62's rule: a passkey is both factors, and nothing a4a adds lets someone in past them.

- **An id that outlives a move.** `PASSKEY_RP_ID` names the relying party id ahead of time, checked at start with an error that says what to set:
  - **PUBLIC_URL's host, or a registrable parent of it**: `example.com` for `a4a.example.com`. Registrable is the public suffix list's answer, through `tldts` (pinned exactly, with `tldts-core`, the list it reads), private entries included, as browsers read it: `co.uk` and `github.io` are refused, since anyone can register under them and browsers make no passkeys for them. Without a list, the rule would be a guess at what a browser then refuses; a suffix added to the list after the pinned release is the gap, and the browser's own refusal is the backstop.
  - **Or, once moved, the host it moved from**, when PUBLIC_URL's origin is among `PASSKEY_RELATED_ORIGINS`. a4a serves `/.well-known/webauthn` (`{ "origins": [...] }`, on whatever host asks), the file WebAuthn's related origin requests read at the id's host. The origins are https (http only on localhost), origins alone, and span five registrable domains at most, the most browsers read.
  - **What each path takes.**
    - A parent id works in every browser, with nothing to keep serving, but only if it's chosen before people add passkeys: a passkey belongs to the id it was made for, so changing it later leaves those behind, listed as made for another address, as D62 lists them. Any site under the parent can ask a browser for its passkeys: a4a takes an answer only from its own origin, so another site can't sign in with one, but it can learn that its visitor has one.
    - Related origins need the old host's name kept pointing at a4a (or at anything that serves the file, over https with a certificate for that host), for as long as its passkeys are wanted. Chrome and Edge honour them from version 128, on the desktop and Android, and Safari from 18; Firefox didn't when this was written. In a browser that doesn't, passkeys for the old host neither sign in nor can be made at the new address, and its people sign in with their password.
    - What still breaks: a lapsed domain or certificate for the old host stops every passkey at once; a browser without related origins has none; and passkey managers keep showing the old host's name.
- **Passkeys required, of everyone or of administrators** (`requirePasskeys`, the instance's settings). Only people a4a's own password signs in are asked: single sign-on and directory accounts stay their provider's (D62).
  - A password sign-in that owes one gives it as the second step, and a code doesn't stand in for it. Someone without one adds it before their session starts (`{ "step": "passkey_setup" }`, a ticket of its own, as two-factor's required setup works, D38), with a code too where they have codes: someone who knows only the password could otherwise add a passkey of their own at that moment, the cost D38 named for its own setup. A passkey from the sign-in page always meets it. Sessions already open stay, as D38's requirement leaves them.
  - **The escape, for a device that can't make one, is an administrator's**: they let that person off (`passkeyExempt`), who then signs in with their password and a code, setting an app up first if they have none, so nobody signs in with a password alone. Not a button the person presses, because a requirement anyone can wave away is a suggestion: a phishing page would relay the press, and a4a can't tell a device that can't from a person who won't. An administrator can ask; D38 put a lost phone in their hands the same way. And it's rare: when this device can't, the browser offers the person's phone (by its QR code) or a security key.
  - **The last administrator.** A change that would leave no administrator able to sign in is refused, and says so: requiring passkeys, turning them off, removing a passkey (one's own or, as an administrator, someone's), and taking an exemption back. Each locks the administrators' rows and counts, in its transaction, those who still sign in: a provider's administrators, those with a passkey that signs in here, those let off, and those passkeys aren't asked of; someone who'd have to add one at their next sign-in isn't counted, since whether their device can is what nobody knows yet. So the first administrator adds a passkey before passkeys are required. Requiring them while they're off is refused, and so is turning them off while they're required; where the address or `PASSWORD_LOGIN` turns them off, nothing is asked (required while off would let nobody in). Not guarded: demoting or banning an administrator, and a passkey stopped as copied or by "This wasn't me", which take access away; the password, or a setup link, brings its person back.
- **Only some authenticators** (`passkeyAuthenticators`, by AAGUID). An AAGUID is the authenticator's own word, so a list asks the maker to vouch: attestation, `direct`.
  - **Privacy.** An attestation tells a4a the make and model of its person's authenticator, and its certificate is the batch's. a4a asks for one only while a list is on (`none` otherwise, as D62), keeps only the AAGUID and that it was vouched for (`attested`), and drops the certificates.
  - **FIDO's metadata.** Its BLOB is fetched from `PASSKEY_MDS_URL` (FIDO's, by default) or read from `PASSKEY_MDS_FILE`, for an instance that can't reach it, and verified by `@simplewebauthn/server`'s `verifyMDSBlob`, the function its `MetadataService` verifies with: the signer's chain to FIDO's root (`PASSKEY_MDS_ROOT_CERT` names another, for a private metadata service, or a test's), the JWT's signature by it. As MetadataService does, a BLOB numbered before the one in use is ignored.
  - **What a4a built beside MetadataService**, which keeps its BLOB in one process's memory, fetches it again inside a registration when it's due and fails that registration when the fetch does, and reads no file: the BLOB's statements and status reports (icons dropped) are kept in Postgres, one row every instance reads, so a restart loses nothing; the lease holder reads it again daily while a list is on, and every half hour while it's missing, failing or stale, with a timeout and a size cap, never inside a sign-in; a fetch that fails keeps the last good BLOB, and the administration page says how old it is, its next update, and when and why the last try failed. With no BLOB yet, adding a passkey under a list is refused, saying why (503).
  - **The check**, at each registration under a list: the attestation must be full, a certificate chain in `packed`, `tpm` or `android-key` (`none`, and self attestation, prove nothing about the maker); its AAGUID on the list; described by the BLOB; and not reported by FIDO as compromised or revoked. Then the library's own check: a4a loads its `MetadataService` with the BLOB's statements (no servers, so it never fetches), and `verifyRegistrationResponse` checks the attestation's signature, and that its certificates chain to the roots the statement names. The passkey takes the statement's name.
  - **Passkeys from before a list keep signing in, marked** (`listed: false`). a4a never asked their makers, so it can't tell a covered one from another: stopping them would end every passkey at once, and lock out every account with passkeys alone. The list says what's added from now on; the profile and the people table say which predate it, and an administrator removes those they won't keep.
- **Accounts with passkeys and no password** (`users.passkeys_only`).
  - **Removing your own** takes a spare, two passkeys that sign in here or one its provider syncs (backed up), so losing a device isn't losing the account; and one of your passkeys in the last ten minutes, so you know it signs you in (the session keeps how its person last proved it's them, `verified_by`). Codes go with it, a code only follows a password; so do the other sessions no passkey signed in. It's mailed, with "This wasn't me".
  - **An administrator makes one** (`passkeysOnly`), and sends a link that adds its first passkey: D33's kind of token, minted as its mail is sent (or shown once, to hand over another way), kept as a hash, good once for three days, voided by a newer one, and carried in the address's fragment, which no server's log keeps. Its page signs nobody in until the passkey is made; a browser signed in as someone else is told to sign out first. Using it takes the link in the passkey's own transaction (of two at once, one wins), and ends every session the account had.
  - **Recovery.** Losing every passkey means an administrator sends such a link again, or sets a password. Never email alone: D62's reason, a mailbox would be a way in past both factors.
  - **What it can't do.** A password sign-in is refused in its own words ("This account signs in with a passkey"), which tells whoever types its login that it exists; logins aren't secrets in a4a, and a wrong-password answer would send its person looking for a password they don't have. Two-factor codes don't apply. Confirming it's you takes a passkey. Setting a password again takes a signed-in browser and a recent sign-in. Its last passkey can't be removed. API tokens and MCP's OAuth work as they do: OAuth signs its person in on a4a's own page, where a passkey does.
- **Every channel.** REST, in OpenAPI: `/.well-known/webauthn`; `POST /auth/two-factor/passkey-setup/options` and `/auth/two-factor/passkey-setup`; `DELETE /me/password`; `POST /auth/passkey/setup/info`, `/options` and `/auth/passkey/setup`; `POST /users/{id}/passkey-setup`; `passkeysOnly` on `POST /users`, `passkeyExempt` on `PATCH /users/{id}`; `requirePasskeys` and `passkeyAuthenticators` on `/settings`; `GET /passkey-metadata` and `POST /passkey-metadata/refresh`. The web: the sign-in's step, the setup link's page, the profile, the people table and the instance's settings. **No MCP tools**: signing in is a browser's, and the policy is security configuration where a mistake locks people out, as D63 kept a desk's sign-in from agents. **No events**: account changes, as two-factor's (D38).

**What it costs.**
- A parent id lets every site under it ask for a4a's passkeys; related origins need the old host's name and certificate kept, and Firefox has neither path's second half.
- Under a list, synced passkeys (iCloud Keychain, Google Password Manager and most others) give no attestation, so they can't be added: a list suits security keys and the devices an organisation hands out. FIDO's BLOB is a few megabytes fetched daily while a list is on, and the library may fetch the certificate revocation lists its chains name.
- `MetadataService` is one per process, loaded before each registration under a list: two instances of a4a in one process would share it.
- Passkeys from before a list sign in until someone removes them.
- Where passkeys are required, someone whose devices can't make one waits for an administrator; and the guard counts only administrators who sign in now, so the first adds a passkey before requiring them.
- A password sign-in to an account with passkeys alone says the account exists.
- Each password sign-in reads the policy, and whether its person has a passkey: a query or two more.

**Revisit when:** passkeys should be required of a group, or of a project's people, rather than everyone or administrators; an id should change after passkeys exist without leaving them behind (a sign-in that asks for two ids); FIDO's statements should name what the profile shows of an authenticator (its icon, its certification level); or an attestation should be checked against roots an organisation keeps beside FIDO's (enterprise attestation).

### D69. The portal's passkeys: made with the requester's mailbox, kept apart from the team's, at the desks that take them

D62 gave the team passkeys and left the portal's requesters for later; D63 gave requesters a password or a provider beside the emailed link, and named a second factor for the password as next. Requesters now sign in with passkeys too, as each desk chooses (`settings.helpdesk.signIn.passkey`), through D62's library and its helpers (`services/portal-passkeys.ts`, which imports what it shares from `services/passkeys.ts`).

- **A desk's new way in**, beside the link, a password or a provider, and never alone: a requester adds a passkey once signed in another way, so a desk that took passkeys alone would let nobody new in (`portalSignIn.passkeyNotAlone`). Left out of a desk's choice, `passkey` keeps what the desk had, so a script written before it turns nothing off. The desk's history records it with the rest (`project.portal_sign_in.changed`, `passkey` in `from` and `to`).
- **What a passkey's session opens:** the desks that take passkeys, and never one where the requester's customer group signs in through a provider (D63). A passkey kept by a4a would let them in after the provider turned them away, which is why D62 gives single sign-on accounts none (`portalSessionOpens`). A desk that stops taking passkeys closes its requests to passkey sessions at once, as with D63's other ways.
- **Made with the mailbox.** A passkey opens every desk that takes passkeys, so it's made with what each of them trusts: the requester's mailbox.
  - Adding or removing one takes a session that proved, in the last ten minutes, that its requester holds the mailbox: one opened by an emailed link (a sign-in link, or the link that set the password) or by a passkey, or confirmed since with one of their passkeys (`requester_sessions.confirmed_at`).
  - A session a password or a provider opened proves it again by signing in by a link, which works whatever the desks take (`POST /portal/sign-in` with no desk); or with a passkey they have.
  - Not the password, as D62's members confirm with theirs. A password is a convenience the mailbox resets (D63), and one known at a desk that takes passwords would make a passkey that opens a desk that doesn't. Nor a provider, which not every desk offers. So whichever desk a passkey was made at, no desk's choice opens another's requests, D63's rule.
  - Renaming takes nothing.
- **Kept apart from the team's.** Both sides share PUBLIC_URL's relying party id, so one authenticator answers both pages, and a browser offers both kinds in either's picker. So:
  - Requesters' passkeys have a table of their own (`requester_passkeys`), as their challenges and their mails' links do. The portal's routes read only theirs, and the team's only members'. A member's passkey on the portal is said for what it is (`portalPasskeys.teamPasskey`), from the handle the browser sent and without reading members' passkeys; a requester's on the team's page is one a4a doesn't know (`passkey_unknown`).
  - A requester's user handle is `hdr:` and their id; a member's is their id alone, letters and digits that never hold a colon. So neither is taken for the other, and an authenticator, which keeps one passkey per handle for a host, never replaces someone's team passkey with their portal one, nor the reverse. A portal passkey is listed under the requester's email, and named "(help desk)" in the desk's language.
  - A credential id is on one side at most (`passkeys.already`, `services/passkey-credentials.ts`): nobody can register a member's credential id, which browsers are sent in `allowCredentials`, as a requester's to stand in its way, nor the reverse. It's checked in the adding transaction under an advisory lock on the id, so two additions at once, one on each side, can't both pass. Run on Postgres without the lock, the test of it saw both added.
- **The rest is D62's:**
  - challenges made by the server, kept as a SHA-256 for five minutes, and taken once, by the ceremony they were made for (`register`, `sign-in`, `confirm`), from the browser that asked: its portal session, or a ticket cookie of the portal's (`a4a_portal_pk`: HttpOnly, SameSite Strict, sent only to `/api/v1/portal/passkey`);
  - user verification required, so a passkey is both factors; attestation `none`;
  - the sign count checked by a4a: a copy stops the passkey, the sessions it opened end, and the requester is told;
  - each try in the sign-in throttle, per address and per passkey (per requester when confirming), under keys no login can have; challenges held to 30 a minute per address on each instance; 20 passkeys a requester;
  - D62's switch (`settings.passkeys`) and its address: off, they're off on both sides.
- **What differs, and why:**
  - **The proof is the mailbox, not the password**, as above.
  - **Never a second step.** Requesters have no codes, and a passkey after a password would be the passkey alone with a delay: a desk that takes passwords offers a passkey in place of the password, a sign-in of its own.
  - **Mail in the desk's language**, as D63's is: a requester has no profile (D49). Each addition, removal or copy is mailed with "This wasn't me" (`/portal#hdk_…`, a token in the fragment as sign-in links' are, kept as a hash, good once for two weeks). Following it ends every portal session of theirs, voids their unused links to sign in or set a password, and stops the passkey it told of, with any added after it (or the copied one). It takes access away and never gives it, so the mail is enough.
  - **The team removes them, not only administrators**, since a requester is in no administrator's people table. A request's card says how many passkeys its requester has, never which (`requester.passkeys` on `GET /issues/{id}/request`). An administrator or the desk's manager removes them all (`DELETE /issues/{id}/request/passkeys`), with the sessions they opened, and the requester is told by which desk, without a link. It goes through the issue, so only someone who sees the request and manages its desk can.
- **Every channel.** REST through `route()`, under the portal's tag: `POST /portal/passkey/options` and `POST /portal/passkey`; `GET /portal/me/passkeys`, `POST /portal/me/passkeys/options`, `POST /portal/me/passkeys`, `PATCH/DELETE /portal/me/passkeys/{id}`; `POST /portal/me/confirm/passkey/options` and `POST /portal/me/confirm/passkey`; `GET/POST /portal/not-me?token=`; and the team's `DELETE /issues/{id}/request/passkeys`. The web: the portal's sign-in page (the email field's autofill where the browser offers it, asked again every four minutes, and a button), its account page, its "This wasn't me", the desk's page and a request's card. No MCP tool: signing in is a browser's, and a desk's setting a person's (D63). No events: a requester's account records none (D63), and the desk's choice is in its history.

**What it costs.**
- A requester signed in by a password or a provider waits for one email before adding a passkey; without SMTP, no requester can add one, and those added before still sign in.
- A browser offers someone's team passkeys on the portal and their portal passkeys on the team's page. a4a refuses each (the portal says it's the team's), but can't keep the browser from offering them.
- A requester's passkeys are bound to the relying party's id, the team's (D62, D68): a move keeps them only as it keeps the team's, by `PASSKEY_RP_ID` and related origins.
- The team's removal ends only the sessions the passkeys opened. Nothing on the team's side ends a requester's other sessions; "This wasn't me" and a new password do.

**Revisit when:** a desk wants passkeys alone, with a link only to make one; the team should end all of a requester's sessions; or a requester should see their sessions on the portal and end them.

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
| Sign-in throttle | Shared in Postgres, per IP and per login (or passkey, or requester's email: D62, D63), and kept across restarts. An attempt is counted before its password is checked, so parallel guesses can't pass the limit |
| Asks for writing help sent at once | Counted per person in Postgres, in the statement that checks them: instances count as one, and none slips past the hour's cap (D59) |
| Sessions | Rows in Postgres: valid on every instance; signing out ends a session everywhere |
| A requester's password set by two links at once, or set while it's changed | Each link is taken in one conditional update, and the requester's row is locked while the password changes: the second waits, then finds the first's. Setting one ends every session they had; changing it, every one but its own (D63) |
| Instances starting together | Migrations, defaults and the unattended first administrator run under an advisory lock: one instance at a time. So does `POST /auth/setup` |
| An import run twice, or stopped halfway | Each issue is known by (project, source, key): a rerun updates or skips it, never makes it twice. Each row commits on its own, so a run that stopped carries on where it was |
| Two people arrange one dashboard | `expectedVersion`: the second gets 409 and the current version |
| A guard and the change it checks | Same transaction: the change is checked after it's written and before commit, and refused all or nothing (D25) |
| A rule acting on a replayed event, or a loop of rules | Once per (rule, issue, change that started the chain), claimed in the rule's own transaction; chains stop three rules deep |
| A rule acting on related issues, telling people, calling a webhook | Each issue it acts on is its own transaction: the command, the message (`rule.notified`) and the call (`rule.called`) commit with the run's claim, or none of them do (D32) |
| A scheduled rule's turn | Claimed by moving its next run on, conditionally, by the instance holding the worker's lease |
| A delivery from version control sent twice | Its delivery id is claimed before the work; links are unique per issue and commit (or pull request), so even a second delivery id changes nothing twice |
| A build's run reported twice, or out of order | Its reports are taken one at a time, under an advisory lock on the project and the build's name: one value is made, and what's marked stays marked. A success is final, and a report older than the one the build holds leaves it as it is (D55) |
| A chat message's form sent twice, or two forms at once | The issue claims the form's draft in the transaction that makes it, so a second sending makes nothing; the person's chat limit is counted again there, under an advisory lock of theirs (D60) |
| A message to a help desk posted twice, or read twice | Known by its Message-ID within its desk, claimed in the log before the work; a failed claim, or one ten minutes stale, may be handled again (D30) |
| A help desk mailbox, shared or a desk's own, read by a new lease holder | Its place is a UID within its UIDVALIDITY, in Postgres, and only ever moves on; a message read twice is a duplicate by its Message-ID |
| Two requests for one customer group filed at once | They take turns under an advisory lock per group, so each sees the agent the other was given (D56) |
| Two people copying someone on one request at once | Each change locks the request's row, so together they can't pass its cap of 20; a unique index keeps one row per address (D57) |
| Two renames of a project's key, a rename and a new project wanting one key, an issue made during a rename | The rename locks the project's row: renames queue, and the second, given the key it saw, gets 409 with the key now. A key is free, a project's or a former key of one, never two: both are checked inside the transaction, and the unique index on projects' keys settles two claims at once. An issue's number is taken on the same row, under the key it has then (D52) |
| Two people undo one agent's change, or someone changes the issue as it's undone | The undo locks the change's row, then the issue, and checks the issue is as the agent left it under those locks: the second undo gets 409 `already_undone`, and a change that got in first makes it refuse with what changed (D34) |
| Two people change one whiteboard at once | Each batch locks the whiteboard's row and takes its next `seq`: changes to different elements, or different properties of one, all land; places go to the last writer, and words sent with `expect` are refused alone, with what's there now, if someone changed them meanwhile. Live streams send each change once, in `seq` order, and resume after the last one seen (D58) |
| Two sign-ins with one passkey at once, or one answer posted twice | Its challenge is taken in one statement, once. The passkey's count moves on in one conditional update: one sign-in passes; one beaten to a higher count is refused, and only a count already passed when it's read marks the passkey copied (D62) |
| A pull request's check run, while its pull request and the issues it names change | One row per pull request, made due by its deliveries and by the outbox's consumer, and claimed by one sender at a time (`SKIP LOCKED`, a lease). A write that raced a newer change leaves it due (`marks`); one whose words didn't change writes nothing, so a redelivered event writes nothing twice. A run is made with a4a's id for it, and a write that died after GitHub made it finds it again (D66) |
| Check runs through one installation, from several instances | Counted in Postgres in the statement that checks the minute's limit, so instances count as one; GitHub's own "wait" pauses the installation for all of them (D66) |
| Two people rank one board at once, or a key would grow too long | Each move locks the board's row (`FOR NO KEY UPDATE`), then the issue's: moves on one board are one at a time, each reading the keys beside its anchor as the last move left them, so two placed just after one card both land, the later first. A board's (or a lane's) keys written afresh happen inside the move that needed it. A card's column and its place change in that one transaction, all or nothing (D53, D65) |
| A card's moves in its issue's history | A move folds into the issue's latest line, or starts one, in the move's own transaction under the board's lock; a change to the issue in between ends the line, so a line never spans another entry (D65) |

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
- **Passkeys (D62):** WebAuthn for PUBLIC_URL's host alone, with user verification required, and only for accounts a4a's own password signs in, never those of single sign-on or a directory; challenges kept as hashes, for five minutes, taken once, bound to the browser that asked; each try counted in the sign-in throttle; a sign count that goes back stops the passkey and ends its sessions; adding or removing one takes a signed-in browser, never a token, and a sign-in from the last ten minutes or proving it's you again; each change is mailed to its person with a link that signs them out everywhere (an administrator's removal is mailed without it).
- **Passkeys in depth (D68):** an id other than PUBLIC_URL's host only where the public suffix list says it's registrable, or the old host with PUBLIC_URL's origin named related; passkeys required of everyone or administrators, the escape an administrator's, never the person's, and no change that leaves no administrator able to sign in; only some authenticators by attestation checked against FIDO's signed metadata, asked for only while a list is on; an account with no password needs a spare passkey and a passkey's proof, and comes back from losing them only by a link an administrator sends (kept as a hash, good once, for three days), never by email alone.
- **The portal's own sign-in (D63):** a requester's password (scrypt, on the requester) and a requesters' identity provider open the portal's cookie alone, never the team's side. A password is set, or reset, only by a link emailed to its requester (kept as a hash, good once, for twenty minutes), which ends every session they had; changing one takes the current one. Providers are an administrator's: OpenID Connect with PKCE, a state bound to the browser and a nonce, the ID token's signature checked, the client secret sealed; each vouches only for an email it verified, within the domains it's given. A session opens only the desks that take the way it was opened. Sign-ins share the members' throttle under keys of their own, and starting one through a provider is limited per address.
- **The portal's passkeys (D69):** a requester's passkeys are kept apart from members', in a table the portal's routes alone read, under user handles no member's can be (`hdr:` and the requester's id), and a credential id is on one side at most. A passkey's session opens only the desks that take passkeys, never one whose customer group signs in through a provider. Adding or removing one takes proof of the mailbox from the last ten minutes (a sign-in by an emailed link or a passkey, or a passkey to confirm), never a password or a provider. The rest is D62's: challenges as hashes, once, five minutes, bound to the ceremony and the browser; user verification; the sign count; the sign-in throttle; each change mailed with a link that signs the requester out everywhere.
- **Project access:** see D15. What can't be seen answers exactly as what doesn't exist.
- **Guests (D37, D64):** a request without credentials reads only the projects an administrator opened to guests, through the same seam as anyone's, with the read scope alone, so every write is refused (401). Guests reach issues and their comments, links, files and history, articles, boards, reports (not the time report), a plan's schedule and whiteboards with their live streams; never the people list, costs, baselines, loads or days away, a board's backlog or sprint plan, who's looking at a whiteboard, the event stream or MCP. Each address has a rate limit of its own (`GUEST_RATE_LIMIT`), and four live whiteboards on each instance.
- **The browser:** strict Content-Security-Policy; no inline script or style; fonts are bundled, nothing loads from outside; Markdown is rendered without raw HTML.
- **Uploaded files:** their type is read from their bytes. Only raster images open in place. Text shows as text, never as markup, and sound and video play in the browser's own player (D35). Everything else is a download. All are served with `nosniff`, `Content-Security-Policy: sandbox` and `Cross-Origin-Resource-Policy: same-origin`. Names are made safe, and storage keys are random, so no name reaches the file system or a bucket's keys.
- **Imports from an API:** the server reads only public https addresses, checked as it connects and at each redirect, unless an administrator allows a host inside by name; the other tracker's token is used and never kept, logged or shown (D29).
- **Webhooks:** signed with HMAC-SHA256 over the raw body. Only admins can create them, because the server will POST to the URL given (server-side request forgery to internal addresses is the admin's call). A workflow rule calls only a webhook an administrator chose for it, only over https (or to this machine), and only an administrator makes such a rule (D32).
- **Email:** unsubscribe links are signed (HMAC-SHA256, a key in settings) and checked in constant time; they only ever stop email. HTML email carries no images, scripts or styles, and quotes what people wrote as written.
- **The help desk:** its public routes need no sign-in and reveal nothing beyond one request (D24); tracking tokens are hashed; its form has a CSRF token tied to a `SameSite=Strict` cookie and an Origin check; anonymous posts are size-limited and rate-limited, and a hidden field catches bots. docs/mcp-and-api.md (8a) says what's missing.
- **Reading as a GitHub App:** its private key is sealed with SECRET_KEY and never shown; the installation tokens it's traded for read contents only, last an hour, and live in memory alone (D54). Each repository is read through its own installation, and a check run is written with a token of its own that may write checks and nothing else (D66).
- **Check runs:** whoever sees a repository reads them, so they name issues by id and link alone; a state only when the integration says so, a summary only for an issue a guest reads, and never an issue limited to some people, which reads as one that doesn't exist. What people wrote is escaped as Markdown's own characters, so a summary can't make a link (D66).
- **Forgejo's and Gitea's tokens:** refused, unused, when the instance says they reach more than `read:user`; taken back as soon as they've been used where the instance's discovery document offers revocation, on its own origin only; and where it doesn't, the profile says so before anyone goes on (D66).
- **Deliveries from version control:** checked (signature or token, in constant time) before anything is read; rate-limited; refusals logged at a bounded rate. Commands in commits run only as their author in a4a, known by a confirmed email or a login an administrator recorded (D33), and only where they can change issues (D26). Bitbucket is read only on the address an administrator gave, following no redirects. Links from a payload are shown only if they are http(s).
- **Chat:** what Teams and Slack send is checked before anything is read (Bot Framework's token; Slack's signature, within five minutes, in constant time), and taken once: a Slack request by its signature, a Teams activity by its id (D60). A message made an issue keeps no raw HTML and no link but http, https and mailto, fetches no picture, and mentions nobody in a4a; its files are linked, never fetched by the server.
- **Confirming an email:** by a link whose token is kept as a hash, works once, for a day, and only for the person who added the email, signed in; at most five go an hour (D33). An API token can't change emails.
- **Mail into a help desk:** a provider's post needs the desk's secret (HTTP Basic, hashed, constant time), and refusals are limited per address. A reply speaks for the requester only from their address and with what only they had (a reply address's token, or an email's random Message-ID). A CC's reply address answers for their address alone, while they're copied; a CC is emailed only the team's words, and a CC's words are emailed to nobody (D57). Nothing set aside or refused is answered, so forged senders get no mail; a receiving server's DMARC failure is refused. Mail's HTML is read as words, never shown (D30).
- **Writing and reading help (D59):** reads only what its person may see, through the access seam; what people wrote goes to the model as data, and an edit's code, link addresses, raw HTML, mentions and ids are put aside and given back to the byte; nothing is written without its person.
- **Agents:**
  - An agent's own tokens are issued by administrators, never by the agent; an agent can't undo, and a person's undo never overwrites a later change (D34).
  - Issue text is untrusted, so the assistant asks before writes, unless its person lets it act.
  - MCP writes are annotated, so clients can ask too.
  - MCP deletes no issue, article, file or whiteboard (D8).
  - Every change records actor, channel and token.

## Limits and assumptions

- **Teams, not internet scale.** Users, tags, fields and values are held in memory per instance (thousands of each is fine), and every instance reloads them after any change to them.
- **Several instances need Postgres**, a `LISTEN` connection each beside the pool (not through a pooler in transaction mode: set `DATABASE_LISTEN_URL`), and a proxy that passes `text/event-stream` through unbuffered. `docker-compose.cluster.yml` runs two behind Caddy.
- **Idle connections stay open 65 s**, past the 60 s a load balancer commonly keeps its own (AWS's default), so the balancer closes first and never sends a request down a connection a4a has just closed. One that keeps them longer, as Google's external Application Load Balancer does (ten minutes), needs `KEEP_ALIVE_SECONDS` set past its timeout: 620.
- **A live stream replays up to 1000 missed events** on reconnect; past that it sends `resync` and the client re-reads.
- **An event whose transaction stays open for more than a minute** is passed over by live streams and consumers, with a warning; it stays in `GET /events`.
- **Pagination.** Search results use offset pagination (sortable by any field); the event feed uses a cursor (`after`).
- **General rate limits are per instance**, in memory (D17): behind N instances a client gets up to N × 1200 API requests a minute and N × 600 MCP requests, and a guest's address N × 300 (D37). `API_RATE_LIMIT`, `MCP_RATE_LIMIT` and `GUEST_RATE_LIMIT` set each instance's share. OAuth's limits are per instance too: 20 app registrations an hour and 120 token requests a minute per address (D28). The sign-in throttle is shared.
- **A token's last-used time** is written at most once a minute per instance.
- **An assistant conversation whose instance dies mid-answer** takes messages again two minutes later: a turn claims its conversation in one statement and refreshes the claim every 30 s while it runs, so a claim left stale was cut off. The same claim stops two decisions sent at once from both running the changes.
- **Time zones.** Dates in a person's searches ("today", "{this week}"), their digest's hour and their email's times follow their own time zone, or the server's when they set none; rules and agents with no person read dates in the server's (D31). The web app shows times in the browser's zone.
- **Reports' days** are in the time zone asked for (the web app sends the browser's), each day as it stood at its end. A report reads at most 400,000 events. A sprint's working days and holidays are those of the plan of the first of its board's projects the reader can see, so a board whose projects keep different calendars draws on the first's.
- **An import** takes a CSV of 64 MB and 50,000 rows at most, one run per project at a time. One from an API reads up to 50,000 issues, each page of its answers 64 MB at most, and waits out a `Retry-After` of up to ten minutes at a time.
- **Days away** count from a year before today to five years after; the engine plans everyone as there beyond that (D36).
- **A limit on an issue, a comment or an article** reaches an open live stream within 10 seconds of being changed: each event's facts are kept that long (D37, D51).
- **A workflow script** runs for 250 ms (a guard for 60 ms) in 16 MB at most, is 20,000 characters at most, asks for 20 commands and 5 comments a run, and sees an issue's latest 20 comments and 100 links (D40).
- **Readable ids** (`BACK-12`) change when an issue moves to another project, and the old one stays its alias for good (D41). A project's key can be renamed; the key it had stays its own, so `BACK-12` finds `CORE-12`, and no other project can take `BACK` while it exists (D52).
- **Files are on one disk, or in a bucket.** Several instances need a bucket (`ATTACHMENT_STORAGE=s3`, D35) or `DATA_DIR/attachments` on a shared volume. Back either up with the database: a file's row and its bytes go together.
- **A whiteboard** holds 500 elements, 2,000 characters of words in each; a batch is 500 operations, and a conversion 50 notes and 50 arrows. Its live stream replays the last 500 changes; further behind, it reads the whiteboard again (D58).
- **Guests' live whiteboards** are four open streams per address and four hundred in all, on each instance (D64).
- **Help desk mail** is read once a minute by default: from the shared mailbox, where desks are told apart by the address mail was sent to, or from a desk's own mailbox (D45). A desk's replies need its mail server to deliver plus addresses (D30).
- **A help desk request** copies 20 addresses at most (D57).
- **A board's keys** are 64 characters at most: a move whose key would be longer writes its board's (or lane's) keys afresh first, in one statement (D65).
- **The portal's own sign-in** takes identity providers that speak OpenID Connect, 50 at most, and no SAML. A session opens only the desks that take the way it was opened, so a requester whose desks differ signs in to each in turn (D63).
- **Check runs** go through one GitHub App installation 20 a minute (`VCS_CHECKS_PER_MINUTE`), across instances; a check lists 50 issues and counts the rest, and reads 250 of a pull request's commits (D66).
- **Passkeys** are 20 a person, for PUBLIC_URL's host, or a parent of it, or the host an instance moved from (`PASSKEY_RP_ID`): an instance at an IP address, or on plain http other than localhost, has none, and one that moves without having chosen an id ahead of time, or naming its new origin related at the old host, leaves its passkeys behind (D62, D68). Related origins span five registrable domains at most. FIDO's BLOB is 64 MB at most, read within 30 seconds (D68).
- **The portal's passkeys** are 20 a requester, for the team's relying party id (`PASSKEY_RP_ID`, D68), and need email to be added: a sign-in by an emailed link proves the mailbox they're made with (D69).
- **Writing and reading help** is 100 asks a person an hour (`AI_WRITING_MAX_PER_HOUR`), counted across instances. What someone sends is 12,000 characters at most to fix or rewrite, 40,000 to summarise and 2,000 for a line to draft from; an issue is read to its latest comments within 60,000 (D59).
- **An issue from a chat message** holds 3,000 characters of it and the first 20 replies of its Slack thread. A person makes 10 in ten minutes (`CHAT_ISSUE_LIMIT`), across Slack, Teams and every instance, and Slack's form lists 100 projects (D60).

## Not yet

Planned, with the seams already in place:

- being told what time alone brings into a saved search (an issue becoming overdue) (D31);
- days away from an HR calendar (D36);
- a guest's page for an article, so a guest's whiteboard card or link to one opens it, and a report's count opening its issues for a guest (D64);
- a whiteboard of a person's own, shared with people and groups, or limited to some, words merged as they're typed rather than refused, and freehand drawing and pictures on a whiteboard (D58);
- the visual editor for a help desk requester's own replies on its public pages, and pictures in a reply that its requester can see (today they read its name), a link tool on the editor's toolbar, and pictures pasted into a new issue before it's created (D39);
- scripts that call out through a signed webhook, and code shared between a project's scripts (D40);
- chat beyond Teams and Slack (Google Chat, Mattermost), Teams' own link unfurling (a message extension), and a channel's posts updated in place as their issue changes (D42);
- a thread's replies in an issue made from a Teams message (through Microsoft Graph), and a message's files brought into the issue rather than linked (D60);
- a team's capacity beyond a sprint's assignees, and timesheets submitted and approved (D43);
- passkeys required of a group or a project's people, and an id changed after passkeys exist without leaving them behind (D68);
- SAML for requesters' identity providers, a desk's own provider limited to its customers, and the desk's emails in a requester's own language (D63);
- customers that several desks serve, a requester in several groups at a desk, and members told of their group's requests (D56);
- builds from GitLab's and Bitbucket's pipelines as GitHub's workflow runs come, a build's commits by the commit graph rather than by time, and GitHub Issues' reactions in an import (D46);
- Asana's time tracking and ClickUp's comment threads in an import (D61);
- a Forgejo run's commits read from Forgejo's compare, once its integrations hold a token (D55);
- a build's own result reported to GitHub as a check run, and checks on GitLab's and Forgejo's pull requests (D66);
- acting from a push notification without opening a4a (assign to me, a state), and reading or writing offline (D47);
- apps that call out to services of their own, share code between their parts, ship guards, or are installed by a project's managers; a catalog with reviews; widgets that follow live events (D48);
- a right-to-left language; and a project's own words in several languages (D49);
- writing help on a requester's own pages, saved words that say the assistant drafted them, and long drafts streamed as they're written (D59).
