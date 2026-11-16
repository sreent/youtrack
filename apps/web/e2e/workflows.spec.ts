/**
 * Scripted workflows (docs/architecture.md, D40): a rule written as a script on the Rules page, its
 * syntax error underlined and its test run on an issue, which then acts on a new issue; and a state
 * machine and an action, whose moves and button are on the issue page.
 *
 * Each test has a project of its own, so its rules never act on another spec's issues.
 */
import { fieldValue, uniqueKey } from './support/api';
import { SECOND_AUTH_FILE } from './support/env';
import { expect, test } from './support/fixtures';

// The second of the flows' administrators (support/env.ts says why): scripts are an administrator's.
test.use({ storageState: SECOND_AUTH_FILE });

/** A rule acts after the outbox's settle time, not inside the change. */
const ACTS_WITHIN = { timeout: 30_000 };

test('an administrator writes a rule as a script, sees its syntax error, tests it on an issue, and it acts', async ({ page, api }) => {
  const key = uniqueKey('WS');
  const project = await api.createProject({ key, name: `Scripts ${key}` });
  const sample = await api.createIssue({ project: key, summary: 'Checkout fails', fields: { Type: 'Bug', Priority: 'Critical' } });

  await page.goto(`/rules/${key}`);
  const add = page.getByRole('region', { name: 'Add a rule' });
  await add.getByLabel('Name', { exact: true }).fill('Critical bugs get triaged');
  await add.getByRole('radio', { name: /a script, in JavaScript/ }).check();
  const script = add.getByRole('textbox', { name: 'Then run this script' });
  await script.fill("if (issue.fields.Priority === 'Critical') {\n  apply('tag triaged';\n}\n");
  // The field underlines the line, and says what's wrong beneath.
  await expect(add.getByText(/\(line 2\)/)).toBeVisible();
  await expect(add.getByRole('button', { name: 'Save the rule' })).toBeDisabled();
  await script.fill("if (issue.fields.Priority === 'Critical') {\n  log('triaging', issue.id);\n  apply('tag triaged');\n}\n");
  await expect(add.getByText(/\(line 2\)/)).toBeHidden();

  // A test run on an issue as it is now: what it logs and would change, and nothing is saved.
  await add.getByLabel('Test it on an issue').fill(sample.id);
  await add.getByRole('button', { name: 'Run it' }).click();
  const run = add.getByRole('group', { name: `What it would do to ${sample.id}` });
  await expect(run).toContainText(`triaging ${sample.id}`);
  await expect(run).toContainText('tag triaged');
  await expect(run).toContainText('Nothing was saved.');
  expect((await api.issue(sample.id)).tags).toEqual([]);

  await add.getByRole('button', { name: 'Save the rule' }).click();
  const rules = page.getByRole('region', { name: `Rules in ${project.name}` });
  await expect(rules.getByText('“Critical bugs get triaged” is saved. It acts from the next change.')).toBeVisible();
  await expect(rules).toContainText('When an issue is created, then run its script.');

  const bug = await api.createIssue({ project: key, summary: 'Payments time out', fields: { Type: 'Bug', Priority: 'Critical' } });
  await expect.poll(async () => (await api.issue(bug.id)).tags.map((t) => t.name), ACTS_WITHIN).toEqual(['triaged']);
  const runs = page.getByRole('region', { name: 'Table of what rules did' });
  await page.reload();
  await expect(runs.getByRole('row').filter({ hasText: bug.id })).toContainText(`Logged: triaging ${bug.id}`);
});

test('a state machine offers its moves on the issue page, one waiting on its condition; an action runs from its button', async ({ page, api }) => {
  const key = uniqueKey('WM');
  const project = await api.createProject({ key, name: `Moves ${key}` });
  await api.post('/state-machines', {
    project: key,
    field: 'State',
    transitions: [
      { name: 'Start work', from: ['Submitted', 'Open'], to: 'In Progress', command: 'tag started' },
      { name: 'Send to review', from: ['In Progress'], to: 'In Review', condition: 'has: Assignee' },
      { name: 'Approve', from: ['In Review'], to: 'Fixed' },
    ],
  });
  const issue = await api.createIssue({ project: key, summary: 'Rotate the keys', fields: { State: 'Open' } });

  // An action, made on the Rules page.
  await page.goto(`/rules/${key}`);
  const actions = page.getByRole('region', { name: `Actions in ${project.name}` });
  await actions.getByRole('button', { name: 'Add an action' }).click();
  await actions.getByLabel('Name', { exact: true }).fill('Flag it');
  await actions.getByLabel('What it does, in the command language').fill('tag flagged');
  await actions.getByRole('button', { name: 'Save the action' }).click();
  await expect(actions.getByText('“Flag it” is saved: its button is on the issues it’s offered for.')).toBeVisible();
  await expect(page.getByRole('region', { name: `State machines in ${project.name}` })).toContainText('Start work: Submitted, Open → In Progress');

  await page.goto(`/issues/${issue.id}`);
  const bar = page.getByRole('group', { name: 'Move it on' });
  await bar.getByRole('button', { name: /^Start work/ }).click();
  await expect(bar.getByRole('button', { name: /^Send to review/ })).toBeDisabled();
  await expect(bar).toContainText('Send to review: It needs the issue to match “has: Assignee”');
  await expect.poll(async () => fieldValue(await api.issue(issue.id), 'State')).toBe('In Progress');
  expect((await api.issue(issue.id)).tags.map((t) => t.name)).toEqual(['started']);

  await bar.getByRole('button', { name: 'Flag it' }).click();
  await expect(page.getByText('“Flag it” is done.')).toBeVisible();
  await expect.poll(async () => (await api.issue(issue.id)).tags.map((t) => t.name).sort()).toEqual(['flagged', 'started']);
});
