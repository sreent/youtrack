import { formatPeriod, type PlanScope } from '@a4a/shared';
import { z } from 'zod';
import { badRequest } from '../lib/errors';
import { getPlanSchedule, listSearchBaselines, whatIfPlan } from '../services/planning';
import { defineTool, type ToolDef } from './types';

/**
 * MCP tools for plans of a search (docs/architecture.md, D72), such as `move_task`, whose preview is a
 * move's dry run (P6). Registered in tools/registry.ts, so the packages that bring them add their tools
 * here and touch no registry. Today's planning tools stay in tools/planning.ts, their names and shapes
 * as they are.
 */

const getPlanTool = defineTool({
  name: 'get_plan',
  title: 'Plan of a search',
  description:
    "The plan of a saved search or a query, across projects (each issue on its own project's calendar): finish date, critical path, late tasks, slack, and variance against one of the saved search's baselines. Pass saved_search (an id) or query (empty for every issue you can see), and project to narrow either to one project. A plan holds at most 2,000 issues: `truncated` says when the search found more (`total`), so narrow it. Pass what_if as get_schedule takes it to see the effect of a delay, a new estimate or a different assignee without saving anything.",
  input: z.object({
    saved_search: z.string().max(64).optional().describe("A saved search's id: yours, or one shared with you"),
    query: z.string().max(2000).optional().describe('A query, as on the issues page; empty for every issue you can see'),
    project: z.string().max(10).optional().describe("Narrow the plan to one project's issues, by key"),
    baseline: z.string().max(64).optional().describe("A baseline to compare with: one of the saved search's, or, with project and a query, one of the project's"),
    what_if: z
      .array(
        z.object({
          issue: z.string(),
          delay_days: z.number().optional(),
          estimate: z.string().optional().describe('e.g. "5d"'),
          assignee: z.string().nullable().optional(),
        }),
      )
      .max(200)
      .optional(),
  }),
  kind: 'reads',
  async run(ctx, input) {
    if ((input.saved_search === undefined) === (input.query === undefined)) {
      throw badRequest('Pass saved_search or query: one of them', 'query may be empty, for every issue you can see.').said('plans.scopeOneOf');
    }
    const project = input.project ? { project: input.project } : {};
    const scope: PlanScope = input.saved_search !== undefined ? { savedSearch: input.saved_search, ...project } : { query: input.query ?? '', ...project };
    if (input.what_if?.length) {
      const res = await whatIfPlan(ctx, {
        scope,
        baseline: input.baseline,
        overrides: input.what_if.map((o) => ({ issue: o.issue, delayDays: o.delay_days, estimate: o.estimate, assignee: o.assignee })),
      });
      return {
        data: {
          finishBefore: res.before.finish,
          finishAfter: res.after.finish,
          finishDeltaWorkingDays: res.finishDeltaDays,
          criticalPathBefore: res.before.criticalPath,
          criticalPathAfter: res.after.criticalPath,
          impacted: res.impacted,
          total: res.after.total,
          truncated: res.after.truncated,
        },
        summary: `What-if: finish moves ${res.finishDeltaDays} working days`,
      };
    }
    const sch = await getPlanSchedule(ctx, scope, { baseline: input.baseline });
    const baselines = 'savedSearch' in scope ? await listSearchBaselines(ctx, scope.savedSearch) : [];
    const leaves = sch.tasks.filter((t) => !t.isSummary);
    const set = (v: { field: string; value: string | number | null } | null | undefined, period = false) =>
      v && v.value !== null ? `${v.field}: ${period && typeof v.value === 'number' ? formatPeriod(v.value) : v.value}` : undefined;
    return {
      data: {
        start: sch.start,
        finish: sch.finish,
        today: sch.today,
        total: sch.total,
        truncated: sch.truncated,
        projects: sch.projects,
        criticalPath: sch.criticalPath,
        baseline: sch.baseline,
        baselines: baselines.map((b) => ({ id: b.id, name: b.name, created: b.createdAt.slice(0, 10), finish: b.finish })),
        late: leaves.filter((t) => t.late).map((t) => ({ id: t.issue.id, finish: t.finish, due: t.deadline })),
        tasks: sch.tasks.map((t) => ({
          id: t.issue.id,
          summary: t.issue.summary,
          project: t.project,
          parent: t.parent,
          summaryTask: t.isSummary || undefined,
          assignee: t.assignee?.login ?? null,
          start: t.start,
          finish: t.finish,
          effort: t.effortMinutes ? formatPeriod(t.effortMinutes) : null,
          done: `${t.percentComplete}%`,
          slackDays: t.slackDays,
          critical: t.critical || undefined,
          late: t.late || undefined,
          dependsOn: t.predecessors.length ? t.predecessors : undefined,
          variance: t.variance ? { startDays: t.variance.startDays, finishDays: t.variance.finishDays } : undefined,
          readOnly: t.editable === false || undefined,
          set: t.set ? { start: set(t.set.start), end: set(t.set.end), estimate: set(t.set.estimate, true) } : undefined,
        })),
        warnings: sch.warnings,
      },
      summary: sch.truncated
        ? `The plan holds the first ${sch.tasks.length} of ${sch.total} issues, and finishes ${sch.finish}: narrow the search to plan the rest`
        : `The plan of ${sch.total} issues finishes ${sch.finish}; ${sch.criticalPath.length} tasks on the critical path`,
    };
  },
});

export const plansTools: ToolDef[] = [getPlanTool] as unknown as ToolDef[];
