import type { TrackerEvent } from '@a4a/shared';
import { and, asc, desc, eq, gt, gte, inArray, type SQL } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import { activities } from '../db/schema';
import { toEventDto } from '../events/activity';
import { parseDateExpression } from '../lib/dates';
import { badRequest } from '../lib/errors';
import { startOfDay, todayIn } from '../reports/tz';
import { eventsVisibleSql, projectAccess } from './access';
import { undoStandings } from './agents';
import { resolveIssue } from './issues';
import { projectByKey } from './schema-cache';
import { zoneOf } from './time-zones';

/** An issue's history, leaving out links to issues the caller can't see; an agent's change says whether it can be undone. */
export async function issueActivity(ctx: Ctx, issueId: string, limit = 200): Promise<TrackerEvent[]> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const issue = await resolveIssue(ctx, issueId);
  const seen = eventsVisibleSql(await projectAccess(ctx), s);
  const rows = await ctx.db
    .select()
    .from(activities)
    .where(and(eq(activities.issueId, issue.id), seen))
    .orderBy(asc(activities.id))
    .limit(limit);
  const events = rows.map((r) => toEventDto(s, r));
  // A change an agent made on its own says whether a person can still undo it (D34).
  const standings = await undoStandings(ctx.db, s, events);
  return events.map((e) => (standings.has(e.id) ? { ...e, undo: standings.get(e.id) } : e));
}

export interface EventFeedOptions {
  after?: number;
  since?: string;
  project?: string;
  issue?: string;
  types?: string[];
  limit?: number;
  order?: 'asc' | 'desc';
}

/**
 * Durable change feed: poll with `after=<last id>`. It holds only what the caller may see (the
 * filter is SQL, so pages stay full and the cursor never stalls behind events they can't see).
 */
export async function eventFeed(ctx: Ctx, opts: EventFeedOptions): Promise<TrackerEvent[]> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const view = await projectAccess(ctx);
  const conds: SQL[] = [];
  const seen = eventsVisibleSql(view, s);
  if (seen) conds.push(seen);
  if (opts.after !== undefined) conds.push(gt(activities.id, opts.after));
  if (opts.since) {
    // "-7d" or a date: from its start where the asker is (D31).
    const zone = zoneOf(ctx);
    const range = parseDateExpression(opts.since, todayIn(zone));
    const ts = range?.from ? new Date(startOfDay(range.from, zone)) : new Date(opts.since);
    if (Number.isNaN(ts.getTime())) throw badRequest(`Invalid "since": ${opts.since}`, 'Use a date, a timestamp, or e.g. -7d');
    conds.push(gte(activities.createdAt, ts));
  }
  if (opts.project) {
    const p = projectByKey(s, opts.project);
    // A project the caller can't see is unknown, in the same words as one that doesn't exist.
    if (!p || !view.canRead(p.id)) throw badRequest(`Unknown project ${opts.project}`);
    conds.push(eq(activities.projectId, p.id));
  }
  if (opts.issue) {
    const issue = await resolveIssue(ctx, opts.issue);
    conds.push(eq(activities.issueId, issue.id));
  }
  if (opts.types?.length) conds.push(inArray(activities.type, opts.types));
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = await ctx.db
    .select()
    .from(activities)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(opts.order === 'desc' || opts.after === undefined ? desc(activities.id) : asc(activities.id))
    .limit(limit);
  const out = rows.map((r) => toEventDto(s, r));
  return opts.order === 'asc' && opts.after === undefined ? out.reverse() : out;
}

