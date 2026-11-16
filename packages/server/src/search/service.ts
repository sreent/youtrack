import type { CountResult, IssueList, QueryProblem } from '@a4a/shared';
import { sql, type SQL } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import { issues } from '../db/schema';
import { badRequest } from '../lib/errors';
import { issueDtos, type IssueRow } from '../services/issues';
import { fieldByName } from '../services/schema-cache';
import { projectAccess, scopeSchema } from '../services/access';
import { zoneOf } from '../services/time-zones';
import { compileQuery, type CompiledQuery } from './compiler';
import { explainParsed } from './explain';
import { withFixes } from './lexer';
import { parseQuery, type ParsedQuery } from './parser';
import { buildVocabulary } from './vocabulary';

export interface PreparedQuery {
  parsed: ParsedQuery;
  compiled: CompiledQuery;
  explanation: string;
}

/**
 * Parse and compile a query as the caller sees the tracker: a project they can't see, and its
 * own values, are unknown words to them, exactly as ones that don't exist; and only issues in
 * projects they can see ever match.
 */
export async function prepareQuery(ctx: Ctx, query: string, extra?: { projectId?: string }): Promise<PreparedQuery> {
  const view = await projectAccess(ctx);
  const visible = view.visibleIds();
  const s = scopeSchema(await ctx.app.schema.get(), visible);
  const vocab = buildVocabulary(s);
  const parsed = parseQuery(query, vocab);
  // Dates are read where the asker is (D31): "today" is their today.
  const zone = zoneOf(ctx);
  const compiled = compileQuery(parsed, { s, meId: ctx.actor.user.id, timeZone: zone });
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
  // A search whose dates depend on where you are says where it read them.
  const explained = explainParsed(parsed);
  return { parsed, compiled, explanation: compiled.readsDates ? `${explained} (dates in ${zone})` : explained };
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
    });
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
  const s = await ctx.app.schema.get();
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
    if (!field) throw badRequest(`Cannot group by "${groupBy}"`, 'Use a custom field name, project, tag, reporter or resolved.');
    if (field.type === 'enum' || field.type === 'state' || field.type === 'version') {
      grouped = sql`SELECT fv.name AS value, count(DISTINCT issues.id)::int AS count, min(fv.ordinal) AS ord FROM issues LEFT JOIN issue_field_values ifv ON ifv.issue_id = issues.id AND ifv.field_id = ${field.id} LEFT JOIN field_values fv ON fv.id = ifv.value_id WHERE ${where} GROUP BY fv.name ORDER BY ord NULLS LAST`;
    } else if (field.type === 'user') {
      grouped = sql`SELECT u.login AS value, count(DISTINCT issues.id)::int AS count FROM issues LEFT JOIN issue_field_values ifv ON ifv.issue_id = issues.id AND ifv.field_id = ${field.id} LEFT JOIN users u ON u.id = ifv.user_id WHERE ${where} GROUP BY u.login ORDER BY count DESC`;
    } else if (field.type === 'date') {
      grouped = sql`SELECT ifv.date_value::text AS value, count(DISTINCT issues.id)::int AS count FROM issues LEFT JOIN issue_field_values ifv ON ifv.issue_id = issues.id AND ifv.field_id = ${field.id} WHERE ${where} GROUP BY ifv.date_value ORDER BY ifv.date_value NULLS LAST`;
    } else {
      grouped = sql`SELECT coalesce(ifv.text_value, ifv.number_value::text) AS value, count(DISTINCT issues.id)::int AS count FROM issues LEFT JOIN issue_field_values ifv ON ifv.issue_id = issues.id AND ifv.field_id = ${field.id} WHERE ${where} GROUP BY 1 ORDER BY count DESC`;
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
  };
}
