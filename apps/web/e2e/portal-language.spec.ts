/**
 * The portal's language (docs/architecture.md, D63's revisit). A requester whose browser is in English
 * chooses Tiếng Việt on the portal's sign-in page, signed out; the link she asks for comes in it, since
 * a4a has no language for her yet; she signs in by it, the portal stays in it and the choice is hers
 * now; the team's next reply comes in it, and the team's request page says her language. Then a
 * request's tracking page, signed out, in another browser: its picker. Light, dark and at 390px.
 *
 * The run's own server sends no email (playwright.config.ts), so this runs on a server of its own
 * that does, beside a mail server (support/mail.ts), as D63's spec does.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { expect, prepareContext, test } from './support/fixtures';
import { message, postMail } from './support/helpdesk';
import { startMailServer, startMailingServer, type MailingServer, type MailServer } from './support/mail';

/** A language's catalog, so the spec reads a page in it as its catalog says it. */
const catalog = (locale: string) =>
  JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../../../packages/shared/i18n/${locale}.json`), 'utf8')) as Record<string, string>;
const vi = catalog('vi');
const ja = catalog('ja');

let mail: MailServer;
let server: MailingServer;
let team: BrowserContext;
let page: Page;
let call: <T>(method: string, path: string, data?: unknown) => Promise<T>;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  mail = await startMailServer();
  server = await startMailingServer(mail.port);
  team = await browser.newContext({ baseURL: server.url, locale: 'en-GB', viewport: { width: 1280, height: 900 } });
  page = await team.newPage();
  await page.goto('/login');
  await page.getByLabel('Login').fill(server.admin.login);
  await page.getByLabel('Password').fill(server.admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/issues$/);
  const made = await page.request.post('/api/v1/me/tokens', { data: { name: 'e2e', scopes: ['read', 'write', 'admin'] }, headers: { origin: server.url } });
  expect(made.status(), await made.text()).toBe(201);
  const { token } = (await made.json()) as { token: string };
  call = async <T>(method: string, path: string, data?: unknown): Promise<T> => {
    const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers: { authorization: `Bearer ${token}` } });
    expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBe(true);
    return (res.status() === 204 ? null : await res.json()) as T;
  };
});

test.afterAll(async () => {
  await team?.close();
  await server?.close();
  await mail?.close();
});

/** Light, dark and on a phone: axe finds nothing, and nothing scrolls sideways. */
async function inEveryLight(p: Page, name: string, ready: () => Promise<void>) {
  for (const [colorScheme, width] of [['light', 1280], ['dark', 1280], ['light', 390]] as const) {
    await p.emulateMedia({ colorScheme });
    await p.setViewportSize({ width, height: 900 });
    await ready();
    await p.screenshot({ path: test.info().outputPath(`${name}-${colorScheme}-${width}.png`), fullPage: true });
    await expectAccessible(p);
    await expectNoSidewaysScroll(p);
  }
  await p.emulateMedia({ colorScheme: 'light' });
  await p.setViewportSize({ width: 1280, height: 900 });
}

test('a requester chooses Tiếng Việt signed out, signs in by the mailed link, and the portal, the next email and the team’s page follow it', async ({ browser }) => {
  test.setTimeout(240_000);
  // A desk that takes mail, and Linh's request by email: a4a knows no language of hers yet.
  const address = 'lang@desk.example';
  await call('POST', '/projects', { key: 'LANG', name: 'Desk LANG', template: 'software' });
  await call('PATCH', '/projects/LANG', { settings: { helpdesk: { enabled: true } } });
  await call('PUT', '/projects/LANG/helpdesk/mail', { address });
  const { url } = await call<{ url: string }>('POST', '/projects/LANG/helpdesk/mail/secret');
  expect((await postMail(url, message({ from: 'Linh <linh@example.org>', to: address, subject: 'The VPN drops', body: 'Every hour.' }))).status).toBe(200);
  await mail.waitFor('linh@example.org', (m) => (m.headers.get('subject') ?? '').includes('The VPN drops'));

  const portal = await browser.newContext({ baseURL: server.url, locale: 'en-GB', viewport: { width: 1280, height: 900 } });
  const watch = await prepareContext(portal);
  try {
    const linh = await portal.newPage();
    await linh.goto('/portal?desk=LANG');
    // Her browser's first, then each language by its own name, in its own lang.
    const picker = linh.getByLabel('Language');
    await expect(picker).toHaveValue('');
    await expect(picker.locator('option').first()).toHaveText('Your browser’s language (English)');
    await expect(picker.locator('option[lang="vi"]')).toHaveText('Tiếng Việt');
    await expect(picker.locator('option[lang="pt-PT"]')).toHaveText('Português');
    await expect(linh.getByRole('button', { name: 'Change language' })).toBeDisabled();
    await inEveryLight(linh, 'sign-in-english', () => expect(linh.getByRole('heading', { name: 'Your requests' })).toBeVisible());

    // From the keyboard: choosing waits for the button, then the page reloads in it.
    await picker.focus();
    await picker.selectOption('vi');
    await expect(linh.locator('html')).toHaveAttribute('lang', 'en');
    await linh.getByRole('button', { name: 'Change language' }).press('Enter');
    await expect(linh.locator('html')).toHaveAttribute('lang', 'vi');
    await expect(linh.getByRole('heading', { name: vi['page.portal.yourRequests'] })).toBeVisible();
    await expect(linh).toHaveURL(/\/portal\?desk=LANG$/);
    await expect(linh.getByLabel(vi['helpdesk.portalLanguage.label'])).toHaveValue('vi');
    await inEveryLight(linh, 'sign-in-vietnamese', () => expect(linh.getByRole('textbox', { name: vi['page.portal.yourEmail'] })).toBeVisible());

    // The link comes in the asking page's language: a4a had none for her.
    await linh.getByRole('textbox', { name: vi['page.portal.yourEmail'] }).fill('linh@example.org');
    await linh.getByRole('button', { name: vi['page.portal.emailMeALink'] }).click();
    await expect(linh.getByRole('status')).toContainText('linh@example.org');
    const link = await mail.waitFor('linh@example.org', (m) => /#hdl_/.test(m.text));
    expect(link.text).toContain(vi['server.portal.why']);

    // Signed in by it: still in Vietnamese, and the choice is hers now, kept by the server.
    await linh.goto(/(\/portal#hdl_[A-Za-z0-9_-]{43})/.exec(link.text)![1]!);
    await expect(linh.getByRole('button', { name: vi['page.portal.signOut'] })).toBeVisible();
    await expect(linh.locator('html')).toHaveAttribute('lang', 'vi');
    await expect(linh).toHaveURL(/\/portal$/);
    await expect(linh.getByLabel(vi['helpdesk.portalLanguage.label'])).toHaveValue('vi');
    expect(((await (await linh.request.get('/api/v1/portal/me')).json()) as { locale: string | null }).locale).toBe('vi');
    await expect(linh.getByRole('button', { name: 'The VPN drops' })).toBeVisible();
    await inEveryLight(linh, 'portal-vietnamese', () => expect(linh.getByRole('button', { name: 'The VPN drops' })).toBeVisible());

    // The team's next reply reaches her in it.
    await call('POST', '/issues/LANG-1/comments', { text: 'We are looking into it.', visibility: 'public' });
    const reply = await mail.waitFor('linh@example.org', (m) => m.text.includes('We are looking into it.'));
    expect(reply.text).toContain(vi['server.helpdesk.seeRequest']);

    // The team's request page says her language, in the team's own, and that she chose it.
    await page.goto('/issues/LANG-1');
    const card = page.getByRole('region', { name: 'Help desk request' });
    await expect(card.getByText('Their language: Vietnamese, as they chose on the portal.')).toBeVisible();
    await inEveryLight(page, 'request-card', () => expect(card.getByText('Their language: Vietnamese, as they chose on the portal.')).toBeVisible());

    // A tracking link, opened signed out in another browser: its own picker, and the request stays open through the reload.
    const tracking = /(\/request#hdt_[A-Za-z0-9_-]{43})/.exec(reply.text)![1]!;
    const other = await browser.newContext({ baseURL: server.url, locale: 'en-GB', viewport: { width: 1280, height: 900 } });
    const watchOther = await prepareContext(other);
    try {
      const track = await other.newPage();
      await track.goto(tracking);
      await expect(track.getByRole('heading', { name: 'The VPN drops' })).toBeVisible();
      await expect(track.getByLabel('Language')).toHaveValue('');
      await track.getByLabel('Language').selectOption('ja');
      await track.getByRole('button', { name: 'Change language' }).click();
      await expect(track.locator('html')).toHaveAttribute('lang', 'ja');
      await expect(track.getByRole('heading', { name: 'The VPN drops' })).toBeVisible();
      await expect(track.getByRole('textbox', { name: ja['page.track.yourReply'] })).toBeVisible();
      await inEveryLight(track, 'tracking-japanese', () => expect(track.getByRole('textbox', { name: ja['page.track.yourReply'] })).toBeVisible());
      // Kept apart from the team's: a member's own pages in this browser stay in theirs.
      expect(await track.evaluate(() => [localStorage.getItem('a4a.portal.locale'), localStorage.getItem('a4a.locale')])).toEqual(['ja', null]);
      expect(watchOther.unexpected()).toEqual([]);
    } finally {
      await other.close();
    }

    // Back to her browser's, signed in: the page follows, and so does the server.
    await linh.getByLabel(vi['helpdesk.portalLanguage.label']).selectOption('');
    await linh.getByRole('button', { name: vi['helpdesk.portalLanguage.change'] }).click();
    await expect(linh.locator('html')).toHaveAttribute('lang', 'en');
    await expect(linh.getByRole('button', { name: 'Sign out' })).toBeVisible();
    expect(((await (await linh.request.get('/api/v1/portal/me')).json()) as { locale: string | null }).locale).toBeNull();
    expect(watch.unexpected()).toEqual([]);
  } finally {
    await portal.close();
  }
});
