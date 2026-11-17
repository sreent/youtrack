/**
 * a4a in Simplified Chinese (D49). A person's browser asks for Chinese as mainland China writes it
 * (zh-CN) and their profile chooses nothing, so the sign-in page and the pages they open are in
 * Simplified Chinese, dates too; and a problem says itself in Chinese. Each page is shot in light, in
 * dark, and at 390px wide, where nothing may spill sideways.
 *
 * The person is one of this file's own, signed in on the Chinese sign-in page: German's spec changes
 * Una's profile, and two language specs sharing a person would cross.
 */
import type { Page, TestInfo } from '@playwright/test';
import { unique, uniqueKey, type Api } from './support/api';
import { expect, test } from './support/fixtures';

// Signed out, in a browser that asks for Simplified Chinese: each test signs its own person in.
test.use({ storageState: { cookies: [], origins: [] }, locale: 'zh-CN' });

const PASSWORD = 'e2e-person-pass-1';

async function person(api: Api) {
  const login = `wangfang.${unique()}`;
  await api.createUser({ login, name: '王芳', password: PASSWORD, role: 'member' });
  return login;
}

/** In through the sign-in page, as a person does: in Chinese, since the browser asks for it. */
async function signIn(page: Page, login: string) {
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh');
  await page.getByLabel('登录名').fill(login);
  await page.getByLabel('密码').fill(PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
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

test('speaks Simplified Chinese where the browser asks for it, dates and all', async ({ page, api }, info) => {
  const login = await person(api);
  const key = uniqueKey('ZH');
  await api.createProject({ key, name: `语言 ${key}` });
  const issue = await api.createIssue({ project: key, summary: `登录后页面变成空白 ${unique()}`, description: '输入密码后，页面上什么也不显示。' });

  await signIn(page, login);
  await expect(page.getByRole('heading', { name: '问题', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '收件箱' }).first()).toBeVisible();
  await shoot(page, info, 'issues');

  await page.goto(`/issues/${issue.id}`);
  await expect(page.getByRole('heading', { name: issue.summary })).toBeVisible();
  await expect(page.getByRole('region', { name: '描述' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '历史记录和评论' })).toBeVisible();
  // Dates as mainland China writes them: "2026年11月16日".
  await expect(page.locator('time').filter({ hasText: /^\d{4}年\d{1,2}月\d{1,2}日$/ }).first()).toBeVisible();
  await shoot(page, info, 'issue');

  await page.goto('/inbox');
  await expect(page.getByRole('heading', { name: '收件箱', exact: true })).toBeVisible();
  await shoot(page, info, 'inbox');

  await page.goto('/me');
  await expect(page.getByRole('heading', { name: '个人资料', exact: true })).toBeVisible();
  await expect(page.getByLabel('语言')).toHaveValue('');
  await expect(page.getByLabel('语言').locator('option:checked')).toHaveText('浏览器的语言：简体中文');
  // The picker names each language as its readers write it, Simplified Chinese among them.
  await expect(page.getByLabel('语言').locator('option[value="zh"]')).toHaveText('简体中文');
  await shoot(page, info, 'profile');
});

test('says a problem in Simplified Chinese, on the sign-in page too', async ({ browser }, info) => {
  // A context of its own, as German's: the wrong password's 401 is what this test asks for.
  const context = await browser.newContext({ locale: 'zh-CN', storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh');
  await expect(page.getByRole('heading', { level: 1, name: '登录' })).toBeVisible();
  await page.getByLabel('登录名').fill(`meiyouren.${unique()}`);
  await page.getByLabel('密码').fill('cuowu-mima');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  // The server's problem carries a key beside its English; the page says it in Chinese.
  await expect(page.getByText('登录名或密码错误。')).toBeVisible();
  await expect(page.getByText('Wrong login or password')).toHaveCount(0);
  await shoot(page, info, 'sign-in');
  await context.close();
});
