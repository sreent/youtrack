import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { OpenAPIHono } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import { APP_NAME } from '@a4a/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Runtime } from '../app-services';
import { handleMcp } from '../mcp/http';
import { SESSION_COOKIE } from '../services/auth';
import type { HttpEnv } from './env';
import { authenticate, csrfGuard, errorBody, idempotency, rateLimit, RateLimiter, securityHeaders, toErrorResponse } from './middleware';
import { aiRoutes } from './routes/ai';
import { articleRoutes } from './routes/articles';
import { attachmentRoutes } from './routes/attachments';
import { authRoutes } from './routes/auth';
import { agileRoutes } from './routes/agile';
import { twoFactorRoutes } from './routes/two-factor';
import { boardRoutes } from './routes/boards';
import { coreRoutes } from './routes/core';
import { eventRoutes } from './routes/events';
import { helpdeskRoutes } from './routes/helpdesk';
import { helpdeskMailRoutes } from './routes/helpdesk-mail';
import { helpdeskDepthRoutes, portalRoutes } from './routes/helpdesk-depth';
import { issueRoutes } from './routes/issues';
import { notificationRoutes } from './routes/notifications';
import { planningRoutes } from './routes/planning';
import { accessRoutes } from './routes/access';
import { ssoRoutes } from './routes/sso';
import { dashboardRoutes } from './routes/dashboards';
import { importRoutes } from './routes/imports';
import { reportRoutes } from './routes/reports';
import { vcsRoutes } from './routes/vcs';
import { buildRoutes } from './routes/builds';
import { codeHostRoutes } from './routes/code-hosts';
import { emailRoutes } from './routes/emails';
import { workflowRoutes } from './routes/workflow';
import { mountOAuth, oauthRoutes } from '../oauth/routes';
import { scimApp, scimTokenRoutes } from '../scim/routes';
import { absenceRoutes } from './routes/absences';
import { groupRoutes } from './routes/groups';
import { guestRoutes, roleRoutes } from './routes/roles';
import { samlRoutes } from './routes/saml';
import { agentRoutes } from './routes/agents';
import { chatRoutes } from './routes/chat';
import { pushRoutes } from './routes/push';

const API_DESCRIPTION = `The a4a REST API: everything the web UI does, for scripts and integrations.

**Authentication.** Send \`Authorization: Bearer a4a_…\` with a token from Profile → API tokens. A token's scopes (read, write, admin) narrow what it may do and never exceed its owner's role.

**Conventions.** Issues are addressed by readable ids (\`BACK-12\`). Custom fields are set by name: \`{"fields": {"Priority": "Critical", "Assignee": "anna"}}\`. Errors are \`{"error": {"code", "message", "hint"}}\`; the hint says how to fix the request. Send \`Idempotency-Key\` on POSTs to make retries safe, and \`expectedVersion\` on updates to avoid overwriting someone else's change.

**Search** with the query language: \`project: BACK #Unresolved Priority: Critical, Major for: me sort by: updated desc\`. **Change** many issues at once with commands: \`State Fixed Assignee anna tag regression\`.

**Agents** can use the same capabilities over MCP at \`/mcp\`.`;

function summarizeIssues(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join('.') || 'body'}: ${i.message}`)
    .join('; ');
}

export function createHttpApp(runtime: Runtime) {
  const api = new OpenAPIHono<HttpEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(errorBody('validation_failed', `Invalid request: ${summarizeIssues(result.error.issues)}`, undefined, result.error.issues), 400);
      }
    },
  });
  api.onError((err, c) => toErrorResponse(c, err));
  api.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', { type: 'http', scheme: 'bearer', description: 'An API token (a4a_…)' });
  api.openAPIRegistry.registerComponent('securitySchemes', 'cookieAuth', { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE });

  authRoutes(api);
  twoFactorRoutes(api);
  scimTokenRoutes(api);
  coreRoutes(api);
  issueRoutes(api);
  boardRoutes(api);
  agileRoutes(api);
  eventRoutes(api);
  planningRoutes(api);
  aiRoutes(api);
  accessRoutes(api);
  ssoRoutes(api);
  attachmentRoutes(api);
  articleRoutes(api);
  reportRoutes(api);
  dashboardRoutes(api);
  importRoutes(api);
  notificationRoutes(api);
  helpdeskRoutes(api);
  helpdeskMailRoutes(api);
  helpdeskDepthRoutes(api);
  portalRoutes(api);
  workflowRoutes(api);
  vcsRoutes(api);
  buildRoutes(api);
  codeHostRoutes(api);
  oauthRoutes(api);
  absenceRoutes(api);
  groupRoutes(api);
  roleRoutes(api);
  guestRoutes(api);
  samlRoutes(api);
  agentRoutes(api);
  emailRoutes(api);
  chatRoutes(api);
  pushRoutes(api);

  api.get('/health', async (c) => {
    let db = true;
    try {
      await runtime.db.execute('SELECT 1' as never);
    } catch {
      db = false;
    }
    // Only the database decides `ok`: without LISTEN this instance still serves, and its
    // live events fall back to polling. The rest says which instance answered and what it does.
    const signals = runtime.signals;
    return c.json(
      {
        ok: db,
        db: runtime.database.kind,
        ai: runtime.config.aiEnabled,
        instance: runtime.instanceId,
        live: signals.mode === 'local' ? 'local' : signals.listening ? 'listening' : 'reconnecting',
        worker: runtime.worker ? (runtime.worker.active ? 'active' : 'standby') : 'off',
      },
      db ? 200 : 503,
    );
  });
  api.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: { title: `${APP_NAME} API`, version: '1.0.0', description: API_DESCRIPTION },
    servers: [{ url: `${runtime.config.publicUrl}/api/v1` }],
  });

  const root = new Hono<HttpEnv>();
  root.onError((err, c) => toErrorResponse(c, err));
  root.use('*', securityHeaders());
  root.use('*', authenticate(runtime));
  // The SAML assertion consumer takes the provider's post: signed, answering a request of this browser's (D27).
  root.use('/api/*', csrfGuard(runtime.config.publicUrl, ['/api/v1/auth/saml/acs']));
  root.use('/api/*', rateLimit(new RateLimiter(runtime.config.apiRateLimit, 60_000), runtime.config.trustProxy, new RateLimiter(runtime.config.guestRateLimit, 60_000)));
  root.use('/mcp', rateLimit(new RateLimiter(runtime.config.mcpRateLimit, 60_000), runtime.config.trustProxy));
  // Provisioning (SCIM, D38): its own tokens and errors, under the API's limit.
  root.use('/scim/*', rateLimit(new RateLimiter(runtime.config.apiRateLimit, 60_000), runtime.config.trustProxy));
  // What anyone may post without signing in is small: a help desk request, a reply, an unsubscribe.
  const small = (maxSize: number) =>
    bodyLimit({ maxSize, onError: (c) => c.json(errorBody('too_large', 'The request is too large', `Send at most ${Math.round(maxSize / 1024)} KB.`), 413) });
  root.use('/api/v1/help/*', small(48 * 1024));
  root.use('/api/v1/unsubscribe', small(4 * 1024));
  root.use('/scim/*', small(1024 * 1024));
  root.use('/api/*', idempotency(runtime));

  root.route('/api/v1', api);
  root.route('/scim/v2', scimApp(runtime));

  // API reference, served without loading anything from outside.
  const require = createRequire(import.meta.url);
  let scalarBundle: string | null = null;
  root.get('/api/docs/scalar.js', (c) => {
    // The package exports only its entry (dist/index.js); the browser bundle sits beside it.
    scalarBundle ??= readFileSync(path.join(path.dirname(require.resolve('@scalar/api-reference')), 'browser', 'standalone.js'), 'utf8');
    c.header('cache-control', 'public, max-age=86400');
    return c.body(scalarBundle, 200, { 'content-type': 'application/javascript; charset=utf-8' });
  });
  root.get('/api/docs', Scalar({ url: '/api/v1/openapi.json', pageTitle: `${APP_NAME} API`, cdn: '/api/docs/scalar.js', theme: 'default' }));

  root.all('/mcp', (c) => handleMcp(c));
  mountOAuth(root, runtime);

  root.all('/api/*', (c) => c.json(errorBody('not_found', `No endpoint ${c.req.method} ${c.req.path}`, 'See /api/docs'), 404));

  const dist = runtime.config.webDist;
  if (dist) {
    // Re-read index.html when a new build replaces it, so it never points at deleted assets.
    const indexPath = path.join(dist, 'index.html');
    let indexCache = { mtime: 0, html: '' };
    const index = () => {
      const mtime = statSync(indexPath).mtimeMs;
      if (mtime !== indexCache.mtime) indexCache = { mtime, html: readFileSync(indexPath, 'utf8') };
      return indexCache.html;
    };
    root.use('/assets/*', async (c, next) => {
      await next();
      c.header('cache-control', 'public, max-age=31536000, immutable');
    });
    // The service worker and the manifest are asked for again each time (D47): a new build is
    // taken up on the next start, never a day later from a cache.
    for (const file of ['/sw.js', '/manifest.webmanifest']) {
      root.use(file, async (c, next) => {
        await next();
        c.header('cache-control', 'no-cache');
      });
    }
    root.use('*', serveStatic({ root: path.relative(process.cwd(), dist) || '.' }));
    root.get('*', (c) => c.html(index()));
  } else {
    root.get('/', (c) =>
      c.text(`${APP_NAME} API is running. The web UI is not built: run "pnpm build", or "pnpm dev" for development. API docs: /api/docs`),
    );
  }
  return root;
}
