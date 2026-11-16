import type { ChatStreamEvent } from '@a4a/shared';
import type Anthropic from '@anthropic-ai/sdk';
import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createConversation, getConversation, sendMessage } from '../src/ai/chat/agent';
import { aiService, setClaudeClientForTests, structured, type ClaudeClient } from '../src/ai/client';
import { wordsToCommand } from '../src/ai/nl';
import { AI_PROVIDERS } from '../src/ai/providers';
import { runCommand } from '../src/commands/executor';
import { aiSettings } from '../src/config';
import type { AppServices } from '../src/context';
import { aiMessages } from '../src/db/schema';
import { withFixes } from '../src/search/lexer';
import { listComments } from '../src/services/comments';
import { createIssue } from '../src/services/issues';
import { createWorld, type TestWorld } from './helpers';

// ---------------------------------------------------------------------------
// A scripted stand-in for an Anthropic-compatible service: forced tool calls pop
// `answers`, streamed calls pop `turns`. It has no structured outputs.
// ---------------------------------------------------------------------------

type Scripted = { content: Record<string, unknown>[]; stop_reason: string };
const script = { answers: [] as Scripted[], turns: [] as Scripted[], requests: [] as Record<string, unknown>[] };
const MODEL = 'deepseek-v4-pro';

const message = (m: Scripted) => ({ id: 'msg_fake', type: 'message', role: 'assistant', model: MODEL, content: m.content, stop_reason: m.stop_reason, stop_details: null, usage: { input_tokens: 10, output_tokens: 5 } });
const answer = (input: unknown): Scripted => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tu_${script.answers.length}`, name: 'answer', input }] });

const fake = {
  beta: {
    messages: {
      create: async (body: Record<string, unknown>) => {
        script.requests.push(structuredClone(body));
        const next = script.answers.shift();
        if (!next) throw new Error('no scripted answer left');
        return message(next);
      },
      stream: (body: Record<string, unknown>) => {
        script.requests.push(structuredClone(body));
        const next = script.turns.shift();
        if (!next) throw new Error('no scripted turn left');
        const events = next.content.flatMap((b, index): Record<string, unknown>[] =>
          b.type === 'text' ? [{ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } }] : b.type === 'thinking' ? [{ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.thinking } }] : [],
        );
        return {
          async *[Symbol.asyncIterator]() {
            for (const e of events) yield e;
          },
          finalMessage: async () => message(next),
        };
      },
      parse: async () => {
        throw new Error('structured outputs are only asked of Claude');
      },
    },
  },
} as unknown as ClaudeClient;

let w: TestWorld;
let issueId = '';

beforeAll(async () => {
  w = await createWorld();
  w.app.config.aiModel = MODEL;
  setClaudeClientForTests(fake, AI_PROVIDERS.deepseek);
  issueId = (await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Checkout page crashes on Safari', fields: { Type: 'Bug' } })).id;
});

afterEach(() => {
  script.answers = [];
  script.turns = [];
  script.requests = [];
});

afterAll(async () => {
  setClaudeClientForTests(null);
  await w?.close();
});

describe('structured answers from other services', () => {
  it('come from a forced tool call, without Claude\'s own request features', async () => {
    script.answers.push(answer({ value: 'x' }));
    const out = await structured(w.app, { system: 's', prompt: 'p', schema: z.object({ value: z.string() }) });
    expect(out).toEqual({ output: { value: 'x' }, model: MODEL });
    const req = script.requests[0]!;
    expect(req).toMatchObject({ model: MODEL, thinking: { type: 'disabled' }, tool_choice: { type: 'tool', name: 'answer' } });
    for (const claudeOnly of ['betas', 'fallbacks', 'output_config']) expect(req).not.toHaveProperty(claudeOnly);
  });

  it('take a left-out key as null, where the schema allows null', async () => {
    const schema = z.object({
      command: z.string(),
      comment: z.string().nullable(),
      fields: z.object({ Assignee: z.object({ value: z.enum(['anna', 'ben']).nullable(), reason: z.string() }) }),
    });
    script.answers.push(answer({ command: 'tag regression', fields: { Assignee: { reason: 'Not stated' } } }));
    const { output } = await structured(w.app, { system: 's', prompt: 'p', schema });
    expect(output).toEqual({ command: 'tag regression', comment: null, fields: { Assignee: { value: null, reason: 'Not stated' } } });
    expect(script.requests).toHaveLength(1);
  });

  it('are repaired once, in words that say what is missing', async () => {
    const schema = z.object({ priority: z.enum(['Major', 'Minor']), reason: z.string() });
    script.answers.push(answer({ priority: 'Huge' }), answer({ priority: 'Major', reason: 'Blocks payments' }));
    const { output } = await structured(w.app, { system: 's', prompt: 'p', schema });
    expect(output).toEqual({ priority: 'Major', reason: 'Blocks payments' });
    const repair = (script.requests[1] as { messages: { role: string; content: unknown }[] }).messages;
    expect(repair.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const result = (repair[2]!.content as { type: string; is_error: boolean; content: string }[])[0]!;
    expect(result).toMatchObject({ type: 'tool_result', is_error: true });
    expect(result.content).toContain('reason: missing');
    expect(result.content).toContain('priority:');
  });

  it('give up after the repair round, and say when they were cut off', async () => {
    const schema = z.object({ priority: z.enum(['Major', 'Minor']) });
    script.answers.push(answer({ priority: 'Huge' }), answer({ priority: 'Huger' }));
    await expect(structured(w.app, { system: 's', prompt: 'p', schema })).rejects.toMatchObject({ code: 'ai_unparseable' });
    script.answers.push({ stop_reason: 'max_tokens', content: [] });
    await expect(structured(w.app, { system: 's', prompt: 'p', schema })).rejects.toMatchObject({ code: 'ai_truncated' });
  });
});

describe('commands from words', () => {
  it('lift a comment out of the command, and repair an issue id with the parser\'s fix', async () => {
    script.answers.push(answer({ command: `${issueId} tag regression comment I am looking into it`, comment: null, explanation: 'Tags it and comments.' }));
    script.answers.push(answer({ command: 'tag regression', comment: 'I am looking into it', explanation: 'Tags it and comments.' }));
    const res = await wordsToCommand(w.as(w.anna), 'tag it regression and say in a comment that I am looking into it', [issueId]);
    expect(res).toMatchObject({ command: 'tag regression', comment: 'I am looking into it' });
    expect(res.preview.problems).toEqual([]);
    const second = String((script.requests[1] as { messages: { content: string }[] }).messages[0]!.content);
    expect(second).toContain(`"${issueId}" is an issue id, not a command`);
    expect(second).toContain("With the parser's fixes it reads: tag regression");
  });

  it('name an issue id where a command word should be, with a fix that takes it out', async () => {
    const command = `${issueId} Priority Major`;
    const res = await runCommand(w.as(w.anna), { issues: [issueId], command, dryRun: true });
    expect(res.problems).toHaveLength(1);
    expect(res.problems[0]!.message).toBe(`"${issueId}" is an issue id, not a command`);
    expect(withFixes(command, res.problems)).toBe('Priority Major');
  });

  it('post the same words once, given both in the command and as its comment', async () => {
    await runCommand(w.as(w.anna), { issues: [issueId], command: 'comment On it, after lunch', comment: 'On it, after lunch' });
    const comments = await listComments(w.as(w.anna), issueId);
    expect(comments.at(-1)!.text).toBe('On it, after lunch');
  });
});

describe('the assistant on another service', () => {
  it('sends the portable request, and keeps raw reasoning out of the transcript', async () => {
    const ctx = w.as(w.anna);
    const conv = await createConversation(ctx, {});
    script.turns.push({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'The user greets me. I should greet back.', signature: 'sig' }, { type: 'text', text: 'Hello.' }] });
    const events: ChatStreamEvent[] = [];
    await sendMessage(ctx, conv.id, { text: 'Hello' }, (e) => events.push(e));

    const req = script.requests[0] as Record<string, unknown>;
    expect(req).toMatchObject({ model: MODEL, thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } });
    expect(req.thinking).toEqual({ type: 'adaptive' });
    for (const claudeOnly of ['betas', 'fallbacks', 'cache_control']) expect(req).not.toHaveProperty(claudeOnly);
    expect(events.some((e) => e.type === 'progress')).toBe(false);

    const detail = await getConversation(ctx, conv.id);
    expect(detail.messages.flatMap((m) => m.parts)).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'Hello.' },
    ]);
    const rows = await w.app.db.select().from(aiMessages).where(eq(aiMessages.conversationId, conv.id)).orderBy(asc(aiMessages.id));
    expect(rows[1]!.meta).toEqual({ reasoning: 'raw' });
    expect((rows[1]!.content as { type: string }[]).map((b) => b.type)).toEqual(['thinking', 'text']); // kept, to send back
  });

  it('drops stored thinking once when the provider or model changes', async () => {
    const ctx = w.as(w.anna);
    const conv = await createConversation(ctx, {});
    script.turns.push({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'Reasoning.', signature: 'sig' }, { type: 'text', text: 'First.' }] });
    await sendMessage(ctx, conv.id, { text: 'One' }, () => {});
    script.turns.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Second.' }] });
    await sendMessage(ctx, conv.id, { text: 'Two' }, () => {});
    // Same model: its thinking goes back unchanged.
    const same = (script.requests[1] as { messages: { role: string; content: { type: string }[] }[] }).messages;
    expect(same[1]!.content.map((b) => b.type)).toEqual(['thinking', 'text']);

    setClaudeClientForTests(fake, AI_PROVIDERS.qwen);
    w.app.config.aiModel = 'qwen3.8-max';
    try {
      script.turns.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Third.' }] });
      await sendMessage(ctx, conv.id, { text: 'Three' }, () => {});
      const switched = (script.requests[2] as { messages: { role: string; content: { type: string }[] }[] }).messages;
      expect(switched[1]!.content.map((b) => b.type)).toEqual(['text']);
    } finally {
      setClaudeClientForTests(fake, AI_PROVIDERS.deepseek);
      w.app.config.aiModel = MODEL;
    }
  });
});

describe('choosing a provider', () => {
  it('is never inferred from which keys are set, and says why the AI is off', () => {
    expect(aiSettings({ ANTHROPIC_API_KEY: 'k', DEEPSEEK_API_KEY: 'k' })).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5', offReason: null });
    expect(aiSettings({ DEEPSEEK_API_KEY: 'k' })).toMatchObject({ provider: 'anthropic', offReason: 'ANTHROPIC_API_KEY is not set on the server' });
    expect(aiSettings({ AI_PROVIDER: 'DeepSeek', DEEPSEEK_API_KEY: 'k' })).toMatchObject({ provider: 'deepseek', model: 'deepseek-v4-pro', offReason: null });
    expect(aiSettings({ AI_PROVIDER: 'deepseek' })).toMatchObject({ offReason: 'DEEPSEEK_API_KEY is not set on the server' });
    expect(aiSettings({ AI_PROVIDER: 'qwen', DASHSCOPE_API_KEY: 'k', AI_MODEL: 'qwen3.8-flash' })).toMatchObject({ provider: 'qwen', model: 'qwen3.8-flash', offReason: null });
    expect(aiSettings({ AI_PROVIDER: 'compatible', AI_API_KEY: 'k', AI_MODEL: 'm' })).toMatchObject({ offReason: 'AI_BASE_URL is not set on the server' });
    expect(aiSettings({ AI_PROVIDER: 'compatible', AI_API_KEY: 'k', AI_BASE_URL: 'https://llm.example.com' })).toMatchObject({ offReason: 'AI_MODEL is not set on the server' });
    expect(aiSettings({ AI_PROVIDER: 'gpt', ANTHROPIC_API_KEY: 'k' }).offReason).toMatch(/^AI_PROVIDER is "gpt", which a4a doesn't know/);
    expect(aiSettings({ AI_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'k', AI_DISABLED: 'true' }).offReason).toBe('AI_DISABLED is set on the server');
  });

  it('never sends an Anthropic credential to another service', async () => {
    const saved = { ...process.env };
    const realFetch = globalThis.fetch;
    const seen: { url: string; headers: Headers }[] = [];
    Object.assign(process.env, { DEEPSEEK_API_KEY: 'sk-deepseek-test', ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_AUTH_TOKEN: 'anthropic-token-test', ANTHROPIC_BASE_URL: 'https://gateway.example.com' });
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify(message({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] })), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      setClaudeClientForTests(null);
      const app = { ...w.app, config: { ...w.app.config, aiProvider: 'deepseek', aiBaseUrl: undefined, aiEnabled: true } } as unknown as AppServices;
      const ai = aiService(app)!;
      expect(ai.provider.id).toBe('deepseek');
      await (ai.client as Anthropic).beta.messages.create({ model: MODEL, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      expect(seen).toHaveLength(1);
      expect(new URL(seen[0]!.url).host).toBe('api.deepseek.com');
      const values = [...seen[0]!.headers.values()].join('\n');
      expect(values).toContain('sk-deepseek-test');
      expect(values).not.toContain('sk-ant-test');
      expect(values).not.toContain('anthropic-token-test');
    } finally {
      globalThis.fetch = realFetch;
      for (const k of ['DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      setClaudeClientForTests(fake, AI_PROVIDERS.deepseek);
    }
  });
});
