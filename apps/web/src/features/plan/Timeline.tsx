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
import { days, plural, shift } from './format';
import { Gantt } from './Gantt';
import { ganttRows, isMilestone } from './gantt';

/** The plan at a glance: when it ends, against the baseline, its critical path, what's late. */
function Facts({ s, cal }: { s: Schedule; cal: WorkCalendar }) {
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
      <li>
        Ends <strong>{dayMonth(s.finish)}</strong>
        {b ? (
          <>
            {', '}
            {b.finishVarianceDays === 0
              ? `as ${b.name} planned`
              : `${days(Math.abs(b.finishVarianceDays))} ${b.finishVarianceDays > 0 ? 'later' : 'earlier'} than ${b.name} (${dayMonth(b.finish)})`}
          </>
        ) : null}
      </li>
      <li>{plural(s.criticalPath.length, 'task')} on the critical path</li>
      <li>
        {late.length ? (
          <Badge tone="bad">{late.length === 1 ? `${late[0]!.issue.id} is late` : `${late.length} tasks are late`}</Badge>
        ) : (
          'Nothing is late'
        )}
      </li>
      {tight ? (
        <li>
          <Badge tone="warn">
            {tight.t.issue.id} has {tight.spare === 0 ? 'no day' : days(tight.spare)} to spare before it's due, {dayMonth(tight.t.deadline!)}
          </Badge>
        </li>
      ) : null}
    </ul>
  );
}

/** What a4a assumed to draw the plan: estimates it didn't have, and the like. */
function Warnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <details className="plan-notes">
      <summary>{plural(warnings.length, 'thing')} a4a assumed to draw this plan</summary>
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
  if (change.delayDays !== undefined) return `If ${id} starts ${days(change.delayDays)} later`;
  if (change.estimate !== undefined) return `If ${id} is estimated at ${change.estimate}`;
  if (change.assignee === null) return `If nobody is assigned ${id}`;
  if (change.assignee !== undefined) return `If ${people.get(change.assignee) ?? change.assignee} does ${id}${task?.assignee ? ` instead of ${task.assignee.name}` : ''}`;
  return `If ${id} changes`;
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
          ? `the plan still ends on ${dayMonth(after.finish)}.`
          : `the plan ends ${days(Math.abs(delta))} ${delta > 0 ? 'later' : 'earlier'}.`}
      </p>
      <ul className="change-lines">
        <li>
          <span className="change-field">Ends:</span>{' '}
          {delta === 0 ? (
            <span className="same">{dayMonth(after.finish)}, as it is</span>
          ) : (
            <>
              <del>{dayMonth(result.before.finish)}</del> → <ins>{dayMonth(after.finish)}</ins>
            </>
          )}
        </li>
        {after.baseline && before.baseline && after.baseline.finishVarianceDays !== before.baseline.finishVarianceDays ? (
          <li>
            <span className="change-field">Against {after.baseline.name}:</span> <del>{shift(before.baseline.finishVarianceDays)}</del> → <ins>{shift(after.baseline.finishVarianceDays)}</ins>
          </li>
        ) : null}
      </ul>
      {nowLate.length ? (
        <div className="badges">
          {nowLate.map((t) => (
            <Badge key={t.issue.id} tone="bad">
              {t.issue.id} would be {days(Math.max(1, workCalendar(after.calendar).between(t.deadline!, t.finish)))} late: it's due {dayMonth(t.deadline!)}
            </Badge>
          ))}
        </div>
      ) : null}
      {moved.length ? (
        <>
          <h3>{moved.length === 1 ? '1 task would move' : `${moved.length} tasks would move`}</h3>
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
                  <span className="levelling-by">{i.finishDeltaDays !== 0 ? shift(i.finishDeltaDays) : `starts ${shift(i.startDeltaDays)}`}</span>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="note">No task moves.</p>
      )}
      <p className="note cluster">
        Nothing is saved: this only shows what would happen.
        <button type="button" className="link" onClick={onClear}>
          Clear the what-if
        </button>
      </p>
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
      <h2 id={titleId}>What if…</h2>
      <p className="note">Change one task and see where the finish would go. Nothing is saved.</p>
      {open.length === 0 ? (
        <p className="note">Every task is done, so there's nothing left to change.</p>
      ) : (
        <form className="whatif-form" onSubmit={submit}>
          <div className="form-field">
            <label htmlFor={`${titleId}-task`}>Task</label>
            <select id={`${titleId}-task`} value={issue} onChange={(e) => setIssue(e.target.value)}>
              {open.map((t) => (
                <option key={t.issue.id} value={t.issue.id}>
                  {t.issue.id} {t.issue.summary}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label htmlFor={`${titleId}-kind`}>What changes</label>
            <select id={`${titleId}-kind`} value={kind} onChange={(e) => setKind(e.target.value as ChangeKind)}>
              <option value="delay">It starts later</option>
              <option value="estimate">It has a new estimate</option>
              <option value="assignee">Someone else does it</option>
            </select>
          </div>
          {kind === 'delay' ? (
            <div className="form-field">
              <label htmlFor={`${titleId}-value`}>Working days later</label>
              <input id={`${titleId}-value`} type="number" min={1} max={250} value={delay} onChange={(e) => setDelay(e.target.value)} required />
            </div>
          ) : kind === 'estimate' ? (
            <div className="form-field">
              <label htmlFor={`${titleId}-value`}>New estimate</label>
              <input id={`${titleId}-value`} value={estimate} onChange={(e) => setEstimate(e.target.value)} placeholder="like 3d or 1d 4h" required />
            </div>
          ) : (
            <div className="form-field">
              <label htmlFor={`${titleId}-value`}>Given to</label>
              <select id={`${titleId}-value`} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">Nobody</option>
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
          <button type="submit" className="primary">
            Show what changes
          </button>
        </form>
      )}
      <div aria-live="polite">
        {change && result.isFetching && !result.data ? <Loading what="the what-if" /> : null}
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
        <button type="button" onClick={() => setSaving(true)}>
          Save a baseline
        </button>
        <button
          type="button"
          aria-expanded={whatIfOpen}
          onClick={() => {
            if (whatIfOpen) setChange(null);
            setWhatIfOpen(!whatIfOpen);
          }}
        >
          What if…
        </button>
      </div>
      {choice.error ? <ErrorNote error={choice.error} /> : null}
      {schedule.isLoading || !choice.ready ? <Loading what="the plan" /> : null}
      {schedule.error ? <ErrorNote error={schedule.error} /> : null}
      {s ? (
        s.tasks.length === 0 ? (
          <section className="card">
            <h2>Nothing to plan yet</h2>
            <p className="note">
              {project.name} has no issues. A plan is drawn from issues: their estimates, start and due dates, who they're assigned to, their subtasks, and what each depends on.
            </p>
          </section>
        ) : (
          <>
            <Facts s={s} cal={cal} />
            {!choice.chosen && choice.ready ? (
              <p className="note">
                {choice.baselines.length
                  ? 'No baseline is chosen, so the chart shows no ghosts of the plan as agreed.'
                  : 'There is no baseline yet. Save one to keep the plan as it stands, and see later how far each task moves from it.'}
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
