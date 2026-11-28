import type { SavedSearch, ViewSettings } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, patch } from '../../api/client';
import { keys } from '../../api/queries';
import { t } from '../../i18n';

/** How long the page waits after the owner's last change before keeping it: a few clicks are one change. */
const SETTLE_MS = 700;
/** How often a change is made again on what's there now, when the search keeps changing under it. */
const RETRIES = 2;

type Waiting = { id: string; change: Partial<ViewSettings> };

/**
 * The owner's changes to how their saved search is shown (D72), kept in it a moment after the last one,
 * with its version. When it changed meanwhile (409, in another tab, say), the page reads it again and
 * makes the same change on what's there now: what this person chose last is what's kept. What hasn't been
 * kept yet is kept as the page is left.
 */
export function useKeptView(): {
  /** The search's own view with what's waiting to be kept over it. */
  shownFor: (s: SavedSearch) => ViewSettings;
  keep: (s: SavedSearch, change: Partial<ViewSettings>) => void;
  /** What happened, said to screen readers. */
  said: string;
  failed: unknown;
} {
  const qc = useQueryClient();
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [said, setSaid] = useState('');
  const [failed, setFailed] = useState<unknown>(null);
  const latest = useRef<Waiting | null>(null);
  latest.current = waiting;

  const send = useCallback(
    async (w: Waiting, tries = 0): Promise<void> => {
      const now = qc.getQueryData<SavedSearch[]>(keys.savedSearches)?.find((s) => s.id === w.id);
      if (!now) return;
      try {
        const kept = await patch<SavedSearch>(`/saved-searches/${w.id}`, { view: { ...now.view, ...w.change }, expectedVersion: now.version });
        qc.setQueryData<SavedSearch[]>(keys.savedSearches, (list) => list?.map((s) => (s.id === kept.id ? kept : s)));
        // What was changed while this was on its way waits for its own turn.
        setWaiting((cur) => (cur === w ? null : cur));
        setFailed(null);
        setSaid(t('views.saved.kept', { name: kept.name }));
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && tries < RETRIES) {
          await qc.refetchQueries({ queryKey: keys.savedSearches });
          return send(w, tries + 1);
        }
        setWaiting((cur) => (cur === w ? null : cur));
        setFailed(e);
        await qc.invalidateQueries({ queryKey: keys.savedSearches });
      }
    },
    [qc],
  );

  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => void send(waiting), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [waiting, send]);
  // Leaving the page keeps what was waiting rather than losing it.
  useEffect(
    () => () => {
      if (latest.current) void send(latest.current);
    },
    [send],
  );

  const keep = useCallback(
    (s: SavedSearch, change: Partial<ViewSettings>) => {
      setSaid('');
      setWaiting((cur) => {
        // Another search's change goes now, before this one waits.
        if (cur && cur.id !== s.id) void send(cur);
        return { id: s.id, change: { ...(cur && cur.id === s.id ? cur.change : {}), ...change } };
      });
    },
    [send],
  );

  const shownFor = useCallback((s: SavedSearch): ViewSettings => (waiting && waiting.id === s.id ? { ...s.view, ...waiting.change } : s.view), [waiting]);
  return { shownFor, keep, said, failed };
}
