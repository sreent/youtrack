/**
 * Files shown in place (docs/architecture.md, D35): a log read from its start or its end, in a
 * frame of its own; sound and video played by the browser, which fetches them in ranges. Nothing
 * opens by itself, and an HTML page shows as its source, never as a page.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import { uniqueKey, type Api } from './support/api';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { SECOND_AUTH_FILE } from './support/env';
import { expect, test } from './support/fixtures';

// The second of the flows' administrators (support/env.ts says why).
test.use({ storageState: SECOND_AUTH_FILE });

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** A log long enough that only part of it shows: 2,000 lines. */
const LOG = Array.from({ length: 2000 }, (_, i) => `2026-11-16 09:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')} INFO line ${i + 1} of the export\n`).join('');

async function issueWithFiles(api: Api, page: Page): Promise<Locator> {
  const key = uniqueKey('FL');
  await api.createProject({ key, name: `Files ${key}` });
  const issue = await api.createIssue({ project: key, summary: 'The export stops halfway' });
  await page.goto(`/issues/${issue.id}`);
  const files = page.getByRole('region', { name: 'Files', exact: true });
  await expect(files).toBeVisible();
  return files;
}

/** Attach through the page's own picker, as a person would. */
async function attach(files: Locator, name: string, buffer: Buffer, mimeType = 'application/octet-stream') {
  await files.locator('input[type="file"]').setInputFiles({ name, mimeType, buffer });
  await expect(files.getByRole('link', { name, exact: true })).toBeVisible();
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme });

    test('a log is shown in place, from its start or its end, and hides again', async ({ page, api }) => {
      const files = await issueWithFiles(api, page);
      await attach(files, 'export.log', Buffer.from(LOG), 'text/plain');
      await attach(files, 'login.txt', Buffer.from('2026-11-16 09:10:02 sign-in as diego‮gnp.exe\n'), 'text/plain');

      const show = files.getByRole('button', { name: 'Show export.log' });
      await expect(show).toHaveAttribute('aria-expanded', 'false');
      await show.click();
      const start = files.getByLabel('export.log, its first 64 KB');
      await expect(start).toContainText('09:00:00 INFO line 1 of the export');
      await expect(start).not.toContainText('line 2000 of the export');
      await expect(files.getByText(/^The first 64 KB of \d+ KB\.$/)).toBeVisible();
      await expect(files.getByRole('button', { name: 'Hide export.log' })).toHaveAttribute('aria-expanded', 'true');

      await files.getByRole('button', { name: 'Show the end' }).click();
      const end = files.getByLabel('export.log, its last 64 KB');
      await expect(end).toContainText('line 2000 of the export');
      await expect(end).not.toContainText('09:00:00 INFO line 1 of the export');
      await expect(files.getByRole('button', { name: 'Show the start' })).toBeVisible();

      // A character that turns text around shows as its code, so the line can't pass for another.
      await files.getByRole('button', { name: 'Show login.txt' }).click();
      const login = files.getByLabel('login.txt', { exact: true });
      await expect(login.locator('.attachment-mark')).toHaveText('U+202E');
      await expect(login).toContainText('diegoU+202Egnp.exe');

      await expectNoSidewaysScroll(page);
      await expectAccessible(page);

      await files.getByRole('button', { name: 'Hide export.log' }).click();
      await expect(end).toBeHidden();
      await expect(files.getByRole('button', { name: 'Show export.log' })).toHaveAttribute('aria-expanded', 'false');
    });
  });
}

test('sound and video play in the page, fetched in ranges; an HTML page shows as its source', async ({ page, api }) => {
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  const files = await issueWithFiles(api, page);
  await attach(files, 'tone.ogg', readFileSync(path.join(FIXTURES, 'tone.ogg')), 'audio/ogg');
  await attach(files, 'clip.webm', readFileSync(path.join(FIXTURES, 'clip.webm')), 'video/webm');
  const html = '<!doctype html><html><body><script>alert("ran")</script><img src=x onerror="alert(1)"></body></html>';
  await attach(files, 'saved-page.html', Buffer.from(html), 'text/html');

  // Ranges, as players ask for them: the server answers 206.
  const ranged = page.waitForResponse((r) => r.url().includes('/content') && r.status() === 206);
  await files.getByRole('button', { name: 'Show tone.ogg' }).click();
  const audio = files.getByLabel('tone.ogg', { exact: true });
  await expect(audio).toBeVisible();
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.readyState)).toBeGreaterThanOrEqual(1);
  expect(await audio.evaluate((a: HTMLAudioElement) => Math.round(a.duration))).toBe(1);
  expect((await ranged).headers()['content-range']).toMatch(/^bytes \d+-\d+\/\d+$/);

  await files.getByRole('button', { name: 'Show clip.webm' }).click();
  const video = files.getByLabel('clip.webm', { exact: true });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1);
  expect(await video.evaluate((v: HTMLVideoElement) => [v.videoWidth, v.videoHeight])).toEqual([64, 48]);

  // A page that would run, shown as what it says, and never run: its name still downloads it.
  await files.getByRole('button', { name: 'Show saved-page.html' }).click();
  await expect(files.getByLabel('saved-page.html', { exact: true })).toHaveText(html);
  await expect(files.getByRole('link', { name: 'saved-page.html', exact: true })).toHaveAttribute('download', 'saved-page.html');
  expect(dialogs).toEqual([]);

  await expectAccessible(page);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('a long line scrolls in its own frame, never the page', async ({ page, api }) => {
    const files = await issueWithFiles(api, page);
    await attach(files, 'minified.json', Buffer.from(`{"items":[${Array.from({ length: 300 }, (_, i) => `{"id":${i},"name":"item ${i}"}`).join(',')}]}\n`), 'application/json');
    await files.getByRole('button', { name: 'Show minified.json' }).click();
    const text = files.getByLabel('minified.json', { exact: true });
    await expect(text).toContainText('"name":"item 0"');
    expect(await text.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
  });
});
