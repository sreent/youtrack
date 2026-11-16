/**
 * People: an administrator adds someone, who can then sign in; and a person changes their own
 * password, which signs every one of their sessions out. Each test has a person of its own, so
 * the administrator's session, which every spec shares, is never signed out.
 */
import type { Page } from '@playwright/test';
import { unique } from './support/api';
import { BASE_URL, THIRD_AUTH_FILE } from './support/env';
import { expect, test } from './support/fixtures';

// The third of the flows' administrators (support/env.ts says why).
test.use({ storageState: THIRD_AUTH_FILE });

async function signIn(page: Page, login: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('an administrator adds someone, as a member', async ({ page, api, playwright }) => {
  const login = `fatima.${unique()}`;
  await page.goto('/admin');
  const add = page.getByRole('group', { name: 'Add someone' });
  await add.getByLabel('Name').fill('Fatima Noor');
  await add.getByLabel('Login').fill(login);
  await add.getByLabel('Password', { exact: true }).fill('fatima-pass-1');
  await expect(add.getByLabel('Role')).toHaveValue('member');
  await add.getByLabel('Rate per hour').fill('80');
  await add.getByRole('button', { name: 'Add them' }).click();
  await expect(add.getByRole('status')).toHaveText(`Fatima Noor is added, and can sign in as ${login}.`);

  const people = page.getByRole('region', { name: 'Table of people' });
  const row = people.getByRole('row').filter({ hasText: login });
  await expect(row.getByRole('textbox', { name: 'Name of Fatima Noor' })).toHaveValue('Fatima Noor');
  await expect(row.getByRole('combobox', { name: 'Role of Fatima Noor' })).toHaveValue('member');
  const made = (await api.users()).find((u) => u.login === login)!;
  expect([made.name, made.role, made.hourlyRate, made.banned]).toEqual(['Fatima Noor', 'member', 80, false]);

  // They can sign in, in a session of their own.
  const theirs = await playwright.request.newContext({ baseURL: BASE_URL });
  expect((await theirs.post('/api/v1/auth/login', { data: { login, password: 'fatima-pass-1' }, headers: { origin: BASE_URL } })).status()).toBe(200);
  expect((await (await theirs.get('/api/v1/me')).json()).login).toBe(login);
  await theirs.dispose();
});

test.describe('signed in as someone else', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a person changes their password, and every one of their sessions is signed out', async ({ page, api, playwright, watch }) => {
    // Their pages ask the server again once their session ends; and the old password is refused.
    watch.allow(/status of 401/);
    const login = `omar.${unique()}`;
    await api.createUser({ login, name: 'Omar Haddad', password: 'omar-pass-1', role: 'member' });
    // A session of theirs elsewhere, from before.
    const elsewhere = await playwright.request.newContext({ baseURL: BASE_URL });
    expect((await elsewhere.post('/api/v1/auth/login', { data: { login, password: 'omar-pass-1' }, headers: { origin: BASE_URL } })).status()).toBe(200);
    expect((await elsewhere.get('/api/v1/me')).status()).toBe(200);

    await signIn(page, login, 'omar-pass-1');
    await expect(page).toHaveURL(/\/issues$/);
    await page.goto('/me');
    await expect(page.getByRole('heading', { level: 1, name: 'Your profile' })).toBeVisible();
    await expect(page.getByText("You're a member: you read and change issues.")).toBeVisible();

    const password = page.getByRole('region', { name: 'Password' });
    await password.getByLabel('Current password').fill('omar-pass-1');
    await password.getByLabel('New password').fill('omar-pass-2');
    await password.getByLabel('The new one again').fill('omar-pass-3');
    await expect(password.getByText('Not the same as the new password.')).toBeVisible();
    await expect(password.getByLabel('The new one again')).toHaveAttribute('aria-invalid', 'true');
    await expect(password.getByRole('button', { name: 'Change the password' })).toBeDisabled();

    await password.getByLabel('The new one again').fill('omar-pass-2');
    await password.getByRole('button', { name: 'Change the password' }).click();
    await expect(password.getByRole('status')).toHaveText('Your password is changed, and every session is signed out, this one too.');
    expect((await elsewhere.get('/api/v1/me')).status()).toBe(401);
    await elsewhere.dispose();

    await password.getByRole('link', { name: 'Sign in again' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await signIn(page, login, 'omar-pass-1');
    await expect(page.getByRole('alert')).toContainText('Wrong login or password');
    await page.getByLabel('Password').fill('omar-pass-2');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/issues$/);
    await expect(page.getByRole('link', { name: 'Omar Haddad' })).toBeVisible();
  });
});
