/**
 * The AI against a real model, on the demo data. Not part of `pnpm test`: it needs a key
 * and costs a little. Run it with the provider's key in the environment:
 *
 *   AI_PROVIDER=deepseek DEEPSEEK_API_KEY=… pnpm --filter @a4a/server test:live
 *   ANTHROPIC_API_KEY=… pnpm --filter @a4a/server test:live
 *
 * It checks what must hold whatever the model's wording: queries and commands the parser
 * accepts, a triage within the project's own values, a verdict for every candidate, and an
 * assistant that reads, pauses before a change, and makes it once approved. Without a key
 * it skips, and says why.
 */
import type { ChatStreamEvent } from '@a4a/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConversation, decide, getConversation, sendMessage } from '../../src/ai/chat/agent';
import { similarWithJudgement, wordsToCommand, wordsToQuery } from '../../src/ai/nl';
import { summarizeIssue, writeWithAI } from '../../src/ai/writing';
import { AI_PROVIDERS } from '../../src/ai/providers';
import { triageIssue } from '../../src/ai/triage';
import { adminCtx, createRuntime, type Runtime } from '../../src/app-services';
import { loadConfig } from '../../src/config';
import type { Ctx } from '../../src/context';
import { openDatabase, type Database } from '../../src/db/client';
import { seedDemo } from '../../src/db/seed';
import { createIssue, getIssue } from '../../src/services/issues';
import { insertUser } from '../../src/services/users';

const config = loadConfig({ seedDemo: false });
const on = config.aiEnabled;
if (!on) console.warn(`Skipping the live AI tests: ${config.aiOffReason}.`);

let app: Runtime;
let database: Database;
let ctx: Ctx;

beforeAll(async () => {
  if (!on) return;
  console.info(`Live AI tests on ${config.aiModel}, from ${AI_PROVIDERS[config.aiProvider].label}.`);
  database = await openDatabase({ memory: true });
  app = await createRuntime(config, database);
  const admin = await insertUser(app.db, { login: 'admin', name: 'Ada Admin', role: 'admin', password: 'password-admin' });
  app.schema.invalidate();
  await seedDemo(app, admin);
  ctx = adminCtx(app, admin, 'api');
});

afterAll(async () => {
  await database?.close();
});

describe.runIf(on)('the AI, live', () => {
  it('turns words into queries the parser accepts', async () => {
    const asks: [string, string | undefined][] = [
      ['open bugs assigned to me', undefined],
      ['critical or show-stopper issues nobody is working on', undefined],
      ['issues that mention safari', 'WEB'],
      ['everything ben reported this month, newest first', undefined],
      ['bugs without a subsystem in BACK', undefined],
    ];
    for (const [text, project] of asks) {
      const res = await wordsToQuery(ctx, text, project);
      expect(res.problems, `"${text}" → ${res.query}`).toEqual([]);
      expect(res.valid).toBe(true);
      expect(res.explanation.length).toBeGreaterThan(0);
    }
  });

  it('turns words into commands the parser accepts, and says no to deleting', async () => {
    const asks: [string, string[]][] = [
      ['assign these to me and make them major', ['BACK-10', 'BACK-12']],
      ['close it as a duplicate of BACK-8', ['BACK-12']],
      ['tag it regression and say in a comment that I am looking into it', ['BACK-3']],
      ['estimate it at two days and move it to in progress', ['BACK-11']],
    ];
    for (const [text, issues] of asks) {
      const res = await wordsToCommand(ctx, text, issues);
      expect(res.preview.problems, `"${text}" → ${res.command}`).toEqual([]);
      expect(res.command.trim().length).toBeGreaterThan(0);
    }
    const commented = await wordsToCommand(ctx, 'tag it regression and say in a comment that I am looking into it', ['BACK-3']);
    expect(commented.comment ?? '').toMatch(/looking into it/i);
    expect(commented.command).not.toMatch(/\bcomment\b/i);

    const deleting = await wordsToCommand(ctx, 'delete this issue', ['BACK-5']);
    expect(deleting.command.trim()).toBe('');
    expect(deleting.explanation).toMatch(/delet|close|resolv|obsolete/i);
  });

  it('summarises an issue and its discussion', async () => {
    const { summary } = await summarizeIssue(ctx, 'BACK-2');
    expect(summary.length).toBeGreaterThan(80);
    expect(summary).toMatch(/safari/i);
  });

  it('triages within the project\'s own values', async () => {
    const issue = await createIssue(ctx, {
      project: 'BACK',
      summary: 'Payments API returns 500 for every card payment since this morning',
      description: 'All card payments fail with HTTP 500 from POST /payments since the 09:00 deploy. Customers cannot pay at all. Logs show a null pointer in the fraud check.',
    });
    const s = await triageIssue(ctx, issue.id);
    const field = (name: string) => s.payload.fields.find((f) => f.name === name);
    expect(['Show-stopper', 'Critical']).toContain(field('Priority')?.value);
    expect(field('Type')?.value).toBe('Bug');
    const subsystems = ['API', 'Database', 'Auth', 'Billing', 'Search', 'Infrastructure'];
    if (field('Subsystem')) expect(subsystems).toContain(field('Subsystem')!.value);
    expect(s.payload.summary.length).toBeGreaterThan(20);
  });

  it('judges every candidate when looking for duplicates', async () => {
    const res = await similarWithJudgement(ctx, { summary: 'Login fails on Safari with single sign-on', description: 'Blank page after the identity provider redirects back.', judge: true });
    expect(res.judged).toBe(true);
    expect(res.items.length).toBeGreaterThan(0);
    for (const item of res.items) expect(['duplicate', 'related', 'different']).toContain(item.verdict);
    expect(res.items.some((i) => i.verdict === 'duplicate' || i.verdict === 'related')).toBe(true);
  });

  it('has the assistant read, pause before a change, and make it once approved', async () => {
    const conv = await createConversation(ctx, { project: 'BACK' });
    const turn = async (run: (emit: (e: ChatStreamEvent) => void) => Promise<void>) => {
      const events: ChatStreamEvent[] = [];
      await run((e) => events.push(e));
      const error = events.find((e) => e.type === 'error');
      expect(error, error && 'message' in error ? error.message : '').toBeUndefined();
      return events;
    };

    const read = await turn((emit) => sendMessage(ctx, conv.id, { text: 'How many open bugs are there in BACK? Answer in one sentence.' }, emit));
    expect(read.some((e) => e.type === 'tool_start' && !e.write)).toBe(true);
    expect(read.at(-1)).toEqual({ type: 'done', status: 'idle' });
    expect(read.filter((e) => e.type === 'text_delta').map((e) => (e.type === 'text_delta' ? e.text : '')).join('')).toMatch(/\d/);

    const change = await turn((emit) => sendMessage(ctx, conv.id, { text: 'Assign BACK-11 to me.', approvalMode: 'ask' }, emit));
    const approval = change.find((e) => e.type === 'approval_required');
    expect(approval, 'the change waits for a yes').toBeDefined();
    expect(change.at(-1)).toEqual({ type: 'done', status: 'awaiting_approval' });
    expect((await getIssue(ctx, 'BACK-11')).fields.find((f) => f.name === 'Assignee')!.value).not.toMatchObject({ login: 'admin' });

    const approvals = approval!.type === 'approval_required' ? approval!.approvals : [];
    const done = await turn((emit) => decide(ctx, conv.id, approvals.map((a) => ({ toolUseId: a.toolUseId, approve: true })), emit));
    expect(done.at(-1)).toEqual({ type: 'done', status: 'idle' });
    expect((await getIssue(ctx, 'BACK-11')).fields.find((f) => f.name === 'Assignee')!.value).toMatchObject({ login: 'admin' });

    // Its reasoning went back with each turn, and only Claude's notes are shown.
    const detail = await getConversation(ctx, conv.id);
    const shown = detail.messages.flatMap((m) => m.parts.map((p) => p.type));
    if (!AI_PROVIDERS[config.aiProvider].claudeFeatures) expect(shown).not.toContain('progress');
  });
});
