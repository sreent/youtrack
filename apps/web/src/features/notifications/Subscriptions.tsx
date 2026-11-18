/**
 * Subscriptions (D31): to a project's new issues or every change in it, and to a saved search's
 * issues coming in or any change to one in it. Each control saves as it's changed, as the email
 * settings do.
 */
import type { Project, SavedSearch, Subscription, SubscriptionEvents } from '@a4a/shared';
import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, Said, Scroll } from '../common/bits';
import { useSubscribe, useSubscriptions, useUpdateSubscription } from './api';
import { quoted } from '../common/format';
import { t, tr } from '../../i18n';
import type { ReactNode } from 'react';

type Choice = SubscriptionEvents | 'none';

const PROJECT_CHOICES: { value: Choice; name: string; about: string }[] = [
  { value: 'none', name: t('notifications.subscriptions.nothingMore'), about: t('notifications.subscriptions.whatCallsOnYouAnd') },
  { value: 'new', name: t('notifications.subscriptions.newIssues'), about: t('notifications.subscriptions.eachIssueReportedInIt') },
  { value: 'all', name: t('notifications.subscriptions.everyChange'), about: t('notifications.subscriptions.newIssuesAndTheChanges') },
];

const SEARCH_CHOICES: { value: Choice; name: string }[] = [
  { value: 'none', name: t('notifications.subscriptions.notSubscribed') },
  { value: 'new', name: t('notifications.subscriptions.tellMeWhenAnIssue') },
  { value: 'all', name: t('notifications.subscriptions.tellMeOfAnyChange') },
];

function useSaid() {
  return useState<{ text: string; bad?: boolean } | null>(null);
}

/** A project's card: what you're told of from it, and whether by email too. */
export function ProjectSubscription({ project }: { project: Pick<Project, 'key' | 'name'> }) {
  const subs = useSubscriptions();
  const save = useSubscribe();
  const [said, setSaid] = useSaid();
  // What was just chosen reads as chosen at once; a refusal puts back what's saved.
  const [choice, setChoice] = useState<Choice | null>(null);
  const [email, setEmail] = useState<boolean | null>(null);
  const name = useId();
  if (subs.isLoading) return <Loading what="loadingLine.yourSubscription" />;
  if (subs.error || !subs.data) return <ErrorNote error={subs.error} />;
  const mine = subs.data.find((s) => s.project?.key === project.key);
  const current: Choice = choice ?? mine?.events ?? 'none';
  const byEmail = email ?? mine?.email ?? true;
  const choose = (events: Choice, withEmail = byEmail) => {
    setChoice(events);
    save.mutate(
      { project: project.key, events: events === 'none' ? null : events, email: withEmail, id: mine?.id },
      {
        onSuccess: () =>
          setSaid({
            text:
              events === 'none'
                ? t('notifications.subscriptions.youReNoLongerSubscribed', { name: project.name })
                : t('notifications.subscriptions.youReToldOf', { v: events === 'all' ? t('notifications.subscriptions.everyChangeIn') : t('notifications.subscriptions.newIssuesIn'), name: project.name, v2: withEmail ? t('notifications.subscriptions.byEmailToo2') : t('notifications.subscriptions.inYourInbox') }),
          }),
        onError: (e) => {
          setChoice(null);
          setEmail(null);
          setSaid({ text: errorText(e), bad: true });
        },
      },
    );
  };
  return (
    <div className="stack">
      <fieldset className="choice-group column" disabled={save.isPending}>
        <legend>{t('notifications.subscriptions.tellMeAbout')}</legend>
        {PROJECT_CHOICES.map((c) => (
          <label key={c.value} className="choice">
            <input type="radio" name={name} value={c.value} checked={current === c.value} onChange={() => choose(c.value)} />
            <span>
              {c.name}
              <small className="field-help">{c.about}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="choice">
        <input
          type="checkbox"
          checked={byEmail}
          disabled={save.isPending}
          onChange={(e) => {
            setEmail(e.target.checked);
            if (current !== 'none') choose(current, e.target.checked);
          }}
        />
        <span>{tr('notifications.subscriptions.byEmailToo', { el: <small className="field-help">{tr('notifications.subscriptions.yourInboxHasItEither', { t0: (c: ReactNode) => <Link to="/inbox">{c}</Link>, t1: (c: ReactNode) => <Link to="/me#notifications">{c}</Link> })}</small> })}</span>
      </label>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </div>
  );
}

/** Beside a saved search on the Issues page: whether, and what of, it tells you. */
export function SearchSubscription({ search }: { search: Pick<SavedSearch, 'id' | 'name'> }) {
  const subs = useSubscriptions();
  const save = useSubscribe();
  const [said, setSaid] = useSaid();
  const [choice, setChoice] = useState<Choice | null>(null);
  if (!subs.data) return null;
  const mine = subs.data.find((s) => s.search?.id === search.id);
  return (
    <>
      <select
        aria-label={t('notifications.subscriptions.yourSubscriptionTo', { name: search.name })}
        value={choice ?? mine?.events ?? 'none'}
        disabled={save.isPending}
        onChange={(e) => {
          const events = e.target.value as Choice;
          setChoice(events);
          save.mutate(
            { savedSearch: search.id, events: events === 'none' ? null : events, email: mine?.email ?? true, id: mine?.id },
            {
              onSuccess: () => setSaid({ text: events === 'none' ? t('notifications.subscriptions.unsubscribed') : t('notifications.subscriptions.subscribedYourInboxWillSay') }),
              onError: (err) => {
                setChoice(null);
                setSaid({ text: errorText(err), bad: true });
              },
            },
          );
        }}
      >
        {SEARCH_CHOICES.map((c) => (
          <option key={c.value} value={c.value}>
            {c.name}
          </option>
        ))}
      </select>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </>
  );
}

/** What it's to, wide enough to read: where the page is narrow, the table scrolls in its frame instead. */
function Target({ s }: { s: Subscription }) {
  if (s.project) {
    return (
      <span className="tw:block tw:min-w-40">
        <span className="item-name">
          <Link to={`/projects/${s.project.key}`}>{s.project.name}</Link>
        </span>
        <span className="item-about">{tr('notifications.subscriptions.aProject', { key: s.project.key, t0: (c: ReactNode) => <span className="mono">{c}</span> })}</span>
      </span>
    );
  }
  return (
    <span className="tw:block tw:min-w-40">
      <span className="item-name">
        <Link to={`/issues?q=${encodeURIComponent(s.search?.query ?? '')}`}>{s.search?.name}</Link>
      </span>
      <span className="item-about">{t('notifications.subscriptions.aSavedSearch')}</span>
    </span>
  );
}

/**
 * One subscription's row. Its controls show what was chosen the moment it's chosen, and follow what
 * the server keeps when that arrives: controlled by the server's copy alone, a box clicked would
 * snap back until the save came back.
 */
function SubscriptionRow({
  s,
  name,
  busy,
  ending,
  save,
  unsubscribe,
}: {
  s: Subscription;
  name: string;
  busy: boolean;
  ending: boolean;
  save: (change: { events?: SubscriptionEvents; email?: boolean }, undo: () => void) => void;
  unsubscribe: () => void;
}) {
  const [events, setEvents] = useState(s.events);
  const [email, setEmail] = useState(s.email);
  useEffect(() => setEvents(s.events), [s.events]);
  useEffect(() => setEmail(s.email), [s.email]);
  const choices = s.project
    ? [
        { value: 'new', name: t('notifications.subscriptions.newIssues') },
        { value: 'all', name: t('notifications.subscriptions.everyChange') },
      ]
    : [
        { value: 'new', name: t('notifications.subscriptions.issuesComingIn') },
        { value: 'all', name: t('notifications.subscriptions.anyChangeToOneIn') },
      ];
  return (
    <tr>
      <th scope="row" className="row-head">
        <Target s={s} />
      </th>
      <td>
        <select
          aria-label={t('notifications.subscriptions.whatTellsYouOf', { name: name })}
          value={events}
          disabled={busy}
          onChange={(e) => {
            const next = e.target.value as SubscriptionEvents;
            const was = events;
            setEvents(next);
            save({ events: next }, () => setEvents(was));
          }}
        >
          {choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.name}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          type="checkbox"
          aria-label={t('notifications.subscriptions.emailMeAbout', { name: name })}
          checked={email}
          disabled={busy}
          onChange={(e) => {
            const next = e.target.checked;
            setEmail(next);
            save({ email: next }, () => setEmail(!next));
          }}
        />
      </td>
      <td className="fit">
        <button type="button" className="small" disabled={ending} onClick={unsubscribe}>{tr('notifications.subscriptions.unsubscribeFrom', { name: name, t0: (c: ReactNode) => <span className="hidden">{c}</span> })}</button>
      </td>
    </tr>
  );
}

/** Your profile's list: each subscription, what it tells you of, whether by email, and a way out. */
export function SubscriptionList() {
  const subs = useSubscriptions();
  const update = useUpdateSubscription();
  const end = useSubscribe();
  const [said, setSaid] = useSaid();
  if (subs.isLoading) return <Loading what="loadingLine.yourSubscriptions" />;
  if (subs.error || !subs.data) return <ErrorNote error={subs.error} />;
  if (!subs.data.length) {
    return (
      <p className="note">{tr('notifications.subscriptions.youSubscribeToNothingYet', { t0: (c: ReactNode) => <Link to="/issues">{c}</Link> })}</p>
    );
  }
  const failed = (e: unknown) => setSaid({ text: errorText(e), bad: true });
  return (
    <div className="stack">
      <Scroll label={t('notifications.subscriptions.tableOfYourSubscriptions')}>
        <table className="figures middle">
          <thead>
            <tr>
              <th scope="col">{t('notifications.subscriptions.to')}</th>
              <th scope="col">{t('notifications.subscriptions.tellMeOf')}</th>
              <th scope="col">{t('notifications.subscriptions.byEmail')}</th>
              <th scope="col">
                <span className="hidden">{t('notifications.subscriptions.unsubscribe')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {subs.data.map((s) => {
              const name = s.project?.name ?? quoted(s.search?.name ?? '');
              return (
                <SubscriptionRow
                  key={s.id}
                  s={s}
                  name={name}
                  busy={update.isPending}
                  ending={end.isPending}
                  save={(change, undo) =>
                    update.mutate(
                      { id: s.id, ...change },
                      {
                        onSuccess: () => setSaid({ text: t('notifications.subscriptions.saved') }),
                        onError: (e) => {
                          undo();
                          failed(e);
                        },
                      },
                    )
                  }
                  unsubscribe={() => end.mutate({ id: s.id, events: null }, { onSuccess: () => setSaid({ text: t('notifications.subscriptions.unsubscribedFrom', { name: name }) }), onError: failed })}
                />
              );
            })}
          </tbody>
        </table>
      </Scroll>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </div>
  );
}
