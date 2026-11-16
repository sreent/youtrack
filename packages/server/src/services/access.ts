/**
 * Project-level access. Every read or write of a project's issues asks here, so
 * per-project roles and project-restricted tokens change this module alone.
 *
 * v1 policy: every project is visible to every signed-in user; writing needs the
 * "write" scope (role ∩ token scopes); administration needs "admin".
 */
import { requireScope, type Ctx } from '../context';
import { notFound } from '../lib/errors';

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
