import { isOptionType, type FieldType } from '@a4a/shared';
import type { CountResult, GroupFields, IssueGroup, IssueList, QueryExplained, QueryProblem } from '@a4a/shared';
import { and, getTableColumns, sql, type SQL } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import { issues } from '../db/schema';
import { badRequest, saidProblems } from '../lib/errors';
import { issueDtos, type IssueRow } from '../services/issues';
import { fieldByName } from '../services/schema-cache';
import { commentSeenSql, fieldSeenSql, issueSeenSql, projectAccess, scopeFields, scopeSchema, visibleSchema } from '../services/access';
import { zoneOf } from '../services/time-zones';
import { compileQuery, type CompiledQuery } from './compiler';
import { translatorFor } from '../i18n';
import { explainParts, explanationOf } from './explain';
import { withFixes } from './lexer';
import { parseQuery, type ParsedQuery } from './parser';
import { buildVocabulary } from './vocabulary';

export interface PreparedQuery {
  parsed: ParsedQuery;
  compiled: CompiledQuery;
  explanation: string;
  /** The explanation in pieces, for a page that counts what it found (D49). */
  explained: QueryExplained;
}

/**
 * Parse and compile a query as the caller sees the tracker: a project they can't see, and its
 * own values, are unknown words to them, exactly as ones that don't exist; and only issues in
 * projects they can see ever match, and of those only the ones not limited away from them (D37),
 * whose words match only in comments they see. A private field kept from them everywhere is an unknown
 * word too; one kept from them in some projects matches, sorts and counts there as empty (D50).
 */
export async function prepareQuery(ctx: Ctx, query: string, extra?: { projectId?: string; /** Read as everyone at once: no private field (D50), as a chat channel's search is. */ everyone?: boolean }): Promise<PreparedQuery> {
  const view = await projectAccess(ctx);
  const visible = view.visibleIds();
  const full = await ctx.app.schema.get();
  const reader = extra?.everyone ? null : view;
  const s = scopeFields(scopeSchema(full, visible), reader);
  const vocab = buildVocabulary(s);
  const parsed = parseQuery(query, vocab);
  // Dates are read where the asker is (D31): "today" is their today.
  const zone = zoneOf(ctx);
  const compiled = compileQuery(parsed, { s, meId: ctx.actor.user.id, timeZone: zone, commentSeen: commentSeenSql(view), fieldSeen: (fieldId) => fieldSeenSql(reader, full, fieldId) });
  if (extra?.projectId) {
    const scope = sql`${issues.projectId} = ${extra.projectId}`;
    compiled.where = compiled.where ? sql`(${scope} AND ${compiled.where})` : scope;
  }
  if (visible !== null) {
    const scope = visible.length
      ? sql`${issues.projectId} IN (${sql.join(visible.map((id) => sql`${id}`), sql`, `)})`
      : sql`FALSE`;
    compiled.where = compiled.where ? sql`(${scope} AND ${compiled.where})` : scope;
  }
  const seen = issueSeenSql(view, full);
  if (seen) compiled.where = compiled.where ? (and(seen, compiled.where) ?? seen) : seen;
  // A search whose dates depend on where you are says where it read them.
  // In the page's language when a page asks (D49); English for an agent or a script.
  const tr = translatorFor(ctx.pageLocale ?? 'en');
  const parts = explainParts(parsed, tr);
  const said = explanationOf(parts, tr);
  return {
    parsed,
    compiled,
    explanation: compiled.readsDates ? tr.t('server.query.datesIn', { explanation: said, zone }) : said,
    explained: { ...parts, zone: compiled.readsDates ? zone : null },
  };
}

function formatProblems(problems: QueryProblem[]): string {
  return problems.map((p) => (p.hint ? `${p.message} (${p.hint})` : p.message)).join('; ');
}

/** Compile or throw a 400 with positions + hints (agent-friendly). */
export async function compileOrThrow(ctx: Ctx, query: string, extra?: { projectId?: string }): Promise<PreparedQuery> {
  const prepared = await prepareQuery(ctx, query, extra);
  if (prepared.compiled.problems.length) {
    const fixed = withFixes(query, prepared.compiled.problems);
    throw badRequest(`Invalid query: ${formatProblems(prepared.compiled.problems)}`, 'See GET /api/v1/search/suggest or the query language guide.', {
      problems: prepared.compiled.problems,
      ...(fixed !== null ? { fixed } : {}),
    }).said('query.invalid', { problems: saidProblems(prepared.compiled.problems) });
  }
  return prepared;
}

/**
 * How a list is grouped by a field (D72): `key` is each issue's first value of it, as the reader sees it
 * (through fieldSeenSql, so where it's kept from them an issue has none), and `order(k)` orders the
 * groups by a key. The order is a function of the key alone, so each group's issues come together.
 */
interface Grouping {
  key: SQL;
  order: (k: SQL) => SQL[];
}

/** The field types a list can't be grouped by: a text's every value is a group of its own. */
const UNGROUPABLE: readonly FieldType[] = ['text'];

async function groupingBy(ctx: Ctx, name: string): Promise<Grouping> {
  const s = await visibleSchema(ctx);
  const field = fieldByName(s, name);
  if (!field || UNGROUPABLE.includes(field.type)) {
    throw badRequest(`Cannot group issues by "${name}"`, 'Group them by a field of their projects, by its name, other than a text field.').said('issues.cannotGroupBy', { field: name });
  }
  const seen = fieldSeenSql(await projectAccess(ctx), await ctx.app.schema.get(), field.id);
  const of = sql`ifv.issue_id = ${issues.id} AND ifv.field_id = ${field.id}${seen ? sql` AND ${seen}` : sql``}`;
  const last = (e: SQL) => sql`${e} ASC NULLS LAST`;
  const byWords = (k: SQL) => [last(sql`lower(${k})`), last(k)];
  if (isOptionType(field.type)) {
    // An option's place is its field's order; values of the same name in several projects are one group, at the first's place.
    const rank = new Map<string, number>();
    for (const v of [...(s.valuesByField.get(field.id) ?? [])].sort((a, b) => a.ordinal - b.ordinal)) if (!rank.has(v.name)) rank.set(v.name, rank.size);
    const cases = [...rank].map(([value, i]) => sql`WHEN ${value} THEN ${i}::int`);
    return {
      key: sql`(SELECT fv.name FROM issue_field_values ifv JOIN field_values fv ON fv.id = ifv.value_id WHERE ${of} ORDER BY fv.ordinal, fv.name LIMIT 1)`,
      order: (k) => [...(cases.length ? [last(sql`(CASE ${k} ${sql.join(cases, sql` `)} END)`)] : []), last(k)],
    };
  }
  switch (field.type) {
    case 'user':
      return { key: sql`(SELECT u.login FROM issue_field_values ifv JOIN users u ON u.id = ifv.user_id WHERE ${of} ORDER BY lower(u.login), u.login LIMIT 1)`, order: byWords };
    case 'group':
      return { key: sql`(SELECT g.name FROM issue_field_values ifv JOIN groups g ON g.id = ifv.group_id WHERE ${of} ORDER BY lower(g.name), g.name LIMIT 1)`, order: byWords };
    case 'string':
      return { key: sql`(SELECT ifv.text_value FROM issue_field_values ifv WHERE ${of} AND ifv.text_value IS NOT NULL ORDER BY lower(ifv.text_value), ifv.text_value LIMIT 1)`, order: byWords };
    case 'date':
      return { key: sql`(SELECT min(ifv.date_value)::text FROM issue_field_values ifv WHERE ${of})`, order: (k) => [last(k)] };
    case 'datetime':
      // By the day, where the asker is, as counting by it is.
      return { key: sql`(SELECT to_char(min(ifv.time_value) AT TIME ZONE ${zoneOf(ctx)}, 'YYYY-MM-DD') FROM issue_field_values ifv WHERE ${of})`, order: (k) => [last(k)] };
    default:
      // integer, float, period (in minutes): a number, sent as its text.
      return { key: sql`(SELECT min(ifv.number_value)::text FROM issue_field_values ifv WHERE ${of})`, order: (k) => [last(sql`(${k})::double precision`)] };
  }
}

export async function searchIssueRows(
  ctx: Ctx,
  query: string,
  opts: { offset?: number; limit?: number; projectId?: string; projectIds?: string[]; extraWhere?: SQL } = {},
): Promise<{ total: number; rows: IssueRow[] }> {
  const { total, rows } = await searchRows(ctx, query, opts);
  return { total, rows };
}

/** searchIssueRows, and grouped by a field (D72) when `group` names one: each row's group, and every group's count. */
async function searchRows(
  ctx: Ctx,
  query: string,
  opts: { offset?: number; limit?: number; projectId?: string; projectIds?: string[]; extraWhere?: SQL; group?: string },
): Promise<{ total: number; rows: (IssueRow & { groupValue?: string | null })[]; groups?: IssueGroup[] }> {
  requireScope(ctx, 'read');
  const { compiled } = await compileOrThrow(ctx, query, { projectId: opts.projectId });
  const parts: SQL[] = [compiled.where ?? sql`TRUE`];
  if (opts.projectIds) {
    parts.push(
      opts.projectIds.length ? sql`${issues.projectId} IN (${sql.join(opts.projectIds.map((id) => sql`${id}`), sql`, `)})` : sql`FALSE`,
    );
  }
  if (opts.extraWhere) parts.push(opts.extraWhere);
  const where = sql.join(parts, sql` AND `);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
  const offset = opts.offset ?? 0;
  const count = ctx.db.select({ n: sql<number>`count(*)::int` }).from(issues).where(where);
  if (!opts.group) {
    const [rows, countRows] = await Promise.all([ctx.db.select().from(issues).where(where).orderBy(...compiled.orderBy).limit(limit).offset(offset), count]);
    return { total: Number(countRows[0]?.n ?? 0), rows };
  }
  // Grouped: by the group's order, then the query's; and each group counted over the whole result, not the page.
  const g = await groupingBy(ctx, opts.group);
  const [rows, countRows, grouped] = await Promise.all([
    ctx.db
      .select({ ...getTableColumns(issues), groupValue: sql<string | null>`${g.key}` })
      .from(issues)
      .where(where)
      .orderBy(...g.order(g.key), ...compiled.orderBy)
      .limit(limit)
      .offset(offset),
    count,
    ctx.db.execute(sql`SELECT t.value, count(*)::int AS count FROM (SELECT ${g.key} AS value FROM issues WHERE ${where}) t GROUP BY t.value ORDER BY ${sql.join(g.order(sql`t.value`), sql`, `)}`),
  ]);
  const groups = (grouped as unknown as { rows: { value: string | null; count: number }[] }).rows.map((r) => ({ value: r.value ?? null, count: Number(r.count) }));
  return { total: Number(countRows[0]?.n ?? 0), rows, groups };
}

export async function searchIssues(ctx: Ctx, query: string, offset = 0, limit = 50, group?: string): Promise<IssueList> {
  const { total, rows, groups } = await searchRows(ctx, query, { offset, limit, group });
  const items = await issueDtos(ctx, rows);
  if (!groups) return { total, items };
  return { total, items: items.map((item, i) => ({ ...item, group: rows[i]!.groupValue ?? null })), groups };
}

/**
 * What a search's issues can be grouped by (D72): the fields every project they're in has, as the reader
 * sees them, so a field kept from them in one of those projects isn't offered. None when it finds nothing.
 */
export async function groupFields(ctx: Ctx, query: string): Promise<GroupFields> {
  requireScope(ctx, 'read');
  const { compiled } = await compileOrThrow(ctx, query);
  const found = await ctx.db
    .selectDistinct({ projectId: issues.projectId })
    .from(issues)
    .where(compiled.where ?? sql`TRUE`);
  const s = await visibleSchema(ctx);
  const projects = found.map((r) => s.projects.get(r.projectId)).filter((p): p is NonNullable<typeof p> => Boolean(p)).sort((a, b) => a.key.localeCompare(b.key));
  if (!projects.length) return { projects: [], fields: [] };
  const own = (projectId: string) => [...(s.projectFields.get(projectId) ?? [])].sort((a, b) => a.ordinal - b.ordinal).map((pf) => pf.fieldId);
  const everywhere = projects.slice(1).reduce((ids, p) => ids.filter((id) => own(p.id).includes(id)), own(projects[0]!.id));
  const fields = everywhere.map((id) => s.fields.get(id)).filter((f): f is NonNullable<typeof f> => Boolean(f) && !UNGROUPABLE.includes(f!.type));
  return { projects: projects.map((p) => p.key), fields: fields.map((f) => ({ name: f.name, type: f.type })) };
}

export async function countIssues(ctx: Ctx, query: string, groupBy?: string): Promise<CountResult> {
  requireScope(ctx, 'read');
  // A field kept from the caller can't be grouped by, and counts as empty where it's kept (D50).
  const s = await visibleSchema(ctx);
  const { compiled } = await compileOrThrow(ctx, query);
  const where = compiled.where ?? sql`TRUE`;
  const [{ n } = { n: 0 }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(issues).where(where);
  const total = Number(n);
  if (!groupBy) return { total, groups: [] };

  const key = groupBy.trim().toLowerCase();
  let grouped: SQL;
  if (key === 'project') {
    grouped = sql`SELECT p.key AS value, count(*)::int AS count FROM issues JOIN projects p ON p.id = issues.project_id WHERE ${where} GROUP BY p.key ORDER BY count DESC`;
  } else if (key === 'tag' || key === 'tags') {
    grouped = sql`SELECT t.name AS value, count(DISTINCT issues.id)::int AS count FROM issues LEFT JOIN issue_tags it ON it.issue_id = issues.id LEFT JOIN tags t ON t.id = it.tag_id WHERE ${where} GROUP BY t.name ORDER BY count DESC`;
  } else if (key === 'reporter') {
    grouped = sql`SELECT u.login AS value, count(*)::int AS count FROM issues LEFT JOIN users u ON u.id = issues.reporter_id WHERE ${where} GROUP BY u.login ORDER BY count DESC`;
  } else if (key === 'resolved') {
    grouped = sql`SELECT CASE WHEN issues.resolved_at IS NULL THEN 'Unresolved' ELSE 'Resolved' END AS value, count(*)::int AS count FROM issues WHERE ${where} GROUP BY 1 ORDER BY count DESC`;
  } else {
    const field = fieldByName(s, groupBy);
    if (!field) throw badRequest(`Cannot group by "${groupBy}"`, 'Use a custom field name, project, tag, reporter or resolved.').said('query.cannotGroupBy', { field: groupBy });
    const seen = fieldSeenSql(await projectAccess(ctx), await ctx.app.schema.get(), field.id);
    const kept = seen ? sql` AND ${seen}` : sql``;
    if (isOptionType(field.type)) {
      grouped = sql`SELECT fv.name AS value, count(DISTINCT issues.id)::int AS count, min(fv.ordinal) AS ord FROM issues LEFT JOIN issue_field_values ifv ON ifv.issue_id = issues.id AND ifv.field_id = ${field.id}${kept} LEFT JOIN field_values fv ON fv.id = ifv.value_id WHERE ${where} GROUP BY fv.name ORDER BY ord NULLS LAST`;
    } else if (field.type === 'user') {
      grouped = sql`SELECT u.login AS value, count(DISTINCT issues.id)::int AS count FROM issues LEFT JOIN issue_field_values ifv ON ifv.issue_id = issues.id AND ifv.field_id = ${field.id}${kept} LEFT JOIN users u ON u.id = ifv.user_id WHERE ${where} GROUP BY u.login ORDER BY count DESC`;
    } else if (field.type === 'group') {
      grouped = sql`SELECT g.name AS value, count(DISTINCT issues.id)::int AS count FROM issues LEFT JOIN issue_field_values ifv ON ifv.issue_id = issues.id AND ifv.field_id = ${field.id}${kept} LEFT JOIN groups g ON g.id = ifv.group_id WHERE ${where} GROUP BY g.name ORDER BY count DESC`;
    } else if (field.type === 'datetime') {
      // By the day, where the asker is.
      const day = sql`to_char(ifv.time_value AT TIME ZONE ${zoneOf(ctx)}, 'YYYY-MM-DD')`;
      grouped = sql`SELECT ${day} AS value, count(DISTINCT issues.id)::int AS count FROM issues LEFT JOIN issue_field_values ifv ON ifv.issue_id = issues.id AND ifv.field_id = ${field.id}${kept} WHERE ${where} GROUP BY 1 ORDER BY 1 NULLS LAST`;
    } else if (field.type === 'date') {
      grouped = sql`SELECT ifv.date_value::text AS value, count(DISTINCT issues.id)::int AS count FROM issues LEFT JOIN issue_field_values ifv ON ifv.issue_id = issues.id AND ifv.field_id = ${field.id}${kept} WHERE ${where} GROUP BY ifv.date_value ORDER BY ifv.date_value NULLS LAST`;
    } else {
      grouped = sql`SELECT coalesce(ifv.text_value, ifv.number_value::text) AS value, count(DISTINCT issues.id)::int AS count FROM issues LEFT JOIN issue_field_values ifv ON ifv.issue_id = issues.id AND ifv.field_id = ${field.id}${kept} WHERE ${where} GROUP BY 1 ORDER BY count DESC`;
    }
  }
  const res = await ctx.db.execute(grouped);
  const rows = (res as unknown as { rows: { value: string | null; count: number }[] }).rows;
  return { total, groups: rows.map((r) => ({ value: r.value ?? null, count: Number(r.count) })) };
}

export async function parseQueryForApi(ctx: Ctx, query: string) {
  const prepared = await prepareQuery(ctx, query);
  return {
    ok: prepared.compiled.problems.length === 0,
    problems: prepared.compiled.problems,
    explanation: prepared.explanation,
    explained: prepared.explained,
  };
}
