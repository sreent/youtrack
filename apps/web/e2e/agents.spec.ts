/**
 * Agents acting as themselves (docs/architecture.md, D34). An administrator adds an agent and issues
 * it a token on the Agents page; with it, the agent changes an issue as itself; a person undoes that
 * from the issue's history; and the agent is given the issue and finds it as its own. A change that
 * someone changed since can't be undone, and says why.
 */
import type { IssueList, TrackerEvent } from '@a4a/shared';
import { Api, fieldValue, unique, uniqueKey } from './support/api';
import { ADMIN } from './support/env';
import { expect, holdLiveEvents, test } from './support/fixtures';

test('an administrator adds an agent and issues it a token; it works as itself, and a person undoes what it did', async ({ page, api }) => {
  const login = `bot-${unique()}`;
  await page.goto('/agents');
  const section = page.getByRole('region', { name: 'Agents of their own' });
  await section.getByLabel('Add an agent').fill(login);
  await section.getByRole('button', { name: 'Add it' }).click();
  await expect(section.getByText(`${login} is added.`, { exact: false })).toBeVisible();

  // A new agent's card opens its token form at once.
  const card = section.getByRole('listitem').filter({ hasText: login });
  const form = card.getByRole('form', { name: `A token for ${login}` });
  await form.getByLabel('Its name').fill('ci');
  await form.getByRole('button', { name: `Issue a token to ${login}` }).click();
  const secret = card.getByRole('status').filter({ hasText: 'Copy it now.' });
  const token = (await secret.getByRole('code').first().textContent())!;
  expect(token).toMatch(/^a4a_/);
  await expect(card.getByRole('region', { name: `Tokens of ${login}` }).getByRole('row').filter({ hasText: 'ci' })).toContainText('write');

  // With it, the agent acts as itself.
  const agent = await Api.withToken(token);
  expect(await agent.get('/me')).toMatchObject({ login, isBot: true });
  const key = uniqueKey('AG');
  await api.createProject({ key, name: `Agents ${key}` });
  const issue = await api.createIssue({ project: key, summary: 'Flaky upload test', fields: { Type: 'Bug' } });
  await agent.updateIssue(issue.id, { fields: { Priority: 'Critical' } });

  // Its change shows as its own, for no one, and a person undoes it.
  await page.goto(`/issues/${issue.id}`);
  const history = page.getByRole('region', { name: 'History and comments' });
  const change = history.getByRole('listitem').filter({ hasText: `${login} · via the API` });
  await expect(change).toContainText('Critical');
  await change.getByRole('button', { name: `Undo ${login}’s change` }).click();
  await expect(change.getByRole('status')).toHaveText('Undone: Priority as before.');
  await expect(change.getByText('undone', { exact: true })).toBeVisible();
  await expect(change.getByRole('button', { name: `Undo ${login}’s change` })).toHaveCount(0);
  await expect(history.getByRole('listitem').filter({ hasText: `${ADMIN.name} undid ${login}’s change` })).toContainText('Priority');
  const fields = page.getByRole('complementary', { name: `Fields of ${issue.id}` });
  await expect(fields.getByRole('button', { name: 'Priority Normal' })).toBeVisible();
  expect(fieldValue(await api.issue(issue.id), 'Priority')).toBe('Normal');

  // The agent can be given the issue, a4a's own agents can't, and it finds the issue as its own.
  await fields.getByRole('button', { name: /^Assignee / }).click();
  const choices = fields.getByRole('listbox', { name: 'Assignee' });
  await expect(choices.getByRole('option', { name: 'triage', exact: true })).toHaveCount(0);
  await choices.getByRole('option', { name: login }).click();
  await expect(fields.getByRole('button', { name: `Assignee ${login}` })).toBeVisible();
  const mine = await agent.get<IssueList>(`/issues?query=${encodeURIComponent('for: me #Unresolved')}`);
  expect(mine.items.map((i) => i.id)).toContain(issue.id);
  await agent.dispose();
});

test('an agent’s change that someone changed meanwhile isn’t undone, and the page says why', async ({ page, api, watch }) => {
  const { agent: bot, token } = await api.createAgent(`bot-${unique()}`);
  const agent = await Api.withToken(token);
  const key = uniqueKey('AU');
  await api.createProject({ key, name: `Undo ${key}` });
  const issue = await api.createIssue({ project: key, summary: 'Search times out', fields: { Type: 'Bug' } });
  await agent.updateIssue(issue.id, { fields: { State: 'In Progress' } });

  await holdLiveEvents(page);
  await page.goto(`/issues/${issue.id}`);
  const change = page.getByRole('region', { name: 'History and comments' }).getByRole('listitem').filter({ hasText: `${bot.login} · via the API` });
  const undo = change.getByRole('button', { name: `Undo ${bot.login}’s change` });
  await expect(undo).toBeVisible();

  // Behind the page's back, someone moves it on.
  await api.updateIssue(issue.id, { fields: { State: 'Fixed' } });
  watch.allow(/status of 409/);
  await undo.click();
  await expect(change.getByText(`Nothing was undone: State is Fixed now: ${ADMIN.name} changed it since`)).toBeVisible();
  await expect(undo).toHaveCount(0);
  expect(fieldValue(await api.issue(issue.id), 'State')).toBe('Fixed');

  // Its history says so too, without being asked.
  const events = await api.get<TrackerEvent[]>(`/issues/${issue.id}/activity`);
  expect(events.find((e) => e.actor.login === bot.login)?.undo).toEqual({
    state: 'changed_since',
    // Anyone who may change the issue undoes an agent's change; a view edit's undo is its author's alone (D34's revisit).
    by: 'anyone',
    note: `State is Fixed now: ${ADMIN.name} changed it since`,
    // Its words, so a page in another language says it in its own (D49).
    noteWords: [{ key: 'agents.stop.fieldChanged', values: { field: 'State', hasValue: 'yes', value: 'Fixed', hasBy: 'yes', by: ADMIN.name } }],
  });
  await agent.dispose();
});
