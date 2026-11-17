/**
 * Groups (D27): an administrator makes a group and puts someone in it, and a project's manager
 * gives the group a role; someone in it then sees a members-only project as far as that role goes,
 * and no further once they're taken out. A group from the identity provider can't be filled by hand.
 */
import type { Page } from '@playwright/test';
import type { GroupDetail, ProjectGroup } from '@a4a/shared';
import { unique, uniqueKey, type Api } from './support/api';
import { expect, test } from './support/fixtures';
import { THIRD_AUTH_FILE } from './support/env';

// The third of the flows' administrators (support/env.ts says why).
test.use({ storageState: THIRD_AUTH_FILE });

const PASSWORD = 'e2e-person-pass-1';

async function person(api: Api, name: string) {
  const login = `${name.split(' ')[0]!.toLowerCase()}.${unique()}`;
  await api.createUser({ login, name, password: PASSWORD, role: 'member' });
  return { login, name };
}

async function signIn(page: Page, login: string) {
  await page.goto('/login');
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/issues$/);
}

test('an administrator makes a group and puts someone in it, and a project gives the group a role', async ({ page, api }) => {
  const ines = await person(api, 'Ines Duarte');
  const name = `Payroll team ${unique()}`;
  await page.goto('/admin');
  const groups = page.getByRole('region', { name: 'Groups' });
  const make = groups.getByRole('group', { name: 'Make a group' });
  await make.getByLabel('Name', { exact: true }).fill(name);
  await make.getByLabel("What it's for").fill('Everyone who runs payroll');
  await make.getByRole('button', { name: 'Make the group' }).click();
  await expect(make.getByRole('status')).toHaveText(`${name} is made. Put people in it on its page.`);

  await groups.getByRole('region', { name: 'Table of groups' }).getByRole('link', { name }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  const people = page.getByRole('region', { name: 'People in it' });
  await expect(people.getByText('Nobody is in it yet.')).toBeVisible();
  const put = people.getByRole('group', { name: 'Put someone in it' });
  // By login, not name: a retry, or another file, makes someone of the same name.
  await put.getByLabel('Person').selectOption({ value: ines.login });
  await put.getByRole('button', { name: 'Put them in' }).click();
  await expect(put.getByRole('status')).toHaveText(`${ines.name} is in ${name} now.`);
  await expect(people.getByRole('region', { name: `People in ${name}` }).getByRole('row').filter({ hasText: ines.login })).toContainText('added by');

  // A members-only project gives the group a role, on its page.
  const key = uniqueKey('GR');
  await api.createProject({ key, name: `Payroll ${key}` });
  await api.patch(`/projects/${key}`, { visibility: 'members' });
  await page.goto(`/projects/${key}`);
  const access = page.getByRole('region', { name: 'People and access' });
  await expect(access.getByText('No group has a role here.')).toBeVisible();
  const add = access.getByRole('group', { name: 'Add a group' });
  await add.getByLabel('Group').selectOption({ label: `${name} (1)` });
  await add.getByLabel('Its role').selectOption('viewer');
  await add.getByRole('button', { name: 'Add the group' }).click();
  await expect(add.getByRole('status')).toHaveText(`Everyone in ${name} is at least a viewer of ${key} now.`);
  const table = access.getByRole('region', { name: `Groups in ${key}` });
  const role = table.getByRole('combobox', { name: `Role of ${name} in ${key}` });
  await expect(role).toHaveValue('viewer');
  await role.selectOption('member');
  await expect(table.getByRole('status').filter({ hasText: `Everyone in ${name} is at least a member now.` })).toBeVisible();
  const saved = await api.get<ProjectGroup[]>(`/projects/${key}/groups`);
  expect(saved.map((g) => [g.group.name, g.role, g.people.map((p) => p.login)])).toEqual([[name, 'member', [ines.login]]]);

  // A members-only project's issues go to people who see it: the group's people among them, nobody else.
  const outsider = await person(api, 'Pavel Novak');
  const issue = await api.createIssue({ project: key, summary: 'Close the quarter', fields: { Type: 'Task' } });
  await page.goto(`/issues/${issue.id}`);
  const fields = page.getByRole('complementary', { name: `Fields of ${issue.id}` });
  await fields.getByRole('button', { name: /^Assignee / }).click();
  const choices = fields.getByRole('listbox', { name: 'Assignee' });
  await expect(choices.getByRole('option', { name: new RegExp(ines.name) })).toBeVisible();
  await expect(choices.getByRole('option', { name: new RegExp(outsider.name) })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.goto(`/projects/${key}`);

  // The group's page says where it has a role.
  await table.getByRole('link', { name }).click();
  await expect(page.getByRole('region', { name: 'Its roles in projects' }).getByRole('row').filter({ hasText: key })).toContainText('Member');
});

test('a group from the identity provider is filled as people sign in, and never by hand', async ({ page, api }) => {
  const made = await api.post<GroupDetail>('/groups', { name: `Engineering ${unique()}`, providerName: `eng-${unique()}` });
  await page.goto(`/groups/${made.id}`);
  const people = page.getByRole('region', { name: 'People in it' });
  await expect(people).toContainText(`names “${made.providerName}” among their groups`);
  await expect(people.getByText('Nobody has signed in from it yet.')).toBeVisible();
  await expect(people.getByRole('group', { name: 'Put someone in it' })).toHaveCount(0);

  // Kept by hand again, an administrator fills it.
  const about = page.getByRole('region', { name: 'The group' });
  await expect(about.getByText('Clear it to keep the group by hand: whoever is in it stays.')).toBeVisible();
  await about.getByLabel('Its name at the identity provider').fill('');
  await about.getByRole('button', { name: 'Save the group' }).click();
  await expect(about.getByRole('status')).toHaveText('Saved.');
  await expect(people.getByRole('group', { name: 'Put someone in it' })).toBeVisible();
});

test.describe('signed in as someone in a group', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("sees a members-only project as far as the group's role goes, and not once they're taken out", async ({ page, api, watch }) => {
    // Once out, the project's page asks for what isn't there for them, as for anything that doesn't exist.
    watch.allow(/status of 404/);
    const key = uniqueKey('GP');
    await api.createProject({ key, name: `Treasury ${key}` });
    await api.patch(`/projects/${key}`, { visibility: 'members' });
    const omar = await person(api, 'Omar Haddad');
    const group = await api.post<GroupDetail>('/groups', { name: `Treasury readers ${unique()}` });
    await api.post(`/groups/${group.id}/members`, { user: omar.login });
    await api.post(`/projects/${key}/groups`, { group: group.id, role: 'viewer' });
    await signIn(page, omar.login);

    await page.goto(`/projects/${key}`);
    await expect(page.getByText(`You're a viewer here, as one of ${group.name}: you read its issues and comment on them.`)).toBeVisible();
    await page.goto('/projects');
    await expect(page.getByRole('link', { name: key, exact: true })).toBeVisible();

    await api.delete(`/groups/${group.id}/members/${omar.login}`);
    await page.goto(`/projects/${key}`);
    await expect(page.getByRole('alert')).toContainText(`Project ${key} not found`);
  });
});
