/**
 * The reports D44 adds: issues per field and the matrix (as issues are now, each count opening its
 * issues), average age (each day as it stood) and time in state (from history). Drawn with Ocean's
 * pieces: bars as the time report's, shaded cells as the load grid's, lines and percentile marks as
 * the other charts', and the figures always in a table too.
 */
import type { AverageAge, IssuesPerField, Matrix, TimeInState, ValueCount } from '@a4a/shared';
import { useId } from 'react';
import { Link } from 'react-router';
import { labelled, labelRoom, niceScale, pathThrough, plotHeight, plotWidth, useChartWidth, daysOf, type Frame } from './chart';
import { t as tx, tr, monthNames } from '../../i18n';

const issuesHref = (query: string) => `/issues?q=${encodeURIComponent(query)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const MONTHS = monthNames();
const dayMonth = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
const fixed1 = (n: number | null) => (n === null ? '—' : String(Math.round(n * 10) / 10));

/** A count that opens its issues, when one query finds them. */
function Count({ n, query, shaded }: { n: number; query: string | null; shaded?: boolean }) {
  if (!n || query === null) return <>{n}</>;
  return (
    // On a shaded cell, the figure keeps the shade's own ink, as the load grid's figures do.
    <Link to={issuesHref(query)} title={tx('reports.moreReports.open', { v: n === 1 ? tx('reports.moreReports.thisIssue') : tx('reports.moreReports.theseIssues', { n: n }) })} style={shaded ? { color: 'inherit' } : undefined}>
      {n}
    </Link>
  );
}

/** Horizontal bars, one per value, each with its count opening its issues. */
function ValueBars({ values, label }: { values: ValueCount[]; label: string }) {
  const max = Math.max(1, ...values.map((v) => v.count));
  return (
    <dl className="time-bars" aria-label={label}>
      {values.map((v) => (
        <div key={v.key || '-'} className="time-row">
          <dt className={v.key === '' || v.key === '*' ? 'muted' : undefined}>{v.label}</dt>
          <dd className="time-bar">
            <svg aria-hidden="true">
              <rect className="time-fill" width={`${Math.round((v.count / max) * 1000) / 10}%`} height="100%" rx="3" />
            </svg>
          </dd>
          <dd className="time-figure">
            <Count n={v.count} query={v.query} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function FiguresTable({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="figures-scroll" tabIndex={0} role="group" aria-label={label}>
      <table className="figures chart-figures">{children}</table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Issues per field
// ---------------------------------------------------------------------------

export function IssuesPerFieldView({ r, compact }: { r: IssuesPerField; compact?: boolean }) {
  if (!r.total) return <p className="note">{tx('reports.moreReports.noIssuesToCountNothing')}</p>;
  const by = r.interval ? tx('reports.moreReports.by', { interval: r.interval }) : '';
  return (
    <div className="stack">
      <p className="note">{tr('reports.moreReports.issuesByEachCountOpens', { n: r.total, name: r.field.name, by: by, v: r.field.multi ? tx('reports.moreReports.anIssueWithSeveralValues') : '' })}</p>
      <ValueBars values={r.values} label={tx('reports.moreReports.issuesBy', { name: r.field.name })} />
      {compact ? null : (
        <FiguresTable label={tx('reports.moreReports.issuesByAsFigures', { name: r.field.name })}>
          <thead>
            <tr>
              <th scope="col">{r.field.name}</th>
              <th scope="col" className="num">{tx('reports.moreReports.issues')}</th>
            </tr>
          </thead>
          <tbody>
            {r.values.map((v) => (
              <tr key={v.key || '-'}>
                <th scope="row">{v.label}</th>
                <td className="num">
                  <Count n={v.count} query={v.query} />
                </td>
              </tr>
            ))}
          </tbody>
        </FiguresTable>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

/** How dark a cell is: none, under half the fullest cell, or more (the load grid's shades). */
const shade = (n: number, max: number) => (n === 0 ? 0 : n * 2 <= max ? 1 : 2);

export function MatrixView({ m }: { m: Matrix; compact?: boolean }) {
  if (!m.total) return <p className="note">{tx('reports.moreReports.noIssuesToCountNothing')}</p>;
  const max = Math.max(1, ...m.cells.flat().map((c) => c.count));
  const corner = tx('reports.moreReports.by2', { name: m.rows.field.name, name2: m.columns.field.name });
  return (
    <div className="stack">
      <p className="note">{tr('reports.moreReports.issuesDownAcross', { n: m.total, name: m.rows.field.name, name2: m.columns.field.name })}</p>
      <FiguresTable label={tx('reports.moreReports.asFigures', { corner: corner })}>
        <thead>
          <tr>
            <th scope="col">{corner}</th>
            {m.columns.values.map((c) => (
              <th key={c.key || '-'} scope="col" className="num">
                {c.label}
              </th>
            ))}
            <th scope="col" className="num">{tx('reports.moreReports.total')}</th>
          </tr>
        </thead>
        <tbody>
          {m.rows.values.map((r, i) => (
            <tr key={r.key || '-'}>
              <th scope="row">{r.label}</th>
              {m.cells[i]!.map((c, j) => (
                <td key={j} className="num load-cell" data-load={shade(c.count, max)}>
                  <Count n={c.count} query={c.query} shaded />
                </td>
              ))}
              <td className="num">
                <strong>
                  <Count n={r.count} query={r.query} />
                </strong>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">{tx('reports.moreReports.total')}</th>
            {m.columns.values.map((c) => (
              <td key={c.key || '-'} className="num">
                <strong>
                  <Count n={c.count} query={c.query} />
                </strong>
              </td>
            ))}
            <td className="num">
              <strong>{m.total}</strong>
            </td>
          </tr>
        </tfoot>
      </FiguresTable>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Average age
// ---------------------------------------------------------------------------

const AGE_FRAME: Frame = { width: 640, height: 240, left: 44, right: 84, top: 14, bottom: 32 };

function AgeChart({ a, compact }: { a: AverageAge; compact?: boolean }) {
  const titleId = useId();
  const [ref, width] = useChartWidth();
  const f = { ...AGE_FRAME, width };
  const n = a.days.length;
  const scale = niceScale(Math.max(1, ...a.days.map((d) => Math.max(d.averageDays ?? 0, d.medianDays ?? 0))), 1);
  const x = (i: number) => f.left + (n > 1 ? (plotWidth(f) * i) / (n - 1) : plotWidth(f) / 2);
  const y = (v: number) => f.top + plotHeight(f) * (1 - v / scale.max);
  const base = f.top + plotHeight(f);
  const points = (pick: (d: AverageAge['days'][number]) => number | null) =>
    a.days.map((d, i) => [i, pick(d)] as const).filter((p): p is readonly [number, number] => p[1] !== null).map(([i, v]) => [x(i), y(v)] as [number, number]);
  const avg = points((d) => d.averageDays);
  const med = points((d) => d.medianDays);
  const xLabels = labelled(n, labelRoom(f));
  const last = a.days.at(-1);
  return (
    <figure className="chart" ref={ref}>
      <svg viewBox={`0 0 ${f.width} ${f.height}`} role="img" aria-labelledby={titleId}>
        <title id={titleId}>{tx('reports.moreReports.theAverageAndMedianAge', { v: compact ? tx('reports.moreReports.underIt') : tx('reports.moreReports.besideIt') })}</title>
        {scale.ticks.map((t) => (
          <g key={t}>
            <line className="chart-grid" x1={f.left} x2={f.width - f.right} y1={y(t)} y2={y(t)} />
            <text x={f.left - 8} y={y(t) + 4} textAnchor="end">{tr('reports.moreReports.d', { t: t })}</text>
          </g>
        ))}
        <line className="chart-axis" x1={f.left} x2={f.width - f.right} y1={base} y2={base} />
        {a.days.map((d, i) =>
          xLabels.has(i) ? (
            <text key={d.date} x={x(i)} y={base + 17} textAnchor="middle">
              {dayMonth(d.date)}
            </text>
          ) : null,
        )}
        {med.length ? <path className="chart-line s2" d={pathThrough(med)} /> : null}
        {avg.length ? <path className="chart-line s1" d={pathThrough(avg)} /> : null}
        {last?.averageDays != null ? (
          <g>
            <circle className="chart-dot s1" cx={x(n - 1)} cy={y(last.averageDays)} r={4} />
            <text className="chart-label" x={x(n - 1) + 9} y={y(last.averageDays) + 4}>
              {daysOf(last.averageDays)}
            </text>
          </g>
        ) : null}
      </svg>
      <figcaption>
        <ul className="chart-key">
          <li>{tr('reports.moreReports.averageAge', { el: <svg width="22" height="10" aria-hidden="true">
              <path className="chart-line s1" d="M1 5H21" />
            </svg> })}</li>
          <li>{tr('reports.moreReports.medianAge', { el: <svg width="22" height="10" aria-hidden="true">
              <path className="chart-line s2" d="M1 5H21" />
            </svg> })}</li>
        </ul>
      </figcaption>
    </figure>
  );
}

export function AverageAgeView({ a, compact }: { a: AverageAge; compact?: boolean }) {
  const last = a.days.at(-1);
  if (!last) return <p className="note">{tx('reports.moreReports.noDaysToShowYet')}</p>;
  return (
    <div className="stack">
      <p className="note">{tr('reports.moreReports.ageCountsFromWhenEach', { v: last.open ? tx('reports.moreReports.issuesOpenOn', { n: last.open, dayMonth: dayMonth(last.date), v: last.averageDays === null ? '' : tx('reports.moreReports.oldOnAverage', { daysOf: daysOf(last.averageDays) }) }) : tx('reports.moreReports.nothingOpenOn', { dayMonth: dayMonth(last.date) }) })}</p>
      <div className={compact ? 'stack' : 'chart-box'}>
        <AgeChart a={a} compact={compact} />
        {compact ? null : (
          <FiguresTable label={tx('reports.moreReports.averageAgeEachDayAs')}>
            <thead>
              <tr>
                <th scope="col">{tx('reports.moreReports.day')}</th>
                <th scope="col" className="num">{tx('reports.moreReports.open2')}</th>
                <th scope="col" className="num">{tx('reports.moreReports.averageDays')}</th>
                <th scope="col" className="num">{tx('reports.moreReports.medianDays')}</th>
              </tr>
            </thead>
            <tbody>
              {a.days.map((d) => (
                <tr key={d.date}>
                  <th scope="row">{dayMonth(d.date)}</th>
                  <td className="num">{d.open}</td>
                  <td className="num">{fixed1(d.averageDays)}</td>
                  <td className="num">{fixed1(d.medianDays)}</td>
                </tr>
              ))}
            </tbody>
          </FiguresTable>
        )}
      </div>
      {a.field && a.values.length ? (
        <FiguresTable label={tx('reports.moreReports.averageAgeByOn', { name: a.field.name, dayMonth: dayMonth(last.date) })}>
          <caption>{tr('reports.moreReports.byAsItStoodOn', { name: a.field.name, dayMonth: dayMonth(last.date) })}</caption>
          <thead>
            <tr>
              <th scope="col">{a.field.name}</th>
              <th scope="col" className="num">{tx('reports.moreReports.open2')}</th>
              <th scope="col" className="num">{tx('reports.moreReports.averageDays')}</th>
              <th scope="col" className="num">{tx('reports.moreReports.oldestDays')}</th>
            </tr>
          </thead>
          <tbody>
            {a.values.slice(0, compact ? 6 : undefined).map((v) => (
              <tr key={v.key || '-'}>
                <th scope="row">{v.label}</th>
                <td className="num">
                  <Count n={v.open} query={v.query} />
                </td>
                <td className="num">{fixed1(v.averageDays)}</td>
                <td className="num">{fixed1(v.oldestDays)}</td>
              </tr>
            ))}
          </tbody>
        </FiguresTable>
      ) : null}
      {!compact && a.oldest.length ? (
        <FiguresTable label={tx('reports.moreReports.theOldestOpenIssues')}>
          <caption>{tr('reports.moreReports.theOldestOpenOn', { dayMonth: dayMonth(last.date) })}</caption>
          <tbody>
            {a.oldest.map((o) => (
              <tr key={o.issue}>
                <th scope="row">
                  <Link className="issue-id" to={`/issues/${o.issue}`}>
                    {o.issue}
                  </Link>
                </th>
                <td>{o.summary}</td>
                <td className="num">{daysOf(o.days)}</td>
              </tr>
            ))}
          </tbody>
        </FiguresTable>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Time in state
// ---------------------------------------------------------------------------

export function TimeInStateView({ t, compact }: { t: TimeInState; compact?: boolean }) {
  const word = t.by === 'column' ? 'column' : 'state';
  const max = Math.max(1, ...t.states.map((s) => s.p85 ?? 0));
  const shown = t.issues.slice(-50).reverse();
  return (
    <div className="stack">
      <p className="note">
        {t.issues.length
          ? tx('reports.moreReports.issuesResolvedFromTo', { n: t.issues.length, v: t.board ? tx('reports.moreReports.on', { name: t.board.name }) : '', dayMonth: dayMonth(t.scope.from), dayMonth2: dayMonth(t.scope.to), word: word })
          : tx('reports.moreReports.nothingWasResolvedFromTo', { v: t.board ? tx('reports.moreReports.on', { name: t.board.name }) : '', dayMonth: dayMonth(t.scope.from), dayMonth2: dayMonth(t.scope.to) })}
      </p>
      <dl className="time-bars" aria-label={tx('reports.moreReports.daysInEach85thPercentile', { word: word })}>
        {t.states.map((s) => {
          const p85 = s.p85 ?? 0;
          const mid = s.p50 ?? 0;
          return (
            <div key={s.name} className="time-row">
              <dt>{s.name}</dt>
              <dd className="time-bar">
                <svg aria-hidden="true">
                  <rect className="time-fill" width={`${Math.round((p85 / max) * 1000) / 10}%`} height="100%" rx="3" />
                  {s.p50 !== null ? <line className="dist-mark" x1={`${(mid / max) * 100}%`} x2={`${(mid / max) * 100}%`} y1="0" y2="100%" /> : null}
                </svg>
              </dd>
              <dd className="time-figure">{s.p85 === null ? '—' : `${daysOf(s.p50 ?? 0)} · ${daysOf(p85)}`}</dd>
            </div>
          );
        })}
      </dl>
      <FiguresTable label={tx('reports.moreReports.daysInEachAsFigures', { word: word })}>
        <thead>
          <tr>
            <th scope="col">{t.by === 'column' ? tx('reports.moreReports.column') : tx('reports.moreReports.state')}</th>
            <th scope="col" className="num">{tx('reports.moreReports.issues')}</th>
            <th scope="col" className="num">{tx('reports.moreReports.medianDays')}</th>
            <th scope="col" className="num">{tx('reports.moreReports.n85thPercentile')}</th>
            {compact ? null : (
              <th scope="col" className="num">{tx('reports.moreReports.mean')}</th>
            )}
            <th scope="col" className="num">{tx('reports.moreReports.openThereNow')}</th>
          </tr>
        </thead>
        <tbody>
          {t.states.map((s) => (
            <tr key={s.name}>
              <th scope="row">{s.name}</th>
              <td className="num">{s.issues}</td>
              <td className="num">{fixed1(s.p50)}</td>
              <td className="num">{fixed1(s.p85)}</td>
              {compact ? null : <td className="num">{fixed1(s.meanDays)}</td>}
              <td className="num">{s.now}</td>
            </tr>
          ))}
        </tbody>
      </FiguresTable>
      {!compact && shown.length ? (
        <FiguresTable label={tx('reports.moreReports.daysEachResolvedIssueSpent', { word: word })}>
          <caption>{t.issues.length > shown.length ? tx('reports.moreReports.theLastResolvedTheCsv', { length: shown.length }) : tx('reports.moreReports.eachResolvedIssue')}</caption>
          <thead>
            <tr>
              <th scope="col">{tx('reports.moreReports.issue')}</th>
              {t.states.map((s) => (
                <th key={s.name} scope="col" className="num">
                  {s.name}
                </th>
              ))}
              <th scope="col" className="num">{tx('reports.moreReports.total')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((i) => (
              <tr key={i.issue}>
                <th scope="row">
                  <Link className="issue-id" to={`/issues/${i.issue}`} title={i.summary}>
                    {i.issue}
                  </Link>
                </th>
                {i.days.map((d, k) => (
                  <td key={k} className="num">
                    {d ? fixed1(d) : ''}
                  </td>
                ))}
                <td className="num">{fixed1(i.totalDays)}</td>
              </tr>
            ))}
          </tbody>
        </FiguresTable>
      ) : null}
      {!compact && t.ongoing.length ? (
        <FiguresTable label={tx('reports.moreReports.openIssuesLongestWhereThey')}>
          <caption>{tx('reports.moreReports.stillOpenTheLongestWhere')}</caption>
          <tbody>
            {t.ongoing.slice(0, 15).map((o) => (
              <tr key={o.issue}>
                <th scope="row">
                  <Link className="issue-id" to={`/issues/${o.issue}`}>
                    {o.issue}
                  </Link>
                </th>
                <td>{o.summary}</td>
                <td>{o.state}</td>
                <td className="num">{daysOf(o.daysInState)}</td>
              </tr>
            ))}
          </tbody>
        </FiguresTable>
      ) : null}
    </div>
  );
}
