/**
 * a4a in German (D49). Una's browser asks for German and her profile chooses nothing, so the pages
 * she opens are in German, dates too; a problem says itself in German, the sign-in page's as well;
 * and her profile's choice goes over the browser's. Each page is shot in light, in dark, and at
 * 390px wide, where nothing may spill sideways: German's words are longer than English's.
 *
 * Una's profile only ever chooses English here, or nothing: her other files' pages ask for English,
 * so they read as they always did whichever runs first.
 */
import type { Page, TestInfo } from '@playwright/test';
import { unique, uniqueKey } from './support/api';
import { THIRD_AUTH_FILE } from './support/env';
import { expect, test } from './support/fixtures';

// The third of the flows' administrators (support/env.ts says why), in a browser that asks for German.
test.use({ storageState: THIRD_AUTH_FILE, locale: 'de-DE' });

/** The page in light and in dark, and at a phone's width, where it must not scroll sideways. */
async function shoot(page: Page, info: TestInfo, name: string) {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await info.attach(`${name}-${colorScheme}.png`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  const size = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth), { message: `${name} spills sideways at 390px` }).toBeLessThanOrEqual(390);
  await info.attach(`${name}-390.png`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  if (size) await page.setViewportSize(size);
}

test('speaks German where the browser asks for it, dates and all', async ({ page, api }, info) => {
  const key = uniqueKey('DE');
  await api.createProject({ key, name: `Sprachen ${key}` });
  const issue = await api.createIssue({ project: key, summary: `Anmeldung schlägt fehl ${unique()}`, description: 'Nach dem Passwort bleibt die Seite leer.' });

  await page.goto('/issues');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.getByRole('heading', { name: 'Vorgänge', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Posteingang' }).first()).toBeVisible();
  await shoot(page, info, 'issues');

  await page.goto(`/issues/${issue.id}`);
  await expect(page.getByRole('heading', { name: issue.summary })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Beschreibung' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Verlauf und Kommentare' })).toBeVisible();
  // Dates as German writes them: "16. Nov. 2026".
  await expect(page.locator('time').filter({ hasText: /^\d{1,2}\. \p{L}+\.? \d{4}$/u }).first()).toBeVisible();
  await shoot(page, info, 'issue');

  await page.goto('/inbox');
  await expect(page.getByRole('heading', { name: 'Posteingang', exact: true })).toBeVisible();
  await shoot(page, info, 'inbox');

  await page.goto('/me');
  await expect(page.getByRole('heading', { name: 'Ihr Profil', exact: true })).toBeVisible();
  await expect(page.getByLabel('Sprache')).toHaveValue('');
  await expect(page.getByLabel('Sprache').locator('option:checked')).toHaveText('Die Ihres Browsers: Deutsch');
  await shoot(page, info, 'profile');
});

test('says roles and counts in German, where English code said them before', async ({ page, api }, info) => {
  const key = uniqueKey('RL');
  await api.createProject({ key, name: `Rollen ${key}` });
  await page.goto(`/projects/${key}`);
  const access = page.getByRole('region', { name: 'Personen und Zugang' });
  // The built-in roles in German, said bare as German says a role, with what each may do.
  await expect(access.getByText(/^Rollen: .*Betrachter darf seine Vorgänge lesen/)).toBeVisible();
  await expect(access.getByText(/a viewer|a member|report issues/)).toHaveCount(0);
  await shoot(page, info, 'people-and-access');

  // People counted by a message's own plural: "12 Personen", not "12 people".
  await page.goto('/admin');
  await expect(page.getByText(/^\d+ Personen/).first()).toBeVisible();
});

test('says a problem in German, on the sign-in page too', async ({ browser }, info) => {
  const context = await browser.newContext({ locale: 'de-DE', storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await page.getByLabel('Login').fill(`niemand.${unique()}`);
  await page.getByLabel('Passwort').fill('nicht das Passwort');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  // The server's problem carries a key beside its English; the page says it in German.
  await expect(page.getByText('Login oder Passwort ist falsch.')).toBeVisible();
  await expect(page.getByText('Wrong login or password')).toHaveCount(0);
  await shoot(page, info, 'sign-in');
  await context.close();
});

test('says a query’s problems in German, as they are typed, and fixes them with one click', async ({ page, api }, info) => {
  const key = uniqueKey('QP');
  await api.createProject({ key, name: `Abfragen ${key}` });
  await page.goto(`/issues?q=${encodeURIComponent(`project: ${key}`)}`);
  const query = page.getByRole('combobox', { name: 'Vorgänge suchen' });

  // The query's problem carries a key beside its English; the page says it in German. Its guess is a
  // button of its own, so the sentence doesn't say it twice.
  await query.fill(`project: ${key} State: Fixd`);
  await expect(page.getByText('Unbekannter Wert „Fixd“ für State.')).toBeVisible();
  await expect(page.getByText(/Unknown value/)).toHaveCount(0);
  await expect(page.getByText(/Meinten Sie „Fixed“/)).toHaveCount(0);
  await expect(query).toHaveAttribute('aria-invalid', 'true');
  // One without a guess says what to do instead, in German too.
  await query.fill(`project: ${key} sort by: zebra`);
  await expect(page.getByText('Nach „zebra“ kann nicht sortiert werden.')).toBeVisible();
  await query.fill(`project: ${key} State: Fixd`);
  await shoot(page, info, 'query-problem');
  await page.getByRole('button', { name: 'Fixed', exact: true }).click();
  await expect(query).toHaveValue(`project: ${key} State: Fixed`);
  await expect(query).not.toHaveAttribute('aria-invalid', 'true');
});

test('a language chosen on the profile goes over the browser’s, and back', async ({ page }) => {
  await page.goto('/me');
  await page.getByLabel('Sprache').selectOption('en');
  await page.getByRole('button', { name: 'Änderungen speichern' }).click();
  // The page says itself again in English: a reload.
  await expect(page.getByRole('heading', { name: 'Your profile', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByLabel('Language')).toHaveValue('en');

  await page.getByLabel('Language').selectOption('');
  await page.getByRole('button', { name: 'Save the changes' }).click();
  await expect(page.getByRole('heading', { name: 'Ihr Profil', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
});
