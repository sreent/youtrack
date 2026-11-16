/**
 * Cycle time as a distribution: Ocean's Distribution (components/Distribution). How many issues
 * took how long, in columns of the first series on equal buckets, with where the half and the 85th
 * percentile fall as lines in ink with their words; the figures at a glance and as tables.
 */
import type { CycleTime } from '@a4a/shared';
import { useId } from 'react';
import { Link } from 'react-router';
import { dayMonth } from '../plan/dates';
import { plural } from '../plan/format';
import { column, daysOf, labelled, labelRoom, niceScale, plotHeight, plotWidth, useChartWidth, type Frame } from './chart';

const FRAME: Frame = { width: 640, height: 240, left: 40, right: 24, top: 34, bottom: 34 };

const bucketWords = (from: number, to: number) => (to <= 1 ? `${Math.round(from * 24)}–${Math.round(to * 24)}h` : `${from}–${to} days`);

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
    { p: c.percentiles.p50, words: 'Half' },
    { p: c.percentiles.p85, words: '85%' },
  ].filter((m): m is { p: number; words: string } => m.p !== null);
  const edges = labelled(c.buckets.length + 1, labelRoom(f, 56));

  const chart = (
    <figure className="chart" ref={ref}>
      <svg viewBox={`0 0 ${f.width} ${f.height}`} role="img" aria-labelledby={titleId}>
        <title id={titleId}>How many issues took how long from start to resolved; the figures are in the table</title>
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
        {marks.map((m, i) => {
          const px = xv(Math.min(m.p, span));
          const close = i > 0 && Math.abs(px - xv(Math.min(marks[0]!.p, span))) < 90;
          return (
            <g key={m.words}>
              <line className="dist-mark" x1={px} x2={px} y1={f.top - 4} y2={base} />
              <text className="chart-label" x={px + 5} y={f.top - (close ? -10 : 10)}>
                {m.words} by {daysOf(m.p)}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption>
        <ul className="chart-key">
          <li>
            <span className="chart-swatch s1" aria-hidden="true" />
            Issues, by how long they took
          </li>
          <li>
            <svg width="12" height="12" aria-hidden="true">
              <path className="dist-mark" d="M6 0V12" />
            </svg>
            Where the half and 85% of them were done
          </li>
        </ul>
      </figcaption>
    </figure>
  );

  const table = (
    <div className="figures-scroll" tabIndex={0} role="group" aria-label="Issues by how long they took">
      <table className="figures chart-figures">
        <caption>How many took how long</caption>
        <thead>
          <tr>
            <th scope="col">Took</th>
            <th scope="col" className="num">
              Issues
            </th>
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

  if (!c.count) return <p className="note">No issue that had started was resolved in this window, so there is nothing to time.</p>;
  if (compact) {
    return (
      <>
        {chart}
        <details className="chart-more">
          <summary>The figures</summary>
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
          <dt>Resolved</dt>
          <dd>{c.count}</dd>
        </div>
        <div>
          <dt>Half within</dt>
          <dd>{fig(c.percentiles.p50)}</dd>
        </div>
        <div>
          <dt>85% within</dt>
          <dd>{fig(c.percentiles.p85)}</dd>
        </div>
        {!compact ? (
          <>
            <div>
              <dt>95% within</dt>
              <dd>{fig(c.percentiles.p95)}</dd>
            </div>
            <div>
              <dt>On average</dt>
              <dd>{fig(c.mean)}</dd>
            </div>
          </>
        ) : null}
      </dl>
      <DistributionChart c={c} compact={compact} />
      {!compact && slowest.length ? (
        <div className="figures-scroll" tabIndex={0} role="group" aria-label="The slowest">
          <table className="figures chart-figures">
            <caption>The slowest, from first {c.startStates.join(' or ')} to resolved</caption>
            <thead>
              <tr>
                <th scope="col">Issue</th>
                <th scope="col" className="num">
                  Took
                </th>
                <th scope="col">Started</th>
                <th scope="col">Resolved</th>
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
                    {i.reopened ? <span className="item-about">Reopened on the way</span> : null}
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
        <p className="note">
          {plural(c.notStarted.length, 'issue was', 'issues were')} resolved without ever being {c.startStates.join(' or ')}, so {c.notStarted.length === 1 ? 'it is' : 'they are'} left out:{' '}
          {c.notStarted.slice(0, 8).map((i, k) => (
            <span key={i.issue}>
              {k ? ', ' : ''}
              <Link className="issue-id" to={`/issues/${i.issue}`}>
                {i.issue}
              </Link>
            </span>
          ))}
          {c.notStarted.length > 8 ? '…' : '.'}
        </p>
      ) : null}
    </div>
  );
}
