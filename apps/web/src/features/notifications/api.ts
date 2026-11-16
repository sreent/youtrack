/** The inbox, watching and email settings: queries, and the changes to them. */
import type { HelpdeskRequest, IssueDetail, NotificationList, NotificationSettings, Subscription, SubscriptionEvents, Watchers } from '@a4a/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, del, get, patch, post, put, qs, subscribeInbox } from '../../api/client';

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

// ---------------------------------------------------------------------------
// Subscriptions (D31): to a project, or to a saved search
// ---------------------------------------------------------------------------

export const subscriptionKeys = { all: ['subscriptions'] as const };

export const useSubscriptions = () => useQuery({ queryKey: subscriptionKeys.all, queryFn: () => get<Subscription[]>('/subscriptions') });

/**
 * Subscribe to a target, change what it tells, or end it (`events: null`). One mutation for all
 * three, as the controls that use it offer them in one place.
 */
export function useSubscribe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { project?: string; savedSearch?: string; events: SubscriptionEvents | null; email?: boolean; id?: string }) => {
      if (input.events === null) {
        if (input.id) await del(`/subscriptions/${input.id}`);
        return null;
      }
      return post<Subscription>('/subscriptions', { project: input.project, savedSearch: input.savedSearch, events: input.events, email: input.email ?? true });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: subscriptionKeys.all }),
  });
}

/** Change one: it reads as changed at once, and goes back if the server refuses. */
export function useUpdateSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; events?: SubscriptionEvents; email?: boolean }) => patch<Subscription>(`/subscriptions/${id}`, body),
    onMutate: async ({ id, ...body }) => {
      await qc.cancelQueries({ queryKey: subscriptionKeys.all });
      const before = qc.getQueryData<Subscription[]>(subscriptionKeys.all);
      if (before) qc.setQueryData<Subscription[]>(subscriptionKeys.all, before.map((s) => (s.id === id ? { ...s, ...body } : s)));
      return { before };
    },
    onError: (_e, _input, context) => {
      if (context?.before) qc.setQueryData(subscriptionKeys.all, context.before);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: subscriptionKeys.all }),
  });
}
