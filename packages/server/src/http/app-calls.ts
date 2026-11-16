/**
 * Calls a widget asks a4a's page to make (docs/architecture.md, D48). The page sends them with
 * `x-a4a-app: <name>` (and `x-a4a-widget`), as the person signed in. Here, before any route:
 *
 * - only from a4a's own page (a session; the CSRF guard has checked its origin), for an app that
 *   is installed and on;
 * - only to what a widget may call, each call needing a part of what the app was granted (and the
 *   widget said it uses): reading issues, writing comments… Anything else is refused;
 * - as the person, narrowed: to the projects the app runs in, to the scopes its grant allows, and
 *   recorded as through the app.
 *
 * The page checks the same before it asks; this is the server's word on it.
 */
import type { MiddlewareHandler } from 'hono';
import type { Runtime } from '../app-services';
import { granted, throughApp } from '../apps/actor';
import type { Manifest } from '../apps/package';
import type { HttpEnv } from './env';
import { errorBody } from './middleware';

type Need = 'any' | 'own' | `${'issues' | 'comments' | 'articles' | 'fields' | 'time'}:${'read' | 'write'}`;

const ID = '[^/]+';
const CALLS: { method: string; path: RegExp; need: Need }[] = [
  { method: 'GET', path: /^\/me$/, need: 'any' },
  { method: 'GET', path: new RegExp(`^/projects/${ID}$`), need: 'any' },
  { method: 'GET', path: /^\/issues$/, need: 'issues:read' },
  { method: 'POST', path: /^\/search\/count$/, need: 'issues:read' },
  { method: 'GET', path: new RegExp(`^/issues/${ID}$`), need: 'issues:read' },
  { method: 'GET', path: new RegExp(`^/issues/${ID}/(links|activity)$`), need: 'issues:read' },
  { method: 'POST', path: /^\/issues$/, need: 'issues:write' },
  { method: 'PATCH', path: new RegExp(`^/issues/${ID}$`), need: 'issues:write' },
  { method: 'POST', path: /^\/commands$/, need: 'issues:write' },
  { method: 'GET', path: new RegExp(`^/issues/${ID}/comments$`), need: 'comments:read' },
  { method: 'POST', path: new RegExp(`^/issues/${ID}/comments$`), need: 'comments:write' },
  { method: 'GET', path: new RegExp(`^/issues/${ID}/work-items$`), need: 'time:read' },
  { method: 'POST', path: new RegExp(`^/issues/${ID}/work-items$`), need: 'time:write' },
  { method: 'GET', path: new RegExp(`^/articles/${ID}$`), need: 'articles:read' },
  { method: 'GET', path: new RegExp(`^/issues/${ID}/articles$`), need: 'articles:read' },
  { method: 'POST', path: /^\/articles$/, need: 'articles:write' },
  { method: 'PATCH', path: new RegExp(`^/articles/${ID}$`), need: 'articles:write' },
  { method: 'GET', path: /^\/fields$/, need: 'fields:read' },
  { method: 'GET', path: new RegExp(`^/projects/${ID}/fields$`), need: 'fields:read' },
  { method: 'POST', path: new RegExp(`^/fields/${ID}/values$`), need: 'fields:write' },
];

/** What a call through an app needs, or null when a widget may not make it. */
export function needOf(method: string, path: string, app: string): Need | null {
  const own = new RegExp(`^/apps/${app.replace(/[^a-z0-9-]/g, '')}/(handlers/${ID}|storage(/${ID})?)$`);
  if (own.test(path) && ['GET', 'POST', 'PUT', 'DELETE'].includes(method)) return 'own';
  return CALLS.find((c) => c.method === method && c.path.test(path))?.need ?? null;
}

const refuse = (message: string, hint: string) => errorBody('forbidden', message, hint);

export function appCallGuard(runtime: Runtime): MiddlewareHandler<HttpEnv> {
  return async (c, next) => {
    const name = c.req.header('x-a4a-app')?.trim().toLowerCase();
    if (!name) return next();
    const ctx = c.get('ctx');
    if (!ctx || ctx.actor.authMethod !== 'session' || ctx.actor.guest) {
      return c.json(refuse('A call through an app comes from a4a’s page, for the person signed in', 'Widgets ask the page around them; a token calls the API itself.'), 403);
    }
    const s = await runtime.schema.get();
    const a = [...s.apps.values()].find((x) => x.name === name);
    if (!a || !a.enabled) return c.json(refuse(`No app ${name} is on here`, 'An administrator installs apps and turns them on.'), 403);
    const path = c.req.path.replace(/^\/api\/v1/, '');
    const need = needOf(c.req.method, path, a.name);
    if (!need) return c.json(refuse(`The ${a.title} app can't call ${c.req.method} ${path}`, 'A widget reads and writes issues, comments, articles, fields and time, its own handlers and its own storage.'), 403);
    if (need !== 'own') {
      const ok = need === 'any' ? a.granted.read.length + a.granted.write.length > 0 : granted(a, need);
      if (!ok) return c.json(refuse(`The ${a.title} app wasn't granted that: it would ${need.replace(':', ' ').replace(/^(\w+) (\w+)$/, '$2 $1')}`, 'An administrator grants what an app asks for when installing it.'), 403);
      // And the widget asking said it uses it.
      const widget = c.req.header('x-a4a-widget')?.trim();
      if (widget && need !== 'any') {
        const [row] = await runtime.db.execute(sqlManifest(a.id)).then((r) => (r as unknown as { rows: { manifest: Manifest }[] }).rows);
        const w = row?.manifest.widgets.find((x) => x.name === widget);
        const [resource, how] = need.split(':') as [string, 'read' | 'write'];
        if (!w || !(w.uses[how] as string[]).includes(resource)) {
          return c.json(refuse(`The ${a.title} app's widget ${widget} doesn't say it uses that`, 'Each widget calls only what its manifest says it uses.'), 403);
        }
      }
    }
    c.set('ctx', throughApp(ctx, s, a));
    return next();
  };
}

import { sql } from 'drizzle-orm';
const sqlManifest = (id: string) => sql`SELECT manifest FROM apps WHERE id = ${id}`;
