/**
 * An issue's page: a field changed from the keyboard, a link added and taken away, a comment and
 * time logged, triage's values accepted one at a time, the summary edited, a summary by the
 * assistant, and what happens when someone else changed the issue first (409). Each test has an
 * issue of its own, in this file's project.
 */
import type { Page } from '@playwright/test';
import type { IssueDetail } from '@a4a/shared';
import { aiOn, mockSummary, mockTriage } from './support/ai';
import { fieldValue, uniqueKey, type Api } from './support/api';
import { ADMIN } from './support/env';
import { expect, holdLiveEvents, test } from './support/fixtures';

let key: string;
let other: IssueDetail;

test.beforeAll(async ({ workerApi: api }) => {
  key = uniqueKey('IP');
  await api.createProject({ key, name: `Checkout ${key}` });
  other = await api.createIssue({ project: key, summary: 'Payment gateway retries too slowly', fields: { Type: 'Bug' } });
});

const newIssue = (api: Api, summary = 'Checkout times out under load', fields: Record<string, string> = {}) =>
  api.createIssue({ project: key, summary, fields: { Type: 'Bug', Priority: 'Normal', Estimation: '2d', ...fields } });

async function open(page: Page, issue: IssueDetail) {
  await page.goto(`/issues/${issue.id}`);
  const fields = page.getByRole('complementary', { name: `Fields of ${issue.id}` });
  await expect(fields).toBeVisible();
  return fields;
}

test('a field is changed from the keyboard, against the version the page read', async ({ page, api }) => {
  const issue = await newIssue(api);
  const fields = await open(page, issue);

  const priority = fields.getByRole('button', { name: 'Priority Normal' });
  await priority.focus();
  await page.keyboard.press('Enter');
  const choices = fields.getByRole('listbox', { name: 'Priority' });
  await expect(choices).toBeFocused();
  await expect(choices.getByRole('option', { name: 'Normal, now' })).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('ArrowUp');
  const major = choices.getByRole('option', { name: 'Major', exact: true });
  await expect(choices).toHaveAttribute('aria-activedescendant', (await major.getAttribute('id'))!);
  const saving = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/api/v1/issues/${issue.id}`));
  await page.keyboard.press('Enter');
  expect((await saving).postDataJSON()).toEqual({ fields: { Priority: 'Major' }, expectedVersion: issue.version });

  // The choices close, and the focus is back on the value, which now says it.
  await expect(choices).toBeHidden();
  await expect(fields.getByRole('button', { name: 'Priority Major' })).toBeFocused();
  expect(fieldValue(await api.issue(issue.id), 'Priority')).toBe('Major');

  // Escape closes the choices without changing anything.
  await page.keyboard.press('Enter');
  await expect(choices).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(choices).toBeHidden();
  await expect(fields.getByRole('button', { name: 'Priority Major' })).toBeFocused();
});

test('a link is added, and taken away', async ({ page, api }) => {
  const issue = await newIssue(api);
  await open(page, issue);
  const links = page.getByRole('region', { name: 'Links' });
  await expect(links.getByText(/^No links yet/)).toBeVisible();

  await links.getByRole('button', { name: 'Add link' }).click();
  const adding = links.getByRole('group', { name: `A link from ${issue.id}` });
  await adding.getByLabel('What it says').selectOption('depends on');
  const to = adding.getByLabel('To', { exact: true });
  await expect(to).toBeFocused();
  await to.fill(other.id);
  // What it would link to shows before it's linked.
  await expect(adding.getByText(other.summary)).toBeVisible();
  await adding.getByRole('button', { name: 'Link it' }).click();

  await expect(adding).toBeHidden();
  await expect(links.getByRole('heading', { name: 'depends on · 1' })).toBeVisible();
  await expect(links.getByRole('link', { name: other.summary })).toBeVisible();
  expect((await api.issue(issue.id)).links.map((l) => [l.phrase, l.issue.id])).toEqual([['depends on', other.id]]);
  expect((await api.issue(other.id)).links.map((l) => [l.phrase, l.issue.id])).toContainEqual(['is required for', issue.id]);

  await links.getByRole('button', { name: `Unlink ${other.id}` }).click();
  await expect(links.getByText(/^No links yet/)).toBeVisible();
  expect((await api.issue(issue.id)).links).toEqual([]);
  // The history says both.
  const history = page.getByRole('region', { name: 'History and comments' });
  await expect(history.getByText(/^Linked:/)).toBeVisible();
  await expect(history.getByText(/^Unlinked:/)).toBeVisible();
});

test('a comment is posted, and time is logged against the estimate', async ({ page, api }) => {
  const issue = await newIssue(api);
  const fields = await open(page, issue);
  const history = page.getByRole('region', { name: 'History and comments' });

  const comment = page.getByLabel(`A comment, as ${ADMIN.name}`);
  await comment.fill('Reproduced on staging: the gateway gives up after **30 seconds**.');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(comment).toHaveValue('');
  await expect(history.getByText('Reproduced on staging: the gateway gives up after')).toBeVisible();
  await expect(history.getByText('30 seconds', { exact: true })).toBeVisible();

  const log = page.getByRole('form', { name: 'Log time' });
  await log.getByLabel('Time spent').fill('1h 30m');
  await log.getByLabel('What it was spent on').fill('Profiling the checkout');
  await log.getByRole('button', { name: 'Log time' }).click();
  const work = page.getByRole('table', { name: `Work logged on ${issue.id}` });
  await expect(work.getByRole('row').filter({ hasText: 'Profiling the checkout' })).toContainText('1h 30m');
  await expect(page.getByText('of 2d estimated')).toBeVisible();
  await expect(fields.getByRole('definition').filter({ hasText: '1h 30m' })).toBeVisible();
  await expect(history.getByText('Profiling the checkout')).toBeVisible();

  const saved = await api.issue(issue.id);
  expect(saved.spentMinutes).toBe(90);
  expect(saved.commentCount).toBe(1);
});

test("triage's values are accepted one at a time (suggestions stood in for)", async ({ page, api }) => {
  const issue = await newIssue(api, 'Refunds are booked twice when the bank is slow');
  const triage = await mockTriage(page, api, issue, {
    fields: [
      { name: 'Priority', value: 'Critical', current: 'Normal', confidence: 'high', reason: 'Customers are charged twice, and support finds out from them.' },
      { name: 'Assignee', value: 'anna', current: null, confidence: 'medium', reason: 'Anna Schmidt works on the payment flows.' },
    ],
    tags: [],
    duplicates: [],
    summary: 'A double booking of refunds, for every customer whose bank answers slowly.',
  });
  const fields = await open(page, issue);

  // Each worked-out value waits, dashed, with why, and its own Accept.
  const priority = fields.getByRole('button', { name: 'Priority Critical' });
  const assignee = fields.getByRole('button', { name: 'Assignee Anna Schmidt' });
  await expect(priority).toHaveAccessibleDescription(/^triage Customers are charged twice/);
  await expect(assignee).toHaveAccessibleDescription(/^triage Anna Schmidt works on the payment flows/);
  await expect(fields.getByText('Dashed values were worked out by an agent')).toBeVisible();
  // A value's Accept is beside it, in the same definition.
  const acceptFor = (value: string) => fields.getByRole('definition').filter({ has: page.getByRole('button', { name: value }) }).getByRole('button', { name: 'Accept' });

  await acceptFor('Priority Critical').click();
  await expect(acceptFor('Priority Critical')).toHaveCount(0);
  await expect(priority).not.toHaveAccessibleDescription(/triage/);
  // The other value still waits.
  await expect(acceptFor('Assignee Anna Schmidt')).toBeVisible();
  expect(triage.applied).toEqual([['Priority']]);
  let saved = await api.issue(issue.id);
  expect([fieldValue(saved, 'Priority'), fieldValue(saved, 'Assignee')]).toEqual(['Critical', null]);

  await acceptFor('Assignee Anna Schmidt').click();
  await expect(fields.getByRole('button', { name: 'Accept' })).toHaveCount(0);
  await expect(fields.getByText('Dashed values were worked out by an agent')).toBeHidden();
  expect(triage.applied).toEqual([['Priority'], ['Assignee']]);
  saved = await api.issue(issue.id);
  expect([fieldValue(saved, 'Priority'), fieldValue(saved, 'Assignee')]).toEqual(['Critical', 'anna']);
});

test('the summary is edited from the keyboard', async ({ page, api }) => {
  const issue = await newIssue(api);
  await open(page, issue);
  const title = page.getByRole('button', { name: `${issue.summary}. Change the summary` });
  await title.focus();
  await page.keyboard.press('Enter');
  const summary = page.getByRole('textbox', { name: 'Summary' });
  await expect(summary).toBeFocused();
  await expect(summary).toHaveValue(issue.summary);

  // Escape puts it back.
  await summary.fill('Not this');
  await summary.press('Escape');
  await expect(page.getByRole('button', { name: `${issue.summary}. Change the summary` })).toBeVisible();

  await page.getByRole('button', { name: `${issue.summary}. Change the summary` }).press('Enter');
  await summary.fill('Checkout times out under load on Fridays');
  await summary.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Checkout times out under load on Fridays');
  expect((await api.issue(issue.id)).summary).toBe('Checkout times out under load on Fridays');
});

test('the assistant summarises the issue (AI stood in for)', async ({ page, api }) => {
  const issue = await newIssue(api);
  await aiOn(page);
  const ai = await mockSummary(page, issue.id, 'Checkout gives up after **30 seconds** when the payment gateway is slow.');
  await open(page, issue);
  await page.getByRole('button', { name: 'Summarise' }).click();
  const summary = page.getByRole('region', { name: 'Summary by the assistant' });
  await expect(summary).toContainText('Checkout gives up after 30 seconds when the payment gateway is slow.');
  await expect(summary.getByText('30 seconds', { exact: true })).toBeVisible();
  expect(ai.asked()).toBe(1);
});

test('a change made meanwhile is not overwritten: the save is refused (409), and the page reads it again', async ({ page, api, watch }) => {
  watch.allow(/status of 409/);
  // The page doesn't hear of the change, as when it lands between reading and saving.
  await holdLiveEvents(page);
  const issue = await newIssue(api);
  const fields = await open(page, issue);
  await expect(fields.getByRole('button', { name: 'Priority Normal' })).toBeVisible();

  // Someone else raises the priority, through the API.
  await api.updateIssue(issue.id, { fields: { Priority: 'Critical' } });

  await page.getByRole('button', { name: `${issue.summary}. Change the summary` }).click();
  const summary = page.getByRole('textbox', { name: 'Summary' });
  await summary.fill('Checkout times out under load at the end of the month');
  const refused = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith(`/api/v1/issues/${issue.id}`));
  await summary.press('Enter');
  expect((await refused).status()).toBe(409);
  await expect(page.getByText('Someone changed this issue just now. It’s been reloaded: check it and try again.')).toBeVisible();
  // It shows the other change now, and keeps what was typed.
  await expect(fields.getByRole('button', { name: 'Priority Critical' })).toBeVisible();
  await expect(summary).toHaveValue('Checkout times out under load at the end of the month');

  await summary.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Checkout times out under load at the end of the month');
  const saved = await api.issue(issue.id);
  expect([saved.summary, fieldValue(saved, 'Priority')]).toEqual(['Checkout times out under load at the end of the month', 'Critical']);
});
