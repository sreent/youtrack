/**
 * Moving and cloning an issue, reacting to it, and its vote (D41): what doesn't carry over is asked
 * for before anything moves, the old id's address goes to the new one, and a clone links back.
 */
import { unique } from './support/api';
import { expect, test } from './support/fixtures';

// The first of the flows' administrators, who has fewer tests (support/env.ts says why there are two).

test('an issue is reacted to, moved with what does not carry over chosen, and cloned', async ({ page, api }) => {
  const summary = `Belongs on the web ${unique()}`;
  const issue = await api.createIssue({ project: 'BACK', summary, description: 'The sign-in page.', fields: { Subsystem: 'API' } });
  await page.goto(`/issues/${issue.id}`);
  await expect(page.getByRole('heading', { name: summary })).toBeVisible();

  // Its reporter's vote is counted already.
  await expect(page.getByRole('button', { name: /^Vote/ })).toBeDisabled();

  // A reaction to the description toggles.
  const description = page.getByRole('region', { name: 'Description' });
  await description.getByRole('button', { name: 'React', exact: true }).click();
  await description.getByRole('group', { name: 'Choose a reaction' }).getByRole('button', { name: '🎉' }).click();
  const party = description.getByRole('button', { name: /🎉 1 reaction, yours among them/ });
  await expect(party).toHaveAttribute('aria-pressed', 'true');
  await party.click();
  await expect(description.getByRole('button', { name: /🎉/ })).toHaveCount(0);

  // Moving: the value WEB doesn't have is asked for first.
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  const move = page.getByRole('region', { name: `Move ${issue.id}` });
  await move.getByLabel('Project').selectOption('WEB');
  const problem = move.getByLabel('Subsystem "API" isn\'t a value in WEB');
  await expect(problem).toBeVisible();
  await expect(move.getByRole('button', { name: 'Move', exact: true })).toBeDisabled();
  await problem.selectOption('-');
  await expect(move.getByRole('button', { name: 'Move', exact: true })).toBeEnabled();
  await move.getByRole('button', { name: 'Move', exact: true }).click();

  await expect(page).toHaveURL(/\/issues\/WEB-\d+$/);
  const now = page.url().split('/').pop()!;
  await expect(page.getByText(`was ${issue.id}`)).toBeVisible();
  expect((await api.issue(issue.id)).id).toBe(now);

  // Its old address goes to the new one.
  await page.goto(`/issues/${issue.id}`);
  await expect(page).toHaveURL(new RegExp(`/issues/${now}$`));
  await expect(page.getByRole('heading', { name: summary })).toBeVisible();

  // A clone is a new issue, linked back.
  await page.getByRole('button', { name: 'Clone' }).click();
  await expect(page).not.toHaveURL(new RegExp(`/issues/${now}$`));
  await expect(page.getByRole('heading', { name: summary })).toBeVisible();
  await expect(page.getByText(`clones`).first()).toBeVisible();
  const copy = await api.issue(page.url().split('/').pop()!);
  expect(copy.links.map((l) => `${l.phrase} ${l.issue.id}`)).toContain(`clones ${now}`);
});
