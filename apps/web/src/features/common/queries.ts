/** Hooks for the management pages, beside src/api/queries.ts (whose keys they extend). */
import type { Baseline, IssueList, Suggestion, TrackerEvent } from '@a4a/shared';
import { useQuery } from '@tanstack/react-query';
import { get, qs } from '../../api/client';

/** A tool agents get, over MCP and in the assistant (GET /ai/tools). */
export interface AITool {
  name: string;
  title: string;
  description: string;
  kind: 'reads' | 'changes';
  destructive: boolean;
}

/** One attempt to deliver an event to a webhook (WebhookDeliverySchema). */
export interface WebhookDelivery {
  id: string;
  eventId: number | null;
  eventType: string;
  statusCode: number | null;
  success: boolean;
  attempt: number;
  durationMs: number;
  error: string | null;
  createdAt: string;
}

export const pageKeys = {
  tools: ['ai', 'tools'] as const,
  /** Everything waiting on a person; apply and dismiss invalidate ['ai', 'suggestions']. */
  pendingSuggestions: (project: string) => ['ai', 'suggestions', project] as const,
  baselines: (key: string) => ['projects', key, 'baselines'] as const,
  deliveries: (id: string) => ['webhooks', id, 'deliveries'] as const,
  /** Under ['events'], so the live feed refreshes it. */
  feed: (project: string, limit: number) => ['events', 'feed', project, limit] as const,
};

export const useAITools = () =>
  useQuery({
    queryKey: pageKeys.tools,
    queryFn: () => get<AITool[]>('/ai/tools'),
    staleTime: 10 * 60_000,
  });

/** Tools by name, for the grammar of each step. */
export function useToolMap(): Map<string, AITool> {
  const tools = useAITools();
  const map = new Map<string, AITool>();
  for (const t of tools.data ?? []) map.set(t.name, t);
  return map;
}

export const usePendingSuggestions = (project: string) =>
  useQuery({
    queryKey: pageKeys.pendingSuggestions(project),
    queryFn: () => get<Suggestion[]>(`/ai/suggestions${qs({ project, limit: 200 })}`),
  });

export const useBaselines = (key: string | undefined) =>
  useQuery({
    queryKey: pageKeys.baselines(key ?? ''),
    queryFn: () => get<Baseline[]>(`/projects/${key}/baselines`),
    enabled: Boolean(key),
    retry: false,
  });

export const useDeliveries = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: pageKeys.deliveries(id),
    queryFn: () => get<WebhookDelivery[]>(`/webhooks/${id}/deliveries`),
    enabled,
  });

/** The summaries of a few issues, by id, in one search ("issue id: BACK-1, WEB-2"). */
export const useIssueSummaries = (ids: string[]) => {
  const sorted = [...new Set(ids)].sort();
  return useQuery({
    queryKey: ['issues', 'list', 'by-id', sorted.join(',')] as const,
    queryFn: async () => {
      const res = await get<IssueList>(`/issues${qs({ query: `issue id: ${sorted.join(', ')}`, limit: Math.min(200, sorted.length) })}`);
      return new Map(res.items.map((i) => [i.id, i]));
    },
    enabled: sorted.length > 0,
    staleTime: 30_000,
  });
};

export const useFeed = (project: string, limit: number) =>
  useQuery({
    queryKey: pageKeys.feed(project, limit),
    queryFn: () => get<TrackerEvent[]>(`/events${qs({ project, limit })}`),
    placeholderData: (previous) => previous,
  });
