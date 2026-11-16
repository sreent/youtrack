/**
 * Project-level access. Every read or write of a project's issues asks here, so
 * per-project roles and project-restricted tokens change this module alone.
 *
 * v1 policy: every project is visible to every signed-in user; writing needs the
 * "write" scope (role ∩ token scopes); administration needs "admin".
 */
import { can, isAdmin, requireScope, type Ctx } from '../context';
import { forbidden, notFound } from '../lib/errors';

/** Project ids the actor may read, or null for "all". */
export async function visibleProjectIds(_ctx: Ctx): Promise<string[] | null> {
  return null;
}

export async function canReadProject(ctx: Ctx, projectId: string): Promise<boolean> {
  const visible = await visibleProjectIds(ctx);
  return visible === null || visible.includes(projectId);
}

export async function assertCanReadProject(ctx: Ctx, projectId: string): Promise<void> {
  requireScope(ctx, 'read');
  // Hidden projects look like missing ones, so ids can't be probed.
  if (!(await canReadProject(ctx, projectId))) throw notFound('Project');
}

export async function assertCanWriteProject(ctx: Ctx, projectId: string): Promise<void> {
  await assertCanReadProject(ctx, projectId);
  requireScope(ctx, 'write');
}

/**
 * Managing how a project works (its workflow rules): its manager or an administrator.
 * v1 policy: administrators, and the project's lead, who stands for its manager until
 * per-project roles name one.
 */
export async function canManageProject(ctx: Ctx, projectId: string): Promise<boolean> {
  if (!(await canReadProject(ctx, projectId)) || !can(ctx, 'write')) return false;
  if (isAdmin(ctx)) return true;
  const s = await ctx.app.schema.get();
  return s.projects.get(projectId)?.leadId === ctx.actor.user.id;
}

export async function assertCanManageProject(ctx: Ctx, projectId: string): Promise<void> {
  await assertCanWriteProject(ctx, projectId);
  if (!(await canManageProject(ctx, projectId))) {
    throw forbidden("Only the project's manager or an administrator can change how it works", 'Ask the project lead or an administrator.');
  }
}
