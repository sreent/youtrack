/**
 * Single sign-on with SAML 2.0, beside OpenID Connect (docs/architecture.md, D27), through
 * @node-saml/node-saml: a4a starts it (an AuthnRequest by the HTTP-Redirect binding), and the
 * provider posts its response to the assertion consumer URL.
 *
 * What the library checks: the signature over the assertion, or over the whole response, against
 * the provider's certificates (one signed assertion only; the assertion it returns is the one the
 * signature covers, so wrapping a signed one around another gains nothing); the issuer; the
 * audience; the time window, with a minute's skew; InResponseTo against a request a4a made, taken
 * once, atomically, in Postgres; and each assertion's id until it would expire, so nothing replays.
 *
 * What a4a adds: the assertion must be for this endpoint (a bearer confirmation whose Recipient is
 * the assertion consumer URL, and no other Destination on the response), and the response must come
 * back to the browser that started (a cookie, as with OIDC's state). Who someone is, and linking
 * them, is services/sso.ts's `personFromProvider`, as for OIDC.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { SAML, ValidateInResponseTo, type CacheItem, type CacheProvider, type Profile } from '@node-saml/node-saml';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { AppServices } from '../context';
import type { SamlConfig } from '../config';
import type { Db } from '../db/client';
import { samlCache } from '../db/schema';
import { sha256 } from '../lib/crypto';
import { startSession } from './auth';
import { providerGroupNames, syncProviderGroups } from './groups';
import { personFromProvider, safeReturnTo, SsoError, type SignedIn } from './sso';

/** How long someone has between leaving for the provider and coming back. */
export const SAML_REQUEST_TTL_MS = 10 * 60_000;
export const SAML_COOKIE = 'a4a_saml';
/** Clocks differ a little: an assertion's time window is stretched by this much at each end. */
export const SAML_SKEW_MS = 60_000;
const METADATA_MAX_AGE_MS = 60 * 60_000;

const MD = 'urn:oasis:names:tc:SAML:2.0:metadata';
const DS = 'http://www.w3.org/2000/09/xmldsig#';
const SAML_NS = 'urn:oasis:names:tc:SAML:2.0:assertion';
const REDIRECT_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const BEARER = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';

/**
 * The little of the DOM read here. @xmldom/xmldom (the parser the SAML library uses) is loaded
 * untyped: its types would bring the browser's DOM into the server's, which changes Node's own
 * `Headers` and `Blob` under every other file.
 */
interface XmlElement {
  getAttribute(name: string): string | null;
  getElementsByTagNameNS(ns: string, local: string): ArrayLike<XmlElement>;
  textContent: string | null;
}
interface XmlDocument {
  documentElement: XmlElement | null;
  getElementsByTagNameNS(ns: string, local: string): ArrayLike<XmlElement>;
}
const { DOMParser } = createRequire(import.meta.url)('@xmldom/xmldom') as {
  DOMParser: new (options?: { errorHandler?: { warning?: (m: string) => void; error?: (m: string) => void } }) => { parseFromString(xml: string, type: string): XmlDocument };
};
/** Warnings and recoverable errors are let pass; what can't be parsed still throws. */
const parseXml = (xml: string): XmlDocument => new DOMParser({ errorHandler: { warning: () => {}, error: () => {} } }).parseFromString(xml, 'text/xml');

/** The provider, as its metadata (or the configuration) sets it out. */
export interface IdpSettings {
  entityId: string;
  ssoUrl: string;
  certs: string[];
}

// ---------------------------------------------------------------------------
// The provider's metadata
// ---------------------------------------------------------------------------

/** Who the provider is, where AuthnRequests go, and the certificates it signs with, from its metadata. */
export function parseIdpMetadata(xml: string, wantEntityId?: string | null): IdpSettings {
  const doc = parseXml(xml);
  const descriptors = Array.from(doc.getElementsByTagNameNS(MD, 'EntityDescriptor')).filter((d) => d.getElementsByTagNameNS(MD, 'IDPSSODescriptor').length > 0);
  const entity = wantEntityId ? descriptors.find((d) => d.getAttribute('entityID') === wantEntityId) : descriptors[0];
  if (!entity) throw new Error(wantEntityId ? `The metadata has no identity provider ${wantEntityId}` : 'The metadata has no identity provider in it');
  const idp = entity.getElementsByTagNameNS(MD, 'IDPSSODescriptor')[0]!;
  const sso = Array.from(idp.getElementsByTagNameNS(MD, 'SingleSignOnService')).find((s) => s.getAttribute('Binding') === REDIRECT_BINDING);
  if (!sso?.getAttribute('Location')) throw new Error('The identity provider takes no AuthnRequest by HTTP-Redirect');
  const certs: string[] = [];
  for (const key of Array.from(idp.getElementsByTagNameNS(MD, 'KeyDescriptor'))) {
    const use = key.getAttribute('use');
    if (use && use !== 'signing') continue;
    for (const c of Array.from(key.getElementsByTagNameNS(DS, 'X509Certificate'))) {
      const body = (c.textContent ?? '').replace(/\s+/g, '');
      if (body) certs.push(body);
    }
  }
  if (!certs.length) throw new Error('The identity provider publishes no signing certificate');
  return { entityId: entity.getAttribute('entityID')!, ssoUrl: sso.getAttribute('Location')!, certs: [...new Set(certs)] };
}

const fetched = new WeakMap<SamlConfig, { at: number; idp: Promise<IdpSettings> }>();

/** The provider: as configured, or from its metadata, fetched at most once an hour (and again after a failure). */
export function idpSettings(cfg: SamlConfig): Promise<IdpSettings> {
  if (!cfg.idpMetadataUrl) return Promise.resolve({ entityId: cfg.idpEntityId!, ssoUrl: cfg.idpSsoUrl!, certs: cfg.idpCerts });
  const hit = fetched.get(cfg);
  if (hit && Date.now() - hit.at < METADATA_MAX_AGE_MS) return hit.idp;
  const idp = (async () => {
    const res = await fetch(cfg.idpMetadataUrl!, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
    if (!res.ok) throw new Error(`the metadata answered ${res.status}`);
    const found = parseIdpMetadata(await res.text(), cfg.idpEntityId);
    // What's set by hand wins over the metadata, so an administrator can pin a certificate or an address.
    return { entityId: found.entityId, ssoUrl: cfg.idpSsoUrl ?? found.ssoUrl, certs: cfg.idpCerts.length ? cfg.idpCerts : found.certs };
  })();
  const entry = { at: Date.now(), idp };
  fetched.set(cfg, entry);
  idp.catch(() => {
    if (fetched.get(cfg) === entry) fetched.delete(cfg);
  });
  return idp;
}

/** What a provider's identities are kept under in user_identities. */
export const samlProviderKey = (idp: Pick<IdpSettings, 'entityId'>) => `saml:${idp.entityId}`;

// ---------------------------------------------------------------------------
// What must be remembered between requests, in Postgres
// ---------------------------------------------------------------------------

/**
 * The library's cache, kept in Postgres so every instance shares it: request ids from the start of
 * a sign-in until its response comes back (taken once, in one statement), and the ids of
 * assertions received until they would expire. Beside a request's row (whose value, the time it
 * was made, the library reads), a second row holds what this sign-in needs back: the browser it
 * started in, and where to go. `takePending` gets it, once the library has taken the request.
 */
class PostgresCache implements CacheProvider {
  private consumedKey: string | null = null;

  constructor(
    private db: Db,
    /** What the sign-in being started needs back. */
    private pending?: string,
  ) {}

  private static key(k: string) {
    return sha256(`saml:${k}`);
  }

  private static pendingKey(k: string) {
    return sha256(`saml-pending:${k}`);
  }

  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    const expiresAt = new Date(Date.now() + SAML_REQUEST_TTL_MS);
    const rows = [{ key: PostgresCache.key(key), value, expiresAt }];
    if (this.pending) rows.push({ key: PostgresCache.pendingKey(key), value: this.pending, expiresAt });
    await this.db
      .insert(samlCache)
      .values(rows)
      .onConflictDoUpdate({ target: samlCache.key, set: { value: sql`excluded.value`, expiresAt } });
    return { value, createdAt: Date.now() };
  }

  /** What the sign-in whose request the library just took needs back, taken with it; null if none was. */
  async takePending(): Promise<string | null> {
    if (!this.consumedKey) return null;
    const [row] = await this.db.delete(samlCache).where(eq(samlCache.key, PostgresCache.pendingKey(this.consumedKey))).returning({ value: samlCache.value });
    return row?.value ?? null;
  }

  /** Whether the library took a request of a4a's for this response. */
  get answeredRequest(): boolean {
    return this.consumedKey !== null;
  }

  async getAsync(key: string): Promise<string | null> {
    const [row] = await this.db
      .select({ value: samlCache.value })
      .from(samlCache)
      .where(and(eq(samlCache.key, PostgresCache.key(key)), sql`${samlCache.expiresAt} > now()`));
    return row?.value ?? null;
  }

  async removeAsync(key: string | null): Promise<string | null> {
    if (!key) return null;
    const [row] = await this.db.delete(samlCache).where(eq(samlCache.key, PostgresCache.key(key))).returning({ value: samlCache.value });
    return row?.value ?? null;
  }

  /** Taken in one statement, so of two copies of one response at once only one gets it. */
  async consumeAsync(key: string): Promise<string | null> {
    const [row] = await this.db.delete(samlCache).where(eq(samlCache.key, PostgresCache.key(key))).returning({ value: samlCache.value, expiresAt: samlCache.expiresAt });
    if (!row || row.expiresAt.getTime() <= Date.now()) return null;
    this.consumedKey = key;
    return row.value;
  }

  async saveIfAbsentAsync(key: string, value: string, expiresAtMs: number): Promise<boolean> {
    const k = PostgresCache.key(key);
    // A row past its time holds nothing back.
    await this.db.delete(samlCache).where(and(eq(samlCache.key, k), lt(samlCache.expiresAt, new Date())));
    const rows = await this.db.insert(samlCache).values({ key: k, value, expiresAt: new Date(expiresAtMs) }).onConflictDoNothing().returning({ key: samlCache.key });
    return rows.length > 0;
  }
}

function samlFor(cfg: SamlConfig, idp: IdpSettings, cache: CacheProvider, requestId?: string): SAML {
  return new SAML({
    callbackUrl: cfg.acsUrl,
    entryPoint: idp.ssoUrl,
    issuer: cfg.spEntityId,
    audience: cfg.spEntityId,
    idpIssuer: idp.entityId,
    idpCert: idp.certs,
    identifierFormat: cfg.nameIdFormat,
    // A signature over the assertion, or over the whole response: at least one, the library insists.
    wantAssertionsSigned: false,
    wantAuthnResponseSigned: false,
    acceptedClockSkewMs: SAML_SKEW_MS,
    validateInResponseTo: cfg.allowIdpInitiated ? ValidateInResponseTo.ifPresent : ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: SAML_REQUEST_TTL_MS,
    rejectReplayedAssertions: true,
    cacheProvider: cache,
    // Let the provider choose how people prove who they are (a password, a passkey, MFA).
    disableRequestedAuthnContext: true,
    ...(requestId ? { generateUniqueId: () => requestId } : {}),
  });
}

/** a4a's service-provider metadata, for the identity provider's administrator. */
export async function spMetadata(app: AppServices): Promise<string> {
  const cfg = app.config.saml;
  if (!cfg) throw new SsoError('refused', 'SAML sign-in is not set up on this server');
  // The metadata names a4a and its endpoint only; it needs no provider settings beyond placeholders.
  const saml = new SAML({
    callbackUrl: cfg.acsUrl,
    issuer: cfg.spEntityId,
    idpCert: 'unused',
    identifierFormat: cfg.nameIdFormat,
    wantAssertionsSigned: false,
    wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.always,
    rejectReplayedAssertions: true,
    cacheProvider: new PostgresCache(app.db),
  });
  return saml.generateServiceProviderMetadata(null, null);
}

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

function sameText(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** Begin: remember the request (and the browser it's for), and send the browser to the provider. */
export async function startSamlSignIn(app: AppServices, returnTo: string | undefined): Promise<{ url: string; browser: string }> {
  const cfg = app.config.saml;
  if (!cfg) throw new SsoError('refused', 'SAML sign-in is not set up on this server');
  const idp = await idpSettings(cfg).catch((e: unknown) => {
    console.error(`saml: the metadata of ${cfg.idpMetadataUrl} could not be read: ${e instanceof Error ? e.message : String(e)}`);
    throw new SsoError('failed', `${cfg.name} can't be reached just now. Try again in a moment.`);
  });
  await app.db.delete(samlCache).where(lt(samlCache.expiresAt, new Date()));
  const browser = randomBytes(32).toString('base64url');
  const requestId = `_${randomBytes(20).toString('hex')}`;
  const pending = JSON.stringify({ browser: sha256(browser), returnTo: safeReturnTo(returnTo) });
  const url = await samlFor(cfg, idp, new PostgresCache(app.db, pending), requestId).getAuthorizeUrlAsync('', undefined, {});
  return { url, browser };
}

/** The values of an attribute, as text. */
function attributeValues(profile: Profile, name: string | null): string[] {
  if (!name) return [];
  const raw = (profile.attributes as Record<string, unknown> | undefined)?.[name] ?? profile[name];
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return list.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
}

const EMAIL_ATTRIBUTES = ['email', 'mail', 'urn:oid:0.9.2342.19200300.100.1.3', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'];
const NAME_ATTRIBUTES = ['displayName', 'name', 'urn:oid:2.16.840.1.113730.3.1.241', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name', 'cn'];
const GIVEN = ['givenName', 'urn:oid:2.5.4.42', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'];
const SURNAME = ['sn', 'surname', 'urn:oid:2.5.4.4', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname'];
const EMAIL_FORMAT = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';

function first(profile: Profile, configured: string | null, usual: string[]): string | null {
  for (const n of configured ? [configured] : usual) {
    const v = attributeValues(profile, n)[0];
    if (v) return v;
  }
  return null;
}

/**
 * The assertion must be for this endpoint: a bearer confirmation in it whose Recipient is the
 * assertion consumer URL (SAML profiles 4.1.4.2), read from the assertion the signature covers.
 * And the response, if it names a Destination, must name this one.
 */
function assertForThisEndpoint(cfg: SamlConfig, profile: Profile): void {
  const same = (a: string | null, b: string) => {
    try {
      return a !== null && new URL(a).href === new URL(b).href;
    } catch {
      return false;
    }
  };
  const signed = profile.getAssertionXml?.();
  if (!signed) throw new Error('no signed assertion to read');
  const assertion = parseXml(signed);
  const recipients = Array.from(assertion.getElementsByTagNameNS(SAML_NS, 'SubjectConfirmation'))
    .filter((c) => c.getAttribute('Method') === BEARER)
    .flatMap((c) => Array.from(c.getElementsByTagNameNS(SAML_NS, 'SubjectConfirmationData')).map((d) => d.getAttribute('Recipient')));
  if (!recipients.some((r) => same(r, cfg.acsUrl))) throw new Error(`no bearer confirmation in the assertion is for ${cfg.acsUrl}`);
  const response = parseXml(profile.getSamlResponseXml?.() ?? '<none/>').documentElement;
  const destination = response?.getAttribute('Destination') || null;
  if (destination && !same(destination, cfg.acsUrl)) throw new Error(`the response is for ${destination}`);
}

/**
 * The provider posted its response. Check everything, find or make the person, and start a new
 * session. `browserCookie` is the cookie set when this browser started.
 */
export async function finishSamlSignIn(
  app: AppServices,
  form: { SAMLResponse?: string; RelayState?: string },
  browserCookie: string | undefined,
  userAgent?: string,
): Promise<SignedIn> {
  const cfg = app.config.saml;
  if (!cfg) throw new SsoError('refused', 'SAML sign-in is not set up on this server');
  if (!form.SAMLResponse) throw new SsoError('failed', `${cfg.name} sent nothing back`);
  const idp = await idpSettings(cfg).catch(() => {
    throw new SsoError('failed', `${cfg.name} can't be reached just now`);
  });
  const cache = new PostgresCache(app.db);
  let profile: Profile | null;
  try {
    profile = (await samlFor(cfg, idp, cache).validatePostResponseAsync({ SAMLResponse: form.SAMLResponse })).profile;
    if (!profile) throw new Error('no assertion');
    assertForThisEndpoint(cfg, profile);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    console.warn(`saml: a sign-in with ${cfg.name} was refused: ${why}`);
    // The provider said no (the person cancelled, or isn't allowed in there).
    if (/SAML provider returned (Responder|Requester) error: .*(AuthnFailed|RequestDenied)/.test(why)) throw new SsoError('cancelled', `${cfg.name} didn't sign you in`);
    if (/InResponseTo|already been received/.test(why)) throw new SsoError('expired', 'This sign-in has already been used, or has run out of time');
    throw new SsoError('failed', `${cfg.name} didn't confirm who you are`);
  }

  // A response to a request of a4a's: it must come back to the browser that started it.
  let returnTo: string;
  if (cache.answeredRequest) {
    const pending = JSON.parse((await cache.takePending()) ?? '{}') as { browser?: string; returnTo?: string };
    if (!browserCookie || !pending.browser || !sameText(sha256(browserCookie), pending.browser)) {
      throw new SsoError('expired', 'This sign-in was started in another browser or tab, or has run out of time');
    }
    returnTo = safeReturnTo(pending.returnTo);
  } else if (cfg.allowIdpInitiated) {
    // Started at the provider: there's no request to answer, and no browser to match.
    returnTo = safeReturnTo(form.RelayState);
  } else {
    throw new SsoError('refused', `Sign in from a4a's sign-in page: signing in started at ${cfg.name} isn't allowed here`);
  }

  const nameId = profile.nameID?.trim();
  if (!nameId) throw new SsoError('failed', `${cfg.name} didn't say who you are`);
  const fromNameId = profile.nameIDFormat === EMAIL_FORMAT && nameId.includes('@') ? nameId : null;
  const email = (first(profile, cfg.emailAttribute, EMAIL_ATTRIBUTES) ?? fromNameId)?.toLowerCase() ?? null;
  const given = first(profile, null, GIVEN);
  const surname = first(profile, null, SURNAME);
  const name = first(profile, cfg.nameAttribute, NAME_ATTRIBUTES) ?? ([given, surname].filter(Boolean).join(' ') || null);
  const user = await personFromProvider(
    app,
    { key: samlProviderKey(idp), name: cfg.name, allowedDomains: cfg.allowedDomains, createUsers: cfg.createUsers, createWithUnverifiedEmail: true },
    {
      subject: nameId,
      email,
      emailVerified: cfg.trustEmail && email !== null,
      login: email ? email.slice(0, email.indexOf('@')) : /^[\w.-]{2,36}$/.test(nameId) ? nameId : null,
      name,
    },
  );
  if (cfg.groupsAttribute) await syncProviderGroups(app, user.id, providerGroupNames(attributeValues(profile, cfg.groupsAttribute)));
  const session = await startSession(app.db, user.id, app.config.sessionTtlDays, userAgent, { with: 'saml' });
  return { user, ...session, returnTo };
}
