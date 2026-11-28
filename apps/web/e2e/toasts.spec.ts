/**
 * The toast host (components/Toasts.tsx, D72), held to Ocean's Toast: served on a page of its own
 * (fixtures/toasts), through Vite on a port of its own, in a clock the test moves. A view's edit and its
 * undo in the real app are view-undo.spec.ts's.
 *
 * - The region is a landmark, "Notifications", always in the page, with a status line of its own that
 *   says each toast once: its words, and with Undo how to undo from the keyboard, unless the page said
 *   it already. The toasts aren't live; Undo and Dismiss are described by their toast's words.
 * - F8 reaches the newest toast, and goes back; Escape closes it, and the focus goes back where it was.
 * - Time to read it: six seconds, ten with Undo, a second more for every ten words past ten; held
 *   while the pointer or the focus is on it, then going on from where it was; three at most.
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

test('a toast is said once by the region’s status line, offers Undo once, and stands while it is read', async ({ page }) => {
  const problems = await open(page);
  const region = page.getByRole('region', { name: 'Notifications' });
  const said = region.getByRole('status');
  const toasts = region.locator('.toast');
  await expect(region).toHaveAttribute('aria-keyshortcuts', 'F8');
  await expect(said).toHaveText('');
  await expect(toasts).toHaveCount(0);

  const moveIt = page.getByRole('button', { name: 'Move it' });
  await moveIt.click();
  await expect(toasts).toHaveCount(1);
  await page.clock.runFor(100);
  // Its words and how to undo from the keyboard, said once; the toasts themselves aren't live.
  await expect(said).toHaveText('Moved BACK-12 to 3 March. Ctrl+Z undoes it.');
  expect(await region.locator('[aria-live], [role="status"], [role="alert"], [role="log"]').count()).toBe(1);
  expect(await region.evaluate((el) => el.getAttribute('aria-live') ?? el.getAttribute('role'))).toBeNull();
  const undo = toasts.getByRole('button', { name: 'Undo' });
  await expect(undo).toHaveAccessibleDescription('Moved BACK-12 to 3 March.');
  await expect(toasts.getByRole('button', { name: 'Dismiss' })).toHaveAccessibleDescription('Moved BACK-12 to 3 March.');

  // Ten seconds with Undo; held under the pointer for as long as it's there; let go, it goes on from where it was.
  await page.mouse.move(1, 1);
  await page.clock.runFor(8_000);
  await expect(toasts).toHaveCount(1);
  await toasts.hover();
  await page.clock.runFor(30_000);
  await expect(toasts).toHaveCount(1);
  await page.mouse.move(1, 1);
  await page.clock.runFor(1_800);
  await expect(toasts).toHaveCount(1);
  await page.clock.runFor(300);
  await expect(toasts).toHaveCount(0);

  // Undo runs once, the toast goes with it, and the focus goes back to where it came from.
  await moveIt.click();
  await undo.click();
  await expect(page.getByText('Undone 1 times')).toBeVisible();
  await expect(toasts).toHaveCount(0);
  await expect(moveIt).toBeFocused();

  // F8 reaches it from anywhere; it's held while focused; F8 again goes back, and so does Escape.
  await moveIt.click();
  await page.getByRole('button', { name: 'Save it' }).focus();
  await page.keyboard.press('F8');
  await expect(undo).toBeFocused();
  await page.clock.runFor(60_000);
  await expect(toasts).toHaveCount(1);
  await page.keyboard.press('F8');
  await expect(page.getByRole('button', { name: 'Save it' })).toBeFocused();
  await page.keyboard.press('F8');
  await expect(undo).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(toasts).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save it' })).toBeFocused();
  await expect(page.getByText('Undone 1 times')).toBeVisible();
  expect(problems).toEqual([]);
});

test('what the page said already is shown and not said again; more words stand longer', async ({ page }) => {
  const problems = await open(page);
  const region = page.getByRole('region', { name: 'Notifications' });
  const said = region.getByRole('status');
  const toasts = region.locator('.toast');
  await page.getByRole('button', { name: 'Save it' }).click();
  await page.clock.runFor(100);
  await expect(said).toHaveText('Saved 1.');
  // Said on the page where it happened: shown, and the status line is left alone.
  await page.getByRole('button', { name: 'Cancel T-1' }).click();
  await page.clock.runFor(100);
  await expect(page.locator('main').getByRole('status')).toHaveText('Cancelled T-1.');
  await expect(toasts.locator('.toast-words')).toHaveText(['Saved 1.', 'Cancelled T-1.']);
  await expect(said).toHaveText('Saved 1.');
  await toasts.nth(0).getByRole('button', { name: 'Dismiss' }).click();
  await toasts.nth(0).getByRole('button', { name: 'Dismiss' }).click();

  // Twenty-five words: six seconds, and two more.
  await page.mouse.move(1, 1);
  await page.getByRole('button', { name: 'Say a lot' }).click();
  await page.mouse.move(1, 1);
  await page.clock.runFor(7_800);
  await expect(toasts).toHaveCount(1);
  await page.clock.runFor(300);
  await expect(toasts).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('three toasts at most, the newest at the foot, each going after six seconds; Dismiss closes one at once', async ({ page }) => {
  const problems = await open(page);
  const toasts = page.getByRole('region', { name: 'Notifications' }).locator('.toast');
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
  const toast = page.getByRole('region', { name: 'Notifications' }).locator('.toast');
  // Held under the pointer while axe reads it, on the page's own clock.
  await toast.hover();
  await expectAccessible(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(page);
  await expect(toast).toHaveCount(1);
  expect(problems).toEqual([]);
});
