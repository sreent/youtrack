/** Reference guides served to people (docs), agents (MCP resources) and the assistant. */

export const QUERY_LANGUAGE_GUIDE = `# a4a query language

A query is a list of terms; terms side by side must all match ("and").

## Field terms
\`Field: value\` — any custom field by name, values by name. Multi-word names and values need no quotes.
- \`State: In Progress\`, \`Priority: Critical, Major\` (comma = any of), \`Type: Bug\`
- \`Assignee: anna\`, \`for: me\` (assignee shortcut), \`Assignee: Unassigned\`
- \`Fix versions: 2.0\`, \`Subsystem: Auth\`, \`Estimation: 2d .. 5d\`, \`Due date: -7d .. {next week}\`
- Exclude a value with a minus: \`State: -Duplicate\`, or a whole term: \`-tag: flaky\`

## Attributes
- \`project: BACK\` · \`issue id: BACK-12\` (or just type \`BACK-12\`)
- \`summary: words\` · \`description: words\`
- \`reporter: ben\` (also \`by:\`) · \`updated by: anna\` · \`commenter: chloe\`
- \`created: 2026-01-01 .. 2026-01-31\` · \`updated: today\` · \`resolved date: {this week}\`
- \`tag: regression\` · \`sprint: Sprint 14\` · \`spent time: 1d .. *\`
- \`has: Assignee\` (field set) · \`has: -Assignee\` (empty) · \`has: comments\`, \`links\`, \`tags\`, \`subtasks\`, \`parent\`, \`work\`
- Links: \`depends on: BACK-3\`, \`is required for: BACK-3\`, \`subtask of: BACK-1\`, \`parent for: BACK-5\`, \`duplicates: BACK-7\`, \`relates to: WEB-2\`, \`links: BACK-3\` (any link)

## Shortcuts
\`#Unresolved\`, \`#Resolved\`, \`#me\` (assigned to me), \`#Unassigned\`, \`#Critical\` or \`#{In Progress}\` (a field value), \`#regression\` (a tag)

## Text
Other words search summaries, descriptions and comments, by prefix: \`login saf\`. Quote an exact phrase: \`"rate limit"\`.

## Dates
\`today\`, \`yesterday\`, \`tomorrow\`, \`{this week}\`, \`{last week}\`, \`{this month}\`, \`{last month}\`, \`{this year}\`, \`-7d\` (7 days ago), \`+2w\`, \`YYYY-MM-DD\`, \`Overdue\` (any day before today: \`Due date: Overdue\`). Ranges: \`a .. b\`, open ends with \`*\`.

## Combining and sorting
\`and\`, \`or\`, parentheses: \`(Type: Bug or Type: Feature) project: WEB\`
\`sort by: Priority, updated desc\` — fields with values sort by their order (most important first).

## From plain words
- "Open", "to do" and "not done" mean unresolved: \`#Unresolved\`. \`State: Open\` is only the state called Open.
- "Newest first" is \`sort by: created desc\`; "recently changed", \`sort by: updated desc\`.

## Examples
- My open work, most important first: \`for: me #Unresolved sort by: Priority\`
- Critical bugs reported this week: \`Type: Bug Priority: Show-stopper, Critical created: {this week}\`
- Untriaged: \`State: Submitted has: -Assignee\`
- Blockers of BACK-3: \`is required for: BACK-3 #Unresolved\`
`;

export const COMMAND_GUIDE = `# a4a commands

A command changes one or more issues at once. Clauses are applied in order.

- Set a field: \`State Fixed\`, \`Priority Critical\`, \`Assignee anna\`, \`Estimation 2d 4h\`, \`Due date 2026-03-01\`
- Leave out the field name when the value is unambiguous: \`Critical In Progress\`
- Assign: \`for me\`, \`for anna\`; clear a field: \`Assignee none\`
- Multi-value fields add by default: \`Fix versions 2.0\`; \`remove Fix versions 1.1\`
- Tags: \`tag regression\`, \`untag needs-info\` (or \`remove tag needs-info\`)
- Links: \`subtask of BACK-3\`, \`depends on BACK-2\`, \`duplicates BACK-7\`, \`relates to WEB-4\`; \`remove depends on BACK-2\`
- Comment: \`comment Fixed in a1b2c3\` (everything after "comment")

Preview first with dry_run / dryRun: the result lists every change per issue. Commands apply to at most 50 issues per call.
`;
