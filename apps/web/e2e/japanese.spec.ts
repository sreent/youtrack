/**
 * a4a in Japanese (D49). A person's browser asks for Japanese and their profile chooses nothing, so
 * the sign-in page and the pages they open are in Japanese, dates too; and a problem says itself in
 * Japanese. Each page is shot in light, in dark, and at 390px wide, where nothing may spill sideways.
 *
 * The person is one of this file's own, signed in on the Japanese sign-in page: German's spec
 * changes Una's profile, and two language specs sharing a person would cross.
 */
import type { Page, TestInfo } from '@playwright/test';
import { unique, uniqueKey, type Api } from './support/api';
import { expect, test } from './support/fixtures';

// Signed out, in a browser that asks for Japanese: each test signs its own person in.
test.use({ storageState: { cookies: [], origins: [] }, locale: 'ja-JP' });

const PASSWORD = 'e2e-person-pass-1';

async function person(api: Api) {
  const login = `hanako.${unique()}`;
  await api.createUser({ login, name: 'Hanako Sato', password: PASSWORD, role: 'member' });
  return login;
}

/** In through the sign-in page, as a person does: in Japanese, since the browser asks for it. */
async function signIn(page: Page, login: string) {
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await page.getByLabel('ログインID').fill(login);
  await page.getByLabel('パスワード').fill(PASSWORD);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
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

test('speaks Japanese where the browser asks for it, dates and all', async ({ page, api }, info) => {
  const login = await person(api);
  const key = uniqueKey('JA');
  await api.createProject({ key, name: `言語 ${key}` });
  const issue = await api.createIssue({ project: key, summary: `ログイン後にページが空になる ${unique()}`, description: 'パスワードを入力すると、ページに何も表示されなくなります。' });

  await signIn(page, login);
  await expect(page.getByRole('heading', { name: '課題', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '受信トレイ' }).first()).toBeVisible();
  await shoot(page, info, 'issues');

  await page.goto(`/issues/${issue.id}`);
  await expect(page.getByRole('heading', { name: issue.summary })).toBeVisible();
  await expect(page.getByRole('region', { name: '説明' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '履歴とコメント' })).toBeVisible();
  // Dates as Japanese writes them: "2026年11月16日".
  await expect(page.locator('time').filter({ hasText: /^\d{4}年\d{1,2}月\d{1,2}日$/ }).first()).toBeVisible();
  await shoot(page, info, 'issue');

  await page.goto('/inbox');
  await expect(page.getByRole('heading', { name: '受信トレイ', exact: true })).toBeVisible();
  await shoot(page, info, 'inbox');

  await page.goto('/me');
  await expect(page.getByRole('heading', { name: 'プロフィール', exact: true })).toBeVisible();
  await expect(page.getByLabel('言語')).toHaveValue('');
  await expect(page.getByLabel('言語').locator('option:checked')).toHaveText('ブラウザーの言語：日本語');
  await shoot(page, info, 'profile');
});

test('says a problem in Japanese, on the sign-in page too', async ({ browser }, info) => {
  // A context of its own, as German's: the wrong password's 401 is what this test asks for.
  const context = await browser.newContext({ locale: 'ja-JP', storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.getByRole('heading', { level: 1, name: 'ログイン' })).toBeVisible();
  await page.getByLabel('ログインID').fill(`daremo.${unique()}`);
  await page.getByLabel('パスワード').fill('chigau-pasuwado');
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  // The server's problem carries a key beside its English; the page says it in Japanese.
  await expect(page.getByText('ログインIDまたはパスワードが正しくありません。')).toBeVisible();
  await expect(page.getByText('Wrong login or password')).toHaveCount(0);
  await shoot(page, info, 'sign-in');
  await context.close();
});
