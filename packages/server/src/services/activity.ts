import type { TrackerEvent } from '@a4a/shared';
import { and, asc, desc, eq, gt, gte, inArray, type SQL } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import { activities } from '../db/schema';
import { toEventDto } from '../events/activity';
import { parseDateExpression } from '../lib/dates';
import { badRequest } from '../lib/errors';
import { resolveIssue } from './issues';
import { projectByKey } from './schema-cache';

export async function issueActivity(ctx: Ctx, issueId: string, limit = 200): Promise<TrackerEvent[]> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const issue = await resolveIssue(ctx, issueId);
  const rows = await ctx.db
    .select()
    .from(activities)
    .where(eq(activities.issueId, issue.id))
    .orderBy(asc(activities.id))
    .limit(limit);
  return rows.map((r) => toEventDto(s, r));
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

/** Durable change feed: poll with `after=<last id>`. */
export async function eventFeed(ctx: Ctx, opts: EventFeedOptions): Promise<TrackerEvent[]> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const conds: SQL[] = [];
  if (opts.after !== undefined) conds.push(gt(activities.id, opts.after));
  if (opts.since) {
    const range = parseDateExpression(opts.since);
    const ts = range?.from ? new Date(`${range.from}T00:00:00`) : new Date(opts.since);
    if (Number.isNaN(ts.getTime())) throw badRequest(`Invalid "since": ${opts.since}`, 'Use a date, a timestamp, or e.g. -7d');
    conds.push(gte(activities.createdAt, ts));
  }
  if (opts.project) {
    const p = projectByKey(s, opts.project);
    if (!p) throw badRequest(`Unknown project ${opts.project}`);
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

