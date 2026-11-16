import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { createRuntime, type Runtime } from './app-services';
import { loadConfig, type Config } from './config';
import { openDatabase } from './db/client';
import { seedDemo } from './db/seed';
import { OutboxWorker, type OutboxConsumer } from './events/worker';
import { webhookConsumer } from './events/webhooks';
import { createHttpApp } from './http/app';
import { needsSetup } from './services/auth';
import { insertUser } from './services/users';

export interface Started {
  runtime: Runtime;
  url: string;
  stop(): Promise<void>;
}

/** Extra consumers (e.g. AI triage) register here before start. */
export const consumerFactories: ((runtime: Runtime) => OutboxConsumer | null)[] = [];

/** Other background work that starts and stops with the server (e.g. the mail sender). */
export interface BackgroundWork {
  start(): void;
  stop(): Promise<void>;
}
export const backgroundFactories: ((runtime: Runtime) => BackgroundWork | null)[] = [];

export async function startServer(overrides: Partial<Config> = {}): Promise<Started> {
  const config = loadConfig(overrides);
  const database = await openDatabase({ url: config.databaseUrl, dataDir: config.dataDir });
  const runtime = await createRuntime(config, database);

  // Optional unattended bootstrap (containers, CI): ADMIN_LOGIN + ADMIN_PASSWORD.
  const login = process.env.ADMIN_LOGIN;
  const password = process.env.ADMIN_PASSWORD;
  if (login && password && (await needsSetup(runtime.db))) {
    const admin = await insertUser(runtime.db, { login, name: process.env.ADMIN_NAME ?? login, password, role: 'admin' });
    runtime.schema.invalidate();
    if (config.seedDemo) await seedDemo(runtime, admin);
  }

  await runtime.live.start();
  const consumers = [webhookConsumer(runtime), ...consumerFactories.map((f) => f(runtime)).filter((c): c is OutboxConsumer => c !== null)];
  const worker = new OutboxWorker(runtime, consumers);
  worker.start();
  const background = backgroundFactories.map((f) => f(runtime)).filter((b): b is BackgroundWork => b !== null);
  for (const b of background) b.start();
  const stopBackground = () => Promise.all(background.map((b) => b.stop().catch(() => {})));

  const app = createHttpApp(runtime);
  const server = await new Promise<Server>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port: config.port, hostname: process.env.HOST ?? '0.0.0.0' }, () => resolve(s as Server));
    (s as Server).once('error', (err: NodeJS.ErrnoException) => {
      reject(err.code === 'EADDRINUSE' ? new Error(`Port ${config.port} is already in use; set PORT to another one`) : err);
    });
  }).catch(async (err) => {
    runtime.live.stop();
    await worker.stop();
    await stopBackground();
    await database.close();
    throw err;
  });

  let stopping: Promise<void> | null = null;
  const stop = () =>
    (stopping ??= (async () => {
      await new Promise<void>((r) => server.close(() => r()));
      runtime.live.stop();
      await worker.stop();
      await stopBackground();
      await database.close();
    })());

  return { runtime, url: config.publicUrl, stop };
}
