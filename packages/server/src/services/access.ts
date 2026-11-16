/**
 * Project-level access: who may see a project, and what they may do in it. Every read or write
 * of a project's things asks here, and nothing else decides it.
 *
 * - A project is open (everyone works in it) or members only (only its people and
 *   administrators see it at all).
 * - Roles in a project, least first: viewer (reads and comments), member (also changes issues),
 *   manager (also changes the project's settings, people, boards and baselines).
 * - Someone's role in a project: manager, if they're an administrator or its lead; otherwise the
 *   highest of the role the project gives them among its people and the roles it gives groups
 *   they're in (D27); otherwise member, if the project is open. So an open project can still keep
 *   someone to reading, by naming them (or a group of theirs) a viewer.
 * - Scopes cap it. Reading needs "read"; commenting, changing issues and managing need "write"
 *   (an administrator also manages with "admin"). So a read-only account or token never writes,
 *   whatever its role in a project. Commenting counts as writing.
 * - A token limited to projects reaches those projects only, as far as its person may.
 * - What someone may not read answers exactly as what doesn't exist (404), so nothing can be
 *   probed; what they may read but not change answers 403 and says why.
 *
 * Inside a transaction, pass it as `db`: on PGlite, a query outside the transaction would wait
 * for it. A request works out its access once and keeps it for two seconds at most, or until
 * something here changes on this instance (`accessChanged`).
 */
import { PROJECT_ROLES, type ProjectAccess, type ProjectRole, type Scope, type TrackerEvent } from '@a4a/shared';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { effectiveScopes, requireScope, type Actor, type AppServices, type Ctx } from '../context';
import type { Db } from '../db/client';
import { activities, groupMembers, groups, projectGroupRoles, projectMembers, projects, users } from '../db/schema';
import { forbidden, notFound } from '../lib/errors';
import { projectByKey, type ProjectRow, type SchemaSnapshot, type UserRow } from './schema-cache';

export type { ProjectRole };
export type ProjectNeed = 'read' | 'comment' | 'write' | 'manage';

const RANK: Record<ProjectRole, number> = { viewer: 1, member: 2, manager: 3 };

interface Grant {
  role: ProjectRole;
  via: ProjectAccess['via'];
  key: string;
  /** With `via: group`, the group's name. */
  group?: string;
}

export function isProjectRole(role: string | null | undefined): role is ProjectRole {
  return (PROJECT_ROLES as readonly string[]).includes(role ?? '');
}

/** What one actor may do in each project, worked out once. */
export class AccessView {
  constructor(
    /** An administrator (by role, or by an admin scope) is a manager of every project. */
    readonly admin: boolean,
    private readonly scopes: readonly Scope[],
    private readonly grants: ReadonlyMap<string, Grant>,
    /** True when every project is in reach: an administrator without a project limit. */
    private readonly everything: boolean,
  ) {}

  role(projectId: string): ProjectRole | null {
    return this.grants.get(projectId)?.role ?? null;
  }

  canRead(projectId: string): boolean {
    return this.grants.has(projectId) && this.scopes.includes('read');
  }

  canComment(projectId: string): boolean {
    return this.canRead(projectId) && this.scopes.includes('write');
  }

  canWrite(projectId: string): boolean {
    const g = this.grants.get(projectId);
    return Boolean(g) && RANK[g!.role] >= RANK.member && this.canComment(projectId);
  }

  canManage(projectId: string): boolean {
    const g = this.grants.get(projectId);
    if (!g || g.role !== 'manager' || !this.scopes.includes('read')) return false;
    return this.scopes.includes('write') || (this.admin && this.scopes.includes('admin'));
  }

  can(projectId: string, need: ProjectNeed): boolean {
    if (need === 'read') return this.canRead(projectId);
    if (need === 'comment') return this.canComment(projectId);
    if (need === 'write') return this.canWrite(projectId);
    return this.canManage(projectId);
  }

  /** Ids of the projects it may read, or null for every project there is. */
  visibleIds(): string[] | null {
    if (!this.scopes.includes('read')) return [];
    return this.everything ? null : [...this.grants.keys()];
  }

  /** What it may do in a project, for the API; null when it can't see it. */
  describe(projectId: string): ProjectAccess | null {
    const g = this.grants.get(projectId);
    if (!g || !this.canRead(projectId)) return null;
    return {
      role: g.role,
      via: g.via,
      group: g.group ?? null,
      read: true,
      comment: this.canComment(projectId),
      write: this.canWrite(projectId),
      manage: this.canManage(projectId),
    };
  }

  /** The key of a project it can see (for messages). */
  keyOf(projectId: string): string | undefined {
    return this.grants.get(projectId)?.key;
  }
}

// ---------------------------------------------------------------------------
// Working it out
// ---------------------------------------------------------------------------

interface ProjectAccessRow {
  id: string;
  key: string;
  visibility: string;
  leadId: string | null;
  /** The role the project gives the person among its people. */
  role: string | null;
  /** The highest role it gives a group they're in, and that group's name (the first by name, on a tie). */
  groupRole?: string | null;
  groupName?: string | null;
}

function grantFor(admin: boolean, userId: string, r: ProjectAccessRow): Grant | null {
  if (admin) return { role: 'manager', via: 'admin', key: r.key };
  if (r.leadId === userId) return { role: 'manager', via: 'lead', key: r.key };
  const own = isProjectRole(r.role) ? r.role : null;
  const viaGroup = isProjectRole(r.groupRole) ? r.groupRole : null;
  // The highest of their own and their groups'; their own, when they're the same.
  if (viaGroup && (!own || RANK[viaGroup] > RANK[own])) return { role: viaGroup, via: 'group', key: r.key, group: r.groupName ?? undefined };
  if (own) return { role: own, via: 'member', key: r.key };
  if (r.visibility !== 'members') return { role: 'member', via: 'open', key: r.key };
  return null;
}

/** Roles as numbers, in SQL, so the highest can be chosen there. */
const RANK_SQL = (role: SQL | string) => sql`CASE ${role} WHEN 'manager' THEN 3 WHEN 'member' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END`;

async function load(db: Db, actor: Pick<Actor, 'user' | 'scopes' | 'projectIds'>): Promise<AccessView> {
  const admin = actor.user.role === 'admin' || actor.scopes.includes('admin');
  const limit = actor.projectIds ? new Set(actor.projectIds) : null;
  // One query: each project, the person's own role in it, and the best role a group of theirs has there.
  const res = await db.execute(sql`
    SELECT p.id, p.key, p.visibility, p.lead_id AS "leadId", pm.role AS role, g.role AS "groupRole", g.name AS "groupName"
    FROM ${projects} p
    LEFT JOIN ${projectMembers} pm ON pm.project_id = p.id AND pm.user_id = ${actor.user.id}
    LEFT JOIN LATERAL (
      SELECT pgr.role, gr.name
      FROM ${projectGroupRoles} pgr
      JOIN ${groupMembers} gm ON gm.group_id = pgr.group_id AND gm.user_id = ${actor.user.id}
      JOIN ${groups} gr ON gr.id = pgr.group_id
      WHERE pgr.project_id = p.id
      ORDER BY ${RANK_SQL(sql`pgr.role`)} DESC, lower(gr.name)
      LIMIT 1
    ) g ON TRUE
  `);
  const rows = (res as unknown as { rows: ProjectAccessRow[] }).rows;
  const grants = new Map<string, Grant>();
  for (const r of rows) {
    if (limit && !limit.has(r.id)) continue;
    const g = actor.user.banned ? null : grantFor(admin, actor.user.id, r);
    if (g) grants.set(r.id, g);
  }
  return new AccessView(admin, actor.scopes, grants, admin && !limit && !actor.user.banned);
}

const MAX_AGE_MS = 2_000;
const memo = new WeakMap<Actor, { at: number; generation: number; view: Promise<AccessView> }>();
const generations = new WeakMap<AppServices, number>();

/**
 * Call after anything that changes who may see or do what: a project's people or visibility,
 * its lead, someone's role or ban, a token's projects. Other instances see it within two seconds,
 * when their requests work access out again.
 */
export function accessChanged(app: AppServices): void {
  generations.set(app, (generations.get(app) ?? 0) + 1);
}

/** What the caller may do, project by project. One query per request at most. */
export function projectAccess(ctx: Ctx, db: Db = ctx.db): Promise<AccessView> {
  const generation = generations.get(ctx.app) ?? 0;
  const hit = memo.get(ctx.actor);
  if (hit && hit.generation === generation && Date.now() - hit.at < MAX_AGE_MS) return hit.view;
  const view = load(db, ctx.actor);
  const entry = { at: Date.now(), generation, view };
  memo.set(ctx.actor, entry);
  view.catch(() => {
    if (memo.get(ctx.actor) === entry) memo.delete(ctx.actor);
  });
  return view;
}

/**
 * What a person may do as if they signed in themselves (their role's scopes, no token limit):
 * for deciding whom to tell about something, or who may be assigned to it. Not memoised.
 */
export function accessFor(db: Db, user: UserRow): Promise<AccessView> {
  return load(db, { user, scopes: effectiveScopes(user.role), projectIds: null });
}

// ---------------------------------------------------------------------------
// The seam: what services call
// ---------------------------------------------------------------------------

/** Project ids the actor may read, or null for "all". Searches pass them on as `projectIds`. */
export async function visibleProjectIds(ctx: Ctx, db?: Db): Promise<string[] | null> {
  return (await projectAccess(ctx, db)).visibleIds();
}

export async function canReadProject(ctx: Ctx, projectId: string, db?: Db): Promise<boolean> {
  return (await projectAccess(ctx, db)).canRead(projectId);
}

export async function assertCanReadProject(ctx: Ctx, projectId: string, db?: Db): Promise<void> {
  requireScope(ctx, 'read');
  // Hidden projects look like missing ones, so ids can't be probed.
  if (!(await canReadProject(ctx, projectId, db))) throw notFound('Project');
}

/** Comment, or change or delete one's own comment: any role in the project, and the write scope. */
export async function assertCanCommentProject(ctx: Ctx, projectId: string, db?: Db): Promise<void> {
  await assertCanReadProject(ctx, projectId, db);
  requireScope(ctx, 'write');
}

/** Change the project's issues: member or manager, and the write scope. */
export async function assertCanWriteProject(ctx: Ctx, projectId: string, db?: Db): Promise<void> {
  await assertCanReadProject(ctx, projectId, db);
  requireScope(ctx, 'write');
  const view = await projectAccess(ctx, db);
  if (!view.canWrite(projectId)) {
    const key = view.keyOf(projectId) ?? 'this project';
    throw forbidden(`You can read ${key} but not change its issues`, `Ask a manager of ${key} to make you one of its members.`);
  }
}

/** Change the project's settings, people, boards or baselines: manager (or administrator). */
export async function assertCanManageProject(ctx: Ctx, projectId: string, db?: Db): Promise<void> {
  await assertCanReadProject(ctx, projectId, db);
  const view = await projectAccess(ctx, db);
  if (!view.canManage(projectId)) {
    const key = view.keyOf(projectId) ?? 'this project';
    if (view.role(projectId) === 'manager') requireScope(ctx, 'write');
    throw forbidden(`Only managers of ${key} can change this`, `Ask a manager of ${key}, or an administrator.`);
  }
}

export async function assertCanProject(ctx: Ctx, projectId: string, need: ProjectNeed, db?: Db): Promise<void> {
  if (need === 'read') return assertCanReadProject(ctx, projectId, db);
  if (need === 'comment') return assertCanCommentProject(ctx, projectId, db);
  if (need === 'write') return assertCanWriteProject(ctx, projectId, db);
  return assertCanManageProject(ctx, projectId, db);
}

/**
 * A project by key, when the caller may do `need` in it. One they can't see is 404 with the
 * very words used for a key that doesn't exist; one they see but may not change is 403.
 */
export async function requireProject(ctx: Ctx, key: string, need: ProjectNeed = 'read', db?: Db): Promise<ProjectRow> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get(db);
  const p = projectByKey(s, key);
  if (!p || !(await canReadProject(ctx, p.id, db))) throw notFound(`Project ${key.trim().toUpperCase()}`);
  if (need !== 'read') await assertCanProject(ctx, p.id, need, db);
  return p;
}

// ---------------------------------------------------------------------------
// Reference data as the caller may see it
// ---------------------------------------------------------------------------

const scoped = new WeakMap<SchemaSnapshot, Map<string, SchemaSnapshot>>();

/** The snapshot without what belongs to projects in `visible`'s complement (their values too). */
export function scopeSchema(s: SchemaSnapshot, visible: readonly string[] | null): SchemaSnapshot {
  if (visible === null) return s;
  const cacheKey = [...visible].sort().join(',');
  let byKey = scoped.get(s);
  if (!byKey) scoped.set(s, (byKey = new Map()));
  const hit = byKey.get(cacheKey);
  if (hit) return hit;
  const ids = new Set(visible);
  const keep = (projectId: string | null) => projectId === null || ids.has(projectId);
  const out: SchemaSnapshot = {
    ...s,
    values: new Map([...s.values].filter(([, v]) => keep(v.projectId))),
    valuesByField: new Map([...s.valuesByField].map(([fieldId, list]) => [fieldId, list.filter((v) => keep(v.projectId))])),
    projects: new Map([...s.projects].filter(([id]) => ids.has(id))),
    projectsByKey: new Map([...s.projectsByKey].filter(([, p]) => ids.has(p.id))),
    projectFields: new Map([...s.projectFields].filter(([id]) => ids.has(id))),
  };
  if (byKey.size > 64) byKey.clear();
  byKey.set(cacheKey, out);
  return out;
}

/**
 * The reference data (projects, their fields and values) as the caller may see it: for the
 * query language, completion, prompts and anything else that names projects or their values.
 */
export async function visibleSchema(ctx: Ctx, db?: Db): Promise<SchemaSnapshot> {
  const [s, view] = [await ctx.app.schema.get(db), await projectAccess(ctx, db)];
  return scopeSchema(s, view.visibleIds());
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** "BACK-12" → "BACK". */
export function keyOfReadableId(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const m = /^([A-Za-z][A-Za-z0-9]*)-\d+$/.exec(id.trim());
  return m ? m[1]!.toUpperCase() : null;
}

/** Whether the caller can see the project of an issue named by its readable id. */
export function canReadIssueId(view: AccessView, s: SchemaSnapshot, readable: unknown): boolean {
  const key = keyOfReadableId(readable);
  const p = key ? s.projectsByKey.get(key) : undefined;
  return Boolean(p && view.canRead(p.id));
}

/**
 * Words an agent wrote that name issues by id (a triage's summary, its reasons), with the ids of
 * issues the caller can't see taken out. People's own words (comments) are left as they wrote them.
 */
export function redactHiddenIds(text: string, view: AccessView, s: SchemaSnapshot): string {
  if (view.visibleIds() === null) return text;
  return text.replace(/\b[A-Za-z][A-Za-z0-9]*-\d+\b/g, (id) => (canReadIssueId(view, s, id) || !s.projectsByKey.has(keyOfReadableId(id)!) ? id : 'an issue you can’t see'));
}

const LINK_EVENTS = ['link.created', 'link.deleted'];

/**
 * Whether the caller may see an event: it belongs to a project they can read, and a link's
 * other end is an issue they can read too. An event without a project is the instance's, and
 * everyone sees it, unless it is about an issue (whose project was deleted since).
 */
export function eventVisible(view: AccessView, s: SchemaSnapshot, e: Pick<TrackerEvent, 'type' | 'project' | 'issue' | 'data'>): boolean {
  const visible = view.visibleIds();
  if (visible === null) return true;
  const readable = (key: string | null) => {
    const p = key ? s.projectsByKey.get(key.toUpperCase()) : undefined;
    return Boolean(p && view.canRead(p.id));
  };
  if (e.project) {
    if (!readable(e.project)) return false;
  } else if (e.issue) {
    return false;
  }
  if (LINK_EVENTS.includes(e.type)) {
    const target = (e.data as { target?: { id?: unknown } } | undefined)?.target;
    if (!readable(keyOfReadableId(target?.id))) return false;
  }
  return true;
}

/** The same rule as `eventVisible`, as SQL over `activities`, so a feed's pages and cursor stay whole. */
export function eventsVisibleSql(view: AccessView, s: SchemaSnapshot): SQL | undefined {
  const visible = view.visibleIds();
  if (visible === null) return undefined;
  const ids = visible.filter((id) => view.canRead(id));
  const keys = ids.map((id) => s.projects.get(id)?.key.toUpperCase() ?? view.keyOf(id)?.toUpperCase()).filter((k): k is string => Boolean(k));
  const inIds = ids.length ? sql`${activities.projectId} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})` : sql`FALSE`;
  const targetKey = sql`upper(split_part(${activities.payload}->'data'->'target'->>'id', '-', 1))`;
  const targetSeen = keys.length ? sql`coalesce(${targetKey} IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)}), FALSE)` : sql`FALSE`;
  return sql`((${inIds} OR (${activities.projectId} IS NULL AND ${activities.payload}->'issue' IS NULL)) AND (${activities.type} NOT IN ('link.created', 'link.deleted') OR ${targetSeen}))`;
}

// ---------------------------------------------------------------------------
// Other people's access: whom to tell, whom to assign
// ---------------------------------------------------------------------------

/**
 * The role each of these people has in a project, as they would signing in (no token limits).
 * Someone who can't see the project, or is banned, is left out.
 */
export async function projectRolesOf(db: Db, projectId: string, userIds: string[]): Promise<Map<string, ProjectRole>> {
  const out = new Map<string, ProjectRole>();
  const unique = [...new Set(userIds)];
  if (!unique.length) return out;
  const [p] = await db.select({ id: projects.id, key: projects.key, visibility: projects.visibility, leadId: projects.leadId }).from(projects).where(eq(projects.id, projectId));
  if (!p) return out;
  const people = await db.select({ id: users.id, role: users.role, banned: users.banned }).from(users).where(inArray(users.id, unique));
  const roles = await db
    .select({ userId: projectMembers.userId, role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), inArray(projectMembers.userId, unique)));
  const byUser = new Map(roles.map((r) => [r.userId, r.role]));
  // The roles groups have here, for whichever of these people are in them (D27).
  const viaGroups = await db
    .select({ userId: groupMembers.userId, role: projectGroupRoles.role })
    .from(projectGroupRoles)
    .innerJoin(groupMembers, eq(groupMembers.groupId, projectGroupRoles.groupId))
    .where(and(eq(projectGroupRoles.projectId, projectId), inArray(groupMembers.userId, unique)));
  const bestByGroup = new Map<string, ProjectRole>();
  for (const r of viaGroups) {
    if (!isProjectRole(r.role)) continue;
    const had = bestByGroup.get(r.userId);
    if (!had || RANK[r.role] > RANK[had]) bestByGroup.set(r.userId, r.role);
  }
  for (const u of people) {
    if (u.banned) continue;
    const g = grantFor(u.role === 'admin', u.id, { ...p, role: byUser.get(u.id) ?? null, groupRole: bestByGroup.get(u.id) ?? null });
    if (g) out.set(u.id, g.role);
  }
  return out;
}

/** Whether a person (as they would sign in) can see a project at all. */
export async function canUserReadProject(db: Db, userId: string, projectId: string): Promise<boolean> {
  return (await projectRolesOf(db, projectId, [userId])).has(userId);
}
