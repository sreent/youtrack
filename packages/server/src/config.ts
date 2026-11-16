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
  /** The ID token claim that names the groups someone is in (OIDC_GROUPS_CLAIM), for groups from the provider (D27). */
  groupsClaim?: string | null;
}

/** Single sign-on with a SAML 2.0 identity provider, from SAML_* in the environment (D27). */
export interface SamlConfig {
  /** What the sign-in page calls it: "Sign in with <name>". */
  name: string;
  /** Where the provider's metadata is (https; plain http only on this machine). Or the three below, by hand. */
  idpMetadataUrl: string | null;
  idpEntityId: string | null;
  /** Where AuthnRequests go, by the HTTP-Redirect binding. */
  idpSsoUrl: string | null;
  /** The provider's signing certificates (PEM or base64), more than one while it rolls a key over. */
  idpCerts: string[];
  /** a4a's own entity id, and where the provider posts responses (PUBLIC_URL's /api/v1/auth/saml/acs). */
  spEntityId: string;
  acsUrl: string;
  /** The NameID format to ask for; null asks for none and takes the provider's choice. */
  nameIdFormat: string | null;
  /** Attributes to read; null for email and name tries the usual names. */
  emailAttribute: string | null;
  nameAttribute: string | null;
  groupsAttribute: string | null;
  /** Whether the email the provider asserts counts as verified (SAML has no email_verified): off unless set. */
  trustEmail: boolean;
  allowedDomains: string[];
  createUsers: boolean;
  /** Sign-in started at the provider, with no request of a4a's to answer: refused unless set. */
  allowIdpInitiated: boolean;
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
  saml: SamlConfig | null;
  /** Whether people may sign in with a password. It can be off only when single sign-on (OIDC or SAML) is on. */
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
  /**
   * Whether a4a is the OAuth 2.1 authorization server for /mcp (MCP_OAUTH, on unless "false"), so
   * MCP clients that sign in by themselves need no token (D28). Only over https, or plain http on
   * this machine for development: with any other PUBLIC_URL it stays off.
   */
  mcpOAuth: boolean;
  /**
   * A mailbox the help desks read their mail from, e.g. imaps://support%40acme.example:pass@imap.acme.example/INBOX
   * (HELPDESK_IMAP_URL). Each message goes to the desk whose address it was sent to (D30).
   */
  helpdeskImapUrl: string | undefined;
  /** How often that mailbox is read (HELPDESK_IMAP_POLL_SECONDS, default 60). */
  helpdeskImapPollMs: number;
  /** The largest message a help desk takes by email, attachments included (HELPDESK_MAIL_MAX_MB, default 25). */
  helpdeskMailMaxBytes: number;
  /** How hard a help desk's proof of work is: the most numbers a browser may have to try (HELPDESK_CAPTCHA_MAX_NUMBER). */
  helpdeskCaptchaMaxNumber: number;
}

const truthy = (v: string | undefined, fallback: boolean) => (v === undefined || v.trim() === '' ? fallback : /^(1|true|yes|on)$/i.test(v.trim()));

/** Whether an address is https, or plain http on this machine (for development and tests). */
export function secureOrLocal(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch {
    return false;
  }
}

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
    groupsClaim: env.OIDC_GROUPS_CLAIM?.trim() || null,
  };
}

/** https, or plain http only on this machine (development and tests). */
function safeProviderUrl(raw: string, variable: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${variable} is not a URL: ${raw}`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`${variable} must be https (plain http is allowed only for a provider on this machine, for development).`);
  }
  return url.href;
}

/** Certificates as given: PEM blocks, or base64 bodies separated by commas. */
export function certificatesFrom(raw: string | undefined): string[] {
  const v = (raw ?? '').trim();
  if (!v) return [];
  if (v.includes('-----BEGIN CERTIFICATE-----')) return v.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  return v
    .split(',')
    .map((c) => c.replace(/\s+/g, ''))
    .filter(Boolean);
}

/** SAML_* from the environment; a half-made configuration stops the server with what's missing. */
export function samlFromEnv(env: NodeJS.ProcessEnv, publicUrl: string): SamlConfig | null {
  const metadataUrl = env.SAML_IDP_METADATA_URL?.trim();
  const ssoUrl = env.SAML_IDP_SSO_URL?.trim();
  if (!metadataUrl && !ssoUrl) return null;
  const idpCerts = certificatesFrom(env.SAML_IDP_CERT);
  const idpEntityId = env.SAML_IDP_ENTITY_ID?.trim() || null;
  if (!metadataUrl && (!idpCerts.length || !idpEntityId)) {
    throw new Error('SAML needs SAML_IDP_METADATA_URL, or all of SAML_IDP_SSO_URL, SAML_IDP_ENTITY_ID and SAML_IDP_CERT.');
  }
  const idpMetadataUrl = metadataUrl ? safeProviderUrl(metadataUrl, 'SAML_IDP_METADATA_URL') : null;
  const idpSsoUrl = ssoUrl ? safeProviderUrl(ssoUrl, 'SAML_IDP_SSO_URL') : null;
  const allowedDomains = (env.SAML_ALLOWED_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
  const trustEmail = truthy(env.SAML_TRUST_EMAIL, false);
  // A domain is only worth checking on an email the provider vouches for.
  if (allowedDomains.length && !trustEmail) throw new Error('SAML_ALLOWED_DOMAINS needs SAML_TRUST_EMAIL=true: a domain is only worth checking on an email the provider vouches for.');
  const createUsers = truthy(env.SAML_CREATE_USERS, false);
  if (!trustEmail && !createUsers) {
    console.warn('SAML: neither SAML_TRUST_EMAIL nor SAML_CREATE_USERS is on, so nobody can sign in with SAML for the first time.');
  }
  return {
    name: env.SAML_NAME?.trim() || new URL(idpMetadataUrl ?? idpSsoUrl!).hostname,
    idpMetadataUrl,
    idpEntityId,
    idpSsoUrl,
    idpCerts,
    spEntityId: env.SAML_SP_ENTITY_ID?.trim() || `${publicUrl}/api/v1/auth/saml/metadata`,
    acsUrl: new URL(`${publicUrl}/api/v1/auth/saml/acs`).href,
    nameIdFormat: env.SAML_NAMEID_FORMAT?.trim() || null,
    emailAttribute: env.SAML_EMAIL_ATTRIBUTE?.trim() || null,
    nameAttribute: env.SAML_NAME_ATTRIBUTE?.trim() || null,
    groupsAttribute: env.SAML_GROUPS_ATTRIBUTE?.trim() || null,
    trustEmail,
    allowedDomains,
    createUsers,
    allowIdpInitiated: truthy(env.SAML_ALLOW_IDP_INITIATED, false),
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
  const saml = samlFromEnv(env, overrides.publicUrl ?? publicUrl);
  // Turning passwords off without single sign-on would let nobody in: then it stays on.
  const passwordLogin = !(oidc || saml) || truthy(env.PASSWORD_LOGIN, true);
  if (oidc === null && saml === null && !truthy(env.PASSWORD_LOGIN, true)) {
    console.warn('PASSWORD_LOGIN=false is ignored: single sign-on is not configured (OIDC_ISSUER or SAML_IDP_*), so nobody could sign in.');
  }
  if (env.ATTACHMENT_STORAGE && env.ATTACHMENT_STORAGE !== 'local') {
    throw new Error(`ATTACHMENT_STORAGE=${env.ATTACHMENT_STORAGE} isn't available: files are stored on local disk ("local") so far`);
  }
  // OAuth's endpoints must be https (MCP's authorization specification): elsewhere, tokens only.
  const wantOAuth = truthy(env.MCP_OAUTH, true);
  const mcpOAuth = wantOAuth && secureOrLocal(overrides.publicUrl ?? publicUrl);
  if (wantOAuth && !mcpOAuth) console.warn('OAuth for MCP is off: PUBLIC_URL is not https, so MCP clients connect with API tokens only (set MCP_OAUTH=false to say so).');
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
    saml,
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
    mcpOAuth,
    helpdeskImapUrl: env.HELPDESK_IMAP_URL?.trim() || undefined,
    helpdeskImapPollMs: intEnv(env.HELPDESK_IMAP_POLL_SECONDS, 60, 10) * 1000,
    helpdeskMailMaxBytes: megabytes(env.HELPDESK_MAIL_MAX_MB, 25),
    helpdeskCaptchaMaxNumber: intEnv(env.HELPDESK_CAPTCHA_MAX_NUMBER, 100_000, 100),
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
