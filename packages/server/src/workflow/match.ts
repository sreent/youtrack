/**
 * A rule's queries as conditions on one issue. They go through the query language's own parser
 * and compiler, so every value is a bound parameter, and they read the issue inside the caller's
 * transaction: a guard sees the change it is checking before it is committed.
 */
import type { QueryProblem, RuleMatch, RuleRelation, RuleTargetKind } from '@a4a/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { issues } from '../db/schema';
import { compileQuery } from '../search/compiler';
import { parseQuery, type ParsedQuery } from '../search/parser';
import { buildVocabulary, type Vocabulary } from '../search/vocabulary';
import { scopeSchema } from '../services/access';
import type { IssueRow } from '../services/issues';
import type { LinkPhrase, SchemaSnapshot } from '../services/schema-cache';

// Parsing depends only on the snapshot's names, so it is kept for as long as the snapshot lives.
const vocabularies = new WeakMap<SchemaSnapshot, Vocabulary>();
const parsed = new WeakMap<SchemaSnapshot, Map<string, ParsedQuery>>();
const KEPT_PER_SNAPSHOT = 500;

const worlds = new WeakMap<SchemaSnapshot, Map<string, SchemaSnapshot>>();

/**
 * The tracker as a rule reads it. A project's rule reads its own project and what belongs to no
 * project: another project, members only or not, is an unknown word to it, as it is to someone
 * who can't see it. A rule for every project reads them all. Kept as long as the snapshot lives.
 */
export function ruleWorld(s: SchemaSnapshot, projectId: string | null): SchemaSnapshot {
  if (!projectId) return s;
  let byProject = worlds.get(s);
  if (!byProject) worlds.set(s, (byProject = new Map()));
  let world = byProject.get(projectId);
  if (!world) byProject.set(projectId, (world = scopeSchema(s, [projectId])));
  return world;
}

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

// ---------------------------------------------------------------------------
// Related issues: a rule's further condition, and the issues it acts on
// ---------------------------------------------------------------------------

/** Link types that make a parent and its subtasks. */
export function aggregationTypeIds(s: SchemaSnapshot): string[] {
  return s.linkTypes.filter((t) => t.aggregation).map((t) => t.id);
}

/**
 * A link phrase a rule can follow from an issue ("depends on", "is required for", "relates to"),
 * or undefined. Subtask links are a parent and subtasks, said as such, not as a phrase.
 */
export function rulePhrase(s: SchemaSnapshot, phrase: string | null | undefined): LinkPhrase | undefined {
  const p = phrase?.trim().toLowerCase();
  if (!p) return undefined;
  return s.linkPhrases.find((x) => x.phrase === p && !x.type.aggregation);
}

/** The phrases a rule can follow, for problems' hints and the form. */
export function rulePhrases(s: SchemaSnapshot): string[] {
  return [...new Set(s.linkPhrases.filter((x) => !x.type.aggregation).map((x) => x.display))];
}

export interface RelatedCondition {
  of: RuleRelation;
  phrase: string | null;
  match: RuleMatch;
  /** The issues it reads, as a condition on `issues`: what they must match, and in the rule's own project. */
  matching: SQL | null;
  /** The issues it reads at all: the rule's own project (null: every project). */
  readable: SQL | null;
}

const list = (ids: string[]) => sql.join(ids.map((id) => sql`${id}`), sql`, `);

/** `SELECT id FROM issues WHERE …`: here `issues` is the inner one, so a compiled query reads the related issue. */
const idsWhere = (where: SQL | null) => sql`(SELECT ${issues.id} FROM issues WHERE ${where ?? sql`TRUE`})`;

/**
 * A rule's further condition as SQL on the enclosing query's `issues` row: the issue the rule
 * would act for. It reads related issues through `issue_links` alone, so the enclosing row is
 * still `issues` there, and the issues it reads are `issues` again only inside their own SELECT,
 * where the related query's compiled condition belongs. "All" needs at least one related issue;
 * a related issue the rule can't read (another project's, for a project's rule) isn't there for it.
 */
export function relatedSql(s: SchemaSnapshot, r: RelatedCondition): SQL {
  const outer = issues.id;
  const matching = idsWhere(r.matching);
  const readable = idsWhere(r.readable);
  // NOT (q) is unknown where q is: an issue whose match is unknown doesn't match.
  const failing = idsWhere(r.matching ? (r.readable ? sql`${r.readable} AND NOT COALESCE((${r.matching}), FALSE)` : sql`NOT COALESCE((${r.matching}), FALSE)`) : sql`FALSE`);
  const agg = aggregationTypeIds(s);
  const isAgg = (col: SQL) => (agg.length ? sql`${col} IN (${list(agg)})` : sql`FALSE`);

  if (r.of === 'parent') {
    return sql`EXISTS (SELECT 1 FROM issue_links rr WHERE rr.target_id = ${outer} AND ${isAgg(sql`rr.type_id`)} AND rr.source_id IN ${matching})`;
  }
  if (r.of === 'subtasks') {
    const some = (set: SQL) => sql`EXISTS (SELECT 1 FROM issue_links rr WHERE rr.source_id = ${outer} AND ${isAgg(sql`rr.type_id`)} AND rr.target_id IN ${set})`;
    return r.match === 'any' ? some(matching) : sql`(${some(readable)} AND NOT ${some(failing)})`;
  }
  if (r.of === 'siblings') {
    // Its parents the rule can read, and their subtasks (itself among them).
    const parents = sql`rr.target_id = ${outer} AND ${isAgg(sql`rr.type_id`)} AND rr.source_id IN ${readable}`;
    const subtasksOf = (set: SQL) => sql`EXISTS (SELECT 1 FROM issue_links rs WHERE rs.source_id = rr.source_id AND ${isAgg(sql`rs.type_id`)} AND rs.target_id IN ${set})`;
    return r.match === 'any'
      ? sql`EXISTS (SELECT 1 FROM issue_links rr WHERE ${parents} AND ${subtasksOf(matching)})`
      : sql`EXISTS (SELECT 1 FROM issue_links rr WHERE ${parents} AND NOT ${subtasksOf(failing)})`;
  }
  const phrase = rulePhrase(s, r.phrase);
  if (!phrase) return sql`FALSE`;
  const linkedIn = (set: SQL) => {
    const out = sql`(rr.source_id = ${outer} AND rr.target_id IN ${set})`;
    const inn = sql`(rr.target_id = ${outer} AND rr.source_id IN ${set})`;
    const how = phrase.direction === 'outward' ? out : phrase.direction === 'inward' ? inn : sql`(${out} OR ${inn})`;
    return sql`EXISTS (SELECT 1 FROM issue_links rr WHERE rr.type_id = ${phrase.type.id} AND ${how})`;
  };
  return r.match === 'any' ? linkedIn(matching) : sql`(${linkedIn(readable)} AND NOT ${linkedIn(failing)})`;
}

/** At most this many issues a rule acts on for one issue (its subtasks, the issues linked to it). */
export const TARGETS_CAP = 200;

/**
 * The issues a rule acts on for `issueId`, in every project: the caller leaves alone the ones its
 * rule can't reach. Oldest first; one more than the cap, so the caller knows it stopped.
 */
export async function targetIssues(db: Db, s: SchemaSnapshot, to: RuleTargetKind, phrase: string | null, issueId: string): Promise<IssueRow[]> {
  if (to === 'issue') return db.select().from(issues).where(sql`${issues.id} = ${issueId}`);
  const agg = aggregationTypeIds(s);
  let ids: SQL;
  if (to === 'parent' || to === 'subtasks') {
    if (!agg.length) return [];
    ids =
      to === 'parent'
        ? sql`SELECT tl.source_id FROM issue_links tl WHERE tl.target_id = ${issueId} AND tl.type_id IN (${list(agg)})`
        : sql`SELECT tl.target_id FROM issue_links tl WHERE tl.source_id = ${issueId} AND tl.type_id IN (${list(agg)})`;
  } else {
    const p = rulePhrase(s, phrase);
    if (!p) return [];
    const out = sql`SELECT tl.target_id FROM issue_links tl WHERE tl.type_id = ${p.type.id} AND tl.source_id = ${issueId}`;
    const inn = sql`SELECT tl.source_id FROM issue_links tl WHERE tl.type_id = ${p.type.id} AND tl.target_id = ${issueId}`;
    ids = p.direction === 'outward' ? out : p.direction === 'inward' ? inn : sql`${out} UNION ${inn}`;
  }
  return db
    .select()
    .from(issues)
    .where(sql`${issues.id} IN (${ids}) AND ${issues.id} <> ${issueId}`)
    .orderBy(issues.createdAt, issues.id)
    .limit(TARGETS_CAP + 1);
}
