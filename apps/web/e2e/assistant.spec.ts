/**
 * The assistant, its endpoints stood in for (support/ai.ts): a streamed answer that reads an
 * issue and then asks before it changes anything; the person approves one change and declines
 * the other, which goes back in one request; and the result streams in.
 */
import type { ChatStreamEvent, Conversation, ConversationDetail } from '@a4a/shared';
import { mockAssistant } from './support/ai';
import { uniqueKey } from './support/api';
import { NOW } from './support/env';
import { expect, test } from './support/fixtures';

test('a streamed answer asks before it changes anything, and the decisions go back in one request', async ({ page, api }) => {
  const key = uniqueKey('AS');
  await api.createProject({ key, name: `Auth docs ${key}` });
  const issue = await api.createIssue({ project: key, summary: 'Document the v2 authentication flow', fields: { Type: 'Task' } });
  const id = issue.id;
  const asked = `Take ${id} and start on it`;
  const update = { issue: id, fields: { State: 'In Progress', Assignee: 'admin' } };
  const comment = { issue: id, text: "Taking this: I'll start with the token exchange." };
  const approvals = [
    { toolUseId: 'tu-update', name: 'update_issue', input: update, preview: `${id}: State Open → In Progress; Assignee — → admin` },
    { toolUseId: 'tu-comment', name: 'add_comment', input: comment, preview: `Comment on ${id}: "${comment.text}"` },
  ];
  const at = NOW.toISOString();
  // The conversation as the server keeps it once the first turn is done: waiting on the person.
  const afterAnswer = (c: Conversation): ConversationDetail => ({
    ...c,
    title: asked,
    status: 'awaiting_approval',
    messages: [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: asked }], createdAt: at },
      {
        id: 'm2',
        role: 'assistant',
        parts: [
          { type: 'progress', text: `Reading ${id} first, to see who has it.` },
          { type: 'tool', id: 'tu-read', name: 'get_issue', input: { issue: id }, status: 'done', summary: `${id} ${issue.summary}`, write: false },
        ],
        createdAt: at,
      },
      {
        id: 'm3',
        role: 'assistant',
        parts: [
          { type: 'text', text: `${id} is open and nobody has it. I can assign it to you, move it to In Progress, and say so in a comment.` },
          { type: 'tool', id: 'tu-update', name: 'update_issue', input: update, status: 'pending_approval', summary: null, write: true },
          { type: 'tool', id: 'tu-comment', name: 'add_comment', input: comment, status: 'pending_approval', summary: null, write: true },
        ],
        createdAt: at,
      },
    ],
    pendingApprovals: approvals,
  });
  const afterDecided = (c: Conversation): ConversationDetail => {
    const d = afterAnswer(c);
    d.status = 'idle';
    d.pendingApprovals = [];
    d.messages[2]!.parts[1] = { type: 'tool', id: 'tu-update', name: 'update_issue', input: update, status: 'done', summary: `Updated ${id}`, write: true };
    d.messages[2]!.parts[2] = { type: 'tool', id: 'tu-comment', name: 'add_comment', input: comment, status: 'rejected', summary: 'You declined it', write: true };
    d.messages.push({ id: 'm4', role: 'assistant', parts: [{ type: 'text', text: `${id} is yours, and In Progress. I left the comment out, as you said.` }], createdAt: at });
    return d;
  };
  const words = `${id} is open and nobody has it. I can assign it to you, move it to In Progress, and say so in a comment.`.split(/(?<= )/);
  const answer: ChatStreamEvent[] = [
    { type: 'message_start', messageId: 'step-0' },
    { type: 'progress', text: `Reading ${id} first, ` },
    { type: 'progress', text: 'to see who has it.' },
    { type: 'tool_start', id: 'tu-read', name: 'get_issue', input: { issue: id }, write: false },
    { type: 'tool_result', id: 'tu-read', ok: true, summary: `${id} ${issue.summary}` },
    { type: 'message_start', messageId: 'step-1' },
    ...words.map((text) => ({ type: 'text_delta' as const, text })),
    { type: 'tool_start', id: 'tu-update', name: 'update_issue', input: update, write: true },
    { type: 'tool_start', id: 'tu-comment', name: 'add_comment', input: comment, write: true },
    { type: 'approval_required', approvals },
    { type: 'done', status: 'awaiting_approval' },
  ];
  const onDecided: ChatStreamEvent[] = [
    { type: 'tool_result', id: 'tu-update', ok: true, summary: `Updated ${id}` },
    { type: 'tool_result', id: 'tu-comment', ok: false, summary: 'You declined it' },
    { type: 'message_start', messageId: 'step-2' },
    { type: 'text_delta', text: `${id} is yours, and In Progress. ` },
    { type: 'text_delta', text: 'I left the comment out, as you said.' },
    { type: 'done', status: 'idle' },
  ];
  const ai = await mockAssistant(page, { title: asked, project: key, answer, afterAnswer, onDecided, afterDecided });

  // Come from the issue: it says where it starts.
  await page.goto(`/assistant?issue=${id}`);
  const talk = page.getByRole('region', { name: 'A conversation with assistant' });
  const composer = talk.getByLabel('Your message');
  await expect(composer).toBeEnabled();
  await expect(talk.getByText(`It starts from ${id}, the issue you came from.`, { exact: false })).toBeVisible();
  await composer.fill(asked);
  await composer.press('Enter');

  // What it read, and what it would change, each change waiting on the person.
  await expect(page).toHaveURL(new RegExp(`/assistant/${ai.conversation.id}\\?issue=${id}$`));
  await expect(talk.getByText(asked, { exact: true })).toBeVisible();
  await expect(talk.getByText(`Reading ${id} first, to see who has it.`)).toBeVisible();
  await expect(talk.getByRole('list', { name: 'What it did' }).first()).toContainText('get_issue');
  const updating = talk.getByRole('region', { name: 'assistant asks to update an issue' });
  const commenting = talk.getByRole('region', { name: 'assistant asks to comment' });
  await expect(updating.getByRole('insertion').first()).toHaveText('In Progress');
  await expect(updating).toContainText(`Why: you asked “${asked}”`);
  await expect(commenting).toContainText(comment.text);
  await expect(talk.getByText('Decide on each change; assistant carries on once you have.')).toBeVisible();
  await expect(composer).toBeDisabled();
  expect(ai.sent).toEqual([{ text: asked, context: { issue: id, project: key }, approvalMode: 'ask' }]);

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
