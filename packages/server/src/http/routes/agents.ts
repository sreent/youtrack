import type { OpenAPIHono } from '@hono/zod-openapi';
import { AgentAccountSchema, ApiTokenCreatedSchema, CreateTokenBody, UndoResultSchema } from '@a4a/shared';
import { z } from 'zod';
import { badRequest } from '../../lib/errors';
import { issueAgentToken, listAgents, revokeAgentToken, undoAgentChange } from '../../services/agents';
import type { HttpEnv } from '../env';
import { route } from '../route';

/** Agents acting as themselves (docs/architecture.md, D34): their tokens, and undoing what they did. */
export function agentRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Agents'];
  route(
    app,
    {
      method: 'get',
      path: '/agents',
      tags,
      summary: 'Agents administrators added, each with its tokens (admin)',
      description:
        "An agent is a bot account. With a token issued to it, a tool acts as the agent itself: its changes are its own, under its name, and `me` is the agent. a4a's own agents (triage, workflow, helpdesk) aren't listed: they take no tokens.",
      response: z.array(AgentAccountSchema),
    },
    ({ ctx }) => listAgents(ctx),
  );
  route(
    app,
    {
      method: 'post',
      path: '/users/{id}/tokens',
      tags,
      summary: 'Issue a token to an agent (admin; the secret is returned once)',
      description:
        "For an agent's account only: a person makes their own tokens, and an agent never makes its own. Scopes stay within the agent's role. `projects` limits the token to projects the agent can see.",
      params: z.object({ id: z.string().describe('The agent, by id or login') }),
      body: CreateTokenBody,
      response: ApiTokenCreatedSchema,
    },
    async ({ ctx, params, body }) => {
      if (!body.scopes.length) throw badRequest('Choose at least one scope').said('tokens.scopeNeeded');
      return issueAgentToken(ctx, params.id, body);
    },
  );
  route(
    app,
    {
      method: 'delete',
      path: '/users/{id}/tokens/{tokenId}',
      tags,
      summary: "Revoke an agent's token (admin)",
      params: z.object({ id: z.string(), tokenId: z.string() }),
      status: 204,
    },
    async ({ ctx, params }) => {
      await revokeAgentToken(ctx, params.id, params.tokenId);
      return null;
    },
  );
  route(
    app,
    {
      method: 'post',
      path: '/events/{id}/undo',
      tags: ['Issues'],
      summary: 'Undo a change an agent made on its own',
      description:
        "As the person asking, who must be able to change the issue. Fields, the summary, the description, tags and links go back as they were, all or none: if anything the agent changed has changed since, nothing is undone (409 `changed_since`, with what changed). The undo's events say which they undo (`data.undoes`); a change is undone once (409 `already_undone`). Comments aren't undone: delete one as any comment. Agents can't undo.",
      params: z.object({ id: z.coerce.number().int().describe("The change's event id, from the issue's history") }),
      response: UndoResultSchema,
      status: 200,
    },
    ({ ctx, params }) => undoAgentChange(ctx, params.id),
  );
}
