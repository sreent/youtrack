import type { TrackerEvent } from '@a4a/shared';
import { and, asc, desc, eq, gt, gte, inArray, ne, type SQL } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import { activities, boardMoves, boards } from '../db/schema';
import { toEventDto } from '../events/activity';
import { translatorFor } from '../i18n';
import { parseDateExpression } from '../lib/dates';
import { badRequest } from '../lib/errors';
import { startOfDay, todayIn } from '../reports/tz';
import { eventFor, eventsFieldsSql, eventsVisibleSql, projectAccess, seenIssueIds, type AccessView } from './access';
import { undoStandings } from './agents';
import { resolveIssue } from './issues';
import { projectByKey, type SchemaSnapshot } from './schema-cache';
import { zoneOf } from './time-zones';

/**
 * An issue's history, leaving out links to issues the caller can't see; an agent's change says whether
 * it can be undone. Its card's moves on boards are a line for each run of them (D65), not every move.
 */
export async function issueActivity(ctx: Ctx, issueId: string, limit = 200): Promise<TrackerEvent[]> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const issue = await resolveIssue(ctx, issueId);
  const view = await projectAccess(ctx);
  const seen = eventsVisibleSql(view, s);
  const rows = await ctx.db
    .select()
    .from(activities)
    .where(and(eq(activities.issueId, issue.id), ne(activities.type, 'board.issue_ranked'), seen, eventsFieldsSql(view, s)))
    .orderBy(asc(activities.id))
    .limit(limit);
  // A change to a private field kept from them isn't there (D50).
  const events = rows.map((r) => eventFor(view, s, toEventDto(s, r))).filter((e): e is TrackerEvent => e !== null);
  // A change an agent made on its own says whether a person can still undo it (D34).
  const standings = await undoStandings(ctx, s, events);
  const said = events.map((e) => (standings.has(e.id) ? { ...e, undo: standings.get(e.id) } : e));
  const moves = await movesInHistory(ctx, view, s, issue.id, limit);
  return [...said, ...moves].sort((a, b) => a.id - b.id).slice(0, limit);
}

type KeptNote = { key: string; values?: Record<string, string | number> };

/**
 * A card's moves, a line for each run (D65): each as the run's last `board.issue_ranked`, with how many
 * moves it holds and its place as a kept note. It names the anchor and the board only to a reader who
 * sees them now, and says less to anyone else ("changed its place", "on a board"); the event's own
 * board goes with it.
 */
async function movesInHistory(ctx: Ctx, view: AccessView, s: SchemaSnapshot, issueId: string, limit: number): Promise<TrackerEvent[]> {
  const lines = await ctx.db.select().from(boardMoves).where(eq(boardMoves.issueId, issueId)).orderBy(asc(boardMoves.lastEventId)).limit(limit);
  if (!lines.length) return [];
  const rows = await ctx.db.select().from(activities).where(inArray(activities.id, lines.map((l) => l.lastEventId)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const anchors = await seenIssueIds(ctx, lines.flatMap((l) => (l.anchorId ? [l.anchorId] : [])));
  const boardIds = [...new Set(lines.flatMap((l) => (l.boardId ? [l.boardId] : [])))];
  const boardRows = boardIds.length ? await ctx.db.select({ id: boards.id, projectIds: boards.projectIds }).from(boards).where(inArray(boards.id, boardIds)) : [];
  const seenBoards = new Set(boardRows.filter((b) => b.projectIds.some((id) => view.canRead(id))).map((b) => b.id));
  const english = translatorFor('en');
  return lines.flatMap((l) => {
    const row = byId.get(l.lastEventId);
    const event = row ? eventFor(view, s, toEventDto(s, row)) : null;
    if (!event) return [];
    const sees = { anchor: l.anchorId !== null && anchors.has(l.anchorId), board: l.boardId !== null && seenBoards.has(l.boardId) };
    const kept = l.said as KeptNote;
    const values = { ...kept.values, ...(sees.anchor || l.side === 'top' ? {} : { side: 'moved', anchor: '' }), ...(sees.board ? {} : { onBoard: 'no', board: '' }) };
    const said = { key: kept.key, values };
    const { boardId, board, ...data } = event.data as Record<string, unknown>;
    return [
      {
        ...event,
        data: { ...data, ...(sees.board ? { boardId, board } : {}), moves: l.moves, firstAt: l.firstAt.toISOString(), said, note: sees.anchor && sees.board ? l.note : english.t(said.key, values) },
      },
    ];
  });
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
  const fieldsSeen = eventsFieldsSql(view, s);
  if (fieldsSeen) conds.push(fieldsSeen);
  if (opts.after !== undefined) conds.push(gt(activities.id, opts.after));
  if (opts.since) {
    // "-7d" or a date: from its start where the asker is (D31).
    const zone = zoneOf(ctx);
    const range = parseDateExpression(opts.since, todayIn(zone));
    const ts = range?.from ? new Date(startOfDay(range.from, zone)) : new Date(opts.since);
    if (Number.isNaN(ts.getTime())) throw badRequest(`Invalid "since": ${opts.since}`, 'Use a date, a timestamp, or e.g. -7d').said('activity.badSince', { since: opts.since });
    conds.push(gte(activities.createdAt, ts));
  }
  if (opts.project) {
    const p = projectByKey(s, opts.project);
    // A project the caller can't see is unknown, in the same words as one that doesn't exist.
    if (!p || !view.canRead(p.id)) throw badRequest(`Unknown project ${opts.project}`).said('activity.unknownProject', { project: opts.project });
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
  const out = rows.map((r) => eventFor(view, s, toEventDto(s, r))).filter((e): e is TrackerEvent => e !== null);
  return opts.order === 'asc' && opts.after === undefined ? out.reverse() : out;
}

