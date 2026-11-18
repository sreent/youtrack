/**
 * a4a in Portuguese (D49), Portugal's. A person's browser asks for pt-PT and their profile chooses
 * nothing, so the sign-in page and the pages they open are in Portuguese, dates too (the page's lang
 * says pt-PT, for a screen reader's voice); and a problem says itself in Portuguese to a browser in
 * Brazil too.
 * Each page is shot in light, in dark, and at 390px wide, where nothing may spill sideways.
 *
 * The person is one of this file's own, signed in on the Portuguese sign-in page: German's spec
 * changes Una's profile, and two language specs sharing a person would cross.
 */
import type { Page, TestInfo } from '@playwright/test';
import { unique, uniqueKey, type Api } from './support/api';
import { expect, test } from './support/fixtures';

// Signed out, in a browser that asks for Portugal's Portuguese: each test signs its own person in.
test.use({ storageState: { cookies: [], origins: [] }, locale: 'pt-PT' });

const PASSWORD = 'e2e-person-pass-1';

async function person(api: Api) {
  const login = `joana.${unique()}`;
  await api.createUser({ login, name: 'Joana Silva', password: PASSWORD, role: 'member' });
  return login;
}

/** In through the sign-in page, as a person does: in Portuguese, since the browser asks for it. */
async function signIn(page: Page, login: string) {
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-PT');
  await page.getByLabel('Login', { exact: true }).fill(login);
  await page.getByLabel('Senha', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/issues$/);
}

/** The page in light and in dark, and at a phone's width, where it must not scroll sideways. */
async function shoot(page: Page, info: TestInfo, name: string) {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    const path = info.outputPath(`${name}-${colorScheme}.png`);
    await page.screenshot({ path, fullPage: true });
    await info.attach(`${name}-${colorScheme}.png`, { path, contentType: 'image/png' });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  const size = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth), { message: `${name} spills sideways at 390px` }).toBeLessThanOrEqual(390);
  const path = info.outputPath(`${name}-390.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(`${name}-390.png`, { path, contentType: 'image/png' });
  if (size) await page.setViewportSize(size);
}

test('speaks Portuguese where the browser asks for it, dates and all', async ({ page, api }, info) => {
  const login = await person(api);
  const key = uniqueKey('PT');
  await api.createProject({ key, name: `Idioma ${key}` });
  const issue = await api.createIssue({ project: key, summary: `A página fica em branco depois do login ${unique()}`, description: 'Depois de digitar a senha, a página não mostra mais nada.' });

  await signIn(page, login);
  await expect(page.getByRole('heading', { name: 'Itens', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Caixa de entrada' }).first()).toBeVisible();
  await shoot(page, info, 'issues');

  await page.goto(`/issues/${issue.id}`);
  await expect(page.getByRole('heading', { name: issue.summary })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Descrição' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Histórico e comentários' })).toBeVisible();
  // Dates as Portugal writes them: "16/11/2026".
  await expect(page.locator('time').filter({ hasText: /^\d{2}\/\d{2}\/\d{4}$/ }).first()).toBeVisible();
  await shoot(page, info, 'issue');

  await page.goto('/inbox');
  await expect(page.getByRole('heading', { name: 'Caixa de entrada', exact: true })).toBeVisible();
  await shoot(page, info, 'inbox');

  await page.goto('/me');
  await expect(page.getByRole('heading', { name: 'Seu perfil', exact: true })).toBeVisible();
  await expect(page.getByLabel('Idioma')).toHaveValue('');
  await expect(page.getByLabel('Idioma').locator('option:checked')).toHaveText('Idioma do navegador: Português');
  // Each language by its own name, and marked as such for a screen reader.
  await expect(page.getByLabel('Idioma').locator('option[value="pt"]')).toHaveAttribute('lang', 'pt-PT');
  await shoot(page, info, 'profile');
});

test('says a problem in Portuguese to a browser in Brazil, on the sign-in page too', async ({ browser }, info) => {
  // A context of its own, as German's: the wrong password's 401 is what this test asks for.
  const context = await browser.newContext({ locale: 'pt-BR', storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-PT');
  await expect(page.getByRole('heading', { level: 1, name: 'Entrar' })).toBeVisible();
  await page.getByLabel('Login', { exact: true }).fill(`ninguem.${unique()}`);
  await page.getByLabel('Senha', { exact: true }).fill('senha-errada');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  // The server's problem carries a key beside its English; the page says it in Portuguese.
  await expect(page.getByText('Login ou senha incorretos.')).toBeVisible();
  await expect(page.getByText('Wrong login or password')).toHaveCount(0);
  await shoot(page, info, 'sign-in');
  await context.close();
});
