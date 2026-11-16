import { formatPeriod } from '@a4a/shared';
import { z } from 'zod';
import { createBaseline, getCostReport, getResourceLoad, getSchedule, level, listBaselines, whatIfSchedule } from '../services/planning';
import { defineTool, type ToolDef } from './types';

const money = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(n));

const getScheduleTool = defineTool({
  name: 'get_schedule',
  title: 'Project schedule',
  description:
    "A project's plan (Gantt): finish date, critical path, late tasks, slack, and variance against a baseline. Pass what_if to see the effect of a delay, a new estimate or a different assignee without saving anything, e.g. what_if: [{\"issue\": \"MIG-12\", \"delay_days\": 3}].",
  input: z.object({
    project: z.string(),
    baseline: z.string().optional().describe('Baseline id (see list in the result) to compare against'),
    query: z.string().optional().describe('Limit the plan to issues matching this query'),
    what_if: z
      .array(
        z.object({
          issue: z.string(),
          delay_days: z.number().optional(),
          estimate: z.string().optional().describe('e.g. "5d"'),
          assignee: z.string().nullable().optional(),
        }),
      )
      .optional(),
  }),
  kind: 'reads',
  async run(ctx, input) {
    const baselines = await listBaselines(ctx, input.project);
    if (input.what_if?.length) {
      const res = await whatIfSchedule(ctx, input.project, {
        query: input.query,
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
        },
        summary: `What-if: finish moves ${res.finishDeltaDays} working days`,
      };
    }
    const sch = await getSchedule(ctx, input.project, { query: input.query, baseline: input.baseline });
    const leaves = sch.tasks.filter((t) => !t.isSummary);
    return {
      data: {
        start: sch.start,
        finish: sch.finish,
        today: sch.today,
        criticalPath: sch.criticalPath,
        baseline: sch.baseline,
        baselines: baselines.map((b) => ({ id: b.id, name: b.name, created: b.createdAt.slice(0, 10), finish: b.finish })),
        late: leaves.filter((t) => t.late).map((t) => ({ id: t.issue.id, finish: t.finish, due: t.deadline })),
        tasks: sch.tasks.map((t) => ({
          id: t.issue.id,
          summary: t.issue.summary,
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
        })),
        warnings: sch.warnings,
      },
      summary: `${sch.project.key} finishes ${sch.finish}; ${sch.criticalPath.length} tasks on the critical path`,
    };
  },
});

const getResourceLoadTool = defineTool({
  name: 'get_resource_load',
  title: 'Resource load',
  description: 'Who is over capacity on which days, from the current plan. Use it before re-assigning work or levelling.',
  input: z.object({ project: z.string(), from: z.string().optional(), to: z.string().optional() }),
  kind: 'reads',
  async run(ctx, input) {
    const load = await getResourceLoad(ctx, input.project, { from: input.from, to: input.to });
    return {
      data: {
        from: load.from,
        to: load.to,
        unassignedHours: load.unassignedHours,
        people: load.resources.map((r) => ({
          login: r.user.login,
          capacityPerDay: r.capacityHoursPerDay,
          totalHours: r.totalHours,
          overallocatedDays: r.overallocatedDays,
          peakLoad: `${Math.round(r.peakLoadPct)}%`,
          overDays: r.days.filter((d) => d.hours > d.capacity + 0.01).slice(0, 15).map((d) => ({ date: d.date, hours: d.hours, capacity: d.capacity, tasks: d.tasks.map((t) => t.issue) })),
        })),
      },
      summary: `${load.resources.filter((r) => r.overallocatedDays > 0).length} people over capacity`,
    };
  },
});

const getCostReportTool = defineTool({
  name: 'get_cost_report',
  title: 'Cost report',
  description: 'Budget, planned, actual and forecast cost, by task and by person; with a baseline, earned value (CPI, SPI, EAC).',
  input: z.object({ project: z.string(), baseline: z.string().optional() }),
  kind: 'reads',
  async run(ctx, input) {
    const c = await getCostReport(ctx, input.project, { baseline: input.baseline });
    return {
      data: {
        currency: c.currency,
        budget: money(c.budget),
        planned: money(c.plannedCost),
        actual: money(c.actualCost),
        forecast: money(c.forecastCost),
        budgetVariance: money(c.budgetVariance),
        evm: c.evm,
        byPerson: c.byPerson.map((p) => ({ login: p.user.login, rate: p.hourlyRate, plannedHours: p.plannedHours, actualHours: p.actualHours, planned: money(p.plannedCost), actual: money(p.actualCost) })),
        topTasks: [...c.byTask].sort((a, b) => b.plannedCost - a.plannedCost).slice(0, 15).map((t) => ({ id: t.issue, planned: money(t.plannedCost), actual: money(t.actualCost) })),
        warnings: c.warnings,
      },
      summary: `Forecast ${money(c.forecastCost)} ${c.currency}${c.budget !== null ? ` against a budget of ${money(c.budget)}` : ''}`,
    };
  },
});

const levelResourcesTool = defineTool({
  name: 'level_resources',
  title: 'Level resources',
  description:
    'Resolve over-allocation by moving task starts. With dry_run (the default) it only proposes; apply only after the person agrees, passing the proposal\'s `starts` as `expect` so that nothing is applied if the plan changed in between. within_slack never moves the finish date; allow_delay may.',
  input: z.object({
    project: z.string(),
    mode: z.enum(['within_slack', 'allow_delay']).default('within_slack'),
    dry_run: z.boolean().default(true),
    expect: z.record(z.string(), z.string()).optional().describe('The `starts` of the dry run the person agreed to'),
  }),
  kind: 'changes',
  destructive: true,
  async preview(ctx, input) {
    const p = await level(ctx, input.project, { mode: input.mode, dryRun: true });
    const key = input.project.toUpperCase();
    if (!p.changes.length) return `Levelling ${key} would move nothing`;
    const moved = p.changes.filter((c) => c.movedBy === 'resources');
    const follow = p.changes.length - moved.length;
    return [
      `Move ${moved.length} task starts in ${key} (finish ${p.finishBefore} → ${p.finishAfter}):`,
      ...moved.map((c) => `${c.issue}: ${c.fromStart} → ${c.toStart}`),
      ...(follow ? [`${follow} more follow their predecessors`] : []),
    ].join('\n');
  },
  async run(ctx, input) {
    const res = await level(ctx, input.project, { mode: input.mode, dryRun: input.dry_run, expect: input.expect });
    const moved = Object.keys(res.starts).length;
    return {
      data: res,
      summary: input.dry_run ? `Levelling would move ${moved} task starts` : `Levelled: moved ${moved} task starts`,
    };
  },
});

const createBaselineTool = defineTool({
  name: 'create_baseline',
  title: 'Save a baseline',
  description: 'Snapshot the current plan (dates, effort, cost) under a name, to measure slippage and earned value against later.',
  input: z.object({ project: z.string(), name: z.string().min(1), note: z.string().optional() }),
  kind: 'changes',
  async preview(_ctx, input) {
    return `Save the current plan of ${input.project.toUpperCase()} as baseline "${input.name}"`;
  },
  async run(ctx, input) {
    const b = await createBaseline(ctx, input.project, { name: input.name, note: input.note });
    return { data: b, summary: `Saved baseline "${b.name}"` };
  },
});

export const planningTools: ToolDef[] = [getScheduleTool, getResourceLoadTool, getCostReportTool, levelResourcesTool, createBaselineTool] as unknown as ToolDef[];
