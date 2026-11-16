/**
 * What makes several instances behave as one, checked on one instance: the ordered
 * log, the resumable stream, the shared login throttle, the worker's lease and
 * fencing, abandoned idempotency claims. Runs on PGlite, or on Postgres with
 * TEST_DATABASE_URL; the cross-instance cases are in cluster.test.ts.
 */
import { createHash } from 'node:crypto';
import type { TrackerEvent } from '@a4a/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime } from '../src/app-services';
import { loadConfig } from '../src/config';
import { activities, idempotencyKeys, loginThrottle, outboxCursors, workerLeases } from '../src/db/schema';
import { OrderedLog } from '../src/events/ordered-log';
import { decodeRanges, encodeRanges } from '../src/events/signals';
import { OutboxWorker, type OutboxConsumer } from '../src/events/worker';
import { createHttpApp } from '../src/http/app';
import { issueTokenFor } from '../src/services/auth';
import { createIssue } from '../src/services/issues';
import { LOGIN_THROTTLE, pruneLoginThrottle, waitInWords } from '../src/services/login-throttle';
import { insertUser } from '../src/services/users';
import { createWorld, type TestWorld } from './helpers';
import { openStream } from './sse-client';

const BASE = 'http://localhost:3511';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, timeoutMs: number, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`${what} not met within ${timeoutMs} ms`);
    await sleep(20);
  }
}

let w: TestWorld;
let http: ReturnType<typeof createHttpApp>;
let token: string;
const request = async (path: string, init: RequestInit) => http.request(path, init);

const maxActivityId = async () => Number((await w.app.db.select({ max: sql<number>`coalesce(max(${activities.id}), 0)` }).from(activities))[0]!.max);
/** Activities with ids of our choosing, to make gaps. The sequence is moved past them afterwards. */
const insertActivity = (id: number) => w.app.db.insert(activities).values({ id, type: 'issue.updated', channel: 'system', payload: { data: { probe: id } } });
const moveSequencePast = async (id: number) => {
  await w.app.db.execute(sql`select setval(pg_get_serial_sequence('activities', 'id'), ${id})`);
};

beforeAll(async () => {
  w = await createWorld();
  w.app.config.publicUrl = BASE;
  http = createHttpApp(w.app);
  token = (await issueTokenFor(w.app.db, w.admin.id, { name: 'scale', scopes: ['read', 'write', 'admin'] })).token;
});

afterAll(async () => {
  w.app.live.stop();
  await w.close();
});

describe('signals', () => {
  it('sends ids as ranges, and reads back only well-formed ones', () => {
    expect(encodeRanges([7, 3, 4, 5, 9, 4])).toBe('3-5,7,9');
    expect(decodeRanges('3-5,7,9')).toEqual([
      [3, 5],
      [7, 7],
      [9, 9],
    ]);
    expect(decodeRanges('x,5-2,-1,8')).toEqual([[8, 8]]);
    const many = Array.from({ length: 3_000 }, (_, i) => i * 2 + 1);
    expect(encodeRanges(many)).toBe(`1-${many.at(-1)}`);
  });
});

describe('the ordered log', () => {
  it('hands rows out in id order, waits at a missing id, and passes it once nothing can fill it', async () => {
    const log = new OrderedLog(w.app.db, { settleMs: 50 });
    const base = (await maxActivityId()) + 100;
    await insertActivity(base + 1);
    await insertActivity(base + 3);
    let read = await log.read(base, 100);
    expect(read.rows.map((r) => r.id)).toEqual([base + 1]);
    expect(read.waiting).toBe(true);
    // The late commit: the missing id appears, and order is kept.
    await insertActivity(base + 2);
    read = await log.read(base + 1, 100);
    expect(read.rows.map((r) => r.id)).toEqual([base + 2, base + 3]);
    expect(read.waiting).toBe(false);
    // An id that never appears (its transaction rolled back) is passed once no transaction could still hold it.
    await insertActivity(base + 5);
    read = await log.read(base + 3, 100);
    expect(read.rows).toEqual([]);
    expect(read.waiting).toBe(true);
    await until(async () => (read = await log.read(base + 3, 100)).rows.length > 0, 3_000, 'the gap being passed');
    expect(read.rows.map((r) => r.id)).toEqual([base + 5]);
    await moveSequencePast(base + 5);
  });

  it('passes a gap held longer than its limit, saying so', async () => {
    const said: string[] = [];
    let now = 1_000_000;
    const log = new OrderedLog(w.app.db, { settleMs: 10 ** 9, maxWaitMs: 60_000, now: () => now, log: (m) => said.push(m) });
    const base = (await maxActivityId()) + 100;
    await insertActivity(base + 2);
    expect((await log.read(base, 100)).rows).toEqual([]);
    now += 61_000;
    expect((await log.read(base, 100)).rows.map((r) => r.id)).toEqual([base + 2]);
    expect(said.join('\n')).toMatch(/passing activity/);
    await moveSequencePast(base + 2);
  });
});

describe('the live stream', () => {
  it('replays what a client missed after its Last-Event-ID, then goes on live, in order and once', async () => {
    const first = await openStream(request, token);
    await first.waitFor((f) => f.event === 'ready');
    await createIssue(w.adminCtx, { project: 'BACK', summary: 'Seen live' });
    await first.waitForEvents(1);
    const last = first.lastEventId()!;
    await first.close();
    const missed = [];
    for (const n of [1, 2]) missed.push(await createIssue(w.adminCtx, { project: 'BACK', summary: `Missed ${n}` }));
    const second = await openStream(request, token, { lastEventId: last });
    const replayed = await second.waitForEvents(2);
    expect(replayed.map((e) => e.issue?.id)).toEqual(missed.map((i) => i.id));
    await createIssue(w.adminCtx, { project: 'BACK', summary: 'Live after the replay' });
    const all = await second.waitForEvents(3);
    expect(all.map((e) => e.id)).toEqual([...new Set(all.map((e) => e.id))].sort((x, y) => x - y));
    await second.close();
  });

  it('takes the resume point from ?after= too, and applies the stream filter to the replay', async () => {
    const start = await maxActivityId();
    await createIssue(w.adminCtx, { project: 'WEB', summary: 'Not for this stream' });
    const back = await createIssue(w.adminCtx, { project: 'BACK', summary: 'For this stream' });
    const stream = await openStream(request, token, { query: `?project=back&types=issue.created&after=${start}` });
    const got = await stream.waitForEvents(1);
    await sleep(200);
    expect(stream.events().map((e) => e.issue?.id)).toEqual([back.id]);
    expect(got[0]!.project).toBe('BACK');
    await stream.close();
  });

  it('says resync, rather than replaying, when a client missed more than a thousand events', async () => {
    const start = await maxActivityId();
    await w.app.db.execute(
      sql`insert into activities (type, channel, payload) select 'issue.updated', 'system', '{}'::jsonb from generate_series(1, 1005)`,
    );
    // The feed must have read past them before the client asks.
    w.app.live.poke();
    await until(() => w.app.live.position >= start + 1005, 5_000, 'the feed reading the burst');
    const stream = await openStream(request, token, { lastEventId: String(start) });
    const frame = await stream.waitFor((f) => f.event === 'resync');
    expect(frame.id).toBe(String(w.app.live.position));
    expect(JSON.parse(frame.data)).toMatchObject({ after: start });
    await sleep(100);
    expect(stream.events()).toEqual([]);
    await stream.close();
  });

  it('ignores a resume point that is not one of ours, and refuses an unknown project', async () => {
    const stream = await openStream(request, token, { lastEventId: '999999999' });
    await stream.waitFor((f) => f.event === 'ready');
    const issue = await createIssue(w.adminCtx, { project: 'BACK', summary: 'After a foreign id' });
    await stream.waitFor((f) => f.event === 'issue.created' && (JSON.parse(f.data) as TrackerEvent).issue?.id === issue.id);
    await stream.close();
    const res = await http.request('/api/v1/events/stream?project=NOPE', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/Unknown project NOPE/);
  });

  it('ends streams when the feed stops, so a server can shut down', async () => {
    const config = loadConfig({ aiEnabled: false, seedDemo: false, publicUrl: BASE });
    const other = await createRuntime(config, w.app.database);
    const otherHttp = createHttpApp(other);
    const stream = await openStream(async (p, i) => otherHttp.request(p, i), token);
    await stream.waitFor((f) => f.event === 'ready');
    other.live.stop();
    await Promise.race([stream.closed, sleep(2_000).then(() => Promise.reject(new Error('the stream stayed open')))]);
    const refused = await otherHttp.request('/api/v1/events/stream', { headers: { authorization: `Bearer ${token}` } });
    expect(refused.status).toBe(503);
  });
});

describe('the login throttle', () => {
  const signIn = (login: string, password: string, headers: Record<string, string> = {}) =>
    http.request('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ login, password }) });

  it('allows ten failures per login in a window, then asks to wait, even with the right password', async () => {
    await insertUser(w.app.db, { login: 'lena', name: 'Lena Limit', password: 'password-lena' });
    for (let n = 0; n < LOGIN_THROTTLE.perLogin; n++) expect((await signIn('lena', 'wrong')).status).toBe(401);
    const res = await signIn('LENA', 'password-lena');
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; hint: string } };
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.hint).toMatch(/^Try again in \d+ minutes?$/);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(14 * 60);
  });

  it('takes a successful attempt back, so only failures count', async () => {
    await insertUser(w.app.db, { login: 'sam', name: 'Sam Success', password: 'password-sam' });
    for (let n = 0; n < LOGIN_THROTTLE.perLogin - 1; n++) expect((await signIn('sam', 'wrong')).status).toBe(401);
    expect((await signIn('sam', 'password-sam')).status).toBe(200);
    expect((await signIn('sam', 'wrong')).status).toBe(401);
    expect((await signIn('sam', 'wrong')).status).toBe(429);
  });

  it('starts a new window once the old one has passed, and housekeeping forgets old windows', async () => {
    await insertUser(w.app.db, { login: 'will', name: 'Will Window', password: 'password-will' });
    for (let n = 0; n <= LOGIN_THROTTLE.perLogin; n++) await signIn('will', 'wrong');
    expect((await signIn('will', 'password-will')).status).toBe(429);
    await w.app.db
      .update(loginThrottle)
      .set({ windowStart: new Date(Date.now() - LOGIN_THROTTLE.windowMs - 1_000) })
      .where(eq(loginThrottle.key, 'login:will'));
    expect((await signIn('will', 'password-will')).status).toBe(200);
    await w.app.db.update(loginThrottle).set({ windowStart: new Date(Date.now() - LOGIN_THROTTLE.windowMs - 1_000) });
    await pruneLoginThrottle(w.app.db);
    expect(await w.app.db.select().from(loginThrottle)).toEqual([]);
  });

  it('counts per address across logins, from the proxy-added X-Forwarded-For entry only', async () => {
    const trusting = createHttpApp(Object.assign(Object.create(w.app), { config: { ...w.app.config, trustProxy: 1 } }));
    const from = (ip: string, login: string, spoof = '') =>
      trusting.request('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': spoof ? `${spoof}, ${ip}` : ip },
        body: JSON.stringify({ login, password: 'wrong' }),
      });
    // A client can't escape its address by sending its own X-Forwarded-For entries.
    for (let n = 0; n < LOGIN_THROTTLE.perIp; n++) expect((await from('198.51.100.9', `nobody-${n}`, `10.0.0.${n}`)).status).toBe(401);
    expect((await from('198.51.100.9', 'nobody-else')).status).toBe(429);
    expect((await from('198.51.100.10', 'nobody-else')).status).toBe(401);
  });

  it('writes waits as people read them', () => {
    expect(waitInWords(1)).toBe('1 second');
    expect(waitInWords(45)).toBe('45 seconds');
    expect(waitInWords(60)).toBe('1 minute');
    expect(waitInWords(61)).toBe('2 minutes');
  });
});

describe('the outbox worker on its own', () => {
  it('takes the lease, hands events to consumers in order, and saves the cursor', async () => {
    const handled: number[] = [];
    const consumer: OutboxConsumer = { name: 'scale-probe', handle: async (e) => void handled.push(e.id) };
    const worker = new OutboxWorker(w.app, [consumer], { leaseMs: 1_000, pollMs: 50, holder: 'solo' }, []);
    worker.start();
    await until(() => worker.active, 2_000, 'the lease');
    const start = await maxActivityId();
    await createIssue(w.adminCtx, { project: 'BACK', summary: 'For the solo worker' });
    await createIssue(w.adminCtx, { project: 'BACK', summary: 'For the solo worker, again' });
    await until(() => handled.filter((id) => id > start).length === 2, 3_000, 'both events');
    expect(handled.filter((id) => id > start)).toEqual([start + 1, start + 2]);
    await until(
      async () => (await w.app.db.select().from(outboxCursors).where(eq(outboxCursors.consumer, 'scale-probe')))[0]?.lastId === start + 2,
      2_000,
      'the cursor',
    );
    await worker.stop();
    expect(await w.app.db.select().from(workerLeases)).toEqual([]);
  });

  it('stops moving the cursor once another instance holds the lease', async () => {
    const handled: number[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const consumer: OutboxConsumer = {
      name: 'fenced-probe',
      handle: async (e) => {
        handled.push(e.id);
        await gate;
      },
    };
    const worker = new OutboxWorker(w.app, [consumer], { leaseMs: 60_000, pollMs: 10_000, holder: 'stalled' }, []);
    worker.start();
    await until(() => worker.active, 2_000, 'the lease');
    await until(async () => (await w.app.db.select().from(outboxCursors).where(eq(outboxCursors.consumer, 'fenced-probe'))).length === 1, 2_000, 'a cursor');
    const [before] = await w.app.db.select().from(outboxCursors).where(eq(outboxCursors.consumer, 'fenced-probe'));
    await createIssue(w.adminCtx, { project: 'BACK', summary: 'Handled while the lease is lost' });
    await until(() => handled.length === 1, 3_000, 'the event in hand');
    // While it is busy, the lease passes to someone else (as after a long stall).
    await w.app.db.update(workerLeases).set({ holder: 'successor' }).where(eq(workerLeases.name, 'outbox'));
    release();
    await until(() => !worker.active, 3_000, 'the worker noticing');
    const [after] = await w.app.db.select().from(outboxCursors).where(eq(outboxCursors.consumer, 'fenced-probe'));
    expect(after!.lastId).toBe(before!.lastId);
    await worker.stop();
    await w.app.db.delete(workerLeases);
  });
});

describe('idempotency keys', () => {
  it('lets a key whose request was abandoned be claimed again, and not one still in progress', async () => {
    const body = JSON.stringify({ project: 'BACK', summary: 'Retried after a crash' });
    const fingerprint = `POST /api/v1/issues ${createHash('sha256').update(body).digest('hex')}`;
    const claim = (key: string, ageMs: number) =>
      w.app.db.insert(idempotencyKeys).values({ userId: w.admin.id, key, method: 'POST', path: fingerprint, statusCode: 0, responseBody: null, createdAt: new Date(Date.now() - ageMs) });
    const post = (key: string) =>
      http.request('/api/v1/issues', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key }, body });
    await claim('fresh-claim', 1_000);
    expect((await post('fresh-claim')).status).toBe(409);
    await claim('abandoned-claim', 6 * 60_000);
    const res = await post('abandoned-claim');
    expect(res.status).toBe(201);
    const replay = await post('abandoned-claim');
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
  });
});

describe('health', () => {
  it('names the instance and what it runs', async () => {
    const res = await http.request('/api/v1/health', {});
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, instance: w.app.instanceId, worker: 'off' });
    expect(['local', 'listening', 'reconnecting']).toContain(body.live);
  });
});
