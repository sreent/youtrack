/**
 * Undo of your own edit in a view (D34's revisit), in the built app: a command on two issues chosen in
 * the list is one edit, which its toast's Undo puts back, and so does Ctrl+Z; Ctrl+Shift+Z makes it
 * again. The toasts' region says each toast once, in its status line, and F8 reaches it. The issue's
 * history offers Undo on your own edit, naming the other issue it puts back. Light, dark and 390px.
 */
import type { IssueDetail } from '@a4a/shared';
import type { Page } from '@playwright/test';
import { fieldValue, uniqueKey } from './support/api';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { expect, test } from './support/fixtures';

let key: string;
let first: IssueDetail;
let second: IssueDetail;

test.beforeAll(async ({ workerApi: api }) => {
  key = uniqueKey('VU');
  await api.createProject({ key, name: `Undo in a view ${key}` });
  first = await api.createIssue({ project: key, summary: 'Exports time out on big projects', fields: { Priority: 'Normal' } });
  second = await api.createIssue({ project: key, summary: 'Search is slow after an import', fields: { Priority: 'Normal' } });
});

const priorities = async (api: { issue(id: string): Promise<IssueDetail> }) => Promise.all([first, second].map(async (i) => fieldValue(await api.issue(i.id), 'Priority')));

/** Both issues chosen in the list, and a command applied to them. */
async function commandOnBoth(page: Page, command: string): Promise<void> {
  await page.goto(`/issues?q=${encodeURIComponent(`project: ${key} sort by: created asc`)}`);
  await expect(page.getByRole('list', { name: '2 issues' }).getByRole('listitem')).toHaveCount(2);
  for (const issue of [first, second]) await page.getByRole('checkbox', { name: `Choose ${issue.id}` }).check();
  await page.getByRole('button', { name: 'Apply a command' }).click();
  const dialog = page.getByRole('dialog', { name: 'Apply a command' });
  await dialog.getByRole('combobox', { name: 'Command' }).fill(command);
  const apply = dialog.getByRole('button', { name: 'Apply to 2 issues' });
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(dialog).toBeHidden();
}

test('a command on two chosen issues is undone from its toast, which the status line says once', async ({ page, api }) => {
  await commandOnBoth(page, 'Priority Critical');
  expect(await priorities(api)).toEqual(['Critical', 'Critical']);
  const region = page.getByRole('region', { name: 'Recent changes' });
  const toast = region.locator('.toast');
  await expect(toast.locator('.toast-words')).toHaveText('Changed 2 issues.');
  // Held under the pointer while it's read and drawn.
  await toast.hover();
  // Said once, by the region's status line, with the key that undoes it; the toasts themselves aren't live.
  const said = region.getByRole('status');
  await expect(said).toHaveText('Changed 2 issues. Ctrl+Z undoes it.');
  expect(await region.locator('[aria-live], [role="status"], [role="alert"], [role="log"]').count()).toBe(1);
  expect(await toast.evaluate((el) => el.closest('[aria-live], [role="status"], [role="alert"]'))).toBeNull();
  const undo = toast.getByRole('button', { name: 'Undo' });
  await expect(undo).toHaveAccessibleDescription('Changed 2 issues.');
  await expect(toast.getByRole('button', { name: 'Dismiss' })).toHaveAccessibleDescription('Changed 2 issues.');
  await page.screenshot({ path: test.info().outputPath('view-undo-toast-light.png') });
  await expectAccessible(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: test.info().outputPath('view-undo-toast-dark.png') });
  await expectAccessible(page);
  await page.emulateMedia({ colorScheme: 'light' });

  await undo.click();
  await expect(region.locator('.toast-words')).toHaveText('Put 2 issues back as they were.');
  await expect(said).toHaveText('Put 2 issues back as they were.');
  await expect.poll(() => priorities(api)).toEqual(['Normal', 'Normal']);
  for (const issue of [first, second]) await expect(page.getByRole('listitem').filter({ hasText: issue.id })).toContainText('Normal');
});

test('Ctrl+Z undoes your newest edit on the page, Ctrl+Shift+Z makes it again, and a text field keeps its own', async ({ page, api }) => {
  await commandOnBoth(page, 'Priority Major');
  expect(await priorities(api)).toEqual(['Major', 'Major']);
  const said = page.getByRole('region', { name: 'Recent changes' }).getByRole('status');
  await expect(said).toHaveText('Changed 2 issues. Ctrl+Z undoes it.');

  // In the search field, Ctrl+Z is the field's: nothing is undone.
  const query = page.getByRole('combobox', { name: 'Search issues' });
  await query.focus();
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  expect(await priorities(api)).toEqual(['Major', 'Major']);

  // Anywhere else on the page, before its toast goes and after.
  await page.getByRole('list', { name: '2 issues' }).getByRole('listitem').first().focus();
  await page.keyboard.press('Control+z');
  await expect(said).toHaveText('Put 2 issues back as they were.');
  await expect.poll(() => priorities(api)).toEqual(['Normal', 'Normal']);

  await page.keyboard.press('Control+Shift+z');
  await expect(said).toHaveText('Changed 2 issues. Ctrl+Z undoes it.');
  await expect.poll(() => priorities(api)).toEqual(['Major', 'Major']);
  await page.keyboard.press('Control+z');
  await expect.poll(() => priorities(api)).toEqual(['Normal', 'Normal']);
});

test('the history offers Undo on your own edit, naming the other issue it puts back; F8 reaches the toast', async ({ page, api }) => {
  await commandOnBoth(page, 'Priority Minor');
  const region = page.getByRole('region', { name: 'Recent changes' });
  await expect(region.locator('.toast')).toHaveCount(1);
  // F8 reaches the newest toast from the page, and goes back.
  const row = page.getByRole('list', { name: '2 issues' }).getByRole('listitem').first();
  await row.focus();
  await page.keyboard.press('F8');
  await expect(region.getByRole('button', { name: 'Undo' })).toBeFocused();
  await page.keyboard.press('F8');
  await expect(row).toBeFocused();

  await page.goto(`/issues/${first.id}`);
  const history = page.getByRole('region', { name: 'History and comments' });
  const entry = history.getByRole('listitem').filter({ hasText: 'changed it in the list' }).last();
  await expect(entry).toContainText(`Made with ${second.id}: Undo puts it back too.`);
  const undo = entry.getByRole('button', { name: 'Undo your change' });
  await expect(undo).toHaveAccessibleDescription(`Made with ${second.id}: Undo puts it back too.`);
  await undo.click();
  await expect(entry).toContainText('Undone: Priority as before.');
  await expect.poll(() => priorities(api)).toEqual(['Normal', 'Normal']);
});

test('at a phone’s width the toast fits, and nothing scrolls sideways', async ({ page, api }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await commandOnBoth(page, 'Priority Critical');
  const toast = page.getByRole('region', { name: 'Recent changes' }).locator('.toast');
  await expect(toast.locator('.toast-words')).toHaveText('Changed 2 issues.');
  await toast.hover();
  await expectNoSidewaysScroll(page);
  await page.screenshot({ path: test.info().outputPath('view-undo-toast-390.png') });
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => priorities(api)).toEqual(['Normal', 'Normal']);
});
