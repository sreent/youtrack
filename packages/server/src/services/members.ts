/**
 * A project's people and their roles. Anyone who can see a project can see who is in it;
 * its managers (and administrators) change who is.
 */
import type { ProjectMember } from '@a4a/shared';
import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import type { Db } from '../db/client';
import { projectMembers } from '../db/schema';
import { publishActivities, recordActivity } from '../events/activity';
import { badRequest, conflict, notFound } from '../lib/errors';
import { accessChanged, loadRoles, requireProject, resolveRole, roleOrder, type RoleDefn } from './access';
import { findUser, type ProjectRow, type SchemaSnapshot, type UserRow } from './schema-cache';
import { userRefDto } from './values';

type MemberRow = typeof projectMembers.$inferSelect;

function memberDto(s: SchemaSnapshot, all: ReadonlyMap<string, RoleDefn>, project: ProjectRow, user: UserRow, row: MemberRow | undefined): ProjectMember {
  const by = row?.addedById ? s.users.get(row.addedById) : undefined;
  return {
    user: userRefDto(user),
    role: row && all.has(row.role) ? row.role : 'manager',
    roleName: all.get(row && all.has(row.role) ? row.role : 'manager')?.name ?? row?.role ?? 'Manager',
    lead: project.leadId === user.id,
    addedAt: row ? row.createdAt.toISOString() : null,
    addedBy: by ? userRefDto(by) : null,
  };
}

/** The project's people: its lead first, then by role and name. */
export async function listMembers(ctx: Ctx, key: string): Promise<ProjectMember[]> {
  const project = await requireProject(ctx, key);
  const s = await ctx.app.schema.get();
  const [rows, all] = await Promise.all([ctx.db.select().from(projectMembers).where(eq(projectMembers.projectId, project.id)), loadRoles(ctx.db)]);
  const out: ProjectMember[] = [];
  for (const r of rows) {
    const u = s.users.get(r.userId);
    if (u) out.push(memberDto(s, all, project, u, r));
  }
  const lead = project.leadId ? s.users.get(project.leadId) : undefined;
  if (lead && !rows.some((r) => r.userId === lead.id)) out.push(memberDto(s, all, project, lead, undefined));
  return out.sort(
    (a, b) => Number(b.lead) - Number(a.lead) || roleOrder(a.role) - roleOrder(b.role) || a.roleName.localeCompare(b.roleName) || a.user.name.localeCompare(b.user.name),
  );
}

function personFor(s: SchemaSnapshot, login: string): UserRow {
  const u = findUser(s, login);
  if (!u) throw notFound(`User ${login}`, 'Use their login, as in GET /users.').said('members.userNotFound', { login });
  return u;
}

async function write(ctx: Ctx, project: ProjectRow, fn: (tx: Db) => Promise<{ type: 'project.member.added' | 'project.member.changed' | 'project.member.removed'; data: Record<string, unknown> }>) {
  const activity = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const { type, data } = await fn(tx);
    return recordActivity(tx, ctx, { type, projectId: project.id, issueId: null, payload: { data } });
  });
  accessChanged(ctx.app);
  await publishActivities(ctx.app, [activity]);
}

export async function addMember(ctx: Ctx, key: string, input: { user: string; role?: string }): Promise<ProjectMember> {
  const project = await requireProject(ctx, key, 'manage');
  const s = await ctx.app.schema.get();
  const user = personFor(s, input.user);
  const role = (await resolveRole(ctx.db, input.role ?? 'member')).id;
  await write(ctx, project, async (tx) => {
    const [row] = await tx
      .insert(projectMembers)
      .values({ projectId: project.id, userId: user.id, role, addedById: ctx.actor.user.id })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      throw conflict(`${user.name} is already one of ${project.key}'s people`, `Change their role instead: PATCH /projects/${project.key}/members/${user.login}.`).said('members.alreadyMember', { name: user.name, project: project.key, login: user.login });
    }
    return { type: 'project.member.added', data: { user: user.login, name: user.name, role } };
  });
  return (await listMembers(ctx, project.key)).find((m) => m.user.id === user.id)!;
}

export async function updateMember(ctx: Ctx, key: string, login: string, input: { role: string }): Promise<ProjectMember> {
  const project = await requireProject(ctx, key, 'manage');
  const s = await ctx.app.schema.get();
  const user = personFor(s, login);
  const role = (await resolveRole(ctx.db, input.role)).id;
  await write(ctx, project, async (tx) => {
    const [before] = await tx
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, user.id)))
      .for('update');
    if (!before) throw notFound(`${user.login} among ${project.key}'s people`, `Add them first: POST /projects/${project.key}/members.`).said('members.notAMember', { login: user.login, project: project.key });
    await tx.update(projectMembers).set({ role }).where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, user.id)));
    return { type: 'project.member.changed', data: { user: user.login, name: user.name, from: before.role, to: role } };
  });
  return (await listMembers(ctx, project.key)).find((m) => m.user.id === user.id)!;
}

export async function removeMember(ctx: Ctx, key: string, login: string): Promise<void> {
  const project = await requireProject(ctx, key, 'manage');
  const s = await ctx.app.schema.get();
  const user = personFor(s, login);
  await write(ctx, project, async (tx) => {
    const [gone] = await tx
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, user.id)))
      .returning();
    if (!gone) {
      if (project.leadId === user.id) {
        throw badRequest(`${user.name} leads ${project.key}, which makes them its manager`, 'Choose another lead in the project’s details first.').said('members.leadIsManager', { name: user.name, project: project.key });
      }
      throw notFound(`${user.login} among ${project.key}'s people`).said('members.notAMemberShort', { login: user.login, project: project.key });
    }
    return { type: 'project.member.removed', data: { user: user.login, name: user.name, role: gone.role } };
  });
}
