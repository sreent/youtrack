import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  AttachFieldBody,
  CreateFieldBody,
  CreateProjectBody,
  CreateUserBody,
  FieldSchema,
  FieldValueBody,
  FieldValueSchema,
  LinkTypeSchema,
  ProjectFieldSchema,
  ProjectSchema,
  SettingsBody,
  SettingsSchema,
  TagBody,
  TagSchema,
  UpdateFieldBody,
  UpdateProjectBody,
  UpdateUserBody,
  UserSchema,
} from '@tracklet/shared';
import { z } from 'zod';
import { notFound } from '../../lib/errors';
import {
  addFieldValue,
  attachField,
  createField,
  deleteField,
  deleteFieldValue,
  detachField,
  listFields,
  projectFieldDtos,
  updateField,
  updateFieldValue,
} from '../../services/fields';
import { createLinkType, listLinkTypes } from '../../services/links';
import { createProject, deleteProject, getProject, listProjects, updateProject } from '../../services/projects';
import { projectByKey } from '../../services/schema-cache';
import { getSettings, updateSettings } from '../../services/settings';
import { createTag, deleteTag, listTags, updateTag } from '../../services/tags';
import { createUser, deleteUser, getUser, listUsers, updateUser } from '../../services/users';
import { assertCanReadProject } from '../../services/access';
import type { HttpEnv } from '../env';
import { route } from '../route';

const Id = z.object({ id: z.string() });
const Key = z.object({ key: z.string() });

export function coreRoutes(app: OpenAPIHono<HttpEnv>) {
  // Users ---------------------------------------------------------------------
  const users = ['Users'];
  route(app, { method: 'get', path: '/users', tags: users, summary: 'List people and bots', query: z.object({ search: z.string().optional() }), response: z.array(UserSchema) }, ({ ctx, query }) => listUsers(ctx, query.search));
  route(app, { method: 'post', path: '/users', tags: users, summary: 'Create a user (admin)', body: CreateUserBody, response: UserSchema }, ({ ctx, body }) => createUser(ctx, body));
  route(app, { method: 'get', path: '/users/{id}', tags: users, summary: 'Get a user by id or login', params: Id, response: UserSchema }, ({ ctx, params }) => getUser(ctx, params.id));
  route(app, { method: 'patch', path: '/users/{id}', tags: users, summary: 'Update a user (admin; people may change their own name)', params: Id, body: UpdateUserBody, response: UserSchema }, ({ ctx, params, body }) => updateUser(ctx, params.id, body));
  route(app, { method: 'delete', path: '/users/{id}', tags: users, summary: 'Delete a user (admin)', params: Id, status: 204 }, async ({ ctx, params }) => {
    await deleteUser(ctx, params.id);
    return null;
  });

  // Projects ------------------------------------------------------------------
  const projects = ['Projects'];
  route(app, { method: 'get', path: '/projects', tags: projects, summary: 'List projects', response: z.array(ProjectSchema) }, ({ ctx }) => listProjects(ctx));
  route(app, { method: 'post', path: '/projects', tags: projects, summary: 'Create a project from a template (admin)', body: CreateProjectBody, response: ProjectSchema }, ({ ctx, body }) => createProject(ctx, body));
  route(app, { method: 'get', path: '/projects/{key}', tags: projects, summary: 'Get a project', params: Key, response: ProjectSchema }, ({ ctx, params }) => getProject(ctx, params.key));
  route(app, { method: 'patch', path: '/projects/{key}', tags: projects, summary: 'Update a project, its triage mode or its plan settings (admin)', params: Key, body: UpdateProjectBody, response: ProjectSchema }, ({ ctx, params, body }) => updateProject(ctx, params.key, body));
  route(app, { method: 'delete', path: '/projects/{key}', tags: projects, summary: 'Delete a project and all its issues (admin)', params: Key, status: 204 }, async ({ ctx, params }) => {
    await deleteProject(ctx, params.key);
    return null;
  });
  route(app, { method: 'get', path: '/projects/{key}/fields', tags: projects, summary: "A project's fields and their allowed values", params: Key, response: z.array(ProjectFieldSchema) }, async ({ ctx, params }) => {
    const s = await ctx.app.schema.get();
    const p = projectByKey(s, params.key);
    if (!p) throw notFound(`Project ${params.key}`);
    await assertCanReadProject(ctx, p.id);
    return projectFieldDtos(s, p.id);
  });
  route(app, { method: 'put', path: '/projects/{key}/fields/{fieldId}', tags: projects, summary: 'Attach or configure a field in a project (admin)', params: z.object({ key: z.string(), fieldId: z.string() }), body: AttachFieldBody, response: z.array(ProjectFieldSchema) }, ({ ctx, params, body }) => attachField(ctx, params.key, params.fieldId, body));
  route(app, { method: 'delete', path: '/projects/{key}/fields/{fieldId}', tags: projects, summary: 'Detach a field from a project (admin)', params: z.object({ key: z.string(), fieldId: z.string() }), status: 204 }, async ({ ctx, params }) => {
    await detachField(ctx, params.key, params.fieldId);
    return null;
  });

  // Custom fields ---------------------------------------------------------------
  const fields = ['Custom fields'];
  route(app, { method: 'get', path: '/fields', tags: fields, summary: 'All custom fields and their values', response: z.array(FieldSchema) }, ({ ctx }) => listFields(ctx));
  route(app, { method: 'post', path: '/fields', tags: fields, summary: 'Create a custom field (admin)', body: CreateFieldBody, response: FieldSchema }, ({ ctx, body }) => createField(ctx, body));
  route(app, { method: 'patch', path: '/fields/{id}', tags: fields, summary: 'Rename or describe a field (admin)', params: Id, body: UpdateFieldBody, response: FieldSchema }, ({ ctx, params, body }) => updateField(ctx, params.id, body));
  route(app, { method: 'delete', path: '/fields/{id}', tags: fields, summary: 'Delete a field and its values everywhere (admin)', params: Id, status: 204 }, async ({ ctx, params }) => {
    await deleteField(ctx, params.id);
    return null;
  });
  route(app, { method: 'post', path: '/fields/{id}/values', tags: fields, summary: 'Add a value (optionally scoped to one project)', params: Id, body: FieldValueBody, response: FieldValueSchema }, ({ ctx, params, body }) => addFieldValue(ctx, params.id, body));
  route(app, { method: 'patch', path: '/fields/{id}/values/{valueId}', tags: fields, summary: 'Change a value: rename, tone, order, archive', params: z.object({ id: z.string(), valueId: z.string() }), body: FieldValueBody.partial(), response: FieldValueSchema }, ({ ctx, params, body }) => updateFieldValue(ctx, params.id, params.valueId, body));
  route(app, { method: 'delete', path: '/fields/{id}/values/{valueId}', tags: fields, summary: 'Delete an unused value', params: z.object({ id: z.string(), valueId: z.string() }), status: 204 }, async ({ ctx, params }) => {
    await deleteFieldValue(ctx, params.id, params.valueId);
    return null;
  });

  // Tags & link types --------------------------------------------------------------
  route(app, { method: 'get', path: '/tags', tags: ['Tags'], summary: 'List tags', response: z.array(TagSchema) }, ({ ctx }) => listTags(ctx));
  route(app, { method: 'post', path: '/tags', tags: ['Tags'], summary: 'Create a tag', body: TagBody, response: TagSchema }, ({ ctx, body }) => createTag(ctx, body));
  route(app, { method: 'patch', path: '/tags/{id}', tags: ['Tags'], summary: 'Rename a tag', params: Id, body: TagBody.partial(), response: TagSchema }, ({ ctx, params, body }) => updateTag(ctx, params.id, body));
  route(app, { method: 'delete', path: '/tags/{id}', tags: ['Tags'], summary: 'Delete a tag', params: Id, status: 204 }, async ({ ctx, params }) => {
    await deleteTag(ctx, params.id);
    return null;
  });
  route(app, { method: 'get', path: '/link-types', tags: ['Links'], summary: 'Link types and their phrases', response: z.array(LinkTypeSchema) }, ({ ctx }) => listLinkTypes(ctx));
  route(
    app,
    {
      method: 'post',
      path: '/link-types',
      tags: ['Links'],
      summary: 'Create a link type (admin)',
      body: z.object({ name: z.string().min(1), outward: z.string().min(1), inward: z.string().optional(), directed: z.boolean().optional() }),
      response: LinkTypeSchema,
    },
    ({ ctx, body }) => createLinkType(ctx, body),
  );

  // Settings ---------------------------------------------------------------------
  route(app, { method: 'get', path: '/settings', tags: ['Settings'], summary: 'Instance settings', response: SettingsSchema }, ({ ctx }) => getSettings(ctx));
  route(app, { method: 'patch', path: '/settings', tags: ['Settings'], summary: 'Change instance settings (admin)', body: SettingsBody, response: SettingsSchema }, ({ ctx, body }) => updateSettings(ctx, body));
}
