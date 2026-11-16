/**
 * The ids an issue had before it moved (D41). A moved issue keeps every id it ever had: each is an
 * alias, (project, number), that finds it wherever ids are taken. A project never gives a number
 * out twice, so an alias never stands for a live issue of its own project.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { issueAliases } from '../db/schema';
import { parseReadableId } from './issue-refs';
import type { SchemaSnapshot } from './schema-cache';

/** The issue an old id stands for, if it is one. */
export async function issueIdByAlias(db: Db, projectId: string, number: number): Promise<string | undefined> {
  const [row] = await db
    .select({ issueId: issueAliases.issueId })
    .from(issueAliases)
    .where(and(eq(issueAliases.projectId, projectId), eq(issueAliases.number, number)));
  return row?.issueId;
}

/** The ids an issue had before it moved, oldest first. */
export async function formerIdsOf(db: Db, s: SchemaSnapshot, issueId: string): Promise<string[]> {
  const rows = await db.select().from(issueAliases).where(eq(issueAliases.issueId, issueId)).orderBy(issueAliases.movedAt);
  return rows.map((r) => `${s.projects.get(r.projectId)?.key ?? '?'}-${r.number}`);
}

/**
 * For ids written somewhere (a description, a commit message), the id each now goes by: an old id
 * maps to the issue's current one, and any other id maps to itself.
 */
export async function currentIds(db: Db, s: SchemaSnapshot, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const asked: { id: string; projectId: string; number: number }[] = [];
  for (const id of ids) {
    out.set(id, id);
    const parsed = parseReadableId(id);
    const p = parsed ? s.projectsByKey.get(parsed.key) : undefined;
    if (parsed && p) asked.push({ id, projectId: p.id, number: parsed.number });
  }
  if (!asked.length) return out;
  const rows = await db.execute(
    sql`SELECT a.project_id, a.number, i.project_id AS now_project, i.number AS now_number
        FROM issue_aliases a JOIN issues i ON i.id = a.issue_id
        WHERE ${sql.join(
          asked.map((x) => sql`(a.project_id = ${x.projectId} AND a.number = ${x.number})`),
          sql` OR `,
        )}`,
  );
  for (const r of (rows as unknown as { rows: { project_id: string; number: number; now_project: string; now_number: number }[] }).rows) {
    const from = asked.find((a) => a.projectId === r.project_id && a.number === Number(r.number));
    const key = s.projects.get(r.now_project)?.key;
    if (from && key) out.set(from.id, `${key}-${r.now_number}`);
  }
  return out;
}

/** Issue ids, internal, with former ones of their own: what each issue has gone by. */
export async function aliasesByIssue(db: Db, s: SchemaSnapshot, issueIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!issueIds.length) return out;
  const rows = await db.select().from(issueAliases).where(inArray(issueAliases.issueId, issueIds)).orderBy(issueAliases.movedAt);
  for (const r of rows) out.set(r.issueId, [...(out.get(r.issueId) ?? []), `${s.projects.get(r.projectId)?.key ?? '?'}-${r.number}`]);
  return out;
}
