import { useSearchParams } from 'react-router';
import { useProjects } from '../api/queries';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { LedgerEntry, withoutMirrors } from '../features/activity/LedgerEntry';
import { useFeed } from '../features/common/queries';
import '../features/common/pages.css';

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
        title="Activity"
        about="Every change, who made it and through what: people on the web, agents over MCP or in the assistant, and scripts with a token. Newest first, with times to the second, in UTC."
      />
      <div className="a4p-filter">
        <label>
          Project
          <select value={project} onChange={(e) => set({ project: e.target.value })}>
            <option value="">All projects</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.key} value={p.key}>
                {p.key} · {p.name}
              </option>
            ))}
          </select>
        </label>
        {feed.isFetching && feed.data ? (
          <span className="note" role="status">
            Reading the newest…
          </span>
        ) : null}
      </div>
      {feed.isLoading ? <Loading what="the activity" /> : null}
      {feed.error ? <ErrorNote error={feed.error} /> : null}
      {feed.data && !events.length ? (
        <section className="card">
          <h2>Nothing has happened here yet</h2>
          <p className="note">Changes to issues, comments, links, logged work and baselines show here as they're made.</p>
        </section>
      ) : null}
      {events.length ? (
        <section className="card a4p-ledger-card" aria-label="The ledger">
          <div className="ledger-box">
            <ol className="ledger">
              {events.map((e) => (
                <LedgerEntry key={e.id} event={e} />
              ))}
            </ol>
          </div>
          {more ? (
            <div className="a4p-actions a4p-more">
              <button type="button" onClick={() => set({ show: Math.min(MOST, limit + STEP) })} disabled={feed.isFetching}>
                Show {Math.min(STEP, MOST - limit)} older
              </button>
            </div>
          ) : (feed.data?.length ?? 0) >= MOST ? (
            <p className="note">This shows the latest {MOST}. For older changes, poll GET /api/v1/events?after= from the API.</p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
