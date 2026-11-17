/**
 * Time tracking (docs/architecture.md, D43): a timer on an issue that becomes a work item, and a
 * weekly timesheet where people enter and correct their time across issues.
 */
import type { StopTimerInput, Timer, Timesheet, TimesheetCellInput, WorkItem } from '@a4a/shared';
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import { isAdmin, requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { issues, timers, users, workItems, workTypes } from '../db/schema';
import { addDays, isISODate, startOfWeek, weekday } from '../lib/dates';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { todayIn } from '../reports/tz';
import { DEFAULT_PLAN } from './projects';
import { absencesForPlan } from './absences';
import { assertCanProject, projectAccess } from './access';
import { issueRefsById } from './issue-refs';
import { resolveIssue } from './issues';
import { findUser, type SchemaSnapshot, type UserRow } from './schema-cache';
import { zoneOf } from './time-zones';
import { userRefDto } from './values';
import { deleteWorkItem, logWork, updateWorkItem } from './workitems';
import { workTypeNames } from './work-types';

type TimerRow = typeof timers.$inferSelect;

/** Seconds a timer has counted by `now`. */
function elapsed(row: TimerRow, now: number): number {
  const running = row.runningSince ? Math.max(0, Math.floor((now - row.runningSince.getTime()) / 1000)) : 0;
  return row.elapsedSeconds + running;
}

async function timerDtos(ctx: Ctx, rows: TimerRow[]): Promise<Timer[]> {
  if (!rows.length) return [];
  const s = await ctx.app.schema.get();
  const view = await projectAccess(ctx);
  const issueRows = await ctx.db
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(inArray(issues.id, rows.map((r) => r.issueId)));
  const projectOf = new Map(issueRows.map((r) => [r.id, r.projectId]));
  // A timer on an issue they can no longer see stays theirs, but out of sight.
  const shown = rows.filter((r) => view.canRead(projectOf.get(r.issueId) ?? ''));
  const refs = await issueRefsById(ctx.db, s, shown.map((r) => r.issueId));
  const now = Date.now();
  return shown
    .filter((r) => refs.has(r.issueId))
    .map((r) => ({ issue: refs.get(r.issueId)!, running: r.runningSince !== null, runningSince: r.runningSince?.toISOString() ?? null, elapsedSeconds: elapsed(r, now) }));
}

/** Your timers: the one running, if any, first; then those paused, latest first. */
export async function listTimers(ctx: Ctx): Promise<Timer[]> {
  requireScope(ctx, 'read');
  const rows = await ctx.db.select().from(timers).where(eq(timers.userId, ctx.actor.user.id)).orderBy(asc(timers.createdAt));
  const dtos = await timerDtos(ctx, rows);
  return dtos.sort((a, b) => Number(b.running) - Number(a.running));
}

async function timerOn(ctx: Ctx, issueId: string): Promise<{ issue: { id: string; projectId: string }; row: TimerRow | undefined }> {
  const issue = await resolveIssue(ctx, issueId);
  const [row] = await ctx.db.select().from(timers).where(and(eq(timers.userId, ctx.actor.user.id), eq(timers.issueId, issue.id)));
  return { issue, row };
}

async function oneTimer(ctx: Ctx, issueId: string): Promise<Timer> {
  const { row } = await timerOn(ctx, issueId);
  if (!row) throw notFound('Timer').said('time.timerNotFound');
  return (await timerDtos(ctx, [row]))[0]!;
}

/** Starts (or resumes) your timer on an issue; one of yours running on another issue is paused. */
export async function startTimer(ctx: Ctx, issueId: string): Promise<Timer> {
  requireScope(ctx, 'write');
  const issue = await resolveIssue(ctx, issueId);
  await assertCanProject(ctx, issue.projectId, 'time');
  const me = ctx.actor.user.id;
  const now = new Date();
  await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const running = await tx.select().from(timers).where(and(eq(timers.userId, me), isNotNull(timers.runningSince)));
    for (const r of running) {
      if (r.issueId === issue.id) return;
      await tx
        .update(timers)
        .set({ runningSince: null, elapsedSeconds: elapsed(r, now.getTime()) })
        .where(and(eq(timers.userId, me), eq(timers.issueId, r.issueId)));
    }
    await tx
      .insert(timers)
      .values({ userId: me, issueId: issue.id, runningSince: now, elapsedSeconds: 0 })
      .onConflictDoUpdate({ target: [timers.userId, timers.issueId], set: { runningSince: now } });
  });
  return oneTimer(ctx, issueId);
}

export async function pauseTimer(ctx: Ctx, issueId: string): Promise<Timer> {
  requireScope(ctx, 'write');
  const { issue, row } = await timerOn(ctx, issueId);
  if (!row) throw notFound('Timer', 'Start one first: POST /issues/{id}/timer/start.').said('time.timerNotFoundStart');
  if (row.runningSince) {
    await ctx.db
      .update(timers)
      .set({ runningSince: null, elapsedSeconds: elapsed(row, Date.now()) })
      .where(and(eq(timers.userId, row.userId), eq(timers.issueId, issue.id), isNotNull(timers.runningSince)));
  }
  return oneTimer(ctx, issueId);
}

/**
 * Stops your timer on an issue and logs what it counted, in whole minutes, as a work item: or
 * `duration` instead, with a date, note and type. Under half a minute counted logs nothing. When
 * the work can't be logged (a type the project requires is missing), the timer is left as it was.
 */
export async function stopTimer(ctx: Ctx, issueId: string, input: StopTimerInput = {}): Promise<{ workItem: WorkItem | null }> {
  requireScope(ctx, 'write');
  const { issue, row } = await timerOn(ctx, issueId);
  if (!row) throw notFound('Timer', 'Start one first: POST /issues/{id}/timer/start.').said('time.timerNotFoundStart');
  await assertCanProject(ctx, issue.projectId, 'time');
  const minutes = Math.round(elapsed(row, Date.now()) / 60);
  const where = and(eq(timers.userId, row.userId), eq(timers.issueId, issue.id));
  // Taken first, so stopping twice at once logs the time once.
  const [taken] = await ctx.db.delete(timers).where(where).returning();
  if (!taken) throw notFound('Timer').said('time.timerNotFound');
  if (input.duration === undefined && minutes <= 0) return { workItem: null };
  try {
    const workItem = await logWork(ctx, issueId, { duration: input.duration ?? minutes, date: input.date, description: input.description ?? '', type: input.type });
    return { workItem };
  } catch (e) {
    await ctx.db.insert(timers).values(taken).onConflictDoNothing();
    throw e;
  }
}

/** Throws your timer on an issue away, logging nothing. */
export async function discardTimer(ctx: Ctx, issueId: string): Promise<void> {
  requireScope(ctx, 'write');
  const { issue } = await timerOn(ctx, issueId);
  const gone = await ctx.db
    .delete(timers)
    .where(and(eq(timers.userId, ctx.actor.user.id), eq(timers.issueId, issue.id)))
    .returning({ issueId: timers.issueId });
  if (!gone.length) throw notFound('Timer').said('time.timerNotFound');
}

// ---------------------------------------------------------------------------
// The weekly timesheet
// ---------------------------------------------------------------------------

/** Whose timesheet: yours, or, for an administrator, anyone's. */
function whose(ctx: Ctx, s: SchemaSnapshot, login: string | undefined): UserRow {
  if (!login) return ctx.actor.user;
  const u = findUser(s, login, ctx.actor.user.id);
  if (!u) throw notFound(`User ${login}`).said('notFound.user', { id: login });
  if (u.id !== ctx.actor.user.id && !isAdmin(ctx)) throw forbidden('Only administrators can see or change other people’s timesheets').said('time.othersTimesheets');
  return u;
}

/**
 * Hours someone works each day of a week: their working week (D43), or their capacity on the
 * default working days; none on a day away, half on a half day away (D36).
 */
async function workingHours(db: Db, u: UserRow, days: string[]): Promise<number[]> {
  const week = u.workWeek && u.workWeek.length === 7 ? u.workWeek : null;
  const base = days.map((d) => (week ? (week[weekday(d)] ?? 0) : DEFAULT_PLAN.workingDays.includes(weekday(d)) ? Math.max(0, u.capacityHoursPerDay) : 0));
  const away = await absencesForPlan(db, [u.id], days[0]!);
  return base.map((hours, i) => {
    const d = days[i]!;
    let share = 1;
    for (const a of away) {
      if (d < a.from || d > a.to) continue;
      share = a.half && share === 1 ? 0.5 : 0;
    }
    return Math.round(hours * share * 100) / 100;
  });
}

export async function getTimesheet(ctx: Ctx, q: { week?: string; user?: string } = {}): Promise<Timesheet> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const person = whose(ctx, s, q.user);
  if (q.week !== undefined && !isISODate(q.week)) throw badRequest('week must be a date (YYYY-MM-DD)').said('time.weekNotADate');
  const monday = startOfWeek(q.week ?? todayIn(zoneOf(ctx)));
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const view = await projectAccess(ctx);
  const rows = (
    await ctx.db
      .select({ item: workItems, projectId: issues.projectId })
      .from(workItems)
      .innerJoin(issues, eq(issues.id, workItems.issueId))
      .where(and(eq(workItems.authorId, person.id), gte(workItems.date, days[0]!), lte(workItems.date, days[6]!)))
      .orderBy(asc(workItems.createdAt))
  ).filter((r) => view.canRead(r.projectId));
  const refs = await issueRefsById(ctx.db, s, rows.map((r) => r.item.issueId));
  const names = await workTypeNames(ctx.db, rows.map((r) => r.item.workTypeId));
  const byRow = new Map<string, Timesheet['rows'][number]>();
  const totals = days.map(() => 0);
  for (const { item } of rows) {
    const issue = refs.get(item.issueId);
    if (!issue) continue;
    const key = `${item.issueId}|${item.workTypeId ?? ''}`;
    const row = byRow.get(key) ?? {
      issue,
      type: item.workTypeId ? { id: item.workTypeId, name: names.get(item.workTypeId) ?? '?' } : null,
      minutes: days.map(() => 0),
      entries: days.map(() => 0),
    };
    byRow.set(key, row);
    const i = days.indexOf(item.date);
    row.minutes[i]! += item.minutes;
    row.entries[i]! += 1;
    totals[i]! += item.minutes;
  }
  const ordered = [...byRow.values()].sort((a, b) => a.issue.id.localeCompare(b.issue.id, undefined, { numeric: true }) || (a.type?.name ?? '').localeCompare(b.type?.name ?? ''));
  const [fresh] = await ctx.db.select().from(users).where(eq(users.id, person.id));
  return { user: userRefDto(person), week: monday, days, hours: await workingHours(ctx.db, fresh ?? person, days), totals, rows: ordered };
}

/**
 * Sets the time in one cell of a timesheet: an issue, a work type (or none) and a day. With no
 * entry there it logs one; with one it corrects it, and 0 deletes it. A cell made of several
 * entries is refused: they are changed on the issue, one by one.
 */
export async function setTimesheetCell(ctx: Ctx, input: TimesheetCellInput): Promise<Timesheet> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const person = whose(ctx, s, input.user);
  if (!isISODate(input.date)) throw badRequest('date must be YYYY-MM-DD').said('time.dateFormat');
  const issue = await resolveIssue(ctx, input.issue);
  await assertCanProject(ctx, issue.projectId, 'time');
  const project = s.projects.get(issue.projectId)!;
  let typeId: string | null = null;
  if (input.type) {
    // The row's type, as it is: archived ones included, since the row is already there.
    const types = await ctx.db.select().from(workTypes).where(eq(workTypes.projectId, project.id));
    const named = input.type.trim().toLowerCase();
    const t = types.find((x) => x.id === input.type) ?? types.find((x) => x.name.toLowerCase() === named);
    if (!t) throw badRequest(`${project.key} has no work type "${input.type}"`).said('time.noWorkType', { project: project.key, type: input.type });
    typeId = t.id;
  }
  const existing = await ctx.db
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.authorId, person.id),
        eq(workItems.issueId, issue.id),
        eq(workItems.date, input.date),
        typeId ? eq(workItems.workTypeId, typeId) : isNull(workItems.workTypeId),
      ),
    );
  if (existing.length > 1) {
    throw conflict(`That day has ${existing.length} entries on ${project.key}-${issue.number}`, 'Change them on the issue, one by one.').said('time.severalEntries', { n: existing.length, project: project.key, number: issue.number });
  }
  const [one] = existing;
  if (one) {
    if (input.minutes === 0) await deleteWorkItem(ctx, one.id);
    else if (input.minutes !== one.minutes) await updateWorkItem(ctx, one.id, { duration: input.minutes });
  } else if (input.minutes > 0) {
    await logWork(ctx, input.issue, { duration: input.minutes, date: input.date, author: person.login, type: typeId });
  }
  return getTimesheet(ctx, { week: input.date, user: person.id === ctx.actor.user.id ? undefined : person.login });
}
