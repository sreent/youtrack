import { isOptionType } from '@a4a/shared';
import type { CountResult, IssueList, QueryExplained, QueryProblem } from '@a4a/shared';
import { and, sql, type SQL } from 'drizzle-orm';
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

export async function searchIssueRows(
  ctx: Ctx,
  query: string,
  opts: { offset?: number; limit?: number; projectId?: string; projectIds?: string[]; extraWhere?: SQL } = {},
): Promise<{ total: number; rows: IssueRow[] }> {
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
  const [rows, countRows] = await Promise.all([
    ctx.db
      .select()
      .from(issues)
      .where(where)
      .orderBy(...compiled.orderBy)
      .limit(limit)
      .offset(opts.offset ?? 0),
    ctx.db.select({ n: sql<number>`count(*)::int` }).from(issues).where(where),
  ]);
  return { total: Number(countRows[0]?.n ?? 0), rows };
}

export async function searchIssues(ctx: Ctx, query: string, offset = 0, limit = 50): Promise<IssueList> {
  const { total, rows } = await searchIssueRows(ctx, query, { offset, limit });
  return { total, items: await issueDtos(ctx, rows) };
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
