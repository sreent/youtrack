/**
 * Builds from CI (docs/architecture.md, D46). An administrator takes a project's builds on the
 * Integrations page and copies the token shown once; a CI posts a build with it; the build marks
 * the resolved issue its commit names, which the builds page and the issue both say.
 */
import { fieldValue, unique, uniqueKey } from './support/api';
import { expect, test } from './support/fixtures';
import { AUTH_FILE, THIRD_AUTH_FILE } from './support/env';

// The third of the flows' administrators (support/env.ts says why).
test.use({ storageState: THIRD_AUTH_FILE });

test('a build from CI marks the resolved issue its commits name, and says so', async ({ page, api, playwright, browser }) => {
  const key = uniqueKey('BU');
  const project = await api.createProject({ key, name: `Builds ${key}` });
  const fixed = await api.createIssue({ project: key, summary: 'Checkout rounds twice', fields: { Type: 'Bug' } });
  await api.post('/commands', { issues: [fixed.id], command: 'State Fixed' });
  const open = await api.createIssue({ project: key, summary: 'Export is slow', fields: { Type: 'Bug' } });

  await page.goto('/integrations');
  const add = page.getByRole('region', { name: "Take a project's builds" });
  const name = `Jenkins ${unique()}`;
  await add.getByLabel('Name', { exact: true }).fill(name);
  await add.getByLabel('Builds of the project').selectOption(key);
  await add.getByRole('button', { name: 'Take its builds' }).click();
  const shown = add.getByRole('status').filter({ hasText: 'Copy the token now.' });
  await expect(shown.getByRole('code').filter({ hasText: /^a4a_ci_/ })).toBeVisible();
  const codes = await shown.getByRole('code').allTextContents();
  const hookUrl = codes.find((c) => /\/api\/v1\/builds\/hooks\//.test(c));
  const token = codes.find((c) => c.startsWith('a4a_ci_'));
  expect(hookUrl && token).toBeTruthy();
  const card = page.getByRole('listitem').filter({ hasText: name });
  await expect(card).toContainText('into Fixed in build');

  // The CI posts with its token alone: no cookie, as a build step would.
  const ci = await playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
  const refused = await ci.post(hookUrl!, { data: { build: '2.0.1' }, headers: { authorization: 'Bearer not-the-token' } });
  expect(refused.status()).toBe(401);
  const posted = await ci.post(hookUrl!, {
    data: { build: '2.0.1', url: 'https://ci.acme.example/job/backend/201/', commits: [{ message: `Round once (${fixed.id})` }, { message: `Stream it (${open.id})` }] },
    headers: { authorization: `Bearer ${token}` },
  });
  expect(posted.status()).toBe(200);
  expect(await posted.json()).toMatchObject({ outcome: 'recorded', marked: 1 });
  await ci.dispose();
  expect(fieldValue(await api.issue(fixed.id), 'Fixed in build')).toBe('2.0.1');

  await page.goto(`/builds/${key}`);
  const table = page.getByRole('region', { name: 'Table of builds' });
  const row = table.getByRole('row').filter({ hasText: '2.0.1' });
  await expect(row).toContainText('passed');
  await expect(row.getByRole('link', { name: fixed.id })).toBeVisible();
  await expect(row).toContainText('fixed in it');
  await expect(row).toContainText('not resolved yet');
  await expect(page.getByRole('heading', { name: `Builds of ${project.name}` })).toBeVisible();

  await page.goto(`/issues/${fixed.id}`);
  const builds = page.getByRole('region', { name: 'Commits and pull requests' }).getByRole('group', { name: 'Builds' });
  await expect(builds.getByRole('link', { name: 'Build 2.0.1' })).toHaveAttribute('href', 'https://ci.acme.example/job/backend/201/');
  await expect(builds).toContainText('fixed in it');
  await expect(row.getByRole('listitem').filter({ hasText: open.id })).toHaveAttribute('title', 'Not resolved yet');

  // A German page says why a build left an issue in German: a4a kept the note's words beside its English.
  const german = await browser.newContext({ locale: 'de-DE', storageState: AUTH_FILE });
  const deutsch = await german.newPage();
  await deutsch.goto(`/builds/${key}`);
  const zeile = deutsch.getByRole('region', { name: 'Tabelle der Builds' }).getByRole('row').filter({ hasText: '2.0.1' });
  await expect(zeile.getByRole('listitem').filter({ hasText: open.id })).toHaveAttribute('title', 'Noch nicht erledigt');
  await deutsch.goto(`/issues/${open.id}`);
  const gebaut = deutsch.getByRole('region', { name: 'Commits und Pull Requests' }).getByRole('group', { name: 'Builds' });
  await expect(gebaut).toContainText('Noch nicht erledigt ·');
  await german.close();
});
