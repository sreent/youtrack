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
import { effort, hours, money } from './format';
import { t, tr } from '../../i18n';

// ---------------------------------------------------------------------------
// The indices, in words
// ---------------------------------------------------------------------------

/** CPI 0.88 is 1 ÷ 0.88, or 14% more than planned. */
export function cpiWords(cpi: number | null): string {
  if (cpi === null) return t('plan.costs.nothingHasBeenSpentYet');
  const r = Math.round((1 / cpi - 1) * 100);
  if (r === 0) return t('plan.costs.theWorkDoneSoFar');
  return r > 0 ? t('plan.costs.theWorkDoneSoFar2', { r: r }) : t('plan.costs.theWorkDoneSoFar3', { v: -r });
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
  if (evm.spi === null) return t('plan.costs.nothingWasPlannedToBe');
  if (behind === null) return evm.spi < 1 ? t('plan.costs.behindThePlan') : evm.spi > 1 ? t('plan.costs.aheadOfThePlan') : t('plan.costs.onSchedule');
  if (behind === 0) return t('plan.costs.onSchedule');
  return behind > 0 ? t('plan.costs.daysBehind', { n: behind }) : t('plan.costs.daysAhead', { n: -behind });
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
    [t('plan.costs.budgetAtCompletionBac'), m(evm.bac), t('plan.costs.whatPlannedTheWorkTo', { baselineName: baselineName })],
    [t('plan.costs.plannedValuePv'), m(evm.pv), t('plan.costs.whatPlannedToBeDone', { baselineName: baselineName, when: dayMonth(evm.asOf) })],
    [t('plan.costs.earnedValueEv'), m(evm.ev), t('plan.costs.whatSDoneAtWhat')],
    [t('plan.costs.actualCostAc'), m(evm.ac), t('plan.costs.whatTheWorkHasCost')],
    [t('plan.costs.costVarianceCv'), m(evm.cv), evm.cv < 0 ? t('plan.costs.evAcTheWorkDone') : t('plan.costs.evAcTheWorkDone2')],
    [t('plan.costs.scheduleVarianceSv'), m(evm.sv), evm.sv < 0 ? t('plan.costs.evPvLessIsDone') : t('plan.costs.evPvAsMuchOr')],
    [t('plan.costs.costPerformanceCpi2'), evm.cpi === null ? '–' : evm.cpi.toFixed(2), 'EV ÷ AC'],
    [t('plan.costs.schedulePerformanceSpi2'), evm.spi === null ? '–' : evm.spi.toFixed(2), 'EV ÷ PV'],
    [t('plan.costs.estimateAtCompletionEac'), m(evm.eac), t('plan.costs.bacCpiWhatItWill')],
    [t('plan.costs.estimateToCompleteEtc'), m(evm.etc), t('plan.costs.eacAcWhatTheRest')],
    [t('plan.costs.varianceAtCompletionVac'), m(evm.vac), t('plan.costs.bacEacUnderThePlan')],
  ];
  return (
    <div className="figures-scroll" tabIndex={0} role="group" aria-label={t('plan.costs.earnedValueAgainst', { baselineName: baselineName })}>
      <table className="figures cost-figures">
        <caption>{tr('plan.costs.earnedValueAgainstAsOf', { baselineName: baselineName, dayMonth: dayMonth(evm.asOf) })}</caption>
        <thead>
          <tr>
            <th scope="col">{t('plan.costs.figure')}</th>
            <th scope="col" className="num">{t('plan.costs.value')}</th>
            <th scope="col">{t('plan.costs.whatItSays')}</th>
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
    <div className="figures-scroll" tabIndex={0} role="group" aria-label={t('plan.costs.byPerson')}>
      <table className="figures cost-figures">
        <caption>{t('plan.costs.byPerson')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('plan.costs.person')}</th>
            <th scope="col" className="num">{t('plan.costs.rate')}</th>
            <th scope="col" className="num">{t('plan.costs.planned')}</th>
            <th scope="col" className="num">{t('plan.costs.spent')}</th>
          </tr>
        </thead>
        <tbody>
          {c.byPerson.map((p) => (
            <tr key={p.user.id}>
              <th scope="row">
                <Who kind={p.user.isBot ? 'agent' : 'person'} name={p.user.isBot ? p.user.login : p.user.name} small />
              </th>
              <td className="num">{p.hourlyRate === null ? t('plan.costs.noRate') : `${money(p.hourlyRate, c.currency)}/h`}</td>
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
    <div className="figures-scroll" tabIndex={0} role="group" aria-label={t('plan.costs.byTask')}>
      <table className="figures cost-figures">
        <caption>{t('plan.costs.byTask')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('plan.costs.task')}</th>
            <th scope="col" className="num">{t('plan.costs.planned')}</th>
            <th scope="col" className="num">{t('plan.costs.spent')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.issue}>
              <th scope="row">
                <span className="issue-id">{t.issue}</span> {t.summary}
                {t.fixedCost > 0 ? <span className="cost-sub">{tr('plan.costs.fixed', { money: money(t.fixedCost, c.currency) })}</span> : null}
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
      <p className="label">{t('plan.costs.earnedValue')}</p>
      <p>
        {choice.baselines.length
          ? t('plan.costs.compareWithABaselineTo')
          : t('plan.costs.withABaselineA4aMeasures')}
      </p>
      {choice.baselines.length ? (
        <BaselinePicker choice={choice} />
      ) : (
        <button type="button" onClick={onSave}>{t('plan.costs.saveThePlanAsA')}</button>
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

  if (costs.isLoading || !choice.ready) return <Loading what={t('plan.costs.theCosts')} />;
  if (costs.error || !costs.data) return <ErrorNote error={costs.error ?? choice.error} />;
  const c = costs.data;
  const evm = c.evm;
  const cur = c.currency;
  const behind = evm && s ? scheduleDays(s, evm, cal) : null;

  const toDate: Bar[] = evm
    ? [
        { name: t('plan.costs.planned'), value: evm.pv, series: 's1' },
        { name: t('plan.costs.earned'), value: evm.ev, series: 's2' },
        { name: t('plan.costs.actual'), value: c.actualCost, series: 's3' },
      ]
    : [{ name: t('plan.costs.actual'), value: c.actualCost, series: 's3' }];
  const atEnd: Bar[] = [
    ...(c.budget !== null ? [{ name: t('plan.costs.budget'), value: c.budget, series: 's1' as const }] : []),
    { name: t('plan.costs.planned'), value: c.plannedCost, series: 's1' },
    { name: t('plan.costs.forecast'), value: c.forecastCost, series: 'forecast' },
  ];
  const max = Math.max(1, ...toDate.map((b) => b.value), ...atEnd.map((b) => b.value));
  const over = c.budget !== null ? c.forecastCost - c.budget : null;
  const week = s ? Math.min(Math.max(1, Math.floor(diffDays(s.start, s.today) / 7) + 1), Math.ceil((diffDays(s.start, s.finish) + 1) / 7)) : null;
  const weeks = s ? Math.ceil((diffDays(s.start, s.finish) + 1) / 7) : null;
  const asOf = evm?.asOf ?? s?.today ?? null;

  return (
    <div className="stack">
      <div className="cluster">
        <BaselinePicker choice={choice} label={t('plan.costs.earnedValueAgainst2')} />
        <button type="button" onClick={() => setSaving(true)}>{t('plan.costs.saveABaseline')}</button>
      </div>
      <section className="card cost-box" aria-labelledby={titleId}>
        <div className="cost">
          <div className="cost-head">
            <h2 id={titleId}>{t('plan.costs.costAgainstPlan')}</h2>
            <p className="note">
              {project.name}
              {asOf ? t('plan.costs.asOf', { dayMonth: dayMonth(asOf) }) : ''}
              {week && weeks ? t('plan.costs.weekOf', { week: week, weeks: weeks }) : ''}
              {evm && choice.chosen ? t('plan.costs.against', { name: choice.chosen.name }) : ''}
            </p>
          </div>
          <div className="cost-top">
            <div className="cost-bars">
              <Bars id={toDateId} label={t('plan.costs.toDate')} bars={toDate} max={max} currency={cur} />
              <Bars id={atEndId} label={t('plan.costs.atCompletion')} bars={atEnd} max={max} currency={cur} />
              {over !== null ? (
                <div className="cost-over">
                  {over > 0 ? <Badge tone="bad">{tr('plan.costs.overBudget', { money: money(over, cur) })}</Badge> : <p className="note">{tr('plan.costs.underBudget', { money: money(-over, cur) })}</p>}
                </div>
              ) : null}
            </div>
            <div className="cost-indices">
              {evm ? (
                <>
                  <div className="cost-index">
                    <p className="label">{t('plan.costs.costPerformanceCpi')}</p>
                    <strong>{evm.cpi === null ? '–' : evm.cpi.toFixed(2)}</strong>
                    <p>{cpiWords(evm.cpi)}</p>
                    <p className="note">{tr('plan.costs.earnedForSpent', { money: money(evm.ev, cur), money2: money(evm.ac, cur) })}</p>
                  </div>
                  <div className="cost-index">
                    <p className="label">{t('plan.costs.schedulePerformanceSpi')}</p>
                    <strong>{evm.spi === null ? '–' : evm.spi.toFixed(2)}</strong>
                    <p>{spiWords(evm, behind)}</p>
                    <p className="note">{tr('plan.costs.earnedOfPlannedByNow', { money: money(evm.ev, cur), money2: money(evm.pv, cur) })}</p>
                  </div>
                </>
              ) : (
                <NoBaseline choice={choice} onSave={() => setSaving(true)} />
              )}
            </div>
          </div>
          {c.budget === null ? <p className="note">{tr('plan.costs.noBudgetIsSetFor', { name: project.name })}</p> : null}
          <div className="cost-tables">
            {evm && choice.chosen ? <EvmTable evm={evm} currency={cur} baselineName={choice.chosen.name} /> : null}
            <PeopleTable c={c} />
            <TasksTable c={c} hoursPerDay={s?.calendar.hoursPerDay ?? project.settings.plan.hoursPerDay} />
          </div>
          {c.warnings.length ? (
            <details className="plan-notes">
              <summary>{c.warnings.length === 1 ? t('plan.costs.n1ThingToKnowAbout') : t('plan.costs.thingsToKnowAboutThese', { length: c.warnings.length })}</summary>
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
