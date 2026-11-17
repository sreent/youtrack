/**
 * A sprint's burndown: Ocean's Burndown (components/Burndown). What's left at the end of each
 * working day in the first series, the ideal dashed as a guide, and each day the sprint's scope
 * changed ringed in the colour of a change, with how much; how it stands as a badge and in words;
 * and the figures as a table beside it.
 */
import type { Burndown } from '@a4a/shared';
import { hoursWords } from '../common/format';
import { useId } from 'react';
import { Link } from 'react-router';
import { Badge } from '../../components/Badges';
import { dayMonth, span } from '../plan/dates';
import { hoursOf, labelled, labelRoom, niceScale, pathThrough, plotHeight, plotWidth, useChartWidth, type Frame } from './chart';
import { t, tr } from '../../i18n';

const FRAME: Frame = { width: 640, height: 250, left: 46, right: 76, top: 18, bottom: 32 };

const VERDICT: Record<Burndown['status']['verdict'], { tone: 'good' | 'warn' | 'bad' | 'idle'; word: string }> = {
  on_track: { tone: 'good', word: t('reports.burndown.onTrack') },
  ahead: { tone: 'good', word: t('reports.burndown.ahead') },
  done: { tone: 'good', word: t('reports.burndown.done') },
  behind: { tone: 'warn', word: t('reports.burndown.behind') },
  ended: { tone: 'bad', word: t('reports.burndown.endedWithWorkLeft') },
  not_started: { tone: 'idle', word: t('reports.burndown.notStarted') },
  empty: { tone: 'idle', word: t('reports.burndown.nothingInIt') },
};

/** Its figure in the report's unit: "12h" by estimate, "3 issues" by count. */
export function burnAmount(b: Burndown, n: number): string {
  return b.by === 'count' ? t('count.issues', { n: Math.round(n) }) : hoursOf(n);
}

const short = (b: Burndown, n: number) => (b.by === 'count' ? String(Math.round(n)) : hoursOf(n));

export function BurndownVerdict({ b }: { b: Burndown }) {
  const v = VERDICT[b.status.verdict];
  return (
    <div className="report-says">
      <Badge tone={v.tone}>{v.word}</Badge>
      <p>{b.status.words}</p>
    </div>
  );
}

export function BurndownChart({ b, compact }: { b: Burndown; compact?: boolean }) {
  const titleId = useId();
  const [ref, width] = useChartWidth();
  const f = { ...FRAME, width };
  const n = b.days.length;
  const values = [b.start, ...b.days.map((d) => d.remaining ?? 0)];
  const scale = niceScale(b.by === 'count' ? Math.max(...values) : Math.max(...values) / 60, 1);
  const top = b.by === 'count' ? scale.max : scale.max * 60;
  const x = (i: number) => f.left + (n ? (plotWidth(f) * i) / n : 0);
  const y = (v: number) => f.top + plotHeight(f) * (1 - (top ? v / top : 0));
  const base = f.top + plotHeight(f);
  // The points: the commitment at the start of the first day, then each day's end as far as now.
  const known = b.days.map((d, i) => ({ d, i: i + 1 })).filter((p) => p.d.remaining !== null);
  const line: [number, number][] = [[x(0), y(b.start)], ...known.map((p) => [x(p.i), y(p.d.remaining!)] as [number, number])];
  const last = known.at(-1);
  const changed = known.filter((p) => p.d.added > 0 || p.d.removed > 0);
  // Name the biggest few changes of scope, never every one.
  const named = new Set(
    [...changed]
      .sort((a, z) => Math.abs(z.d.added - z.d.removed) - Math.abs(a.d.added - a.d.removed))
      .slice(0, compact ? 2 : 4)
      .map((p) => p.i),
  );
  const todayIndex = b.days.findIndex((d) => d.date === b.today);
  const showToday = todayIndex >= 0 && b.status.verdict !== 'ended';
  const xLabels = labelled(n, labelRoom(f));
  const title = t('reports.burndown.whatSLeftOfAt', { name: b.sprint.name, v: compact ? t('reports.burndown.underIt') : t('reports.burndown.besideIt') });
  // Columns with nothing in them on any day are left out, so the table fits beside the chart.
  const has = {
    done: b.days.some((d) => d.completed),
    added: b.days.some((d) => d.added),
    removed: b.days.some((d) => d.removed),
    spent: b.days.some((d) => d.spentMinutes),
  };

  const chart = (
    <figure className="chart" ref={ref}>
      <svg viewBox={`0 0 ${f.width} ${f.height}`} role="img" aria-labelledby={titleId}>
        <title id={titleId}>{title}</title>
        {scale.ticks.map((t) => {
          const v = b.by === 'count' ? t : t * 60;
          return (
            <g key={t}>
              <line className="chart-grid" x1={f.left} x2={f.width - f.right} y1={y(v)} y2={y(v)} />
              <text x={f.left - 8} y={y(v) + 4} textAnchor="end">
                {b.by === 'count' ? t : hoursWords(t)}
              </text>
            </g>
          );
        })}
        <line className="chart-axis" x1={f.left} x2={f.width - f.right} y1={base} y2={base} />
        {b.days.map((d, i) =>
          xLabels.has(i) ? (
            <g key={d.date}>
              <line className="chart-axis" x1={x(i + 1)} x2={x(i + 1)} y1={base} y2={base + 4} />
              <text x={x(i + 1)} y={base + 17} textAnchor="middle">
                {dayMonth(d.date)}
              </text>
            </g>
          ) : null,
        )}
        {/* Today is named in the key, not on the plot, where the day's own figures are. */}
        {showToday ? <line className="chart-today" x1={x(todayIndex + 1)} x2={x(todayIndex + 1)} y1={f.top} y2={base} /> : null}
        {n ? <path className="burn-ideal" d={pathThrough([[x(0), y(b.start)], [x(n), y(0)]])} /> : null}
        <path className="chart-line s1" d={pathThrough(line)} />
        {changed.map((p) => {
          const net = p.d.added - p.d.removed;
          return (
            <g key={p.d.date}>
              <circle className="burn-scope" cx={x(p.i)} cy={y(p.d.remaining!)} r={4.5} />
              {named.has(p.i) && net !== 0 ? (
                <text className="chart-label" x={x(p.i)} y={y(p.d.remaining!) - 10} textAnchor="middle">
                  {net > 0 ? '+' : '−'}
                  {short(b, Math.abs(net))}
                </text>
              ) : null}
            </g>
          );
        })}
        {last ? (
          <g>
            <circle className="chart-dot s1" cx={x(last.i)} cy={y(last.d.remaining!)} r={4} />
            <text className="chart-label" x={x(last.i) + 9} y={y(last.d.remaining!) + 4}>{tr('reports.burndown.left', { short: short(b, last.d.remaining!) })}</text>
          </g>
        ) : (
          <circle className="chart-dot s1" cx={x(0)} cy={y(b.start)} r={4} />
        )}
      </svg>
      <figcaption>
        <ul className="chart-key">
          <li>{tr('reports.burndown.whatSLeft', { el: <svg width="22" height="10" aria-hidden="true">
              <path className="chart-line s1" d="M1 5H21" />
            </svg> })}</li>
          <li>{tr('reports.burndown.ideal', { el: <svg width="22" height="10" aria-hidden="true">
              <path className="burn-ideal" d="M1 5H21" />
            </svg> })}</li>
          {changed.length ? (
            <li>{tr('reports.burndown.scopeChanged', { el: <svg width="12" height="12" aria-hidden="true">
                <circle className="burn-scope" cx="6" cy="6" r="4.5" />
              </svg> })}</li>
          ) : null}
          {showToday ? (
            <li>{tr('reports.burndown.today', { el: <svg width="6" height="14" aria-hidden="true">
                <path className="chart-today" d="M3 0V14" />
              </svg> })}</li>
          ) : null}
        </ul>
      </figcaption>
    </figure>
  );

  const table = (
    <div className="figures-scroll" tabIndex={0} role="group" aria-label={t('reports.burndown.dayByDay', { name: b.sprint.name })}>
      <table className="figures chart-figures">
        <caption>{tr('reports.burndown.dayByDay2', { v: b.by === 'count' ? t('reports.burndown.inIssues') : t('reports.burndown.inHoursOfEstimate') })}</caption>
        <thead>
          <tr>
            <th scope="col">{t('reports.burndown.day')}</th>
            <th scope="col" className="num">{t('reports.burndown.left2')}</th>
            <th scope="col" className="num">{t('reports.burndown.ideal2')}</th>
            {has.done ? (
              <th scope="col" className="num">{t('reports.burndown.done')}</th>
            ) : null}
            {has.added ? (
              <th scope="col" className="num">{t('reports.burndown.added')}</th>
            ) : null}
            {has.removed ? (
              <th scope="col" className="num">{t('reports.burndown.removed')}</th>
            ) : null}
            {has.spent ? (
              <th scope="col" className="num">{t('reports.burndown.logged')}</th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">{t('reports.burndown.atTheStart')}</th>
            <td className="num">{short(b, b.start)}</td>
            <td className="num">{short(b, b.start)}</td>
            {has.done ? <td className="num" /> : null}
            {has.added ? <td className="num" /> : null}
            {has.removed ? <td className="num" /> : null}
            {has.spent ? <td className="num" /> : null}
          </tr>
          {b.days.map((d) => (
            <tr key={d.date} className={d.date === b.today ? t('reports.burndown.today3') : undefined}>
              <th scope="row">
                {dayMonth(d.date)}
                {d.date === b.today ? t('reports.burndown.today2') : ''}
              </th>
              <td className="num">{d.remaining === null ? '' : short(b, d.remaining)}</td>
              <td className="num">{short(b, d.ideal)}</td>
              {has.done ? <td className="num">{d.completed ? short(b, d.completed) : ''}</td> : null}
              {has.added ? <td className="num">{d.added ? short(b, d.added) : ''}</td> : null}
              {has.removed ? <td className="num">{d.removed ? short(b, d.removed) : ''}</td> : null}
              {has.spent ? <td className="num">{d.spentMinutes ? hoursOf(d.spentMinutes) : ''}</td> : null}
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
          <summary>{t('reports.burndown.theFigures')}</summary>
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

/** The burndown with its head: the sprint, its dates, how it stands, and what changed. */
export function BurndownReport({ b, compact }: { b: Burndown; compact?: boolean }) {
  const kinds: Record<string, string> = { added: t('reports.burndown.added'), removed: t('reports.burndown.takenOut'), deleted: t('reports.burndown.deleted'), resolved: t('reports.burndown.resolved'), reopened: t('reports.burndown.reopened'), estimate: t('reports.burndown.estimateChanged') };
  return (
    <div className="report">
      {!compact ? (
        <div className="report-head">
          <h2>
            {b.sprint.name} <span className="note">{tr('reports.burndown.on', { name: b.sprint.board.name })}</span>
          </h2>
          <p className="note">
            {span(b.sprint.startDate, b.sprint.endDate)}, {t('count.workingDays', { n: b.workingDays })}
            {b.sprint.goal ? ` · ${b.sprint.goal}` : ''}
          </p>
        </div>
      ) : null}
      <BurndownVerdict b={b} />
      <dl className="report-facts">
        <div>
          <dt>{t('reports.burndown.committed')}</dt>
          <dd>{burnAmount(b, b.start)}</dd>
        </div>
        <div>
          <dt>{t('reports.burndown.left2')}</dt>
          <dd>{burnAmount(b, b.remaining)}</dd>
        </div>
        <div>
          <dt>{t('reports.burndown.scopeChanged2')}</dt>
          <dd>{b.added || b.removed ? [b.added ? `+${short(b, b.added)}` : '', b.removed ? `−${short(b, b.removed)}` : ''].filter(Boolean).join(', ') : t('reports.burndown.no')}</dd>
        </div>
        {!compact ? (
          <div>
            <dt>{t('reports.burndown.workingDaysLeft')}</dt>
            <dd>{b.workingDaysLeft}</dd>
          </div>
        ) : null}
      </dl>
      <BurndownChart b={b} compact={compact} />
      {b.warnings.length ? (
        <ul className="note">
          {b.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      {!compact && b.changes.length ? (
        <details className="chart-more">
          <summary>{tr('reports.burndown.changesToItsScope', { n: b.changes.length })}</summary>
          <ul>
            {b.changes.map((c, i) => (
              <li key={`${c.at}-${c.issue}-${i}`}>
                {dayMonth(c.date)}: {kinds[c.kind]} <Link to={`/issues/${c.issue}`}>{c.issue}</Link> {c.summary}, {c.amount > 0 ? '+' : '−'}
                {burnAmount(b, Math.abs(c.amount))}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
