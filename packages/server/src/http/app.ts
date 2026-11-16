import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { OpenAPIHono } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import { APP_NAME } from '@a4a/shared';
import { Hono } from 'hono';
import type { Runtime } from '../app-services';
import { handleMcp } from '../mcp/http';
import { SESSION_COOKIE } from '../services/auth';
import type { HttpEnv } from './env';
import { authenticate, csrfGuard, errorBody, idempotency, rateLimit, RateLimiter, securityHeaders, toErrorResponse } from './middleware';
import { aiRoutes } from './routes/ai';
import { authRoutes } from './routes/auth';
import { boardRoutes } from './routes/boards';
import { coreRoutes } from './routes/core';
import { eventRoutes } from './routes/events';
import { issueRoutes } from './routes/issues';
import { planningRoutes } from './routes/planning';
import { accessRoutes } from './routes/access';
import { ssoRoutes } from './routes/sso';
import { dashboardRoutes } from './routes/dashboards';
import { importRoutes } from './routes/imports';
import { reportRoutes } from './routes/reports';

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
  coreRoutes(api);
  issueRoutes(api);
  boardRoutes(api);
  eventRoutes(api);
  planningRoutes(api);
  aiRoutes(api);
  accessRoutes(api);
  ssoRoutes(api);
  reportRoutes(api);
  dashboardRoutes(api);
  importRoutes(api);

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
  root.use('/api/*', csrfGuard(runtime.config.publicUrl));
  root.use('/api/*', rateLimit(new RateLimiter(runtime.config.apiRateLimit, 60_000), runtime.config.trustProxy));
  root.use('/mcp', rateLimit(new RateLimiter(runtime.config.mcpRateLimit, 60_000), runtime.config.trustProxy));
  root.use('/api/*', idempotency(runtime));

  root.route('/api/v1', api);

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
    root.use('*', serveStatic({ root: path.relative(process.cwd(), dist) || '.' }));
    root.get('*', (c) => c.html(index()));
  } else {
    root.get('/', (c) =>
      c.text(`${APP_NAME} API is running. The web UI is not built: run "pnpm build", or "pnpm dev" for development. API docs: /api/docs`),
    );
  }
  return root;
}
