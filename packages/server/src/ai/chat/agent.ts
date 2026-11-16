/**
 * The in-app assistant: a streaming tool loop over the shared tool layer.
 *
 * - History is append-only: content blocks are stored exactly as the API returned
 *   them (thinking blocks included) and sent back unchanged.
 * - The system prompt and tools are fixed per conversation, so the prefix caches.
 * - Reads run at once; writes pause for the person's approval unless they chose
 *   "auto". All results of one assistant turn go back in a single user message.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, ChatPart, ChatStreamEvent, Conversation, ConversationDetail } from '@a4a/shared';
import { and, asc, desc, eq } from 'drizzle-orm';
import { requireScope, withChannel, type Ctx } from '../../context';
import { aiConversations, aiMessages } from '../../db/schema';
import { todayISO } from '../../lib/dates';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { excerpt } from '../../lib/text';
import { visibleSchema } from '../../services/access';
import { projectByKey } from '../../services/schema-cache';
import { toolByName, toolErrorText } from '../../tools/registry';
import { aiService, FALLBACK_BETA, requireAI, THINKING_UPDATES_BETA, toAppError, type AIService } from '../client';
import { schemaSummary } from '../prompt-context';
import { ANTHROPIC_TOOLS, historyVersion, SYSTEM_PROMPT } from './prompt';

type Block = Anthropic.Beta.BetaContentBlockParam;
type ConversationRow = typeof aiConversations.$inferSelect;
type MessageRow = typeof aiMessages.$inferSelect;
export type Emit = (event: ChatStreamEvent) => void;

const MAX_STEPS = 24;
const MAX_RESULT_CHARS = 30_000;
const PAGE_PREFIX = '<page_context>';

interface Approval {
  toolUseId: string;
  name: string;
  input: unknown;
  preview: string;
}

interface Pending {
  order: string[];
  results: Record<string, Anthropic.Beta.BetaToolResultBlockParam>;
  summaries: Record<string, string>;
  awaiting: Approval[];
  approvalMode: 'ask' | 'auto';
}

interface FrozenContext {
  intro: string;
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

function conversationDto(s: Awaited<ReturnType<Ctx['app']['schema']['get']>>, row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    project: row.projectId ? (s.projects.get(row.projectId)?.key ?? null) : null,
    status: row.status as Conversation['status'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadOwn(ctx: Ctx, id: string): Promise<ConversationRow> {
  const [row] = await ctx.db
    .select()
    .from(aiConversations)
    .where(and(eq(aiConversations.id, id), eq(aiConversations.userId, ctx.actor.user.id)));
  if (!row) throw notFound('Conversation');
  return row;
}

export async function listConversations(ctx: Ctx): Promise<Conversation[]> {
  requireScope(ctx, 'read');
  const s = await visibleSchema(ctx);
  const rows = await ctx.db
    .select()
    .from(aiConversations)
    .where(eq(aiConversations.userId, ctx.actor.user.id))
    .orderBy(desc(aiConversations.updatedAt))
    .limit(100);
  return rows.map((r) => conversationDto(s, r));
}

export async function createConversation(ctx: Ctx, input: { title?: string; project?: string }): Promise<Conversation> {
  requireScope(ctx, 'read');
  const s = await visibleSchema(ctx);
  const project = input.project ? projectByKey(s, input.project) : undefined;
  if (input.project && !project) throw notFound(`Project ${input.project}`);
  // Frozen for the conversation's life so the prompt prefix stays cacheable.
  const frozen: FrozenContext = {
    intro: [
      `The conversation started on ${todayISO()}.`,
      project ? `The person opened it from project ${project.key} (${project.name}); assume that project unless they say otherwise.` : '',
      `They may: ${ctx.actor.scopes.join(', ')}.`,
      '',
      await schemaSummary(ctx),
    ]
      .filter((l) => l !== '')
      .join('\n'),
  };
  const [row] = await ctx.db
    .insert(aiConversations)
    .values({
      id: newId(),
      userId: ctx.actor.user.id,
      title: input.title?.trim() || 'New conversation',
      projectId: project?.id ?? null,
      status: 'idle',
      context: frozen,
      agentVersion: historyVersion(aiService(ctx.app)),
    })
    .returning();
  return conversationDto(s, row!);
}

export async function deleteConversation(ctx: Ctx, id: string): Promise<void> {
  await loadOwn(ctx, id);
  await ctx.db.delete(aiConversations).where(eq(aiConversations.id, id));
}

export async function getConversation(ctx: Ctx, id: string): Promise<ConversationDetail> {
  requireScope(ctx, 'read');
  const s = await visibleSchema(ctx);
  const row = await loadOwn(ctx, id);
  const messages = await ctx.db.select().from(aiMessages).where(eq(aiMessages.conversationId, id)).orderBy(asc(aiMessages.id));
  const pending = (row.pending as Pending | null) ?? null;
  return {
    ...conversationDto(s, row),
    messages: renderMessages(messages, pending),
    pendingApprovals: pending?.awaiting ?? [],
  };
}

/** Turn stored API content blocks into the parts people see. */
export function renderMessages(rows: MessageRow[], pending: Pending | null): ChatMessage[] {
  const results = new Map<string, { error: boolean; declined: boolean }>();
  const summaries = new Map<string, string>();
  for (const row of rows) {
    const meta = (row.meta ?? {}) as { summaries?: Record<string, string>; declined?: string[] };
    for (const [k, v] of Object.entries(meta.summaries ?? {})) summaries.set(k, v);
    if (row.role !== 'user') continue;
    for (const b of row.content as Block[]) {
      if (b.type === 'tool_result') results.set(b.tool_use_id, { error: Boolean(b.is_error), declined: (meta.declined ?? []).includes(b.tool_use_id) });
    }
  }
  const awaiting = new Set((pending?.awaiting ?? []).map((a) => a.toolUseId));
  const out: ChatMessage[] = [];
  for (const row of rows) {
    const parts: ChatPart[] = [];
    // Another service's thinking is its raw reasoning, not notes written to be read.
    const raw = (row.meta as { reasoning?: string } | null)?.reasoning === 'raw';
    for (const b of row.content as Block[]) {
      if (b.type === 'text') {
        if (row.role === 'user' && b.text.startsWith(PAGE_PREFIX)) continue;
        if (b.text.trim()) parts.push({ type: 'text', text: b.text });
      } else if (b.type === 'thinking') {
        if (b.thinking.trim() && !raw) parts.push({ type: 'progress', text: b.thinking });
      } else if (b.type === 'tool_use') {
        const r = results.get(b.id);
        const tool = toolByName(b.name);
        parts.push({
          type: 'tool',
          id: b.id,
          name: b.name,
          input: b.input,
          status: r ? (r.declined ? 'rejected' : r.error ? 'error' : 'done') : awaiting.has(b.id) ? 'pending_approval' : 'running',
          summary: summaries.get(b.id) ?? null,
          write: tool?.kind === 'changes',
        });
      } else if (b.type === 'fallback') {
        parts.push({ type: 'notice', text: `Answered by ${b.to.model}` });
      }
    }
    if (parts.length) out.push({ id: String(row.id), role: row.role as 'user' | 'assistant', parts, createdAt: row.createdAt.toISOString() });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/** After a mid-stream fallback, drop model-internal blocks before the last fallback boundary. */
export function sanitizeFallback(content: Block[]): Block[] {
  const last = content.map((b) => b.type).lastIndexOf('fallback');
  if (last < 0) return content;
  const paired = new Set(content.filter((b) => b.type === 'web_search_tool_result' || b.type === 'web_fetch_tool_result').map((b) => (b as { tool_use_id: string }).tool_use_id));
  return content.filter((b, i) => {
    if (i >= last) return true;
    if (b.type === 'thinking' || b.type === 'redacted_thinking' || b.type === 'tool_use') return false;
    if (b.type === 'server_tool_use') return paired.has(b.id);
    return true;
  });
}

function stripThinking(content: Block[]): Block[] {
  return content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
}

async function history(ctx: Ctx, conv: ConversationRow, ai: AIService): Promise<Anthropic.Beta.BetaMessageParam[]> {
  const rows = await ctx.db.select().from(aiMessages).where(eq(aiMessages.conversationId, conv.id)).orderBy(asc(aiMessages.id));
  const version = historyVersion(ai);
  if (conv.agentVersion !== version) {
    // The prompt, the tools or the model changed since these turns: their thinking blocks
    // are bound to the old prefix and model, so drop them once (persistently) and carry on.
    for (const r of rows) {
      if (r.role !== 'assistant') continue;
      const stripped = stripThinking(r.content as Block[]);
      if (stripped.length !== (r.content as Block[]).length) {
        await ctx.db.update(aiMessages).set({ content: stripped }).where(eq(aiMessages.id, r.id));
        r.content = stripped;
      }
    }
    await ctx.db.update(aiConversations).set({ agentVersion: version }).where(eq(aiConversations.id, conv.id));
    conv.agentVersion = version;
  }
  return rows.map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content as Block[] })) as Anthropic.Beta.BetaMessageParam[];
}

async function append(ctx: Ctx, conversationId: string, role: 'user' | 'assistant', content: Block[], extra: { usage?: unknown; meta?: unknown } = {}) {
  const [row] = await ctx.db
    .insert(aiMessages)
    .values({ conversationId, role, content: content as never, usage: (extra.usage ?? null) as never, meta: (extra.meta ?? null) as never })
    .returning({ id: aiMessages.id });
  await ctx.db.update(aiConversations).set({ updatedAt: new Date() }).where(eq(aiConversations.id, conversationId));
  return row!.id;
}

async function setStatus(ctx: Ctx, id: string, status: Conversation['status'], pending: Pending | null) {
  await ctx.db.update(aiConversations).set({ status, pending: pending as never, updatedAt: new Date() }).where(eq(aiConversations.id, id));
}

function resultBlock(toolUseId: string, text: string, isError = false): Anthropic.Beta.BetaToolResultBlockParam {
  const content = text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…(truncated; narrow the query for the rest)` : text;
  return { type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) };
}

async function runTool(ctx: Ctx, name: string, input: unknown): Promise<{ block: (id: string) => Anthropic.Beta.BetaToolResultBlockParam; ok: boolean; summary: string }> {
  const tool = toolByName(name);
  if (!tool) return { block: (id) => resultBlock(id, `Unknown tool "${name}"`, true), ok: false, summary: `Unknown tool ${name}` };
  const parsed = tool.input.safeParse(input ?? {});
  if (!parsed.success) {
    const text = JSON.stringify({ INVALID_JSON: JSON.stringify(input), problems: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    return { block: (id) => resultBlock(id, text, true), ok: false, summary: 'Invalid input' };
  }
  try {
    const result = await tool.run(withChannel(ctx, 'assistant'), parsed.data);
    return { block: (id) => resultBlock(id, JSON.stringify(result.data)), ok: true, summary: result.summary };
  } catch (e) {
    const text = toolErrorText(e);
    return { block: (id) => resultBlock(id, text, true), ok: false, summary: excerpt(text.split('\n')[0] ?? 'Failed', 160) };
  }
}

/** Run assistant steps until the turn ends, a write needs approval, or a limit is hit. */
async function loop(ctx: Ctx, conv: ConversationRow, emit: Emit, approvalMode: 'ask' | 'auto'): Promise<void> {
  const ai = requireAI(ctx.app);
  const claude = ai.provider.claudeFeatures;
  const frozen = conv.context as FrozenContext;
  let jsonRetries = 0;
  for (let step = 0; step < MAX_STEPS; step++) {
    const messages = await history(ctx, conv, ai);
    emit({ type: 'message_start', messageId: `step-${step}` });
    let message: Anthropic.Beta.BetaMessage;
    try {
      const base = {
        model: ai.model,
        max_tokens: 64000,
        output_config: { effort: 'medium' as const },
        system: [
          { type: 'text' as const, text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' as const } },
          { type: 'text' as const, text: frozen.intro },
        ],
        tools: ANTHROPIC_TOOLS,
        messages,
      };
      // Claude gets its own features; any other service, the portable subset of the request.
      const stream = claude
        ? ai.client.beta.messages.stream({
            ...base,
            betas: [FALLBACK_BETA, THINKING_UPDATES_BETA],
            fallbacks: 'default',
            thinking: { type: 'adaptive', display: 'updates' },
            cache_control: { type: 'ephemeral' },
          })
        : ai.client.beta.messages.stream({ ...base, thinking: { type: 'adaptive' } });
      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') emit({ type: 'text_delta', text: event.delta.text });
          // Claude's thinking comes as short progress notes, written to be read. Another
          // service's is its raw reasoning: it is kept, to send back, but not shown.
          else if (claude && event.delta.type === 'thinking_delta' && event.delta.thinking) emit({ type: 'progress', text: event.delta.thinking });
        }
      }
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (e) {
      // Only a tool input the SDK could not parse at all is retried; API errors are not.
      if (e instanceof Anthropic.APIError || jsonRetries++ >= 2) throw toAppError(e, ai);
      emit({ type: 'notice', text: 'Retrying a step whose tool input was malformed' });
      continue;
    }

    const content = sanitizeFallback(message.content as Block[]);
    const toolUses = content.filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === 'tool_use');
    await append(ctx, conv.id, 'assistant', content, { usage: message.usage, meta: claude ? undefined : { reasoning: 'raw' } });
    if (content.some((b) => b.type === 'fallback')) {
      emit({ type: 'notice', text: `Answered by ${message.model}` });
    }

    if (message.stop_reason === 'refusal') {
      // A refusal can cut a tool call off mid-input: never run that turn's tools.
      if (toolUses.length) await append(ctx, conv.id, 'user', toolUses.map((t) => resultBlock(t.id, 'Not run: the response was declined.', true)));
      emit({ type: 'notice', text: 'The assistant declined to continue with this request.' });
      break;
    }
    if (!toolUses.length) break;
    if (message.stop_reason === 'max_tokens') {
      await append(ctx, conv.id, 'user', toolUses.map((t) => resultBlock(t.id, 'Not run: the response was cut off before the tool input was complete.', true)));
      emit({ type: 'notice', text: 'The response was cut off; ask again with a narrower request.' });
      break;
    }

    const pending: Pending = { order: toolUses.map((t) => t.id), results: {}, summaries: {}, awaiting: [], approvalMode };
    for (const t of toolUses) {
      const tool = toolByName(t.name);
      const write = tool?.kind === 'changes';
      emit({ type: 'tool_start', id: t.id, name: t.name, input: t.input, write });
      if (write && approvalMode === 'ask') {
        let preview: string;
        try {
          const parsed = tool!.input.parse(t.input ?? {});
          preview = tool!.preview ? await tool!.preview(withChannel(ctx, 'assistant'), parsed) : `${tool!.title}`;
        } catch (e) {
          // An invalid write never reaches the person: answer the model with the error.
          const text = toolErrorText(e);
          pending.results[t.id] = resultBlock(t.id, text, true);
          pending.summaries[t.id] = excerpt(text, 160);
          emit({ type: 'tool_result', id: t.id, ok: false, summary: pending.summaries[t.id]! });
          continue;
        }
        pending.awaiting.push({ toolUseId: t.id, name: t.name, input: t.input, preview });
        continue;
      }
      const r = await runTool(ctx, t.name, t.input);
      pending.results[t.id] = r.block(t.id);
      pending.summaries[t.id] = r.summary;
      emit({ type: 'tool_result', id: t.id, ok: r.ok, summary: r.summary });
    }

    if (pending.awaiting.length) {
      await setStatus(ctx, conv.id, 'awaiting_approval', pending);
      emit({ type: 'approval_required', approvals: pending.awaiting });
      emit({ type: 'done', status: 'awaiting_approval' });
      return;
    }
    await append(ctx, conv.id, 'user', pending.order.map((id) => pending.results[id]!), { meta: { summaries: pending.summaries } });
    if (step === MAX_STEPS - 1) emit({ type: 'notice', text: `Stopped after ${MAX_STEPS} steps; ask to continue.` });
  }
  await setStatus(ctx, conv.id, 'idle', null);
  emit({ type: 'done', status: 'idle' });
}

async function guarded(ctx: Ctx, conv: ConversationRow, emit: Emit, run: () => Promise<void>) {
  try {
    await run();
  } catch (e) {
    const err = e instanceof AppError ? e : toAppError(e);
    emit({ type: 'error', message: err.hint ? `${err.message}. ${err.hint}` : err.message });
    const [latest] = await ctx.db.select().from(aiConversations).where(eq(aiConversations.id, conv.id));
    if (latest?.status === 'running') await setStatus(ctx, conv.id, 'idle', null);
    emit({ type: 'done', status: 'idle' });
  }
}

export async function sendMessage(
  ctx: Ctx,
  conversationId: string,
  input: { text: string; context?: { issue?: string; project?: string; query?: string }; approvalMode?: 'ask' | 'auto' },
  emit: Emit,
): Promise<void> {
  requireScope(ctx, 'read');
  requireAI(ctx.app);
  const conv = await loadOwn(ctx, conversationId);
  if (conv.status === 'running') throw conflict('The assistant is still answering in this conversation');
  if (conv.status === 'awaiting_approval') throw conflict('Approve or decline the pending changes first');
  const blocks: Block[] = [];
  const page = [
    input.context?.issue ? `The person is looking at issue ${input.context.issue}.` : '',
    input.context?.project ? `They are in project ${input.context.project}.` : '',
    input.context?.query ? `Their search is: ${input.context.query}` : '',
  ].filter(Boolean);
  if (page.length) blocks.push({ type: 'text', text: `${PAGE_PREFIX}${page.join(' ')}</page_context>` });
  blocks.push({ type: 'text', text: input.text });
  await setStatus(ctx, conv.id, 'running', null);
  await append(ctx, conv.id, 'user', blocks);
  if (conv.title === 'New conversation') {
    await ctx.db.update(aiConversations).set({ title: excerpt(input.text, 70) }).where(eq(aiConversations.id, conv.id));
  }
  await guarded(ctx, conv, emit, () => loop(ctx, conv, emit, input.approvalMode ?? 'ask'));
}

export async function decide(ctx: Ctx, conversationId: string, decisions: { toolUseId: string; approve: boolean }[], emit: Emit): Promise<void> {
  requireScope(ctx, 'read');
  requireAI(ctx.app);
  const conv = await loadOwn(ctx, conversationId);
  const pending = conv.pending as Pending | null;
  if (conv.status !== 'awaiting_approval' || !pending) throw badRequest('Nothing in this conversation is waiting for approval');
  const byId = new Map(decisions.map((d) => [d.toolUseId, d.approve]));
  const missing = pending.awaiting.filter((a) => !byId.has(a.toolUseId));
  if (missing.length) throw badRequest(`Decide on every pending change (${missing.length} left)`);
  await setStatus(ctx, conv.id, 'running', pending);
  const declined: string[] = [];
  await guarded(ctx, conv, emit, async () => {
    for (const a of pending.awaiting) {
      if (byId.get(a.toolUseId)) {
        const r = await runTool(ctx, a.name, a.input);
        pending.results[a.toolUseId] = r.block(a.toolUseId);
        pending.summaries[a.toolUseId] = r.summary;
        emit({ type: 'tool_result', id: a.toolUseId, ok: r.ok, summary: r.summary });
      } else {
        declined.push(a.toolUseId);
        pending.results[a.toolUseId] = resultBlock(a.toolUseId, 'The person declined this change. Do not retry it; ask what they would like instead.');
        pending.summaries[a.toolUseId] = 'You declined it';
        emit({ type: 'tool_result', id: a.toolUseId, ok: false, summary: 'You declined it' });
      }
    }
    await append(ctx, conv.id, 'user', pending.order.map((id) => pending.results[id]!), { meta: { summaries: pending.summaries, declined } });
    await setStatus(ctx, conv.id, 'running', null);
    await loop(ctx, conv, emit, pending.approvalMode);
  });
}
