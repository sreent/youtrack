/**
 * Planning sprints from a board (docs/architecture.md, D43): its backlog in rank order, ranking,
 * story points, velocity, and a sprint's load against what its people can work.
 */
import { WELL_KNOWN_FIELDS, type Backlog, type Issue, type RankInput, type SprintPlan, type Velocity } from '@a4a/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { boardRanks, issues, sprintIssues, sprints, users, workItems } from '../db/schema';
import { diffDays } from '../lib/dates';
import { badRequest } from '../lib/errors';
import { availabilities } from '../planning/availability';
import { listWorkingDays, normalizeCalendar } from '../planning/calendar';
import type { PlanResource } from '../planning/types';
import { todayIn } from '../reports/tz';
import { searchIssueRows } from '../search/service';
import { absencesForPlan } from './absences';
import { assertCanWriteProject, projectAccess } from './access';
import { MAX_BOARD_ISSUES, loadBoard, loadSprint, pointsOf, rankRows, sprintDtos, sumPoints, type BoardRow } from './boards';
import type { IssueRow } from './issue-refs';
import { issueDtos, resolveIssue } from './issues';
import { projectSettings } from './projects';
import { pointsMeasure, sprintBurn } from './reports';
import { fieldByName, type ProjectRow } from './schema-cache';
import { zoneOf } from './time-zones';
import { userRefDto } from './values';

/** What a backlog holds when its board doesn't say. */
export const DEFAULT_BACKLOG_QUERY = '#Unresolved';
/** Gaps between ranks: room for many moves before the board's ranks are renumbered. */
const RANK_STEP = 1024;
/** The sprints a velocity chart shows, at most: the latest. */
const VELOCITY_SPRINTS = 12;

/**
 * The backlog's issues: the board's backlog query in the projects the caller can read, without the
 * issues of its open sprints (not archived, and not over), in rank order.
 */
async function backlogRows(ctx: Ctx, board: BoardRow): Promise<{ rows: IssueRow[]; ranks: Map<string, number>; total: number; query: string }> {
  const view = await projectAccess(ctx);
  const readable = board.projectIds.filter((id) => view.canRead(id));
  const query = board.backlogQuery ?? DEFAULT_BACKLOG_QUERY;
  const today = todayIn(zoneOf(ctx));
  const extraWhere = sql`NOT EXISTS (SELECT 1 FROM sprint_issues si JOIN sprints sp ON sp.id = si.sprint_id WHERE si.issue_id = issues.id AND sp.board_id = ${board.id} AND NOT sp.archived AND (sp.end_date IS NULL OR sp.end_date >= ${today}))`;
  const found = await searchIssueRows(ctx, query, { projectIds: readable, extraWhere, limit: MAX_BOARD_ISSUES });
  const { rows, ranks } = await rankRows(ctx.db, board.id, found.rows);
  return { rows, ranks, total: found.total, query };
}

export async function getBacklog(ctx: Ctx, boardId: string): Promise<Backlog> {
  requireScope(ctx, 'read');
  const board = await loadBoard(ctx, boardId);
  const { rows, ranks, total, query } = await backlogRows(ctx, board);
  const items = await issueDtos(ctx, rows);
  const rankedIds = new Set(rows.filter((r) => ranks.has(r.id)).map((r) => r.id));
  return {
    query,
    issues: items,
    ranked: items.filter((i) => rankedIds.has(i.uid)).map((i) => i.id),
    count: total,
    points: sumPoints(items, board.pointsFieldId),
  };
}

/**
 * Puts an issue just after or just before another on the board, or at the top (D43). Ranks are
 * numbers with gaps: a move takes the middle of the gap, and when a gap runs out every rank on
 * the board is spaced out again. An issue placed next to one without a rank first gives that one,
 * and those without one shown above it, places after the ranked ones, in the order shown.
 */
export async function rankIssue(ctx: Ctx, boardId: string, input: RankInput): Promise<void> {
  requireScope(ctx, 'write');
  const board = await loadBoard(ctx, boardId);
  const onBoard = async (id: string) => {
    const row = await resolveIssue(ctx, id);
    if (!board.projectIds.includes(row.projectId)) throw badRequest(`${id.toUpperCase()} isn't on this board`, 'Only issues of the board’s projects have a place on it.').said('agile.notOnBoard', { id: id.toUpperCase() });
    return row;
  };
  if (input.after && input.before) throw badRequest('Say where with after or before, not both').said('agile.afterOrBefore');
  const issue = await onBoard(input.issue);
  await assertCanWriteProject(ctx, issue.projectId);
  const anchorInput = input.after ?? input.before ?? null;
  const anchor = anchorInput ? await onBoard(anchorInput) : null;
  if (anchor?.id === issue.id) throw badRequest('An issue can’t be placed next to itself').said('agile.nextToItself');
  const before = await ctx.db.select({ issueId: boardRanks.issueId }).from(boardRanks).where(and(eq(boardRanks.boardId, board.id), eq(boardRanks.issueId, anchor?.id ?? '')));
  // Read before the transaction: the search runs on its own connection (PGlite has one).
  const shown = anchor && !before.length ? (await backlogRows(ctx, board)).rows.map((r) => r.id) : null;
  await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const all = await tx.select().from(boardRanks).where(eq(boardRanks.boardId, board.id)).orderBy(asc(boardRanks.rank));
    const order = all.filter((r) => r.issueId !== issue.id).map((r) => ({ id: r.issueId, rank: r.rank }));
    const writes = new Map<string, number>();
    if (anchor && !order.some((o) => o.id === anchor.id)) {
      const ranked = new Set(order.map((o) => o.id));
      const list = (shown ?? []).filter((id) => id !== issue.id);
      const at = list.indexOf(anchor.id);
      const run = at >= 0 ? list.slice(0, at + 1).filter((id) => !ranked.has(id)) : [anchor.id];
      let last = order.at(-1)?.rank ?? 0;
      for (const id of run) {
        last += RANK_STEP;
        order.push({ id, rank: last });
        writes.set(id, last);
      }
    }
    const i = anchor ? order.findIndex((o) => o.id === anchor.id) : -1;
    const pos = !anchor ? 0 : input.after ? i + 1 : i;
    const prev = order[pos - 1]?.rank;
    const next = order[pos]?.rank;
    let rank = prev === undefined && next === undefined ? RANK_STEP : prev === undefined ? next! - RANK_STEP : next === undefined ? prev + RANK_STEP : (prev + next) / 2;
    if (prev !== undefined && next !== undefined && !(rank > prev && rank < next)) {
      // No room left between them: space the board's ranks out again.
      order.splice(pos, 0, { id: issue.id, rank: 0 });
      order.forEach((o, k) => writes.set(o.id, (k + 1) * RANK_STEP));
      rank = (pos + 1) * RANK_STEP;
    }
    writes.set(issue.id, rank);
    const values = [...writes].map(([issueId, r]) => ({ boardId: board.id, issueId, rank: r }));
    await tx
      .insert(boardRanks)
      .values(values)
      .onConflictDoUpdate({ target: [boardRanks.boardId, boardRanks.issueId], set: { rank: sql`excluded.rank` } });
  });
}

// ---------------------------------------------------------------------------
// Velocity
// ---------------------------------------------------------------------------

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Per sprint that has begun: what it held when it started, and what was resolved in it by its end,
 * in story points, estimated hours or issues; and the average done over the last three that are
 * over. Each sprint's figures come from history, as its burndown's do.
 */
export async function velocity(ctx: Ctx, boardId: string, by?: Velocity['by']): Promise<Velocity> {
  requireScope(ctx, 'read');
  const board = await loadBoard(ctx, boardId);
  if (!board.sprintsEnabled) throw badRequest('This board does not use sprints', 'Enable sprints on the board first.').said('agile.noSprints');
  const measureBy = by ?? (board.pointsFieldId ? 'points' : 'estimate');
  const s = await ctx.app.schema.get();
  const pointsName = board.pointsFieldId ? s.fields.get(board.pointsFieldId)?.name : undefined;
  if (measureBy === 'points' && !pointsName) {
    throw badRequest('This board has no story points field', 'Choose one in the board’s settings, or ask for velocity by estimate or count.').said('agile.noStoryPoints');
  }
  const view = await projectAccess(ctx);
  const projects = board.projectIds.filter((id) => view.canRead(id)).map((id) => s.projects.get(id)).filter((p): p is ProjectRow => Boolean(p));
  const tz = zoneOf(ctx);
  const now = Date.now();
  const today = todayIn(tz, now);
  const rows = await ctx.db.select().from(sprints).where(eq(sprints.boardId, board.id)).orderBy(asc(sprints.startDate), asc(sprints.createdAt));
  const begun = rows
    .filter((r): r is typeof r & { startDate: string; endDate: string } => Boolean(r.startDate && r.endDate))
    .filter((r) => r.startDate <= today && r.endDate >= r.startDate && diffDays(r.startDate, r.endDate) <= 366)
    .slice(-VELOCITY_SPRINTS);
  const measure = measureBy === 'points' ? pointsMeasure(pointsName!) : undefined;
  const scale = (n: number) => (measureBy === 'estimate' ? round1(n / 60) : round1(n));
  const out: Velocity['sprints'] = [];
  for (const r of begun) {
    const { res } = await sprintBurn(ctx, s, r, projects, measureBy === 'count' ? 'count' : 'estimate', tz, now, measure);
    const done = res.days.reduce((sum, d) => sum + d.completed - d.reopened, 0);
    out.push({ id: r.id, name: r.name, startDate: r.startDate, endDate: r.endDate, committed: scale(res.start), done: scale(Math.max(0, done)), finished: r.endDate < today });
  }
  const lastThree = out.filter((x) => x.finished).slice(-3);
  return {
    by: measureBy,
    unit: measureBy === 'points' ? 'points' : measureBy === 'estimate' ? 'hours' : 'issues',
    sprints: out,
    average: lastThree.length ? round1(lastThree.reduce((sum, x) => sum + x.done, 0) / lastThree.length) : null,
  };
}

// ---------------------------------------------------------------------------
// A sprint's load against its people's capacity
// ---------------------------------------------------------------------------

function userOf(issue: Issue, fieldId: string | undefined): { id: string } | null {
  if (!fieldId) return null;
  const v = issue.fields.find((f) => f.fieldId === fieldId)?.value;
  return v && typeof v === 'object' && !Array.isArray(v) && 'login' in v && 'id' in v ? (v as { id: string }) : null;
}

function minutesOfValue(issue: Issue, fieldId: string | undefined): number {
  if (!fieldId) return 0;
  const v = issue.fields.find((f) => f.fieldId === fieldId)?.value;
  return v && typeof v === 'object' && !Array.isArray(v) && 'minutes' in v ? Number((v as { minutes: number }).minutes) || 0 : 0;
}

/**
 * Who has what in a sprint (D43): per assignee, its issues, their points, the remaining estimate
 * of the unresolved ones (estimate less work logged), and the hours they can work from its start
 * (or today, once it has started) to its end, by their working week and days away.
 */
export async function sprintPlan(ctx: Ctx, sprintId: string): Promise<SprintPlan> {
  requireScope(ctx, 'read');
  const { sprint, board } = await loadSprint(ctx, sprintId, 'read');
  const view = await projectAccess(ctx);
  const s = await ctx.app.schema.get();
  const readable = board.projectIds.filter((id) => view.canRead(id));
  const rows = readable.length
    ? await ctx.db
        .select()
        .from(issues)
        .where(and(inArray(issues.projectId, readable), sql`EXISTS (SELECT 1 FROM ${sprintIssues} si WHERE si.issue_id = ${issues.id} AND si.sprint_id = ${sprint.id})`))
        .orderBy(asc(issues.number))
    : [];
  const { rows: ordered } = await rankRows(ctx.db, board.id, rows as IssueRow[]);
  const items = await issueDtos(ctx, ordered);
  const assignee = fieldByName(s, WELL_KNOWN_FIELDS.assignee)?.id;
  const estimate = fieldByName(s, WELL_KNOWN_FIELDS.estimation)?.id;
  const spentRows = rows.length
    ? await ctx.db
        .select({ issueId: workItems.issueId, minutes: sql<number>`sum(${workItems.minutes})::int` })
        .from(workItems)
        .where(inArray(workItems.issueId, rows.map((r) => r.id)))
        .groupBy(workItems.issueId)
    : [];
  const spent = new Map(spentRows.map((r) => [r.issueId, Number(r.minutes)]));

  type Row = { userId: string | null; issues: number; points: number; loadMinutes: number };
  const byUser = new Map<string, Row>();
  const keyOf = (id: string | null) => id ?? '';
  for (const issue of items) {
    const userId = userOf(issue, assignee)?.id ?? null;
    const row = byUser.get(keyOf(userId)) ?? { userId, issues: 0, points: 0, loadMinutes: 0 };
    byUser.set(keyOf(userId), row);
    row.issues += 1;
    row.points += board.pointsFieldId ? (pointsOf(issue, board.pointsFieldId) ?? 0) : 0;
    if (!issue.resolvedAt) row.loadMinutes += Math.max(0, minutesOfValue(issue, estimate) - (spent.get(issue.uid) ?? 0));
  }

  const today = todayIn(zoneOf(ctx));
  const from = sprint.startDate && sprint.endDate ? (sprint.startDate > today ? sprint.startDate : today) : null;
  const to = sprint.startDate && sprint.endDate ? sprint.endDate : null;
  const people = [...byUser.values()].map((r) => r.userId).filter((id): id is string => Boolean(id));
  const userRows = people.length ? await ctx.db.select().from(users).where(inArray(users.id, people)) : [];
  const first = readable.map((id) => s.projects.get(id)).find((p): p is ProjectRow => Boolean(p));
  const cal = normalizeCalendar(projectSettings(first ?? ({ settings: {} } as ProjectRow)).plan);
  const resources: PlanResource[] = userRows.map((u) => ({ id: u.id, login: u.login, name: u.name, capacityHoursPerDay: u.capacityHoursPerDay, hourlyRate: u.hourlyRate, week: u.workWeek }));
  const availabilityOf = availabilities(cal, await absencesForPlan(ctx.db, people, today), today, resources);
  const capacityOf = (userId: string): number | null => {
    if (!from || !to) return null;
    if (from > to) return 0;
    const u = userRows.find((x) => x.id === userId);
    if (!u) return 0;
    const a = availabilityOf(userId);
    return round1(listWorkingDays(a.cal, from, to).reduce((sum, d) => sum + Math.max(0, u.capacityHoursPerDay) * a.share(d), 0));
  };
  const hasPoints = Boolean(board.pointsFieldId);
  const out: SprintPlan['people'] = [...byUser.values()]
    .map((r) => {
      const u = r.userId ? s.users.get(r.userId) : undefined;
      return {
        user: u ? userRefDto(u) : null,
        issues: r.issues,
        points: hasPoints ? round1(r.points) : null,
        loadHours: round1(r.loadMinutes / 60),
        capacityHours: r.userId ? capacityOf(r.userId) : null,
      };
    })
    .sort((a, b) => (a.user === null ? 1 : b.user === null ? -1 : a.user.name.localeCompare(b.user.name)));
  const named = out.filter((p) => p.user);
  return {
    sprint: (await sprintDtos(ctx.db, view, [sprint], s))[0]!,
    from,
    to,
    people: out,
    totals: {
      issues: items.length,
      points: hasPoints ? round1(out.reduce((sum, p) => sum + (p.points ?? 0), 0)) : null,
      loadHours: round1(out.reduce((sum, p) => sum + p.loadHours, 0)),
      capacityHours: from && to ? round1(named.reduce((sum, p) => sum + (p.capacityHours ?? 0), 0)) : null,
    },
  };
}
