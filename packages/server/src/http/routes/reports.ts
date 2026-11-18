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
import {
  AverageAgeQuery,
  AverageAgeSchema,
  formatPeriod,
  IssuesPerFieldQuery,
  IssuesPerFieldSchema,
  MatrixQuery,
  MatrixSchema,
  TimeInStateQuery,
  TimeInStateSchema,
} from '@a4a/shared';
import { csvResponse, toCsv } from '../../reports/csv';
import { averageAgeReport, issuesPerFieldReport, matrixReport, timeInStateReport } from '../../services/more-reports';
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
      path: '/reports/burndown', guests: true,
      tags,
      summary: "A sprint's burndown: what was committed, what's left each working day, the ideal, and scope changes",
      description:
        'From the activity log: who joined and left the sprint, states and estimates. Pass a sprint id, or a board for its current sprint. `status.words` says how it stands ("Behind: 26h left, where the ideal for today is 12h …").',
      query: BurndownQuery,
      response: BurndownSchema,
    },
    ({ ctx, query }) => burndownReport(ctx, query),
  );
  route(app, { method: 'get', path: '/reports/burndown.csv', guests: true, tags, summary: "A sprint's burndown, day by day, as CSV", description: csv, query: BurndownQuery }, async ({ ctx, query }) => {
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
      path: '/reports/flow', guests: true,
      tags,
      summary: 'Cumulative flow: issues in each state at the end of each day',
      description: 'A project (with its deleted issues on the days they existed), or a query (issues as they match it now).',
      query: FlowQuery,
      response: FlowSchema,
    },
    ({ ctx, query }) => flowReport(ctx, query),
  );
  route(app, { method: 'get', path: '/reports/flow.csv', guests: true, tags, summary: 'Cumulative flow as CSV', description: csv, query: FlowQuery }, async ({ ctx, query }) => {
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
      path: '/reports/created-resolved', guests: true,
      tags,
      summary: 'Issues created against issues resolved, by day, week or month, with how many were open',
      query: CreatedResolvedQuery,
      response: CreatedResolvedSchema,
    },
    ({ ctx, query }) => createdResolvedReport(ctx, query),
  );
  route(app, { method: 'get', path: '/reports/created-resolved.csv', guests: true, tags, summary: 'Created against resolved as CSV', description: csv, query: CreatedResolvedQuery }, async ({ ctx, query }) => {
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
      path: '/reports/cycle-time', guests: true,
      tags,
      summary: 'Cycle time: from first In Progress to resolved, as a distribution with its percentiles',
      description: 'Issues resolved in the window, and still resolved at its end. Issues resolved without being started are listed apart, and left out of the figures.',
      query: CycleTimeQuery,
      response: CycleTimeSchema,
    },
    ({ ctx, query }) => cycleTimeReport(ctx, query),
  );
  route(app, { method: 'get', path: '/reports/cycle-time.csv', guests: true, tags, summary: 'Each issue\'s cycle time as CSV', description: csv, query: CycleTimeQuery }, async ({ ctx, query }) => {
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

  // More reports (D44) ------------------------------------------------------

  const now = 'The issues a query finds as they are now (a project\'s, or all you can see, without one).';
  route(
    app,
    {
      method: 'get',
      path: '/reports/issues-per-field', guests: true,
      tags,
      summary: "Issues per field: how many have each of a field's values",
      description: `${now} Any field, of any type, or Project; dates by day, week or month. Each value carries the query that finds its issues; a multi-valued field counts an issue under each of its values.`,
      query: IssuesPerFieldQuery,
      response: IssuesPerFieldSchema,
    },
    ({ ctx, query }) => issuesPerFieldReport(ctx, query),
  );
  route(app, { method: 'get', path: '/reports/issues-per-field.csv', guests: true, tags, summary: 'Issues per field as CSV', description: csv, query: IssuesPerFieldQuery }, async ({ ctx, query }) => {
    const r = await issuesPerFieldReport(ctx, query);
    return csvResponse(toCsv([r.field.name, 'Issues'], [...r.values.map((v) => [v.label, v.count]), ['Total issues', r.total]], new Set([0])), `issues-per-${r.field.name}-${scopeName(query)}.csv`);
  });

  route(
    app,
    {
      method: 'get',
      path: '/reports/matrix', guests: true,
      tags,
      summary: 'Matrix: two fields against each other, with the issues in each pair of values',
      description: `${now} Rows and columns are any two fields (or Project); each cell, row and column carries the query that finds its issues, with totals.`,
      query: MatrixQuery,
      response: MatrixSchema,
    },
    ({ ctx, query }) => matrixReport(ctx, query),
  );
  route(app, { method: 'get', path: '/reports/matrix.csv', guests: true, tags, summary: 'Matrix as CSV', description: csv, query: MatrixQuery }, async ({ ctx, query }) => {
    const m = await matrixReport(ctx, query);
    return csvResponse(
      toCsv(
        [`${m.rows.field.name} \\ ${m.columns.field.name}`, ...m.columns.values.map((c) => c.label), 'Total'],
        [...m.rows.values.map((r, i) => [r.label, ...m.cells[i]!.map((c) => c.count), r.count]), ['Total', ...m.columns.values.map((c) => c.count), m.total]],
        new Set([0]),
      ),
      `matrix-${m.rows.field.name}-${m.columns.field.name}-${scopeName(query)}.csv`,
    );
  });

  route(
    app,
    {
      method: 'get',
      path: '/reports/average-age', guests: true,
      tags,
      summary: 'Average age: how long open issues had been open, each day as it stood',
      description:
        'From the activity log: each day, the issues unresolved at its end and their average and median age (days since each was created). With a field, also by its value as it stood that day. A moved issue counts in the project it was in.',
      query: AverageAgeQuery,
      response: AverageAgeSchema,
    },
    ({ ctx, query }) => averageAgeReport(ctx, query),
  );
  route(app, { method: 'get', path: '/reports/average-age.csv', guests: true, tags, summary: 'Average age, day by day, as CSV', description: csv, query: AverageAgeQuery }, async ({ ctx, query }) => {
    const a = await averageAgeReport(ctx, query);
    return csvResponse(
      toCsv(
        ['Date', 'Open', 'Average age (days)', 'Median age (days)', ...a.values.map((v) => `${v.label} (days)`)],
        a.days.map((d, i) => [d.date, d.open, d.averageDays, d.medianDays, ...a.values.map((v) => v.days[i] ?? null)]),
      ),
      `average-age-${scopeName(query)}-${a.scope.from}-${a.scope.to}.csv`,
    );
  });

  route(
    app,
    {
      method: 'get',
      path: '/reports/time-in-state', guests: true,
      tags,
      summary: 'Time in state: how long issues spend in each state, or in each of a board\'s columns',
      description:
        "From the activity log: for issues resolved in the window, the days each spent in each state until then, and per state the median and 85th percentile; and how long each open issue has been where it is. With a board, its columns over its projects and query.",
      query: TimeInStateQuery,
      response: TimeInStateSchema,
    },
    ({ ctx, query }) => timeInStateReport(ctx, query),
  );
  route(app, { method: 'get', path: '/reports/time-in-state.csv', guests: true, tags, summary: 'Time in state, issue by issue, as CSV', description: csv, query: TimeInStateQuery }, async ({ ctx, query }) => {
    const t = await timeInStateReport(ctx, query);
    return csvResponse(
      toCsv(
        ['Issue', 'Summary', 'Resolved', ...t.states.map((s) => `${s.name} (days)`), 'Total (days)'],
        t.issues.map((i) => [i.issue, i.summary, i.resolved, ...i.days, i.totalDays]),
        new Set([1]),
      ),
      `time-in-${t.by}-${t.board ? t.board.name : scopeName(query)}-${t.scope.from}-${t.scope.to}.csv`,
    );
  });
}
