/**
 * Custom actions (docs/architecture.md, D40): named, per project, each a command or a script. The
 * issue page shows them as buttons, and their names read as commands, so an agent or a person at
 * the command bar runs them too (commands/executor.ts). An action runs as whoever runs it, who must
 * be able to change the issue; its condition (a query) says when it's offered.
 *
 * A command action is the project manager's to make. A scripted one is code, run on the server for
 * anyone who presses its button, so it is an administrator's, as scripted rules are: a manager can
 * still turn it off.
 */
import type { IssueDetail, IssueWorkflow, WorkflowAction, WorkflowActionInput, WorkflowProblem } from '@a4a/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { parseCommand } from '../commands/parser';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { WORKFLOW_BOT } from '../db/defaults';
import { workflowActions } from '../db/schema';
import { publishActivities } from '../events/activity';
import { AppError, asSentence, badRequest, conflict, forbidden, keyedProblem, notFound, saidProblems, wordsOf } from '../lib/errors';
import { newId } from '../lib/ids';
import { assertCanManageProject, canReadProject, requireProject } from '../services/access';
import { applyChanges, fieldValuesOf, findIssue, issueDetail, resolveIssue } from '../services/issues';
import { actionsFor, type ActionRow, type SchemaSnapshot } from '../services/schema-cache';
import { condition, meets, ruleWorld } from './match';
import { canWrite, issueTransitions, nameProblems } from './machines';
import { checkScript, runScript } from './sandbox';
import { changeOf, scriptInput } from './script-issue';
import { applyPlanned, plannedChanges } from './scripts';
import { commandSpec } from '../commands/executor';

const whole = (text: string) => ({ start: 0, end: text.length });

/** Writing a script is an administrator's (D40): a script is code that runs on the server, as whoever sets it off. */
export function assertCanScript(ctx: Ctx, kind: 'action' | 'rule'): void {
  if (!ctx.actor.scopes.includes('admin')) {
    throw kind === 'action'
      ? forbidden('Only administrators can write, change or delete a scripted action', 'Turn it off instead, or ask an administrator.').said('workflow.scriptedActionAdminOnly')
      : forbidden('Only administrators can write, change or delete a scripted rule', 'Turn it off instead, or ask an administrator.').said('workflow.scriptedRuleAdminOnly');
  }
}

interface ActionDraft {
  name: string;
  command: string;
  script: string | null;
  condition: string;
  enabled: boolean;
}

export async function actionProblems(s: SchemaSnapshot, projectId: string, d: ActionDraft, own: { actionId?: string } = {}): Promise<WorkflowProblem[]> {
  const out: WorkflowProblem[] = [];
  for (const m of nameProblems(s, projectId, d.name, own)) out.push({ part: 'name', ...whole(d.name), ...m });
  // A value of a field reads as setting it: an action can't be called that.
  const n = d.name.trim().toLowerCase();
  for (const pf of s.projectFields.get(projectId) ?? []) {
    const f = s.fields.get(pf.fieldId);
    if (!f || !['enum', 'state', 'version'].includes(f.type)) continue;
    if ((s.valuesByField.get(f.id) ?? []).some((v) => !v.archived && (!v.projectId || v.projectId === projectId) && v.name.toLowerCase() === n)) {
      out.push(
        keyedProblem(
          { part: 'name', message: `“${d.name.trim()}” is a value of ${f.name}`, hint: 'Name it for what it does, e.g. “Escalate”.', ...whole(d.name) },
          'rule.actionNameIsValue',
          { name: d.name.trim(), field: f.name },
        ),
      );
    }
  }
  if (d.script !== null) {
    if (d.command.trim()) out.push(keyedProblem({ part: 'command', message: 'An action is a command or a script, not both', ...whole(d.command) }, 'rule.commandOrScript'));
    for (const p of await checkScript(d.script)) out.push({ part: 'script', message: p.message, start: p.start, end: p.end, ...(p.hint ? { hint: p.hint } : {}), ...wordsOf(p) });
  } else if (!d.command.trim()) {
    out.push(keyedProblem({ part: 'command', message: 'Say what it does, in the command language', hint: 'e.g. Priority Critical tag escalated', ...whole('') }, 'rule.sayActionCommand'));
  } else {
    const parsed = parseCommand(d.command, s, [projectId]);
    for (const p of parsed.problems) out.push({ ...p, part: 'command' });
    if (parsed.ops.some((op) => op.kind === 'action')) out.push(keyedProblem({ part: 'command', message: 'Its command runs another action, and an action can’t', ...whole(d.command) }, 'rule.actionRunsAction'));
  }
  if (d.condition.trim()) {
    const c = condition(ruleWorld(s, projectId), d.condition, { meId: s.usersByLogin.get(WORKFLOW_BOT)?.id ?? '' });
    for (const p of c.problems) out.push({ ...p, part: 'condition' });
  }
  return out;
}

async function dto(s: SchemaSnapshot, row: ActionRow): Promise<WorkflowAction> {
  return {
    id: row.id,
    project: s.projects.get(row.projectId)?.key ?? '?',
    name: row.name,
    command: row.command,
    script: row.script,
    condition: row.condition,
    enabled: row.enabled,
    problems: await actionProblems(s, row.projectId, { name: row.name, command: row.command, script: row.script, condition: row.condition, enabled: row.enabled }, { actionId: row.id }),
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function refuseProblems(problems: WorkflowProblem[]): never {
  const words = problems.map((p) => (p.hint ? `${p.message} (${p.hint})` : p.message)).join('; ');
  throw badRequest(`The action needs fixing: ${words}`, 'Each problem says where it is.', { problems }).said('workflow.actionNeedsFixing', { problems: saidProblems(problems) });
}

async function loadAction(ctx: Ctx, id: string): Promise<ActionRow> {
  requireScope(ctx, 'read');
  const [row] = await ctx.db.select().from(workflowActions).where(eq(workflowActions.id, id));
  if (!row || !(await canReadProject(ctx, row.projectId))) throw notFound('Action').said('workflow.actionNotFound');
  return row;
}

export async function listActions(ctx: Ctx, project: string): Promise<WorkflowAction[]> {
  requireScope(ctx, 'read');
  const p = await requireProject(ctx, project);
  const rows = await ctx.db
    .select()
    .from(workflowActions)
    .where(eq(workflowActions.projectId, p.id))
    .orderBy(asc(workflowActions.position), asc(workflowActions.createdAt), asc(workflowActions.id));
  const s = await ctx.app.schema.get();
  return Promise.all(rows.map((r) => dto(s, r)));
}

export async function createAction(ctx: Ctx, input: WorkflowActionInput): Promise<WorkflowAction> {
  requireScope(ctx, 'write');
  const project = await requireProject(ctx, input.project, 'manage');
  await assertCanManageProject(ctx, project.id);
  const d: ActionDraft = {
    name: input.name.trim(),
    command: input.command?.trim() ?? '',
    script: input.script?.trim() ? input.script : null,
    condition: input.condition?.trim() ?? '',
    enabled: input.enabled ?? true,
  };
  if (d.script !== null) assertCanScript(ctx, 'action');
  const s = await ctx.app.schema.get();
  const problems = await actionProblems(s, project.id, d);
  if (problems.length) refuseProblems(problems);
  const position = actionsFor(s, project.id).reduce((n, a) => Math.max(n, a.position + 1), 0);
  const [row] = await ctx.db
    .insert(workflowActions)
    .values({ id: newId(), projectId: project.id, ...d, position, createdById: ctx.actor.user.id, updatedById: ctx.actor.user.id })
    .onConflictDoNothing()
    .returning();
  if (!row) throw conflict(`${project.key} has an action “${d.name}” already`).said('workflow.actionExists', { project: project.key, name: d.name });
  ctx.app.schema.invalidate();
  return dto(await ctx.app.schema.get(), row);
}

export async function updateAction(
  ctx: Ctx,
  id: string,
  input: Partial<Omit<WorkflowActionInput, 'project'>> & { expectedVersion?: number },
): Promise<WorkflowAction> {
  requireScope(ctx, 'write');
  const row = await loadAction(ctx, id);
  await assertCanManageProject(ctx, row.projectId);
  if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) {
    throw conflict(`The action “${row.name}” was changed by someone else`, 'Reload it and make your change again.', { currentVersion: row.version }).said('workflow.actionChangedMeanwhile', { action: row.name });
  }
  const d: ActionDraft = {
    name: input.name !== undefined ? input.name.trim() : row.name,
    command: input.command !== undefined ? input.command.trim() : row.command,
    script: input.script !== undefined ? (input.script?.trim() ? input.script : null) : row.script,
    condition: input.condition !== undefined ? input.condition.trim() : row.condition,
    enabled: input.enabled ?? row.enabled,
  };
  const onlyTurningOff = input.enabled === false && Object.keys(input).every((k) => k === 'enabled' || k === 'expectedVersion');
  if ((row.script !== null || d.script !== null) && !onlyTurningOff) assertCanScript(ctx, 'action');
  if (!onlyTurningOff) {
    const problems = await actionProblems(await ctx.app.schema.get(), row.projectId, d, { actionId: row.id });
    if (problems.length) refuseProblems(problems);
  }
  const [updated] = await ctx.db
    .update(workflowActions)
    .set({ ...d, version: sql`${workflowActions.version} + 1`, updatedById: ctx.actor.user.id, updatedAt: new Date() })
    .where(and(eq(workflowActions.id, row.id), eq(workflowActions.version, row.version)))
    .returning()
    .catch((e: unknown) => {
      if (/unique|duplicate/i.test(String((e as { message?: string })?.message ?? e))) throw conflict(`There is an action “${d.name}” already`).said('workflow.actionNameTaken', { name: d.name });
      throw e;
    });
  if (!updated) throw conflict(`The action “${row.name}” was changed by someone else`, 'Reload it and make your change again.').said('workflow.actionChangedMeanwhile', { action: row.name });
  ctx.app.schema.invalidate();
  return dto(await ctx.app.schema.get(), updated);
}

export async function deleteAction(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'write');
  const row = await loadAction(ctx, id);
  await assertCanManageProject(ctx, row.projectId);
  if (row.script !== null) assertCanScript(ctx, 'action');
  await ctx.db.delete(workflowActions).where(eq(workflowActions.id, row.id));
  ctx.app.schema.invalidate();
}

// ---------------------------------------------------------------------------
// On an issue
// ---------------------------------------------------------------------------

/** What someone can do to an issue now by its project's workflows: transitions and actions. Nothing for someone who can't change it. */
export async function issueWorkflow(ctx: Ctx, idOrReadable: string): Promise<IssueWorkflow> {
  const issue = await resolveIssue(ctx, idOrReadable);
  const s = await ctx.app.schema.get();
  if (!(await canWrite(ctx, issue.projectId))) return { transitions: [], actions: [] };
  const transitions = await issueTransitions(ctx, s, issue, await fieldValuesOf(ctx.db, issue.id));
  const actions: IssueWorkflow['actions'] = [];
  for (const a of actionsFor(s, issue.projectId)) {
    if (!a.enabled) continue;
    if (a.condition.trim()) {
      const when = condition(ruleWorld(s, issue.projectId), a.condition, { meId: ctx.actor.user.id });
      // One that no longer reads, or whose condition the issue doesn't match, isn't offered.
      if (when.problems.length || (when.where && !(await meets(ctx.db, issue.id, [when.where]))[0])) continue;
    }
    actions.push({ id: a.id, name: a.name, scripted: a.script !== null, allowed: true, why: null });
  }
  return { transitions, actions };
}

/** Make one of an issue's transitions, by name, as the caller. */
export async function runTransition(ctx: Ctx, idOrReadable: string, body: { field?: string; transition: string; expectedVersion?: number }): Promise<IssueDetail> {
  requireScope(ctx, 'write');
  const issue = await resolveIssue(ctx, idOrReadable);
  const s = await ctx.app.schema.get();
  const spec = await commandSpec(ctx, issue, [{ kind: 'transition', name: body.transition, field: body.field ?? '', to: '' }]);
  if (body.field && spec.transition && s.fields.get(spec.transition.fieldId)?.name.toLowerCase() !== body.field.toLowerCase()) {
    throw badRequest(`${body.field} has no transition “${body.transition}”`).said('workflow.noTransition', { field: body.field, transition: body.transition });
  }
  const res = await ctx.db.transaction(async (tx) => {
    const fresh = (await findIssue(tx as unknown as Db, s, issue.id)) ?? issue;
    return applyChanges(tx as unknown as Db, ctx, fresh, { ...spec, expectedVersion: body.expectedVersion });
  });
  await publishActivities(ctx.app, res.activities);
  return issueDetail(ctx, res.issue);
}

/** Run one of the project's actions on an issue, as the caller, who must be able to change it. */
export async function runAction(ctx: Ctx, idOrReadable: string, actionId: string, body: { expectedVersion?: number } = {}): Promise<IssueDetail> {
  requireScope(ctx, 'write');
  const issue = await resolveIssue(ctx, idOrReadable);
  const s = await ctx.app.schema.get();
  const action = actionsFor(s, issue.projectId).find((a) => a.id === actionId && a.enabled);
  if (!action) {
    const key = s.projects.get(issue.projectId)?.key;
    throw key
      ? notFound('Action', `${key} has no such action, or it is off.`).said('workflow.noSuchAction', { project: key })
      : notFound('Action', 'The project has no such action, or it is off.').said('workflow.noSuchActionHere');
  }
  if (!action.script) {
    // A command action: the executor reads it, condition and all, as the command bar does.
    const spec = await commandSpec(ctx, issue, [{ kind: 'action', name: action.name }]);
    const res = await ctx.db.transaction(async (tx) => {
      const fresh = (await findIssue(tx as unknown as Db, s, issue.id)) ?? issue;
      return applyChanges(tx as unknown as Db, ctx, fresh, { ...spec, expectedVersion: body.expectedVersion, data: { ...spec.data, action: action.name } });
    });
    await publishActivities(ctx.app, res.activities);
    return issueDetail(ctx, res.issue);
  }
  if (action.condition.trim()) {
    const when = condition(ruleWorld(s, issue.projectId), action.condition, { meId: ctx.actor.user.id });
    if (when.problems.length) throw badRequest(`The action “${action.name}” no longer reads: ${when.problems.map((p) => p.message).join('; ')}`).said('command.actionUnreadable', { action: action.name, problems: saidProblems(when.problems) });
    if (when.where && !(await meets(ctx.db, issue.id, [when.where]))[0]) throw badRequest(`“${action.name}” isn't offered for this issue now`, `It's for issues that match “${action.condition}”.`).said('workflow.actionNotOffered', { action: action.name, condition: action.condition });
  }
  if (body.expectedVersion !== undefined && body.expectedVersion !== issue.version) {
    throw conflict('The issue was changed by someone else', 'Reload it and run the action again.', { currentVersion: issue.version }).said('workflow.issueChangedMeanwhile');
  }
  // A scripted action: its script, then what it asked for, as the caller, all in one transaction.
  const input = await scriptInput(ctx.db, s, issue, changeOf('action', s.users.get(ctx.actor.user.id), [], { action: action.name }));
  const out = await runScript(action.script, input);
  if (out.error) throw new AppError(422, 'action_failed', `The action “${action.name}” stopped: ${out.error.message}`, 'Nothing was changed. Its script needs fixing: tell an administrator.').said('workflow.actionStopped', { action: action.name, error: asSentence(out.error.message) });
  if (out.intents.refusal !== null) {
    throw new AppError(422, 'refused_by_action', out.intents.refusal, `The action “${action.name}” refuses it. Nothing was changed.`).said('workflow.actionRefused', {
      refusal: asSentence(out.intents.refusal),
      action: action.name,
    });
  }
  const planned = await plannedChanges(ctx, ctx.db, s, issue, input.issue, out.intents);
  const res = await ctx.db.transaction(async (tx) => applyPlanned(tx as unknown as Db, ctx, s, issue, planned, { action: action.name }));
  await publishActivities(ctx.app, res.activities);
  return issueDetail(ctx, (await findIssue(ctx.db, s, issue.id)) ?? issue);
}
