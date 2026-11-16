/**
 * Reports for agents: one tool, `get_report`, for "are we on track?" (a sprint's burndown), how
 * work flows (cumulative flow), how long it takes (cycle time) and where time went (logged work).
 * Answers are compact: the figures an agent reasons with, and a sentence it can repeat.
 */
import { formatPeriod } from '@a4a/shared';
import { z } from 'zod';
import { burndownReport, createdResolvedReport, cycleTimeReport, flowReport, timeReport } from '../services/reports';
import { defineTool, type ToolDef } from './types';

const hours = (m: number) => Math.round((m / 60) * 10) / 10;

const getReportTool = defineTool({
  name: 'get_report',
  title: 'Report',
  description: [
    'Reports worked out from the issues\' history and logged work.',
    '- burndown: is a sprint on track? Pass board (its current sprint) or sprint. Answers what was committed, what is left, the ideal for today, scope added, a verdict in words and a forecast.',
    '- flow: issues in each state at the end of each day (cumulative flow), for a project or a query.',
    '- cycle_time: days from first In Progress to resolved, with percentiles (p50, p85), for issues resolved in the window.',
    '- created_resolved: issues created against resolved, by day, week or month.',
    '- time: work logged by person, issue, project and week, with each issue\'s estimate against what was spent.',
    'Windows default to the last 30 days (90 for cycle time, 28 for time); dates are YYYY-MM-DD.',
  ].join('\n'),
  input: z.object({
    report: z.enum(['burndown', 'flow', 'cycle_time', 'created_resolved', 'time']),
    board: z.string().optional().describe('burndown: board name or id (its current sprint)'),
    sprint: z.string().optional().describe('burndown: sprint id, or its name with board'),
    by: z.enum(['estimate', 'count']).optional().describe('burndown: by estimate (default) or by issue count'),
    project: z.string().optional().describe('Project key'),
    query: z.string().optional().describe('Only issues matching this query'),
    from: z.string().optional(),
    to: z.string().optional(),
    start_states: z.string().optional().describe('cycle_time: states that start the clock, comma-separated (default In Progress)'),
    author: z.string().optional().describe('time: only this person\'s work (login)'),
    interval: z.enum(['day', 'week', 'month']).optional().describe('created_resolved'),
    time_zone: z.string().optional().describe('IANA zone the days are in; default the server\'s'),
  }),
  kind: 'reads',
  async run(ctx, input) {
    const tz = input.time_zone;
    switch (input.report) {
      case 'burndown': {
        const b = await burndownReport(ctx, { board: input.board, sprint: input.sprint, by: input.by, timeZone: tz });
        const v = (n: number | null) => (n === null ? null : b.by === 'count' ? n : formatPeriod(n));
        return {
          data: {
            sprint: b.sprint.name,
            board: b.sprint.board.name,
            dates: `${b.sprint.startDate} to ${b.sprint.endDate}`,
            by: b.by,
            verdict: b.status.verdict,
            says: b.status.words,
            committed: v(b.start),
            remaining: v(b.remaining),
            idealToday: v(b.status.idealNow),
            completed: v(b.completed),
            scopeAdded: v(b.added),
            scopeRemoved: v(b.removed),
            workingDaysLeft: b.workingDaysLeft,
            forecastEnd: b.status.forecastEnd,
            days: b.days.map((d) => ({ date: d.date, remaining: v(d.remaining), ideal: v(d.ideal) })),
            changes: b.changes.slice(-30).map((c) => ({ date: c.date, issue: c.issue, kind: c.kind, amount: v(Math.abs(c.amount)) })),
            unestimated: b.unestimated.length ? b.unestimated : undefined,
            warnings: b.warnings.length ? b.warnings : undefined,
          },
          summary: `${b.sprint.name}: ${b.status.words}`,
        };
      }
      case 'flow': {
        const f = await flowReport(ctx, { project: input.project, query: input.query, from: input.from, to: input.to, timeZone: tz });
        const last = f.days.at(-1);
        return {
          data: {
            from: f.scope.from,
            to: f.scope.to,
            states: f.states.map((s) => (s.resolved ? `${s.name} (resolved)` : s.name)),
            days: f.days.map((d) => ({ date: d.date, ...Object.fromEntries(f.states.map((s, i) => [s.name, d.counts[i]])) })),
            includesDeleted: f.scope.includesDeleted,
          },
          summary: last ? `On ${last.date}: ${f.states.map((s, i) => `${last.counts[i]} ${s.name}`).join(', ')}` : 'No days to show',
        };
      }
      case 'cycle_time': {
        const c = await cycleTimeReport(ctx, { project: input.project, query: input.query, from: input.from, to: input.to, start: input.start_states, timeZone: tz });
        return {
          data: {
            from: c.scope.from,
            to: c.scope.to,
            startStates: c.startStates,
            resolved: c.count,
            percentilesInDays: c.percentiles,
            meanDays: c.mean,
            slowest: [...c.issues].sort((a, b) => b.days - a.days).slice(0, 10).map((i) => ({ issue: i.issue, days: i.days, reopened: i.reopened || undefined })),
            notStarted: c.notStarted.length ? c.notStarted.map((i) => i.issue) : undefined,
          },
          summary: c.count ? `${c.count} issues: half took ${c.percentiles.p50} days or less, 85% took ${c.percentiles.p85} days or less` : 'No started issue was resolved in the window',
        };
      }
      case 'created_resolved': {
        const r = await createdResolvedReport(ctx, { project: input.project, query: input.query, from: input.from, to: input.to, interval: input.interval, timeZone: tz });
        return {
          data: { from: r.scope.from, to: r.scope.to, interval: r.interval, totals: r.totals, buckets: r.buckets },
          summary: `${r.totals.created} created, ${r.totals.resolved} resolved, ${r.buckets.at(-1)?.open ?? 0} open at the end`,
        };
      }
      case 'time': {
        const t = await timeReport(ctx, { project: input.project, query: input.query, from: input.from, to: input.to, author: input.author });
        return {
          data: {
            from: t.from,
            to: t.to,
            totalHours: hours(t.totalMinutes),
            byPerson: t.byPerson.map((p) => ({ who: p.user?.login ?? p.label, hours: hours(p.minutes) })),
            byProject: t.byProject.map((p) => ({ project: p.label, hours: hours(p.minutes) })),
            byWeek: t.byWeek.map((w) => ({ week: w.key, hours: hours(w.minutes) })),
            overEstimate: t.byIssue.filter((i) => (i.overMinutes ?? 0) > 0).slice(0, 15).map((i) => ({ issue: i.issue, estimate: formatPeriod(i.estimateMinutes ?? 0), spent: formatPeriod(i.spentMinutes) })),
            topIssues: t.byIssue.slice(0, 15).map((i) => ({ issue: i.issue, hours: hours(i.minutes), estimate: i.estimateMinutes === null ? null : formatPeriod(i.estimateMinutes) })),
          },
          summary: `${formatPeriod(t.totalMinutes)} logged from ${t.from} to ${t.to}`,
        };
      }
    }
  },
});

export const reportTools: ToolDef[] = [getReportTool] as unknown as ToolDef[];
