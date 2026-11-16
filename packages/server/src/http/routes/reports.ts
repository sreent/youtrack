import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  BurndownQuery,
  BurndownSchema,
  CreatedResolvedQuery,
  CreatedResolvedSchema,
  CycleTimeQuery,
  CycleTimeSchema,
  FlowQuery,
  FlowSchema,
  TimeCsvQuery,
  TimeReportQuery,
  TimeReportSchema,
} from '@a4a/shared';
import { formatPeriod } from '@a4a/shared';
import { csvResponse, toCsv } from '../../reports/csv';
import { burndownReport, createdResolvedReport, cycleTimeReport, flowReport, timeEntries, timeReport } from '../../services/reports';
import type { HttpEnv } from '../env';
import { route } from '../route';

const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;
const scopeName = (q: { project?: string }) => (q.project ? q.project.toUpperCase() : 'all');

export function reportRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Reports'];
  const csv = 'The same figures as CSV (RFC 4180, UTF-8 with a byte order mark), for a spreadsheet.';

  route(
    app,
    {
      method: 'get',
      path: '/reports/burndown',
      tags,
      summary: "A sprint's burndown: what was committed, what's left each working day, the ideal, and scope changes",
      description:
        'From the activity log: who joined and left the sprint, states and estimates. Pass a sprint id, or a board for its current sprint. `status.words` says how it stands ("Behind: 26h left, where the ideal for today is 12h …").',
      query: BurndownQuery,
      response: BurndownSchema,
    },
    ({ ctx, query }) => burndownReport(ctx, query),
  );
  route(app, { method: 'get', path: '/reports/burndown.csv', tags, summary: "A sprint's burndown, day by day, as CSV", description: csv, query: BurndownQuery }, async ({ ctx, query }) => {
    const b = await burndownReport(ctx, query);
    const unit = b.by === 'count' ? 'issues' : 'hours';
    const v = (n: number | null) => (n === null ? null : b.by === 'count' ? n : hours(n));
    return csvResponse(
      toCsv(
        ['Date', `Remaining (${unit})`, `Ideal (${unit})`, `Completed (${unit})`, `Added (${unit})`, `Removed (${unit})`, `Reopened (${unit})`, 'Spent (hours)'],
        b.days.map((d) => [d.date, v(d.remaining), v(d.ideal), v(d.completed), v(d.added), v(d.removed), v(d.reopened), hours(d.spentMinutes)]),
      ),
      `burndown-${b.sprint.name}.csv`,
    );
  });

  route(
    app,
    {
      method: 'get',
      path: '/reports/flow',
      tags,
      summary: 'Cumulative flow: issues in each state at the end of each day',
      description: 'A project (with its deleted issues on the days they existed), or a query (issues as they match it now).',
      query: FlowQuery,
      response: FlowSchema,
    },
    ({ ctx, query }) => flowReport(ctx, query),
  );
  route(app, { method: 'get', path: '/reports/flow.csv', tags, summary: 'Cumulative flow as CSV', description: csv, query: FlowQuery }, async ({ ctx, query }) => {
    const f = await flowReport(ctx, query);
    return csvResponse(
      toCsv(['Date', ...f.states.map((s) => s.name), 'Total'], f.days.map((d) => [d.date, ...d.counts, d.total])),
      `flow-${scopeName(query)}-${f.scope.from}-${f.scope.to}.csv`,
    );
  });

  route(
    app,
    {
      method: 'get',
      path: '/reports/created-resolved',
      tags,
      summary: 'Issues created against issues resolved, by day, week or month, with how many were open',
      query: CreatedResolvedQuery,
      response: CreatedResolvedSchema,
    },
    ({ ctx, query }) => createdResolvedReport(ctx, query),
  );
  route(app, { method: 'get', path: '/reports/created-resolved.csv', tags, summary: 'Created against resolved as CSV', description: csv, query: CreatedResolvedQuery }, async ({ ctx, query }) => {
    const r = await createdResolvedReport(ctx, query);
    return csvResponse(
      toCsv(['From', 'To', 'Created', 'Resolved', 'Reopened', 'Open at the end'], r.buckets.map((b) => [b.from, b.to, b.created, b.resolved, b.reopened, b.open])),
      `created-resolved-${scopeName(query)}-${r.scope.from}-${r.scope.to}.csv`,
    );
  });

  route(
    app,
    {
      method: 'get',
      path: '/reports/cycle-time',
      tags,
      summary: 'Cycle time: from first In Progress to resolved, as a distribution with its percentiles',
      description: 'Issues resolved in the window, and still resolved at its end. Issues resolved without being started are listed apart, and left out of the figures.',
      query: CycleTimeQuery,
      response: CycleTimeSchema,
    },
    ({ ctx, query }) => cycleTimeReport(ctx, query),
  );
  route(app, { method: 'get', path: '/reports/cycle-time.csv', tags, summary: 'Each issue\'s cycle time as CSV', description: csv, query: CycleTimeQuery }, async ({ ctx, query }) => {
    const c = await cycleTimeReport(ctx, query);
    return csvResponse(
      toCsv(
        ['Issue', 'Summary', 'Started', 'Resolved', 'Days', 'Reopened'],
        c.issues.map((i) => [i.issue, i.summary, i.started, i.resolved, i.days, i.reopened ? 'yes' : 'no']),
        new Set([1]),
      ),
      `cycle-time-${scopeName(query)}-${c.scope.from}-${c.scope.to}.csv`,
    );
  });

  route(
    app,
    {
      method: 'get',
      path: '/reports/time',
      tags,
      summary: 'Work logged by person, issue, project and week, with totals, and each issue\'s estimate against what was spent',
      query: TimeReportQuery,
      response: TimeReportSchema,
    },
    ({ ctx, query }) => timeReport(ctx, query),
  );
  route(
    app,
    { method: 'get', path: '/reports/time.csv', tags, summary: 'Logged work as CSV: each entry, or the totals by person, issue, project or week', description: csv, query: TimeCsvQuery },
    async ({ ctx, query }) => {
      const name = `time-${scopeName(query)}`;
      if (query.rows === 'entries') {
        const e = await timeEntries(ctx, query);
        return csvResponse(
          toCsv(
            ['Date', 'Person', 'Login', 'Project', 'Issue', 'Summary', 'Minutes', 'Hours', 'Duration', 'Note'],
            e.rows.map((r) => [r.date, r.name ?? '', r.login ?? '', r.project, r.issue, r.summary, r.minutes, hours(r.minutes), formatPeriod(r.minutes), r.description]),
            new Set([1, 5, 9]),
          ),
          `${name}-${e.from}-${e.to}.csv`,
        );
      }
      const t = await timeReport(ctx, query);
      const file = `${name}-by-${query.rows}-${t.from}-${t.to}.csv`;
      if (query.rows === 'issue') {
        return csvResponse(
          toCsv(
            ['Issue', 'Summary', 'Project', 'Logged in the window (hours)', 'Spent all told (hours)', 'Estimate (hours)', 'Over the estimate (hours)', 'Resolved'],
            t.byIssue.map((i) => [
              i.issue,
              i.summary,
              i.project,
              hours(i.minutes),
              hours(i.spentMinutes),
              i.estimateMinutes === null ? null : hours(i.estimateMinutes),
              i.overMinutes === null ? null : hours(i.overMinutes),
              i.resolved ? 'yes' : 'no',
            ]),
            new Set([1]),
          ),
          file,
        );
      }
      const groups = query.rows === 'person' ? t.byPerson : query.rows === 'project' ? t.byProject : t.byWeek;
      const head = query.rows === 'person' ? 'Person' : query.rows === 'project' ? 'Project' : 'Week';
      return csvResponse(
        toCsv([head, 'Hours', 'Minutes', 'Entries'], [...groups.map((g) => [query.rows === 'week' ? g.key : g.label, hours(g.minutes), g.minutes, g.entries]), ['Total', hours(t.totalMinutes), t.totalMinutes, t.entries]], new Set([0])),
        file,
      );
    },
  );
}
