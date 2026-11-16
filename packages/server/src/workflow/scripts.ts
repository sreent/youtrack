/**
 * Scripted workflows (docs/architecture.md, D40): what a script asked for, turned into changes.
 *
 * A script runs in the sandbox (./sandbox.ts) and only writes down what it wants. Here its commands
 * are read in the command language and turned into changes by the command executor, as whoever the
 * script acts as (the workflow agent for a rule, the person for an action); the caller then applies
 * them with applyChanges, in one transaction, so a script's change goes the way every change goes:
 * access, guards, state machines, activity, the run log (D4, D25).
 *
 * A script changes its own issue, or one linked to it in its project (its parent, a subtask, a
 * linked issue): nothing it can't see from the issue it runs on.
 */
import type { Change, ScriptRun } from '@a4a/shared';
import { commandSpec } from '../commands/executor';
import { parseCommand } from '../commands/parser';
import type { Ctx } from '../context';
import type { Db } from '../db/client';
import { AppError, badRequest } from '../lib/errors';
import { issueRefsById, readableId, type IssueRow } from '../services/issue-refs';
import { applyChanges, findIssue, type ChangeSpec } from '../services/issues';
import { rulesFor, type RuleRow, type SchemaSnapshot } from '../services/schema-cache';
import { noteBroken, noteRefusal, refusedByScript } from './guards';
import { condition, meets, ruleWorld } from './match';
import { runScript, SCRIPT_LIMITS, type ScriptIntents, type ScriptOutcome } from './sandbox';
import { reachable, scriptInput, type ScriptChange, type ScriptIssue } from './script-issue';

export interface Planned {
  issue: IssueRow;
  spec: ChangeSpec;
  /** The command it came from, as the script wrote it. */
  command: string | null;
}

/**
 * What a script's intents change, issue by issue, in the order it asked: each apply() is one
 * change, each comment() another. Throws (an AppError) on a command that doesn't fit or an issue it
 * can't reach, before anything is applied.
 */
export async function plannedChanges(
  ctx: Ctx,
  db: Db,
  s: SchemaSnapshot,
  issue: IssueRow,
  seen: ScriptIssue,
  intents: ScriptIntents,
  opts: { meId?: string; onlySelf?: boolean } = {},
): Promise<Planned[]> {
  const out: Planned[] = [];
  const key = s.projects.get(issue.projectId)?.key ?? 'its project';
  const reach = reachable(seen);
  for (const a of intents.applies) {
    let target = issue;
    if (a.to && a.to !== seen.id) {
      if (opts.onlySelf) throw badRequest(`Run as a command, it changes only ${seen.id}, not ${a.to}`, 'Use its button on the issue to let it change related issues.');
      if (!reach.has(a.to)) throw badRequest(`It can't change ${a.to}: a script changes its issue, or one linked to it in ${key}`);
      const found = await findIssue(db, s, a.to);
      if (!found) throw badRequest(`There is no issue ${a.to}`);
      target = found;
    }
    const parsed = parseCommand(a.command, s, [target.projectId]);
    if (parsed.problems.length) throw badRequest(`Its command “${a.command}” doesn't fit ${key}: ${parsed.problems.map((p) => p.message).join('; ')}`);
    // A script may run a command action, or make a transition, but not run another script.
    out.push({ issue: target, spec: await commandSpec(ctx, target, parsed.ops, undefined, { meId: opts.meId, db, noScripts: true }), command: a.command });
  }
  for (const text of intents.comments) out.push({ issue, spec: { comment: text }, command: null });
  return out;
}

/** Apply what was planned, in order, in the caller's transaction. Changes to the issue itself, and words for the rest. */
export async function applyPlanned(
  tx: Db,
  ctx: Ctx,
  s: SchemaSnapshot,
  issue: IssueRow,
  planned: Planned[],
  data?: Record<string, unknown>,
): Promise<{ changes: Change[]; others: string[]; activities: Awaited<ReturnType<typeof applyChanges>>['activities'] }> {
  const changes: Change[] = [];
  const others: string[] = [];
  const activities: Awaited<ReturnType<typeof applyChanges>>['activities'] = [];
  for (const p of planned) {
    const fresh = (await findIssue(tx, s, p.issue.id)) ?? p.issue;
    const res = await applyChanges(tx, ctx, fresh, data ? { ...p.spec, data: { ...p.spec.data, ...data } } : p.spec);
    activities.push(...res.activities);
    if (p.issue.id === issue.id) changes.push(...res.changes);
    else if (res.changes.length) others.push(`${readableId(s, p.issue)}: ${res.changes.map((c) => `${c.field} → ${c.to ?? '—'}`).join(', ')}`);
  }
  return { changes, others, activities };
}

export function scriptErrorText(out: ScriptOutcome): string {
  return out.error ? `Its script stopped: ${out.error.message}` : '';
}

// ---------------------------------------------------------------------------
// Scripted guards: in the write path, after the change and before commit
// ---------------------------------------------------------------------------

/** The project's scripted guards that are on. From the snapshot: a project without any costs a filter and no query. */
export function scriptedGuards(s: SchemaSnapshot, projectId: string): RuleRow[] {
  return rulesFor(s, projectId).filter((r) => r.kind === 'guard' && r.enabled && r.script);
}

/**
 * Run the project's scripted guards on the issue as the change left it, inside the transaction:
 * one that calls refuse() refuses the change (it throws, so the caller's transaction rolls back).
 * A guard whose script fails, or whose query no longer reads, refuses nothing and says so in its
 * run log once an hour: a broken script must not stop every change in the project.
 */
export async function enforceScriptGuards(tx: Db, ctx: Ctx, s: SchemaSnapshot, issue: IssueRow, change: ScriptChange, isNew: boolean): Promise<void> {
  const guards = scriptedGuards(s, issue.projectId);
  if (!guards.length) return;
  let input: Awaited<ReturnType<typeof scriptInput>> | null = null;
  for (const rule of guards) {
    if (rule.query.trim()) {
      const when = condition(ruleWorld(s, rule.projectId), rule.query, { meId: ctx.actor.user.id });
      if (when.problems.length) {
        noteBroken(ctx, rule, when.problems.map((p) => p.message).join('; '));
        continue;
      }
      if (when.where && !(await meets(tx, issue.id, [when.where]))[0]) continue;
    }
    input ??= await scriptInput(tx, s, issue, change);
    const out = await runScript(rule.script!, input, { timeMs: SCRIPT_LIMITS.guardTimeMs });
    if (out.error) {
      noteBroken(ctx, rule, out.error.message, `${scriptErrorText(out)}. It refuses nothing until it is fixed.`);
      continue;
    }
    if (out.intents.refusal !== null) {
      noteRefusal(ctx, rule, isNew ? null : { id: issue.id, key: readableId(s, issue), projectId: issue.projectId }, issue.projectId, out.intents.refusal);
      throw refusedByScript(rule, out.intents.refusal);
    }
  }
}

// ---------------------------------------------------------------------------
// A dry run: what a script would do to one issue, saving nothing
// ---------------------------------------------------------------------------

/**
 * Run a script on an issue as it is now and show what it would do: its logs, its refusal, and what
 * each command it asks for would change (the executor's dry run, as `actor`). Nothing is saved.
 */
export async function dryRunScript(
  actor: Ctx,
  s: SchemaSnapshot,
  issue: IssueRow,
  script: string,
  change: ScriptChange,
  opts: { meId?: string; timeMs?: number; guard?: boolean } = {},
): Promise<ScriptRun> {
  const input = await scriptInput(actor.db, s, issue, change);
  const out = await runScript(script, input, { timeMs: opts.timeMs });
  const base = { ok: !out.error, error: out.error, logs: out.intents.logs, refusal: out.intents.refusal, comments: out.intents.comments, ms: out.ms };
  if (out.error) return { ...base, applies: [], note: `${scriptErrorText(out)}. Nothing it asked for would be done.` };
  if (opts.guard) {
    return {
      ...base,
      applies: [],
      note:
        out.intents.refusal !== null
          ? `It would refuse this change: “${out.intents.refusal}”.`
          : `It would let this change through.${out.intents.applies.length || out.intents.comments.length ? ' A guard only refuses: what it applies or comments is ignored.' : ''}`,
    };
  }
  if (out.intents.refusal !== null) return { ...base, applies: [], note: `It would do nothing: “${out.intents.refusal}”.` };
  const applies: ScriptRun['applies'] = [];
  const refs = await issueRefsById(actor.db, s, [issue.id]);
  for (const a of out.intents.applies) {
    const one: ScriptIntents = { applies: [a], comments: [], refusal: null, logs: [] };
    try {
      const [p] = await plannedChanges(actor, actor.db, s, issue, input.issue, one, { meId: opts.meId });
      const ref = p!.issue.id === issue.id ? refs.get(issue.id)! : (await issueRefsById(actor.db, s, [p!.issue.id])).get(p!.issue.id)!;
      const res = await actor.db.transaction(async (tx) => applyChanges(tx as unknown as Db, actor, p!.issue, p!.spec, { dryRun: true }));
      applies.push({ command: a.command, issue: ref, changes: res.changes, errors: [] });
    } catch (e) {
      applies.push({ command: a.command, issue: a.to ? null : (refs.get(issue.id) ?? null), changes: [], errors: [e instanceof AppError && e.hint ? `${e.message} (${e.hint})` : e instanceof Error ? e.message : String(e)] });
    }
  }
  const n = applies.filter((a) => a.changes.length).length;
  const failing = applies.filter((a) => a.errors.length).length;
  return {
    ...base,
    applies,
    note: [
      applies.length ? `It asks for ${applies.length} ${applies.length === 1 ? 'command' : 'commands'}: ${n} would change something${failing ? `, ${failing} would fail` : ''}.` : 'It asks for no command.',
      out.intents.comments.length ? `It would post ${out.intents.comments.length === 1 ? 'a comment' : `${out.intents.comments.length} comments`}.` : '',
      'Nothing was saved.',
    ]
      .filter(Boolean)
      .join(' '),
  };
}
