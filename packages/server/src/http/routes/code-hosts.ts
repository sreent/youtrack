import type { OpenAPIHono } from '@hono/zod-openapi';
import { CodeHostSchema, ConnectStartSchema } from '@a4a/shared';
import { z } from 'zod';
import { codeHosts, ConnectError, finishConnect, startConnect } from '../../vcs/connect';
import type { HttpEnv } from '../env';
import { route } from '../route';

const Provider = z.object({ provider: z.string() });

/** People connecting their own accounts at GitHub, GitLab, Bitbucket (docs/architecture.md, D46), and Forgejo or Gitea (D54). */
export function codeHostRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Version control'];
  route(app, { method: 'get', path: '/me/code-hosts', tags, summary: 'Where you can connect your own account', response: z.array(CodeHostSchema) }, ({ ctx }) => Promise.resolve(codeHosts(ctx.app)));
  route(
    app,
    {
      method: 'post',
      path: '/me/code-hosts/{provider}/connect',
      tags,
      summary: 'Start connecting your account at a code host',
      description:
        "Returns the provider's page to sign in at. Back from it, the account you proved yours becomes your login there, so its commits and pull requests are yours. a4a asks who you are with the token once, and doesn't keep it. From the web, signed in.",
      params: Provider,
      response: ConnectStartSchema,
      status: 200,
    },
    ({ ctx, params }) => startConnect(ctx, params.provider),
  );
  route(
    app,
    {
      method: 'get',
      path: '/auth/code-hosts/{provider}/callback',
      tags,
      summary: 'Where a code host sends the browser back (the redirect URI)',
      description: 'Register exactly `PUBLIC_URL/api/v1/auth/code-hosts/<provider>/callback` with the provider\'s OAuth app. The browser goes back to the profile, with `?connected=` or `?connect=` saying why not.',
      params: Provider,
      auth: 'none',
      status: 302,
    },
    async ({ c, params }) => {
      try {
        await finishConnect(c.get('runtime'), c.get('ctx'), params.provider, new URL(c.req.url).searchParams);
        return c.redirect(`/me?connected=${encodeURIComponent(params.provider)}#code-hosts`, 302);
      } catch (e) {
        if (e instanceof ConnectError) return c.redirect(`/me?connect=${e.failure}#code-hosts`, 302);
        console.error('code hosts: the callback failed', e instanceof Error ? e.message : e);
        return c.redirect('/me?connect=failed#code-hosts', 302);
      }
    },
  );
}
