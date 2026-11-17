/**
 * Reports for agents: one tool, `get_report`, for "are we on track?" (a sprint's burndown), how
 * work flows (cumulative flow), how long it takes (cycle time) and where time went (logged work).
 * Answers are compact: the figures an agent reasons with, and a sentence it can repeat.
 */
import { formatPeriod } from '@a4a/shared';
import { z } from 'zod';
import { badRequest } from '../lib/errors';
import { averageAgeReport, issuesPerFieldReport, matrixReport, timeInStateReport } from '../services/more-reports';
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
    '- issues_per_field: how many issues (as they are now) have each value of field (any field, or Project), each with the query that finds them.',
    '- matrix: field against by_field, issues in each pair of values, with totals.',
    '- average_age: each day, the open issues and how old they were on average; with field, by its value as it stood.',
    '- time_in_state: for issues resolved in the window, the median and 85th percentile of days spent in each state (or a board\'s columns, with board); and who has waited longest where.',
    'Windows default to the last 30 days (90 for cycle time and time in state, 28 for time); dates are YYYY-MM-DD.',
  ].join('\n'),
  input: z.object({
    report: z.enum(['burndown', 'flow', 'cycle_time', 'created_resolved', 'time', 'issues_per_field', 'matrix', 'average_age', 'time_in_state']),
    field: z.string().optional().describe('issues_per_field, matrix (rows), average_age: a field by name, or Project'),
    by_field: z.string().optional().describe('matrix: the field across the columns'),
    board: z.string().optional().describe('burndown: board name or id (its current sprint); time_in_state: its columns'),
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
      case 'issues_per_field': {
        const r = await issuesPerFieldReport(ctx, { project: input.project, query: input.query, field: needs(input.field, 'field'), interval: input.interval, timeZone: tz });
        const top = r.values.filter((v) => v.key !== '').slice(0, 3);
        return {
          data: { field: r.field.name, issues: r.total, values: r.values.map((v) => ({ value: v.label, issues: v.count, query: v.query ?? undefined })) },
          summary: `${r.total} issues by ${r.field.name}: ${[...top.map((v) => `${v.count} ${v.label}`), ...(r.noValue ? [`${r.noValue} with none`] : [])].join(', ') || 'none'}`,
        };
      }
      case 'matrix': {
        const m = await matrixReport(ctx, { project: input.project, query: input.query, rows: needs(input.field, 'field'), columns: needs(input.by_field, 'by_field'), interval: input.interval, timeZone: tz });
        return {
          data: {
            rows: m.rows.field.name,
            columns: m.columns.field.name,
            columnValues: m.columns.values.map((c) => c.label),
            table: m.rows.values.map((r, i) => ({ [m.rows.field.name]: r.label, counts: m.cells[i]!.map((c) => c.count), total: r.count })),
            columnTotals: m.columns.values.map((c) => c.count),
            issues: m.total,
          },
          summary: `${m.total} issues by ${m.rows.field.name} (${m.rows.values.length} rows) against ${m.columns.field.name} (${m.columns.values.length} columns)`,
        };
      }
      case 'average_age': {
        const a = await averageAgeReport(ctx, { project: input.project, query: input.query, from: input.from, to: input.to, field: input.field, timeZone: tz });
        const last = a.days.at(-1);
        return {
          data: {
            from: a.scope.from,
            to: a.scope.to,
            days: a.days.map((d) => ({ date: d.date, open: d.open, averageDays: d.averageDays })),
            byValue: a.values.length ? a.values.map((v) => ({ value: v.label, open: v.open, averageDays: v.averageDays, oldestDays: v.oldestDays })) : undefined,
            oldest: a.oldest.map((o) => ({ issue: o.issue, days: o.days })),
          },
          summary: last ? `On ${last.date}: ${last.open} open, ${last.averageDays ?? 0} days old on average (median ${last.medianDays ?? 0})` : 'No days to show',
        };
      }
      case 'time_in_state': {
        const t = await timeInStateReport(ctx, { project: input.project, query: input.query, from: input.from, to: input.to, board: input.board, timeZone: tz });
        const slow = [...t.states].filter((x) => x.p85 !== null && !x.resolved).sort((a, b) => (b.p85 ?? 0) - (a.p85 ?? 0))[0];
        return {
          data: {
            from: t.scope.from,
            to: t.scope.to,
            by: t.by,
            board: t.board?.name,
            resolvedIssues: t.issues.length,
            states: t.states.map((x) => ({ [t.by]: x.name, issues: x.issues, medianDays: x.p50, p85Days: x.p85, openNow: x.now })),
            longestWaiting: t.ongoing.slice(0, 10).map((o) => ({ issue: o.issue, [t.by]: o.state, days: o.daysInState })),
          },
          summary: slow ? `${t.issues.length} issues resolved; the longest stay is in ${slow.name}: half spent ${slow.p50} days or less there, 85% ${slow.p85} or less` : `${t.issues.length} issues resolved in the window`,
        };
      }
    }
  },
});

function needs(v: string | undefined, name: string): string {
  // api only: an MCP tool's, met by agents alone
  if (!v?.trim()) throw badRequest(`This report needs ${name}`, name === 'by_field' ? 'Give by_field: the field across the columns, e.g. State.' : 'Give field: a field\'s name, e.g. Priority, or Project.');
  return v;
}

export const reportTools: ToolDef[] = [getReportTool] as unknown as ToolDef[];
