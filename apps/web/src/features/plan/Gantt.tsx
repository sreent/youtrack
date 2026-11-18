/**
 * Ocean's Gantt (components/Gantt): the tasks in a list beside the chart, sharing its rows; the
 * critical path in ink and twice as heavy; the baseline a ghost beneath; slack a dashed tail; a
 * late task's due date and its words; summaries as brackets; milestones as diamonds; today. The
 * chart is SVG drawn from attributes alone, so it needs no style of its own, and is hidden from
 * screen readers: the list says in words what it shows.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { IssueLink } from '../../app/places';
import { addDays, dayMonth, diffDays, localToday, span, weekday, type WorkCalendar } from './dates';
import { anchors, DAY, ganttRange, HEAD, linkHead, linkPath, restDays, ROW, rowTop, scale, type GanttTask, type Scale } from './gantt';
import { formatItems, formatList, t as tw_, tr } from '../../i18n';

interface Props {
  /** The plan's name, for what the chart is called. */
  title: string;
  rows: GanttTask[];
  start: string;
  finish: string;
  today: string;
  cal: WorkCalendar;
  baselineName: string | null;
  whatIf: boolean;
  /** Scroll to today when this changes (the project opened), not on every read. */
  scrollKey: string;
}

/**
 * What the chart shows of a task, in words, for the list's screen-reader text: what follows the name
 * its link says, each part after the comma the page's language puts between items ("、" in Japanese).
 */
function said(t: GanttTask, names: Map<string, string>, today: string): string {
  const parts: string[] = [];
  if (t.kind === 'milestone') parts.push(tw_('plan.gantt.aMilestone2'));
  if (t.critical) parts.push(tw_('plan.gantt.onTheCriticalPath'));
  if (t.late) parts.push(tw_(t.late.due < today ? 'plan.gantt.daysLateWasDue' : 'plan.gantt.daysLateIsDue', { n: t.late.days, when: dayMonth(t.late.due) }));
  if (t.slackTo) parts.push(tw_('plan.gantt.daysOfSlack', { n: t.slackDays }));
  if (t.after.length) parts.push(tw_('plan.gantt.after', { andList: formatList(t.after.map((id) => names.get(id) ?? id)) }));
  if (t.baseline) parts.push(tw_('plan.gantt.plannedFor', { span: span(t.baseline.start, t.baseline.finish) }));
  if (t.whatIf) parts.push(tw_('plan.gantt.inTheWhatIf', { span: span(t.whatIf.start, t.whatIf.finish) }));
  // The name the link says goes first, so the comma after it is the one Thai sets beside it; then it's cut.
  return parts.length ? formatItems([t.name, ...parts]).slice(t.name.length) : '';
}

function Axis({ s, cal, height }: { s: Scale; cal: WorkCalendar; height: number }) {
  const rest = restDays(s, cal);
  const mondays: string[] = [];
  const dates: string[] = [];
  for (let i = 0; i < s.days; i++) {
    const d = addDays(s.from, i);
    dates.push(d);
    if (weekday(d) === 1) mondays.push(d);
  }
  const rows = Math.round((height - HEAD) / ROW);
  return (
    <>
      {rest.map(([d, count]) => (
        <rect key={d} className="gantt-weekend" x={s.x(d)} y={HEAD} width={count * s.dayWidth} height={height - HEAD} />
      ))}
      {Array.from({ length: Math.max(0, rows - 1) }, (_, r) => {
        const y = rowTop(r + 1) - 0.5;
        return <line key={`r${r}`} className="gantt-rule" x1={0} x2={s.width} y1={y} y2={y} />;
      })}
      <line className="gantt-rule" x1={0} x2={s.width} y1={HEAD - 0.5} y2={HEAD - 0.5} />
      {mondays
        .filter((m) => s.x(m) > 0)
        .map((m) => (
          <line key={`w${m}`} className="gantt-rule" x1={s.x(m) - 0.5} x2={s.x(m) - 0.5} y1={0} y2={height} />
        ))}
      {mondays.map((m) => (
        <text key={`l${m}`} className="gantt-week" x={s.x(m) + 5} y={15}>
          {dayMonth(m)}
        </text>
      ))}
      {dates.map((d) => (
        <text key={`d${d}`} x={s.x(d) + s.dayWidth / 2} y={33} textAnchor="middle">
          {Number(d.slice(8, 10))}
        </text>
      ))}
    </>
  );
}

function Links({ rows, s }: { rows: GanttTask[]; s: Scale }) {
  const at = new Map(rows.map((t, i) => [t.id, i]));
  const out: React.ReactNode[] = [];
  rows.forEach((t, r) => {
    for (const p of t.after) {
      const pr = at.get(p);
      if (pr === undefined) continue;
      const from = rows[pr]!;
      const sx = anchors(from, s).end;
      const tx = anchors(t, s).start;
      const sy = rowTop(pr) + 14;
      const ty = rowTop(r) + 14;
      const critical = from.critical && t.critical;
      out.push(
        <path key={`${p}>${t.id}`} className={critical ? 'gantt-link critical' : 'gantt-link'} d={linkPath(sx, sy, tx, ty, rowTop(r))} />,
        <path key={`${p}>${t.id}:h`} className={critical ? 'gantt-link-head critical' : 'gantt-link-head'} d={linkHead(tx, ty)} />,
      );
    }
  });
  return <>{out}</>;
}

function Bracket({ t, top, s }: { t: GanttTask; top: number; s: Scale }) {
  const x1 = s.x(t.start) + 2;
  const x2 = s.end(t.finish) - 2;
  return <path className="gantt-summary" d={`M${x1} ${top + 21}V${top + 12}H${x2}V${top + 21}`} data-task={t.id} />;
}

const diamond = (cx: number, top: number) => `M${cx} ${top + 6}l8 8 -8 8 -8 -8z`;

function Task({ t, top, s }: { t: GanttTask; top: number; s: Scale }) {
  const cls = ['gantt-task', t.critical ? 'critical' : '', t.late ? 'late' : ''].filter(Boolean).join(' ');
  const half = s.dayWidth / 2;
  const base = t.baseline ? (
    t.kind === 'milestone' ? (
      <rect className="gantt-base" x={s.x(t.baseline.start) + half - 5} y={top + 24} width={10} height={4} rx={2} />
    ) : (
      <rect className="gantt-base" x={s.x(t.baseline.start) + 2} y={top + 24} width={Math.max(2, s.end(t.baseline.finish) - s.x(t.baseline.start) - 4)} height={4} rx={2} />
    )
  ) : null;
  const end = t.kind === 'milestone' ? s.x(t.start) + half + 8 : s.end(t.finish) - 2;
  const latest = t.slackTo ? s.end(t.slackTo) - 2 : null;
  const slack =
    latest !== null && latest > end + 3 ? (
      <>
        <path className="gantt-slack" d={`M${end + 3} ${top + 14}H${latest}`} />
        <path className="gantt-slack-end" d={`M${latest} ${top + 10}v8`} />
      </>
    ) : null;
  let shape: React.ReactNode;
  if (t.kind === 'milestone') {
    shape = <path className="gantt-milestone" d={diamond(s.x(t.start) + half, top)} />;
  } else {
    const x = s.x(t.start) + 2;
    const w = s.end(t.finish) - s.x(t.start) - 4;
    shape = (
      <>
        <rect className="gantt-bar" x={x} y={top + 8} width={w} height={12} rx={4} />
        {t.done > 0 ? <rect className="gantt-done-part" x={x + 2} y={top + 10} width={Math.round((w - 4) * Math.min(100, t.done)) / 100} height={8} rx={2.5} /> : null}
      </>
    );
  }
  const late = t.late ? (
    <>
      <line className="gantt-due" x1={s.end(t.late.due)} x2={s.end(t.late.due)} y1={top + 4} y2={top + 24} />
      <path className="gantt-late-mark" d={`M${end + 16} ${top + 10}l8 8M${end + 24} ${top + 10}l-8 8`} />
      <text className="gantt-late" x={end + 29} y={top + 18}>{tr('plan.gantt.daysLate', { n: t.late.days })}</text>
    </>
  ) : null;
  // Days its assignee is away while it's on: shaded behind the bar, half a day dashed (D43).
  const away = t.away.map((a) => (
    <rect key={a.date} className={a.part === 'day' ? 'gantt-away' : 'gantt-away half'} x={s.x(a.date)} y={top + 3} width={s.dayWidth} height={22}>
      <title>{a.part === 'day' ? tw_('plan.gantt.away') : tw_('plan.gantt.awayPart', { part: a.part /* a stable code the message selects on */ })}</title>
    </rect>
  ));
  return (
    <g className={cls} data-task={t.id}>
      {away}
      {base}
      {slack}
      {shape}
      {late}
    </g>
  );
}

/** Where a what-if would put a task: dashed, in the colour of a change, as what isn't so. */
function WhatIfMark({ t, top, s }: { t: GanttTask; top: number; s: Scale }) {
  const w = t.whatIf!;
  if (t.kind === 'milestone') return <path className="gantt-whatif" d={diamond(s.x(w.start) + s.dayWidth / 2, top)} data-task={t.id} />;
  return <rect className="gantt-whatif" x={s.x(w.start) + 2} y={top + 8} width={s.end(w.finish) - s.x(w.start) - 4} height={12} rx={4} data-task={t.id} />;
}

/** How wide the chart's part of the frame is, so a short plan's days fill it rather than leave a gap. */
function useChartRoom(scroller: React.RefObject<HTMLDivElement | null>): number {
  const [room, setRoom] = useState(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      const side = el.querySelector<HTMLElement>('.gantt-side')?.offsetWidth ?? 0;
      setRoom(Math.max(0, el.clientWidth - side));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scroller]);
  return room;
}

export function Gantt({ title, rows, start, finish, today, cal, baselineName, whatIf, scrollKey }: Props) {
  const titleId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const room = useChartRoom(scroller);
  const range = useMemo(() => {
    let r = ganttRange(rows, start, finish, today);
    // Room for a late task's words after its bar.
    const lastLate = rows.reduce<string | null>((m, t) => (t.late && (!m || t.finish > m) ? t.finish : m), null);
    if (lastLate && addDays(lastLate, 7) > r.to) r = { from: r.from, to: addDays(r.to, 7) };
    // A short plan: more days after it, as many as fill the frame, so it leaves no gap.
    const fit = Math.floor(room / DAY);
    if (fit > diffDays(r.from, r.to) + 1) r = { from: r.from, to: addDays(r.from, fit - 1) };
    return r;
  }, [rows, start, finish, today, room]);
  const s = useMemo(() => scale(range.from, range.to), [range]);
  const height = HEAD + ROW * rows.length;
  const names = useMemo(() => new Map(rows.map((t) => [t.id, t.name])), [rows]);
  // Today's line sits at the hour of the day, when the browser's day is the plan's.
  const now = new Date();
  const dayPart = localToday(now) === today ? (now.getHours() + now.getMinutes() / 60) / 24 : 0.5;
  const todayX = Math.round((s.x(today) + s.dayWidth * dayPart) * 10) / 10;

  const scrolledFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || scrolledFor.current === scrollKey) return;
    scrolledFor.current = scrollKey;
    const side = el.querySelector<HTMLElement>('.gantt-side')?.offsetWidth ?? 0;
    const room = el.clientWidth - side;
    el.scrollLeft = Math.max(0, todayX - room * 0.25);
  }, [scrollKey, todayX]);

  return (
    <section className="gantt gantt-box" aria-labelledby={titleId}>
      <h2 id={titleId} className="hidden">{tr('plan.gantt.byDay', { title: title })}</h2>
      <div ref={scroller} className="gantt-scroll" tabIndex={0} role="group" aria-label={`${title}, ${span(start, finish)}`}>
        <div className="gantt-grid">
          <div className="gantt-side">
            <div className="gantt-side-head" aria-hidden="true">
              <span>{tw_('plan.gantt.task')}</span>
              <span>{tw_('plan.gantt.when')}</span>
              <span>{tw_('plan.gantt.done')}</span>
            </div>
            <ol className="gantt-rows">
              {rows.map((t) => (
                <li key={t.id} className={['gantt-row', t.kind === 'summary' ? 'summary' : '', t.late ? 'late' : ''].filter(Boolean).join(' ')} data-depth={t.depth}>
                  <span className="gantt-name" title={t.name}>
                    <IssueLink id={t.id}>{t.name}</IssueLink>
                    <span className="hidden">{said(t, names, today)}</span>
                  </span>
                  <span className="gantt-when">{span(t.start, t.finish)}</span>
                  <span className="gantt-done">
                    {t.kind === 'milestone' && !t.resolved ? null : (
                      <>
                        {Math.round(t.done)}%<span className="hidden">{tw_('plan.gantt.done2')}</span>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </div>
          <svg className="gantt-chart" width={s.width} height={height} viewBox={`0 0 ${s.width} ${height}`} aria-hidden="true">
            <Axis s={s} cal={cal} height={height} />
            <Links rows={rows} s={s} />
            {rows.map((t, r) => (t.kind === 'summary' ? <Bracket key={t.id} t={t} top={rowTop(r)} s={s} /> : null))}
            {rows.map((t, r) => (t.kind === 'summary' ? null : <Task key={t.id} t={t} top={rowTop(r)} s={s} />))}
            {rows.map((t, r) => (t.whatIf && t.kind !== 'summary' ? <WhatIfMark key={`w${t.id}`} t={t} top={rowTop(r)} s={s} /> : null))}
            {today >= s.from && todayX <= s.width ? (
              <>
                <line className="gantt-today" x1={todayX} x2={todayX} y1={34} y2={height} />
                <text className="gantt-today-label" x={todayX + 4} y={62}>{tw_('plan.gantt.today')}</text>
              </>
            ) : null}
          </svg>
        </div>
      </div>
      <ul className="gantt-legend">
        <li>{tr('plan.gantt.aTaskWhatSDone', { el: <svg width="28" height="14" aria-hidden="true">
            <rect className="gantt-bar" x="1" y="1" width="26" height="12" rx="4" />
            <rect className="gantt-done-part" x="3" y="3" width="13" height="8" rx="2.5" />
          </svg> })}</li>
        <li>{tr('plan.gantt.theCriticalPathInkTwice', { el: <svg width="28" height="14" aria-hidden="true">
            <g className="gantt-task critical">
              <rect className="gantt-bar" x="1.5" y="1.5" width="25" height="11" rx="4" />
            </g>
          </svg> })}</li>
        {baselineName ? (
          <li>{tr('plan.gantt.theBaselineFadedBeneath', { el: <svg width="28" height="14" aria-hidden="true">
              <rect className="gantt-base" x="1" y="5" width="26" height="4" rx="2" />
            </svg>, baselineName: baselineName })}</li>
        ) : null}
        <li>{tr('plan.gantt.slackHowFarItCan', { el: <svg width="28" height="14" aria-hidden="true">
            <path className="gantt-slack" d="M2 7H25" />
            <path className="gantt-slack-end" d="M25 3v8" />
          </svg> })}</li>
        <li>{tr('plan.gantt.aMilestone', { el: <svg width="28" height="14" aria-hidden="true">
            <path className="gantt-milestone" d="M14 0l7 7 -7 7 -7 -7z" />
          </svg> })}</li>
        <li>{tr('plan.gantt.today2', { el: <svg width="28" height="14" aria-hidden="true">
            <line className="gantt-today" x1="14" x2="14" y1="0" y2="14" />
          </svg> })}</li>
        {whatIf ? (
          <li>{tr('plan.gantt.whereTheWhatIfWould', { el: <svg width="28" height="14" aria-hidden="true">
              <rect className="gantt-whatif" x="1.5" y="1.5" width="25" height="11" rx="4" />
            </svg> })}</li>
        ) : null}
      </ul>
    </section>
  );
}
