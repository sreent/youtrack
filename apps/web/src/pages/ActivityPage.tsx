import { useSearchParams } from 'react-router';
import { useProjects } from '../api/queries';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { LedgerEntry, withoutMirrors } from '../features/activity/LedgerEntry';
import { FormField } from '../features/common/bits';
import { useFeed } from '../features/common/queries';
import { t, tr } from '../i18n';

const STEP = 100;
const MOST = 500;

/** The change feed as Ocean's ledger: every change, who made it and through what, newest first. */
export default function ActivityPage() {
  const [search, setSearch] = useSearchParams();
  const project = search.get('project') ?? '';
  const limit = Math.min(MOST, Math.max(STEP, Number(search.get('show')) || STEP));
  const projects = useProjects();
  const feed = useFeed(project, limit);
  const events = withoutMirrors(feed.data ?? []);
  const more = (feed.data?.length ?? 0) >= limit && limit < MOST;

  const set = (next: { project?: string; show?: number }) => {
    const p = new URLSearchParams(search);
    if (next.project !== undefined) {
      if (next.project) p.set('project', next.project);
      else p.delete('project');
      p.delete('show');
    }
    if (next.show !== undefined) p.set('show', String(next.show));
    setSearch(p, { replace: true });
  };

  return (
    <>
      <PageHead
        title={t('page.activity.activity')}
        about={t('page.activity.everyChangeWhoMadeIt')}
      />
      <div className="stack">
        <div className="cluster">
          <FormField label={t('page.activity.project')} className="inline">
            {(id) => (
              <select id={id} value={project} onChange={(e) => set({ project: e.target.value })}>
                <option value="">{t('page.activity.allProjects')}</option>
                {(projects.data ?? []).map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.key} · {p.name}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          {feed.isFetching && feed.data ? (
            <span className="note" role="status">{t('page.activity.readingTheNewest')}</span>
          ) : null}
        </div>
        {feed.isLoading ? <Loading what={t('page.activity.theActivity')} /> : null}
        {feed.error ? <ErrorNote error={feed.error} /> : null}
        {feed.data && !events.length ? (
          <section className="card">
            <h2>{t('page.activity.nothingHasHappenedHereYet')}</h2>
            <p className="note">{t('page.activity.changesToIssuesCommentsLinks')}</p>
          </section>
        ) : null}
        {events.length ? (
          <section className="card ledger-box stack tight" aria-label={t('page.activity.theLedger')}>
            <ol className="ledger">
              {events.map((e) => (
                <LedgerEntry key={e.id} event={e} />
              ))}
            </ol>
            {more ? (
              <div className="cluster tw:justify-center">
                <button type="button" onClick={() => set({ show: Math.min(MOST, limit + STEP) })} disabled={feed.isFetching}>{tr('page.activity.showOlder', { min: Math.min(STEP, MOST - limit) })}</button>
              </div>
            ) : (feed.data?.length ?? 0) >= MOST ? (
              <p className="note">{tr('page.activity.thisShowsTheLatestFor', { MOST: MOST })}</p>
            ) : null}
          </section>
        ) : null}
      </div>
    </>
  );
}
