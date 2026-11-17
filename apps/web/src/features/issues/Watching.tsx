import type { WatchReason } from '@a4a/shared';
import { Icon } from '../../components/Icon';
import { ErrorLine } from '../../components/States';
import { UserWho } from '../../components/Who';
import { useWatch, useWatchers } from '../notifications/api';
import { errorText } from './api';
import { t } from '../../i18n';

const WHY: Record<WatchReason, string> = {
  explicit: t('issues.watching.choseTo'),
  reporter: t('issues.watching.reportedIt'),
  assignee: t('issues.watching.wasAssignedIt'),
  commenter: 'commented',
  mentioned: t('issues.watching.wasMentioned'),
  lead: t('issues.watching.leadsTheProject'),
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
        title={watching ? t('issues.watching.youHearAboutItsChanges') : t('issues.watching.hearAboutItsChangesAnd')}
      >
        <Icon name="bell" />
        <span>{t('issues.watching.watch')}</span>
        <span className="watch-count">
          <span aria-hidden="true">{n}</span>
          <span className="hidden">, {n === 1 ? t('issues.watching.n1PersonWatchesIt') : t('issues.watching.peopleWatchIt', { n: n })}</span>
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
      <h2 id="watchers-title">{t('issues.watching.watchers')}</h2>
      {list.length ? (
        <ul className="plain">
          {list.map((w) => (
            <li key={w.user.id}>
              <UserWho user={w.user} small about={WHY[w.reason]} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="note">{watchers.isLoading ? t('issues.watching.loading') : t('issues.watching.nobodyWatchesIt')}</p>
      )}
      <p className="note">{t('issues.watching.theyHearAboutItsChanges')}</p>
    </section>
  );
}
