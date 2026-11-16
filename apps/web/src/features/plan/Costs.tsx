/**
 * Cost against plan: Ocean's CostPanel (components/CostPanel). Bars on one scale, each with its
 * figure; earned value against the chosen baseline, its indices in plain words worked out from
 * the figures; and the figures as tables. The API keeps no week-by-week series, so there are no
 * curves to draw, and none is made up.
 */
import type { CostReport, Evm, Project, Schedule } from '@a4a/shared';
import { useId, useMemo, useState } from 'react';
import { Badge } from '../../components/Badges';
import { ErrorNote, Loading } from '../../components/States';
import { Who } from '../../components/Who';
import { useCosts, useSchedule } from './api';
import { BaselinePicker, SaveBaselineDialog, type BaselineChoice } from './Baselines';
import { addDays, dayMonth, diffDays, workCalendar, type WorkCalendar } from './dates';
import { days, effort, hours, money } from './format';

// ---------------------------------------------------------------------------
// The indices, in words
// ---------------------------------------------------------------------------

/** CPI 0.88 is 1 ÷ 0.88, or 14% more than planned. */
export function cpiWords(cpi: number | null): string {
  if (cpi === null) return 'Nothing has been spent yet, so there is nothing to measure.';
  const r = Math.round((1 / cpi - 1) * 100);
  if (r === 0) return 'The work done so far cost what was planned.';
  return r > 0 ? `The work done so far cost ${r}% more than planned.` : `The work done so far cost ${-r}% less than planned.`;
}

/** Share of a baseline task's working days elapsed by `asOf`, as the server counts it. */
function plannedFraction(cal: WorkCalendar, start: string, finish: string, asOf: string): number {
  if (asOf < start) return 0;
  if (asOf >= finish) return 1;
  const total = cal.inclusive(start, finish);
  return total > 0 ? cal.inclusive(start, asOf) / total : 0;
}

/**
 * How far the schedule is behind (positive) or ahead (negative), in working days: counted from
 * when the baseline's planned value reached what's been earned.
 */
export function scheduleDays(s: Schedule, evm: Evm, cal: WorkCalendar): number | null {
  const rows = s.tasks.filter((t) => !t.isSummary && t.baseline);
  if (!rows.length || evm.spi === null) return null;
  const pv = (d: string) => rows.reduce((sum, t) => sum + t.baseline!.cost * plannedFraction(cal, t.baseline!.start, t.baseline!.finish, d), 0);
  const first = rows.reduce((m, t) => (t.baseline!.start < m ? t.baseline!.start : m), rows[0]!.baseline!.start);
  const last = rows.reduce((m, t) => (t.baseline!.finish > m ? t.baseline!.finish : m), rows[0]!.baseline!.finish);
  let reached = last;
  for (let d = first, i = 0; d <= last && i < 5000; d = addDays(d, 1), i++) {
    if (!cal.isWorking(d) && d !== last) continue;
    if (pv(d) >= evm.ev - 0.005) {
      reached = d;
      break;
    }
  }
  return cal.between(reached, evm.asOf);
}

function spiWords(evm: Evm, behind: number | null): string {
  if (evm.spi === null) return 'Nothing was planned to be done by now, so there is nothing to measure yet.';
  if (behind === null) return evm.spi < 1 ? 'Behind the plan.' : evm.spi > 1 ? 'Ahead of the plan.' : 'On schedule.';
  if (behind === 0) return 'On schedule.';
  return behind > 0 ? `${days(behind)} behind.` : `${days(-behind)} ahead.`;
}

// ---------------------------------------------------------------------------
// The bars
// ---------------------------------------------------------------------------

interface Bar {
  name: string;
  value: number;
  series: 's1' | 's2' | 's3' | 'forecast';
}

function Bars({ id, label, bars, max, currency }: { id: string; label: string; bars: Bar[]; max: number; currency: string }) {
  return (
    <>
      <p className="label" id={id}>
        {label}
      </p>
      <dl aria-labelledby={id}>
        {bars.map((b) => {
          const pct = `${Math.round(Math.max(0, Math.min(1, b.value / max)) * 1000) / 10}%`;
          return (
            <div key={b.name} className="cost-row">
              <dt>{b.name}</dt>
              <dd className="cost-bar">
                <svg aria-hidden="true">
                  {b.series === 'forecast' ? (
                    <rect className="cost-fill forecast" x="0.75" y="0.75" width={pct} height="10.5" rx="3" />
                  ) : (
                    <rect className={`cost-fill ${b.series}`} width={pct} height="100%" rx="3" />
                  )}
                </svg>
              </dd>
              <dd className="cost-figure">{money(b.value, currency)}</dd>
            </div>
          );
        })}
      </dl>
    </>
  );
}

// ---------------------------------------------------------------------------
// The tables
// ---------------------------------------------------------------------------

function EvmTable({ evm, currency, baselineName }: { evm: Evm; currency: string; baselineName: string }) {
  const m = (n: number | null) => (n === null ? '–' : money(n, currency));
  const rows: [string, string, string][] = [
    ['Budget at completion (BAC)', m(evm.bac), `What ${baselineName} planned the work to cost`],
    ['Planned value (PV)', m(evm.pv), `What ${baselineName} planned to be done by ${dayMonth(evm.asOf)}`],
    ['Earned value (EV)', m(evm.ev), "What's done, at what it was planned to cost"],
    ['Actual cost (AC)', m(evm.ac), 'What the work has cost so far'],
    ['Cost variance (CV)', m(evm.cv), evm.cv < 0 ? 'EV − AC: the work done cost more than planned' : 'EV − AC: the work done cost no more than planned'],
    ['Schedule variance (SV)', m(evm.sv), evm.sv < 0 ? 'EV − PV: less is done than planned by now' : 'EV − PV: as much or more is done than planned by now'],
    ['Cost performance (CPI)', evm.cpi === null ? '–' : evm.cpi.toFixed(2), 'EV ÷ AC'],
    ['Schedule performance (SPI)', evm.spi === null ? '–' : evm.spi.toFixed(2), 'EV ÷ PV'],
    ['Estimate at completion (EAC)', m(evm.eac), 'BAC ÷ CPI: what it will cost if the work goes on costing as it has'],
    ['Estimate to complete (ETC)', m(evm.etc), 'EAC − AC: what the rest will cost'],
    ['Variance at completion (VAC)', m(evm.vac), 'BAC − EAC: under the plan if positive, over it if negative'],
  ];
  return (
    <div className="figures-scroll" tabIndex={0} role="group" aria-label={`Earned value against ${baselineName}`}>
      <table className="figures cost-figures">
        <caption>Earned value against {baselineName}, as of {dayMonth(evm.asOf)}</caption>
        <thead>
          <tr>
            <th scope="col">Figure</th>
            <th scope="col" className="num">
              Value
            </th>
            <th scope="col">What it says</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, value, about]) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              <td className="num">{value}</td>
              <td className="cost-says">{about}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PeopleTable({ c }: { c: CostReport }) {
  if (!c.byPerson.length) return null;
  return (
    <div className="figures-scroll" tabIndex={0} role="group" aria-label="By person">
      <table className="figures cost-figures">
        <caption>By person</caption>
        <thead>
          <tr>
            <th scope="col">Person</th>
            <th scope="col" className="num">
              Rate
            </th>
            <th scope="col" className="num">
              Planned
            </th>
            <th scope="col" className="num">
              Spent
            </th>
          </tr>
        </thead>
        <tbody>
          {c.byPerson.map((p) => (
            <tr key={p.user.id}>
              <th scope="row">
                <Who kind={p.user.isBot ? 'agent' : 'person'} name={p.user.isBot ? p.user.login : p.user.name} small />
              </th>
              <td className="num">{p.hourlyRate === null ? 'No rate' : `${money(p.hourlyRate, c.currency)}/h`}</td>
              <td className="num">
                {money(p.plannedCost, c.currency)}
                <span className="hidden">, </span>
                <span className="cost-sub"> {hours(p.plannedHours)}</span>
              </td>
              <td className="num">
                {money(p.actualCost, c.currency)}
                <span className="hidden">, </span>
                <span className="cost-sub"> {hours(p.actualHours)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TasksTable({ c, hoursPerDay }: { c: CostReport; hoursPerDay: number }) {
  const rows = c.byTask.filter((t) => t.plannedCost > 0 || t.actualCost > 0);
  if (!rows.length) return null;
  return (
    <div className="figures-scroll" tabIndex={0} role="group" aria-label="By task">
      <table className="figures cost-figures">
        <caption>By task</caption>
        <thead>
          <tr>
            <th scope="col">Task</th>
            <th scope="col" className="num">
              Planned
            </th>
            <th scope="col" className="num">
              Spent
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.issue}>
              <th scope="row">
                <span className="issue-id">{t.issue}</span> {t.summary}
                {t.fixedCost > 0 ? <span className="cost-sub"> · {money(t.fixedCost, c.currency)} fixed</span> : null}
              </th>
              <td className="num">
                {money(t.plannedCost, c.currency)}
                {t.effortMinutes > 0 ? <span className="cost-sub"> {effort(t.effortMinutes, hoursPerDay)}</span> : null}
              </td>
              <td className="num">
                {money(t.actualCost, c.currency)}
                {t.spentMinutes > 0 ? <span className="cost-sub"> {effort(t.spentMinutes, hoursPerDay)}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

function NoBaseline({ choice, onSave }: { choice: BaselineChoice; onSave: () => void }) {
  return (
    <div className="cost-index ask">
      <p className="label">Earned value</p>
      <p>
        {choice.baselines.length
          ? 'Compare with a baseline to see how much of the work planned by now is done, whether it is costing more than planned (CPI), and how far ahead or behind it is (SPI).'
          : 'With a baseline, a4a measures the work done against the plan as agreed: how much of what was planned by now is done, whether it is costing more than planned (CPI), and how far ahead or behind it is (SPI).'}
      </p>
      {choice.baselines.length ? (
        <BaselinePicker choice={choice} />
      ) : (
        <button type="button" onClick={onSave}>
          Save the plan as a baseline
        </button>
      )}
    </div>
  );
}

export function Costs({ project, choice }: { project: Project; choice: BaselineChoice }) {
  const key = project.key;
  const baselineId = choice.chosen?.id ?? null;
  const costs = useCosts(key, baselineId, choice.ready);
  const schedule = useSchedule(key, baselineId, choice.ready);
  const [saving, setSaving] = useState(false);
  const titleId = useId();
  const toDateId = useId();
  const atEndId = useId();
  const s = schedule.data;
  const cal = useMemo(() => workCalendar(s?.calendar ?? project.settings.plan), [s?.calendar, project.settings.plan]);

  if (costs.isLoading || !choice.ready) return <Loading what="the costs" />;
  if (costs.error || !costs.data) return <ErrorNote error={costs.error ?? choice.error} />;
  const c = costs.data;
  const evm = c.evm;
  const cur = c.currency;
  const behind = evm && s ? scheduleDays(s, evm, cal) : null;

  const toDate: Bar[] = evm
    ? [
        { name: 'Planned', value: evm.pv, series: 's1' },
        { name: 'Earned', value: evm.ev, series: 's2' },
        { name: 'Actual', value: c.actualCost, series: 's3' },
      ]
    : [{ name: 'Actual', value: c.actualCost, series: 's3' }];
  const atEnd: Bar[] = [
    ...(c.budget !== null ? [{ name: 'Budget', value: c.budget, series: 's1' as const }] : []),
    { name: 'Planned', value: c.plannedCost, series: 's1' },
    { name: 'Forecast', value: c.forecastCost, series: 'forecast' },
  ];
  const max = Math.max(1, ...toDate.map((b) => b.value), ...atEnd.map((b) => b.value));
  const over = c.budget !== null ? c.forecastCost - c.budget : null;
  const week = s ? Math.min(Math.max(1, Math.floor(diffDays(s.start, s.today) / 7) + 1), Math.ceil((diffDays(s.start, s.finish) + 1) / 7)) : null;
  const weeks = s ? Math.ceil((diffDays(s.start, s.finish) + 1) / 7) : null;
  const asOf = evm?.asOf ?? s?.today ?? null;

  return (
    <div className="stack">
      <div className="cluster">
        <BaselinePicker choice={choice} label="Earned value against" />
        <button type="button" onClick={() => setSaving(true)}>
          Save a baseline
        </button>
      </div>
      <section className="card cost-box" aria-labelledby={titleId}>
        <div className="cost">
          <div className="cost-head">
            <h2 id={titleId}>Cost against plan</h2>
            <p className="note">
              {project.name}
              {asOf ? ` · as of ${dayMonth(asOf)}` : ''}
              {week && weeks ? `, week ${week} of ${weeks}` : ''}
              {evm && choice.chosen ? ` · against ${choice.chosen.name}` : ''}
            </p>
          </div>
          <div className="cost-top">
            <div className="cost-bars">
              <Bars id={toDateId} label="To date" bars={toDate} max={max} currency={cur} />
              <Bars id={atEndId} label="At completion" bars={atEnd} max={max} currency={cur} />
              {over !== null ? (
                <div className="cost-over">
                  {over > 0 ? <Badge tone="bad">{money(over, cur)} over budget</Badge> : <p className="note">{money(-over, cur)} under budget</p>}
                </div>
              ) : null}
            </div>
            <div className="cost-indices">
              {evm ? (
                <>
                  <div className="cost-index">
                    <p className="label">Cost performance, CPI</p>
                    <strong>{evm.cpi === null ? '–' : evm.cpi.toFixed(2)}</strong>
                    <p>{cpiWords(evm.cpi)}</p>
                    <p className="note">
                      {money(evm.ev, cur)} earned for {money(evm.ac, cur)} spent
                    </p>
                  </div>
                  <div className="cost-index">
                    <p className="label">Schedule performance, SPI</p>
                    <strong>{evm.spi === null ? '–' : evm.spi.toFixed(2)}</strong>
                    <p>{spiWords(evm, behind)}</p>
                    <p className="note">
                      {money(evm.ev, cur)} earned of {money(evm.pv, cur)} planned by now
                    </p>
                  </div>
                </>
              ) : (
                <NoBaseline choice={choice} onSave={() => setSaving(true)} />
              )}
            </div>
          </div>
          {c.budget === null ? <p className="note">No budget is set for {project.name}. Set one in the project's plan settings to see the forecast against it.</p> : null}
          <div className="cost-tables">
            {evm && choice.chosen ? <EvmTable evm={evm} currency={cur} baselineName={choice.chosen.name} /> : null}
            <PeopleTable c={c} />
            <TasksTable c={c} hoursPerDay={s?.calendar.hoursPerDay ?? project.settings.plan.hoursPerDay} />
          </div>
          {c.warnings.length ? (
            <details className="plan-notes">
              <summary>{c.warnings.length === 1 ? '1 thing to know about these figures' : `${c.warnings.length} things to know about these figures`}</summary>
              <ul>
                {c.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </section>
      <SaveBaselineDialog projectKey={key} open={saving} onClose={() => setSaving(false)} onSaved={(b) => choice.choose(b.id)} />
    </div>
  );
}
