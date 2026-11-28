/**
 * The toast host (components/Toasts.tsx, D72), held to Ocean's Toast. Nothing in a4a shows a toast yet
 * (undo's package will), so the built app can't show one: this serves the component on a page of its
 * own (fixtures/toasts), through Vite on a port of its own, in a clock the test moves.
 *
 * - The live region is there before any toast, and says each as it comes.
 * - An action runs once and closes its toast; Dismiss and Escape close it at once, and the focus goes
 *   back where it was.
 * - Time to read it: ten seconds with an action, six without, held while the pointer or the focus is
 *   on it, and two more once let go; three at most, the newest at the foot.
 * - axe finds nothing in light or dark, and nothing scrolls sideways at 390px.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';
import { expectAccessible } from './support/checks';

const here = path.dirname(fileURLToPath(import.meta.url));
let vite: ViteDevServer | undefined;
let cache = '';
let url = '';

test.beforeAll(async () => {
  cache = mkdtempSync(path.join(tmpdir(), 'a4a-toasts-'));
  vite = await createServer({
    configFile: false,
    root: path.join(here, 'fixtures/toasts'),
    cacheDir: cache,
    plugins: [react()],
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, fs: { allow: [path.resolve(here, '../../..')] } },
  });
  await vite.listen();
  url = vite.resolvedUrls!.local[0]!;
});

test.afterAll(async () => {
  await vite?.close();
  if (cache) rmSync(cache, { recursive: true, force: true });
});

/** The page, its clock paused unless it should run (axe runs on timers), and whatever goes wrong in it. */
async function open(page: Page, clock: 'paused' | 'running' = 'paused'): Promise<string[]> {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(e.message));
  if (clock === 'paused') await page.clock.install();
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Toasts' })).toBeVisible();
  if (clock === 'paused') await page.clock.pauseAt(Date.now() + 60_000);
  return problems;
}

test('a toast is said in the live region, offers its action once, and stands while it is read', async ({ page }) => {
  const problems = await open(page);
  const region = page.getByRole('status');
  const toasts = region.locator('.toast');
  await expect(region).toBeAttached();
  await expect(toasts).toHaveCount(0);

  const moveIt = page.getByRole('button', { name: 'Move it' });
  await moveIt.click();
  await expect(toasts).toHaveCount(1);
  await expect(region).toContainText('Moved BACK-12 to 3 March.');
  await expect(toasts.getByRole('button', { name: 'Undo' })).toBeVisible();
  await expect(toasts.getByRole('button', { name: 'Dismiss' })).toBeVisible();

  // Ten seconds with an action; held under the pointer, for as long as it's there; let go, two more.
  await page.mouse.move(1, 1);
  await page.clock.runFor(9_000);
  await expect(toasts).toHaveCount(1);
  await toasts.hover();
  await page.clock.runFor(30_000);
  await expect(toasts).toHaveCount(1);
  await page.mouse.move(1, 1);
  await page.clock.runFor(1_900);
  await expect(toasts).toHaveCount(1);
  await page.clock.runFor(200);
  await expect(toasts).toHaveCount(0);

  // Its action runs once, the toast goes with it, and the focus goes back to where it came from.
  await moveIt.click();
  await toasts.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('Undone 1 times')).toBeVisible();
  await expect(toasts).toHaveCount(0);
  await expect(moveIt).toBeFocused();

  // Reached from the keyboard, it's held while focused; Escape closes it, and the focus goes back.
  await moveIt.click();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(toasts.getByRole('button', { name: 'Undo' })).toBeFocused();
  await page.clock.runFor(60_000);
  await expect(toasts).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(toasts).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save it' })).toBeFocused();
  await expect(page.getByText('Undone 1 times')).toBeVisible();
  expect(problems).toEqual([]);
});

test('three toasts at most, the newest at the foot, each going after six seconds; Dismiss closes one at once', async ({ page }) => {
  const problems = await open(page);
  const toasts = page.getByRole('status').locator('.toast');
  const saveIt = page.getByRole('button', { name: 'Save it' });
  for (let i = 0; i < 4; i++) await saveIt.click();
  await expect(toasts).toHaveCount(3);
  await expect(toasts.locator('.toast-words')).toHaveText(['Saved 2.', 'Saved 3.', 'Saved 4.']);
  await expect(toasts.getByRole('button', { name: 'Undo' })).toHaveCount(0);

  await toasts.nth(1).getByRole('button', { name: 'Dismiss' }).click();
  await expect(toasts.locator('.toast-words')).toHaveText(['Saved 2.', 'Saved 4.']);
  await expect(saveIt).toBeFocused();
  await page.mouse.move(1, 1);
  await page.clock.runFor(5_900);
  await expect(toasts).toHaveCount(2);
  await page.clock.runFor(200);
  await expect(toasts).toHaveCount(0);

  // At a phone's width, it fits.
  await page.setViewportSize({ width: 390, height: 800 });
  await saveIt.click();
  await expect(toasts).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(problems).toEqual([]);
});

test('axe finds nothing in a toast, in light or dark', async ({ page }) => {
  const problems = await open(page, 'running');
  await page.getByRole('button', { name: 'Move it' }).click();
  const toast = page.getByRole('status').locator('.toast');
  // Held under the pointer while axe reads it, on the page's own clock.
  await toast.hover();
  await expectAccessible(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(page);
  await expect(toast).toHaveCount(1);
  expect(problems).toEqual([]);
});
