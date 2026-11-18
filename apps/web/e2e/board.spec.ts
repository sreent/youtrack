/**
 * A board: a card dragged to another column is saved, through the board's rank, with the version the board showed; from
 * the keyboard, a card's id opens the command dialog that moves it; and a card someone else
 * changed meanwhile isn't moved over their change. The board and its issues are this file's own.
 */
import type { Page } from '@playwright/test';
import type { Board, IssueDetail } from '@a4a/shared';
import { fieldValue, uniqueKey } from './support/api';
import { SECOND_AUTH_FILE } from './support/env';
import { expect, holdLiveEvents, test } from './support/fixtures';

// The second of the flows' administrators (support/env.ts says why).
test.use({ storageState: SECOND_AUTH_FILE });

let key: string;
let board: Board;

test.beforeAll(async ({ workerApi: api }) => {
  key = uniqueKey('BD');
  await api.createProject({ key, name: `Releases ${key}` });
  board = await api.createBoard({
    name: `Releases ${key}`,
    projects: [key],
    columns: [
      { name: 'Open', values: ['Open'] },
      { name: 'In Progress', values: ['In Progress'] },
      { name: 'Done', values: ['Fixed'] },
    ],
  });
});

const card = (page: Page, issue: IssueDetail) => page.getByRole('button', { name: `Move ${issue.id} with a command` });
const column = (page: Page, name: string) => page.getByRole('list', { name, exact: true });

/** Drag a card, as a mouse does: press, move past the threshold, carry it over the column, let go. */
async function drag(page: Page, issue: IssueDetail, to: string) {
  const from = await page.getByRole('listitem').filter({ has: card(page, issue) }).boundingBox();
  const target = await column(page, to).boundingBox();
  if (!from || !target) throw new Error(`Can't see ${issue.id} or the ${to} column`);
  // Press on the card's foot, away from its id and its link.
  await page.mouse.move(from.x + from.width / 2, from.y + from.height - 6);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height - 2, { steps: 4 });
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
  await expect(column(page, to).getByText(`Drop it to move ${issue.id} to ${to}`)).toBeVisible();
  await page.mouse.up();
}

test('a card dragged to another column is saved with the version the board showed', async ({ page, api }) => {
  const issue = await api.createIssue({ project: key, summary: 'Ship the 2.4 release notes', fields: { Type: 'Task' } });
  await page.goto(`/boards/${board.id}`);
  await expect(column(page, 'Open').getByRole('button', { name: `Move ${issue.id} with a command` })).toBeVisible();

  const saved = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/v1/boards/${board.id}/rank`));
  await drag(page, issue, 'In Progress');
  // Into a column with nobody to place it against: its column, and its place in the board's order kept.
  expect((await saved).postDataJSON()).toEqual({ issue: issue.id, column: 'In Progress', expectedVersion: issue.version });

  await expect(column(page, 'In Progress').getByRole('button', { name: `Move ${issue.id} with a command` })).toBeVisible();
  await expect(column(page, 'Open').getByRole('button', { name: `Move ${issue.id} with a command` })).toBeHidden();
  expect(fieldValue(await api.issue(issue.id), 'State')).toBe('In Progress');
});

test("from the keyboard, a card's id opens the command that moves it, and the focus follows the card", async ({ page, api }) => {
  const issue = await api.createIssue({ project: key, summary: 'Tag the release in git', fields: { Type: 'Task' } });
  await page.goto(`/boards/${board.id}`);
  const id = column(page, 'Open').getByRole('button', { name: `Move ${issue.id} with a command` });
  await id.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog', { name: 'Apply a command' });
  const command = dialog.getByRole('combobox', { name: 'Command' });
  // It starts from the next column's value, and shows what it changes before anything does.
  await expect(command).toHaveValue('State In Progress');
  await expect(command).toBeFocused();
  const preview = dialog.getByRole('group', { name: 'What it changes' });
  await expect(preview.getByRole('insertion')).toHaveText('In Progress');
  await expect(dialog.getByRole('button', { name: `Apply to ${issue.id}` })).toBeEnabled();
  await page.keyboard.press('Enter');

  await expect(dialog).toBeHidden();
  const moved = column(page, 'In Progress').getByRole('button', { name: `Move ${issue.id} with a command` });
  await expect(moved).toBeVisible();
  await expect(moved).toBeFocused();
  expect(fieldValue(await api.issue(issue.id), 'State')).toBe('In Progress');
});

test('a card someone changed meanwhile stays where it was, and the board says why (409)', async ({ page, api, watch }) => {
  watch.allow(/status of 409/);
  await holdLiveEvents(page);
  const issue = await api.createIssue({ project: key, summary: 'Update the download page', fields: { Type: 'Task' } });
  await page.goto(`/boards/${board.id}`);
  await expect(column(page, 'Open').getByRole('button', { name: `Move ${issue.id} with a command` })).toBeVisible();

  await api.updateIssue(issue.id, { fields: { Priority: 'Critical' } });
  const refused = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/v1/boards/${board.id}/rank`));
  await drag(page, issue, 'In Progress');
  expect((await refused).status()).toBe(409);

  const note = page.getByRole('alert').filter({ hasText: `Someone changed ${issue.id} while you were moving it, so it stayed in Open.` });
  await expect(note).toBeVisible();
  await expect(column(page, 'Open').getByRole('button', { name: `Move ${issue.id} with a command` })).toBeVisible();
  // The board read it again: it shows the other change.
  await expect(column(page, 'Open').getByRole('listitem').filter({ has: card(page, issue) }).getByRole('meter', { name: 'Priority' })).toHaveAttribute(
    'aria-valuetext',
    'Critical',
  );
  expect(fieldValue(await api.issue(issue.id), 'State')).toBe('Open');
  await note.getByRole('button', { name: 'Dismiss' }).click();
  await expect(note).toBeHidden();
});
