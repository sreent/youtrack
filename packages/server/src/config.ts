import { existsSync } from 'node:fs';
import path from 'node:path';
import { AI_PROVIDER_IDS, AI_PROVIDERS, isAIProviderId, providerKey, type AIProviderId } from './ai/providers';

/** Single sign-on with an OpenID Connect provider, from OIDC_* in the environment. */
export interface OidcConfig {
  /** The provider's issuer, exactly as its discovery document gives it. */
  issuer: string;
  clientId: string;
  /** Empty for a public client (PKCE alone). */
  clientSecret: string | null;
  scopes: string;
  /** What the sign-in page calls it: "Sign in with <name>". */
  name: string;
  /** Lower-case email domains allowed in; empty: any the provider vouches for. */
  allowedDomains: string[];
  /** Give someone an account the first time they sign in, when no account has their email. */
  createUsers: boolean;
  /** Where the provider sends people back: PUBLIC_URL's /api/v1/auth/oidc/callback, registered with the provider as is. */
  redirectUri: string;
}

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
  oidc: OidcConfig | null;
  /** Whether people may sign in with a password. It can be off only when single sign-on is on. */
  passwordLogin: boolean;
}

const truthy = (v: string | undefined, fallback: boolean) => (v === undefined || v.trim() === '' ? fallback : /^(1|true|yes|on)$/i.test(v.trim()));

/** OIDC_* from the environment; a half-made configuration stops the server with what's missing. */
export function oidcFromEnv(env: NodeJS.ProcessEnv, publicUrl: string): OidcConfig | null {
  const issuer = env.OIDC_ISSUER?.trim();
  const clientId = env.OIDC_CLIENT_ID?.trim();
  if (!issuer && !clientId) return null;
  if (!issuer || !clientId) throw new Error('Single sign-on needs both OIDC_ISSUER and OIDC_CLIENT_ID: set both, or neither.');
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error(`OIDC_ISSUER is not a URL: ${issuer}`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('OIDC_ISSUER must be https (plain http is allowed only for a provider on this machine, for development).');
  }
  return {
    issuer,
    clientId,
    clientSecret: env.OIDC_CLIENT_SECRET?.trim() || null,
    scopes: env.OIDC_SCOPES?.trim() || 'openid email profile',
    name: env.OIDC_NAME?.trim() || url.hostname,
    allowedDomains: (env.OIDC_ALLOWED_DOMAINS ?? '')
      .split(',')
      .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean),
    createUsers: truthy(env.OIDC_CREATE_USERS, false),
    redirectUri: new URL(`${publicUrl}/api/v1/auth/oidc/callback`).href,
  };
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
  const publicUrl = (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '');
  const oidc = oidcFromEnv(env, overrides.publicUrl ?? publicUrl);
  // Turning passwords off without single sign-on would let nobody in: then it stays on.
  const passwordLogin = !oidc || truthy(env.PASSWORD_LOGIN, true);
  if (oidc === null && !truthy(env.PASSWORD_LOGIN, true)) console.warn('PASSWORD_LOGIN=false is ignored: single sign-on is not configured (OIDC_ISSUER), so nobody could sign in.');
  return {
    port,
    publicUrl,
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
    oidc,
    passwordLogin,
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
