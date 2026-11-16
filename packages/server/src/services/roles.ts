import { BUILTIN_ROLE_NAMES, BUILTIN_ROLE_PERMISSIONS, PERMISSIONS, PROJECT_ROLES, type Permission, type ProjectRole, type RoleDef } from '@a4a/shared';
import { eq, sql } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { projectGroupRoles, projectMembers, roles } from '../db/schema';
import { badRequest, conflict, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { accessChanged, isProjectRole } from './access';

/**
 * Roles as sets of permissions (D37). The built-in viewer, member and manager are three such sets
 * that can be given but not changed; an administrator defines more, and projects give them to
 * people and groups as they give the built-in ones. Every check on what someone may do in a
 * project asks for a permission (services/access.ts), never for a role by name.
 */

const DESCRIPTIONS: Record<ProjectRole, string> = {
  viewer: 'Sees the project and its issues, comments, and sees time and costs.',
  member: 'Also reports, changes and deletes issues, and logs time.',
  manager: "Everything: the project's settings and people too, its boards, and every issue in it, whoever it's limited to.",
};

type RoleRow = typeof roles.$inferSelect;

async function usesOf(db: Db): Promise<Map<string, number>> {
  const [named, viaGroups] = await Promise.all([
    db.select({ role: projectMembers.role, n: sql<number>`count(*)::int` }).from(projectMembers).groupBy(projectMembers.role),
    db.select({ role: projectGroupRoles.role, n: sql<number>`count(*)::int` }).from(projectGroupRoles).groupBy(projectGroupRoles.role),
  ]);
  const out = new Map<string, number>();
  for (const r of [...named, ...viaGroups]) out.set(r.role, (out.get(r.role) ?? 0) + Number(r.n));
  return out;
}

function ordered(perms: Iterable<string>): Permission[] {
  const set = new Set(perms);
  return PERMISSIONS.filter((p) => set.has(p));
}

function checked(perms: readonly Permission[]): Permission[] {
  const list = ordered(perms);
  if (!list.includes('read')) throw badRequest('A role needs the read permission', 'Every other permission works on what its holder can see: add "read".');
  return list;
}

function roleDto(r: RoleRow, uses: Map<string, number>): RoleDef {
  return { id: r.id, name: r.name, description: r.description, permissions: ordered(r.permissions), builtin: false, uses: uses.get(r.id) ?? 0, version: r.version };
}

function takenName(name: string): never {
  throw conflict(`There's already a role called "${name}"`, 'Choose another name, or change that role.');
}

async function assertNameFree(db: Db, name: string, except?: string): Promise<void> {
  const want = name.toLowerCase();
  if (PROJECT_ROLES.some((id) => id === want || BUILTIN_ROLE_NAMES[id].toLowerCase() === want) || want === 'guest') takenName(name);
  const [hit] = await db.select({ id: roles.id }).from(roles).where(sql`lower(${roles.name}) = ${want}`);
  if (hit && hit.id !== except) takenName(name);
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return (err?.code ?? err?.cause?.code) === '23505';
}

/** Every role: the built-in ones by rank, then the custom ones by name. Anyone signed in may see them. */
export async function listRoles(ctx: Ctx): Promise<RoleDef[]> {
  requireScope(ctx, 'read');
  const [rows, uses] = await Promise.all([ctx.db.select().from(roles).orderBy(sql`lower(${roles.name})`), usesOf(ctx.db)]);
  const builtin: RoleDef[] = PROJECT_ROLES.map((id) => ({
    id,
    name: BUILTIN_ROLE_NAMES[id],
    description: DESCRIPTIONS[id],
    permissions: [...BUILTIN_ROLE_PERMISSIONS[id]],
    builtin: true,
    uses: uses.get(id) ?? 0,
    version: 1,
  }));
  const order: Record<ProjectRole, number> = { manager: 0, member: 1, viewer: 2 };
  return [...builtin.sort((a, b) => order[a.id as ProjectRole] - order[b.id as ProjectRole]), ...rows.map((r) => roleDto(r, uses))];
}

async function requireRole(db: Db, ref: string): Promise<RoleRow> {
  if (isProjectRole(ref) || ref.toLowerCase() === 'guest') {
    throw badRequest(`${isProjectRole(ref) ? BUILTIN_ROLE_NAMES[ref] : 'Guest'} is a built-in role, and can't be changed`, 'Make a role of your own with the permissions you want, and give that instead.');
  }
  const [row] = await db
    .select()
    .from(roles)
    .where(sql`${roles.id} = ${ref} OR lower(${roles.name}) = ${ref.toLowerCase()}`);
  if (!row) throw notFound(`Role ${ref}`, 'GET /roles lists the roles there are.');
  return row;
}

export async function getRole(ctx: Ctx, ref: string): Promise<RoleDef> {
  const all = await listRoles(ctx);
  const want = ref.toLowerCase();
  const found = all.find((r) => r.id === ref || r.name.toLowerCase() === want);
  if (!found) throw notFound(`Role ${ref}`, 'GET /roles lists the roles there are.');
  return found;
}

export async function createRole(ctx: Ctx, input: { name: string; description?: string; permissions: Permission[] }): Promise<RoleDef> {
  requireScope(ctx, 'admin');
  const name = input.name.trim();
  if (!name) throw badRequest('A role needs a name');
  await assertNameFree(ctx.db, name);
  const id = newId();
  try {
    await ctx.db.insert(roles).values({ id, name, description: (input.description ?? '').trim(), permissions: checked(input.permissions) });
  } catch (e) {
    if (isUniqueViolation(e)) takenName(name);
    throw e;
  }
  accessChanged(ctx.app);
  return getRole(ctx, id);
}

export async function updateRole(
  ctx: Ctx,
  ref: string,
  input: { name?: string; description?: string; permissions?: Permission[]; expectedVersion?: number },
): Promise<RoleDef> {
  requireScope(ctx, 'admin');
  const row = await requireRole(ctx.db, ref);
  if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) {
    throw conflict(`${row.name} was changed by someone else (version ${row.version}, you sent ${input.expectedVersion})`, 'Reload the role and make your change again.', {
      currentVersion: row.version,
    });
  }
  const name = input.name?.trim();
  if (name !== undefined) {
    if (!name) throw badRequest('A role needs a name');
    await assertNameFree(ctx.db, name, row.id);
  }
  try {
    await ctx.db
      .update(roles)
      .set({
        ...(name !== undefined ? { name } : {}),
        ...(input.description !== undefined ? { description: input.description.trim() } : {}),
        ...(input.permissions !== undefined ? { permissions: checked(input.permissions) } : {}),
        version: sql`${roles.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(roles.id, row.id));
  } catch (e) {
    if (isUniqueViolation(e)) takenName(name ?? row.name);
    throw e;
  }
  // What everyone with it may do changed: every cached view of access is stale.
  accessChanged(ctx.app);
  return getRole(ctx, row.id);
}

/** Delete a role nobody has: one still given in some project would leave them with no role there. */
export async function deleteRole(ctx: Ctx, ref: string): Promise<void> {
  requireScope(ctx, 'admin');
  const row = await requireRole(ctx.db, ref);
  const n = (await usesOf(ctx.db)).get(row.id) ?? 0;
  if (n) {
    throw conflict(
      `${row.name} is given to ${n === 1 ? 'one person or group' : `${n} people and groups`} in projects`,
      "Give them another role first, in each project's People and access, then delete it.",
    );
  }
  await ctx.db.delete(roles).where(eq(roles.id, row.id));
  accessChanged(ctx.app);
}
