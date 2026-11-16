import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { Config } from '../config';
import type { AppServices } from '../context';
import { aiDisabled, AppError } from '../lib/errors';
import { AI_PROVIDERS, providerHost, providerKey, type AIProvider } from './providers';

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
  provider: AIProvider;
  /** Where requests go, when not the provider's own address. */
  baseURL: string | undefined;
}

let injected: { client: ClaudeClient; provider?: AIProvider } | null = null;

/** Tests: route every AI call to a fake client, as if served by `provider` (Anthropic unless given). */
export function setClaudeClientForTests(client: ClaudeClient | null, provider?: AIProvider): void {
  injected = client ? { client, provider } : null;
  cached = null;
}

let cached: AIService | null = null;

export function aiService(app: AppServices): AIService | null {
  if (injected) return { client: injected.client, model: app.config.aiModel, provider: injected.provider ?? AI_PROVIDERS[app.config.aiProvider], baseURL: undefined };
  if (!app.config.aiEnabled) return null;
  cached ??= connect(app.config);
  return cached;
}

function connect(config: Config): AIService {
  const provider = AI_PROVIDERS[config.aiProvider];
  // For Anthropic the SDK reads ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN itself. For anyone
  // else the key is passed in code, which makes it the client's only credential: the SDK
  // then reads no Anthropic key from the environment, so none is ever sent to another service.
  const client =
    provider.id === 'anthropic'
      ? new Anthropic({ baseURL: config.aiBaseUrl, maxRetries: 2 })
      : new Anthropic({ baseURL: config.aiBaseUrl ?? provider.baseURL, apiKey: providerKey(provider), maxRetries: 2 });
  return { client, model: config.aiModel, provider, baseURL: config.aiBaseUrl };
}

export function requireAI(app: AppServices): AIService {
  const ai = aiService(app);
  if (!ai) throw aiDisabled();
  return ai;
}

/** Map SDK errors (typed, most specific first) to the API's error shape. */
export function toAppError(e: unknown, ai?: AIService): AppError {
  if (e instanceof AppError) return e;
  const provider = ai?.provider ?? AI_PROVIDERS.anthropic;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new AppError(503, 'ai_unavailable', 'The AI service rejected the server\'s credentials', `Check ${provider.keyVars[0]} on the server.`);
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new AppError(429, 'ai_rate_limited', 'The AI service is busy right now', 'Try again in a minute.');
  }
  if (e instanceof Anthropic.BadRequestError) {
    return new AppError(502, 'ai_bad_request', `The AI service refused the request: ${e.message}`);
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new AppError(503, 'ai_unreachable', 'The AI service could not be reached', `Check the server's network access to ${providerHost(provider, ai?.baseURL)}.`);
  }
  if (e instanceof Anthropic.APIError) {
    return new AppError(502, 'ai_error', `The AI service failed (${e.status ?? 'no status'})`);
  }
  return new AppError(500, 'ai_error', e instanceof Error ? e.message : String(e));
}

/** A zod schema as a tool's input schema. */
export function toolInputSchema(schema: z.ZodType): Anthropic.Beta.BetaTool.InputSchema {
  const json = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  delete json.$schema;
  return json as Anthropic.Beta.BetaTool.InputSchema;
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
  return ai.provider.claudeFeatures ? structuredOutput(ai, req) : answerByTool(ai, req);
}

/** Claude: structured outputs, so the response can only be the schema's shape. */
async function structuredOutput<S extends z.ZodType>(ai: AIService, req: StructuredRequest<S>): Promise<{ output: z.infer<S>; model: string }> {
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
    throw toAppError(e, ai);
  }
  stopCheck(message);
  if (message.parsed_output === null || message.parsed_output === undefined) {
    throw new AppError(502, 'ai_unparseable', 'The AI response did not match the expected shape');
  }
  return { output: message.parsed_output as z.infer<S>, model: message.model };
}

const ANSWER = 'answer';

/**
 * Everyone else: the answer comes as the input of a tool the model must call, checked
 * against the same zod schema, with one repair round in zod's own words. Some services
 * ignore structured outputs (DeepSeek answers in prose), but all of them take a forced
 * tool call. Thinking is off for it: DeepSeek refuses a forced tool while thinking, and
 * these are classifications.
 */
async function answerByTool<S extends z.ZodType>(ai: AIService, req: StructuredRequest<S>): Promise<{ output: z.infer<S>; model: string }> {
  const tool: Anthropic.Beta.BetaTool = {
    name: ANSWER,
    description: 'Give your answer. Call it once, with every required field.',
    input_schema: toolInputSchema(req.schema),
  };
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: req.prompt }];
  for (let attempt = 0; ; attempt++) {
    let message;
    try {
      message = await ai.client.beta.messages.create({
        model: ai.model,
        max_tokens: req.maxTokens ?? 16000,
        thinking: { type: 'disabled' },
        system: req.system,
        tools: [tool],
        tool_choice: { type: 'tool', name: ANSWER },
        messages,
      });
    } catch (e) {
      throw toAppError(e, ai);
    }
    stopCheck(message);
    const use = message.content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use' && b.name === ANSWER);
    const input = use ? withNulls(tool.input_schema as JsonSchema, use.input) : undefined;
    const parsed = use ? req.schema.safeParse(input) : null;
    if (parsed?.success) return { output: parsed.data as z.infer<S>, model: message.model };
    if (attempt >= 1) throw new AppError(502, 'ai_unparseable', 'The AI response did not match the expected shape');
    messages.push({ role: 'assistant', content: message.content as Anthropic.Beta.BetaContentBlockParam[] });
    messages.push({
      role: 'user',
      content: use
        ? [{ type: 'tool_result', tool_use_id: use.id, is_error: true, content: `That answer doesn't fit: ${problemsOf(parsed!.error, input)}. Call ${ANSWER} again with a corrected answer.` }]
        : `Call the ${ANSWER} tool with your answer.`,
    });
  }
}

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
}

function admitsNull(s: JsonSchema): boolean {
  if (s.type === 'null' || (Array.isArray(s.type) && s.type.includes('null'))) return true;
  return [...(s.anyOf ?? []), ...(s.oneOf ?? [])].some(admitsNull);
}

/**
 * Some services leave out a key whose answer is null, where the schema requires the key
 * and allows null (the shape structured outputs need). Put the null back, at any depth.
 */
export function withNulls(schema: JsonSchema, value: unknown): unknown {
  const branches = [schema, ...(schema.anyOf ?? []), ...(schema.oneOf ?? [])];
  if (Array.isArray(value)) {
    const items = branches.map((b) => b.items).find((i): i is JsonSchema => Boolean(i) && !Array.isArray(i));
    return items ? value.map((v) => withNulls(items, v)) : value;
  }
  if (value === null || typeof value !== 'object') return value;
  const shape = branches.find((b) => b.properties);
  if (!shape?.properties) return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const [key, sub] of Object.entries(shape.properties)) {
    if (out[key] === undefined) {
      if (shape.required?.includes(key) && admitsNull(sub)) out[key] = null;
    } else {
      out[key] = withNulls(sub, out[key]);
    }
  }
  return out;
}

/** zod's problems, in words a model acts on: a key that isn't there is "missing". */
function problemsOf(error: z.ZodError, input: unknown): string {
  const at = (path: PropertyKey[]) => path.reduce<unknown>((v, k) => (v !== null && typeof v === 'object' ? (v as Record<PropertyKey, unknown>)[k] : undefined), input);
  return error.issues
    .slice(0, 12)
    .map((i) => `${i.path.length ? i.path.join('.') : 'the answer'}: ${i.path.length && at(i.path) === undefined ? 'missing' : i.message}`)
    .join('; ');
}

function stopCheck(message: { stop_reason: string | null; stop_details?: { explanation?: string | null } | null }): void {
  if (message.stop_reason === 'refusal') {
    throw new AppError(422, 'ai_declined', 'The AI declined this request', message.stop_details?.explanation ?? undefined);
  }
  if (message.stop_reason === 'max_tokens') {
    throw new AppError(502, 'ai_truncated', 'The AI response was cut off before it finished');
  }
}
