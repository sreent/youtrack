/**
 * The portal's own sign-in (docs/architecture.md, D63): how each desk's requesters sign in, beside
 * the link emailed to them (D45). A password they set by a link sent to their email; and identity
 * providers for requesters, apart from the team's (D16): OpenID Connect through openid-client, the
 * authorization code flow with PKCE, a state bound to the browser and a nonce, the ID token's
 * signature checked against the provider's keys.
 *
 * - A provider is the server's, made by an administrator, and any desk may offer it: it vouches for
 *   who someone is, and a requester is one person at every desk (a row per address, D24).
 * - A desk chooses the ways it takes. A session opens a desk's requests only when it was opened in
 *   one of them (`portalSessionOpens`, services/access.ts), so one desk's choice never loosens
 *   another's.
 * - A requester's password and a member's are kept apart, checked apart, and open different
 *   sessions: neither ever signs anyone in on the other side.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { HelpdeskSignIn, PortalProvider, PortalSignInMethods } from '@a4a/shared';
import { langTag } from '@a4a/shared/i18n';
import { and, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { startPortalSaml } from './portal-saml';
import * as oidc from 'openid-client';
import { requireScope, type AppServices, type Ctx } from '../context';
import type { Db } from '../db/client';
import { customerGroups, portalProviders, portalSsoStates, requesterIdentities, requesterSessions, requesterSignIns, requesters } from '../db/schema';
import { captchaChallenge, checkCaptcha } from '../helpdesk/captcha';
import { deskTranslator } from '../helpdesk/mails';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors';
import { newId } from '../lib/ids';
import { open, seal } from '../lib/secret-box';
import { AUTOMATIC, composeMail, type RenderedMail } from '../mail/compose';
import { enqueueMail, kickMail, type MailRow } from '../mail/outbox';
import { mailConfigured } from '../notify/state';
import { emailDomain, projectAccess, type PortalSignedIn } from './access';
import { requesterByEmail } from './customer-groups';
import { passkeyOffered } from './portal-passkeys';
import { projectSettings } from './projects';
import type { ProjectRow } from './schema-cache';

type ProviderRow = typeof portalProviders.$inferSelect;
type RequesterRow = typeof requesters.$inferSelect;

/** A link that sets a requester's password: as a sign-in link is, good once for 20 minutes, kept as a hash. */
const PASSWORD_PREFIX = 'hdp_';
const PASSWORD_LINK_TTL_MS = 20 * 60_000;
export const PORTAL_SSO_COOKIE = 'a4a_portal_sso';
export const PORTAL_SSO_PATH = '/api/v1/portal/sso';
export const PORTAL_SSO_TTL_MS = 10 * 60_000;
/** The captcha's "desk" for the portal's password sign-in: no project's key has a star, so a form's challenge never passes here, nor this one there. */
const PORTAL_CAPTCHA = '*';
const MAX_PROVIDERS = 50;

const keySource = (app: AppServices) => ({ secretKey: app.config.secretKey, dataDir: app.config.dataDir });

/** Where every requesters' provider sends the browser back: one address for all, the state saying which provider it was. */
export function portalRedirectUri(app: AppServices): string {
  return `${app.config.publicUrl.replace(/\/+$/, '')}/api/v1/portal/sso/callback`;
}

/** A desk's choice, as its settings keep it. */
export function deskSignIn(p: ProjectRow): HelpdeskSignIn {
  return projectSettings(p).helpdesk.signIn;
}

/** A desk that takes requests, by its key: what a sign-in page may name. Anything else is no desk, alike. */
function openDesk(projects: Map<string, ProjectRow>, key: string | null | undefined): ProjectRow | undefined {
  const p = key ? projects.get(key.trim().toUpperCase()) : undefined;
  return p && !p.archived && projectSettings(p).helpdesk.enabled ? p : undefined;
}

const taking = (projects: Iterable<ProjectRow>) => [...projects].filter((p) => !p.archived && projectSettings(p).helpdesk.enabled);

// ---------------------------------------------------------------------------
// A desk's choice (settings.helpdesk.signIn), checked as it's saved
// ---------------------------------------------------------------------------

/**
 * What a desk's new choice must be: one way at least, providers that exist, and none taken off that
 * one of its customer groups still signs in through. With what its history says of the change.
 */
export async function checkDeskSignIn(ctx: Ctx, project: ProjectRow, input: HelpdeskSignIn, current: HelpdeskSignIn) {
  const providers = [...new Set(input.providers)];
  // Left out, a desk keeps whether it takes passkeys (D69): a script written before them doesn't turn them off.
  const passkey = input.passkey ?? Boolean(current.passkey);
  if (!input.link && !input.password && !providers.length) {
    // A passkey is added once a requester is signed in another way: alone, it would let nobody new in.
    if (passkey) throw badRequest('A passkey can’t be a desk’s only way in', 'Requesters add one once they’re signed in: keep the emailed link, a password or an identity provider beside it.').said('portalSignIn.passkeyNotAlone');
    throw badRequest('A desk needs one way at least for its requesters to sign in', 'Keep the emailed link, or choose a password or an identity provider.').said('portalSignIn.oneWayAtLeast');
  }
  const known = providers.length ? await ctx.db.select({ id: portalProviders.id, name: portalProviders.name }).from(portalProviders).where(inArray(portalProviders.id, providers)) : [];
  const missing = providers.find((id) => !known.some((k) => k.id === id));
  if (missing) throw badRequest(`There's no identity provider ${missing}`, 'Choose one an administrator added for requesters.').said('portalSignIn.unknownProvider', { id: missing });
  const dropped = current.providers.filter((id) => !providers.includes(id));
  if (dropped.length) {
    const [tied] = await ctx.db
      .select({ group: customerGroups.name, provider: portalProviders.name })
      .from(customerGroups)
      .innerJoin(portalProviders, eq(portalProviders.id, customerGroups.providerId))
      .where(and(eq(customerGroups.projectId, project.id), inArray(customerGroups.providerId, dropped)));
    if (tied) {
      throw conflict(`${tied.group}'s people sign in through ${tied.provider}`, `Tie ${tied.group} to another way first, then take ${tied.provider} off.`).said('portalSignIn.groupSignsInThrough', { group: tied.group, provider: tied.provider });
    }
  }
  const next: HelpdeskSignIn = { link: input.link, password: input.password, providers, passkey };
  const names = new Map(known.map((k) => [k.id, k.name]));
  const before = current.providers.length ? await ctx.db.select({ id: portalProviders.id, name: portalProviders.name }).from(portalProviders).where(inArray(portalProviders.id, current.providers)) : [];
  for (const b of before) names.set(b.id, b.name);
  const said = (x: HelpdeskSignIn) => ({ link: x.link, password: x.password, providers: x.providers.map((id) => names.get(id) ?? id), passkey: Boolean(x.passkey) });
  const changed = next.link !== current.link || next.password !== current.password || next.providers.join() !== current.providers.join() || next.passkey !== Boolean(current.passkey);
  return { next, changed, data: { from: said(current), to: said(next) } };
}

// ---------------------------------------------------------------------------
// Identity providers for requesters: an administrator's
// ---------------------------------------------------------------------------

function loopback(url: URL): boolean {
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/** An issuer a4a will reach: https, or plain http on this machine (development and tests), with nothing but its address. */
function checkIssuer(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw badRequest('That issuer is no address', 'Give the provider’s issuer as its discovery document names it, such as https://login.acme.com.').said('portalSignIn.issuerNotUrl');
  }
  if (u.protocol !== 'https:' && !loopback(u)) {
    throw badRequest('An identity provider is reached over https', 'Give its https address: plain http only reaches a provider on this machine.').said('portalSignIn.issuerNotHttps');
  }
  if (u.username || u.password || u.hash || u.search) {
    throw badRequest('An issuer is an address alone', 'Leave out a user, a password, a query and a fragment.').said('portalSignIn.issuerShape');
  }
  // Kept as given: discovery compares it with the issuer the provider's document names.
  return raw.trim();
}

const discovered = new Map<string, Promise<oidc.Configuration>>();

/** The provider, found by discovery once per version of its row (and again after a failure, so a provider that was down is found later). */
function configurationOf(app: AppServices, row: Pick<ProviderRow, 'id' | 'issuer' | 'clientId' | 'clientSecretSealed' | 'updatedAt'>): Promise<oidc.Configuration> {
  const key = `${row.id}:${row.updatedAt.getTime()}:${row.issuer}:${row.clientId}`;
  const hit = discovered.get(key);
  if (hit) return hit;
  const secret = row.clientSecretSealed ? open(keySource(app), row.clientSecretSealed) : null;
  const issuer = new URL(row.issuer);
  const execute: ((c: oidc.Configuration) => void)[] = [oidc.enableNonRepudiationChecks];
  if (loopback(issuer)) execute.push(oidc.allowInsecureRequests);
  const found = oidc.discovery(issuer, row.clientId, secret ?? undefined, secret ? oidc.ClientSecretBasic(secret) : oidc.None(), { execute, timeout: 10 });
  if (discovered.size > 200) discovered.clear();
  discovered.set(key, found);
  found.catch(() => {
    if (discovered.get(key) === found) discovered.delete(key);
  });
  return found;
}

async function providerDtos(ctx: Ctx, rows: ProviderRow[]): Promise<PortalProvider[]> {
  const s = await ctx.app.schema.get();
  const view = await projectAccess(ctx);
  const desks = [...s.projects.values()].filter((p) => view.canRead(p.id));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind as 'oidc' | 'saml',
    issuer: row.kind === 'saml' ? (row.samlEntityId ?? row.issuer) : row.issuer,
    clientId: row.kind === 'saml' ? null : row.clientId,
    hasSecret: Boolean(row.clientSecretSealed),
    scopes: row.scopes,
    domains: row.domains,
    samlEntryPoint: row.samlEntryPoint,
    hasCert: Boolean(row.samlCert),
    redirectUri: portalRedirectUri(ctx.app),
    desks: desks
      .filter((p) => deskSignIn(p).providers.includes(row.id))
      .map((p) => p.key)
      .sort(),
    createdAt: row.createdAt.toISOString(),
  }));
}

/** Administrators keep them; whoever manages a desk reads them, to choose its own. */
async function mayReadProviders(ctx: Ctx): Promise<void> {
  requireScope(ctx, 'read');
  if (ctx.actor.user.role === 'admin') return;
  const s = await ctx.app.schema.get();
  const view = await projectAccess(ctx);
  if (![...s.projects.values()].some((p) => view.allows(p.id, 'manage'))) {
    throw forbidden('Only administrators and desks’ managers see identity providers for requesters', 'Ask an administrator.').said('portalSignIn.providersForManagers');
  }
}

export async function listPortalProviders(ctx: Ctx): Promise<PortalProvider[]> {
  await mayReadProviders(ctx);
  return providerDtos(ctx, await ctx.db.select().from(portalProviders).orderBy(sql`lower(${portalProviders.name})`));
}

const providerMissing = () => notFound('Identity provider', 'It may have been removed: reload the page.').said('portalSignIn.providerNotFound');

async function providerRow(db: Db, id: string): Promise<ProviderRow> {
  const [row] = await db.select().from(portalProviders).where(eq(portalProviders.id, id));
  if (!row) throw providerMissing();
  return row;
}

/** Discovery must work before a provider is kept, so a typo is said now, not at a requester's first sign-in. */
async function reachable(app: AppServices, row: Pick<ProviderRow, 'id' | 'issuer' | 'clientId' | 'clientSecretSealed' | 'updatedAt'>): Promise<void> {
  try {
    await configurationOf(app, row);
  } catch (e) {
    console.warn(`portal sso: discovery of ${row.issuer} failed: ${e instanceof Error ? e.message : String(e)}`);
    throw badRequest(`a4a couldn't read ${row.issuer}'s discovery document`, 'Check the issuer: its /.well-known/openid-configuration must answer, and name the same issuer.').said('portalSignIn.providerUnreachable', { issuer: row.issuer });
  }
}

async function nameFree(db: Db, name: string, self: string | null): Promise<void> {
  const [same] = await db.select({ id: portalProviders.id }).from(portalProviders).where(sql`lower(${portalProviders.name}) = ${name.toLowerCase()}`);
  if (same && same.id !== self) throw conflict(`There's an identity provider called ${name} already`, 'Give this one another name.').said('portalSignIn.providerNameTaken', { name });
}

export async function createPortalProvider(
  ctx: Ctx,
  input: { name: string; issuer: string; clientId?: string; clientSecret?: string | null; scopes?: string; domains?: string[]; kind?: 'oidc' | 'saml'; samlEntryPoint?: string; samlCert?: string },
): Promise<PortalProvider> {
  requireScope(ctx, 'admin');
  const name = input.name.trim().replace(/\s+/g, ' ');
  await nameFree(ctx.db, name, null);
  const [{ n } = { n: 0 }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(portalProviders);
  if (Number(n) >= MAX_PROVIDERS) throw badRequest(`a4a keeps ${MAX_PROVIDERS} identity providers for requesters at most`, 'Remove one no desk offers.').said('portalSignIn.tooManyProviders', { n: MAX_PROVIDERS });
  const now = new Date();
  const row = {
    id: newId(),
    name,
    issuer: input.kind === 'saml' ? input.issuer.trim() : checkIssuer(input.issuer),
    clientId: input.kind === 'saml' ? '' : (input.clientId ?? '').trim(),
    clientSecretSealed: input.clientSecret ? seal(keySource(ctx.app), input.clientSecret) : null,
    scopes: scopesOf(input.scopes),
    domains: [...new Set(input.domains ?? [])],
    kind: input.kind ?? 'oidc',
    samlEntryPoint: input.kind === 'saml' ? input.samlEntryPoint?.trim() ?? null : null,
    samlCert: input.kind === 'saml' ? input.samlCert?.trim() ?? null : null,
    samlEntityId: input.kind === 'saml' ? input.issuer.trim() : null,
    createdAt: now,
    updatedAt: now,
  };
  if (row.kind === 'saml') {
    if (!row.samlEntryPoint || !row.samlCert) throw badRequest('A SAML provider needs its SSO URL and its signing certificate').said('portal.providers.samlNeedsBoth');
    const u = new URL(row.samlEntryPoint);
    if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost', '::1'].includes(u.hostname)) throw badRequest("A SAML provider's SSO URL must be https", 'Plain http only on this machine, to try it out').said('portal.providers.samlHttps');
  } else {
    await reachable(ctx.app, row);
  }
  await ctx.db.insert(portalProviders).values(row);
  return (await providerDtos(ctx, [row]))[0]!;
}

/** OpenID Connect's scope, always, and an email to know them by. */
function scopesOf(raw: string | undefined): string {
  const words = new Set((raw?.trim() || 'openid email profile').split(/\s+/));
  words.add('openid');
  words.add('email');
  return [...words].join(' ').slice(0, 500);
}

export async function updatePortalProvider(
  ctx: Ctx,
  id: string,
  input: { name?: string; issuer?: string; clientId?: string; clientSecret?: string | null; scopes?: string; domains?: string[] },
): Promise<PortalProvider> {
  requireScope(ctx, 'admin');
  const row = await providerRow(ctx.db, id);
  const name = input.name !== undefined ? input.name.trim().replace(/\s+/g, ' ') : row.name;
  if (name !== row.name) await nameFree(ctx.db, name, id);
  const next = {
    ...row,
    name,
    issuer: input.issuer !== undefined ? checkIssuer(input.issuer) : row.issuer,
    clientId: input.clientId?.trim() ?? row.clientId,
    clientSecretSealed: input.clientSecret === undefined ? row.clientSecretSealed : input.clientSecret ? seal(keySource(ctx.app), input.clientSecret) : null,
    scopes: input.scopes !== undefined ? scopesOf(input.scopes) : row.scopes,
    domains: input.domains !== undefined ? [...new Set(input.domains)] : row.domains,
    updatedAt: new Date(),
  };
  if (next.issuer !== row.issuer || next.clientId !== row.clientId || next.clientSecretSealed !== row.clientSecretSealed) await reachable(ctx.app, next);
  await ctx.db.update(portalProviders).set(next).where(eq(portalProviders.id, id));
  return (await providerDtos(ctx, [next]))[0]!;
}

/**
 * Removed only once no desk offers it and no customer group signs in through it: taking it away
 * from under them would open their requests to the desk's other ways, or close them to everyone.
 */
export async function deletePortalProvider(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'admin');
  const row = await providerRow(ctx.db, id);
  const s = await ctx.app.schema.get();
  const desk = [...s.projects.values()].find((p) => deskSignIn(p).providers.includes(id));
  if (desk) throw conflict(`${desk.key} offers ${row.name} to its requesters`, `Take it off ${desk.key}'s sign-in first.`).said('portalSignIn.providerInUse', { project: desk.key, provider: row.name });
  const [tied] = await ctx.db.select({ group: customerGroups.name }).from(customerGroups).where(eq(customerGroups.providerId, id)).limit(1);
  if (tied) throw conflict(`${tied.group}'s people sign in through ${row.name}`, `Tie ${tied.group} to another way first, then take ${row.name} off.`).said('portalSignIn.groupSignsInThrough', { group: tied.group, provider: row.name });
  await ctx.db.delete(portalProviders).where(eq(portalProviders.id, id));
}

// ---------------------------------------------------------------------------
// How the sign-in page signs someone in
// ---------------------------------------------------------------------------

/** Whether a password sign-in asks for the desks' proof of work: when any desk that takes passwords asks its form for one (D30). */
function captchaAsked(projects: Iterable<ProjectRow>): boolean {
  return taking(projects).some((p) => deskSignIn(p).password && projectSettings(p).helpdesk.captcha);
}

async function providerNames(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  return new Map((await db.select({ id: portalProviders.id, name: portalProviders.name }).from(portalProviders).where(inArray(portalProviders.id, [...ids]))).map((r) => [r.id, r.name]));
}

/**
 * The ways a desk's sign-in page offers, or, for the portal as a whole, the ways some desk takes.
 * Providers are named only on their desk's page: the portal's own doesn't list every customer's.
 * A desk that doesn't take requests answers as no desk, alike for one that doesn't exist.
 */
export async function signInMethods(app: AppServices, deskKey: string | undefined): Promise<PortalSignInMethods> {
  const s = await app.schema.get();
  const desk = openDesk(s.projectsByKey, deskKey);
  const all = taking(s.projects.values());
  const choice = desk ? deskSignIn(desk) : { link: !all.length || all.some((p) => deskSignIn(p).link), password: all.some((p) => deskSignIn(p).password), providers: [] as string[] };
  // An unknown desk offers no passkey, as it names no provider; the portal's own page, if some desk takes them.
  const passkey = await passkeyOffered(app, desk ? desk.key : deskKey, desk ? choice : null);
  const names = await providerNames(app.db, choice.providers);
  return {
    desk: desk ? { key: desk.key, name: desk.name } : null,
    link: choice.link,
    password: choice.password,
    providers: choice.providers.flatMap((id) => (names.has(id) ? [{ id, name: names.get(id)!, start: `/api/v1/portal/sso/${encodeURIComponent(id)}/start${desk ? `?desk=${desk.key}` : ''}` }] : [])),
    captcha: choice.password && captchaAsked(s.projects.values()) ? await captchaChallenge(app, PORTAL_CAPTCHA) : null,
    mail: mailConfigured(app),
    passkey,
  };
}

const methodOff = (desk: ProjectRow, way: 'link' | 'password') =>
  way === 'link'
    ? new AppError(403, 'method_off', `${desk.name} doesn't sign requesters in by an emailed link`, 'Sign in another way its page offers.').said('portal.linksOff', { desk: desk.name })
    : new AppError(403, 'method_off', `${desk.name} doesn't take passwords`, 'Sign in another way its page offers.').said('portal.passwordsOff', { desk: desk.name });

/**
 * Whether a way may be asked for here: the desk named takes it; with no desk named, some desk does.
 * Refused in words a page says in its requester's language.
 */
export async function assertWayTaken(app: AppServices, deskKey: string | undefined, way: 'link' | 'password'): Promise<void> {
  const s = await app.schema.get();
  const desk = openDesk(s.projectsByKey, deskKey);
  if (desk) {
    if (!deskSignIn(desk)[way]) throw methodOff(desk, way);
    return;
  }
  if (way === 'password' && !taking(s.projects.values()).some((p) => deskSignIn(p).password)) {
    throw new AppError(403, 'method_off', 'No help desk here takes passwords', 'Ask for a sign-in link instead.').said('portal.passwordsOffEverywhere');
  }
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/** Checked against when someone has no password, so an address without one takes as long to refuse as a wrong password. */
let decoy: Promise<string> | null = null;

/**
 * The requester whose portal password this is, or null. Never a member: a member's password is in
 * `users`, checked by `/auth/login` alone, and this reads `requesters` alone.
 */
export async function requesterByPassword(db: Db, email: string, password: string): Promise<RequesterRow | null> {
  const [r] = await db.select().from(requesters).where(sql`lower(${requesters.email}) = ${email.trim().toLowerCase()}`);
  decoy ??= hashPassword(randomToken('', 16));
  const ok = await verifyPassword(password, r?.passwordHash ?? (await decoy));
  return ok && r?.passwordHash ? r : null;
}

/** The proof of work a password sign-in sends, checked once, when a desk taking passwords asks for one. */
export async function checkPortalCaptcha(app: AppServices, answer: Parameters<typeof checkCaptcha>[2]): Promise<void> {
  const s = await app.schema.get();
  if (!captchaAsked(s.projects.values())) return;
  const verdict = await checkCaptcha(app, PORTAL_CAPTCHA, answer);
  if (verdict === 'expired') throw new AppError(400, 'captcha_expired', 'The check that you’re not a bot has expired', 'It runs again by itself: send the request once more.').said('helpdesk.captchaExpired');
  if (verdict !== 'ok') throw new AppError(400, 'captcha_failed', 'The check that you’re not a bot didn’t pass', 'Reload the page and send it again: what you wrote is still there.').said('helpdesk.captchaFailed');
}

export const wrongPassword = () => unauthorized('Wrong email or password').said('portal.wrongPassword');

/** Email a link that sets their password: a first one, or a new one for one forgotten. Alike for any address, as a sign-in link is. */
export async function requestPasswordLink(app: AppServices, email: string, desk?: string): Promise<void> {
  if (!mailConfigured(app)) {
    throw new AppError(503, 'mail_unavailable', "Signing in needs email, and this server doesn't send any", 'Use the link in an email about your request, or ask the team.').said('portal.noEmail');
  }
  await assertWayTaken(app, desk, 'password');
  const requester = await requesterByEmail(app.db, email);
  await enqueueMail(app.db, app, {
    kind: 'portal-password',
    dedupeKey: `portal-password:${requester.id}:${Date.now()}`,
    payload: { requesterId: requester.id, desk: desk?.trim().toUpperCase() || null },
    messageId: `portal.${randomToken('', 12)}`,
  });
  kickMail(app);
}

export async function renderPortalPassword(app: AppServices, mail: MailRow): Promise<RenderedMail | null> {
  const p = mail.payload as { requesterId?: string; desk?: string | null };
  const [requester] = await app.db.select().from(requesters).where(eq(requesters.id, String(p.requesterId ?? '')));
  if (!requester) return null;
  const token = randomToken(PASSWORD_PREFIX, 32);
  await app.db.insert(requesterSignIns).values({ tokenHash: sha256(token), requesterId: requester.id, purpose: 'password', expiresAt: new Date(Date.now() + PASSWORD_LINK_TTL_MS) });
  const s = await app.schema.get();
  const desk = p.desk ? s.projectsByKey.get(p.desk) : undefined;
  // In the requester's own language when their browser asked for one (D63's revisit); else the desk's (D49).
  const tr = deskTranslator(app, requester.locale);
  const where = desk ? tr.t('server.portal.deskOf', { project: desk.name }) : tr.t('server.portal.theDesk');
  const has = requester.passwordHash ? 'yes' : 'no';
  const subject = tr.t('server.portalPassword.subject', { where, has });
  const { text, html } = composeMail(subject, {
    lang: langTag(tr.locale),
    lead: tr.t('server.portalPassword.lead', { where, has }),
    sections: [],
    action: { label: tr.t('server.portalPassword.choose'), url: `${app.config.publicUrl}/portal${desk ? `?desk=${desk.key}` : ''}#${token}` },
    why: tr.t('server.portalPassword.why'),
  });
  return {
    to: requester.email,
    subject,
    text,
    html,
    headers: { ...AUTOMATIC },
    onFailed: async () => void (await app.db.delete(requesterSignIns).where(eq(requesterSignIns.tokenHash, sha256(token)))),
  };
}

/**
 * A new session's token for a requester, opened the way it says. One opened by what only the
 * mailbox's holder has (an emailed link, a passkey, or the link that set the password: `confirmed`)
 * may add and remove passkeys for ten minutes (D69).
 */
export async function startPortalSession(db: Db, requesterId: string, how: PortalSignedIn & { passkeyId?: string; confirmed?: boolean }, ttlMs: number): Promise<string> {
  const session = randomToken('hds_', 32);
  const confirmed = how.confirmed ?? (how.method === 'link' || how.method === 'passkey');
  await db.insert(requesterSessions).values({
    tokenHash: sha256(session),
    requesterId,
    method: how.method,
    providerId: how.providerId,
    passkeyId: how.passkeyId ?? null,
    confirmedAt: confirmed ? new Date() : null,
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return session;
}

/**
 * Set their password with a link's token, once: every session they had ends (whoever knew the old
 * password, or held a session, is out), as do the other links to set one; a new session starts.
 */
export async function setPasswordWithLink(app: AppServices, token: string, password: string, ttlMs: number): Promise<{ session: string; requesterId: string }> {
  const hash = await hashPassword(password);
  const now = new Date();
  const done = await app.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const expired = () => new AppError(401, 'link_expired', 'This link has expired or was used', 'Ask for a new one: it comes by email in a minute.').said('portal.passwordLinkExpired');
    const link = and(eq(requesterSignIns.tokenHash, sha256(token)), eq(requesterSignIns.purpose, 'password'));
    const [whose] = await tx.select({ requesterId: requesterSignIns.requesterId }).from(requesterSignIns).where(link);
    if (!whose) throw expired();
    // One change to their password at a time, and the requester locked first, as changing it locks
    // them first: a second link used at once waits here, then finds itself gone with the others.
    // Taking the link before the requester would deadlock with it.
    const [r] = await tx.select().from(requesters).where(eq(requesters.id, whose.requesterId)).for('update');
    const [used] = await tx
      .update(requesterSignIns)
      .set({ usedAt: now })
      .where(and(link, isNull(requesterSignIns.usedAt), gt(requesterSignIns.expiresAt, now)))
      .returning();
    if (!r || !used) throw expired();
    await tx.update(requesters).set({ passwordHash: hash, passwordSetAt: now, updatedAt: now }).where(eq(requesters.id, r!.id));
    await tx.delete(requesterSessions).where(eq(requesterSessions.requesterId, r!.id));
    await tx.delete(requesterSignIns).where(and(eq(requesterSignIns.requesterId, r!.id), eq(requesterSignIns.purpose, 'password'), isNull(requesterSignIns.usedAt)));
    // Opened by the link the mailbox's holder had: as recent as a sign-in link, for adding a passkey (D69).
    const session = await startPortalSession(tx, r!.id, { method: 'password', providerId: null, confirmed: true }, ttlMs);
    return { session, requesterId: r!.id, first: !r!.passwordHash };
  });
  await tellOfSignIn(app, done.requesterId, done.first ? 'passwordSet' : 'passwordChanged');
  return { session: done.session, requesterId: done.requesterId };
}

/** Change it on the portal: the one they have first. Their other sessions end; this one stays. */
export async function changePassword(app: AppServices, requesterId: string, sessionToken: string, current: string, password: string): Promise<void> {
  const hash = await hashPassword(password);
  await app.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [r] = await tx.select().from(requesters).where(eq(requesters.id, requesterId)).for('update');
    if (!r?.passwordHash) throw badRequest('You have no password yet', 'Ask for a link to set one: it comes by email.').said('portal.noPasswordYet');
    if (!(await verifyPassword(current, r.passwordHash))) throw badRequest('That isn’t your current password', 'Type the one you sign in with now, or ask for a link to set a new one.').said('portal.wrongCurrentPassword');
    const now = new Date();
    await tx.update(requesters).set({ passwordHash: hash, passwordSetAt: now, updatedAt: now }).where(eq(requesters.id, r.id));
    await tx.delete(requesterSessions).where(and(eq(requesterSessions.requesterId, r.id), ne(requesterSessions.tokenHash, sha256(sessionToken))));
    await tx.delete(requesterSignIns).where(and(eq(requesterSignIns.requesterId, r.id), eq(requesterSignIns.purpose, 'password'), isNull(requesterSignIns.usedAt)));
  });
  await tellOfSignIn(app, requesterId, 'passwordChanged');
}

// ---------------------------------------------------------------------------
// Telling them: a new way of signing in on their account
// ---------------------------------------------------------------------------

type Told = 'passwordSet' | 'passwordChanged' | 'provider';

/** An email that how they sign in changed, so someone who did it in their name is found out. Without email, nothing. */
export async function tellOfSignIn(app: AppServices, requesterId: string, what: Told, provider?: string): Promise<void> {
  const queued = await enqueueMail(app.db, app, {
    kind: 'portal-account',
    dedupeKey: `portal-account:${requesterId}:${what}:${Date.now()}`,
    payload: { requesterId, what, provider: provider ?? null },
    messageId: `portal.${randomToken('', 12)}`,
  });
  if (queued) kickMail(app);
}

export async function renderPortalAccount(app: AppServices, mail: MailRow): Promise<RenderedMail | null> {
  const p = mail.payload as { requesterId?: string; what?: Told; provider?: string | null };
  const [requester] = await app.db.select().from(requesters).where(eq(requesters.id, String(p.requesterId ?? '')));
  if (!requester) return null;
  const tr = deskTranslator(app, requester.locale);
  const what = p.what === 'provider' || p.what === 'passwordChanged' ? p.what : 'passwordSet';
  const values = { what, provider: p.provider ?? '', email: requester.email };
  const subject = tr.t('server.portalAccount.subject', values);
  const { text, html } = composeMail(subject, {
    lang: langTag(tr.locale),
    lead: tr.t('server.portalAccount.lead', values),
    sections: [],
    action: { label: tr.t('server.portalAccount.open'), url: `${app.config.publicUrl}/portal` },
    why: tr.t('server.portalAccount.why'),
  });
  return { to: requester.email, subject, text, html, headers: { ...AUTOMATIC } };
}

// ---------------------------------------------------------------------------
// Single sign-on through a requesters' provider
// ---------------------------------------------------------------------------

/** Why a sign-in through a provider didn't work, as a code the portal's page turns into words. */
export type PortalSsoFailure = 'cancelled' | 'expired' | 'failed' | 'unverified' | 'domain' | 'refused';

export class PortalSsoError extends Error {
  constructor(
    readonly failure: PortalSsoFailure,
    message: string,
    /** The desk the sign-in started from, once its state is known: the page offers its ways again. */
    readonly desk: string | null = null,
  ) {
    super(message);
  }
}

function sameText(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** Begin: offered by the desk named (or by some desk), remember what the callback checks, and send the browser to the provider. */
export async function startPortalSso(app: AppServices, providerId: string, deskKey: string | undefined): Promise<{ url: string; state: string }> {
  const s = await app.schema.get();
  const [row] = await app.db.select().from(portalProviders).where(eq(portalProviders.id, providerId));
  const desk = openDesk(s.projectsByKey, deskKey);
  const offered = row && (desk ? deskSignIn(desk).providers.includes(row.id) : taking(s.projects.values()).some((p) => deskSignIn(p).providers.includes(row.id)));
  if (!row || !offered) throw new PortalSsoError('refused', 'No help desk here signs requesters in through that provider');
  if (row.kind === 'saml') return startPortalSaml(app, row, desk?.key ?? null);
  const configuration = await configurationOf(app, row).catch((e: unknown) => {
    console.error(`portal sso: discovery of ${row.issuer} failed: ${e instanceof Error ? e.message : String(e)}`);
    throw new PortalSsoError('failed', `${row.name} can't be reached just now`);
  });
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const now = Date.now();
  await app.db.delete(portalSsoStates).where(lt(portalSsoStates.expiresAt, new Date(now)));
  await app.db.insert(portalSsoStates).values({ id: sha256(state), providerId: row.id, desk: desk?.key ?? null, codeVerifier, nonce, expiresAt: new Date(now + PORTAL_SSO_TTL_MS) });
  const url = oidc.buildAuthorizationUrl(configuration, {
    redirect_uri: portalRedirectUri(app),
    scope: row.scopes,
    response_type: 'code',
    state,
    nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
  });
  return { url: url.href, state };
}

function claimText(claims: oidc.IDToken, name: string): string | null {
  const v = claims[name];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * The provider sent the browser back: check everything, find the requester by the email it
 * vouches for, and start a session opened through it. `desk` is where it started, to go back to.
 */
export async function finishPortalSso(app: AppServices, query: URLSearchParams, browserState: string | undefined, ttlMs: number): Promise<{ session: string; desk: string | null }> {
  const state = query.get('state') ?? '';
  if (query.get('error')) {
    // Still take the state, so it can't be used after this.
    const [gone] = state ? await app.db.delete(portalSsoStates).where(eq(portalSsoStates.id, sha256(state))).returning() : [];
    const cancelled = query.get('error') === 'access_denied';
    throw new PortalSsoError(cancelled ? 'cancelled' : 'failed', cancelled ? 'The sign-in was cancelled' : "The provider didn't sign them in", gone?.desk ?? null);
  }
  if (!state || !browserState || !sameText(state, browserState)) throw new PortalSsoError('expired', 'This sign-in was started in another browser or tab, or has run out of time');
  const [pending] = await app.db.delete(portalSsoStates).where(eq(portalSsoStates.id, sha256(state))).returning();
  if (!pending || pending.expiresAt.getTime() < Date.now()) throw new PortalSsoError('expired', 'This sign-in has already been used, or has run out of time');
  const desk = pending.desk;
  const [row] = await app.db.select().from(portalProviders).where(eq(portalProviders.id, pending.providerId));
  if (!row) throw new PortalSsoError('refused', 'That provider was removed', desk);
  const configuration = await configurationOf(app, row).catch(() => {
    throw new PortalSsoError('failed', `${row.name} can't be reached just now`, desk);
  });
  // The URL the provider sent the browser to, as it knows it: the redirect URI with the query it added.
  const current = new URL(portalRedirectUri(app));
  current.search = query.toString();
  let claims: oidc.IDToken | undefined;
  try {
    const tokens = await oidc.authorizationCodeGrant(configuration, current, { pkceCodeVerifier: pending.codeVerifier, expectedState: state, expectedNonce: pending.nonce, idTokenExpected: true });
    claims = tokens.claims();
  } catch (e) {
    console.warn(`portal sso: a sign-in through ${row.name} was refused: ${e instanceof Error ? e.message : String(e)}`);
    throw new PortalSsoError('failed', `${row.name} didn't confirm who they are`, desk);
  }
  if (!claims?.sub) throw new PortalSsoError('failed', `${row.name} didn't say who they are`, desk);
  const email = claimText(claims, 'email')?.toLowerCase() ?? null;
  // Only the provider's own "verified" counts: a real true, not a string (D16); Entra ID says it as xms_edov.
  if (!email || !(claims.email_verified === true || claims.xms_edov === true)) throw new PortalSsoError('unverified', `${row.name} hasn't verified their email`, desk);
  if (row.domains.length && !row.domains.includes(emailDomain(email))) throw new PortalSsoError('domain', `${row.name} vouches for other domains`, desk);
  const name = claimText(claims, 'name') ?? ([claimText(claims, 'given_name'), claimText(claims, 'family_name')].filter(Boolean).join(' ') || undefined);
  const requester = await requesterByEmail(app.db, email, name);
  // The first time this provider signs them in is a new way in on their account: they're told.
  const firstTime = await app.db.insert(requesterIdentities).values({ requesterId: requester.id, providerId: row.id, subject: String(claims.sub) }).onConflictDoNothing().returning();
  if (!firstTime.length) {
    await app.db.update(requesterIdentities).set({ subject: String(claims.sub), lastAt: new Date() }).where(and(eq(requesterIdentities.requesterId, requester.id), eq(requesterIdentities.providerId, row.id)));
  }
  const session = await startPortalSession(app.db, requester.id, { method: 'sso', providerId: row.id }, ttlMs);
  if (firstTime.length) await tellOfSignIn(app, requester.id, 'provider', row.name);
  return { session, desk: pending.desk };
}

/** Forget sign-ins through a provider that never came back (a chore). */
export async function prunePortalSso(db: Db): Promise<void> {
  await db.delete(portalSsoStates).where(lt(portalSsoStates.expiresAt, new Date()));
}

/** The names of providers, by id, for what the portal says of how a desk signs people in. */
export { providerNames };
