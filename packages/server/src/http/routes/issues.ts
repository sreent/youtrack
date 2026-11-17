import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  CommandBody,
  CommandResultSchema,
  CloneIssueBody,
  CommentSchema,
  CountBody,
  CountResultSchema,
  CreateIssueBody,
  EventSchema,
  IssueDetailSchema,
  IssueLinkSchema,
  IssueListQuery,
  IssueListSchema,
  LinkBody,
  MoveIssueBody,
  MovePlanSchema,
  NewCommentBody,
  ParseQueryResultSchema,
  SavedSearchBody,
  SavedSearchSchema,
  SetVisibilityBody,
  QueryProblemSchema,
  ReactBody,
  ReactionSummarySchema,
  SuggestItemSchema,
  UpdateCommentBody,
  UpdateIssueBody,
  VoteSchema,
  WorkItemBody,
  WorkItemSchema,
  patchBody,
} from '@a4a/shared';
import { z } from 'zod';
import { parseCommandForApi, runCommand } from '../../commands/executor';
import { suggestCommand } from '../../commands/parser';
import { countIssues, parseQueryForApi, searchIssues } from '../../search/service';
import { cloneIssue, moveIssue } from '../../services/move';
import { reactToComment, reactToIssue, setVote } from '../../services/votes';
import { suggest } from '../../search/suggest';
import { issueActivity } from '../../services/activity';
import { addComment, deleteComment, listComments, setCommentVisibility, updateComment } from '../../services/comments';
import { createIssue, deleteIssue, getIssue, resolveIssue, setIssueVisibility, updateIssue } from '../../services/issues';
import { deleteLinkById, linkIssues, listLinks } from '../../services/links';
import { createSavedSearch, deleteSavedSearch, listSavedSearches, updateSavedSearch } from '../../services/saved-searches';
import { deleteWorkItem, listWorkItems, logWork } from '../../services/workitems';
import { requireScope, withChannel } from '../../context';
import { visibleSchema } from '../../services/access';
import type { HttpEnv } from '../env';
import { route } from '../route';

const Id = z.object({ id: z.string().describe('Readable id (BACK-12) or internal id') });

export function issueRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Issues'];
  route(
    app,
    {
      method: 'get',
      path: '/issues',
      tags,
      summary: 'Search issues with the query language',
      description:
        'Examples: `project: BACK #Unresolved for: me`, `Type: Bug Priority: Critical, Major sort by: updated desc`, `created: -7d .. today "login"`. Invalid queries return 400 with the problem\'s position and a hint.',
      query: IssueListQuery,
      response: IssueListSchema,
    },
    ({ ctx, query }) => searchIssues(ctx, query.query, query.offset, query.limit),
  );
  route(app, { method: 'post', path: '/issues', tags, summary: 'Create an issue', description: 'Fields are set by name; send `Idempotency-Key` to make retries safe.', body: CreateIssueBody, response: IssueDetailSchema }, ({ ctx, body }) => createIssue(ctx, body));
  route(app, { method: 'get', path: '/issues/{id}', tags, summary: 'Get an issue', params: Id, response: IssueDetailSchema }, ({ ctx, params }) => getIssue(ctx, params.id));
  route(
    app,
    {
      method: 'patch',
      path: '/issues/{id}',
      tags,
      summary: 'Update an issue',
      description: 'Only the fields you send change. Send `expectedVersion` to fail with 409 if someone changed the issue meanwhile.',
      params: Id,
      body: UpdateIssueBody,
      response: IssueDetailSchema,
    },
    ({ ctx, params, body }) => updateIssue(ctx, params.id, body),
  );
  route(app, { method: 'delete', path: '/issues/{id}', tags, summary: 'Delete an issue', params: Id, status: 204 }, async ({ ctx, params }) => {
    await deleteIssue(ctx, params.id);
    return null;
  });
  route(
    app,
    {
      method: 'put',
      path: '/issues/{id}/visibility',
      tags,
      summary: 'Limit who sees an issue',
      description:
        "Limit it to some people and groups (D37), or send `visibleTo: null` to lift the limit. Its reporter, its assignee, the project's managers and administrators always see it; to anyone else it's missing, in the same words as an issue that doesn't exist. Takes the edit permission, and you can't limit it away from yourself.",
      params: Id,
      body: SetVisibilityBody,
      response: IssueDetailSchema,
    },
    ({ ctx, params, body }) => setIssueVisibility(ctx, params.id, body),
  );
  route(app, { method: 'get', path: '/issues/{id}/activity', tags, summary: "An issue's history: who changed what, when, and through which channel", params: Id, response: z.array(EventSchema) }, ({ ctx, params }) => issueActivity(ctx, params.id));

  // Comments
  route(app, { method: 'get', path: '/issues/{id}/comments', tags: ['Comments'], summary: 'List comments', params: Id, response: z.array(CommentSchema) }, ({ ctx, params }) => listComments(ctx, params.id));
  route(
    app,
    {
      method: 'post',
      path: '/issues/{id}/comments',
      tags: ['Comments'],
      summary: 'Add a comment (Markdown)',
      description:
        '`@login` mentions a person: they are told, and watch the issue. On a help desk request, `visibility: "public"` also sends it to the requester, by email and on their tracking page; comments are internal unless you say so. `visibleTo` limits it to some people and groups (D37): its author, the project\'s managers and administrators still see it.',
      params: Id,
      body: NewCommentBody,
      response: CommentSchema,
    },
    ({ ctx, params, body }) => addComment(ctx, params.id, body.text, { visibility: body.visibility, visibleTo: body.visibleTo }),
  );
  route(app, { method: 'patch', path: '/comments/{id}', tags: ['Comments'], summary: 'Edit your comment, against the version you read', params: z.object({ id: z.string() }), body: UpdateCommentBody, response: CommentSchema }, ({ ctx, params, body }) => updateComment(ctx, params.id, body.text, body.expectedVersion));
  route(
    app,
    {
      method: 'put',
      path: '/comments/{id}/visibility',
      tags: ['Comments'],
      summary: 'Limit who sees a comment',
      description: "Its author or a manager of the project may. Send `visibleTo: null` to lift the limit. A public comment, which went to a help desk's requester, can't be limited.",
      params: z.object({ id: z.string() }),
      body: SetVisibilityBody,
      response: CommentSchema,
    },
    ({ ctx, params, body }) => setCommentVisibility(ctx, params.id, body.visibleTo),
  );
  route(app, { method: 'delete', path: '/comments/{id}', tags: ['Comments'], summary: 'Delete your comment', params: z.object({ id: z.string() }), status: 204 }, async ({ ctx, params }) => {
    await deleteComment(ctx, params.id);
    return null;
  });

  // Moving, cloning, votes and reactions (D41)
  route(
    app,
    {
      method: 'post',
      path: '/issues/{id}/move',
      tags: ['Issues'],
      summary: 'Move an issue to another project',
      description:
        "It takes the project's next number, and its old id keeps finding it. Values carry over by name; what doesn't is a problem, and nothing moves until each has a value in `fields` (or null). `dryRun` says what would happen. A move with problems left is refused with the plan in the error's details.",
      params: Id,
      body: MoveIssueBody,
      response: MovePlanSchema,
      status: 200,
    },
    ({ ctx, params, body }) => moveIssue(ctx, params.id, body),
  );
  route(
    app,
    {
      method: 'post',
      path: '/issues/{id}/clone',
      tags: ['Issues'],
      summary: 'Clone an issue',
      description: 'Its summary, description, values and tags, in its project or another, linked back ("clones") and under the same parent. Comments, files, work, votes and other links stay with the original.',
      params: Id,
      body: CloneIssueBody,
      response: IssueDetailSchema,
    },
    ({ ctx, params, body }) => cloneIssue(ctx, params.id, body),
  );
  route(app, { method: 'post', path: '/issues/{id}/vote', tags: ['Issues'], summary: 'Vote for an issue', params: Id, response: VoteSchema, status: 200 }, ({ ctx, params }) => setVote(ctx, params.id, true));
  route(app, { method: 'delete', path: '/issues/{id}/vote', tags: ['Issues'], summary: 'Take your vote back', params: Id, response: VoteSchema, status: 200 }, ({ ctx, params }) => setVote(ctx, params.id, false));
  route(
    app,
    { method: 'post', path: '/issues/{id}/reactions', tags: ['Issues'], summary: "React to an issue's description, or take the reaction back", params: Id, body: ReactBody, response: z.array(ReactionSummarySchema), status: 200 },
    ({ ctx, params, body }) => reactToIssue(ctx, params.id, body.emoji),
  );
  route(
    app,
    { method: 'post', path: '/comments/{id}/reactions', tags: ['Comments'], summary: 'React to a comment, or take the reaction back', params: z.object({ id: z.string() }), body: ReactBody, response: z.array(ReactionSummarySchema), status: 200 },
    ({ ctx, params, body }) => reactToComment(ctx, params.id, body.emoji),
  );

  // Links
  route(app, { method: 'get', path: '/issues/{id}/links', tags: ['Links'], summary: "An issue's links", params: Id, response: z.array(IssueLinkSchema) }, ({ ctx, params }) => listLinks(ctx, params.id));
  route(
    app,
    {
      method: 'post',
      path: '/issues/{id}/links',
      tags: ['Links'],
      summary: 'Link to another issue',
      description: 'The relation reads from this issue: `{"relation": "depends on", "issue": "BACK-2"}` means this issue depends on BACK-2.',
      params: Id,
      body: LinkBody,
      response: z.array(IssueLinkSchema),
    },
    ({ ctx, params, body }) => linkIssues(ctx, params.id, body.relation, body.issue),
  );
  route(app, { method: 'delete', path: '/links/{id}', tags: ['Links'], summary: 'Remove a link', params: z.object({ id: z.string() }), status: 204 }, async ({ ctx, params }) => {
    await deleteLinkById(ctx, params.id);
    return null;
  });

  // Work items
  route(app, { method: 'get', path: '/issues/{id}/work-items', tags: ['Time tracking'], summary: 'Logged work on an issue', params: Id, response: z.array(WorkItemSchema) }, ({ ctx, params }) => listWorkItems(ctx, params.id));
  route(app, { method: 'post', path: '/issues/{id}/work-items', tags: ['Time tracking'], summary: 'Log work ("1h 30m")', params: Id, body: WorkItemBody, response: WorkItemSchema }, ({ ctx, params, body }) => logWork(ctx, params.id, body));
  route(app, { method: 'delete', path: '/work-items/{id}', tags: ['Time tracking'], summary: 'Delete a work item', params: z.object({ id: z.string() }), status: 204 }, async ({ ctx, params }) => {
    await deleteWorkItem(ctx, params.id);
    return null;
  });

  // Search helpers
  const search = ['Search'];
  route(app, { method: 'post', path: '/search/parse', tags: search, summary: 'Validate a query and explain it in words', body: z.object({ query: z.string() }), response: ParseQueryResultSchema, status: 200 }, ({ ctx, body }) => {
    requireScope(ctx, 'read');
    return parseQueryForApi(ctx, body.query);
  });
  route(
    app,
    {
      method: 'get',
      path: '/search/suggest',
      tags: search,
      summary: 'Completions for the query at the caret',
      query: z.object({ query: z.string().default(''), caret: z.coerce.number().int().min(0).optional() }),
      response: z.object({ items: z.array(SuggestItemSchema) }),
    },
    async ({ ctx, query }) => {
      requireScope(ctx, 'read');
      const s = await visibleSchema(ctx);
      return { items: suggest(s, query.query, Math.min(query.caret ?? query.query.length, query.query.length)) };
    },
  );
  route(app, { method: 'post', path: '/search/count', tags: search, summary: 'Count issues matching a query, optionally grouped by a field', body: CountBody, response: CountResultSchema, status: 200 }, ({ ctx, body }) => countIssues(ctx, body.query, body.groupBy));

  // Commands
  route(
    app,
    {
      method: 'post',
      path: '/commands',
      tags: ['Commands'],
      summary: 'Apply a command to up to 50 issues (or preview it with dryRun)',
      description: 'Examples: `State Fixed`, `for me In Progress`, `Critical tag regression`, `subtask of BACK-3`, `remove tag needs-info`. With `dryRun: true` nothing changes and the result lists exactly what would.',
      body: CommandBody,
      response: CommandResultSchema.extend({ description: z.string() }),
      status: 200,
    },
    // The person applies what the assistant read from their words: record it as theirs, via the assistant.
    ({ ctx, body }) => runCommand(body.readBy === 'assistant' && ctx.actor.channel === 'web' ? withChannel(ctx, 'assistant') : ctx, body),
  );
  route(
    app,
    {
      method: 'post',
      path: '/commands/parse',
      tags: ['Commands'],
      summary: 'Check a command and get completions at the caret',
      body: z.object({ issues: z.array(z.string()).min(1).max(50), command: z.string(), caret: z.number().int().min(0).optional() }),
      response: z.object({ problems: z.array(QueryProblemSchema), description: z.string(), suggestions: z.array(SuggestItemSchema) }),
      status: 200,
    },
    async ({ ctx, body }) => {
      requireScope(ctx, 'read');
      const rows = await Promise.all(body.issues.map((id) => resolveIssue(ctx, id)));
      const projectIds = [...new Set(rows.map((r) => r.projectId))];
      const s = await visibleSchema(ctx);
      const parsed = await parseCommandForApi(ctx, body.command, projectIds);
      return { ...parsed, suggestions: suggestCommand(body.command, Math.min(body.caret ?? body.command.length, body.command.length), s, projectIds) };
    },
  );

  // Saved searches
  const saved = ['Saved searches'];
  route(app, { method: 'get', path: '/saved-searches', tags: saved, summary: 'Your saved searches and shared ones', response: z.array(SavedSearchSchema) }, ({ ctx }) => listSavedSearches(ctx));
  route(app, { method: 'post', path: '/saved-searches', tags: saved, summary: 'Save a search', body: SavedSearchBody, response: SavedSearchSchema }, ({ ctx, body }) => createSavedSearch(ctx, body));
  route(app, { method: 'patch', path: '/saved-searches/{id}', tags: saved, summary: 'Change a saved search', params: z.object({ id: z.string() }), body: patchBody(SavedSearchBody), response: SavedSearchSchema }, ({ ctx, params, body }) => updateSavedSearch(ctx, params.id, body));
  route(app, { method: 'delete', path: '/saved-searches/{id}', tags: saved, summary: 'Delete a saved search', params: z.object({ id: z.string() }), status: 204 }, async ({ ctx, params }) => {
    await deleteSavedSearch(ctx, params.id);
    return null;
  });
}
