/**
 * a4a's end-to-end suite: the production build, served by the real server under its real CSP,
 * on a database of its own, driven in Chromium. `pnpm test:e2e` at the root builds first; see the
 * README's "End-to-end tests".
 *
 * The runner evaluates this file first and sets the run's port, folder and clock in its
 * environment; the workers it starts inherit them (support/env.ts reads them).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const CI = Boolean(process.env.CI);

/** A port nothing listens on now, asked of the system (a config can't wait, so a child process asks). */
function freePort(): string {
  const script = "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})";
  return execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim();
}

if (!process.env.E2E_RUN_DIR) {
  // The runner, the first time: a fresh database for this run, removed when it ends.
  const server = path.join(root, 'packages/server/dist/index.js');
  const web = path.join(root, 'apps/web/dist/index.html');
  if (!existsSync(server) || !existsSync(web)) {
    throw new Error('The end-to-end tests run against the production build, and there is none: run "pnpm build" at the repository root first (or "pnpm test:e2e" there, which builds).');
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'a4a-e2e-'));
  mkdirSync(path.join(dir, 'auth'));
  process.env.E2E_RUN_DIR = dir;
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
}
process.env.E2E_PORT ||= freePort();
process.env.E2E_NOW ||= new Date().toISOString();

// Read only once the environment is set.
const { ADMIN, AUTH_FILE, BASE_URL, DATA_DIR, PORT } = await import('./support/env');

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.(spec|setup)\.ts$/,
  outputDir: '../test-results',
  // Files run at once, each making its own projects and issues; the tests in a file run in order.
  // The server, on its one embedded database, is what they wait on: a worker a core, up to four.
  fullyParallel: false,
  workers: CI ? Math.min(4, Math.max(2, availableParallelism())) : undefined,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [['github'], ['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    locale: 'en-GB',
    // Traces only when a test is retried in CI; locally, pass --trace on to record them.
    trace: CI ? 'on-first-retry' : 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts$/ },
    {
      name: 'chromium',
      testMatch: /.*\.spec\.ts$/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 }, storageState: AUTH_FILE },
    },
  ],
  webServer: {
    // The built server, serving the built UI itself (pnpm build makes both).
    command: 'node packages/server/dist/index.js',
    cwd: root,
    url: `${BASE_URL}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      NODE_ENV: 'production',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      PUBLIC_URL: BASE_URL,
      DATA_DIR,
      WEB_DIST: path.join(root, 'apps/web/dist'),
      ADMIN_LOGIN: ADMIN.login,
      ADMIN_PASSWORD: ADMIN.password,
      SEED_DEMO: 'true',
      // Never a developer's own database or Claude key, from their environment or a .env file:
      // the server reads .env only for what isn't set, and an empty value counts as set.
      DATABASE_URL: '',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      AI_DISABLED: 'true',
    },
  },
});
