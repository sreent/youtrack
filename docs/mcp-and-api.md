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
| Scripts and integrations | REST API + webhooks | CI files a bug when a build breaks; GitHub or GitLab links commits and pull requests, and `PROJ-12 #Fixed` resolves an issue; importers; dashboards and reports |
| Coding agents (Claude Code, Cursor) | MCP | Pick up an issue, move it to *In Progress*, comment progress, link follow-ups, resolve it when done |
| Assistant agents (Claude Desktop, custom) | MCP | Triage the backlog, write status reports and release notes, find duplicates, plan sprints |
| Event-driven agents | Webhooks / SSE + MCP or REST | React when something happens: triage new issues, notify on blockers |
| Agents with a person's token | MCP `list_notifications` | See what's waiting for their person: assigned, mentioned, changes on what they watch |
| People outside the team | The help desk's public pages (no sign-in) | Ask a project for help, follow the request, answer the team's replies |
| Project managers (waterfall or hybrid) | Web UI + REST + MCP | Gantt timeline with critical path, resource levelling, cost tracking against a budget, baselines and earned value |
| The built-in AI assistant | Same tool layer as MCP | Chat with your projects; it asks before it changes anything |

## 2. Design principles

1. **API-first.** Anything you can do in the UI you can do over REST. An OpenAPI 3.1 spec is served at `/api/v1/openapi.json`, with interactive docs at `/api/docs`.
2. **MCP is curated for agents, not a mirror of REST.** About 37 task-shaped tools instead of ~100 endpoints. They take readable IDs (`PROJ-12`) and names (`"Priority": "Critical"`), not internal IDs. Output is compact and agent-readable. Errors tell the agent how to fix the call (for example *"Unknown value 'Fixd' for State. Did you mean 'Fixed'?"*).
3. **One tool layer, three surfaces.** The MCP tools and the in-app assistant's tools are the same code, running over the same services as REST, with the same validation and permission checks.
4. **One permission model.** Every API token belongs to a user and acts as that user. Token scopes (`read`, `write`, `admin`) can only narrow what the user may do, and a token can be limited to some projects.
   - Each project is open, or members only. In a project a person is a viewer (reads, comments), a member (also changes issues) or a manager (also its settings, people, boards and baselines); its lead and administrators are managers.
   - What you can't see answers exactly as what doesn't exist (404), on every surface: REST, MCP, search, links, events, SSE and AI.
5. **Safe by default for agents.**
   - MCP cannot delete issues.
   - Commands support `dry_run`.
   - Bulk commands are capped at 50 issues per call.
   - Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`), so a client can auto-approve reads and ask before writes.
   - The in-app assistant asks the user before every write.
6. **Everything is attributed.** The activity log records who made each change and through which channel: `web`, `api`, `mcp`, `assistant`, `automation`, `system` or `vcs` (a commit or pull request, through an integration), plus the token or integration name. History reads *"anna (via MCP · token 'claude-code') changed State: Open → In Progress"*. A change a workflow rule made says which rule, in its `data.automation`.
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
watcher: me #Unresolved sort by: updated desc
has: request sla: overdue
```

- Fields are referenced by name, and multi-word values work without quotes (`State: In Progress`).
- Supported: ranges (`a .. b`, `*`), negation (`-value`), `and` / `or` / parentheses, and relative dates (`today`, `{this week}`, `-14d`, and `Overdue`, any day before today). Dates are read in the asker's time zone (their profile's, or the server's), and a day of `created`, `updated` or `resolved` runs from their midnight to their next; a query's explanation names the zone when its dates depend on it. Workflow rules read them in the server's.
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
| Auth and setup | `POST /auth/login`, `POST /auth/logout`, `GET/POST /auth/setup`, `GET/PATCH /me` | First-run admin setup, sessions, profile. `GET /auth/setup` says how people sign in here (password, single sign-on). Your `timeZone` (an IANA name, or null for the server's, `serverTimeZone`) is where your dates are read: "today" in your searches and commands, your digest's hour, your email's times |
| Single sign-on | `GET /auth/oidc/start?next=`, `GET /auth/oidc/callback` | OpenID Connect, for browsers: the authorization code flow with PKCE, state and nonce; a new session on success |
| SAML sign-in | `GET /auth/saml/start?next=`, `POST /auth/saml/acs`, `GET /auth/saml/metadata` | SAML 2.0, for browsers (D27): an AuthnRequest by redirect, the signed response posted back, a new session on success; and a4a's service-provider metadata, for the identity provider |
| API tokens | `GET/POST /me/tokens`, `PATCH/DELETE /me/tokens/{id}` | Personal tokens with scopes, expiry and, optionally, the only projects they reach (`projects`); the secret is shown once and stored hashed; last-used time is tracked |
| Agents | `GET /agents`, `POST /users/{agent}/tokens`, `DELETE /users/{agent}/tokens/{id}` | Agents of their own (bot accounts administrators add), with their tokens, issued and revoked by administrators: with one, an agent acts as itself. An agent never makes its own; a person's are their own (D34) |
| Users | `GET/POST /users`, `GET/PATCH/DELETE /users/{id}` | Admin user management, roles (`admin`, `member`, `viewer`), bot users; administrators also see how each person signs in (`signIn`) |
| Projects | `GET/POST /projects`, `GET/PATCH/DELETE /projects/{key}` | Projects with short keys (`BACK`), leads, who sees them (`visibility`: `open` or `members`), AI triage mode; each says what you may do in it (`access`) |
| Project people | `GET/POST /projects/{key}/members`, `PATCH/DELETE /projects/{key}/members/{login}` | Who is in a project and their role (`viewer`, `member`, `manager`). Anyone who sees the project sees its people; its managers change them |
| Project groups | `GET/POST /projects/{key}/groups`, `PATCH/DELETE /projects/{key}/groups/{group}` | The groups with a role in a project, and who is in each (as a project's people are seen by anyone who sees it). Everyone in one has at least its role there; someone's role is the highest of their own and their groups'. Its managers change them |
| Groups | `GET/POST /groups`, `GET/PATCH/DELETE /groups/{id}`, `POST /groups/{id}/members`, `DELETE /groups/{id}/members/{login}` | Groups of people (D27). Anyone signed in sees them and who is in them; administrators make and fill them. One with `providerName` takes its people from the identity provider at each sign-in, never by hand |
| Project schema | `GET /projects/{key}/fields`, `PUT/DELETE /projects/{key}/fields/{fieldId}` | Which custom fields a project uses, which are required, and their defaults (its managers change them) |
| Custom fields | `GET/POST /fields`, `PATCH/DELETE /fields/{id}`, `POST/PATCH/DELETE /fields/{id}/values[/{valueId}]` | Field types: enum, state (with *resolved* flag), user, version, string, text, integer, float, date, period. Values can be shared or per-project, ordered and colored |
| Issues | `GET /issues?query=&sort=`, `POST /issues`, `GET/PATCH/DELETE /issues/{id}` | Search with the query language; create with fields, tags, parent and links in one call; partial updates with `expectedVersion` |
| Comments | `GET/POST /issues/{id}/comments`, `PATCH/DELETE /comments/{id}` | Markdown comments. `@login` mentions a person who can see the project: they're told, and watch the issue. On a help desk request, `visibility: "public"` also sends a comment to the requester, and takes someone who may change the issue (not a viewer); comments are `internal` unless you say so |
| Watchers | `GET /issues/{id}/watchers`, `PUT/DELETE /issues/{id}/watchers/me` | Who watches an issue and why (reported it, assigned, commented, mentioned, leads its project, chose to), and watching or not yourself. Idempotent; a token needs `write` |
| Notifications | `GET /notifications?unread=&issue=`, `GET /notifications/count`, `POST /notifications/read`, `PATCH /notifications/{id}`, `GET /notifications/stream` (SSE) | Your inbox, latest first: each notification folds the events on one issue that came close together, with the strongest reason (`assigned`, `mentioned`, `request`, `rule`: a workflow rule tells you, `watching`, `subscribed`) and its words, and for `subscribed` which subscription brought it. Mark read by ids, issue or all, `until` the latest you saw; the stream sends your unread count as it changes |
| Subscriptions | `GET/POST /subscriptions`, `GET/PATCH/DELETE /subscriptions/{id}` | Yours, to a `project` (its `new` issues, or `all`: every change in it) or a `savedSearch` (an issue coming into it, `new`, or any change to one in it, `all`), each saying whether it emails. Posting one for the same project or search again changes it. What a search finds already isn't news. A token needs `write` to change them |
| Email | `GET/PATCH /me/notification-settings`, `GET/POST /unsubscribe?token=` (public) | What comes by email: `all`, `direct` (mentions, assignments, new help desk requests, what a workflow rule tells you) or `none` (subscriptions too), and a daily digest at `digestHour` in your time zone. The unsubscribe link is signed, per kind (one subscription's email, for a subscription's), and takes a mail client's one-click POST (RFC 8058) |
| Help desk | `PATCH /projects/{key}` (`settings.helpdesk`), `GET /issues/{id}/request`; public: `GET /help/{key}`, `POST /help/{key}/requests`, `GET /help/requests/by-token`, `POST /help/requests/by-token/replies` | Open a project's public form, set its first-response target, and have the form ask for a proof of work (`captcha`); who asked for an issue, how (form or email), and where it stands against the target; for people outside, the form (with its CSRF token and cookie, and its challenge when the desk asks for one), filing a request, and their request's page and replies, by a tracking token in the `x-tracking-token` header |
| Help desk by email | `GET/PUT /projects/{key}/helpdesk/mail`, `POST/DELETE /projects/{key}/helpdesk/mail/secret`, `GET /projects/{key}/helpdesk/mail/log`; for mail providers: `POST /mail/inbound/{key}` | A desk's address, the secret its mail provider posts with (shown once), and what came in over 30 days and what became of each (its managers). The provider posts each message raw, with the secret as HTTP Basic's password; it becomes a request, the requester's reply, or nothing, and the answer says which (D30) |
| Links | `GET/POST /issues/{id}/links`, `DELETE /links/{id}`, `GET /link-types` | Relates, depends on / is required for, duplicates, subtask of / parent for |
| Tags | `GET/POST /tags`, `PATCH/DELETE /tags/{id}`, plus `addTags` / `removeTags` on issues | Colored tags |
| Time tracking | `GET/POST /issues/{id}/work-items`, `DELETE /work-items/{id}` | Log work (`1h 30m`); spent time is rolled up on the issue |
| Attachments | `GET/POST /issues/{id}/attachments`, `POST /comments/{id}/attachments`, `GET/POST /articles/{id}/attachments`, `GET/DELETE /attachments/{id}`, `GET /attachments/{id}/content`, `GET /attachments/{id}/text`, `GET /attachments/limits` | Files on issues, comments (the author's own) and articles. Upload as `multipart/form-data` with the file in a part named `file` (`curl -F file=@build.log`), streamed, one per request: up to `ATTACHMENT_MAX_MB` (20) each and `ATTACHMENTS_PER_ISSUE_MB` (100) for an issue with its comments, or an article; 413 otherwise. The type is read from the bytes, never from the name or the request; the name is made safe; the SHA-256 is kept and is the ETag. `content` serves PNG, JPEG, GIF and WebP `inline` and everything else as an `attachment`, with `nosniff` and `Content-Security-Policy: sandbox`; `?download=1` downloads images too. It answers one byte range (`Range: bytes=…`) with 206 and `Content-Range`, 416 past the end, and honours `If-Range`; several ranges get the whole file. `text` reads a text file in slices of up to 128 KB, from an offset or its end (`tail=true`). A file says `text` when it can be read so, and `play` (`audio` or `video`) when the web app plays it in place. Who added a file may delete it, and so may anyone who may change its project. When the store of files (a bucket, `ATTACHMENT_STORAGE=s3`) fails, uploads and downloads answer 503 `storage_unavailable` |
| Knowledge base | `GET/POST /articles`, `GET/PATCH/DELETE /articles/{id}`, `GET /projects/{key}/articles`, `GET /articles/{id}/versions[/{version}]`, `POST /articles/{id}/versions/{version}/restore`, `GET /issues/{id}/articles` | Articles per project, by readable id (`BACK-A-3`), in a tree: `parent` and `position` place them, and a move under one of its own descendants is refused. Markdown, saved as a new version each time (with `expectedVersion` for 409 on a newer save); a version comes with its diff against the one before, and an old one can be brought back as a new one. `GET /articles?query=` searches titles and bodies (full text, prefixes, near misses on titles), with snippets. Ids written in articles, descriptions and comments are mentions: an article lists the issues and articles that mention it, and `GET /issues/{id}/articles` the articles that mention an issue. An article with articles under it can't be deleted |
| Activity | `GET /issues/{id}/activity`, `POST /events/{id}/undo` | Full change history with actor and channel. A change an agent made on its own says whether a person can still undo it (`undo`: `possible`, `changed_since` with what, `undone` by whom); undoing it puts its fields, summary, description, tags or link back as the person asking, all or nothing, once (409 `changed_since`, `already_undone`) |
| Search helpers | `POST /search/parse`, `GET /search/suggest`, `POST /search/count` | Validate and explain a query, autocomplete, and counts grouped by any field (dashboards, reports) |
| Commands | `POST /commands`, `POST /commands/parse` | Apply or preview a command on up to 50 issues |
| Saved searches | `GET/POST /saved-searches`, `PATCH/DELETE /saved-searches/{id}` | Personal and shared saved queries |
| Agile boards | `GET/POST /boards`, `GET/PATCH/DELETE /boards/{id}`, `GET /boards/{id}/view?sprint=` | Kanban or scrum boards: columns mapped to State values, WIP limits, swimlanes, board filter query |
| Sprints | `GET/POST /boards/{id}/sprints`, `PATCH/DELETE /sprints/{id}`, `POST /sprints/{id}/issues` | Sprint planning |
| Schedule (Gantt) | `GET /projects/{key}/schedule?query=&baseline=`, `POST /projects/{key}/schedule/what-if` | Critical-path schedule: early/late dates, slack, critical path, summary roll-ups, dependency cycles, finish date. *What-if* takes overrides (delay, estimate, assignee) and returns the impact without saving |
| Resources | `GET /projects/{key}/resources?from=&to=`, `POST /projects/{key}/level` | Per-person daily load against each day's capacity (half on a half day away, none on a day away, with `away` saying which part, never why), over-allocated days, levelling preview (`dryRun`, default) or apply (`within_slack`, the default, or `allow_delay`). Applying writes the Start date of the tasks moved for resources, in one transaction; pass the preview's `starts` as `expect` and nothing is applied if the plan changed since (409). For a plan with no start date of its own, `keepsStart` says where applying fixes its start, so the plan stays as proposed |
| Costs | `GET /projects/{key}/costs?baseline=` | Budget, planned and actual cost by task and by person; earned value (PV, EV, AC, CPI, SPI, EAC) against a baseline |
| Baselines | `GET/POST /projects/{key}/baselines`, `GET/DELETE /baselines/{id}` | Snapshot the plan, then compare start, finish, effort and cost variance per task |
| Plan settings | `PATCH /projects/{key}` (`plan`), `PATCH /users/{id}` (`hourlyRate`, `capacityHoursPerDay`) | Working days, hours per day, holidays, project start, budget and currency; per-person rate and capacity |
| Days away | `GET /absences?user=&from=&to=`, `POST /absences`, `PATCH/DELETE /absences/{id}` | A person's days away (whole days, or a `half`: `morning`, `afternoon`), which plans skip for their work (D36). Anyone may read when; `kind` and `note` are null except for the person, administrators and whoever entered it. A person enters their own; a manager of a project they work in, or an administrator, theirs (`user`). Days out of order, more than a year, half of several days or overlapping their others are refused, each saying how to put it right; a change takes `expectedVersion` |
| Preferences | `GET/PATCH /me/preferences` | What a person chose to see, kept for them across devices: `loadWindow`, the load grid's days on every plan (`{ "preset": "2w" \| "1m" \| "3m" \| "plan" }` from today, or `{ "from", "to" }`; null for the plan's own) |
| Reports | `GET /reports/burndown?board=&sprint=&by=`, `GET /reports/flow`, `GET /reports/created-resolved?interval=`, `GET /reports/cycle-time?start=`, `GET /reports/time?author=`, each also as `.csv` (`/reports/time.csv?rows=entries\|person\|issue\|project\|week`) | Worked out from the activity log and the time logged, for a project or a query, `from`/`to` or `days`, in `timeZone` (the server's by default). A sprint's burndown by estimate or by count, with the ideal, every change to its scope, and how it stands in a sentence; issues in each state day by day; created against resolved; cycle time with its percentiles; time by person, issue, project and week, against estimates |
| Dashboards | `GET/POST /dashboards`, `GET /dashboards/default`, `GET/PATCH/DELETE /dashboards/{id}` | A person's widgets (a report with its parameters, a saved search's count or list, a note), private or shared; `expectedVersion` on a change, 409 if someone changed it since. Each viewer sees a shared one's widgets as they may |
| Imports | `POST /imports?project=` (the CSV as the body, `text/csv`), `POST /imports/from-api`, `POST /imports/{id}/fetch`, `GET /imports`, `GET /imports/{id}`, `PUT /imports/{id}/mapping`, `POST /imports/{id}/check`, `POST /imports/{id}/run`, `GET /imports/{id}/rows?status=`, `POST /imports/{id}/undo`, `DELETE /imports/{id}` | Jira and YouTrack CSV exports, for a project's managers: columns found from their headers, values mapped (states, people, priorities, sprints), a dry run with the problems row by row, then a job with its progress. Each issue keeps its original dates and reporter, recorded as imported, with its comments and time; links and parents follow in a second pass. Rerunning updates what changed and never makes an issue twice (known by its key there); undo takes back the issues it made that nobody has worked on since. `from-api` reads the issues a YouTrack query or a Jira JQL matches instead (status `fetching`, then `ready`), with each issue's comments, work items and files; its `credentials` (a token, and for Jira Cloud the account's email) are used and never kept, so `run` takes them again when files are to come, and `fetch` carries on a read that stopped |
| Events | `GET /events?after=`, `GET /events/stream?after=` (SSE) | A durable change feed: poll it, or stream it live. A stream resumes from its last event id, on any instance, missing nothing |
| Webhooks | `GET/POST /webhooks`, `PATCH/DELETE /webhooks/{id}`, `GET /webhooks/{id}/deliveries`, `POST /webhooks/{id}/test` | Signed push notifications with retries and a delivery log |
| Workflow rules | `GET/POST /rules`, `GET/PATCH/DELETE /rules/{id}`, `POST /rules/preview`, `POST /rules/check`, `GET /rule-runs?project=&rule=` | Rules that change issues on their own, as the workflow agent: **on a change** (an issue is created, changes, optionally only a named field, or gets a comment) when the issue then matches a query; **on a schedule** (every hour, day or weekday at a time) for every issue that matches; or a **guard**, which refuses a change that would make an issue match one query without matching another, with a message. Preview shows problems where they are, how many issues match now, and what the command would change on a few of them (the executor's dry run). `PATCH {enabled: false}` turns one off. The run log says, issue by issue, applied, unchanged, failed, skipped or refused, and why. Reading a project's rules and runs needs only reading the project, and those of a project you can't see answer as missing (404). Managing them needs one of its managers; rules for every project (`project: null`), an administrator whose token reaches every project. A project's rule acts only on, and names only, its own project's issues. A change or scheduled rule can also take `related` (a further condition: `{of: "parent" \| "subtasks" \| "siblings" \| "linked", phrase, match: "all" \| "any", query}`), `target` (what it acts on: `{to: "issue" \| "parent" \| "subtasks" \| "linked", phrase}`), `notify` (`{to: ["assignee", "reporter", "watchers", "managers"], people: [logins], message}`) and `call` (`{webhook: id}`: administrators only, an https webhook, which then can't be deleted while the rule calls it) (D32) |
| Version control | `GET/POST /vcs/integrations`, `PATCH/DELETE /vcs/integrations/{id}`, `POST /vcs/integrations/{id}/secret`, `GET /vcs/integrations/{id}/deliveries`, `POST /vcs/integrations/{id}/test`, `GET /issues/{id}/vcs` | Administrators add an integration (`github`, `gitlab`, `bitbucket` for Bitbucket Cloud, `bitbucket-dc` for Data Center, `gitea` for Gitea and Forgejo) and get its webhook URL and a secret, shown once (a new secret is shown once too). Bitbucket Data Center's needs its `baseUrl` (https); either Bitbucket takes an `accessToken` to read the commits a delivery leaves out, never shown again (`hasAccessToken` says whether it has one; `null` removes it). Deliveries, refused ones included, are logged; a test sends one through a4a's own handling. An issue's commits and pull requests, with the command each commit gave and whether it was applied |
| Deliveries from version control | `POST /vcs/hooks/{id}` (public) | Checked in constant time: an HMAC-SHA256 of the raw body (GitHub's `X-Hub-Signature-256`, Bitbucket's `X-Hub-Signature`, Gitea's `X-Gitea-Signature` and Forgejo's `X-Forgejo-Signature`), or `X-Gitlab-Token`; rate-limited; handled once per delivery id (`X-GitHub-Delivery`, GitLab's `Idempotency-Key` or `X-Gitlab-Event-UUID`, Bitbucket's `X-Request-UUID` or `X-Request-Id`, `X-Gitea-Delivery`). Bitbucket Data Center's unsigned Test connection ping is answered and nothing more. A push links each commit to the issues its message mentions; `BACK-12 #Fixed` or `BACK-12 #State Fixed Assignee anna` applies the command after `#`, as the commit's author in a4a (by a confirmed email, or a login the provider vouches for), if they can change the project's issues, else links only and says why. Pull and merge requests are linked by title, branch and description, and keep their state (open, merged, closed). The reply names no issue and no person, since providers show it to the repository's administrators; the delivery log says what was done |
| Your emails | `GET/POST /me/emails`, `POST /me/emails/send`, `GET/POST /me/emails/confirm`, `POST /me/emails/primary`, `DELETE /me/emails/{id}` | Your primary email and others, each confirmed or not. Adding one mails a link to it; the link confirms it only for you, signed in, once, within 24 hours (`GET` says which email a link confirms, `POST` confirms). A confirmed email can be your primary one. Signed in only: a token reads them and changes none. Without SMTP, `canSendLinks` is false and an administrator confirms |
| Emails and logins (admin) | `GET/POST /users/{id}/emails`, `DELETE /users/{id}/emails/{emailId}`, `GET/POST /users/{id}/provider-logins`, `DELETE /users/{id}/provider-logins/{loginId}` | An administrator adds someone's email, confirmed, and records their login at a provider (for Bitbucket Cloud, the account id or UUID). A person reads their own. A commit is its author's when its confirmed email or the login the provider names is theirs, and nobody's when those name two people |
| AI | see [section 7](#7-ai-endpoints) | Triage, duplicates, natural language → query or command, summaries, chat |
| Settings | `GET/PATCH /settings` | Instance name, default AI triage mode |
| System | `GET /health`, `GET /openapi.json` | Probes, spec |

**Example: what scripts can do with it**

- **CI bot**
  1. On a red build it sends `POST /issues` with `Idempotency-Key: build-4711`, `Type: Bug` and `tag: ci-failure`, so a retry never duplicates the issue.
  2. When the build goes green again it sends `POST /commands` with `State Fixed`.
- **Commit hook.** Built in: add a GitHub or GitLab integration, and a commit message like `BACK-12 #Fixed` links the commit and applies the command as its author. Without one, a hook can send `POST /commands {issues:["BACK-12"], command:"State Fixed", comment:"Fixed in a1b2c3"}`.
- **Weekly report.** `POST /search/count {query:"project: BACK #Unresolved", groupBy:"Priority"}`.
- **Chat bot.** Read `GET /events/stream` and post "BACK-12 moved to In Progress by anna".
- **Stand-up bot.** `GET /reports/burndown?board=Backend sprints` says how the sprint stands, in a sentence: "Behind: 26h left, where the ideal had 20h left as today began".
- **Timesheets.** `GET /reports/time.csv?rows=entries&from=2026-11-01&to=2026-11-30` for the month's entries, as a spreadsheet opens them.
- **Moving from Jira.** `POST /imports?project=WEB` with the export, then `PUT /imports/{id}/mapping` for what wasn't found, `POST /imports/{id}/check`, and `POST /imports/{id}/run`; follow it with `GET /imports/{id}`.
- **Moving from YouTrack, without an export.** `POST /imports/from-api` with `{"project": "WEB", "source": "youtrack", "url": "https://example.youtrack.cloud", "query": "project: WEB", "credentials": {"token": "perm:…"}}`. Follow `GET /imports/{id}` until it is `ready`, then map, check and run as above, giving the same `credentials` to `run` when it brings files. A Jira Cloud token goes with its account's `email`; a Jira Data Center personal access token goes alone. Not over MCP: an agent would pass the other tracker's token through a model's context.

## 5. MCP server

**Transport and auth**

- **Endpoint:** `POST /mcp` on the same server, using Streamable HTTP (stateless) with `Authorization: Bearer …`. The tool calls act as the token's user.
- **Signing in (OAuth 2.1, docs/architecture.md D28):** a client that signs in by itself needs only the address. Without a token, `/mcp` answers 401 with `WWW-Authenticate: Bearer realm="a4a", resource_metadata="<PUBLIC_URL>/.well-known/oauth-protected-resource/mcp", scope="read write"`, and the client goes from there (5.6). Its access token (`a4o_…`) works at `/mcp` alone.
- **API tokens** (`a4a_…`) work too, for clients that don't sign in by themselves.
- **stdio:** for clients that only speak stdio, the `a4a-mcp` bridge connects stdio to `/mcp` using `A4A_URL` + `A4A_TOKEN`.

### 5.1 Tools

| Tool | What it does | Kind |
|---|---|---|
| `get_current_user` | Who the agent is acting as: role, token scopes, and the projects a limited token reaches; `agent: true` when its token was issued to an agent's own account, which acts as itself | read |
| `list_projects` | Projects with key, name, description, open-issue counts | read |
| `get_project` | A project's fields and allowed values (states marked resolved/unresolved), link types, tags, people | read |
| `search_issues` | Run a query. Returns total + compact rows (id, summary, state, priority, type, assignee, updated). Invalid queries return the error position and a suggestion | read |
| `get_issue` | One issue in full: fields, description, links (subtasks, blockers, duplicates), recent comments, spent time, pending AI triage suggestions, its files, the articles that mention it, and the commits and pull requests that mention it (with each commit's command and whether it was applied) | read |
| `count_issues` | Count issues matching a query, optionally grouped by a field ("open bugs by priority") | read |
| `get_activity` | Recent changes: who changed what and when, filtered by issue, project, query or time ("what happened since yesterday?") | read |
| `find_similar_issues` | Rank existing issues by similarity to some text. Use before filing an issue to avoid duplicates | read |
| `list_users` | Find people, and agents of their own (`bot: true`), by name or login, for assignment; a4a's own agents aren't offered | read |
| `get_board` | Board columns with their cards for a sprint: a status overview | read |
| `create_issue` | Create an issue with fields, tags, parent and links. The result includes likely duplicates so the agent can link or close | write |
| `update_issue` | Change summary, description or fields; add or remove tags | write (idempotent) |
| `apply_command` | Apply a command to 1–50 issues, with optional comment. Use `dry_run` to preview | write |
| `add_comment` | Comment on an issue (Markdown); `@login` mentions someone. On a help desk request, `public: true` also emails it to the requester | write |
| `link_issues` / `unlink_issues` | `"BACK-5 depends on BACK-2"`, `"BACK-9 duplicates BACK-1"`, `"BACK-7 subtask of BACK-3"` | write |
| `log_work` | Log time on an issue (`"1h 30m"`, optional date and note) | write |
| `get_schedule` | The project plan: finish date, critical path, slack, late tasks, and variance against a baseline. Optional `what_if` overrides answer *"what slips if BACK-12 slips 3 days?"* without saving anything | read |
| `get_resource_load` | Who is over-allocated, and on which days; and who is away when (`awayDays`), never why | read |
| `get_cost_report` | Budget vs. planned vs. actual cost, plus earned value against a baseline | read |
| `level_resources` | Propose (`dry_run`, default) or apply a levelled schedule that resolves over-allocation; `expect` applies only the proposal the person agreed to | write |
| `create_baseline` | Snapshot the current plan under a name | write |
| `list_project_members` | Who is in a project and their role, by name or through a group (with who is in each group), whether it is members only, and what you may do in it. Assign a members-only project's issues only to its people | read |
| `read_attachment` | Read a text file on an issue, comment or article (a log, a stack trace), up to 128 KB at a time, from an offset or from its end; images and other binary files are refused with where to download them | read |
| `attach_file` | Attach a small file (256 KB at most, given as `text` or `base64`) to an issue, the agent's own comment, or an article. It goes through the same checks as any upload, and is recorded with the token's name | write |
| `search_articles` | Find knowledge base articles by words in titles and bodies, in one project or all, with snippets; without words, the latest changed | read |
| `get_article` | An article in full, in Markdown: where it sits, what's under it, its version, what mentions it, and its files; or an earlier version | read |
| `create_article` | Write an article, at the top of a project's tree or under another; the preview says where and shows its start | write |
| `update_article` | Change an article's title or body (a new version) or move it; `expected_version` refuses to overwrite a newer save. The preview shows the lines it adds and removes | write (idempotent) |
| `get_report` | A report, worked out from history: `burndown` (is the sprint on track, and what changed its scope), `flow` (issues in each state, day by day), `created_resolved`, `cycle_time` (how long work takes, with percentiles) or `time` (logged, by person, issue, project and week, against estimates) | read |
| `list_notifications` | What's waiting for the token's person, grouped by issue: assigned, mentioned, help desk requests, changes and comments on what they watch, and what they subscribed to (`because` says which subscription), each with its changes and words. Unread only by default | read |
| `mark_notifications_read` | Mark the person's notifications read: by id, one issue's, or all | write (idempotent) |
| `watch_issue` / `unwatch_issue` | Watch an issue for the person, or stop until they take part again | write (idempotent) |
| `list_watchers` | Who watches an issue, and why | read |
| `list_subscriptions` | The projects and saved searches the person subscribes to, and what each tells them of. A notification's `because` names the one that brought it | read |
| `subscribe` | Subscribe the person to a project (its new issues, or every change) or to a saved search, by name or id (an issue coming into it, or any change to one in it); `events: "none"` ends it. Subscribing again changes it | write (idempotent) |
| `list_rules` | A project's workflow rules, each in words ("When an issue is created, if it matches …, then apply …"), with when it next runs, what it did last, and anything that no longer reads | read |
| `preview_rule` | What a rule would do, saved or described, without saving or changing anything: its problems (with the text fixed where a4a knows the fix), how many issues match now, what its command would change on a few (a dry run), and, for a rule across issues, which related issues it would act on and whom it would tell | read |

Every tool and resource sees only what its token's person may see, in the projects the token reaches: a hidden project or issue is "not found", exactly as a missing one.

Deliberately **not** exposed over MCP in v1: deleting issues, articles or files, user and permission admin (changing a project's people included), webhooks, settings, integrations, a help desk's settings, email preferences (they're the person's own, in the web app), undoing an agent's change (a person decides that, D34), and making or changing workflow rules. A rule acts later, on its own, on every issue that ever matches it, outliving the conversation and the caps on a command (50 issues, a dry run first); and an agent reads issue text, which anyone can write. So agents can list rules and preview one (`preview_rule`), and a person makes it, on the Rules page or over REST.

`get_issue` says when an issue is a help desk request (who asked, whether by the form or by email, and its first-response target) and which comments are public, so an agent knows what the requester has seen.

**Why agents may attach files, and only small ones.** Agents produce things worth keeping beside an issue: a log excerpt, a failing test's output, a patch, a script that reproduces a bug. So `attach_file` exists, through the same service as every upload: the type is read from the bytes, the per-issue cap applies, the file is served as a download, and its activity names the token. But a file over MCP is base64 or text inside a tool call, so every byte passes through the model's context: 256 KB is about what an agent can sensibly write out. A larger file goes to `POST /issues/{id}/attachments` with the same token.

### 5.2 Resources (read-only context a client can attach)

| URI | Content |
|---|---|
| `a4a://guide/query-language` | The search syntax reference, with examples |
| `a4a://guide/commands` | The command syntax reference |
| `a4a://projects/{key}` | A project's schema: fields, values, link types |
| `a4a://issues/{id}` | An issue rendered as Markdown (lists the 50 most recently updated) |
| `a4a://articles/{id}` | A knowledge base article as Markdown (lists the 50 most recently changed) |

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

- **Claude Code, end to end.** `/mcp__a4a__work_on_issue BACK-12` → `get_issue` → `apply_command("for me In Progress")` → work in the repo → `add_comment("Root cause: …")` → `create_issue(... parent BACK-12)` for a follow-up → `apply_command("State Fixed", comment: "Fixed in PR #123")`.
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

The web UI has a **Connect an agent** page that creates a token and fills in these snippets for you. A client that signs in by itself needs none of it: `claude mcp add --transport http a4a http://localhost:3000/mcp`, then `/mcp` in Claude Code to sign in; in Claude, a custom connector with your a4a's https address and `/mcp`, reachable from the internet.

### 5.6 Signing in with OAuth

a4a is the authorization server for its own `/mcp`, following MCP's authorization specification. Every address below is `PUBLIC_URL`'s. They answer only when `PUBLIC_URL` is https (or this computer) and `MCP_OAUTH` isn't `false`; otherwise the metadata is 404 and `/mcp` asks for a token as before. The protocol's endpoints answer any origin, without credentials; nothing else does.

| Endpoint | What it is |
|---|---|
| `GET /.well-known/oauth-protected-resource/mcp` (and `/.well-known/oauth-protected-resource`) | RFC 9728: `resource` is `PUBLIC_URL/mcp`, its authorization server is `PUBLIC_URL`, its scopes `read` and `write` |
| `GET /.well-known/oauth-authorization-server` | RFC 8414: the endpoints below; `response_types` `code`; grants `authorization_code` and `refresh_token`; PKCE `S256`; client authentication `none`; `iss` in the answer (RFC 9207) |
| `POST /oauth/register` | RFC 7591, JSON. Public clients only: `client_id`, never a secret. `redirect_uris` are https, or http to `127.0.0.1`, `[::1]` or `localhost`. 20 an hour per address |
| `GET /oauth/authorize` | The consent page, in the browser: `response_type=code`, `client_id`, `redirect_uri`, `code_challenge` with `code_challenge_method=S256`, `state`, `scope`, `resource` |
| `POST /oauth/token` | Form-encoded. `grant_type=authorization_code` with `code`, `code_verifier`, `client_id`, `redirect_uri`; or `grant_type=refresh_token` with `refresh_token`, `client_id` (and a narrower `scope`, if wanted). Optional `resource`. Answers `access_token`, `token_type`, `expires_in` (3600), `refresh_token` and `scope`, with `Cache-Control: no-store` |
| `POST /oauth/revoke` | RFC 7009: `token`, `client_id`. A refresh token revokes everything issued since its code; an access token, itself. Always 200 |

- **Scopes.** `read`, and `write`, which brings `read` with it. Words a4a doesn't know (`openid`, `offline_access`) are left out, not refused, and the token's `scope` says what was given. Never `admin`.
- **The consent page** shows who asks (the name the app gave itself, said to be its own), where it sends the person back, what it may do, and where: every project, or the ones chosen. A person whose role only reads can't allow changes. Allowed once, an app asking for no more carries on without asking, for 90 days from its last use.
- **Errors** are OAuth's: `{ "error", "error_description" }`.
  - On the token endpoint: `invalid_request`, `invalid_client` (401), `invalid_grant`, `unauthorized_client`, `unsupported_grant_type`, `invalid_scope`, `invalid_target`.
  - Sent back to the app: `access_denied`, `invalid_request`, `unsupported_response_type`, `invalid_target`, with its `state` and `iss`.
  - An unknown app, or a redirect it didn't register, is shown on a4a's page and sent nowhere.
- **Lifetimes.** A code lasts two minutes and works once. An access token lasts an hour. A refresh token lasts 30 days and is replaced at each use. A code or refresh token used twice revokes every token since its code.
- **Behind the consent page** (REST, signed in, a4a's own page only): `GET /api/v1/oauth/authorize` checks a request, and `POST /api/v1/oauth/authorize` records the person's decision and says where the browser goes. `GET /api/v1/me/oauth-grants` lists the apps a person allowed; `DELETE /api/v1/me/oauth-grants/{id}` revokes one, and every token it holds, at once.

## 6. Events and webhooks

An agent or integration can react to changes instead of polling.

**Event types**

- `issue.created`, `issue.updated` (with the list of field changes), `issue.deleted`
- `comment.created`, `comment.updated`, `comment.deleted`

What notifications need is in `data`, as logins: `assigned` (new assignees) and `mentions` (people newly mentioned who can see the project) on `issue.created`, `issue.updated`, `comment.created` and `comment.updated`; `watchers` on `issue.deleted`, since they go with the issue. A help desk request's events come through the `helpdesk` channel, by the `helpdesk` agent, with `data.requester.name` (never their email); a public comment has `data.visibility: "public"`. Watching, reading and email preferences are each person's own, and are no events.
- `link.created`, `link.deleted`
- `work.logged`
- `ai.triage.completed`
- `baseline.created`
- `project.member.added`, `project.member.changed`, `project.member.removed`, `project.visibility.changed`
- `project.group.added`, `project.group.changed`, `project.group.removed`: a group's role in a project (`data` names the group; a group deleted carries `deleted: true`)
- `attachment.added`, `attachment.removed` (with the file's name, size, type, checksum and link; on an issue, its comment's id when it's a comment's)
- `article.created`, `article.updated` (with what changed: title, content, parent, position), `article.deleted`
- `sprint.issue_added`, `sprint.issue_removed`: an issue joined or left a sprint (`data` names the sprint and its board), the history a burndown reads
- `commit.linked` (with the command it gave, whether it was applied and why), `pull_request.linked`, `pull_request.updated` (its state moved: open, merged, closed)
- `rule.notified`: a workflow rule told people about the issue (`data.message`, its words; `data.people`, the logins it told; `data.to`, whom it asked for). The notifier delivers it, with the reason `rule`
- `rule.called`: a workflow rule called a webhook about the issue (`data.webhook`; `changes`, what the rule changed on it). It goes only to that webhook, never to one that listens for events, so a webhook can't subscribe to it

A change a workflow rule made carries `data.automation`: the rule's id and name, and how many rules deep in a chain it is.

An event's `actor.isBot` says an agent's account acted as itself (a4a's own, such as triage, or an agent of its own with a token issued to it). A person's undo of an agent's change is `issue.updated` (or `link.created`, `link.deleted`) with `data.undoes`: the event it undoes (D34).

Every consumer sees only the events of projects it can see: `GET /events` and `GET /events/stream` filter by the caller's access, and leave out a link whose other end it can't see. Webhooks (made by administrators) get every event.

**Payload**

```json
{ "id": 1042, "type": "issue.updated", "occurredAt": "2026-11-15T10:12:00Z",
  "actor": { "login": "anna", "channel": "mcp", "token": "claude-code", "isBot": false },
  "project": "BACK", "issue": { "id": "BACK-12", "summary": "…", "url": "…" },
  "changes": [ { "field": "State", "from": "Open", "to": "In Progress" } ] }
```

**Delivery**

- **Webhooks:** filtered by event type and project, signed with `X-A4A-Signature: sha256=<HMAC of body>`, retried up to 3 times with backoff, every attempt logged.
- **`GET /events/stream`:** the same payloads over SSE, in id order, from whichever instance serves it.
  - Each frame's `id` is the event id. On reconnect, send it back as `Last-Event-ID` (browsers do this by themselves) or as `?after=`, and the stream first replays what you missed, then goes on live, without repeats.
  - More than 1000 missed events get a `resync` event instead, whose `id` is where the stream goes on from: re-read what you show, or page through `GET /events?after=`.
  - `project` and `types` filter the replay too.
- **`GET /events?after=<id>`:** a durable feed to catch up after downtime.

## 7. AI endpoints

These run on Claude (`claude-opus-5-5`) when `ANTHROPIC_API_KEY` is set, or on DeepSeek, Qwen or another service that speaks Anthropic's Messages API, chosen with `AI_PROVIDER` (see the README). `GET /ai/status` says who serves the model, which model, and why the AI is off when it is. Without a key they return `503 ai_disabled`, and the non-AI parts keep working (lexical similar-issue search included).

| Endpoint | What it does |
|---|---|
| `POST /ai/query` | Natural language → query. *"critical bugs assigned to me updated this week"* → `Type: Bug Priority: Critical for: me updated: {this week}`. The query is validated by the real parser; on a parse error the model gets the error and retries once |
| `POST /ai/command` | Natural language → command for the selected issues, returned with a dry-run preview. *"close as duplicate of BACK-7 and assign to anna"* |
| `POST /ai/similar` | Duplicate check while typing. Lexical candidates (Postgres full-text + trigram) are returned instantly; with `judge: true` the AI labels each as *duplicate*, *related* or *different*, with a reason |
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
- **Apps that sign in (OAuth).**
  - The person chooses what each app may do and where, on a4a's own page, and revokes it under Agents and tokens.
  - Its tokens are hashed, short-lived, work at `/mcp` alone, and never carry `admin`.
  - The activity names the app.
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
- **Notifications.** An agent sees its person's inbox (`list_notifications`, with `read`), and changes it only with `write`. What's in it was written by people, and is information, not instructions.

## 8a. The help desk's public surface

People outside the team reach a project's help desk without signing in, so these routes are built to tell them nothing beyond their one request:

- **The form** (`/help/<KEY>`) answers the same 404 whether the project doesn't exist or its help desk is closed. Posting needs an `Origin` of this server, and a form token: signed, naming the project and a nonce in a `SameSite=Strict` cookie, and good for 6 hours. A field hidden from people (`website`) catches bots: filled in, the answer is the usual one and nothing is filed. Limits: 5 requests per address in 15 minutes, 3 per email an hour, 120 per help desk an hour; bodies over 48 KB are refused, and each field has its own limit.
- **A request is filed as an issue** reported by the `helpdesk` agent for the requester, who isn't a user: their email and name are kept apart, as a requester, never among people to assign or mention. What they write mentions nobody.
- **The tracking token** is 256 random bits, kept only as a SHA-256 hash. Each email to the requester carries a fresh one, minted as it's sent, so none waits in plain text; every one stays good for the request until it's deleted. In a link it sits in the fragment (`/request#hdt_…`), so it never reaches a server's logs or another site's `Referer`; to the API it travels in a header. Any wrong token, malformed or not, gets the same 404.
- **The request's page** shows its summary, its state, what the requester wrote and the public replies, never an internal comment, a field, an issue id or anyone's email but their own. The requester's replies are public comments that tell the issue's watchers.
- **A proof of work, when the desk asks for one** (`settings.helpdesk.captcha`). The form comes with a challenge the server signed: find the number up to `maxnumber` whose SHA-256 of `salt` and number is `challenge`. The browser finds it with WebCrypto, in a worker of the site's own, and the request carries it as `captcha`; the server checks it, for that desk and while it's good (30 minutes), and takes it once. Nothing to solve by hand and nothing from another site: it makes each request cost a bot a moment, not a person. A wrong or spent answer is `400 captcha_failed`, an old one `400 captcha_expired`; the page fetches a new challenge either way.
- **By email** (D30). A desk with an address takes requests and answers by mail, posted by its mail provider to `POST /mail/inbound/<KEY>` or read from the server's shared mailbox. The provider authenticates with the desk's secret as HTTP Basic's password; a desk that doesn't exist, takes no mail, or has another secret answers the same 401, and such posts are limited per address. Each message counts once (by Message-ID). A reply is taken only from the requester's own address, to a reply address whose token is the request's, or answering an email a4a sent them (whose Message-ID is random). Auto-replies, bounces, list mail and a4a's own are set aside; nobody is ever told of what was set aside or refused, so a forged sender gets no mail. Limits: 5 new requests per sender an hour, 30 replies per request, 300 messages per desk; 25 MB a message (`HELPDESK_MAIL_MAX_MB`).
- **What's missing:** checking that the email is the requester's before anything is filed (anyone can file in another's name, by the form or by forging a sender, and the confirmation then goes to that address, so the per-email limits cap it; a desk's mail is refused when its own server says it failed DMARC); and attachments on the form (by email they come). The limits are shared by every instance; behind a proxy, set `TRUST_PROXY` so they count the client's address rather than the proxy's.

## 9. Open questions

These are the decisions worth thinking through together. v1 ships with the defaults in brackets.

1. **Deletes over MCP.** Should agents ever delete issues? [No. Agents resolve instead, for example `State Obsolete`.]
2. **Agents as teammates** (later). Assignable bot users that pick up issues assigned to them and report back, triggered by webhooks. This was the AI feature not picked for v1; the event feed and MCP make it a small step.
3. **OAuth 2.1 for remote MCP** (later). Needed for claude.ai custom connectors and one-click sign-in from MCP clients. [v1 uses bearer tokens. What it would take is in `docs/architecture.md`, D16.]
4. **Per-project token restrictions.** Done: a token can be limited to projects, e.g. one that only touches `BACK`.
5. **VCS integration.** Done: GitHub and GitLab integrations link commits and pull requests, and `BACK-12 #Fixed` applies as the commit's author, by an email an administrator set or confirmed, or the identity provider verified. Still open: several emails per person, or a mapping from a provider's logins, so a commit under a no-reply address can run commands too.
6. **Partial responses** (later). A YouTrack-style `?fields=id,summary,fields(State)` selector for heavy integrations.
7. **Agent-specific limits.** Should MCP writes be rate-limited separately from humans, or require a second human approval for bulk changes over N issues?
8. **The help desk by email.** Done (D30): mail to a desk's address files requests, and answers to its emails become the requester's public comments, from a provider's webhook or the shared mailbox. Still open: replies to the team by email from people other than the requester (today they're refused), and one mailbox per desk rather than one shared by all.
9. **Per-person time zones.** Done (D31): a person's zone, on their profile, is where their searches read "today", when their digest comes and the zone of their email's times. Rules and agents with no person read the server's.
