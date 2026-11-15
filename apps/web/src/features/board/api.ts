/**
 * The board's queries and its one write. Board keys start with 'boards' (src/api/queries.ts),
 * which the live-events handler invalidates whenever an issue changes.
 */
import type { IssueDetail, ProjectField } from '@a4a/shared';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { get, patch } from '../../api/client';
import { keys } from '../../api/queries';
import type { PendingMove } from './model';

export { useBoardView, useBoards } from '../../api/queries';

/** The fields of the board's projects: their values, to show a card where it's going before the server says so. */
export function useProjectFieldLists(projectKeys: string[]): ProjectField[] {
  const results = useQueries({
    queries: projectKeys.map((key) => ({
      queryKey: keys.projectFields(key),
      queryFn: () => get<ProjectField[]>(`/projects/${key}/fields`),
      staleTime: 60_000,
    })),
  });
  return results.flatMap((r) => r.data ?? []);
}

export interface FailedMove {
  move: PendingMove;
  error: unknown;
}

/**
 * Moving cards: each move shows at once (optimistic), is written with the version the board
 * showed (so a card someone else changed meanwhile is a clear conflict, not a lost update),
 * and is taken back, with what went wrong, when the server refuses it.
 */
export function useCardMoves() {
  const qc = useQueryClient();
  const [pending, setPending] = useState<ReadonlyMap<string, PendingMove>>(new Map());
  const [failed, setFailed] = useState<FailedMove | null>(null);

  const forget = useCallback((id: string) => {
    setPending((p) => {
      const next = new Map(p);
      next.delete(id);
      return next;
    });
  }, []);

  const move = useCallback(
    async (m: PendingMove) => {
      setFailed(null);
      setPending((p) => new Map(p).set(m.issue, m));
      // A board read that lands now would show the card where it was.
      await qc.cancelQueries({ queryKey: ['boards'] });
      try {
        await patch<IssueDetail>(`/issues/${m.issue}`, { fields: m.fields, expectedVersion: m.version });
        void qc.invalidateQueries({ queryKey: keys.issue(m.issue) });
        void qc.invalidateQueries({ queryKey: ['issues', 'list'] });
        // Keep showing the move until the board has been read again with it in place.
        await qc.invalidateQueries({ queryKey: ['boards'] });
      } catch (error) {
        setFailed({ move: m, error });
        void qc.invalidateQueries({ queryKey: ['boards'] });
      } finally {
        forget(m.issue);
      }
    },
    [qc, forget],
  );

  return { pending, failed, move, dismiss: () => setFailed(null) };
}
