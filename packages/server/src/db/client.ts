import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { sql } from 'drizzle-orm';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import * as schema from './schema';

export type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export interface Database {
  db: Db;
  kind: 'pglite' | 'postgres';
  close(): Promise<void>;
}

export interface OpenOptions {
  /** Postgres connection string. When empty, the embedded PGlite database is used. */
  url?: string;
  /** Directory for PGlite data. Ignored when `memory` is true or `url` is set. */
  dataDir?: string;
  /** In-memory PGlite (tests). */
  memory?: boolean;
}

function migrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../drizzle'), // src/db -> packages/server/drizzle
    path.resolve(here, '../drizzle'), // dist -> packages/server/drizzle
    path.resolve(here, 'drizzle'),
    path.resolve(process.cwd(), 'drizzle'),
    path.resolve(process.cwd(), 'packages/server/drizzle'),
  ];
  const found = candidates.find((c) => existsSync(path.join(c, 'meta', '_journal.json')));
  if (!found) throw new Error(`Could not find the drizzle migrations folder (looked in ${candidates.join(', ')})`);
  return found;
}

export async function openDatabase(opts: OpenOptions): Promise<Database> {
  const folder = migrationsFolder();
  if (opts.url) {
    const pool = new pg.Pool({ connectionString: opts.url, max: Number(process.env.DATABASE_POOL_SIZE ?? 10) });
    // An idle client can die (database restart, failover, admin termination). Without
    // a listener node-postgres rethrows that as an uncaught error and the process exits;
    // the pool replaces the client on the next checkout, so logging is enough.
    pool.on('error', (err) => console.error(`postgres: idle connection lost (${err.message})`));
    const db = drizzlePg(pool, { schema }) as unknown as Db;
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await migratePg(db as never, { migrationsFolder: folder });
    return { db, kind: 'postgres', close: () => pool.end() };
  }

  let client: PGlite;
  let release = () => {};
  if (opts.memory) {
    client = new PGlite({ extensions: { pg_trgm } });
  } else {
    const dir = path.resolve(opts.dataDir ?? './data', 'pglite');
    mkdirSync(dir, { recursive: true });
    release = lockDataDir(dir);
    client = new PGlite(dir, { extensions: { pg_trgm } });
  }
  await client.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  const db = drizzlePglite(client, { schema }) as unknown as Db;
  await migratePglite(db as never, { migrationsFolder: folder });
  return {
    db,
    kind: 'pglite',
    close: async () => {
      await client.close();
      release();
    },
  };
}

/**
 * PGlite is one process's database: a second process opening the same directory
 * would corrupt it. Hold a lock file with our pid, and take over only a lock whose
 * process is gone.
 */
function lockDataDir(dir: string): () => void {
  const lock = path.join(dir, '..', 'pglite.lock');
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8').trim());
    let alive = false;
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive) {
      throw new Error(`The embedded database in ${dir} is in use by process ${pid}. Stop it first, or use Postgres (DATABASE_URL) to run several servers.`);
    }
  }
  writeFileSync(lock, String(process.pid));
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (readFileSync(lock, 'utf8').trim() === String(process.pid)) rmSync(lock);
    } catch {
      // already gone
    }
  };
  process.once('exit', release);
  return release;
}
