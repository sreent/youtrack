/**
 * The plan at a glance, and what a4a assumed to draw it: beside the Gantt on the plan page, a guest's plan and
 * the timeline of a search (D72).
 */
import type { Schedule } from '@a4a/shared';
import type { ReactNode } from 'react';
import { Badge } from '../../components/Badges';
import { t, tr } from '../../i18n';
import { dayMonth, type WorkCalendar } from './dates';

/** The plan at a glance: when it ends, against the baseline, its critical path, what's late. */
export function Facts({ s, cal }: { s: Schedule; cal: WorkCalendar }) {
  const leaves = s.tasks.filter((t) => !t.isSummary);
  const late = leaves.filter((t) => t.late);
  const b = s.baseline;
  // A due date with little room left is at risk, though not late yet.
  const tight = leaves
    .filter((t) => !t.late && !t.issue.resolved && t.deadline)
    .map((t) => ({ t, spare: cal.between(t.finish, t.deadline!) }))
    .filter((x) => x.spare <= 2)
    .sort((a, b2) => a.spare - b2.spare)[0];
  return (
    <ul className="plan-facts">
      <li>{tr('plan.timeline.ends', { dayMonth: dayMonth(s.finish), t0: (c: ReactNode) => <strong>{c}</strong>, v: b ? (
          <>
            {', '}
            {b.finishVarianceDays === 0
              ? t('plan.timeline.asPlanned', { name: b.name })
              : t(b.finishVarianceDays > 0 ? 'plan.timeline.daysLaterThan' : 'plan.timeline.daysEarlierThan', { n: Math.abs(b.finishVarianceDays), name: b.name, dayMonth: dayMonth(b.finish) })}
          </>
        ) : null })}</li>
      <li>{tr('plan.timeline.tasksOnTheCriticalPath', { n: s.criticalPath.length })}</li>
      <li>
        {late.length ? (
          <Badge tone="bad">{late.length === 1 ? t('plan.timeline.isLate', { id: late[0]!.issue.id }) : t('plan.timeline.tasksAreLate', { length: late.length })}</Badge>
        ) : (
          t('plan.timeline.nothingIsLate')
        )}
      </li>
      {tight ? (
        <li>
          <Badge tone="warn">{tr('plan.timeline.daysToSpare', { id: tight.t.issue.id, n: tight.spare, dayMonth: dayMonth(tight.t.deadline!) })}</Badge>
        </li>
      ) : null}
    </ul>
  );
}

/** What a4a assumed to draw the plan: estimates it didn't have, and the like. */
export function Warnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <details className="plan-notes">
      <summary>{tr('plan.timeline.thingsA4aAssumed', { n: warnings.length })}</summary>
      <ul>
        {warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </details>
  );
}
