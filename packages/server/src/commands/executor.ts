import { MAX_BULK_ISSUES, type Change, type CommandResult } from '@a4a/shared';
import { and, eq, sql } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { boards, sprints } from '../db/schema';
import { publishActivities, type ActivityRow } from '../events/activity';
import { AppError, badRequest } from '../lib/errors';
import { readableId } from '../services/issue-refs';
import { assertCanWriteProject, visibleSchema } from '../services/access';
import { changeSprintInTx, type BoardRow, type SprintRow } from '../services/boards';
import { applyChanges, findIssue, findVisibleIssue, type ChangeSpec, type FieldChangeSpec, type IssueRow, type LinkSpec } from '../services/issues';
import { resolveFieldInput } from '../services/values';
import { todayIn } from '../reports/tz';
import { zoneOf } from '../services/time-zones';
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
    let moves: SprintMove[];
    try {
      spec = await commandSpec(ctx, issue, parsed.ops, req.comment, { meId: req.meId, sprints: true });
      moves = await sprintMoves(ctx, issue, parsed.ops);
      if (moves.length) await assertCanWriteProject(ctx, issue.projectId);
    } catch (e) {
      results.push({ issue: rid, changes: [], errors: [e instanceof Error ? e.message : String(e)] });
      continue;
    }
    try {
      const res = await ctx.db.transaction(async (tx) => {
        // Re-read inside the transaction so concurrent edits are not lost.
        const fresh = (await findIssue(tx as unknown as Db, s, issue.id)) ?? issue;
        const applied = await applyChanges(tx as unknown as Db, ctx, fresh, spec, { dryRun: req.dryRun });
        // Into or out of sprints in the same transaction: all of the command, or none of it (D43).
        const sprintChanges: Change[] = [];
        for (const m of moves) {
          if (req.dryRun) {
            sprintChanges.push(m.remove ? { field: 'Sprint', from: m.sprint.name, to: null } : { field: 'Sprint', from: null, to: m.sprint.name });
            continue;
          }
          const done = await changeSprintInTx(tx as unknown as Db, ctx, m.sprint, m.board, [fresh], m.remove);
          applied.activities.push(...done);
          if (done.length) sprintChanges.push(m.remove ? { field: 'Sprint', from: m.sprint.name, to: null } : { field: 'Sprint', from: null, to: m.sprint.name });
        }
        return { ...applied, changes: [...applied.changes, ...sprintChanges] };
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

interface SprintMove {
  sprint: SprintRow;
  board: BoardRow;
  remove: boolean;
}

/**
 * The sprints a command's sprint clauses name, for one issue (D43): by name, on the boards of its
 * project that use sprints. A name more than one such sprint has is refused, as is one none has;
 * an archived sprint takes no new issues.
 */
async function sprintMoves(ctx: Ctx, issue: IssueRow, ops: CommandOp[]): Promise<SprintMove[]> {
  const out: SprintMove[] = [];
  for (const op of ops) {
    if (op.kind !== 'sprint') continue;
    const found = await ctx.db
      .select({ sprint: sprints, board: boards })
      .from(sprints)
      .innerJoin(boards, eq(boards.id, sprints.boardId))
      .where(and(sql`lower(${sprints.name}) = ${op.name.toLowerCase()}`, eq(boards.sprintsEnabled, true), sql`${issue.projectId} = ANY(${boards.projectIds})`));
    const open = op.mode === 'add' ? found.filter((f) => !f.sprint.archived) : found;
    if (!open.length) {
      throw badRequest(
        found.length ? `${found[0]!.sprint.name} is archived` : `No board of this issue's project has a sprint called ${op.name}`,
        found.length ? 'Choose a sprint that is still open.' : 'Name a sprint of one of its boards.',
      );
    }
    if (open.length > 1) {
      throw badRequest(`${open.length} sprints are called ${op.name}: on ${open.map((f) => f.board.name).join(', ')}`, 'Rename one, or use PUT /sprints/{id}/issues.');
    }
    out.push({ sprint: open[0]!.sprint, board: open[0]!.board, remove: op.mode === 'remove' });
  }
  return out;
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
  opts: { meId?: string; db?: Db; sprints?: boolean } = {},
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
  for (const op of ops) {
    switch (op.kind) {
      case 'field': {
        if (!attached.has(op.field.id)) throw badRequest(`${project.key} has no field ${op.field.name}`);
        const values = op.raw.flatMap((r) => resolveFieldInput(s, op.field, project.id, r, meId, today, zoneOf(ctx)));
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
      case 'sprint':
        // Only a command run on issues moves them between sprints (runCommand does), not a rule's.
        if (!opts.sprints) throw badRequest('Sprints are changed by a command run on issues', 'Leave the sprint clause out here.');
        break;
    }
  }
  if (comment?.trim()) comments.push(comment.trim());
  // The same words given both ways (in the command and as its comment) are one comment.
  return { fields, links, addTags, removeTags, comment: [...new Set(comments)].join('\n\n') || undefined };
}

export function parseCommandForApi(ctx: Ctx, command: string, projectIds: string[]) {
  return visibleSchema(ctx).then((s) => {
    const parsed = parseCommand(command, s, projectIds);
    return { problems: parsed.problems, description: describeCommand(parsed.ops) };
  });
}
