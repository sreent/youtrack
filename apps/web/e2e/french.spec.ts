/**
 * a4a in French (D49). A person of this file's own signs in through a browser that asks for French,
 * with no language chosen on their profile, so the pages they open are in French, dates too; a
 * problem says itself in French, the sign-in page's as well. Each page is shot in light, in dark,
 * and at 390px wide, where nothing may spill sideways: French's words run longer than English's.
 *
 * Not Una, as German's file is: it changes Una's profile, and files sharing a person would cross.
 * The profile's choice going over the browser's is German's file to show.
 */
import type { Page, TestInfo } from '@playwright/test';
import { unique, uniqueKey } from './support/api';
import { expect, test } from './support/fixtures';

const PASSWORD = 'e2e-person-pass-1';

// Signed out to begin with, in a browser that asks for French.
test.use({ storageState: { cookies: [], origins: [] }, locale: 'fr-FR' });

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

test('speaks French where the browser asks for it, dates and all', async ({ page, api }, info) => {
  const login = `camille.${unique()}`;
  await api.createUser({ login, name: 'Camille Martin', password: PASSWORD, role: 'member' });
  const key = uniqueKey('FR');
  await api.createProject({ key, name: `Langues ${key}` });
  const issue = await api.createIssue({ project: key, summary: `La connexion échoue ${unique()}`, description: 'Après le mot de passe, la page reste vide.' });

  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.getByRole('heading', { level: 1, name: 'Se connecter' })).toBeVisible();
  await page.getByLabel('Identifiant').fill(login);
  await page.getByLabel('Mot de passe').fill(PASSWORD);
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(page).toHaveURL(/\/issues$/);
  await expect(page.getByRole('heading', { name: 'Tickets', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Boîte de réception' }).first()).toBeVisible();
  await shoot(page, info, 'issues');

  await page.goto(`/issues/${issue.id}`);
  await expect(page.getByRole('heading', { name: issue.summary })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Description' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Historique et commentaires' })).toBeVisible();
  // Dates as French writes them: "16 nov. 2026".
  await expect(page.locator('time').filter({ hasText: /^\d{1,2}\s\p{L}+\.?\s\d{4}$/u }).first()).toBeVisible();
  await shoot(page, info, 'issue');

  await page.goto('/inbox');
  await expect(page.getByRole('heading', { name: 'Boîte de réception', exact: true })).toBeVisible();
  await shoot(page, info, 'inbox');

  await page.goto('/me');
  await expect(page.getByRole('heading', { name: 'Votre profil', exact: true })).toBeVisible();
  await expect(page.getByLabel('Langue')).toHaveValue('');
  await expect(page.getByLabel('Langue').locator('option:checked')).toHaveText('Celle de votre navigateur : Français');
  await shoot(page, info, 'profile');
});

test('says a problem in French, on the sign-in page too', async ({ browser }, info) => {
  const context = await browser.newContext({ locale: 'fr-FR', storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await page.getByLabel('Identifiant').fill(`personne.${unique()}`);
  await page.getByLabel('Mot de passe').fill('pas le mot de passe');
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  // The server's problem carries a key beside its English; the page says it in French.
  await expect(page.getByText('Identifiant ou mot de passe incorrect.')).toBeVisible();
  await expect(page.getByText('Wrong login or password')).toHaveCount(0);
  await shoot(page, info, 'sign-in');
  await context.close();
});
