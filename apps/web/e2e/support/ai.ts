/**
 * The AI, stood in for in the browser. The run's server has no Claude key, so its AI endpoints
 * answer 503; a flow that needs one has it answered here (`page.route`) with what the server
 * would send, typed by the contract. What the server does with Claude is tested in its own
 * vitest suite (packages/server/test/ai.test.ts), with a fake client.
 */
import type { Page, Route } from '@playwright/test';
import type { ChatStreamEvent, Conversation, ConversationDetail, IssueDetail, NLQueryResult, Suggestion, SummarizeResult, TriagePayload } from '@a4a/shared';
import { unique, type Api } from './api';
import { NOW } from './env';

const path = (route: Route) => new URL(route.request().url()).pathname;

/** The server says AI is on, so the pages offer what needs it. */
export async function aiOn(page: Page): Promise<void> {
  await page.route('**/api/v1/ai/status', (route) => route.fulfill({ json: { enabled: true, model: 'claude-opus-5-5', reason: null } }));
}

/** Words to a query (POST /ai/query): answers with `read(text)`, and keeps what was asked. */
export async function mockWordsToQuery(page: Page, read: (text: string) => Omit<NLQueryResult, 'problems'>) {
  const asked: { text: string; project?: string }[] = [];
  await page.route('**/api/v1/ai/query', async (route) => {
    const body = route.request().postDataJSON() as { text: string; project?: string };
    asked.push(body);
    await route.fulfill({ json: { ...read(body.text), problems: [] } satisfies NLQueryResult });
  });
  return { asked };
}

/** An issue's summary by the assistant (POST /issues/{id}/summarize). */
export async function mockSummary(page: Page, issueId: string, summary: string) {
  let asked = 0;
  await page.route(`**/api/v1/issues/${issueId}/summarize`, async (route) => {
    asked += 1;
    await route.fulfill({ json: { summary, language: 'en', partial: false, post: null, model: 'claude-opus-5-5' } satisfies SummarizeResult });
  });
  return { asked: () => asked };
}

// ---------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------

export function triageSuggestion(issueId: string, payload: TriagePayload, status: Suggestion['status'] = 'pending'): Suggestion {
  return { id: `sugg-e2e-${unique()}`, issueId, kind: 'triage', status, payload, model: 'claude-opus-5-5', createdAt: NOW.toISOString(), resolvedAt: null, resolvedBy: null };
}

/** What triage would work out for the demo's BACK-3, the same failure as BACK-2. */
export const BACK_3_TRIAGE: TriagePayload = {
  fields: [
    { name: 'Priority', value: 'Critical', current: 'Normal', confidence: 'high', reason: 'Nobody on Safari 17 can sign in with SSO; the same failure in BACK-2 is Critical.' },
    { name: 'Subsystem', value: 'Auth', current: null, confidence: 'high', reason: 'Single sign-on is the Auth subsystem.' },
    { name: 'Assignee', value: 'anna', current: null, confidence: 'medium', reason: 'Anna Schmidt works on the other sign-in issues in BACK.' },
  ],
  tags: [{ name: 'regression', confidence: 'medium' }],
  duplicates: [{ issue: 'BACK-2', summary: 'Login fails on Safari with SSO', verdict: 'duplicate', reason: 'The same failure: SSO sign-in on Safari, reported a week apart.' }],
  summary: 'A sign-in failure for every Safari 17 user, the same as BACK-2, which Anna Schmidt is fixing.',
};

/** Suggestions waiting on a person: the Decide page's queue and each issue's own. Nothing is applied. */
export async function mockWaitingSuggestions(page: Page, suggestions: Suggestion[]): Promise<void> {
  await page.route((url) => url.pathname === '/api/v1/ai/suggestions', (route) => route.fulfill({ json: suggestions }));
  for (const s of suggestions) {
    await page.route(`**/api/v1/issues/${s.issueId}/suggestions`, (route) => route.fulfill({ json: suggestions.filter((x) => x.issueId === s.issueId) }));
  }
}

/**
 * A triage suggestion waiting on an issue, and accepting it a value at a time (POST
 * /suggestions/{id}/apply). Applying is the server's work; here the stand-in makes the same
 * change to the issue through the API, so the page reads the issue as it would be.
 */
export async function mockTriage(page: Page, api: Api, issue: IssueDetail, payload: TriagePayload) {
  const accepted = new Set<string>();
  const applied: string[][] = [];
  const first = triageSuggestion(issue.id, payload);
  const suggestion = (): Suggestion => ({
    ...first,
    status: accepted.size === 0 ? 'pending' : accepted.size < payload.fields.length ? 'partially_applied' : 'applied',
  });
  await page.route(`**/api/v1/issues/${issue.id}/suggestions`, (route) => route.fulfill({ json: [suggestion()] }));
  await page.route(`**/api/v1/suggestions/${first.id}/apply`, async (route) => {
    const body = route.request().postDataJSON() as { fields?: string[] };
    const names = body.fields ?? payload.fields.map((f) => f.name);
    applied.push(names);
    await api.updateIssue(issue.id, { fields: Object.fromEntries(payload.fields.filter((f) => names.includes(f.name)).map((f) => [f.name, f.value])) });
    names.forEach((n) => accepted.add(n));
    await route.fulfill({ json: suggestion() });
  });
  return { applied };
}

// ---------------------------------------------------------------------------
// The assistant
// ---------------------------------------------------------------------------

/** Server-sent events, as the chat endpoints write them. */
export const sse = (events: ChatStreamEvent[]) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

export interface AssistantScript {
  title: string;
  project: string | null;
  /** The turn the person's first message starts, as it streams. */
  answer: ChatStreamEvent[];
  /** The conversation as the server keeps it after that turn. */
  afterAnswer: (c: Conversation) => ConversationDetail;
  /** The turn the person's decisions start. */
  onDecided: ChatStreamEvent[];
  afterDecided: (c: Conversation) => ConversationDetail;
}

/**
 * "Take BACK-6 and start on it": the assistant reads the issue, then asks to update it (In
 * Progress, assigned to the person) and to comment on it. The person approves the update and
 * declines the comment, and it says so.
 */
export function takeIssue(issue: { id: string; summary: string }, project: string | null) {
  const id = issue.id;
  const asked = `Take ${id} and start on it`;
  const update = { issue: id, fields: { State: 'In Progress', Assignee: 'admin' } };
  const comment = { issue: id, text: "Taking this: I'll start with the token exchange." };
  const approvals = [
    { toolUseId: 'tu-update', name: 'update_issue', input: update, preview: `${id}: State Open → In Progress; Assignee — → admin` },
    { toolUseId: 'tu-comment', name: 'add_comment', input: comment, preview: `Comment on ${id}: "${comment.text}"` },
  ];
  const at = NOW.toISOString();
  const offer = `${id} is open and nobody has it. I can assign it to you, move it to In Progress, and say so in a comment.`;
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
          { type: 'text', text: offer },
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
  const script: AssistantScript = {
    title: asked,
    project,
    answer: [
      { type: 'message_start', messageId: 'step-0' },
      { type: 'progress', text: `Reading ${id} first, ` },
      { type: 'progress', text: 'to see who has it.' },
      { type: 'tool_start', id: 'tu-read', name: 'get_issue', input: { issue: id }, write: false },
      { type: 'tool_result', id: 'tu-read', ok: true, summary: `${id} ${issue.summary}` },
      { type: 'message_start', messageId: 'step-1' },
      ...offer.split(/(?<= )/).map((text) => ({ type: 'text_delta' as const, text })),
      { type: 'tool_start', id: 'tu-update', name: 'update_issue', input: update, write: true },
      { type: 'tool_start', id: 'tu-comment', name: 'add_comment', input: comment, write: true },
      { type: 'approval_required', approvals },
      { type: 'done', status: 'awaiting_approval' },
    ],
    afterAnswer,
    onDecided: [
      { type: 'tool_result', id: 'tu-update', ok: true, summary: `Updated ${id}` },
      { type: 'tool_result', id: 'tu-comment', ok: false, summary: 'You declined it' },
      { type: 'message_start', messageId: 'step-2' },
      { type: 'text_delta', text: `${id} is yours, and In Progress. ` },
      { type: 'text_delta', text: 'I left the comment out, as you said.' },
      { type: 'done', status: 'idle' },
    ],
    afterDecided,
  };
  return { asked, comment, script };
}

const newConversation = (title: string, project: string | null): Conversation => ({
  id: `conv-e2e-${unique()}`,
  title,
  project,
  status: 'idle',
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
});

/**
 * The assistant's conversation endpoints: a new conversation, the person's message (a streamed
 * turn that ends waiting on them), their decisions (one request, a streamed turn), and the
 * conversation read back after each. Keeps what the page sent.
 */
export async function mockAssistant(page: Page, script: AssistantScript) {
  const conversation = newConversation(script.title, script.project);
  const sent: unknown[] = [];
  const decided: unknown[] = [];
  let stage: 'new' | 'created' | 'answered' | 'decided' = 'new';
  const detail = (): ConversationDetail =>
    stage === 'answered' ? script.afterAnswer(conversation) : stage === 'decided' ? script.afterDecided(conversation) : { ...conversation, messages: [], pendingApprovals: [] };

  await aiOn(page);
  await page.route(
    (url) => url.pathname.startsWith('/api/v1/ai/conversations'),
    async (route) => {
      const p = path(route);
      const method = route.request().method();
      const base = '/api/v1/ai/conversations';
      if (p === base && method === 'POST') {
        stage = 'created';
        return route.fulfill({ status: 201, json: conversation });
      }
      if (p === base) return route.fulfill({ json: stage === 'new' ? [] : [{ ...conversation, status: detail().status }] });
      if (p === `${base}/${conversation.id}`) return route.fulfill({ json: detail() });
      if (p === `${base}/${conversation.id}/messages`) {
        sent.push(route.request().postDataJSON());
        stage = 'answered';
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(script.answer) });
      }
      if (p === `${base}/${conversation.id}/approve`) {
        decided.push(route.request().postDataJSON());
        stage = 'decided';
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(script.onDecided) });
      }
      return route.fallback();
    },
  );
  return { conversation, sent, decided };
}

/** A conversation the server keeps, as it reads back: in the list, and opened. Returns its address. */
export async function mockStoredConversation(page: Page, script: AssistantScript, at: 'answered' | 'decided' = 'answered'): Promise<string> {
  const conversation = newConversation(script.title, script.project);
  const detail = at === 'answered' ? script.afterAnswer(conversation) : script.afterDecided(conversation);
  await aiOn(page);
  await page.route('**/api/v1/ai/conversations', (route) => route.fulfill({ json: [{ ...conversation, status: detail.status }] }));
  await page.route(`**/api/v1/ai/conversations/${conversation.id}`, (route) => route.fulfill({ json: detail }));
  return `/assistant/${conversation.id}`;
}
