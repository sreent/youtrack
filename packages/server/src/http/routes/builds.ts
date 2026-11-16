import type { OpenAPIHono } from '@hono/zod-openapi';
import { BuildSchema, BuildSourceBody, BuildSourceCreatedSchema, BuildSourceSchema, IssueBuildSchema, UpdateBuildSourceBody } from '@a4a/shared';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { createBuildSource, deleteBuildSource, issueBuilds, listBuilds, listBuildSources, receiveBuild, rotateBuildToken, updateBuildSource } from '../../ci/builds';
import type { HttpEnv } from '../env';
import { clientIp, errorBody } from '../middleware';
import { route } from '../route';

const Id = z.object({ id: z.string() });
const MAX_BUILD_BODY = 1024 * 1024;

/** CI builds (docs/architecture.md, D46): where they come from, what each did, and where a CI posts them. */
export function buildRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Builds'];
  route(app, { method: 'get', path: '/build-sources', tags, summary: 'Where builds come from (admin)', response: z.array(BuildSourceSchema) }, ({ ctx }) => listBuildSources(ctx));
  route(
    app,
    {
      method: 'post',
      path: '/build-sources',
      tags,
      summary: "Take a project's builds from CI (admin)",
      description:
        "`github`: a GitHub integration's `workflow_run` deliveries, signed as its pushes are: a run of the chosen workflow on the chosen branch that finishes is a build. `generic`: any CI posts each build to the source's `hookUrl` with the `token` returned here, shown only once. A successful build goes in the project's build field, and the resolved issues its commits name get it.",
      body: BuildSourceBody,
      response: BuildSourceCreatedSchema,
    },
    ({ ctx, body }) => createBuildSource(ctx, body),
  );
  route(app, { method: 'patch', path: '/build-sources/{id}', tags, summary: 'Rename, re-point or pause a build source (admin)', params: Id, body: UpdateBuildSourceBody, response: BuildSourceSchema }, ({ ctx, params, body }) =>
    updateBuildSource(ctx, params.id, body),
  );
  route(app, { method: 'delete', path: '/build-sources/{id}', tags, summary: 'Remove a build source (admin); its builds stay', params: Id, status: 204 }, async ({ ctx, params }) => {
    await deleteBuildSource(ctx, params.id);
    return null;
  });
  route(
    app,
    { method: 'post', path: '/build-sources/{id}/token', tags, summary: "Give a CI's build source a new token, shown once (admin)", description: 'The old token stops working at once.', params: Id, response: BuildSourceCreatedSchema, status: 200 },
    ({ ctx, params }) => rotateBuildToken(ctx, params.id),
  );

  // A CI's builds. The raw body is read here, so a refusal says what was wrong with it.
  app.use('/builds/hooks/*', bodyLimit({ maxSize: MAX_BUILD_BODY, onError: (c) => c.json(errorBody('too_large', 'The build is too large', 'Send the commits since the last build.'), 413) }));
  route(
    app,
    {
      method: 'post',
      path: '/builds/hooks/{id}',
      tags,
      summary: 'Where a CI posts a build',
      description:
        "With the source's token as `Authorization: Bearer <token>`. The body is a build: its number or name (`build`), `status` (success, failure or cancelled), `url`, `branch`, `repository`, and the commits it holds since the last build: `commits` (shas, or `{ sha, message }`, whose messages are read for issue ids too) or `range` (`{ from, to }`, which a4a asks GitHub about with the access token of a GitHub integration of the repository). The same build posted again is the same build: what it holds now is added. The answer gives counts, never issue ids.",
      params: Id,
      auth: 'none',
      status: 200,
    },
    async ({ c, params }) => {
      const body = new Uint8Array(await c.req.arrayBuffer());
      const answer = await receiveBuild(c.get('runtime'), params.id, { header: (n) => c.req.header(n), body, ip: clientIp(c, c.get('runtime').config.trustProxy) });
      if (answer.retryAfter) c.header('retry-after', String(answer.retryAfter));
      return c.json(answer.body, answer.status as 200);
    },
  );

  route(
    app,
    {
      method: 'get',
      path: '/projects/{key}/builds',
      tags,
      summary: "A project's builds, newest first, with what each did to the issues its commits name",
      params: z.object({ key: z.string() }),
      query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(30) }),
      response: z.array(BuildSchema),
    },
    ({ ctx, params, query }) => listBuilds(ctx, params.key, { limit: query.limit }),
  );
  route(app, { method: 'get', path: '/issues/{id}/builds', tags, summary: 'The builds an issue is in: the one that marked it fixed, and any that found it open', params: Id, response: z.array(IssueBuildSchema) }, ({ ctx, params }) => issueBuilds(ctx, params.id));
}
