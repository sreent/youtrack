/**
 * Days away (D36): a project's manager enters days away for someone on the plan, and their work
 * waits for them, in the grid and the schedule; the grid's days are the manager's own choice, kept
 * for them; a person keeps their own days away on their profile; and a long board with lanes keeps
 * its column heads in view.
 *
 * Each test has people and a project of its own: days away and the grid's window are a person's,
 * and the demo's people are planned by other specs.
 */
import type { Page } from '@playwright/test';
import type { Absence, Preferences, Schedule } from '@a4a/shared';
import { unique, uniqueKey, type Api } from './support/api';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { SECOND_AUTH_FILE } from './support/env';
import { expect, test } from './support/fixtures';

// The second of the flows' administrators (support/env.ts says why).
test.use({ storageState: SECOND_AUTH_FILE });

const PASSWORD = 'e2e-away-pass-1';

/** Today, as the server (on this machine) reads it. */
const today = () => new Date().toLocaleDateString('en-CA');
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** The Monday two weeks on at least, and the days of its week. */
function weekAhead() {
  const t = today();
  const wd = new Date(`${t}T00:00:00Z`).getUTCDay();
  const mon = addDays(t, 14 + ((8 - wd) % 7));
  return { mon, tue: addDays(mon, 1), wed: addDays(mon, 2), thu: addDays(mon, 3), fri: addDays(mon, 4) };
}

async function person(api: Api, name: string) {
  const login = `${name.split(' ')[0]!.toLowerCase()}.${unique()}`;
  await api.createUser({ login, name, password: PASSWORD, role: 'member' });
  return { login, name };
}

async function signIn(page: Page, login: string) {
  await page.goto('/login');
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/issues$/);
}

test.describe('signed in as people of its own', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a manager enters days away for someone on the plan, and their work waits for them", async ({ page, api }) => {
    const key = uniqueKey('AW');
    const pat = await person(api, 'Pat Planner');
    const sam = await person(api, 'Sam Sato');
    await api.createProject({ key, name: `Racks ${key}`, template: 'waterfall', lead: pat.login });
    const week = weekAhead();
    const task = await api.createIssue({ project: key, summary: 'Wire the new racks', fields: { Type: 'Task', Assignee: sam.login, Estimation: '3d', 'Start date': week.mon } });
    const finish = async () => (await api.get<Schedule>(`/projects/${key}/schedule`)).tasks.find((t) => t.issue.id === task.id)!.finish;
    expect(await finish()).toBe(week.wed);

    await signIn(page, pat.login);
    await page.goto(`/plan/${key}/resources`);
    const grid = page.getByRole('region', { name: "Who's booked, and how much" });
    // The grid's days: that week, between two dates.
    const between = grid.getByRole('form', { name: 'Or the days between two dates' });
    await between.getByLabel('From').fill(week.mon);
    await between.getByLabel('to', { exact: true }).fill(week.fri);
    await between.getByRole('button', { name: 'Show these days' }).click();
    const row = grid.getByRole('row').filter({ hasText: sam.name });
    await expect(row.locator('td')).toHaveText(['8h', '8h', '8h', '0h', '0h']);

    await grid.getByRole('button', { name: 'Days away' }).click();
    const dialog = page.getByRole('dialog', { name: 'Days away' });
    const form = dialog.getByRole('form', { name: `Add days away for ${sam.name}` });
    await form.getByLabel('From').fill(week.tue);
    await expect(form.getByLabel('To', { exact: true })).toHaveValue(week.tue);
    await form.getByLabel('Why').selectOption('training');
    await form.getByRole('button', { name: 'Add the days away' }).click();
    await expect(dialog.getByRole('status')).toHaveText(new RegExp(`^Added: ${sam.name} is away Tue [^,]+, so plans skip it for ${sam.name}’s work\\.$`));
    await expect(dialog.getByRole('row').filter({ hasText: 'Training' })).toBeVisible();
    // Half of Thursday too: the afternoon.
    await form.getByLabel('From').fill(week.thu);
    await form.getByRole('radio', { name: 'The afternoon' }).check();
    await form.getByRole('button', { name: 'Add the days away' }).click();
    await expect(dialog.getByRole('row')).toHaveCount(3);
    await expectAccessible(page);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();

    // Tuesday is away; the work runs Monday, Wednesday, Thursday morning and Friday.
    await expect(row.locator('td').nth(1)).toHaveText('away');
    await expect(row.locator('td').nth(3)).toContainText('of 4h');
    await expect(row.locator('td').nth(3)).toContainText('away in the afternoon');
    await expect(row.locator('td.part')).toHaveCount(1);
    expect(await finish()).toBe(week.fri);
    // Anyone may see when; why is Sam's, Pat's who entered it, and the administrators'.
    const seen = await api.get<Absence[]>(`/absences?user=${sam.login}`);
    expect(seen.map((a) => [a.from, a.half, a.createdBy?.login])).toEqual([
      [week.tue, null, pat.login],
      [week.thu, 'afternoon', pat.login],
    ]);

    // The grid's days are Pat's choice, kept for them: on another visit they're the same.
    await page.reload();
    await expect(grid.getByRole('form', { name: 'Or the days between two dates' }).getByLabel('From')).toHaveValue(week.mon);
    await expect(row.locator('td')).toHaveCount(5);
    await grid.getByRole('button', { name: 'Two weeks' }).click();
    await expect(grid.getByRole('button', { name: 'Two weeks' })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await (await page.request.get('/api/v1/me/preferences')).json()) as Preferences).toEqual({ loadWindow: { preset: '2w' } });
    await expectNoSidewaysScroll(page);
  });

  test('a person keeps their own days away on their profile', async ({ page, api }) => {
    const kit = await person(api, 'Kit Morgan');
    const week = weekAhead();
    await signIn(page, kit.login);
    await page.goto('/me');
    const away = page.getByRole('region', { name: 'Days away', exact: true });
    await expect(away.getByText('You have no days away entered, from a month ago on.')).toBeVisible();

    const form = away.getByRole('form', { name: 'Add days away' });
    await form.getByLabel('From').fill(week.mon);
    await form.getByLabel('To', { exact: true }).fill(week.wed);
    await expect(form.getByRole('group', { name: 'How much of the day' })).toBeHidden();
    await form.getByLabel('A note, if you want one').fill('Lisbon');
    await form.getByRole('button', { name: 'Add the days away' }).click();
    await expect(away.getByRole('status')).toHaveText(/^Added: you’re away [^,]+–[^,]+, so plans skip those days for your work\.$/);
    const row = away.getByRole('row').filter({ hasText: 'Lisbon' });
    await expect(row).toContainText('Holiday');

    await row.getByRole('button', { name: /^Change / }).click();
    const change = away.getByRole('form', { name: /^Change / });
    await change.getByLabel('To', { exact: true }).fill(week.thu);
    await change.getByRole('button', { name: 'Save the change' }).click();
    await expect(away.getByRole('status')).toHaveText(/^Changed: you’re away [^,]+–[^,]+, so plans skip/);
    expect((await api.get<Absence[]>(`/absences?user=${kit.login}`)).map((a) => [a.from, a.to])).toEqual([[week.mon, week.thu]]);

    await away.getByRole('row').filter({ hasText: 'Lisbon' }).getByRole('button', { name: /^Remove / }).click();
    await page.getByRole('dialog', { name: /^Remove / }).getByRole('button', { name: 'Remove it' }).click();
    await expect(away.getByText('You have no days away entered, from a month ago on.')).toBeVisible();
    await expectAccessible(page);
  });
});

test('a long board with lanes keeps its column heads in view as it scrolls', async ({ page, api }) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  const key = uniqueKey('LN');
  await api.createProject({ key, name: `Lanes ${key}` });
  for (const priority of ['Critical', 'Major', 'Normal']) {
    for (let i = 1; i <= 4; i++) await api.createIssue({ project: key, summary: `${priority} work ${i}`, fields: { Type: 'Task', Priority: priority } });
  }
  const board = await api.post<{ id: string }>('/boards', {
    name: `Lanes ${key}`,
    projects: [key],
    columns: [
      { name: 'Open', values: ['Open'] },
      { name: 'In Progress', values: ['In Progress'] },
      { name: 'Done', values: ['Fixed'] },
    ],
    swimlaneField: 'Priority',
  });
  await page.goto(`/boards/${board.id}`);
  const frame = page.getByRole('group', { name: `Lanes ${key}'s columns` });
  await expect(frame.getByRole('heading', { name: 'Normal' })).toBeAttached();
  const head = frame.getByRole('heading', { name: 'In Progress', level: 3 });
  // The frame at the window's top, as someone scrolling down to the board would have it.
  await frame.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  const before = (await head.boundingBox())!;
  // The board scrolls in its own frame, which is taller than the window allows: down to its last lane.
  expect(await frame.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect(frame.getByRole('heading', { name: /^Critical/ })).toBeInViewport();
  await frame.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  // The first lane has gone up out of view; the column heads haven't.
  await expect(frame.getByRole('heading', { name: /^Critical/ })).not.toBeInViewport();
  const after = (await head.boundingBox())!;
  const top = (await frame.boundingBox())!.y;
  expect(after.y).toBeGreaterThanOrEqual(top);
  expect(after.y).toBeLessThan(top + 40);
  expect(before.y).toBeGreaterThanOrEqual(top);
  await expect(head).toBeInViewport();
});
