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
import { badRequest, conflict, forbidden, notFound, saidProblems } from '../lib/errors';
import { newId } from '../lib/ids';
import { todayISO } from '../lib/dates';
import { prepareQuery } from '../search/service';
import { canReadProject, projectAccess, requireProject } from './access';
import type { SchemaSnapshot } from './schema-cache';
import { userRefDto } from './values';

type Row = typeof dashboards.$inferSelect;

async function dto(ctx: Ctx, s: SchemaSnapshot, r: Row, seen: Seen | null = null): Promise<Dashboard> {
  const owner = s.users.get(r.ownerId);
  const mine = r.ownerId === ctx.actor.user.id;
  const all = r.widgets as Widget[];
  const widgets: Widget[] = [];
  if (seen && !(mine || isAdmin(ctx))) {
    for (const w of all) if (await widgetVisible(w, seen)) widgets.push(w);
  } else widgets.push(...all);
  return {
    id: r.id,
    name: r.name,
    shared: r.shared,
    owner: owner ? userRefDto(owner) : null,
    mine,
    canEdit: (mine || isAdmin(ctx)) && ctx.actor.scopes.includes('write'),
    version: r.version,
    widgets,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** What the caller can see of what widgets name: projects by key, boards by id and name, sprints, queries. */
interface Seen {
  keys: Set<string>;
  boards: Map<string, boolean>;
  sprint(id: string): Promise<boolean>;
  query(text: string): Promise<boolean>;
  savedSearch(id: string): Promise<boolean>;
}

async function seenBy(ctx: Ctx): Promise<Seen> {
  const view = await projectAccess(ctx);
  const s = await ctx.app.schema.get();
  const keys = new Set<string>();
  for (const p of s.projects.values()) if (view.canRead(p.id)) keys.add(p.key.toUpperCase());
  // A board is seen when any of its projects is, as on the board itself; by id and by name.
  const seenBoards = new Map<string, boolean>();
  for (const b of await ctx.db.select({ id: boards.id, name: boards.name, projectIds: boards.projectIds }).from(boards)) {
    const visible = b.projectIds.some((id) => view.canRead(id));
    seenBoards.set(b.id, visible);
    seenBoards.set(b.name.toLowerCase(), (seenBoards.get(b.name.toLowerCase()) ?? false) || visible);
  }
  // A query makes sense to the viewer when it names nothing they can't see: the saved searches' rule.
  const queries = new Map<string, Promise<boolean>>();
  const query = (text: string) => {
    if (!text.trim()) return Promise.resolve(true);
    if (!queries.has(text)) queries.set(text, prepareQuery(ctx, text).then((p) => !p.compiled.problems.length));
    return queries.get(text)!;
  };
  return {
    keys,
    boards: seenBoards,
    sprint: async (id) => {
      const [sp] = await ctx.db.select({ boardId: sprints.boardId }).from(sprints).where(eq(sprints.id, id));
      return Boolean(sp && seenBoards.get(sp.boardId));
    },
    query,
    savedSearch: async (id) => {
      const [ss] = await ctx.db.select().from(savedSearches).where(eq(savedSearches.id, id));
      if (!ss || (ss.ownerId !== ctx.actor.user.id && !ss.shared)) return false;
      return ss.ownerId === ctx.actor.user.id || query(ss.query);
    },
  };
}

/**
 * Whether a widget names only what the viewer can see. A shared dashboard's widgets are worked out
 * as each viewer may see; one naming a project, board or sprint they can't see, or with a query
 * (its own or its saved search's) naming a project or value they can't see, is left out for them,
 * as a shared saved search is, so its words don't give that project away. A widget's title and a
 * note are their owner's words, and stay as written.
 */
async function widgetVisible(w: Widget, seen: Seen): Promise<boolean> {
  if (w.kind === 'note') return true;
  if (w.kind === 'search') return w.savedSearch ? seen.savedSearch(w.savedSearch) : seen.query(w.query ?? '');
  const p = w.params;
  if (p.report === 'burndown') {
    if (p.board) return Boolean(seen.boards.get(p.board) ?? seen.boards.get(p.board.toLowerCase()));
    return p.sprint ? seen.sprint(p.sprint) : true;
  }
  if (p.project && !seen.keys.has(p.project.toUpperCase())) return false;
  return seen.query(p.query ?? '');
}

export async function listDashboards(ctx: Ctx): Promise<Dashboard[]> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const rows = await ctx.db
    .select()
    .from(dashboards)
    .where(or(eq(dashboards.ownerId, ctx.actor.user.id), eq(dashboards.shared, true)))
    .orderBy(asc(dashboards.name));
  const seen = await seenBy(ctx);
  const out: Dashboard[] = [];
  for (const r of rows) out.push(await dto(ctx, s, r, seen));
  return out.sort((a, b) => Number(b.mine) - Number(a.mine));
}

async function load(ctx: Ctx, id: string): Promise<Row> {
  const [row] = await ctx.db.select().from(dashboards).where(eq(dashboards.id, id));
  // Someone else's dashboard that isn't shared is theirs alone, admins included: it looks like a missing one.
  if (!row || (row.ownerId !== ctx.actor.user.id && !row.shared)) throw notFound('Dashboard', 'GET /dashboards lists yours and the shared ones.').said('dashboards.notFoundListThem');
  return row;
}

export async function getDashboard(ctx: Ctx, id: string): Promise<Dashboard> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  return dto(ctx, s, await load(ctx, id), await seenBy(ctx));
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
    if (readable.some(Boolean)) {
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
  if (input.length > MAX_WIDGETS) throw badRequest(`A dashboard holds ${MAX_WIDGETS} widgets at most`).said('dashboards.tooManyWidgets', { MAX_WIDGETS });
  const widgets = input.map((w) => WidgetSchema.parse(w));
  const ids = new Set<string>();
  let seen: Seen | undefined;
  for (const w of widgets) {
    if (ids.has(w.id)) throw badRequest(`Two widgets have the id "${w.id}"`, 'Give each widget an id of its own.').said('dashboards.duplicateWidgetId', { id: w.id });
    ids.add(w.id);
    const where = w.title ? `"${w.title}"` : `widget ${w.id}`;
    const checkQuery = async (query: string | undefined) => {
      if (!query?.trim()) return;
      const prepared = await prepareQuery(ctx, query);
      if (prepared.compiled.problems.length) {
        throw badRequest(`The query of ${where} has problems: ${prepared.compiled.problems.map((p) => p.message).join('; ')}`, 'Fix the query, or try it on the Issues page first.', {
          problems: prepared.compiled.problems,
        }).said('dashboards.queryHasProblems', { titled: w.title ? 'yes' : 'no', title: w.title ?? '', wid: w.id, problems: saidProblems(prepared.compiled.problems) });
      }
    };
    if (w.kind === 'report') {
      const p = w.params;
      if (p.report === 'burndown') {
        if (!p.board && !p.sprint) throw badRequest(`${where} needs a board (for its current sprint) or a sprint`).said('dashboards.needsBoardOrSprint', { titled: w.title ? 'yes' : 'no', title: w.title ?? '', wid: w.id });
        seen ??= await seenBy(ctx);
        if (p.board) {
          if (!(seen.boards.get(p.board) ?? seen.boards.get(p.board.toLowerCase()))) throw notFound(`Board ${p.board}`, 'GET /boards lists the boards you can see.').said('dashboards.boardNotFound', { board: p.board });
        } else if (p.sprint && !(await seen.sprint(p.sprint))) throw notFound(`Sprint ${p.sprint}`).said('notFound.sprint', { id: p.sprint });
      } else {
        if (p.project) await requireProject(ctx, p.project, 'read');
        await checkQuery(p.query);
      }
    } else if (w.kind === 'search') {
      if (!w.savedSearch && !w.query?.trim()) throw badRequest(`${where} needs a saved search or a query`).said('dashboards.needsSearch', { titled: w.title ? 'yes' : 'no', title: w.title ?? '', wid: w.id });
      if (w.savedSearch) {
        // One you can't list (someone else's, or naming what you can't see) is as one that doesn't exist.
        seen ??= await seenBy(ctx);
        if (!(await seen.savedSearch(w.savedSearch))) throw notFound(`Saved search ${w.savedSearch}`, 'Use one of yours, or a shared one: GET /saved-searches lists them.').said('dashboards.savedSearchNotFound', { savedSearch: w.savedSearch });
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
  if (current.ownerId !== ctx.actor.user.id && !isAdmin(ctx)) throw forbidden('Only its owner can change a dashboard', 'Make a copy of it to change it: create a dashboard with its widgets.').said('dashboards.onlyOwnerChanges');
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
    if (!now) throw notFound('Dashboard').said('notFound.dashboardUnnamed');
    throw conflict(`"${current.name}" was changed by someone else (version ${now.version}, you sent ${input.expectedVersion})`, 'Reload it and make your change again.', {
      currentVersion: now.version,
    }).said('dashboards.changedBySomeoneElse', { name: current.name, version: now.version, expectedVersion: String(input.expectedVersion) });
  }
  return dto(ctx, s, row);
}

export async function deleteDashboard(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'write');
  const current = await load(ctx, id);
  if (current.ownerId !== ctx.actor.user.id && !isAdmin(ctx)) throw forbidden('Only its owner can delete a dashboard').said('dashboards.onlyOwnerDeletes');
  await ctx.db.delete(dashboards).where(eq(dashboards.id, id));
}
