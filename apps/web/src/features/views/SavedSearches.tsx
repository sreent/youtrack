import type { SavedSearch, ViewSettings } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { ApiError, del, post } from '../../api/client';
import { keys, useMe, useSavedSearches } from '../../api/queries';
import { ErrorLine } from '../../components/States';
import { problemWords, t, tr } from '../../i18n';
import { SearchSubscription } from '../notifications/Subscriptions';

/** A problem as the page says it: in its own words where the server keyed it (D49), else as the server put it. */
export function saidOf(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return problemWords(e) ?? (e.hint ? `${e.message}. ${e.hint}` : e.message);
  return fallback;
}

/**
 * The saved searches, yours and those shared with you: each opens in its own view (D72), and a shared
 * one says which. The one open offers what may be done with it: following it, forgetting it (asking
 * first when its baselines would go with it) and, for an administrator, adopting one left with no owner.
 */
export function SavedSearches({
  current,
  query,
  view,
  onOpen,
  onSaved,
  onGone,
}: {
  /** The saved search open, if one is. */
  current: SavedSearch | null;
  /** The query shown, which "Save this search" saves. */
  query: string;
  /** How it's shown now, which a new saved search keeps. */
  view: ViewSettings;
  onOpen: (s: SavedSearch) => void;
  onSaved: (s: SavedSearch) => void;
  onGone: () => void;
}) {
  const saved = useSavedSearches();
  const me = useMe();
  const qc = useQueryClient();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const [asking, setAsking] = useState<{ search: SavedSearch; baselines: number } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const myId = me.data?.id;
  const admin = Boolean(me.data?.auth.scopes.includes('admin'));
  // Opened by its query, as before saved searches had an address of their own.
  const shown = current ?? (query ? saved.data?.find((s) => s.query === query) : undefined) ?? null;

  const save = async () => {
    setError(null);
    try {
      const made = await post<SavedSearch>('/saved-searches', { name: name.trim(), query, shared: false, view: { kind: view.kind, group: view.group } });
      setNaming(false);
      setName('');
      await qc.invalidateQueries({ queryKey: keys.savedSearches });
      onSaved(made);
    } catch (e) {
      setError(e instanceof ApiError ? (problemWords(e) ?? e.message) : t('page.issues.couldNotSaveTheSearch'));
    }
  };

  const forget = async (s: SavedSearch, confirm = false) => {
    setError(null);
    try {
      await del(`/saved-searches/${s.id}${confirm ? '?confirm=true' : ''}`);
      setAsking(null);
      await qc.invalidateQueries({ queryKey: keys.savedSearches });
      setSaid(t('views.saved.forgotten', { name: s.name }));
      if (current?.id === s.id) onGone();
    } catch (e) {
      // Its baselines would go with it: ask first, saying how many.
      if (e instanceof ApiError && e.key === 'savedSearches.hasBaselines' && !confirm) {
        setAsking({ search: s, baselines: Number((e.details as { baselines?: number } | undefined)?.baselines ?? 0) });
        dialog.current?.showModal();
        keep.current?.focus();
        return;
      }
      setError(saidOf(e, t('views.saved.couldNotForget')));
    }
  };

  const adopt = async (s: SavedSearch) => {
    setError(null);
    try {
      const mine = await post<SavedSearch>(`/saved-searches/${s.id}/adopt`);
      qc.setQueryData<SavedSearch[]>(keys.savedSearches, (list) => list?.map((x) => (x.id === mine.id ? mine : x)));
      setSaid(t('views.saved.adopted', { name: mine.name }));
    } catch (e) {
      setError(saidOf(e, t('views.saved.couldNotAdopt')));
      await qc.invalidateQueries({ queryKey: keys.savedSearches });
    }
  };

  return (
    <div className="cluster">
      <span className="label">{t('page.issues.savedSearches')}</span>
      {saved.data?.map((s) => (
        <button key={s.id} type="button" className="link" aria-current={s.id === shown?.id ? 'true' : undefined} onClick={() => onOpen(s)}>
          {s.shared && s.view.kind !== 'list' ? t('views.saved.shownAs', { name: s.name, view: s.view.kind }) : s.name}
        </button>
      ))}
      {query && !shown && !naming ? (
        <button type="button" className="link" onClick={() => setNaming(true)}>{t('page.issues.saveThisSearch')}</button>
      ) : null}
      {shown ? <SearchSubscription search={shown} /> : null}
      {shown && shown.owner && shown.owner.id === myId && !shown.shared ? (
        <button type="button" className="link" onClick={() => void forget(shown)}>{tr('page.issues.forget', { name: shown.name })}</button>
      ) : null}
      {shown && !shown.owner && admin ? (
        <button type="button" className="link" onClick={() => void adopt(shown)}>{t('views.saved.adopt', { name: shown.name })}</button>
      ) : null}
      {shown && !shown.owner && !admin ? <span className="note">{t('views.saved.noOwner')}</span> : null}
      {naming ? (
        <form
          className="cluster"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void save();
          }}
        >
          <input aria-label={t('page.issues.nameForThisSearch')} placeholder={t('page.issues.aNameForIt')} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <button type="submit" disabled={!name.trim()}>{t('page.issues.save')}</button>
          <button type="button" className="link" onClick={() => setNaming(false)}>{t('page.issues.cancel')}</button>
        </form>
      ) : null}
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <p role="status" className="hidden">{said}</p>
      {/* Ocean's Confirm, asked once the server says what would go with it. */}
      <dialog ref={dialog} className="dialog" aria-labelledby={`${titleId}-title`} aria-describedby={`${titleId}-about`} onClose={() => setAsking(null)}>
        <h2 id={`${titleId}-title`}>{t('views.saved.forgetTitle', { name: asking?.search.name ?? '' })}</h2>
        <p id={`${titleId}-about`}>{t('views.saved.forgetAbout', { n: asking?.baselines ?? 0 })}</p>
        <div className="dialog-actions">
          <button type="button" ref={keep} onClick={() => dialog.current?.close()}>{t('common.confirm.keepIt')}</button>
          <button
            type="button"
            className="danger primary"
            onClick={() => {
              const s = asking?.search;
              dialog.current?.close();
              if (s) void forget(s, true);
            }}
          >
            {t('views.saved.forgetConfirm')}
          </button>
        </div>
      </dialog>
    </div>
  );
}
