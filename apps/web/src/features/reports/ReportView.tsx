/**
 * A report, read and drawn: the one way the Reports page and a dashboard's widgets show one.
 * While it reads again, the last answer stays, so nothing jumps.
 */
import type { Burndown, CreatedResolved, CycleTime, Flow, ReportKind, ReportWidgetParams, TimeReport } from '@a4a/shared';
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
];

/** A widget's parameters as a report's: its window of days up to today becomes from and to. */
export function widgetQuery(p: ReportWidgetParams): { kind: ReportKind; params: ReportParams } {
  const today = localToday();
  if (p.report === 'burndown') return { kind: 'burndown', params: { board: p.board, sprint: p.sprint, by: p.by } };
  const from = addDays(today, -((p.days ?? 30) - 1));
  const base = { project: p.project, query: p.query, from, to: today };
  if (p.report === 'created-resolved') return { kind: p.report, params: { ...base, interval: p.interval } };
  if (p.report === 'cycle-time') return { kind: p.report, params: { ...base, start: p.start } };
  if (p.report === 'time') return { kind: p.report, params: { ...base, author: p.author } };
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
    }
  })();
  // The last answer stays while it reads again: no flash, no jump.
  return <div aria-busy={q.isFetching || undefined}>{body}</div>;
}
