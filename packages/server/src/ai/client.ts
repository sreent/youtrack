import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import type { AppServices } from '../context';
import { aiDisabled, AppError } from '../lib/errors';

/** The part of the SDK client the AI features use (lets tests inject a fake). */
export type ClaudeClient = Pick<Anthropic, 'beta'>;

/**
 * Refusal fallbacks: on a safety-classifier decline the API re-runs the request on
 * the model Anthropic recommends for that category, so a false positive doesn't
 * become an outage for an otherwise benign tracker request.
 */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Short progress notes between tool calls, shown in the assistant's run. */
export const THINKING_UPDATES_BETA = 'thinking-display-updates-2026-08-18';

export interface AIService {
  client: ClaudeClient;
  model: string;
}

let injected: ClaudeClient | null = null;

/** Tests: route every AI call to a fake client. */
export function setClaudeClientForTests(client: ClaudeClient | null): void {
  injected = client;
  cached = null;
}

let cached: AIService | null = null;

export function aiService(app: AppServices): AIService | null {
  if (injected) return { client: injected, model: app.config.aiModel };
  if (!app.config.aiEnabled) return null;
  cached ??= { client: new Anthropic({ maxRetries: 2 }), model: app.config.aiModel };
  return cached;
}

export function requireAI(app: AppServices): AIService {
  const ai = aiService(app);
  if (!ai) throw aiDisabled();
  return ai;
}

/** Map SDK errors (typed, most specific first) to the API's error shape. */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new AppError(503, 'ai_unavailable', 'The AI service rejected the server\'s credentials', 'Check ANTHROPIC_API_KEY on the server.');
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new AppError(429, 'ai_rate_limited', 'The AI service is busy right now', 'Try again in a minute.');
  }
  if (e instanceof Anthropic.BadRequestError) {
    return new AppError(502, 'ai_bad_request', `The AI service refused the request: ${e.message}`);
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new AppError(503, 'ai_unreachable', 'The AI service could not be reached', 'Check the server\'s network access to api.anthropic.com.');
  }
  if (e instanceof Anthropic.APIError) {
    return new AppError(502, 'ai_error', `The AI service failed (${e.status ?? 'no status'})`);
  }
  return new AppError(500, 'ai_error', e instanceof Error ? e.message : String(e));
}

export interface StructuredRequest<S extends z.ZodType> {
  system: string;
  prompt: string;
  schema: S;
  effort?: 'low' | 'medium' | 'high';
  maxTokens?: number;
}

/**
 * One structured call: the response is constrained to `schema` and parsed. Used
 * for triage, words-to-query, words-to-command, summaries and duplicate judging.
 */
export async function structured<S extends z.ZodType>(app: AppServices, req: StructuredRequest<S>): Promise<{ output: z.infer<S>; model: string }> {
  const ai = requireAI(app);
  let message;
  try {
    message = await ai.client.beta.messages.parse({
      model: ai.model,
      max_tokens: req.maxTokens ?? 16000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      output_config: { effort: req.effort ?? 'low', format: betaZodOutputFormat(req.schema) },
      system: req.system,
      messages: [{ role: 'user', content: req.prompt }],
    });
  } catch (e) {
    throw toAppError(e);
  }
  if (message.stop_reason === 'refusal') {
    throw new AppError(422, 'ai_declined', 'The AI declined this request', message.stop_details?.explanation ?? undefined);
  }
  if (message.stop_reason === 'max_tokens') {
    throw new AppError(502, 'ai_truncated', 'The AI response was cut off before it finished');
  }
  if (message.parsed_output === null || message.parsed_output === undefined) {
    throw new AppError(502, 'ai_unparseable', 'The AI response did not match the expected shape');
  }
  return { output: message.parsed_output as z.infer<S>, model: message.model };
}
