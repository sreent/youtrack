import type { Group, GroupDetail, ProjectGroup } from '@a4a/shared';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../api/client';

/** Groups of people, and the roles projects give them (D27). */
export const groupKeys = {
  all: ['groups'] as const,
  one: (id: string) => ['groups', id] as const,
  project: (key: string) => ['projects', key, 'groups'] as const,
};

export const useGroups = () => useQuery({ queryKey: groupKeys.all, queryFn: () => get<Group[]>('/groups') });

export const useGroup = (id: string) => useQuery({ queryKey: groupKeys.one(id), queryFn: () => get<GroupDetail>(`/groups/${encodeURIComponent(id)}`) });

export const useProjectGroups = (key: string, enabled = true) =>
  useQuery({ queryKey: groupKeys.project(key), queryFn: () => get<ProjectGroup[]>(`/projects/${key}/groups`), enabled: enabled && Boolean(key) });

/** Where a group's people come from, in words. */
export function comesFrom(g: { providerName: string | null }, provider: string | null): string {
  if (!g.providerName) return 'Kept by hand';
  return `${provider ?? 'The identity provider'}, as “${g.providerName}”`;
}
