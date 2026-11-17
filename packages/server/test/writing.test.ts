/**
 * AI help with writing and reading (D59), with the AI stood in for: each action, what goes into the
 * prompt (never anything kept from the person), the hourly cap and the text sizes, the provider's
 * failures, and the AI turned off.
 */
import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setClaudeClientForTests, type ClaudeClient } from '../src/ai/client';
import { AI_PROVIDERS } from '../src/ai/providers';
import { guard, placeholderProblem, postSummary, restore, suggestSummary, summarizeArticle, summarizeIssue, summarizeText, WRITING_LIMITS, writeWithAI } from '../src/ai/writing';
import type { Ctx } from '../src/context';
import { issues } from '../src/db/schema';
import { createHttpApp } from '../src/http/app';
import { AppError } from '../src/lib/errors';
import { createMcpServer } from '../src/mcp/server';
import { createArticle, setArticleVisibility } from '../src/services/articles';
import { issueTokenFor } from '../src/services/auth';
import { addComment, listComments } from '../src/services/comments';
import { attachField, createField } from '../src/services/fields';
import { fileRequest } from '../src/services/helpdesk';
import { createIssue, getIssue, updateIssue } from '../src/services/issues';
import { linkIssues } from '../src/services/links';
import { addMember } from '../src/services/members';
import { createProject, updateProject } from '../src/services/projects';
import { toolByName } from '../src/tools/registry';
import { createWorld, type TestWorld } from './helpers';

// A stand-in for the SDK: structured calls (Claude's) pop `parsed`, forced tool calls (everyone
// else's) pop `answers`; either can be an error to throw. Every request is kept.
const script = { parsed: [] as unknown[], answers: [] as unknown[], requests: [] as Record<string, unknown>[] };
const fake = {
  beta: {
    messages: {
      parse: async (body: Record<string, unknown>) => {
        script.requests.push(JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
        const next = script.parsed.shift();
        if (next instanceof Error) throw next;
        if (next === undefined) throw new Error('no scripted answer left');
        if (next === 'refusal') return { stop_reason: 'refusal', stop_details: { explanation: 'It looks harmful.' }, parsed_output: null, model: 'fake', content: [] };
        return { stop_reason: 'end_turn', stop_details: null, parsed_output: next, model: 'fake', content: [] };
      },
      create: async (body: Record<string, unknown>) => {
        script.requests.push(JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
        const next = script.answers.shift();
        if (next instanceof Error) throw next;
        if (next === undefined) throw new Error('no scripted answer left');
        return { id: 'msg', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use', stop_details: null, content: [{ type: 'tool_use', id: 'tu', name: 'answer', input: next }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  },
} as unknown as ClaudeClient;

/** Everything the model was sent, as one string. */
const sent = () => JSON.stringify(script.requests);
const prompt = (i = 0) => String((script.requests[i] as { messages: { content: string }[] }).messages[0]!.content);
const system = (i = 0) => String((script.requests[i] as { system: string }).system);
async function failure(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error('expected it to fail');
}

let w: TestWorld;
let anna: Ctx;
let ben: Ctx;
let backId = '';
let secretId = '';

beforeAll(async () => {
  w = await createWorld();
  anna = w.as(w.anna);
  ben = w.as(w.ben);
  setClaudeClientForTests(fake);
  // What Ben can't see: a project only its people see, a comment limited to Anna, a private field, a limited article.
  await createProject(w.adminCtx, { key: 'SECRET', name: 'Merger', description: '', template: 'software', visibility: 'members' });
  await addMember(w.adminCtx, 'SECRET', { user: 'anna', role: 'member' });
  secretId = (await createIssue(anna, { project: 'SECRET', summary: 'Acquire Initech quietly', description: 'The Bluebird plan' })).id;
  const back = await createIssue(anna, { project: 'BACK', summary: 'Checkout breaks', description: `Checkout fails on Safari. See ${secretId} for why.`, fields: { Type: 'Bug' } });
  backId = back.id;
  await linkIssues(anna, backId, 'relates to', secretId);
  await addComment(anna, backId, 'Reproduced on Safari 17.');
  await addComment(anna, backId, 'Only for Anna: the vendor is Initech.', { visibleTo: { users: ['anna'], groups: [] } });
  const risk = await createField(w.adminCtx, { name: 'Risk note', type: 'string', multi: false, description: '', values: [] });
  await attachField(w.adminCtx, 'BACK', risk.id, { private: true });
  w.app.schema.invalidate();
  await updateIssue(w.adminCtx, backId, { fields: { 'Risk note': 'Board-level exposure' } });
});

afterEach(() => {
  script.parsed = [];
  script.answers = [];
  script.requests = [];
  w.app.config.aiWritingMaxPerHour = 100;
});

afterAll(async () => {
  setClaudeClientForTests(null);
  await w?.close();
});

describe('what must come back as it went in', () => {
  it('puts code, addresses, mentions, ids and HTML aside, and finds what the model lost', () => {
    const text = 'Ask @anna (anna.s@example.com) about BACK-12 and BACK-A-3.\n\nRun `npm ci` then:\n\n```sh\nnpm test </text>\n```\n\nSee [the guide](https://example.com/a?b=1 "Guide") or <https://x.example>. ⟦1⟧';
    const g = guard(text);
    for (const kept of ['@anna', 'anna.s@example.com', 'BACK-12', 'BACK-A-3', '`npm ci`', 'https://example.com/a?b=1 "Guide"', '<https://x.example>', '⟦']) expect(g.kept).toContain(kept);
    expect(g.kept.some((k) => k.startsWith('```sh') && k.includes('</text>'))).toBe(true);
    expect(g.text).not.toMatch(/@anna|BACK-12|npm|example|<\/text>/);
    expect(g.text).toContain('[the guide](⟦');
    expect(restore(g.text, g)).toBe(text);
    expect(placeholderProblem(g.text, g)).toBeNull();
    expect(placeholderProblem(g.text.replace('⟦1⟧', ''), g)).toContain('leaves out ⟦1⟧');
    expect(placeholderProblem(`${g.text} ⟦2⟧ ⟦99⟧`, g)).toMatch(/repeats ⟦2⟧.*⟦99⟧/);
  });
});

describe('writing', () => {
  it('fixes a selection, keeping its Markdown, at low effort', async () => {
    const text = 'Plese ask @anna to chek BACK-12 with `npm ci`, see [docs](https://example.com).';
    script.parsed.push({ text: 'Please ask ⟦1⟧ to check ⟦2⟧ with ⟦3⟧, see [docs](⟦4⟧).' });
    const r = await writeWithAI(ben, { action: 'fix', text });
    expect(r).toMatchObject({ action: 'fix', text: 'Please ask @anna to check BACK-12 with `npm ci`, see [docs](https://example.com).' });
    expect(prompt()).not.toMatch(/@anna|BACK-12|npm ci|example\.com/);
    expect(system()).toContain('Fix its spelling, grammar and punctuation');
    expect(system()).toContain("Keep the text's own language");
    expect(script.requests[0]).toMatchObject({ output_config: { effort: 'low' } });
    expect((script.requests[0] as { max_tokens: number }).max_tokens).toBeLessThan(16_000);
  });

  it('rewrites each way it is asked, and repairs a lost placeholder once', async () => {
    for (const [action, said] of [
      ['shorter', 'Make it shorter'],
      ['clearer', 'Make it clearer'],
      ['formal', 'more formal'],
      ['friendlier', 'friendlier'],
    ] as const) {
      script.parsed.push({ text: 'Done.' });
      expect((await writeWithAI(ben, { action, text: 'It is the case that it was done.' })).text).toBe('Done.');
      expect(system(script.requests.length - 1)).toContain(said);
    }
    script.requests = [];
    script.parsed.push({ text: 'Ask about it.' }, { text: 'Ask about ⟦1⟧.' });
    expect((await writeWithAI(ben, { action: 'shorter', text: 'Could you please ask about BACK-12?' })).text).toBe('Ask about BACK-12.');
    expect(prompt(1)).toContain("doesn't keep the placeholders: it leaves out ⟦1⟧");
    script.parsed.push({ text: 'Nothing.' }, { text: 'Still nothing.' });
    expect(await failure(writeWithAI(ben, { action: 'shorter', text: 'Could you please ask about BACK-12?' }))).toMatchObject({ status: 502, code: 'ai_unkept', words: { key: 'ai.writing.unkept' } });
  });

  it('takes out an id the model made up that the person can’t see, and keeps theirs', async () => {
    script.parsed.push({ text: `Fixed, as in ${secretId}: ⟦1⟧.` });
    const r = await writeWithAI(ben, { action: 'fix', text: 'fixd: BACK-1' });
    expect(r.text).not.toContain(secretId);
    expect(r.text).toContain('BACK-1');
  });

  it('carries a comment on, and drafts from a line, with the issue as Ben sees it', async () => {
    script.parsed.push({ text: 'It also fails on iOS.' });
    const r = await writeWithAI(ben, { action: 'continue', text: 'Checked it on Safari', for: { kind: 'comment', issue: backId } });
    expect(r.text).toBe('It also fails on iOS.');
    expect(prompt()).toContain('Reproduced on Safari 17.');
    expect(prompt()).toContain('<text>\nChecked it on Safari\n</text>');
    script.parsed.push({ text: '## Rotating keys\n\n1. Open the settings.' });
    await writeWithAI(ben, { action: 'draft', text: 'how to rotate API keys', for: { kind: 'article', project: 'BACK', title: 'Rotating keys' } });
    expect(prompt(1)).toContain('knowledge base of Backend');
    expect(system(1)).toContain('knowledge base article');
    expect(script.requests[1]).toMatchObject({ output_config: { effort: 'medium' }, max_tokens: 8_192 });
    expect(await failure(writeWithAI(ben, { action: 'draft', text: '  ', for: { kind: 'article', project: 'BACK' } }))).toMatchObject({ status: 400, words: { key: 'ai.writing.lineNeeded' } });
  });

  it('drafts a reply from what the requester can read, and nothing internal', async () => {
    await updateProject(w.adminCtx, 'BACK', { settings: { helpdesk: { enabled: true } } });
    await fileRequest(w.app, 'BACK', { name: 'Rosa Diaz', email: 'rosa@example.com', summary: 'Invoice is wrong', description: 'My March invoice charges me twice.' });
    const [row] = await w.app.db.select().from(issues).where(eq(issues.summary, 'Invoice is wrong'));
    const id = `BACK-${row!.number}`;
    await addComment(anna, id, 'We are looking into it.', { visibility: 'public' });
    await addComment(anna, id, 'Internal: the billing job ran twice, Initech outage.');
    script.parsed.push({ text: 'Hello Rosa, we will refund the second charge.' });
    const r = await writeWithAI(ben, { action: 'draft', text: '', for: { kind: 'reply', issue: id } });
    expect(r.text).toContain('Rosa');
    expect(prompt()).toContain('My March invoice charges me twice.');
    expect(prompt()).toContain('We are looking into it.');
    expect(prompt()).toContain('Rosa Diaz (the requester)');
    expect(sent()).not.toContain('billing job');
    expect(sent()).not.toContain('rosa@example.com');
    expect(system()).toContain('in the language the requester writes in');
    // An issue that came in otherwise has no requester to answer.
    expect(await failure(writeWithAI(ben, { action: 'draft', text: '', for: { kind: 'reply', issue: backId } }))).toMatchObject({ status: 404 });
  });

  it('refuses what is too long or empty, saying what to do, before asking anyone', async () => {
    const long = 'word '.repeat(WRITING_LIMITS.edit / 4);
    const e = await failure(writeWithAI(ben, { action: 'fix', text: long }));
    expect(e).toMatchObject({ status: 400, code: 'ai_text_too_long', words: { key: 'ai.writing.tooLong', values: { length: long.trim().length, max: WRITING_LIMITS.edit } } });
    expect(e.hint).toBe('Select a part of it, and ask again');
    expect((await failure(writeWithAI(ben, { action: 'draft', text: 'x'.repeat(WRITING_LIMITS.line + 1), for: { kind: 'comment' } }))).words?.key).toBe('ai.writing.lineTooLong');
    expect((await failure(summarizeText(ben, 'y'.repeat(WRITING_LIMITS.selection + 1)))).words?.key).toBe('ai.writing.selectionTooLong');
    expect((await failure(writeWithAI(ben, { action: 'clearer', text: ' \n ' }))).words?.key).toBe('ai.writing.nothingToWorkOn');
    expect(script.requests).toHaveLength(0);
  });
});

describe('only what the person may see goes to the model', () => {
  it('summarises an issue from what Ben sees: no limited comment, private field, or hidden issue however it is named', async () => {
    script.parsed.push({ summary: `- Fails on Safari; related to ${secretId}.` });
    const r = await summarizeIssue(ben, backId);
    expect(sent()).toContain('Reproduced on Safari 17.');
    expect(sent()).not.toContain('Only for Anna');
    expect(sent()).not.toContain('Board-level exposure');
    expect(sent()).not.toContain('Acquire Initech');
    expect(sent()).not.toContain('Bluebird');
    // Its id stays as text, as Ben reads it in the description (D37); what the model says of it is taken out.
    expect(r.summary).not.toContain(secretId);
    expect(r).toMatchObject({ language: 'en', partial: false });
    expect(r.post).toEqual(expect.any(String));
  });

  it('reads the limited comment and the private field for Anna, and then offers no comment for everyone', async () => {
    script.parsed.push({ summary: '- The vendor is known.' });
    const r = await summarizeIssue(w.adminCtx, backId, 'de');
    expect(sent()).toContain('Only for Anna');
    expect(sent()).not.toContain('Board-level exposure');
    expect(system()).toContain('Write it in German');
    expect(r).toMatchObject({ language: 'de', post: null });
  });

  it('answers an issue or an article kept from the reader as one that does not exist', async () => {
    const hidden = await failure(summarizeIssue(ben, secretId));
    const missing = await failure(summarizeIssue(ben, 'SECRET-999'));
    expect([hidden.status, hidden.code]).toEqual([missing.status, missing.code]);
    expect(hidden.message).toBe(missing.message.replace('SECRET-999', secretId));
    expect((await failure(writeWithAI(ben, { action: 'continue', text: 'and so', for: { kind: 'comment', issue: secretId } }))).status).toBe(404);
    expect((await failure(suggestSummary(ben, secretId))).status).toBe(404);
    const article = await createArticle(anna, { project: 'BACK', title: 'Vendor shortlist', body: 'Initech, then Globex.' });
    await setArticleVisibility(anna, article.id, { users: ['anna'], groups: [] });
    expect((await failure(summarizeArticle(ben, article.id))).status).toBe(404);
    expect((await failure(writeWithAI(ben, { action: 'continue', text: 'and so', for: { kind: 'article', article: article.id } }))).status).toBe(404);
    expect(script.requests).toHaveLength(0);
    script.parsed.push({ summary: '- A shortlist of two.' });
    expect((await summarizeArticle(anna, article.id)).summary).toBe('- A shortlist of two.');
    expect(prompt()).toContain('Initech, then Globex.');
  });
});

describe('summaries posted as comments, and summaries suggested', () => {
  it("posts a summary as the assistant's, once it's as the assistant wrote it, for whoever asked", async () => {
    script.parsed.push({ summary: '- Safari only.' });
    const r = await summarizeIssue(ben, backId);
    expect((await failure(postSummary(ben, backId, { text: '- Safari only, and my own words.', token: r.post! }))).words?.key).toBe('ai.writing.summaryNotPostable');
    expect((await failure(postSummary(anna, backId, { text: r.summary, token: r.post! }))).words?.key).toBe('ai.writing.summaryNotPostable');
    const c = await postSummary(ben, backId, { text: r.summary, token: r.post! });
    expect(c).toMatchObject({ text: '- Safari only.', channel: 'assistant', visibility: 'internal', visibleTo: null });
    expect((await listComments(ben, backId)).some((x) => x.id === c.id)).toBe(true);
  });

  it('suggests a clearer summary in the issue’s own words, and changes nothing', async () => {
    script.parsed.push({ summary: '  "Checkout fails on Safari 17"  ' });
    const before = await getIssue(ben, backId);
    const s = await suggestSummary(ben, backId);
    expect(s).toMatchObject({ current: 'Checkout breaks', summary: 'Checkout fails on Safari 17', version: before.version });
    expect((await getIssue(ben, backId)).summary).toBe('Checkout breaks');
    expect(system()).toContain('never translate it');
  });
});

describe('costs and limits', () => {
  it('caps each person per hour, counting asks sent at once, and says when to try again', async () => {
    w.app.config.aiWritingMaxPerHour = 2;
    const viewer = w.as(w.viewer);
    for (let i = 0; i < 5; i++) script.parsed.push({ summary: 'ok' });
    const results = await Promise.allSettled([0, 1, 2, 3, 4].map(() => summarizeText(viewer, 'Some words to read.')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const capped = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(capped.reason).toMatchObject({ status: 429, code: 'ai_writing_limit', words: { key: 'ai.writing.limit', values: { max: 2, minutes: 60 } } });
    expect(capped.reason.message).toBe('You’ve asked the assistant for help 2 times in the last hour, as often as it answers anyone');
    // Someone else has an hour of their own.
    script.parsed.push({ summary: 'ok' });
    await expect(summarizeText(anna, 'Some words to read.')).resolves.toMatchObject({ summary: 'ok' });
  });

  it("says what the provider's failures mean", async () => {
    script.parsed.push(new Anthropic.RateLimitError(429, undefined, 'busy', new Headers()));
    expect(await failure(summarizeText(ben, 'Words.'))).toMatchObject({ status: 429, code: 'ai_rate_limited' });
    script.parsed.push(new Anthropic.APIConnectionError({ message: 'down' }));
    expect(await failure(writeWithAI(ben, { action: 'fix', text: 'Words.' }))).toMatchObject({ status: 503, code: 'ai_unreachable' });
    script.parsed.push('refusal');
    expect(await failure(writeWithAI(ben, { action: 'fix', text: 'Words.' }))).toMatchObject({ status: 422, code: 'ai_declined' });
  });

  it('works on another provider by a forced tool call, without Claude’s own request features', async () => {
    setClaudeClientForTests(fake, AI_PROVIDERS.qwen);
    try {
      script.answers.push({ text: 'Fixed ⟦1⟧.' });
      expect((await writeWithAI(ben, { action: 'fix', text: 'Fixd BACK-1.' })).text).toBe('Fixed BACK-1.');
      expect(script.requests[0]).toMatchObject({ thinking: { type: 'disabled' }, tool_choice: { type: 'tool', name: 'answer' } });
      expect(script.requests[0]).not.toHaveProperty('output_config');
    } finally {
      setClaudeClientForTests(fake);
    }
  });
});

describe('without an AI provider', () => {
  it('says ai_disabled on every action, over REST too, and MCP offers no summary', async () => {
    const token = (await issueTokenFor(w.app.db, w.ben.id, { name: 'ben', scopes: ['read', 'write'] })).token;
    const app = createHttpApp(w.app);
    const call = (path: string, body: unknown) =>
      app.request(`/api/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(toolByName('summarize_issue')).toBeDefined();
    const tools = async () => {
      const server = createMcpServer(ben) as unknown as { _registeredTools: Record<string, unknown> };
      return Object.keys(server._registeredTools);
    };
    expect(await tools()).toContain('summarize_issue');
    setClaudeClientForTests(null);
    try {
      for (const p of [writeWithAI(ben, { action: 'fix', text: 'Words.' }), summarizeIssue(ben, backId), summarizeText(ben, 'Words.'), suggestSummary(ben, backId)]) {
        expect(await failure(p)).toMatchObject({ status: 503, code: 'ai_disabled' });
      }
      const res = await call('/ai/write', { action: 'fix', text: 'Words.' });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ai_disabled');
      expect((await call(`/issues/${backId}/summarize`, {})).status).toBe(503);
      expect(await tools()).not.toContain('summarize_issue');
    } finally {
      setClaudeClientForTests(fake);
    }
  });

  it('serves the actions over REST, as in OpenAPI', async () => {
    const token = (await issueTokenFor(w.app.db, w.ben.id, { name: 'ben2', scopes: ['read', 'write'] })).token;
    const app = createHttpApp(w.app);
    script.parsed.push({ text: 'Hello.' });
    const res = await app.request('/api/v1/ai/write', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'fix', text: 'Helo.' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ action: 'fix', text: 'Hello.' });
    const spec = (await (await app.request('/api/v1/openapi.json')).json()) as { paths: Record<string, unknown> };
    for (const path of ['/ai/write', '/ai/summarize', '/issues/{id}/summarize', '/issues/{id}/summary/comment', '/issues/{id}/suggest-summary', '/articles/{id}/summarize']) expect(spec.paths).toHaveProperty(path);
    const tool = toolByName('summarize_issue')!;
    script.parsed.push({ summary: '- Safari only.' });
    const out = await tool.run(ben, tool.input.parse({ issue: backId }) as never);
    expect(out.data).toMatchObject({ issue: backId, summary: '- Safari only.', language: 'en' });
  });
});
