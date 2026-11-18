# a4a · agenda

A YouTrack-style tracker of issues, boards and plans, with a REST API, an MCP server for agents, and AI built in. It joins **a7c** (autonomic), **a5s** (agentos) and **a3t** (ambit), and wears their shared look, [Ocean](https://github.com/sreent/ocean).

a4a's own pieces (issue list, query and command bars, field panel, board, Gantt, load grid, cost panel and more) are part of Ocean since [sreent/ocean#7](https://github.com/sreent/ocean/pull/7), and the web app and the server pin a commit of Ocean's `main`.

## What it does

- **In your language**: every page, email, push notification, chat reply and problem in the language on your profile, else your browser's, else the server's; English, German, Spanish, French, Japanese, Korean, Portugal's Portuguese, Vietnamese, Indonesian, Thai and Simplified Chinese, with dates and numbers as your language writes them. What people named (projects, fields, states) stays as they wrote it, and so do the query and command languages. See [docs/translating.md](docs/translating.md).
- **On a phone**: a4a installs from the browser (Android, iOS, desktop), opens offline and says so, and pushes what your inbox gets to the devices you turn it on for, encrypted to each, one notification per issue, with the unread count on its icon. Share a page into it to start an issue. Every page is made for a thumb: 44px to tap, clear of the notch, the keyboard never covering what you type.
- **Issues with typed custom fields** per project: State, Priority, Type, Assignee, Subsystem, Fix versions, Estimation, Start date, Due date, Fixed cost.
  - Values carry Ocean's tones, so resolved reads as a tick and blocked as a clock. Priority is a meter, not a colour.
  - Fields can also hold groups, builds (a list CI can add to twice without harm), owned values (each Subsystem has an owner, who takes an issue about it that nobody has) and moments with a time, typed in your own time zone.
  - A field can show, and be required, only while its issue matches a search: *Fixed in build*, while `State: Fixed`. Marking it Fixed asks for the build.
- **Moving and cloning.** An issue moves to another project and takes its next number; its old id still finds it everywhere (addresses, the API, MCP, Markdown, commit messages). What doesn't carry over by name is asked for before anything moves. A clone copies its words, values and tags, linked back.
- **Renaming a project's key.** Its managers rename `BACK` to `CORE`, typing the new key again to confirm; its issues keep their numbers. `BACK` stays the project's for good: `BACK-12` still opens `CORE-12` everywhere it was written (links, emails, commits and branches, chat, the API and MCP), `project: BACK` still finds it in saved searches, rules, boards and dashboards, and no other project can take it. Renaming back is allowed.
- **Votes and reactions.** Vote for what you want (`sort by: votes desc`, `voter: me`), and react to a description or a comment with one of eight emoji.
- **The query language**, as in YouTrack: `project: BACK #Unresolved for: me Priority: Critical, Major sort by: updated desc`.
  - Autocomplete as you type.
  - Problems are underlined where they are, with the fix one click away: *Unknown value "Fixd" for State · Did you mean Fixed?* The API gives agents the same fix as data.
  - Or ask in words: an agent turns them into a query, and shows the query it read before it runs.
- **Commands** change many issues at once: `State Fixed Assignee anna tag regression`, `subtask of BACK-3`. The web app shows what a command changes on each issue before it applies. It can also take the command in words.
- **Workflow rules**, written in the same two languages and read as sentences:
  - when an issue is created, changes or gets a comment, and then matches a query, a command changes it: *When an issue is created, if it matches `Type: Bug Priority: Critical`, then apply `Assignee anna tag urgent`*;
  - on a schedule, every issue that matches gets the command: *every day at 09:00, `#Unresolved Due date: Overdue` gets `tag overdue`*;
  - a guard refuses a change that would break it, and the change leaves nothing behind: *State Won't fix needs a comment*.
  - Across issues: a rule can also ask something of its parent, its subtasks, its parent's subtasks or the issues linked to it, and act on them instead: *When an issue's State changes, if it matches `#Resolved` and all of its parent's subtasks match `#Resolved`, then apply `State Fixed` to its parent*.
  - Beyond a change: a rule can tell people (its assignee, reporter, watchers, the project's managers, or people by name) in its own words, in their inbox and by email at their level, and an administrator's rule can call a webhook, signed with its secret.
  - Each is previewed before it's saved (its problems where they are, the issues it would touch now, what it would change on a few, and whom it would tell), acts as the workflow agent, and keeps a log of what it did. Rules that set off rules stop three steps deep, and a rule acts on an issue once for each change that set it off.
  - A project's managers make its rules, and everyone who can see the project can read them. A rule acts only in its own project.
- **Scripted workflows** (D40):
  - An administrator can write a rule as a script, in JavaScript. It sees the issue, what changed and who changed it, and asks with `apply(command)`, `comment(text)` and `refuse(why)`.
  - Scripts run in a sandbox: QuickJS in WebAssembly, with no network, files or timers, and 250 ms and 16 MB a run.
  - What a script asks for goes through the command executor, so a scripted rule keeps the run log, the depth limit and acting once for each change. A scripted guard refuses a change in its own words, before it's saved.
  - The Rules page underlines a script's syntax errors as it's typed and test-runs it on an issue, saving nothing.
  - **State machines**: a project's state field moves only by its named transitions, each with an optional condition and command. A change that skips one is refused, however it's made, and the issue page offers the moves as buttons.
  - **Custom actions**: named commands or scripts per project, shown as buttons on the issues they're offered for, and run by name as commands too.
- **Version control**: GitHub, GitLab, Bitbucket (Cloud and Data Center), Gitea and Forgejo send pushes and pull requests.
  - A commit or pull request that mentions `BACK-12` is linked to it, and shows on the issue with its state (open, merged, closed).
  - `BACK-12 #Fixed` in a commit message applies the command as its author, when a4a knows them and they can change the project's issues; otherwise the commit is linked and the issue says why.
  - a4a knows a commit's author by any of their confirmed emails, or by their login at the provider (from the account they connected, or as an administrator records it). People add emails on their profile and confirm each by a link a4a mails; an administrator can confirm one instead. When the email and the login name two people, it's nobody.
  - Deliveries are checked (each provider's signature, GitLab's token), handled once, rate-limited and logged.
  - Bitbucket Data Center's pushes don't say what their commits say, and Bitbucket Cloud's carry the latest five a branch got: given an access token, a4a reads the rest from Bitbucket.
- **Builds from CI** (D46, D55): GitHub Actions' workflow runs, Forgejo's and Gitea's Actions runs, or any CI posting with a token, put each passing build in the project's build field, and mark the resolved issues its commits name as fixed in it. A project's builds page says what each build did; searches take ranges of builds.
- **People connect their own accounts** at GitHub, GitLab, Bitbucket, and a Forgejo or Gitea, from their profile, by signing in there, so their commits are theirs without an administrator.
- **GitHub as an App** (D54): a GitHub integration can read as a GitHub App rather than with a person's token, given the app's id, one of its private keys and its installation, which a4a finds. Its tokens last an hour and are kept only in memory, and the app's own webhook can be the integration's.
- **More importers**: GitHub Issues, Redmine, and Zendesk into a help desk (requesters, public replies and internal notes), beside YouTrack and Jira.
  - **Asana and ClickUp** (D61): a project's or a List's tasks with their subtasks, comments, files and custom fields; a section or a status as the state, and completed tasks resolved; dependencies as links; followers and watchers as watchers; ClickUp's time tracked as work, and its checklists as checklists in the description.
- **VS Code**: an extension with your issues, an issue beside the code, a new issue from selected code, an issue named in the commit message, and a4a's MCP tools for VS Code's agent.
- **Writing as it reads.** Descriptions, comments, help desk replies and articles are written in a visual editor, or as Markdown by a switch that's remembered; Markdown is what's kept, and a text opened and saved untouched is the same to the byte.
  - Bold, italic, struck through, code, headings, quotes, lists, checklists and tables from its toolbar, or by typing Markdown's own marks.
  - A screenshot pasted or dropped is uploaded as one of the issue's or the article's files, and goes in the text where it was put. Pictures show in place, only a4a's own raster files: never SVG, never another site's.
  - A checklist is ticked where it's read, by whoever may change the text, and saved against the version read: if someone changed it meanwhile, the page says so and reloads.
  - "@" offers people, as the comment box always has.
- **Chat with Microsoft Teams and Slack** (D42):
  - A channel is told of a project's issues, or a saved search's: new issues, state changes, assignments, comments and other changes, as chosen for it. Teams gets Ocean's cards, Slack its own blocks.
  - A channel is told only what everyone who reads the project may see: never an issue or a comment limited to some people, a help desk's internal note or a requester's address. Whoever subscribes a channel vouches for its people; a project open to its members alone takes someone who manages it.
  - People ask the bot as themselves, with their own access: `BACK-12`, `BACK-12 State Fixed`, `comment BACK-12 …`, `new BACK …`, `search …`, `subscribe BACK`. A card's buttons (Assign to me, Move to…, Comment) do the same, and answer the person alone.
  - Teams knows people who sign in with Microsoft Entra ID; anyone else links their chat account once, with a link only they see. Slack unfurls links to issues a channel may be told of.
  - A message becomes an issue (D60): Slack's message shortcut and Teams' message action ("Create an a4a issue") open a form with the projects you may create in, a summary from the message's first line, and the message as Markdown, nothing in it that runs; in Slack, the replies after it too, up to 20. It's made as you, "via Slack" or "via Teams"; you're told where only you see it, and its thread gets a link where the channel may be told of the project. The issue keeps where it came from (the channel, a link to the message, who sent it and when, its files as links), shown on its page in each reader's language, over the API and to agents. The message's author, linked, watches it. At most `CHAT_ISSUE_LIMIT` issues from chat per person in ten minutes.
- **Agile boards** with sprints, WIP limits and swimlanes; a long board with lanes keeps its column heads in view.
  - A backlog to plan sprints from (a board's saved query, `#Unresolved` by default), ranked by dragging or from the keyboard (Alt and an arrow); issues go into a sprint by dragging, or with the command `sprint Sprint 4`.
  - Cards ranked on the board itself, in the backlog's one order (D53): dragged within a column, or into another at a place, which changes its state and its place in one change (a state machine or guard that refuses it refuses both); from the keyboard, Alt and an arrow moves a card a place or a column, said where a screen reader hears it; on a phone, a card held still is picked up, and a finger that moves first swipes through the columns. Others see the new order live.
  - Story points in a number field the board chooses, summed on each column, the sprint and the backlog; a velocity chart of points committed and done per sprint, with the average of the last three.
  - Planning a sprint shows each person's remaining estimate against the hours they can work in it, by their working week and days away.
- **Whiteboards** (D58): a project's canvas where its team plans and brainstorms beside its issues, in notes (plain, or an idea, agreed, a question, a problem or parked, said in words as well as colour), text, sections, issue and article cards and arrows between them.
  - Several people edit one at once and see each other's changes as they're made, and who's looking. Edits to different things all land; words someone changed while you typed are kept in your box, not lost. Each person undoes and redoes their own, never someone else's.
  - A note becomes an issue in a click, its first line the summary, and its card the issue's where it was; several at once, each on its own, so one that can't still lets the others through. An arrow between two issues becomes a link, never twice. The new issue's history names the whiteboard.
  - Cards follow their issues live, and a card someone may not see (limited, another project, deleted) shows only that it's hidden. Removing a card never deletes its issue.
  - All of it from the keyboard, with an outline a screen reader reads, and by touch on a phone. Whoever reads the project reads its whiteboards; whoever may change its issues changes them.
- **Time tracking:** a timer on an issue (start, pause, stop; one running per person) that becomes a work item; work types per project, required where the project says so; and a weekly timesheet where people enter and correct their time across issues, each day against their working hours.
- **Planning** for waterfall and hybrid projects:
  - a Gantt schedule with the critical path and *what-if* ("what slips if MIG-12 slips 3 days?");
  - resource load and levelling, which is proposed first and applies exactly what was proposed, or nothing if the plan changed meanwhile;
  - people's days away, whole or half days: their work waits for them, levelling finds room on the days they're there, and the load grid and the Gantt show them (the grid over the days each person chooses), never why;
  - each person's working week (part time, a weekday off), which scheduling, levelling, the load grid, sprint planning and the timesheet use;
  - cost tracking against a budget;
  - baselines with earned value (CPI, SPI, EAC).
- **Files** on issues, comments and articles: dropped or chosen, with progress; images shown in place, everything else (SVG and HTML included) downloaded, whatever its name says. Each file's type is read from its bytes and its SHA-256 kept; uploads stream to disk or to an S3-compatible bucket (S3, MinIO, R2), with a size limit per file and a cap per issue.
  - Text files (logs, code, CSV, JSON, Markdown, and HTML as its source) open in place, from their start or their end. Sound and video play in the browser's own player, served in ranges.
  - `files:to-s3` moves the files on disk to a bucket, checking each copy against its checksum, and carries on where a run stopped.
- **A knowledge base** per project: articles in a tree (`BACK-A-3`), written in Markdown with a preview beside it, every saved version kept with its diff, full-text search, and mentions both ways: an article lists the issues that name it, and an issue the articles.
  - An article can be **limited to some people and groups**, from the start or later; its author, the project's managers and administrators always see it. What's under a limited article is seen only by who sees it, so moving one under it hides it too. To everyone else it's missing everywhere: the tree, search, its versions and files, mentions, the feed, MCP and the assistant (D51).
- **Reports**, worked out from each issue's history:
  - a sprint's burndown, by estimate or by count, with the ideal, every change to its scope, and how it stands in a sentence (linked from the sprint board);
  - cumulative flow, created against resolved, and cycle time with its percentiles;
  - time logged by person, issue, project and week, against estimates;
  - issues per field, by any field, and a matrix of two fields against each other, as issues are now, each count opening its issues;
  - average age, and time in each state (or a board's columns) with its median and 85th percentile, each day as it stood.
  - A moved issue counts once, in the project it was in each day.
  - Each chart has its figures as a table beside it, and the tables download as CSV.
- **Dashboards**: a page of your own reports, saved searches and notes, private or shared. Each viewer sees what they may.
- **Importing from Jira or YouTrack**, from a CSV export or straight from their APIs, for a project's managers:
  - columns and values are mapped for you where their names say what they are, and you map the rest;
  - a check says what would happen, row by row, before anything changes;
  - issues keep their original dates, reporters, comments, time and links;
  - from an API, each issue's comments, work items and files come too: a query (YouTrack) or a JQL (Jira Cloud or Data Center) says which issues, and the token is used and never kept;
  - running it again updates what changed and never makes an issue twice, and an import nobody has worked on since can be undone.
- **Notifications** of what concerns you:
  - You watch what you report, are assigned, comment on or are mentioned in (`@anna`), and what you choose to; `watcher: me` finds it.
  - An inbox under Work, by issue, its unread count live in the sidebar. Changes close together on one issue are one notification, and nobody hears of their own changes.
  - Subscriptions: to a project's new issues or every change in it (on its page), and to an issue coming into a saved search or any change to one in it (on the Issues page). Your inbox says which brought what, and your profile lists them.
  - Email if you want it: everything, mentions and assignments only, or never, and a daily digest; each subscription says whether it emails too. Each email stops its kind in one click.
  - Your time zone, on your profile: what "today" means in your searches and commands, when your digest comes, and the times in your email.
- **A help desk** per project: a public form at `/help/<KEY>` for people who aren't users, a page of their own for each request, where they follow the public replies and answer them. Comments stay internal unless the team makes one public.
  - **By email:** a desk with an address takes requests by mail, and the requester can answer the team's emails. Mail arrives from your provider's webhook (SendGrid, Mailgun, Postmark, a Cloudflare Email Worker) or a shared IMAP mailbox. Quoted history and signatures are cut, files kept, and auto-replies, bounces and lists set aside.
  - **CCs:** up to 20 people copied on a request, from the Cc of the requester's email, by the team on the request's page, or by the requester on the portal. Each gets the team's public replies and changes of state by email, in an email of their own, answers by email as themselves, sees the request on the portal, and stops with one click; the request's history says who copied whom.
  - **A proof of work** the form can ask for: the sender's browser works a moment on a signed challenge, with no puzzle and nothing from another site.
- **SLAs** in working hours: policies by query with first-response and resolution targets, a time zone, days and holidays; clocks that pause while a request waits on its requester and restart what's left when it's reopened; at risk and breached said as they happen, kept in an "SLA status" field boards and reports read; `sla: breached`, `first response: overdue`, `resolution due: today`; met and breached per week.
- **Customer groups**: a desk groups its requesters by company or team, by their email's domain or by hand. `customer: Acme` chooses a group's requests in SLA policies, rules, searches, boards and reports; a group can count its SLA in its own hours and holidays, give its new requests to its own agents (whoever has the fewest open), and share its members' requests with each other on the portal, to read or to answer, unless one is kept private. Met and breached by group.
- **A portal for requesters** at `/portal`: signed in as their desk chooses (a link sent to their email, a password they set by one, or their organisation's identity provider, which an administrator adds and any desk may offer, and a customer group can require), they see their requests (and their customer group's, where it shares them), reply, answer their colleagues' where the group lets them, and ask without the proof of work. A desk can read **a mailbox of its own** and send from its address and name.
- **Replying by email**: the team answers a notification email and it's a comment by them (`MAIL_REPLY_ADDRESS`), internal on a request unless what they answered was public.
- **Kinds of change**: each person chooses which tell them, by the inbox and by email, for what they watch and per subscription.
- **AI**, built for Claude, that also runs on DeepSeek or Qwen:
  - Triage of new issues: it only suggests, or applies confident values to fields left at their defaults. Its values wait, dashed, on the issue, and a person accepts each one they agree with.
  - Duplicate detection.
  - Search and commands in plain words.
  - Writing help in every text field, in the visual editor and in Markdown: fix spelling and grammar; rewrite shorter, clearer, more formal or friendlier; carry a text on, or draft it from a line (an article from a prompt, a reply to a requester from the request's conversation). Each answer is a suggestion beside what it would replace, to accept, edit or discard; code, links, mentions and ids come back as they went in, and the text keeps its language.
  - Summaries of an issue, an article or a selection, in the reader's language, read only from what they may see; an issue's summary posted as the assistant's comment; a clearer summary suggested for an issue. Each person asks up to `AI_WRITING_MAX_PER_HOUR` times an hour.
  - An assistant that works through the same tools as MCP and asks before it changes anything.
- **Projects with their own people**:
  - a project is open to everyone, or seen only by its members and administrators;
  - in it, each person is a viewer (reads and comments), a member (also changes issues) or a manager (also its settings, people, boards and baselines);
  - **roles are sets of permissions** (read, comment, create, edit, delete, time, costs, boards, manage, and seeing and changing private fields): administrators add their own beside the three built-in ones;
  - **groups** get roles as people do, and someone may do what any of their own and their groups' roles allows;
  - **an issue, a comment or an article can be limited** to some people and groups: everyone else, everywhere, finds it missing (and what's under a limited article, D51);
  - **a field can be private** in a project: only people whose role may see private fields see it (managers do), and only those whose role may change them set it; to anyone else, everywhere, from search to email and Claude, it isn't there, and a chat channel or a webhook never gets it;
  - **guests** read a project opened to anyone, without signing in: its issues, articles, boards, reports, plan and whiteboards (live), never its money, people's days away and loads, or who's looking, and change nothing;
  - what you can't see doesn't exist for you, everywhere: search, links, boards, plans, the event feed, MCP and what goes to Claude;
  - tokens can be limited to some projects.
- **Single sign-on** with your identity provider, by OpenID Connect or SAML 2.0 (or both), with password sign-in optional.
  - Accounts are linked by a verified email, can be made on first sign-in, and can be kept to your email domains.
  - Groups can come from the provider: who is in them follows its groups claim or attribute, at each sign-in.
  - **LDAP**: the login form checks passwords against your directory too, over ldaps or StartTLS, can make accounts at the first sign-in, and fills groups from memberOf or a group search.
  - **Provisioning by SCIM 2.0**: Microsoft Entra ID (or another provider) adds people and groups, changes them, and bans those it deactivates, between sign-ins.
- **Two-factor sign-in** for passwords: a code from an authenticator app after the password, set up from a QR code, with single-use recovery codes. An administrator can ask it of everyone who signs in with a password.
- **Passkeys**: sign in with a fingerprint, a face or a screen lock, without a login, a password or a code, from the browser's autofill or a button; or use one in place of the code after a password. People add, name and remove theirs on their profile, after a recent sign-in, and are emailed each change with a "This wasn't me" link that signs them out everywhere. Administrators see who has them, remove someone's, and can turn them off. They need `PUBLIC_URL` to be https (or localhost), and are for people a4a's own password signs in; single sign-on and LDAP accounts keep their provider's checks.
- **Apps**: extensions an administrator installs from a package or a catalog, after reading what each asks for, for every project or some. A project's managers can turn one off in it.
  - **What an app adds**: widgets on an issue's panel, below its summary, a project's page, an article, dashboards or a page of its own; handlers that run in the workflow sandbox; rules that act as the app's own agent; settings for the app and each project.
  - **What it may do**: exactly what its parts use, as granted: read or write issues, comments, articles, fields and time. Its widgets run in sandboxed frames and do for each person only what that person may; history says what came through an app.
  - **Catalogs**: name each package's SHA-256 and may sign it with Ed25519 by a key you trust. Two example apps are in `examples/apps`, and `pnpm --filter @a4a/server apps:pack` packages your own, with a catalog of them.
- **For integrations**:
  - a REST API (OpenAPI 3.1, docs at `/api/docs`);
  - signed webhooks with at-least-once delivery, and a durable event feed with live SSE that resumes from the last event id;
  - `Idempotency-Key` on POSTs, and `expectedVersion` against lost updates.
- **For agents**: an MCP server at `/mcp` with 60 tools (`summarize_issue` among them where the AI is set up), 5 resources and 6 prompts, plus `a4a-mcp`, a stdio bridge for stdio-only clients. Agents can read a log attached to an issue, attach small files, and write documentation in the knowledge base, previewed first. `list_notifications` shows an agent what's waiting for its person. Agents can list and preview workflow rules; people make them. Clients that sign in by themselves, such as Claude and Claude Code, need only the address: a4a asks the person what each may do, and where (OAuth 2.1, as MCP's authorization specification asks).
- **Agents of their own**: an administrator adds an agent (a bot account) and issues it tokens on **Agents and tokens**.
  - With one, an agent over MCP or the API acts as itself: its changes show under its name, for no one, and `me` is the agent.
  - Issues can be assigned to it, as to a person; `for: me #Unresolved` over its token is its work. a4a's own agents (triage, workflow, the help desk) take no work.
  - What an agent changes on its own (as itself, for a person over MCP, through the assistant, or by a rule), anyone who may change the issue can undo from its history: fields, summary, description, tags and links go back as they were, all or nothing. If someone has changed any of it since, nothing is undone, and a4a says what changed.
- **One process or several**: on Postgres, any number of instances behind a load balancer behave as one. Live events reach every instance within about a second, cached fields and values update everywhere at once, sign-in limits are shared, and exactly one instance runs the background work, with another taking over if it dies.

## Quick start

Needs Node 20.19 or later, and pnpm.

```bash
pnpm install
```

```bash
pnpm dev
```

Open <http://localhost:5173>. The first visit creates the administrator, and optionally three demo projects:

- Backend platform, with a likely duplicate and a sprint board;
- Web app, on a kanban board with WIP limits and swimlanes;
- Data center migration, a plan with a baseline, an over-allocated engineer and a deadline at risk.

To add them later, to a database with an administrator and no projects yet, run `pnpm db:seed`. With the embedded database, stop the server first: one process at a time may open it.

The database is embedded (PGlite in `packages/server/data`), so nothing else is needed.

To turn on the AI features, set a Claude API key before `pnpm dev`:

```bash
export ANTHROPIC_API_KEY=sk-ant-…
```

They also run on DeepSeek or Qwen, which speak the same API. What differs is in [D14](docs/architecture.md#d14-other-models-get-the-portable-subset). The AI sends issue text to whoever serves it, so the provider is named, never guessed from the keys that are set:

```bash
export AI_PROVIDER=deepseek DEEPSEEK_API_KEY=sk-…
```

## Connect an agent (MCP)

**Clients that sign in by themselves** (Claude, Claude Code, and others that speak MCP's OAuth) need only the address. They send you to a4a, which shows who asks and lets you choose what it may do and where, and they appear under **Agents and tokens**, where you can revoke them.

```bash
claude mcp add --transport http a4a http://localhost:3000/mcp
```

Then `/mcp` in Claude Code signs it in. In Claude, add a custom connector with your a4a's https address and `/mcp`: Claude reaches it from the internet, so it has to be reachable from there. Where `PUBLIC_URL` is neither https nor this computer, signing in this way is off: use a token instead.

**With a token**, for any other client:

1. Create a token: **Agents and tokens** in the app, or `POST /api/v1/me/tokens`.
   - A read-only token is the safe way to let an agent explore.
2. Point your client at it.

**Claude Code**

```bash
claude mcp add --transport http a4a http://localhost:3000/mcp --header "Authorization: Bearer a4a_your_token"
```

**Cursor, and other clients that speak HTTP** (`mcp.json`):

```json
{ "mcpServers": { "a4a": { "url": "http://localhost:3000/mcp", "headers": { "Authorization": "Bearer a4a_your_token" } } } }
```

**Claude Desktop, and other stdio-only clients**: use the bridge.

```json
{ "mcpServers": { "a4a": { "command": "npx", "args": ["a4a-mcp"], "env": { "A4A_URL": "http://localhost:3000", "A4A_TOKEN": "a4a_your_token" } } } }
```

The bridge isn't published to npm yet. Until it is, build it with `pnpm build` and use `"command": "node", "args": ["<repo>/packages/mcp-bridge/dist/index.js"]`.

What agents get is described in [docs/mcp-and-api.md](docs/mcp-and-api.md):

- tools such as `search_issues`, `apply_command` (with `dry_run`), `get_schedule` (with `what_if`) and `level_resources`;
- the query and command guides, as resources;
- prompts such as `work_on_issue` and `schedule_review`.

Every change an agent makes is recorded with the token's name, and agents cannot delete issues.

## Configuration

The server reads these from its environment, and from a `.env` file: the one in its working directory, else the one at the repository's root. What the environment sets wins.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | API, MCP and (in production) the web UI |
| `HOST` | `0.0.0.0` | The address the server listens on; `127.0.0.1` keeps it to this machine, behind a proxy on it |
| `PUBLIC_URL` | `http://localhost:$PORT` | Used in links, MCP snippets and the CSRF check. Its host is passkeys' relying party: they need https (or localhost), and are bound to the host, so moving to another one means adding them again (D62) |
| `DATABASE_URL` | empty | A Postgres URL. When empty, the embedded PGlite database in `DATA_DIR` is used, which is for one process only |
| `DATABASE_POOL_SIZE` | `10` | The most connections each instance opens to Postgres; it holds one more for `LISTEN` |
| `DATABASE_LISTEN_URL` | `DATABASE_URL` | Where that `LISTEN` connection goes, when `DATABASE_URL` points at a pooler in transaction mode (PgBouncer), which drops `LISTEN` |
| `TRUST_PROXY` | `0` | How many proxies in front append to `X-Forwarded-For`; `1` behind one load balancer. With `0` the header is ignored, since clients can send it |
| `API_RATE_LIMIT`, `MCP_RATE_LIMIT` | `1200`, `600` | Requests a minute per token, user or address, on each instance |
| `GUEST_RATE_LIMIT` | `300` | Requests a minute per address from guests, who read projects open to anyone without signing in (D37) |
| `MCP_OAUTH` | `true` | Let MCP clients sign in with OAuth 2.1, so they need no token (D28). It works only when `PUBLIC_URL` is https, or on this computer; elsewhere, or with `false`, clients use API tokens |
| `DATA_DIR` | `./data` | Where the embedded database, files kept on disk and the key file (`secret.key`) live; a relative path is from the server's working directory |
| `WEB_DIST` | `apps/web/dist` | The built web UI the server serves, found from its working directory; the image sets `/app/web` |
| `AI_PROVIDER` | `anthropic` | Who serves the model: `anthropic`, `deepseek`, `qwen`, or `compatible` for another service that speaks Anthropic's Messages API. Issue text the AI reads goes to them |
| `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) | empty | Anthropic's key. A provider's key turns the AI features on |
| `DEEPSEEK_API_KEY`, `QWEN_API_KEY` (or `DASHSCOPE_API_KEY`), `AI_API_KEY` | empty | The key for DeepSeek, Qwen or a `compatible` service |
| `AI_DISABLED` | `false` | `true` turns the AI features off, whatever key is set |
| `AI_BASE_URL` | the provider's | Where requests go. Needed for `compatible`; for Qwen in mainland China, `https://dashscope.aliyuncs.com/apps/anthropic`. For Anthropic, without it, the SDK reads `ANTHROPIC_BASE_URL` |
| `AI_MODEL` | `claude-opus-5-5`, `deepseek-v4-pro` or `qwen3.8-max` | The model used. Needed for `compatible` |
| `AI_TRIAGE_MAX_PER_HOUR` | `120` | The most automatic triage runs in an hour, across every instance; past it, new issues aren't triaged |
| `AI_WRITING_MAX_PER_HOUR` | `100` | How many times each person may ask for writing and reading help in an hour: every action and summary, on the web, the API and MCP |
| `ADMIN_LOGIN`, `ADMIN_PASSWORD` | empty | Create the first administrator without the setup page (containers, CI) |
| `ADMIN_EMAIL`, `ADMIN_NAME` | empty, their login | Their email, so single sign-on can find them by it, and their name |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID` | empty | Turn on single sign-on with an OpenID Connect provider: its issuer (https) and a4a's client id there. Register `PUBLIC_URL/api/v1/auth/oidc/callback` as the redirect URI, exactly |
| `OIDC_CLIENT_SECRET` | empty | The client's secret (empty for a public client) |
| `OIDC_NAME` | the issuer's host | What the sign-in page calls it: "Sign in with …" |
| `OIDC_SCOPES` | `openid email profile` | Scopes asked for |
| `OIDC_ALLOWED_DOMAINS` | empty | Comma-separated email domains allowed in; empty allows any the provider verifies |
| `OIDC_CREATE_USERS` | `false` | Give someone an account the first time they sign in |
| `OIDC_GROUPS_CLAIM` | empty | The ID token claim that lists someone's groups (often `groups`): it fills the groups that come from the provider, at each sign-in |
| `SAML_IDP_METADATA_URL` | empty | Turn on SAML 2.0 sign-in: where the identity provider's metadata is (https). Register `PUBLIC_URL/api/v1/auth/saml/acs` (HTTP-POST) with the provider, or give it `PUBLIC_URL/api/v1/auth/saml/metadata` |
| `SAML_IDP_ENTITY_ID`, `SAML_IDP_SSO_URL`, `SAML_IDP_CERT` | empty | Or the provider set out by hand: its entity id, its sign-in URL (HTTP-Redirect), and its signing certificates (PEM, or base64 separated by commas) |
| `SAML_NAME` | the provider's host | What the sign-in page calls it |
| `SAML_SP_ENTITY_ID` | `PUBLIC_URL/api/v1/auth/saml/metadata` | a4a's own entity id |
| `SAML_EMAIL_ATTRIBUTE`, `SAML_NAME_ATTRIBUTE` | the usual names | Where the email and the name are; by default `email`, `mail` and their URIs, and `displayName` or given name and surname |
| `SAML_GROUPS_ATTRIBUTE` | empty | The attribute that lists someone's groups: it fills the groups that come from the provider, at each sign-in |
| `SAML_TRUST_EMAIL` | `false` | Count the email the provider asserts as verified (SAML has no `email_verified`), so it links existing accounts |
| `SAML_ALLOWED_DOMAINS` | empty | Comma-separated email domains allowed in (needs `SAML_TRUST_EMAIL`) |
| `SAML_CREATE_USERS` | `false` | Give someone an account the first time they sign in |
| `SAML_NAMEID_FORMAT` | empty | The NameID format to ask for; empty takes the provider's (a persistent one is best) |
| `SAML_ALLOW_IDP_INITIATED` | `false` | Take sign-ins started at the provider, which answer no request of a4a's |
| `PASSWORD_LOGIN` | `true` | `false` turns a4a's own passwords off, while single sign-on or LDAP is on (LDAP's form stays) |
| `SESSION_TTL_DAYS` | `30` | How many days a sign-in lasts |
| `SECRET_KEY` | a key file | Seals the secrets a4a keeps in the database and reads back (two-factor secrets, integrations' tokens and GitHub Apps' keys, Slack's token and signing secret, desks' mailboxes, the portal's identity providers' secrets, apps' secret settings, the push key), and signs apps' file addresses: any text, or 32 bytes in hex or base64. Without it, a4a writes a key to `DATA_DIR/secret.key` the first time, to back up with the database. Several instances need the same `SECRET_KEY` |
| `LDAP_URL` | empty | Check passwords against an LDAP directory too: `ldaps://host:636`, or `ldap://host:389` with `LDAP_STARTTLS=true` (D38) |
| `LDAP_STARTTLS` | `false` | Upgrade a plain `ldap://` connection with StartTLS before anything is sent |
| `LDAP_BIND_DN`, `LDAP_BIND_PASSWORD` | empty | The service account a4a searches as; empty binds anonymously |
| `LDAP_BASE_DN` | (required) | Where to look for people, e.g. `dc=acme,dc=example` |
| `LDAP_USER_FILTER` | uid, sAMAccountName, userPrincipalName or mail | The filter that finds someone; `{login}` is what they typed, escaped |
| `LDAP_LOGIN_ATTRIBUTE`, `LDAP_EMAIL_ATTRIBUTE`, `LDAP_NAME_ATTRIBUTE` | `uid`, `mail`, `displayName` | Their a4a login (the first time), email and name |
| `LDAP_ID_ATTRIBUTE` | objectGUID or entryUUID | Their id there, which keeps finding them after a rename; else their DN |
| `LDAP_GROUPS_ATTRIBUTE` | empty | An attribute listing their groups' DNs, such as `memberOf`: it fills the groups that follow the provider |
| `LDAP_GROUP_BASE_DN`, `LDAP_GROUP_FILTER`, `LDAP_GROUP_NAME_ATTRIBUTE` | empty, `(\|(member={dn})(uniqueMember={dn}))`, `cn` | Or find their groups by a search, where `{dn}` is theirs |
| `LDAP_CA_CERT` | empty | A PEM file (or PEM text) of the certificate authority the directory's certificate comes from |
| `LDAP_NAME` | the host | What the sign-in page calls the directory |
| `LDAP_CREATE_USERS` | `false` | Give someone an account the first time they sign in |
| `LDAP_TRUST_EMAIL` | `false` | Count the directory's email as verified, so it links existing accounts |
| `LDAP_ALLOWED_DOMAINS` | empty | Comma-separated email domains allowed in (needs `LDAP_TRUST_EMAIL`) |
| `MCP_OAUTH_CLIENT_DOCUMENTS` | `true` | Take MCP clients whose client_id is the https address of their metadata document, read with the same guard as imports |
| `OAUTH_CLIENT_DOCUMENTS_ALLOW_HTTP_LOOPBACK` | `false` | For tests only: lets a client's metadata document be read over plain http from this machine |
| `SEED_DEMO` | `true` | With `ADMIN_*`, also create the demo projects |
| `ATTACHMENT_MAX_MB` | `20` | The largest file one upload may carry (1 MB = 1024 × 1024 bytes) |
| `ATTACHMENTS_PER_ISSUE_MB` | `100` | All the files on one issue, its comments' included, or on one article |
| `ATTACHMENT_STORAGE` | `local` | Where files go: `local` keeps them under `DATA_DIR/attachments`; `s3`, in the bucket below. Back it up with the database |
| `S3_BUCKET` | empty | The bucket files go in with `ATTACHMENT_STORAGE=s3`, and where `files:to-s3` copies them. a4a checks it as it starts |
| `S3_ENDPOINT` | empty | A store other than AWS's: MinIO's, R2's or another's address, e.g. `http://minio:9000` |
| `S3_REGION` | `us-east-1` | The bucket's region (else `AWS_REGION` or `AWS_DEFAULT_REGION`); R2 takes `auto` |
| `S3_PREFIX` | empty | Before every key, so a bucket can hold more than a4a's files, e.g. `a4a/` |
| `S3_FORCE_PATH_STYLE` | `true` with an endpoint | The bucket in the path (`http://host/bucket/key`), as most stores other than AWS want |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | empty | The bucket's keys (`S3_SESSION_TOKEN` with temporary ones). Without them, the AWS chain gives them: its environment, a profile, or the machine's role |
| `SMTP_URL` | empty | An SMTP server for email, e.g. `smtp://user:pass@mail.example.com:587` (`smtps://` for TLS from the start). Without it, a4a sends no email and nothing fails: the inbox still has everything, and administrators confirm the emails people add, since no link can go |
| `MAIL_FROM` | `a4a <a4a@host>` | Who email comes from; by default at `PUBLIC_URL`'s host |
| `MAIL_REPLY_ADDRESS` | empty | Where the team's replies to notification emails go, plus a token each (`replies+…@acme.example`); its mail must reach a4a as a desk's does (the shared mailbox, or a desk's webhook). Without it, notification emails can't be answered |
| `NOTIFY_WINDOW_SECONDS` | `120` | Changes to one issue within this long are one notification, and one email |
| `PUSH` | `true` | Push notifications to the devices people turn them on for (D47). `false` turns them off |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | made once | The key pair push is signed with, base64url (as `npx web-push generate-vapid-keys` writes them). Without them a4a makes a pair the first time and keeps it in the database, its private half sealed with `SECRET_KEY`; changing it means people turn push on again |
| `VAPID_SUBJECT` | `PUBLIC_URL` if https, else `mailto:` `MAIL_FROM` | Who push services may contact about a4a's pushes |
| `PUSH_HOSTS` | the browsers' | The push services a4a sends to, comma-separated, `*.example.com` for any host under it. By default `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com` and `*.notify.windows.com` |
| `PUSH_ALLOW_HTTP_LOOPBACK` | `false` | For tests only: lets push go over plain http to this machine |
| `DEFAULT_LOCALE` | `en` | The language a4a writes in to whoever chose none on their profile, and shows a browser that asks for none it speaks: `en`, `de`, `es`, `fr`, `id` (Indonesian), `ja`, `ko`, `pt` (Portugal's Portuguese), `th` (Thai), `vi` or `zh` (Simplified Chinese) |
| `DIGEST_HOUR` | `8` | The hour the daily digest goes out, in each person's time zone (the server's for those who set none) |
| `HELPDESK_IMAP_URL` | empty | A mailbox the help desks read, e.g. `imaps://support%40acme.example:pass@imap.acme.example/INBOX` (`imap://` upgrades with STARTTLS). Each message goes to the desk whose address it was sent to. Without it, desks take mail by their provider's webhook alone |
| `HELPDESK_IMAP_POLL_SECONDS` | `60` | How often that mailbox, and each desk's own, is read, by the instance holding the worker's lease |
| `HELPDESK_MAIL_MAX_MB` | `25` | The largest message a help desk takes, attachments included |
| `HELPDESK_CAPTCHA_MAX_NUMBER` | `100000` | How hard a help desk form's proof of work is: the most numbers a browser may have to try (half that on average, about a second) |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | empty | A GitHub OAuth app people connect their GitHub accounts through, from their profile (D46). Its callback: `PUBLIC_URL/api/v1/auth/code-hosts/github/callback`. `GITHUB_URL` for GitHub Enterprise Server |
| `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET` | empty | The same for GitLab (an application with the `read_user` scope; callback `…/code-hosts/gitlab/callback`). `GITLAB_URL` for a self-managed GitLab |
| `BITBUCKET_CLIENT_ID`, `BITBUCKET_CLIENT_SECRET` | empty | The same for Bitbucket Cloud (an OAuth consumer with Account read; its callback URL `…/code-hosts/bitbucket/callback`) |
| `FORGEJO_URL`, `FORGEJO_CLIENT_ID`, `FORGEJO_CLIENT_SECRET` | empty | The same for a Forgejo (D54): its address, and an OAuth2 application made there, confidential, with the redirect URI `…/code-hosts/gitea/callback`. `GITEA_URL`, `GITEA_CLIENT_ID` and `GITEA_CLIENT_SECRET` for a Gitea instead; with both, Forgejo's is used |
| `IMPORT_ALLOW_HOSTS` | empty | Comma-separated host names an import may read from although they are inside the network, such as a YouTrack or Jira of your own. Every other host must be public; https always |
| `IMPORT_ALLOW_HTTP_LOOPBACK` | `false` | For tests only: lets an import read over plain http from this machine |
| `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`, `TEAMS_TENANT_ID` | empty | A Teams bot (D42): its Entra app's id and client secret, and the one tenant it serves. All three, or none |
| `TEAMS_SERVICE_HOSTS` | Bot Framework's | More hosts a Teams service URL may name, comma-separated, beside Bot Framework's own (`smba.trafficmanager.net` and the government clouds') |
| `SLACK_API_URL` | `https://slack.com/api` | Slack's Web API. Slack itself is connected on the Chat page, with its app's token and signing secret |
| `CHAT_ALLOW_HTTP_LOOPBACK` | `false` | For tests only: lets chat services be reached over plain http on this machine |
| `CHAT_ISSUE_LIMIT` | `10` | Issues one person may make from Teams and Slack messages in ten minutes, across both and every instance (D60) |
| `VCS_ALLOW_HTTP_LOOPBACK` | `false` | For tests only: lets a GitHub API address and a Forgejo or Gitea be reached over plain http on this machine |
| `APP_CATALOGS` | empty | App catalogs to install from: https addresses of JSON indexes, comma-separated (D48) |
| `APP_TRUSTED_KEYS` | empty | Ed25519 public keys (PEM, or base64 of the 32 bytes), comma-separated, that apps from a signing catalog must be signed with |
| `APP_MAX_MB` | `5` | The largest app package |
| `APP_ALLOW_HTTP_LOOPBACK` | `false` | For tests only: lets catalogs and packages be read over plain http from this machine |

## Builds from CI

An administrator adds a build source under **Integrations**, for a project. A build that passes goes in the project's build field ("Fixed in build", made for it if it has none), and the resolved issues its commits name are marked as fixed in it (D46).

- **GitHub Actions**: choose a GitHub integration, its branch and its workflow, and tick **Workflow runs** among the webhook's events on GitHub. When the integration reads as a GitHub App (D54), or has an access token that may read the repository's contents, a4a asks GitHub which commits each run holds; otherwise a run holds those a4a saw pushed.
- **Forgejo or Gitea Actions** (D55): choose a Gitea or Forgejo integration, its branch and its workflow's file (`ci.yml`), and tick the run events on its webhook: **Workflow run events**' Success, Failure and Cancelled on Forgejo 17 and later, **Action Run events**' Success and Failure on Forgejo 12 to 16, or **Workflow run** on Gitea. A build is named by its run's number. It holds the commits a4a saw pushed to the branch since the last passing build, and those of the push that started the run, which Forgejo's run carries; these integrations take no token, so a4a asks Forgejo nothing.
- **Any other CI**: the source shows a URL and a token once. Post each build, with the commits since the previous one, from a step at the end of the build. Keep the token in the CI's secrets as `A4A_BUILD_TOKEN`, and the URL as `A4A_BUILD_URL`.

Jenkins (a `sh` step; `GIT_PREVIOUS_SUCCESSFUL_COMMIT` is the Git plugin's):

```bash
curl -fsS -X POST "$A4A_BUILD_URL" -H "Authorization: Bearer $A4A_BUILD_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"build\": \"$BUILD_NUMBER\", \"url\": \"$BUILD_URL\", \"commits\": $(git log --format=%H "$GIT_PREVIOUS_SUCCESSFUL_COMMIT..$GIT_COMMIT" | jq -R . | jq -sc .)}"
```

GitLab CI (a job after the build; `CI_COMMIT_BEFORE_SHA` is the push's previous head):

```bash
curl -fsS -X POST "$A4A_BUILD_URL" -H "Authorization: Bearer $A4A_BUILD_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"build\": \"$CI_PIPELINE_IID\", \"url\": \"$CI_PIPELINE_URL\", \"branch\": \"$CI_COMMIT_BRANCH\", \"commits\": $(git log --format=%H "$CI_COMMIT_BEFORE_SHA..$CI_COMMIT_SHA" | jq -R . | jq -sc .)}"
```

GitHub Actions, posting itself rather than through a workflow-run integration. It sends a range (`github.event.before` is the push's previous head), which a4a reads from GitHub through a GitHub integration of the repository that has an access token or reads as an App:

```bash
curl -fsS -X POST "$A4A_BUILD_URL" -H "Authorization: Bearer $A4A_BUILD_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"build\": \"$GITHUB_RUN_NUMBER\", \"url\": \"$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID\", \"repository\": \"$GITHUB_REPOSITORY\", \"range\": {\"from\": \"${{ github.event.before }}\", \"to\": \"$GITHUB_SHA\"}}"
```

A build reported again is the same build: what it holds now is added. `"status": "failure"` records a failed one, which marks nothing. Find issues by build with `Fixed in build: 1.4.207`, or a range, `Fixed in build: 120 .. 130`.

## VS Code

`packages/vscode` is a4a's extension: your issues in a view, an issue opened beside the code and changed with a command, a new issue from selected code, an issue named in the commit message, and a4a's MCP tools for VS Code's agent. Build it with `pnpm --filter a4a-vscode package`, and install `packages/vscode/dist/a4a.vsix` with **Extensions: Install from VSIX…**. [Its README](packages/vscode/README.md) says how to sign in.

## Production

```bash
docker compose up --build
```

This runs a4a with Postgres 16 on port 3000. See [`docker-compose.yml`](docker-compose.yml) and [`Dockerfile`](Dockerfile).

Without Docker, with `DATABASE_URL` pointing at Postgres:

```bash
pnpm build
```

```bash
pnpm start
```

`pnpm start` serves the built UI too. Put it behind HTTPS and set `PUBLIC_URL`; session cookies are then `Secure`.

### Several instances

On Postgres, run as many instances as you like behind a load balancer, with nothing sticky. [`docker-compose.cluster.yml`](docker-compose.cluster.yml) runs two behind Caddy ([`deploy/Caddyfile`](deploy/Caddyfile)):

```bash
docker compose -f docker-compose.cluster.yml up --build
```

What each instance needs:

- the same `DATABASE_URL` and `PUBLIC_URL` (the address people open, at the proxy);
- the same `SECRET_KEY`, so each can read the secrets another sealed;
- `TRUST_PROXY=1` behind one proxy, so sign-in limits count the client's address rather than the proxy's;
- a `LISTEN` connection straight to Postgres (`DATABASE_LISTEN_URL` if `DATABASE_URL` goes through a pooler in transaction mode);
- a proxy that doesn't buffer `text/event-stream`. Caddy doesn't, and nginx doesn't for a4a's streams, which send `X-Accel-Buffering: no`; their keep-alives, at least every 25 seconds, stay within nginx's default read timeout;
- the same files: a bucket (`ATTACHMENT_STORAGE=s3`), or `DATA_DIR/attachments` on a volume they all mount.

`GET /api/v1/health` names the instance that answered and whether it runs the background work (`"worker": "active"` on one, `"standby"` on the rest). How the instances agree, and what is per instance on purpose, is in [D17](docs/architecture.md#d17-several-instances-on-one-postgres-behave-as-one).

### Files in a bucket

Set `ATTACHMENT_STORAGE=s3` and the `S3_*` settings above. A bucket that can't be reached, or refuses a4a, stops the server as it starts, saying what to check. Downloads still come through a4a, which checks who may see a file, so the bucket needs no public access.

To move the files a server already keeps on disk, run the copy with the server's own settings. First run it while the server still runs on disk:

```bash
pnpm --filter @a4a/server files:to-s3
```

Then stop the server and run it again: it copies only what came since. It checks each copy against the checksum taken at upload, says what it couldn't copy and why, and carries on where a run stopped. Start the server with `ATTACHMENT_STORAGE=s3` once it has copied everything. From a build, it's `node packages/server/dist/files-to-s3.js`; `--dry-run` counts what it would copy. Nothing on disk is deleted. With the embedded database, stop the server before either run: one process at a time may open it.

### Single sign-on with Microsoft Entra ID

Through OpenID Connect. In the Entra admin center, under App registrations, make a new registration:

1. Supported account types: this organizational directory only (single tenant).
2. Redirect URI: platform Web, `PUBLIC_URL/api/v1/auth/oidc/callback`.
3. Under Certificates & secrets, a new client secret; copy its value.
4. Under Token configuration, the optional claims `email` and `xms_edov` in the ID token. Entra sends no `email_verified`: `xms_edov` is how it says the email's domain is one your tenant verified, and without it a first sign-in can't find or make an account. Add a groups claim too, for groups.

Then, on the server:

```
OIDC_ISSUER=https://login.microsoftonline.com/<tenant id>/v2.0
OIDC_CLIENT_ID=<application (client) id>
OIDC_CLIENT_SECRET=<the secret's value>
OIDC_NAME=Microsoft
OIDC_CREATE_USERS=true
OIDC_ALLOWED_DOMAINS=<your domain>
OIDC_GROUPS_CLAIM=groups
```

Entra's groups claim names each group by its object id, not its name: give each a4a group that follows the provider the Entra group's Object ID as its provider name. Or define app roles in the registration, assign groups to them, and set `OIDC_GROUPS_CLAIM=roles` to have names instead. Once sign-in works, `PASSWORD_LOGIN=false` leaves sign-in, and its multi-factor checks, to Entra.

To have Entra add and remove people between sign-ins, make a SCIM token in Administration → Provisioning. In Entra, open the enterprise application, then Provisioning, and set the mode to Automatic: the tenant URL is `https://a4a.example.com/scim/v2` and the secret token is the SCIM token. Entra's default mappings work as they are. A group it provisions follows it under its object id, as the groups claim names it, so provisioning and sign-in agree; someone it deactivates is banned, and keeps their history.

### Chat with Microsoft Teams and Slack

**Teams.** In the Azure portal, create an Azure Bot, single tenant, on an app registration: the one a4a signs people in with, or its own. Give it a client secret, and set the bot's messaging endpoint to `https://a4a.example.com/api/v1/chat/teams/messages`, then turn on its Microsoft Teams channel. On the a4a server:

```
TEAMS_APP_ID=<the app's client id>
TEAMS_APP_PASSWORD=<its client secret>
TEAMS_TENANT_ID=<your tenant id>
```

Then download the app package from the Chat page (Download the Teams app), upload it in the Teams admin center under Manage apps, and add it to a team: a4a lists the team's channels. People who sign in to a4a with Entra ID are known to the bot from their next sign-in (a4a keeps their `oid`); anyone else says "link" to it once. The package's message action, "Create an a4a issue" in a message's More actions, makes an issue of a message in a channel of a team a4a is in (D60); a package uploaded before it came is uploaded again to add it.

**Slack.** Create an app at api.slack.com from scratch. Give its bot the scopes `chat:write`, `commands`, `channels:read`, `groups:read`, `links:read`, `links:write`, and, to make issues of messages (D60), `channels:history`, `groups:history` and `users:read`; add the slash command `/a4a`, interactivity, and event subscriptions (`link_shared`; `member_joined_channel` and `member_left_channel`; `channel_deleted`, `channel_archive` and `channel_rename`, and for private channels `group_deleted`, `group_archive` and `group_rename`; `app_uninstalled` and `tokens_revoked`), each at the URL the Chat page shows; under Interactivity & Shortcuts, add a shortcut on messages, named "Create an a4a issue", with the callback ID `a4a_create_issue`; and add your a4a's domain under App unfurl domains. Install it, then paste its bot token and signing secret on the Chat page. Invite it to a channel with `/invite @a4a`, and subscribe the channel there with `/a4a subscribe BACK`, or on the project's page.

## Development

```bash
pnpm test
```

This runs the web app's three checks, then the server's tests on in-memory PGlite, then the VS Code extension's tests. The checks are `check:design` (a4a's look is all Ocean's: its stylesheets may hold no rules of their own), `check:words` (every catalog has English's messages, and no words people read are written into the code) and `check:problems` (every problem the server makes has a key in the catalogs). To run the server's tests against a real Postgres server, where each test file gets its own database:

```bash
TEST_DATABASE_URL=postgres://user@localhost:5432/postgres pnpm test
```

The role needs `CREATEDB`. With Postgres, `test/cluster.test.ts` also runs: two instances against one database (live events across them, the cache, the shared sign-in throttle, the worker lease and its handover). Without `TEST_DATABASE_URL` it is skipped. In CI, give the job a Postgres 16 service, for example on GitHub Actions:

```yaml
services:
  postgres:
    image: postgres:16
    env:
      POSTGRES_PASSWORD: postgres
    ports: ['5432:5432']
    options: --health-cmd pg_isready --health-interval 5s --health-retries 10
env:
  TEST_DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres
```

Then `pnpm install --frozen-lockfile` and `pnpm test` as usual. Running the suite once without `TEST_DATABASE_URL` as well keeps PGlite covered.

The S3 store's tests run against a fake S3 server they start themselves. `test/s3-live.test.ts` runs against a real one when `TEST_S3_ENDPOINT` names it, with `TEST_S3_BUCKET`, `TEST_S3_ACCESS_KEY_ID` and `TEST_S3_SECRET_ACCESS_KEY`; CI gives it MinIO, built from its source at a pinned commit. Without them it is skipped.

The types of every package, and of the browser specs, are checked with:

```bash
pnpm typecheck
```

The AI's tests use a scripted model. To run every AI feature against a real one, on the demo data, with the provider's key set as above (it costs a little):

```bash
pnpm --filter @a4a/server test:live
```

CI runs these for DeepSeek and Qwen, on `main` and when run by hand, each when its key is a repository secret (`DEEPSEEK_API_KEY`, `QWEN_API_KEY`); one without its key is skipped. It doesn't run Claude live; the command above does, with `ANTHROPIC_API_KEY` set.

| Path | What |
| --- | --- |
| `packages/shared` | The contract: zod schemas for every request and response, used for validation, OpenAPI and the UI's types; and each language's catalog (`i18n/`) with its translator |
| `packages/server` | Services, the query and command languages, the planning engine, AI, MCP, the HTTP API, the outbox worker |
| `packages/mcp-bridge` | `a4a-mcp`, the stdio bridge |
| `packages/vscode` | The VS Code extension |
| `apps/web` | The web UI on Ocean |
| `docs/` | [What the API and MCP can do](docs/mcp-and-api.md), [the architecture and its decisions](docs/architecture.md), [translating a4a](docs/translating.md) and [the questions for native speakers](docs/translation-questions.md) |

The schema lives in `packages/server/src/db/schema.ts`. Migrations are generated with:

```bash
pnpm db:generate
```

They run on start.

## End-to-end tests

Playwright drives Chromium through the web app as people use it, against the production build: the real server serves the built UI under its real CSP, on a fresh embedded database with the demo projects, started for the run and removed after it. AI is off on that server; where a flow needs it, the browser's requests to the AI endpoints are answered by the test (the server's own AI is tested by its vitest suite). The other services a flow meets are stood in for on this machine: a webhook's receiver, Teams' Bot Framework, Slack's API, a Forgejo, GitHub's API, a YouTrack, ClickUp, a push service and an identity provider. A flow that needs email, or a passkey (which needs localhost, not an IP address), starts an a4a server of its own, beside a mail server.

The browser tests need Node 22.12 or later, as axe does. Once, for the browser:

```bash
pnpm --filter @a4a/web exec playwright install --with-deps chromium
```

Then, which builds first:

```bash
pnpm test:e2e
```

- `pnpm --filter @a4a/web test:e2e` runs them without building again.
- Arguments go to Playwright: `pnpm test:e2e issue.spec.ts`, `pnpm test:e2e -g "levelling"`, `pnpm test:e2e --headed`.
- The server listens on a free port; set `E2E_PORT` to choose it, `E2E_HOOK_PORT` for the webhook receiver the tests start, and `E2E_TEAMS_PORT`, `E2E_SLACK_PORT` and `E2E_FORGEJO_PORT` for the stand-ins the server is told of before it starts.

What it covers, in `apps/web/e2e`:

- **The tour**: every page, light, dark and at 390px, with no console errors, no CSP violations, no sideways scroll, and nothing axe finds against WCAG 2.2 AA. It includes what only the AI fills (a conversation waiting on its approvals, triage's suggestions), stood in for.
- **Each language**: German, Spanish, French, Japanese, Korean, Portugal's Portuguese, Vietnamese, Indonesian, Thai and Simplified Chinese, a spec each: a browser that asks for the language gets the sign-in page and the pages it opens in it, dates too, and its problems, in light, in dark and at 390px.
- **On a phone**: installable, opening offline and saying so, push turned on and off and what a push shows, sharing into New issue, and the pages people use, at a Pixel 7's size.
- **Issues**: a query's problem and its fix, suggestions from the keyboard, rows chosen from the keyboard and a command previewed then applied, saved searches, a query read from words.
- **An issue**: a field changed from the keyboard, links, comments, logged time, triage's values accepted one at a time, the summary, and a save refused (409) when someone changed the issue first.
- **Reporting**: similar issues while typing, and a retry that doesn't duplicate (`Idempotency-Key`).
- **Moving and renaming**: an issue moved, with what doesn't carry over asked for first and its old address going to its new id; a clone linked back; a reaction and a vote; a project's key renamed, typed twice, with an old link still opening its issue and the old key still finding the project.
- **Writing and files**: Markdown kept as it was written, a pasted screenshot uploaded into the text, a checklist ticked against the version read; a log read from its start or its end, sound and video played in ranges, and HTML shown as its source.
- **Boards**: dragging (saved with `expectedVersion`), moving from the keyboard, and a move refused; cards ranked in their column and into another at a place, by dragging and with Alt and an arrow, and someone else's rank shown without a reload.
- **Sprints and time**: a sprint planned from a board's backlog, its load against capacity and the velocity chart; a timer, and work logged with a work type and corrected in the weekly timesheet, against a working week of one's own.
- **Plans**: the what-if, baselines, levelling, and levelling refused (409); days away entered by a manager and followed by the grid and the schedule, a person's own on their profile, and the grid's days remembered.
- **Whiteboards**: two people editing one at once, each seeing the other's changes and who's looking, and an undo; notes made issues and their arrow a link, and a card following its issue; from the keyboard.
- **Reports**: issues per field and the matrix, each count opening its issues, average age and time in state, as CSV and as dashboard widgets.
- **Notifications**: subscriptions to a project's new issues and to a saved search, reaching the inbox and listed on the profile; and a person's time zone, where their searches read "today".
- **Rules**: a rule acting as the workflow agent, and a guard refusing a change in its own words; a rule across issues, and one that tells people; a script's syntax error and test run, a state machine's moves and an action's button.
- **Version control and CI**: a signed GitHub push linking its commit and running its command as its author; a Bitbucket login an administrator records, and emails people add; a Forgejo account connected; a GitHub integration given an App; builds posted with a token, and from Forgejo's Actions, marking the issues they name.
- **Importing**: from YouTrack's API, with comments, work items and files, and from ClickUp's, with checklists, comments and time tracked.
- **The help desk**: a request by email, and the form's proof of work; working hours, SLA targets and the portal; a customer group's domain and agent, and a colleague answering on the portal; a CC answering by email and on the portal; the portal's sign-in by a password and by an identity provider.
- **Chat**: a Teams channel told of a project, and someone linking their Teams account; a Slack message made an issue, as whoever asked.
- **Management**: tokens (one limited to projects too) and the MCP setup, webhooks (a test delivery, checked against its signature, and pausing), fields, projects, people and passwords.
- **Signing in**: two-factor, with a code and with a recovery code, an administrator's reset, and a SCIM token; a passkey added, signed in with alone and removed, and its mail's "This wasn't me"; an app signing in to MCP with OAuth, allowed and revoked.
- **Agents and apps**: an agent acting as itself, and its change undone from the issue's history; an app installed for a project, its widget drawn in a sandboxed frame, then removed.
- **Access**: a manager makes a project members only and gives someone a role in it; to someone outside, it and its issues don't exist; a viewer reads and comments, and is offered nothing that would change an issue.
- **Groups**: an administrator makes a group and puts someone in it, and a project gives the group a role; someone in it sees a members-only project as far as that role goes, and not once they're taken out; a group from the identity provider can't be filled by hand.
- **Access in depth**: an administrator makes a role and a project gives it; an issue and a comment limited to one person are missing to another, and so are an article and what's under it; a project opened to guests is read signed out.
- **Guests beyond issues**: signed out, a guest reads a guest-open project's board, reports, plan and whiteboard (live), with nothing offered that changes them, and finds nothing of a project that isn't open.
- **Private fields**: a manager attaches a field as private, and a viewer finds the issue without it, its value nowhere on the page.
- **The assistant**: a streamed answer, its approval cards, the decisions and the result.
- **Writing help**: a line selected in a description fixed, shown as a change, accepted and saved; the whole text rewritten, and the suggestion discarded; an issue summarised and posted as the assistant's comment; a reply drafted on a help desk request and sent; and nothing offered without a provider. The AI is stood in for.

To see what a test did, record a trace and open it:

```bash
pnpm test:e2e issue.spec.ts --trace on
```

```bash
pnpm --filter @a4a/web exec playwright show-trace test-results/<the test>/trace.zip
```

With `CI` set, a failed test is retried twice, its first retry is traced, and the HTML report is written to `apps/web/playwright-report`. a4a's own CI runs the suite with `--trace off`, and keeps the report and the failures' screenshots for a week when a run fails.

A new page joins the tour with one line in `tour.spec.ts`. A new flow is a spec that takes `test` from `e2e/support/fixtures.ts`, so its page's clock is fixed and its console is watched; makes a project of its own (`uniqueKey`), so it runs beside the others; and finds things by their roles and labels.
