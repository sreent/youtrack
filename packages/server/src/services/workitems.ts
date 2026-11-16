import { formatPeriod, parsePeriod, type WorkItem } from '@a4a/shared';
import { asc, eq } from 'drizzle-orm';
import { isAdmin, requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { issues, workItems } from '../db/schema';
import { publishActivities, recordActivity } from '../events/activity';
import { isISODate, todayISO } from '../lib/dates';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { assertCanWriteProject, projectAccess } from './access';
import { issueRefsById, readableId } from './issue-refs';
import { findVisibleIssue, resolveIssue } from './issues';
import { findUser } from './schema-cache';
import { userRefDto } from './values';

type WorkItemRow = typeof workItems.$inferSelect;

async function dto(ctx: Ctx, row: WorkItemRow, issueReadable: string): Promise<WorkItem> {
  const s = await ctx.app.schema.get();
  const author = row.authorId ? s.users.get(row.authorId) : undefined;
  return {
    id: row.id,
    issueId: issueReadable,
    author: author ? userRefDto(author) : null,
    date: row.date,
    minutes: row.minutes,
    description: row.description,
    hourlyRate: row.hourlyRate,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listWorkItems(ctx: Ctx, issueId: string): Promise<WorkItem[]> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const issue = await resolveIssue(ctx, issueId);
  const rows = await ctx.db.select().from(workItems).where(eq(workItems.issueId, issue.id)).orderBy(asc(workItems.date));
  const rid = readableId(s, issue);
  return Promise.all(rows.map((r) => dto(ctx, r, rid)));
}

export async function logWork(
  ctx: Ctx,
  issueId: string,
  input: { duration: string | number; date?: string; description?: string; author?: string },
): Promise<WorkItem> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const issue = await resolveIssue(ctx, issueId);
  await assertCanWriteProject(ctx, issue.projectId);
  const minutes = parsePeriod(input.duration);
  if (!minutes || minutes <= 0) throw badRequest(`Invalid duration "${input.duration}"`, 'Use "1h 30m", "2d" or minutes.');
  const date = input.date ?? todayISO();
  if (!isISODate(date)) throw badRequest('date must be YYYY-MM-DD');
  let author = ctx.actor.user;
  if (input.author) {
    const u = findUser(s, input.author, ctx.actor.user.id);
    if (!u) throw notFound(`User ${input.author}`);
    if (u.id !== ctx.actor.user.id && !isAdmin(ctx) && !(await projectAccess(ctx)).canManage(issue.projectId)) {
      throw forbidden('Only administrators and managers of the project can log work for other people');
    }
    author = u;
  }
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
      })
      .returning();
    await tx.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, issue.id));
    const activity = await recordActivity(tx, ctx, {
      type: 'work.logged',
      projectId: issue.projectId,
      issueId: issue.id,
      payload: {
        issue: ref,
        data: { workItemId: row!.id, minutes, duration: formatPeriod(minutes), date, author: author.login, description: input.description ?? '' },
      },
    });
    return { row: row!, activity };
  });
  await publishActivities(ctx.app, [activity]);
  return dto(ctx, row, readableId(s, issue));
}

export async function deleteWorkItem(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const [row] = await ctx.db.select().from(workItems).where(eq(workItems.id, id));
  // Work on an issue the caller can't see is not found, exactly as work that doesn't exist.
  const issue = row ? await findVisibleIssue(ctx, row.issueId) : undefined;
  if (!row || !issue) throw notFound('Work item');
  await assertCanWriteProject(ctx, issue.projectId);
  if (row.authorId !== ctx.actor.user.id && !(await projectAccess(ctx)).canManage(issue.projectId)) {
    throw forbidden('You can only delete your own work items', 'Managers of the project can delete anyone’s.');
  }
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
