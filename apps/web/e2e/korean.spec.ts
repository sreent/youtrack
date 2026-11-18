/**
 * a4a in Korean (D49). A person's browser asks for Korean and their profile chooses nothing, so
 * the sign-in page and the pages they open are in Korean, dates too; and a problem says itself in
 * Korean. Each page is shot in light, in dark, and at 390px wide, where nothing may spill sideways.
 *
 * The person is one of this file's own, signed in on the Korean sign-in page: German's spec
 * changes Una's profile, and two language specs sharing a person would cross.
 */
import type { Page, TestInfo } from '@playwright/test';
import { unique, uniqueKey, type Api } from './support/api';
import { expect, test } from './support/fixtures';

// Signed out, in a browser that asks for Korean: each test signs its own person in.
test.use({ storageState: { cookies: [], origins: [] }, locale: 'ko-KR' });

const PASSWORD = 'e2e-person-pass-1';

async function person(api: Api) {
  const login = `minji.${unique()}`;
  await api.createUser({ login, name: '김민지', password: PASSWORD, role: 'member' });
  return login;
}

/** In through the sign-in page, as a person does: in Korean, since the browser asks for it. */
async function signIn(page: Page, login: string) {
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await page.getByLabel('로그인 ID').fill(login);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
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

test('speaks Korean where the browser asks for it, dates and all', async ({ page, api }, info) => {
  const login = await person(api);
  const key = uniqueKey('KO');
  await api.createProject({ key, name: `언어 ${key}` });
  const issue = await api.createIssue({ project: key, summary: `로그인 후 페이지가 비어 있음 ${unique()}`, description: '비밀번호를 입력하면 페이지에 아무것도 표시되지 않습니다.' });

  await signIn(page, login);
  await expect(page.getByRole('heading', { name: '이슈', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '수신함' }).first()).toBeVisible();
  await shoot(page, info, 'issues');

  await page.goto(`/issues/${issue.id}`);
  await expect(page.getByRole('heading', { name: issue.summary })).toBeVisible();
  await expect(page.getByRole('region', { name: '설명' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '기록과 댓글' })).toBeVisible();
  // Dates as Korean writes them: "2026년 11월 16일".
  await expect(page.locator('time').filter({ hasText: /^\d{4}년 \d{1,2}월 \d{1,2}일$/ }).first()).toBeVisible();
  await shoot(page, info, 'issue');

  await page.goto('/inbox');
  await expect(page.getByRole('heading', { name: '수신함', exact: true })).toBeVisible();
  await shoot(page, info, 'inbox');

  await page.goto('/me');
  await expect(page.getByRole('heading', { name: '프로필', exact: true })).toBeVisible();
  // The picker offers Korean by its own name, and this person chose none: their browser's it is.
  await expect(page.getByLabel('언어', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('언어', { exact: true }).locator('option:checked')).toHaveText('브라우저 언어: 한국어');
  await expect(page.getByLabel('언어', { exact: true }).locator('option[value="ko"]')).toHaveText('한국어');
  await shoot(page, info, 'profile');
});

test('says a problem in Korean, on the sign-in page too', async ({ browser }, info) => {
  // A context of its own, as German's: the wrong password's 401 is what this test asks for.
  const context = await browser.newContext({ locale: 'ko-KR', storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await expect(page.getByRole('heading', { level: 1, name: '로그인' })).toBeVisible();
  await page.getByLabel('로그인 ID').fill(`nugu.${unique()}`);
  await page.getByLabel('비밀번호').fill('teullin-bimilbeonho');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  // The server's problem carries a key beside its English; the page says it in Korean.
  await expect(page.getByText('로그인 ID 또는 비밀번호가 올바르지 않습니다.')).toBeVisible();
  await expect(page.getByText('Wrong login or password')).toHaveCount(0);
  await shoot(page, info, 'sign-in');
  await context.close();
});
