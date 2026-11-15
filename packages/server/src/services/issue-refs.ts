import type { IssueRef } from '@tracklet/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { issueFieldValues, issues } from '../db/schema';
import { type SchemaSnapshot, stateField } from './schema-cache';

export type IssueRow = typeof issues.$inferSelect;

export function readableId(s: SchemaSnapshot, issue: Pick<IssueRow, 'projectId' | 'number'>): string {
  const p = s.projects.get(issue.projectId);
  return `${p?.key ?? '?'}-${issue.number}`;
}

/** Parse "BACK-12" into key and number. */
export function parseReadableId(id: string): { key: string; number: number } | null {
  const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(id.trim());
  if (!m) return null;
  return { key: m[1]!.toUpperCase(), number: parseInt(m[2]!, 10) };
}

export async function stateNames(db: Db, s: SchemaSnapshot, issueIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const sf = stateField(s);
  if (!sf || !issueIds.length) return out;
  const rows = await db
    .select({ issueId: issueFieldValues.issueId, valueId: issueFieldValues.valueId })
    .from(issueFieldValues)
    .where(and(eq(issueFieldValues.fieldId, sf.id), inArray(issueFieldValues.issueId, issueIds)));
  for (const r of rows) {
    const v = r.valueId ? s.values.get(r.valueId) : undefined;
    if (v) out.set(r.issueId, v.name);
  }
  return out;
}

export function issueRef(s: SchemaSnapshot, issue: IssueRow, state: string | null): IssueRef {
  return { id: readableId(s, issue), summary: issue.summary, resolved: issue.resolvedAt !== null, state };
}

export async function issueRefsById(db: Db, s: SchemaSnapshot, ids: string[]): Promise<Map<string, IssueRef>> {
  const out = new Map<string, IssueRef>();
  const unique = [...new Set(ids)];
  if (!unique.length) return out;
  const rows = await db.select().from(issues).where(inArray(issues.id, unique));
  const states = await stateNames(db, s, unique);
  for (const r of rows) out.set(r.id, issueRef(s, r, states.get(r.id) ?? null));
  return out;
}
