import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  AddGroupMemberBody,
  AddProjectGroupBody,
  CreateGroupBody,
  GroupDetailSchema,
  GroupSchema,
  ProjectGroupSchema,
  UpdateGroupBody,
  UpdateProjectGroupBody,
} from '@a4a/shared';
import { z } from 'zod';
import {
  addGroupMember,
  addProjectGroup,
  createGroup,
  deleteGroup,
  getGroup,
  listGroups,
  listProjectGroups,
  removeGroupMember,
  removeProjectGroup,
  updateGroup,
  updateProjectGroup,
} from '../../services/groups';
import type { HttpEnv } from '../env';
import { route } from '../route';

const Id = z.object({ id: z.string().describe("The group's id or name") });
const IdLogin = z.object({ id: z.string().describe("The group's id or name"), login: z.string().describe('Login of the person') });
const Key = z.object({ key: z.string() });
const KeyGroup = z.object({ key: z.string(), group: z.string().describe("The group's id or name") });

/** Groups of people, and the roles projects give them (docs/architecture.md, D27). */
export function groupRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Groups'];
  route(
    app,
    {
      method: 'get',
      path: '/groups',
      tags,
      summary: 'Groups of people',
      description: 'Anyone signed in sees groups and who is in them, as they see people. `projects` counts only projects the caller can see.',
      response: z.array(GroupSchema),
    },
    ({ ctx }) => listGroups(ctx),
  );
  route(
    app,
    {
      method: 'post',
      path: '/groups',
      tags,
      summary: 'Make a group (administrators)',
      description:
        "With `providerName`, the group comes from the identity provider: at each sign-in, someone the provider says is in a group of that name (the value of `OIDC_GROUPS_CLAIM` or `SAML_GROUPS_ATTRIBUTE`) is put in it, and taken out when it no longer says so. Who is in such a group can't be changed by hand.",
      body: CreateGroupBody,
      response: GroupDetailSchema,
    },
    ({ ctx, body }) => createGroup(ctx, body),
  );
  route(app, { method: 'get', path: '/groups/{id}', tags, summary: 'A group: who is in it, and its roles in projects', params: Id, response: GroupDetailSchema }, ({ ctx, params }) =>
    getGroup(ctx, params.id),
  );
  route(
    app,
    {
      method: 'patch',
      path: '/groups/{id}',
      tags,
      summary: 'Rename a group, or say where its people come from (administrators)',
      description:
        'Setting `providerName` on a group kept by hand empties it: from then on the identity provider says who is in it, at each sign-in. Setting it to null keeps whoever is in it, by hand from then on.',
      params: Id,
      body: UpdateGroupBody,
      response: GroupDetailSchema,
    },
    ({ ctx, params, body }) => updateGroup(ctx, params.id, body),
  );
  route(
    app,
    { method: 'delete', path: '/groups/{id}', tags, summary: 'Delete a group, and its roles in projects (administrators)', params: Id, status: 204 },
    async ({ ctx, params }) => {
      await deleteGroup(ctx, params.id);
      return null;
    },
  );
  route(
    app,
    { method: 'post', path: '/groups/{id}/members', tags, summary: 'Put someone in a group kept by hand (administrators)', params: Id, body: AddGroupMemberBody, response: GroupDetailSchema },
    ({ ctx, params, body }) => addGroupMember(ctx, params.id, body.user),
  );
  route(
    app,
    { method: 'delete', path: '/groups/{id}/members/{login}', tags, summary: 'Take someone out of a group kept by hand (administrators)', params: IdLogin, status: 204 },
    async ({ ctx, params }) => {
      await removeGroupMember(ctx, params.id, params.login);
      return null;
    },
  );

  const projectTags = ['Projects'];
  route(
    app,
    {
      method: 'get',
      path: '/projects/{key}/groups',
      tags: projectTags,
      summary: "The groups with a role in a project",
      description: "Everyone in a group has at least the group's role in the project; someone's role is the highest of their own and their groups'.",
      params: Key,
      response: z.array(ProjectGroupSchema),
    },
    ({ ctx, params }) => listProjectGroups(ctx, params.key),
  );
  route(
    app,
    { method: 'post', path: '/projects/{key}/groups', tags: projectTags, summary: 'Give a group a role in a project (its managers)', params: Key, body: AddProjectGroupBody, response: ProjectGroupSchema },
    ({ ctx, params, body }) => addProjectGroup(ctx, params.key, body),
  );
  route(
    app,
    { method: 'patch', path: '/projects/{key}/groups/{group}', tags: projectTags, summary: "Change a group's role in a project (its managers)", params: KeyGroup, body: UpdateProjectGroupBody, response: ProjectGroupSchema },
    ({ ctx, params, body }) => updateProjectGroup(ctx, params.key, params.group, body),
  );
  route(
    app,
    { method: 'delete', path: '/projects/{key}/groups/{group}', tags: projectTags, summary: 'Take a group out of a project (its managers)', params: KeyGroup, status: 204 },
    async ({ ctx, params }) => {
      await removeProjectGroup(ctx, params.key, params.group);
      return null;
    },
  );
}
