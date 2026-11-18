/**
 * AI help with writing and reading (docs/architecture.md, D59), with the AI stood in for in the
 * browser (D20): text selected in the editor fixed, the change accepted and saved; an issue
 * summarised, and the summary posted as the assistant's; a reply drafted on a help desk request and
 * sent. Each in light, in dark and at a phone's width, without sideways scroll.
 */
import type { Comment, IssueList, SummarizeResult, WriteInput, WriteResult } from '@a4a/shared';
import type { Locator, Page } from '@playwright/test';
import { aiOn } from './support/ai';
import { unique, uniqueKey } from './support/api';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { expect, test } from './support/fixtures';
import { deskTakingMail, message, postMail } from './support/helpdesk';

let key: string;

test.beforeAll(async ({ workerApi: api }) => {
  key = uniqueKey('WH');
  await api.createProject({ key, name: `Writing help ${key}` });
});

/** Shots of a piece in light and dark, and of the page at a phone's width, which mustn't scroll sideways. */
async function shoot(page: Page, name: string, what: Locator) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await what.screenshot({ path: test.info().outputPath(`${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoSidewaysScroll(page);
  await page.screenshot({ path: test.info().outputPath(`${name}-390.png`), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** The assistant's writing, as the server would answer (POST /ai/write); keeps what it was asked. */
async function mockWrite(page: Page, write: (asked: WriteInput) => string) {
  const asked: WriteInput[] = [];
  await page.route('**/api/v1/ai/write', async (route) => {
    const body = route.request().postDataJSON() as WriteInput;
    asked.push(body);
    await route.fulfill({ json: { action: body.action, text: write(body), model: 'stand-in' } satisfies WriteResult });
  });
  return asked;
}

test('text selected in a description is fixed, the change accepted, and saved', async ({ page, api }) => {
  const issue = await api.createIssue({ project: key, summary: 'Checkout breaks on Safari', description: 'Checkout dont work on Safari.\n\nAsk @admin about it.' });
  await aiOn(page);
  const asked = await mockWrite(page, ({ text }) => text.replace('dont work', 'doesn’t work'));
  await page.goto(`/issues/${issue.id}`);
  await page.getByRole('button', { name: 'Edit the description' }).click();
  const editor = page.getByRole('textbox', { name: 'Description' });
  await expect(editor).toBeVisible();

  // The first line, selected from the keyboard: the toolbar for what's selected shows.
  await editor.getByText('Checkout dont work on Safari.').click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  const selected = page.getByRole('group', { name: 'Writing help for the selected text' });
  await selected.getByRole('button', { name: 'Fix spelling and grammar' }).click();

  const card = page.getByRole('region', { name: 'Spelling and grammar, fixed' });
  await expect(card).toContainText('Suggested by the assistant');
  await expect(card).toContainText('Not in the text yet: nothing changes until you accept it.');
  const change = card.getByRole('list', { name: 'What it would change' });
  await expect(change.locator('li.del')).toHaveText(/Checkout dont work on Safari\./);
  await expect(change.locator('li.add')).toHaveText(/Checkout doesn’t work on Safari\./);
  expect(asked).toEqual([{ action: 'fix', text: 'Checkout dont work on Safari.', for: { kind: 'description', issue: issue.id } }]);
  // Nothing is written yet.
  expect((await api.issue(issue.id)).description).toBe('Checkout dont work on Safari.\n\nAsk @admin about it.');
  await expectAccessible(page);
  await shoot(page, 'writing-fix', card);

  await card.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByText('It’s in the text now. Save to keep it.')).toBeVisible();
  await expect(editor).toContainText('Checkout doesn’t work on Safari.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  // The editor writes its Markdown with a line end at the end (D39).
  await expect.poll(async () => (await api.issue(issue.id)).description.trimEnd()).toBe('Checkout doesn’t work on Safari.\n\nAsk @admin about it.');
});

test('the whole text is offered too, and a suggestion discarded leaves it as it was', async ({ page, api }) => {
  const issue = await api.createIssue({ project: key, summary: 'Refunds are slow', description: 'Refunds take a long time and people are not happy about it at all.' });
  await aiOn(page);
  await mockWrite(page, () => 'Refunds are slow, and people are unhappy.');
  await page.goto(`/issues/${issue.id}`);
  await page.getByRole('button', { name: 'Edit the description' }).click();
  // The description's editor, beside the comment box's, which has its own.
  const field = page.locator('.editor', { has: page.getByRole('textbox', { name: 'Description' }) });
  await field.getByRole('button', { name: 'Writing help', exact: true }).click();
  await expect(field.getByRole('button', { name: 'Writing help', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await field.getByRole('group', { name: 'Writing help for the whole text' }).getByRole('button', { name: 'Shorter' }).click();
  const card = page.getByRole('region', { name: 'Shorter' });
  await expect(card.getByRole('list', { name: 'What it would change' }).locator('li.add')).toHaveText(/Refunds are slow, and people are unhappy\./);
  await card.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByText('Discarded: the text is as it was.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Description' })).toContainText('Refunds take a long time');
});

test('an issue is summarised, labelled as the assistant’s, and posted as its comment', async ({ page, api }) => {
  const issue = await api.createIssue({ project: key, summary: 'Payments time out', description: 'The gateway gives up after 30 seconds.' });
  await aiOn(page);
  let summarised = 0;
  await page.route(`**/api/v1/issues/${issue.id}/summarize`, async (route) => {
    summarised += 1;
    await route.fulfill({ json: { summary: '- The gateway gives up after **30 seconds**.\n- Nobody is on it yet.', language: 'en', partial: false, post: 'signed', model: 'stand-in' } satisfies SummarizeResult });
  });
  const posted: { text: string; token: string }[] = [];
  await page.route(`**/api/v1/issues/${issue.id}/summary/comment`, async (route) => {
    const body = route.request().postDataJSON() as { text: string; token: string };
    posted.push(body);
    const comment: Comment = {
      id: `c-${unique()}`,
      issueId: issue.id,
      author: null,
      text: body.text,
      channel: 'assistant',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
      visibility: 'internal',
      requester: null,
      visibleTo: null,
      reactions: [],
    };
    await route.fulfill({ status: 201, json: comment });
  });
  await page.goto(`/issues/${issue.id}`);
  await page.getByRole('button', { name: 'Summarise' }).click();
  const summary = page.getByRole('region', { name: 'Summary by the assistant' });
  await expect(summary).toContainText('summarised the issue and its discussion');
  await expect(summary.getByText('30 seconds', { exact: true })).toBeVisible();
  await expect(summary.locator('.avatar.agent')).toBeVisible();
  await expectAccessible(page);
  await shoot(page, 'writing-summary', summary);
  await summary.getByRole('button', { name: 'Post it as a comment' }).click();
  await expect(page.getByText('Posted as a comment, as the assistant’s.')).toBeVisible();
  expect(posted).toEqual([{ text: '- The gateway gives up after **30 seconds**.\n- Nobody is on it yet.', token: 'signed' }]);
  expect(summarised).toBe(1);
});

test('a reply is drafted on a help desk request from its conversation, accepted, and sent', async ({ page, api }) => {
  const desk = uniqueKey('WR');
  await api.createProject({ key: desk, name: `Billing desk ${desk}` });
  const address = `billing-${unique()}@desk.example`;
  const { url } = await deskTakingMail(api, desk, address);
  expect((await postMail(url, message({ from: 'Rosa Diaz <rosa@example.com>', to: address, subject: 'Charged twice in March', body: 'My March invoice charges me twice.' }))).status).toBe(200);
  const found = await api.get<IssueList>(`/issues?q=${encodeURIComponent(`project: ${desk}`)}`);
  const id = found.items[0]!.id;
  await aiOn(page);
  const asked = await mockWrite(page, () => 'Hello Rosa,\n\nWe have refunded the second charge; it reaches your card within five days.\n\nAda Admin');

  await page.goto(`/issues/${id}`);
  await page.getByRole('button', { name: 'Reply to Rosa Diaz' }).click();
  await page.getByRole('button', { name: 'Draft a reply' }).click();
  const card = page.getByRole('region', { name: 'A draft' });
  await expect(card).toContainText('Suggested by the assistant');
  await expect(card.getByRole('list', { name: 'What it would change' })).toContainText('We have refunded the second charge');
  expect(asked).toEqual([{ action: 'draft', text: '', for: { kind: 'reply', issue: id } }]);
  await shoot(page, 'writing-reply', card);

  await card.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByRole('textbox', { name: /reply|comment/i })).toContainText('We have refunded the second charge');
  await page.getByRole('button', { name: 'Send to Rosa Diaz' }).click();
  await expect
    .poll(async () => (await api.get<Comment[]>(`/issues/${id}/comments`)).find((c) => c.visibility === 'public')?.text)
    .toBe('Hello Rosa,\n\nWe have refunded the second charge; it reaches your card within five days.\n\nAda Admin');
});

test('without an AI provider, no writing help is offered', async ({ page, api }) => {
  const issue = await api.createIssue({ project: key, summary: 'Nothing to help with', description: 'Words.' });
  await page.goto(`/issues/${issue.id}`);
  await page.getByRole('button', { name: 'Edit the description' }).click();
  await expect(page.getByRole('textbox', { name: 'Description' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Writing help' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Summarise' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Suggest a summary' })).toHaveCount(0);
});
