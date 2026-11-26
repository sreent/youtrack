/**
 * The migrations and drizzle-kit's snapshots. The database the migrations build is the one schema.ts
 * declares, its keys included; the snapshots form one chain whose last is schema.ts, so `drizzle-kit
 * generate` writes only what changes next; and an installation upgrades through 0062 whatever rows
 * break its keys.
 *
 * Why: migrations 0049, 0051, 0055 and 0058 were written by hand and left out six foreign keys that
 * schema.ts declares, and their snapshots, written by hand too, kept `drizzle-kit generate` from
 * running for every migration after them. Nothing noticed, since the app runs the SQL alone.
 */
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { sql, type SQL } from 'drizzle-orm';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { generateDrizzleJson } from 'drizzle-kit/api';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client';
import * as schema from '../src/db/schema';
import { createWorld, freshPostgres, type TestWorld } from './helpers';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');
const ON_POSTGRES = Boolean(process.env.TEST_DATABASE_URL);

type Column = { name: string; type: string; notNull?: boolean; primaryKey?: boolean; isUnique?: boolean; uniqueName?: string };
type Table = {
  name: string;
  columns: Record<string, Column>;
  indexes: Record<string, unknown>;
  foreignKeys: Record<string, { tableTo: string; onDelete?: string }>;
  uniqueConstraints: Record<string, unknown>;
  compositePrimaryKeys: Record<string, unknown>;
  checkConstraints: Record<string, unknown>;
};
type Snapshot = { id: string; prevId: string; version: string; dialect: string; tables: Record<string, Table> } & Record<string, unknown>;

const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
const fileOf = (idx: number) => `${String(idx).padStart(4, '0')}_snapshot.json`;
const snapshotOf = (idx: number) => JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', fileOf(idx)), 'utf8')) as Snapshot;
/** What schema.ts declares, as `drizzle-kit generate` would write it. */
const declared = generateDrizzleJson(schema as never) as unknown as Snapshot;

async function rows<T>(db: Db, query: SQL): Promise<T[]> {
  return ((await db.execute(query)) as unknown as { rows: T[] }).rows;
}

// ---------------------------------------------------------------------------
// The snapshots
// ---------------------------------------------------------------------------

describe("drizzle-kit's snapshots", () => {
  it('form one chain, one per migration, and the last is what schema.ts declares', () => {
    const files = readdirSync(path.join(MIGRATIONS, 'meta')).filter((f) => f.endsWith('snapshot.json')).sort();
    expect(files, 'one snapshot per migration, named as drizzle-kit names them').toEqual(journal.entries.map((e) => fileOf(e.idx)));
    const ids = new Set<string>();
    let prev = '00000000-0000-0000-0000-000000000000';
    for (const e of journal.entries) {
      const s = snapshotOf(e.idx);
      expect([s.version, s.dialect], e.tag).toEqual(['7', 'postgresql']);
      expect(ids.has(s.id), `${e.tag}'s id is another snapshot's`).toBe(false);
      expect(s.prevId, `${e.tag} follows the snapshot before it`).toBe(prev);
      ids.add(s.id);
      prev = s.id;
    }
    // What `drizzle-kit generate` compares: alike, so it writes nothing until schema.ts changes. When this
    // fails, schema.ts changed with no migration: run `pnpm --filter @a4a/server exec drizzle-kit generate --name <what>`.
    const last = snapshotOf(journal.entries.at(-1)!.idx);
    for (const part of ['tables', 'enums', 'schemas', 'sequences', 'roles', 'policies', 'views']) expect(last[part], part).toEqual(declared[part]);
  });
});

// ---------------------------------------------------------------------------
// The database the migrations build
// ---------------------------------------------------------------------------

const DELETE_RULES: Record<string, string> = { a: 'no action', r: 'restrict', c: 'cascade', n: 'set null', d: 'set default' };
/** Postgres's own names for the types schema.ts names otherwise. */
const SAID_AS: Record<string, string> = { serial: 'integer', bigserial: 'bigint', smallserial: 'smallint', varchar: 'character varying', char: 'character', timestamp: 'timestamp without time zone' };
/** A column's type as information_schema says it: no collation, no precision, an array as ARRAY. */
function typeOf(t: string): string {
  if (t.endsWith('[]')) return 'ARRAY';
  const bare = t.split(' COLLATE ')[0]!.replace(/\(.*\)$/, '').trim();
  return SAID_AS[bare] ?? bare;
}

/** Each way the database a world's migrations built differs from what schema.ts declares, in words. */
async function differences(db: Db): Promise<string[]> {
  const out: string[] = [];
  const tables = new Set((await rows<{ t: string }>(db, sql`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)).map((r) => r.t));
  const columns = await rows<{ t: string; c: string; type: string; nullable: string }>(db, sql`SELECT table_name AS t, column_name AS c, data_type AS type, is_nullable AS nullable FROM information_schema.columns WHERE table_schema = 'public'`);
  const constraints = await rows<{ t: string; name: string; kind: string; target: string; del: string; valid: boolean }>(
    db,
    sql`SELECT cl.relname AS t, k.conname::text AS name, k.contype::text AS kind, coalesce(cf.relname, '') AS target, k.confdeltype::text AS del, k.convalidated AS valid
        FROM pg_constraint k JOIN pg_class cl ON cl.oid = k.conrelid LEFT JOIN pg_class cf ON cf.oid = k.confrelid
        WHERE k.connamespace = 'public'::regnamespace AND k.conrelid <> 0`,
  );
  const indexes = await rows<{ t: string; name: string }>(db, sql`SELECT tablename AS t, indexname AS name FROM pg_indexes WHERE schemaname = 'public'`);
  const declaredTables = Object.values(declared.tables);
  for (const t of declaredTables) if (!tables.has(t.name)) out.push(`${t.name}: no such table`);
  for (const t of tables) if (!declaredTables.some((d) => d.name === t)) out.push(`${t}: a table schema.ts doesn't declare`);
  for (const t of declaredTables.filter((d) => tables.has(d.name))) {
    const cols = new Map(columns.filter((c) => c.t === t.name).map((c) => [c.c, c]));
    for (const c of Object.values(t.columns)) {
      const real = cols.get(c.name);
      if (!real) out.push(`${t.name}.${c.name}: no such column`);
      else {
        if (typeOf(c.type) !== real.type) out.push(`${t.name}.${c.name}: ${real.type}, where schema.ts says ${c.type}`);
        if (Boolean(c.notNull) !== (real.nullable === 'NO')) out.push(`${t.name}.${c.name}: ${real.nullable === 'NO' ? 'not null' : 'nullable'}, where schema.ts says otherwise`);
      }
    }
    for (const name of cols.keys()) if (!t.columns[name]) out.push(`${t.name}.${name}: a column schema.ts doesn't declare`);
    const mine = constraints.filter((k) => k.t === t.name);
    const named = (kind: string) => new Set(mine.filter((k) => k.kind === kind).map((k) => k.name));
    const compare = (what: string, want: Set<string>, have: Set<string>) => {
      for (const n of want) if (!have.has(n)) out.push(`${t.name}: no ${what} ${n}`);
      for (const n of have) if (!want.has(n)) out.push(`${t.name}: a ${what} ${n} schema.ts doesn't declare`);
    };
    compare('foreign key', new Set(Object.keys(t.foreignKeys)), named('f'));
    for (const [name, fk] of Object.entries(t.foreignKeys)) {
      const real = mine.find((k) => k.kind === 'f' && k.name === name);
      if (!real) continue;
      if (real.target !== fk.tableTo) out.push(`${t.name}: ${name} points at ${real.target}, where schema.ts says ${fk.tableTo}`);
      if (DELETE_RULES[real.del] !== (fk.onDelete ?? 'no action')) out.push(`${t.name}: ${name} does ${DELETE_RULES[real.del]} on delete, where schema.ts says ${fk.onDelete ?? 'no action'}`);
      if (!real.valid) out.push(`${t.name}: ${name} isn't validated`);
    }
    const uniques = new Set([...Object.keys(t.uniqueConstraints), ...Object.values(t.columns).flatMap((c) => (c.isUnique && c.uniqueName ? [c.uniqueName] : []))]);
    compare('unique constraint', uniques, named('u'));
    const keys = Object.keys(t.compositePrimaryKeys).length ? new Set(Object.keys(t.compositePrimaryKeys)) : new Set(Object.values(t.columns).some((c) => c.primaryKey) ? [`${t.name}_pkey`] : []);
    compare('primary key', keys, named('p'));
    compare('check', new Set(Object.keys(t.checkConstraints)), named('c'));
    // An index of a primary key or a unique constraint goes by the constraint's name.
    const ofConstraints = new Set(mine.filter((k) => k.kind === 'p' || k.kind === 'u').map((k) => k.name));
    compare('index', new Set(Object.keys(t.indexes)), new Set(indexes.filter((i) => i.t === t.name && !ofConstraints.has(i.name)).map((i) => i.name)));
  }
  return out;
}

describe('the migrations', () => {
  let w: TestWorld;
  beforeAll(async () => {
    w = await createWorld({ projects: false, people: false });
  });
  afterAll(async () => {
    await w?.close();
  });

  it("build the database schema.ts declares: its tables, columns, keys, checks and indexes", async () => {
    // When this fails, a migration made by hand left something out, or schema.ts changed with no migration.
    expect(await differences(w.app.db)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 0062: the six keys, over an installation's rows
// ---------------------------------------------------------------------------

/** The migrations before one, in a folder of their own. */
function migrationsBefore(tag: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'a4a-migrations-'));
  cpSync(MIGRATIONS, dir, { recursive: true });
  const at = journal.entries.findIndex((e) => e.tag === tag);
  if (at < 0) throw new Error(`No migration ${tag} in the journal`);
  for (const e of journal.entries.slice(at)) rmSync(path.join(dir, `${e.tag}.sql`));
  writeFileSync(path.join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, at) }));
  return dir;
}

/** A value of a column's type, for one nothing reads. */
function anything(type: string): unknown {
  if (/char|text/.test(type)) return `x-${randomUUID()}`;
  if (/int|numeric|double|real/.test(type)) return 0;
  if (type === 'boolean') return false;
  if (type === 'jsonb' || type === 'json') return '{}';
  if (type === 'ARRAY') return '{}';
  if (type === 'date') return '2026-01-05';
  if (type.startsWith('timestamp')) return new Date().toISOString();
  if (type === 'uuid') return randomUUID();
  return `x-${randomUUID()}`;
}

/**
 * A row of a table with these values, each other column it needs filled: a parent made the same way
 * for a key the table has, else a value of its type. So a test writes only the columns it means.
 */
async function insertRow(db: Db, table: string, values: Record<string, unknown>, depth = 0): Promise<Record<string, unknown>> {
  const needed = await rows<{ c: string; type: string }>(
    db,
    sql`SELECT column_name AS c, data_type AS type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table} AND is_nullable = 'NO' AND column_default IS NULL AND is_identity = 'NO' AND is_generated = 'NEVER'`,
  );
  const keys = await rows<{ c: string; parent: string; pc: string }>(
    db,
    sql`SELECT a.attname AS c, cf.relname AS parent, af.attname AS pc
        FROM pg_constraint k JOIN pg_class ct ON ct.oid = k.conrelid JOIN pg_class cf ON cf.oid = k.confrelid
        JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1] JOIN pg_attribute af ON af.attrelid = k.confrelid AND af.attnum = k.confkey[1]
        WHERE k.contype = 'f' AND ct.relname = ${table} AND cardinality(k.conkey) = 1`,
  );
  const row: Record<string, unknown> = { ...values };
  for (const col of needed) {
    if (col.c in row) continue;
    const key = keys.find((k) => k.c === col.c);
    if (key && key.parent !== table && depth < 5) row[col.c] = (await insertRow(db, key.parent, {}, depth + 1))[key.pc];
    else row[col.c] = anything(col.type);
  }
  const names = Object.keys(row);
  const [made] = await rows<Record<string, unknown>>(
    db,
    sql`INSERT INTO ${sql.identifier(table)} (${sql.join(names.map((n) => sql.identifier(n)), sql`, `)}) VALUES (${sql.join(names.map((n) => sql`${row[n]}`), sql`, `)}) RETURNING *`,
  );
  return made!;
}

const KEYS = [
  'attachments_whiteboard_id_whiteboards_id_fk',
  'whiteboard_elements_attachment_id_attachments_id_fk',
  'chat_posts_channel_id_chat_channels_id_fk',
  'portal_providers_project_id_projects_id_fk',
  'timesheet_weeks_user_id_users_id_fk',
  'timesheet_weeks_approved_by_id_users_id_fk',
];

/** An installation at 0061, with rows that break each of 0062's keys beside rows that don't, upgraded. */
async function upgradeOverBrokenRows(db: Db, migrate: (folder: string) => Promise<void>): Promise<void> {
  const before = migrationsBefore('0062_keys_the_schema_declares');
  try {
    await migrate(before);
  } finally {
    rmSync(before, { recursive: true, force: true });
  }
  const has = async (table: string, id: unknown) => (await rows(db, sql`SELECT 1 FROM ${sql.identifier(table)} WHERE id = ${id}`)).length === 1;
  const person = await insertRow(db, 'users', {});
  const weekGone = await insertRow(db, 'timesheet_weeks', { user_id: 'someone-deleted' });
  const weekKept = await insertRow(db, 'timesheet_weeks', { user_id: person.id, approved_by_id: 'someone-deleted' });
  const board = await insertRow(db, 'whiteboards', {});
  const pictureGone = await insertRow(db, 'attachments', { whiteboard_id: 'a-deleted-board', issue_id: null, article_id: null, comment_id: null });
  const pictureKept = await insertRow(db, 'attachments', { whiteboard_id: board.id, issue_id: null, article_id: null, comment_id: null });
  const drawingLost = await insertRow(db, 'whiteboard_elements', { whiteboard_id: board.id, attachment_id: pictureGone.id });
  const drawingKept = await insertRow(db, 'whiteboard_elements', { whiteboard_id: board.id, attachment_id: pictureKept.id });
  const channel = await insertRow(db, 'chat_channels', {});
  const postGone = await insertRow(db, 'chat_posts', { channel_id: 'a-deleted-channel' });
  const postKept = await insertRow(db, 'chat_posts', { channel_id: channel.id });
  const desk = await insertRow(db, 'projects', {});
  const providerGone = await insertRow(db, 'portal_providers', { project_id: 'a-deleted-desk' });
  const providerNamed = await insertRow(db, 'portal_providers', { project_id: 'another-deleted-desk' });
  await insertRow(db, 'customer_groups', { provider_id: providerNamed.id });
  const providerOwn = await insertRow(db, 'portal_providers', { project_id: desk.id });
  const providerServer = await insertRow(db, 'portal_providers', { project_id: null });

  await migrate(MIGRATIONS);

  // A cascade's rows went, a set null's were cleared, and the rest stayed.
  expect([await has('timesheet_weeks', weekGone.id), await has('timesheet_weeks', weekKept.id)]).toEqual([false, true]);
  expect((await rows<{ a: unknown }>(db, sql`SELECT approved_by_id AS a FROM timesheet_weeks WHERE id = ${weekKept.id}`))[0]!.a).toBeNull();
  expect([await has('attachments', pictureGone.id), await has('attachments', pictureKept.id)]).toEqual([false, true]);
  const drawings = await rows<{ id: string; a: string | null }>(db, sql`SELECT id, attachment_id AS a FROM whiteboard_elements WHERE id IN (${drawingLost.id}, ${drawingKept.id})`);
  expect(Object.fromEntries(drawings.map((d) => [d.id, d.a]))).toEqual({ [String(drawingLost.id)]: null, [String(drawingKept.id)]: pictureKept.id });
  expect([await has('chat_posts', postGone.id), await has('chat_posts', postKept.id)]).toEqual([false, true]);
  // A deleted desk's provider goes, unless a customer group still names it: then it stays, and so
  // does the key, held for new rows and left unvalidated rather than stopping the server.
  expect([await has('portal_providers', providerGone.id), await has('portal_providers', providerNamed.id), await has('portal_providers', providerOwn.id), await has('portal_providers', providerServer.id)]).toEqual([
    false,
    true,
    true,
    true,
  ]);
  const made = await rows<{ name: string; valid: boolean }>(db, sql`SELECT conname::text AS name, convalidated AS valid FROM pg_constraint WHERE contype = 'f' AND conname IN (${sql.join(KEYS.map((k) => sql`${k}`), sql`, `)})`);
  expect(Object.fromEntries(made.map((k) => [k.name, k.valid]))).toEqual({ ...Object.fromEntries(KEYS.map((k) => [k, true])), portal_providers_project_id_projects_id_fk: false });
  // And each key holds from now on.
  await expect(db.execute(sql`INSERT INTO timesheet_weeks (id, user_id, week) VALUES (${randomUUID()}, 'nobody-at-all', '2026-01-12')`)).rejects.toThrow();
}

describe("0062's keys", () => {
  it('an installation upgrades over rows that break them, as each key would have taken them, on PGlite', async () => {
    const client = new PGlite({ extensions: { pg_trgm } });
    await client.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    const db = drizzlePglite(client) as unknown as Db;
    try {
      await upgradeOverBrokenRows(db, (folder) => migratePglite(db as never, { migrationsFolder: folder }));
    } finally {
      await client.close();
    }
  }, 120_000);

  it.runIf(ON_POSTGRES)('an installation upgrades over rows that break them, as each key would have taken them, on Postgres', async () => {
    const fresh = (await freshPostgres())!;
    const pool = new pg.Pool({ connectionString: fresh.url, max: 2 });
    const db = drizzlePg(pool) as unknown as Db;
    try {
      await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
      await upgradeOverBrokenRows(db, (folder) => migratePg(db as never, { migrationsFolder: folder }));
    } finally {
      await pool.end();
      await fresh.drop();
    }
  }, 120_000);
});
