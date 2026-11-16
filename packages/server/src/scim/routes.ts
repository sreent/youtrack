/**
 * SCIM 2.0 at /scim/v2 (D38), for an identity provider's provisioning, and the SCIM tokens
 * administrators make for it under /api/v1/scim/tokens.
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import { CreateScimTokenBody, ScimTokenCreatedSchema, ScimTokenSchema } from '@a4a/shared';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Runtime } from '../app-services';
import type { Ctx } from '../context';
import type { HttpEnv } from '../http/env';
import { route } from '../http/route';
import { errorBody, SCIM, SCIM_JSON, ScimError } from './protocol';
import {
  createScimGroup,
  createScimToken,
  createScimUser,
  deleteScimGroup,
  deleteScimUser,
  getScimGroup,
  getScimUser,
  listScimGroups,
  listScimTokens,
  listScimUsers,
  patchScimGroup,
  patchScimUser,
  replaceScimGroup,
  replaceScimUser,
  revokeScimToken,
  scimActor,
  type ScimCall,
} from './service';

const scimJson = (c: Context<HttpEnv>, body: unknown, status = 200) => c.body(JSON.stringify(body), status as 200, { 'content-type': SCIM_JSON });

function scimError(c: Context<HttpEnv>, err: unknown): Response {
  if (err instanceof ScimError) {
    if (err.status === 401) c.header('www-authenticate', 'Bearer realm="a4a SCIM"');
    return scimJson(c, errorBody(err.status, err.detail, err.scimType), err.status);
  }
  console.error('SCIM: a request failed:', err);
  return scimJson(c, errorBody(500, 'Something went wrong in a4a; the request can be tried again'), 500);
}

async function bodyOf(c: Context<HttpEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ScimError(400, 'The body isn’t JSON', 'invalidSyntax');
  }
}

const AUTH_SCHEME = { type: 'oauthbearertoken', name: 'OAuth Bearer Token', description: 'A SCIM token an administrator makes in a4a: Administration → Provisioning', primary: true };

function discovery(base: string) {
  const attr = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    type: 'string',
    multiValued: false,
    required: false,
    caseExact: false,
    mutability: 'readWrite',
    returned: 'default',
    uniqueness: 'none',
    ...extra,
  });
  const userSchema = {
    schemas: [SCIM.schema],
    id: SCIM.user,
    name: 'User',
    description: 'A person in a4a',
    attributes: [
      attr('userName', { required: true, uniqueness: 'server' }),
      attr('externalId', { caseExact: true }),
      attr('name', { type: 'complex', subAttributes: [attr('formatted'), attr('givenName'), attr('familyName')] }),
      attr('displayName'),
      attr('emails', { type: 'complex', multiValued: true, subAttributes: [attr('value'), attr('type'), attr('primary', { type: 'boolean' })] }),
      attr('active', { type: 'boolean' }),
    ],
    meta: { resourceType: 'Schema', location: `${base}/Schemas/${SCIM.user}` },
  };
  const groupSchema = {
    schemas: [SCIM.schema],
    id: SCIM.group,
    name: 'Group',
    description: 'A group in a4a that follows the provider',
    attributes: [
      attr('displayName', { required: true }),
      attr('externalId', { caseExact: true }),
      attr('members', { type: 'complex', multiValued: true, subAttributes: [attr('value', { mutability: 'immutable' }), attr('display', { mutability: 'readOnly' }), attr('$ref', { type: 'reference', referenceTypes: ['User'], mutability: 'immutable' })] }),
    ],
    meta: { resourceType: 'Schema', location: `${base}/Schemas/${SCIM.group}` },
  };
  const resourceType = (name: 'User' | 'Group') => ({
    schemas: [SCIM.resourceType],
    id: name,
    name,
    endpoint: `/${name}s`,
    schema: name === 'User' ? SCIM.user : SCIM.group,
    meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/${name}` },
  });
  return {
    serviceProviderConfig: {
      schemas: [SCIM.serviceProviderConfig],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [AUTH_SCHEME],
      meta: { resourceType: 'ServiceProviderConfig', location: `${base}/ServiceProviderConfig` },
    },
    resourceTypes: [resourceType('User'), resourceType('Group')],
    schemas: [userSchema, groupSchema],
  };
}

/** The SCIM service: its own tokens, its own errors, its own media type. */
export function scimApp(runtime: Runtime) {
  const scim = new Hono<HttpEnv>();
  const base = `${runtime.config.publicUrl}/scim/v2`;
  const known = discovery(base);
  scim.onError((err, c) => scimError(c, err));
  scim.use('*', async (c, next) => {
    const header = c.req.header('authorization');
    const bearer = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined;
    const ctx = await scimActor(runtime, bearer);
    if (!ctx) {
      throw new ScimError(401, 'The SCIM token is missing, unknown or revoked, or the administrator who made it no longer is one. Make a new one in a4a: Administration → Provisioning');
    }
    c.set('ctx', ctx);
    await next();
  });
  const call = (c: Context<HttpEnv>): ScimCall => ({ runtime, ctx: c.get('ctx') as Ctx, base });

  scim.get('/ServiceProviderConfig', (c) => scimJson(c, known.serviceProviderConfig));
  scim.get('/ResourceTypes', (c) => scimJson(c, { schemas: [SCIM.list], totalResults: 2, startIndex: 1, itemsPerPage: 2, Resources: known.resourceTypes }));
  scim.get('/ResourceTypes/:id', (c) => {
    const found = known.resourceTypes.find((r) => r.id === c.req.param('id'));
    if (!found) throw new ScimError(404, 'The resource types are User and Group');
    return scimJson(c, found);
  });
  scim.get('/Schemas', (c) => scimJson(c, { schemas: [SCIM.list], totalResults: 2, startIndex: 1, itemsPerPage: 2, Resources: known.schemas }));
  scim.get('/Schemas/:id', (c) => {
    const found = known.schemas.find((s) => s.id === c.req.param('id'));
    if (!found) throw new ScimError(404, `The schemas are ${SCIM.user} and ${SCIM.group}`);
    return scimJson(c, found);
  });

  scim.get('/Users', async (c) => scimJson(c, await listScimUsers(call(c), c.req.query())));
  scim.post('/Users', async (c) => scimJson(c, await createScimUser(call(c), await bodyOf(c)), 201));
  scim.get('/Users/:id', async (c) => scimJson(c, await getScimUser(call(c), c.req.param('id'))));
  scim.put('/Users/:id', async (c) => scimJson(c, await replaceScimUser(call(c), c.req.param('id'), await bodyOf(c))));
  scim.patch('/Users/:id', async (c) => scimJson(c, await patchScimUser(call(c), c.req.param('id'), await bodyOf(c))));
  scim.delete('/Users/:id', async (c) => {
    await deleteScimUser(call(c), c.req.param('id'));
    return c.body(null, 204);
  });

  scim.get('/Groups', async (c) => scimJson(c, await listScimGroups(call(c), c.req.query())));
  scim.post('/Groups', async (c) => scimJson(c, await createScimGroup(call(c), await bodyOf(c)), 201));
  scim.get('/Groups/:id', async (c) => scimJson(c, await getScimGroup(call(c), c.req.param('id'), c.req.query('excludedAttributes'))));
  scim.put('/Groups/:id', async (c) => scimJson(c, await replaceScimGroup(call(c), c.req.param('id'), await bodyOf(c))));
  scim.patch('/Groups/:id', async (c) => {
    await patchScimGroup(call(c), c.req.param('id'), await bodyOf(c));
    return c.body(null, 204);
  });
  scim.delete('/Groups/:id', async (c) => {
    await deleteScimGroup(call(c), c.req.param('id'));
    return c.body(null, 204);
  });
  // Mounted under the root, a sub-app's notFound isn't asked: this is.
  scim.all('*', (c) => scimError(c, new ScimError(404, `Nothing is at ${c.req.path}: a4a serves /Users, /Groups, /ServiceProviderConfig, /ResourceTypes and /Schemas`)));
  return scim;
}

/** Administrators' SCIM tokens, in the REST API. */
export function scimTokenRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Provisioning'];
  route(app, { method: 'get', path: '/scim/tokens', tags, summary: 'SCIM tokens identity providers provision people with (admin)', response: z.array(ScimTokenSchema) }, ({ ctx }) => listScimTokens(ctx));
  route(
    app,
    {
      method: 'post',
      path: '/scim/tokens',
      tags,
      summary: 'Make a SCIM token for an identity provider (admin; the secret is returned once)',
      description: 'Give the provider `baseUrl` as the tenant URL and `token` as the secret token. It acts as you, while you are an administrator.',
      body: CreateScimTokenBody,
      response: ScimTokenCreatedSchema,
    },
    ({ ctx, body }) => createScimToken(ctx, body.name),
  );
  route(app, { method: 'delete', path: '/scim/tokens/{id}', tags, summary: 'Revoke a SCIM token (admin)', params: z.object({ id: z.string() }), status: 204 }, async ({ ctx, params }) => {
    await revokeScimToken(ctx, params.id);
    return null;
  });
}
