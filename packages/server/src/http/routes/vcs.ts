import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  IssueVcsSchema,
  UpdateVcsIntegrationBody,
  VcsDeliverySchema,
  VcsIntegrationBody,
  VcsIntegrationCreatedSchema,
  VcsIntegrationSchema,
  VcsTestResultSchema,
} from '@a4a/shared';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  createIntegration,
  deleteIntegration,
  listIntegrations,
  listVcsDeliveries,
  rotateIntegrationSecret,
  testIntegration,
  updateIntegration,
} from '../../vcs/integrations';
import { issueVcs } from '../../vcs/links';
import { MAX_BODY, receive } from '../../vcs/receive';
import type { HttpEnv } from '../env';
import { clientIp, errorBody } from '../middleware';
import { route } from '../route';

const Id = z.object({ id: z.string() });

export function vcsRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Version control'];
  route(app, { method: 'get', path: '/vcs/integrations', tags, summary: 'GitHub and GitLab integrations (admin)', response: z.array(VcsIntegrationSchema) }, ({ ctx }) => listIntegrations(ctx));
  route(
    app,
    {
      method: 'post',
      path: '/vcs/integrations',
      tags,
      summary: 'Add a GitHub or GitLab integration (admin)',
      description:
        'Returns the webhook URL to give the provider, and a secret, shown only once: in GitHub it is the webhook\'s secret, in GitLab its secret token. Send pushes and pull (merge) requests. A commit message that mentions `BACK-12` links the commit to it; `BACK-12 #Fixed` also applies the command after `#`, as the a4a person whose verified email wrote the commit, if they can change the project\'s issues.',
      body: VcsIntegrationBody,
      response: VcsIntegrationCreatedSchema,
    },
    ({ ctx, body }) => createIntegration(ctx, body),
  );
  route(app, { method: 'patch', path: '/vcs/integrations/{id}', tags, summary: 'Rename, re-scope or pause an integration (admin)', params: Id, body: UpdateVcsIntegrationBody, response: VcsIntegrationSchema }, ({ ctx, params, body }) =>
    updateIntegration(ctx, params.id, body),
  );
  route(app, { method: 'delete', path: '/vcs/integrations/{id}', tags, summary: 'Remove an integration (admin); its links stay on their issues', params: Id, status: 204 }, async ({ ctx, params }) => {
    await deleteIntegration(ctx, params.id);
    return null;
  });
  route(
    app,
    { method: 'post', path: '/vcs/integrations/{id}/secret', tags, summary: 'Give an integration a new secret, shown once (admin)', description: 'The old secret stops working at once.', params: Id, response: VcsIntegrationCreatedSchema, status: 200 },
    ({ ctx, params }) => rotateIntegrationSecret(ctx, params.id),
  );
  route(
    app,
    {
      method: 'get',
      path: '/vcs/integrations/{id}/deliveries',
      tags,
      summary: 'Recent deliveries, refused ones included (admin)',
      params: Id,
      query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
      response: z.array(VcsDeliverySchema),
    },
    ({ ctx, params, query }) => listVcsDeliveries(ctx, params.id, query.limit),
  );
  route(
    app,
    {
      method: 'post',
      path: '/vcs/integrations/{id}/test',
      tags,
      summary: 'Send a test delivery (admin)',
      description: 'a4a sends itself a delivery as the provider would, and handles it as any other: for GitHub a signed ping; for GitLab a push with no commits.',
      params: Id,
      response: VcsTestResultSchema,
      status: 200,
    },
    ({ ctx, params }) => testIntegration(ctx, params.id),
  );

  // The provider's deliveries. The raw body is read here, unparsed: GitHub signs its exact bytes.
  app.use('/vcs/hooks/*', bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json(errorBody('too_large', 'The delivery is too large', `a4a reads deliveries up to ${MAX_BODY / 1024 / 1024} MB.`), 413) }));
  route(
    app,
    {
      method: 'post',
      path: '/vcs/hooks/{id}',
      tags,
      summary: 'Where GitHub and GitLab send deliveries',
      description:
        'Checked with `X-Hub-Signature-256` (GitHub, an HMAC-SHA256 of the raw body) or `X-Gitlab-Token` (GitLab), in constant time. Each delivery id (`X-GitHub-Delivery`; GitLab\'s `Idempotency-Key`, else `X-Gitlab-Event-UUID`) is handled once: one sent again is answered as a duplicate. Rate-limited per integration.',
      params: Id,
      auth: 'none',
      status: 200,
    },
    async ({ c, params }) => {
      const body = new Uint8Array(await c.req.arrayBuffer());
      const answer = await receive(c.get('runtime'), params.id, { header: (n) => c.req.header(n), body, ip: clientIp(c) });
      if (answer.retryAfter) c.header('retry-after', String(answer.retryAfter));
      return c.json(answer.body, answer.status as 200);
    },
  );

  route(app, { method: 'get', path: '/issues/{id}/vcs', tags, summary: "An issue's commits and pull requests", params: Id, response: IssueVcsSchema }, ({ ctx, params }) => issueVcs(ctx, params.id));
}
