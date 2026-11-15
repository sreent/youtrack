import type { SimilarIssue } from '@a4a/shared';
import { sql } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import { prefixTsQuery } from '../search/compiler';
import { visibleProjectIds } from '../services/access';
import { findIssue } from '../services/issues';
import { issueRefsById } from '../services/issue-refs';
import { projectByKey } from '../services/schema-cache';

export interface SimilarQuery {
  summary: string;
  description?: string;
  project?: string;
  excludeIssue?: string;
  limit?: number;
}

/**
 * Lexical candidates for "is this a duplicate?": trigram similarity of summaries
 * plus full-text rank over summary and description. Cheap, needs no model, and
 * good at recall; the AI judge (ai/duplicates.ts) adds precision.
 */
export async function findSimilar(ctx: Ctx, q: SimilarQuery): Promise<SimilarIssue[]> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const limit = Math.min(Math.max(q.limit ?? 5, 1), 20);
  const text = `${q.summary} ${q.description ?? ''}`.slice(0, 2000);
  // OR the words so partial overlaps rank; ts_rank weights the summary (A) higher.
  const words = prefixTsQuery(text)?.split(' & ') ?? [];
  const tsq = words.length ? words.slice(0, 24).join(' | ') : null;
  const project = q.project ? projectByKey(s, q.project) : undefined;
  const exclude = q.excludeIssue ? await findIssue(ctx.db, s, q.excludeIssue) : undefined;
  const visible = await visibleProjectIds(ctx);
  const conds = [sql`TRUE`];
  if (project) conds.push(sql`i.project_id = ${project.id}`);
  if (exclude) conds.push(sql`i.id <> ${exclude.id}`);
  if (visible) conds.push(visible.length ? sql`i.project_id IN (${sql.join(visible.map((v) => sql`${v}`), sql`, `)})` : sql`FALSE`);
  const rank = tsq ? sql`ts_rank(i.search_vector, to_tsquery('english', ${tsq}))` : sql`0`;
  const res = await ctx.db.execute(sql`
    SELECT i.id, i.project_id,
           similarity(i.summary, ${q.summary}) AS sim,
           ${rank} AS rank
    FROM issues i
    WHERE ${sql.join(conds, sql` AND `)}
      AND (i.summary % ${q.summary} ${tsq ? sql`OR i.search_vector @@ to_tsquery('english', ${tsq})` : sql``})
    ORDER BY (similarity(i.summary, ${q.summary}) * 0.6 + least(${rank} * 2, 0.4)) DESC
    LIMIT ${limit}
  `);
  const rows = (res as unknown as { rows: { id: string; project_id: string; sim: number; rank: number }[] }).rows;
  const refs = await issueRefsById(ctx.db, s, rows.map((r) => r.id));
  const out: SimilarIssue[] = [];
  for (const r of rows) {
    const ref = refs.get(r.id);
    if (!ref) continue;
    const score = Math.round((Number(r.sim) * 0.6 + Math.min(Number(r.rank) * 2, 0.4)) * 100) / 100;
    if (score < 0.12) continue;
    out.push({ issue: ref, project: s.projects.get(r.project_id)?.key ?? '', score, verdict: null, reason: null });
  }
  return out;
}
