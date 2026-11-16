/**
 * The Gantt's rows and geometry, as Ocean's contract draws them (components/Gantt): a head 40px
 * tall, then 32px a row (row r's top is 40 + 32r); each day `dayWidth` wide; a bar inset 2px
 * into its days, 12px tall at the row's top + 8, what's done 8px tall inside it; the baseline a
 * 4px ghost at + 24; a milestone a diamond centred in its day; finish-to-start curves with
 * corners of 4px, leaving 3px after a bar and arriving 5px before the next, its head 6px long.
 */
import type { Schedule, ScheduleTask } from '@a4a/shared';
import { addDays, diffDays, maxDate, minDate, mondayOf, sundayOf, type WorkCalendar } from './dates';

export const HEAD = 40;
export const ROW = 32;
export const DAY = 17;

export type GanttKind = 'task' | 'summary' | 'milestone';

export interface GanttTask {
  id: string;
  kind: GanttKind;
  name: string;
  depth: number;
  start: string;
  finish: string;
  /** 0 to 100. */
  done: number;
  resolved: boolean;
  baseline: { start: string; finish: string } | null;
  critical: boolean;
  /** Finishes after its due date: when it was due, and by how many working days. */
  late: { due: string; days: number } | null;
  /** The latest it may finish, when that's later than it will. */
  slackTo: string | null;
  slackDays: number;
  /** The tasks it follows (finish to start), in the plan. */
  after: string[];
  /** Where a what-if would put it, when that's elsewhere. */
  whatIf: { start: string; finish: string } | null;
  /** The days its assignee is away while it's on, and which part of each (D36, D43); never why. */
  away: { date: string; part: 'day' | 'morning' | 'afternoon' }[];
}

/** A milestone takes no time: the API has no flag for it, but a leaf of 0 working days is one. */
export const isMilestone = (t: ScheduleTask) => t.isMilestone;

export function ganttRows(s: Schedule, cal: WorkCalendar, whatIf: Schedule | null = null): GanttTask[] {
  const after = whatIf ? new Map(whatIf.tasks.map((t) => [t.issue.id, t])) : null;
  const inPlan = new Set(s.tasks.map((t) => t.issue.id));
  const awayOf = new Map((s.away ?? []).map((a) => [a.assignee, a.days]));
  return s.tasks.map((t) => {
    const w = after?.get(t.issue.id);
    const away = t.assignee && !t.isSummary ? (awayOf.get(t.assignee.login) ?? []).filter((d) => d.date >= t.start && d.date <= t.finish) : [];
    return {
      id: t.issue.id,
      kind: t.isSummary ? 'summary' : isMilestone(t) ? 'milestone' : 'task',
      name: t.issue.summary,
      depth: t.depth,
      start: t.start,
      finish: t.finish,
      done: t.percentComplete,
      resolved: t.issue.resolved,
      baseline: t.baseline ? { start: t.baseline.start, finish: t.baseline.finish } : null,
      critical: t.critical,
      late: t.late && t.deadline ? { due: t.deadline, days: Math.max(1, cal.between(t.deadline, t.finish)) } : null,
      slackTo: !t.isSummary && t.slackDays > 0 && t.lateFinish > t.finish ? t.lateFinish : null,
      slackDays: t.slackDays,
      after: t.predecessors.filter((p) => inPlan.has(p)),
      whatIf: w && (w.start !== t.start || w.finish !== t.finish) ? { start: w.start, finish: w.finish } : null,
      away,
    };
  });
}

/** The days the chart spans: from the Monday before the first date it shows to the Sunday after the last. */
export function ganttRange(rows: GanttTask[], start: string, finish: string, today: string): { from: string; to: string } {
  let lo = minDate(start, today);
  let hi = maxDate(finish, today);
  for (const r of rows) {
    for (const d of [r.start, r.finish, r.baseline?.start, r.baseline?.finish, r.slackTo, r.whatIf?.start, r.whatIf?.finish]) {
      if (!d) continue;
      lo = minDate(lo, d);
      hi = maxDate(hi, d);
    }
  }
  return { from: mondayOf(lo), to: sundayOf(hi) };
}

export interface Scale {
  from: string;
  days: number;
  dayWidth: number;
  /** The left edge of a day. */
  x(d: string): number;
  /** The right edge of a day. */
  end(d: string): number;
  width: number;
}

export function scale(from: string, to: string, dayWidth = DAY): Scale {
  const days = diffDays(from, to) + 1;
  return {
    from,
    days,
    dayWidth,
    x: (d) => diffDays(from, d) * dayWidth,
    end: (d) => (diffDays(from, d) + 1) * dayWidth,
    width: days * dayWidth,
  };
}

export const rowTop = (r: number) => HEAD + ROW * r;

/** Where a row's curves leave and arrive: a bar's ends, or a diamond's points. */
export function anchors(t: GanttTask, s: Scale): { start: number; end: number } {
  if (t.kind === 'milestone') {
    const cx = s.x(t.start) + s.dayWidth / 2;
    return { start: cx - 7, end: cx + 7 };
  }
  return { start: s.x(t.start) + 2, end: s.end(t.finish) - 2 };
}

const R = 4;
const n = (v: number) => Math.round(v * 10) / 10;

/**
 * A finish-to-start curve from (sx, sy) to (tx, ty). Where there's room, it turns down 7px after
 * the bar and runs along the next row to it; where there isn't, it runs back along the edge of
 * the next row's lane to just before its start.
 */
export function linkPath(sx: number, sy: number, tx: number, ty: number, targetTop: number): string {
  const e1 = sx + 7;
  const end = tx - 5;
  const dir = ty > sy ? 1 : -1;
  if (end >= e1 + R) {
    return `M${n(sx)} ${sy}H${n(e1 - R)}Q${n(e1)} ${sy} ${n(e1)} ${sy + R * dir}V${ty - R * dir}Q${n(e1)} ${ty} ${n(e1 + R)} ${ty}H${n(end)}`;
  }
  const run = dir > 0 ? targetTop + 2 : targetTop + ROW - 2;
  const e2 = end - R;
  return (
    `M${n(sx)} ${sy}H${n(e1 - R)}Q${n(e1)} ${sy} ${n(e1)} ${sy + R * dir}V${run - R * dir}Q${n(e1)} ${run} ${n(e1 - R)} ${run}` +
    `H${n(e2 + R)}Q${n(e2)} ${run} ${n(e2)} ${run + R * dir}V${ty - R * dir}Q${n(e2)} ${ty} ${n(e2 + R)} ${ty}H${n(end)}`
  );
}

export const linkHead = (tx: number, ty: number) => `M${n(tx)} ${ty}l-6 -3.5v7z`;

/** Runs of days the plan doesn't work (weekends, holidays), as [first, count]. */
export function restDays(s: Scale, cal: WorkCalendar): [string, number][] {
  const out: [string, number][] = [];
  for (let i = 0; i < s.days; i++) {
    const d = addDays(s.from, i);
    if (cal.isWorking(d)) continue;
    const last = out[out.length - 1];
    if (last && diffDays(last[0], d) === last[1]) last[1]++;
    else out.push([d, 1]);
  }
  return out;
}
