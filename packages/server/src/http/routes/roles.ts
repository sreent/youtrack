import type { OpenAPIHono } from '@hono/zod-openapi';
import { CreateRoleBody, RoleDefSchema, UpdateRoleBody } from '@a4a/shared';
import { z } from 'zod';
import { createRole, deleteRole, getRole, listRoles, updateRole } from '../../services/roles';
import type { HttpEnv } from '../env';
import { route } from '../route';

const Id = z.object({ id: z.string().describe("The role's id or name") });

/** Roles as sets of permissions (docs/architecture.md, D37). */
export function roleRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Roles'];
  route(
    app,
    {
      method: 'get',
      path: '/roles',
      tags,
      summary: 'Roles, and what each lets someone do in a project',
      description:
        'The built-in viewer, member and manager first, then the roles administrators made. Projects give any of them to people and groups (`role` takes an id or a name). Permissions: read, comment, create, edit, delete, time, costs, boards, manage.',
      response: z.array(RoleDefSchema),
    },
    ({ ctx }) => listRoles(ctx),
  );
  route(app, { method: 'get', path: '/roles/{id}', tags, summary: 'A role', params: Id, response: RoleDefSchema }, ({ ctx, params }) => getRole(ctx, params.id));
  route(
    app,
    {
      method: 'post',
      path: '/roles',
      tags,
      summary: 'Make a role (administrators)',
      description: 'A name and a set of permissions; read is needed for any other. A read-only account or token gets none of the permissions that change things, whatever its role.',
      body: CreateRoleBody,
      response: RoleDefSchema,
    },
    ({ ctx, body }) => createRole(ctx, body),
  );
  route(
    app,
    {
      method: 'patch',
      path: '/roles/{id}',
      tags,
      summary: 'Change a role (administrators)',
      description: 'Everyone with it may do what it says from now on. The built-in roles can\'t be changed. Send `expectedVersion` to fail with 409 if someone changed it meanwhile.',
      params: Id,
      body: UpdateRoleBody,
      response: RoleDefSchema,
    },
    ({ ctx, params, body }) => updateRole(ctx, params.id, body),
  );
  route(
    app,
    { method: 'delete', path: '/roles/{id}', tags, summary: 'Delete a role nobody has (administrators)', params: Id, status: 204 },
    async ({ ctx, params }) => {
      await deleteRole(ctx, params.id);
      return null;
    },
  );
}
