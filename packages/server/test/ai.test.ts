import type { ChatStreamEvent } from '@tracklet/shared';
import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createConversation, decide, getConversation, sanitizeFallback, sendMessage } from '../src/ai/chat/agent';
import { setClaudeClientForTests, type ClaudeClient } from '../src/ai/client';
import { wordsToQuery } from '../src/ai/nl';
import { applySuggestion, triageConsumer, triageIssue } from '../src/ai/triage';
import { systemCtx } from '../src/app-services';
import { aiMessages, users } from '../src/db/schema';
import { createIssue, getIssue } from '../src/services/issues';
import { updateProject } from '../src/services/projects';
import { searchIssues } from '../src/search/service';
import { createWorld, type TestWorld } from './helpers';

// ---------------------------------------------------------------------------
// A scripted stand-in for the SDK client: structured calls pop `parsed`, streamed
// calls pop `turns`. Every request body is recorded.
// ---------------------------------------------------------------------------

type Turn = { content: Record<string, unknown>[]; stop_reason: string };
const script = { parsed: [] as unknown[], turns: [] as Turn[], requests: [] as Record<string, unknown>[] };

function fakeStream(turn: Turn) {
  const message = { id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: turn.content, stop_reason: turn.stop_reason, stop_details: null, usage: { input_tokens: 10, output_tokens: 5 } };
  const events = turn.content.flatMap((b, index) =>
    b.type === 'text' ? [{ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } }] : b.type === 'thinking' ? [{ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.thinking } }] : [],
  );
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
    finalMessage: async () => message,
  };
}

const fake = {
  beta: {
    messages: {
      parse: async (body: Record<string, unknown>) => {
        script.requests.push(body);
        const next = script.parsed.shift();
        if (next === undefined) throw new Error('no scripted structured output left');
        return { stop_reason: 'end_turn', stop_details: null, parsed_output: next, model: 'claude-opus-5-5', content: [] };
      },
      stream: (body: Record<string, unknown>) => {
        script.requests.push(structuredClone(body));
        const next = script.turns.shift();
        if (!next) throw new Error('no scripted turn left');
        return fakeStream(next);
      },
    },
  },
} as unknown as ClaudeClient;

let w: TestWorld;
let issueId = '';

beforeAll(async () => {
  w = await createWorld();
  setClaudeClientForTests(fake);
  const issue = await createIssue(w.as(w.anna), {
    project: 'BACK',
    summary: 'Checkout page crashes on Safari',
    description: 'Clicking Pay shows a white screen.',
    fields: { Type: 'Bug' },
  });
  issueId = issue.id;
});

afterEach(() => {
  script.parsed = [];
  script.turns = [];
  script.requests = [];
});

afterAll(async () => {
  setClaudeClientForTests(null);
  await w?.close();
});

describe('words to query', () => {
  it('repairs an invalid query once, using the parser\'s own words', async () => {
    script.parsed.push({ query: 'Prio: Critical #Unresolved', explanation: 'Critical open issues' });
    script.parsed.push({ query: 'Priority: Critical #Unresolved', explanation: 'Critical open issues' });
    const res = await wordsToQuery(w.as(w.anna), 'critical stuff that is still open');
    expect(res).toMatchObject({ query: 'Priority: Critical #Unresolved', valid: true, problems: [] });
    expect(String((script.requests[1] as { messages: { content: string }[] }).messages[0]!.content)).toContain('Unknown field "Prio"');
    expect(script.requests[0]).toMatchObject({ model: 'claude-opus-5-5', betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: { effort: 'low' } });
  });
});

describe('triage', () => {
  it('stores a suggestion constrained to the project\'s values, and applies it on request', async () => {
    script.parsed.push({
      fields: {
        Priority: { value: 'Critical', confidence: 'high', reason: 'Checkout is broken for Safari users' },
        Type: { value: 'Bug', confidence: 'high', reason: 'A crash' },
        Assignee: { value: 'anna', confidence: 'medium', reason: 'Owns the web checkout' },
        Subsystem: { value: null, confidence: 'low', reason: 'Not stated' },
      },
      summary: 'A Safari-only crash in checkout; urgent because it blocks payment.',
    });
    const s = await triageIssue(w.as(w.anna), issueId);
    expect(s.status).toBe('pending');
    expect(s.payload.fields.map((f) => f.name).sort()).toEqual(['Assignee', 'Priority', 'Type']);
    const schema = JSON.stringify((script.requests[0] as { output_config: { format: unknown } }).output_config.format);
    expect(schema).toContain('Show-stopper');
    const applied = await applySuggestion(w.as(w.ben), s.id, { fields: ['Priority'] });
    expect(applied.status).toBe('partially_applied');
    const issue = await getIssue(w.as(w.ben), issueId);
    expect(issue.fields.find((f) => f.name === 'Priority')!.value).toMatchObject({ name: 'Critical' });
    expect(issue.fields.find((f) => f.name === 'Assignee')!.value).toBeNull();
  });

  it('in auto mode fills only what the reporter left at its default', async () => {
    await updateProject(w.adminCtx, 'BACK', { settings: { triageMode: 'auto' } });
    const created = await createIssue(w.as(w.ben), { project: 'BACK', summary: 'Export to CSV times out', fields: { Priority: 'Minor' } });
    script.parsed.push({
      fields: {
        Priority: { value: 'Major', confidence: 'high', reason: 'Customers rely on exports' },
        Type: { value: 'Bug', confidence: 'high', reason: 'A timeout' },
        Assignee: { value: 'ben', confidence: 'low', reason: 'Guess' },
        Subsystem: { value: 'API', confidence: 'medium', reason: 'The export endpoint' },
      },
      summary: 'Export timeouts.',
    });
    const s = await w.app.schema.get();
    const consumer = triageConsumer(w.app)!;
    await consumer.handle({
      id: 1,
      type: 'issue.created',
      occurredAt: new Date().toISOString(),
      actor: { id: w.ben.id, login: 'ben', name: 'Ben Okafor', channel: 'api', token: null },
      project: 'BACK',
      issue: { id: created.id, summary: created.summary, resolved: false, state: 'Open' },
      changes: [],
      data: { explicitFields: ['Priority'] },
    });
    void s;
    const issue = await getIssue(w.as(w.ben), created.id);
    const field = (n: string) => issue.fields.find((f) => f.name === n)!.value as { name?: string; login?: string } | null;
    expect(field('Priority')).toMatchObject({ name: 'Minor' }); // the reporter's choice stands
    expect(field('Type')).toMatchObject({ name: 'Bug' }); // a default, so the agent may set it
    expect(field('Subsystem')).toMatchObject({ name: 'API' });
    expect(field('Assignee')).toBeNull(); // low confidence: left as a suggestion
    const [bot] = await w.app.db.select().from(users).where(eq(users.login, 'triage'));
    const history = await searchIssues(systemCtx(w.app, bot!), `updated by: triage`, 0, 10);
    expect(history.items.map((i) => i.id)).toContain(created.id);
    await updateProject(w.adminCtx, 'BACK', { settings: { triageMode: 'suggest' } });
  });
});

describe('assistant', () => {
  it('pauses writes for approval, then continues with every result in one message', async () => {
    const ctx = w.as(w.anna);
    const conv = await createConversation(ctx, { project: 'BACK' });
    script.turns.push({
      stop_reason: 'tool_use',
      content: [
        { type: 'thinking', thinking: 'Find the issue, then raise its priority.', signature: 'sig-1' },
        { type: 'tool_use', id: 'tu_read', name: 'search_issues', input: { query: 'project: BACK Safari' } },
        { type: 'tool_use', id: 'tu_write', name: 'update_issue', input: { issue: issueId, fields: { Priority: 'Show-stopper' } } },
      ],
    });
    const events: ChatStreamEvent[] = [];
    await sendMessage(ctx, conv.id, { text: 'Make the Safari checkout crash a show-stopper', context: { issue: issueId } }, (e) => events.push(e));

    const approval = events.find((e) => e.type === 'approval_required');
    expect(approval).toBeDefined();
    expect(approval!.type === 'approval_required' && approval!.approvals[0]!.preview).toBe(`${issueId}: Priority Critical → Show-stopper`);
    expect(events.find((e) => e.type === 'tool_result' && e.id === 'tu_read')).toMatchObject({ ok: true });
    expect(events.at(-1)).toEqual({ type: 'done', status: 'awaiting_approval' });
    expect((await getIssue(ctx, issueId)).fields.find((f) => f.name === 'Priority')!.value).toMatchObject({ name: 'Critical' });

    const req = script.requests[0] as Record<string, unknown> & { tools: { name: string; eager_input_streaming?: boolean }[]; messages: { content: { text?: string }[] }[] };
    expect(req).toMatchObject({
      model: 'claude-opus-5-5',
      betas: ['server-side-fallback-2026-07-01', 'thinking-display-updates-2026-08-18'],
      fallbacks: 'default',
      thinking: { type: 'adaptive', display: 'updates' },
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
    });
    expect(req.tools.every((t) => t.eager_input_streaming)).toBe(true);
    expect(req.tools.map((t) => t.name)).not.toContain('delete_issue');
    expect(req.messages[0]!.content[0]!.text).toContain(`looking at issue ${issueId}`);

    const detail = await getConversation(ctx, conv.id);
    expect(detail.status).toBe('awaiting_approval');
    expect(detail.pendingApprovals).toHaveLength(1);

    script.turns.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: `${issueId} is now a Show-stopper.` }] });
    const after: ChatStreamEvent[] = [];
    await decide(ctx, conv.id, [{ toolUseId: 'tu_write', approve: true }], (e) => after.push(e));
    expect(after.at(-1)).toEqual({ type: 'done', status: 'idle' });
    expect((await getIssue(ctx, issueId)).fields.find((f) => f.name === 'Priority')!.value).toMatchObject({ name: 'Show-stopper' });

    // The second request replays history verbatim: thinking block included, both results in one user message, in order.
    const replay = (script.requests[1] as { messages: { role: string; content: Record<string, unknown>[] }[] }).messages;
    expect(replay.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(replay[1]!.content[0]).toEqual({ type: 'thinking', thinking: 'Find the issue, then raise its priority.', signature: 'sig-1' });
    expect(replay[2]!.content.map((b) => b.tool_use_id)).toEqual(['tu_read', 'tu_write']);

    const rows = await w.app.db.select().from(aiMessages).where(eq(aiMessages.conversationId, conv.id)).orderBy(asc(aiMessages.id));
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const final = await getConversation(ctx, conv.id);
    const tools = final.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool');
    expect(tools.map((t) => t.type === 'tool' && t.status)).toEqual(['done', 'done']);
    expect(final.messages.at(-1)!.parts[0]).toEqual({ type: 'text', text: `${issueId} is now a Show-stopper.` });
    // History shows the change came through the assistant, as Anna.
    const activity = await w.app.db.query.activities.findMany({ orderBy: (a, { desc }) => [desc(a.id)], limit: 1 });
    expect(activity[0]).toMatchObject({ type: 'issue.updated', channel: 'assistant', actorId: w.anna.id });
  });

  it('tells the model when the person declines', async () => {
    const ctx = w.as(w.anna);
    const conv = await createConversation(ctx, {});
    script.turns.push({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_c', name: 'add_comment', input: { issue: issueId, text: 'Bumped.' } }] });
    await sendMessage(ctx, conv.id, { text: 'Comment that I bumped it' }, () => {});
    script.turns.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'All right, I left it.' }] });
    await decide(ctx, conv.id, [{ toolUseId: 'tu_c', approve: false }], () => {});
    const replay = (script.requests[1] as { messages: { content: Record<string, unknown>[] }[] }).messages.at(-1)!;
    expect(String(replay.content[0]!.content)).toContain('declined');
    const detail = await getConversation(ctx, conv.id);
    expect(detail.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool')).toMatchObject({ status: 'rejected' });
  });

  it('drops model-internal blocks before a fallback boundary', () => {
    const out = sanitizeFallback([
      { type: 'thinking', thinking: 'x', signature: 's' },
      { type: 'text', text: 'partial' },
      { type: 'tool_use', id: 't1', name: 'get_issue', input: {} },
      { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } },
      { type: 'text', text: 'rest' },
    ] as never);
    expect(out.map((b) => b.type)).toEqual(['text', 'fallback', 'text']);
  });
});
