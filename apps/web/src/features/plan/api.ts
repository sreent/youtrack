/**
 * The plan's queries and writes. Every key starts with 'plan', which the live-events handler
 * invalidates whenever anything changes, so a schedule, a load or a cost report is read again
 * as soon as an issue, its work or a baseline changes.
 */
import type { Baseline, CostReport, LevelingMode, LevelingResult, ResourceLoad, Schedule, WhatIfResult } from '@a4a/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { get, post, qs } from '../../api/client';

export interface WhatIfChange {
  issue: string;
  delayDays?: number;
  estimate?: string;
  assignee?: string | null;
}

export const planKeys = {
  project: (key: string) => ['plan', key] as const,
  schedule: (key: string, baseline: string | null) => ['plan', key, 'schedule', baseline ?? ''] as const,
  baselines: (key: string) => ['plan', key, 'baselines'] as const,
  resources: (key: string) => ['plan', key, 'resources'] as const,
  costs: (key: string, baseline: string | null) => ['plan', key, 'costs', baseline ?? ''] as const,
  whatIf: (key: string, baseline: string | null, change: WhatIfChange) => ['plan', key, 'what-if', baseline ?? '', JSON.stringify(change)] as const,
};

/** Keep showing the project's last answer while another baseline loads, never another project's. */
function sameProject<T>(key: string) {
  return (previous: T | undefined, query?: { queryKey: readonly unknown[] }) => (query?.queryKey[1] === key ? previous : undefined);
}

export function useBaselines(key: string) {
  return useQuery({ queryKey: planKeys.baselines(key), queryFn: () => get<Baseline[]>(`/projects/${key}/baselines`) });
}

export function useSchedule(key: string, baseline: string | null, enabled = true) {
  return useQuery({
    queryKey: planKeys.schedule(key, baseline),
    queryFn: () => get<Schedule>(`/projects/${key}/schedule${qs({ baseline: baseline ?? undefined })}`),
    placeholderData: sameProject<Schedule>(key),
    enabled,
    retry: false,
  });
}

export function useResourceLoad(key: string) {
  return useQuery({ queryKey: planKeys.resources(key), queryFn: () => get<ResourceLoad>(`/projects/${key}/resources`), retry: false });
}

export function useCosts(key: string, baseline: string | null, enabled = true) {
  return useQuery({
    queryKey: planKeys.costs(key, baseline),
    queryFn: () => get<CostReport>(`/projects/${key}/costs${qs({ baseline: baseline ?? undefined })}`),
    placeholderData: sameProject<CostReport>(key),
    enabled,
    retry: false,
  });
}

/** What the plan would do if one task changed. Nothing is saved; it's read again as the plan changes. */
export function useWhatIf(key: string, baseline: string | null, change: WhatIfChange | null) {
  return useQuery({
    queryKey: planKeys.whatIf(key, baseline, change ?? { issue: '' }),
    queryFn: () => post<WhatIfResult>(`/projects/${key}/schedule/what-if`, { baseline: baseline ?? undefined, overrides: [change!] }),
    enabled: change !== null,
    retry: false,
  });
}

/** A levelling proposal (dry run): what it would move, and the starts applying it would write. */
export function proposeLevelling(key: string, mode: LevelingMode): Promise<LevelingResult> {
  return post<LevelingResult>(`/projects/${key}/level`, { mode, dryRun: true });
}

/** Apply exactly what was proposed: the server refuses with 409 if levelling would now write anything else. */
export function applyLevelling(key: string, mode: LevelingMode, expect: Record<string, string>): Promise<LevelingResult> {
  return post<LevelingResult>(`/projects/${key}/level`, { mode, dryRun: false, expect });
}

export function useSaveBaseline(key: string) {
  const qc = useQueryClient();
  return useCallback(
    async (input: { name: string; note: string }) => {
      const b = await post<Baseline>(`/projects/${key}/baselines`, input);
      await qc.invalidateQueries({ queryKey: planKeys.baselines(key) });
      return b;
    },
    [key, qc],
  );
}

export function useInvalidatePlan(key: string) {
  const qc = useQueryClient();
  return useCallback(() => qc.invalidateQueries({ queryKey: planKeys.project(key) }), [key, qc]);
}
