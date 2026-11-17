/**
 * Importing from ClickUp's API (D61): choosing ClickUp fills in its address; a List's tasks are
 * read and mapped (its status as the state, its watchers as watchers); and the import brings each
 * task with its checklist, its comment and its time tracked.
 */
import { uniqueKey } from './support/api';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { CU_LIST, CU_TOKEN, startClickUp, type FakeClickUp } from './support/clickup';
import { SECOND_AUTH_FILE } from './support/env';
import { expect, test } from './support/fixtures';

// The second of the flows' administrators (support/env.ts says why).
test.use({ storageState: SECOND_AUTH_FILE });

let cu: FakeClickUp;

test.beforeAll(async () => {
  cu = await startClickUp();
});

test.afterAll(async () => {
  await cu?.close();
});

test("a ClickUp List's tasks are read, mapped, checked and imported with their checklists, comments and time", async ({ page, api }) => {
  const key = uniqueKey('CU');
  await api.createProject({ key, name: `From ClickUp ${key}` });
  await page.goto('/import');
  const form = page.getByRole('region', { name: 'Read from another tracker' });
  await form.getByLabel('Into the project').selectOption(key);

  // ClickUp has one address for everyone: choosing it fills it in, and asks for its words.
  await form.getByRole('radio', { name: 'ClickUp' }).check();
  await expect(form.getByLabel('Its address')).toHaveValue('https://app.clickup.com');
  await expect(form.getByRole('checkbox', { name: 'Its time entries' })).toBeChecked();
  await form.getByLabel('Its address').fill(cu.url);
  await form.getByLabel('Personal token').fill(CU_TOKEN);
  await form.getByLabel('Which tasks: a List').fill(CU_LIST);
  await expectNoSidewaysScroll(page);
  await form.getByRole('button', { name: 'Read the issues' }).click();

  const columns = page.getByRole('region', { name: 'Its columns' });
  await expect(columns).toBeVisible();
  await expect(columns).toContainText(`From ClickUp at ${cu.url}, the issues matching ${CU_LIST}, read as Jane Remote: 2 issues, with 1 comment, 1 time entry and 0 files.`);
  await expect(columns.getByLabel('What "Status" becomes')).toHaveValue('field:State');
  await expect(columns.getByLabel('What "Watchers" becomes')).toHaveValue('watchers');
  await expectAccessible(page);

  const check = page.getByRole('region', { name: 'Check it, then import it' });
  await check.getByRole('button', { name: 'Check it' }).click();
  await expect(check.getByLabel('What it would do')).toContainText('To create2');
  await expect(check.getByLabel('What it would do')).toContainText('Work items1');
  await check.getByRole('button', { name: 'Import 2 issues' }).click();

  const report = page.getByRole('region', { name: 'What the import did' });
  await expect(report.getByLabel('What it did')).toContainText('Created2');
  await expect(report.getByLabel('What it did')).toContainText('Links and parents1');

  // The task, as it was there: its checklist in its description, its comment and its time.
  await report.getByRole('link', { name: `${key}-1` }).click();
  await expect(page.getByRole('heading', { name: 'Ship the mobile app' })).toBeVisible();
  await expect(page.getByText('Tag the build')).toBeVisible();
  await expect(page.getByText('Write the notes')).toBeVisible();
  await expect(page.getByText('The build is green')).toBeVisible();
  // Its time tracked there is its time spent here; its history names where it came from.
  await expect(page.getByRole('cell', { name: '45m' })).toBeVisible();
  await expect(page.getByText('imported it from ClickUp (86e1)')).toBeVisible();
  await expectAccessible(page);
});
