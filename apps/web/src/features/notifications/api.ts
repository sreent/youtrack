/** The inbox, watching and email settings: queries, and the changes to them. */
import type { HelpdeskRequest, IssueDetail, NotificationList, NotificationSettings, Watchers } from '@a4a/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, get, patch, post, put, qs, subscribeInbox } from '../../api/client';

export const inboxKeys = {
  all: ['notifications'] as const,
  count: ['notifications', 'count'] as const,
  list: (unread: boolean) => ['notifications', 'list', unread] as const,
  settings: ['notifications', 'settings'] as const,
  watchers: (issue: string) => ['issues', 'one', issue, 'watchers'] as const,
  request: (issue: string) => ['issues', 'one', issue, 'request'] as const,
};

export const useUnreadCount = () =>
  useQuery({ queryKey: inboxKeys.count, queryFn: async () => (await get<{ unread: number }>('/notifications/count')).unread, staleTime: 30_000 });

export const useNotifications = (unread: boolean) =>
  useQuery({ queryKey: inboxKeys.list(unread), queryFn: () => get<NotificationList>(`/notifications${qs({ unread: unread || undefined, limit: 100 })}`) });

export const useNotificationSettings = () => useQuery({ queryKey: inboxKeys.settings, queryFn: () => get<NotificationSettings>('/me/notification-settings') });

export const useWatchers = (issue: string) => useQuery({ queryKey: inboxKeys.watchers(issue), queryFn: () => get<Watchers>(`/issues/${issue}/watchers`) });

/** The help desk files each request as its own agent, `helpdesk`: only those issues have a requester to ask about. */
export function fromHelpdesk(issue: Pick<IssueDetail, 'reporter'> | undefined): boolean {
  return Boolean(issue?.reporter?.isBot && issue.reporter.login === 'helpdesk');
}

/** A help desk request's requester and first-response target; null for an issue that didn't come in that way. */
export const useRequestInfo = (issue: Pick<IssueDetail, 'id' | 'reporter'> | undefined) =>
  useQuery({
    queryKey: inboxKeys.request(issue?.id ?? ''),
    enabled: fromHelpdesk(issue),
    retry: false,
    queryFn: async () => {
      try {
        return await get<HelpdeskRequest>(`/issues/${issue!.id}/request`);
      } catch (e) {
        if ((e as { status?: number }).status === 404) return null;
        throw e;
      }
    },
  });

/** Keep the sidebar's count and the inbox live: the stream says when either changed. */
export function useInboxLive() {
  const qc = useQueryClient();
  useEffect(
    () =>
      subscribeInbox((unread) => {
        qc.setQueryData(inboxKeys.count, unread);
        void qc.invalidateQueries({ queryKey: ['notifications', 'list'] });
      }),
    [qc],
  );
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { ids?: string[]; issue?: string; all?: boolean; until?: string; read?: boolean }) =>
      post<{ changed: number; unread: number }>('/notifications/read', body),
    onSuccess: (r) => {
      qc.setQueryData(inboxKeys.count, r.unread);
      void qc.invalidateQueries({ queryKey: inboxKeys.all });
    },
  });
}

export function useWatch(issue: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (watch: boolean) => (watch ? put<Watchers>(`/issues/${issue}/watchers/me`, {}) : api<Watchers>('DELETE', `/issues/${issue}/watchers/me`)),
    onSuccess: (w) => qc.setQueryData(inboxKeys.watchers(issue), w),
  });
}

export function useSaveNotificationSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Pick<NotificationSettings, 'email' | 'digest'>>) => patch<NotificationSettings>('/me/notification-settings', body),
    onSuccess: (s) => qc.setQueryData(inboxKeys.settings, s),
  });
}
