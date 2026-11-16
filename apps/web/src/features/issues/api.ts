import type { IssueDetail, Tone, UpdateIssueInput } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { ApiError, patch } from '../../api/client';
import { keys, useFields } from '../../api/queries';

/**
 * Change an issue, guarded by the version it was read at: if someone changed it since,
 * the server says so (409) and the page re-reads it rather than overwrite their change.
 */
export function useUpdateIssue(issue: IssueDetail | undefined) {
  const qc = useQueryClient();
  return useCallback(
    async (body: Omit<UpdateIssueInput, 'expectedVersion'>): Promise<IssueDetail> => {
      if (!issue) throw new Error('No issue');
      try {
        const next = await patch<IssueDetail>(`/issues/${issue.id}`, { ...body, expectedVersion: issue.version });
        qc.setQueryData(keys.issue(issue.id), next);
        void qc.invalidateQueries({ queryKey: ['issues', 'one', issue.id] });
        void qc.invalidateQueries({ queryKey: ['issues', 'list'] });
        return next;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) void qc.invalidateQueries({ queryKey: keys.issue(issue.id) });
        throw e;
      }
    },
    [issue, qc],
  );
}

/** "Someone else changed BACK-12 …" or the server's words, for a line beside the control. */
export function errorText(e: unknown, fallback = 'That didn’t work.'): string {
  if (e instanceof ApiError) {
    if (e.status === 409) return 'Someone changed this issue just now. It’s been reloaded: check it and try again.';
    return e.hint ? `${e.message}. ${e.hint}` : e.message;
  }
  return fallback;
}

/** Each state's tone, by name, for issues we only know by reference (links, history). */
export function useStateTones(): Map<string, Tone> {
  const fields = useFields();
  return useMemo(() => {
    const m = new Map<string, Tone>();
    for (const f of fields.data ?? []) if (f.type === 'state') for (const v of f.values) if (v.tone) m.set(v.name, v.tone);
    return m;
  }, [fields.data]);
}
