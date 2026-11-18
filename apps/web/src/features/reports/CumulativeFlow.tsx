/**
 * Cumulative flow: Ocean's CumulativeFlow (components/CumulativeFlow). A band for each state, how
 * many issues were in it at the end of each day, stacked with the resolved at the foot. A state's
 * band takes the colour of how it stands (resolved, waiting on someone, failed, or open), never a
 * series colour; bands of one colour are told apart by the card's colour between them and by their
 * names at their ends, and the figures are in the table beside it.
 */
import type { Flow, FlowState } from '@a4a/shared';
import { useId } from 'react';
import { dayMonth } from '../plan/dates';
import { labelled, labelRoom, niceScale, plotHeight, plotWidth, useChartWidth, type Frame } from './chart';
import { formatItems, t, tr } from '../../i18n';

const FRAME: Frame = { width: 640, height: 260, left: 40, right: 118, top: 12, bottom: 32 };

export type Standing = 'done' | 'waiting' | 'failed' | 'open';
const STANDING_WORDS: Record<Standing, string> = { done: t('reports.cumulativeFlow.resolved'), waiting: t('reports.cumulativeFlow.waitingOnSomeone'), failed: t('reports.cumulativeFlow.failed'), open: t('reports.cumulativeFlow.open') };

/** How a state stands, in Ocean's words for how things stood. */
export function standingOf(s: FlowState): Standing {
  if (s.resolved) return 'done';
  if (s.tone === 'warn') return 'waiting';
  if (s.tone === 'bad') return 'failed';
  return 'open';
}

export function CumulativeFlowChart({ flow, compact }: { flow: Flow; compact?: boolean }) {
  const titleId = useId();
  const [ref, width] = useChartWidth();
  const f = { ...FRAME, width };
  const used = flow.states.map((s, k) => ({ s, k })).filter(({ k }) => flow.days.some((d) => (d.counts[k] ?? 0) > 0));
  // Stacked from the foot: the last state in the workflow lowest, the resolved ones first.
  const stack = [...used].reverse();
  const n = flow.days.length;
  const max = Math.max(1, ...flow.days.map((d) => used.reduce((sum, u) => sum + (d.counts[u.k] ?? 0), 0)));
  const scale = niceScale(max, 1);
  const x = (i: number) => f.left + (n > 1 ? (plotWidth(f) * i) / (n - 1) : plotWidth(f) / 2);
  const y = (v: number) => f.top + plotHeight(f) * (1 - v / scale.max);
  const base = f.top + plotHeight(f);
  const lower = flow.days.map(() => 0);
  const bands = stack.map(({ s, k }) => {
    const from = [...lower];
    flow.days.forEach((d, i) => (lower[i]! += d.counts[k] ?? 0));
    const to = [...lower];
    const xs = n > 1 ? flow.days.map((_, i) => x(i)) : [f.left, f.left + plotWidth(f)];
    const at = (arr: number[], i: number) => (n > 1 ? arr[i]! : arr[0]!);
    const topEdge = xs.map((px, i) => `${i ? 'L' : 'M'}${px.toFixed(1)} ${y(at(to, i)).toFixed(1)}`).join('');
    const bottomEdge = xs
      .map((px, i) => [px, y(at(from, i))] as const)
      .reverse()
      .map(([px, py]) => `L${px.toFixed(1)} ${py.toFixed(1)}`)
      .join('');
    const lastFrom = from[from.length - 1]!;
    const lastTo = to[to.length - 1]!;
    return { s, k, d: `${topEdge}${bottomEdge}Z`, mid: (y(lastFrom) + y(lastTo)) / 2, height: y(lastFrom) - y(lastTo), count: lastTo - lastFrom };
  });
  const xLabels = labelled(n, labelRoom(f));
  const groups = (['done', 'waiting', 'failed', 'open'] as Standing[])
    .map((g) => ({ g, names: used.filter((u) => standingOf(u.s) === g).map((u) => u.s.name) }))
    .filter((x) => x.names.length);
  const last = flow.days.at(-1);

  const chart = (
    <figure className="chart" ref={ref}>
      <svg viewBox={`0 0 ${f.width} ${f.height}`} role="img" aria-labelledby={titleId}>
        <title id={titleId}>{t('reports.cumulativeFlow.issuesInEachStateAt', { v: flow.days.length ? t('reports.cumulativeFlow.to', { when: dayMonth(flow.days[0]!.date), when2: dayMonth(flow.days.at(-1)!.date) }) : '' })}</title>
        {scale.ticks.map((t) => (
          <g key={t}>
            <line className="chart-grid" x1={f.left} x2={f.width - f.right} y1={y(t)} y2={y(t)} />
            <text x={f.left - 8} y={y(t) + 4} textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        {bands.map((band) => (
          <path key={band.s.name} className="cfd-band" data-standing={standingOf(band.s)} d={band.d} />
        ))}
        <line className="chart-axis" x1={f.left} x2={f.width - f.right} y1={base} y2={base} />
        {flow.days.map((d, i) =>
          xLabels.has(i) ? (
            <g key={d.date}>
              <line className="chart-axis" x1={x(i)} x2={x(i)} y1={base} y2={base + 4} />
              <text x={x(i)} y={base + 17} textAnchor="middle">
                {dayMonth(d.date)}
              </text>
            </g>
          ) : null,
        )}
        {bands
          .filter((band) => band.height >= 13 && band.count > 0)
          .map((band) => (
            <text key={band.s.name} className="chart-label" x={f.width - f.right + 8} y={band.mid + 4}>
              {band.s.name} {band.count}
            </text>
          ))}
      </svg>
      <figcaption>
        <ul className="chart-key">
          {groups.map(({ g, names }) => (
            <li key={g}>
              <span className="chart-swatch" data-standing={g} aria-hidden="true" />
              {STANDING_WORDS[g]}: {formatItems(names)}
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );

  const table = (
    <div className="figures-scroll" tabIndex={0} role="group" aria-label={t('reports.cumulativeFlow.issuesInEachStateDay')}>
      <table className="figures chart-figures">
        <caption>{tr('reports.cumulativeFlow.atTheEndOfEach', { v: last && last.date === flow.scope.today ? t('reports.cumulativeFlow.todayAsItIsNow') : '' })}</caption>
        <thead>
          <tr>
            <th scope="col">{t('reports.cumulativeFlow.day')}</th>
            {used.map((u) => (
              <th key={u.s.name} scope="col" className="num">
                {u.s.name}
              </th>
            ))}
            <th scope="col" className="num">{t('reports.cumulativeFlow.all')}</th>
          </tr>
        </thead>
        <tbody>
          {[...flow.days].reverse().map((d) => (
            <tr key={d.date} className={d.date === flow.scope.today ? 'today' : undefined}>
              <th scope="row">
                {dayMonth(d.date)}
                {d.date === flow.scope.today ? t('reports.cumulativeFlow.today') : ''}
              </th>
              {used.map((u) => (
                <td key={u.s.name} className="num">
                  {d.counts[u.k] ?? 0}
                </td>
              ))}
              <td className="num">{d.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  if (!used.length) return <p className="note">{t('reports.cumulativeFlow.noIssuesWereInThis')}</p>;
  if (compact) {
    return (
      <>
        {chart}
        <details className="chart-more">
          <summary>{t('reports.cumulativeFlow.theFigures')}</summary>
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

export function CumulativeFlowReport({ flow, compact }: { flow: Flow; compact?: boolean }) {
  const last = flow.days.at(-1);
  const open = last ? flow.states.reduce((n, s, k) => n + (s.resolved ? 0 : (last.counts[k] ?? 0)), 0) : 0;
  const done = last ? flow.states.reduce((n, s, k) => n + (s.resolved ? (last.counts[k] ?? 0) : 0), 0) : 0;
  return (
    <div className="report">
      <dl className="report-facts">
        <div>
          <dt>{t('reports.cumulativeFlow.openNow')}</dt>
          <dd>{open}</dd>
        </div>
        <div>
          <dt>{t('reports.cumulativeFlow.resolved')}</dt>
          <dd>{done}</dd>
        </div>
        {!compact ? (
          <div>
            <dt>{t('reports.cumulativeFlow.counted')}</dt>
            <dd>
              {flow.scope.issues} <small>{flow.scope.includesDeleted ? t('reports.cumulativeFlow.withDeletedOnesOnTheir') : t('reports.cumulativeFlow.asTheQueryMatchesNow')}</small>
            </dd>
          </div>
        ) : null}
      </dl>
      <CumulativeFlowChart flow={flow} compact={compact} />
      {flow.noState ? <p className="note">{tr('reports.cumulativeFlow.issuesWithNoState', { n: flow.noState })}</p> : null}
    </div>
  );
}
