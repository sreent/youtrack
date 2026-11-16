/**
 * The AI, stood in for in the browser. The run's server has no Claude key, so its AI endpoints
 * answer 503; a flow that needs one has it answered here (`page.route`) with what the server
 * would send, typed by the contract. What the server does with Claude is tested in its own
 * vitest suite (packages/server/test/ai.test.ts), with a fake client.
 */
import type { Page, Route } from '@playwright/test';
import type { ChatStreamEvent, Conversation, ConversationDetail, IssueDetail, NLQueryResult, Suggestion, TriagePayload } from '@a4a/shared';
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
    await route.fulfill({ json: { summary, model: 'claude-opus-5-5' } });
  });
  return { asked: () => asked };
}

/**
 * A triage suggestion waiting on an issue (GET /issues/{id}/suggestions), and accepting it a value
 * at a time (POST /suggestions/{id}/apply). Applying is the server's work; here the stand-in makes
 * the same change to the issue through the API, so the page reads the issue as it would be.
 */
export async function mockTriage(page: Page, api: Api, issue: IssueDetail, payload: TriagePayload) {
  const id = `sugg-e2e-${unique()}`;
  const accepted = new Set<string>();
  const applied: string[][] = [];
  const suggestion = (): Suggestion => ({
    id,
    issueId: issue.id,
    kind: 'triage',
    status: accepted.size === 0 ? 'pending' : accepted.size < payload.fields.length ? 'partially_applied' : 'applied',
    payload,
    model: 'claude-opus-5-5',
    createdAt: NOW.toISOString(),
    resolvedAt: null,
    resolvedBy: null,
  });
  await page.route(`**/api/v1/issues/${issue.id}/suggestions`, (route) => route.fulfill({ json: [suggestion()] }));
  await page.route(`**/api/v1/suggestions/${id}/apply`, async (route) => {
    const body = route.request().postDataJSON() as { fields?: string[] };
    const names = body.fields ?? payload.fields.map((f) => f.name);
    applied.push(names);
    await api.updateIssue(issue.id, { fields: Object.fromEntries(payload.fields.filter((f) => names.includes(f.name)).map((f) => [f.name, f.value])) });
    names.forEach((n) => accepted.add(n));
    await route.fulfill({ json: suggestion() });
  });
  return { applied };
}

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
 * The assistant's conversation endpoints: a new conversation, the person's message (a streamed
 * turn that ends waiting on them), their decisions (one request, a streamed turn), and the
 * conversation read back after each. Keeps what the page sent.
 */
export async function mockAssistant(page: Page, script: AssistantScript) {
  const conversation: Conversation = {
    id: `conv-e2e-${unique()}`,
    title: script.title,
    project: script.project,
    status: 'idle',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
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
