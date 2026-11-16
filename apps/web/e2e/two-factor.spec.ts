/**
 * Identity in depth (D38): someone turns two-factor sign-in on from their profile and signs in with
 * a code after their password, and with a recovery code; an administrator resets someone's, and
 * makes a SCIM token an identity provider provisions people with.
 *
 * Asking two-factor of everyone is an instance-wide switch: turned on here, it would ask the other
 * flows' people for codes mid-run. The server's tests cover it (packages/server/test/two-factor.test.ts).
 */
import type { Page } from '@playwright/test';
import { unique, type Api } from './support/api';
import { BASE_URL } from './support/env';
import { expect, test } from './support/fixtures';
import { totp, withTwoFactor } from './support/totp';

const PASSWORD = 'e2e-person-pass-1';

async function person(api: Api, name: string) {
  const login = `${name.split(' ')[0]!.toLowerCase()}.${unique()}`;
  await api.createUser({ login, name, password: PASSWORD, role: 'member' });
  return { login, name };
}

async function password(page: Page, login: string) {
  await page.goto('/login');
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('signed in with a password', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('turns two-factor sign-in on from the profile, then signs in with a code, and with a recovery code', async ({ page, api, watch }) => {
    // A wrong code is answered 400, as the page expects.
    watch.allow(/status of 400/);
    const nadia = await person(api, 'Nadia Okafor');
    await password(page, nadia.login);
    await expect(page).toHaveURL(/\/issues$/);

    await page.goto('/me');
    const card = page.getByRole('region', { name: 'Two-factor sign-in' });
    await expect(card.getByText(/^Off: your password alone signs you in/)).toBeVisible();
    await card.getByRole('button', { name: 'Set up two-factor sign-in' }).click();
    await expect(card.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
    const key = (await card.getByText(/^Or type this key into it:/).textContent())!.replace(/^Or type this key into it:\s*/, '');
    expect(key).toMatch(/^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/);
    const secret = key.replace(/ /g, '');
    await card.getByLabel('Code from the app').fill(totp(secret));
    await card.getByRole('button', { name: 'Turn it on' }).click();
    await expect(card.getByRole('status').filter({ hasText: /^Two-factor sign-in is on/ })).toHaveText('Two-factor sign-in is on: from now on a4a asks for a code after your password.');
    const codes = card.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem');
    await expect(codes).toHaveCount(10);
    const recovery = (await codes.first().textContent())!;
    expect(recovery).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);

    // The password alone no longer signs in: a code from the app comes after it.
    await page.context().clearCookies();
    await password(page, nadia.login);
    await expect(page.getByRole('heading', { name: 'Two-factor sign-in' })).toBeVisible();
    await page.getByLabel('Code', { exact: true }).fill('000000');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('That code isn’t right');
    // The next step's code: the one the setup took can't be taken twice.
    await page.getByLabel('Code', { exact: true }).fill(totp(secret, 1));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/issues$/);

    // A lost phone: a recovery code, once.
    await page.context().clearCookies();
    await password(page, nadia.login);
    await page.getByLabel('Code', { exact: true }).fill(recovery);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/issues$/);
    await page.goto('/me');
    await expect(page.getByRole('region', { name: 'Two-factor sign-in' }).getByText(/9 recovery codes left\.$/)).toBeVisible();
  });
});

test('an administrator resets someone’s two-factor sign-in, and makes a SCIM token for an identity provider', async ({ page, api, browser }) => {
  const pavel = await person(api, 'Pavel Novak');
  // Pavel turns it on in his own browser.
  const his = await browser.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
  await withTwoFactor(await his.newPage(), pavel.login, PASSWORD);
  await his.close();

  await page.goto('/admin');
  const row = page.getByRole('region', { name: 'Table of people' }).getByRole('row').filter({ hasText: pavel.login });
  await expect(row).toContainText('with two-factor');
  await row.getByRole('button', { name: `Reset two-factor for ${pavel.name}` }).click();
  await expect(row.getByRole('status')).toHaveText(`${pavel.name}'s two-factor sign-in is reset: their next sign-in sets it up again if it's required.`);
  await expect(row).not.toContainText('with two-factor');

  const provisioning = page.getByRole('region', { name: 'Provisioning' });
  const name = `Entra ${unique()}`;
  await provisioning.getByLabel('A token for').fill(name);
  await provisioning.getByRole('button', { name: 'Make a SCIM token' }).click();
  await expect(provisioning.getByText(`Give ${name} these: a4a shows the token only this once, and keeps a fingerprint of it.`)).toBeVisible();
  await expect(provisioning.getByLabel('Tenant URL')).toHaveText(/\/scim\/v2$/);
  const token = (await provisioning.getByLabel('Secret token').textContent())!;
  expect(token).toMatch(/^a4s_/);
  // The provider's first call: Entra's test of the connection.
  const tried = await page.request.get(`/scim/v2/Users?filter=${encodeURIComponent('userName eq "nobody@corp.example"')}`, { headers: { authorization: `Bearer ${token}` } });
  expect(tried.status()).toBe(200);
  expect(await tried.json()).toMatchObject({ totalResults: 0 });
  await page.reload();
  await expect(provisioning.getByText(name)).toBeVisible();
  await provisioning.getByRole('button', { name: `Revoke ${name}’s token` }).click();
  await expect(provisioning.getByRole('status')).toHaveText(`${name}’s token is revoked: it provisions nothing from now on.`);
  expect((await page.request.get('/scim/v2/Users', { headers: { authorization: `Bearer ${token}` } })).status()).toBe(401);
});
