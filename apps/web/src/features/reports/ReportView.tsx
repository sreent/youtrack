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
import { t } from '../../i18n';

export const REPORTS: { kind: ReportKind; label: string; about: string }[] = [
  { kind: 'burndown', label: t('reports.reportView.burndown'), about: t('reports.reportView.aSprintSWorkLeft') },
  { kind: 'flow', label: t('reports.reportView.cumulativeFlow'), about: t('reports.reportView.howManyIssuesWereIn') },
  { kind: 'created-resolved', label: t('reports.reportView.createdAndResolved'), about: t('reports.reportView.issuesComingInAgainstIssues') },
  { kind: 'cycle-time', label: t('reports.reportView.cycleTime'), about: t('reports.reportView.howLongIssuesTakeFrom') },
  { kind: 'time', label: t('reports.reportView.time'), about: t('reports.reportView.workLoggedByPersonIssue') },
  { kind: 'issues-per-field', label: t('reports.reportView.issuesPerField'), about: t('reports.reportView.howManyIssuesAQuery') },
  { kind: 'matrix', label: t('reports.reportView.matrix'), about: t('reports.reportView.twoFieldsAgainstEachOther') },
  { kind: 'average-age', label: t('reports.reportView.averageAge'), about: t('reports.reportView.howLongTheOpenIssues') },
  { kind: 'time-in-state', label: t('reports.reportView.timeInState'), about: t('reports.reportView.howLongResolvedIssuesSpent') },
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
  if (q.isLoading) return <Loading what={t('reports.reportView.theReport')} />;
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
