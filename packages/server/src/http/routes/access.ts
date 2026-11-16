import type { OpenAPIHono } from '@hono/zod-openapi';
import { AddMemberBody, ProjectMemberSchema, UpdateMemberBody } from '@a4a/shared';
import { z } from 'zod';
import { addMember, listMembers, removeMember, updateMember } from '../../services/members';
import type { HttpEnv } from '../env';
import { route } from '../route';

const Key = z.object({ key: z.string() });
const KeyLogin = z.object({ key: z.string(), login: z.string().describe('Login of the person') });

/** A project's people and their roles. Who sees a project at all is its `visibility`, on PATCH /projects/{key}. */
export function accessRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Projects'];
  route(
    app,
    {
      method: 'get',
      path: '/projects/{key}/members',
      tags,
      summary: "A project's people and their roles",
      description:
        'Its lead first, a manager by leading it. In a members-only project only these people and administrators see it; in an open project everyone else is a member.',
      params: Key,
      response: z.array(ProjectMemberSchema),
    },
    ({ ctx, params }) => listMembers(ctx, params.key),
  );
  route(
    app,
    {
      method: 'post',
      path: '/projects/{key}/members',
      tags,
      summary: 'Give someone a role in a project (its managers)',
      description: "viewer: reads and comments. member: also changes issues. manager: also changes the project's settings, people, boards and baselines.",
      params: Key,
      body: AddMemberBody,
      response: ProjectMemberSchema,
    },
    ({ ctx, params, body }) => addMember(ctx, params.key, body),
  );
  route(
    app,
    {
      method: 'patch',
      path: '/projects/{key}/members/{login}',
      tags,
      summary: "Change someone's role in a project (its managers)",
      params: KeyLogin,
      body: UpdateMemberBody,
      response: ProjectMemberSchema,
    },
    ({ ctx, params, body }) => updateMember(ctx, params.key, params.login, body),
  );
  route(
    app,
    { method: 'delete', path: '/projects/{key}/members/{login}', tags, summary: 'Take someone out of a project (its managers)', params: KeyLogin, status: 204 },
    async ({ ctx, params }) => {
      await removeMember(ctx, params.key, params.login);
      return null;
    },
  );
}
