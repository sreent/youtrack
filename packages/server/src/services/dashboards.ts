/**
 * Dashboards: a person's page of widgets, each a report with its parameters, a saved search's count
 * or list, or a note. A dashboard is its owner's; shared, everyone can see it, and only its owner
 * (or an admin) changes it. A widget's figures are worked out for whoever looks, under their own
 * access, so sharing a dashboard never shares what someone else may not see.
 */
import { MAX_WIDGETS, type Dashboard, type Widget, type WidgetInput } from '@a4a/shared';
import { WidgetSchema } from '@a4a/shared';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import { isAdmin, requireScope, type Ctx } from '../context';
import { boards, dashboards, savedSearches, sprints } from '../db/schema';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { todayISO } from '../lib/dates';
import { prepareQuery } from '../search/service';
import { canReadProject } from './access';
import { projectByKey } from './schema-cache';
import { userRefDto } from './values';

type Row = typeof dashboards.$inferSelect;

function dto(ctx: Ctx, s: Awaited<ReturnType<Ctx['app']['schema']['get']>>, r: Row): Dashboard {
  const owner = s.users.get(r.ownerId);
  const mine = r.ownerId === ctx.actor.user.id;
  return {
    id: r.id,
    name: r.name,
    shared: r.shared,
    owner: owner ? userRefDto(owner) : null,
    mine,
    canEdit: (mine || isAdmin(ctx)) && ctx.actor.scopes.includes('write'),
    version: r.version,
    widgets: r.widgets as Widget[],
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listDashboards(ctx: Ctx): Promise<Dashboard[]> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const rows = await ctx.db
    .select()
    .from(dashboards)
    .where(or(eq(dashboards.ownerId, ctx.actor.user.id), eq(dashboards.shared, true)))
    .orderBy(asc(dashboards.name));
  return rows.map((r) => dto(ctx, s, r)).sort((a, b) => Number(b.mine) - Number(a.mine));
}

async function load(ctx: Ctx, id: string): Promise<Row> {
  const [row] = await ctx.db.select().from(dashboards).where(eq(dashboards.id, id));
  // Someone else's dashboard that isn't shared is theirs alone, admins included: it looks like a missing one.
  if (!row || (row.ownerId !== ctx.actor.user.id && !row.shared)) throw notFound('Dashboard', 'GET /dashboards lists yours and the shared ones.');
  return row;
}

export async function getDashboard(ctx: Ctx, id: string): Promise<Dashboard> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  return dto(ctx, s, await load(ctx, id));
}

/**
 * What a4a shows someone with no dashboard of their own: their open issues, the current sprint of
 * a board they can see, what came in against what got done this month, and how long work takes.
 * Worked out, not saved, until they make it theirs.
 */
export async function defaultDashboard(ctx: Ctx): Promise<Dashboard> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const widgets: Widget[] = [
    { id: 'mine', kind: 'search', title: 'Assigned to you', query: 'for: me #Unresolved sort by: updated desc', show: 'list', limit: 8, width: 'half' },
  ];
  const today = todayISO();
  const sprintBoards = await ctx.db
    .select({ id: boards.id, name: boards.name, projectIds: boards.projectIds })
    .from(boards)
    .innerJoin(sprints, eq(sprints.boardId, boards.id))
    .where(and(eq(boards.sprintsEnabled, true), eq(sprints.archived, false), sql`${sprints.startDate} <= ${today}`, sql`${sprints.endDate} >= ${today}`))
    .orderBy(asc(boards.name));
  for (const b of sprintBoards) {
    const readable = await Promise.all(b.projectIds.map((p) => canReadProject(ctx, p)));
    if (readable.every(Boolean)) {
      widgets.push({ id: 'sprint', kind: 'report', title: `${b.name}: the current sprint`, params: { report: 'burndown', board: b.id, by: 'estimate' }, width: 'half' });
      break;
    }
  }
  widgets.push({ id: 'flow', kind: 'report', title: 'Created and resolved, the last 30 days', params: { report: 'created-resolved', days: 30 }, width: 'half' });
  widgets.push({ id: 'cycle', kind: 'report', title: 'How long work takes, the last 90 days', params: { report: 'cycle-time', days: 90 }, width: 'half' });
  const me = s.users.get(ctx.actor.user.id);
  return {
    id: null,
    name: 'Your dashboard',
    shared: false,
    owner: me ? userRefDto(me) : null,
    mine: true,
    canEdit: false,
    version: 0,
    widgets,
    createdAt: null,
    updatedAt: null,
  };
}

/** Widgets as given, checked: one id each, and every project, query, saved search and board they name exists. */
async function checkWidgets(ctx: Ctx, input: WidgetInput[]): Promise<Widget[]> {
  if (input.length > MAX_WIDGETS) throw badRequest(`A dashboard holds ${MAX_WIDGETS} widgets at most`);
  const widgets = input.map((w) => WidgetSchema.parse(w));
  const ids = new Set<string>();
  const s = await ctx.app.schema.get();
  for (const w of widgets) {
    if (ids.has(w.id)) throw badRequest(`Two widgets have the id "${w.id}"`, 'Give each widget an id of its own.');
    ids.add(w.id);
    const where = w.title ? `"${w.title}"` : `widget ${w.id}`;
    const checkQuery = async (query: string | undefined) => {
      if (!query?.trim()) return;
      const prepared = await prepareQuery(ctx, query);
      if (prepared.compiled.problems.length) {
        throw badRequest(`The query of ${where} has problems: ${prepared.compiled.problems.map((p) => p.message).join('; ')}`, 'Fix the query, or try it on the Issues page first.', {
          problems: prepared.compiled.problems,
        });
      }
    };
    if (w.kind === 'report') {
      const p = w.params;
      if (p.report === 'burndown') {
        if (!p.board && !p.sprint) throw badRequest(`${where} needs a board (for its current sprint) or a sprint`);
        if (p.board) {
          const all = await ctx.db.select({ id: boards.id, name: boards.name }).from(boards);
          if (!all.some((b) => b.id === p.board || b.name.toLowerCase() === p.board!.toLowerCase())) throw notFound(`Board ${p.board}`, `Boards: ${all.map((b) => b.name).join(', ')}`);
        } else if (p.sprint) {
          const [sp] = await ctx.db.select({ id: sprints.id }).from(sprints).where(eq(sprints.id, p.sprint));
          if (!sp) throw notFound(`Sprint ${p.sprint}`);
        }
      } else {
        if (p.project) {
          const project = projectByKey(s, p.project);
          if (!project || !(await canReadProject(ctx, project.id))) throw notFound(`Project ${p.project}`);
        }
        await checkQuery(p.query);
      }
    } else if (w.kind === 'search') {
      if (!w.savedSearch && !w.query?.trim()) throw badRequest(`${where} needs a saved search or a query`);
      if (w.savedSearch) {
        const [ss] = await ctx.db.select().from(savedSearches).where(eq(savedSearches.id, w.savedSearch));
        if (!ss || (ss.ownerId !== ctx.actor.user.id && !ss.shared)) throw notFound(`Saved search ${w.savedSearch}`, 'Use one of yours, or a shared one.');
      } else await checkQuery(w.query);
    }
  }
  return widgets;
}

export async function createDashboard(ctx: Ctx, input: { name: string; shared?: boolean; widgets?: WidgetInput[] }): Promise<Dashboard> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const widgets = await checkWidgets(ctx, input.widgets ?? []);
  const [row] = await ctx.db
    .insert(dashboards)
    .values({ id: newId(), ownerId: ctx.actor.user.id, name: input.name.trim(), shared: input.shared ?? false, widgets })
    .returning();
  return dto(ctx, s, row!);
}

export async function updateDashboard(
  ctx: Ctx,
  id: string,
  input: { name?: string; shared?: boolean; widgets?: WidgetInput[]; expectedVersion?: number },
): Promise<Dashboard> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const current = await load(ctx, id);
  if (current.ownerId !== ctx.actor.user.id && !isAdmin(ctx)) throw forbidden('Only its owner can change a dashboard', 'Make a copy of it to change it: create a dashboard with its widgets.');
  const widgets = input.widgets ? await checkWidgets(ctx, input.widgets) : undefined;
  const conds = [eq(dashboards.id, id)];
  if (input.expectedVersion !== undefined) conds.push(eq(dashboards.version, input.expectedVersion));
  const [row] = await ctx.db
    .update(dashboards)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.shared !== undefined ? { shared: input.shared } : {}),
      ...(widgets ? { widgets } : {}),
      version: sql`${dashboards.version} + 1`,
      updatedAt: new Date(),
    })
    .where(and(...conds))
    .returning();
  if (!row) {
    const [now] = await ctx.db.select({ version: dashboards.version }).from(dashboards).where(eq(dashboards.id, id));
    if (!now) throw notFound('Dashboard');
    throw conflict(`"${current.name}" was changed by someone else (version ${now.version}, you sent ${input.expectedVersion})`, 'Reload it and make your change again.', {
      currentVersion: now.version,
    });
  }
  return dto(ctx, s, row);
}

export async function deleteDashboard(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'write');
  const current = await load(ctx, id);
  if (current.ownerId !== ctx.actor.user.id && !isAdmin(ctx)) throw forbidden('Only its owner can delete a dashboard');
  await ctx.db.delete(dashboards).where(eq(dashboards.id, id));
}
