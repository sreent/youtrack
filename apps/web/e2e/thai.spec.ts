/**
 * a4a in Thai (D49). A person's browser asks for Thai and their profile chooses nothing, so the
 * sign-in page and the pages they open are in Thai, dates too, in Gregorian years (2026, not the
 * Buddhist era's 2569); and a problem says itself in Thai. Each page is shot in light, in dark, and at
 * 390px wide, where nothing may spill sideways; and the browser is asked which font drew its Thai.
 *
 * The person is one of this file's own, signed in on the Thai sign-in page: German's spec changes
 * Una's profile, and two language specs sharing a person would cross.
 */
import type { Page, TestInfo } from '@playwright/test';
import { unique, uniqueKey, type Api } from './support/api';
import { expect, test } from './support/fixtures';

// Signed out, in a browser that asks for Thai: each test signs its own person in.
test.use({ storageState: { cookies: [], origins: [] }, locale: 'th-TH' });

const PASSWORD = 'e2e-person-pass-1';
/** Ocean's face for Thai letters; Latin ones are IBM Plex Sans. */
const THAI_FACE = 'IBM Plex Sans Thai';

async function person(api: Api) {
  const login = `somchai.${unique()}`;
  await api.createUser({ login, name: 'สมชาย ใจดี', password: PASSWORD, role: 'member' });
  return login;
}

/** In through the sign-in page, as a person does: in Thai, since the browser asks for it. */
async function signIn(page: Page, login: string) {
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('lang', 'th');
  await page.getByLabel('ชื่อผู้ใช้').fill(login);
  await page.getByLabel('รหัสผ่าน').fill(PASSWORD);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();
  await expect(page).toHaveURL(/\/issues$/);
}

/**
 * The fonts the browser drew the first Thai words under an element in, by name, as Chromium's
 * DevTools protocol says. The element holding those words is marked for a moment to find it.
 */
async function fontsOf(page: Page, selector: string): Promise<string[]> {
  const found = await page.evaluate(async (sel) => {
    await document.fonts.ready;
    const walker = document.createTreeWalker(document.querySelector(sel) ?? document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (/[฀-๿]/.test(n.textContent ?? '') && n.parentElement) {
        n.parentElement.setAttribute('data-thai-probe', '');
        return true;
      }
    }
    return false;
  }, selector);
  if (!found) return [];
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-thai-probe]' });
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    return fonts.map((f) => f.familyName);
  } finally {
    await cdp.detach();
    await page.evaluate(() => document.querySelectorAll('[data-thai-probe]').forEach((el) => el.removeAttribute('data-thai-probe')));
  }
}

/** The page's heading is Thai, and drawn in Plex Sans Thai: not boxes, and not a system font. */
async function drawnInThai(page: Page, selector = 'h1') {
  await expect(page.locator(selector).first()).toHaveText(/[฀-๿]/);
  await expect.poll(() => fontsOf(page, selector), { message: `${selector} isn't drawn in ${THAI_FACE}` }).toContain(THAI_FACE);
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

test('speaks Thai where the browser asks for it, dates in Gregorian years', async ({ page, api }, info) => {
  const login = await person(api);
  const key = uniqueKey('TH');
  await api.createProject({ key, name: `ภาษา ${key}` });
  const issue = await api.createIssue({ project: key, summary: `หน้าว่างหลังเข้าสู่ระบบ ${unique()}`, description: 'พอใส่รหัสผ่านแล้ว หน้าก็ไม่แสดงอะไรเลย' });

  await signIn(page, login);
  await expect(page.getByRole('heading', { name: 'อิชชู', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'กล่องจดหมาย' }).first()).toBeVisible();
  await drawnInThai(page);
  await shoot(page, info, 'issues');

  await page.goto(`/issues/${issue.id}`);
  await expect(page.getByRole('heading', { name: issue.summary })).toBeVisible();
  await expect(page.getByRole('region', { name: 'คำอธิบาย' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ประวัติและความคิดเห็น' })).toBeVisible();
  // Dates as Thai writes them, with the year a4a's people type: "17 พ.ย. 2026", never "2569".
  await expect(page.locator('time').filter({ hasText: /^\d{1,2} [^\s\d]+ 20\d\d$/ }).first()).toBeVisible();
  await expect(page.locator('time').filter({ hasText: /25\d\d/ })).toHaveCount(0);
  await drawnInThai(page);
  await shoot(page, info, 'issue');

  await page.goto('/inbox');
  await expect(page.getByRole('heading', { name: 'กล่องจดหมาย', exact: true })).toBeVisible();
  await drawnInThai(page);
  await shoot(page, info, 'inbox');

  await page.goto('/me');
  await expect(page.getByRole('heading', { name: 'โปรไฟล์', exact: true })).toBeVisible();
  await expect(page.getByLabel('ภาษา')).toHaveValue('');
  // The picker names each language as its readers write it: Thai is ไทย.
  await expect(page.getByLabel('ภาษา').locator('option:checked')).toHaveText('ภาษาของเบราว์เซอร์: ไทย');
  await expect(page.getByLabel('ภาษา').locator('option[value="th"]')).toHaveText('ไทย');
  await drawnInThai(page);
  await shoot(page, info, 'profile');
});

test('says a problem in Thai, on the sign-in page too', async ({ browser }, info) => {
  // A context of its own, as German's: the wrong password's 401 is what this test asks for.
  const context = await browser.newContext({ locale: 'th-TH', storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('lang', 'th');
  await expect(page.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' })).toBeVisible();
  await page.getByLabel('ชื่อผู้ใช้').fill(`maimee.${unique()}`);
  await page.getByLabel('รหัสผ่าน').fill('mai-chai-rahat');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();
  // The server's problem carries a key beside its English; the page says it in Thai.
  await expect(page.getByText('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง')).toBeVisible();
  await expect(page.getByText('Wrong login or password')).toHaveCount(0);
  await drawnInThai(page);
  await shoot(page, info, 'sign-in');
  await context.close();
});
