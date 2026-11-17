/**
 * Guards: workflow rules that refuse a change. A guard says "an issue that matches Q must also
 * match R". The write path (applyChanges, createIssue) asks here, in the same transaction:
 *
 *   1. before writing, whether each of the project's guards holds for the issue;
 *   2. after writing, and before commit, whether it still does.
 *
 * A change that takes an issue from keeping a guard to breaking it is refused, so the transaction
 * rolls back and leaves nothing behind. An issue that already broke a guard before (it was changed
 * before the guard existed) can still be changed in other ways: the guard refuses only what makes
 * things worse. A new issue has no "before": it must keep every guard it matches.
 *
 * Keeping it fast and deadlock-free on the one write path:
 * - The guards come from the schema snapshot, in memory: a project without guards costs a filter
 *   over the rules held there, and no query.
 * - With guards, both checks are one SELECT each, of every guard at once, on the transaction's own
 *   connection. Reads take no row locks and never wait on one (Postgres MVCC), so the checks add no
 *   edge to any transaction's wait-for graph: they can't take part in a deadlock. A snapshot reload
 *   inside the transaction also runs on the transaction's connection (see SchemaCache.get), never on
 *   the pool, so on PGlite, which has one connection, it can't wait on itself.
 * - Writing down a refusal is the one write a guard makes, and it is sent on the pool without being
 *   awaited: the transaction never waits on it. On PGlite it queues behind the transaction; on
 *   Postgres it waits for the issue's row lock, which the refused transaction releases as it ends.
 */
import type { Ctx } from '../context';
import type { Db } from '../db/client';
import { ruleRuns } from '../db/schema';
import type { SQL } from 'drizzle-orm';
import { AppError, asSentence } from '../lib/errors';
import { readableId, type IssueRow } from '../services/issue-refs';
import { rulesFor, type RuleRow, type SchemaSnapshot } from '../services/schema-cache';
import { condition, meets, ruleWorld } from './match';

export interface GuardCheck {
  rule: RuleRow;
  when: SQL | null;
  requires: SQL | null;
}

/** The project's guards as conditions, "me" being whoever makes the change. Guards that no longer read are left out. */
export function guardChecks(ctx: Ctx, s: SchemaSnapshot, projectId: string): GuardCheck[] {
  const out: GuardCheck[] = [];
  for (const rule of rulesFor(s, projectId)) {
    // A scripted guard decides in its script (./scripts.ts), not by what it requires.
    if (rule.kind !== 'guard' || !rule.enabled || rule.script) continue;
    const world = ruleWorld(s, rule.projectId);
    const when = condition(world, rule.query, { meId: ctx.actor.user.id });
    const requires = condition(world, rule.requires ?? '', { meId: ctx.actor.user.id });
    // A guard that no longer reads (a value was renamed since) must neither refuse every change nor
    // let a misread query decide: it refuses nothing until someone fixes it, and says so.
    if (when.problems.length || requires.problems.length) {
      noteBroken(ctx, rule, [...when.problems, ...requires.problems].map((p) => p.message).join('; '));
      continue;
    }
    out.push({ rule, when: when.where, requires: requires.where });
  }
  return out;
}

/** Whether each guard holds for the issue as it is in `tx`: it does unless the issue matches its query and not what it requires. */
export async function guardsHeld(tx: Db, checks: GuardCheck[], issueId: string): Promise<boolean[]> {
  if (!checks.length) return [];
  const flags = await meets(
    tx,
    issueId,
    checks.flatMap((c) => [c.when, c.requires]),
  );
  return checks.map((_, i) => !(flags[2 * i] && !flags[2 * i + 1]));
}

/**
 * After the change, before commit: refuse it if it broke a guard that held before it (`before`
 * null: a new issue, which must keep them all). Throws, so the caller's transaction rolls back.
 */
export async function enforceGuards(tx: Db, ctx: Ctx, s: SchemaSnapshot, checks: GuardCheck[], before: boolean[] | null, issue: IssueRow): Promise<void> {
  if (!checks.length) return;
  const after = await guardsHeld(tx, checks, issue.id);
  const broken = checks.findIndex((_, i) => !after[i] && (before === null || before[i]));
  if (broken < 0) return;
  const rule = checks[broken]!.rule;
  noteRefusal(ctx, rule, before === null ? null : { id: issue.id, key: readableId(s, issue), projectId: issue.projectId }, issue.projectId);
  throw refusedBy(rule);
}

export function refusedBy(rule: RuleRow): AppError {
  const own = rule.message?.trim();
  const values = { rule: rule.name, query: rule.query, requires: rule.requires ?? '' };
  return new AppError(
    422,
    'refused_by_rule',
    own || `The rule "${rule.name}" refuses this change`,
    `The rule "${rule.name}": an issue that matches ${rule.query} must also match ${rule.requires ?? ''}.`,
    { rule: { id: rule.id, name: rule.name } },
  ).said(own ? 'workflow.ruleRefusesInItsWords' : 'workflow.ruleRefuses', own ? { refusal: asSentence(own), ...values } : values);
}

/** A scripted guard's refusal, in the words it gave refuse(). */
export function refusedByScript(rule: RuleRow, message: string): AppError {
  return new AppError(422, 'refused_by_rule', message, `The rule "${rule.name}" refuses it in its script.`, { rule: { id: rule.id, name: rule.name } }).said(
    'workflow.ruleScriptRefuses',
    { refusal: asSentence(message), rule: rule.name },
  );
}

export function isRefusal(e: unknown): e is AppError {
  return e instanceof AppError && e.code === 'refused_by_rule';
}

function actorOf(ctx: Ctx): string | null {
  return ctx.actor.authMethod === 'system' && ctx.actor.user.id === 'system' ? null : ctx.actor.user.id;
}

/** The refusal, in the rule's run log: written on the pool and not awaited, so the refused transaction never waits on it. */
export function noteRefusal(ctx: Ctx, rule: RuleRow, issue: { id: string; key: string; projectId: string } | null, projectId: string, message?: string): void {
  void ctx.app.db
    .insert(ruleRuns)
    .values({
      ruleId: rule.id,
      projectId,
      // A refused new issue never existed, so the row names none.
      issueId: issue?.id ?? null,
      issueKey: issue?.key ?? null,
      actorId: actorOf(ctx),
      outcome: 'refused',
      message: issue ? (message ?? rule.message ?? '') : `Refused a new issue. ${message ?? rule.message ?? ''}`.trim(),
    })
    .catch(() => {});
}

const brokenNoted = new Map<string, number>();
const BROKEN_NOTE_EVERY_MS = 3_600_000;

/** A guard that no longer reads is written down once an hour, not on every change. */
export function noteBroken(ctx: Ctx, rule: RuleRow, problems: string, said?: string): void {
  const last = brokenNoted.get(rule.id) ?? 0;
  if (Date.now() - last < BROKEN_NOTE_EVERY_MS) return;
  brokenNoted.set(rule.id, Date.now());
  void ctx.app.db
    .insert(ruleRuns)
    .values({
      ruleId: rule.id,
      projectId: rule.projectId,
      outcome: 'failed',
      message: said ?? `It no longer reads (${problems}), so it refuses nothing until it is fixed.`,
    })
    .catch(() => {});
}
