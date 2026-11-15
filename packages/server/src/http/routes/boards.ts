import type { OpenAPIHono } from '@hono/zod-openapi';
import { BoardBody, BoardSchema, BoardViewSchema, SprintBody, SprintIssuesBody, SprintSchema } from '@a4a/shared';
import { z } from 'zod';
import {
  boardView,
  createBoard,
  createSprint,
  deleteBoard,
  deleteSprint,
  getBoard,
  listBoards,
  setSprintIssues,
  updateBoard,
  updateSprint,
} from '../../services/boards';
import type { HttpEnv } from '../env';
import { route } from '../route';

const Id = z.object({ id: z.string() });

export function boardRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Agile boards'];
  route(app, { method: 'get', path: '/boards', tags, summary: 'List boards', response: z.array(BoardSchema) }, ({ ctx }) => listBoards(ctx));
  route(app, { method: 'post', path: '/boards', tags, summary: 'Create a board', description: 'Columns default to one per open value of the column field, plus a Done column for resolved values.', body: BoardBody, response: BoardSchema }, ({ ctx, body }) => createBoard(ctx, body));
  route(app, { method: 'get', path: '/boards/{id}', tags, summary: 'Get a board', params: Id, response: BoardSchema }, ({ ctx, params }) => getBoard(ctx, params.id));
  route(app, { method: 'patch', path: '/boards/{id}', tags, summary: 'Change a board', params: Id, body: BoardBody.partial(), response: BoardSchema }, ({ ctx, params, body }) => updateBoard(ctx, params.id, body));
  route(app, { method: 'delete', path: '/boards/{id}', tags, summary: 'Delete a board', params: Id, status: 204 }, async ({ ctx, params }) => {
    await deleteBoard(ctx, params.id);
    return null;
  });
  route(
    app,
    {
      method: 'get',
      path: '/boards/{id}/view',
      tags,
      summary: 'The board as columns of issues (for a sprint, or the current one)',
      description: 'Move a card by changing its column field: PATCH /issues/{id} with {"fields": {"State": "In Progress"}}.',
      params: Id,
      query: z.object({ sprint: z.string().optional() }),
      response: BoardViewSchema,
    },
    ({ ctx, params, query }) => boardView(ctx, params.id, query.sprint),
  );
  route(app, { method: 'post', path: '/boards/{id}/sprints', tags, summary: 'Create a sprint', params: Id, body: SprintBody, response: SprintSchema }, ({ ctx, params, body }) => createSprint(ctx, params.id, body));
  route(app, { method: 'patch', path: '/sprints/{id}', tags, summary: 'Change a sprint', params: Id, body: SprintBody.partial(), response: SprintSchema }, ({ ctx, params, body }) => updateSprint(ctx, params.id, body));
  route(app, { method: 'delete', path: '/sprints/{id}', tags, summary: 'Delete a sprint', params: Id, status: 204 }, async ({ ctx, params }) => {
    await deleteSprint(ctx, params.id);
    return null;
  });
  route(app, { method: 'post', path: '/sprints/{id}/issues', tags, summary: 'Add issues to a sprint, or remove them', params: Id, body: SprintIssuesBody, response: SprintSchema, status: 200 }, ({ ctx, params, body }) => setSprintIssues(ctx, params.id, body.issues, body.remove));
}
