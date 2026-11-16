/**
 * Two-factor sign-in for password accounts (docs/architecture.md, D38): a TOTP code after the
 * password, from an authenticator app enrolled by a QR code, with recovery codes for a lost phone.
 *
 * - The secret is kept encrypted (lib/secret-box.ts); recovery codes as hashes, each good once.
 * - A code is good once: the step it was taken in is kept, and taking it is one conditional update,
 *   so two requests with one code can't both pass.
 * - A sign-in whose password was right but whose second step is owed is a ticket: a cookie's token,
 *   kept as a hash, good for ten minutes and five tries. Its tries count in the sign-in throttle too.
 * - Single sign-on and API tokens are untouched: their providers and tokens carry their own checks.
 */
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import type { AppServices } from '../context';
import type { Db } from '../db/client';
import { recoveryCodes, signInTickets, userTotp } from '../db/schema';
import { randomToken, sha256 } from '../lib/crypto';
import { AppError, conflict } from '../lib/errors';
import { newId } from '../lib/ids';
import { open, seal } from '../lib/secret-box';
import { base32Encode, checkCode, newTotpSecret, otpauthUri } from '../lib/totp';
import { randomBytes } from 'node:crypto';
import { getSetting, setSetting } from './settings';
import type { UserRow } from './schema-cache';

export const TICKET_COOKIE = 'a4a_2fa';
/** The ticket's cookie goes only to the endpoints that finish a sign-in. */
export const TICKET_COOKIE_PATH = '/api/v1/auth/two-factor';
export const TICKET_TTL_MS = 10 * 60_000;
export const TICKET_TRIES = 5;
export const RECOVERY_CODE_COUNT = 10;

export type TicketPurpose = 'verify' | 'enroll';

const keySource = (app: AppServices) => ({ secretKey: app.config.secretKey, dataDir: app.config.dataDir });

// ---------------------------------------------------------------------------
// What an administrator asks of everyone
// ---------------------------------------------------------------------------

export async function twoFactorRequired(db: Db): Promise<boolean> {
  return (await getSetting(db, 'requireTwoFactor')) === true;
}

export async function setTwoFactorRequired(db: Db, on: boolean): Promise<void> {
  await setSetting(db, 'requireTwoFactor', on);
}

// ---------------------------------------------------------------------------
// One person's second factor
// ---------------------------------------------------------------------------

async function totpRow(db: Db, userId: string) {
  const [row] = await db.select().from(userTotp).where(eq(userTotp.userId, userId));
  return row;
}

export async function hasTwoFactor(db: Db, userId: string): Promise<boolean> {
  return Boolean((await totpRow(db, userId))?.confirmedAt);
}

export interface TwoFactorStatus {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesLeft: number;
  required: boolean;
}

export async function twoFactorStatus(db: Db, userId: string): Promise<TwoFactorStatus> {
  const row = await totpRow(db, userId);
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)));
  return {
    enabled: Boolean(row?.confirmedAt),
    enabledAt: row?.confirmedAt?.toISOString() ?? null,
    recoveryCodesLeft: row?.confirmedAt ? Number(n) : 0,
    required: await twoFactorRequired(db),
  };
}

export interface Enrolment {
  /** For typing in by hand, in groups of four. */
  secret: string;
  otpauthUri: string;
}

/** Start setting two-factor up: a new secret, kept until a code from it confirms it. */
export async function beginEnrolment(app: AppServices, user: UserRow, issuer: string): Promise<Enrolment> {
  const row = await totpRow(app.db, user.id);
  if (row?.confirmedAt) throw conflict('Two-factor sign-in is on already', 'Turn it off first to set it up with another app.');
  const secret = newTotpSecret();
  const sealed = seal(keySource(app), secret);
  await app.db
    .insert(userTotp)
    .values({ userId: user.id, secret: sealed, confirmedAt: null, lastStep: null })
    .onConflictDoUpdate({ target: userTotp.userId, set: { secret: sealed, confirmedAt: null, lastStep: null, createdAt: new Date() } });
  return { secret: secret.match(/.{1,4}/g)!.join(' '), otpauthUri: otpauthUri(secret, issuer, user.login) };
}

/** The address the QR code holds, for an enrolment under way; null when there is none. */
export async function enrolmentUri(app: AppServices, user: UserRow, issuer: string): Promise<string | null> {
  const row = await totpRow(app.db, user.id);
  if (!row || row.confirmedAt) return null;
  const secret = open(keySource(app), row.secret);
  return secret ? otpauthUri(secret, issuer, user.login) : null;
}

function newRecoveryCode(): string {
  // 50 bits, in base32 without look-alikes' trouble: an app's alphabet, read in two halves.
  const raw = base32Encode(randomBytes(7)).slice(0, 10);
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

const normalCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, '');

async function freshRecoveryCodes(db: Db, userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
  await db.insert(recoveryCodes).values(codes.map((c) => ({ id: newId(), userId, codeHash: sha256(normalCode(c)) })));
  return codes;
}

export const wrongCode = () => new AppError(400, 'wrong_code', 'That code isn’t right', 'Type the six digits your authenticator app shows now; each code works once.');

/** Confirm an enrolment with a code from the app: two-factor is on, and here are the recovery codes, shown once. */
export async function confirmEnrolment(app: AppServices, userId: string, code: string): Promise<string[]> {
  const row = await totpRow(app.db, userId);
  if (!row) throw conflict('Two-factor sign-in isn’t being set up', 'Start setting it up first.');
  if (row.confirmedAt) throw conflict('Two-factor sign-in is on already');
  const secret = open(keySource(app), row.secret);
  if (!secret) throw new AppError(500, 'secret_unreadable', 'The secret being set up can’t be read', 'Start setting it up again.');
  const step = checkCode(secret, code, Date.now(), null);
  if (step === null) throw wrongCode();
  await app.db.update(userTotp).set({ confirmedAt: new Date(), lastStep: step }).where(eq(userTotp.userId, userId));
  return freshRecoveryCodes(app.db, userId);
}

/**
 * Whether a code is right for someone whose two-factor is on: a code from the app, taken once, or
 * an unused recovery code, used up. Says which it was.
 */
export async function takeSecondFactor(app: AppServices, userId: string, code: string): Promise<'totp' | 'recovery' | null> {
  const row = await totpRow(app.db, userId);
  if (!row?.confirmedAt) return null;
  const digits = code.replace(/\s+/g, '');
  if (/^\d{6}$/.test(digits)) {
    const secret = open(keySource(app), row.secret);
    if (!secret) return null;
    const step = checkCode(secret, digits, Date.now(), row.lastStep);
    if (step === null) return null;
    // Taken once: only one request can move the step on to it.
    const taken = await app.db
      .update(userTotp)
      .set({ lastStep: step })
      .where(and(eq(userTotp.userId, userId), sql`(${userTotp.lastStep} IS NULL OR ${userTotp.lastStep} < ${step})`))
      .returning({ userId: userTotp.userId });
    return taken.length ? 'totp' : null;
  }
  const used = await app.db
    .update(recoveryCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(recoveryCodes.userId, userId), eq(recoveryCodes.codeHash, sha256(normalCode(code))), isNull(recoveryCodes.usedAt)))
    .returning({ id: recoveryCodes.id });
  return used.length ? 'recovery' : null;
}

/** New recovery codes, for someone who proves it's them with a code now; the old ones stop working. */
export async function renewRecoveryCodes(app: AppServices, userId: string, code: string): Promise<string[]> {
  if (!(await hasTwoFactor(app.db, userId))) throw conflict('Two-factor sign-in isn’t on');
  if ((await takeSecondFactor(app, userId, code)) === null) throw wrongCode();
  return freshRecoveryCodes(app.db, userId);
}

/** Turn it off, with a code: the secret and the recovery codes go. */
export async function disableTwoFactor(app: AppServices, userId: string, code: string): Promise<void> {
  if (!(await hasTwoFactor(app.db, userId))) throw conflict('Two-factor sign-in isn’t on');
  if (await twoFactorRequired(app.db)) {
    throw new AppError(403, 'two_factor_required', 'Two-factor sign-in is required here', 'An administrator asks it of every password account. To move to another app, ask one to reset yours.');
  }
  if ((await takeSecondFactor(app, userId, code)) === null) throw wrongCode();
  await removeTwoFactor(app.db, userId);
}

/** An administrator's reset, for a lost phone and no recovery codes: the next sign-in sets it up again if required. */
export async function removeTwoFactor(db: Db, userId: string): Promise<void> {
  await db.delete(userTotp).where(eq(userTotp.userId, userId));
  await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
}

// ---------------------------------------------------------------------------
// A sign-in halfway
// ---------------------------------------------------------------------------

/** What a sign-in whose password was right still owes: a code, setting two-factor up, or nothing. */
export async function secondStepFor(db: Db, userId: string): Promise<TicketPurpose | null> {
  if (await hasTwoFactor(db, userId)) return 'verify';
  if (await twoFactorRequired(db)) return 'enroll';
  return null;
}

export async function issueTicket(db: Db, userId: string, purpose: TicketPurpose): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken('a4t_', 32);
  const expiresAt = new Date(Date.now() + TICKET_TTL_MS);
  await db.insert(signInTickets).values({ id: sha256(token), userId, purpose, expiresAt });
  return { token, expiresAt };
}

export type TicketRow = typeof signInTickets.$inferSelect;

/** The live ticket a cookie holds, counting a try on it; null once it ran out, or was never one. */
export async function useTicket(db: Db, token: string | undefined, purpose: TicketPurpose): Promise<TicketRow | null> {
  if (!token) return null;
  const [row] = await db
    .update(signInTickets)
    .set({ attempts: sql`${signInTickets.attempts} + 1` })
    .where(and(eq(signInTickets.id, sha256(token)), eq(signInTickets.purpose, purpose), sql`${signInTickets.expiresAt} > now()`, lt(signInTickets.attempts, TICKET_TRIES)))
    .returning();
  return row ?? null;
}

/** The live ticket, without counting a try: for showing an enrolment's QR code. */
export async function peekTicket(db: Db, token: string | undefined, purpose: TicketPurpose): Promise<TicketRow | null> {
  if (!token) return null;
  const [row] = await db
    .select()
    .from(signInTickets)
    .where(and(eq(signInTickets.id, sha256(token)), eq(signInTickets.purpose, purpose), sql`${signInTickets.expiresAt} > now()`, lt(signInTickets.attempts, TICKET_TRIES)));
  return row ?? null;
}

export async function endTicket(db: Db, token: string): Promise<void> {
  await db.delete(signInTickets).where(eq(signInTickets.id, sha256(token)));
}

/** Housekeeping. */
export async function pruneTickets(db: Db): Promise<void> {
  await db.delete(signInTickets).where(lt(signInTickets.expiresAt, new Date()));
}
