/**
 * Fields only some people see (D50): a project's manager attaches a field as private, and a viewer
 * finds the issue without it, its value nowhere on the page; the manager sees it, marked private.
 */
import type { Field, IssueDetail } from '@a4a/shared';
import { unique, uniqueKey } from './support/api';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { THIRD_AUTH_FILE } from './support/env';
import { expect, test } from './support/fixtures';

// The third of the flows' administrators (support/env.ts says why).
test.use({ storageState: THIRD_AUTH_FILE });

const PASSWORD = 'e2e-person-pass-1';

test('a manager makes a field private, and a viewer finds the issue without it', async ({ page, api, browser }) => {
  const key = uniqueKey('PF');
  await api.createProject({ key, name: `Accounts ${key}` });
  const name = `Margin ${unique()}`;
  const field = await api.post<Field>('/fields', { name, type: 'string', values: [] });
  const viewer = { login: `vic.${unique()}`, name: 'Vic Ortega' };
  await api.createUser({ ...viewer, password: PASSWORD, role: 'member' });
  await api.post(`/projects/${key}/members`, { user: viewer.login, role: 'viewer' });
  const issue = await api.createIssue({ project: key, summary: 'Renewal for Initech' });

  // The manager (an administrator, here) attaches it to the project as private.
  await page.goto(`/projects/${key}`);
  const fields = page.getByRole('region', { name: 'Fields' });
  const attach = fields.getByRole('group', { name: 'Attach a field' });
  await attach.getByLabel('Field', { exact: true }).selectOption({ value: field.id });
  await attach.getByRole('checkbox', { name: /^Private/ }).check();
  await attach.getByRole('button', { name: 'Attach it' }).click();
  await expect(attach.getByRole('status')).toHaveText(`${name} is attached. New and existing issues can have it now.`);
  const row = fields.getByRole('row', { name: new RegExp(`^${name}`) });
  await expect(row.getByRole('checkbox', { name: `${name} is private` })).toBeChecked();
  await expect(fields.getByText(/^A private field is seen only by people/)).toBeVisible();

  await api.patch<IssueDetail>(`/issues/${issue.id}`, { fields: { [name]: 'Thin, 4 percent' } });
  await page.goto(`/issues/${issue.id}`);
  const panel = page.getByRole('complementary', { name: `Fields of ${issue.id}` });
  // Its label says it's private, and it's the manager's to change.
  await expect(panel.getByRole('textbox', { name: `${name} Private` })).toHaveValue('Thin, 4 percent');
  await expect(panel.getByText('Private', { exact: true })).toBeVisible();
  // Both pages as everyone's are held to: light, dark and on a phone, axe clean, nothing sideways.
  for (const path of [`/projects/${key}`, `/issues/${issue.id}`]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectAccessible(page);
      await page.screenshot({ path: test.info().outputPath(`${path.split('/')[1]}-${colorScheme}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoSidewaysScroll(page);
    await page.screenshot({ path: test.info().outputPath(`${path.split('/')[1]}-390.png`), fullPage: true });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1280, height: 900 });

  // The viewer, signed in on their own: no such field, and its value nowhere.
  const theirs = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const them = await theirs.newPage();
  await them.goto('/login');
  await them.getByLabel('Login').fill(viewer.login);
  await them.getByLabel('Password').fill(PASSWORD);
  await them.getByRole('button', { name: 'Sign in' }).click();
  await expect(them).toHaveURL(/\/issues$/);
  await them.goto(`/issues/${issue.id}`);
  await expect(them.getByRole('heading', { level: 1, name: 'Renewal for Initech' })).toBeVisible();
  const their = them.getByRole('complementary', { name: `Fields of ${issue.id}` });
  await expect(their.getByText('State', { exact: true })).toBeVisible();
  await expect(their.getByText(name)).toHaveCount(0);
  await expect(them.getByText('Thin, 4 percent')).toHaveCount(0);
  await expect(them.getByText(name)).toHaveCount(0);
  await theirs.close();
});
