/**
 * Agile and time tracking (D43): a sprint planned from a board's backlog, ranked from the keyboard
 * and by dragging, issues moved into the sprint, its load against capacity and the velocity chart;
 * then a timer on an issue, work logged with a work type, corrected in the weekly timesheet, and a
 * working week of one's own that the timesheet measures each day against.
 *
 * Each test has a project of its own.
 */
import type { Board, Field, Sprint } from '@a4a/shared';
import { unique, uniqueKey, type Api } from './support/api';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { SECOND, SECOND_AUTH_FILE } from './support/env';
import { expect, test } from './support/fixtures';

// The second of the flows' administrators (support/env.ts says why).
test.use({ storageState: SECOND_AUTH_FILE });

const today = () => new Date().toLocaleDateString('en-CA');
/** Today's cell of a row, by its label: "BACK-1, Development, Mon 16 Nov" in the page's own words. */
const todayIn = (row: string) => new RegExp(`^${row}, \\w+,? (${Number(today().slice(8))} \\w+|\\w+ ${Number(today().slice(8))})$`);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function pointsField(api: Api, key: string): Promise<Field> {
  const field = await api.post<Field>('/fields', { name: `Points ${unique()}`, type: 'integer', multi: false, description: '', values: [] });
  const res = await api.context.put(`/api/v1/projects/${key}/fields/${field.id}`, { data: {} });
  expect(res.ok(), await res.text()).toBe(true);
  return field;
}

test('plans a sprint from the backlog: ranks, moves into the sprint, and weighs its load', async ({ page, api }) => {
  const key = uniqueKey('AG');
  await api.createProject({ key, name: `Agile ${key}` });
  const points = await pointsField(api, key);
  const board = await api.post<Board>('/boards', { name: `Plan ${key}`, projects: [key], sprintsEnabled: true, pointsField: points.name });
  const sprint = await api.post<Sprint>(`/boards/${board.id}/sprints`, { name: 'Sprint A', startDate: today(), endDate: addDays(today(), 13) });
  const made = [];
  for (const [summary, pts] of [['Rotate the keys', 5], ['Paginate the log', 3], ['Retry webhooks', 2]] as const) {
    made.push(await api.createIssue({ project: key, summary, fields: { [points.name]: String(pts), Estimation: '1d', Assignee: SECOND.login } }));
  }
  const [keys, log, retry] = [made[0]!, made[1]!, made[2]!];

  await page.goto(`/boards/${board.id}/plan`);
  const backlog = page.getByRole('list', { name: 'Backlog, in rank order' });
  await expect(backlog.getByRole('listitem')).toHaveCount(3);
  await expect(page.getByText('3 issues, 10 pts')).toBeVisible();
  const order = () => backlog.getByRole('listitem').evaluateAll((items) => items.map((li) => li.getAttribute('data-issue')));
  const before = await order();

  // From the keyboard: Alt and an arrow moves the last one up a place, and says so.
  const last = before[2]!;
  await page.getByRole('button', { name: `Move ${last}` }).press('Alt+ArrowUp');
  await expect.poll(order).toEqual([before[0], last, before[1]]);
  await expect(page.getByRole('status').filter({ hasText: `Moved ${last} above ${before[1]}.` })).toBeAttached();

  // Dragging one onto the sprint puts it there; the button does too.
  await backlog.locator(`li[data-issue="${keys.id}"]`).dragTo(page.getByRole('list', { name: 'Sprints to drop an issue on' }).getByRole('listitem').filter({ hasText: 'Sprint A' }));
  await expect(backlog.locator(`li[data-issue="${keys.id}"]`)).toHaveCount(0);
  await backlog.locator(`li[data-issue="${log.id}"]`).getByRole('button', { name: 'To Sprint A' }).click();
  await expect(backlog.getByRole('listitem')).toHaveCount(1);
  await expect(backlog.locator(`li[data-issue="${retry.id}"]`)).toBeVisible();

  // The sprint's load against what its person can work, and the velocity so far.
  const load = page.getByRole('region', { name: 'Sprint A: load against capacity' });
  await expect(load.getByRole('row', { name: new RegExp(SECOND.name) })).toContainText('16h');
  await expect(page.getByRole('heading', { name: 'Velocity' })).toBeVisible();
  // It began today and everything joined it since, so nothing was committed yet: said in words, not drawn.
  await expect(page.getByText('Nothing was committed to or done in Sprint A yet, in points.')).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectAccessible(page);

  // The board itself says the sprint's points, and the column's.
  await page.goto(`/boards/${board.id}?sprint=${sprint.id}`);
  await expect(page.getByText(/Sprint A holds 8 story points\./)).toBeVisible();
});

test('times work, logs it as a work type, and corrects it in the weekly timesheet', async ({ page, api }) => {
  const key = uniqueKey('TT');
  await api.createProject({ key, name: `Time ${key}` });
  await api.post(`/projects/${key}/work-types`, { name: 'Development' });
  const issue = await api.createIssue({ project: key, summary: 'Write the migration' });

  await page.goto(`/issues/${issue.id}`);
  const timer = page.getByRole('group', { name: 'Your timer' });
  await timer.getByRole('button', { name: 'Start timer' }).click();
  await expect(timer).toContainText('Running');
  await timer.getByRole('button', { name: 'Pause' }).click();
  await expect(timer).toContainText('Paused');
  await timer.getByRole('button', { name: 'Discard' }).click();
  await expect(timer).toContainText('Time it as you work');

  const form = page.getByRole('form', { name: 'Log time' });
  await form.getByLabel('Time spent').fill('1h');
  await form.getByLabel('Work type').selectOption('Development');
  await form.getByRole('button', { name: 'Log time' }).click();
  await expect(page.getByRole('cell', { name: 'Development', exact: true })).toBeVisible();

  await page.goto('/timesheet');
  const week = page.getByRole('region', { name: 'Your week' });
  const cell = week.getByRole('textbox', { name: todayIn(`${issue.id}, Development`) });
  await expect(cell).toHaveValue('1h');
  await cell.fill('1h 30m');
  await cell.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: `Saved 1h 30m on ${issue.id}` })).toBeAttached();
  await page.reload();
  await expect(cell).toHaveValue('1h 30m');
  await expectNoSidewaysScroll(page);
  await expectAccessible(page);

  // A working week of one's own: Wednesday off, which the timesheet then says.
  await page.goto('/me');
  await page.getByLabel('Hours on Wednesday').fill('0');
  await page.getByRole('button', { name: 'Save my week' }).click();
  await expect(page.getByText('Saved. Plans and your timesheet use it.')).toBeVisible();
  await page.goto('/timesheet');
  await expect(page.getByRole('columnheader', { name: /^Wed .*Off$/ })).toBeVisible();
  await api.patch(`/users/${SECOND.login}`, { workWeek: null });
});
