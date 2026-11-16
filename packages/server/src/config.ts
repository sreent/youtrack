import { existsSync } from 'node:fs';
import path from 'node:path';
import { AI_PROVIDER_IDS, AI_PROVIDERS, isAIProviderId, providerKey, type AIProviderId } from './ai/providers';

export interface Config {
  port: number;
  publicUrl: string;
  databaseUrl: string | undefined;
  dataDir: string;
  seedDemo: boolean;
  /** Who serves the model: AI_PROVIDER, Anthropic unless set. */
  aiProvider: AIProviderId;
  /** AI_BASE_URL: where requests go, when not the provider's own address. */
  aiBaseUrl: string | undefined;
  aiModel: string;
  aiEnabled: boolean;
  /** Why the AI is off, in words for the person running the server; null when it's on. */
  aiOffReason: string | null;
  webDist: string | undefined;
  sessionTtlDays: number;
  isDev: boolean;
}

function loadDotEnv() {
  const candidates = [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../../.env')];
  for (const file of candidates) {
    if (existsSync(file)) {
      try {
        process.loadEnvFile(file);
      } catch {
        // ignore malformed .env
      }
      return;
    }
  }
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  loadDotEnv();
  const env = process.env;
  const port = Number(env.PORT ?? 3000);
  const webDistCandidates = [
    env.WEB_DIST,
    path.resolve(process.cwd(), '../../apps/web/dist'),
    path.resolve(process.cwd(), 'apps/web/dist'),
  ].filter(Boolean) as string[];
  const ai = aiSettings(env);
  return {
    port,
    publicUrl: (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    databaseUrl: env.DATABASE_URL || undefined,
    dataDir: path.resolve(env.DATA_DIR || path.resolve(process.cwd(), 'data')),
    seedDemo: (env.SEED_DEMO ?? 'true') !== 'false',
    aiProvider: ai.provider,
    aiBaseUrl: ai.baseUrl,
    aiModel: ai.model,
    aiEnabled: ai.offReason === null,
    aiOffReason: ai.offReason,
    webDist: webDistCandidates.find((p) => existsSync(path.join(p, 'index.html'))),
    sessionTtlDays: Number(env.SESSION_TTL_DAYS ?? 30),
    isDev: env.NODE_ENV !== 'production',
    ...overrides,
  };
}

/** The AI's provider, address and model, and why it's off if it is. A mistake here turns the AI off, never the tracker. */
export function aiSettings(env: NodeJS.ProcessEnv): { provider: AIProviderId; baseUrl: string | undefined; model: string; offReason: string | null } {
  const named = (env.AI_PROVIDER || 'anthropic').trim().toLowerCase();
  const known = isAIProviderId(named);
  const provider = AI_PROVIDERS[known ? named : 'anthropic'];
  const baseUrl = env.AI_BASE_URL?.trim() || undefined;
  const model = env.AI_MODEL?.trim() || provider.defaultModel || '';
  const offReason = !known
    ? `AI_PROVIDER is "${env.AI_PROVIDER}", which a4a doesn't know; use one of ${AI_PROVIDER_IDS.join(', ')}`
    : env.AI_DISABLED === 'true'
      ? 'AI_DISABLED is set on the server'
      : !providerKey(provider, env)
        ? `${provider.keyVars[0]} is not set on the server`
        : provider.id === 'compatible' && !baseUrl
          ? 'AI_BASE_URL is not set on the server'
          : !model
            ? 'AI_MODEL is not set on the server'
            : null;
  return { provider: provider.id, baseUrl, model, offReason };
}
