/**
 * The board's queries and its one write. Board keys start with 'boards' (src/api/queries.ts),
 * which the live-events handler invalidates whenever an issue changes or a card is ranked.
 */
import type { BoardView, ProjectField } from '@a4a/shared';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { get, post } from '../../api/client';
import { keys } from '../../api/queries';
import { rankBody, type Lane, type PendingMove } from './model';

export { useBoardView, useBoards } from '../../api/queries';

/** Stable, so the lists are combined once per change, not on every render. */
const allFields = (results: { data?: ProjectField[] }[]): ProjectField[] => results.flatMap((r) => r.data ?? []);

/** The fields of the board's projects: their values, to show a card where it's going before the server says so. */
export function useProjectFieldLists(projectKeys: string[]): ProjectField[] {
  return useQueries({
    queries: projectKeys.map((key) => ({
      queryKey: keys.projectFields(key),
      queryFn: () => get<ProjectField[]>(`/projects/${key}/fields`),
      staleTime: 60_000,
    })),
    combine: allFields,
  });
}

export interface FailedMove {
  move: PendingMove;
  error: unknown;
}

/**
 * Moving cards (D53): each move shows at once (optimistic) and is one request to the board's rank,
 * its column, lane and place together. It's written with the version the board showed, so a card
 * someone else changed meanwhile is a clear conflict, not a lost update, and it's taken back, with
 * what went wrong, when the server refuses it. Moves go one after another: a card moved again
 * before its last move is saved is sent with the version that move left, and a refused move drops
 * the moves of its card queued behind it, which were made on top of it.
 */
export function useCardMoves(view: BoardView, lanes: Lane[], onSaved: (said: string) => void) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<ReadonlyMap<string, PendingMove & { seq: number }>>(new Map());
  const [failed, setFailed] = useState<FailedMove | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const seq = useRef(0);
  /** Per card, the last move dropped because one before it was refused. */
  const dropped = useRef(new Map<string, number>());
  /** Per card, how many of its moves are on their way. */
  const queued = useRef(new Map<string, number>());
  const latest = useRef({ view, lanes, onSaved });
  latest.current = { view, lanes, onSaved };
  const boardId = view.board.id;

  const forget = useCallback((id: string, mine: number) => {
    setPending((p) => {
      if (p.get(id)?.seq !== mine) return p;
      const next = new Map(p);
      next.delete(id);
      return next;
    });
  }, []);

  /** The card's version as the last read of the board says it: for a move made on top of one on its way. */
  const versionNow = useCallback(
    (id: string): number | undefined => {
      for (const [, d] of qc.getQueriesData<BoardView>({ queryKey: ['boards', boardId, 'view'] })) {
        for (const c of d?.columns ?? []) for (const i of c.issues) if (i.id === id) return i.version;
      }
      return undefined;
    },
    [qc, boardId],
  );

  const move = useCallback(
    (m: PendingMove, said?: string): Promise<void> => {
      const mine = ++seq.current;
      const chained = (queued.current.get(m.issue) ?? 0) > 0;
      queued.current.set(m.issue, (queued.current.get(m.issue) ?? 0) + 1);
      setFailed(null);
      setPending((p) => {
        const prev = p.get(m.issue);
        return new Map(p).set(m.issue, { ...m, fields: { ...prev?.fields, ...m.fields }, seq: mine });
      });
      const run = async () => {
        try {
          if (mine <= (dropped.current.get(m.issue) ?? 0)) return;
          // A board read that lands now would show the card where it was.
          await qc.cancelQueries({ queryKey: ['boards'] });
          const { view: v, lanes: l } = latest.current;
          const version = (chained ? versionNow(m.issue) : undefined) ?? m.version;
          try {
            await post(`/boards/${v.board.id}/rank`, rankBody(v, l, m, version));
            void qc.invalidateQueries({ queryKey: keys.issue(m.issue) });
            void qc.invalidateQueries({ queryKey: ['issues', 'list'] });
            // Keep showing the move until the board has been read again with it in place.
            await qc.invalidateQueries({ queryKey: ['boards'] });
            if (said) latest.current.onSaved(said);
          } catch (error) {
            dropped.current.set(m.issue, seq.current);
            setFailed({ move: m, error });
            void qc.invalidateQueries({ queryKey: ['boards'] });
          }
        } finally {
          queued.current.set(m.issue, (queued.current.get(m.issue) ?? 1) - 1);
          forget(m.issue, mine);
        }
      };
      chain.current = chain.current.then(run, run);
      return chain.current;
    },
    [qc, forget, versionNow],
  );

  return { pending, failed, move, dismiss: () => setFailed(null) };
}
