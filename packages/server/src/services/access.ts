/**
 * Project-level access: who may see a project, and what they may do in it. Every read or write
 * of a project's things asks here, and nothing else decides it.
 *
 * - A project is open (everyone works in it) or members only (only its people and
 *   administrators see it at all). An administrator may also make it readable without signing
 *   in, by guests, who read and nothing else (D37).
 * - A role is a set of permissions (PERMISSIONS in @a4a/shared, D37): the built-in viewer
 *   (reads and comments), member (also reports, changes, deletes issues and logs time) and
 *   manager (everything), and any an administrator defines.
 * - Someone's permissions in a project: a manager's, if they're an administrator or its lead;
 *   otherwise everything the role the project gives them among its people and the roles it gives
 *   groups they're in allow together (D27); otherwise a member's, if the project is open. So an
 *   open project can still keep someone to reading, by naming them (or a group of theirs) a viewer.
 * - Scopes cap it. Reading needs "read"; every permission that changes something needs "write"
 *   (an administrator also manages with "admin"). So a read-only account or token never writes,
 *   whatever its role in a project. Commenting counts as writing.
 * - A token limited to projects reaches those projects only, as far as its person may.
 * - An issue or a comment can be limited to some people and groups (D37). Then only they see it,
 *   besides those who must: an issue's reporter and assignee, a comment's author, the project's
 *   managers (who answer for everything in it) and administrators.
 * - What someone may not read answers exactly as what doesn't exist (404), so nothing can be
 *   probed; what they may read but not change answers 403 and says why.
 *
 * Inside a transaction, pass it as `db`: on PGlite, a query outside the transaction would wait
 * for it. A request works out its access once and keeps it for two seconds at most, or until
 * something here changes on this instance (`accessChanged`).
 */
import {
  BUILTIN_ROLE_NAMES,
  BUILTIN_ROLE_PERMISSIONS,
  PERMISSIONS,
  PROJECT_ROLES,
  WRITING_PERMISSIONS,
  type Permission,
  type ProjectAccess,
  type ProjectRole,
  type Scope,
  type TrackerEvent,
} from '@a4a/shared';
import type { Translator } from '@a4a/shared/i18n';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { effectiveScopes, requireScope, type Actor, type AppServices, type Ctx } from '../context';
import type { Db } from '../db/client';
import { activities, comments, groupMembers, issueAliases, issueFieldValues, issues, projectGroupRoles, projectMembers, projects, roles, users } from '../db/schema';
import { translatorFor } from '../i18n';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { fieldByName, keysOfProject, projectByKey, type ProjectRow, type SchemaSnapshot, type UserRow } from './schema-cache';

export type { ProjectRole };
/** What a check asks for: a permission, or "write" (changing issues, the same as "edit"). */
export type ProjectNeed = Permission | 'write';

/** A role as access works with it: built-in or custom. */
export interface RoleDefn {
  id: string;
  name: string;
  permissions: ReadonlySet<Permission>;
  builtin: boolean;
}

const ALL = new Set<Permission>(PERMISSIONS);
const BUILTIN: ReadonlyMap<string, RoleDefn> = new Map(
  PROJECT_ROLES.map((id) => [id, { id, name: BUILTIN_ROLE_NAMES[id], permissions: new Set(BUILTIN_ROLE_PERMISSIONS[id]), builtin: true }]),
);
const MANAGER = BUILTIN.get('manager')!;
const MEMBER = BUILTIN.get('member')!;
const GUEST: RoleDefn = { id: 'guest', name: 'Guest', permissions: new Set<Permission>(['read']), builtin: true };

interface Grant {
  role: string;
  roleName: string;
  permissions: ReadonlySet<Permission>;
  via: ProjectAccess['via'];
  key: string;
  /** With `via: group`, the group's name. */
  group?: string;
}

export function isProjectRole(role: string | null | undefined): role is ProjectRole {
  return (PROJECT_ROLES as readonly string[]).includes(role ?? '');
}

/** Every role there is: the built-in three, then the custom ones by name. */
export async function loadRoles(db: Db): Promise<Map<string, RoleDefn>> {
  const out = new Map(BUILTIN);
  const rows = await db.select({ id: roles.id, name: roles.name, permissions: roles.permissions }).from(roles).orderBy(sql`lower(${roles.name})`);
  for (const r of rows) {
    out.set(r.id, { id: r.id, name: r.name, permissions: new Set(r.permissions.filter((p): p is Permission => (PERMISSIONS as readonly string[]).includes(p))), builtin: false });
  }
  return out;
}

/** A role named by its id or its name (any case), or a 400 that lists the roles there are. */
export async function resolveRole(db: Db, ref: string): Promise<RoleDefn> {
  const all = await loadRoles(db);
  const want = ref.trim().toLowerCase();
  const found = all.get(ref.trim()) ?? [...all.values()].find((r) => r.name.toLowerCase() === want || r.id.toLowerCase() === want);
  if (!found) throw badRequest(`Unknown role "${ref}"`, `Use one of: ${[...all.values()].map((r) => r.name).join(', ')}.`).said('access.unknownRole', { ref, roles: [...all.values()].map((r) => r.name) });
  return found;
}

/** How a role sorts among others: the built-in ones by rank, then the custom ones by name. */
export function roleOrder(id: string): number {
  return id === 'manager' ? 0 : id === 'member' ? 1 : id === 'viewer' ? 2 : 3;
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
    /** Who it is, and the groups they're in: for who sees a limited issue or comment (D37). */
    readonly userId: string = '',
    readonly groupIds: readonly string[] = [],
    /** A guest, not signed in (D37). */
    readonly guest: boolean = false,
  ) {}

  role(projectId: string): string | null {
    return this.grants.get(projectId)?.role ?? null;
  }

  /** Whether the role allows it, as far as the account or token does. */
  allows(projectId: string, permission: Permission): boolean {
    const g = this.grants.get(projectId);
    if (!g || !this.scopes.includes('read') || !g.permissions.has(permission)) return false;
    if (permission === 'manage') return this.scopes.includes('write') || (this.admin && this.scopes.includes('admin'));
    if (WRITING_PERMISSIONS.includes(permission)) return this.scopes.includes('write');
    return true;
  }

  canRead(projectId: string): boolean {
    return this.allows(projectId, 'read');
  }

  canComment(projectId: string): boolean {
    return this.allows(projectId, 'comment');
  }

  canWrite(projectId: string): boolean {
    return this.allows(projectId, 'edit');
  }

  canManage(projectId: string): boolean {
    return this.allows(projectId, 'manage');
  }

  can(projectId: string, need: ProjectNeed): boolean {
    return this.allows(projectId, need === 'write' ? 'edit' : need);
  }

  /**
   * Whether they see every issue and comment in the project, whoever it's limited to: its
   * managers and administrators. Seeing is reading, so a read-only token of theirs sees them too.
   */
  seesAllIn(projectId: string): boolean {
    if (!this.canRead(projectId)) return false;
    return this.admin || Boolean(this.grants.get(projectId)?.permissions.has('manage'));
  }

  /** The projects whose every issue they see (`seesAllIn`). */
  managedIds(): string[] {
    return [...this.grants.keys()].filter((id) => this.seesAllIn(id));
  }

  /** Ids of the projects it may read, or null for every project there is. */
  visibleIds(): string[] | null {
    if (!this.scopes.includes('read')) return [];
    return this.everything ? null : [...this.grants.keys()].filter((id) => this.canRead(id));
  }

  /** What it may do in a project, for the API; null when it can't see it. */
  describe(projectId: string): ProjectAccess | null {
    const g = this.grants.get(projectId);
    if (!g || !this.canRead(projectId)) return null;
    return {
      role: g.role,
      roleName: g.roleName,
      via: g.via,
      group: g.group ?? null,
      permissions: PERMISSIONS.filter((p) => this.allows(projectId, p)),
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
  /** The roles it gives groups they're in, and those groups' names, by name. */
  groupRoles?: string[] | null;
  groupNames?: string[] | null;
}

function grantFor(admin: boolean, userId: string, r: ProjectAccessRow, all: ReadonlyMap<string, RoleDefn>): Grant | null {
  if (admin) return { role: MANAGER.id, roleName: MANAGER.name, permissions: ALL, via: 'admin', key: r.key };
  if (r.leadId === userId) return { role: MANAGER.id, roleName: MANAGER.name, permissions: ALL, via: 'lead', key: r.key };
  const own = r.role ? all.get(r.role) : undefined;
  const viaGroups = (r.groupRoles ?? [])
    .map((id, i) => ({ role: all.get(id), group: r.groupNames?.[i] ?? undefined }))
    .filter((g): g is { role: RoleDefn; group: string | undefined } => Boolean(g.role));
  if (own || viaGroups.length) {
    // Everything their own role and their groups' roles allow, together. The role it's named by is
    // the one that allows the most; their own, when it ties.
    const permissions = new Set<Permission>(own?.permissions ?? []);
    for (const g of viaGroups) for (const p of g.role.permissions) permissions.add(p);
    let named: { role: RoleDefn; via: ProjectAccess['via']; group?: string } | null = own ? { role: own, via: 'member' } : null;
    for (const g of viaGroups) {
      if (!named || g.role.permissions.size > named.role.permissions.size) named = { role: g.role, via: 'group', group: g.group };
    }
    return { role: named!.role.id, roleName: named!.role.name, permissions, via: named!.via, key: r.key, group: named!.group };
  }
  if (r.visibility !== 'members') return { role: MEMBER.id, roleName: MEMBER.name, permissions: MEMBER.permissions, via: 'open', key: r.key };
  return null;
}

async function groupIdsOf(db: Db, userId: string): Promise<string[]> {
  const rows = await db.select({ id: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.userId, userId));
  return rows.map((r) => r.id);
}

async function load(db: Db, actor: Pick<Actor, 'user' | 'scopes' | 'projectIds' | 'guest' | 'app'>): Promise<AccessView> {
  // A guest reads the projects open to guests, and nothing else (D37).
  if (actor.guest) {
    const open = await db
      .select({ id: projects.id, key: projects.key })
      .from(projects)
      .where(and(eq(projects.guestAccess, true), eq(projects.visibility, 'open')));
    const grants = new Map<string, Grant>(open.map((p) => [p.id, { role: GUEST.id, roleName: GUEST.name, permissions: GUEST.permissions, via: 'guest', key: p.key }]));
    return new AccessView(false, actor.scopes, grants, false, actor.user.id, [], true);
  }
  // An app's agent (D48): what its grant gives it, in the projects it runs in, and nothing else.
  if (actor.app?.agent) {
    const permissions = appPermissions(actor.app.granted);
    const limit = actor.projectIds ? new Set(actor.projectIds) : null;
    const rows = await db.select({ id: projects.id, key: projects.key }).from(projects).where(inArray(projects.id, actor.app.projectIds.length ? actor.app.projectIds : ['']));
    const grants = new Map<string, Grant>();
    for (const p of rows) {
      if (limit && !limit.has(p.id)) continue;
      if (!actor.user.banned) grants.set(p.id, { role: 'app', roleName: 'App', permissions, via: 'app', key: p.key });
    }
    return new AccessView(false, actor.scopes, grants, false, actor.user.id, []);
  }
  const admin = actor.user.role === 'admin' || actor.scopes.includes('admin');
  const limit = actor.projectIds ? new Set(actor.projectIds) : null;
  // One query: each project, the person's own role in it, and the roles groups of theirs have there.
  const [res, all, groupIds] = await Promise.all([
    db.execute(sql`
      SELECT p.id, p.key, p.visibility, p.lead_id AS "leadId", pm.role AS role, g.roles AS "groupRoles", g.names AS "groupNames"
      FROM ${projects} p
      LEFT JOIN ${projectMembers} pm ON pm.project_id = p.id AND pm.user_id = ${actor.user.id}
      LEFT JOIN LATERAL (
        SELECT array_agg(pgr.role ORDER BY lower(gr.name)) AS roles, array_agg(gr.name ORDER BY lower(gr.name)) AS names
        FROM ${projectGroupRoles} pgr
        JOIN ${groupMembers} gm ON gm.group_id = pgr.group_id AND gm.user_id = ${actor.user.id}
        JOIN groups gr ON gr.id = pgr.group_id
        WHERE pgr.project_id = p.id
      ) g ON TRUE
    `),
    loadRoles(db),
    groupIdsOf(db, actor.user.id),
  ]);
  const rows = (res as unknown as { rows: ProjectAccessRow[] }).rows;
  const grants = new Map<string, Grant>();
  for (const r of rows) {
    if (limit && !limit.has(r.id)) continue;
    const g = actor.user.banned ? null : grantFor(admin, actor.user.id, r, all);
    if (g) grants.set(r.id, actor.app ? withoutPrivateFields(g) : g);
  }
  return new AccessView(admin, actor.scopes, grants, admin && !limit && !actor.user.banned, actor.user.id, groupIds);
}

/**
 * What an app's grant (D48) allows in a project, as permissions: reading, and each kind of writing
 * it was granted. Writing fields' values and articles needs more than a role an app holds gives; an
 * app does those through a person's widget or handler, with that person's permissions.
 */
export function appPermissions(granted: { read: readonly string[]; write: readonly string[] }): ReadonlySet<Permission> {
  const out = new Set<Permission>();
  if (granted.read.length || granted.write.length) out.add('read');
  if (granted.write.includes('issues')) {
    out.add('create');
    out.add('edit');
  }
  if (granted.write.includes('comments')) out.add('comment');
  if (granted.write.includes('time')) out.add('time');
  if (granted.read.includes('time')) out.add('costs');
  return out;
}

const MAX_AGE_MS = 2_000;
const memo = new WeakMap<Actor, { at: number; generation: number; view: Promise<AccessView> }>();
const generations = new WeakMap<AppServices, number>();

/**
 * Call after anything that changes who may see or do what: a project's people or visibility,
 * its lead, someone's role or ban, a token's projects, a role's permissions. Other instances see
 * it within two seconds, when their requests work access out again.
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
  if (!(await canReadProject(ctx, projectId, db))) throw notFound('Project').said('notFound.projectUnnamed');
}

/** What each permission lets one do, for the words of a refusal. */
const DOING: Record<Permission, string> = {
  read: 'read it',
  comment: 'comment in it',
  create: 'report issues in it',
  edit: 'change its issues',
  delete: 'delete its issues',
  time: 'log time in it',
  costs: 'see its time and costs',
  boards: 'change its boards',
  manage: 'change its settings',
  readPrivate: 'see its private fields',
  editPrivate: 'change its private fields',
};

/**
 * The caller may do `need` in the project: one they can't see is 404 in the words of a missing
 * one; one they see but whose role doesn't allow it is 403, saying which permission it takes.
 */
export async function assertCanProject(ctx: Ctx, projectId: string, need: ProjectNeed, db?: Db): Promise<void> {
  await assertCanReadProject(ctx, projectId, db);
  const permission: Permission = need === 'write' ? 'edit' : need;
  if (permission === 'read') return;
  const view = await projectAccess(ctx, db);
  if (view.allows(projectId, permission)) return;
  const key = view.keyOf(projectId) ?? 'this project';
  if (permission === 'manage') {
    if (view.seesAllIn(projectId)) requireScope(ctx, 'write');
    throw forbidden(`Only managers of ${key} can change this`, `Ask a manager of ${key}, or an administrator.`).said('access.onlyManagers', { key });
  }
  if (WRITING_PERMISSIONS.includes(permission)) requireScope(ctx, 'write');
  throw forbidden(`Your role in ${key} doesn't let you ${DOING[permission]}`, `Ask a manager of ${key} for a role that does.`).said('access.roleDoesNotAllow', { key, permission });
}

/** Comment, or change or delete one's own comment. */
export async function assertCanCommentProject(ctx: Ctx, projectId: string, db?: Db): Promise<void> {
  await assertCanProject(ctx, projectId, 'comment', db);
}

/** Change the project's issues. */
export async function assertCanWriteProject(ctx: Ctx, projectId: string, db?: Db): Promise<void> {
  await assertCanProject(ctx, projectId, 'edit', db);
}

/** Change the project's settings, people, boards or baselines: manager (or administrator). */
export async function assertCanManageProject(ctx: Ctx, projectId: string, db?: Db): Promise<void> {
  await assertCanProject(ctx, projectId, 'manage', db);
}

/**
 * A project by key, when the caller may do `need` in it. One they can't see is 404 with the
 * very words used for a key that doesn't exist; one they see but may not change is 403.
 */
export async function requireProject(ctx: Ctx, key: string, need: ProjectNeed = 'read', db?: Db): Promise<ProjectRow> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get(db);
  const p = projectByKey(s, key);
  if (!p || !(await canReadProject(ctx, p.id, db))) throw notFound(`Project ${key.trim().toUpperCase()}`).said('notFound.project', { id: key.trim().toUpperCase() });
  if (need !== 'read') await assertCanProject(ctx, p.id, need, db);
  return p;
}

// ---------------------------------------------------------------------------
// Who sees an issue or a comment that is limited (D37)
// ---------------------------------------------------------------------------

/** The field whose people an issue is assigned to: "Assignee", or the first person field. */
export function assigneeFieldIdOf(s: SchemaSnapshot): string | undefined {
  const named = fieldByName(s, 'Assignee');
  if (named?.type === 'user') return named.id;
  for (const f of s.fields.values()) if (f.type === 'user') return f.id;
  return undefined;
}

const ident = (alias: string) => sql.raw(`"${alias.replace(/"/g, '')}"`);
const list = (ids: readonly string[]) => sql.join(ids.map((id) => sql`${id}`), sql`, `);

/**
 * SQL over an `issues` row (as `alias`): whether the viewer sees it, as far as its being limited
 * goes (the project is checked apart). Undefined when they see every issue they can reach.
 */
export function issueSeenSql(view: AccessView, s: SchemaSnapshot, alias = 'issues'): SQL | undefined {
  if (view.admin) return undefined;
  const a = ident(alias);
  const parts: SQL[] = [sql`NOT ${a}.limited`];
  const managed = view.managedIds();
  if (managed.length) parts.push(sql`${a}.project_id IN (${list(managed)})`);
  if (!view.guest && view.userId) {
    parts.push(sql`${a}.reporter_id = ${view.userId}`, sql`${view.userId} = ANY(${a}.visible_user_ids)`);
    if (view.groupIds.length) parts.push(sql`${a}.visible_group_ids && ARRAY[${list(view.groupIds)}]::text[]`);
    const assignee = assigneeFieldIdOf(s);
    if (assignee) {
      parts.push(sql`EXISTS (SELECT 1 FROM issue_field_values seen_av WHERE seen_av.issue_id = ${a}.id AND seen_av.field_id = ${assignee} AND seen_av.user_id = ${view.userId})`);
    }
  }
  return sql`(${sql.join(parts, sql` OR `)})`;
}

/** SQL over a `comments` row (as `alias`): whether the viewer sees it, as far as its being limited goes. */
export function commentSeenSql(view: AccessView, alias = 'c'): SQL | undefined {
  if (view.admin) return undefined;
  const a = ident(alias);
  const parts: SQL[] = [sql`NOT ${a}.limited`];
  const managed = view.managedIds();
  if (managed.length) parts.push(sql`EXISTS (SELECT 1 FROM issues seen_ci WHERE seen_ci.id = ${a}.issue_id AND seen_ci.project_id IN (${list(managed)}))`);
  if (!view.guest && view.userId) {
    parts.push(sql`${a}.author_id = ${view.userId}`, sql`${view.userId} = ANY(${a}.visible_user_ids)`);
    if (view.groupIds.length) parts.push(sql`${a}.visible_group_ids && ARRAY[${list(view.groupIds)}]::text[]`);
  }
  return sql`(${sql.join(parts, sql` OR `)})`;
}

type Limits = { limited: boolean; visibleUserIds: string[]; visibleGroupIds: string[] };
type IssueLimits = Limits & { id: string; projectId: string; reporterId: string | null };
type CommentLimits = Limits & { authorId: string | null };

function listedIn(view: AccessView, row: Limits): boolean {
  if (view.guest || !view.userId) return false;
  return row.visibleUserIds.includes(view.userId) || row.visibleGroupIds.some((g) => view.groupIds.includes(g));
}

/** Whether the viewer sees an issue they can reach the project of, as far as its being limited goes. */
export async function seesIssueRow(view: AccessView, db: Db, s: SchemaSnapshot, row: IssueLimits): Promise<boolean> {
  if (!row.limited || view.seesAllIn(row.projectId)) return true;
  if (view.guest || !view.userId) return false;
  if (row.reporterId === view.userId || listedIn(view, row)) return true;
  const assignee = assigneeFieldIdOf(s);
  if (!assignee) return false;
  const [hit] = await db
    .select({ id: issueFieldValues.id })
    .from(issueFieldValues)
    .where(and(eq(issueFieldValues.issueId, row.id), eq(issueFieldValues.fieldId, assignee), eq(issueFieldValues.userId, view.userId)))
    .limit(1);
  return Boolean(hit);
}

/** Whether the viewer sees a comment on an issue they see, as far as its being limited goes. */
export function seesCommentRow(view: AccessView, projectId: string, row: CommentLimits): boolean {
  if (!row.limited || view.seesAllIn(projectId)) return true;
  if (view.guest || !view.userId) return false;
  return row.authorId === view.userId || listedIn(view, row);
}

/** Of these issue ids, the ones the caller sees: in a project they read, and not limited away from them. */
export async function seenIssueIds(ctx: Ctx, ids: readonly string[], db: Db = ctx.db): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Set();
  const [view, s] = [await projectAccess(ctx, db), await ctx.app.schema.get(db)];
  const seen = issueSeenSql(view, s);
  const rows = await db
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(seen ? and(inArray(issues.id, unique), seen) : inArray(issues.id, unique));
  return new Set(rows.filter((r) => view.canRead(r.projectId)).map((r) => r.id));
}

/**
 * Of these people, those who see an issue, as each would signing in: they reach its project, and
 * it isn't limited away from them. For whom to tell of it.
 */
export async function whoSeesIssue(db: Db, s: SchemaSnapshot, issue: IssueLimits, userIds: readonly string[]): Promise<Set<string>> {
  const grants = await projectGrantsOf(db, issue.projectId, [...userIds]);
  if (!issue.limited) return new Set(grants.keys());
  const out = new Set<string>();
  const rest: string[] = [];
  for (const [id, g] of grants) {
    if (g.permissions.has('manage') || id === issue.reporterId || issue.visibleUserIds.includes(id)) out.add(id);
    else rest.push(id);
  }
  if (rest.length && issue.visibleGroupIds.length) {
    const inGroups = await db.select({ userId: groupMembers.userId }).from(groupMembers).where(and(inArray(groupMembers.userId, rest), inArray(groupMembers.groupId, issue.visibleGroupIds)));
    for (const r of inGroups) out.add(r.userId);
  }
  const assignee = assigneeFieldIdOf(s);
  const left = rest.filter((id) => !out.has(id));
  if (assignee && left.length) {
    const assigned = await db
      .select({ userId: issueFieldValues.userId })
      .from(issueFieldValues)
      .where(and(eq(issueFieldValues.issueId, issue.id), eq(issueFieldValues.fieldId, assignee), inArray(issueFieldValues.userId, left)));
    for (const r of assigned) if (r.userId) out.add(r.userId);
  }
  return out;
}

/** Of these people (who see the issue), those who see one of its comments. */
export async function whoSeesComment(db: Db, projectId: string, comment: CommentLimits, userIds: readonly string[]): Promise<Set<string>> {
  if (!comment.limited) return new Set(userIds);
  const grants = await projectGrantsOf(db, projectId, [...userIds]);
  const out = new Set<string>();
  const rest: string[] = [];
  for (const id of userIds) {
    if (grants.get(id)?.permissions.has('manage') || id === comment.authorId || comment.visibleUserIds.includes(id)) out.add(id);
    else rest.push(id);
  }
  if (rest.length && comment.visibleGroupIds.length) {
    const inGroups = await db.select({ userId: groupMembers.userId }).from(groupMembers).where(and(inArray(groupMembers.userId, rest), inArray(groupMembers.groupId, comment.visibleGroupIds)));
    for (const r of inGroups) out.add(r.userId);
  }
  return out;
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
    formerKeys: new Map([...s.formerKeys].filter(([id]) => ids.has(id))),
    projectFields: new Map([...s.projectFields].filter(([id]) => ids.has(id))),
    // A desk's customer groups name its customers: only its readers learn them (D56).
    customerGroups: new Map([...s.customerGroups].filter(([, g]) => ids.has(g.projectId))),
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
  // Without the private fields they may not see, too (D50).
  return scopeFields(scopeSchema(s, view.visibleIds()), view);
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
 * issues the caller can't see taken out, in their reader's language (`tr`, D49). People's own words
 * (comments) are left as they wrote them.
 */
export function redactHiddenIds(text: string, view: AccessView, s: SchemaSnapshot, tr: Translator): string {
  if (view.visibleIds() === null) return text;
  return text.replace(/\b[A-Za-z][A-Za-z0-9]*-\d+\b/g, (id) => (canReadIssueId(view, s, id) || !s.projectsByKey.has(keyOfReadableId(id)!) ? id : tr.t('server.access.issueYouCantSee')));
}

/**
 * The same, also taking out issues limited away from the caller (D37), which needs the database.
 */
export async function redactUnseenIds(ctx: Ctx, text: string): Promise<string> {
  const [view, s] = [await projectAccess(ctx), await ctx.app.schema.get()];
  const tr = translatorFor(ctx.locale);
  const named = [...new Set(text.match(/\b[A-Za-z][A-Za-z0-9]*-\d+\b/g) ?? [])];
  if (!named.length) return redactUnseenArticleIds(ctx, text);
  const rows: { readable: string; id: string }[] = [];
  for (const id of named) {
    const key = keyOfReadableId(id);
    const p = key ? s.projectsByKey.get(key) : undefined;
    if (!p) continue;
    const [row] = await ctx.db.select({ id: issues.id }).from(issues).where(and(eq(issues.projectId, p.id), eq(issues.number, Number(id.slice(id.lastIndexOf('-') + 1)))));
    if (row) rows.push({ readable: id, id: row.id });
  }
  const seen = await seenIssueIds(ctx, rows.map((r) => r.id));
  const hidden = new Set(rows.filter((r) => !seen.has(r.id)).map((r) => r.readable.toUpperCase()));
  return redactUnseenArticleIds(ctx, redactHiddenIds(text, view, s, tr).replace(/\b[A-Za-z][A-Za-z0-9]*-\d+\b/g, (id) => (hidden.has(id.toUpperCase()) ? tr.t('server.access.issueYouCantSee') : id)));
}

const LINK_EVENTS = ['link.created', 'link.deleted'];

/**
 * Whether the caller may see an event, as far as projects go: it belongs to a project they can
 * read, and a link's other end is an issue in one they can read too. An event without a project
 * is the instance's, and everyone sees it, unless it is about an issue (whose project was deleted
 * since). Whether its issue or comment is limited away from them is `eventSeen`'s to say.
 */
/** A whiteboard's life, the events the feed hears (D58): a personal board's ride on its own sharing. */
const WHITEBOARD_EVENTS: readonly string[] = ['whiteboard.created', 'whiteboard.renamed', 'whiteboard.deleted', 'whiteboard.converted'];

export function eventVisible(view: AccessView, s: SchemaSnapshot, e: Pick<TrackerEvent, 'type' | 'project' | 'issue' | 'data'>): boolean {
  // A week of time, submitted or approved (D43's revisit): the person and administrators alone.
  if (!e.project && !e.issue && WHITEBOARD_EVENTS.includes(e.type)) {
    const personal = (e.data as { whiteboard?: { personal?: { share?: string; people?: string[]; groups?: string[] } } } | undefined)?.whiteboard?.personal;
    if (!personal || view.guest) return false;
    return personal.share === 'everyone' || (personal.people ?? []).includes(view.userId) || (personal.groups ?? []).some((g) => view.groupIds.includes(g));
  }
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

/** An event's issue and comment, as who-sees-what needs them; kept a moment, since every open stream asks. */
const factsCache = new Map<number, { at: number; facts: Promise<{ issue: IssueLimits | null; comment: CommentLimits | null; target: IssueLimits | null }> }>();

function eventFacts(db: Db, s: SchemaSnapshot, e: Pick<TrackerEvent, 'id' | 'type' | 'issue' | 'data'>, fresh = false) {
  const hit = factsCache.get(e.id);
  if (!fresh && hit && Date.now() - hit.at < 10_000) return hit.facts;
  const facts = (async () => {
    const issueOf = async (readable: unknown): Promise<IssueLimits | null> => {
      const key = keyOfReadableId(readable);
      const p = key ? s.projectsByKey.get(key) : undefined;
      if (!p || typeof readable !== 'string') return null;
      const [row] = await db
        .select({ id: issues.id, projectId: issues.projectId, reporterId: issues.reporterId, limited: issues.limited, visibleUserIds: issues.visibleUserIds, visibleGroupIds: issues.visibleGroupIds })
        .from(issues)
        .where(and(eq(issues.projectId, p.id), eq(issues.number, Number(readable.slice(readable.lastIndexOf('-') + 1)))));
      return row ?? null;
    };
    const issue = await issueOf(e.issue?.id);
    const commentId = (e.data as { commentId?: unknown } | undefined)?.commentId;
    let comment: CommentLimits | null = null;
    if (typeof commentId === 'string') {
      const [row] = await db
        .select({ authorId: comments.authorId, limited: comments.limited, visibleUserIds: comments.visibleUserIds, visibleGroupIds: comments.visibleGroupIds })
        .from(comments)
        .where(eq(comments.id, commentId));
      comment = row ?? null;
    }
    const target = LINK_EVENTS.includes(e.type) ? await issueOf((e.data as { target?: { id?: unknown } } | undefined)?.target?.id) : null;
    return { issue, comment, target };
  })();
  if (factsCache.size > 2000) factsCache.clear();
  factsCache.set(e.id, { at: Date.now(), facts });
  return facts;
}

/** Whether the caller sees an event: `eventVisible`, and its issue, comment and link's other end aren't limited away from them (D37). */
export async function eventSeen(
  view: AccessView,
  db: Db,
  s: SchemaSnapshot,
  e: Pick<TrackerEvent, 'id' | 'type' | 'project' | 'issue' | 'data'>,
  /** Read the issue's and comment's limits now, not as they were a moment ago: before sending something on (a push, D47). */
  opts: { fresh?: boolean } = {},
): Promise<boolean> {
  if (!eventVisible(view, s, e)) return false;
  if (!(await articleEventSeen(view, db, s, e, opts))) return false;
  if (!(await goneEventSeen(view, db, s, e, opts))) return false;
  if (view.admin || !e.issue) return true;
  const { issue, comment, target } = await eventFacts(db, s, e, opts.fresh);
  // A limited issue that's gone (its deletion, or what it was before): only who saw all of its project.
  if (!issue && (e.data as { limited?: unknown } | undefined)?.limited === true) {
    const p = s.projectsByKey.get(keyOfReadableId(e.issue.id) ?? '');
    if (!p || !view.seesAllIn(p.id)) return false;
  }
  if (issue && !(await seesIssueRow(view, db, s, issue))) return false;
  if (issue && comment && !seesCommentRow(view, issue.projectId, comment)) return false;
  if (target && !(await seesIssueRow(view, db, s, target))) return false;
  return true;
}

/**
 * Whether an event is about something limited (D37): its issue, its comment, or a link's other
 * end, or an issue that was limited when it was deleted. Webhooks don't carry these.
 */
export async function eventLimited(db: Db, s: SchemaSnapshot, e: Pick<TrackerEvent, 'id' | 'type' | 'project' | 'issue' | 'data'>): Promise<boolean> {
  if ((e.data as { limited?: unknown } | undefined)?.limited === true) return true;
  if (await articleEventLimited(db, s, e)) return true;
  if (await goneEventLimited(db, s, e)) return true;
  if (!e.issue) return false;
  const { issue, comment, target } = await eventFacts(db, s, e);
  return Boolean(issue?.limited || comment?.limited || target?.limited);
}

/** The same rule as `eventSeen`, as SQL over `activities`, so a feed's pages and cursor stay whole. */
export function eventsVisibleSql(view: AccessView, s: SchemaSnapshot): SQL | undefined {
  const visible = view.visibleIds();
  // Even who sees every project hears only the personal whiteboards whose sharing names them (D58's revisit).
  if (visible === null) {
    const personal = sql`(${activities.projectId} IS NOT NULL OR ${activities.payload}->'issue' IS NOT NULL OR ${activities.type} NOT IN ('whiteboard.created', 'whiteboard.renamed', 'whiteboard.deleted', 'whiteboard.converted') OR coalesce(${activities.payload}->'data'->'whiteboard'->'personal'->>'share', 'everyone') = 'everyone' OR ${activities.payload}->'data'->'whiteboard'->'personal'->'people' ? ${view.userId} OR EXISTS (SELECT 1 FROM group_members seen_adm_gm WHERE seen_adm_gm.user_id = ${view.userId} AND ${activities.payload}->'data'->'whiteboard'->'personal'->'groups' ? seen_adm_gm.group_id))`;
    return personal;
  }
  const ids = visible.filter((id) => view.canRead(id));
  // A link written before its other end's project was renamed names it by a key it had (D52).
  const keys = ids.flatMap((id) => (s.projects.has(id) ? keysOfProject(s, id) : [view.keyOf(id)?.toUpperCase()])).filter((k): k is string => Boolean(k));
  const inIds = ids.length ? sql`${activities.projectId} IN (${list(ids)})` : sql`FALSE`;
  const targetKey = sql`upper(split_part(${activities.payload}->'data'->'target'->>'id', '-', 1))`;
  const targetSeen = keys.length ? sql`coalesce(${targetKey} IN (${list(keys)}), FALSE)` : sql`FALSE`;
  const parts: SQL[] = [
    // Nothing to do with a project shows in everyone's feed; a personal whiteboard's events only in its readers' (D58's revisit),
    // as the event kept its sharing: everyone, or its people and groups, which a deleted whiteboard can no longer say itself.
    sql`(${inIds} OR (${activities.projectId} IS NULL AND ${activities.payload}->'issue' IS NULL AND (
      ${activities.type} NOT IN ('whiteboard.created', 'whiteboard.renamed', 'whiteboard.deleted', 'whiteboard.converted')
      OR coalesce(${activities.payload}->'data'->'whiteboard'->'personal'->>'share', 'everyone') = 'everyone'
      OR ${activities.payload}->'data'->'whiteboard'->'personal'->'people' ? ${view.userId}
      OR EXISTS (SELECT 1 FROM group_members seen_gm WHERE seen_gm.user_id = ${view.userId} AND ${activities.payload}->'data'->'whiteboard'->'personal'->'groups' ? seen_gm.group_id)
    )))`,
    sql`(${activities.type} NOT IN ('link.created', 'link.deleted') OR ${targetSeen})`,
  ];
  // An issue, or a comment, limited away from them hides its events (D37); and a link's, when its other end is.
  const issueSeen = issueSeenSql(view, s, 'seen_ei');
  if (issueSeen) {
    const managed = view.managedIds();
    const inManaged = managed.length ? sql`${activities.projectId} IN (${list(managed)})` : sql`FALSE`;
    parts.push(sql`(${activities.payload}->'data'->>'limited' IS DISTINCT FROM 'true' OR ${activities.issueId} IS NOT NULL OR ${inManaged})`);
    parts.push(sql`(${activities.issueId} IS NULL OR EXISTS (SELECT 1 FROM issues seen_ei WHERE seen_ei.id = ${activities.issueId} AND ${issueSeen}))`);
    const targetIssueSeen = issueSeenSql(view, s, 'seen_ti');
    parts.push(
      sql`(${activities.type} NOT IN ('link.created', 'link.deleted') OR NOT EXISTS (SELECT 1 FROM issues seen_ti JOIN projects seen_tp ON seen_tp.id = seen_ti.project_id WHERE upper(seen_tp.key) = ${targetKey} AND seen_ti.number::text = split_part(${activities.payload}->'data'->'target'->>'id', '-', 2) AND NOT ${targetIssueSeen}))`,
    );
  }
  const commentSeen = commentSeenSql(view, 'seen_c');
  if (commentSeen) {
    parts.push(
      sql`(${activities.payload}->'data'->>'commentId' IS NULL OR NOT EXISTS (SELECT 1 FROM comments seen_c WHERE seen_c.id = ${activities.payload}->'data'->>'commentId' AND NOT ${commentSeen}))`,
    );
  }
  const articleSeen = articleEventsSeenSql(view);
  if (articleSeen) parts.push(articleSeen);
  // A limited issue deleted since, a link naming it, a comment limited on one: as hidden as it was.
  const goneSeen = goneEventsSql(view);
  if (goneSeen) parts.push(goneSeen);
  return sql`(${sql.join(parts, sql` AND `)})`;
}

// ---------------------------------------------------------------------------
// Other people's access: whom to tell, whom to assign
// ---------------------------------------------------------------------------

/**
 * What each of these people may do in a project, as they would signing in (no token limits).
 * Someone who can't see the project, or is banned, is left out.
 */
export async function projectGrantsOf(db: Db, projectId: string, userIds: string[]): Promise<Map<string, Grant>> {
  const out = new Map<string, Grant>();
  const unique = [...new Set(userIds)];
  if (!unique.length) return out;
  const [p] = await db.select({ id: projects.id, key: projects.key, visibility: projects.visibility, leadId: projects.leadId }).from(projects).where(eq(projects.id, projectId));
  if (!p) return out;
  const [people, own, viaGroups, all] = await Promise.all([
    db.select({ id: users.id, role: users.role, banned: users.banned }).from(users).where(inArray(users.id, unique)),
    db
      .select({ userId: projectMembers.userId, role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), inArray(projectMembers.userId, unique))),
    // The roles groups have here, for whichever of these people are in them (D27).
    db
      .select({ userId: groupMembers.userId, role: projectGroupRoles.role, name: sql<string>`(SELECT name FROM groups WHERE groups.id = ${projectGroupRoles.groupId})` })
      .from(projectGroupRoles)
      .innerJoin(groupMembers, eq(groupMembers.groupId, projectGroupRoles.groupId))
      .where(and(eq(projectGroupRoles.projectId, projectId), inArray(groupMembers.userId, unique))),
    loadRoles(db),
  ]);
  const byUser = new Map(own.map((r) => [r.userId, r.role]));
  for (const u of people) {
    if (u.banned) continue;
    const theirs = viaGroups.filter((r) => r.userId === u.id).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const g = grantFor(u.role === 'admin', u.id, { ...p, role: byUser.get(u.id) ?? null, groupRoles: theirs.map((r) => r.role), groupNames: theirs.map((r) => r.name) }, all);
    if (g) out.set(u.id, g);
  }
  return out;
}

/**
 * The role each of these people has in a project, as they would signing in (no token limits).
 * Someone who can't see the project, or is banned, is left out.
 */
export async function projectRolesOf(db: Db, projectId: string, userIds: string[]): Promise<Map<string, string>> {
  const grants = await projectGrantsOf(db, projectId, userIds);
  return new Map([...grants].map(([id, g]) => [id, g.role]));
}

/** Whether a person (as they would sign in) can see a project at all. */
export async function canUserReadProject(db: Db, userId: string, projectId: string): Promise<boolean> {
  return (await projectRolesOf(db, projectId, [userId])).has(userId);
}

/** Who manages a project: its lead, and its people whose role, or a group's role, lets them manage it. Not every administrator. */
export async function managersOf(db: Db, projectId: string): Promise<string[]> {
  const [p] = await db.select({ leadId: projects.leadId }).from(projects).where(eq(projects.id, projectId));
  const named = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId))
    .union(
      db
        .select({ userId: groupMembers.userId })
        .from(projectGroupRoles)
        .innerJoin(groupMembers, eq(groupMembers.groupId, projectGroupRoles.groupId))
        .where(eq(projectGroupRoles.projectId, projectId)),
    );
  const candidates = [...new Set([...(p?.leadId ? [p.leadId] : []), ...named.map((r) => r.userId)])];
  const grants = await projectGrantsOf(db, projectId, candidates);
  return [...grants].filter(([id, g]) => g.permissions.has('manage') && (g.via !== 'admin' || id === p?.leadId || named.some((n) => n.userId === id))).map(([id]) => id);
}

// ---------------------------------------------------------------------------
// Requesters on the portal (D45)
// ---------------------------------------------------------------------------

/** An email's domain, in lower case: what a desk's organizations are named by. */
export function emailDomain(email: string): string {
  return email.trim().toLowerCase().split('@').pop() ?? '';
}

/** A help desk request as the portal's seam reads it: who asked, the customer group it was filed under, and whether it's kept from the group. */
export type RequestSharing = { requesterId: string; groupId: string | null; private: boolean };

/**
 * Whether a requester signed in to the portal sees a request: one they made; one they're copied on
 * (`copied`, D57: they're told of it by email already); or one filed under a customer group they're
 * in whose members share their requests (D56; `groups`: what each of their groups shares with them,
 * services/customer-groups.ts), unless its requester or the team kept it private. Being copied and
 * being in its group are grants of their own: neither changes the other. Nothing else of a project,
 * ever: a requester is never a member.
 */
export function requesterSees(request: RequestSharing, viewer: { id: string }, groups: ReadonlyMap<string, 'none' | 'read' | 'comment'>, copied = false): boolean {
  if (request.requesterId === viewer.id || copied) return true;
  if (request.private || !request.groupId) return false;
  const sharing = groups.get(request.groupId);
  return sharing === 'read' || sharing === 'comment';
}

/** How a requester's portal session was opened (D63): an emailed link, their password, an identity provider, or a passkey (D69). */
export type PortalSignedIn = { method: 'link' | 'password' | 'sso' | 'passkey'; providerId: string | null };

/**
 * Whether a portal session opens a desk's requests to its requester at all (D63), before
 * `requesterSees` decides each: it was opened in a way the desk takes, and, where they're in a
 * customer group of the desk tied to an identity provider (`groupProvider`), through that provider
 * and no other way: never by a passkey (D69), which would let them in after the provider turned them
 * away. Read at each request, so a desk that stops taking a way closes it at once. What a session
 * doesn't open is missing, as a request that doesn't exist is.
 */
export function portalSessionOpens(desk: { link: boolean; password: boolean; providers: readonly string[]; passkey?: boolean }, groupProvider: string | null, session: PortalSignedIn): boolean {
  if (groupProvider) return session.method === 'sso' && session.providerId === groupProvider && desk.providers.includes(groupProvider);
  if (session.method === 'sso') return session.providerId !== null && desk.providers.includes(session.providerId);
  if (session.method === 'passkey') return desk.passkey === true;
  return session.method === 'password' ? desk.password : desk.link;
}

/** Whether they may answer it: their own, one they're copied on (D57), or one their group shares to comment on (D56). */
export function requesterMayComment(request: RequestSharing, viewer: { id: string }, groups: ReadonlyMap<string, 'none' | 'read' | 'comment'>, copied = false): boolean {
  if (request.requesterId === viewer.id || copied) return true;
  return requesterSees(request, viewer, groups) && groups.get(request.groupId!) === 'comment';
}

// ---------------------------------------------------------------------------
// Private fields (D50)
// ---------------------------------------------------------------------------

/**
 * Whom a private field is kept from: a person's view, or null for everyone at once (a chat channel's
 * people, a webhook's receiver, what triage tells Claude), who read no private field.
 */
export type FieldReader = AccessView | null;

/**
 * A person's grant as an app acting for them holds it (D48): without the private fields. An app is
 * granted issues, not what a project's managers keep to some people; its own agent never had them.
 */
function withoutPrivateFields(g: Grant): Grant {
  return { ...g, permissions: new Set([...g.permissions].filter((p) => p !== 'readPrivate' && p !== 'editPrivate')) };
}

/** Whether they read a project's private fields: their values, and the changes to them. */
export function readsPrivateIn(view: FieldReader, projectId: string): boolean {
  return Boolean(view?.allows(projectId, 'readPrivate'));
}

/** A project's private fields, by id. */
export function privateFieldIds(s: SchemaSnapshot, projectId: string): Set<string> {
  return new Set((s.projectFields.get(projectId) ?? []).filter((pf) => pf.private).map((pf) => pf.fieldId));
}

const hiddenMemo = new WeakMap<SchemaSnapshot, { everyone?: Map<string, Set<string>>; views: WeakMap<AccessView, Map<string, Set<string>>> }>();

/**
 * The fields kept from them, by project: each project's private fields, where they may not read
 * them. Empty for whoever reads every private field they can reach, and wherever none is private.
 */
export function hiddenFields(view: FieldReader, s: SchemaSnapshot): Map<string, Set<string>> {
  let memo = hiddenMemo.get(s);
  if (!memo) hiddenMemo.set(s, (memo = { views: new WeakMap() }));
  const hit = view ? memo.views.get(view) : memo.everyone;
  if (hit) return hit;
  const out = new Map<string, Set<string>>();
  for (const [projectId, pfs] of s.projectFields) {
    if (!pfs.some((pf) => pf.private) || readsPrivateIn(view, projectId)) continue;
    out.set(projectId, privateFieldIds(s, projectId));
  }
  if (view) memo.views.set(view, out);
  else memo.everyone = out;
  return out;
}

/** Whether they see a field's values on the issues of a project. */
export function seesField(view: FieldReader, s: SchemaSnapshot, projectId: string, fieldId: string): boolean {
  return !hiddenFields(view, s).get(projectId)?.has(fieldId);
}

/** The projects whose issues keep a field's values from them; none, mostly. */
export function projectsHiding(view: FieldReader, s: SchemaSnapshot, fieldId: string): string[] {
  return [...hiddenFields(view, s)].filter(([, ids]) => ids.has(fieldId)).map(([projectId]) => projectId);
}

/**
 * SQL over an `issues` row (as `alias`): whether they see this field's values on it. Undefined where
 * it's kept from them nowhere, which costs nothing. Searches, sorts, counts and reports add it to every
 * read of the field's values, so an issue whose value is kept from them reads as having none.
 */
export function fieldSeenSql(view: FieldReader, s: SchemaSnapshot, fieldId: string, alias = 'issues'): SQL | undefined {
  const hiding = projectsHiding(view, s, fieldId);
  return hiding.length ? sql`${ident(alias)}.project_id NOT IN (${list(hiding)})` : undefined;
}

const fieldScoped = new WeakMap<SchemaSnapshot, WeakMap<AccessView, SchemaSnapshot>>();

/**
 * The reference data without the fields they may not see (D50). A field private in a project leaves
 * that project's fields; one kept from them in every project of theirs that has it leaves everything,
 * values and all, so the query and command languages, completion and prompts answer it as they answer
 * a field that doesn't exist. `visibleSchema` gives this; pass a view, or null for everyone.
 */
export function scopeFields(s: SchemaSnapshot, view: FieldReader): SchemaSnapshot {
  const hidden = hiddenFields(view, s);
  if (!hidden.size) return s;
  const cached = view ? fieldScoped.get(s)?.get(view) : undefined;
  if (cached) return cached;
  const seen = new Set<string>();
  for (const [projectId, pfs] of s.projectFields) for (const pf of pfs) if (!hidden.get(projectId)?.has(pf.fieldId)) seen.add(pf.fieldId);
  const gone = new Set<string>();
  for (const ids of hidden.values()) for (const id of ids) if (!seen.has(id)) gone.add(id);
  // A value a project keeps for itself goes with the field there, too: its name is one of its values.
  const keptValue = (v: { fieldId: string; projectId: string | null }) => gone.has(v.fieldId) || Boolean(v.projectId && hidden.get(v.projectId)?.has(v.fieldId));
  const out: SchemaSnapshot = {
    ...s,
    fields: new Map([...s.fields].filter(([id]) => !gone.has(id))),
    fieldsByName: new Map([...s.fieldsByName].filter(([, f]) => !gone.has(f.id))),
    values: new Map([...s.values].filter(([, v]) => !keptValue(v))),
    valuesByField: new Map([...s.valuesByField].filter(([id]) => !gone.has(id)).map(([id, list]) => [id, list.filter((v) => !keptValue(v))])),
    projectFields: new Map([...s.projectFields].map(([projectId, pfs]) => [projectId, hidden.has(projectId) ? pfs.filter((pf) => !hidden.get(projectId)!.has(pf.fieldId)) : pfs])),
  };
  if (view) {
    let byView = fieldScoped.get(s);
    if (!byView) fieldScoped.set(s, (byView = new WeakMap()));
    byView.set(view, out);
  }
  return out;
}

/** The names a project's hidden fields go by in history, lower-cased: their names, and the ones they had. */
function hiddenNames(s: SchemaSnapshot, ids: ReadonlySet<string> | undefined): Set<string> {
  const out = new Set<string>();
  for (const id of ids ?? []) {
    const f = s.fields.get(id);
    if (!f) continue;
    out.add(f.name.toLowerCase());
    for (const n of f.formerNames ?? []) out.add(n.toLowerCase());
  }
  return out;
}

/**
 * An event as they may read it (D50): changes to fields kept from them taken out, and the values a new
 * issue started with. Null for a change to nothing else, which isn't shown at all. A move also keeps
 * back what the project it left kept from them.
 */
export function eventFor(view: FieldReader, s: SchemaSnapshot, e: TrackerEvent): TrackerEvent | null {
  // Who is copied on a request is people outside the team, by their addresses (D57): a guest isn't
  // told, as they aren't told who asked.
  if (view?.guest && (e.type === 'request.cc_added' || e.type === 'request.cc_removed')) return null;
  e = whiteboardOriginFor(view, s, e);
  const p = e.project ? s.projectsByKey.get(e.project.toUpperCase()) : undefined;
  if (!p) return e;
  const hidden = hiddenFields(view, s);
  const names = hiddenNames(s, hidden.get(p.id));
  if (e.type === 'issue.moved') {
    const from = s.projectsByKey.get(String((e.data as { fromProject?: unknown }).fromProject ?? '').toUpperCase());
    if (from) for (const n of hiddenNames(s, hidden.get(from.id))) names.add(n);
  }
  if (!names.size) return e;
  const kept = (name: unknown) => typeof name !== 'string' || !names.has(name.toLowerCase());
  const changes = e.changes.filter((c) => kept(c.field));
  if (e.type === 'issue.updated' && e.changes.length && !changes.length) return null;
  let data = e.data;
  if (e.type === 'issue.created') {
    const d = e.data as { fields?: Record<string, unknown>; explicitFields?: unknown };
    data = {
      ...e.data,
      ...(d.fields && typeof d.fields === 'object' ? { fields: Object.fromEntries(Object.entries(d.fields).filter(([name]) => kept(name))) } : {}),
      ...(Array.isArray(d.explicitFields) ? { explicitFields: d.explicitFields.filter(kept) } : {}),
    };
  }
  return changes.length === e.changes.length && data === e.data ? e : { ...e, changes, data };
}

/**
 * Where an issue or a link came from, and what a whiteboard made (D58), as the reader may know it: a
 * note may become an issue in another project than its whiteboard's, so a reader of the issue who
 * can't read the whiteboard's project isn't told its name; and of what a whiteboard made, its readers
 * are told only the issues in projects they read. Webhooks (no reader) hear it all, as they hear every
 * project.
 */
function whiteboardOriginFor(view: FieldReader, s: SchemaSnapshot, e: TrackerEvent): TrackerEvent {
  if (!view) return e;
  const d = e.data as { whiteboard?: { id?: unknown; project?: unknown }; issues?: unknown; links?: unknown };
  if (e.type === 'whiteboard.converted') {
    const seen = (id: unknown) => canReadIssueId(view, s, id);
    const issues = Array.isArray(d.issues) ? d.issues.filter(seen) : d.issues;
    const links = Array.isArray(d.links) ? d.links.filter((l: { from?: unknown; to?: unknown } | null) => seen(l?.from) && seen(l?.to)) : d.links;
    return { ...e, data: { ...e.data, issues, links } };
  }
  const wb = d.whiteboard;
  if (!wb || typeof wb !== 'object' || typeof wb.project !== 'string') return e;
  const p = s.projectsByKey.get(wb.project.toUpperCase());
  if (p && view.canRead(p.id)) return e;
  return { ...e, data: { ...e.data, whiteboard: { id: wb.id } } };
}

/**
 * The same as SQL over `activities`, for what a feed leaves out whole: a change to an issue that was
 * all to fields kept from them. What's left of a change that did more is `eventFor`'s to trim.
 */
export function eventsFieldsSql(view: FieldReader, s: SchemaSnapshot): SQL | undefined {
  const parts: SQL[] = [];
  for (const [projectId, ids] of hiddenFields(view, s)) {
    const names = [...hiddenNames(s, ids)];
    if (!names.length) continue;
    parts.push(
      sql`NOT (${activities.projectId} = ${projectId} AND ${activities.type} = 'issue.updated' AND jsonb_typeof(${activities.payload}->'changes') = 'array' AND jsonb_array_length(${activities.payload}->'changes') > 0 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${activities.payload}->'changes') seen_fc WHERE lower(seen_fc->>'field') NOT IN (${list(names)})))`,
    );
  }
  return parts.length ? sql`(${sql.join(parts, sql` AND `)})` : undefined;
}

/**
 * SQL over rows that keep changes as a JSON array beside a project (a rule's runs): leaves out a row
 * with any change to a field kept from them, since what else it says words that change too.
 */
export function touchesNoHiddenSql(view: FieldReader, s: SchemaSnapshot, projectId: SQL, changes: SQL): SQL | undefined {
  const parts: SQL[] = [];
  for (const [id, ids] of hiddenFields(view, s)) {
    const names = [...hiddenNames(s, ids)];
    if (names.length) {
      parts.push(sql`NOT (${projectId} = ${id} AND jsonb_typeof(${changes}) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(${changes}) seen_rc WHERE lower(seen_rc->>'field') IN (${list(names)})))`);
    }
  }
  return parts.length ? sql`(${sql.join(parts, sql` AND `)})` : undefined;
}

/** Of a project's changes, those everyone who reads it may see: none to a private field. For words kept where all of them read. */
export function publicChanges<C extends { field: string }>(s: SchemaSnapshot, projectId: string, changes: readonly C[]): C[] {
  const names = hiddenNames(s, privateFieldIds(s, projectId));
  return changes.filter((c) => !names.has(c.field.toLowerCase()));
}

/** Of these people, those who read a project's private fields, as each would signing in. */
export async function whoReadsPrivate(db: Db, projectId: string, userIds: readonly string[]): Promise<Set<string>> {
  const grants = await projectGrantsOf(db, projectId, [...userIds]);
  return new Set([...grants].filter(([, g]) => g.permissions.has('readPrivate')).map(([id]) => id));
}

/**
 * The caller may set these fields on an issue of the project. One private there that they may not read
 * answers as a field the project doesn't have (`unknown`'s words); one they read but may not change is
 * 403, saying which permission it takes.
 */
export async function assertCanSetFields(ctx: Ctx, projectId: string, fieldIds: readonly string[], unknown: (fieldId: string) => Error, db?: Db): Promise<void> {
  const s = await ctx.app.schema.get(db);
  const own = privateFieldIds(s, projectId);
  const touched = fieldIds.filter((id) => own.has(id));
  if (!touched.length) return;
  const view = await projectAccess(ctx, db);
  const hidden = touched.find((id) => !seesField(view, s, projectId, id));
  if (hidden) throw unknown(hidden);
  await assertCanProject(ctx, projectId, 'editPrivate', db);
}

// ---------------------------------------------------------------------------
// Who sees an article that is limited (D51)
// ---------------------------------------------------------------------------

/** An article's own limit, and where it sits: what deciding who sees it needs. */
export type ArticleLimits = Limits & { id: string; projectId: string; parentId: string | null; createdById: string | null };

/**
 * Whether the viewer sees an article as far as its own limit goes, leaving the articles above it
 * aside: its author, the people and groups named, the project's managers and administrators.
 */
export function seesArticleItself(view: AccessView, row: Limits & { projectId: string; createdById: string | null }): boolean {
  if (!row.limited || view.seesAllIn(row.projectId)) return true;
  if (view.guest || !view.userId) return false;
  return row.createdById === view.userId || listedIn(view, row);
}

/** `seesArticleItself` as SQL over an `articles` row. */
function articleItselfSeenSql(view: AccessView, alias: string): SQL {
  const a = ident(alias);
  const parts: SQL[] = [sql`NOT ${a}.limited`];
  const managed = view.managedIds();
  if (managed.length) parts.push(sql`${a}.project_id IN (${list(managed)})`);
  if (!view.guest && view.userId) {
    parts.push(sql`${a}.created_by_id = ${view.userId}`, sql`${view.userId} = ANY(${a}.visible_user_ids)`);
    if (view.groupIds.length) parts.push(sql`${a}.visible_group_ids && ARRAY[${list(view.groupIds)}]::text[]`);
  }
  return sql`(${sql.join(parts, sql` OR `)})`;
}

/**
 * A subquery of the ids of the articles limited away from the viewer, and of every article under
 * one: from the few that are limited, down the tree. It names nothing outside, so it runs once.
 */
function unseenArticlesSql(view: AccessView): SQL {
  return sql`WITH RECURSIVE unseen_a (id, project_id) AS (
      SELECT ua.id, ua.project_id FROM articles ua WHERE ua.limited AND NOT ${articleItselfSeenSql(view, 'ua')}
      UNION
      SELECT uc.id, uc.project_id FROM articles uc JOIN unseen_a ON uc.project_id = unseen_a.project_id AND uc.parent_id = unseen_a.id
    ) SELECT id FROM unseen_a`;
}

/**
 * SQL over an `articles` row (as `alias`): whether the viewer sees it, as far as limits go: neither
 * it nor any article above it is limited away from them (the project is checked apart). Undefined
 * when they see every article they can reach.
 */
export function articleSeenSql(view: AccessView, alias = 'articles'): SQL | undefined {
  if (view.admin) return undefined;
  return sql`${ident(alias)}.id NOT IN (${unseenArticlesSql(view)})`;
}

/** An article and every article above it, itself first, with their limits: one query. */
export async function articleChain(db: Db, articleId: string): Promise<ArticleLimits[]> {
  const res = await db.execute(sql`
    WITH RECURSIVE up AS (
      SELECT a.id, a.project_id, a.parent_id, a.created_by_id, a.limited, a.visible_user_ids, a.visible_group_ids, 0 AS depth FROM articles a WHERE a.id = ${articleId}
      UNION ALL
      SELECT a.id, a.project_id, a.parent_id, a.created_by_id, a.limited, a.visible_user_ids, a.visible_group_ids, up.depth + 1
      FROM articles a JOIN up ON a.id = up.parent_id WHERE up.depth < 200
    )
    SELECT id, project_id AS "projectId", parent_id AS "parentId", created_by_id AS "createdById", limited,
      visible_user_ids AS "visibleUserIds", visible_group_ids AS "visibleGroupIds"
    FROM up ORDER BY depth
  `);
  return (res as unknown as { rows: ArticleLimits[] }).rows;
}

/**
 * Whether the viewer sees an article in a project they read: neither it nor any article above it
 * is limited away from them (D51). A sub-article is never seen by someone who can't see its parent.
 */
export async function seesArticleRow(view: AccessView, db: Db, row: ArticleLimits): Promise<boolean> {
  if (view.seesAllIn(row.projectId)) return true;
  if (!seesArticleItself(view, row)) return false;
  if (!row.parentId) return true;
  return (await articleChain(db, row.parentId)).every((a) => seesArticleItself(view, a));
}

/** Of these article ids, the ones the caller sees: in a project they read, and not limited away from them (D51). */
export async function seenArticleIds(ctx: Ctx, ids: readonly string[], db: Db = ctx.db): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Set();
  const view = await projectAccess(ctx, db);
  const seen = articleSeenSql(view, 'articles');
  const res = await db.execute(sql`SELECT articles.id, articles.project_id AS "projectId" FROM articles WHERE articles.id IN (${list(unique)})${seen ? sql` AND ${seen}` : sql``}`);
  const rows = (res as unknown as { rows: { id: string; projectId: string }[] }).rows;
  return new Set(rows.filter((r) => view.canRead(r.projectId)).map((r) => r.id));
}

/**
 * Of these people, those who see an article, as each would signing in: they reach its project, and
 * neither it nor any article above it is limited away from them (D51). For whom to tell of it.
 */
export async function whoSeesArticle(db: Db, articleId: string, userIds: readonly string[]): Promise<Set<string>> {
  const chain = await articleChain(db, articleId);
  if (!chain.length) return new Set();
  const grants = await projectGrantsOf(db, chain[0]!.projectId, [...userIds]);
  const limited = chain.filter((a) => a.limited);
  const out = new Set<string>();
  const rest: string[] = [];
  for (const [id, g] of grants) {
    if (!limited.length || g.permissions.has('manage')) out.add(id);
    else rest.push(id);
  }
  if (!rest.length) return out;
  const groupIds = [...new Set(limited.flatMap((a) => a.visibleGroupIds))];
  const theirs = new Map<string, string[]>();
  if (groupIds.length) {
    const rows = await db
      .select({ userId: groupMembers.userId, groupId: groupMembers.groupId })
      .from(groupMembers)
      .where(and(inArray(groupMembers.userId, rest), inArray(groupMembers.groupId, groupIds)));
    for (const r of rows) theirs.set(r.userId, [...(theirs.get(r.userId) ?? []), r.groupId]);
  }
  for (const id of rest) {
    const groups = theirs.get(id) ?? [];
    if (limited.every((a) => a.createdById === id || a.visibleUserIds.includes(id) || a.visibleGroupIds.some((g) => groups.includes(g)))) out.add(id);
  }
  return out;
}

/** 3 for an event about BACK-A-3: its own events, and its files' (`data.article`). Null for any other event. */
function articleNumberOf(e: Pick<TrackerEvent, 'data'>): number | null {
  const id = (e.data as { article?: { id?: unknown } } | undefined)?.article?.id;
  const m = typeof id === 'string' ? /-A-(\d+)$/i.exec(id.trim()) : null;
  return m ? Number(m[1]) : null;
}

type ArticleFacts = { chain: ArticleLimits[] | null; goneLimited: boolean };
/** An article event's article and those above it, kept a moment as an issue event's facts are (D37). */
const articleFactsCache = new Map<number, { at: number; facts: Promise<ArticleFacts> }>();

function articleFacts(db: Db, projectId: string, number: number, eventId: number, fresh = false): Promise<ArticleFacts> {
  const hit = articleFactsCache.get(eventId);
  if (!fresh && hit && Date.now() - hit.at < 10_000) return hit.facts;
  const facts = (async (): Promise<ArticleFacts> => {
    const res = await db.execute(sql`SELECT id FROM articles WHERE project_id = ${projectId} AND number = ${number}`);
    const id = (res as unknown as { rows: { id: string }[] }).rows[0]?.id;
    if (id) return { chain: await articleChain(db, id), goneLimited: false };
    // Gone: hidden still if it was limited when it was deleted, or sat under an article that was.
    const gone = await db.execute(sql`
      SELECT 1 AS found FROM activities g
      WHERE g.type = 'article.deleted' AND g.payload->'data'->>'limited' = 'true' AND g.project_id = ${projectId}
        AND split_part(g.payload->'data'->'article'->>'id', '-', 3) = ${String(number)}
      LIMIT 1
    `);
    return { chain: null, goneLimited: (gone as unknown as { rows: unknown[] }).rows.length > 0 };
  })();
  if (articleFactsCache.size > 2000) articleFactsCache.clear();
  articleFactsCache.set(eventId, { at: Date.now(), facts });
  return facts;
}

/**
 * Whether the viewer sees an event about an article (its own, or its files'): neither it nor an
 * article above it is limited away from them, and, gone, it wasn't limited when it went (D51).
 * Any other event passes.
 */
export async function articleEventSeen(
  view: AccessView,
  db: Db,
  s: SchemaSnapshot,
  e: Pick<TrackerEvent, 'id' | 'project' | 'data'>,
  opts: { fresh?: boolean } = {},
): Promise<boolean> {
  const number = articleNumberOf(e);
  if (number === null || view.admin) return true;
  const p = e.project ? s.projectsByKey.get(e.project.toUpperCase()) : undefined;
  // An article's event outlives its project only for administrators.
  if (!p) return false;
  if (view.seesAllIn(p.id)) return true;
  const { chain, goneLimited } = await articleFacts(db, p.id, number, e.id, opts.fresh);
  if (!chain) return !goneLimited && (e.data as { limited?: unknown } | undefined)?.limited !== true;
  return chain.every((a) => seesArticleItself(view, a));
}

/** Whether an event is about an article that is limited, or sits under one, or was when it was deleted (D51). */
export async function articleEventLimited(db: Db, s: SchemaSnapshot, e: Pick<TrackerEvent, 'id' | 'project' | 'data'>): Promise<boolean> {
  const number = articleNumberOf(e);
  if (number === null) return false;
  const p = e.project ? s.projectsByKey.get(e.project.toUpperCase()) : undefined;
  if (!p) return true;
  const { chain, goneLimited } = await articleFacts(db, p.id, number, e.id);
  return chain ? chain.some((a) => a.limited) : goneLimited || (e.data as { limited?: unknown } | undefined)?.limited === true;
}

/** `articleEventSeen` as SQL over `activities`, so a feed's pages and its cursor stay whole. */
export function articleEventsSeenSql(view: AccessView): SQL | undefined {
  if (view.admin) return undefined;
  const ref = sql`(${activities.payload}->'data'->'article'->>'id')`;
  const number = sql`split_part(${ref}, '-', 3)`;
  const managed = view.managedIds();
  const inManaged = managed.length ? sql`${activities.projectId} IN (${list(managed)})` : sql`FALSE`;
  return sql`(${ref} IS NULL OR ${inManaged} OR (${activities.projectId} IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM articles seen_ea WHERE seen_ea.project_id = ${activities.projectId} AND seen_ea.number::text = ${number} AND seen_ea.id IN (${unseenArticlesSql(view)}))
    AND NOT EXISTS (SELECT 1 FROM activities seen_gone WHERE seen_gone.type = 'article.deleted' AND seen_gone.payload->'data'->>'limited' = 'true'
      AND seen_gone.project_id = ${activities.projectId} AND split_part(seen_gone.payload->'data'->'article'->>'id', '-', 3) = ${number})))`;
}

const ARTICLE_ID = /\b([A-Za-z][A-Za-z0-9]*)-A-(\d+)\b/gi;

/**
 * Words an agent wrote, with the ids of articles the caller can't see taken out (D51), as
 * `redactUnseenIds` takes out issues': in a project they can't read, or limited away from them;
 * said in the caller's language (D49).
 */
export async function redactUnseenArticleIds(ctx: Ctx, text: string): Promise<string> {
  const named = [...new Set([...text.matchAll(ARTICLE_ID)].map((m) => m[0].toUpperCase()))];
  if (!named.length) return text;
  const [view, s] = [await projectAccess(ctx), await ctx.app.schema.get()];
  const hidden = new Set<string>();
  const found: { readable: string; id: string }[] = [];
  for (const readable of named) {
    const [key, , number] = readable.split('-');
    const p = s.projectsByKey.get(key!);
    if (!p) continue;
    if (!view.canRead(p.id)) {
      hidden.add(readable);
      continue;
    }
    const res = await ctx.db.execute(sql`SELECT id FROM articles WHERE project_id = ${p.id} AND number = ${Number(number)}`);
    const id = (res as unknown as { rows: { id: string }[] }).rows[0]?.id;
    if (id) found.push({ readable, id });
  }
  const seen = await seenArticleIds(ctx, found.map((f) => f.id));
  for (const f of found) if (!seen.has(f.id)) hidden.add(f.readable);
  if (!hidden.size) return text;
  const said = translatorFor(ctx.locale).t('server.access.articleYouCantSee');
  return text.replace(ARTICLE_ID, (id) => (hidden.has(id.toUpperCase()) ? said : id));
}

// ---------------------------------------------------------------------------
// What stays hidden once a limited issue is deleted (D37)
// ---------------------------------------------------------------------------

/**
 * What an issue's deletion keeps beside its event, so that what was limited stays hidden once the
 * rows that said so are gone: if the issue was limited, every id it had (its own, and those from
 * before it moved, D41, each under every key its project has had, D52); and its comments that were
 * limited, deleted ones too. It goes in the deletion's payload, and never into an event a reader
 * gets. Read in the deleting transaction, before the issue goes.
 */
export interface GoneLimits {
  ids?: string[];
  comments?: string[];
}

export async function goneLimitsOf(db: Db, s: SchemaSnapshot, issue: { id: string; projectId: string; number: number; limited: boolean }): Promise<GoneLimits | undefined> {
  const limitedComments = await db.select({ id: comments.id }).from(comments).where(and(eq(comments.issueId, issue.id), eq(comments.limited, true)));
  let ids: string[] = [];
  if (issue.limited) {
    const before = await db.select({ projectId: issueAliases.projectId, number: issueAliases.number }).from(issueAliases).where(eq(issueAliases.issueId, issue.id));
    ids = [...new Set([issue, ...before].flatMap((at) => keysOfProject(s, at.projectId).map((k) => `${k.toUpperCase()}-${at.number}`)))];
  }
  if (!ids.length && !limitedComments.length) return undefined;
  return { ...(ids.length ? { ids } : {}), ...(limitedComments.length ? { comments: limitedComments.map((c) => c.id) } : {}) };
}

/** The deletions that hide something from the viewer: all of them, but those in a project they see all of. */
function goneDeletionsSql(view: AccessView): SQL {
  const managed = view.managedIds();
  return managed.length ? sql`gone.type = 'issue.deleted' AND (gone.project_id IS NULL OR gone.project_id NOT IN (${list(managed)}))` : sql`gone.type = 'issue.deleted'`;
}
const GONE_LIMITED = sql`gone.payload->'data'->>'limited' = 'true'`;

/** Every id, in upper case, of an issue deleted while limited: those its deletion kept, or, deleted before they were kept, the one it had. */
function goneIdsSql(view: AccessView): SQL {
  return sql`SELECT upper(gone_id) FROM activities gone, jsonb_array_elements_text(coalesce(gone.payload->'gone'->'ids', '[]'::jsonb)) gone_id WHERE ${goneDeletionsSql(view)} AND ${GONE_LIMITED}
    UNION SELECT upper(gone.payload->'issue'->>'id') FROM activities gone WHERE ${goneDeletionsSql(view)} AND ${GONE_LIMITED} AND gone.payload->'issue'->>'id' IS NOT NULL`;
}

/** Where each such issue was when it was deleted, as its project and number, so an event that names it by an older key still finds it (D52). */
function gonePlacesSql(view: AccessView): SQL {
  return sql`SELECT gone.project_id || ':' || split_part(gone.payload->'issue'->>'id', '-', 2) FROM activities gone
    WHERE ${goneDeletionsSql(view)} AND ${GONE_LIMITED} AND gone.project_id IS NOT NULL AND gone.payload->'issue'->>'id' IS NOT NULL`;
}

/** The comments that were limited on issues deleted since. */
function goneCommentsSql(view: AccessView): SQL {
  return sql`SELECT gone_c FROM activities gone, jsonb_array_elements_text(coalesce(gone.payload->'gone'->'comments', '[]'::jsonb)) gone_c WHERE ${goneDeletionsSql(view)}`;
}

/**
 * SQL over an issue as a row names it, by a readable id and the project it was in (an event's, a
 * notification's): whether it was deleted while it was limited, and the viewer doesn't see all of
 * its project. Undefined for an administrator.
 */
export function goneIssueSql(view: AccessView, readable: SQL, projectId: SQL): SQL | undefined {
  if (view.admin) return undefined;
  return sql`(coalesce(upper(${readable}) IN (${goneIdsSql(view)}), FALSE) OR coalesce((${projectId} || ':' || split_part(${readable}, '-', 2)) IN (${gonePlacesSql(view)}), FALSE))`;
}

/**
 * SQL over `activities`: an event of an issue deleted while it was limited, a link that names one,
 * and an event of a comment limited on an issue deleted since, are left out for anyone who doesn't
 * see all of its project, as the deletion itself is. Undefined for an administrator.
 */
export function goneEventsSql(view: AccessView): SQL | undefined {
  const p = activities.payload;
  const own = goneIssueSql(view, sql`${p}->'issue'->>'id'`, sql`${activities.projectId}`);
  if (!own) return undefined;
  return sql`NOT (
    (${activities.issueId} IS NULL AND ${p}->'issue'->>'id' IS NOT NULL AND ${own})
    OR (${activities.type} IN ('link.created', 'link.deleted') AND coalesce(upper(${p}->'data'->'target'->>'id') IN (${goneIdsSql(view)}), FALSE))
    OR (${p}->'data'->>'commentId' IS NOT NULL AND coalesce(${p}->'data'->>'commentId' IN (${goneCommentsSql(view)}), FALSE)))`;
}

/** The deletions that hide an event, by the project each was in: kept a moment, as an event's facts are. */
const goneCache = new Map<number, { at: number; hits: Promise<(string | null)[]> }>();

function goneHitsOf(db: Db, s: SchemaSnapshot, e: Pick<TrackerEvent, 'id' | 'type' | 'project' | 'issue' | 'data'>, fresh = false): Promise<(string | null)[]> {
  const cached = goneCache.get(e.id);
  if (!fresh && cached && Date.now() - cached.at < 10_000) return cached.hits;
  const hits = (async () => {
    const data = (e.data ?? {}) as { commentId?: unknown; target?: { id?: unknown } };
    const targetId = LINK_EVENTS.includes(e.type) && typeof data.target?.id === 'string' ? data.target.id : null;
    const commentId = typeof data.commentId === 'string' ? data.commentId : null;
    if (!e.issue && !targetId && !commentId) return [];
    // Only what's gone can have been deleted while limited: a row that stands answers for itself.
    const facts = await eventFacts(db, s, e, fresh);
    const rid = e.issue && !facts.issue ? e.issue.id.toUpperCase() : null;
    const target = targetId && !facts.target ? targetId.toUpperCase() : null;
    const comment = commentId && !facts.comment ? commentId : null;
    if (!rid && !target && !comment) return [];
    const named = (id: string) => sql`(gone.payload->'gone'->'ids' @> jsonb_build_array(${id}::text) OR upper(gone.payload->'issue'->>'id') = ${id})`;
    const project = e.project ? s.projectsByKey.get(e.project.toUpperCase()) : undefined;
    const arms: SQL[] = [];
    if (rid) arms.push(named(rid));
    if (rid && project) arms.push(sql`(gone.project_id = ${project.id} AND split_part(gone.payload->'issue'->>'id', '-', 2) = ${rid.slice(rid.lastIndexOf('-') + 1)})`);
    if (target) arms.push(named(target));
    const limited = arms.length ? sql`(${GONE_LIMITED} AND (${sql.join(arms, sql` OR `)}))` : sql`FALSE`;
    const res = await db.execute(sql`
      SELECT gone.project_id AS "projectId" FROM activities gone
      WHERE gone.type = 'issue.deleted' AND (${limited}${comment ? sql` OR gone.payload->'gone'->'comments' @> jsonb_build_array(${comment}::text)` : sql``})
    `);
    return (res as unknown as { rows: { projectId: string | null }[] }).rows.map((r) => r.projectId);
  })();
  if (goneCache.size > 2000) goneCache.clear();
  goneCache.set(e.id, { at: Date.now(), hits });
  return hits;
}

/** Whether the viewer sees an event as far as deleted issues go: none deleted while limited hides it, but in a project they see all of. */
export async function goneEventSeen(view: AccessView, db: Db, s: SchemaSnapshot, e: Pick<TrackerEvent, 'id' | 'type' | 'project' | 'issue' | 'data'>, opts: { fresh?: boolean } = {}): Promise<boolean> {
  if (view.admin) return true;
  return (await goneHitsOf(db, s, e, opts.fresh)).every((projectId) => projectId !== null && view.seesAllIn(projectId));
}

/** Whether an event is of an issue deleted while limited, names one, or is of a comment limited on one deleted since: webhooks carry none. */
export async function goneEventLimited(db: Db, s: SchemaSnapshot, e: Pick<TrackerEvent, 'id' | 'type' | 'project' | 'issue' | 'data'>): Promise<boolean> {
  return (await goneHitsOf(db, s, e)).length > 0;
}
