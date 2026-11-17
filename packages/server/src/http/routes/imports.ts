import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  ErrorSchema,
  ImportCheckSchema,
  ImportFetchBody,
  ImportFromApiBody,
  ImportMappingBody,
  ImportRowSchema,
  ImportRowsQuery,
  ImportRunBody,
  ImportSchema,
  ImportUndoBody,
  ImportUndoSchema,
  ImportUploadQuery,
  paginated,
} from '@a4a/shared';
import type { Context } from 'hono';
import { z } from 'zod';
import { asSentence, badRequest, unauthorized } from '../../lib/errors';
import { continueFetch, importFromApi } from '../../services/api-imports';
import { checkImport, deleteImport, getImport, importRowsOf, listImports, runImport, undoImport, updateMapping, uploadImport } from '../../services/imports';
import type { HttpEnv } from '../env';
import { route } from '../route';

const Id = z.object({ id: z.string() });
const ImportRowList = paginated(ImportRowSchema, 'ImportRowList');

export function importRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Imports'];
  const errors = { 'application/json': { schema: ErrorSchema } };

  // The file is the body itself, read as it arrives (route() takes JSON bodies only).
  const upload = createRoute({
    method: 'post',
    path: '/imports',
    tags,
    summary: 'Upload a CSV export (Jira or YouTrack) to import into a project',
    description:
      'Send the file as the body with Content-Type: text/csv. It is read as it streams, up to 64 MB and 50,000 rows, and its columns are mapped from their headers. Nothing is imported yet: check the mapping, then POST /imports/{id}/check and /run. For the project\'s managers, and administrators.',
    security: [{ bearerAuth: [] }, { cookieAuth: [] }],
    request: {
      query: ImportUploadQuery,
      body: { content: { 'text/csv': { schema: z.string().describe('The CSV file, UTF-8') } }, required: true },
    },
    responses: {
      201: { description: 'Uploaded, with the mapping found', content: { 'application/json': { schema: ImportSchema } } },
      400: { description: 'The file can\'t be read: the error says where', content: errors },
      401: { description: 'Not signed in', content: errors },
      403: { description: 'Not a manager of the project', content: errors },
      404: { description: 'No such project', content: errors },
    },
  });
  (app as unknown as { openapi: (r: unknown, h: (c: Context<HttpEnv>) => Promise<Response>) => void }).openapi(upload, async (c) => {
    const ctx = c.get('ctx');
    if (!ctx) throw unauthorized('Sign in, or send "Authorization: Bearer <token>"', 'Create a token under Agents and tokens.').said('access.signInOrToken');
    const query = ImportUploadQuery.safeParse(c.req.query());
    if (!query.success) throw badRequest(`Invalid request: ${query.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`).said('imports.invalidQuery', { issues: asSentence(query.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')) });
    const type = c.req.header('content-type') ?? '';
    if (type && !/^(text\/csv|text\/plain|application\/octet-stream|application\/vnd\.ms-excel)\b/i.test(type)) {
      throw badRequest(`The file was sent as ${type.split(';')[0]}`, 'Send the CSV itself as the body, with Content-Type: text/csv.').said('imports.wrongType', { type: type.split(';')[0] });
    }
    const result = await uploadImport(ctx, query.data, c.req.raw.body);
    return c.json(result, 201);
  });

  route(
    app,
    {
      method: 'post',
      path: '/imports/from-api',
      tags,
      summary: "Read issues from YouTrack's or Jira's API, to import into a project",
      description:
        "The token is tried and the query counted first, so a wrong address, token or query says so at once. Then the issues the query matches are read as a job (status fetching; follow it with GET /imports/{id}): their fields, links and tags as the columns an export would have, and their comments, work items and files beside them. The address must be https and public (an administrator may allow hosts inside the network: IMPORT_ALLOW_HOSTS). The token is used and not kept: running the import asks for it again when files are to come. Issues and comments only some people may see there are left out. Then map, check and run it as an upload. For the project's managers, and administrators.",
      body: ImportFromApiBody,
      response: ImportSchema,
      status: 202,
    },
    ({ ctx, body }) => importFromApi(ctx, body),
  );
  route(
    app,
    {
      method: 'post',
      path: '/imports/{id}/fetch',
      tags,
      summary: 'Carry on reading an import from an API that stopped, with the token again',
      description: 'From the page it stopped at: nothing is read twice.',
      params: Id,
      body: ImportFetchBody,
      response: ImportSchema,
      status: 202,
    },
    ({ ctx, params, body }) => continueFetch(ctx, params.id, body.credentials),
  );
  route(app, { method: 'get', path: '/imports', tags, summary: 'Imports, newest first', query: z.object({ project: z.string().optional() }), response: z.array(ImportSchema) }, ({ ctx, query }) =>
    listImports(ctx, query.project),
  );
  route(app, { method: 'get', path: '/imports/{id}', tags, summary: 'An import: its columns, its value maps, how its run is going, and what it did', params: Id, response: ImportSchema }, ({ ctx, params }) =>
    getImport(ctx, params.id),
  );
  route(
    app,
    {
      method: 'put',
      path: '/imports/{id}/mapping',
      tags,
      summary: 'Map columns to fields, and values to a4a\'s',
      description:
        'Columns by index to a target: summary, description, key, external-id, parent, created, updated, resolved, reporter, tags, comment, spent, sprint, field:<name>, link:<phrase> or ignore. Values by target: each value in the file to an a4a value, a login or a sprint id, or null to leave it empty.',
      params: Id,
      body: ImportMappingBody,
      response: ImportSchema,
    },
    ({ ctx, params, body }) => updateMapping(ctx, params.id, body),
  );
  route(
    app,
    {
      method: 'post',
      path: '/imports/{id}/check',
      tags,
      summary: 'Dry run: what the import would create and update, and the problems row by row. Nothing changes.',
      params: Id,
      response: ImportCheckSchema,
      status: 200,
    },
    ({ ctx, params }) => checkImport(ctx, params.id),
  );
  route(
    app,
    {
      method: 'post',
      path: '/imports/{id}/run',
      tags,
      summary: 'Run the import as a job; follow it with GET /imports/{id}',
      description:
        "Each row becomes an issue with its original created and updated dates and reporter, recorded in its history as imported, with its comments; links and parents follow in a second pass. Running it again updates what changed in the export since, and never makes an issue twice: an issue is known by its key there. An import from an API that brings files takes the token again (credentials), to download them as it runs; a4a doesn't keep it.",
      params: Id,
      body: ImportRunBody,
      bodyOptional: true,
      response: ImportSchema,
      status: 202,
    },
    ({ ctx, params, body }) => runImport(ctx, params.id, { credentials: body?.credentials }),
  );
  route(app, { method: 'get', path: '/imports/{id}/rows', tags, summary: 'What each row became, with its problems', params: Id, query: ImportRowsQuery, response: ImportRowList }, ({ ctx, params, query }) =>
    importRowsOf(ctx, params.id, query),
  );
  route(
    app,
    {
      method: 'post',
      path: '/imports/{id}/undo',
      tags,
      summary: 'Take an import back: the issues it created go, unless someone has worked on them since',
      description: 'dryRun (the default) says what would go and what stays. Changes it made to issues that existed before stay: undoing those would write old values over what happened since.',
      params: Id,
      body: ImportUndoBody,
      response: ImportUndoSchema,
      status: 200,
    },
    ({ ctx, params, body }) => undoImport(ctx, params.id, body),
  );
  route(app, { method: 'delete', path: '/imports/{id}', tags, summary: 'Forget an upload (the issues it made stay)', params: Id, status: 204 }, async ({ ctx, params }) => {
    await deleteImport(ctx, params.id);
    return null;
  });
}
