import { formatPeriod, parsePeriod, type WorkItem } from '@a4a/shared';
import { asc, eq } from 'drizzle-orm';
import { isAdmin, requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { issues, workItems } from '../db/schema';
import { publishActivities, recordActivity } from '../events/activity';
import { isISODate } from '../lib/dates';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { todayIn } from '../reports/tz';
import { assertCanProject, projectAccess } from './access';
import { issueRefsById, readableId } from './issue-refs';
import { findVisibleIssue, resolveIssue } from './issues';
import { projectSettings } from './projects';
import { findUser } from './schema-cache';
import { zoneOf } from './time-zones';
import { userRefDto } from './values';
import { resolveWorkType, workTypeNames } from './work-types';

type WorkItemRow = typeof workItems.$inferSelect;

async function dto(ctx: Ctx, row: WorkItemRow, issueReadable: string, typeName?: string): Promise<WorkItem> {
  const s = await ctx.app.schema.get();
  const author = row.authorId ? s.users.get(row.authorId) : undefined;
  if (row.workTypeId && typeName === undefined) typeName = (await workTypeNames(ctx.db, [row.workTypeId])).get(row.workTypeId);
  return {
    id: row.id,
    issueId: issueReadable,
    author: author ? userRefDto(author) : null,
    date: row.date,
    minutes: row.minutes,
    description: row.description,
    hourlyRate: row.hourlyRate,
    type: row.workTypeId && typeName ? { id: row.workTypeId, name: typeName } : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listWorkItems(ctx: Ctx, issueId: string): Promise<WorkItem[]> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const issue = await resolveIssue(ctx, issueId);
  // Time logged is for roles that see time and costs (D37).
  await assertCanProject(ctx, issue.projectId, 'costs');
  const rows = await ctx.db.select().from(workItems).where(eq(workItems.issueId, issue.id)).orderBy(asc(workItems.date));
  const rid = readableId(s, issue);
  const names = await workTypeNames(ctx.db, rows.map((r) => r.workTypeId));
  return Promise.all(rows.map((r) => dto(ctx, r, rid, r.workTypeId ? (names.get(r.workTypeId) ?? '') : undefined)));
}

/** Minutes from "1h 30m", "2d" or a number of minutes; refused when it isn't more than nothing. */
export function minutesOrRefuse(duration: string | number): number {
  const minutes = parsePeriod(duration);
  if (!minutes || minutes <= 0) throw badRequest(`Invalid duration "${duration}"`, 'Use "1h 30m", "2d" or minutes.').said('workItems.invalidDuration', { duration });
  return minutes;
}

export async function logWork(
  ctx: Ctx,
  issueId: string,
  input: { duration: string | number; date?: string; description?: string; author?: string; type?: string | null },
): Promise<WorkItem> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const issue = await resolveIssue(ctx, issueId);
  await assertCanProject(ctx, issue.projectId, 'time');
  const minutes = minutesOrRefuse(input.duration);
  // Work logged without a date is on the day it is where its person is (D31).
  const date = input.date ?? todayIn(zoneOf(ctx));
  if (!isISODate(date)) throw badRequest('date must be YYYY-MM-DD').said('workItems.dateFormat');
  let author = ctx.actor.user;
  if (input.author) {
    const u = findUser(s, input.author, ctx.actor.user.id);
    if (!u) throw notFound(`User ${input.author}`).said('notFound.user', { id: input.author });
    if (u.id !== ctx.actor.user.id && !isAdmin(ctx) && !(await projectAccess(ctx)).canManage(issue.projectId)) {
      throw forbidden('Only administrators and managers of the project can log work for other people').said('workItems.othersWork');
    }
    author = u;
  }
  const project = s.projects.get(issue.projectId)!;
  const type = await resolveWorkType(ctx.db, project, input.type, projectSettings(project).time.workTypeRequired);
  const ref = (await issueRefsById(ctx.db, s, [issue.id])).get(issue.id);
  const { row, activity } = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx
      .insert(workItems)
      .values({
        id: newId(),
        issueId: issue.id,
        authorId: author.id,
        date,
        minutes,
        description: input.description ?? '',
        hourlyRate: author.hourlyRate,
        workTypeId: type?.id ?? null,
      })
      .returning();
    await tx.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, issue.id));
    const activity = await recordActivity(tx, ctx, {
      type: 'work.logged',
      projectId: issue.projectId,
      issueId: issue.id,
      payload: {
        issue: ref,
        data: {
          workItemId: row!.id,
          minutes,
          duration: formatPeriod(minutes),
          date,
          author: author.login,
          description: input.description ?? '',
          ...(type ? { type: type.name } : {}),
        },
      },
    });
    return { row: row!, activity };
  });
  await publishActivities(ctx.app, [activity]);
  return dto(ctx, row, readableId(s, issue), type?.name);
}

/**
 * A work item the caller may change: their own, or anyone's in a project they manage. One on an
 * issue they can't see is not found, exactly as one that doesn't exist.
 */
async function loadOwnOrManaged(ctx: Ctx, id: string, verb: string) {
  const [row] = await ctx.db.select().from(workItems).where(eq(workItems.id, id));
  const issue = row ? await findVisibleIssue(ctx, row.issueId) : undefined;
  if (!row || !issue) throw notFound('Work item').said('workItems.notFound');
  // Logging and changing work takes the time permission (D37), as logging it does.
  await assertCanProject(ctx, issue.projectId, 'time');
  if (row.authorId !== ctx.actor.user.id && !isAdmin(ctx) && !(await projectAccess(ctx)).canManage(issue.projectId)) {
    throw forbidden(`You can only ${verb} your own work items`, `Managers of the project can ${verb} anyone’s.`).said('workItems.onlyOwn', { verb });
  }
  return { row, issue };
}

/** Corrects logged work (D43): its time, day, note or type. Recorded as work.updated. */
export async function updateWorkItem(
  ctx: Ctx,
  id: string,
  input: { duration?: string | number; date?: string; description?: string; type?: string | null },
): Promise<WorkItem> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const { row, issue } = await loadOwnOrManaged(ctx, id, 'change');
  const minutes = input.duration !== undefined ? minutesOrRefuse(input.duration) : row.minutes;
  const date = input.date ?? row.date;
  if (!isISODate(date)) throw badRequest('date must be YYYY-MM-DD').said('workItems.dateFormat');
  const project = s.projects.get(issue.projectId)!;
  const type =
    input.type !== undefined
      ? await resolveWorkType(ctx.db, project, input.type, projectSettings(project).time.workTypeRequired)
      : undefined;
  const ref = (await issueRefsById(ctx.db, s, [issue.id])).get(issue.id);
  const { updated, activity } = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [updated] = await tx
      .update(workItems)
      .set({
        minutes,
        date,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(type !== undefined ? { workTypeId: type?.id ?? null } : {}),
      })
      .where(eq(workItems.id, id))
      .returning();
    await tx.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, issue.id));
    const activity = await recordActivity(tx, ctx, {
      type: 'work.updated',
      projectId: issue.projectId,
      issueId: issue.id,
      payload: {
        issue: ref,
        data: { workItemId: id, minutes, duration: formatPeriod(minutes), date, was: { minutes: row.minutes, date: row.date } },
      },
    });
    return { updated: updated!, activity };
  });
  await publishActivities(ctx.app, [activity]);
  return dto(ctx, updated, readableId(s, issue));
}

export async function deleteWorkItem(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const { row, issue } = await loadOwnOrManaged(ctx, id, 'delete');
  const ref = (await issueRefsById(ctx.db, s, [issue.id])).get(issue.id);
  const activity = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.delete(workItems).where(eq(workItems.id, id));
    return recordActivity(tx, ctx, {
      type: 'work.deleted',
      projectId: issue.projectId,
      issueId: issue.id,
      payload: { issue: ref, data: { workItemId: id, minutes: row.minutes, date: row.date } },
    });
  });
  await publishActivities(ctx.app, [activity]);
}
