/**
 * The reports D44 adds: issues per field and the matrix, each count opening its issues; average age;
 * time in state, by states and by a board's columns; as CSV, and as dashboard widgets.
 */
import { uniqueKey } from './support/api';
import { expect, test } from './support/fixtures';

// The first of the flows' administrators: the dashboard the run's token makes is theirs.

test('issues per field and the matrix open their issues; age and time in state read the history', async ({ page, api }) => {
  const key = uniqueKey('RM');
  await api.createProject({ key, name: `Reports ${key}`, template: 'software' });
  await api.createIssue({ project: key, summary: 'Checkout fails on Safari', fields: { Priority: 'Critical', Type: 'Bug' } });
  await api.createIssue({ project: key, summary: 'Typo on the pricing page', fields: { Priority: 'Minor', Type: 'Bug' } });
  await api.createIssue({ project: key, summary: 'Export to CSV', fields: { Priority: 'Major', Type: 'Feature' } });
  const done = await api.createIssue({ project: key, summary: 'Slow search on large projects', fields: { Priority: 'Major', Type: 'Bug', State: 'In Progress' } });
  await api.updateIssue(done.id, { fields: { State: 'Fixed' } });

  // Issues per field: by Type, each count opening its issues.
  await page.goto(`/reports/issues-per-field?project=${key}`);
  await page.getByLabel('Field', { exact: true }).selectOption('Type');
  const figures = page.getByRole('group', { name: 'Issues by Type, as figures' });
  await expect(figures.getByRole('row', { name: /^Bug 3$/ })).toBeVisible();
  await figures.getByRole('link', { name: '3', exact: true }).click();
  await expect(page).toHaveURL(/\/issues\?q=/);
  await expect(page.getByRole('list', { name: '3 issues' })).toBeVisible();

  // The matrix: Priority down, Type across, with totals.
  await page.goto(`/reports/matrix?project=${key}&rows=Priority&columns=Type`);
  const matrix = page.getByRole('group', { name: 'Priority by Type, as figures' });
  await expect(matrix.getByRole('row', { name: /^Major 1 1 2$/ })).toBeVisible();
  await expect(matrix.getByRole('row', { name: /^Total 3 1 4$/ })).toBeVisible();
  const csv = await page.getByRole('link', { name: 'Download the figures (CSV)' }).getAttribute('href');
  const body = await (await page.request.get(csv!)).text();
  expect(body).toContain('Priority \\ Type');
  await matrix.getByRole('row', { name: /^Major/ }).getByRole('link', { name: '1', exact: true }).first().click();
  await expect(page.getByRole('list', { name: '1 issues' }).or(page.getByRole('list', { name: '1 issue' }))).toBeVisible();

  // Average age, by Priority as it stood: today's open issues.
  await page.goto(`/reports/average-age?project=${key}&days=7`);
  await page.getByLabel('By', { exact: true }).selectOption('Priority');
  await expect(page.getByRole('group', { name: /^Average age by Priority on / })).toContainText('Critical');
  await expect(page.getByText(/^3 issues open on /)).toBeVisible();

  // Time in state: the fixed issue's time in progress; then by a board's columns.
  const board = await api.createBoard({
    name: `Flow ${key}`,
    projects: [key],
    columns: [
      { name: 'To do', values: ['Open', 'Submitted'] },
      { name: 'Doing', values: ['In Progress'] },
      { name: 'Done', values: ['Fixed', 'Verified'] },
    ],
  });
  await page.goto(`/reports/time-in-state?project=${key}&days=7`);
  await expect(page.getByText(/^1 issue resolved from /)).toBeVisible();
  await expect(page.getByRole('group', { name: 'Days each resolved issue spent in each state' }).getByRole('link', { name: done.id })).toBeVisible();
  await page.getByLabel('Columns of').selectOption(board.id);
  const columns = page.getByRole('group', { name: 'Days in each column, as figures' });
  await expect(columns.getByRole('row')).toHaveCount(4); // the head and three columns
  await expect(columns.getByRole('row', { name: /^To do 0 — — — 3$/ })).toBeVisible(); // nothing resolved waited there; three wait there now

  // All four as widgets on a dashboard.
  const dashboard = await api.post<{ id: string }>('/dashboards', {
    name: `Reports ${key}`,
    widgets: [
      { id: 'field', kind: 'report', params: { report: 'issues-per-field', project: key, field: 'Type' } },
      { id: 'matrix', kind: 'report', params: { report: 'matrix', project: key, rows: 'Priority', columns: 'Type' } },
      { id: 'age', kind: 'report', params: { report: 'average-age', project: key, days: 7 } },
      { id: 'states', kind: 'report', params: { report: 'time-in-state', project: key, days: 7, board: board.id } },
    ],
  });
  await page.goto(`/dashboard/${dashboard.id}`);
  await expect(page.getByLabel('Issues by Type', { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Priority by Type, as figures' })).toBeVisible();
  await expect(page.getByRole('img', { name: /average and median age/ })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Days in each column, as figures' })).toBeVisible();
});
