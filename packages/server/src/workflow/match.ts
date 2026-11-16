/**
 * A rule's queries as conditions on one issue. They go through the query language's own parser
 * and compiler, so every value is a bound parameter, and they read the issue inside the caller's
 * transaction: a guard sees the change it is checking before it is committed.
 */
import type { QueryProblem } from '@a4a/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { issues } from '../db/schema';
import { compileQuery } from '../search/compiler';
import { parseQuery, type ParsedQuery } from '../search/parser';
import { buildVocabulary, type Vocabulary } from '../search/vocabulary';
import type { SchemaSnapshot } from '../services/schema-cache';

// Parsing depends only on the snapshot's names, so it is kept for as long as the snapshot lives.
const vocabularies = new WeakMap<SchemaSnapshot, Vocabulary>();
const parsed = new WeakMap<SchemaSnapshot, Map<string, ParsedQuery>>();
const KEPT_PER_SNAPSHOT = 500;

export function vocabularyOf(s: SchemaSnapshot): Vocabulary {
  let v = vocabularies.get(s);
  if (!v) vocabularies.set(s, (v = buildVocabulary(s)));
  return v;
}

export function parsedQuery(s: SchemaSnapshot, text: string): ParsedQuery {
  let byText = parsed.get(s);
  if (!byText) parsed.set(s, (byText = new Map()));
  let p = byText.get(text);
  if (!p) {
    p = parseQuery(text, vocabularyOf(s));
    if (byText.size < KEPT_PER_SNAPSHOT) byText.set(text, p);
  }
  return p;
}

export interface Condition {
  /** null: every issue. */
  where: SQL | null;
  problems: QueryProblem[];
}

/**
 * A query as a condition on `issues`. "me" is `meId`; with none (a scheduled rule), "me" is nobody.
 * With `projectId`, only that project's issues meet it.
 */
export function condition(s: SchemaSnapshot, text: string, opts: { meId: string | null; projectId?: string | null }): Condition {
  const compiled = compileQuery(parsedQuery(s, text), { s, meId: opts.meId ?? '' });
  let where = compiled.where;
  if (opts.projectId) {
    const scope = sql`${issues.projectId} = ${opts.projectId}`;
    where = where ? sql`(${scope} AND ${where})` : scope;
  }
  return { where, problems: compiled.problems };
}

/** Whether one issue meets each condition, read in one query on `db` (inside a transaction, the transaction). */
export async function meets(db: Db, issueId: string, conditions: (SQL | null)[]): Promise<boolean[]> {
  if (!conditions.length) return [];
  const columns = conditions.map((c, i) => sql`(${c ?? sql`TRUE`}) AS ${sql.identifier(`m${i}`)}`);
  const res = await db.execute(sql`SELECT ${sql.join(columns, sql`, `)} FROM issues WHERE ${issues.id} = ${issueId}`);
  const row = (res as unknown as { rows: Record<string, unknown>[] }).rows[0];
  return conditions.map((_, i) => row?.[`m${i}`] === true);
}
