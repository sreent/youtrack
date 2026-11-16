/**
 * Subscriptions (D31): to a project's new issues or every change in it, and to a saved search's
 * issues coming in or any change to one in it. Each control saves as it's changed, as the email
 * settings do.
 */
import type { Project, SavedSearch, Subscription, SubscriptionEvents } from '@a4a/shared';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, Said, Scroll } from '../common/bits';
import { useSubscribe, useSubscriptions, useUpdateSubscription } from './api';

type Choice = SubscriptionEvents | 'none';

const PROJECT_CHOICES: { value: Choice; name: string; about: string }[] = [
  { value: 'none', name: 'Nothing more', about: 'What calls on you, and the issues you watch, reach you anyway.' },
  { value: 'new', name: 'New issues', about: 'Each issue reported in it.' },
  { value: 'all', name: 'Every change', about: 'New issues, and the changes, comments, links and files on all of them.' },
];

const SEARCH_CHOICES: { value: Choice; name: string }[] = [
  { value: 'none', name: 'Not subscribed' },
  { value: 'new', name: 'Tell me when an issue comes into it' },
  { value: 'all', name: 'Tell me of any change to one in it' },
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
  if (subs.isLoading) return <Loading what="your subscription" />;
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
                ? `You're no longer subscribed to ${project.name}.`
                : `You're told of ${events === 'all' ? 'every change in' : 'new issues in'} ${project.name}${withEmail ? ', by email too' : ', in your inbox'}.`,
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
        <legend>Tell me about</legend>
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
        <span>
          By email too
          <small className="field-help">
            Your <Link to="/inbox">inbox</Link> has it either way. Choosing “Never” for email on <Link to="/me#notifications">your profile</Link> stops this too.
          </small>
        </span>
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
        aria-label={`Your subscription to “${search.name}”`}
        value={choice ?? mine?.events ?? 'none'}
        disabled={save.isPending}
        onChange={(e) => {
          const events = e.target.value as Choice;
          setChoice(events);
          save.mutate(
            { savedSearch: search.id, events: events === 'none' ? null : events, email: mine?.email ?? true, id: mine?.id },
            {
              onSuccess: () => setSaid({ text: events === 'none' ? 'Unsubscribed.' : 'Subscribed: your inbox will say.' }),
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
        <span className="item-about">
          <span className="mono">{s.project.key}</span> · a project
        </span>
      </span>
    );
  }
  return (
    <span className="tw:block tw:min-w-40">
      <span className="item-name">
        <Link to={`/issues?q=${encodeURIComponent(s.search?.query ?? '')}`}>{s.search?.name}</Link>
      </span>
      <span className="item-about">a saved search</span>
    </span>
  );
}

/** Your profile's list: each subscription, what it tells you of, whether by email, and a way out. */
export function SubscriptionList() {
  const subs = useSubscriptions();
  const update = useUpdateSubscription();
  const end = useSubscribe();
  const [said, setSaid] = useSaid();
  if (subs.isLoading) return <Loading what="your subscriptions" />;
  if (subs.error || !subs.data) return <ErrorNote error={subs.error} />;
  if (!subs.data.length) {
    return (
      <p className="note">
        You subscribe to nothing yet. On a project's page you can be told of its new issues, or of every change in it; on the <Link to="/issues">Issues</Link> page, of an
        issue coming into a saved search.
      </p>
    );
  }
  const failed = (e: unknown) => setSaid({ text: errorText(e), bad: true });
  return (
    <div className="stack">
      <Scroll label="Table of your subscriptions">
        <table className="figures middle">
          <thead>
            <tr>
              <th scope="col">To</th>
              <th scope="col">Tell me of</th>
              <th scope="col">By email</th>
              <th scope="col">
                <span className="hidden">Unsubscribe</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {subs.data.map((s) => {
              const name = s.project?.name ?? `“${s.search?.name ?? ''}”`;
              const choices = s.project
                ? [
                    { value: 'new', name: 'New issues' },
                    { value: 'all', name: 'Every change' },
                  ]
                : [
                    { value: 'new', name: 'Issues coming in' },
                    { value: 'all', name: 'Any change to one in it' },
                  ];
              return (
                <tr key={s.id}>
                  <th scope="row" className="row-head">
                    <Target s={s} />
                  </th>
                  <td>
                    <select
                      aria-label={`What ${name} tells you of`}
                      value={s.events}
                      disabled={update.isPending}
                      onChange={(e) => update.mutate({ id: s.id, events: e.target.value as SubscriptionEvents }, { onSuccess: () => setSaid({ text: 'Saved.' }), onError: failed })}
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
                      aria-label={`Email me about ${name}`}
                      checked={s.email}
                      disabled={update.isPending}
                      onChange={(e) => update.mutate({ id: s.id, email: e.target.checked }, { onSuccess: () => setSaid({ text: 'Saved.' }), onError: failed })}
                    />
                  </td>
                  <td className="fit">
                    <button
                      type="button"
                      className="small"
                      disabled={end.isPending}
                      onClick={() => end.mutate({ id: s.id, events: null }, { onSuccess: () => setSaid({ text: `Unsubscribed from ${name}.` }), onError: failed })}
                    >
                      Unsubscribe<span className="hidden"> from {name}</span>
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Scroll>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </div>
  );
}
