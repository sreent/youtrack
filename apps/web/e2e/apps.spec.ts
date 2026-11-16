/**
 * Apps (docs/architecture.md, D48). An administrator reads what an app asks for, installs it for a
 * project, and its widget draws on that project's issues: a sandboxed frame, named as an app's, that
 * asks a4a through the page for what its app was granted. A frame that isn't the widget's is not
 * heard. Removing the app takes its widget away.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uniqueKey } from './support/api';
import { BASE_URL, SECOND_AUTH_FILE } from './support/env';
import { expect, test } from './support/fixtures';
import { zipFolder } from './support/zip';

// The second of the flows' administrators (support/env.ts says why).
test.use({ storageState: SECOND_AUTH_FILE });

const here = path.dirname(fileURLToPath(import.meta.url));
const example = path.resolve(here, '../../../examples/apps/time-by-person');

test('an app is installed after reading what it asks, and its widget asks a4a through the page', async ({ page, api }) => {
  const key = uniqueKey('AP');
  const project = await api.createProject({ key, name: `Apps ${key}` });
  const elsewhere = await api.createProject({ key: uniqueKey('AQ'), name: 'Not chosen' });

  // A run that was tried before left it installed: start from none.
  await page.request.delete(`${BASE_URL}/api/v1/apps/time-by-person`, { headers: { origin: BASE_URL } });
  await page.goto('/admin');
  const apps = page.getByRole('region', { name: 'Apps' });
  await expect(apps.getByText('No apps are installed.')).toBeVisible();
  await apps.getByLabel('Install from a file').setInputFiles({ name: 'time-by-person-1.0.0.zip', mimeType: 'application/zip', buffer: zipFolder(example) });

  // What it asks, in the words the administrator accepts, before anything is kept.
  const deciding = apps.getByRole('region', { name: 'Install Time by person' });
  const asks = deciding.getByRole('list', { name: 'What it asks to do' });
  await expect(asks.getByRole('listitem')).toHaveText(['Read issues: their summaries, descriptions, fields, tags and links', 'Read logged time']);
  await expect(deciding).toContainText('“Time by person” on an issue\'s side panel');
  await deciding.getByRole('checkbox', { name: new RegExp(`^${key}`) }).check();
  await deciding.getByRole('button', { name: 'Install it' }).click();
  await expect(apps.getByText(`Time by person is installed, for ${key}.`)).toBeVisible();
  const card = apps.getByRole('listitem').filter({ has: page.getByRole('heading', { name: /^Time by person/ }) });
  await expect(card).toContainText(`Runs in ${key}.`);
  await expect(card).toContainText('Its rules act as app-time-by-person.');

  // Its widget on the project's issue, adding up the time logged there.
  const issue = await api.createIssue({ project: key, summary: 'Speed up the nightly export' });
  await api.post(`/issues/${issue.id}/work-items`, { duration: '2h' });
  await page.goto(`/issues/${issue.id}`);
  const widget = page.getByRole('region', { name: 'Time by person' });
  await expect(widget.getByTitle('Time by person is an app')).toBeVisible();
  const frame = page.frameLocator('iframe[title="Time by person"]');
  await expect(frame.getByRole('table')).toContainText('2h');
  await expect(frame.getByText('2h in all.')).toBeVisible();

  // A frame that isn't the widget's isn't heard: its ask reaches nothing.
  const asked: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/users')) asked.push(r.url());
  });
  // The page itself posts what a widget would: it isn't the widget's frame, so nothing answers it.
  await page.evaluate(() => window.postMessage({ a4a: 1, type: 'request', id: 1, method: 'GET', path: '/users' }, '*'));
  await page.waitForTimeout(500);
  expect(asked).toEqual([]);

  // Not on an issue of a project it wasn't chosen for.
  const other = await api.createIssue({ project: elsewhere.key, summary: 'Nothing to see here' });
  await page.goto(`/issues/${other.id}`);
  await expect(page.getByRole('heading', { name: 'Nothing to see here' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Time by person' })).toHaveCount(0);

  // The project's managers see it among the project's apps.
  await page.goto(`/projects/${project.key}`);
  const projectApps = page.getByRole('region', { name: 'Apps' });
  await expect(projectApps.getByRole('list', { name: `Apps in ${key}` })).toContainText('runs here');

  // Removed, it takes its widget with it.
  await page.goto('/admin');
  await card.getByRole('button', { name: 'Remove Time by person' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove it' }).click();
  await expect(apps.getByText('No apps are installed.')).toBeVisible();
  await page.goto(`/issues/${issue.id}`);
  await expect(page.getByRole('heading', { name: 'Speed up the nightly export' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Time by person' })).toHaveCount(0);
});
