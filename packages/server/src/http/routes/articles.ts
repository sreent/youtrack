import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  ArticleDetailSchema,
  ArticleListQuery,
  ArticleRefSchema,
  ArticleSchema,
  ArticleSearchResultSchema,
  ArticleVersionDetailSchema,
  ArticleVersionSchema,
  CreateArticleBody,
  UpdateArticleBody,
} from '@a4a/shared';
import { z } from 'zod';
import {
  articlesMentioningIssue,
  articleTree,
  createArticle,
  deleteArticle,
  getArticle,
  getArticleVersion,
  listArticleVersions,
  restoreArticleVersion,
  searchArticles,
  updateArticle,
} from '../../services/articles';
import type { HttpEnv } from '../env';
import { route } from '../route';

const tags = ['Knowledge base'];
const Id = z.object({ id: z.string().describe('Readable id (BACK-A-3) or internal id') });
const Version = Id.extend({ version: z.coerce.number().int().min(1) });

export function articleRoutes(app: OpenAPIHono<HttpEnv>) {
  route(
    app,
    {
      method: 'get',
      path: '/articles',
      tags,
      summary: 'Search articles, or list the latest changed',
      description: 'Words are found in titles (first) and bodies, by full-text search with near misses on titles. Without `query`, the articles changed most recently come first.',
      query: ArticleListQuery,
      response: ArticleSearchResultSchema,
    },
    ({ ctx, query }) => searchArticles(ctx, query),
  );
  route(
    app,
    {
      method: 'get',
      path: '/projects/{key}/articles',
      tags,
      summary: "A project's knowledge base as a tree",
      description: 'Every article, flat, in reading order: each one, then those under it. `parent` and `position` say where each sits.',
      params: z.object({ key: z.string() }),
      response: z.array(ArticleSchema),
    },
    ({ ctx, params }) => articleTree(ctx, params.key),
  );
  route(
    app,
    {
      method: 'post',
      path: '/articles',
      tags,
      summary: 'Write an article',
      description: 'Markdown. Ids written in it (BACK-12, BACK-A-3) become links, and the article shows up under "mentioned in" on what it names.',
      body: CreateArticleBody,
      response: ArticleDetailSchema,
    },
    ({ ctx, body }) => createArticle(ctx, body),
  );
  route(app, { method: 'get', path: '/articles/{id}', tags, summary: 'An article, where it sits, and what mentions it', params: Id, response: ArticleDetailSchema }, ({ ctx, params }) =>
    getArticle(ctx, params.id),
  );
  route(
    app,
    {
      method: 'patch',
      path: '/articles/{id}',
      tags,
      summary: 'Change or move an article',
      description:
        'A new title or body is saved as a new version. `parent` and `position` move it within its project; a move under one of its own descendants is refused. Send `expectedVersion` to get 409 rather than overwrite a newer save.',
      params: Id,
      body: UpdateArticleBody,
      response: ArticleDetailSchema,
    },
    ({ ctx, params, body }) => updateArticle(ctx, params.id, body),
  );
  route(app, { method: 'delete', path: '/articles/{id}', tags, summary: 'Delete an article that has none under it', params: Id, status: 204 }, async ({ ctx, params }) => {
    await deleteArticle(ctx, params.id);
    return null;
  });
  route(app, { method: 'get', path: '/articles/{id}/versions', tags, summary: 'Every saved version, newest first', params: Id, response: z.array(ArticleVersionSchema) }, ({ ctx, params }) =>
    listArticleVersions(ctx, params.id),
  );
  route(
    app,
    { method: 'get', path: '/articles/{id}/versions/{version}', tags, summary: 'One version in full, and its lines against the one before', params: Version, response: ArticleVersionDetailSchema },
    ({ ctx, params }) => getArticleVersion(ctx, params.id, params.version),
  );
  route(
    app,
    {
      method: 'post',
      path: '/articles/{id}/versions/{version}/restore',
      tags,
      summary: 'Bring a version back, as a new version',
      params: Version,
      body: z.object({ expectedVersion: z.number().int().optional() }),
      response: ArticleDetailSchema,
      status: 200,
    },
    ({ ctx, params, body }) => restoreArticleVersion(ctx, params.id, params.version, body.expectedVersion),
  );
  route(
    app,
    { method: 'get', path: '/issues/{id}/articles', tags, summary: 'Articles that mention an issue', params: z.object({ id: z.string() }), response: z.array(ArticleRefSchema) },
    ({ ctx, params }) => articlesMentioningIssue(ctx, params.id),
  );
}
