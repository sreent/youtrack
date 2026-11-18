import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  AIStatusSchema,
  ApplySuggestionBody,
  ChatApproveBody,
  ChatMessageBody,
  ConversationDetailSchema,
  ConversationSchema,
  CreateConversationBody,
  NLCommandBody,
  NLCommandResultSchema,
  NLQueryBody,
  NLQueryResultSchema,
  SimilarBody,
  SimilarResultSchema,
  SuggestionSchema,
  SummarizeResultSchema,
  CommentSchema,
  SuggestedSummarySchema,
  SummarizeTextBody,
  SummaryCommentBody,
  SummaryLanguageQuery,
  TextSummarySchema,
  WriteBody,
  WriteResultSchema,
  type ChatStreamEvent,
} from '@a4a/shared';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { createConversation, decide, deleteConversation, getConversation, listConversations, sendMessage, type Emit } from '../../ai/chat/agent';
import { aiService, requireAI } from '../../ai/client';
import { AI_PROVIDERS } from '../../ai/providers';
import { similarWithJudgement, wordsToCommand, wordsToQuery } from '../../ai/nl';
import { postSummary, suggestSummary, summarizeArticle, summarizeIssue, summarizeText, writeWithAI } from '../../ai/writing';
import { applySuggestion, dismissSuggestion, listPendingSuggestions, listSuggestions, triageIssue } from '../../ai/triage';
import { requireScope, type Ctx } from '../../context';
import { TOOLS } from '../../tools/registry';
import type { HttpEnv } from '../env';
import { route } from '../route';

const Id = z.object({ id: z.string() });

/** Run an assistant turn and stream its events as SSE; the turn finishes even if the client leaves. */
function streamTurn(c: Parameters<typeof streamSSE>[0], run: (emit: Emit) => Promise<void>) {
  return streamSSE(c, async (stream) => {
    const queue: ChatStreamEvent[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    const emit: Emit = (e) => {
      queue.push(e);
      wake?.();
    };
    const work = run(emit)
      .catch((e: unknown) => emit({ type: 'error', message: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        finished = true;
        wake?.();
      });
    while (!stream.aborted) {
      while (queue.length) {
        const e = queue.shift()!;
        await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
      }
      if (finished) break;
      await new Promise<void>((r) => {
        wake = r;
      });
      wake = null;
    }
    await work;
  });
}

export function aiRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['AI'];
  route(app, { method: 'get', path: '/ai/status', tags, summary: 'Whether AI features are on, and which model they use', response: AIStatusSchema }, async ({ c }) => {
    const runtime = c.get('runtime');
    const ai = aiService(runtime);
    return {
      enabled: Boolean(ai),
      provider: AI_PROVIDERS[runtime.config.aiProvider].label,
      model: runtime.config.aiModel,
      reason: ai ? null : (runtime.config.aiOffReason ?? 'The AI is turned off on this server'),
    };
  });
  route(
    app,
    {
      method: 'get',
      path: '/ai/tools',
      tags,
      summary: 'The tools agents get, over MCP and in the assistant',
      response: z.array(z.object({ name: z.string(), title: z.string(), description: z.string(), kind: z.enum(['reads', 'changes']), destructive: z.boolean() })),
    },
    async ({ ctx }) => {
      requireScope(ctx, 'read');
      const ai = Boolean(aiService(ctx.app));
      return TOOLS.filter((t) => ai || !t.needsAI).map((t) => ({ name: t.name, title: t.title, description: t.description, kind: t.kind, destructive: Boolean(t.destructive) }));
    },
  );
  route(app, { method: 'post', path: '/ai/query', tags, summary: 'Turn plain words into a search query (checked by the real parser)', body: NLQueryBody, response: NLQueryResultSchema, status: 200 }, ({ ctx, body }) => wordsToQuery(ctx, body.text, body.project));
  route(app, { method: 'post', path: '/ai/command', tags, summary: 'Turn plain words into a command for some issues, with a dry-run preview', body: NLCommandBody, response: NLCommandResultSchema, status: 200 }, ({ ctx, body }) => wordsToCommand(ctx, body.text, body.issues));
  route(
    app,
    {
      method: 'post',
      path: '/ai/similar',
      tags,
      summary: 'Issues similar to a draft (lexical; with judge, the AI labels each)',
      description: 'Works without AI: candidates come from full-text and trigram similarity. With `judge: true` and AI enabled, each is labelled duplicate, related or different with a reason.',
      body: SimilarBody,
      response: SimilarResultSchema,
      status: 200,
    },
    async ({ ctx, body }) => {
      if (body.judge) requireAI(ctx.app);
      return similarWithJudgement(ctx, body);
    },
  );
  route(app, { method: 'post', path: '/issues/{id}/triage', tags, summary: 'Triage an issue now: suggested fields, tags and possible duplicates', params: Id, response: SuggestionSchema }, ({ ctx, params }) => triageIssue(ctx, params.id));
  route(app, { method: 'get', path: '/issues/{id}/suggestions', tags, summary: "An issue's AI suggestions, newest first", params: Id, response: z.array(SuggestionSchema) }, ({ ctx, params }) => listSuggestions(ctx, params.id));
  route(
    app,
    {
      method: 'get',
      path: '/ai/suggestions',
      tags,
      summary: 'Suggestions waiting for a person, across issues',
      query: z.object({ project: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }),
      response: z.array(SuggestionSchema),
    },
    ({ ctx, query }) => listPendingSuggestions(ctx, query),
  );
  route(app, { method: 'post', path: '/suggestions/{id}/apply', tags, summary: 'Apply a suggestion, or some of it', params: Id, body: ApplySuggestionBody, response: SuggestionSchema, status: 200 }, ({ ctx, params, body }) => applySuggestion(ctx, params.id, body));
  route(app, { method: 'post', path: '/suggestions/{id}/dismiss', tags, summary: 'Dismiss a suggestion', params: Id, response: SuggestionSchema, status: 200 }, ({ ctx, params }) => dismissSuggestion(ctx, params.id));

  // Writing and reading help (D59): suggestions and summaries, none of them saved.
  route(
    app,
    {
      method: 'post',
      path: '/ai/write',
      tags,
      summary: 'Fix, rewrite, carry on or draft a text: a suggestion, never saved',
      description:
        "fix, shorter, clearer, formal and friendlier change a text's words and keep its language; code, links' addresses, mentions and ids come back as they went in. continue writes what follows it; draft writes from a line, and for a reply to a help desk request, from what its requester can read. Each ask counts against the person's hourly allowance (AI_WRITING_MAX_PER_HOUR).",
      body: WriteBody,
      response: WriteResultSchema,
      status: 200,
    },
    ({ ctx, body }) => writeWithAI(ctx, body),
  );
  route(
    app,
    { method: 'post', path: '/ai/summarize', tags, summary: 'Summarise a text, such as a selection, in the reader’s language', body: SummarizeTextBody, response: TextSummarySchema, status: 200 },
    ({ ctx, body }) => summarizeText(ctx, body.text, body.language),
  );
  route(
    app,
    {
      method: 'post',
      path: '/issues/{id}/summarize',
      tags,
      summary: 'Summarise an issue and its discussion, as the reader sees it, in their language',
      params: Id,
      query: SummaryLanguageQuery,
      response: SummarizeResultSchema,
      status: 200,
    },
    ({ ctx, params, query }) => summarizeIssue(ctx, params.id, query.language),
  );
  route(
    app,
    {
      method: 'post',
      path: '/issues/{id}/summary/comment',
      tags,
      summary: "Post an issue's summary as a comment, as the assistant's",
      description: 'Takes the summary exactly as it came, with its `post` token, within an hour. The history says the assistant wrote it, for whoever posted it.',
      params: Id,
      body: SummaryCommentBody,
      response: CommentSchema,
      status: 201,
    },
    ({ ctx, params, body }) => postSummary(ctx, params.id, body),
  );
  route(
    app,
    { method: 'post', path: '/issues/{id}/suggest-summary', tags, summary: 'Suggest a clearer summary (title) for an issue: nothing changes until it is saved', params: Id, response: SuggestedSummarySchema, status: 200 },
    ({ ctx, params }) => suggestSummary(ctx, params.id),
  );
  route(
    app,
    { method: 'post', path: '/articles/{id}/summarize', tags, summary: 'Summarise an article, in the reader’s language', params: Id, query: SummaryLanguageQuery, response: TextSummarySchema, status: 200 },
    ({ ctx, params, query }) => summarizeArticle(ctx, params.id, query.language),
  );

  const chat = ['Assistant'];
  route(app, { method: 'get', path: '/ai/conversations', tags: chat, summary: 'Your conversations with the assistant', response: z.array(ConversationSchema) }, ({ ctx }) => listConversations(ctx));
  route(app, { method: 'post', path: '/ai/conversations', tags: chat, summary: 'Start a conversation', body: CreateConversationBody, response: ConversationSchema }, ({ ctx, body }) => createConversation(ctx, body));
  route(app, { method: 'get', path: '/ai/conversations/{id}', tags: chat, summary: 'A conversation, its messages and pending approvals', params: Id, response: ConversationDetailSchema }, ({ ctx, params }) => getConversation(ctx, params.id));
  route(app, { method: 'delete', path: '/ai/conversations/{id}', tags: chat, summary: 'Delete a conversation', params: Id, status: 204 }, async ({ ctx, params }) => {
    await deleteConversation(ctx, params.id);
    return null;
  });
  route(
    app,
    {
      method: 'post',
      path: '/ai/conversations/{id}/messages',
      tags: chat,
      summary: 'Say something to the assistant (Server-Sent Events)',
      description:
        'Streams events: message_start, text_delta, progress, tool_start, tool_result, approval_required, notice, error, done. With approvalMode "ask", changes pause for POST …/approve.',
      params: Id,
      body: ChatMessageBody,
      status: 200,
    },
    async ({ c, ctx, params, body }) => {
      await preflight(ctx, params.id);
      return streamTurn(c, (emit) => sendMessage(ctx, params.id, body, emit));
    },
  );
  route(
    app,
    {
      method: 'post',
      path: '/ai/conversations/{id}/approve',
      tags: chat,
      summary: 'Approve or decline the pending changes, then continue (Server-Sent Events)',
      params: Id,
      body: ChatApproveBody,
      status: 200,
    },
    async ({ c, ctx, params, body }) => {
      await preflight(ctx, params.id);
      return streamTurn(c, (emit) => decide(ctx, params.id, body.decisions, emit));
    },
  );
}

/** Fail before opening a stream when the request can't work at all. */
async function preflight(ctx: Ctx, conversationId: string) {
  requireAI(ctx.app);
  await getConversation(ctx, conversationId);
}
