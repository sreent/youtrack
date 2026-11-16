/**
 * The assistant, its endpoints stood in for (support/ai.ts): a streamed answer that reads an
 * issue and then asks before it changes anything; the person approves one change and declines
 * the other, which goes back in one request; and the result streams in.
 */
import { mockAssistant, takeIssue } from './support/ai';
import { uniqueKey } from './support/api';
import { expect, test } from './support/fixtures';

test('a streamed answer asks before it changes anything, and the decisions go back in one request', async ({ page, api }) => {
  const key = uniqueKey('AS');
  await api.createProject({ key, name: `Auth docs ${key}` });
  const issue = await api.createIssue({ project: key, summary: 'Document the v2 authentication flow', fields: { Type: 'Task' } });
  const { asked, comment, script } = takeIssue(issue, key);
  const ai = await mockAssistant(page, script);

  // Come from the issue: it says where it starts.
  await page.goto(`/assistant?issue=${issue.id}`);
  const talk = page.getByRole('region', { name: 'A conversation with assistant' });
  const composer = talk.getByLabel('Your message');
  await expect(composer).toBeEnabled();
  await expect(talk.getByText(`It starts from ${issue.id}, the issue you came from.`, { exact: false })).toBeVisible();
  await composer.fill(asked);
  await composer.press('Enter');

  // What it read, and what it would change, each change waiting on the person.
  await expect(page).toHaveURL(new RegExp(`/assistant/${ai.conversation.id}\\?issue=${issue.id}$`));
  await expect(talk.getByText(asked, { exact: true })).toBeVisible();
  await expect(talk.getByText(`Reading ${issue.id} first, to see who has it.`)).toBeVisible();
  await expect(talk.getByRole('list', { name: 'What it did' }).first()).toContainText('get_issue');
  const updating = talk.getByRole('region', { name: 'assistant asks to update an issue' });
  const commenting = talk.getByRole('region', { name: 'assistant asks to comment' });
  await expect(updating.getByRole('insertion').first()).toHaveText('In Progress');
  await expect(updating).toContainText(`Why: you asked “${asked}”`);
  await expect(commenting).toContainText(comment.text);
  await expect(talk.getByText('Decide on each change; assistant carries on once you have.')).toBeVisible();
  await expect(composer).toBeDisabled();
  expect(ai.sent).toEqual([{ text: asked, context: { issue: issue.id, project: key }, approvalMode: 'ask' }]);

  // Nothing goes back until both are decided; then both go in one request.
  await updating.getByRole('button', { name: 'Approve' }).click();
  await expect(updating.getByRole('status')).toHaveText('You approved it.');
  expect(ai.decided).toEqual([]);
  await commenting.getByRole('button', { name: 'Decline' }).click();

  await expect(talk.getByText('I left the comment out, as you said.', { exact: false })).toBeVisible();
  expect(ai.decided).toEqual([
    {
      decisions: [
        { toolUseId: 'tu-update', approve: true },
        { toolUseId: 'tu-comment', approve: false },
      ],
    },
  ]);
  await expect(talk.getByRole('region', { name: /^assistant asks to/ })).toHaveCount(0);
  await expect(talk.getByText('you declined it', { exact: true })).toBeVisible();
  await expect(composer).toBeEnabled();
  await expect(page.getByRole('navigation', { name: 'Your conversations' }).getByRole('link', { name: new RegExp(asked) })).toBeVisible();
});
