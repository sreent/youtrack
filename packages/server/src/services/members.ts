/**
 * A project's people and their roles. Anyone who can see a project can see who is in it;
 * its managers (and administrators) change who is.
 */
import type { ProjectMember, ProjectRole } from '@a4a/shared';
import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import type { Db } from '../db/client';
import { projectMembers } from '../db/schema';
import { publishActivities, recordActivity } from '../events/activity';
import { badRequest, conflict, notFound } from '../lib/errors';
import { accessChanged, isProjectRole, requireProject } from './access';
import { findUser, type ProjectRow, type SchemaSnapshot, type UserRow } from './schema-cache';
import { userRefDto } from './values';

type MemberRow = typeof projectMembers.$inferSelect;

const ORDER: Record<ProjectRole, number> = { manager: 0, member: 1, viewer: 2 };

function memberDto(s: SchemaSnapshot, project: ProjectRow, user: UserRow, row: MemberRow | undefined): ProjectMember {
  const by = row?.addedById ? s.users.get(row.addedById) : undefined;
  return {
    user: userRefDto(user),
    role: row && isProjectRole(row.role) ? row.role : 'manager',
    lead: project.leadId === user.id,
    addedAt: row ? row.createdAt.toISOString() : null,
    addedBy: by ? userRefDto(by) : null,
  };
}

/** The project's people: its lead first, then by role and name. */
export async function listMembers(ctx: Ctx, key: string): Promise<ProjectMember[]> {
  const project = await requireProject(ctx, key);
  const s = await ctx.app.schema.get();
  const rows = await ctx.db.select().from(projectMembers).where(eq(projectMembers.projectId, project.id));
  const out: ProjectMember[] = [];
  for (const r of rows) {
    const u = s.users.get(r.userId);
    if (u) out.push(memberDto(s, project, u, r));
  }
  const lead = project.leadId ? s.users.get(project.leadId) : undefined;
  if (lead && !rows.some((r) => r.userId === lead.id)) out.push(memberDto(s, project, lead, undefined));
  return out.sort(
    (a, b) => Number(b.lead) - Number(a.lead) || ORDER[a.role] - ORDER[b.role] || a.user.name.localeCompare(b.user.name),
  );
}

function personFor(s: SchemaSnapshot, login: string): UserRow {
  const u = findUser(s, login);
  if (!u) throw notFound(`User ${login}`, 'Use their login, as in GET /users.');
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

export async function addMember(ctx: Ctx, key: string, input: { user: string; role?: ProjectRole }): Promise<ProjectMember> {
  const project = await requireProject(ctx, key, 'manage');
  const s = await ctx.app.schema.get();
  const user = personFor(s, input.user);
  const role = input.role ?? 'member';
  if (!isProjectRole(role)) throw badRequest(`Unknown role "${role}"`, 'Use viewer, member or manager.');
  await write(ctx, project, async (tx) => {
    const [row] = await tx
      .insert(projectMembers)
      .values({ projectId: project.id, userId: user.id, role, addedById: ctx.actor.user.id })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      throw conflict(`${user.name} is already one of ${project.key}'s people`, `Change their role instead: PATCH /projects/${project.key}/members/${user.login}.`);
    }
    return { type: 'project.member.added', data: { user: user.login, name: user.name, role } };
  });
  return (await listMembers(ctx, project.key)).find((m) => m.user.id === user.id)!;
}

export async function updateMember(ctx: Ctx, key: string, login: string, input: { role: ProjectRole }): Promise<ProjectMember> {
  const project = await requireProject(ctx, key, 'manage');
  const s = await ctx.app.schema.get();
  const user = personFor(s, login);
  if (!isProjectRole(input.role)) throw badRequest(`Unknown role "${input.role}"`, 'Use viewer, member or manager.');
  await write(ctx, project, async (tx) => {
    const [before] = await tx
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, user.id)))
      .for('update');
    if (!before) throw notFound(`${user.login} among ${project.key}'s people`, `Add them first: POST /projects/${project.key}/members.`);
    await tx.update(projectMembers).set({ role: input.role }).where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, user.id)));
    return { type: 'project.member.changed', data: { user: user.login, name: user.name, from: before.role, to: input.role } };
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
        throw badRequest(`${user.name} leads ${project.key}, which makes them its manager`, 'Choose another lead in the project’s details first.');
      }
      throw notFound(`${user.login} among ${project.key}'s people`);
    }
    return { type: 'project.member.removed', data: { user: user.login, name: user.name, role: gone.role } };
  });
}
