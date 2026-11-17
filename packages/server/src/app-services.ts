import { hostname } from 'node:os';
import type { Channel } from '@a4a/shared';
import type { Config } from './config';
import { effectiveScopes, type Actor, type AppServices, type Ctx, type UserRow } from './context';
import type { Database } from './db/client';
import { ensureDefaults } from './db/defaults';
import { migrateOrganizations } from './services/customer-groups';
import { EventBus } from './events/bus';
import { LocalSignals, PgSignals, type PgSignalsOptions } from './events/signals';
import { LiveEvents, type LiveEventsOptions } from './events/sse';
import type { OutboxWorker } from './events/worker';
import { newId } from './lib/ids';
import { SchemaCache } from './services/schema-cache';

export interface Runtime extends AppServices {
  database: Database;
  live: LiveEvents;
  /** This process among the instances sharing the database (logs, health, the worker lease). */
  instanceId: string;
  /** Set once the background work runs (see startBackground). */
  worker: OutboxWorker | null;
}

export interface RuntimeOptions {
  live?: LiveEventsOptions;
  signals?: PgSignalsOptions;
}

export async function createRuntime(config: Config, database: Database, opts: RuntimeOptions = {}): Promise<Runtime> {
  // Several instances starting together on an empty database must not all create the defaults.
  await database.exclusive(() => ensureDefaults(database.db));
  // D45's organizations become customer groups (D56), once, before anything serves.
  await database.exclusive(() => migrateOrganizations(database.db));
  const instanceId = `${hostname()}-${process.pid}-${newId(4)}`;
  const listenUrl = config.databaseListenUrl || database.url;
  const signals =
    database.kind === 'postgres' && listenUrl ? new PgSignals(listenUrl, database.db, instanceId, opts.signals) : new LocalSignals(instanceId);
  const app: Runtime = {
    config,
    db: database.db,
    database,
    bus: new EventBus(),
    signals,
    schema: new SchemaCache(database.db),
    hooks: {},
    live: undefined as unknown as LiveEvents,
    instanceId,
    worker: null,
  };
  app.schema.broadcast = (tx) => signals.announceSchemaChange(tx);
  // Another instance changed reference data, or we may have missed that it did.
  signals.subscribe((s) => {
    if (s.kind === 'schema' || s.kind === 'resync') app.schema.drop();
  });
  app.live = new LiveEvents(app, opts.live);
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
