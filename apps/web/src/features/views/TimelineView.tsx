/**
 * The timeline of a search (D72), read-only: the plan of its scope as GET /plans/schedule answers it, across
 * projects, drawn with the plan's facts and Ocean's Gantt, each issue on its own project's days (D73). A plan
 * cut short at 2,000 issues says so, and how to narrow it. P5 makes it editable.
 */
import type { PlanSchedule, PlanScope, PlanSettings, Schedule } from '@a4a/shared';
import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Badge } from '../../components/Badges';
import { ErrorNote, Loading } from '../../components/States';
import { t, tr } from '../../i18n';
import { weekday, workCalendar } from '../plan/dates';
import { Facts, Warnings } from '../plan/Facts';
import { Gantt } from '../plan/Gantt';
import { ganttRows } from '../plan/gantt';
import { usePlanSchedule } from './api';
import type { ViewProps } from './types';

/** The most issues a plan holds (D72), as the server caps it. */
const MAX_PLAN_ISSUES = 2000;

/**
 * The days a plan counts across its projects (D73): a day works if any of their calendars works it, and is a
 * holiday only where every calendar working that weekday keeps it. With one calendar, that calendar.
 */
export function unionCalendar(s: PlanSchedule): Pick<PlanSettings, 'workingDays' | 'holidays'> {
  const cals = Object.values(s.calendars ?? {});
  if (cals.length < 2) return s.calendar;
  const workingDays = [...new Set(cals.flatMap((c) => c.workingDays))].sort((a, b) => a - b);
  const holidays = [...new Set(cals.flatMap((c) => c.holidays))].filter((d) => cals.every((c) => !c.workingDays.includes(weekday(d)) || c.holidays.includes(d))).sort();
  return { workingDays, holidays };
}

/** What a plan cut short says: how many of its search's issues it holds, and how to plan the rest. */
function CutShort({ s, narrowAt }: { s: PlanSchedule; narrowAt: string | null }) {
  return (
    <p className="note cluster">
      <Badge tone="warn">{t('views.timeline.cutShort', { shown: s.tasks.length, total: s.total ?? s.tasks.length })}</Badge>
      <span>
        {narrowAt
          ? tr('views.timeline.narrowIn', { max: MAX_PLAN_ISSUES, t0: (c: ReactNode) => <Link to={narrowAt}>{c}</Link> })
          : t('views.timeline.narrow', { max: MAX_PLAN_ISSUES })}
      </span>
    </p>
  );
}

export interface PlanTimelineProps {
  scope: PlanScope;
  /** What the chart is called: the plan's name. */
  title: string;
  /** A baseline to compare with, drawn as a ghost beneath each bar; null for none. */
  baseline: string | null;
  baselineName?: string | null;
  /** False while what the plan is read with (its baseline) isn't known yet. */
  enabled?: boolean;
  /** A what-if's plan: each task it moves is dashed where it would go. */
  whatIf?: Schedule | null;
  /** What's said when the plan holds nothing. */
  empty?: ReactNode;
  /** Where to narrow the search when the plan was cut short (the issues page, with its query); null where the page holds the query itself. */
  narrowAt?: string | null;
  /** What a page puts between the plan's facts and its chart, once the plan is read (the plan page's what-if). */
  children?: (s: PlanSchedule) => ReactNode;
}

/** The read-only timeline of a scope: its facts, the Gantt, and what a4a assumed to draw it. */
export function PlanTimeline({ scope, title, baseline, baselineName = null, enabled = true, whatIf = null, empty, narrowAt = null, children }: PlanTimelineProps) {
  const schedule = usePlanSchedule(scope, baseline, enabled);
  const s = schedule.data;
  const cal = useMemo(() => workCalendar(s ? unionCalendar(s) : undefined), [s]);
  const rows = useMemo(() => (s ? ganttRows(s, cal, whatIf) : []), [s, cal, whatIf]);
  const scrollKey = 'savedSearch' in scope ? `s:${scope.savedSearch}` : `q:${scope.project ?? ''}:${scope.query}`;
  return (
    <>
      {schedule.isLoading || !enabled ? <Loading what="loadingLine.plan" /> : null}
      {schedule.error ? <ErrorNote error={schedule.error} /> : null}
      {s ? (
        s.tasks.length === 0 ? (
          (empty ?? (
            <section className="card">
              <h2>{t('plan.timeline.nothingToPlanYet')}</h2>
              <p className="note">{t('views.timeline.findsNothing')}</p>
            </section>
          ))
        ) : (
          <>
            <Facts s={s} cal={cal} />
            {s.truncated ? <CutShort s={s} narrowAt={narrowAt} /> : null}
            {children?.(s)}
            <Gantt title={title} rows={rows} start={s.start} finish={s.finish} today={s.today} cal={cal} baselineName={baselineName} whatIf={Boolean(whatIf)} scrollKey={scrollKey} />
            <Warnings warnings={s.warnings} />
          </>
        )
      ) : null}
    </>
  );
}

/** The timeline among a search's views (D72): its scope, compared with the baseline its settings name. */
export default function TimelineView({ scope, query, savedSearch, settings }: ViewProps) {
  const title = savedSearch?.name ?? (query.trim() || t('views.timeline.everything'));
  return (
    <div className="stack">
      <PlanTimeline scope={scope} title={title} baseline={settings.timeline?.baseline ?? null} />
    </div>
  );
}
