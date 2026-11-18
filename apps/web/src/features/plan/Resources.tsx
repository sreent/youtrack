/**
 * Who's booked, and how much: Ocean's LoadGrid (components/LoadGrid) over the plan's working
 * days, then levelling, proposed before anything moves. Applying sends the starts the person
 * was shown; if the plan changed meanwhile the server refuses (409), and the new proposal is
 * shown for them to decide again. Nothing is ever re-applied on its own.
 *
 * The grid's days are each person's choice, kept for them (D36); a day someone is away says so,
 * and half a day away is dashed, with what's left of the day.
 */
import type { LevelingMode, LevelingResult, Project, ResourceLoad, Schedule } from '@a4a/shared';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { useMe } from '../../api/queries';
import { Badge } from '../../components/Badges';
import { Icon } from '../../components/Icon';
import { ErrorNote, Loading } from '../../components/States';
import { Who } from '../../components/Who';
import { usePreferences, useSetLoadWindow } from '../away/api';
import { DaysAway } from '../away/DaysAway';
import { FormField } from '../common/bits';
import { applyLevelling, proposeLevelling, useInvalidatePlan, useResourceLoad, useSchedule } from './api';
import { dayMonth, mondayOf, span, weekdayName, workCalendar, type WorkCalendar } from './dates';
import { andList, hours, shift } from './format';
import { WindowChoice, windowRange } from './LoadWindow';
import { t, tr } from '../../i18n';

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
  // A day someone is away says so; a day of no hours that isn't one is "off". Neither says why.
  if (day.capacity <= 0 && day.hours <= 0) return <td className={`load-cell off${ws}`}>{day.away === 'day' ? t('plan.resources.cellAway') : t('plan.resources.cellOff')}</td>;
  const half = day.away === 'morning' || day.away === 'afternoon' ? day.away : null;
  const part = half ? ' part' : '';
  if (day.hours > day.capacity + 0.01) {
    return (
      <td className={`load-cell over${part}${ws}`} title={tasksTitle(day)}>
        <Icon name="clock" />
        {hours(day.hours)}
        <span>{tr('plan.resources.of', { hours: hours(day.capacity) })}</span>
        <span className="hidden">{t('plan.resources.over', { away: half ?? 'no' })}</span>
      </td>
    );
  }
  if (half) {
    return (
      <td className={`load-cell${part}${ws}`} data-load={loadLevel(day.hours, day.capacity)} title={tasksTitle(day)}>
        {hours(day.hours)}
        <span>{tr('plan.resources.of', { hours: hours(day.capacity) })}</span>
        <span className="hidden">{t('plan.resources.awayHalf', { away: half })}</span>
      </td>
    );
  }
  return (
    <td className={`load-cell${ws}`} data-load={loadLevel(day.hours, day.capacity)} title={tasksTitle(day)}>
      {hours(day.hours)}
    </td>
  );
}

function LoadGrid({ load, choice, children }: { load: ResourceLoad; choice?: React.ReactNode; children?: React.ReactNode }) {
  const titleId = useId();
  const aboutId = useId();
  const dates = load.resources[0]?.days.map((d) => d.date) ?? [];
  const first = dates[0];
  const last = dates[dates.length - 1];
  const when = first && last ? span(first, last) : '';
  const starts = dates.map((d, i) => i > 0 && mondayOf(d) !== mondayOf(dates[i - 1]!));
  const away = load.resources.some((r) => r.days.some((d) => d.away));
  return (
    <section className="load load-box" aria-labelledby={titleId}>
      <h2 id={titleId}>{t('plan.resources.whoSBookedAndHow')}</h2>
      {choice}
      <p className="note" id={aboutId}>{tr('plan.resources.hoursBookedAgainstEachPerson', { when: when, v: away ? t('plan.resources.aDaySomeoneIsAway') : null })}</p>
      <div className="load-scroll" tabIndex={0} role="group" aria-label={t('plan.resources.hoursBooked', { when: when })}>
        <table className="load-grid" aria-labelledby={titleId} aria-describedby={aboutId}>
          <thead>
            <tr>
              <th scope="col" className="load-who">{t('plan.resources.person')}</th>
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
                  <Who kind={r.user.isBot ? 'agent' : 'person'} name={r.user.isBot ? r.user.login : r.user.name} about={t('plan.resources.aDay', { hours: hours(r.capacityHoursPerDay) })} small />
                </th>
                {r.days.map((d, i) => (
                  <LoadCell key={d.date} day={d} weekStart={Boolean(starts[i])} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="load-key" aria-label={t('plan.resources.whatTheShadesMean')}>
        <li>{t('plan.resources.shareOfTheDayBooked')}</li>
        <li>{tr('plan.resources.aQuarter', { el: <span className="load-cell" data-load="1" /> })}</li>
        <li>{tr('plan.resources.half', { el: <span className="load-cell" data-load="2" /> })}</li>
        <li>{tr('plan.resources.threeQuarters', { el: <span className="load-cell" data-load="3" /> })}</li>
        <li>{tr('plan.resources.allOfIt', { el: <span className="load-cell" data-load="4" /> })}</li>
        <li>{tr('plan.resources.overItWithTheHours', { el: <span className="load-cell over" /> })}</li>
        {away ? (
          <>
            <li>{tr('plan.resources.away', { el: <span className="load-cell off" /> })}</li>
            <li>{tr('plan.resources.halfADayAway', { el: <span className="load-cell part" data-load="0" /> })}</li>
          </>
        ) : null}
      </ul>
      {load.unassignedHours > 0 ? (
        <p className="note">{tr('plan.resources.ofWorkInTheseDays', { hours: hours(load.unassignedHours) })}</p>
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
      const kept = done.keepsStart ? t('plan.resources.itsStartIsSetTo', { dayMonth: dayMonth(done.keepsStart) }) : '';
      setNotice({
        kind: 'levelled',
        text: t('plan.resources.levelledTasks', { n: moved.length }),
        detail:
          (moved.length === 1 && first
            ? t('plan.resources.nowStartsItsHistorySays', { issue: first.issue, dayMonth: dayMonth(first.toStart), dayMonth2: dayMonth(done.finishAfter) })
            : t('plan.resources.theirStartDatesChangedAnd', { dayMonth: dayMonth(done.finishAfter) })) + kept,
      });
      await invalidate();
      await propose(m);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // The plan changed since the person saw this proposal: show them the new one, and the
        // load it answers, to decide again. The load is read first, so the new proposal isn't
        // taken for one the plan has moved on from when the load lands after it.
        setNotice({ kind: 'changed' });
        await invalidate();
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

  let title = t('plan.resources.levelling2');
  let about: React.ReactNode = null;
  if (r) {
    if (r.overallocatedDaysBefore === 0 && !r.changes.length) {
      title = t('plan.resources.nobodyIsBookedOverTheir');
      about = t('plan.resources.levellingHasNothingToMove');
    } else if (!moved.length) {
      title = mode === 'within_slack' ? t('plan.resources.levellingCanTFixThis') : t('plan.resources.levellingCanTFindRoom');
      about =
        mode === 'within_slack'
          ? t('plan.resources.allowDelayToSeeWhat', { v: unresolved.length ? t('plan.resources.canTMoveWithoutMoving', { named: named(unresolved), dayMonth: dayMonth(r.finishBefore) }) : t('plan.resources.noTaskCanMoveWithin') })
          : t('plan.resources.nothingMoves', { v: unresolved.length ? t('plan.resources.canTFindADay', { named: named(unresolved) }) : t('plan.resources.noTaskCanMove') });
    } else {
      title = t('plan.resources.levellingWouldMoveTasks', { n: moved.length });
      const outcome = r.overallocatedDaysAfter === 0 ? t('plan.resources.soNobodyIsBookedOver') : t('plan.resources.soFewerDaysAreOver', { overallocatedDaysAfter: r.overallocatedDaysAfter, overallocatedDaysBefore: r.overallocatedDaysBefore });
      const finish =
        mode === 'within_slack' || !finishMoves ? t('plan.resources.thePlanStillEndsOn', { dayMonth: dayMonth(r.finishBefore) }) : t('plan.resources.thePlanWouldEndOn', { dayMonth: dayMonth(r.finishAfter), dayMonth2: dayMonth(r.finishBefore) });
      about = t('plan.resources.nothingMovesUntilYouLevelThem', { outcome: outcome, finish: finish, n: moved.length });
    }
  }

  return (
    <section className="levelling" aria-labelledby={titleId} aria-busy={busy !== null}>
      <h3 id={titleId}>{title}</h3>
      {about ? <p className="note">{about}</p> : null}
      <div className="modes" role="group" aria-label={t('plan.resources.howFarLevellingMayMove')}>
        <button type="button" aria-pressed={mode === 'within_slack'} onClick={() => setMode('within_slack')} disabled={busy === 'levelling'}>{t('plan.resources.withinSlack')}</button>
        <button type="button" aria-pressed={mode === 'allow_delay'} onClick={() => setMode('allow_delay')} disabled={busy === 'levelling'}>{t('plan.resources.allowDelay')}</button>
      </div>
      <p className="note">
        {mode === 'within_slack'
          ? t('plan.resources.withinSlackATaskOnly')
          : t('plan.resources.allowingDelayATaskMay')}
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
            <Badge tone="warn">{t('plan.resources.nothingWasLevelled')}</Badge>
            <span className="note">{t('plan.resources.thePlanChangedSinceThis')}</span>
          </p>
        ) : null}
        {stale ? (
          <p>
            <span className="note">{t('plan.resources.thePlanHasChangedSince')}</span>
            <button type="button" className="link" onClick={() => void propose(mode)}>{t('plan.resources.proposeAgain')}</button>
          </p>
        ) : null}
      </div>
      {busy === 'proposing' && !r ? <Loading what="loadingLine.levelling" /> : null}
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
            {following.length === 1 ? t('plan.resources.n1MoreTaskFollowsIts') : t('plan.resources.moreTasksFollowTheirPredecessors', { length: following.length })}
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
            <span className="change-field">{t('plan.resources.thePlanEnds')}</span> <del>{dayMonth(r.finishBefore)}</del> → <ins>{dayMonth(r.finishAfter)}</ins>
          </li>
        </ul>
      ) : null}
      {r && moved.length && r.keepsStart ? (
        <p className="note">{tr('plan.resources.thePlanHasNoStart', { dayMonth: dayMonth(r.keepsStart) })}</p>
      ) : null}
      {nowLate.length ? (
        <div className="badges">
          {nowLate.map((c) => (
            <Badge key={c.issue} tone="bad">{tr('plan.resources.wouldBeDaysLate', { issue: c.issue, n: (Math.max(1, cal.between(deadlines.get(c.issue)!, c.toFinish))), dayMonth: dayMonth(deadlines.get(c.issue)!) })}</Badge>
          ))}
        </div>
      ) : null}
      {r && moved.length && unresolved.length ? (
        <p className="note">{tr(mode === 'within_slack' ? 'plan.resources.cantBeLevelledWithinSlack' : 'plan.resources.cantBeLevelledAtAll', { named: named(unresolved), n: unresolved.length })}</p>
      ) : null}
      {r && moved.length ? (
        <div className="levelling-actions">
          <button type="button" className="primary" onClick={() => void level()} disabled={busy !== null || stale}>
            {busy === 'levelling' ? t('plan.resources.levelling') : t('plan.resources.levelTasks', { n: moved.length })}
          </button>
          <p className="note">
            {mode === 'within_slack'
              ? t('plan.resources.movesWithinSlackHistorySays', { n: moved.length })
              : t('plan.resources.startDatesChangeHistorySays', { n: moved.length })}
          </p>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Days away for the plan's people, in the browser's own dialog: your own, and, as the project's
 * manager, anyone's in the grid. Their work moves as soon as they're saved.
 */
function DaysAwayDialog({ people, meLogin, open, onClose }: { people: { login: string; name: string }[]; meLogin: string; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [login, setLogin] = useState(people.find((p) => p.login === meLogin)?.login ?? people[0]?.login ?? '');
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  const person = people.find((p) => p.login === login) ?? people[0];
  return (
    <dialog ref={ref} className="dialog wide" aria-labelledby={titleId} onClose={onClose}>
      <h2 id={titleId}>{t('plan.resources.daysAway')}</h2>
      <p>{t('plan.resources.plansSkipAPersonS')}</p>
      {open && person ? (
        <div className="stack">
          {people.length > 1 ? (
            <FormField label={t('plan.resources.whose')}>
              {(id) => (
                <select id={id} value={person.login} onChange={(e) => setLogin(e.target.value)}>
                  {people.map((p) => (
                    <option key={p.login} value={p.login}>
                      {p.login === meLogin ? t('plan.resources.you', { name: p.name }) : p.name}
                    </option>
                  ))}
                </select>
              )}
            </FormField>
          ) : null}
          <DaysAway person={person} you={person.login === meLogin} canEnter />
        </div>
      ) : null}
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>{t('plan.resources.done')}</button>
      </div>
    </dialog>
  );
}

export function Resources({ project }: { project: Project }) {
  const key = project.key;
  const me = useMe();
  const prefs = usePreferences();
  const setWindow = useSetLoadWindow();
  const chosen = prefs.data?.loadWindow ?? null;
  const range = useMemo(() => windowRange(chosen), [chosen]);
  // The person's window first, so the grid isn't read twice: once for the plan's days, once for theirs.
  const load = useResourceLoad(key, range, !prefs.isLoading);
  const schedule = useSchedule(key, null);
  const cal = useMemo(() => workCalendar(schedule.data?.calendar ?? project.settings.plan), [schedule.data?.calendar, project.settings.plan]);
  const [awayOpen, setAwayOpen] = useState(false);
  if (prefs.isLoading || load.isLoading) return <Loading what="loadingLine.booked" />;
  if (load.error || !load.data) return <ErrorNote error={load.error} />;
  const l = load.data;
  const choice = <WindowChoice chosen={chosen} busy={setWindow.isPending} onChoose={(w) => setWindow.mutate(w)} />;

  // Whose days away this page may enter: your own, or, as its manager, everyone's in the grid.
  const meLogin = me.data?.login ?? '';
  const writes = Boolean(me.data?.auth.scopes.includes('write'));
  const people = l.resources.filter((r) => !r.user.isBot).map((r) => ({ login: r.user.login, name: r.user.name }));
  const enterable = !writes ? [] : project.access?.manage ? people : people.filter((p) => p.login === meLogin);
  const awayButton = enterable.length ? (
    <button type="button" onClick={() => setAwayOpen(true)}>{t('plan.resources.daysAway')}</button>
  ) : null;
  // Outside Ocean's layout rows, whose children lose their margins: the dialog centres itself by its own.
  const awayDialog = enterable.length ? <DaysAwayDialog people={enterable} meLogin={meLogin} open={awayOpen} onClose={() => setAwayOpen(false)} /> : null;

  if (!l.resources.length) {
    return (
      <section className="card">
        <h2>{t('plan.resources.nobodyIsBookedYet')}</h2>
        <p className="note">{tr('plan.resources.nobodyIsAssignedToS', { name: project.name })}</p>
      </section>
    );
  }
  if (!l.resources[0]?.days.length) {
    return (
      <section className="card stack">
        <h2>{t('plan.resources.noWorkingDaysToShow')}</h2>
        {choice}
        <p className="note">{tr('plan.resources.loadComesFromEachTask', { v: range.from ? t('plan.resources.theseDaysHaveNoWorking') : t('plan.resources.hasNoWorkLeftTo', { name: project.name }) })}</p>
      </section>
    );
  }
  return (
    <div>
      <LoadGrid
        load={l}
        choice={
          <div className="cluster">
            {choice}
            <span className="grow" />
            {awayButton}
          </div>
        }
      >
        <Levelling projectKey={key} load={l} schedule={schedule.data} cal={cal} />
      </LoadGrid>
      {awayDialog}
    </div>
  );
}
