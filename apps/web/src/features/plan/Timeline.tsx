/**
 * The plan over time: the Gantt against a chosen baseline, saving a new baseline, and a what-if
 * that shows where the finish would move if one task slipped, took longer or changed hands.
 */
import type { Project, Schedule, ScheduleTask, WhatIfResult } from '@a4a/shared';
import { useId, useMemo, useState } from 'react';
import { useUsers } from '../../api/queries';
import { Badge } from '../../components/Badges';
import { ErrorNote, Loading } from '../../components/States';
import { useSchedule, useWhatIf, type WhatIfChange } from './api';
import { BaselinePicker, SaveBaselineDialog, type BaselineChoice } from './Baselines';
import { dayMonth, span, workCalendar, type WorkCalendar } from './dates';
import { shift } from './format';
import { Gantt } from './Gantt';
import { ganttRows, isMilestone } from './gantt';
import { t, tr } from '../../i18n';
import type { ReactNode } from 'react';

/** The plan at a glance: when it ends, against the baseline, its critical path, what's late. */
export function Facts({ s, cal }: { s: Schedule; cal: WorkCalendar }) {
  const leaves = s.tasks.filter((t) => !t.isSummary);
  const late = leaves.filter((t) => t.late);
  const b = s.baseline;
  // A due date with little room left is at risk, though not late yet.
  const tight = leaves
    .filter((t) => !t.late && !t.issue.resolved && t.deadline)
    .map((t) => ({ t, spare: cal.between(t.finish, t.deadline!) }))
    .filter((x) => x.spare <= 2)
    .sort((a, b2) => a.spare - b2.spare)[0];
  return (
    <ul className="plan-facts">
      <li>{tr('plan.timeline.ends', { dayMonth: dayMonth(s.finish), t0: (c: ReactNode) => <strong>{c}</strong>, v: b ? (
          <>
            {', '}
            {b.finishVarianceDays === 0
              ? t('plan.timeline.asPlanned', { name: b.name })
              : t(b.finishVarianceDays > 0 ? 'plan.timeline.daysLaterThan' : 'plan.timeline.daysEarlierThan', { n: Math.abs(b.finishVarianceDays), name: b.name, dayMonth: dayMonth(b.finish) })}
          </>
        ) : null })}</li>
      <li>{tr('plan.timeline.tasksOnTheCriticalPath', { n: s.criticalPath.length })}</li>
      <li>
        {late.length ? (
          <Badge tone="bad">{late.length === 1 ? t('plan.timeline.isLate', { id: late[0]!.issue.id }) : t('plan.timeline.tasksAreLate', { length: late.length })}</Badge>
        ) : (
          t('plan.timeline.nothingIsLate')
        )}
      </li>
      {tight ? (
        <li>
          <Badge tone="warn">{tr('plan.timeline.daysToSpare', { id: tight.t.issue.id, n: tight.spare, dayMonth: dayMonth(tight.t.deadline!) })}</Badge>
        </li>
      ) : null}
    </ul>
  );
}

/** What a4a assumed to draw the plan: estimates it didn't have, and the like. */
export function Warnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <details className="plan-notes">
      <summary>{tr('plan.timeline.thingsA4aAssumed', { n: warnings.length })}</summary>
      <ul>
        {warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </details>
  );
}

type ChangeKind = 'delay' | 'estimate' | 'assignee';

function describe(change: WhatIfChange, task: ScheduleTask | undefined, people: Map<string, string>): string {
  const id = change.issue;
  if (change.delayDays !== undefined) return t('plan.timeline.ifStartsDaysLater', { id: id, n: change.delayDays });
  if (change.estimate !== undefined) return t('plan.timeline.ifIsEstimatedAt', { id: id, estimate: change.estimate });
  if (change.assignee === null) return t('plan.timeline.ifNobodyIsAssigned', { id: id });
  if (change.assignee !== undefined) return t('plan.timeline.ifDoes', { v: people.get(change.assignee) ?? change.assignee, id: id, v2: task?.assignee ? t('plan.timeline.insteadOf', { name: task.assignee.name }) : '' });
  return t('plan.timeline.ifChanges', { id: id });
}

function WhatIfResultView({ result, before, change, people, onClear }: { result: WhatIfResult; before: Schedule; change: WhatIfChange; people: Map<string, string>; onClear: () => void }) {
  const was = new Map(before.tasks.map((t) => [t.issue.id, t]));
  const after = result.after;
  const delta = result.finishDeltaDays;
  const moved = result.impacted.filter((i) => !was.get(i.issue)?.isSummary);
  const nowLate = after.tasks.filter((t) => t.late && !was.get(t.issue.id)?.late);
  const lead = describe(change, was.get(change.issue), people);
  return (
    <div className="whatif-result">
      <p className="whatif-lead">
        {lead},{' '}
        {delta === 0
          ? t('plan.timeline.thePlanStillEndsOn', { dayMonth: dayMonth(after.finish) })
          : t(delta > 0 ? 'plan.timeline.thePlanEndsDaysLater' : 'plan.timeline.thePlanEndsDaysEarlier', { n: Math.abs(delta) })}
      </p>
      <ul className="change-lines">
        <li>
          <span className="change-field">{t('plan.timeline.ends2')}</span>{' '}
          {delta === 0 ? (
            <span className="same">{tr('plan.timeline.asItIs', { dayMonth: dayMonth(after.finish) })}</span>
          ) : (
            <>
              <del>{dayMonth(result.before.finish)}</del> → <ins>{dayMonth(after.finish)}</ins>
            </>
          )}
        </li>
        {after.baseline && before.baseline && after.baseline.finishVarianceDays !== before.baseline.finishVarianceDays ? (
          <li>
            <span className="change-field">{tr('plan.timeline.against', { name: after.baseline.name })}</span> <del>{shift(before.baseline.finishVarianceDays)}</del> → <ins>{shift(after.baseline.finishVarianceDays)}</ins>
          </li>
        ) : null}
      </ul>
      {nowLate.length ? (
        <div className="badges">
          {nowLate.map((t) => (
            <Badge key={t.issue.id} tone="bad">{tr('plan.timeline.wouldBeDaysLate', { id: t.issue.id, n: (Math.max(1, workCalendar(after.calendar).between(t.deadline!, t.finish))), dayMonth: dayMonth(t.deadline!) })}</Badge>
          ))}
        </div>
      ) : null}
      {moved.length ? (
        <>
          <h3>{moved.length === 1 ? t('plan.timeline.n1TaskWouldMove') : t('plan.timeline.tasksWouldMove', { length: moved.length })}</h3>
          <ul className="levelling-list">
            {moved.map((i) => {
              const b = was.get(i.issue);
              const a = after.tasks.find((t) => t.issue.id === i.issue);
              return (
                <li key={i.issue}>
                  <span className="issue-id">{i.issue}</span>
                  <span className="levelling-what">{i.summary}</span>
                  {b && a ? (
                    <ul className="change-lines">
                      <li>
                        <del>{span(b.start, b.finish)}</del> → <ins>{span(a.start, a.finish)}</ins>
                      </li>
                    </ul>
                  ) : (
                    <span />
                  )}
                  <span className="levelling-by">{i.finishDeltaDays !== 0 ? shift(i.finishDeltaDays) : t('plan.timeline.starts', { shift: shift(i.startDeltaDays) })}</span>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="note">{t('plan.timeline.noTaskMoves')}</p>
      )}
      <p className="note cluster">{tr('plan.timeline.nothingIsSavedThisOnly', { el: <button type="button" className="link" onClick={onClear}>{t('plan.timeline.clearTheWhatIf')}</button> })}</p>
    </div>
  );
}

function WhatIfPanel({
  schedule,
  projectKey,
  baseline,
  change,
  onChange,
}: {
  schedule: Schedule;
  projectKey: string;
  baseline: string | null;
  change: WhatIfChange | null;
  onChange: (c: WhatIfChange | null) => void;
}) {
  const titleId = useId();
  const users = useUsers();
  const open = schedule.tasks.filter((t) => !t.isSummary && !t.issue.resolved);
  const [issue, setIssue] = useState(change?.issue ?? open.find((t) => t.critical && !isMilestone(t))?.issue.id ?? open[0]?.issue.id ?? '');
  const [kind, setKind] = useState<ChangeKind>('delay');
  const [delay, setDelay] = useState('2');
  const [estimate, setEstimate] = useState('');
  const [assignee, setAssignee] = useState('');
  const result = useWhatIf(projectKey, baseline, change);
  const people = useMemo(() => new Map((users.data ?? []).map((u) => [u.login, u.name])), [users.data]);
  const task = open.find((t) => t.issue.id === issue);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!issue) return;
    if (kind === 'delay') onChange({ issue, delayDays: Math.max(1, Math.min(250, Math.round(Number(delay) || 1))) });
    else if (kind === 'estimate') onChange({ issue, estimate: estimate.trim() });
    else onChange({ issue, assignee: assignee === '' ? null : assignee });
  };

  return (
    <section className="card whatif" aria-labelledby={titleId}>
      <h2 id={titleId}>{t('plan.timeline.whatIf')}</h2>
      <p className="note">{t('plan.timeline.changeOneTaskAndSee')}</p>
      {open.length === 0 ? (
        <p className="note">{t('plan.timeline.everyTaskIsDoneSo')}</p>
      ) : (
        <form className="whatif-form" onSubmit={submit}>
          <div className="form-field">
            <label htmlFor={`${titleId}-task`}>{t('plan.timeline.task')}</label>
            <select id={`${titleId}-task`} value={issue} onChange={(e) => setIssue(e.target.value)}>
              {open.map((t) => (
                <option key={t.issue.id} value={t.issue.id}>
                  {t.issue.id} {t.issue.summary}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label htmlFor={`${titleId}-kind`}>{t('plan.timeline.whatChanges')}</label>
            <select id={`${titleId}-kind`} value={kind} onChange={(e) => setKind(e.target.value as ChangeKind)}>
              <option value="delay">{t('plan.timeline.itStartsLater')}</option>
              <option value="estimate">{t('plan.timeline.itHasANewEstimate')}</option>
              <option value="assignee">{t('plan.timeline.someoneElseDoesIt')}</option>
            </select>
          </div>
          {kind === 'delay' ? (
            <div className="form-field">
              <label htmlFor={`${titleId}-value`}>{t('plan.timeline.workingDaysLater')}</label>
              <input id={`${titleId}-value`} type="number" min={1} max={250} value={delay} onChange={(e) => setDelay(e.target.value)} required />
            </div>
          ) : kind === 'estimate' ? (
            <div className="form-field">
              <label htmlFor={`${titleId}-value`}>{t('plan.timeline.newEstimate')}</label>
              <input id={`${titleId}-value`} value={estimate} onChange={(e) => setEstimate(e.target.value)} placeholder={t('plan.timeline.like3dOr1d4h')} required />
            </div>
          ) : (
            <div className="form-field">
              <label htmlFor={`${titleId}-value`}>{t('plan.timeline.givenTo')}</label>
              <select id={`${titleId}-value`} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">{t('plan.timeline.nobody')}</option>
                {(users.data ?? [])
                  .filter((u) => !u.banned && u.login !== task?.assignee?.login)
                  .map((u) => (
                    <option key={u.id} value={u.login}>
                      {u.name}
                    </option>
                  ))}
              </select>
            </div>
          )}
          <button type="submit" className="primary">{t('plan.timeline.showWhatChanges')}</button>
        </form>
      )}
      <div aria-live="polite">
        {change && result.isFetching && !result.data ? <Loading what="loadingLine.whatIf" /> : null}
        {change && result.error ? <ErrorNote error={result.error} /> : null}
        {change && result.data ? <WhatIfResultView result={result.data} before={schedule} change={change} people={people} onClear={() => onChange(null)} /> : null}
      </div>
    </section>
  );
}

export function Timeline({ project, choice }: { project: Project; choice: BaselineChoice }) {
  const key = project.key;
  const baselineId = choice.chosen?.id ?? null;
  const schedule = useSchedule(key, baselineId, choice.ready);
  const [saving, setSaving] = useState(false);
  const [whatIfOpen, setWhatIfOpen] = useState(false);
  const [change, setChange] = useState<WhatIfChange | null>(null);
  const whatIf = useWhatIf(key, baselineId, change);
  const s = schedule.data;
  const cal = useMemo(() => workCalendar(s?.calendar), [s?.calendar]);
  const rows = useMemo(() => (s ? ganttRows(s, cal, change && whatIf.data ? whatIf.data.after : null) : []), [s, cal, change, whatIf.data]);

  return (
    <div className="stack">
      <div className="cluster">
        <BaselinePicker choice={choice} />
        <button type="button" onClick={() => setSaving(true)}>{t('plan.timeline.saveABaseline')}</button>
        <button
          type="button"
          aria-expanded={whatIfOpen}
          onClick={() => {
            if (whatIfOpen) setChange(null);
            setWhatIfOpen(!whatIfOpen);
          }}
        >{t('plan.timeline.whatIf')}</button>
      </div>
      {choice.error ? <ErrorNote error={choice.error} /> : null}
      {schedule.isLoading || !choice.ready ? <Loading what="loadingLine.plan" /> : null}
      {schedule.error ? <ErrorNote error={schedule.error} /> : null}
      {s ? (
        s.tasks.length === 0 ? (
          <section className="card">
            <h2>{t('plan.timeline.nothingToPlanYet')}</h2>
            <p className="note">{tr('plan.timeline.hasNoIssuesAPlan', { name: project.name })}</p>
          </section>
        ) : (
          <>
            <Facts s={s} cal={cal} />
            {!choice.chosen && choice.ready ? (
              <p className="note">
                {choice.baselines.length
                  ? t('plan.timeline.noBaselineIsChosenSo')
                  : t('plan.timeline.thereIsNoBaselineYet')}
              </p>
            ) : null}
            {whatIfOpen ? <WhatIfPanel schedule={s} projectKey={key} baseline={baselineId} change={change} onChange={setChange} /> : null}
            <Gantt
              title={project.name}
              rows={rows}
              start={s.start}
              finish={s.finish}
              today={s.today}
              cal={cal}
              baselineName={choice.chosen?.name ?? null}
              whatIf={Boolean(change && whatIf.data)}
              scrollKey={key}
            />
            <Warnings warnings={s.warnings} />
          </>
        )
      ) : null}
      <SaveBaselineDialog projectKey={key} open={saving} onClose={() => setSaving(false)} onSaved={(b) => choice.choose(b.id)} />
    </div>
  );
}
