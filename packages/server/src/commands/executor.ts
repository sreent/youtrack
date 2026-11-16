import { MAX_BULK_ISSUES, type CommandResult } from '@a4a/shared';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { publishActivities, type ActivityRow } from '../events/activity';
import { AppError, badRequest } from '../lib/errors';
import { readableId } from '../services/issue-refs';
import { visibleSchema } from '../services/access';
import { applyChanges, findIssue, findVisibleIssue, type ChangeSpec, type FieldChangeSpec, type IssueRow, type LinkSpec } from '../services/issues';
import { resolveFieldInput } from '../services/values';
import { todayIn } from '../reports/tz';
import { zoneOf } from '../services/time-zones';
import { actionsFor, machinesFor, transitionsOf } from '../services/schema-cache';
import { condition, meets, ruleWorld } from '../workflow/match';
import { runScript } from '../workflow/sandbox';
import { changeOf, scriptInput } from '../workflow/script-issue';
import { describeCommand, parseCommand, type CommandOp } from './parser';

export interface CommandRequest {
  issues: string[];
  command: string;
  comment?: string;
  dryRun?: boolean;
  /**
   * Who "me" is in the command, when it isn't whoever applies it: a workflow rule applies as the
   * workflow agent, and its "me" is the person whose change set it off.
   */
  meId?: string;
}

export async function runCommand(ctx: Ctx, req: CommandRequest): Promise<CommandResult & { description: string }> {
  requireScope(ctx, req.dryRun ? 'read' : 'write');
  if (req.issues.length > MAX_BULK_ISSUES) {
    throw badRequest(`A command can change at most ${MAX_BULK_ISSUES} issues at once`, 'Split the list into smaller batches.');
  }
  const s = await ctx.app.schema.get();
  const rows: IssueRow[] = [];
  const missing: string[] = [];
  for (const id of req.issues) {
    // An issue the caller can't see is unknown, exactly as one that doesn't exist.
    const row = await findVisibleIssue(ctx, id);
    if (row) rows.push(row);
    else missing.push(id);
  }
  if (missing.length) throw badRequest(`Unknown issues: ${missing.join(', ')}`);
  const projectIds = [...new Set(rows.map((r) => r.projectId))];
  const parsed = parseCommand(req.command, s, projectIds);
  const description = describeCommand(parsed.ops);
  if (parsed.problems.length) {
    return { applied: false, problems: parsed.problems, results: [], description };
  }
  if (!parsed.ops.length && !req.comment?.trim()) {
    return {
      applied: false,
      problems: [{ message: 'The command is empty', start: 0, end: 0, hint: 'e.g. "State Fixed" or "for me"' }],
      results: [],
      description,
    };
  }

  const results: CommandResult['results'] = [];
  const activities: ActivityRow[] = [];
  for (const issue of rows) {
    const rid = readableId(s, issue);
    const errors: string[] = [];
    let spec: ChangeSpec;
    try {
      spec = await commandSpec(ctx, issue, parsed.ops, req.comment, { meId: req.meId });
    } catch (e) {
      results.push({ issue: rid, changes: [], errors: [e instanceof Error ? e.message : String(e)] });
      continue;
    }
    try {
      const res = await ctx.db.transaction(async (tx) => {
        // Re-read inside the transaction so concurrent edits are not lost.
        const fresh = (await findIssue(tx as unknown as Db, s, issue.id)) ?? issue;
        return applyChanges(tx as unknown as Db, ctx, fresh, spec, { dryRun: req.dryRun });
      });
      activities.push(...res.activities);
      results.push({ issue: rid, changes: res.changes, errors });
    } catch (e) {
      const msg = e instanceof AppError ? (e.hint ? `${e.message} (${e.hint})` : e.message) : String(e);
      results.push({ issue: rid, changes: [], errors: [msg] });
    }
  }
  await publishActivities(ctx.app, activities);
  return { applied: !req.dryRun && results.some((r) => r.changes.length > 0), problems: [], results, description };
}

/**
 * What a command's ops change on one issue, with names resolved in the issue's project: the step
 * the executor takes for each issue, before applyChanges. "me" is `meId`, by default whoever acts.
 * Inside a transaction, pass it as `db` (PGlite has one connection).
 */
export async function commandSpec(
  ctx: Ctx,
  issue: IssueRow,
  ops: CommandOp[],
  comment?: string,
  opts: { meId?: string; db?: Db; noScripts?: boolean; inAction?: string } = {},
): Promise<ChangeSpec> {
  const db = opts.db ?? ctx.db;
  const meId = opts.meId ?? ctx.actor.user.id;
  // "Due date today" is today where whoever acts is (D31); for the workflow agent, the server's.
  const today = todayIn(zoneOf(ctx));
  const s = await ctx.app.schema.get(opts.db);
  const project = s.projects.get(issue.projectId)!;
  const attached = new Set((s.projectFields.get(project.id) ?? []).map((pf) => pf.fieldId));
  const fields: FieldChangeSpec[] = [];
  const links: LinkSpec[] = [];
  const addTags: string[] = [];
  const removeTags: string[] = [];
  const comments: string[] = [];
  let transition: ChangeSpec['transition'];
  /** What another spec (an action's) adds to this one. */
  const merge = (sub: ChangeSpec) => {
    fields.push(...(sub.fields ?? []));
    links.push(...(sub.links ?? []));
    addTags.push(...(sub.addTags ?? []));
    removeTags.push(...(sub.removeTags ?? []));
    if (sub.comment) comments.push(sub.comment);
    if (sub.transition) transition = sub.transition;
  };
  for (const op of ops) {
    switch (op.kind) {
      case 'transition': {
        const found = machinesFor(s, project.id)
          .filter((m) => m.enabled)
          .flatMap((m) => transitionsOf(m).map((t) => ({ m, t })))
          .find((x) => x.t.name.toLowerCase() === op.name.toLowerCase());
        const field = found ? s.fields.get(found.m.fieldId) : undefined;
        if (!found || !field || !attached.has(field.id)) throw badRequest(`${project.key} has no transition “${op.name}”`);
        // The write path checks that it goes from the state the issue is in, and its condition (D40).
        fields.push({ field, mode: 'set', values: resolveFieldInput(s, field, project.id, found.t.to, meId, today) });
        transition = { fieldId: field.id, name: found.t.name };
        break;
      }
      case 'action': {
        if (opts.inAction) throw badRequest(`The action “${opts.inAction}” runs another action, “${op.name}”, and an action can't`);
        const action = actionsFor(s, project.id).find((a) => a.enabled && a.name.toLowerCase() === op.name.toLowerCase());
        if (!action) throw badRequest(`${project.key} has no action “${op.name}”`);
        const rid = `${project.key}-${issue.number}`;
        if (action.condition.trim()) {
          const when = condition(ruleWorld(s, project.id), action.condition, { meId });
          if (when.problems.length) throw badRequest(`The action “${action.name}” no longer reads: ${when.problems.map((p) => p.message).join('; ')}`);
          if (when.where && !(await meets(db, issue.id, [when.where]))[0]) {
            throw badRequest(`“${action.name}” isn't offered for ${rid} now`, `It's for issues that match “${action.condition}”.`);
          }
        }
        if (action.script) {
          if (opts.noScripts) throw badRequest(`“${action.name}” is a scripted action, and a script can't run another script`);
          const out = await runScript(action.script, await scriptInput(db, s, issue, changeOf('action', s.users.get(ctx.actor.user.id), [], { action: action.name })));
          if (out.error) throw badRequest(`The action “${action.name}” stopped: ${out.error.message}`);
          if (out.intents.refusal !== null) throw new AppError(422, 'refused_by_action', out.intents.refusal, `The action “${action.name}” refuses it.`);
          for (const a of out.intents.applies) {
            // Run as a command, a scripted action changes only its issue: its button reaches the rest.
            if (a.to && a.to !== rid) throw badRequest(`Run as a command, “${action.name}” changes only ${rid}, not ${a.to}`, 'Use its button on the issue.');
            const parsed = parseCommand(a.command, s, [project.id]);
            if (parsed.problems.length) throw badRequest(`The action “${action.name}” asks for “${a.command}”, which doesn't fit ${project.key}: ${parsed.problems.map((p) => p.message).join('; ')}`);
            merge(await commandSpec(ctx, issue, parsed.ops, undefined, { ...opts, noScripts: true, inAction: action.name }));
          }
          comments.push(...out.intents.comments);
        } else {
          const parsed = parseCommand(action.command, s, [project.id]);
          if (parsed.problems.length) throw badRequest(`The action “${action.name}” no longer fits ${project.key}: ${parsed.problems.map((p) => p.message).join('; ')}`);
          merge(await commandSpec(ctx, issue, parsed.ops, undefined, { ...opts, inAction: action.name }));
        }
        break;
      }
      case 'field': {
        if (!attached.has(op.field.id)) throw badRequest(`${project.key} has no field ${op.field.name}`);
        const values = op.raw.flatMap((r) => resolveFieldInput(s, op.field, project.id, r, meId, today));
        fields.push({ field: op.field, mode: op.mode, values });
        break;
      }
      case 'tag':
        (op.mode === 'add' ? addTags : removeTags).push(op.name);
        break;
      case 'link':
        for (const t of op.targets) {
          // A target the actor can't see is unknown, exactly as one that doesn't exist.
          const target = await findVisibleIssue(ctx, t, db);
          if (!target) throw badRequest(`Unknown issue ${t}`);
          links.push({ phrase: op.phrase, target, remove: op.mode === 'remove' });
        }
        break;
      case 'comment':
        if (op.text) comments.push(op.text);
        break;
    }
  }
  if (comment?.trim()) comments.push(comment.trim());
  // The same words given both ways (in the command and as its comment) are one comment.
  return { fields, links, addTags, removeTags, comment: [...new Set(comments)].join('\n\n') || undefined, ...(transition ? { transition } : {}) };
}

export function parseCommandForApi(ctx: Ctx, command: string, projectIds: string[]) {
  return visibleSchema(ctx).then((s) => {
    const parsed = parseCommand(command, s, projectIds);
    return { problems: parsed.problems, description: describeCommand(parsed.ops) };
  });
}
