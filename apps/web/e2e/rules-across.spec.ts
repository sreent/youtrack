/**
 * Rules across issues (docs/architecture.md, D32): a rule made on the Rules page from its example
 * fixes a parent once all its subtasks are resolved, and a rule tells the people it names, which
 * the issue's history and the run log both say.
 *
 * Each test has a project of its own, so its rules never act on another spec's issues.
 */
import type { Page } from '@playwright/test';
import type { IssueDetail } from '@a4a/shared';
import { fieldValue, unique, uniqueKey, type Api } from './support/api';
import { SECOND_AUTH_FILE } from './support/env';
import { expect, test } from './support/fixtures';

// The second of the flows' administrators (support/env.ts says why).
test.use({ storageState: SECOND_AUTH_FILE });

/** A rule acts after the outbox's settle time, not inside the change. */
const ACTS_WITHIN = { timeout: 30_000 };

function ruleCard(page: Page, name: string) {
  return page.getByRole('listitem').filter({ has: page.getByRole('heading', { name, exact: true }) });
}

async function subtaskOf(api: Api, key: string, parent: IssueDetail, summary: string): Promise<IssueDetail> {
  const kid = await api.createIssue({ project: key, summary, fields: { Type: 'Task' } });
  await api.post(`/issues/${kid.id}/links`, { relation: 'subtask of', issue: parent.id });
  return kid;
}

test('a rule from its example fixes a parent once all its subtasks are resolved', async ({ page, api }) => {
  const key = uniqueKey('RX');
  const project = await api.createProject({ key, name: `Families ${key}` });
  const parent = await api.createIssue({ project: key, summary: 'Ship the export', fields: { Type: 'Feature' } });
  const first = await subtaskOf(api, key, parent, 'Write the exporter');
  const second = await subtaskOf(api, key, parent, 'Document the export');

  await page.goto(`/rules/${key}`);
  const add = page.getByRole('region', { name: 'Add a rule' });
  await add.getByRole('button', { name: 'Done subtasks fix their parent' }).click();
  await expect(add.getByLabel('Name', { exact: true })).toHaveValue('Done subtasks fix their parent');
  await expect(add.getByRole('combobox', { name: 'And what its related issues match' })).toHaveValue('siblings-all');
  await expect(add.getByRole('combobox', { name: 'Which issues it acts on' })).toHaveValue('parent');
  // The dry run: no subtask is resolved yet, so nothing matches.
  await expect(add.getByRole('group', { name: 'What it would do' })).toContainText('0 issues match it now.');
  await add.getByRole('button', { name: 'Save the rule' }).click();

  const rules = page.getByRole('region', { name: `Rules in ${project.name}` });
  await expect(rules.getByText('“Done subtasks fix their parent” is saved. It acts from the next change.')).toBeVisible();
  const card = ruleCard(page, 'Done subtasks fix their parent');
  await expect(card).toContainText(
    "When an issue's State changes, if it matches #Resolved and all of its parent's subtasks match #Resolved, then apply State Fixed to its parent.",
  );

  // One subtask resolved: the parent stays as it is. Both: the rule fixes it.
  await api.updateIssue(first.id, { fields: { State: 'Fixed' } });
  await api.updateIssue(second.id, { fields: { State: 'Fixed' } });
  await expect.poll(async () => fieldValue(await api.issue(parent.id), 'State'), ACTS_WITHIN).toBe('Fixed');

  await page.goto(`/issues/${parent.id}`);
  await expect(page.getByText('applied the rule “Done subtasks fix their parent”')).toBeVisible();

  // The run log names the parent, set off by a subtask.
  await page.goto(`/rules/${key}`);
  const runs = page.getByRole('region', { name: 'Table of what rules did' });
  await expect(runs.getByRole('row').filter({ hasText: parent.id })).toContainText('applied');
});

test('a rule tells the people it names, and the issue says so', async ({ page, api }) => {
  const key = uniqueKey('RT');
  await api.createProject({ key, name: `News ${key}` });
  const login = `oncall-${unique()}`;
  await api.createUser({ login, name: 'Olu On-call', password: 'correct-horse-battery' });

  await page.goto(`/rules/${key}`);
  const add = page.getByRole('region', { name: 'Add a rule' });
  await add.getByLabel('Name', { exact: true }).fill('Critical bugs are news');
  await add.getByRole('combobox', { name: 'If it matches this query' }).fill('Priority: Critical');
  const tell = add.getByRole('group', { name: 'And tell' });
  await tell.getByRole('checkbox', { name: 'Its assignee' }).check();
  await add.getByLabel('And these people, by login').fill(login);
  await add.getByLabel('Telling them').fill('A critical bug came in: please look at it now.');
  await expect(add.getByRole('group', { name: 'What it would do' })).toBeVisible();
  await add.getByRole('button', { name: 'Save the rule' }).click();

  const card = ruleCard(page, 'Critical bugs are news');
  await expect(card).toContainText(`When an issue is created, if it matches Priority: Critical, then tell its assignee and @${login} “A critical bug came in: please look at it now.”`);
  await expect(card.getByText('tells people', { exact: true })).toBeVisible();

  // Made through the API as the administrator, who set it off and so isn't told.
  const issue = await api.createIssue({ project: key, summary: 'Payments fail', fields: { Type: 'Bug', Priority: 'Critical' } });
  await expect
    .poll(async () => {
      const history = await api.get<{ type: string; data: { people?: string[] } }[]>(`/issues/${issue.id}/activity`);
      return history.find((e) => e.type === 'rule.notified')?.data.people ?? [];
    }, ACTS_WITHIN)
    .toEqual([login]);

  await page.goto(`/issues/${issue.id}`);
  await expect(page.getByText(`applied the rule “Critical bugs are news”, and told @${login}`)).toBeVisible();
  await expect(page.getByText('“A critical bug came in: please look at it now.”')).toBeVisible();
});
