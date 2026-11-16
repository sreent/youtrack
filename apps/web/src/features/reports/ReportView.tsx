/**
 * A report, read and drawn: the one way the Reports page and a dashboard's widgets show one.
 * While it reads again, the last answer stays, so nothing jumps.
 */
import type { AverageAge, Burndown, CreatedResolved, CycleTime, Flow, IssuesPerField, Matrix, ReportKind, ReportWidgetParams, TimeInState, TimeReport } from '@a4a/shared';
import { AverageAgeView, IssuesPerFieldView, MatrixView, TimeInStateView } from './MoreReports';
import { ErrorNote, Loading } from '../../components/States';
import { addDays, localToday } from '../plan/dates';
import { useReport, type ReportParams } from './api';
import { BurndownReport } from './Burndown';
import { CreatedResolvedReport } from './CreatedResolved';
import { CumulativeFlowReport } from './CumulativeFlow';
import { CycleTimeReport } from './Distribution';
import { TimeReportView } from './TimeReport';

export const REPORTS: { kind: ReportKind; label: string; about: string }[] = [
  { kind: 'burndown', label: 'Burndown', about: "A sprint's work left at the end of each working day, against the ideal, and where its scope changed." },
  { kind: 'flow', label: 'Cumulative flow', about: 'How many issues were in each state at the end of each day: where work piles up, and how fast it gets done.' },
  { kind: 'created-resolved', label: 'Created and resolved', about: 'Issues coming in against issues getting done, day by day, week by week or month by month.' },
  { kind: 'cycle-time', label: 'Cycle time', about: 'How long issues take from first In Progress to resolved, as a spread with its percentiles.' },
  { kind: 'time', label: 'Time', about: 'Work logged by person, issue, project and week, and each issue against its estimate.' },
  { kind: 'issues-per-field', label: 'Issues per field', about: "How many issues a query finds have each of a field's values, as they are now. Each count opens its issues." },
  { kind: 'matrix', label: 'Matrix', about: 'Two fields against each other: the issues with each pair of values, with totals. Each cell opens its issues.' },
  { kind: 'average-age', label: 'Average age', about: 'How long the open issues had been open at the end of each day, as things stood then; by a field, if you choose one.' },
  { kind: 'time-in-state', label: 'Time in state', about: "How long resolved issues spent in each state, or a board's columns: the median and the 85th percentile, and who has waited longest." },
];

/** A widget's parameters as a report's: its window of days up to today becomes from and to. */
export function widgetQuery(p: ReportWidgetParams): { kind: ReportKind; params: ReportParams } {
  const today = localToday();
  if (p.report === 'burndown') return { kind: 'burndown', params: { board: p.board, sprint: p.sprint, by: p.by } };
  // Issues as they are now take no window.
  if (p.report === 'issues-per-field') return { kind: p.report, params: { project: p.project, query: p.query, field: p.field, interval: p.interval } };
  if (p.report === 'matrix') return { kind: p.report, params: { project: p.project, query: p.query, rows: p.rows, columns: p.columns, interval: p.interval } };
  const from = addDays(today, -((p.days ?? 30) - 1));
  const base = { project: p.project, query: p.query, from, to: today };
  if (p.report === 'created-resolved') return { kind: p.report, params: { ...base, interval: p.interval } };
  if (p.report === 'cycle-time') return { kind: p.report, params: { ...base, start: p.start } };
  if (p.report === 'time') return { kind: p.report, params: { ...base, author: p.author } };
  if (p.report === 'average-age') return { kind: p.report, params: { ...base, field: p.field } };
  if (p.report === 'time-in-state') return { kind: p.report, params: { ...base, board: p.board } };
  return { kind: 'flow', params: base };
}

export function ReportView({ kind, params, compact }: { kind: ReportKind; params: ReportParams; compact?: boolean }) {
  const q = useReport(kind, params);
  if (q.isLoading) return <Loading what="the report" />;
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return null;
  const body = (() => {
    switch (kind) {
      case 'burndown':
        return <BurndownReport b={q.data as Burndown} compact={compact} />;
      case 'flow':
        return <CumulativeFlowReport flow={q.data as Flow} compact={compact} />;
      case 'created-resolved':
        return <CreatedResolvedReport r={q.data as CreatedResolved} compact={compact} />;
      case 'cycle-time':
        return <CycleTimeReport c={q.data as CycleTime} compact={compact} />;
      case 'time':
        return <TimeReportView t={q.data as TimeReport} compact={compact} />;
      case 'issues-per-field':
        return <IssuesPerFieldView r={q.data as IssuesPerField} compact={compact} />;
      case 'matrix':
        return <MatrixView m={q.data as Matrix} compact={compact} />;
      case 'average-age':
        return <AverageAgeView a={q.data as AverageAge} compact={compact} />;
      case 'time-in-state':
        return <TimeInStateView t={q.data as TimeInState} compact={compact} />;
    }
  })();
  // The last answer stays while it reads again: no flash, no jump.
  return <div aria-busy={q.isFetching || undefined}>{body}</div>;
}
