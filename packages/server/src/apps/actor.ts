/**
 * Who acts when an app does (docs/architecture.md, D48).
 *
 * - Its agent, as itself: what its rules do. It reads and writes what its grant gives it, in the
 *   projects it runs in, and nowhere else (services/access.ts gives the view).
 * - A person, through it: what a widget asks for them, or a handler they call. Their own access,
 *   narrowed to the projects the app runs in and to what it was granted: an app never shows or does
 *   for a person what they couldn't themselves. History says it came through the app.
 */
import type { Scope } from '@a4a/shared';
import type { AppServices, Ctx, UserRow } from '../context';
import { appProjectIds, type AppRow, type SchemaSnapshot } from '../services/schema-cache';

const appScopes = (row: AppRow): Scope[] => (row.granted.write.length ? ['read', 'write'] : ['read']);

/** The app's agent, acting as itself in one project (a rule's issue) or in every project it runs in. */
export function appAgentCtx(app: AppServices, s: SchemaSnapshot, row: AppRow, agent: UserRow, projectId?: string): Ctx {
  const runsIn = appProjectIds(s, row);
  return {
    app,
    db: app.db,
    actor: {
      user: agent,
      scopes: appScopes(row),
      channel: 'app',
      tokenId: null,
      tokenName: row.title,
      authMethod: 'system',
      projectIds: projectId ? runsIn.filter((id) => id === projectId) : runsIn,
      app: { id: row.id, name: row.name, title: row.title, granted: row.granted, agent: true, projectIds: runsIn },
    },
  };
}

/** A person acting through the app: their access, within the projects it runs in and what it was granted. */
export function throughApp(ctx: Ctx, s: SchemaSnapshot, row: AppRow): Ctx {
  const runsIn = appProjectIds(s, row);
  const mine = ctx.actor.projectIds;
  const allowed = appScopes(row);
  return {
    ...ctx,
    actor: {
      ...ctx.actor,
      scopes: ctx.actor.scopes.filter((sc) => allowed.includes(sc)),
      projectIds: mine ? runsIn.filter((id) => mine.includes(id)) : runsIn,
      channel: 'app',
      tokenName: row.title,
      app: { id: row.id, name: row.name, title: row.title, granted: row.granted, agent: false, projectIds: runsIn },
    },
  };
}

/** Whether the app was granted reading (or writing) something. */
export function granted(row: { granted: { read: string[]; write: string[] } }, need: string): boolean {
  const [resource, how] = need.split(':') as [string, 'read' | 'write'];
  // Writing doesn't give reading: an app reads only what it said it reads.
  return how === 'write' ? row.granted.write.includes(resource) : row.granted.read.includes(resource);
}
