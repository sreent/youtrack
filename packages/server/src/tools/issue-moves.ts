/**
 * Tools to move, clone and vote for issues (D41).
 */
import { z } from 'zod';
import { setVote } from '../services/votes';
import { cloneIssue, moveIssue } from '../services/move';
import { defineTool, type ToolDef } from './types';

const FieldsArg = z
  .record(z.string(), z.union([z.string(), z.number(), z.null(), z.array(z.string())]))
  .describe('Values, by field name, for fields whose value does not carry over (the problems say which); null leaves one empty.');

const moveIssueTool = defineTool({
  name: 'move_issue',
  title: 'Move an issue to another project',
  description:
    'Move an issue to another project. It takes that project\'s next number; its old id keeps finding it. Values carry over by name; anything that does not (a value the other project lacks, a person who cannot see it, a field it requires) is a problem, and nothing moves until each has a value in fields (or null). Use dry_run first to see the problems and what carries over.',
  input: z.object({
    issue: z.string().describe('The issue, e.g. BACK-12'),
    project: z.string().describe('The key of the project it moves to'),
    fields: FieldsArg.optional(),
    dry_run: z.boolean().optional().describe('Say what would happen, and change nothing'),
  }),
  kind: 'changes',
  async preview(ctx, input) {
    const plan = await moveIssue(ctx, input.issue, { project: input.project, fields: input.fields, dryRun: true });
    const problems = plan.problems.length ? ` Problems: ${plan.problems.map((p) => p.message).join('; ')}.` : '';
    return `Move ${plan.from} to ${plan.project.key}, as ${plan.to}.${problems}`;
  },
  async run(ctx, input) {
    const plan = await moveIssue(ctx, input.issue, { project: input.project, fields: input.fields, dryRun: input.dry_run ?? false });
    const data = {
      from: plan.from,
      to: plan.to,
      moved: plan.moved,
      problems: plan.problems,
      carried: plan.carried,
      dropped: plan.dropped,
      left_sprints: plan.leftSprints,
    };
    if (!plan.moved) return { data, summary: plan.problems.length ? `${plan.from} can't move yet: ${plan.problems.length} problem(s)` : `${plan.from} would move to ${plan.to}` };
    return { data, summary: `Moved ${plan.from} to ${plan.to}` };
  },
});

const cloneIssueTool = defineTool({
  name: 'clone_issue',
  title: 'Clone an issue',
  description:
    'Copy an issue, in its project or another: its summary, description, field values and tags, linked to the original ("clones") and under the same parent. Comments, files, work and votes stay with the original. Values another project lacks are left to its defaults.',
  input: z.object({
    issue: z.string().describe('The issue to copy, e.g. BACK-12'),
    project: z.string().optional().describe('Where the copy goes; its own project if left out'),
    summary: z.string().optional().describe("The copy's summary; the original's if left out"),
  }),
  kind: 'changes',
  async preview(_ctx, input) {
    return `Clone ${input.issue.toUpperCase()}${input.project ? ` into ${input.project.toUpperCase()}` : ''}`;
  },
  async run(ctx, input) {
    const copy = await cloneIssue(ctx, input.issue, { project: input.project, summary: input.summary });
    return { data: { id: copy.id, summary: copy.summary, url: `${ctx.app.config.publicUrl}/issues/${copy.id}` }, summary: `Cloned ${input.issue.toUpperCase()} as ${copy.id}` };
  },
});

const voteIssueTool = defineTool({
  name: 'vote_issue',
  title: 'Vote for an issue',
  description: 'Vote for an issue, or take your vote back (vote: false). Votes count how many people want it; its reporter cannot vote. Sort by them with "sort by: votes desc".',
  input: z.object({ issue: z.string(), vote: z.boolean().default(true) }),
  kind: 'changes',
  idempotent: true,
  async preview(_ctx, input) {
    return `${input.vote === false ? 'Take back your vote for' : 'Vote for'} ${input.issue.toUpperCase()}`;
  },
  async run(ctx, input) {
    const v = await setVote(ctx, input.issue, input.vote !== false);
    return { data: v, summary: `${v.voted ? 'Voted for' : 'Took back the vote for'} ${input.issue.toUpperCase()} (${v.votes} vote${v.votes === 1 ? '' : 's'})` };
  },
});

export const issueMoveTools = [moveIssueTool, cloneIssueTool, voteIssueTool] as unknown as ToolDef[];
