/**
 * Customer groups in the help desk (docs/architecture.md, D56): a desk's groups, their domains,
 * members and agents, for the desk's managers to set and its people to read; and a request's group,
 * or its being kept from the group, which the team changes as it changes the request.
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import { CustomerGroupBody, CustomerGroupMemberBody, CustomerGroupMemberSchema, CustomerGroupSchema, HelpdeskRequestSchema, RequestUpdateBody } from '@a4a/shared';
import { z } from 'zod';
import { addGroupMember, createCustomerGroup, deleteCustomerGroup, getCustomerGroup, listCustomerGroups, listGroupMembers, removeGroupMember, updateCustomerGroup } from '../../services/customer-groups';
import { updateRequest } from '../../services/helpdesk';
import type { HttpEnv } from '../env';
import { route } from '../route';

const Key = z.object({ key: z.string().min(1).max(10) });
const KeyId = Key.extend({ id: z.string().min(1).max(40) });

export function customerGroupRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Help desk'];
  const managers = "The desk's managers and administrators.";

  route(
    app,
    {
      method: 'get',
      path: '/projects/{key}/customer-groups',
      tags,
      summary: "A desk's customer groups",
      description: 'With their domains, sharing, hours, agents (and whether each can be given a request now), how many were added by hand, and their open requests.',
      params: Key,
      response: z.array(CustomerGroupSchema),
    },
    ({ ctx, params }) => listCustomerGroups(ctx, params.key),
  );
  route(
    app,
    {
      method: 'post',
      path: '/projects/{key}/customer-groups',
      tags,
      summary: 'Make a customer group',
      description: `${managers} A domain names one group at a desk (409 names the group that has it); agents are logins of people who may change the project's issues. Requests filed from now on go under it; earlier ones keep theirs.`,
      params: Key,
      body: CustomerGroupBody,
      response: CustomerGroupSchema,
      status: 201,
    },
    ({ ctx, params, body }) => createCustomerGroup(ctx, params.key, body),
  );
  route(app, { method: 'get', path: '/projects/{key}/customer-groups/{id}', tags, summary: 'A customer group', params: KeyId, response: CustomerGroupSchema }, ({ ctx, params }) =>
    getCustomerGroup(ctx, params.key, params.id),
  );
  route(
    app,
    {
      method: 'put',
      path: '/projects/{key}/customer-groups/{id}',
      tags,
      summary: 'Change a customer group',
      description: `${managers} Its domains and agents become those given. Its open requests' SLAs follow its hours now.`,
      params: KeyId,
      body: CustomerGroupBody,
      response: CustomerGroupSchema,
    },
    ({ ctx, params, body }) => updateCustomerGroup(ctx, params.key, params.id, body),
  );
  route(
    app,
    { method: 'delete', path: '/projects/{key}/customer-groups/{id}', tags, summary: 'Delete a customer group', description: `${managers} Its requests are in none from then on.`, params: KeyId, status: 204 },
    async ({ ctx, params }) => {
      await deleteCustomerGroup(ctx, params.key, params.id);
      return null;
    },
  );
  route(
    app,
    { method: 'get', path: '/projects/{key}/customer-groups/{id}/members', tags, summary: 'Requesters added to a group by hand', params: KeyId, response: z.array(CustomerGroupMemberSchema) },
    ({ ctx, params }) => listGroupMembers(ctx, params.key, params.id),
  );
  route(
    app,
    {
      method: 'post',
      path: '/projects/{key}/customer-groups/{id}/members',
      tags,
      summary: 'Add a requester to a group by hand',
      description: `${managers} By their email, whether or not they have asked anything yet. A requester is in one group at a desk: one in another is refused (409), naming it.`,
      params: KeyId,
      body: CustomerGroupMemberBody,
      response: CustomerGroupMemberSchema,
      status: 201,
    },
    ({ ctx, params, body }) => addGroupMember(ctx, params.key, params.id, body),
  );
  route(
    app,
    {
      method: 'delete',
      path: '/projects/{key}/customer-groups/{id}/members/{requester}',
      tags,
      summary: 'Take a requester out of a group',
      description: `${managers} Their domain may still put them in a group.`,
      params: KeyId.extend({ requester: z.string().min(1).max(40) }),
      status: 204,
    },
    async ({ ctx, params }) => {
      await removeGroupMember(ctx, params.key, params.id, params.requester);
      return null;
    },
  );
  route(
    app,
    {
      method: 'patch',
      path: '/issues/{id}/request',
      tags,
      summary: "Change a request's customer group, or keep it from the group",
      description:
        "Someone who may change the project's issues; in the request's history, as any change. A request that comes into a group with dedicated agents goes to one of them, unless someone chose its assignee.",
      params: z.object({ id: z.string().min(1).max(40) }),
      body: RequestUpdateBody,
      response: HelpdeskRequestSchema,
    },
    ({ ctx, params, body }) => updateRequest(ctx, params.id, body),
  );
}
