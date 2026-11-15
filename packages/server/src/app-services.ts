import type { Channel } from '@tracklet/shared';
import type { Config } from './config';
import { effectiveScopes, type Actor, type AppServices, type Ctx, type UserRow } from './context';
import type { Database } from './db/client';
import { ensureDefaults } from './db/defaults';
import { EventBus } from './events/bus';
import { LiveEvents } from './events/sse';
import { SchemaCache } from './services/schema-cache';

export interface Runtime extends AppServices {
  database: Database;
  live: LiveEvents;
}

export async function createRuntime(config: Config, database: Database): Promise<Runtime> {
  await ensureDefaults(database.db);
  const app: Runtime = {
    config,
    db: database.db,
    database,
    bus: new EventBus(),
    schema: new SchemaCache(database.db),
    hooks: {},
    live: undefined as unknown as LiveEvents,
  };
  app.live = new LiveEvents(app);
  return app;
}

/** A context for work the server does itself (seeding, the worker), acting as `user`. */
export function systemCtx(app: AppServices, user: UserRow, channel: Channel = 'system'): Ctx {
  const actor: Actor = {
    user,
    scopes: effectiveScopes(user.role),
    channel,
    tokenId: null,
    tokenName: null,
    authMethod: 'system',
  };
  return { app, db: app.db, actor };
}

/** Elevated system context (admin scopes regardless of the user's role). */
export function adminCtx(app: AppServices, user: UserRow, channel: Channel = 'system'): Ctx {
  const ctx = systemCtx(app, user, channel);
  ctx.actor.scopes = ['read', 'write', 'admin'];
  return ctx;
}
