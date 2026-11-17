/**
 * Conditional fields (D41). A project's field may carry a condition, a search in the project's own
 * words ("State: Fixed"). While its issue matches, the field shows, and is required if the project
 * requires it; while it doesn't, the field is hidden and nothing asks for it. Conditions are read
 * the way rules read theirs (workflow/match.ts), so one issue's are answered in one query.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { issues } from '../db/schema';
import { badRequest, saidProblem } from '../lib/errors';
import { condition, meets, ruleWorld } from '../workflow/match';
import type { SchemaSnapshot } from './schema-cache';

/** A condition as someone wrote it, checked against the project's vocabulary. Empty clears it. */
export function checkFieldCondition(s: SchemaSnapshot, projectId: string, text: string | null | undefined): string | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  const c = condition(ruleWorld(s, projectId), t, { meId: null });
  const p = c.problems[0];
  if (p) throw badRequest(`The condition doesn't read: ${p.message}`, p.hint ?? 'Write it as a search, e.g. State: Fixed').said('conditions.doesNotReadSaying', { problem: saidProblem(p), hasHint: p.hint ? 'yes' : 'no' });
  if (!c.where) throw badRequest("The condition doesn't say anything", 'Write it as a search, e.g. State: Fixed').said('conditions.saysNothing');
  return t;
}

/** A condition as SQL on `issues`. One that no longer reads (a value renamed since) holds always: the field behaves as though it had none. */
function conditionSql(world: SchemaSnapshot, text: string): SQL {
  const c = condition(world, text, { meId: null });
  return c.problems.length || !c.where ? sql`TRUE` : c.where;
}

/** For each of a project's fields with a condition, whether it applies to the issue now. Fields without one aren't in the map. */
export async function fieldsApplying(db: Db, s: SchemaSnapshot, projectId: string, issueId: string): Promise<Map<string, boolean>> {
  const pfs = (s.projectFields.get(projectId) ?? []).filter((pf) => pf.condition);
  const out = new Map<string, boolean>();
  if (!pfs.length) return out;
  const world = ruleWorld(s, projectId);
  const res = await meets(db, issueId, pfs.map((pf) => conditionSql(world, pf.condition!)));
  pfs.forEach((pf, i) => out.set(pf.fieldId, res[i] ?? true));
  return out;
}

export interface RequiredWhen {
  fieldId: string;
  name: string;
  condition: string;
  /** The condition holds and the field is empty. */
  missing: SQL;
}

/** A project's fields that are required while a condition holds. */
export function requiredWhen(s: SchemaSnapshot, projectId: string): RequiredWhen[] {
  const pfs = (s.projectFields.get(projectId) ?? []).filter((pf) => pf.required && pf.condition);
  if (!pfs.length) return [];
  const world = ruleWorld(s, projectId);
  return pfs.flatMap((pf) => {
    const f = s.fields.get(pf.fieldId);
    if (!f) return [];
    const missing = sql`(${conditionSql(world, pf.condition!)}) AND NOT EXISTS (SELECT 1 FROM issue_field_values ifv WHERE ifv.issue_id = ${issues.id} AND ifv.field_id = ${f.id})`;
    return [{ fieldId: f.id, name: f.name, condition: pf.condition!, missing }];
  });
}

/** Which of `checks` the issue misses now. */
export async function missingNow(db: Db, issueId: string, checks: RequiredWhen[]): Promise<boolean[]> {
  return checks.length ? meets(db, issueId, checks.map((c) => c.missing)) : [];
}

/**
 * Refuse a change that leaves a field empty while its condition holds, unless it was already so
 * before the change (`before` null: a new issue, which needs every one). Like a guard, it runs once
 * everything is written, so the caller's transaction takes the change back.
 */
export async function enforceRequiredWhen(db: Db, issueId: string, checks: RequiredWhen[], before: boolean[] | null): Promise<void> {
  if (!checks.length) return;
  const now = await missingNow(db, issueId, checks);
  const broken = checks.find((_, i) => now[i] && !before?.[i]);
  if (broken) {
    throw badRequest(`${broken.name} is required when ${broken.condition}`, `Set ${broken.name} in the same change.`, {
      requiredField: broken.name,
      condition: broken.condition,
    }).said('conditions.required', { name: broken.name, condition: broken.condition });
  }
}
