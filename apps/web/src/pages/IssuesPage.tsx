import type { SavedSearch } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ApiError, del, post } from '../api/client';
import { keys, useAIStatus, useIssues, useSavedSearches } from '../api/queries';
import { Icon } from '../components/Icon';
import { ErrorNote, Loading, PageHead, ErrorLine } from '../components/States';
import { CommandBar } from '../features/issues/CommandBar';
import { SearchSubscription } from '../features/notifications/Subscriptions';
import { IssueList } from '../features/issues/IssueList';
import { QueryBar } from '../features/issues/QueryBar';
import { t, tr } from '../i18n';

const PAGE = 50;

function SavedSearches({ query, onPick }: { query: string; onPick: (q: string) => void }) {
  const saved = useSavedSearches();
  const qc = useQueryClient();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mine = saved.data?.find((s) => s.query === query);

  const save = async () => {
    setError(null);
    try {
      await post<SavedSearch>('/saved-searches', { name: name.trim(), query, shared: false });
      setNaming(false);
      setName('');
      await qc.invalidateQueries({ queryKey: keys.savedSearches });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('page.issues.couldNotSaveTheSearch'));
    }
  };

  return (
    <div className="cluster">
      <span className="label">{t('page.issues.savedSearches')}</span>
      {saved.data?.map((s) => (
        <button key={s.id} type="button" className="link" aria-current={s.query === query ? 'true' : undefined} onClick={() => onPick(s.query)}>
          {s.name}
        </button>
      ))}
      {query && !mine && !naming ? (
        <button type="button" className="link" onClick={() => setNaming(true)}>{t('page.issues.saveThisSearch')}</button>
      ) : null}
      {mine ? <SearchSubscription search={mine} /> : null}
      {mine && mine.owner && !mine.shared ? (
        <button
          type="button"
          className="link"
          onClick={async () => {
            await del(`/saved-searches/${mine.id}`);
            await qc.invalidateQueries({ queryKey: keys.savedSearches });
          }}
        >{tr('page.issues.forget', { name: mine.name })}</button>
      ) : null}
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
    </div>
  );
}

export default function IssuesPage() {
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const offset = Math.max(0, Number(params.get('from') ?? 0) || 0);
  const issues = useIssues(query, offset, PAGE);
  const ai = useAIStatus();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [commanding, setCommanding] = useState(false);

  const search = useCallback(
    (q: string) => {
      setParams(q ? { q } : {});
      setChosen(new Set());
    },
    [setParams],
  );
  const page = (from: number) => setParams({ ...(query ? { q: query } : {}), ...(from ? { from: String(from) } : {}) });

  const items = issues.data?.items;
  const chosenIssues = useMemo(() => (items ?? []).filter((i) => chosen.has(i.id)).map((i) => ({ id: i.id, summary: i.summary })), [items, chosen]);
  const project = /\bproject:\s*([A-Za-z][A-Za-z0-9]*)/.exec(query)?.[1];
  const total = issues.data?.total ?? null;
  const badQuery = issues.error instanceof ApiError && issues.error.problems.length > 0;

  return (
    <>
      <PageHead
        title={t('page.issues.issues')}
        actions={
          <Link to="/issues/new" className="button primary">{tr('page.issues.newIssue', { el: <Icon name="plus" /> })}</Link>
        }
      />
      <div className="stack">
        <QueryBar value={query} onSubmit={search} found={issues.isFetching && !issues.isPlaceholderData ? null : total} project={project} aiEnabled={Boolean(ai.data?.enabled)} />
        <SavedSearches query={query} onPick={search} />
        {issues.isLoading ? <Loading what="issues" /> : null}
        {issues.error && !badQuery ? <ErrorNote error={issues.error} /> : null}
        {items && items.length === 0 ? (
          <p className="note">{query ? t('page.issues.nothingMatchesThisSearch') : t('page.issues.thereAreNoIssuesYet')}</p>
        ) : null}
        {items && items.length > 0 ? (
          <IssueList issues={items} label={query ? t('page.issues.issuesFound') : t('page.issues.allIssues')} chosen={chosen} onChosen={setChosen} onCommand={() => setCommanding(true)} />
        ) : null}
        {total !== null && total > PAGE ? (
          <nav className="cluster" aria-label={t('page.issues.pages')}>
            <button type="button" disabled={offset === 0} onClick={() => page(Math.max(0, offset - PAGE))}>{t('page.issues.previous')}</button>
            <span className="note">{tr('page.issues.of', { v: offset + 1, min: Math.min(offset + PAGE, total), total: total })}</span>
            <button type="button" disabled={offset + PAGE >= total} onClick={() => page(offset + PAGE)}>{t('page.issues.next')}</button>
          </nav>
        ) : null}
      </div>
      <CommandBar
        issues={chosenIssues}
        open={commanding && chosenIssues.length > 0}
        onClose={() => setCommanding(false)}
        onApplied={() => setChosen(new Set())}
      />
    </>
  );
}
