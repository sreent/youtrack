import { formatPeriod, type IssueDetail, type UserRef } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { del, post } from '../../api/client';
import { keys, useWorkItems } from '../../api/queries';
import { fieldOf } from '../../components/Badges';
import { ErrorNote } from '../../components/States';
import { UserWho } from '../../components/Who';
import { errorText } from './api';
import { isPeriod } from './fields';

const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, in the person's own day

/** Time spent on an issue, against its estimate, and a way to log some. */
export function WorkLog({ issue, me }: { issue: IssueDetail; me: UserRef | undefined }) {
  const id = useId();
  const qc = useQueryClient();
  const items = useWorkItems(issue.id);
  const [duration, setDuration] = useState('');
  const [date, setDate] = useState(today());
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const estimate = fieldOf(issue.fields, 'Estimation')?.value;
  const estimated = isPeriod(estimate) ? estimate : null;

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: keys.issueSub(issue.id, 'work') }),
      qc.invalidateQueries({ queryKey: keys.issue(issue.id) }),
      qc.invalidateQueries({ queryKey: keys.issueSub(issue.id, 'activity') }),
      qc.invalidateQueries({ queryKey: ['plan'] }),
    ]);

  const log = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/issues/${issue.id}/work-items`, { duration: duration.trim(), date, description: description.trim() });
      setDuration('');
      setDescription('');
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card a4-stack" aria-labelledby={`${id}-title`}>
      <div className="a4-row">
        <h2 id={`${id}-title`} className="a4-grow">
          Time spent
        </h2>
        <span className="note">
          <span className="mono">{formatPeriod(issue.spentMinutes) || '0m'}</span>
          {estimated ? (
            <>
              {' '}
              of <span className="mono">{estimated.presentation}</span> estimated
            </>
          ) : null}
        </span>
      </div>
      {items.error ? <ErrorNote error={items.error} /> : null}
      {items.data && items.data.length ? (
        <table className="figures">
          <caption className="hidden">Work logged on {issue.id}</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Who</th>
              <th scope="col" className="num">
                Time
              </th>
              <th scope="col">What</th>
              <th scope="col">
                <span className="hidden">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.data.map((w) => (
              <tr key={w.id}>
                <td>{new Date(`${w.date}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</td>
                <td>
                  <UserWho user={w.author} small />
                </td>
                <td className="num mono">{formatPeriod(w.minutes)}</td>
                <td>{w.description}</td>
                <td>
                  {w.author && me && w.author.id === me.id ? (
                    <button
                      type="button"
                      className="link"
                      aria-label={`Remove ${formatPeriod(w.minutes)} logged on ${w.date}`}
                      onClick={async () => {
                        try {
                          await del(`/work-items/${w.id}`);
                          await refresh();
                        } catch (e) {
                          setError(errorText(e));
                        }
                      }}
                    >
                      Remove
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="note">No time logged yet.</p>
      )}
      <form
        className="a4-row"
        aria-label="Log time"
        onSubmit={(e) => {
          e.preventDefault();
          if (duration.trim()) void log();
        }}
      >
        <input className="mono" aria-label="Time spent" placeholder="1h 30m" size={8} value={duration} onChange={(e) => setDuration(e.target.value)} />
        <input type="date" aria-label="Day" value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
        <input className="a4-grow" aria-label="What it was spent on" placeholder="What it was spent on" value={description} onChange={(e) => setDescription(e.target.value)} />
        <button type="submit" disabled={!duration.trim() || busy}>
          {busy ? 'Logging…' : 'Log time'}
        </button>
      </form>
      {error ? (
        <p className="a4-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
