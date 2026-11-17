/**
 * Subscriptions and time zones (docs/architecture.md, D31).
 *
 * A person subscribes to a project's new issues on its page, and to a saved search of their own on
 * the Issues page; what someone else does reaches their inbox, saying which subscription brought it;
 * their profile lists both, changes one and ends the other. Their time zone, offered from their
 * browser's on the profile, is where their searches read "today".
 *
 * Each test signs in as people of its own, so nobody else's inbox or zone is touched.
 */
import type { APIRequestContext, Page, PlaywrightWorkerArgs } from '@playwright/test';
import type { IssueDetail } from '@a4a/shared';
import { unique, uniqueKey } from './support/api';
import { BASE_URL } from './support/env';
import { expect, test } from './support/fixtures';

test.use({ storageState: { cookies: [], origins: [] } });

async function signIn(page: Page, login: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/issues$/);
}

/** Someone else, signed in elsewhere, to change things behind the page's back. */
async function sessionOf(playwright: PlaywrightWorkerArgs['playwright'], login: string, password: string): Promise<APIRequestContext> {
  const session = await playwright.request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin: BASE_URL } });
  expect((await session.post('/api/v1/auth/login', { data: { login, password } })).status()).toBe(200);
  return session;
}

test('a person subscribes to a project and to a saved search, and hears of what comes in', async ({ page, api, playwright }) => {
  const key = uniqueKey('SU');
  const project = await api.createProject({ key, name: `Subscribed ${key}` });
  const rita = `rita.${unique()}`;
  const wes = `wes.${unique()}`;
  await api.createUser({ login: rita, name: 'Rita Reyes', password: 'rita-pass-1', role: 'member' });
  await api.createUser({ login: wes, name: 'Wes Ward', password: 'wes-pass-1', role: 'member' });
  const other = await sessionOf(playwright, wes, 'wes-pass-1');
  await signIn(page, rita, 'rita-pass-1');

  // On the project's page: its new issues.
  await page.goto(`/projects/${key}`);
  const card = page.getByRole('region', { name: 'Your subscription' });
  await expect(card.getByRole('radio', { name: /^Nothing more/ })).toBeChecked();
  await card.getByRole('radio', { name: /^New issues/ }).check();
  await expect(card.getByRole('status')).toHaveText(`You're told of new issues in ${project.name}, by email too.`);

  // On the Issues page: a saved search of her own, and an issue coming into it.
  const search = `Critical in ${key}`;
  await page.goto(`/issues?q=${encodeURIComponent(`project: ${key} Priority: Critical`)}`);
  await page.getByRole('button', { name: 'Save this search' }).click();
  await page.getByRole('textbox', { name: 'Name for this search' }).fill(search);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const following = page.getByRole('combobox', { name: `Your subscription to “${search}”` });
  await expect(following).toHaveValue('none');
  await following.selectOption({ label: 'Tell me when an issue comes into it' });
  await expect(page.getByText('Subscribed: your inbox will say.')).toBeVisible();

  // Wes reports one issue, and a critical one: each reaches her, and says which subscription brought it.
  const create = async (summary: string, priority: string) => {
    const res = await other.post('/api/v1/issues', { data: { project: key, summary, fields: { Priority: priority } } });
    expect(res.status()).toBe(201);
    return (await res.json()) as IssueDetail;
  };
  const normal = await create('Exports time out on big projects', 'Normal');
  const critical = await create('Logins fail after the upgrade', 'Critical');
  await page.goto('/inbox');
  const inbox = page.getByRole('list', { name: 'Unread, by issue' });
  const entry = (issue: IssueDetail) => inbox.getByRole('listitem').filter({ has: page.getByRole('link', { name: new RegExp(`^${issue.id}: `) }) });
  // The notifier tells her once the change has settled; the inbox shows it as it comes.
  await expect(entry(normal).getByText(`Because you subscribed to new issues in ${project.name}.`)).toBeVisible({ timeout: 30_000 });
  await expect(entry(critical).getByText(`Because you subscribed to issues coming into “${search}”.`)).toBeVisible({ timeout: 30_000 });
  await expect(entry(normal)).toContainText('Wes Ward reported it');

  // Her profile lists both: one changes, the other ends.
  await page.goto('/me');
  const table = page.getByRole('region', { name: 'Table of your subscriptions' });
  await expect(table.getByRole('row')).toHaveCount(3);
  await table.getByRole('combobox', { name: `What ${project.name} tells you of` }).selectOption({ label: 'Every change' });
  await expect(page.getByRole('region', { name: 'What you subscribe to' }).getByRole('status')).toHaveText('Saved.');
  await table.getByRole('checkbox', { name: `Email me about ${project.name}` }).uncheck();
  await expect(table.getByRole('checkbox', { name: `Email me about ${project.name}` })).not.toBeChecked();
  await table.getByRole('button', { name: `Unsubscribe from “${search}”` }).click();
  await expect(table.getByRole('row')).toHaveCount(2);
  const mine = (await (await page.request.get('/api/v1/subscriptions')).json()) as { project: { key: string } | null; events: string; email: boolean }[];
  expect(mine).toEqual([expect.objectContaining({ project: expect.objectContaining({ key }), events: 'all', email: false })]);
  await other.dispose();
});

test.describe('in another time zone', () => {
  test.use({ timezoneId: 'Asia/Tokyo' });

  test("a person takes their browser's time zone, and their searches read today there", async ({ page, api }) => {
    const login = `kei.${unique()}`;
    await api.createUser({ login, name: 'Kei Mori', password: 'kei-pass-1', role: 'member' });
    await signIn(page, login, 'kei-pass-1');
    await page.goto('/me');
    const you = page.getByRole('region', { name: 'You' });
    const zone = you.getByRole('combobox', { name: 'Time zone' });
    await expect(zone).toHaveValue('');
    await you.getByRole('button', { name: 'Use your browser’s, Asia/Tokyo' }).click();
    await expect(zone).toHaveValue('Asia/Tokyo');
    await you.getByRole('button', { name: 'Save the changes' }).click();
    // The subscriptions reload in the new zone, and their loading line is a status of its own.
    await expect(you.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Notifications', exact: true })).toContainText('at 08:00 your time (Asia/Tokyo)');

    await page.reload();
    await expect(you.getByRole('combobox', { name: 'Time zone' })).toHaveValue('Asia/Tokyo');
    await page.goto(`/issues?q=${encodeURIComponent('created: today')}`);
    await expect(page.getByRole('status').filter({ hasText: '(dates in Asia/Tokyo)' })).toBeVisible();
  });
});
