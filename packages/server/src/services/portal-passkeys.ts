/**
 * Requesters' passkeys (docs/architecture.md, D69): a requester signs in to the help desk portal with
 * a passkey, at the desks that take one, as D62's members sign in to a4a. Through D62's library and
 * its helpers (services/passkeys.ts), and kept apart from the team's passkeys:
 *
 * - **Their own table** (`requester_passkeys`): the portal's routes read only these, the team's only
 *   members' (`passkeys`), and a credential id is on one side at most (services/passkey-credentials.ts).
 * - **User handles no member's can be:** `hdr:` and the requester's id, where a member's is their id
 *   alone, letters and digits without a colon. An authenticator keeps one passkey per handle for a
 *   host, so one person's two passkeys, the team's and the portal's, never replace each other.
 * - **Made with the mailbox.** Adding or removing one takes a session that proved, in the last ten
 *   minutes, that its requester holds their mailbox: opened by an emailed link (a sign-in link, or the
 *   link that set their password) or by a passkey, or confirmed since with a passkey. A passkey opens
 *   every desk that takes passkeys, so it is made with what each of them trusts: a password, which the
 *   mailbox resets, or a provider, which not every desk offers, would let one desk's choice open
 *   another's requests (D63).
 * - **What it opens:** the desks that take passkeys, never one where the requester's customer group
 *   signs in through a provider (`portalSessionOpens`, services/access.ts).
 * - The rest is D62's: challenges made here, kept as a hash for five minutes and taken once, by the
 *   ceremony they were made for and the browser that asked; user verification required, so a passkey
 *   is both factors; attestation `none`; the sign count checked; each try in the sign-in throttle;
 *   every change mailed, in the desk's language, with a link that says it wasn't them.
 */
import type { Passkey, PasskeyOptions, PortalPasskeyAlert, PortalPasskeys, PortalPasskeysOff } from '@a4a/shared';
import { APP_NAME } from '@a4a/shared';
import { langTag } from '@a4a/shared/i18n';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { decodeAttestationObject, decodeClientDataJSON, parseAuthenticatorData } from '@simplewebauthn/server/helpers';
import { and, asc, count, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { requireScope, type AppServices, type Ctx } from '../context';
import type { Db } from '../db/client';
import { helpdeskRequests, requesterPasskeyAlerts, requesterPasskeyChallenges, requesterPasskeys, requesterSessions, requesterSignIns, requesters } from '../db/schema';
import { deskTranslator } from '../helpdesk/mails';
import { randomToken, sha256 } from '../lib/crypto';
import { AppError, conflict, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { AUTOMATIC, composeMail, type RenderedMail } from '../mail/compose';
import { enqueueMail, kickMail, type MailRow } from '../mail/outbox';
import { mailConfigured } from '../notify/state';
import { emailTime } from '../notify/words';
import { projectAccess } from './access';
import { readableId } from './issue-refs';
import { resolveIssue } from './issues';
import { credentialFree } from './passkey-credentials';
import { ALERT_TTL_MS, CHALLENGE_TTL_MS, MAX_PASSKEYS, passkeyName, RECENT_MS, rpFor, rpOf, rpsOf, workingFor, type RelyingParty } from './passkeys';
import { deskSignIn } from './portal-sign-in';
import { projectSettings } from './projects';
import { getSetting } from './settings';
import { zoneOfUser } from './time-zones';

/** The sign-in page's ticket: it binds a passkey sign-in to the browser that asked for its challenge. */
export const PORTAL_PASSKEY_TICKET = 'a4a_portal_pk';
export const PORTAL_PASSKEY_PATH = '/api/v1/portal/passkey';
/** What starts a requester's user handle: a member's (D62) is their id alone, which never holds a colon. */
export const HANDLE_PREFIX = 'hdr:';
/** A "this wasn't me" link's token, in the portal's fragment as sign-in links are (`/portal#hdk_…`). */
const ALERT_PREFIX = 'hdk_';
/** EdDSA, ES256 and RS256: what authenticators make. */
const ALGORITHMS = [-8, -7, -257];

type PasskeyRow = typeof requesterPasskeys.$inferSelect;
type RequesterRow = typeof requesters.$inferSelect;
type Ceremony = 'register' | 'sign-in' | 'confirm';

/** A portal session, as what it may do with passkeys needs it. */
export interface PortalSessionRef {
  /** Its token's hash: the session's id. */
  id: string;
  requesterId: string;
  confirmedAt: Date | null;
}

// ---------------------------------------------------------------------------
// When they're on
// ---------------------------------------------------------------------------

/** Desks that take requests and passkeys. */
function passkeyDesks(projects: Iterable<Parameters<typeof deskSignIn>[0]>) {
  return [...projects].filter((p) => !p.archived && projectSettings(p).helpdesk.enabled && Boolean(deskSignIn(p).passkey));
}

/** Why requesters' passkeys are off here, or null: the address, the instance's switch (D62's, for both), or no desk taking them. */
export async function portalPasskeysOff(app: AppServices): Promise<PortalPasskeysOff | null> {
  if (!rpOf(app)) return 'address';
  if ((await getSetting(app.db, 'passkeys')) === false) return 'instance';
  const s = await app.schema.get();
  return passkeyDesks(s.projects.values()).length ? null : 'desks';
}

/** Whether the sign-in page offers a passkey: the desk named takes them, or with none named, some desk does; and they're on. */
export async function passkeyOffered(app: AppServices, deskKey: string | undefined | null, desk: { passkey?: boolean } | null): Promise<boolean> {
  if (!rpOf(app) || (await getSetting(app.db, 'passkeys')) === false) return false;
  if (desk) return Boolean(desk.passkey);
  if (deskKey) return false;
  return passkeyDesks((await app.schema.get()).projects.values()).length > 0;
}

const offProblem = (why: PortalPasskeysOff): AppError =>
  why === 'address'
    ? new AppError(403, 'passkeys_off', 'Passkeys need the help desk at an https address', 'Browsers make passkeys only for https addresses, or localhost: sign in another way this page offers.').said('portalPasskeys.offAddress')
    : why === 'instance'
      ? new AppError(403, 'passkeys_off', 'Passkeys are turned off here', 'An administrator turned them off: sign in another way this page offers.').said('portalPasskeys.offInstance')
      : new AppError(403, 'method_off', 'No help desk here takes passkeys', 'Sign in another way this page offers.').said('portal.passkeysOffEverywhere');

/** The relying party, while requesters' passkeys are on here; otherwise the problem that says why not. */
async function requireOn(app: AppServices): Promise<RelyingParty> {
  const off = await portalPasskeysOff(app);
  if (off) throw offProblem(off);
  return rpOf(app)!;
}

/** A sign-in from a desk's page: that desk must take passkeys, as a password sign-in's must take passwords (D63). */
async function assertDeskTakes(app: AppServices, deskKey: string | undefined): Promise<void> {
  if (!deskKey?.trim()) return;
  const s = await app.schema.get();
  const p = s.projectsByKey.get(deskKey.trim().toUpperCase());
  if (p && !p.archived && projectSettings(p).helpdesk.enabled && !deskSignIn(p).passkey) {
    throw new AppError(403, 'method_off', `${p.name} doesn’t take passkeys`, 'Sign in another way its page offers.').said('portal.passkeysOff', { desk: p.name });
  }
}

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

const stale = () =>
  new AppError(400, 'passkey_stale', 'This passkey request ran out, or was used already', 'Start again: each one works once, for five minutes.').said('passkeys.stale');
const notKnown = () =>
  new AppError(401, 'passkey_unknown', 'The help desk doesn’t know that passkey', 'It may have been removed. Choose another passkey, or sign in another way this page offers.').said('portalPasskeys.notKnown');
const teamPasskey = () =>
  new AppError(401, 'passkey_unknown', 'That passkey signs in to a4a’s team, not the help desk', 'Choose your help desk passkey, or sign in another way this page offers.').said('portalPasskeys.teamPasskey');
const refused = () =>
  new AppError(400, 'passkey_refused', 'That passkey couldn’t be checked', 'Try again. If it keeps happening, sign in another way and add the passkey again.').said('passkeys.refused');
const copiedProblem = () =>
  new AppError(401, 'passkey_copied', 'This passkey stopped working: it may have been copied', 'Sign in another way, then remove it on the portal and add a new one.').said('portalPasskeys.copied');
const notVerified = () =>
  new AppError(400, 'user_not_verified', 'Your device didn’t check it’s you', 'Unlock the passkey with your fingerprint, face, PIN or screen lock when your device asks.').said('passkeys.notVerified');
const otherOrigin = (origin: string) =>
  new AppError(400, 'passkey_origin', 'This passkey answer came from another address', `a4a takes passkeys only at ${origin}.`).said('passkeys.otherOrigin', { origin });
const elsewhere = (rpId: string) =>
  new AppError(400, 'passkey_elsewhere', 'That passkey was made for another address', `It works only at ${rpId}. Sign in another way, and add a passkey for this address.`).said('portalPasskeys.elsewhere', { rpId });
const confirmFirst = () =>
  new AppError(403, 'confirm_needed', 'Confirm it’s you first', 'Adding or removing a passkey takes a sign-in by an emailed link or a passkey in the last ten minutes: use one of your passkeys, or sign in again by a link.').said('portalPasskeys.confirmFirst');
const tooMany = () =>
  conflict(`You have ${MAX_PASSKEYS} passkeys already`, 'Remove one you don’t use first.').said('passkeys.tooMany', { max: MAX_PASSKEYS });
const missingPasskey = () => notFound('Passkey').said('notFound.passkey');

// ---------------------------------------------------------------------------
// Challenges: their own table, so a member's ceremony can't take a requester's, nor the reverse
// ---------------------------------------------------------------------------

async function newChallenge(db: Db, purpose: Ceremony, boundTo: string, requesterId: string | null): Promise<string> {
  const challenge = randomBytes(32).toString('base64url');
  await db.insert(requesterPasskeyChallenges).values({ id: sha256(challenge), purpose, requesterId, boundTo, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) });
  return challenge;
}

/** The challenge an answer names, taken once, whatever comes after: unexpired, for its ceremony, browser and requester. */
async function takeChallenge(db: Db, clientDataJSON: string, purpose: Ceremony, boundTo: string, requesterId: string | null): Promise<string> {
  let challenge: string;
  try {
    challenge = decodeClientDataJSON(clientDataJSON).challenge;
  } catch {
    throw refused();
  }
  if (typeof challenge !== 'string' || !challenge) throw refused();
  const [row] = await db
    .delete(requesterPasskeyChallenges)
    .where(
      and(
        eq(requesterPasskeyChallenges.id, sha256(challenge)),
        eq(requesterPasskeyChallenges.purpose, purpose),
        eq(requesterPasskeyChallenges.boundTo, boundTo),
        requesterId ? eq(requesterPasskeyChallenges.requesterId, requesterId) : isNull(requesterPasskeyChallenges.requesterId),
        gt(requesterPasskeyChallenges.expiresAt, new Date()),
      ),
    )
    .returning({ id: requesterPasskeyChallenges.id });
  if (!row) throw stale();
  return challenge;
}

/** What the browser says it did, and where: the ceremony's type, and a4a's own origin. */
function checkClient(rp: RelyingParty, clientDataJSON: string, type: 'webauthn.create' | 'webauthn.get'): void {
  let data: { type?: unknown; origin?: unknown };
  try {
    data = decodeClientDataJSON(clientDataJSON);
  } catch {
    throw refused();
  }
  if (data.type !== type) throw refused();
  if (data.origin !== rp.origin) throw otherOrigin(rp.origin);
}

const verifiedPerson = (authData: Uint8Array) => parseAuthenticatorData(new Uint8Array(authData)).flags.uv;

// ---------------------------------------------------------------------------
// What a requester sees
// ---------------------------------------------------------------------------

function dto(row: PasskeyRow, rp: RelyingParty | null, accepted: string[] = rp ? [rp.id] : []): Passkey {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    synced: row.multiDevice,
    copied: Boolean(row.copiedAt),
    elsewhere: !accepted.includes(row.rpId) ? row.rpId : null,
  };
}

async function rowsOf(db: Db, requesterId: string): Promise<PasskeyRow[]> {
  return db.select().from(requesterPasskeys).where(eq(requesterPasskeys.requesterId, requesterId)).orderBy(asc(requesterPasskeys.createdAt));
}

/** Passkeys that can sign in here now: not copied, made for this address. */
const working = (rows: PasskeyRow[], rp: RelyingParty | null) => rows.filter((r) => !r.copiedAt && rp && r.rpId === rp.id);

/** The portal session a cookie's token names, for what only it may do. */
export async function portalSessionRef(db: Db, token: string | undefined): Promise<PortalSessionRef | null> {
  if (!token) return null;
  const [row] = await db
    .select({ id: requesterSessions.tokenHash, requesterId: requesterSessions.requesterId, confirmedAt: requesterSessions.confirmedAt })
    .from(requesterSessions)
    .where(and(eq(requesterSessions.tokenHash, sha256(token)), gt(requesterSessions.expiresAt, new Date())));
  return row ?? null;
}

const confirmedUntil = (session: PortalSessionRef | null): Date | null => {
  const until = session?.confirmedAt ? new Date(session.confirmedAt.getTime() + RECENT_MS) : null;
  return until && until.getTime() > Date.now() ? until : null;
};

function requireRecent(session: PortalSessionRef): void {
  if (!confirmedUntil(session)) throw confirmFirst();
}

export async function myPortalPasskeys(app: AppServices, requester: Pick<RequesterRow, 'id'>, session: PortalSessionRef | null): Promise<PortalPasskeys> {
  const rp = rpOf(app);
  const rows = await rowsOf(app.db, requester.id);
  const off = await portalPasskeysOff(app);
  return {
    passkeys: rows.map((r) => dto(r, rp, rpsOf(app).map((x) => x.id))),
    on: off === null,
    off,
    confirmedUntil: confirmedUntil(session)?.toISOString() ?? null,
    confirmWith: { passkey: off === null && workingFor(app, rows).length > 0, link: mailConfigured(app) },
  };
}

/** How many passkeys a requester has, for the team: never their names (D69). */
export async function requesterPasskeyCount(db: Db, requesterId: string): Promise<number> {
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(requesterPasskeys).where(eq(requesterPasskeys.requesterId, requesterId));
  return Number(n);
}

// ---------------------------------------------------------------------------
// Adding one, renaming and removing
// ---------------------------------------------------------------------------

/** The WebAuthn user handle: the prefix, then the requester's id, which says nothing about them. */
const handleOf = (requesterId: string) => new TextEncoder().encode(`${HANDLE_PREFIX}${requesterId}`);

export async function portalRegistrationOptions(app: AppServices, requester: RequesterRow, session: PortalSessionRef): Promise<PasskeyOptions> {
  const rp = await requireOn(app);
  requireRecent(session);
  const rows = await rowsOf(app.db, requester.id);
  if (rows.length >= MAX_PASSKEYS) throw tooMany();
  const challenge = await newChallenge(app.db, 'register', session.id, requester.id);
  // What the browser's passkey manager lists it as, in the help desk's language (D49): their address,
  // and their name marked as the help desk's, beside any passkey of theirs for the team.
  const tr = deskTranslator(app);
  return (await generateRegistrationOptions({
    rpName: ((await getSetting(app.db, 'instanceName')) as string | undefined) ?? APP_NAME,
    rpID: rp.id,
    userName: requester.email,
    userDisplayName: tr.t('server.portalPasskeys.displayName', { name: requester.name }),
    userID: handleOf(requester.id),
    // As bytes: a string would be taken as text, and encoded again.
    challenge: new Uint8Array(Buffer.from(challenge, 'base64url')),
    timeout: CHALLENGE_TTL_MS,
    // Why `none` (D62): any authenticator its requester chooses is taken, and its make isn't asked.
    attestationType: 'none',
    excludeCredentials: rows.map((r) => ({ id: r.credentialId, transports: r.transports })),
    // Discoverable, so it signs in naming nobody; and it checks its person, so it's both factors.
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    supportedAlgorithmIDs: ALGORITHMS,
  })) as unknown as PasskeyOptions;
}

export async function addPortalPasskey(
  app: AppServices,
  requester: RequesterRow,
  session: PortalSessionRef,
  input: { response: RegistrationResponseJSON; name?: string },
  userAgent?: string,
): Promise<Passkey> {
  const rp = await requireOn(app);
  requireRecent(session);
  const { response } = input;
  const challenge = await takeChallenge(app.db, response.response.clientDataJSON, 'register', session.id, requester.id);
  checkClient(rp, response.response.clientDataJSON, 'webauthn.create');
  let uv: boolean;
  try {
    uv = verifiedPerson(decodeAttestationObject(Buffer.from(response.response.attestationObject, 'base64url')).get('authData'));
  } catch {
    throw refused();
  }
  if (!uv) throw notVerified();
  let verified;
  try {
    verified = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: rp.origin, expectedRPID: rp.id, requireUserVerification: true, supportedAlgorithmIDs: ALGORITHMS });
  } catch (e) {
    console.warn(`portal passkeys: a registration was refused: ${e instanceof Error ? e.message : String(e)}`);
    throw refused();
  }
  if (!verified.verified) throw refused();
  const info = verified.registrationInfo;
  const already = () => conflict('That passkey is in a4a already', 'Each passkey is added once.').said('passkeys.already');
  const row = await app.db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    // One at a time per requester, so two at once can't pass the cap together.
    await tx.select({ id: requesters.id }).from(requesters).where(eq(requesters.id, requester.id)).for('update');
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(requesterPasskeys).where(eq(requesterPasskeys.requesterId, requester.id));
    if (Number(n) >= MAX_PASSKEYS) throw tooMany();
    // A credential a member has, or another requester, is theirs: never this requester's too.
    if (!(await credentialFree(tx, info.credential.id))) throw already();
    const [made] = await tx
      .insert(requesterPasskeys)
      .values({
        id: newId(),
        requesterId: requester.id,
        credentialId: info.credential.id,
        publicKey: Buffer.from(info.credential.publicKey),
        signCount: info.credential.counter,
        transports: (response.response.transports ?? []).slice(0, 10),
        multiDevice: info.credentialDeviceType === 'multiDevice',
        backedUp: info.credentialBackedUp,
        aaguid: info.aaguid,
        name: passkeyName(input.name, info.aaguid, userAgent),
        rpId: rp.id,
      })
      .onConflictDoNothing()
      .returning();
    if (!made) throw already();
    await tellOf(tx, app, requester.id, { change: 'added', passkeyId: made.id, name: made.name });
    return made;
  });
  kickMail(app);
  return dto(row, rp);
}

export async function renamePortalPasskey(app: AppServices, requester: Pick<RequesterRow, 'id'>, id: string, name: string): Promise<Passkey> {
  const [row] = await app.db
    .update(requesterPasskeys)
    .set({ name: name.trim().slice(0, 60) })
    .where(and(eq(requesterPasskeys.id, id), eq(requesterPasskeys.requesterId, requester.id)))
    .returning();
  if (!row) throw missingPasskey();
  return dto(row, rpOf(app));
}

/** Its requester takes it away: it signs nobody in, and the other sessions it opened end. Even with passkeys off. */
export async function removePortalPasskey(app: AppServices, requester: Pick<RequesterRow, 'id'>, session: PortalSessionRef, id: string): Promise<void> {
  requireRecent(session);
  await app.db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const [gone] = await tx.delete(requesterPasskeys).where(and(eq(requesterPasskeys.id, id), eq(requesterPasskeys.requesterId, requester.id))).returning();
    if (!gone) throw missingPasskey();
    await tx.delete(requesterSessions).where(and(eq(requesterSessions.passkeyId, gone.id), ne(requesterSessions.tokenHash, session.id)));
    await tellOf(tx, app, requester.id, { change: 'removed', passkeyId: gone.id, name: gone.name });
  });
  kickMail(app);
}

/**
 * The team takes a request's requester's passkeys away, as for a lost device: an administrator, or
 * the desk's manager. Every one of them goes, with every session one opened; the requester is told,
 * by which desk. The request's issue is read through the seam: one the caller can't see is missing.
 */
export async function removeRequesterPasskeys(ctx: Ctx, issueId: string): Promise<number> {
  requireScope(ctx, 'write');
  const issue = await resolveIssue(ctx, issueId);
  const s = await ctx.app.schema.get();
  const [request] = await ctx.db.select({ requesterId: helpdeskRequests.requesterId }).from(helpdeskRequests).where(eq(helpdeskRequests.issueId, issue.id));
  const id = readableId(s, issue);
  if (!request) throw notFound(`A help desk request for ${id}`, 'Only issues filed through a help desk have one.').said('helpdesk.requestNotFound', { id });
  if (!(await projectAccess(ctx)).canManage(issue.projectId)) {
    throw forbidden('Only the desk’s managers and administrators remove a requester’s passkeys', 'Ask one of them.').said('portalPasskeys.forManagers');
  }
  const desk = s.projects.get(issue.projectId)?.name ?? '';
  const n = await ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const gone = await tx.delete(requesterPasskeys).where(eq(requesterPasskeys.requesterId, request.requesterId)).returning({ id: requesterPasskeys.id, name: requesterPasskeys.name });
    if (!gone.length) return 0;
    await tx.delete(requesterSessions).where(inArray(requesterSessions.passkeyId, gone.map((g) => g.id)));
    await tellOf(tx, ctx.app, request.requesterId, { change: 'removed-by-team', passkeyId: null, name: gone.length === 1 ? gone[0]!.name : '', n: gone.length, desk });
    return gone.length;
  });
  kickMail(ctx.app);
  return n;
}

// ---------------------------------------------------------------------------
// Using one: signing in, and confirming it's them
// ---------------------------------------------------------------------------

async function requestOptions(app: AppServices, rp: RelyingParty, purpose: Ceremony, boundTo: string, requesterId: string | null): Promise<PasskeyOptions> {
  const challenge = await newChallenge(app.db, purpose, boundTo, requesterId);
  const allow = requesterId ? working(await rowsOf(app.db, requesterId), rp) : [];
  const options = (await generateAuthenticationOptions({
    rpID: rp.id,
    challenge: new Uint8Array(Buffer.from(challenge, 'base64url')),
    timeout: CHALLENGE_TTL_MS,
    userVerification: 'required',
    // Signing in names nobody: the browser offers the passkeys it holds for this host.
    ...(requesterId ? { allowCredentials: allow.map((r) => ({ id: r.credentialId, transports: r.transports })) } : {}),
  })) as unknown as PasskeyOptions;
  return { ...options, legacyRpIds: rpsOf(app).filter((x) => x.id !== rp.id).map((x) => x.id) };
}

/** Options for signing in from the portal's sign-in page, bound to the browser's ticket. */
export async function portalSignInOptions(app: AppServices, ticket: string, deskKey?: string, rpId?: string): Promise<PasskeyOptions> {
  await requireOn(app);
  const rp = rpFor(app, rpId);
  if (!rp) throw elsewhere(rpId ?? '');
  await assertDeskTakes(app, deskKey);
  return requestOptions(app, rp, 'sign-in', sha256(ticket), null);
}

/** Options for confirming it's them, in a signed-in portal session: their own passkeys. */
export async function portalConfirmOptions(app: AppServices, requester: Pick<RequesterRow, 'id'>, session: PortalSessionRef, rpId?: string): Promise<PasskeyOptions> {
  await requireOn(app);
  const rp = rpFor(app, rpId);
  if (!rp) throw elsewhere(rpId ?? '');
  return requestOptions(app, rp, 'confirm', session.id, requester.id);
}

async function rowByCredential(db: Db, credentialId: string): Promise<PasskeyRow | undefined> {
  const [row] = await db.select().from(requesterPasskeys).where(eq(requesterPasskeys.credentialId, credentialId));
  return row;
}

/** A count that went back: two authenticators hold the key. It signs nobody in again, the sessions it opened end, and its requester is told, once. */
async function markCopied(app: AppServices, row: PasskeyRow): Promise<void> {
  await app.db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const [marked] = await tx
      .update(requesterPasskeys)
      .set({ copiedAt: new Date() })
      .where(and(eq(requesterPasskeys.id, row.id), isNull(requesterPasskeys.copiedAt)))
      .returning({ id: requesterPasskeys.id });
    if (!marked) return;
    await tx.delete(requesterSessions).where(eq(requesterSessions.passkeyId, row.id));
    await tellOf(tx, app, row.requesterId, { change: 'copied', passkeyId: row.id, name: row.name });
  });
  kickMail(app);
  console.warn(`portal passkeys: passkey ${row.id} of requester ${row.requesterId} answered with a sign count it had passed; it signs nobody in again`);
}

/** Check one assertion against its passkey, and move the passkey's count on to it, as D62 does. */
async function verifyAssertion(app: AppServices, current: RelyingParty, row: PasskeyRow, response: AuthenticationResponseJSON, challenge: string): Promise<void> {
  if (row.copiedAt) throw copiedProblem();
  const rp = rpsOf(app).find((x) => x.id === row.rpId);
  if (!rp) throw elsewhere(row.rpId);
  checkClient(rp, response.response.clientDataJSON, 'webauthn.get');
  let uv: boolean;
  try {
    uv = verifiedPerson(Buffer.from(response.response.authenticatorData, 'base64url'));
  } catch {
    throw refused();
  }
  if (!uv) throw notVerified();
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      // The count is checked below, so a count that goes back is known for what it is.
      credential: { id: row.credentialId, publicKey: new Uint8Array(row.publicKey), counter: 0, transports: row.transports },
      requireUserVerification: true,
    });
  } catch (e) {
    console.warn(`portal passkeys: a sign-in with passkey ${row.id} was refused: ${e instanceof Error ? e.message : String(e)}`);
    throw refused();
  }
  if (!result.verified) throw refused();
  const next = result.authenticationInfo.newCounter;
  // Authenticators that keep no count (most synced passkeys) say 0 each time; the others count up.
  if ((next > 0 || row.signCount > 0) && next <= row.signCount) {
    await markCopied(app, row);
    throw copiedProblem();
  }
  const moved = await app.db
    .update(requesterPasskeys)
    .set({ signCount: next, lastUsedAt: new Date(), backedUp: result.authenticationInfo.credentialBackedUp })
    .where(and(eq(requesterPasskeys.id, row.id), isNull(requesterPasskeys.copiedAt), or(lt(requesterPasskeys.signCount, next), and(eq(requesterPasskeys.signCount, 0), sql`${next} = 0`))))
    .returning({ id: requesterPasskeys.id });
  // Another use got there first with a higher count, or it was just marked copied: refused, marking nothing.
  if (!moved.length) throw refused();
}

/** The requester a passkey from the sign-in page names, signed in by it: both factors at once. */
export async function signInWithPortalPasskey(app: AppServices, ticket: string | undefined, response: AuthenticationResponseJSON, deskKey?: string): Promise<{ requester: RequesterRow; passkeyId: string }> {
  const rp = await requireOn(app);
  await assertDeskTakes(app, deskKey);
  if (!ticket) throw stale();
  const challenge = await takeChallenge(app.db, response.response.clientDataJSON, 'sign-in', sha256(ticket), null);
  // The browser offers every passkey it holds for this host, the team's too. A member's handle is
  // their id alone: said for what it is from the handle the browser sent, without reading members'.
  const handle = response.response.userHandle ? Buffer.from(response.response.userHandle, 'base64url').toString('utf8') : null;
  if (handle !== null && !handle.startsWith(HANDLE_PREFIX)) throw teamPasskey();
  const row = await rowByCredential(app.db, response.id);
  if (!row || response.rawId !== response.id) throw notKnown();
  if (handle !== null && handle !== `${HANDLE_PREFIX}${row.requesterId}`) throw notKnown();
  const [requester] = await app.db.select().from(requesters).where(eq(requesters.id, row.requesterId));
  if (!requester) throw notKnown();
  await verifyAssertion(app, rp, row, response, challenge);
  return { requester, passkeyId: row.id };
}

/** Confirming it's them with a passkey: the session may add and remove passkeys for ten minutes. */
export async function confirmWithPortalPasskey(app: AppServices, requester: Pick<RequesterRow, 'id'>, session: PortalSessionRef, response: AuthenticationResponseJSON): Promise<Date> {
  const rp = await requireOn(app);
  const challenge = await takeChallenge(app.db, response.response.clientDataJSON, 'confirm', session.id, requester.id);
  const row = await rowByCredential(app.db, response.id);
  if (!row || row.requesterId !== requester.id) throw notKnown();
  await verifyAssertion(app, rp, row, response, challenge);
  const now = new Date();
  await app.db.update(requesterSessions).set({ confirmedAt: now }).where(eq(requesterSessions.tokenHash, session.id));
  return new Date(now.getTime() + RECENT_MS);
}

// ---------------------------------------------------------------------------
// Telling them, and "this wasn't me"
// ---------------------------------------------------------------------------

type Change = 'added' | 'removed' | 'copied' | 'removed-by-team';

/** Queue the mail that tells a requester their passkeys changed, in the change's transaction. */
async function tellOf(tx: Db, app: AppServices, requesterId: string, what: { change: Change; passkeyId: string | null; name: string; n?: number; desk?: string }): Promise<void> {
  const id = newId();
  await enqueueMail(tx, app, { kind: 'portal-passkey', dedupeKey: `portal-passkey:${id}`, payload: { requesterId, ...what, at: new Date().toISOString() }, messageId: `portal.pk-${id}` });
}

export async function renderPortalPasskeyMail(app: AppServices, row: MailRow): Promise<RenderedMail | null> {
  const p = row.payload as { requesterId?: string; change?: Change; passkeyId?: string | null; name?: string; n?: number; desk?: string; at?: string };
  if (!p.requesterId || !p.change || !p.at) return null;
  const [r] = await app.db.select().from(requesters).where(eq(requesters.id, p.requesterId));
  if (!r) return null;
  // In the help desk's language, as its other emails to a requester are (D49, D63).
  const tr = deskTranslator(app);
  const words = { name: p.name ?? '', email: r.email, when: emailTime(p.at, zoneOfUser(null), tr.locale), n: p.n ?? 1, desk: p.desk ?? '' };
  const portal = `${app.config.publicUrl}/portal`;
  const why = tr.t('server.portalPasskeys.why', { email: r.email });
  // The team's removal was nobody's mistake to report: it says who, and how to add one again.
  if (p.change === 'removed-by-team') {
    const subject = tr.t('server.portalPasskeys.removedByTeamSubject', words);
    const { text, html } = composeMail(subject, {
      lang: langTag(tr.locale),
      lead: tr.t('server.portalPasskeys.removedByTeam', words),
      sections: [{ head: tr.t('server.portalPasskeys.signInAndAddAgain') }],
      action: { label: tr.t('server.portalPasskeys.open'), url: portal },
      why,
    });
    return { to: r.email, subject, text, html, headers: { ...AUTOMATIC } };
  }
  const token = randomToken(ALERT_PREFIX, 32);
  const tokenHash = sha256(token);
  await app.db.insert(requesterPasskeyAlerts).values({
    tokenHash,
    requesterId: r.id,
    change: p.change,
    passkeyId: p.passkeyId ?? null,
    name: p.name ?? '',
    changedAt: new Date(p.at),
    expiresAt: new Date(Date.now() + ALERT_TTL_MS),
  });
  const subject = tr.t('server.portalPasskeys.subject', { change: p.change });
  const { text, html } = composeMail(subject, {
    lang: langTag(tr.locale),
    lead: tr.t('server.portalPasskeys.lead', { ...words, change: p.change }),
    sections: [{ head: tr.t('server.portalPasskeys.ifItWasYou', { change: p.change }), lines: [tr.t('server.portalPasskeys.notYou', { change: p.change })] }],
    // In the fragment, as a sign-in link's token is: it never reaches a server's logs.
    action: { label: tr.t('server.portalPasskeys.action', { change: p.change }), url: `${portal}#${token}` },
    why,
  });
  return {
    to: r.email,
    subject,
    text,
    html,
    headers: { ...AUTOMATIC },
    // A link nobody received is forgotten.
    onFailed: async () => {
      await app.db.delete(requesterPasskeyAlerts).where(eq(requesterPasskeyAlerts.tokenHash, tokenHash));
    },
  };
}

const alertGone = () =>
  notFound('Link', 'It was used already, or it’s more than two weeks old. Sign in to the portal and look at your passkeys there.').said('portalPasskeys.alertGone');

async function alertRow(db: Db, token: string) {
  const [row] = await db
    .select({ alert: requesterPasskeyAlerts, email: requesters.email })
    .from(requesterPasskeyAlerts)
    .innerJoin(requesters, eq(requesters.id, requesterPasskeyAlerts.requesterId))
    .where(and(eq(requesterPasskeyAlerts.tokenHash, sha256(token)), gt(requesterPasskeyAlerts.expiresAt, new Date())));
  return row;
}

const alertDto = (row: NonNullable<Awaited<ReturnType<typeof alertRow>>>, done: boolean): PortalPasskeyAlert => ({
  change: row.alert.change as PortalPasskeyAlert['change'],
  name: row.alert.name,
  email: row.email,
  changedAt: row.alert.changedAt.toISOString(),
  done,
});

/** What a "this wasn't me" link is about, before it's followed: opening it changes nothing (scanners open links). */
export async function describePortalAlert(app: AppServices, token: string): Promise<PortalPasskeyAlert> {
  const row = await alertRow(app.db, token);
  if (!row) throw alertGone();
  return alertDto(row, Boolean(row.alert.usedAt));
}

/**
 * The requester says the change wasn't theirs: every portal session of theirs ends, their unused
 * links to sign in or set a password are void, and the passkey the mail told of signs nobody in, with
 * any added after it (or the copied one). It only takes access away, so the mail is the proof. Once.
 */
export async function followPortalAlert(app: AppServices, token: string): Promise<PortalPasskeyAlert> {
  const row = await alertRow(app.db, token);
  if (!row) throw alertGone();
  if (row.alert.usedAt) return alertDto(row, true);
  await app.db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const [taken] = await tx
      .update(requesterPasskeyAlerts)
      .set({ usedAt: new Date() })
      .where(and(eq(requesterPasskeyAlerts.tokenHash, row.alert.tokenHash), isNull(requesterPasskeyAlerts.usedAt)))
      .returning({ tokenHash: requesterPasskeyAlerts.tokenHash });
    if (!taken) return;
    const { requesterId, passkeyId, change, changedAt } = row.alert;
    if (change === 'added' && passkeyId) {
      await tx.delete(requesterPasskeys).where(and(eq(requesterPasskeys.requesterId, requesterId), or(eq(requesterPasskeys.id, passkeyId), gte(requesterPasskeys.createdAt, changedAt))));
    } else if (change === 'copied' && passkeyId) {
      await tx.delete(requesterPasskeys).where(and(eq(requesterPasskeys.requesterId, requesterId), eq(requesterPasskeys.id, passkeyId)));
    }
    await tx.delete(requesterSessions).where(eq(requesterSessions.requesterId, requesterId));
    await tx.delete(requesterSignIns).where(and(eq(requesterSignIns.requesterId, requesterId), isNull(requesterSignIns.usedAt)));
  });
  return alertDto(row, true);
}

/** Housekeeping: challenges nobody answered, and links past their time. */
export async function prunePortalPasskeys(db: Db): Promise<void> {
  await db.delete(requesterPasskeyChallenges).where(lt(requesterPasskeyChallenges.expiresAt, new Date()));
  await db.delete(requesterPasskeyAlerts).where(lt(requesterPasskeyAlerts.expiresAt, new Date()));
}
