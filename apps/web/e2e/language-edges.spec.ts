/**
 * What a language does at a value's edge, in a browser (D49): a problem's list joined as the reader's
 * language joins one, 「、」 in Japanese, where the server's English joins it with ", "; and a French
 * word elided before a name that begins with a vowel, "Base de connaissances d’Atelier", which the
 * catalog can't write, since the name is a value. Each test signs in a person of its own through a
 * browser that asks for its language, and shoots the page in light, in dark and at 390px.
 */
import type { Page, TestInfo } from '@playwright/test';
import type { ArticleDetail } from '@a4a/shared';
import { unique, uniqueKey, type Api } from './support/api';
import { expect, test } from './support/fixtures';

const PASSWORD = 'e2e-person-pass-1';

async function person(api: Api, name: string) {
  const login = `edges.${unique()}`;
  await api.createUser({ login, name, password: PASSWORD, role: 'member' });
  return login;
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

test.describe('in Japanese', () => {
  test.use({ storageState: { cookies: [], origins: [] }, locale: 'ja-JP' });

  test('lists what a query’s field takes with 「、」, as Japanese lists things', async ({ page, api }, info) => {
    const login = await person(api, 'Hanako Sato');
    const key = uniqueKey('JL');
    await api.createProject({ key, name: `一覧 ${key}` });
    await page.goto('/login');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    await page.getByLabel('ログインID').fill(login);
    await page.getByLabel('パスワード').fill(PASSWORD);
    await page.getByRole('button', { name: 'ログイン', exact: true }).click();
    await expect(page).toHaveURL(/\/issues$/);

    await page.goto(`/issues?q=${encodeURIComponent(`project: ${key}`)}`);
    const query = page.getByRole('combobox', { name: '課題を検索' });
    // No value is near enough to guess, so the problem lists them: the server sends the list as a
    // list, and the page joins it in Japanese.
    await query.fill(`project: ${key} Priority: Qqqqqq`);
    const problem = page.getByText('Priorityに値「Qqqqqq」はありません。');
    await expect(problem).toBeVisible();
    await expect(problem).toContainText('値：Show-stopper、Critical、Major、Normal、Minor。');
    await expect(page.getByText(/Show-stopper, Critical/)).toHaveCount(0);
    await expect(query).toHaveAttribute('aria-invalid', 'true');
    await shoot(page, info, 'japanese-list');
  });
});

test.describe('in French', () => {
  test.use({ storageState: { cookies: [], origins: [] }, locale: 'fr-FR' });

  test('elides de before a project’s name that begins with a vowel, and keeps it before one that doesn’t', async ({ page, api }, info) => {
    const login = await person(api, 'Camille Martin');
    const key = uniqueKey('FE');
    const other = uniqueKey('FB');
    await api.createProject({ key, name: `Atelier ${key}` });
    await api.createProject({ key: other, name: `Bureau ${other}` });
    const article = await api.post<ArticleDetail>('/articles', { project: key, title: 'Horaires de l’atelier', body: 'Ouvert de 8 h à 18 h.' });
    const beside = await api.post<ArticleDetail>('/articles', { project: other, title: 'Horaires du bureau', body: 'Ouvert de 9 h à 17 h.' });
    await page.goto('/login');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await page.getByLabel('Identifiant').fill(login);
    await page.getByLabel('Mot de passe').fill(PASSWORD);
    await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
    await expect(page).toHaveURL(/\/issues$/);

    // The tree is named for its project: the catalog writes "de {name}", and a4a elides it as it says the name.
    await page.goto(`/articles/${article.id}`);
    await expect(page.getByRole('heading', { name: article.title })).toBeVisible();
    await expect(page.getByRole('navigation', { name: `Base de connaissances d’Atelier ${key}` })).toBeVisible();
    await expect(page.getByRole('navigation', { name: `Base de connaissances de Atelier ${key}` })).toHaveCount(0);
    await shoot(page, info, 'french-elided');

    await page.goto(`/articles/${beside.id}`);
    await expect(page.getByRole('navigation', { name: `Base de connaissances de Bureau ${other}` })).toBeVisible();
  });
});
