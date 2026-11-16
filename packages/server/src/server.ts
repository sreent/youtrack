import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { createRuntime, type Runtime } from './app-services';
import { checkAttachmentStorage } from './attachments/storage';
import { loadConfig, type Config } from './config';
import { openDatabase } from './db/client';
import { seedDemo } from './db/seed';
import { OutboxWorker, type Chore, type OutboxConsumer, type WorkerOptions } from './events/worker';
import { webhookConsumer } from './events/webhooks';
import { ruleChores, rulesConsumer } from './workflow/engine';
import { createHttpApp } from './http/app';
import { needsSetup, pruneSessions } from './services/auth';
import { pruneLoginThrottle } from './services/login-throttle';
import { insertUser } from './services/users';

export interface Started {
  runtime: Runtime;
  url: string;
  stop(): Promise<void>;
}

/** Extra consumers (e.g. AI triage) register here before start. */
export const consumerFactories: ((runtime: Runtime) => OutboxConsumer | null)[] = [];

/** Extra upkeep for the lease holder (e.g. mail digests) registers here before start. */
export const choreFactories: ((runtime: Runtime) => Chore[])[] = [];

/**
 * Other background work that runs on every instance and starts and stops with the server (e.g.
 * the mail sender). stop() should end at once what holds a connection open, then wait for the rest.
 */
export interface BackgroundWork {
  start(): void;
  stop(): Promise<void>;
}
export const backgroundFactories: ((runtime: Runtime) => BackgroundWork | null)[] = [];

/** Upkeep the lease holder does for every instance. */
export function defaultChores(runtime: Runtime): Chore[] {
  return [
    { name: 'login-throttle', everyMs: 5 * 60_000, run: () => pruneLoginThrottle(runtime.db) },
    { name: 'sessions', everyMs: 60 * 60_000, run: () => pruneSessions(runtime.db) },
    ...choreFactories.flatMap((f) => f(runtime)),
    ...ruleChores(runtime),
  ];
}

/**
 * Start what runs beside the HTTP server: signals between instances, the live feed,
 * and the outbox worker (which acts only while this instance holds its lease).
 */
export async function startBackground(
  runtime: Runtime,
  consumers: OutboxConsumer[],
  opts: { worker?: WorkerOptions; chores?: Chore[] } = {},
): Promise<{ worker: OutboxWorker; stop(opts?: { releaseLease?: boolean }): Promise<void> }> {
  await runtime.signals.start();
  await runtime.live.start();
  const worker = new OutboxWorker(runtime, consumers, { holder: runtime.instanceId, ...opts.worker }, opts.chores ?? defaultChores(runtime));
  worker.start();
  runtime.worker = worker;
  return {
    worker,
    stop: async (stopOpts) => {
      runtime.live.stop();
      await worker.stop(stopOpts);
      await runtime.signals.stop();
    },
  };
}

export async function startServer(overrides: Partial<Config> = {}): Promise<Started> {
  const config = loadConfig(overrides);
  const database = await openDatabase({ url: config.databaseUrl, dataDir: config.dataDir });
  const runtime = await createRuntime(config, database);
  // A bucket a4a can't reach or isn't let into stops it here, saying what to check (D35).
  await checkAttachmentStorage(runtime).catch(async (e: unknown) => {
    await database.close();
    throw e;
  });

  // Optional unattended bootstrap (containers, CI): ADMIN_LOGIN + ADMIN_PASSWORD.
  // Exclusive, so replicas starting together create one administrator and seed once.
  const login = process.env.ADMIN_LOGIN;
  const password = process.env.ADMIN_PASSWORD;
  if (login && password) {
    await database.exclusive(async () => {
      if (!(await needsSetup(runtime.db))) return;
      const email = process.env.ADMIN_EMAIL?.trim() || null;
      const admin = await insertUser(runtime.db, { login, name: process.env.ADMIN_NAME ?? login, email, emailVerified: Boolean(email), password, role: 'admin' });
      runtime.schema.invalidate();
      if (config.seedDemo) await seedDemo(runtime, admin);
    });
  }

  const consumers = [
    webhookConsumer(runtime),
    rulesConsumer(runtime),
    ...consumerFactories.map((f) => f(runtime)).filter((c): c is OutboxConsumer => c !== null),
  ];
  const background = await startBackground(runtime, consumers);
  const extras = backgroundFactories.map((f) => f(runtime)).filter((b): b is BackgroundWork => b !== null);
  for (const b of extras) b.start();
  const stopExtras = () => Promise.all(extras.map((b) => b.stop().catch(() => {}))).then(() => {});

  const app = createHttpApp(runtime);
  const server = await new Promise<Server>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port: config.port, hostname: process.env.HOST ?? '0.0.0.0' }, () => resolve(s as Server));
    (s as Server).once('error', (err: NodeJS.ErrnoException) => {
      reject(err.code === 'EADDRINUSE' ? new Error(`Port ${config.port} is already in use; set PORT to another one`) : err);
    });
  }).catch(async (err) => {
    await stopExtras();
    await background.stop();
    await database.close();
    throw err;
  });

  let stopping: Promise<void> | null = null;
  const stop = () =>
    (stopping ??= (async () => {
      const closed = new Promise<void>((r) => server.close(() => r()));
      // End the live streams, or their connections would hold the server open; their
      // clients reconnect (to another instance, behind a load balancer) and resume.
      runtime.live.stop();
      const extrasStopped = stopExtras();
      await closed;
      await extrasStopped;
      await background.stop();
      await database.close();
    })());

  return { runtime, url: config.publicUrl, stop };
}
