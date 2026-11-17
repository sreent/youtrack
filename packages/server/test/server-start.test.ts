/**
 * The server as it starts for real: on a database of its own, listening, answering, and keeping an
 * idle connection open longer than a load balancer in front would.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { KEEP_ALIVE_MS, startServer, type Started } from '../src/server';

let started: Started | undefined;
let dir = '';

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'a4a-start-'));
  started = await startServer({ port: 0, dataDir: dir, databaseUrl: undefined, seedDemo: false, aiEnabled: false, smtpUrl: undefined });
});

afterAll(async () => {
  await started?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it("keeps an idle connection open past a load balancer's 60 seconds, and answers", async () => {
  const server = started!.server;
  // A balancer that keeps a connection 60 s closes it first, so it never sends down one a4a closed.
  expect(KEEP_ALIVE_MS).toBeGreaterThan(60_000);
  expect(server.keepAliveTimeout).toBe(KEEP_ALIVE_MS);
  expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
  expect(res.status).toBe(200);
});
