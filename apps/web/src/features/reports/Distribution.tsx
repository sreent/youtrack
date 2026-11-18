/**
 * Cycle time as a distribution: Ocean's Distribution (components/Distribution). How many issues
 * took how long, in columns of the first series on equal buckets, with where the half and the 85th
 * percentile fall as lines in ink with their words; the figures at a glance and as tables.
 */
import type { CycleTime } from '@a4a/shared';
import { useId } from 'react';
import { Link } from 'react-router';
import { dayMonth } from '../plan/dates';
import { column, daysOf, labelled, labelRoom, niceScale, plotHeight, plotWidth, useChartWidth, type Frame } from './chart';
import { formatList, t, tr } from '../../i18n';

const FRAME: Frame = { width: 640, height: 240, left: 40, right: 24, top: 34, bottom: 34 };

const bucketWords = (from: number, to: number) => (to <= 1 ? t('reports.distribution.hours', { from: Math.round(from * 24), to: Math.round(to * 24) }) : t('reports.distribution.days', { from: from, to: to }));

export function DistributionChart({ c, compact }: { c: CycleTime; compact?: boolean }) {
  const titleId = useId();
  const [ref, width] = useChartWidth();
  const f = { ...FRAME, width };
  const span = c.buckets.length * c.bucketDays;
  const scale = niceScale(Math.max(1, ...c.buckets.map((b) => b.count)), 1);
  const xv = (v: number) => f.left + (span ? (plotWidth(f) * v) / span : 0);
  const y = (v: number) => f.top + plotHeight(f) * (1 - v / scale.max);
  const base = f.top + plotHeight(f);
  const slot = c.buckets.length ? plotWidth(f) / c.buckets.length : 0;
  const w = Math.max(2, Math.min(24, slot - 4));
  const marks = [
    { p: c.percentiles.p50, words: t('reports.distribution.half') },
    { p: c.percentiles.p85, words: '85%' },
  ].filter((m): m is { p: number; words: string } => m.p !== null);
  const edges = labelled(c.buckets.length + 1, labelRoom(f, 56));
  // Each mark's words beside its line: to its right, or to its left where they'd run past the
  // chart's edge; the second a line lower where it would meet the first.
  const placed: { words: string; label: string; px: number; end: boolean; lower: boolean; from: number; to: number }[] = [];
  for (const m of marks) {
    const px = xv(Math.min(m.p, span));
    const label = t('reports.distribution.by', { words: m.words, daysOf: daysOf(m.p) });
    const room = label.length * 6.5;
    const end = px + 5 + room > f.width;
    const from = end ? px - 5 - room : px + 5;
    const to = end ? px - 5 : px + 5 + room;
    const lower = placed.some((o) => !o.lower && from < o.to + 6 && to > o.from - 6);
    placed.push({ words: m.words, label, px, end, lower, from, to });
  }

  const chart = (
    <figure className="chart" ref={ref}>
      <svg viewBox={`0 0 ${f.width} ${f.height}`} role="img" aria-labelledby={titleId}>
        <title id={titleId}>{t('reports.distribution.howManyIssuesTookHow')}</title>
        {scale.ticks.map((t) => (
          <g key={t}>
            <line className="chart-grid" x1={f.left} x2={f.width - f.right} y1={y(t)} y2={y(t)} />
            <text x={f.left - 8} y={y(t) + 4} textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        {c.buckets.map((b, i) =>
          b.count ? <path key={b.from} className="chart-col s1" d={column(f.left + slot * i + (slot - w) / 2, y(b.count), w, base)} /> : null,
        )}
        <line className="chart-axis" x1={f.left} x2={f.width - f.right} y1={base} y2={base} />
        {[...Array(c.buckets.length + 1).keys()].map((i) =>
          edges.has(i) ? (
            <g key={i}>
              <line className="chart-axis" x1={xv(i * c.bucketDays)} x2={xv(i * c.bucketDays)} y1={base} y2={base + 4} />
              <text x={xv(i * c.bucketDays)} y={base + 17} textAnchor="middle">
                {i === 0 ? '0' : daysOf(i * c.bucketDays).replace(' days', 'd').replace(' day', 'd')}
              </text>
            </g>
          ) : null,
        )}
        {placed.map((m) => (
          <g key={m.words}>
            <line className="dist-mark" x1={m.px} x2={m.px} y1={f.top - 4} y2={base} />
            <text className="chart-label" x={m.end ? m.px - 5 : m.px + 5} y={m.lower ? f.top + 10 : f.top - 10} textAnchor={m.end ? 'end' : 'start'}>
              {m.label}
            </text>
          </g>
        ))}
      </svg>
      <figcaption>
        <ul className="chart-key">
          <li>{tr('reports.distribution.issuesByHowLongThey', { el: <span className="chart-swatch s1" aria-hidden="true" /> })}</li>
          <li>{tr('reports.distribution.whereTheHalfAnd85', { el: <svg width="12" height="12" aria-hidden="true">
              <path className="dist-mark" d="M6 0V12" />
            </svg> })}</li>
        </ul>
      </figcaption>
    </figure>
  );

  const table = (
    <div className="figures-scroll" tabIndex={0} role="group" aria-label={t('reports.distribution.issuesByHowLongThey2')}>
      <table className="figures chart-figures">
        <caption>{t('reports.distribution.howManyTookHowLong')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('reports.distribution.took')}</th>
            <th scope="col" className="num">{t('reports.distribution.issues')}</th>
          </tr>
        </thead>
        <tbody>
          {c.buckets.map((b) => (
            <tr key={b.from}>
              <th scope="row">{bucketWords(b.from, b.to)}</th>
              <td className="num">{b.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  if (!c.count) return <p className="note">{t('reports.distribution.noIssueThatHadStarted')}</p>;
  if (compact) {
    return (
      <>
        {chart}
        <details className="chart-more">
          <summary>{t('reports.distribution.theFigures')}</summary>
          {table}
        </details>
      </>
    );
  }
  return (
    <div className="chart-box">
      {chart}
      {table}
    </div>
  );
}

export function CycleTimeReport({ c, compact }: { c: CycleTime; compact?: boolean }) {
  const slowest = [...c.issues].sort((a, b) => b.days - a.days).slice(0, 15);
  const fig = (v: number | null) => (v === null ? '–' : daysOf(v));
  return (
    <div className="report">
      <dl className="report-facts">
        <div>
          <dt>{t('reports.distribution.resolved')}</dt>
          <dd>{c.count}</dd>
        </div>
        <div>
          <dt>{t('reports.distribution.halfWithin')}</dt>
          <dd>{fig(c.percentiles.p50)}</dd>
        </div>
        <div>
          <dt>{t('reports.distribution.n85Within')}</dt>
          <dd>{fig(c.percentiles.p85)}</dd>
        </div>
        {!compact ? (
          <>
            <div>
              <dt>{t('reports.distribution.n95Within')}</dt>
              <dd>{fig(c.percentiles.p95)}</dd>
            </div>
            <div>
              <dt>{t('reports.distribution.onAverage')}</dt>
              <dd>{fig(c.mean)}</dd>
            </div>
          </>
        ) : null}
      </dl>
      <DistributionChart c={c} compact={compact} />
      {!compact && slowest.length ? (
        <div className="figures-scroll" tabIndex={0} role="group" aria-label={t('reports.distribution.theSlowest')}>
          <table className="figures chart-figures">
            <caption>{tr('reports.distribution.theSlowestFromFirstTo', { join: formatList(c.startStates, 'disjunction') })}</caption>
            <thead>
              <tr>
                <th scope="col">{t('reports.distribution.issue')}</th>
                <th scope="col" className="num">{t('reports.distribution.took')}</th>
                <th scope="col">{t('reports.distribution.started')}</th>
                <th scope="col">{t('reports.distribution.resolved')}</th>
              </tr>
            </thead>
            <tbody>
              {slowest.map((i) => (
                <tr key={i.issue}>
                  <th scope="row">
                    <Link className="issue-id" to={`/issues/${i.issue}`}>
                      {i.issue}
                    </Link>{' '}
                    {i.summary}
                    {i.reopened ? <span className="item-about">{t('reports.distribution.reopenedOnTheWay')}</span> : null}
                  </th>
                  <td className="num">{daysOf(i.days)}</td>
                  <td>{dayMonth(i.started.slice(0, 10))}</td>
                  <td>{dayMonth(i.resolved.slice(0, 10))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {c.notStarted.length ? (
        <p className="note">{tr('reports.distribution.issuesResolvedNeverStarted', { n: c.notStarted.length, states: formatList(c.startStates, 'disjunction'), map: c.notStarted.slice(0, 8).map((i, k) => (
            <span key={i.issue}>
              {k ? ', ' : ''}
              <Link className="issue-id" to={`/issues/${i.issue}`}>
                {i.issue}
              </Link>
            </span>
          )), v2: c.notStarted.length > 8 ? '…' : '.' })}</p>
      ) : null}
    </div>
  );
}
