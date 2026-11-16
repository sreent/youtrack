/**
 * Sign in once, as a person does, and keep the session for the specs (storageState): the
 * administrators for the flows, and another for the tour (env.ts says why). Also
 * make the API token the specs use to arrange their data and to change things behind a page's back.
 */
import { writeFileSync } from 'node:fs';
import { expect, test as setup, type Page } from '@playwright/test';
import { ADMIN, AUTH_FILE, BASE_URL, GUIDE, SECOND, SECOND_AUTH_FILE, THIRD, THIRD_AUTH_FILE, TOKEN_FILE, TOUR_AUTH_FILE } from './support/env';

async function signIn(page: Page, who: { login: string; password: string }) {
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Login').fill(who.login);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/issues$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Issues' })).toBeVisible();
}

/** A token of the signed-in person's (the session's writes must come from the app's own origin). */
async function createToken(page: Page, name: string, scopes: string[]): Promise<string> {
  const created = await page.request.post('/api/v1/me/tokens', { data: { name, scopes }, headers: { origin: BASE_URL } });
  expect(created.status(), await created.text()).toBe(201);
  return ((await created.json()) as { token: string }).token;
}

setup('sign in as the administrators: three for the flows, and the one who takes the tour', async ({ browser }) => {
  const admin = await browser.newPage();
  await signIn(admin, ADMIN);
  await admin.context().storageState({ path: AUTH_FILE });
  // The token's requests are attributed to it ("e2e for admin via the API"), as a script's are.
  const token = await createToken(admin, 'e2e', ['read', 'write', 'admin']);
  writeFileSync(TOKEN_FILE, JSON.stringify({ token }));

  for (const person of [GUIDE, SECOND, THIRD]) {
    const made = await admin.request.post('/api/v1/users', {
      data: { login: person.login, name: person.name, password: person.password, role: 'admin' },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(made.status(), await made.text()).toBe(201);
  }
  await admin.close();

  for (const [person, file] of [
    [SECOND, SECOND_AUTH_FILE],
    [THIRD, THIRD_AUTH_FILE],
  ] as const) {
    const flows = await browser.newPage();
    await signIn(flows, person);
    await flows.context().storageState({ path: file });
    await flows.close();
  }

  const guide = await browser.newPage();
  await signIn(guide, GUIDE);
  // So the tour sees a table of tokens, not an empty one.
  await createToken(guide, 'claude-code', ['read']);
  await guide.context().storageState({ path: TOUR_AUTH_FILE });
  await guide.close();
});
