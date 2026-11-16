/**
 * Who's booked, and how much: Ocean's LoadGrid (components/LoadGrid) over the plan's working
 * days, then levelling, proposed before anything moves. Applying sends the starts the person
 * was shown; if the plan changed meanwhile the server refuses (409), and the new proposal is
 * shown for them to decide again. Nothing is ever re-applied on its own.
 */
import type { LevelingMode, LevelingResult, Project, ResourceLoad, Schedule } from '@a4a/shared';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { Badge } from '../../components/Badges';
import { Icon } from '../../components/Icon';
import { ErrorNote, Loading } from '../../components/States';
import { Who } from '../../components/Who';
import { applyLevelling, proposeLevelling, useInvalidatePlan, useResourceLoad, useSchedule } from './api';
import { dayMonth, mondayOf, span, spanWords, weekdayName, workCalendar, type WorkCalendar } from './dates';
import { andList, days, hours, plural, shift } from './format';

type Day = ResourceLoad['resources'][number]['days'][number];

/** A quarter of the day at a time: 0 for nothing booked, 1 to 4 for up to a quarter … all of it. */
export function loadLevel(h: number, capacity: number): number {
  if (h <= 0) return 0;
  if (capacity <= 0) return 4;
  return Math.min(4, Math.max(1, Math.ceil((h / capacity) * 4 - 1e-9)));
}

function tasksTitle(day: Day): string | undefined {
  return day.tasks.length ? day.tasks.map((t) => `${t.issue} ${hours(t.hours)}`).join(', ') : undefined;
}

function LoadCell({ day, weekStart }: { day: Day; weekStart: boolean }) {
  const ws = weekStart ? ' week-start' : '';
  if (day.capacity <= 0 && day.hours <= 0) return <td className={`load-cell off${ws}`}>away</td>;
  if (day.hours > day.capacity + 0.01) {
    return (
      <td className={`load-cell over${ws}`} title={tasksTitle(day)}>
        <Icon name="clock" />
        {hours(day.hours)}
        <span>of {hours(day.capacity)}</span>
        <span className="hidden">, over</span>
      </td>
    );
  }
  return (
    <td className={`load-cell${ws}`} data-load={loadLevel(day.hours, day.capacity)} title={tasksTitle(day)}>
      {hours(day.hours)}
    </td>
  );
}

function LoadGrid({ load, children }: { load: ResourceLoad; children?: React.ReactNode }) {
  const titleId = useId();
  const aboutId = useId();
  const dates = load.resources[0]?.days.map((d) => d.date) ?? [];
  const first = dates[0];
  const last = dates[dates.length - 1];
  const when = first && last ? spanWords(first, last) : '';
  const starts = dates.map((d, i) => i > 0 && mondayOf(d) !== mondayOf(dates[i - 1]!));
  return (
    <section className="load load-box" aria-labelledby={titleId}>
      <h2 id={titleId}>Who's booked, and how much</h2>
      <p className="note" id={aboutId}>
        Hours booked against each person's capacity, {when}. Weekends are the gap between the weeks.
      </p>
      <div className="load-scroll" tabIndex={0} role="group" aria-label={`Hours booked, ${when}`}>
        <table className="load-grid" aria-labelledby={titleId} aria-describedby={aboutId}>
          <thead>
            <tr>
              <th scope="col" className="load-who">
                Person
              </th>
              {dates.map((d, i) => (
                <th key={d} scope="col" className={starts[i] ? 'week-start' : undefined}>
                  {weekdayName(d)} <span>{dayMonth(d)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {load.resources.map((r) => (
              <tr key={r.user.id}>
                <th scope="row" className="load-who">
                  <Who kind={r.user.isBot ? 'agent' : 'person'} name={r.user.isBot ? r.user.login : r.user.name} about={`${hours(r.capacityHoursPerDay)} a day`} small />
                </th>
                {r.days.map((d, i) => (
                  <LoadCell key={d.date} day={d} weekStart={Boolean(starts[i])} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="load-key" aria-label="What the shades mean">
        <li>Share of the day booked:</li>
        <li>
          <span className="load-cell" data-load="1" />a quarter
        </li>
        <li>
          <span className="load-cell" data-load="2" />
          half
        </li>
        <li>
          <span className="load-cell" data-load="3" />
          three quarters
        </li>
        <li>
          <span className="load-cell" data-load="4" />
          all of it
        </li>
        <li>
          <span className="load-cell over" />
          over it, with the hours
        </li>
      </ul>
      {load.unassignedHours > 0 ? (
        <p className="note">{hours(load.unassignedHours)} of work in these days has nobody assigned, so it isn't in the grid.</p>
      ) : null}
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Levelling
// ---------------------------------------------------------------------------

interface Proposal {
  mode: LevelingMode;
  result: LevelingResult;
  /** The load it was proposed against, to tell when the plan has moved on since. */
  basis: string;
}

type Notice = { kind: 'levelled'; text: string; detail: string } | { kind: 'changed' } | null;

function loadSignature(load: ResourceLoad | undefined): string {
  return load ? JSON.stringify(load.resources.map((r) => [r.user.id, r.days.map((d) => d.hours)])) : '';
}

function Change({ c, who }: { c: LevelingResult['changes'][number]; who: string | null }) {
  return (
    <li>
      <span className="issue-id">{c.issue}</span>
      <span className="levelling-what">
        {c.summary}
        {who ? <span className="who-about"> · {who}</span> : null}
      </span>
      <ul className="change-lines">
        <li>
          <del>{span(c.fromStart, c.fromFinish)}</del> → <ins>{span(c.toStart, c.toFinish)}</ins>
        </li>
      </ul>
      <span className="levelling-by">{shift(c.delayDays)}</span>
    </li>
  );
}

function Levelling({ projectKey, load, schedule, cal }: { projectKey: string; load: ResourceLoad; schedule: Schedule | undefined; cal: WorkCalendar }) {
  const titleId = useId();
  const [mode, setMode] = useState<LevelingMode>('within_slack');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState<'proposing' | 'levelling' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const invalidate = useInvalidatePlan(projectKey);
  const signature = loadSignature(load);
  const latestSignature = useRef(signature);
  latestSignature.current = signature;
  const asked = useRef(0);

  const propose = useCallback(
    async (m: LevelingMode) => {
      const ticket = ++asked.current;
      setBusy('proposing');
      setError(null);
      try {
        const result = await proposeLevelling(projectKey, m);
        if (ticket === asked.current) setProposal({ mode: m, result, basis: latestSignature.current });
      } catch (e) {
        if (ticket === asked.current) setError(e);
      } finally {
        if (ticket === asked.current) setBusy(null);
      }
    },
    [projectKey],
  );

  useEffect(() => {
    setNotice(null);
    void propose(mode);
  }, [mode, propose]);

  const names = useMemo(() => new Map(load.resources.map((r) => [r.user.login, r.user.name])), [load]);
  const summaries = useMemo(() => new Map((schedule?.tasks ?? []).map((t) => [t.issue.id, t.issue.summary])), [schedule]);
  const named = (ids: string[]) => andList(ids.map((id) => (summaries.has(id) ? `${id} ${summaries.get(id)}` : id)));
  const deadlines = useMemo(() => new Map((schedule?.tasks ?? []).filter((t) => t.deadline).map((t) => [t.issue.id, t.deadline!])), [schedule]);

  const level = async () => {
    if (!proposal) return;
    const { result, mode: m } = proposal;
    const moved = result.changes.filter((c) => c.movedBy === 'resources');
    setBusy('levelling');
    setError(null);
    setNotice(null);
    try {
      const done = await applyLevelling(projectKey, m, result.starts);
      const first = moved[0];
      setNotice({
        kind: 'levelled',
        text: `Levelled ${plural(moved.length, 'task')}`,
        detail:
          moved.length === 1 && first
            ? `${first.issue} now starts ${dayMonth(first.toStart)}. Its history says levelling moved it. The plan ends ${dayMonth(done.finishAfter)}.`
            : `Their start dates changed, and each one's history says levelling moved it. The plan ends ${dayMonth(done.finishAfter)}.`,
      });
      await invalidate();
      await propose(m);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // The plan changed since the person saw this proposal: show them the new one, and the
        // load it answers, to decide again.
        setNotice({ kind: 'changed' });
        void invalidate();
        await propose(m);
      } else {
        setError(e);
        setBusy(null);
      }
    }
  };

  const r = proposal?.mode === mode ? proposal.result : null;
  const moved = r ? r.changes.filter((c) => c.movedBy === 'resources') : [];
  const following = r ? r.changes.filter((c) => c.movedBy === 'dependencies') : [];
  const stale = Boolean(proposal && proposal.basis !== signature && busy === null);
  const finishMoves = r ? r.finishAfter !== r.finishBefore : false;
  const nowLate = r
    ? r.changes.filter((c) => {
        const due = deadlines.get(c.issue);
        return due !== undefined && c.toFinish > due && c.fromFinish <= due;
      })
    : [];
  const unresolved = r?.unresolved ?? [];

  let title = 'Levelling';
  let about: React.ReactNode = null;
  if (r) {
    if (r.overallocatedDaysBefore === 0 && !r.changes.length) {
      title = 'Nobody is booked over their day';
      about = 'Levelling has nothing to move.';
    } else if (!moved.length) {
      title = mode === 'within_slack' ? "Levelling can't fix this within slack" : "Levelling can't find room";
      about =
        mode === 'within_slack'
          ? `${unresolved.length ? `${named(unresolved)} can't move without moving the finish, ${dayMonth(r.finishBefore)}.` : 'No task can move within its slack.'} Allow delay to see what it would take.`
          : `${unresolved.length ? `${named(unresolved)} can't find a day with room.` : 'No task can move.'} Nothing moves.`;
    } else {
      title = `Levelling would move ${plural(moved.length, 'task')}`;
      const outcome = r.overallocatedDaysAfter === 0 ? 'So nobody is booked over their day.' : `So fewer days are over: ${r.overallocatedDaysAfter} instead of ${r.overallocatedDaysBefore}.`;
      const finish =
        mode === 'within_slack' || !finishMoves ? `The plan still ends on ${dayMonth(r.finishBefore)}.` : `The plan would end on ${dayMonth(r.finishAfter)} instead of ${dayMonth(r.finishBefore)}.`;
      about = `${outcome} ${finish} Nothing moves until you level ${moved.length === 1 ? 'it' : 'them'}.`;
    }
  }

  return (
    <section className="levelling" aria-labelledby={titleId} aria-busy={busy !== null}>
      <h3 id={titleId}>{title}</h3>
      {about ? <p className="note">{about}</p> : null}
      <div className="modes" role="group" aria-label="How far levelling may move tasks">
        <button type="button" aria-pressed={mode === 'within_slack'} onClick={() => setMode('within_slack')} disabled={busy === 'levelling'}>
          Within slack
        </button>
        <button type="button" aria-pressed={mode === 'allow_delay'} onClick={() => setMode('allow_delay')} disabled={busy === 'levelling'}>
          Allow delay
        </button>
      </div>
      <p className="note">
        {mode === 'within_slack'
          ? "Within slack, a task only moves as far as it may without moving the plan's finish."
          : 'Allowing delay, a task may move past its slack, and the finish may move with it.'}
      </p>
      {/* Always there, so what lands in it is heard: what levelling just did, or that the plan has moved on. */}
      <div className="levelling-status" aria-live="polite">
        {notice?.kind === 'levelled' ? (
          <p>
            <Badge tone="good">{notice.text}</Badge>
            <span className="note">{notice.detail}</span>
          </p>
        ) : null}
        {notice?.kind === 'changed' ? (
          <p role="alert">
            <Badge tone="warn">Nothing was levelled</Badge>
            <span className="note">The plan changed since this was proposed. This is the new proposal: check it, and level again if it still looks right.</span>
          </p>
        ) : null}
        {stale ? (
          <p>
            <span className="note">The plan has changed since this was proposed.</span>
            <button type="button" className="link" onClick={() => void propose(mode)}>
              Propose again
            </button>
          </p>
        ) : null}
      </div>
      {busy === 'proposing' && !r ? <Loading what="what levelling would move" /> : null}
      {error ? <ErrorNote error={error} /> : null}
      {moved.length ? (
        <ul className="levelling-list">
          {moved.map((c) => (
            <Change key={c.issue} c={c} who={c.assignee ? (names.get(c.assignee) ?? c.assignee) : null} />
          ))}
        </ul>
      ) : null}
      {following.length ? (
        <details>
          <summary>
            {following.length === 1 ? '1 more task follows its predecessors, and moves with them' : `${following.length} more tasks follow their predecessors, and move with them`}
          </summary>
          <ul className="levelling-list">
            {following.map((c) => (
              <Change key={c.issue} c={c} who={c.assignee ? (names.get(c.assignee) ?? c.assignee) : null} />
            ))}
          </ul>
        </details>
      ) : null}
      {r && moved.length && finishMoves ? (
        <ul className="change-lines">
          <li>
            <span className="change-field">The plan ends:</span> <del>{dayMonth(r.finishBefore)}</del> → <ins>{dayMonth(r.finishAfter)}</ins>
          </li>
        </ul>
      ) : null}
      {nowLate.length ? (
        <div className="badges">
          {nowLate.map((c) => (
            <Badge key={c.issue} tone="bad">
              {c.issue} would be {days(Math.max(1, cal.between(deadlines.get(c.issue)!, c.toFinish)))} late: it's due {dayMonth(deadlines.get(c.issue)!)}
            </Badge>
          ))}
        </div>
      ) : null}
      {r && moved.length && unresolved.length ? (
        <p className="note">
          {named(unresolved)} can't be levelled {mode === 'within_slack' ? 'within slack' : 'at all'}, so {unresolved.length === 1 ? 'it stays' : 'they stay'} where {unresolved.length === 1 ? 'it is' : 'they are'}.
        </p>
      ) : null}
      {r && moved.length ? (
        <div className="levelling-actions">
          <button type="button" className="primary" onClick={() => void level()} disabled={busy !== null || stale}>
            {busy === 'levelling' ? 'Levelling…' : `Level ${plural(moved.length, 'task')}`}
          </button>
          <p className="note">
            {mode === 'within_slack'
              ? `${moved.length === 1 ? 'It moves' : 'Each moves'} within ${moved.length === 1 ? 'its' : 'its'} slack, and ${moved.length === 1 ? 'its' : 'each one’s'} history says levelling moved it.`
              : `${moved.length === 1 ? 'Its start date changes' : 'Their start dates change'}, and the history says levelling moved ${moved.length === 1 ? 'it' : 'them'}; the tasks after ${moved.length === 1 ? 'it' : 'them'} follow.`}
          </p>
        </div>
      ) : null}
    </section>
  );
}

export function Resources({ project }: { project: Project }) {
  const key = project.key;
  const load = useResourceLoad(key);
  const schedule = useSchedule(key, null);
  const cal = useMemo(() => workCalendar(schedule.data?.calendar ?? project.settings.plan), [schedule.data?.calendar, project.settings.plan]);
  if (load.isLoading) return <Loading what="who's booked" />;
  if (load.error || !load.data) return <ErrorNote error={load.error} />;
  const l = load.data;
  if (!l.resources.length || !l.resources[0]?.days.length) {
    return (
      <section className="card">
        <h2>Nobody is booked yet</h2>
        <p className="note">
          {l.resources.length
            ? `${project.name} has no work left to place from today on.`
            : `Nobody is assigned to ${project.name}'s tasks, so there's no load to show.`}{' '}
          Load comes from each task's estimate, spread over its working days, against its assignee's hours a day.
        </p>
      </section>
    );
  }
  return (
    <div>
      <LoadGrid load={l}>
        <Levelling projectKey={key} load={l} schedule={schedule.data} cal={cal} />
      </LoadGrid>
    </div>
  );
}
