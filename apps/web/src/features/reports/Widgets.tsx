/**
 * A dashboard's widgets (Ocean's Dashboard, components/Dashboard): a report with its parameters,
 * a saved search's count or list, or a note. Each is worked out for whoever looks, as they may see.
 */
import type { CountResult, IssueList, SavedSearch, Widget } from '@a4a/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { get, post, qs } from '../../api/client';
import { useSavedSearches } from '../../api/queries';
import { StateBadge } from '../../components/Badges';
import { Markdown } from '../../components/Markdown';
import { ErrorNote, Loading } from '../../components/States';
import { REPORTS, ReportView, widgetQuery } from './ReportView';

function SearchWidget({ w }: { w: Extract<Widget, { kind: 'search' }> }) {
  const saved = useSavedSearches();
  const search: SavedSearch | undefined = w.savedSearch ? saved.data?.find((s) => s.id === w.savedSearch) : undefined;
  const query = w.savedSearch ? search?.query : w.query;
  const missing = Boolean(w.savedSearch && saved.data && !search);
  const list = useQuery({
    queryKey: ['issues', 'list', 'widget', query ?? '', w.show, w.limit],
    queryFn: (): Promise<CountResult | IssueList> =>
      w.show === 'count' ? post<CountResult>('/search/count', { query: query ?? '' }) : get<IssueList>(`/issues${qs({ query: query ?? '', limit: w.limit })}`),
    enabled: query !== undefined && !missing,
    retry: false,
  });
  if (missing) return <p className="note">The saved search this showed is gone, or no longer shared.</p>;
  if (saved.isLoading || list.isLoading) return <Loading />;
  if (list.error) return <ErrorNote error={list.error} />;
  const href = `/issues${qs({ query: query ?? '' })}`;
  if (w.show === 'count') {
    const c = list.data as CountResult | undefined;
    return (
      <p className="widget-count">
        <strong>{c?.total ?? 0}</strong>
        <Link to={href}>{c?.total === 1 ? 'issue' : 'issues'}</Link>
      </p>
    );
  }
  const l = list.data as IssueList | undefined;
  if (!l?.items.length) return <p className="note">Nothing matches it now.</p>;
  return (
    <>
      <ul className="widget-list">
        {l.items.map((i) => (
          <li key={i.id}>
            <Link className="issue-id" to={`/issues/${i.id}`}>
              {i.id}
            </Link>
            <span>
              {i.summary} <StateBadge fields={i.fields} />
            </span>
          </li>
        ))}
      </ul>
      {l.total > l.items.length ? (
        <p className="note">
          <Link to={href}>All {l.total}</Link>
        </p>
      ) : null}
    </>
  );
}

/** A widget's title: its own, or what it shows. */
export function widgetTitle(w: Widget, saved?: SavedSearch[]): string {
  if (w.title) return w.title;
  if (w.kind === 'note') return 'Note';
  if (w.kind === 'search') return (w.savedSearch && saved?.find((s) => s.id === w.savedSearch)?.name) || w.query || 'A search';
  return REPORTS.find((r) => r.kind === w.params.report)?.label ?? 'Report';
}

export function WidgetBody({ w }: { w: Widget }) {
  if (w.kind === 'note') return <Markdown text={w.text} />;
  if (w.kind === 'search') return <SearchWidget w={w} />;
  const { kind, params } = widgetQuery(w.params);
  return <ReportView kind={kind} params={params} compact={w.width !== 'full'} />;
}
