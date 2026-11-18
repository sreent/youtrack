/**
 * Passkeys (docs/architecture.md, D62): WebAuthn credentials a person signs in with, without a login,
 * a password or a code, through @simplewebauthn/server.
 *
 * - **The relying party** is PUBLIC_URL: its host is the id, its origin the only one taken. Browsers
 *   make passkeys only for a domain, in a secure context: https, or http on localhost.
 * - **A passkey is both factors.** Every ceremony asks the authenticator to verify its person (a
 *   fingerprint, a face, a PIN), and a response without that is refused. So a passkey signs in alone,
 *   and stands in for a code after a password.
 * - **Challenges** are made here, kept as a hash for five minutes, and taken once, by the ceremony
 *   they were made for, from the browser that asked: its session, or the ticket its cookie holds.
 * - **The sign count** is checked on each use. One that goes back means two authenticators hold the
 *   key: a4a can't tell which is its person's, so the passkey signs nobody in again, its sessions end,
 *   and its person is told.
 * - **Who has them:** people a4a's own password signs in. Single sign-on and directory accounts sign
 *   in where their provider checks them, and a passkey kept here would let them past it.
 * - Adding or removing one takes a sign-in from the last ten minutes, or proving it's you again.
 * - Account changes, not projects': they record no events (as two-factor's don't, D38), and each
 *   addition or removal is mailed to its person, with a link that says it wasn't them.
 * - In depth (D68): the id may be a parent of PUBLIC_URL's host, or the host an instance moved from
 *   (related origins); only some authenticators may be taken, by attestation checked against FIDO's
 *   metadata (passkey-metadata.ts); and an account may have passkeys and no password. Whose sign-in
 *   owes a passkey, the setup links, and the guards that keep an administrator able to sign in are
 *   in passkey-policy.ts.
 */
import type { MyPasskeys, Passkey, PasskeyAlert, PasskeyOptions, PasskeysOff } from '@a4a/shared';
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
import { convertAAGUIDToString, decodeAttestationObject, decodeClientDataJSON, parseAuthenticatorData } from '@simplewebauthn/server/helpers';
import { and, asc, count, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { requireScope, type AppServices, type Ctx } from '../context';
import type { Db } from '../db/client';
import { passkeyAlerts, passkeyChallenges, passkeys, sessions, users } from '../db/schema';
import { randomToken, sha256 } from '../lib/crypto';
import { AppError, conflict, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { AUTOMATIC, composeMail, type RenderedMail } from '../mail/compose';
import { enqueueMail, kickMail, type MailRow } from '../mail/outbox';
import { localeOfPerson, translatorFor } from '../i18n';
import { emailTime } from '../notify/words';
import { deviceLabel } from '../push/service';
import type { UserRow } from './schema-cache';
import { credentialFree } from './passkey-credentials';
import { holdStatements, metadataInUse, nameOf, untrusted, type MdsEntry } from './passkey-metadata';
import { getSetting } from './settings';
import { zoneOfUser } from './time-zones';

/** How long a challenge waits for its answer; the browser is told the same. */
export const CHALLENGE_TTL_MS = 5 * 60_000;
/** How long a sign-in, or proving it's you again, lets a session add and remove passkeys. */
export const RECENT_MS = 10 * 60_000;
/** Passkeys one person may keep. */
export const MAX_PASSKEYS = 20;
/** How long a mail's "this wasn't me" link works. */
export const ALERT_TTL_MS = 14 * 86_400_000;
/** The sign-in page's ticket: it binds a passkey sign-in to the browser that asked for its challenge. */
export const PASSKEY_TICKET_COOKIE = 'a4a_pk';
export const PASSKEY_TICKET_PATH = '/api/v1/auth/passkey';
/** EdDSA, ES256 and RS256: what authenticators make. */
const ALGORITHMS = [-8, -7, -257];

type PasskeyRow = typeof passkeys.$inferSelect;
/** `owed`: adding one as a password sign-in owes it (D68); `setup`: from an administrator's link (D68). */
export type Ceremony = 'register' | 'sign-in' | 'second-step' | 'confirm' | 'owed' | 'setup';

// ---------------------------------------------------------------------------
// The relying party, and who may have passkeys
// ---------------------------------------------------------------------------

export interface RelyingParty {
  id: string;
  origin: string;
}

/**
 * a4a as a relying party: PUBLIC_URL's origin, and its host as the id unless PASSKEY_RP_ID names
 * another (D68: a parent domain, or the host an instance moved from); null where no browser makes
 * passkeys for it.
 */
export function relyingParty(publicUrl: string, rpId?: string): RelyingParty | null {
  try {
    const u = new URL(publicUrl);
    const host = u.hostname;
    // A relying party id is a domain: an IP address can't be one.
    if (isIP(host.replace(/^\[|\]$/g, ''))) return null;
    const local = host === 'localhost' || host.endsWith('.localhost');
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
    return { id: rpId ?? host, origin: u.origin };
  } catch {
    return null;
  }
}

/** This instance's relying party (D68): PUBLIC_URL's origin, with PASSKEY_RP_ID as its id where it's set. */
export const rpOf = (app: AppServices): RelyingParty | null => relyingParty(app.config.publicUrl, app.config.passkeyRpId);

/** Why passkeys are off on this instance, or null when they're on. */
export async function passkeysOff(app: AppServices): Promise<Exclude<PasskeysOff, 'account'> | null> {
  if (!rpOf(app)) return 'address';
  if (!app.config.passwordLogin) return 'passwords';
  if ((await getSetting(app.db, 'passkeys')) === false) return 'instance';
  return null;
}

/** Someone a4a's own password signs in, who may have passkeys beside it; or an account with passkeys alone (D68). */
export const mayHavePasskeys = (user: Pick<UserRow, 'isBot' | 'passwordHash' | 'passkeysOnly'>) => !user.isBot && (Boolean(user.passwordHash) || user.passkeysOnly);

export const offProblem = (why: PasskeysOff): AppError => {
  switch (why) {
    case 'instance':
      return new AppError(403, 'passkeys_off', 'Passkeys are turned off here', 'An administrator turned them off; sign in with your password.').said('passkeys.offInstance');
    case 'address':
      return new AppError(403, 'passkeys_off', 'Passkeys need a4a at an https address', 'Browsers make passkeys only for https addresses, or localhost; ask an administrator to set PUBLIC_URL to one.').said('passkeys.offAddress');
    case 'passwords':
      return new AppError(403, 'passkeys_off', 'Passkeys are off while a4a’s own sign-in is', 'Sign in with single sign-on: a passkey would let you past it.').said('passkeys.offPasswords');
    default:
      return new AppError(403, 'passkeys_off', 'Your account signs in with single sign-on', 'Your identity provider checks who you are; a passkey kept by a4a would let you in without it.').said('passkeys.notForYou');
  }
};

/** The relying party, when this person may use passkeys now; otherwise the problem that says why not. */
export async function requireOn(app: AppServices, user?: UserRow): Promise<RelyingParty> {
  const off = await passkeysOff(app);
  if (off) throw offProblem(off);
  if (user && !mayHavePasskeys(user)) throw offProblem('account');
  return rpOf(app)!;
}

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

const stale = () =>
  new AppError(400, 'passkey_stale', 'This passkey request ran out, or was used already', 'Start again: each one works once, for five minutes.').said('passkeys.stale');
export const notKnown = () =>
  new AppError(401, 'passkey_unknown', 'a4a doesn’t know that passkey', 'It may have been removed, or made for another a4a. Sign in with your password, or choose another passkey.').said('passkeys.notKnown');
const refused = () =>
  new AppError(400, 'passkey_refused', 'That passkey couldn’t be checked', 'Try again. If it keeps happening, sign in another way and add the passkey again.').said('passkeys.refused');
const copiedProblem = () =>
  new AppError(401, 'passkey_copied', 'This passkey stopped working: it may have been copied', 'Sign in another way, then remove it from your profile and add a new one.').said('passkeys.copied');
const notVerified = () =>
  new AppError(400, 'user_not_verified', 'Your device didn’t check it’s you', 'Unlock the passkey with your fingerprint, face, PIN or screen lock when your device asks.').said('passkeys.notVerified');
const otherOrigin = (origin: string) =>
  new AppError(400, 'passkey_origin', 'This passkey answer came from another address', `a4a takes passkeys only at ${origin}.`).said('passkeys.otherOrigin', { origin });
const elsewhere = (rpId: string) =>
  new AppError(400, 'passkey_elsewhere', 'That passkey was made for another address', `It works only at ${rpId}. Sign in with your password, and add a passkey for this address.`).said('passkeys.elsewhere', { rpId });
export const confirmFirst = () =>
  new AppError(403, 'confirm_needed', 'Confirm it’s you first', 'Adding or removing a passkey takes a sign-in from the last ten minutes: type your password, or use one of your passkeys.').said('passkeys.confirmFirst');

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

async function newChallenge(db: Db, purpose: Ceremony, boundTo: string, userId: string | null): Promise<string> {
  const challenge = randomBytes(32).toString('base64url');
  await db.insert(passkeyChallenges).values({ id: sha256(challenge), purpose, userId, boundTo, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) });
  return challenge;
}

/**
 * The challenge a response answers, taken: once, unexpired, by the ceremony it was made for, from the
 * browser it was given to, for the person it was made for. Taken whatever the outcome after, so a
 * challenge is one try.
 */
async function takeChallenge(db: Db, clientDataJSON: string, purpose: Ceremony, boundTo: string, userId: string | null): Promise<string> {
  let challenge: string;
  try {
    challenge = decodeClientDataJSON(clientDataJSON).challenge;
  } catch {
    throw refused();
  }
  if (typeof challenge !== 'string' || !challenge) throw refused();
  const [row] = await db
    .delete(passkeyChallenges)
    .where(
      and(
        eq(passkeyChallenges.id, sha256(challenge)),
        eq(passkeyChallenges.purpose, purpose),
        eq(passkeyChallenges.boundTo, boundTo),
        userId ? eq(passkeyChallenges.userId, userId) : isNull(passkeyChallenges.userId),
        gt(passkeyChallenges.expiresAt, new Date()),
      ),
    )
    .returning({ id: passkeyChallenges.id });
  if (!row) throw stale();
  return challenge;
}

/** Housekeeping: challenges nobody answered, and links past their time. */
export async function prunePasskeyChallenges(db: Db): Promise<void> {
  await db.delete(passkeyChallenges).where(lt(passkeyChallenges.expiresAt, new Date()));
  await db.delete(passkeyAlerts).where(lt(passkeyAlerts.expiresAt, new Date()));
}

/** What the browser says it did, and where: the ceremony's type and the page's origin must be a4a's. */
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

/** The authenticator data's flags: user present, and user verified (WebAuthn §6.1). */
function flagsOf(authData: Uint8Array): { up: boolean; uv: boolean } {
  const flags = parseAuthenticatorData(new Uint8Array(authData)).flags;
  return { up: flags.up, uv: flags.uv };
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * What an authenticator is, by the AAGUID it says (with attestation `none`, a hint, not proof): the
 * passkey providers people meet most. Names are products', the same in every language.
 */
const AUTHENTICATORS: Record<string, string> = {
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud Keychain',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud Keychain',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  '531126d6-e717-415c-9320-3d9aa6981239': 'Dashlane',
  '0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6': 'Keeper',
  'b84e4048-15dc-4dd0-8640-f4f60813c8af': 'NordPass',
  '53414d53-554e-4700-0000-000000000000': 'Samsung Pass',
  'cb69481e-8ff7-4039-93ec-0a2729a154a8': 'YubiKey 5',
  'ee882879-721c-4913-9775-3dfcce97072a': 'YubiKey 5',
  'fa2b99dc-9e39-4257-8f92-4a30d23c4118': 'YubiKey 5',
  '2fc0579f-8113-47ea-b116-bb5a8db9202a': 'YubiKey 5',
};

/** A new passkey's name: what its person typed, else what its authenticator is, else the browser that made it. */
export function passkeyName(typed: string | undefined, aaguid: string | undefined, userAgent: string | undefined): string {
  const name = typed?.trim() || (aaguid ? AUTHENTICATORS[aaguid.toLowerCase()] : undefined) || deviceLabel(userAgent);
  return name.slice(0, 60);
}

// ---------------------------------------------------------------------------
// What a person sees
// ---------------------------------------------------------------------------

/** `list`: the authenticators taken here, where only some are (D68). */
function passkeyDto(row: PasskeyRow, rp: RelyingParty | null, list?: string[] | null): Passkey {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    synced: row.multiDevice,
    copied: Boolean(row.copiedAt),
    elsewhere: rp && row.rpId !== rp.id ? row.rpId : null,
    attested: row.attested,
    listed: list ? row.attested && list.includes(row.aaguid ?? '') : null,
  };
}

async function rowsOf(db: Db, userId: string): Promise<PasskeyRow[]> {
  return db.select().from(passkeys).where(eq(passkeys.userId, userId)).orderBy(asc(passkeys.createdAt));
}

/** Passkeys that can sign in here now: not copied, made for this address. */
export const working = (rows: PasskeyRow[], rp: RelyingParty | null) => rows.filter((r) => !r.copiedAt && rp && r.rpId === rp.id);

export interface SessionRef {
  /** The session's id: the hash of its cookie's token. */
  id: string;
  verifiedAt: Date;
  /** How it was signed in; null for a session from before a4a kept it, which is never recent. */
  signedInWith: string | null;
  /** How its person last proved it's them: `passkey` or `password` (D68); null before a4a kept it. */
  verifiedBy?: string | null;
}

export const confirmedUntil = (session: SessionRef | null): Date | null => {
  const until = session?.signedInWith ? new Date(session.verifiedAt.getTime() + RECENT_MS) : null;
  return until && until.getTime() > Date.now() ? until : null;
};

export function requireRecent(session: SessionRef): void {
  if (!confirmedUntil(session)) throw confirmFirst();
}

export async function myPasskeys(app: AppServices, user: UserRow, session: SessionRef | null, hasCode: boolean): Promise<MyPasskeys> {
  const rp = rpOf(app);
  const rows = await rowsOf(app.db, user.id);
  const list = await authenticatorList(app);
  const instance = await passkeysOff(app);
  const off: PasskeysOff | null = instance ?? (mayHavePasskeys(user) ? null : 'account');
  return {
    passkeys: rows.map((r) => passkeyDto(r, rp, list)),
    on: off === null,
    off,
    confirmedUntil: confirmedUntil(session)?.toISOString() ?? null,
    confirmWith: { password: Boolean(user.passwordHash), code: Boolean(user.passwordHash) && hasCode, passkey: off === null && working(rows, rp).length > 0 },
  };
}

/** Someone's passkeys, for an administrator. */
export async function passkeysOf(ctx: Ctx, userId: string): Promise<Passkey[]> {
  requireScope(ctx, 'admin');
  const [u] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  if (!u) throw notFound(`User ${userId}`).said('notFound.user', { id: userId });
  const rp = rpOf(ctx.app);
  const list = await authenticatorList(ctx.app);
  return (await rowsOf(ctx.db, userId)).map((r) => passkeyDto(r, rp, list));
}

/** How many passkeys each person has, for the people table. */
export async function passkeyCounts(db: Db, userIds: string[]): Promise<Map<string, number>> {
  if (!userIds.length) return new Map();
  const rows = await db.select({ userId: passkeys.userId, n: count() }).from(passkeys).where(inArray(passkeys.userId, userIds)).groupBy(passkeys.userId);
  return new Map(rows.map((r) => [r.userId, Number(r.n)]));
}

/** Whether this person has a passkey that can sign in here now: a password sign-in may take it instead of a code. */
export async function hasWorkingPasskey(app: AppServices, userId: string): Promise<boolean> {
  return working(await rowsOf(app.db, userId), rpOf(app)).length > 0;
}

// ---------------------------------------------------------------------------
// Adding one
// ---------------------------------------------------------------------------

/** The WebAuthn user handle: the person's id, which says nothing about them. */
const userHandle = (user: UserRow) => new TextEncoder().encode(user.id);

async function instanceName(db: Db): Promise<string> {
  return ((await getSetting(db, 'instanceName')) as string | undefined) ?? APP_NAME;
}

export async function registrationOptions(app: AppServices, user: UserRow, session: SessionRef): Promise<PasskeyOptions> {
  requireRecent(session);
  return registrationOptionsFor(app, user, 'register', session.id);
}

/**
 * A challenge for navigator.credentials.create(), for one ceremony, bound to what it's bound to: a
 * session, a sign-in's ticket, or a setup link's browser (D68). Where only some authenticators are
 * taken, it asks the authenticator's maker to vouch for it (`direct`), and only then (D68).
 */
export async function registrationOptionsFor(app: AppServices, user: UserRow, purpose: Ceremony, boundTo: string): Promise<PasskeyOptions> {
  const rp = await requireOn(app, user);
  const rows = await rowsOf(app.db, user.id);
  if (rows.length >= MAX_PASSKEYS) throw tooMany();
  const list = await authenticatorList(app);
  if (list && !(await metadataInUse(app))) throw noMetadata();
  const challenge = await newChallenge(app.db, purpose, boundTo, user.id);
  return (await generateRegistrationOptions({
    rpName: await instanceName(app.db),
    rpID: rp.id,
    userName: user.login,
    userDisplayName: user.name,
    userID: userHandle(user),
    // As bytes: a string would be taken as text, and encoded again.
    challenge: new Uint8Array(Buffer.from(challenge, 'base64url')),
    timeout: CHALLENGE_TTL_MS,
    // Why `none`: a4a takes any authenticator its person chooses, and doesn't need to know its make.
    // Only where some authenticators alone are taken does it ask the maker (D68).
    attestationType: list ? 'direct' : 'none',
    excludeCredentials: rows.map((r) => ({ id: r.credentialId, transports: r.transports })),
    // Discoverable, so it signs in without a name; and it checks its person, so it's both factors.
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    supportedAlgorithmIDs: ALGORITHMS,
  })) as unknown as PasskeyOptions;
}

const tooMany = () =>
  conflict(`You have ${MAX_PASSKEYS} passkeys already`, 'Remove one you don’t use first.').said('passkeys.tooMany', { max: MAX_PASSKEYS });

export async function addPasskey(
  app: AppServices,
  user: UserRow,
  session: SessionRef,
  input: { response: RegistrationResponseJSON; name?: string },
  userAgent?: string,
): Promise<Passkey> {
  await requireOn(app, user);
  requireRecent(session);
  return (await registerPasskey(app, user, { purpose: 'register', boundTo: session.id }, input, userAgent)).passkey;
}

/**
 * Check what the browser made against the challenge it answers, and keep it: the ceremony behind
 * adding one from the profile, as a sign-in owes one, and from a setup link (D68). `within` runs in
 * the same transaction, after the passkey is in: what throws there takes it back out.
 */
export async function registerPasskey(
  app: AppServices,
  user: UserRow,
  bound: { purpose: Ceremony; boundTo: string },
  input: { response: RegistrationResponseJSON; name?: string },
  userAgent?: string,
  within?: (tx: Db, made: PasskeyRow) => Promise<void>,
): Promise<{ passkey: Passkey; id: string }> {
  const rp = await requireOn(app, user);
  const { response } = input;
  const challenge = await takeChallenge(app.db, response.response.clientDataJSON, bound.purpose, bound.boundTo, user.id);
  checkClient(rp, response.response.clientDataJSON, 'webauthn.create');
  let uv: boolean;
  let attestation: ReturnType<typeof decodeAttestationObject>;
  try {
    attestation = decodeAttestationObject(Buffer.from(response.response.attestationObject, 'base64url'));
    uv = flagsOf(attestation.get('authData')).uv;
  } catch {
    throw refused();
  }
  if (!uv) throw notVerified();
  // Only some authenticators (D68): its maker must vouch for it, and be one of those taken.
  const list = await authenticatorList(app);
  const vouched = list ? await vouchedFor(app, attestation, list) : null;
  await holdStatements(list ? await metadataInUse(app) : null);
  let verified;
  try {
    verified = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: true,
      supportedAlgorithmIDs: ALGORITHMS,
    });
  } catch (e) {
    console.warn(`passkeys: a registration was refused: ${e instanceof Error ? e.message : String(e)}`);
    throw refused();
  }
  if (!verified.verified) throw refused();
  const info = verified.registrationInfo;
  const name = vouched ? (input.name?.trim() || nameOf(vouched)).slice(0, 60) : passkeyName(input.name, info.aaguid, userAgent);
  const row = await app.db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    // One at a time per person, so two at once can't pass the cap together.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for('update');
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(passkeys).where(eq(passkeys.userId, user.id));
    if (Number(n) >= MAX_PASSKEYS) throw tooMany();
    // A credential a requester has on the portal is theirs (D69): never a member's too.
    if (!(await credentialFree(tx, info.credential.id))) throw conflict('That passkey is in a4a already', 'Each passkey is added once.').said('passkeys.already');
    const [made] = await tx
      .insert(passkeys)
      .values({
        id: newId(),
        userId: user.id,
        credentialId: info.credential.id,
        publicKey: Buffer.from(info.credential.publicKey),
        signCount: info.credential.counter,
        transports: (response.response.transports ?? []).slice(0, 10),
        multiDevice: info.credentialDeviceType === 'multiDevice',
        backedUp: info.credentialBackedUp,
        aaguid: info.aaguid,
        name,
        rpId: rp.id,
        attested: Boolean(vouched),
      })
      .onConflictDoNothing()
      .returning();
    if (!made) throw conflict('That passkey is in a4a already', 'Each passkey is added once.').said('passkeys.already');
    await tellOf(tx, app, user.id, { change: 'added', passkeyId: made.id, name: made.name });
    if (within) await within(tx, made);
    return made;
  });
  kickMail(app);
  return { passkey: passkeyDto(row, rp, list), id: row.id };
}

export async function renamePasskey(app: AppServices, user: UserRow, id: string, name: string): Promise<Passkey> {
  const [row] = await app.db
    .update(passkeys)
    .set({ name: name.trim().slice(0, 60) })
    .where(and(eq(passkeys.id, id), eq(passkeys.userId, user.id)))
    .returning();
  if (!row) throw notFound('Passkey').said('notFound.passkey');
  return passkeyDto(row, rpOf(app));
}

/**
 * Its person takes it away: it signs nobody in, and the other sessions it signed in end. Even with
 * passkeys off. `check` runs in the transaction once it's gone, to refuse what that would leave (D68).
 */
export async function removePasskey(app: AppServices, user: UserRow, session: SessionRef, id: string, check?: (tx: Db) => Promise<void>): Promise<void> {
  requireRecent(session);
  await app.db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const [gone] = await tx.delete(passkeys).where(and(eq(passkeys.id, id), eq(passkeys.userId, user.id))).returning();
    if (!gone) throw notFound('Passkey').said('notFound.passkey');
    if (check) await check(tx);
    await tx.delete(sessions).where(and(eq(sessions.passkeyId, gone.id), ne(sessions.id, session.id)));
    await tellOf(tx, app, user.id, { change: 'removed', passkeyId: gone.id, name: gone.name });
  });
  kickMail(app);
}

/** An administrator's removal, for a lost device: every passkey of theirs, and every session one signed in. */
export async function removePasskeysOf(ctx: Ctx, userId: string, check?: (tx: Db) => Promise<void>): Promise<number> {
  requireScope(ctx, 'admin');
  const [u] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  if (!u) throw notFound(`User ${userId}`).said('notFound.user', { id: userId });
  const n = await ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const gone = await tx.delete(passkeys).where(eq(passkeys.userId, userId)).returning({ id: passkeys.id, name: passkeys.name });
    if (!gone.length) return 0;
    if (check) await check(tx);
    await tx.delete(sessions).where(inArray(sessions.passkeyId, gone.map((g) => g.id)));
    await tellOf(tx, ctx.app, userId, { change: 'removed-by-admin', passkeyId: null, name: gone.length === 1 ? gone[0]!.name : '', n: gone.length });
    return gone.length;
  });
  kickMail(ctx.app);
  return n;
}

// ---------------------------------------------------------------------------
// Using one
// ---------------------------------------------------------------------------

async function requestOptions(app: AppServices, rp: RelyingParty, purpose: Ceremony, boundTo: string, user: UserRow | null): Promise<PasskeyOptions> {
  const challenge = await newChallenge(app.db, purpose, boundTo, user?.id ?? null);
  const allow = user ? working(await rowsOf(app.db, user.id), rp) : [];
  return (await generateAuthenticationOptions({
    rpID: rp.id,
    // As bytes: a string would be taken as text, and encoded again.
    challenge: new Uint8Array(Buffer.from(challenge, 'base64url')),
    timeout: CHALLENGE_TTL_MS,
    userVerification: 'required',
    // Signing in from the sign-in page names nobody: the browser offers the passkeys it has for a4a.
    ...(user ? { allowCredentials: allow.map((r) => ({ id: r.credentialId, transports: r.transports })) } : {}),
  })) as unknown as PasskeyOptions;
}

/** Options for signing in from the sign-in page, bound to the browser's ticket. */
export async function signInOptions(app: AppServices, ticket: string): Promise<PasskeyOptions> {
  return requestOptions(app, await requireOn(app), 'sign-in', sha256(ticket), null);
}

/** Options for the step after a password: the person's own passkeys, bound to the sign-in's ticket. */
export async function secondStepOptions(app: AppServices, ticketId: string, user: UserRow): Promise<PasskeyOptions> {
  return requestOptions(app, await requireOn(app, user), 'second-step', ticketId, user);
}

/** Options for proving it's you again, in a signed-in session. */
export async function confirmOptions(app: AppServices, user: UserRow, session: SessionRef): Promise<PasskeyOptions> {
  return requestOptions(app, await requireOn(app, user), 'confirm', session.id, user);
}

async function rowByCredential(db: Db, credentialId: string): Promise<PasskeyRow | undefined> {
  const [row] = await db.select().from(passkeys).where(eq(passkeys.credentialId, credentialId));
  return row;
}

/**
 * A passkey's count went back: two authenticators hold its key. It signs nobody in from now on, the
 * sessions it signed in end, and its person is told, once.
 */
async function markCopied(app: AppServices, row: PasskeyRow): Promise<void> {
  await app.db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const [marked] = await tx.update(passkeys).set({ copiedAt: new Date() }).where(and(eq(passkeys.id, row.id), isNull(passkeys.copiedAt))).returning({ id: passkeys.id });
    if (!marked) return;
    await tx.delete(sessions).where(eq(sessions.passkeyId, row.id));
    await tellOf(tx, app, row.userId, { change: 'copied', passkeyId: row.id, name: row.name });
  });
  kickMail(app);
  console.warn(`passkeys: passkey ${row.id} of user ${row.userId} answered with a sign count it had passed; it signs nobody in again`);
}

/** Check one assertion against its passkey, and move the passkey's count on to it. */
async function verifyAssertion(app: AppServices, rp: RelyingParty, row: PasskeyRow, response: AuthenticationResponseJSON, challenge: string): Promise<void> {
  if (row.copiedAt) throw copiedProblem();
  if (row.rpId !== rp.id) throw elsewhere(row.rpId);
  checkClient(rp, response.response.clientDataJSON, 'webauthn.get');
  let flags;
  try {
    flags = flagsOf(Buffer.from(response.response.authenticatorData, 'base64url'));
  } catch {
    throw refused();
  }
  if (!flags.uv) throw notVerified();
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      // The count is checked here, below, so a count that goes back is known for what it is.
      credential: { id: row.credentialId, publicKey: new Uint8Array(row.publicKey), counter: 0, transports: row.transports },
      requireUserVerification: true,
    });
  } catch (e) {
    console.warn(`passkeys: a sign-in with passkey ${row.id} was refused: ${e instanceof Error ? e.message : String(e)}`);
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
    .update(passkeys)
    .set({ signCount: next, lastUsedAt: new Date(), backedUp: result.authenticationInfo.credentialBackedUp })
    .where(and(eq(passkeys.id, row.id), isNull(passkeys.copiedAt), or(lt(passkeys.signCount, next), and(eq(passkeys.signCount, 0), sql`${next} = 0`))))
    .returning({ id: passkeys.id });
  // Another use got there first, with a higher count, or it was just marked copied: this one is refused, and marks nothing.
  if (!moved.length) throw refused();
}

/** The person a passkey from the sign-in page names, signed in by it: both factors at once. */
export async function signInWithPasskey(app: AppServices, ticket: string | undefined, response: AuthenticationResponseJSON): Promise<{ user: UserRow; passkeyId: string }> {
  const rp = await requireOn(app);
  if (!ticket) throw stale();
  const challenge = await takeChallenge(app.db, response.response.clientDataJSON, 'sign-in', sha256(ticket), null);
  const row = await rowByCredential(app.db, response.id);
  if (!row || response.rawId !== response.id) throw notKnown();
  // The browser says whose passkey it is: it must be the one a4a gave it to.
  if (response.response.userHandle && Buffer.from(response.response.userHandle, 'base64url').toString('utf8') !== row.userId) throw notKnown();
  const [user] = await app.db.select().from(users).where(eq(users.id, row.userId));
  if (!user || user.banned || !mayHavePasskeys(user)) throw notKnown();
  await verifyAssertion(app, rp, row, response, challenge);
  return { user, passkeyId: row.id };
}

/** A passkey in place of a code, after a password: one of that person's own. */
export async function secondStepWithPasskey(app: AppServices, ticketId: string, user: UserRow, response: AuthenticationResponseJSON): Promise<{ passkeyId: string }> {
  const rp = await requireOn(app, user);
  const challenge = await takeChallenge(app.db, response.response.clientDataJSON, 'second-step', ticketId, user.id);
  const row = await rowByCredential(app.db, response.id);
  // Someone else's passkey proves nothing about this person.
  if (!row || row.userId !== user.id) throw notKnown();
  await verifyAssertion(app, rp, row, response, challenge);
  return { passkeyId: row.id };
}

/** Proving it's you again with a passkey: the session may add and remove passkeys for ten minutes. */
export async function confirmWithPasskey(app: AppServices, user: UserRow, session: SessionRef, response: AuthenticationResponseJSON): Promise<Date> {
  const rp = await requireOn(app, user);
  const challenge = await takeChallenge(app.db, response.response.clientDataJSON, 'confirm', session.id, user.id);
  const row = await rowByCredential(app.db, response.id);
  if (!row || row.userId !== user.id) throw notKnown();
  await verifyAssertion(app, rp, row, response, challenge);
  return markVerified(app.db, session.id, 'passkey');
}

/** The session's person proved it's them just now: with a passkey, or a password (D68 keeps which). */
export async function markVerified(db: Db, sessionId: string, by: 'passkey' | 'password' = 'password'): Promise<Date> {
  const now = new Date();
  // A session from before a4a kept how it was signed in is known from here on as one confirmed.
  await db
    .update(sessions)
    .set({ verifiedAt: now, verifiedBy: by, signedInWith: sql`coalesce(${sessions.signedInWith}, 'confirmed')` })
    .where(eq(sessions.id, sessionId));
  return new Date(now.getTime() + RECENT_MS);
}

/** The session behind a request's cookie, for what only a signed-in browser may do. */
export async function sessionRef(db: Db, token: string | undefined): Promise<SessionRef | null> {
  if (!token) return null;
  const [row] = await db
    .select({ id: sessions.id, verifiedAt: sessions.verifiedAt, signedInWith: sessions.signedInWith, verifiedBy: sessions.verifiedBy })
    .from(sessions)
    .where(eq(sessions.id, sha256(token)));
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Telling its person, and "this wasn't me"
// ---------------------------------------------------------------------------

type Change = 'added' | 'removed' | 'copied' | 'removed-by-admin' | 'password-removed';

/** Queue the mail that tells someone their passkeys changed, in the change's transaction. */
export async function tellOf(tx: Db, app: AppServices, userId: string, what: { change: Change; passkeyId: string | null; name: string; n?: number }): Promise<void> {
  const id = newId();
  await enqueueMail(tx, app, { kind: 'passkey', dedupeKey: `passkey:${id}`, userId, payload: { ...what, at: new Date().toISOString() }, messageId: `pk-${id}` });
}

export async function renderPasskeyMail(app: AppServices, row: MailRow): Promise<RenderedMail | null> {
  const p = row.payload as { change?: Change; passkeyId?: string | null; name?: string; n?: number; at?: string };
  if (!row.userId || !p.change || !p.at) return null;
  const [u] = await app.db.select().from(users).where(eq(users.id, row.userId));
  if (!u || !u.email || u.isBot || u.banned) return null;
  const tr = translatorFor(localeOfPerson(app, u));
  const when = emailTime(p.at, zoneOfUser(u), tr.locale);
  const name = p.name ?? '';
  const words = { name, login: u.login, when, n: p.n ?? 1 };
  const profile = `${app.config.publicUrl}/me`;
  // An administrator's removal was nobody's mistake to report: it says who, and how to add one again.
  if (p.change === 'removed-by-admin') {
    const subject = tr.t('server.passkeys.removedByAdminSubject', words);
    const { text, html } = composeMail(subject, {
      lang: langTag(tr.locale),
      lead: tr.t('server.passkeys.removedByAdmin', words),
      // With no password (D68), only a link from an administrator lets them in again.
      sections: [{ head: tr.t(u.passkeysOnly ? 'server.passkeys.askForALink' : 'server.passkeys.signInAndAddAgain') }],
      action: { label: tr.t('server.passkeys.openYourProfile'), url: profile },
      why: tr.t('server.passkeys.why', { login: u.login }),
    });
    return { to: u.email, subject, text, html, headers: { ...AUTOMATIC } };
  }
  const token = randomToken('', 32);
  const tokenHash = sha256(token);
  await app.db.insert(passkeyAlerts).values({
    tokenHash,
    userId: u.id,
    change: p.change,
    passkeyId: p.passkeyId ?? null,
    name,
    changedAt: new Date(p.at),
    expiresAt: new Date(Date.now() + ALERT_TTL_MS),
  });
  const gonePassword = p.change === 'password-removed';
  const subject = tr.t(gonePassword ? 'server.passkeys.passwordRemovedSubject' : p.change === 'added' ? 'server.passkeys.addedSubject' : p.change === 'removed' ? 'server.passkeys.removedSubject' : 'server.passkeys.copiedSubject');
  const lead = tr.t(gonePassword ? 'server.passkeys.passwordRemoved' : p.change === 'added' ? 'server.passkeys.added' : p.change === 'removed' ? 'server.passkeys.removed' : 'server.passkeys.copied', words);
  const head = tr.t(gonePassword ? 'server.passkeys.ifYouRemovedYourPassword' : p.change === 'added' ? 'server.passkeys.ifYouAddedIt' : p.change === 'removed' ? 'server.passkeys.ifYouRemovedIt' : u.passkeysOnly ? 'server.passkeys.removeItAndAddNew' : 'server.passkeys.removeAndAddNew');
  // No password to change (D68): the fix is the link, and an administrator.
  const notYou = gonePassword || u.passkeysOnly ? tr.t('server.passkeys.notYouPasskeysOnly', { change: p.change }) : tr.t('server.passkeys.notYou', { change: p.change });
  const { text, html } = composeMail(subject, {
    lang: langTag(tr.locale),
    lead,
    sections: [{ head, lines: [notYou] }],
    action: { label: tr.t(p.change === 'copied' ? 'server.passkeys.signOutEverywhere' : 'server.passkeys.thisWasntMe'), url: `${app.config.publicUrl}/not-me?token=${encodeURIComponent(token)}` },
    why: tr.t('server.passkeys.why', { login: u.login }),
  });
  return {
    to: u.email,
    subject,
    text,
    html,
    headers: { ...AUTOMATIC },
    // A link nobody received is forgotten.
    onFailed: async () => {
      await app.db.delete(passkeyAlerts).where(eq(passkeyAlerts.tokenHash, tokenHash));
    },
  };
}

const alertGone = () =>
  notFound('Link', 'It was used already, or it’s more than two weeks old. Sign in and look at your passkeys on your profile.').said('passkeys.alertGone');

async function alertRow(db: Db, token: string) {
  const [row] = await db
    .select({ alert: passkeyAlerts, login: users.login })
    .from(passkeyAlerts)
    .innerJoin(users, eq(users.id, passkeyAlerts.userId))
    .where(and(eq(passkeyAlerts.tokenHash, sha256(token)), gt(passkeyAlerts.expiresAt, new Date())));
  return row;
}

const alertDto = (row: NonNullable<Awaited<ReturnType<typeof alertRow>>>, done: boolean): PasskeyAlert => ({
  change: row.alert.change as PasskeyAlert['change'],
  name: row.alert.name,
  login: row.login,
  changedAt: row.alert.changedAt.toISOString(),
  done,
});

/** What a "this wasn't me" link is about, before it's followed: opening it changes nothing (scanners open links). */
export async function describeAlert(app: AppServices, token: string): Promise<PasskeyAlert> {
  const row = await alertRow(app.db, token);
  if (!row) throw alertGone();
  return alertDto(row, Boolean(row.alert.usedAt));
}

/**
 * Its person says the change wasn't theirs: every session of theirs ends, and the passkey it names
 * signs nobody in, with any added after it. It only takes access away, so it needs no sign-in: the
 * mail is the proof. Once.
 */
export async function followAlert(app: AppServices, token: string): Promise<PasskeyAlert> {
  const row = await alertRow(app.db, token);
  if (!row) throw alertGone();
  if (row.alert.usedAt) return alertDto(row, true);
  await app.db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const [taken] = await tx
      .update(passkeyAlerts)
      .set({ usedAt: new Date() })
      .where(and(eq(passkeyAlerts.tokenHash, row.alert.tokenHash), isNull(passkeyAlerts.usedAt)))
      .returning({ tokenHash: passkeyAlerts.tokenHash });
    if (!taken) return;
    const { userId, passkeyId, change, changedAt } = row.alert;
    if (change === 'added' && passkeyId) {
      await tx.delete(passkeys).where(and(eq(passkeys.userId, userId), or(eq(passkeys.id, passkeyId), gte(passkeys.createdAt, changedAt))));
    } else if (change === 'copied' && passkeyId) {
      await tx.delete(passkeys).where(and(eq(passkeys.userId, userId), eq(passkeys.id, passkeyId)));
    }
    await tx.delete(sessions).where(eq(sessions.userId, userId));
  });
  return alertDto(row, true);
}

/** Thrown where only a signed-in browser may act. */
export const browserOnly = () =>
  forbidden('Passkeys are changed from a signed-in browser', 'Open your profile in a4a; a token can’t change how you sign in.').said('passkeys.browserOnly');

// ---------------------------------------------------------------------------
// Only some authenticators (D68)
// ---------------------------------------------------------------------------

/** The authenticators new passkeys may come from, by AAGUID, where an administrator chose some; null for any. */
export async function authenticatorList(app: AppServices): Promise<string[] | null> {
  const list = (await getSetting(app.db, 'passkeyAuthenticators')) as string[] | null | undefined;
  return Array.isArray(list) && list.length ? list : null;
}

/** Attestation formats whose check the library makes against the authenticator's metadata statement. */
const VOUCHING = new Set(['packed', 'tpm', 'android-key']);

export const noMetadata = () =>
  new AppError(
    503,
    'passkey_metadata_missing',
    'a4a can’t check passkeys’ makers yet',
    'Only some authenticators are taken here, and FIDO’s list of them hasn’t been read yet. Try again later, or ask an administrator.',
  ).said('passkeys.noMetadata');
const unattested = () =>
  new AppError(
    400,
    'passkey_unattested',
    'This passkey’s maker didn’t vouch for it',
    'Only some authenticators are taken here, and a4a knows which by what their maker vouches. Synced passkeys mostly don’t: use a security key or device your organisation chose.',
  ).said('passkeys.unattested');
const notListed = () =>
  new AppError(403, 'passkey_not_listed', 'That kind of authenticator isn’t taken here', 'An administrator chose which are: your profile lists them.').said('passkeys.notListed');
const unknownMaker = () =>
  new AppError(403, 'passkey_not_listed', 'FIDO’s metadata doesn’t describe that authenticator', 'a4a checks a maker’s word against it, so it can’t take this one. Ask an administrator.').said('passkeys.unknownMaker');
const untrustedMaker = (name: string) =>
  new AppError(403, 'passkey_not_listed', `FIDO says ${name} can’t be trusted`, 'Its maker reported it compromised or revoked. Use another authenticator.').said('passkeys.untrustedMaker', { name });

/**
 * Before the cryptography: the attestation must be one its maker signed, from an authenticator on
 * the list that FIDO's metadata describes and still trusts. Its signature, and that its certificates
 * chain to the roots the statement names, the library checks after (holdStatements).
 */
async function vouchedFor(app: AppServices, attestation: ReturnType<typeof decodeAttestationObject>, list: string[]): Promise<MdsEntry> {
  const metadata = await metadataInUse(app);
  if (!metadata) throw noMetadata();
  const fmt = attestation.get('fmt');
  const x5c = attestation.get('attStmt')?.get('x5c');
  // `none`, and self attestation (no certificate), prove nothing about who made the key.
  if (!VOUCHING.has(fmt) || !Array.isArray(x5c) || !x5c.length) throw unattested();
  let aaguid: string;
  try {
    const parsed = parseAuthenticatorData(new Uint8Array(attestation.get('authData')));
    if (!parsed.aaguid) throw new Error('no AAGUID');
    aaguid = convertAAGUIDToString(parsed.aaguid);
  } catch {
    throw refused();
  }
  if (!list.includes(aaguid)) throw notListed();
  const entry = metadata.byAaguid.get(aaguid);
  if (!entry) throw unknownMaker();
  if (untrusted(entry)) throw untrustedMaker(nameOf(entry));
  return entry;
}
