/**
 * Who sees a project, and what each person may do in it (D15): a manager makes a project members
 * only and gives someone a role in it; to someone outside, it and its issues don't exist; and a
 * viewer reads an issue and may comment, with nothing offered that would change it.
 */
import type { Page } from '@playwright/test';
import type { Project, ProjectMember } from '@a4a/shared';
import { unique, uniqueKey, type Api } from './support/api';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { SECOND_AUTH_FILE } from './support/env';
import { expect, test } from './support/fixtures';

// The second of the flows' administrators (support/env.ts says why).
test.use({ storageState: SECOND_AUTH_FILE });

const PASSWORD = 'e2e-person-pass-1';

/** Someone of the test's own, who can sign in: a member of a4a, with no place in any project yet. */
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

test('a manager makes a project members only, and gives someone a role in it', async ({ page, api }) => {
  const key = uniqueKey('AC');
  await api.createProject({ key, name: `Payroll ${key}` });
  const noor = await person(api, 'Noor Hassan');
  await page.goto(`/projects/${key}`);
  const access = page.getByRole('region', { name: 'People and access' });
  await expect(access.getByText('Open to everyone')).toBeVisible();

  await access.getByRole('radio', { name: /^Members only/ }).check();
  await access.getByRole('button', { name: 'Save who sees it' }).click();
  await expect(access.getByRole('status').filter({ hasText: `Only ${key}'s people and administrators see it now.` })).toBeVisible();
  await expect(access.getByText('Members only', { exact: true })).toBeVisible();

  const add = access.getByRole('group', { name: 'Add someone' });
  await add.getByLabel('Person').selectOption({ label: noor.name });
  await add.getByLabel('Role').selectOption('viewer');
  await add.getByRole('button', { name: 'Add them' }).click();
  await expect(add.getByRole('status')).toHaveText(`${noor.name} is a viewer of ${key} now.`);
  const people = access.getByRole('region', { name: `People in ${key}` });
  const role = people.getByRole('combobox', { name: `Role of ${noor.name} in ${key}` });
  await expect(role).toHaveValue('viewer');

  await role.selectOption('member');
  await expect(people.getByRole('status').filter({ hasText: `${noor.name} is a member now.` })).toBeVisible();
  const saved = await api.get<Project>(`/projects/${key}`);
  const members = await api.get<ProjectMember[]>(`/projects/${key}/members`);
  expect([saved.visibility, members.find((m) => m.user.login === noor.login)?.role]).toEqual(['members', 'member']);

  // Taking someone out asks first, and says what it means here.
  await people.getByRole('row').filter({ hasText: noor.login }).getByRole('button', { name: 'Take out' }).click();
  const confirm = page.getByRole('dialog', { name: `Take ${noor.name} out of ${key}?` });
  await expect(confirm).toContainText(`${noor.name} won't see ${key} or its issues any more.`);
  await confirm.getByRole('button', { name: 'Take them out' }).click();
  await expect(people.getByRole('row').filter({ hasText: noor.login })).toHaveCount(0);
});

test.describe('signed in as someone else', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('to someone outside a members-only project, it and its issues don\'t exist', async ({ page, api, watch }) => {
    // Its pages ask for what isn't there, as they would for anything that doesn't exist.
    watch.allow(/status of 404/);
    const key = uniqueKey('MO');
    const hidden = `Salary file rounds pence the wrong way (${key})`;
    await api.createProject({ key, name: `Payroll ${key}` });
    await api.patch(`/projects/${key}`, { visibility: 'members' });
    const issue = await api.createIssue({ project: key, summary: hidden });
    const outsider = await person(api, 'Ravi Menon');
    const nowhere = uniqueKey('ZQ');
    await signIn(page, outsider.login);

    // An issue of it reads as one that doesn't exist, word for word.
    await page.goto(`/issues/${issue.id}`);
    await expect(page.getByText(`There’s no issue ${issue.id}, or you can’t see it.`)).toBeVisible();
    await expect(page.getByText(hidden)).toHaveCount(0);
    await page.goto(`/issues/${nowhere}-1`);
    await expect(page.getByText(`There’s no issue ${nowhere}-1, or you can’t see it.`)).toBeVisible();

    // So do the project and its plan.
    await page.goto(`/projects/${key}`);
    await expect(page.getByRole('alert')).toContainText(`Project ${key} not found`);
    await page.goto(`/projects/${nowhere}`);
    await expect(page.getByRole('alert')).toContainText(`Project ${nowhere} not found`);
    await page.goto(`/plan/${key}`);
    await expect(page.getByRole('heading', { name: `There is no project ${key}` })).toBeVisible();

    // It's in no list, and the query language doesn't know it.
    await page.goto('/projects');
    await expect(page.getByRole('region', { name: 'Table of projects' })).toBeVisible();
    await expect(page.getByRole('link', { name: key, exact: true })).toHaveCount(0);
    await page.goto('/issues');
    const query = page.getByRole('combobox', { name: 'Search issues' });
    await query.fill(`project: ${key}`);
    await expect(page.getByText(`Unknown project "${key}"`)).toBeVisible();
    await query.fill('"Salary file rounds pence"');
    await query.press('Enter');
    await expect(page.getByText('Nothing matches this search.')).toBeVisible();
  });

  test('a viewer reads an issue and may comment, and is offered nothing that would change it', async ({ page, api }) => {
    const key = uniqueKey('VW');
    await api.createProject({ key, name: `Handbook ${key}` });
    const issue = await api.createIssue({ project: key, summary: 'Explain how leave is booked', description: 'The **old** process is still in the handbook.', fields: { Type: 'Task', Priority: 'Normal', Estimation: '1d' } });
    const other = await api.createIssue({ project: key, summary: 'Move the handbook to the wiki', fields: { Type: 'Task' } });
    await api.post(`/issues/${issue.id}/links`, { relation: 'relates to', issue: other.id });
    await api.post(`/issues/${issue.id}/work-items`, { duration: '2h', description: 'First draft' });
    const viewer = await person(api, 'Lena Fischer');
    await api.post(`/projects/${key}/members`, { user: viewer.login, role: 'viewer' });
    await signIn(page, viewer.login);

    await page.goto(`/issues/${issue.id}`);
    const fields = page.getByRole('complementary', { name: `Fields of ${issue.id}` });
    await expect(fields).toBeVisible();
    await expect(page.getByText(`You can read ${key}'s issues and comment on them; changing them is for its members.`)).toBeVisible();

    // Everything reads as it is…
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Explain how leave is booked');
    await expect(page.getByRole('region', { name: 'Description' })).toContainText('The old process is still in the handbook.');
    await expect(page.getByRole('region', { name: 'Links' }).getByRole('link', { name: other.summary })).toBeVisible();
    await expect(fields).toContainText('Normal');
    await expect(page.getByRole('table', { name: `Work logged on ${issue.id}` })).toContainText('First draft');

    // …and nothing is offered that would change it.
    await expect(page.getByRole('button', { name: 'Apply a command' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Change the summary$/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit the description' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add link' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: `Unlink ${other.id}` })).toHaveCount(0);
    await expect(fields.getByRole('button')).toHaveCount(0);
    await expect(fields.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByRole('form', { name: 'Log time' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(0);
    // The page as a reader has it is held to what every page is.
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);

    // A viewer may comment.
    const comment = page.getByLabel('A comment, as Lena Fischer');
    await comment.fill('The new process starts in January.');
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(page.getByRole('region', { name: 'History and comments' }).getByText('The new process starts in January.')).toBeVisible();
    expect((await api.issue(issue.id)).commentCount).toBe(1);
  });
});
