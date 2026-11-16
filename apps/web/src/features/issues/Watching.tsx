import type { WatchReason } from '@a4a/shared';
import { Icon } from '../../components/Icon';
import { ErrorLine } from '../../components/States';
import { UserWho } from '../../components/Who';
import { useWatch, useWatchers } from '../notifications/api';
import { errorText } from './api';

const WHY: Record<WatchReason, string> = {
  explicit: 'chose to',
  reporter: 'reported it',
  assignee: 'was assigned it',
  commenter: 'commented',
  mentioned: 'was mentioned',
  lead: 'leads the project',
};

/** Ocean's WatchToggle: pressed while you watch the issue, with how many do. */
export function WatchToggle({ issue }: { issue: string }) {
  const watchers = useWatchers(issue);
  const watch = useWatch(issue);
  const watching = watchers.data?.watching ?? false;
  const n = watchers.data?.watchers.length ?? 0;
  return (
    <>
      <button
        type="button"
        className="watch"
        aria-pressed={watching}
        disabled={!watchers.data || watch.isPending}
        onClick={() => watch.mutate(!watching)}
        title={watching ? 'You hear about its changes and comments. Press to stop.' : 'Hear about its changes and comments.'}
      >
        <Icon name="bell" />
        <span>Watch</span>
        <span className="watch-count">
          <span aria-hidden="true">{n}</span>
          <span className="hidden">, {n === 1 ? '1 person watches it' : `${n} people watch it`}</span>
        </span>
      </button>
      {watch.error ? <ErrorLine>{errorText(watch.error)}</ErrorLine> : null}
    </>
  );
}

/** Who watches the issue, and why, in a card beside it. */
export function WatchersCard({ issue }: { issue: string }) {
  const watchers = useWatchers(issue);
  const list = watchers.data?.watchers ?? [];
  return (
    <section className="card side-card" aria-labelledby="watchers-title">
      <h2 id="watchers-title">Watchers</h2>
      {list.length ? (
        <ul className="plain">
          {list.map((w) => (
            <li key={w.user.id}>
              <UserWho user={w.user} small about={WHY[w.reason]} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="note">{watchers.isLoading ? 'Loading…' : 'Nobody watches it.'}</p>
      )}
      <p className="note">They hear about its changes and comments. Whoever reports it, is assigned it, comments or is mentioned watches it too.</p>
    </section>
  );
}
