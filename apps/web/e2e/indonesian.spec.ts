/**
 * a4a in Indonesian (D49). A person's browser asks for Indonesian and their profile chooses nothing,
 * so the sign-in page and the pages they open are in Indonesian, dates too; and a problem says
 * itself in Indonesian. Each page is shot in light, in dark, and at 390px wide, where nothing may
 * spill sideways.
 *
 * The person is one of this file's own, signed in on the Indonesian sign-in page: German's spec
 * changes Una's profile, and two language specs sharing a person would cross.
 */
import type { Page, TestInfo } from '@playwright/test';
import { unique, uniqueKey, type Api } from './support/api';
import { expect, test } from './support/fixtures';

// Signed out, in a browser that asks for Indonesian: each test signs its own person in.
test.use({ storageState: { cookies: [], origins: [] }, locale: 'id-ID' });

const PASSWORD = 'e2e-person-pass-1';

async function person(api: Api) {
  const login = `siti.${unique()}`;
  await api.createUser({ login, name: 'Siti Rahayu', password: PASSWORD, role: 'member' });
  return login;
}

/** In through the sign-in page, as a person does: in Indonesian, since the browser asks for it. */
async function signIn(page: Page, login: string) {
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('lang', 'id');
  await page.getByLabel('Nama pengguna', { exact: true }).fill(login);
  await page.getByLabel('Kata sandi', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
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

test('speaks Indonesian where the browser asks for it, dates and all', async ({ page, api }, info) => {
  const login = await person(api);
  const key = uniqueKey('ID');
  await api.createProject({ key, name: `Bahasa ${key}` });
  const issue = await api.createIssue({ project: key, summary: `Halaman kosong setelah masuk ${unique()}`, description: 'Setelah kata sandi dimasukkan, halaman tidak menampilkan apa pun.' });

  await signIn(page, login);
  await expect(page.getByRole('heading', { name: 'Isu', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Kotak masuk' }).first()).toBeVisible();
  await shoot(page, info, 'issues');

  await page.goto(`/issues/${issue.id}`);
  await expect(page.getByRole('heading', { name: issue.summary })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Deskripsi' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Riwayat dan komentar' })).toBeVisible();
  // Dates as Indonesia writes them: "17 Nov 2026", and its times with a point, "14.05.00", where
  // English writes "14:05:00".
  await expect(page.locator('time').filter({ hasText: /^\d{1,2} \p{L}{3} \d{4}$/u }).first()).toBeVisible();
  await expect(page.locator('time[title]').first()).toHaveAttribute('title', /\d{2}\.\d{2}\.\d{2}$/);
  await shoot(page, info, 'issue');

  await page.goto('/inbox');
  await expect(page.getByRole('heading', { name: 'Kotak masuk', exact: true })).toBeVisible();
  await shoot(page, info, 'inbox');

  await page.goto('/me');
  await expect(page.getByRole('heading', { name: 'Profil', exact: true })).toBeVisible();
  await expect(page.getByLabel('Bahasa', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Bahasa', { exact: true }).locator('option:checked')).toHaveText('Bahasa browser: Bahasa Indonesia');
  // The picker names each language as its readers do, Indonesian among them.
  await expect(page.getByLabel('Bahasa', { exact: true }).locator('option[value="id"]')).toHaveText('Bahasa Indonesia');
  await shoot(page, info, 'profile');
});

test('says a problem in Indonesian, on the sign-in page too', async ({ browser }, info) => {
  // A context of its own, as German's: the wrong password's 401 is what this test asks for.
  const context = await browser.newContext({ locale: 'id-ID', storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('lang', 'id');
  await expect(page.getByRole('heading', { level: 1, name: 'Masuk' })).toBeVisible();
  await page.getByLabel('Nama pengguna', { exact: true }).fill(`tidakada.${unique()}`);
  await page.getByLabel('Kata sandi', { exact: true }).fill('kata-sandi-salah');
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  // The server's problem carries a key beside its English; the page says it in Indonesian.
  await expect(page.getByText('Nama pengguna atau kata sandi salah.')).toBeVisible();
  await expect(page.getByText('Wrong login or password')).toHaveCount(0);
  await shoot(page, info, 'sign-in');
  await context.close();
});
