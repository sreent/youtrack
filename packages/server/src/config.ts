import { DEFAULT_LOCALE, isLocale, LOCALES, type Locale } from '@a4a/shared/i18n';
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { getDomain, getDomainWithoutSuffix } from 'tldts';
import { AI_PROVIDER_IDS, AI_PROVIDERS, isAIProviderId, providerKey, type AIProviderId } from './ai/providers';
import { validPublicKey, vapidPairMatches } from './push/webpush';

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

/** An S3-compatible bucket for files, from S3_* in the environment (D35). */
export interface S3Config {
  bucket: string;
  /** The store's address: none for AWS itself; MinIO's, R2's or another's otherwise (S3_ENDPOINT). */
  endpoint: string | undefined;
  region: string;
  /** Before every key, so a bucket can hold more than a4a's files: "a4a/" puts them under a4a/ (S3_PREFIX). */
  prefix: string;
  /** The bucket in the path rather than the host name, as most stores other than AWS want (S3_FORCE_PATH_STYLE). */
  forcePathStyle: boolean;
  /** S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY when both are set; otherwise the AWS chain (environment, profile, the machine's role). */
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | null;
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
  /** How many times a person may ask for writing and reading help in an hour (AI_WRITING_MAX_PER_HOUR, D59). */
  aiWritingMaxPerHour: number;
  webDist: string | undefined;
  sessionTtlDays: number;
  isDev: boolean;
  oidc: OidcConfig | null;
  saml: SamlConfig | null;
  /** Whether people may sign in with a password. It can be off only when another way in is on: OIDC, SAML or a directory (LDAP). */
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
  /** Requests per minute per address from guests, who aren't signed in (GUEST_RATE_LIMIT, D37). */
  guestRateLimit: number;
  /** The largest file one upload may carry (ATTACHMENT_MAX_MB, default 20). */
  attachmentMaxBytes: number;
  /** All the files on one issue, its comments' included, or on one article (ATTACHMENTS_PER_ISSUE_MB, default 100). */
  attachmentsPerIssueMaxBytes: number;
  /** Where files go (ATTACHMENT_STORAGE): "local", under DATA_DIR/attachments, or "s3", the bucket in `s3`. */
  attachmentStorage: 'local' | 's3';
  /** The bucket, when S3_BUCKET is set: where files go with "s3", and where the copy command takes them. */
  s3: S3Config | null;
  /** SMTP server for email, e.g. smtp://user:pass@mail.example.com:587. Without it, no email is sent and nothing fails. */
  smtpUrl: string | undefined;
  /** Who email comes from, e.g. "a4a <a4a@example.com>". */
  mailFrom: string;
  /**
   * The address the team's replies to notification emails go to (MAIL_REPLY_ADDRESS, D45), plus a
   * token: its mail must reach a4a as a desk's does (the shared mailbox, or a desk's webhook).
   */
  mailReplyAddress: string | undefined;
  /** Changes to one issue within this long fold into one notification (and one email). */
  notifyWindowMs: number;
  /**
   * How long an idle connection stays open (KEEP_ALIVE_SECONDS, 65 s): longer than whatever is in
   * front keeps one idle, or it can send a request down a connection a4a has just closed (a 502).
   * Behind Google's external Application Load Balancer, which keeps them ten minutes, 620.
   */
  keepAliveMs: number;
  /** The hour (0-23) the daily digest goes out, in each person's own time zone (D31). */
  digestHour: number;
  /** The language a4a writes in to whoever chose none, and shows a browser that asks for none it speaks (DEFAULT_LOCALE, D49). */
  defaultLocale: Locale;
  /**
   * Whether a4a is the OAuth 2.1 authorization server for /mcp (MCP_OAUTH, on unless "false"), so
   * MCP clients that sign in by themselves need no token (D28). Only over https, or plain http on
   * this machine for development: with any other PUBLIC_URL it stays off.
   */
  mcpOAuth: boolean;
  /**
   * The relying party id passkeys are made for (PASSKEY_RP_ID, D68); unset, PUBLIC_URL's host. A
   * registrable parent of that host, chosen ahead of a move, or the host an instance moved from when
   * PUBLIC_URL's origin is among the related origins.
   */
  passkeyRpId: string | undefined;
  /** The origins `/.well-known/webauthn` names related to the relying party (PASSKEY_RELATED_ORIGINS, D68). */
  passkeyRelatedOrigins: string[];
  /**
   * FIDO's Metadata Service, read only while only some authenticators are taken (D68): its BLOB from
   * `url` (PASSKEY_MDS_URL), or from `file` instead (PASSKEY_MDS_FILE); signed by a certificate that
   * chains to `rootCerts` (PASSKEY_MDS_ROOT_CERT, PEM), FIDO's own roots when unset.
   */
  passkeyMds: { url: string; file: string | undefined; rootCerts: string[] | undefined; allowHttpLoopback: boolean };
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
  /**
   * The mail servers whose Authentication-Results a4a trusts, by their authserv-ids, lower case
   * (HELPDESK_TRUSTED_AUTHSERV_IDS, comma-separated, D67): an email whose sender's domain passed
   * DMARC at one of them, said in the topmost such header, is known to be from its sender.
   */
  helpdeskTrustedAuthservIds: string[];
  /**
   * Hosts an import may read from although their addresses are inside the network
   * (IMPORT_ALLOW_HOSTS, comma-separated names): a YouTrack or Jira of the company's own.
   * Every other host must be public. https always.
   */
  importAllowHosts: string[];
  /** For tests: an import may read over plain http from this machine (IMPORT_ALLOW_HTTP_LOOPBACK). Never in production. */
  importAllowHttpLoopback: boolean;
  /**
   * App catalogs (D48): JSON indexes at https addresses, comma-separated (APP_CATALOGS). An
   * administrator installs from them, each package checked against the digest its catalog names.
   */
  appCatalogs: string[];
  /**
   * Ed25519 public keys an app's signature may be made with (APP_TRUSTED_KEYS, comma-separated,
   * base64 of the 32-byte key or PEM). A catalog that signs its apps has each one checked against them.
   */
  appTrustedKeys: string[];
  /** The largest app package, in bytes (APP_MAX_MB, default 5). */
  appMaxBytes: number;
  /** For tests: catalogs and packages may be read over plain http from this machine (APP_ALLOW_HTTP_LOOPBACK). */
  appAllowHttpLoopback: boolean;
  /**
   * The key secrets a4a reads back are encrypted with (SECRET_KEY): a TOTP secret (D38). The same on
   * every instance. Without it, one is made in DATA_DIR/secret.key the first time it's needed.
   */
  secretKey: string | undefined;
  /** Sign-in with a password checked against an LDAP directory, from LDAP_* in the environment (D38). */
  ldap: LdapConfig | null;
  /**
   * The OAuth apps people connect their own code-host accounts through (D46): GITHUB_CLIENT_ID and
   * _SECRET (GITHUB_URL for GitHub Enterprise Server), GITLAB_* (GITLAB_URL for a self-managed one),
   * BITBUCKET_* (an OAuth consumer of Bitbucket Cloud), and FORGEJO_* or GITEA_* with the instance's
   * own address, FORGEJO_URL or GITEA_URL (D54). A provider without one isn't offered.
   */
  codeHosts: CodeHostApps;
  /** For tests: version control and code hosts may be reached over plain http on this machine (VCS_ALLOW_HTTP_LOOPBACK). Never in production. */
  vcsAllowHttpLoopback: boolean;
  /** Check runs a4a writes through one GitHub App installation a minute, across every instance (D66): VCS_CHECKS_PER_MINUTE. */
  vcsChecksPerMinute: number;
  /**
   * Whether an MCP client may be known by a client ID metadata document: an https client_id whose
   * metadata a4a reads (MCP_OAUTH_CLIENT_DOCUMENTS, on unless "false"; D38).
   */
  oauthClientDocuments: boolean;
  /** For tests: a client ID metadata document may be read over plain http from this machine. Never in production. */
  oauthClientDocumentsAllowHttpLoopback: boolean;
  /** A Microsoft Teams bot, from TEAMS_* in the environment (D42); null without one. */
  teams: TeamsConfig | null;
  /** Slack's Web API (SLACK_API_URL, for tests): https://slack.com/api. */
  slackApiUrl: string;
  /** For tests: chat services may be reached over plain http on this machine (CHAT_ALLOW_HTTP_LOOPBACK). Never in production. */
  chatAllowHttpLoopback: boolean;
  /** How many issues one person may make from chat messages in ten minutes (CHAT_ISSUE_LIMIT, D60). */
  chatIssueLimit: number;
  /** Push notifications to people's devices (D47). */
  push: PushConfig;
}

/**
 * A Teams bot registered with Azure Bot Service (D42): its Entra app's id and secret, and the one
 * tenant it serves. Bot Framework signs what Teams sends; the bot calls Teams with a token from Entra.
 */
export interface TeamsConfig {
  appId: string;
  appPassword: string;
  tenantId: string;
  /** Bot Framework's OpenID metadata, whose keys sign what Teams sends (TEAMS_OPENID_METADATA_URL, for tests). */
  openIdMetadataUrl: string;
  /** Where the bot gets its token to call Teams: the tenant's token endpoint at Entra (TEAMS_TOKEN_URL, for tests). */
  tokenUrl: string;
  /** The hosts a service URL may name: Bot Framework's (TEAMS_SERVICE_HOSTS, comma-separated, to add one). */
  serviceHosts: string[];
}

/** Bot Framework's hosts for Teams: the public cloud's, and the government clouds'. */
export const TEAMS_SERVICE_HOSTS = ['smba.trafficmanager.net', 'smba.infra.gcc.teams.microsoft.com', 'smba.infra.gov.teams.microsoft.us', 'smba.infra.dod.teams.microsoft.us'];

/** TEAMS_* from the environment: all three of the app's id, its secret and its tenant, or none. */
export function teamsFromEnv(env: NodeJS.ProcessEnv): TeamsConfig | null {
  const appId = env.TEAMS_APP_ID?.trim();
  const appPassword = env.TEAMS_APP_PASSWORD?.trim();
  const tenantId = env.TEAMS_TENANT_ID?.trim();
  if (!appId && !appPassword && !tenantId) return null;
  if (!appId || !appPassword || !tenantId) {
    throw new Error('A Teams bot needs TEAMS_APP_ID, TEAMS_APP_PASSWORD and TEAMS_TENANT_ID (its Entra app, the secret, and the tenant): set all three, or none.');
  }
  const extra = (env.TEAMS_SERVICE_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return {
    appId,
    appPassword,
    tenantId,
    openIdMetadataUrl: safeProviderUrl(env.TEAMS_OPENID_METADATA_URL?.trim() || 'https://login.botframework.com/v1/.well-known/openidconfiguration', 'TEAMS_OPENID_METADATA_URL'),
    tokenUrl: safeProviderUrl(env.TEAMS_TOKEN_URL?.trim() || `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, 'TEAMS_TOKEN_URL'),
    serviceHosts: [...new Set([...TEAMS_SERVICE_HOSTS, ...extra])],
  };
}

/** Web Push (D47): the key a4a signs with, who it says it is, and the push services it sends to. */
export interface PushConfig {
  /** Whether a4a sends push notifications at all (PUSH, on unless "false"). */
  enabled: boolean;
  /** VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, both or neither; without them a pair is made once and kept, sealed, in the database. */
  vapid: { publicKey: string; privateKey: string } | null;
  /** Who a push service may contact about a4a's messages (VAPID_SUBJECT): PUBLIC_URL when it's https, otherwise mailto: MAIL_FROM's address. */
  subject: string;
  /**
   * The push services' hosts a4a sends to (PUSH_HOSTS, comma-separated; "*.example.com" for any host under it).
   * By default the browsers' own: Chrome's, Firefox's, Safari's and Edge's.
   */
  hosts: string[];
  /** For tests: plain http to this machine. Never in production (PUSH_ALLOW_HTTP_LOOPBACK). */
  allowHttpLoopback: boolean;
}

/** The push services browsers subscribe with: Chrome, Android, Samsung and Opera (FCM), Firefox, Safari and iOS, Edge (WNS). */
export const DEFAULT_PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', '*.notify.windows.com'];

/** An LDAP directory people sign in with (D38): bind as a service account, find the person, bind as them. */
export interface LdapConfig {
  /** ldaps://host:636, or ldap://host:389 with StartTLS (plain ldap only to this machine). */
  url: string;
  startTls: boolean;
  /** Who a4a binds as to search; null for an anonymous search. */
  bindDn: string | null;
  bindPassword: string | null;
  baseDn: string;
  /** The search for a person, with {login} for what they typed (escaped). */
  userFilter: string;
  loginAttribute: string;
  emailAttribute: string;
  nameAttribute: string;
  /** A person's stable id there: objectGUID (Active Directory), entryUUID, or their DN when neither is sent. */
  idAttribute: string | null;
  /** The attribute listing a person's groups as DNs (memberOf); null to search for groups instead, or for none. */
  groupsAttribute: string | null;
  /** Where to search for groups, with {dn} for the person's DN; null for none. */
  groupBaseDn: string | null;
  groupFilter: string;
  groupNameAttribute: string;
  /** PEM certificates to trust for the directory's TLS, beside the system's. */
  caCerts: string[];
  name: string;
  createUsers: boolean;
  trustEmail: boolean;
  allowedDomains: string[];
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

/** PEM certificates from LDAP_CA_CERT: the text itself, or a file's path. */
function pemCerts(value: string | undefined): string[] {
  const v = value?.trim();
  if (!v) return [];
  const text = v.includes('-----BEGIN') ? v.replace(/\\n/g, '\n') : readFileSync(v, 'utf8');
  return text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

/** LDAP_* from the environment; a half-made configuration stops the server with what's missing (D38). */
export function ldapFromEnv(env: NodeJS.ProcessEnv): LdapConfig | null {
  const raw = env.LDAP_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`LDAP_URL=${raw} isn't an address: give ldaps://host:636, or ldap://host:389 with LDAP_STARTTLS=true`);
  }
  const startTls = truthy(env.LDAP_STARTTLS, false);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'ldaps:' && url.protocol !== 'ldap:') throw new Error(`LDAP_URL must be ldaps:// or ldap://, not ${url.protocol}`);
  // A password goes to the directory: never in the clear, but to this machine (development, tests).
  if (url.protocol === 'ldap:' && !startTls && !local) throw new Error('LDAP_URL is plain ldap://: use ldaps://, or set LDAP_STARTTLS=true, since people’s passwords go to the directory');
  const baseDn = env.LDAP_BASE_DN?.trim();
  if (!baseDn) throw new Error('LDAP needs LDAP_BASE_DN: where to look for people, e.g. dc=acme,dc=example');
  const bindDn = env.LDAP_BIND_DN?.trim() || null;
  const bindPassword = env.LDAP_BIND_PASSWORD ?? null;
  if (bindDn && !bindPassword) throw new Error('LDAP_BIND_DN needs LDAP_BIND_PASSWORD');
  const userFilter = env.LDAP_USER_FILTER?.trim() || '(|(uid={login})(sAMAccountName={login})(userPrincipalName={login})(mail={login}))';
  if (!userFilter.includes('{login}')) throw new Error('LDAP_USER_FILTER must hold {login}, where what the person typed goes');
  const allowedDomains = (env.LDAP_ALLOWED_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
  const trustEmail = truthy(env.LDAP_TRUST_EMAIL, false);
  if (allowedDomains.length && !trustEmail) throw new Error('LDAP_ALLOWED_DOMAINS needs LDAP_TRUST_EMAIL=true: a domain is only worth checking on an email the directory vouches for.');
  return {
    url: url.href.replace(/\/$/, ''),
    startTls,
    bindDn,
    bindPassword,
    baseDn,
    userFilter,
    loginAttribute: env.LDAP_LOGIN_ATTRIBUTE?.trim() || 'uid',
    emailAttribute: env.LDAP_EMAIL_ATTRIBUTE?.trim() || 'mail',
    nameAttribute: env.LDAP_NAME_ATTRIBUTE?.trim() || 'displayName',
    idAttribute: env.LDAP_ID_ATTRIBUTE?.trim() || null,
    groupsAttribute: env.LDAP_GROUPS_ATTRIBUTE?.trim() || null,
    groupBaseDn: env.LDAP_GROUP_BASE_DN?.trim() || null,
    groupFilter: env.LDAP_GROUP_FILTER?.trim() || '(|(member={dn})(uniqueMember={dn}))',
    groupNameAttribute: env.LDAP_GROUP_NAME_ATTRIBUTE?.trim() || 'cn',
    caCerts: pemCerts(env.LDAP_CA_CERT),
    name: env.LDAP_NAME?.trim() || url.hostname,
    createUsers: truthy(env.LDAP_CREATE_USERS, false),
    trustEmail,
    allowedDomains,
  };
}

function intEnv(value: string | undefined, fallback: number, min = 0): number {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isInteger(n) && n >= min ? n : fallback;
}

/** Megabytes from the environment, as bytes (1 MB = 1024 × 1024 bytes). */
/** The bucket from S3_*, or null without S3_BUCKET. Half a pair of keys is a mistake, said at once. */
export function s3FromEnv(env: NodeJS.ProcessEnv): S3Config | null {
  const bucket = env.S3_BUCKET?.trim();
  if (!bucket) return null;
  const endpoint = env.S3_ENDPOINT?.trim().replace(/\/+$/, '') || undefined;
  if (endpoint && !/^https?:\/\/[^/\s]+/i.test(endpoint)) {
    throw new Error(`S3_ENDPOINT=${endpoint} isn't an address: give the store's http(s) URL, e.g. https://s3.example.com or http://minio:9000`);
  }
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error('Set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither (then the AWS chain gives the keys: its environment, a profile, or the machine\'s role)');
  }
  const sessionToken = env.S3_SESSION_TOKEN?.trim();
  const prefix = (env.S3_PREFIX ?? '').trim().replace(/^\/+/, '');
  return {
    bucket,
    endpoint,
    region: env.S3_REGION?.trim() || env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim() || 'us-east-1',
    prefix: prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix,
    forcePathStyle: truthy(env.S3_FORCE_PATH_STYLE, Boolean(endpoint)),
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) } : null,
  };
}

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

/** PUSH, VAPID_* and PUSH_HOSTS (D47). A key pair half given, or not a pair, stops the server, saying which. */
export function pushFromEnv(env: NodeJS.ProcessEnv, publicUrl: string, mailFrom: string): PushConfig {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  if (Boolean(publicKey) !== Boolean(privateKey)) {
    throw new Error(`VAPID_${publicKey ? 'PRIVATE' : 'PUBLIC'}_KEY is missing: give both keys of the pair, or neither and a4a makes one`);
  }
  if (publicKey && privateKey && !(validPublicKey(publicKey) && vapidPairMatches({ publicKey, privateKey }))) {
    throw new Error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not one P-256 pair (base64url, as `npx web-push generate-vapid-keys` writes them)');
  }
  const address = /<([^>]+)>/.exec(mailFrom)?.[1] ?? mailFrom.trim();
  const subject = env.VAPID_SUBJECT?.trim() || (publicUrl.startsWith('https://') ? publicUrl : `mailto:${address}`);
  if (!/^(mailto:|https:\/\/)/.test(subject)) throw new Error(`VAPID_SUBJECT=${subject} must be a mailto: address or an https address, for push services to reach you`);
  const hosts = (env.PUSH_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return {
    enabled: truthy(env.PUSH, true),
    vapid: publicKey && privateKey ? { publicKey, privateKey } : null,
    subject,
    hosts: hosts.length ? hosts : DEFAULT_PUSH_HOSTS,
    allowHttpLoopback: truthy(env.PUSH_ALLOW_HTTP_LOOPBACK, false),
  };
}

/** DEFAULT_LOCALE: one of the languages there are catalogs for (packages/shared/i18n). */
function localeEnv(value: string | undefined): Locale {
  const v = value?.trim().toLowerCase();
  if (!v) return DEFAULT_LOCALE;
  if (!isLocale(v)) throw new Error(`DEFAULT_LOCALE must be one of ${LOCALES.join(', ')}, not "${value}"`);
  return v;
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
  const ldap = ldapFromEnv(env);
  // Turning a4a's own passwords off with no other way in would let nobody in: then they stay on.
  // LDAP's passwords are the directory's, so it counts as another way in.
  const passwordLogin = !(oidc || saml || ldap) || truthy(env.PASSWORD_LOGIN, true);
  if (oidc === null && saml === null && ldap === null && !truthy(env.PASSWORD_LOGIN, true)) {
    console.warn('PASSWORD_LOGIN=false is ignored: neither single sign-on nor LDAP is configured (OIDC_ISSUER, SAML_IDP_* or LDAP_URL), so nobody could sign in.');
  }
  const attachmentStorage = (env.ATTACHMENT_STORAGE || 'local').trim().toLowerCase();
  if (attachmentStorage !== 'local' && attachmentStorage !== 's3') {
    throw new Error(`ATTACHMENT_STORAGE=${env.ATTACHMENT_STORAGE} isn't a store a4a knows: use "local" (files under DATA_DIR/attachments) or "s3" (a bucket, S3_BUCKET)`);
  }
  const s3 = s3FromEnv(env);
  if (attachmentStorage === 's3' && !s3) throw new Error('ATTACHMENT_STORAGE=s3 needs S3_BUCKET: the bucket files go in');
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
    seedDemo: truthy(env.SEED_DEMO, true),
    aiProvider: ai.provider,
    aiBaseUrl: ai.baseUrl,
    aiModel: ai.model,
    aiEnabled: ai.offReason === null,
    aiOffReason: ai.offReason,
    aiWritingMaxPerHour: intEnv(env.AI_WRITING_MAX_PER_HOUR, 100, 1),
    webDist: webDistCandidates.find((p) => existsSync(path.join(p, 'index.html'))),
    sessionTtlDays: Number(env.SESSION_TTL_DAYS ?? 30),
    isDev: env.NODE_ENV !== 'production',
    oidc,
    saml,
    passwordLogin,
    trustProxy: intEnv(env.TRUST_PROXY, 0),
    apiRateLimit: intEnv(env.API_RATE_LIMIT, 1200, 1),
    mcpRateLimit: intEnv(env.MCP_RATE_LIMIT, 600, 1),
    guestRateLimit: intEnv(env.GUEST_RATE_LIMIT, 300, 1),
    attachmentMaxBytes: megabytes(env.ATTACHMENT_MAX_MB, 20),
    attachmentsPerIssueMaxBytes: megabytes(env.ATTACHMENTS_PER_ISSUE_MB, 100),
    attachmentStorage,
    s3,
    smtpUrl: env.SMTP_URL || undefined,
    mailFrom: env.MAIL_FROM || `a4a <a4a@${hostnameOf(env.PUBLIC_URL)}>`,
    mailReplyAddress: env.MAIL_REPLY_ADDRESS?.trim().toLowerCase() || undefined,
    notifyWindowMs: Math.max(0, Number(env.NOTIFY_WINDOW_SECONDS ?? 120)) * 1000,
    keepAliveMs: intEnv(env.KEEP_ALIVE_SECONDS, 65, 1) * 1000,
    digestHour: Math.min(23, Math.max(0, Number(env.DIGEST_HOUR ?? 8))),
    defaultLocale: localeEnv(env.DEFAULT_LOCALE),
    mcpOAuth,
    helpdeskImapUrl: env.HELPDESK_IMAP_URL?.trim() || undefined,
    helpdeskImapPollMs: intEnv(env.HELPDESK_IMAP_POLL_SECONDS, 60, 10) * 1000,
    helpdeskMailMaxBytes: megabytes(env.HELPDESK_MAIL_MAX_MB, 25),
    helpdeskCaptchaMaxNumber: intEnv(env.HELPDESK_CAPTCHA_MAX_NUMBER, 100_000, 100),
    helpdeskTrustedAuthservIds: (env.HELPDESK_TRUSTED_AUTHSERV_IDS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    importAllowHosts: (env.IMPORT_ALLOW_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    importAllowHttpLoopback: truthy(env.IMPORT_ALLOW_HTTP_LOOPBACK, false),
    appCatalogs: (env.APP_CATALOGS ?? '')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean),
    appTrustedKeys: (env.APP_TRUSTED_KEYS ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
    appMaxBytes: megabytes(env.APP_MAX_MB, 5),
    appAllowHttpLoopback: truthy(env.APP_ALLOW_HTTP_LOOPBACK, false),
    secretKey: env.SECRET_KEY?.trim() || undefined,
    ldap,
    codeHosts: codeHostsFromEnv(env),
    vcsAllowHttpLoopback: truthy(env.VCS_ALLOW_HTTP_LOOPBACK, false),
    vcsChecksPerMinute: intEnv(env.VCS_CHECKS_PER_MINUTE, 20, 1),
    oauthClientDocuments: truthy(env.MCP_OAUTH_CLIENT_DOCUMENTS, true),
    oauthClientDocumentsAllowHttpLoopback: truthy(env.OAUTH_CLIENT_DOCUMENTS_ALLOW_HTTP_LOOPBACK, false),
    teams: teamsFromEnv(env),
    slackApiUrl: safeProviderUrl(env.SLACK_API_URL?.trim() || 'https://slack.com/api', 'SLACK_API_URL').replace(/\/+$/, ''),
    chatAllowHttpLoopback: truthy(env.CHAT_ALLOW_HTTP_LOOPBACK, false),
    chatIssueLimit: intEnv(env.CHAT_ISSUE_LIMIT, 10, 1),
    push: pushFromEnv(env, overrides.publicUrl ?? publicUrl, env.MAIL_FROM || `a4a <a4a@${hostnameOf(env.PUBLIC_URL)}>`),
    ...passkeysFromEnv(env, overrides.publicUrl ?? publicUrl),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Passkeys that outlive a move, and FIDO's metadata (D68)
// ---------------------------------------------------------------------------

/** FIDO's Metadata Service: where its BLOB is published (MDS3). */
export const FIDO_MDS_URL = 'https://mds3.fidoalliance.org/';
/** Browsers read at most five registrable domains' labels from a relying party's related origins. */
export const MAX_RELATED_LABELS = 5;
const PSL = { allowPrivateDomains: true };

const hostOf = (url: string): string => new URL(url).hostname.toLowerCase();
const isLocalHost = (host: string) => host === 'localhost' || host.endsWith('.localhost');

/**
 * Whether a domain is one a site may be registered under, by the public suffix list (tldts, pinned):
 * not a public suffix itself (`co.uk`, `github.io`), and not an address. Browsers use the same list,
 * private entries included, and refuse a relying party id that is a suffix on it.
 */
export function registrable(domain: string): boolean {
  return !isIP(domain) && getDomain(domain, PSL) !== null;
}

/** PASSKEY_RELATED_ORIGINS: https origins (http only on localhost), with at most five registrable domains between them. */
export function relatedOriginsFromEnv(value: string | undefined): string[] {
  const origins: string[] = [];
  for (const raw of (value ?? '').split(',').map((v) => v.trim()).filter(Boolean)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error(`PASSKEY_RELATED_ORIGINS: "${raw}" isn't an address; give origins such as https://a4a.example.com, separated by commas`);
    }
    const host = u.hostname.toLowerCase();
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalHost(host))) throw new Error(`PASSKEY_RELATED_ORIGINS: ${raw} must be https: browsers use passkeys only in a secure context`);
    if (isIP(host.replace(/^\[|\]$/g, ''))) throw new Error(`PASSKEY_RELATED_ORIGINS: ${raw} is an address, not a domain; passkeys need a domain`);
    if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || u.username) throw new Error(`PASSKEY_RELATED_ORIGINS: ${raw} must be an origin alone, such as ${u.origin}, without a path`);
    if (!origins.includes(u.origin)) origins.push(u.origin);
  }
  if (origins.length > 20) throw new Error('PASSKEY_RELATED_ORIGINS names more than 20 origins');
  const labels = new Set(origins.map((o) => getDomainWithoutSuffix(hostOf(o), PSL) ?? hostOf(o)));
  if (labels.size > MAX_RELATED_LABELS) {
    throw new Error(`PASSKEY_RELATED_ORIGINS spans ${labels.size} registrable domains (${[...labels].join(', ')}); browsers read at most ${MAX_RELATED_LABELS}, so the rest would never be related`);
  }
  return origins;
}

/**
 * PASSKEY_RP_ID, checked at start: PUBLIC_URL's host; a parent domain of it that isn't a public suffix
 * (`example.com` for `a4a.example.com`), which every browser takes there; or, once an instance has
 * moved, the host it moved from, when PUBLIC_URL's origin is among the related origins that host serves.
 */
export function passkeyRpIdFromEnv(value: string | undefined, publicUrl: string, related: string[]): string | undefined {
  const raw = value?.trim().toLowerCase().replace(/\.$/, '');
  if (!raw) return undefined;
  let id: string;
  try {
    // Through URL, so an international name is the punycode browsers compare.
    id = new URL(`https://${raw}`).hostname;
  } catch {
    throw new Error(`PASSKEY_RP_ID=${value} isn't a domain name`);
  }
  if (isIP(id.replace(/^\[|\]$/g, ''))) throw new Error(`PASSKEY_RP_ID=${value} is an address: a relying party id is a domain name`);
  const host = hostOf(publicUrl);
  if (id === host) return id;
  if (host.endsWith(`.${id}`)) {
    if (!registrable(id)) throw new Error(`PASSKEY_RP_ID=${value} is a public suffix, which anyone can register under: browsers make no passkeys for it. Use the domain your organisation registered, such as ${getDomain(host, PSL) ?? host}`);
    return id;
  }
  if (related.includes(new URL(publicUrl).origin)) {
    if (!registrable(id) && !isLocalHost(id)) throw new Error(`PASSKEY_RP_ID=${value} is a public suffix: browsers make no passkeys for it`);
    return id;
  }
  throw new Error(
    `PASSKEY_RP_ID=${value} must be PUBLIC_URL's host (${host}) or a parent domain of it, such as ${getDomain(host, PSL) ?? host}; or, for an instance that moved from ${value}, keep it and add PUBLIC_URL's origin (${new URL(publicUrl).origin}) to PASSKEY_RELATED_ORIGINS`,
  );
}

/** PASSKEY_MDS_ROOT_CERT: the PEM certificates FIDO's BLOB must chain to, read at start. */
function mdsRootsFromEnv(file: string | undefined): string[] | undefined {
  if (!file?.trim()) return undefined;
  let pem: string;
  try {
    pem = readFileSync(file.trim(), 'utf8');
  } catch (e) {
    throw new Error(`PASSKEY_MDS_ROOT_CERT=${file} can't be read: ${e instanceof Error ? e.message : String(e)}`);
  }
  const certs = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (!certs.length) throw new Error(`PASSKEY_MDS_ROOT_CERT=${file} holds no PEM certificate`);
  return certs.map((c) => `${c}\n`);
}

export function passkeysFromEnv(env: NodeJS.ProcessEnv, publicUrl: string): Pick<Config, 'passkeyRpId' | 'passkeyRelatedOrigins' | 'passkeyMds'> {
  const passkeyRelatedOrigins = relatedOriginsFromEnv(env.PASSKEY_RELATED_ORIGINS);
  const allowHttpLoopback = truthy(env.PASSKEY_MDS_ALLOW_HTTP_LOOPBACK, false);
  const url = env.PASSKEY_MDS_URL?.trim() || FIDO_MDS_URL;
  const u = new URL(url);
  if (u.protocol !== 'https:' && !(allowHttpLoopback && u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))) {
    throw new Error(`PASSKEY_MDS_URL=${url} must be https: a4a trusts what it reads there only by its signature, and fetches it in the open otherwise`);
  }
  return {
    passkeyRpId: passkeyRpIdFromEnv(env.PASSKEY_RP_ID, publicUrl, passkeyRelatedOrigins),
    passkeyRelatedOrigins,
    passkeyMds: { url, file: env.PASSKEY_MDS_FILE?.trim() || undefined, rootCerts: mdsRootsFromEnv(env.PASSKEY_MDS_ROOT_CERT), allowHttpLoopback },
  };
}

export interface CodeHostApp {
  clientId: string;
  clientSecret: string;
  /** Where people sign in: https://github.com, https://gitlab.com, https://bitbucket.org, a Forgejo's own. */
  webUrl: string;
  /** Its API: https://api.github.com, https://gitlab.com/api/v4, https://api.bitbucket.org, a Forgejo's /api/v1. */
  apiUrl: string;
  /** What people call it, where that isn't the provider's own name: "Forgejo" or "Gitea", by which was set up. */
  name?: string;
}
export type CodeHostApps = Partial<Record<'github' | 'gitlab' | 'bitbucket' | 'gitea', CodeHostApp>>;

export function codeHostsFromEnv(env: NodeJS.ProcessEnv): CodeHostApps {
  const out: CodeHostApps = {};
  const app = (prefix: string) => {
    const clientId = env[`${prefix}_CLIENT_ID`]?.trim();
    const clientSecret = env[`${prefix}_CLIENT_SECRET`]?.trim();
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  };
  const trim = (u: string) => u.trim().replace(/\/+$/, '');
  const gh = app('GITHUB');
  if (gh) {
    const webUrl = trim(env.GITHUB_URL || 'https://github.com');
    out.github = { ...gh, webUrl, apiUrl: /^https:\/\/github\.com$/i.test(webUrl) ? 'https://api.github.com' : `${webUrl}/api/v3` };
  }
  const gl = app('GITLAB');
  if (gl) {
    const webUrl = trim(env.GITLAB_URL || 'https://gitlab.com');
    out.gitlab = { ...gl, webUrl, apiUrl: `${webUrl}/api/v4` };
  }
  const bb = app('BITBUCKET');
  if (bb) out.bitbucket = { ...bb, webUrl: 'https://bitbucket.org', apiUrl: 'https://api.bitbucket.org' };
  // Gitea and Forgejo are one provider in a4a (gitea), each at its own address: there's no default one.
  // FORGEJO_* is read first, so a server that names both connects to Forgejo.
  for (const [prefix, name] of [['FORGEJO', 'Forgejo'], ['GITEA', 'Gitea']] as const) {
    const forge = app(prefix);
    const url = env[`${prefix}_URL`]?.trim();
    if (!forge || !url || out.gitea) continue;
    const webUrl = trim(url);
    out.gitea = { ...forge, webUrl, apiUrl: `${webUrl}/api/v1`, name };
  }
  return out;
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
