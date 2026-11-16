/**
 * Access in depth (D37): an administrator makes a role and a project gives it to someone; an issue
 * and a comment limited to some people are missing to everyone else; and a project an
 * administrator opens to guests is read by someone who isn't signed in.
 */
import type { Page } from '@playwright/test';
import type { ProjectMember } from '@a4a/shared';
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

test('an administrator makes a role, and a project gives it to someone', async ({ page, api }) => {
  const name = `Reporter ${unique()}`;
  await page.goto('/admin');
  const roles = page.getByRole('region', { name: 'Roles' });
  await expect(roles.getByRole('region', { name: 'Table of roles' }).getByRole('row', { name: /^Manager/ })).toBeVisible();
  const make = roles.getByRole('group', { name: 'Make a role' });
  await make.getByLabel('Name', { exact: true }).fill(name);
  await make.getByRole('checkbox', { name: /^Report issues/ }).check();
  await make.getByRole('button', { name: 'Make the role' }).click();
  await expect(roles.getByRole('status').filter({ hasText: `${name} is made.` })).toBeVisible();
  await expect(roles.getByRole('row', { name: new RegExp(`^${name}`) })).toContainText('Read, Comment, Report issues');

  const ines = await person(api, 'Ines Duarte');
  const key = uniqueKey('RL');
  await api.createProject({ key, name: `Desk ${key}` });
  await page.goto(`/projects/${key}`);
  const add = page.getByRole('region', { name: 'People and access' }).getByRole('group', { name: 'Add someone' });
  await add.getByLabel('Person').selectOption({ label: ines.name });
  await add.getByLabel('Role').selectOption({ label: name });
  await expect(add.getByText(`A ${name} may read its issues, comment on them and report issues.`)).toBeVisible();
  await add.getByRole('button', { name: 'Add them' }).click();
  await expect(add.getByRole('status')).toHaveText(`${ines.name} is a ${name} of ${key} now.`);
  const members = await api.get<ProjectMember[]>(`/projects/${key}/members`);
  expect(members.find((m) => m.user.login === ines.login)?.roleName).toBe(name);
});

test('an issue limited to one person, and a comment, as its reporter sets them', async ({ page, api }) => {
  const key = uniqueKey('VT');
  await api.createProject({ key, name: `Merger ${key}` });
  const erin = await person(api, 'Erin Hall');
  const issue = await api.createIssue({ project: key, summary: 'Due diligence on Initech' });
  await page.goto(`/issues/${issue.id}`);
  const card = page.getByRole('region', { name: 'Visible to' });
  await expect(card.getByText(`Everyone who sees ${key}.`)).toBeVisible();
  await card.getByRole('button', { name: 'Limit who sees it' }).click();
  await card.getByLabel('People').selectOption({ label: erin.name });
  await card.getByRole('button', { name: 'Limit it to them' }).click();
  await expect(card.getByRole('status')).toHaveText(`It's limited to ${erin.name} now, besides those who always see it.`);
  await expect(card.getByRole('listitem').filter({ hasText: erin.name })).toBeVisible();

  const history = page.getByRole('region', { name: 'History and comments' });
  await history.getByRole('button', { name: 'Limit who sees it' }).click();
  await history.getByLabel('People').selectOption({ label: erin.name });
  await history.getByLabel(/^A comment/).fill('The numbers are in the data room.');
  await history.getByRole('button', { name: 'Comment' }).click();
  await expect(history.getByText(`visible to ${erin.name}`)).toBeVisible();
  const comments = await api.get<{ visibleTo: { users: { login: string }[] } | null }[]>(`/issues/${issue.id}/comments`);
  expect(comments.map((c) => c.visibleTo?.users.map((u) => u.login))).toEqual([[erin.login]]);
});

test.describe('someone it is not limited to', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('finds the issue missing, word for word, and the comment gone', async ({ page, api, watch }) => {
    watch.allow(/status of 404/);
    const key = uniqueKey('VO');
    await api.createProject({ key, name: `Merger ${key}` });
    const ravi = await person(api, 'Ravi Menon');
    const hidden = await api.createIssue({ project: key, summary: 'Acquisition target list', visibleTo: { users: [], groups: [] } });
    const plain = await api.createIssue({ project: key, summary: 'Office move' });
    await api.post(`/issues/${plain.id}/comments`, { text: 'The landlord wants 40k', visibleTo: { users: [], groups: [] } });
    await api.post(`/issues/${plain.id}/comments`, { text: 'Boxes arrive Monday' });
    await signIn(page, ravi.login);
    await page.goto(`/issues/${hidden.id}`);
    await expect(page.getByText(`There’s no issue ${hidden.id}, or you can’t see it.`)).toBeVisible();
    await expect(page.getByText('Acquisition target list')).toHaveCount(0);
    await page.goto(`/issues/${plain.id}`);
    await expect(page.getByText('Boxes arrive Monday')).toBeVisible();
    await expect(page.getByText('The landlord wants 40k')).toHaveCount(0);
  });
});

test('an administrator opens a project to guests, who read it signed out', async ({ page, api, browser }) => {
  const key = uniqueKey('GU');
  await api.createProject({ key, name: `Roadmap ${key}` });
  const open = await api.createIssue({ project: key, summary: 'Dark mode for the mobile app' });
  await api.createIssue({ project: key, summary: 'Pricing for the enterprise plan', visibleTo: { users: [], groups: [] } });
  await page.goto(`/projects/${key}`);
  const guests = page.getByRole('checkbox', { name: /^Open to guests/ });
  // It changes once the server has it: the box follows the project as saved.
  await guests.click();
  await expect(page.getByRole('status').filter({ hasText: `Anyone may read ${key} now, signed in or not.` })).toBeVisible();
  await expect(guests).toBeChecked();

  const outside = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const guest = await outside.newPage();
  await guest.goto('/login');
  await guest.getByRole('link', { name: 'Read without signing in' }).click();
  await expect(guest.getByRole('heading', { level: 1, name: 'Open to anyone' })).toBeVisible();
  const choose = guest.getByRole('navigation', { name: 'Projects open to anyone' });
  if (await choose.isVisible()) await choose.getByRole('button', { name: `Roadmap ${key}` }).click();
  await guest.getByRole('link', { name: new RegExp(`^${open.id} `) }).click();
  await expect(guest.getByRole('heading', { level: 1, name: 'Dark mode for the mobile app' })).toBeVisible();
  await expect(guest.getByText('Pricing for the enterprise plan')).toHaveCount(0);
  await outside.close();
  await api.patch(`/projects/${key}`, { guestAccess: false });
});
