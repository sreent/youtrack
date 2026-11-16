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
  /** Postgres for the LISTEN connection, when DATABASE_URL goes through a pooler that drops LISTEN. */
  databaseListenUrl: string | undefined;
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
  /**
   * How many proxies in front of the server append to X-Forwarded-For (a load
   * balancer: 1). The client's address is the entry the outermost of them added;
   * with 0 the header is ignored, since anyone can send it.
   */
  trustProxy: number;
  /** Requests per minute per token, user or address, on each instance. */
  apiRateLimit: number;
  mcpRateLimit: number;
  /** The largest file one upload may carry (ATTACHMENT_MAX_MB, default 20). */
  attachmentMaxBytes: number;
  /** All the files on one issue, its comments' included, or on one article (ATTACHMENTS_PER_ISSUE_MB, default 100). */
  attachmentsPerIssueMaxBytes: number;
  /** Where files go: "local", under DATA_DIR/attachments, is the one store so far (ATTACHMENT_STORAGE). */
  attachmentStorage: 'local';
  /** SMTP server for email, e.g. smtp://user:pass@mail.example.com:587. Without it, no email is sent and nothing fails. */
  smtpUrl: string | undefined;
  /** Who email comes from, e.g. "a4a <a4a@example.com>". */
  mailFrom: string;
  /** Changes to one issue within this long fold into one notification (and one email). */
  notifyWindowMs: number;
  /** The hour (server time, 0-23) the daily digest goes out. */
  digestHour: number;
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

function intEnv(value: string | undefined, fallback: number, min = 0): number {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isInteger(n) && n >= min ? n : fallback;
}

/** Megabytes from the environment, as bytes (1 MB = 1024 × 1024 bytes). */
function megabytes(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Math.round((Number.isFinite(n) && n > 0 ? n : fallback) * 1024 * 1024);
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

function hostnameOf(url: string | undefined): string {
  try {
    return url ? new URL(url).hostname : 'localhost';
  } catch {
    return 'localhost';
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
  if (env.ATTACHMENT_STORAGE && env.ATTACHMENT_STORAGE !== 'local') {
    throw new Error(`ATTACHMENT_STORAGE=${env.ATTACHMENT_STORAGE} isn't available: files are stored on local disk ("local") so far`);
  }
  return {
    port,
    publicUrl,
    databaseUrl: env.DATABASE_URL || undefined,
    databaseListenUrl: env.DATABASE_LISTEN_URL || undefined,
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
    trustProxy: intEnv(env.TRUST_PROXY, 0),
    apiRateLimit: intEnv(env.API_RATE_LIMIT, 1200, 1),
    mcpRateLimit: intEnv(env.MCP_RATE_LIMIT, 600, 1),
    attachmentMaxBytes: megabytes(env.ATTACHMENT_MAX_MB, 20),
    attachmentsPerIssueMaxBytes: megabytes(env.ATTACHMENTS_PER_ISSUE_MB, 100),
    attachmentStorage: 'local',
    smtpUrl: env.SMTP_URL || undefined,
    mailFrom: env.MAIL_FROM || `a4a <a4a@${hostnameOf(env.PUBLIC_URL)}>`,
    notifyWindowMs: Math.max(0, Number(env.NOTIFY_WINDOW_SECONDS ?? 120)) * 1000,
    digestHour: Math.min(23, Math.max(0, Number(env.DIGEST_HOUR ?? 8))),
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
