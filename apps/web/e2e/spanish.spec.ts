/**
 * a4a in Spanish (D49), as german.spec.ts checks German. A browser that asks for Spanish signs in a
 * person of the file's own, made here, on a sign-in page in Spanish; their profile chooses nothing,
 * so the pages they open are in Spanish, dates too; a problem says itself in Spanish, the sign-in
 * page's as well. Each page is shot in light, in dark, and at 390px wide, where nothing may spill
 * sideways: Spanish runs longer than English.
 *
 * Its person is its own, not one of the flows' administrators: German's file changes Una's profile,
 * and two files sharing a person while one changes their language would cross.
 */
import type { Browser, Page, TestInfo } from '@playwright/test';
import { unique, uniqueKey, type Api } from './support/api';
import { expect, test } from './support/fixtures';

const PASSWORD = 'e2e-persona-pass-1';

/** A member of the file's own, signed in through the Spanish sign-in page in a browser that asks for Spanish. */
async function signedInInSpanish(browser: Browser, api: Api) {
  const login = `lucia.${unique()}`;
  await api.createUser({ login, name: 'Lucía Fernández', password: PASSWORD, role: 'member' });
  const context = await browser.newContext({ locale: 'es-ES', storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.getByRole('heading', { level: 1, name: 'Iniciar sesión' })).toBeVisible();
  await page.getByLabel('Usuario').fill(login);
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await expect(page).toHaveURL(/\/issues$/);
  return { page, close: () => context.close() };
}

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

test('speaks Spanish where the browser asks for it, dates and all', async ({ browser, api }, info) => {
  const key = uniqueKey('ES');
  await api.createProject({ key, name: `Idiomas ${key}` });
  const issue = await api.createIssue({ project: key, summary: `El inicio de sesión falla ${unique()}`, description: 'Después de la contraseña, la página se queda en blanco.' });
  const { page, close } = await signedInInSpanish(browser, api);

  await expect(page.getByRole('heading', { name: 'Incidencias', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Bandeja de entrada' }).first()).toBeVisible();
  await shoot(page, info, 'issues');

  await page.goto(`/issues/${issue.id}`);
  await expect(page.getByRole('heading', { name: issue.summary })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Descripción' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Historial y comentarios' })).toBeVisible();
  // Dates as Spanish writes them: "16 nov 2026".
  await expect(page.locator('time').filter({ hasText: /^\d{1,2} \p{L}+\.? \d{4}$/u }).first()).toBeVisible();
  await shoot(page, info, 'issue');

  await page.goto('/inbox');
  await expect(page.getByRole('heading', { name: 'Bandeja de entrada', exact: true })).toBeVisible();
  await shoot(page, info, 'inbox');

  await page.goto('/me');
  await expect(page.getByRole('heading', { name: 'Tu perfil', exact: true })).toBeVisible();
  await expect(page.getByLabel('Idioma')).toHaveValue('');
  await expect(page.getByLabel('Idioma').locator('option:checked')).toHaveText('El de tu navegador: Español');
  await shoot(page, info, 'profile');
  await close();
});

test('says a problem in Spanish, on the sign-in page too', async ({ browser }, info) => {
  const context = await browser.newContext({ locale: 'es-ES', storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await page.getByLabel('Usuario').fill(`nadie.${unique()}`);
  await page.getByLabel('Contraseña').fill('no es la contraseña');
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  // The server's problem carries a key beside its English; the page says it in Spanish.
  await expect(page.getByText('El usuario o la contraseña no son correctos.')).toBeVisible();
  await expect(page.getByText('Wrong login or password')).toHaveCount(0);
  await shoot(page, info, 'sign-in');
  await context.close();
});
