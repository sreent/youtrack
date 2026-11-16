import type { SavedSearch } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ApiError, del, post } from '../api/client';
import { keys, useAIStatus, useIssues, useSavedSearches } from '../api/queries';
import { Icon } from '../components/Icon';
import { ErrorNote, Loading, PageHead, ErrorLine } from '../components/States';
import { CommandBar } from '../features/issues/CommandBar';
import { IssueList } from '../features/issues/IssueList';
import { QueryBar } from '../features/issues/QueryBar';

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
      setError(e instanceof ApiError ? e.message : 'Could not save the search.');
    }
  };

  return (
    <div className="cluster">
      <span className="label">Saved searches</span>
      {saved.data?.map((s) => (
        <button key={s.id} type="button" className="link" aria-current={s.query === query ? 'true' : undefined} onClick={() => onPick(s.query)}>
          {s.name}
        </button>
      ))}
      {query && !mine && !naming ? (
        <button type="button" className="link" onClick={() => setNaming(true)}>
          Save this search
        </button>
      ) : null}
      {mine && mine.owner && !mine.shared ? (
        <button
          type="button"
          className="link"
          onClick={async () => {
            await del(`/saved-searches/${mine.id}`);
            await qc.invalidateQueries({ queryKey: keys.savedSearches });
          }}
        >
          Forget “{mine.name}”
        </button>
      ) : null}
      {naming ? (
        <form
          className="cluster"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void save();
          }}
        >
          <input aria-label="Name for this search" placeholder="A name for it" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <button type="submit" disabled={!name.trim()}>
            Save
          </button>
          <button type="button" className="link" onClick={() => setNaming(false)}>
            Cancel
          </button>
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
        title="Issues"
        actions={
          <Link to="/issues/new" className="button primary">
            <Icon name="plus" />
            New issue
          </Link>
        }
      />
      <div className="stack">
        <QueryBar value={query} onSubmit={search} found={issues.isFetching && !issues.isPlaceholderData ? null : total} project={project} aiEnabled={Boolean(ai.data?.enabled)} />
        <SavedSearches query={query} onPick={search} />
        {issues.isLoading ? <Loading what="issues" /> : null}
        {issues.error && !badQuery ? <ErrorNote error={issues.error} /> : null}
        {items && items.length === 0 ? (
          <p className="note">{query ? 'Nothing matches this search.' : 'There are no issues yet.'}</p>
        ) : null}
        {items && items.length > 0 ? (
          <IssueList issues={items} label={query ? 'Issues found' : 'All issues'} chosen={chosen} onChosen={setChosen} onCommand={() => setCommanding(true)} />
        ) : null}
        {total !== null && total > PAGE ? (
          <nav className="cluster" aria-label="Pages">
            <button type="button" disabled={offset === 0} onClick={() => page(Math.max(0, offset - PAGE))}>
              Previous
            </button>
            <span className="note">
              {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
            </span>
            <button type="button" disabled={offset + PAGE >= total} onClick={() => page(offset + PAGE)}>
              Next
            </button>
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
