/**
 * The issue list: a query's problem and its one-click fix, suggestions from the keyboard, rows
 * chosen from the keyboard and a command previewed then applied, a saved search, and a query read
 * from words (the AI stood in for). The issues are in a project of this file's own.
 */
import type { IssueDetail } from '@a4a/shared';
import { mockWordsToQuery, aiOn } from './support/ai';
import { fieldValue, uniqueKey } from './support/api';
import { expect, test } from './support/fixtures';

let key: string;
let exporting: IssueDetail;
let darkMode: IssueDetail;
let stale: IssueDetail;

test.beforeAll(async ({ workerApi: api }) => {
  key = uniqueKey('IQ');
  await api.createProject({ key, name: `Search and commands ${key}` });
  exporting = await api.createIssue({ project: key, summary: 'Export fails for large CSV files', fields: { Type: 'Bug', Priority: 'Major' } });
  darkMode = await api.createIssue({ project: key, summary: 'Add dark mode to the reports page', fields: { Type: 'Feature', Priority: 'Normal' } });
  stale = await api.createIssue({ project: key, summary: 'Search shows stale results after an edit', fields: { Type: 'Bug', Priority: 'Critical', State: 'Fixed' } });
});

test('a query problem is underlined, fixed with one click, and suggestions come from the keyboard', async ({ page }) => {
  await page.goto(`/issues?q=${encodeURIComponent(`project: ${key}`)}`);
  await expect(page.getByRole('list', { name: '3 issues' })).toBeVisible();
  const query = page.getByRole('combobox', { name: 'Search issues' });

  await query.fill(`project: ${key} State: Fixd`);
  await expect(page.getByText('Unknown value "Fixd" for State')).toBeVisible();
  await expect(query).toHaveAttribute('aria-invalid', 'true');
  // A query with a problem doesn't run: Enter checks it again, and stops there.
  const before = page.url();
  const checked = Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/search/parse'),
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/search/suggest'),
  ]);
  await query.press('Enter');
  await checked;
  await page.evaluate(() => new Promise(requestAnimationFrame));
  expect(page.url()).toBe(before);

  await page.getByRole('button', { name: 'Fixed', exact: true }).click();
  await expect(query).toHaveValue(`project: ${key} State: Fixed`);
  await expect(query).not.toHaveAttribute('aria-invalid');
  await expect(query).toBeFocused();

  // " Prio": the field is suggested; the arrows reach it, and Tab takes it.
  await query.press('End');
  await query.pressSequentially(' Prio');
  const suggestions = page.getByRole('listbox', { name: 'Suggestions' });
  await expect(suggestions.getByRole('option', { name: /^Priority:/ })).toBeVisible();
  await query.press('ArrowDown');
  await expect(suggestions.getByRole('option', { selected: true })).toHaveText(/^Priority:/);
  await query.press('Tab');
  await expect(query).toHaveValue(`project: ${key} State: Fixed Priority: `);
  await expect(query).toBeFocused();

  await query.pressSequentially('Crit');
  await expect(suggestions.getByRole('option', { name: /^Critical/ })).toBeVisible();
  await query.press('Tab');
  await expect(query).toHaveValue(new RegExp(`^project: ${key} State: Fixed Priority: Critical\\s*$`));

  await query.press('Enter');
  const found = page.getByRole('list', { name: '1 issues' });
  await expect(found.getByRole('listitem')).toHaveCount(1);
  await expect(found.getByRole('link', { name: stale.summary })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /^1 issue/ })).toBeVisible();
});

test('rows chosen from the keyboard get a command, previewed before it applies', async ({ page, api }) => {
  await page.goto(`/issues?q=${encodeURIComponent(`project: ${key} #Unresolved sort by: created asc`)}`);
  const rows = page.getByRole('list', { name: '2 issues' }).getByRole('listitem');
  await expect(rows).toHaveCount(2);

  // One stop for the list; the arrows move inside it, Space chooses.
  await rows.first().focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.getByText('2 chosen')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: `Choose ${exporting.id}` })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: `Choose ${darkMode.id}` })).toBeChecked();

  await page.getByRole('button', { name: 'Apply a command' }).click();
  const dialog = page.getByRole('dialog', { name: 'Apply a command' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(`To 2 issues: ${exporting.id} and ${darkMode.id}`)).toBeVisible();
  const command = dialog.getByRole('combobox', { name: 'Command' });
  await expect(command).toBeFocused();

  // A misspelt value: the problem, its fix, then what it would change on each issue.
  await command.fill('State In Progres');
  await expect(dialog.getByText('Unknown value "In Progres" for State')).toBeVisible();
  const apply = dialog.getByRole('button', { name: 'Apply to 2 issues' });
  await expect(apply).toBeDisabled();
  await dialog.getByRole('button', { name: '{In Progress}' }).click();
  await expect(command).toHaveValue('State {In Progress}');

  const preview = dialog.getByRole('group', { name: 'What it changes' });
  for (const issue of [exporting, darkMode]) {
    const line = preview.getByRole('listitem').filter({ hasText: issue.id });
    await expect(line).toContainText(issue.summary);
    await expect(line.getByRole('insertion')).toHaveText('In Progress');
  }
  // Nothing has changed yet.
  expect(fieldValue(await api.issue(exporting.id), 'State')).toBe('Open');

  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('2 chosen')).toBeHidden();
  for (const issue of [exporting, darkMode]) {
    expect(fieldValue(await api.issue(issue.id), 'State')).toBe('In Progress');
    await expect(page.getByRole('listitem').filter({ hasText: issue.id })).toContainText('In Progress');
  }
});

test('a search is saved, chosen again, and forgotten', async ({ page, api }) => {
  const query = `project: ${key} Type: Bug`;
  const name = `Bugs in ${key}`;
  await page.goto(`/issues?q=${encodeURIComponent(query)}`);
  await expect(page.getByRole('list', { name: '2 issues' })).toBeVisible();

  await page.getByRole('button', { name: 'Save this search' }).click();
  const naming = page.getByRole('textbox', { name: 'Name for this search' });
  await expect(naming).toBeFocused();
  await naming.fill(name);
  await naming.press('Enter');
  const saved = page.getByRole('button', { name, exact: true });
  await expect(saved).toHaveAttribute('aria-current', 'true');

  // From all issues, the saved search brings its query back.
  await page.goto('/issues');
  await expect(page.getByRole('list', { name: /^\d+ issues$/ })).toBeVisible();
  await saved.click();
  await expect(page.getByRole('combobox', { name: 'Search issues' })).toHaveValue(query);
  await expect(page.getByRole('list', { name: '2 issues' })).toBeVisible();
  await expect(saved).toHaveAttribute('aria-current', 'true');

  await page.getByRole('button', { name: `Forget “${name}”` }).click();
  await expect(saved).toBeHidden();
  await expect(page.getByRole('button', { name: 'Save this search' })).toBeVisible();
  const kept = await api.get<{ name: string }[]>('/saved-searches');
  expect(kept.map((s) => s.name)).not.toContain(name);
});

test('words become a query, and the page shows the query it read (AI stood in for)', async ({ page }) => {
  await aiOn(page);
  const ai = await mockWordsToQuery(page, () => ({ query: `project: ${key} Priority: Critical`, explanation: `Issues in project ${key}, Priority: Critical`, valid: true }));
  await page.goto(`/issues?q=${encodeURIComponent(`project: ${key}`)}`);
  await expect(page.getByRole('list', { name: '3 issues' })).toBeVisible();

  const ask = page.getByRole('button', { name: 'Ask in words' });
  await ask.click();
  await expect(ask).toHaveAttribute('aria-pressed', 'true');
  const words = page.getByRole('combobox', { name: 'Ask in words' });
  await expect(words).toBeFocused();
  await words.fill('the critical ones');
  await words.press('Enter');

  await expect(page.getByText('Interpreted as:')).toBeVisible();
  await expect(page.getByRole('main').getByText(`project: ${key} Priority: Critical`, { exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: '1 issues' }).getByRole('link', { name: stale.summary })).toBeVisible();
  expect(ai.asked).toEqual([{ text: 'the critical ones', project: key }]);
});
