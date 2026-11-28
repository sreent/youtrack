import type { PlanScope, SavedSearch, ViewSettings } from '@a4a/shared';
import { DEFAULT_VIEW, isViewKind } from '@a4a/shared/view-kinds';
import { Suspense, useEffect, useId, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ApiError } from '../api/client';
import { useAIStatus, useGroupFields, useIssues, useMe, useSavedSearches } from '../api/queries';
import { Icon } from '../components/Icon';
import { ErrorLine, ErrorNote, Loading, PageHead } from '../components/States';
import { CommandBar } from '../features/issues/CommandBar';
import { QueryBar } from '../features/issues/QueryBar';
import { useKeptView } from '../features/views/kept';
import { availableViews, viewFor } from '../features/views/registry';
import { SavedSearches, saidOf } from '../features/views/SavedSearches';
import type { CommandIssues, ViewProps } from '../features/views/types';
import { t, tr } from '../i18n';

const PAGE = 50;

/** The keys of how a search is shown that a view's own settings are (D72): the rest, kind and group, are the page's. */
const OWN = ['timeline', 'calendar', 'table'] as const;

/**
 * The fields to group by: none, then those every project of the search's issues has (D72). The one
 * chosen stays offered while they load, or when it's one they don't have.
 */
function GroupPicker({ query, value, onPick }: { query: string; value: string | null; onPick: (field: string | null) => void }) {
  const fields = useGroupFields(query);
  const id = useId();
  const names = (fields.data?.fields ?? []).map((f) => f.name);
  if (value && !names.some((n) => n.toLowerCase() === value.toLowerCase())) names.unshift(value);
  return (
    <span className="form-field inline">
      <label htmlFor={id}>{t('views.group.label')}</label>
      <select id={id} value={value ?? ''} onChange={(e) => onPick(e.target.value || null)}>
        <option value="">{t('views.group.nothing')}</option>
        {names.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </span>
  );
}

export default function IssuesPage() {
  const [params, setParams] = useSearchParams();
  const me = useMe();
  const saved = useSavedSearches();
  const ai = useAIStatus();
  const kept = useKeptView();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [commanding, setCommanding] = useState<CommandIssues | null>(null);
  // A view's own settings for anyone but the owner, and for a search not saved: theirs while they're here.
  const [local, setLocal] = useState<Partial<ViewSettings>>({});
  const [refused, setRefused] = useState<string | null>(null);

  // The address holds it all (D72): ?q= or ?search=, then &view= and &group=, and &from= for the page.
  const searchId = params.get('search');
  const open = searchId ? (saved.data?.find((s) => s.id === searchId) ?? null) : null;
  const waitingForSearch = Boolean(searchId) && saved.isLoading;
  const lost = Boolean(searchId) && !saved.isLoading && !open;
  const owner = Boolean(open && me.data && open.owner?.id === me.data.id);
  const query = open ? open.query : searchId ? '' : (params.get('q') ?? '');
  const offset = Math.max(0, Number(params.get('from') ?? 0) || 0);
  const addressView = params.get('view');
  const addressGroup = params.get('group');

  // The saved search's own view, with what its owner changed and hasn't kept yet; then what the address says.
  const base: ViewSettings = open ? (owner ? kept.shownFor(open) : open.view) : DEFAULT_VIEW;
  const settings: ViewSettings = {
    ...base,
    ...(owner ? {} : local),
    kind: isViewKind(addressView) ? addressView : base.kind,
    group: addressGroup !== null ? addressGroup || null : base.group,
  };
  const shown = viewFor(settings.kind);
  const group = settings.group && settings.group !== refused ? settings.group : null;

  const issues = useIssues(query, offset, PAGE, group, !waitingForSearch && !lost);
  const groupRefused = issues.error instanceof ApiError && issues.error.key === 'issues.cannotGroupBy';
  useEffect(() => {
    if (groupRefused && group) setRefused(group);
  }, [groupRefused, group]);

  /** Change how it's shown: kept in the saved search for its owner, in the address for anyone else. */
  const change = (next: Partial<ViewSettings>) => {
    const regrouped = 'group' in next && next.group !== settings.group;
    if (open && owner) {
      // What the address said gives way to what's kept: the page shows the same, and the owner's search keeps it.
      kept.keep(open, { kind: settings.kind, group: settings.group, ...next });
      setParams((p) => {
        const n = new URLSearchParams(p);
        n.delete('view');
        n.delete('group');
        if (regrouped) n.delete('from');
        return n;
      });
    } else {
      const own: Partial<ViewSettings> = {};
      for (const k of OWN) if (k in next) Object.assign(own, { [k]: next[k] });
      if (Object.keys(own).length) setLocal((l) => ({ ...l, ...own }));
      setParams((p) => {
        const n = new URLSearchParams(p);
        if ('kind' in next && next.kind) {
          // Today's list keeps today's address: nothing else in it, for a search that isn't saved.
          if (next.kind === 'list' && !open) n.delete('view');
          else n.set('view', next.kind);
        }
        if ('group' in next) {
          const g = next.group ?? null;
          if (!open) {
            if (g) n.set('group', g);
            else n.delete('group');
          } else if (g === open.view.group) n.delete('group');
          else n.set('group', g ?? '');
        }
        if (regrouped) n.delete('from');
        return n;
      });
    }
  };
  const onSettings = (next: ViewSettings) => {
    const diff: Partial<ViewSettings> = {};
    for (const k of ['kind', 'group', ...OWN] as const) if (JSON.stringify(next[k]) !== JSON.stringify(settings[k])) Object.assign(diff, { [k]: next[k] });
    if (Object.keys(diff).length) change(diff);
  };

  // A new query keeps the view and its grouping, as the switch keeps the search; what was chosen goes.
  const search = (q: string) => {
    if (open && q === open.query) return;
    const n = new URLSearchParams();
    if (q) n.set('q', q);
    if (shown.kind !== 'list') n.set('view', shown.kind);
    if (settings.group) n.set('group', settings.group);
    setParams(n);
    setChosen(new Set());
    setLocal({});
  };
  const openSaved = (s: SavedSearch) => {
    setParams({ search: s.id });
    setChosen(new Set());
    setLocal({});
  };
  const page = (from: number) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (from) n.set('from', String(from));
      else n.delete('from');
      return n;
    });

  const items = issues.data?.items;
  const chosenIssues = useMemo(() => (items ?? []).filter((i) => chosen.has(i.id)).map((i) => ({ id: i.id, summary: i.summary })), [items, chosen]);
  const project = /\bproject:\s*([A-Za-z][A-Za-z0-9]*)/.exec(query)?.[1];
  const total = issues.data?.total ?? null;
  const badQuery = issues.error instanceof ApiError && issues.error.problems.length > 0;
  const scope: PlanScope = open ? { savedSearch: open.id } : { query };
  const views = availableViews();
  const props: ViewProps = {
    scope,
    query,
    savedSearch: open,
    group,
    settings,
    onSettings,
    chosen,
    onChosen: setChosen,
    onCommand: (named) => setCommanding(named ?? chosenIssues),
    issues: items ?? [],
    groups: group ? (issues.data?.groups ?? null) : null,
  };
  const View = shown.component;

  return (
    <>
      <PageHead
        title={open ? open.name : t('page.issues.issues')}
        crumbs={
          open ? (
            <>
              <Link to="/issues">{t('page.issues.issues')}</Link>
              <span className="sep" aria-hidden="true">
                /
              </span>
            </>
          ) : undefined
        }
        actions={
          <>
            <GroupPicker query={query} value={settings.group} onPick={(g) => change({ group: g })} />
            <Link to="/issues/new" className="button primary">{tr('page.issues.newIssue', { el: <Icon name="plus" /> })}</Link>
          </>
        }
      />
      <div className="stack">
        {views.length > 1 ? (
          // Ocean's choice of views, as the plan's: the chosen one pressed. Each keeps the search, its grouping and what's chosen.
          <div>
            <div className="modes" role="group" aria-label={t('views.switch.label')}>
              {views.map((v) => (
                <button key={v.kind} type="button" aria-pressed={shown.kind === v.kind} onClick={() => change({ kind: v.kind })}>
                  {t(v.label)}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <QueryBar value={query} onSubmit={search} found={issues.isFetching && !issues.isPlaceholderData ? null : total} project={project} aiEnabled={Boolean(ai.data?.enabled)} />
        <SavedSearches current={open} query={query} view={{ ...settings, kind: shown.kind, group }} onOpen={openSaved} onSaved={openSaved} onGone={() => setParams(query ? { q: query } : {})} />
        <p role="status" className="hidden">{kept.said}</p>
        {kept.failed ? <ErrorLine>{t('views.saved.notKept', { problem: saidOf(kept.failed, t('views.saved.couldNotKeep')) })}</ErrorLine> : null}
        {lost ? (
          <p className="note">{tr('views.saved.lost', { t0: (c: React.ReactNode) => <Link to="/issues">{c}</Link> })}</p>
        ) : null}
        {refused && settings.group === refused ? <ErrorLine>{saidOf(issues.error ?? null, t('views.group.refused', { field: refused }))}</ErrorLine> : null}
        {waitingForSearch || issues.isLoading ? <Loading what="loadingLine.issues" /> : null}
        {issues.error && !badQuery && !groupRefused ? <ErrorNote error={issues.error} /> : null}
        {shown.kind === 'list' ? (
          <>
            {items && items.length === 0 ? <p className="note">{query ? t('page.issues.nothingMatchesThisSearch') : t('page.issues.thereAreNoIssuesYet')}</p> : null}
            {items && items.length > 0 ? (
              <Suspense fallback={<Loading what="loadingLine.issues" />}>
                <View {...props} />
              </Suspense>
            ) : null}
            {total !== null && total > PAGE ? (
              <nav className="cluster" aria-label={t('page.issues.pages')}>
                <button type="button" disabled={offset === 0} onClick={() => page(Math.max(0, offset - PAGE))}>{t('page.issues.previous')}</button>
                <span className="note">{tr('page.issues.of', { v: offset + 1, min: Math.min(offset + PAGE, total), total: total })}</span>
                <button type="button" disabled={offset + PAGE >= total} onClick={() => page(offset + PAGE)}>{t('page.issues.next')}</button>
              </nav>
            ) : null}
          </>
        ) : lost ? null : (
          <Suspense fallback={<Loading what="loadingLine.issues" />}>
            <View {...props} />
          </Suspense>
        )}
      </div>
      <CommandBar view={shown.kind} issues={commanding ?? []} open={Boolean(commanding?.length)} onClose={() => setCommanding(null)} onApplied={() => setChosen(new Set())} />
    </>
  );
}
