/**
 * The planning views' reads of a scope (D72): a saved search's issues, or a query's, in one project or
 * several. Every key starts with 'plan', which the live-events handler invalidates whenever anything
 * changes, so a view's plan is read again as soon as an issue, its work or a baseline changes; and a
 * project's scope sits under that project's key, so what refreshes the project's plan refreshes it too.
 */
import type { Baseline, PlanSchedule, PlanScope } from '@a4a/shared';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../api/client';

/** A scope as a key: the same scope is the same key, whichever order its parts came in. */
const scopeKey = (scope: PlanScope) => ('savedSearch' in scope ? `s:${scope.savedSearch}` : `q:${scope.query}`) + (scope.project ? `|${scope.project}` : '');

export const viewKeys = {
  schedule: (scope: PlanScope, baseline: string | null) => ['plan', scope.project ?? '', 'plans', scopeKey(scope), baseline ?? ''] as const,
  searchBaselines: (savedSearch: string) => ['plan', '', 'saved-search', savedSearch, 'baselines'] as const,
};

/**
 * The scope in a GET's query string, as `PlanScopeQuery` reads it: an empty query is sent too, since it
 * means every issue the reader sees.
 */
export function scopeQueryString(scope: PlanScope, extra: Record<string, string | null | undefined> = {}): string {
  const p = new URLSearchParams();
  if ('savedSearch' in scope) p.set('savedSearch', scope.savedSearch);
  else p.set('query', scope.query);
  if (scope.project) p.set('project', scope.project);
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  return `?${p}`;
}

/** Keep showing the scope's last answer while another baseline loads, never another scope's. */
function sameScope(scope: PlanScope) {
  const key = scopeKey(scope);
  return (previous: PlanSchedule | undefined, query?: { queryKey: readonly unknown[] }) => (query?.queryKey[3] === key ? previous : undefined);
}

/** The plan of a scope, as GET /plans/schedule answers it, compared with a baseline when one is given. */
export function usePlanSchedule(scope: PlanScope, baseline: string | null, enabled = true) {
  return useQuery({
    queryKey: viewKeys.schedule(scope, baseline),
    queryFn: () => get<PlanSchedule>(`/plans/schedule${scopeQueryString(scope, { baseline })}`),
    placeholderData: sameScope(scope),
    enabled,
    retry: false,
  });
}

/** A saved search's baselines (D72), as its reader may read them. */
export function useSearchBaselines(savedSearch: string | null) {
  return useQuery({
    queryKey: viewKeys.searchBaselines(savedSearch ?? ''),
    queryFn: () => get<Baseline[]>(`/saved-searches/${encodeURIComponent(savedSearch!)}/baselines`),
    enabled: savedSearch !== null,
    retry: false,
  });
}
