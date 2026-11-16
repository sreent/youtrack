/**
 * Created against resolved: Ocean's CreatedResolved (components/CreatedResolved). For each day,
 * week or month, the issues created and the issues resolved, in columns side by side in the first
 * two series, on one scale; how many were open at the end of each is in the table, not on a second
 * scale.
 */
import type { CreatedResolved } from '@a4a/shared';
import { useId } from 'react';
import { dayMonth } from '../plan/dates';
import { column, labelled, labelRoom, niceScale, plotHeight, plotWidth, useChartWidth, type Frame } from './chart';
import { t, tr, monthNames } from '../../i18n';

const FRAME: Frame = { width: 640, height: 230, left: 40, right: 16, top: 14, bottom: 34 };
const MONTHS = monthNames();

function bucketName(r: CreatedResolved, from: string, to: string): string {
  if (r.interval === 'day') return dayMonth(from);
  if (r.interval === 'month') return `${MONTHS[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}`;
  return from === to ? dayMonth(from) : t('reports.createdResolved.to', { when: dayMonth(from), when2: dayMonth(to) });
}

export function CreatedResolvedChart({ r, compact }: { r: CreatedResolved; compact?: boolean }) {
  const titleId = useId();
  const [ref, width] = useChartWidth();
  const f = { ...FRAME, width };
  const n = r.buckets.length;
  const scale = niceScale(Math.max(1, ...r.buckets.flatMap((b) => [b.created, b.resolved])), 1);
  const y = (v: number) => f.top + plotHeight(f) * (1 - v / scale.max);
  const base = f.top + plotHeight(f);
  const slot = n ? plotWidth(f) / n : 0;
  const w = Math.max(2, Math.min(24, (slot - 6) / 2));
  const left = (i: number) => f.left + slot * i + (slot - (w * 2 + 2)) / 2;
  const xLabels = labelled(n, labelRoom(f));
  const label = (from: string) => (r.interval === 'month' ? `${MONTHS[Number(from.slice(5, 7)) - 1]}` : dayMonth(from));

  const chart = (
    <figure className="chart" ref={ref}>
      <svg viewBox={`0 0 ${f.width} ${f.height}`} role="img" aria-labelledby={titleId}>
        <title id={titleId}>{t('reports.createdResolved.issuesCreatedAndIssuesResolved', { interval: r.interval })}</title>
        {scale.ticks.map((t) => (
          <g key={t}>
            <line className="chart-grid" x1={f.left} x2={f.width - f.right} y1={y(t)} y2={y(t)} />
            <text x={f.left - 8} y={y(t) + 4} textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        {r.buckets.map((b, i) => (
          <g key={b.from}>
            {b.created ? <path className="chart-col s1" d={column(left(i), y(b.created), w, base)} /> : null}
            {b.resolved ? <path className="chart-col s2" d={column(left(i) + w + 2, y(b.resolved), w, base)} /> : null}
          </g>
        ))}
        <line className="chart-axis" x1={f.left} x2={f.width - f.right} y1={base} y2={base} />
        {r.buckets.map((b, i) =>
          xLabels.has(i) ? (
            <text key={b.from} x={f.left + slot * (i + 0.5)} y={base + 17} textAnchor="middle">
              {label(b.from)}
            </text>
          ) : null,
        )}
      </svg>
      <figcaption>
        <ul className="chart-key">
          <li>{tr('reports.createdResolved.created', { el: <span className="chart-swatch s1" aria-hidden="true" /> })}</li>
          <li>{tr('reports.createdResolved.resolved', { el: <span className="chart-swatch s2" aria-hidden="true" /> })}</li>
        </ul>
      </figcaption>
    </figure>
  );

  const table = (
    <div className="figures-scroll" tabIndex={0} role="group" aria-label={t('reports.createdResolved.createdAndResolvedBy', { interval: r.interval })}>
      <table className="figures chart-figures">
        <caption>{tr('reports.createdResolved.by', { interval: r.interval })}</caption>
        <thead>
          <tr>
            <th scope="col">{r.interval === 'day' ? t('reports.createdResolved.day') : r.interval === 'week' ? t('reports.createdResolved.week') : t('reports.createdResolved.month')}</th>
            <th scope="col" className="num">{t('reports.createdResolved.created2')}</th>
            <th scope="col" className="num">{t('reports.createdResolved.resolved2')}</th>
            <th scope="col" className="num">{t('reports.createdResolved.reopened')}</th>
            <th scope="col" className="num">{t('reports.createdResolved.openAtTheEnd')}</th>
          </tr>
        </thead>
        <tbody>
          {[...r.buckets].reverse().map((b) => (
            <tr key={b.from}>
              <th scope="row">{bucketName(r, b.from, b.to)}</th>
              <td className="num">{b.created}</td>
              <td className="num">{b.resolved}</td>
              <td className="num">{b.reopened || ''}</td>
              <td className="num">{b.open}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  if (compact) {
    return (
      <>
        {chart}
        <details className="chart-more">
          <summary>{t('reports.createdResolved.theFigures')}</summary>
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

export function CreatedResolvedReport({ r, compact }: { r: CreatedResolved; compact?: boolean }) {
  const open = r.buckets.at(-1)?.open ?? 0;
  const first = r.buckets[0];
  const before = first ? first.open - first.created + first.resolved - first.reopened : 0;
  return (
    <div className="report">
      <dl className="report-facts">
        <div>
          <dt>{t('reports.createdResolved.created2')}</dt>
          <dd>{r.totals.created}</dd>
        </div>
        <div>
          <dt>{t('reports.createdResolved.resolved2')}</dt>
          <dd>{r.totals.resolved}</dd>
        </div>
        <div>
          <dt>{t('reports.createdResolved.openNow')}</dt>
          <dd>
            {open}{' '}
            {!compact && first ? (
              <small>{tr('reports.createdResolved.atTheStart', { v: open > before ? t('reports.createdResolved.moreThan', { v: open - before }) : open < before ? t('reports.createdResolved.fewerThan', { v: before - open }) : t('reports.createdResolved.asManyAs') })}</small>
            ) : null}
          </dd>
        </div>
        {r.totals.reopened && !compact ? (
          <div>
            <dt>{t('reports.createdResolved.reopened')}</dt>
            <dd>{r.totals.reopened}</dd>
          </div>
        ) : null}
      </dl>
      <CreatedResolvedChart r={r} compact={compact} />
    </div>
  );
}
