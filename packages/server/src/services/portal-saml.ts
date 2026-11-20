/**
 * SAML for requesters (D63's revisit): a portal provider whose kind is `saml`, beside OpenID
 * Connect. The same library and checks as the team's SAML (D27, services/saml.ts) - the signature,
 * the issuer, the audience, the time window, InResponseTo taken once, the endpoint's own Recipient
 * and Destination - with each provider's own entry point, certificate and entity id from its row,
 * and one assertion consumer serves them all, the state saying which provider it was.
 */
import { randomBytes } from 'node:crypto';
import { SAML, ValidateInResponseTo, type Profile } from '@node-saml/node-saml';
import { and, eq, lt } from 'drizzle-orm';
import type { AppServices } from '../context';
import { portalProviders, portalSsoStates, requesterIdentities, samlCache } from '../db/schema';
import { sha256 } from '../lib/crypto';
import { PostgresCache } from './saml';
import { PortalSsoError, startPortalSession, tellOfSignIn, PORTAL_SSO_TTL_MS } from './portal-sign-in';
import { requesterByEmail } from './customer-groups';

type ProviderRow = typeof portalProviders.$inferSelect;

export const portalAcsUrl = (app: AppServices) => `${app.config.publicUrl}/api/v1/portal/sso/callback`;
const portalSpId = (app: AppServices) => `${app.config.publicUrl}/api/v1/portal/saml/metadata`;

function samlFor(app: AppServices, row: ProviderRow, cache: PostgresCache): SAML {
  return new SAML({
    callbackUrl: portalAcsUrl(app),
    entryPoint: row.samlEntryPoint!,
    issuer: portalSpId(app),
    audience: portalSpId(app),
    idpIssuer: row.samlEntityId!,
    idpCert: [row.samlCert!],
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: PORTAL_SSO_TTL_MS,
    acceptedClockSkewMs: 60_000,
  });
}

/** Start the SAML sign-in: the AuthnRequest, and the state the browser must bring back. */
export async function startPortalSaml(app: AppServices, row: ProviderRow, deskKey: string | null): Promise<{ url: string; state: string }> {
  await app.db.delete(samlCache).where(lt(samlCache.expiresAt, new Date()));
  const state = randomBytes(32).toString('base64url');
  await app.db.insert(portalSsoStates).values({ id: sha256(state), providerId: row.id, desk: deskKey, codeVerifier: '', nonce: '', expiresAt: new Date(Date.now() + PORTAL_SSO_TTL_MS) });
  const url = await samlFor(app, row, new PostgresCache(app.db, JSON.stringify({ state: sha256(state) }))).getAuthorizeUrlAsync('', state, {});
  return { url, state };
}

const EMAIL_ATTRS = ['email', 'mail', 'urn:oid:0.9.2342.19200300.100.1.3', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'] as const;
const NAME_ATTRS = ['displayName', 'name', 'cn'] as const;

function attr(profile: Profile, names: readonly string[]): string | null {
  for (const n of names) {
    const raw = (profile.attributes as Record<string, unknown> | undefined)?.[n] ?? profile[n];
    const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
    const first = list.find((v): v is string => typeof v === 'string' && v.trim() !== '');
    if (typeof first === 'string') return first.trim();
  }
  return null;
}

/**
 * The provider posted its response: check everything, find the requester by the email it vouches
 * for, and start a session opened through it. The same words as the OIDC path's refusals.
 */
export async function finishPortalSaml(app: AppServices, form: { SAMLResponse?: string; RelayState?: string }, browserState: string | undefined, ttlMs: number): Promise<{ session: string; desk: string | null }> {
  const state = form.RelayState ?? '';
  if (!state || !browserState || state !== browserState) throw new PortalSsoError('expired', 'This sign-in was started in another browser or tab, or has run out of time');
  const [pending] = await app.db.delete(portalSsoStates).where(eq(portalSsoStates.id, sha256(state))).returning();
  if (!pending || pending.expiresAt.getTime() < Date.now()) throw new PortalSsoError('expired', 'This sign-in has already been used, or has run out of time');
  const [row] = await app.db.select().from(portalProviders).where(eq(portalProviders.id, pending.providerId));
  if (!row || row.kind !== 'saml') throw new PortalSsoError('refused', 'That provider was removed', pending.desk);
  let profile: Profile | null;
  try {
    profile = (await samlFor(app, row, new PostgresCache(app.db)).validatePostResponseAsync({ SAMLResponse: form.SAMLResponse ?? '' })).profile;
    if (!profile) throw new Error('no assertion');
  } catch (e) {
    console.warn(`portal saml: a sign-in through ${row.name} was refused: ${e instanceof Error ? e.message : String(e)}`);
    throw new PortalSsoError('failed', `${row.name} didn't confirm who they are`, pending.desk);
  }
  const email = attr(profile, EMAIL_ATTRS)?.toLowerCase() ?? null;
  if (!email) throw new PortalSsoError('unverified', `${row.name} hasn't verified their email`, pending.desk);
  const domain = email.slice(email.indexOf('@') + 1);
  if (row.domains.length && !row.domains.includes(domain)) throw new PortalSsoError('domain', `${row.name} vouches for other domains`, pending.desk);
  const name = attr(profile, NAME_ATTRS) ?? undefined;
  const requester = await requesterByEmail(app.db, email, name);
  const firstTime = await app.db.insert(requesterIdentities).values({ requesterId: requester.id, providerId: row.id, subject: email }).onConflictDoNothing().returning();
  if (!firstTime.length) {
    await app.db.update(requesterIdentities).set({ subject: email, lastAt: new Date() }).where(and(eq(requesterIdentities.requesterId, requester.id), eq(requesterIdentities.providerId, row.id)));
  }
  if (firstTime.length) await tellOfSignIn(app, requester.id, 'provider', row.name);
  const session = await startPortalSession(app.db, requester.id, { method: 'sso', providerId: row.id }, ttlMs);
  return { session, desk: pending.desk };
}
