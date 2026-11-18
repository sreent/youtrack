/**
 * Boards at scale, lanes of their own, and a card's place in its history (D65): the migration turning
 * 50,000 doubles into keys in the same order, timed; a move that reads only beside its anchor; two
 * moves at once on Postgres, both landing, the later first; lanes with and without their own order,
 * and turning it on and off; a card's moves folded into lines of its history; and what a line says to
 * a reader who can't see its anchor or its board.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import type { Board, TrackerEvent } from '@a4a/shared';
import { keyAt } from '@a4a/shared/ranks';
import { eq, sql } from 'drizzle-orm';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client';
import { boardLaneRanks, boardMoves, boardRanks, issues as issuesTable } from '../src/db/schema';
import { getBacklog, rankIssue } from '../src/services/agile';
import { eventFeed, issueActivity } from '../src/services/activity';
import { boardView, createBoard, deleteBoard, getBoard, updateBoard } from '../src/services/boards';
import { createIssue, updateIssue } from '../src/services/issues';
import { addMember } from '../src/services/members';
import { createProject } from '../src/services/projects';
import { rankKeySql } from '../src/services/rank-keys';
import { toolByName } from '../src/tools/registry';
import { createWorld, freshPostgres, type TestWorld } from './helpers';

const ON_POSTGRES = Boolean(process.env.TEST_DATABASE_URL);
const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');
const BIG = 50_000;
const LOG = '/tmp/claude-0/-home-user/b51280ae-4ca9-58cd-9da6-49b41b0553ed/scratchpad/boards-timings.log';

let w: TestWorld;
beforeAll(async () => {
  w = await createWorld();
  await createProject(w.adminCtx, { key: 'LAN', name: 'Lanes', template: 'software', lead: 'ben' });
  await addMember(w.adminCtx, 'LAN', { user: 'anna', role: 'member' });
});
afterAll(async () => w?.close());

const rowsOf = <T>(res: unknown) => (res as { rows: T[] }).rows;

/** The statements a transaction begun inside `fn` sends, as drizzle logs them. */
async function statements(db: Db, fn: () => Promise<unknown>): Promise<string[]> {
  const session = (db as unknown as { session: { options: { logger?: unknown } } }).session;
  const before = session.options.logger;
  const seen: string[] = [];
  session.options.logger = { logQuery: (query: string) => seen.push(query) };
  try {
    await fn();
  } finally {
    session.options.logger = before;
  }
  return seen;
}

/** Issues made one after another, by summary, so their numbers (and the query's order) are theirs. */
async function made(project: string, summaries: string[], fields: Record<string, string> = {}) {
  const out = new Map<string, string>();
  for (const summary of summaries) out.set(summary, (await createIssue(w.as(w.anna), { project, summary, fields })).uid);
  return out;
}

/** A column's cards by summary, as someone sees the board. */
async function column(board: Board, name: string, ctx = w.as(w.anna)): Promise<string[]> {
  return (await boardView(ctx, board.id)).columns.find((c) => c.name === name)!.issues.map((i) => i.summary);
}

/** A column's cards in one lane: those of the people named, in the column's order. */
const inLane = (cards: string[], lane: string[]) => cards.filter((c) => lane.includes(c));

/** The Open column's cards assigned to someone, in the order the board shows them. */
async function lane(board: Board, login: string): Promise<string[]> {
  const cards = (await boardView(w.as(w.anna), board.id)).columns.find((c) => c.name === 'Open')!.issues;
  return cards.filter((i) => (i.fields.find((f) => f.name === 'Assignee')?.value as { login?: string } | null)?.login === login).map((i) => i.summary);
}

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

/** The migrations up to the one before D65's, in a folder of their own. */
function migrationsBefore(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'a4a-migrations-'));
  cpSync(MIGRATIONS, dir, { recursive: true });
  const journal = JSON.parse(readFileSync(path.join(dir, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  const at = journal.entries.findIndex((e) => e.tag === name);
  if (at < 0) throw new Error(`No migration ${name} in the journal`);
  for (const e of journal.entries.slice(at)) rmSync(path.join(dir, `${e.tag}.sql`));
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(path.join(dir, 'meta/_journal.json'), JSON.stringify(journal));
  return dir;
}

/** A board of 50,000 doubles, ties among them, and a small second board, written as the old schema had them. */
async function seedDoubles(db: Db): Promise<void> {
  await db.execute(sql`INSERT INTO projects (id, key, name, settings) VALUES ('p-mig', 'MIG', 'Migrated', '{}')`);
  await db.execute(sql`INSERT INTO boards (id, name, project_ids, columns) VALUES ('b-big', 'Big board', ARRAY['p-mig'], '[]'), ('b-small', 'Small board', ARRAY['p-mig'], '[]')`);
  await db.execute(sql`INSERT INTO issues (id, project_id, number, summary) SELECT 'i' || g, 'p-mig', g, 'Issue ' || g FROM generate_series(1, ${BIG}) AS g`);
  // Each double twice, some below zero and some fractions, so the order is the doubles' and then the issues'.
  await db.execute(sql`INSERT INTO board_ranks (board_id, issue_id, rank) SELECT 'b-big', 'i' || g, ((g * 7919) % ${BIG / 2})::float8 / 7 - 1000 FROM generate_series(1, ${BIG}) AS g`);
  await db.execute(sql`INSERT INTO board_ranks (board_id, issue_id, rank) SELECT 'b-small', 'i' || g, -g::float8 FROM generate_series(1, 300) AS g`);
}

async function orderBy(db: Db, board: string, by: 'rank' | 'key'): Promise<string[]> {
  const res = await db.execute(by === 'rank' ? sql`SELECT issue_id FROM board_ranks WHERE board_id = ${board} ORDER BY rank, issue_id` : sql`SELECT issue_id FROM board_ranks WHERE board_id = ${board} ORDER BY key`);
  return rowsOf<{ issue_id: string }>(res).map((r) => r.issue_id);
}

/** Migrates a database of the old schema holding a board of 50,000 ranks; says how long D65's migration took. */
async function migrateBigBoard(db: Db, migrate: (folder: string) => Promise<void>): Promise<{ ms: number; plan: string }> {
  const before = migrationsBefore('0044_board_ranks_keys');
  try {
    await migrate(before);
  } finally {
    rmSync(before, { recursive: true, force: true });
  }
  await seedDoubles(db);
  const [big, small] = [await orderBy(db, 'b-big', 'rank'), await orderBy(db, 'b-small', 'rank')];
  const started = performance.now();
  await migrate(MIGRATIONS);
  const ms = Math.round(performance.now() - started);
  // Every board's order is as it was, its keys the shared keyAt(0), keyAt(1) …
  expect(await orderBy(db, 'b-big', 'key')).toEqual(big);
  expect(await orderBy(db, 'b-small', 'key')).toEqual(small);
  const keys = rowsOf<{ key: string }>(await db.execute(sql`SELECT key FROM board_ranks WHERE board_id = 'b-big' ORDER BY key`)).map((r) => r.key);
  expect(keys.slice(0, 3)).toEqual([keyAt(0), keyAt(1), keyAt(2)]);
  expect(keys.at(-1)).toBe(keyAt(BIG - 1));
  // A move's read of its neighbour goes through the index, not the board's rows.
  await db.execute(sql`ANALYZE board_ranks`);
  const plan = rowsOf<Record<string, string>>(await db.execute(sql`EXPLAIN SELECT issue_id, key FROM board_ranks WHERE board_id = 'b-big' AND key > ${keyAt(25_000)} ORDER BY key LIMIT 1`))
    .map((r) => Object.values(r)[0])
    .join('\n');
  return { ms, plan };
}

describe('the migration', () => {
  it('turns a board of 50,000 doubles into keys in the same order, on PGlite', async () => {
    const client = new PGlite({ extensions: { pg_trgm } });
    await client.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    const db = drizzlePglite(client) as unknown as Db;
    try {
      const { ms, plan } = await migrateBigBoard(db, (folder) => migratePglite(db as never, { migrationsFolder: folder }));
      expect(plan).toMatch(/board_ranks_key/);
      writeFileSync(LOG, `PGlite: D65's migration over ${BIG} ranks took ${ms} ms\n`, { flag: 'a' });
    } finally {
      await client.close();
    }
  }, 180_000);

  it.runIf(ON_POSTGRES)('turns a board of 50,000 doubles into keys in the same order, on Postgres', async () => {
    const fresh = (await freshPostgres())!;
    const pool = new pg.Pool({ connectionString: fresh.url, max: 2 });
    const db = drizzlePg(pool) as unknown as Db;
    try {
      await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
      const { ms, plan } = await migrateBigBoard(db, (folder) => migratePg(db as never, { migrationsFolder: folder }));
      expect(plan).toMatch(/Index (Only )?Scan using board_ranks_key/);
      writeFileSync(LOG, `Postgres: D65's migration over ${BIG} ranks took ${ms} ms\n`, { flag: 'a' });
    } finally {
      await pool.end();
      await fresh.drop();
    }
  }, 180_000);
});

// ---------------------------------------------------------------------------
// A move reads its neighbours
// ---------------------------------------------------------------------------

describe('a move', () => {
  it('reads its anchor’s key and the next, and writes one row, however many ranks the board has', async () => {
    const board = await createBoard(w.as(w.ben), { name: 'Wide board', projects: ['LAN'] });
    const ids = [...(await made('LAN', ['Wide one', 'Wide two', 'Wide three'], { State: 'Open' })).values()];
    // Two thousand more places on the board, for issues the move never reads.
    await w.app.db.execute(sql`INSERT INTO issues (id, project_id, number, summary) SELECT 'wide' || g, ${(await getBoard(w.adminCtx, board.id)).projects[0]!.id}, 100000 + g, 'Filler ' || g FROM generate_series(1, 2000) AS g`);
    await w.app.db.execute(sql`INSERT INTO board_ranks (board_id, issue_id, key) SELECT ${board.id}, 'wide' || g, ${rankKeySql(sql`(g + 100)`)} FROM generate_series(1, 2000) AS g`);
    for (const [i, id] of ids.entries()) await w.app.db.insert(boardRanks).values({ boardId: board.id, issueId: id, key: keyAt(i) });

    const sent = await statements(w.app.db, () => rankIssue(w.as(w.anna), board.id, { issue: ids[2]!, after: ids[0]! }));
    const ranks = sent.filter((q) => /board_ranks/.test(q));
    // The anchor's key, the one after it, and the one row written.
    expect(ranks).toHaveLength(3);
    expect(ranks.filter((q) => /^select/i.test(q.trim())).every((q) => /limit 1|issue_id in/i.test(q))).toBe(true);
    expect(ranks.filter((q) => /^insert/i.test(q.trim()))).toHaveLength(1);
    const keys = new Map((await w.app.db.select().from(boardRanks).where(eq(boardRanks.boardId, board.id))).map((r) => [r.issueId, r.key]));
    expect(keys.get(ids[2]!)! > keyAt(0) && keys.get(ids[2]!)! < keyAt(1)).toBe(true);
    expect(keys.get('wide1')).toBe(keyAt(101));
  });

  // Two moves at once, made to meet: the first holds the board while it waits to write its row (the
  // test holds that row), and the second comes in meanwhile. Without the board's lock, both read the
  // same neighbours, take the same key, and tie: this test then fails (checked by taking the lock out).
  it.runIf(ON_POSTGRES)('lands both of two moves at once just after one card, the later first, on Postgres', async () => {
    const board = await createBoard(w.as(w.ben), { name: 'Raced board', projects: ['LAN'] });
    const ids = await made('LAN', ['Race R', 'Race S', 'Race T', 'Race U'], { State: 'Open' });
    for (const [i, id] of [...ids.values()].entries()) await w.app.db.insert(boardRanks).values({ boardId: board.id, issueId: id, key: keyAt(i) });
    const waiting = async () =>
      Number(rowsOf<{ n: string }>(await w.app.db.execute(sql`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`))[0]!.n);
    const until = async (done: () => Promise<boolean>) => {
      for (let i = 0; i < 200 && !(await done()); i++) await new Promise((r) => setTimeout(r, 25));
    };
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let holding!: () => void;
    const holds = new Promise<void>((r) => (holding = r));
    const holder = w.app.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM board_ranks WHERE board_id = ${board.id} AND issue_id = ${ids.get('Race T')!} FOR UPDATE`);
      holding();
      await held;
    });
    await holds;
    const first = rankIssue(w.as(w.anna), board.id, { issue: ids.get('Race T')!, after: ids.get('Race R')!, column: 'Open' });
    await until(async () => (await waiting()) >= 1);
    let secondDone = false;
    const second = rankIssue(w.as(w.ben), board.id, { issue: ids.get('Race U')!, after: ids.get('Race R')!, column: 'Open' }).finally(() => (secondDone = true));
    await until(async () => secondDone || (await waiting()) >= 2);
    release();
    await Promise.all([holder, first, second]);
    const keys = (await w.app.db.select().from(boardRanks).where(eq(boardRanks.boardId, board.id))).map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(await column(board, 'Open')).toEqual(['Race R', 'Race U', 'Race T', 'Race S']);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

describe('lanes of their own', () => {
  let board: Board;
  let id: Map<string, string>;
  const annas = ['Ann one', 'Ann two', 'Ann three'];
  const bens = ['Ben one', 'Ben two'];

  beforeAll(async () => {
    board = await createBoard(w.as(w.ben), { name: 'Own lanes', projects: ['LAN'], swimlaneField: 'Assignee', laneOrder: true, columns: [{ name: 'Open', values: ['Open'] }, { name: 'Done', values: ['Fixed'] }] });
    id = new Map([...(await made('LAN', annas, { State: 'Open', Assignee: 'anna' })), ...(await made('LAN', bens, { State: 'Open', Assignee: 'ben' }))]);
  });

  it('places a card among its lane’s cards, and leaves the board’s order, and so the backlog, as it was', async () => {
    expect(board.laneOrder).toBe(true);
    const shared = await column(board, 'Open');
    const backlog = (await getBacklog(w.as(w.anna), board.id)).issues.map((i) => i.summary);
    const [a0, a1, a2] = inLane(shared, annas);
    // Last of Anna's lane to its top: only its lane's place changes.
    expect(await rankIssue(w.as(w.anna), board.id, { issue: id.get(a2!)!, before: id.get(a0!)!, column: 'Open' })).toEqual({ changes: [], placed: true });
    expect(inLane(await column(board, 'Open'), annas)).toEqual([a2, a0, a1]);
    expect(inLane(await column(board, 'Open'), bens)).toEqual(inLane(shared, bens));
    expect((await getBacklog(w.as(w.anna), board.id)).issues.map((i) => i.summary)).toEqual(backlog);
    expect(await w.app.db.select().from(boardRanks).where(eq(boardRanks.boardId, board.id))).toEqual([]);
    // The backlog ranks the board's own order, which the lanes don't follow once placed.
    await rankIssue(w.as(w.anna), board.id, { issue: id.get(a1!)! });
    expect((await getBacklog(w.as(w.anna), board.id)).issues[0]!.summary).toBe(a1);
    expect(inLane(await column(board, 'Open'), annas)).toEqual([a2, a0, a1]);
    // Alt and Down: just after the next in its lane.
    await rankIssue(w.as(w.anna), board.id, { issue: id.get(a2!)!, after: id.get(a0!)!, column: 'Open' });
    expect(inLane(await column(board, 'Open'), annas)).toEqual([a0, a2, a1]);
  });

  it('puts a card dropped into another lane where it was dropped in that lane’s order', async () => {
    const before = await lane(board, 'ben');
    const mover = (await lane(board, 'anna'))[0]!;
    const out = await rankIssue(w.as(w.anna), board.id, { issue: id.get(mover)!, after: id.get(before[0]!)!, column: 'Open', lane: 'ben' });
    expect(out).toEqual({ changes: [{ field: 'Assignee', from: 'anna', to: 'ben' }], placed: true });
    expect(await lane(board, 'ben')).toEqual([before[0], mover, before[1]]);
    // Its place in Anna's lane is gone with it: one place per card, in the lane it was put in.
    const places = await w.app.db.select().from(boardLaneRanks).where(eq(boardLaneRanks.issueId, id.get(mover)!));
    expect(places.map((p) => p.lane)).toEqual([`u:${w.ben.id}`]);
    // MCP places it in its lane's order the same way.
    const tool = toolByName('rank_issue')!;
    await tool.run(w.as(w.anna), { board: 'Own lanes', issue: id.get(mover)!, before: id.get(before[0]!)!, column: 'Open' });
    expect(await lane(board, 'ben')).toEqual([mover, before[0], before[1]]);
  });

  it('gives a card that comes into a lane with no place there a place after the lane’s placed cards, in the board’s order', async () => {
    const placed = (await lane(board, 'ben')).slice(0, 2);
    const coming = (await lane(board, 'anna'))[0]!;
    // Reassigned on the issue, not on the board: it has no place in Ben's lane, so it comes after his
    // placed cards, among those without one in the board's order.
    await updateIssue(w.as(w.anna), id.get(coming)!, { fields: { Assignee: 'ben' } });
    const unplaced = (await getBacklog(w.as(w.anna), board.id)).issues.map((i) => i.summary).filter((s) => [...bens, coming].includes(s) && !placed.includes(s));
    expect(await lane(board, 'ben')).toEqual([...placed, ...unplaced]);
    // Placed just after the last of those without a place, they take places first, in the order shown, so nothing jumps.
    await rankIssue(w.as(w.anna), board.id, { issue: id.get(placed[0]!)!, after: id.get(unplaced.at(-1)!)!, column: 'Open' });
    expect(await lane(board, 'ben')).toEqual([placed[1], ...unplaced, placed[0]]);
  });

  it('keeps each lane’s places when the setting is turned off, shows the board’s order meanwhile, and forgets them for another lane field', async () => {
    const own = await column(board, 'Open');
    const off = await updateBoard(w.as(w.ben), board.id, { laneOrder: false });
    expect(off.laneOrder).toBe(false);
    // Off, the board's one order: a move writes the board's order, as D53 has it, and not the lanes'.
    const laneRows = await w.app.db.select().from(boardLaneRanks).where(eq(boardLaneRanks.boardId, board.id));
    const [x, y] = await lane(board, 'ben');
    await rankIssue(w.as(w.anna), board.id, { issue: id.get(y!)!, before: id.get(x!)!, column: 'Open' });
    expect(await lane(board, 'ben')).toEqual(expect.arrayContaining([x, y]));
    expect(await w.app.db.select().from(boardLaneRanks).where(eq(boardLaneRanks.boardId, board.id))).toEqual(laneRows);
    // On again: each lane's order as it was left.
    await updateBoard(w.as(w.ben), board.id, { laneOrder: true });
    expect(await column(board, 'Open')).toEqual(own);
    // Another lane field: places in lanes the board no longer has are forgotten.
    await updateBoard(w.as(w.ben), board.id, { swimlaneField: 'Priority' });
    expect(await w.app.db.select().from(boardLaneRanks).where(eq(boardLaneRanks.boardId, board.id))).toEqual([]);
    await updateBoard(w.as(w.ben), board.id, { swimlaneField: 'Assignee' });
  });

  it('is off by default: lanes share the board’s order', async () => {
    const shared = await createBoard(w.as(w.ben), { name: 'Shared lanes', projects: ['LAN'], swimlaneField: 'Assignee' });
    expect(shared.laneOrder).toBe(false);
    const [first, second] = inLane(await column(shared, 'Open'), annas);
    await rankIssue(w.as(w.anna), shared.id, { issue: id.get(second!)!, before: id.get(first!)!, column: 'Open' });
    expect((await w.app.db.select().from(boardRanks).where(eq(boardRanks.boardId, shared.id))).length).toBeGreaterThan(0);
    expect(await w.app.db.select().from(boardLaneRanks).where(eq(boardLaneRanks.boardId, shared.id))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A card's place in its issue's history
// ---------------------------------------------------------------------------

const lines = (events: TrackerEvent[]) => events.filter((e) => e.type === 'board.issue_ranked').map((e) => ({ note: e.data.note, moves: e.data.moves, board: e.data.board }));

describe('a card’s place in its history', () => {
  let board: Board;
  let id: Map<string, string>;
  beforeAll(async () => {
    board = await createBoard(w.as(w.ben), { name: 'Platform board', projects: ['LAN'], columns: [{ name: 'Open', values: ['Open'] }, { name: 'Done', values: ['Fixed'] }] });
    id = await made('LAN', ['Hist A', 'Hist B', 'Hist C', 'Hist D'], { State: 'Open' });
  });
  const ref = async (summary: string) => (await boardView(w.as(w.anna), board.id)).columns.flatMap((c) => c.issues).find((i) => i.summary === summary)!.id;

  it('folds one person’s moves on one board into a line, and starts another for someone else, a change between, or another board', async () => {
    const [a, b, c, d] = ['Hist A', 'Hist B', 'Hist C', 'Hist D'].map((x) => id.get(x)!);
    await rankIssue(w.as(w.anna), board.id, { issue: a!, after: b!, column: 'Open' });
    await rankIssue(w.as(w.anna), board.id, { issue: a!, after: c!, column: 'Open' });
    await rankIssue(w.as(w.anna), board.id, { issue: a!, before: d!, column: 'Open' });
    const [rb, rd] = [await ref('Hist B'), await ref('Hist D')];
    expect(lines(await issueActivity(w.as(w.anna), a!))).toEqual([{ note: `moved it above ${rd} on Platform board`, moves: 3, board: 'Platform board' }]);
    // The ledger keeps every move, as before.
    expect((await eventFeed(w.as(w.anna), { issue: a!, types: ['board.issue_ranked'] })).length).toBe(3);
    // Someone else's move is a line of its own; then a change to the issue ends the run.
    await rankIssue(w.as(w.ben), board.id, { issue: a!, after: b!, column: 'Open' });
    await updateIssue(w.as(w.anna), a!, { fields: { Priority: 'Critical' } });
    await rankIssue(w.as(w.ben), board.id, { issue: a!, before: b!, column: 'Open' });
    // The backlog's own top, on another board.
    const other = await createBoard(w.as(w.ben), { name: 'Other board', projects: ['LAN'] });
    await rankIssue(w.as(w.ben), other.id, { issue: a! });
    expect(lines(await issueActivity(w.as(w.anna), a!))).toEqual([
      { note: `moved it above ${rd} on Platform board`, moves: 3, board: 'Platform board' },
      { note: `moved it below ${rb} on Platform board`, moves: 1, board: 'Platform board' },
      { note: `moved it above ${rb} on Platform board`, moves: 1, board: 'Platform board' },
      { note: 'moved it to the top of Other board', moves: 1, board: 'Other board' },
    ]);
    // Each line keeps its words as a key and values, for every reader's language (D49).
    const kept = (await issueActivity(w.as(w.anna), a!)).find((e) => e.type === 'board.issue_ranked')!;
    expect(kept.data.said).toEqual({ key: 'boards.history.moved', values: { side: 'above', anchor: rd, onBoard: 'yes', board: 'Platform board' } });
  });

  it('starts a new line ten minutes after a line’s first move', async () => {
    const [b, c] = ['Hist B', 'Hist C'].map((x) => id.get(x)!);
    await rankIssue(w.as(w.anna), board.id, { issue: b!, after: c!, column: 'Open' });
    await w.app.db.update(boardMoves).set({ firstAt: sql`now() - interval '11 minutes'` }).where(eq(boardMoves.issueId, b!));
    await rankIssue(w.as(w.anna), board.id, { issue: b!, before: c!, column: 'Open' });
    await rankIssue(w.as(w.anna), board.id, { issue: b!, after: c!, column: 'Open' });
    expect(lines(await issueActivity(w.as(w.anna), b!)).map((l) => l.moves)).toEqual([1, 2]);
  });

  it('names an anchor and a board only to a reader who sees them, and says less to anyone else', async () => {
    await createProject(w.adminCtx, { key: 'LAS', name: 'Lanes secret', template: 'software', visibility: 'members', lead: 'ben' });
    // Hidden from Anna, and from nobody else on Ben's side: limited to Ben.
    const hidden = await createIssue(w.as(w.ben), { project: 'LAN', summary: 'Hist limited', fields: { State: 'Open' }, visibleTo: { users: ['ben'] } });
    const c = id.get('Hist C')!;
    await rankIssue(w.as(w.ben), board.id, { issue: c, after: hidden.id, column: 'Open' });
    const said = (ctx = w.as(w.anna)) => issueActivity(ctx, c).then((h) => h.filter((e) => e.type === 'board.issue_ranked').at(-1)!);
    expect((await said(w.as(w.ben))).data.note).toBe(`moved it below ${hidden.id} on Platform board`);
    const toAnna = await said();
    expect(toAnna.data.note).toBe('changed its place on Platform board');
    expect(toAnna.data.said).toEqual({ key: 'boards.history.moved', values: { side: 'moved', anchor: '', onBoard: 'yes', board: 'Platform board' } });
    expect(JSON.stringify(toAnna)).not.toContain(hidden.id);
    // A board she no longer sees: its projects are ones she doesn't read.
    await updateBoard(w.as(w.ben), board.id, { projects: ['LAS'] });
    const unseen = await said();
    expect(unseen.data.note).toBe('changed its place on a board');
    expect(unseen.data.board).toBeUndefined();
    expect(JSON.stringify(unseen)).not.toContain('Platform board');
    expect((await said(w.as(w.ben))).data.note).toBe(`moved it below ${hidden.id} on Platform board`);
    // Deleted, the board is no one's to see, and the line stays, saying less.
    await deleteBoard(w.as(w.ben), board.id);
    expect((await said(w.as(w.ben))).data.note).toBe(`moved it below ${hidden.id} on a board`);
    expect((await w.app.db.select().from(issuesTable).where(eq(issuesTable.id, c))).length).toBe(1);
  });
});
