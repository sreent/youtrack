import { adminCtx, createRuntime, systemCtx, type Runtime } from '../src/app-services';
import { loadConfig } from '../src/config';
import type { Ctx, UserRow } from '../src/context';
import { openDatabase } from '../src/db/client';
import { createProject } from '../src/services/projects';
import { insertUser } from '../src/services/users';
import { addFieldValue } from '../src/services/fields';
import { fieldByName } from '../src/services/schema-cache';

export interface TestWorld {
  app: Runtime;
  admin: UserRow;
  anna: UserRow;
  ben: UserRow;
  viewer: UserRow;
  as(user: UserRow): Ctx;
  adminCtx: Ctx;
  close(): Promise<void>;
}

/** A fresh in-memory database with defaults, three people and two projects (BACK, WEB). */
export async function createWorld(opts: { projects?: boolean } = {}): Promise<TestWorld> {
  const config = loadConfig({ aiEnabled: false, seedDemo: false });
  const pg = await freshPostgres();
  const database = await openDatabase(pg ? { url: pg.url } : { memory: true });
  const app = await createRuntime(config, database);
  const admin = await insertUser(app.db, { login: 'admin', name: 'Ada Admin', role: 'admin', password: 'password-admin' });
  const anna = await insertUser(app.db, { login: 'anna', name: 'Anna Schmidt', role: 'member', hourlyRate: 90 });
  const ben = await insertUser(app.db, { login: 'ben', name: 'Ben Okafor', role: 'member', hourlyRate: 80 });
  const viewer = await insertUser(app.db, { login: 'vera', name: 'Vera Viewer', role: 'viewer' });
  app.schema.invalidate();
  const ctx = adminCtx(app, admin, 'api');
  if (opts.projects !== false) {
    await createProject(ctx, { key: 'BACK', name: 'Backend', template: 'software' });
    await createProject(ctx, { key: 'WEB', name: 'Web app', template: 'software' });
    const s = await app.schema.get();
    const subsystem = fieldByName(s, 'Subsystem')!;
    for (const name of ['API', 'Database', 'Auth']) await addFieldValue(ctx, subsystem.id, { name, project: 'BACK' });
    await addFieldValue(ctx, subsystem.id, { name: 'UI', project: 'WEB' });
    const versions = fieldByName(s, 'Fix versions')!;
    for (const name of ['1.0', '1.1', '2.0']) await addFieldValue(ctx, versions.id, { name });
  }
  return {
    app,
    admin,
    anna,
    ben,
    viewer,
    adminCtx: ctx,
    as: (user) => systemCtx(app, user, 'api'),
    close: async () => {
      await database.close();
      await pg?.drop();
    },
  };
}

/**
 * With TEST_DATABASE_URL (a Postgres server URL), every test file gets its own
 * database, created here and dropped afterwards; without it, in-memory PGlite.
 */
export async function freshPostgres(): Promise<{ url: string; drop(): Promise<void> } | null> {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) return null;
  const { default: pgLib } = await import('pg');
  const name = `a4a_t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pgLib.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      const c = new pgLib.Client({ connectionString: base });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
