/**
 * Several a4a instances against one Postgres database, as behind a load balancer.
 * Each instance is a full runtime (its own pool, LISTEN connection, live feed and
 * worker) in this process. Needs TEST_DATABASE_URL; skipped without it.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TrackerEvent } from '@a4a/shared';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminCtx, createRuntime, type Runtime } from '../src/app-services';
import { loadConfig } from '../src/config';
import type { Ctx, UserRow } from '../src/context';
import { openDatabase, type Database } from '../src/db/client';
import { activities, fields, idempotencyKeys, outboxCursors, webhookDeliveries, workerLeases } from '../src/db/schema';
import type { PgSignals, PgSignalsOptions, Signal } from '../src/events/signals';
import { webhookConsumer } from '../src/events/webhooks';
import type { Chore, OutboxConsumer, OutboxWorker, WorkerOptions } from '../src/events/worker';
import { createHttpApp } from '../src/http/app';
import { startBackground } from '../src/server';
import { issueTokenFor } from '../src/services/auth';
import { addFieldValue } from '../src/services/fields';
import { createIssue } from '../src/services/issues';
import { createProject } from '../src/services/projects';
import { fieldByName } from '../src/services/schema-cache';
import { insertUser } from '../src/services/users';
import { createWebhook, deleteWebhook } from '../src/events/webhooks';
import { freshPostgres } from './helpers';
import { openStream } from './sse-client';

const PG_URL = process.env.TEST_DATABASE_URL;
const BASE = 'http://localhost:3510';
const LEASE_MS = 1_500;
const POLL_MS = 100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, timeoutMs: number, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`${what} not met within ${timeoutMs} ms`);
    await sleep(20);
  }
}

interface Instance {
  runtime: Runtime;
  database: Database;
  http: ReturnType<typeof createHttpApp>;
  worker: OutboxWorker;
  /** Event ids the probe consumer handled here, in order. */
  handled: number[];
  /** Times the probe chore ran here. */
  chores: { runs: number };
  /** Make the probe consumer take this long on its next event. */
  slow: { ms: number };
  request: (path: string, init: RequestInit) => Promise<Response>;
  stop(opts?: { releaseLease?: boolean }): Promise<void>;
}

async function startInstance(url: string, opts: { worker?: WorkerOptions; signals?: PgSignalsOptions; webhooks?: boolean } = {}): Promise<Instance> {
  const database = await openDatabase({ url });
  const config = loadConfig({ aiEnabled: false, seedDemo: false, publicUrl: BASE, webDist: undefined, trustProxy: 1 });
  // A backstop longer than any test: what arrives must have come by NOTIFY, a reconnect or a recheck.
  const runtime = await createRuntime(config, database, { live: { backstopMs: 120_000 }, signals: { retryMs: 200, ...opts.signals } });
  const handled: number[] = [];
  const slow = { ms: 0 };
  const chores = { runs: 0 };
  const probe: OutboxConsumer = {
    name: 'probe',
    async handle(event) {
      handled.push(event.id);
      if (slow.ms) {
        const ms = slow.ms;
        slow.ms = 0;
        await sleep(ms);
      }
    },
  };
  const chore: Chore = { name: 'probe', everyMs: 100, run: async () => void chores.runs++ };
  const consumers = opts.webhooks ? [probe, webhookConsumer(runtime)] : [probe];
  const bg = await startBackground(runtime, consumers, { worker: { leaseMs: LEASE_MS, pollMs: POLL_MS, ...opts.worker }, chores: [chore] });
  const http = createHttpApp(runtime);
  let stopped = false;
  return {
    runtime,
    database,
    http,
    worker: bg.worker,
    handled,
    chores,
    slow,
    request: async (path, init) => http.request(path, init),
    stop: async (stopOpts) => {
      if (stopped) return;
      stopped = true;
      await bg.stop(stopOpts);
      await database.close();
    },
  };
}

describe.skipIf(!PG_URL)('several instances on one Postgres', () => {
  let db: Awaited<ReturnType<typeof freshPostgres>>;
  let a: Instance;
  let b: Instance;
  const others: Instance[] = [];
  let admin: UserRow;
  let token: string;
  let ctxA: Ctx;
  let hookServer: Server | null = null;

  const maxActivityId = async () => Number((await a.runtime.db.select({ max: sql<number>`coalesce(max(${activities.id}), 0)` }).from(activities))[0]!.max);
  const idsAfter = async (after: number) =>
    (await a.runtime.db.select({ id: activities.id }).from(activities).where(sql`${activities.id} > ${after}`).orderBy(activities.id)).map((r) => r.id);
  const leaseHolder = async () => (await a.runtime.db.select().from(workerLeases).where(eq(workerLeases.name, 'outbox')))[0]?.holder;
  const activeAndStandby = () => (a.worker.active ? [a, b] : [b, a]) as [Instance, Instance];

  beforeAll(async () => {
    db = (await freshPostgres())!;
    [a, b] = await Promise.all([startInstance(db.url, { webhooks: true }), startInstance(db.url, { webhooks: true, signals: { retryMs: 600 } })]);
    admin = await insertUser(a.runtime.db, { login: 'admin', name: 'Ada Admin', role: 'admin', password: 'password-admin' });
    a.runtime.schema.invalidate();
    ctxA = adminCtx(a.runtime, admin, 'api');
    await createProject(ctxA, { key: 'BACK', name: 'Backend', template: 'software' });
    token = (await issueTokenFor(a.runtime.db, admin.id, { name: 'cluster', scopes: ['read', 'write', 'admin'] })).token;
  });

  afterAll(async () => {
    hookServer?.close();
    for (const i of [a, b, ...others]) await i?.stop();
    await db?.drop();
  });

  it('starts two instances together on an empty database: one migration, one set of defaults', async () => {
    const fresh = (await freshPostgres())!;
    try {
      const [d1, d2] = await Promise.all([openDatabase({ url: fresh.url }), openDatabase({ url: fresh.url })]);
      const config = loadConfig({ aiEnabled: false, seedDemo: false });
      await Promise.all([createRuntime(config, d1), createRuntime(config, d2)]);
      const states = await d1.db.select().from(fields).where(eq(fields.name, 'State'));
      expect(states).toHaveLength(1);
      await d1.close();
      await d2.close();
    } finally {
      await fresh.drop();
    }
  });

  describe('live events', () => {
    it('sends an event written on A to a stream on B within a second', async () => {
      const stream = await openStream(b.request, token);
      await stream.waitFor((f) => f.event === 'ready');
      const started = Date.now();
      const issue = await createIssue(ctxA, { project: 'BACK', summary: 'Written on A' });
      const frame = await stream.waitFor((f) => f.event === 'issue.created' && (JSON.parse(f.data) as TrackerEvent).issue?.id === issue.id, 3_000);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(frame.id).toBe(String((JSON.parse(frame.data) as TrackerEvent).id));
      await stream.close();
    });

    it('resumes a stream from its last event id on the other instance, missing and repeating nothing', async () => {
      const first = await openStream(b.request, token);
      await first.waitFor((f) => f.event === 'ready');
      await createIssue(ctxA, { project: 'BACK', summary: 'Seen live' });
      await first.waitForEvents(1);
      const last = first.lastEventId()!;
      await first.close();
      const missed = [];
      for (const n of [1, 2, 3]) missed.push(await createIssue(ctxA, { project: 'BACK', summary: `Missed ${n}` }));
      // A load balancer may send the reconnect anywhere.
      const second = await openStream(a.request, token, { lastEventId: last });
      const replayed = await second.waitForEvents(3);
      expect(replayed.map((e) => e.issue?.id)).toEqual(missed.map((i) => i.id));
      const live = await createIssue(ctxA, { project: 'BACK', summary: 'Live again' });
      const all = await second.waitForEvents(4);
      expect(all[3]!.issue?.id).toBe(live.id);
      const ids = all.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual([...ids].sort((x, y) => x - y));
      expect(ids[0]).toBeGreaterThan(Number(last));
      await second.close();
    });

    it('catches up from the log when its LISTEN connection is cut', async () => {
      const stream = await openStream(b.request, token);
      await stream.waitFor((f) => f.event === 'ready');
      const signals = b.runtime.signals as PgSignals;
      const seen: Signal['kind'][] = [];
      const unsubscribe = signals.subscribe((s) => seen.push(s.kind));
      const pid = signals.backendPid!;
      const admin = new pg.Client({ connectionString: db!.url });
      await admin.connect();
      await admin.query('select pg_terminate_backend($1)', [pid]);
      await admin.end();
      await until(() => !signals.listening, 2_000, 'B noticing the cut');
      // Written while B can't hear: their notifications are lost to it.
      const written = [];
      for (const n of [1, 2, 3]) written.push(await createIssue(ctxA, { project: 'BACK', summary: `While B was not listening ${n}` }));
      const got = await stream.waitForEvents(3, 5_000);
      expect(got.map((e) => e.issue?.id)).toEqual(written.map((i) => i.id));
      expect(signals.listening).toBe(true);
      expect(signals.backendPid).not.toBe(pid);
      expect(seen).toContain('resync');
      unsubscribe();
      await stream.close();
    });

    it('reconnects a LISTEN connection that stays open but hears nothing', async () => {
      const deaf = await startInstance(db!.url, { signals: { pingMs: 150, pingTimeoutMs: 300, retryMs: 100 } });
      others.push(deaf);
      const signals = deaf.runtime.signals as PgSignals;
      const pid = signals.backendPid;
      // No error, no closed socket: it just stops hearing, as through a pooler that drops LISTEN.
      await (signals as unknown as { client: pg.Client }).client.query('UNLISTEN *');
      const stream = await openStream(deaf.request, token);
      await stream.waitFor((f) => f.event === 'ready');
      const issue = await createIssue(ctxA, { project: 'BACK', summary: 'Heard once the ping failed' });
      await stream.waitFor((f) => f.event === 'issue.created' && (JSON.parse(f.data) as TrackerEvent).issue?.id === issue.id, 3_000);
      expect(signals.backendPid).not.toBe(pid);
      await stream.close();
      await deaf.stop();
    });

    it('holds an event behind a lower id that commits late, and passes an id that rolls back', async () => {
      const stream = await openStream(b.request, token);
      await stream.waitFor((f) => f.event === 'ready');
      const tx = new pg.Client({ connectionString: db!.url });
      const unrelated = new pg.Client({ connectionString: db!.url });
      await tx.connect();
      await unrelated.connect();
      const insert = `insert into activities (type, channel, payload) values ('issue.updated', 'system', '{"data":{"note":"held"}}') returning id`;
      try {
        await tx.query('begin');
        const heldId = Number((await tx.query<{ id: string }>(insert)).rows[0]!.id);
        const later = await createIssue(ctxA, { project: 'BACK', summary: 'Committed after a lower id' });
        await sleep(700);
        expect(stream.events()).toEqual([]);
        await tx.query('commit');
        const got = await stream.waitForEvents(2, 3_000);
        expect(got.map((e) => e.id)).toEqual([heldId, heldId + 1]);
        expect(got[1]!.issue?.id).toBe(later.id);

        // Work elsewhere in the database, left open, must not hold the gap: only writers of the log count.
        await unrelated.query('begin');
        await unrelated.query(`insert into settings (key, value) values ('unrelated-open-writer', '1'::jsonb)`);
        await tx.query('begin');
        const lostId = Number((await tx.query<{ id: string }>(insert)).rows[0]!.id);
        const next = await createIssue(ctxA, { project: 'BACK', summary: 'Committed after an id that rolls back' });
        await sleep(500);
        expect(stream.events()).toHaveLength(2);
        await tx.query('rollback');
        const rolledBack = Date.now();
        await stream.waitFor((f) => f.event === 'issue.created' && (JSON.parse(f.data) as TrackerEvent).issue?.id === next.id, 3_000);
        expect(Date.now() - rolledBack).toBeLessThan(1_000);
        expect(stream.events().map((e) => e.id)).toEqual([heldId, heldId + 1, lostId + 1]);
      } finally {
        await unrelated.query('rollback').catch(() => {});
        await unrelated.end();
        await tx.end();
        await stream.close();
      }
    });

    it('waits for the lower id also when its transaction has the newest transaction id', async () => {
      // The interleaving pg_current_snapshot() can't see: the transaction holding the gap
      // got its transaction id after the one that committed the next row.
      const stream = await openStream(b.request, token);
      await stream.waitFor((f) => f.event === 'ready');
      const early = new pg.Client({ connectionString: db!.url });
      const late = new pg.Client({ connectionString: db!.url });
      await early.connect();
      await late.connect();
      const insert = `insert into activities (type, channel, payload) values ('issue.updated', 'system', '{}') returning id`;
      try {
        await early.query('begin');
        await early.query(`insert into settings (key, value) values ('xid-order-probe', '1'::jsonb)`);
        await late.query('begin');
        await late.query(`insert into settings (key, value) values ('xid-order-probe-2', '1'::jsonb)`);
        const heldId = Number((await late.query<{ id: string }>(insert)).rows[0]!.id);
        const nextId = Number((await early.query<{ id: string }>(insert)).rows[0]!.id);
        await early.query('commit');
        await early.query(`select pg_notify('a4a_events', $1)`, [`test ${nextId}`]);
        await sleep(800);
        expect(stream.events()).toEqual([]);
        await late.query('commit');
        const got = await stream.waitForEvents(2, 3_000);
        expect(got.map((e) => e.id)).toEqual([heldId, nextId]);
      } finally {
        await early.query(`delete from settings where key like 'xid-order-probe%'`).catch(() => {});
        await early.end();
        await late.end();
        await stream.close();
      }
    });
  });

  describe('reference data', () => {
    it('sees a field value added on A at once on B, well before the minute', async () => {
      const before = await b.runtime.schema.get();
      const subsystem = fieldByName(before, 'Subsystem')!;
      expect(before.valuesByField.get(subsystem.id)!.some((v) => v.name === 'Payments')).toBe(false);
      const started = Date.now();
      await addFieldValue(ctxA, subsystem.id, { name: 'Payments', project: 'BACK' });
      await until(async () => (await b.runtime.schema.get()).valuesByField.get(subsystem.id)!.some((v) => v.name === 'Payments'), 2_000, 'B seeing the value');
      expect(Date.now() - started).toBeLessThan(1_000);
      const res = await b.request('/api/v1/projects/BACK/fields', { headers: { authorization: `Bearer ${token}` } });
      const body = (await res.json()) as { name: string; values: { name: string }[] }[];
      expect(body.find((f) => f.name === 'Subsystem')!.values.map((v) => v.name)).toContain('Payments');
    });

    it('sees a tag created inside a transaction on A once that commits', async () => {
      expect((await b.runtime.schema.get()).tagsByName.has('cluster-made')).toBe(false);
      await createIssue(ctxA, { project: 'BACK', summary: 'Tagged on A', tags: ['cluster-made'] });
      await until(async () => (await b.runtime.schema.get()).tagsByName.has('cluster-made'), 2_000, 'B seeing the tag');
    });
  });

  describe('accounts', () => {
    const signIn = (inst: Instance, login: string, password: string, ip = '198.51.100.7') =>
      inst.request('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ login, password }),
      });

    it('shares the login throttle between instances, and keeps it across a restart', async () => {
      await insertUser(a.runtime.db, { login: 'tess', name: 'Tess Throttle', password: 'password-tess' });
      for (let n = 0; n < 10; n++) expect((await signIn(n % 2 ? a : b, 'tess', 'wrong')).status).toBe(401);
      const blocked = await signIn(a, 'tess', 'password-tess');
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(800);
      expect((await signIn(b, 'tess', 'password-tess', '203.0.113.50')).status).toBe(429);
      // A new instance, as after a restart, counts from the same rows.
      const c = await startInstance(db!.url);
      others.push(c);
      expect((await signIn(c, 'tess', 'password-tess', '203.0.113.51')).status).toBe(429);
      await c.stop();
    });

    it('counts parallel attempts on both instances before checking them, so none slip past', async () => {
      await insertUser(a.runtime.db, { login: 'pat', name: 'Pat Parallel', password: 'password-pat' });
      const results = await Promise.all(Array.from({ length: 16 }, (_, n) => signIn(n % 2 ? a : b, 'pat', 'wrong', `192.0.2.${n}`)));
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 401)).toHaveLength(10);
      expect(statuses.filter((s) => s === 429)).toHaveLength(6);
    });

    it('keeps a session made on A valid on B, and a sign-out on B ends it on A', async () => {
      const res = await signIn(a, 'admin', 'password-admin');
      expect(res.status).toBe(200);
      const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
      expect((await b.request('/api/v1/me', { headers: { cookie } })).status).toBe(200);
      expect((await b.request('/api/v1/auth/logout', { method: 'POST', headers: { cookie, origin: BASE } })).status).toBe(204);
      expect((await a.request('/api/v1/me', { headers: { cookie } })).status).toBe(401);
    });

    it('replays an Idempotency-Key on the other instance, and lets a key abandoned mid-request be used again', async () => {
      const post = (inst: Instance, key: string, summary: string) =>
        inst.request('/api/v1/issues', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key },
          body: JSON.stringify({ project: 'BACK', summary }),
        });
      const first = await post(a, 'build-4711', 'Build 4711 failed');
      expect(first.status).toBe(201);
      const retry = await post(b, 'build-4711', 'Build 4711 failed');
      expect(retry.status).toBe(201);
      expect(retry.headers.get('idempotent-replayed')).toBe('true');
      expect(((await retry.json()) as { id: string }).id).toBe(((await first.json()) as { id: string }).id);

      // Both instances at once with one key: one issue.
      const before = await maxActivityId();
      const both = await Promise.all([post(a, 'build-4712', 'Build 4712 failed'), post(b, 'build-4712', 'Build 4712 failed')]);
      expect(both.map((r) => r.status).sort()).toEqual(expect.arrayContaining([201]));
      expect((await idsAfter(before)).length).toBe(1);

      // An instance died holding a claim ten minutes ago: the retry runs instead of answering 409 for a day.
      await a.runtime.db.insert(idempotencyKeys).values({
        userId: admin.id,
        key: 'build-4713',
        method: 'POST',
        path: `POST /api/v1/issues ${sha256Hex(JSON.stringify({ project: 'BACK', summary: 'Build 4713 failed' }))}`,
        statusCode: 0,
        responseBody: null,
        createdAt: new Date(Date.now() - 10 * 60_000),
      });
      expect((await post(b, 'build-4713', 'Build 4713 failed')).status).toBe(201);
    });
  });

  describe('the outbox worker', () => {
    it('runs consumers and chores on exactly one instance', async () => {
      await until(() => a.worker.active || b.worker.active, 3_000, 'a lease holder');
      const [active, standby] = activeAndStandby();
      expect(standby.worker.active).toBe(false);
      expect(await leaseHolder()).toBe(active.runtime.instanceId);
      const start = await maxActivityId();
      for (const n of [1, 2, 3, 4, 5]) await createIssue(ctxA, { project: 'BACK', summary: `For the worker ${n}` });
      const expected = await idsAfter(start);
      await until(() => expected.every((id) => active.handled.includes(id)), 3_000, 'the holder handling every event');
      await sleep(300);
      expect(active.handled.filter((id) => id > start)).toEqual(expected);
      expect(standby.handled.filter((id) => id > start)).toEqual([]);
      const standbyChores = standby.chores.runs;
      await sleep(400);
      expect(active.chores.runs).toBeGreaterThan(0);
      expect(standby.chores.runs).toBe(standbyChores);
    });

    it('delivers a webhook once per event, though both instances run the webhook consumer', async () => {
      const received: number[] = [];
      hookServer = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          received.push((JSON.parse(body) as TrackerEvent).id);
          res.writeHead(204).end();
        });
      });
      await new Promise<void>((r) => hookServer!.listen(3512, '127.0.0.1', () => r()));
      const port = (hookServer.address() as AddressInfo).port;
      const hook = await createWebhook(ctxA, { url: `http://127.0.0.1:${port}/hook`, events: ['issue.created'] });
      const issues = [];
      for (const n of [1, 2, 3]) issues.push(await createIssue(ctxA, { project: 'BACK', summary: `Hooked ${n}` }));
      await until(() => received.length >= 3, 5_000, 'three deliveries');
      await sleep(500);
      expect(received).toHaveLength(3);
      expect(new Set(received).size).toBe(3);
      const deliveries = await a.runtime.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, hook.id));
      expect(deliveries.filter((d) => d.success)).toHaveLength(3);
      await deleteWebhook(ctxA, hook.id);
    });

    it('keeps the lease while a consumer takes longer than the lease', async () => {
      const [active, standby] = activeAndStandby();
      const start = await maxActivityId();
      active.slow.ms = LEASE_MS * 2;
      await createIssue(ctxA, { project: 'BACK', summary: 'Slow to handle' });
      const [id] = await idsAfter(start);
      await until(() => active.handled.includes(id!), 3_000, 'the slow event starting');
      await sleep(LEASE_MS * 2 + 300);
      expect(await leaseHolder()).toBe(active.runtime.instanceId);
      expect(standby.worker.active).toBe(false);
      expect(standby.handled).not.toContain(id);
    });

    it('ignores a clock that runs ahead: the lease is kept on the database clock', async () => {
      const [active] = activeAndStandby();
      const ahead = await startInstance(db!.url, { worker: { now: () => Date.now() + 10 * 60_000 } });
      others.push(ahead);
      await sleep(LEASE_MS + 300);
      expect(ahead.worker.active).toBe(false);
      expect(await leaseHolder()).toBe(active.runtime.instanceId);
      await ahead.stop();
    });

    it('hands the lease over within the lease time when the holder dies', async () => {
      const [active, standby] = activeAndStandby();
      const start = await maxActivityId();
      for (const n of [1, 2]) await createIssue(ctxA, { project: 'BACK', summary: `Before the crash ${n}` });
      const first = await idsAfter(start);
      await until(() => first.every((id) => active.handled.includes(id)), 3_000, 'the holder handling the first batch');
      await until(
        async () => ((await a.runtime.db.select().from(outboxCursors).where(eq(outboxCursors.consumer, 'probe')))[0]?.lastId ?? 0) >= first.at(-1)!,
        2_000,
        'the cursor being saved',
      );
      // As in a crash: no more renewals, and the lease is left to expire.
      const died = Date.now();
      await active.worker.stop({ releaseLease: false });
      await until(() => standby.worker.active, LEASE_MS + POLL_MS + 1_000, 'the standby taking over');
      const tookOver = Date.now() - died;
      expect(tookOver).toBeGreaterThan(LEASE_MS - 600);
      expect(tookOver).toBeLessThan(LEASE_MS + POLL_MS + 500);
      expect(await leaseHolder()).toBe(standby.runtime.instanceId);
      const mid = await maxActivityId();
      for (const n of [1, 2]) await createIssue(ctxA, { project: 'BACK', summary: `After the crash ${n}` });
      const second = await idsAfter(mid);
      await until(() => second.every((id) => standby.handled.includes(id)), 3_000, 'the successor handling new events');
      // The successor starts at the saved cursor: nothing from before the crash again.
      expect(standby.handled.filter((id) => first.includes(id))).toEqual([]);
    });
  });
});

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
