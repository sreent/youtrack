import type { IssueDetail, Timer, UserRef, WorkType } from '@a4a/shared';
import { formatPeriod } from '@a4a/shared/periods';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { del, get, post } from '../../api/client';
import { keys, useWorkItems } from '../../api/queries';
import { fieldOf } from '../../components/Badges';
import { ErrorNote, ErrorLine } from '../../components/States';
import { UserWho } from '../../components/Who';
import { errorText } from './api';
import { isPeriod } from './fields';

const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, in the person's own day

const clock = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

/** Your timer on the issue (D43): start, pause, stop (which logs it) or throw it away; one runs at a time. */
function TimerControl({ issue, type, onLogged, onError }: { issue: IssueDetail; type: string; onLogged: () => Promise<unknown>; onError: (e: unknown) => void }) {
  const qc = useQueryClient();
  const timers = useQuery({ queryKey: ['timers'], queryFn: () => get<Timer[]>('/timers') });
  const mine = timers.data?.find((t) => t.issue.id === issue.id) ?? null;
  const other = timers.data?.find((t) => t.running && t.issue.id !== issue.id) ?? null;
  const [now, setNow] = useState(() => Date.now());
  const [read, setRead] = useState(() => Date.now());
  useEffect(() => setRead(Date.now()), [timers.dataUpdatedAt]);
  useEffect(() => {
    if (!mine?.running) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [mine?.running]);
  const seconds = mine ? mine.elapsedSeconds + (mine.running ? Math.max(0, Math.floor((now - read) / 1000)) : 0) : 0;
  const act = async (what: 'start' | 'pause' | 'stop' | 'discard') => {
    try {
      if (what === 'discard') await del(`/issues/${issue.id}/timer`);
      else await post(`/issues/${issue.id}/timer/${what}`, what === 'stop' ? { type: type || undefined } : {});
      await qc.invalidateQueries({ queryKey: ['timers'] });
      if (what === 'stop') await onLogged();
    } catch (e) {
      onError(e);
    }
  };
  return (
    <div className={mine?.running ? 'timer running' : 'timer'} role="group" aria-label="Your timer">
      <span className="timer-time" aria-live="off">{clock(seconds)}</span>
      <span className="note">{mine ? (mine.running ? 'Running' : 'Paused') : other ? `Your timer is on ${other.issue.id}` : 'Time it as you work'}</span>
      {mine?.running ? (
        <button type="button" onClick={() => void act('pause')}>Pause</button>
      ) : (
        <button type="button" onClick={() => void act('start')}>{mine ? 'Resume' : 'Start timer'}</button>
      )}
      {mine ? (
        <>
          <button type="button" className="primary" onClick={() => void act('stop')}>Stop and log</button>
          <button type="button" className="link" onClick={() => void act('discard')}>Discard</button>
        </>
      ) : null}
    </div>
  );
}

/** Time spent on an issue, against its estimate, and a way to log some (for those who may change the issue). */
export function WorkLog({ issue, me, canEdit = true }: { issue: IssueDetail; me: UserRef | undefined; canEdit?: boolean }) {
  const id = useId();
  const qc = useQueryClient();
  const items = useWorkItems(issue.id);
  const [duration, setDuration] = useState('');
  const [date, setDate] = useState(today());
  const [description, setDescription] = useState('');
  const [type, setType] = useState('');
  const types = useQuery({ queryKey: ['projects', issue.project.key, 'work-types'], queryFn: () => get<WorkType[]>(`/projects/${issue.project.key}/work-types`), staleTime: 60_000 });
  const offered = (types.data ?? []).filter((t) => !t.archived);
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
      await post(`/issues/${issue.id}/work-items`, { duration: duration.trim(), date, description: description.trim(), type: type || undefined });
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
    <section className="card stack" aria-labelledby={`${id}-title`}>
      <div className="cluster">
        <h2 id={`${id}-title`} className="grow">
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
              {items.data.some((w) => w.type) ? <th scope="col">Type</th> : null}
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
                {items.data.some((x) => x.type) ? <td>{w.type?.name ?? ''}</td> : null}
                <td>
                  {canEdit && w.author && me && w.author.id === me.id ? (
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
      {canEdit ? <TimerControl issue={issue} type={type} onLogged={refresh} onError={(e) => setError(errorText(e))} /> : null}
      {canEdit ? (
        <form
          className="cluster"
          aria-label="Log time"
          onSubmit={(e) => {
            e.preventDefault();
            if (duration.trim()) void log();
          }}
        >
          <input className="mono" aria-label="Time spent" placeholder="1h 30m" size={8} value={duration} onChange={(e) => setDuration(e.target.value)} />
          <input type="date" aria-label="Day" value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
          <input className="grow" aria-label="What it was spent on" placeholder="What it was spent on" value={description} onChange={(e) => setDescription(e.target.value)} />
          {offered.length ? (
            <select aria-label="Work type" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">No type</option>
              {offered.map((t) => (
                <option key={t.id} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          ) : null}
          <button type="submit" disabled={!duration.trim() || busy}>
            {busy ? 'Logging…' : 'Log time'}
          </button>
        </form>
      ) : null}
      {error ? (
        <ErrorLine>{error}</ErrorLine>
      ) : null}
    </section>
  );
}
