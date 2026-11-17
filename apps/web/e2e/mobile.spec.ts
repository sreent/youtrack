/**
 * a4a on a phone (docs/architecture.md, D47): installable, opening offline and saying so, push
 * notifications on and off from the profile, what the service worker shows of a push, sharing into
 * New issue, and the pages people use on a phone at a phone's width.
 *
 * At a Pixel 7's size, as Theo, the second of the flows' administrators (support/env.ts says why).
 */
import { devices, type CDPSession, type Page } from '@playwright/test';
import { unique, uniqueKey } from './support/api';
import { SECOND_AUTH_FILE } from './support/env';
import { expect, test } from './support/fixtures';
import { fakePushManager, pushReceiver } from './support/push';

const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];
test.use({ ...pixel, storageState: SECOND_AUTH_FILE });

/** The service worker in charge of the page, once it is (it registers after the page loads). */
async function controlled(page: Page) {
  await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.ready) && navigator.serviceWorker.controller), undefined, { timeout: 20_000 });
}

/** What on the page is too small to tap, or reaches past the screen's width. */
async function phoneProblems(page: Page): Promise<{ overflow: number; small: string[] }> {
  return page.evaluate(() => {
    const small: string[] = [];
    const targets = document.querySelectorAll<HTMLElement>('button, a[href], input:not([type=hidden]), select, textarea, [role=tab], summary');
    for (const el of targets) {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (!r.width || !r.height || style.visibility === 'hidden' || el.closest('[hidden], [aria-hidden=true]')) continue;
      // A link within a sentence is the sentence's size (WCAG 2.5.8 leaves those out).
      if (el.tagName === 'A' && style.display === 'inline') continue;
      // A box or a radio is tapped by its label, its whole row.
      const label = el.matches('input[type=checkbox], input[type=radio]') ? el.closest('label') : null;
      const box = label ? label.getBoundingClientRect() : r;
      if (box.height < 43.5 || box.width < 43.5) {
        small.push(`${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(' ').join('.')}` : ''} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}" ${Math.round(box.width)}×${Math.round(box.height)}`);
      }
    }
    return { overflow: document.documentElement.scrollWidth - window.innerWidth, small };
  });
}

test('a4a can be installed: its manifest and service worker, as Chromium sees them', async ({ page, request }) => {
  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.headers()['content-type']).toContain('application/manifest+json');
  expect(manifest.headers()['cache-control']).toBe('no-cache');
  const m = (await manifest.json()) as { display: string; start_url: string; icons: { sizes: string; purpose: string }[]; shortcuts: { url: string }[]; share_target: { action: string } };
  expect(m.display).toBe('standalone');
  expect(m.icons.map((i) => `${i.sizes} ${i.purpose}`)).toEqual(expect.arrayContaining(['192x192 any', '512x512 any', '512x512 maskable']));
  expect(m.shortcuts.map((s) => s.url)).toEqual(['/issues/new', '/inbox']);
  expect(m.share_target.action).toBe('/issues/new');
  const sw = await request.get('/sw.js');
  expect(sw.headers()['content-type']).toContain('javascript');
  expect(sw.headers()['cache-control']).toBe('no-cache');

  await page.goto('/issues');
  await expect(page.getByRole('heading', { name: 'Issues', level: 1 })).toBeVisible();
  await controlled(page);
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const { installabilityErrors } = (await cdp.send('Page.getInstallabilityErrors')) as { installabilityErrors: { errorId: string }[] };
  expect(installabilityErrors.map((e) => e.errorId)).toEqual([]);
  const app = (await cdp.send('Page.getAppManifest')) as { errors: { message: string }[]; url: string };
  expect(app.errors.map((e) => e.message)).toEqual([]);
  expect(app.url).toMatch(/\/manifest\.webmanifest$/);
});

test('opens offline, says so, and comes back by itself', async ({ page, context, watch }) => {
  // Offline, the page's requests fail, and the browser says so in the console.
  watch.allow(/ERR_INTERNET_DISCONNECTED/, /Failed to fetch/, /net::ERR_FAILED/);
  await page.goto('/issues');
  await expect(page.getByRole('heading', { name: 'Issues', level: 1 })).toBeVisible();
  await controlled(page);

  // Already open: a word above the page.
  await context.setOffline(true);
  await expect(page.getByRole('status').filter({ hasText: "You're offline" })).toBeVisible();
  // Opened offline: the kept shell, which says it waits for the network.
  await page.reload();
  await expect(page.getByRole('heading', { name: "You're offline" })).toBeVisible({ timeout: 20_000 });
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Issues', level: 1 })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: "You're offline" })).toHaveCount(0);
});

test('push notifications: on for this device, a test, an assignment, and off', async ({ page, context, api, baseURL }) => {
  const receiver = await pushReceiver();
  try {
    // As the person allowing them when the browser asks.
    await context.grantPermissions(['notifications'], { origin: baseURL });
    await context.addInitScript(fakePushManager, receiver.device);
    await page.goto('/me');
    const push = page.getByRole('region', { name: 'Push notifications' });
    await expect(push.getByText("They're off on this device.")).toBeVisible();
    await controlled(page);
    await push.getByRole('button', { name: 'Turn on for this device' }).click();
    await expect(push.getByRole('status').filter({ hasText: 'Push notifications are on for this device.' })).toBeVisible();
    const devices = push.getByRole('list', { name: 'Devices push notifications go to' });
    await expect(devices.getByRole('listitem')).toHaveCount(1);
    await expect(devices.getByRole('listitem').first()).toContainText('Chrome on Android');
    await expect(devices.getByRole('listitem').first()).toContainText('this device');

    await push.getByRole('button', { name: 'Send a test' }).click();
    await expect(push.getByRole('status').filter({ hasText: 'Sent: it should be on your device now.' })).toBeVisible();
    expect(receiver.received).toEqual([expect.objectContaining({ title: 'a4a', body: 'Push notifications reach Chrome on Android.', url: '/me' })]);

    // Assigned an issue by someone else: a push a few seconds later, about it.
    const key = uniqueKey('PH');
    await api.createProject({ key, name: `Phone ${key}` });
    const issue = await api.createIssue({ project: key, summary: `Checkout fails on the phone ${unique()}`, fields: { Assignee: 'theo' } });
    await expect.poll(() => receiver.received.length, { timeout: 30_000 }).toBe(2);
    expect(receiver.received[1]).toMatchObject({ title: `${issue.id}: ${issue.summary}`, url: `/issues/${issue.id}`, tag: expect.stringMatching(/^issue-/) });

    await push.getByRole('button', { name: 'Turn off on this device' }).click();
    await expect(push.getByRole('status').filter({ hasText: 'Push notifications are off on this device.' })).toBeVisible();
    await expect(devices).toHaveCount(0);
    await expect(push.getByRole('button', { name: 'Turn on for this device' })).toBeVisible();
  } finally {
    await receiver.close();
  }
});

test('the service worker shows each push, tagged by its issue, keeps the badge, and opens what was tapped', async ({ page, context }) => {
  await page.goto('/inbox');
  await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible();
  await controlled(page);
  // What the worker asks the platform to show, and the badge it sets: a headless browser shows neither.
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await worker.evaluate(() => {
    const sw = self as unknown as {
      shown: unknown[];
      badges: number[];
      registration: { showNotification: (title: string, options: Record<string, unknown>) => Promise<void> };
      navigator: { setAppBadge: (n: number) => Promise<void>; clearAppBadge: () => Promise<void> };
    };
    sw.shown = [];
    sw.badges = [];
    sw.registration.showNotification = async (title, options) => void sw.shown.push({ title, ...options });
    sw.navigator.setAppBadge = async (n) => void sw.badges.push(n);
    sw.navigator.clearAppBadge = async () => void sw.badges.push(0);
  });
  const cdp = await page.context().newCDPSession(page);
  const registered = new Promise<string>((resolve) => {
    cdp.on('ServiceWorker.workerRegistrationUpdated', (e: { registrations: { registrationId: string; scopeURL: string; isDeleted: boolean }[] }) => {
      const r = e.registrations.find((x) => !x.isDeleted);
      if (r) resolve(r.registrationId);
    });
  });
  await cdp.send('ServiceWorker.enable');
  const registrationId = await registered;
  const origin = new URL(page.url()).origin;
  const deliver = (data: unknown) => cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId, data: JSON.stringify(data) });
  await deliver({ title: 'BACK-12: Sign-in page times out', body: 'Anna Schmidt mentioned you', tag: 'issue-1', url: '/issues/BACK-12', unread: 3, renotify: true });
  await deliver({ title: 'BACK-12: Sign-in page times out', body: 'Anna Schmidt commented twice', tag: 'issue-1', url: '/issues/BACK-12', unread: 4, renotify: true });
  await deliver({ title: 'WEB-3: Footer is a pixel off', body: 'Ben Okafor assigned it to you', tag: 'issue-2', url: '/issues/WEB-3', unread: 5, renotify: true });
  type Shown = { title: string; body: string; tag: string; renotify: boolean; icon: string; badge: string; data: { url: string } };
  const shown = () => worker.evaluate(() => (self as unknown as { shown: Shown[] }).shown);
  await expect.poll(async () => (await shown()).length).toBe(3);
  // One per issue: pushes with the same tag replace each other on the device, and alert again.
  expect((await shown()).map((s) => [s.title, s.body, s.tag, s.renotify, s.data.url])).toEqual([
    ['BACK-12: Sign-in page times out', 'Anna Schmidt mentioned you', 'issue-1', true, '/issues/BACK-12'],
    ['BACK-12: Sign-in page times out', 'Anna Schmidt commented twice', 'issue-1', true, '/issues/BACK-12'],
    ['WEB-3: Footer is a pixel off', 'Ben Okafor assigned it to you', 'issue-2', true, '/issues/WEB-3'],
  ]);
  expect((await shown())[0]).toMatchObject({ icon: '/icons/icon-192.png', badge: '/icons/badge-96.png' });
  expect(await worker.evaluate(() => (self as unknown as { badges: number[] }).badges)).toEqual([3, 4, 5]);

  // Tapped, with a4a open: the worker asks the page to open it, in place.
  await worker.evaluate(async () => {
    const all = await (self as unknown as { clients: { matchAll(o: object): Promise<{ postMessage(m: unknown): void }[]> } }).clients.matchAll({ type: 'window' });
    for (const c of all) c.postMessage({ type: 'open', url: '/issues/new' });
  });
  await expect(page.getByRole('heading', { name: 'New issue', level: 1 })).toBeVisible();
});

test('a page shared from another app opens New issue, filled in', async ({ page }) => {
  const url = 'https://status.example.com/incidents/42';
  await page.goto(`/issues/new?title=${encodeURIComponent('Payments are failing')}&text=${encodeURIComponent(`Seen at 09:40\n${url}`)}`);
  await expect(page.getByLabel('Summary')).toHaveValue('Payments are failing');
  await expect(page.getByRole('heading', { name: 'New issue', level: 1 })).toBeVisible();
  // The description, in the editor as written or as Markdown, whichever this browser last chose.
  const written = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('textarea, [contenteditable="true"]')].map((e) => (e instanceof HTMLTextAreaElement ? e.value : e.innerText)).join('\n'),
    );
  await expect.poll(written).toContain('Seen at 09:40');
  expect(await written()).toContain(url);
});

test('the pages people use on a phone fit it, and are made to be tapped', async ({ page, api }) => {
  const key = uniqueKey('MB');
  await api.createProject({ key, name: `Mobile ${key}` });
  const issue = await api.createIssue({ project: key, summary: 'The export times out on big projects', fields: { Type: 'Bug', Priority: 'Major', Assignee: 'theo' } });
  await api.post(`/issues/${issue.id}/comments`, { text: 'Seen on the staging box too, with a 40 MB project.' });
  const board = await api.createBoard({ name: `Mobile board ${key}`, projects: [key] });
  const pages: [string, string, RegExp | string][] = [
    ['issues', '/issues', 'Issues'],
    ['issue', `/issues/${issue.id}`, issue.summary],
    ['new-issue', '/issues/new', 'New issue'],
    ['inbox', '/inbox', 'Inbox'],
    ['board', `/boards/${board.id}`, board.name],
  ];
  await page.setViewportSize({ width: 390, height: 844 });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [name, path, heading] of pages) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await page.waitForLoadState('networkidle');
      const found = await phoneProblems(page);
      expect.soft(found.overflow, `${name}: nothing reaches past the screen`).toBeLessThanOrEqual(0);
      expect.soft(found.small, `${name}: everything to tap is 44px or more`).toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`phone-${name}-${scheme}.png`), fullPage: true });
    }
  }
});
