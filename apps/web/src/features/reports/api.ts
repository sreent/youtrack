/**
 * Reports and dashboards over the API. Report keys start with 'reports', which the live-events
 * handler invalidates whenever anything changes, so a chart is read again as its issues move.
 */
import type { AverageAge, Burndown, CreatedResolved, CycleTime, Dashboard, Flow, IssuesPerField, Matrix, ReportKind, TimeInState, TimeReport, Widget } from '@a4a/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, get, qs } from '../../api/client';

/** The reader's own time zone: a report's days begin and end where they are. */
export function readerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export type ReportOf<K extends ReportKind> = K extends 'burndown'
  ? Burndown
  : K extends 'flow'
    ? Flow
    : K extends 'created-resolved'
      ? CreatedResolved
      : K extends 'cycle-time'
        ? CycleTime
        : K extends 'issues-per-field'
          ? IssuesPerField
          : K extends 'matrix'
            ? Matrix
            : K extends 'average-age'
              ? AverageAge
              : K extends 'time-in-state'
                ? TimeInState
                : TimeReport;

export type ReportParams = Record<string, string | number | undefined>;

export const reportKeys = {
  all: ['reports'] as const,
  one: (kind: ReportKind, params: ReportParams) => ['reports', kind, JSON.stringify(params)] as const,
  dashboards: ['reports', 'dashboards'] as const,
  dashboard: (id: string) => ['reports', 'dashboards', id] as const,
  defaultDashboard: ['reports', 'dashboards', 'default'] as const,
};

/** The query string a report takes: its parameters, and the reader's time zone (time reports go by dates alone). */
export function reportQuery(kind: ReportKind, params: ReportParams): string {
  return qs({ ...params, ...(kind === 'time' ? {} : { timeZone: readerTimeZone() }) });
}

export function csvHref(kind: ReportKind, params: ReportParams, extra: ReportParams = {}): string {
  return `/api/v1/reports/${kind}.csv${reportQuery(kind, { ...params, ...extra })}`;
}

export function useReport<K extends ReportKind>(kind: K, params: ReportParams, enabled = true) {
  return useQuery({
    queryKey: reportKeys.one(kind, params),
    queryFn: () => get<ReportOf<K>>(`/reports/${kind}${reportQuery(kind, params)}`),
    placeholderData: keepPreviousData,
    enabled,
    retry: false,
  });
}

export const useDashboards = () => useQuery({ queryKey: reportKeys.dashboards, queryFn: () => get<Dashboard[]>('/dashboards') });
export const useDefaultDashboard = (enabled: boolean) =>
  useQuery({ queryKey: reportKeys.defaultDashboard, queryFn: () => get<Dashboard>('/dashboards/default'), enabled });

export function saveDashboard(id: string, body: { name?: string; shared?: boolean; widgets?: Widget[]; expectedVersion?: number }) {
  return api<Dashboard>('PATCH', `/dashboards/${id}`, body);
}

export function createDashboard(body: { name: string; shared?: boolean; widgets?: Widget[] }) {
  return api<Dashboard>('POST', '/dashboards', body);
}
