/**
 * Groups of people (docs/architecture.md, D27). A project gives a group a role as it gives one to a
 * person, and everyone in the group has at least that role there: services/access.ts reads it.
 *
 * - Administrators make groups and say who is in them. Anyone signed in may see groups and who is
 *   in them, as they may see people.
 * - A group with a `providerName` comes from the identity provider: who is in it is set at each
 *   sign-in, from the groups the provider says the person is in, and never by hand. Groups kept by
 *   hand are never touched by a sign-in, whatever they're called.
 * - A project's managers give groups roles in it, as they give people roles; each change is in the
 *   project's history (`project.group.*`).
 */
import type { Group, GroupDetail, GroupMember, GroupRef, ProjectGroup, ProjectRole } from '@a4a/shared';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { requireScope, type AppServices, type Ctx } from '../context';
import type { Db } from '../db/client';
import { groupMembers, groups, projectGroupRoles } from '../db/schema';
import { publishActivities, recordActivity, type ActivityRow } from '../events/activity';
import { badRequest, conflict, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { accessChanged, isProjectRole, projectAccess, requireProject } from './access';
import { findUser, type ProjectRow, type SchemaSnapshot, type UserRow } from './schema-cache';
import { userRefDto } from './values';

type GroupRow = typeof groups.$inferSelect;

const ROLE_WORDS = 'Use viewer, member or manager.';

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function sizes(db: Db, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await db.select({ groupId: groupMembers.groupId, n: count() }).from(groupMembers).where(inArray(groupMembers.groupId, ids)).groupBy(groupMembers.groupId);
  return new Map(rows.map((r) => [r.groupId, Number(r.n)]));
}

function refDto(g: GroupRow, size: number): GroupRef {
  return { id: g.id, name: g.name, providerName: g.providerName, size };
}

/** A group by its id or its name (any case). */
async function findGroup(db: Db, ref: string): Promise<GroupRow | undefined> {
  const v = ref.trim();
  const [byId] = await db.select().from(groups).where(eq(groups.id, v));
  if (byId) return byId;
  const [byName] = await db.select().from(groups).where(sql`lower(${groups.name}) = ${v.toLowerCase()}`);
  return byName;
}

async function requireGroup(db: Db, ref: string): Promise<GroupRow> {
  const g = await findGroup(db, ref);
  if (!g) throw notFound(`Group ${ref}`, 'Use its id or its name, as in GET /groups.');
  return g;
}

/** The projects the caller can see that give each group a role. */
async function visibleRoles(ctx: Ctx, groupIds: string[]): Promise<(typeof projectGroupRoles.$inferSelect)[]> {
  if (!groupIds.length) return [];
  const view = await projectAccess(ctx);
  const rows = await ctx.db.select().from(projectGroupRoles).where(inArray(projectGroupRoles.groupId, groupIds));
  return rows.filter((r) => view.canRead(r.projectId));
}

export async function listGroups(ctx: Ctx): Promise<Group[]> {
  requireScope(ctx, 'read');
  const rows = await ctx.db.select().from(groups).orderBy(sql`lower(${groups.name})`);
  const ids = rows.map((g) => g.id);
  const [n, roles] = await Promise.all([sizes(ctx.db, ids), visibleRoles(ctx, ids)]);
  return rows.map((g) => ({
    ...refDto(g, n.get(g.id) ?? 0),
    description: g.description,
    createdAt: g.createdAt.toISOString(),
    projects: roles.filter((r) => r.groupId === g.id).length,
  }));
}

export async function getGroup(ctx: Ctx, ref: string): Promise<GroupDetail> {
  requireScope(ctx, 'read');
  const g = await requireGroup(ctx.db, ref);
  const s = await ctx.app.schema.get();
  const people = await ctx.db.select().from(groupMembers).where(eq(groupMembers.groupId, g.id));
  const members: GroupMember[] = [];
  for (const m of people) {
    const u = s.users.get(m.userId);
    if (!u) continue;
    const by = m.addedById ? s.users.get(m.addedById) : undefined;
    members.push({ user: userRefDto(u), addedAt: m.createdAt.toISOString(), addedBy: by ? userRefDto(by) : null });
  }
  members.sort((a, b) => a.user.name.localeCompare(b.user.name));
  const roles = (await visibleRoles(ctx, [g.id]))
    .map((r) => ({ project: s.projects.get(r.projectId), role: r.role }))
    .filter((r): r is { project: ProjectRow; role: ProjectRole } => Boolean(r.project) && isProjectRole(r.role))
    .map((r) => ({ project: { id: r.project.id, key: r.project.key, name: r.project.name }, role: r.role }))
    .sort((a, b) => a.project.key.localeCompare(b.project.key));
  return {
    ...refDto(g, members.length),
    description: g.description,
    createdAt: g.createdAt.toISOString(),
    projects: roles.length,
    members,
    roles,
  };
}

// ---------------------------------------------------------------------------
// Groups themselves: administrators
// ---------------------------------------------------------------------------

function uniqueViolation(e: unknown): string | null {
  const err = e as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const code = err?.code ?? err?.cause?.code;
  if (code !== '23505') return null;
  return err?.constraint ?? err?.cause?.constraint ?? '';
}

function takenError(e: unknown, input: { name?: string; providerName?: string | null }): never {
  const constraint = uniqueViolation(e);
  if (constraint === null) throw e;
  if (constraint.includes('provider')) {
    throw conflict(`Another group already comes from "${input.providerName}" at the identity provider`, 'One group per name there: change that one, or use another name.');
  }
  throw conflict(`There's already a group called "${input.name}"`, 'Choose another name, or add people to that one.');
}

export async function createGroup(ctx: Ctx, input: { name: string; description?: string; providerName?: string | null }): Promise<GroupDetail> {
  requireScope(ctx, 'admin');
  const id = newId();
  try {
    await ctx.db.insert(groups).values({
      id,
      name: input.name.trim(),
      description: (input.description ?? '').trim(),
      providerName: input.providerName?.trim() || null,
      createdById: ctx.actor.user.id,
    });
  } catch (e) {
    takenError(e, input);
  }
  // A group field names groups from the schema snapshot (D41).
  ctx.app.schema.invalidate();
  return getGroup(ctx, id);
}

export async function updateGroup(ctx: Ctx, ref: string, input: { name?: string; description?: string; providerName?: string | null }): Promise<GroupDetail> {
  requireScope(ctx, 'admin');
  const g = await requireGroup(ctx.db, ref);
  const providerName = input.providerName === undefined ? undefined : input.providerName?.trim() || null;
  // A group that starts coming from the provider, or from another of its groups, empties: whoever
  // was in it was put there by hand, or under the old name, not by what the provider says now.
  const toProvider = providerName !== undefined && providerName !== null && providerName.toLowerCase() !== (g.providerName ?? '').toLowerCase();
  try {
    await ctx.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await tx
        .update(groups)
        .set({
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined ? { description: input.description.trim() } : {}),
          ...(providerName !== undefined ? { providerName } : {}),
          updatedAt: new Date(),
        })
        .where(eq(groups.id, g.id));
      // From now on the provider says who is in it, at each sign-in; nobody stays in it by hand.
      if (toProvider) await tx.delete(groupMembers).where(eq(groupMembers.groupId, g.id));
    });
  } catch (e) {
    takenError(e, { name: input.name ?? g.name, providerName });
  }
  if (toProvider) accessChanged(ctx.app);
  if (input.name !== undefined) ctx.app.schema.invalidate();
  return getGroup(ctx, g.id);
}

export async function deleteGroup(ctx: Ctx, ref: string): Promise<void> {
  requireScope(ctx, 'admin');
  const g = await requireGroup(ctx.db, ref);
  const s = await ctx.app.schema.get();
  const written = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const roles = await tx.delete(projectGroupRoles).where(eq(projectGroupRoles.groupId, g.id)).returning();
    const out: ActivityRow[] = [];
    // Each project it had a role in says so in its history, as when a manager takes it out.
    for (const r of roles) {
      if (!s.projects.has(r.projectId)) continue;
      out.push(await recordActivity(tx, ctx, { type: 'project.group.removed', projectId: r.projectId, issueId: null, payload: { data: { group: g.id, name: g.name, role: r.role, deleted: true } } }));
    }
    await tx.delete(groups).where(eq(groups.id, g.id));
    return out;
  });
  accessChanged(ctx.app);
  ctx.app.schema.invalidate();
  await publishActivities(ctx.app, written);
}

function personFor(s: SchemaSnapshot, login: string): UserRow {
  const u = findUser(s, login);
  if (!u) throw notFound(`User ${login}`, 'Use their login, as in GET /users.');
  return u;
}

function keptByProvider(g: GroupRow): never {
  throw badRequest(
    `Who is in ${g.name} comes from the identity provider`,
    `It's set at each sign-in, from the groups the provider says someone is in (as "${g.providerName}"). Change it there, or make the group one kept by hand: PATCH /groups/${g.id} with providerName null.`,
  );
}

export async function addGroupMember(ctx: Ctx, ref: string, login: string): Promise<GroupDetail> {
  requireScope(ctx, 'admin');
  const g = await requireGroup(ctx.db, ref);
  if (g.providerName) keptByProvider(g);
  const user = personFor(await ctx.app.schema.get(), login);
  const [row] = await ctx.db.insert(groupMembers).values({ groupId: g.id, userId: user.id, addedById: ctx.actor.user.id }).onConflictDoNothing().returning();
  if (!row) throw conflict(`${user.name} is already in ${g.name}`);
  accessChanged(ctx.app);
  return getGroup(ctx, g.id);
}

export async function removeGroupMember(ctx: Ctx, ref: string, login: string): Promise<void> {
  requireScope(ctx, 'admin');
  const g = await requireGroup(ctx.db, ref);
  if (g.providerName) keptByProvider(g);
  const user = personFor(await ctx.app.schema.get(), login);
  const [gone] = await ctx.db.delete(groupMembers).where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.userId, user.id))).returning();
  if (!gone) throw notFound(`${user.login} in ${g.name}`);
  accessChanged(ctx.app);
}

// ---------------------------------------------------------------------------
// Groups from the identity provider
// ---------------------------------------------------------------------------

/**
 * What the provider says someone is in, as a list of names: a claim or an attribute may be one
 * value or several. Anything that isn't text is left out.
 */
export function providerGroupNames(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return [...new Set(list.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim().toLowerCase()))];
}

/**
 * Put someone in exactly the provider's groups of these names, at a sign-in: into those they're
 * missing from, out of those the provider no longer names. Groups kept by hand are left alone, and
 * names a4a has no group for are ignored. Returns whether anything changed.
 */
export async function syncProviderGroups(app: AppServices, userId: string, names: string[]): Promise<boolean> {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const changed = await app.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const fromProvider = await tx.select({ id: groups.id, providerName: groups.providerName }).from(groups).where(sql`${groups.providerName} IS NOT NULL`);
    if (!fromProvider.length) return false;
    const ids = fromProvider.map((g) => g.id);
    const current = new Set(
      (await tx.select({ groupId: groupMembers.groupId }).from(groupMembers).where(and(eq(groupMembers.userId, userId), inArray(groupMembers.groupId, ids)))).map((r) => r.groupId),
    );
    const should = new Set(fromProvider.filter((g) => wanted.has(g.providerName!.toLowerCase())).map((g) => g.id));
    const add = [...should].filter((id) => !current.has(id));
    const remove = [...current].filter((id) => !should.has(id));
    if (add.length) await tx.insert(groupMembers).values(add.map((groupId) => ({ groupId, userId, addedById: null }))).onConflictDoNothing();
    if (remove.length) await tx.delete(groupMembers).where(and(eq(groupMembers.userId, userId), inArray(groupMembers.groupId, remove)));
    return add.length > 0 || remove.length > 0;
  });
  if (changed) accessChanged(app);
  return changed;
}

// ---------------------------------------------------------------------------
// A project's groups: its managers
// ---------------------------------------------------------------------------

export async function listProjectGroups(ctx: Ctx, key: string): Promise<ProjectGroup[]> {
  const project = await requireProject(ctx, key);
  const s = await ctx.app.schema.get();
  const rows = await ctx.db
    .select({ role: projectGroupRoles, group: groups })
    .from(projectGroupRoles)
    .innerJoin(groups, eq(groups.id, projectGroupRoles.groupId))
    .where(eq(projectGroupRoles.projectId, project.id));
  // Who is in each, in one read: anyone who sees a project sees who is in it, through a group too.
  const ids = rows.map((r) => r.group.id);
  const inThem = ids.length ? await ctx.db.select().from(groupMembers).where(inArray(groupMembers.groupId, ids)) : [];
  const order: Record<ProjectRole, number> = { manager: 0, member: 1, viewer: 2 };
  return rows
    .filter((r) => isProjectRole(r.role.role))
    .map((r) => {
      const by = r.role.addedById ? s.users.get(r.role.addedById) : undefined;
      const people = inThem
        .filter((m) => m.groupId === r.group.id)
        .map((m) => s.users.get(m.userId))
        .filter((u): u is UserRow => Boolean(u))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(userRefDto);
      return { group: refDto(r.group, people.length), role: r.role.role as ProjectRole, people, addedAt: r.role.createdAt.toISOString(), addedBy: by ? userRefDto(by) : null };
    })
    .sort((a, b) => order[a.role] - order[b.role] || a.group.name.localeCompare(b.group.name));
}

async function writeProjectGroup(
  ctx: Ctx,
  project: ProjectRow,
  fn: (tx: Db) => Promise<{ type: 'project.group.added' | 'project.group.changed' | 'project.group.removed'; data: Record<string, unknown> }>,
) {
  const activity = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const { type, data } = await fn(tx);
    return recordActivity(tx, ctx, { type, projectId: project.id, issueId: null, payload: { data } });
  });
  accessChanged(ctx.app);
  await publishActivities(ctx.app, [activity]);
}

export async function addProjectGroup(ctx: Ctx, key: string, input: { group: string; role?: ProjectRole }): Promise<ProjectGroup> {
  const project = await requireProject(ctx, key, 'manage');
  const role = input.role ?? 'member';
  if (!isProjectRole(role)) throw badRequest(`Unknown role "${role}"`, ROLE_WORDS);
  const g = await requireGroup(ctx.db, input.group);
  await writeProjectGroup(ctx, project, async (tx) => {
    const [row] = await tx.insert(projectGroupRoles).values({ projectId: project.id, groupId: g.id, role, addedById: ctx.actor.user.id }).onConflictDoNothing().returning();
    if (!row) throw conflict(`${g.name} already has a role in ${project.key}`, `Change its role instead: PATCH /projects/${project.key}/groups/${g.id}.`);
    return { type: 'project.group.added', data: { group: g.id, name: g.name, role } };
  });
  return (await listProjectGroups(ctx, project.key)).find((r) => r.group.id === g.id)!;
}

export async function updateProjectGroup(ctx: Ctx, key: string, ref: string, input: { role: ProjectRole }): Promise<ProjectGroup> {
  const project = await requireProject(ctx, key, 'manage');
  if (!isProjectRole(input.role)) throw badRequest(`Unknown role "${input.role}"`, ROLE_WORDS);
  const g = await requireGroup(ctx.db, ref);
  await writeProjectGroup(ctx, project, async (tx) => {
    const [before] = await tx
      .select()
      .from(projectGroupRoles)
      .where(and(eq(projectGroupRoles.projectId, project.id), eq(projectGroupRoles.groupId, g.id)))
      .for('update');
    if (!before) throw notFound(`${g.name} among ${project.key}'s groups`, `Give it a role first: POST /projects/${project.key}/groups.`);
    await tx.update(projectGroupRoles).set({ role: input.role }).where(and(eq(projectGroupRoles.projectId, project.id), eq(projectGroupRoles.groupId, g.id)));
    return { type: 'project.group.changed', data: { group: g.id, name: g.name, from: before.role, to: input.role } };
  });
  return (await listProjectGroups(ctx, project.key)).find((r) => r.group.id === g.id)!;
}

export async function removeProjectGroup(ctx: Ctx, key: string, ref: string): Promise<void> {
  const project = await requireProject(ctx, key, 'manage');
  const g = await requireGroup(ctx.db, ref);
  await writeProjectGroup(ctx, project, async (tx) => {
    const [gone] = await tx
      .delete(projectGroupRoles)
      .where(and(eq(projectGroupRoles.projectId, project.id), eq(projectGroupRoles.groupId, g.id)))
      .returning();
    if (!gone) throw notFound(`${g.name} among ${project.key}'s groups`);
    return { type: 'project.group.removed', data: { group: g.id, name: g.name, role: gone.role } };
  });
}
