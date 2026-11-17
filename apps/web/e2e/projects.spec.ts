/** Projects: one is created from the waterfall template, and its details, triage rung and plan settings saved. */
import type { Project, ProjectField } from '@a4a/shared';
import { uniqueKey } from './support/api';
import { SECOND_AUTH_FILE } from './support/env';
import { expect, test } from './support/fixtures';

// The second of the flows' administrators (support/env.ts says why).
test.use({ storageState: SECOND_AUTH_FILE });

test('a project is created, and its settings are saved', async ({ page, api }) => {
  const key = uniqueKey('PR');
  const name = `Rollout ${key}`;
  await page.goto('/projects');
  const create = page.getByRole('region', { name: 'Create a project' });
  await create.getByLabel('Key').fill(key.toLowerCase());
  await create.getByLabel('Name').fill(name);
  await create.getByLabel('Lead', { exact: true }).selectOption({ label: 'Chloé Martin' });
  await expect(create.getByRole('radio', { name: /^Open/ })).toBeChecked();
  await create.getByRole('radio', { name: /^Waterfall/ }).check();
  await create.getByRole('button', { name: 'Create the project' }).click();

  await expect(page).toHaveURL(new RegExp(`/projects/${key}$`));
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  const fields = (await api.get<ProjectField[]>(`/projects/${key}/fields`)).map((f) => f.name);
  expect(fields).toEqual(expect.arrayContaining(['Start date', 'Fixed cost', 'Estimation']));
  expect(fields).not.toContain('Fix versions');

  // Its details.
  const details = page.getByRole('region', { name: 'Details' });
  await details.getByLabel("What it's for").fill('Move the payment service to the new region.');
  await details.getByRole('button', { name: 'Save the details' }).click();
  await expect(details.getByRole('status')).toHaveText('The details are saved.');

  // How far triage may go: choosing a rung saves it, and it's chosen once the server has it.
  const triage = page.getByRole('region', { name: 'AI triage' });
  await triage.getByRole('radio', { name: /^auto\b.*Acts/ }).click();
  await expect(triage.getByRole('status')).toHaveText('Triage now fills empty fields on its own, and says so in each issue’s history.');
  await expect(triage.getByRole('radio', { name: /^auto\b.*Acts/ })).toBeChecked();

  // Its plan's calendar and budget.
  const plan = page.getByRole('region', { name: 'Plan settings' });
  await plan.getByLabel('Starts').fill('2027-01-04');
  await plan.getByLabel('Hours in a working day').fill('7.5');
  await plan.getByLabel('Budget').fill('25000');
  await plan.getByRole('checkbox', { name: 'Saturday' }).check();
  await plan.getByLabel('A day off to add').fill('2027-01-06');
  await plan.getByRole('button', { name: 'Add the day' }).click();
  await expect(plan.getByRole('button', { name: 'Remove 6 Jan 2027' })).toBeVisible();
  await plan.getByRole('button', { name: 'Save the plan settings' }).click();
  await expect(plan.getByRole('status')).toHaveText('The plan settings are saved. The plan uses them from now on.');

  const saved = await api.get<Project>(`/projects/${key}`);
  expect(saved.description).toBe('Move the payment service to the new region.');
  expect(saved.lead?.login).toBe('chloe');
  expect(saved.settings.triageMode).toBe('auto');
  expect(saved.settings.plan).toEqual({ startDate: '2027-01-04', workingDays: [1, 2, 3, 4, 5, 6], hoursPerDay: 7.5, holidays: ['2027-01-06'], budget: 25000, currency: 'USD' });

  // And the page reads them back so.
  await page.reload();
  await expect(plan.getByLabel('Hours in a working day')).toHaveValue('7.5');
  await expect(plan.getByRole('checkbox', { name: 'Saturday' })).toBeChecked();
  await expect(plan.getByRole('button', { name: 'Remove 6 Jan 2027' })).toBeVisible();
  await expect(triage.getByRole('radio', { name: /^auto\b.*Acts/ })).toBeChecked();
});
