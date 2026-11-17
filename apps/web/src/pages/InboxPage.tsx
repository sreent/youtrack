import type { Change, Notification, TrackerEvent } from '@a4a/shared';
import { subscriptionTells } from '@a4a/shared/i18n';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Badge } from '../components/Badges';
import { ChangeLines } from '../components/Changes';
import { Markdown } from '../components/Markdown';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { actorWho, Avatar } from '../components/Who';
import { count, excerpt, whenRead } from '../features/common/format';
import { useStateTones } from '../features/issues/api';
import { useMarkRead, useNotifications } from '../features/notifications/api';
import { intlLocale, t, tr } from '../i18n';

interface Group {
  issue: Notification['issue'];
  deleted: boolean;
  items: Notification[];
  lastAt: string;
}

/** By issue, the issue whose latest news is newest first; within one, newest first too. */
function byIssue(items: Notification[]): Group[] {
  const groups = new Map<string, Group>();
  for (const n of items) {
    const g = groups.get(n.issue.id);
    if (g) {
      g.items.push(n);
      if (n.lastAt > g.lastAt) g.lastAt = n.lastAt;
    } else groups.set(n.issue.id, { issue: n.issue, deleted: n.issueDeleted, items: [n], lastAt: n.lastAt });
  }
  return [...groups.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

/** Each field's change across the events, from what it was first to what it became last. */
function netChanges(events: TrackerEvent[]): Change[] {
  const out = new Map<string, Change>();
  for (const e of events) {
    if (e.type !== 'issue.updated') continue;
    for (const c of e.changes) {
      const had = out.get(c.field);
      out.set(c.field, had ? { field: c.field, from: had.from, to: c.to } : c);
    }
  }
  return [...out.values()].filter((c) => c.from !== c.to);
}

function NotificationEntry({ n }: { n: Notification }) {
  const last = n.events[n.events.length - 1];
  const who = last ? actorWho(last.actor, last.data) : { kind: 'own' as const, name: 'a4a', about: '' };
  const changes = netChanges(n.events);
  const said = n.events.filter((e) => e.type === 'comment.created' && typeof e.data.text === 'string' && e.data.text.trim()).slice(-2);
  const links = n.events.filter((e) => e.type === 'link.created' || e.type === 'link.deleted');
  const files = n.events.filter((e) => e.type === 'attachment.added' || e.type === 'attachment.removed');
  const unread = n.readAt === null;
  return (
    <li className={unread ? 'unread' : 'read'}>
      <Avatar kind={who.kind} name={who.name} small />
      <div className="history-body">
        <p className="history-head">
          {unread ? <span className="hidden">{t('page.inbox.unread')}</span> : null}
          <strong className="inbox-what">{n.title}</strong> ·{' '}
          <time dateTime={n.lastAt} title={new Date(n.lastAt).toLocaleString(intlLocale())}>
            {whenRead(n.lastAt)}
          </time>
        </p>
        {n.subscription ? <p className="note">{tr('page.inbox.becauseYouSubscribedTo', { tells: subscriptionTells(n.subscription.target, n.subscription.events), name: n.subscription.name })}</p> : null}
        {changes.length ? <ChangeLines changes={changes} /> : null}
        {links.map((e) => (
          <p key={e.id} className="note">
            {e.type === 'link.created' ? t('page.inbox.linked') : t('page.inbox.unlinked')}: {String(e.data.phrase ?? '')} {(e.data.target as { id?: string } | undefined)?.id ?? ''}
          </p>
        ))}
        {files.map((e) => (
          <p key={e.id} className="note">
            {e.type === 'attachment.added' ? t('page.inbox.attached') : t('page.inbox.removed')}: {String((e.data.attachment as { name?: string } | undefined)?.name ?? t('page.inbox.aFile'))}
          </p>
        ))}
        {said.map((e) => (
          <div key={e.id} className={e.data.visibility === 'public' ? 'history-comment public' : 'history-comment'}>
            <Markdown text={excerpt(String(e.data.text), 600)} />
          </div>
        ))}
      </div>
    </li>
  );
}

function InboxGroup({ g, onRead }: { g: Group; onRead: (ids: string[], read: boolean, until: string) => void }) {
  const tones = useStateTones();
  const unread = g.items.some((n) => n.readAt === null);
  const ids = g.items.map((n) => n.id);
  const open = () => unread && onRead(ids, true, g.lastAt);
  return (
    <li className={g.deleted ? 'inbox-group deleted' : 'inbox-group'}>
      <div className="inbox-issue">
        {g.deleted ? (
          <>
            <span className="issue-id">{g.issue.id}</span>
            <span className="inbox-summary">{g.issue.summary}</span>
            <span className="chip">{t('page.inbox.deleted')}</span>
          </>
        ) : (
          <>
            <span className="issue-id" aria-hidden="true">
              {g.issue.id}
            </span>
            <Link className="inbox-summary" to={`/issues/${g.issue.id}`} onClick={open}>
              <span className="hidden">{g.issue.id}: </span>
              {g.issue.summary}
            </Link>
            {g.issue.state ? <Badge tone={tones.get(g.issue.state) ?? null}>{g.issue.state}</Badge> : null}
          </>
        )}
        <button type="button" className="small" onClick={() => onRead(ids, unread, g.lastAt)}>
          {unread ? t('page.inbox.markRead') : t('page.inbox.markUnread')}
          <span className="hidden"> {g.issue.id}</span>
        </button>
      </div>
      <ol className="history">
        {g.items.map((n) => (
          <NotificationEntry key={n.id} n={n} />
        ))}
      </ol>
    </li>
  );
}

/**
 * Ocean's Inbox: what concerns you, by issue. Unread ones by default; opening an issue from here
 * marks what's there read, and marking read leaves what arrived after you looked.
 */
export default function InboxPage() {
  const [unreadOnly, setUnreadOnly] = useState(true);
  const list = useNotifications(unreadOnly);
  const mark = useMarkRead();
  const groups = useMemo(() => byIssue(list.data?.items ?? []), [list.data]);
  const unread = list.data?.unread ?? 0;
  const newest = groups[0]?.lastAt;
  return (
    <>
      <PageHead
        title={t('page.inbox.inbox')}
        about={t('page.inbox.whatConcernsYouIssuesAssigned')}
        meta={
          <>
            <span>{unread ? count(unread, 'page.inbox.unreadNotifications') : t('page.inbox.nothingUnread')}</span>
            <Link to="/me">{t('page.inbox.chooseWhatReachesYouBy')}</Link>
          </>
        }
        actions={
          <button type="button" disabled={!unread || mark.isPending || !newest} onClick={() => newest && mark.mutate({ all: true, until: newest })}>{t('page.inbox.markAllRead')}</button>
        }
      />
      <div className="stack">
        <div className="modes" role="group" aria-label={t('page.inbox.whichNotificationsToShow')}>
          <button type="button" aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>{t('page.inbox.unread2')}</button>
          <button type="button" aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>{t('page.inbox.all')}</button>
        </div>
        {mark.error ? <ErrorNote error={mark.error} /> : null}
        {list.isLoading ? <Loading what="loadingLine.inbox" /> : null}
        {list.error ? <ErrorNote error={list.error} /> : null}
        {list.data && !groups.length ? (
          <section className="card">
            <h2>{unreadOnly ? t('page.inbox.youReUpToDate') : t('page.inbox.nothingHereYet')}</h2>
            <p className="note">{t('page.inbox.issuesAssignedToYouMentions')}</p>
            {unreadOnly ? (
              <button type="button" className="link" onClick={() => setUnreadOnly(false)}>{t('page.inbox.showWhatYouVeRead')}</button>
            ) : null}
          </section>
        ) : null}
        {groups.length ? (
          <ol className="inbox" aria-label={unreadOnly ? t('page.inbox.unreadByIssue') : t('page.inbox.notificationsByIssue')}>
            {groups.map((g) => (
              <InboxGroup key={g.issue.id} g={g} onRead={(ids, read, until) => mark.mutate({ ids, read, ...(read ? { until } : {}) })} />
            ))}
          </ol>
        ) : null}
      </div>
    </>
  );
}
