/** People's load on a plan, and levelling it: proposed, then applied as one transaction (D10). */
import { WELL_KNOWN_FIELDS, type LevelingMode, type LevelingResult, type ResourceLoad } from '@a4a/shared';
import { eq, sql } from 'drizzle-orm';
import { requireScope, type Ctx } from '../../context';
import type { Db } from '../../db/client';
import { projects } from '../../db/schema';
import { publishActivities, type ActivityRow } from '../../events/activity';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { computeLoad, computeSchedule, levelResources, PLAN_CALENDAR_KEY } from '../../planning';
import { applyChanges, resolveFieldsInput } from '../issues';
import { fieldByName } from '../schema-cache';
import { userRefDto } from '../values';
import { loadProjectPlan, type Loaded } from './load';

export async function getResourceLoad(ctx: Ctx, key: string, opts: { from?: string; to?: string; query?: string } = {}): Promise<ResourceLoad> {
  const l = await loadProjectPlan(ctx, key, { query: opts.query });
  const schedule = computeSchedule(l.input);
  const load = computeLoad(l.input, schedule, opts.from, opts.to);
  return {
    from: load.from,
    to: load.to,
    unassignedHours: load.unassignedHours,
    resources: load.resources
      .map((r) => {
        const u = l.s.users.get(r.resourceId);
        if (!u) return null;
        return {
          user: userRefDto(u),
          capacityHoursPerDay: r.capacityHoursPerDay,
          totalHours: r.totalHours,
          overallocatedDays: r.overallocatedDays,
          peakLoadPct: r.peakLoadPct,
          days: r.days,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null),
  };
}

/** Propose (dryRun) or apply levelling of a project's plan. Applying writes each moved task's Start date, never its due date. */
export async function level(
  ctx: Ctx,
  key: string,
  opts: { query?: string; mode: LevelingMode; dryRun: boolean; expect?: Record<string, string> },
): Promise<LevelingResult> {
  if (!opts.dryRun) requireScope(ctx, 'write');
  // Applying writes Start dates, which is work on issues: members may, as for each issue by hand.
  const l = await loadProjectPlan(ctx, key, { query: opts.query, need: opts.dryRun ? 'read' : 'write' });
  return levelLoaded(ctx, l, opts);
}

/**
 * Propose or apply levelling of a loaded plan, of one project or several (D73). Each moved task's Start date
 * is written in its own project, through `applyChanges`; where writing them would move where a project begins,
 * that project keeps its start (`keepStarts`, by its calendar's key, which is its key).
 */
export async function levelLoaded(ctx: Ctx, l: Loaded, opts: { mode: LevelingMode; dryRun: boolean; expect?: Record<string, string> }): Promise<LevelingResult> {
  if (!opts.dryRun) requireScope(ctx, 'write');
  const p = levelResources(l.input, opts.mode);
  const changes = p.changes.map((c) => ({
    issue: c.id,
    summary: c.summary,
    assignee: c.assigneeId ? (l.s.users.get(c.assigneeId)?.login ?? null) : null,
    fromStart: c.fromStart,
    fromFinish: c.fromFinish,
    toStart: c.toStart,
    toFinish: c.toFinish,
    delayDays: c.delayDays,
    movedBy: c.movedBy,
  }));
  // Applying writes the starts of the tasks levelling moved, and only those: a task that
  // moved because its predecessors did follows them by itself, and pinning its start
  // would turn a task with a due date and no estimate into a start-to-due window.
  const starts = p.levelledStarts;
  const writes = Object.entries(starts);
  const name = l.project?.key ?? '';
  if (!opts.dryRun && opts.expect && !sameStarts(opts.expect, starts)) {
    throw conflict(`The plan of ${name} changed since this levelling was proposed`, 'Review the new proposal, then level again.', { starts }).said('planning.planChanged', { project: name });
  }
  // Where each project begins, kept where the written starts would move it: by its calendar's key (D73).
  const byKey = new Map([...l.projects.values()].map((pp) => [pp.calendarId, pp.row]));
  const keep = Object.entries(p.keepStarts ?? (p.keepStart ? { [PLAN_CALENDAR_KEY]: p.keepStart } : {}))
    .map(([k, start]) => ({ project: k === PLAN_CALENDAR_KEY ? l.project : byKey.get(k), start }))
    .filter((x): x is { project: NonNullable<typeof x.project>; start: string } => Boolean(x.project));
  if (!opts.dryRun && writes.length) {
    const startField = fieldByName(l.s, WELL_KNOWN_FIELDS.startDate);
    for (const [id] of writes) {
      const projectId = l.projectOf.get(id);
      const project = projectId ? l.s.projects.get(projectId) : undefined;
      if (project && (!startField || !(l.s.projectFields.get(project.id) ?? []).some((pf) => pf.fieldId === startField.id))) {
        throw badRequest(`${project.key} has no "${WELL_KNOWN_FIELDS.startDate}" field to record levelled starts`, 'Attach the field in the project settings.').said('planning.noStartDateField', { project: project.key, field: WELL_KNOWN_FIELDS.startDate });
      }
    }
    // One transaction: the person agreed to the whole proposal, so it lands whole or not at all.
    const activities = await ctx.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const out: ActivityRow[] = [];
      for (const k of keep) {
        // Part of what was proposed, not a change of settings: the project begins where it did.
        // Only plan.startDate, in SQL, so a settings change made meanwhile is kept.
        await tx
          .update(projects)
          .set({
            settings: sql`jsonb_set(coalesce(${projects.settings}, '{}'::jsonb), '{plan}', coalesce(${projects.settings}->'plan', '{}'::jsonb) || jsonb_build_object('startDate', ${k.start}::text))`,
            updatedAt: new Date(),
          })
          .where(eq(projects.id, k.project.id));
      }
      for (const [id, start] of writes) {
        const row = l.rowsById.get(id);
        const project = row ? l.s.projects.get(row.projectId) : undefined;
        if (!row || !project) throw notFound(`Issue ${id}`).said('notFound.issue', { id });
        const fields = resolveFieldsInput(l.s, project, { [WELL_KNOWN_FIELDS.startDate]: start }, ctx.actor.user.id);
        const res = await applyChanges(tx, ctx, row, { fields });
        out.push(...res.activities);
      }
      return out;
    });
    if (keep.length) ctx.app.schema.invalidate();
    await publishActivities(ctx.app, activities);
  }
  return {
    mode: p.mode,
    applied: !opts.dryRun && writes.length > 0,
    finishBefore: p.finishBefore,
    finishAfter: p.finishAfter,
    overallocatedDaysBefore: p.overallocatedDaysBefore,
    overallocatedDaysAfter: p.overallocatedDaysAfter,
    changes,
    starts,
    unresolved: p.unresolved,
    keepsStart: writes.length ? p.keepStart : null,
  };
}

function sameStarts(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => b[k] === a[k]);
}
