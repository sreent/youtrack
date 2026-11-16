/**
 * Importing from YouTrack's API: a wrong token says so at once; the issues are read and mapped as
 * an export's columns would be; a page reloaded since, which no longer holds the token, asks for
 * it again before the files can come; and the import brings the issues with their comments, work
 * items and files.
 */
import { uniqueKey } from './support/api';
import { expectAccessible } from './support/checks';
import { expect, test } from './support/fixtures';
import { startYouTrack, YT_TOKEN, type FakeYouTrack } from './support/youtrack';

let yt: FakeYouTrack;

test.beforeAll(async () => {
  yt = await startYouTrack();
});

test.afterAll(async () => {
  await yt?.close();
});

test('issues are read from YouTrack, mapped, checked and imported with their comments, work items and files', async ({ page, api, watch }) => {
  const key = uniqueKey('YI');
  await api.createProject({ key, name: `Old tracker ${key}` });
  await page.goto('/import');
  const form = page.getByRole('region', { name: 'Read from YouTrack or Jira' });
  await form.getByLabel('Into the project').selectOption(key);
  await form.getByLabel('Its address').fill(yt.url);
  await form.getByLabel('Which issues: a query').fill('project: OLD');

  // A wrong token says so at once, and nothing is read.
  watch.allow(/status of 400/);
  await form.getByLabel('Permanent token').fill('perm:not-it');
  await form.getByRole('button', { name: 'Read the issues' }).click();
  await expect(form.getByText("YouTrack didn't accept the token")).toBeVisible();
  await expect(page).toHaveURL(/\/import$/);

  await form.getByLabel('Permanent token').fill(YT_TOKEN);
  await form.getByRole('button', { name: 'Read the issues' }).click();

  // Read, and mapped as the columns of an export would be.
  const columns = page.getByRole('region', { name: 'Its columns' });
  await expect(columns).toBeVisible();
  await expect(columns).toContainText(`From YouTrack at ${yt.url}, the issues matching project: OLD, read as Jane Remote: 2 issues, with 1 comment, 1 work item, 1 file (18 bytes).`);
  await expect(columns.getByRole('row').filter({ hasText: 'Issue Id' })).toContainText('OLD-1');
  await expectAccessible(page);

  // The page forgets the token when it's reloaded, and a4a never kept it: the run asks again.
  await page.reload();
  const check = page.getByRole('region', { name: 'Check it, then import it' });
  await expect(check).toContainText("It brings 1 file from YouTrack, downloaded as it runs. a4a doesn't keep the token: give it again to import.");
  await check.getByRole('button', { name: 'Check it' }).click();
  await expect(check.getByLabel('What it would do')).toContainText('To create2');
  await expect(check.getByLabel('What it would do')).toContainText('Work items1');
  await expect(check.getByLabel('What it would do')).toContainText('Files1');
  const importIt = check.getByRole('button', { name: 'Import 2 issues' });
  await expect(importIt).toBeDisabled();
  await check.getByLabel('Permanent token').fill(YT_TOKEN);
  await importIt.click();

  const report = page.getByRole('region', { name: 'What the import did' });
  await expect(report).toBeVisible();
  await expect(report.getByLabel('What it did')).toContainText('Created2');
  await expect(report.getByLabel('What it did')).toContainText('Files1');
  await expectAccessible(page);

  // The issue, as it was there: its comment, its work item and its file.
  await report.getByRole('link', { name: `${key}-1` }).click();
  await expect(page.getByRole('heading', { name: 'Move the invoices to the new store' })).toBeVisible();
  await expect(page.getByText('The bucket is read-only now.')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Listing the files' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'notes.txt' })).toBeVisible();
});
