/**
 * Who serves the model. a4a is built for Claude, and gets every feature from it. It can
 * also run on a service that speaks Anthropic's Messages API, such as DeepSeek or Qwen;
 * those get the portable subset of each request (see D14 in docs/architecture.md).
 *
 * Choosing one sends issue text to that service, so it is never inferred from which
 * keys happen to be set: AI_PROVIDER names it.
 */
export const AI_PROVIDER_IDS = ['anthropic', 'deepseek', 'qwen', 'compatible'] as const;
export type AIProviderId = (typeof AI_PROVIDER_IDS)[number];

export interface AIProvider {
  id: AIProviderId;
  /** Its name, for people: "DeepSeek". */
  label: string;
  /** Where requests go. Unset for Anthropic means the SDK's own default, or ANTHROPIC_BASE_URL. */
  baseURL: string | undefined;
  /** The environment variables that may hold its key; the first one set is used. */
  keyVars: readonly string[];
  /** The model when AI_MODEL isn't set. */
  defaultModel: string | undefined;
  /**
   * Claude's own request features: structured outputs, refusal fallbacks, thinking
   * shown as progress updates, and automatic prompt caching.
   */
  claudeFeatures: boolean;
}

export const AI_PROVIDERS: Record<AIProviderId, AIProvider> = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    baseURL: undefined,
    keyVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    defaultModel: 'claude-opus-5-5',
    claudeFeatures: true,
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/anthropic',
    keyVars: ['DEEPSEEK_API_KEY'],
    defaultModel: 'deepseek-v4-pro',
    claudeFeatures: false,
  },
  qwen: {
    id: 'qwen',
    label: 'Qwen',
    // Alibaba Cloud Model Studio, international region. Its keys are per region:
    // for mainland China set AI_BASE_URL=https://dashscope.aliyuncs.com/apps/anthropic.
    baseURL: 'https://dashscope-intl.aliyuncs.com/apps/anthropic',
    keyVars: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
    defaultModel: 'qwen3.8-max',
    claudeFeatures: false,
  },
  compatible: {
    id: 'compatible',
    label: 'an Anthropic-compatible service',
    baseURL: undefined,
    keyVars: ['AI_API_KEY'],
    defaultModel: undefined,
    claudeFeatures: false,
  },
};

export function isAIProviderId(id: string): id is AIProviderId {
  return (AI_PROVIDER_IDS as readonly string[]).includes(id);
}

/** The key the provider's variables hold, if any. Never logged. */
export function providerKey(provider: AIProvider, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const v of provider.keyVars) if (env[v]) return env[v];
  return undefined;
}

/** The host requests go to, for "could not be reached" hints. */
export function providerHost(provider: AIProvider, baseURL: string | undefined): string {
  const url = baseURL ?? provider.baseURL ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
