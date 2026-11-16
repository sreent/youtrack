/**
 * Time logged: Ocean's TimeReport (components/TimeReport). The total; a bar for each person,
 * project or week on one scale, each with its figure; each issue's time against its estimate, past
 * it in --warn with its words; and each person's weeks, as a table. Bars are SVG, their width a
 * share of their line.
 */
import type { TimeReport } from '@a4a/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { Badge } from '../../components/Badges';
import { Who } from '../../components/Who';
import { dayMonth, spanWords } from '../plan/dates';
import { plural } from '../plan/format';
import { hoursOf } from './chart';

type Group = 'person' | 'project' | 'week';
const GROUPS: { id: Group; label: string }[] = [
  { id: 'person', label: 'By person' },
  { id: 'project', label: 'By project' },
  { id: 'week', label: 'By week' },
];

function Bars({ t, group, label }: { t: TimeReport; group: Group; label: string }) {
  const rows = group === 'person' ? t.byPerson : group === 'project' ? t.byProject : t.byWeek;
  const max = Math.max(1, ...rows.map((r) => r.minutes));
  return (
    <dl className="time-bars" aria-label={label}>
      {rows.map((r) => {
        const pct = `${Math.round((r.minutes / max) * 1000) / 10}%`;
        return (
          <div key={r.key} className="time-row">
            <dt>{r.label}</dt>
            <dd className="time-bar">
              <svg aria-hidden="true">
                <rect className="time-fill" width={pct} height="100%" rx="3" />
              </svg>
            </dd>
            <dd className="time-figure">{hoursOf(r.minutes)}</dd>
          </div>
        );
      })}
    </dl>
  );
}

/** Spent against estimate: a bar on the estimate's track, and past it in --warn, with how far. */
function SpentMeter({ spent, estimate }: { spent: number; estimate: number | null }) {
  if (estimate === null || estimate <= 0) return <span className="muted">No estimate</span>;
  const over = spent > estimate;
  const full = Math.max(spent, estimate);
  const within = `${Math.round((Math.min(spent, estimate) / full) * 1000) / 10}%`;
  const past = `${Math.round(((spent - estimate) / full) * 1000) / 10}%`;
  return (
    <span className="spent-meter">
      <svg aria-hidden="true">
        <rect className="spent-track" width="100%" height="100%" rx="3" />
        <rect className="spent-fill" width={within} height="100%" rx="3" />
        {over ? <rect className="spent-over" x={within} width={past} height="100%" rx="3" /> : null}
      </svg>
      {over ? <Badge tone="warn">{hoursOf(spent - estimate)} over</Badge> : <span className="muted">{Math.round((spent / estimate) * 100)}% of {hoursOf(estimate)}</span>}
    </span>
  );
}

export function TimeReportView({ t, compact }: { t: TimeReport; compact?: boolean }) {
  const [group, setGroup] = useState<Group>('person');
  const people = t.byPerson.length;
  const issues = compact ? t.byIssue.slice(0, 5) : t.byIssue;
  return (
    <div className="report">
      <dl className="report-facts">
        <div>
          <dt>Logged</dt>
          <dd>
            {hoursOf(t.totalMinutes)} <small>{spanWords(t.from, t.to)}</small>
          </dd>
        </div>
        <div>
          <dt>Entries</dt>
          <dd>{t.entries}</dd>
        </div>
        <div>
          <dt>People</dt>
          <dd>{people}</dd>
        </div>
      </dl>
      {!t.entries ? <p className="note">Nobody logged work here in this window.</p> : null}
      {t.entries ? (
        <>
          {!compact ? (
            <div className="modes" role="group" aria-label="Group the time">
              {GROUPS.map((g) => (
                <button key={g.id} type="button" aria-pressed={group === g.id} onClick={() => setGroup(g.id)}>
                  {g.label}
                </button>
              ))}
            </div>
          ) : null}
          <Bars t={t} group={compact ? 'person' : group} label={`Time logged, ${GROUPS.find((g) => g.id === (compact ? 'person' : group))!.label.toLowerCase()}`} />
          <div className="figures-scroll" tabIndex={0} role="group" aria-label="Time against estimates, by issue">
            <table className="figures chart-figures">
              <caption>{compact ? 'Where the most time went' : 'Each issue: time logged here, all told, and against its estimate'}</caption>
              <thead>
                <tr>
                  <th scope="col">Issue</th>
                  <th scope="col" className="num">
                    Here
                  </th>
                  {!compact ? (
                    <th scope="col" className="num">
                      All told
                    </th>
                  ) : null}
                  <th scope="col">Against its estimate</th>
                </tr>
              </thead>
              <tbody>
                {issues.map((i) => (
                  <tr key={i.issue}>
                    <th scope="row">
                      <Link className="issue-id" to={`/issues/${i.issue}`}>
                        {i.issue}
                      </Link>{' '}
                      {i.summary}
                    </th>
                    <td className="num">{hoursOf(i.minutes)}</td>
                    {!compact ? <td className="num">{hoursOf(i.spentMinutes)}</td> : null}
                    <td>
                      <SpentMeter spent={i.spentMinutes} estimate={i.estimateMinutes} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!compact && t.weeks.length > 1 ? (
            <div className="figures-scroll" tabIndex={0} role="group" aria-label="Each person's weeks">
              <table className="figures chart-figures">
                <caption>Each person, week by week (weeks begin on Monday)</caption>
                <thead>
                  <tr>
                    <th scope="col">Person</th>
                    {t.weeks.map((w) => (
                      <th key={w} scope="col" className="num">
                        {dayMonth(w)}
                      </th>
                    ))}
                    <th scope="col" className="num">
                      All
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {t.matrix.map((m) => (
                    <tr key={m.label}>
                      <th scope="row">{m.user ? <Who kind={m.user.isBot ? 'agent' : 'person'} name={m.user.isBot ? m.user.login : m.user.name} small /> : m.label}</th>
                      {m.minutes.map((v, k) => (
                        <td key={t.weeks[k]} className="num">
                          {v ? hoursOf(v) : ''}
                        </td>
                      ))}
                      <td className="num">{hoursOf(m.minutes.reduce((a, b) => a + b, 0))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {compact && t.byIssue.length > issues.length ? <p className="note">And {plural(t.byIssue.length - issues.length, 'more issue')}.</p> : null}
        </>
      ) : null}
    </div>
  );
}
