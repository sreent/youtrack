/**
 * Passkeys in depth (docs/architecture.md, D68): an instance's policy, accounts with passkeys and no
 * password, and the one-time links that add an account's first passkey.
 *
 * - **Required, of everyone or of administrators.** A password sign-in that owes a passkey and has
 *   none adds one before its session starts, as two-factor's required setup works (D38). The escape,
 *   for a device that can't make one, is an administrator's: they let that person off (`exempt`), who
 *   then signs in with their password and a code. Only people a4a's own password signs in are asked:
 *   single sign-on and directory accounts are their provider's (D62).
 * - **The last administrator.** A policy, a removal or a lifted exemption that would leave no
 *   administrator able to sign in is refused: each such change locks the administrators' rows and
 *   counts, in its transaction, those who still sign in under it.
 * - **No password.** Someone with a spare passkey (two that sign in here, or one their provider
 *   syncs) removes their password after proving it's them with a passkey. Then a password sign-in is
 *   refused in its own words, codes don't apply, and confirming it's them takes a passkey.
 * - **Setup links**, D33's kind of token: minted as the mail is sent (or shown once to the
 *   administrator), kept as a hash, good once for three days, for one account. Losing every passkey
 *   means an administrator sends one again: no email alone is a way in (D62).
 */
import type { MyPasskeys, PasskeySetupInfo, PasskeySetupLink, PasskeysRequired } from '@a4a/shared';
import { PASSKEYS_REQUIRED } from '@a4a/shared';
import { langTag } from '@a4a/shared/i18n';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { requireScope, type AppServices, type Ctx } from '../context';
import type { Db } from '../db/client';
import { passkeys, passkeySetupLinks, recoveryCodes, sessions, users, userTotp } from '../db/schema';
import { randomToken, sha256 } from '../lib/crypto';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { localeOfPerson, translatorFor } from '../i18n';
import { AUTOMATIC, composeMail, type RenderedMail } from '../mail/compose';
import { enqueueMail, kickMail, type MailRow } from '../mail/outbox';
import { mailConfigured } from '../notify/state';
import { emailTime } from '../notify/words';
import { metadataInUse, nameOf, refreshMetadata } from './passkey-metadata';
import {
  authenticatorList,
  confirmedUntil,
  mayHavePasskeys,
  passkeysOff,
  registerPasskey,
  registrationOptionsFor,
  requireOn,
  rpOf,
  tellOf,
  working,
  type SessionRef,
} from './passkeys';
import type { UserRow } from './schema-cache';
import { getSetting, setSetting } from './settings';
import { zoneOfUser } from './time-zones';

/** How long a setup link works. Long enough for one sent before a weekend; short enough that an old mail is no key. */
export const SETUP_TTL_MS = 3 * 86_400_000;
/** The setup link's page: the token rides in the fragment, which no server's log keeps. */
export const SETUP_PAGE = '/passkey-setup';

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

export async function requiredOfWhom(db: Db): Promise<PasskeysRequired> {
  const v = await getSetting(db, 'requirePasskeys');
  return (PASSKEYS_REQUIRED as readonly unknown[]).includes(v) ? (v as PasskeysRequired) : 'off';
}

/**
 * What a password sign-in owes, as passkeys go: nothing; a passkey (`owed`); or, for someone an
 * administrator let off, a code in its place (`exempt`). Only where passkeys are on: required while
 * they're off would let nobody in, so it asks nothing.
 */
export async function passkeyOwed(app: AppServices, user: UserRow): Promise<'no' | 'owed' | 'exempt'> {
  if (!mayHavePasskeys(user) || (await passkeysOff(app)) !== null) return 'no';
  const required = await requiredOfWhom(app.db);
  const applies = required === 'everyone' || (required === 'admins' && user.role === 'admin');
  if (!applies) return 'no';
  return user.passkeyExemptAt ? 'exempt' : 'owed';
}

const wouldLockOut = () =>
  conflict(
    'That would leave no administrator able to sign in',
    'An administrator needs a passkey that signs in here, a password where passkeys aren’t required of them, or to be let off. Add a passkey to your own account first, on your profile.',
  ).said('passkeys.wouldLockOut');
const cantRequireWhileOff = () =>
  conflict('Passkeys can’t be required while they’re off', 'Turn them on first. Where PUBLIC_URL isn’t https, or a4a’s own passwords are off, they can’t be.').said('passkeys.cantRequireWhileOff');
export const lastAdmin = () =>
  conflict('You’d leave no administrator able to sign in', 'Every other administrator owes a passkey and has none, or has no password. Add another passkey first, or let an administrator off.').said('passkeys.lastAdmin');
const onlyWayIn = () =>
  conflict('That’s your only passkey, and you have no password', 'Add another passkey first, or set a password on your profile: otherwise nothing signs you in.').said('passkeys.onlyWayIn');

/**
 * How many administrators still sign in under a policy: those single sign-on or a directory signs in
 * (outside it); those with no password who hold a passkey that signs in here; and, with a password,
 * those it doesn't ask a passkey of, those let off, and those who hold one. Someone who'd have to add
 * one at their next sign-in isn't counted: whether their device can is what nobody knows yet. Locks
 * the administrators' rows, so two changes at once count one after the other.
 */
async function adminsWhoSignIn(tx: Db, app: AppServices, policy: { required: PasskeysRequired; passkeysOn: boolean }): Promise<number> {
  const admins = await tx
    .select()
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.isBot, false), eq(users.banned, false)))
    .for('update');
  const rp = rpOf(app);
  let n = 0;
  for (const a of admins) {
    if (!mayHavePasskeys(a)) {
      n++;
      continue;
    }
    const holds = policy.passkeysOn && rp ? (await tx.select({ id: passkeys.id }).from(passkeys).where(and(eq(passkeys.userId, a.id), isNull(passkeys.copiedAt), eq(passkeys.rpId, rp.id))).limit(1)).length > 0 : false;
    if (a.passkeysOnly) {
      if (holds) n++;
      continue;
    }
    const asked = policy.passkeysOn && (policy.required === 'everyone' || policy.required === 'admins');
    if (!asked || a.passkeyExemptAt || holds) n++;
  }
  return n;
}

const configOn = (app: AppServices) => Boolean(rpOf(app)) && app.config.passwordLogin;

/** The administrator's passkey settings (D62's switch, and D68's policy and list), refused where they'd lock administrators out. */
export async function applyPasskeySettings(ctx: Ctx, input: { passkeys?: boolean; requirePasskeys?: PasskeysRequired; passkeyAuthenticators?: string[] | null }): Promise<void> {
  requireScope(ctx, 'admin');
  if (input.passkeys === undefined && input.requirePasskeys === undefined && input.passkeyAuthenticators === undefined) return;
  const app = ctx.app;
  await ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const now = { on: (await getSetting(tx, 'passkeys')) !== false, required: await requiredOfWhom(tx) };
    const next = { on: input.passkeys ?? now.on, required: input.requirePasskeys ?? now.required };
    if (next.required !== 'off' && (!next.on || !configOn(app))) throw cantRequireWhileOff();
    if (next.on !== now.on || next.required !== now.required) {
      if ((await adminsWhoSignIn(tx, app, { required: next.required, passkeysOn: next.on && configOn(app) })) === 0) throw wouldLockOut();
    }
    // Off, passkeys sign nobody in and none are added; they're kept, for when they're on again (D62).
    if (input.passkeys !== undefined) await setSetting(tx, 'passkeys', input.passkeys);
    // From the next sign-in on; a session already open stays, as two-factor's requirement leaves them (D38).
    if (input.requirePasskeys !== undefined) await setSetting(tx, 'requirePasskeys', input.requirePasskeys);
    if (input.passkeyAuthenticators !== undefined) await setSetting(tx, 'passkeyAuthenticators', input.passkeyAuthenticators?.length ? [...new Set(input.passkeyAuthenticators)] : null);
  });
  // A list wants FIDO's metadata: read it now, so the page says at once whether it came.
  if (input.passkeyAuthenticators?.length) void refreshMetadata(app).catch((e) => console.warn(`passkeys: reading FIDO's metadata failed: ${String(e)}`));
}

/** Its person removes a passkey: refused where nothing would sign them in, or no administrator would (in the removal's transaction). */
export const ownRemovalCheck = (app: AppServices, user: UserRow) => async (tx: Db) => {
  const [me] = await tx.select().from(users).where(eq(users.id, user.id)).for('update');
  if (!me) return;
  const left = working(await tx.select().from(passkeys).where(eq(passkeys.userId, me.id)), rpOf(app));
  if (me.passkeysOnly && !left.length) throw onlyWayIn();
  if (me.role === 'admin' && (await adminsWhoSignIn(tx, app, { required: await requiredOfWhom(tx), passkeysOn: (await passkeysOff(app)) === null })) === 0) throw lastAdmin();
};

/** An administrator removes someone's passkeys: refused where it would leave no administrator able to sign in. */
export const adminRemovalCheck = (app: AppServices, userId: string) => async (tx: Db) => {
  const [target] = await tx.select({ role: users.role }).from(users).where(eq(users.id, userId));
  if (target?.role !== 'admin') return;
  if ((await adminsWhoSignIn(tx, app, { required: await requiredOfWhom(tx), passkeysOn: (await passkeysOff(app)) === null })) === 0) throw lastAdmin();
};

/** An administrator lets someone sign in without a passkey where passkeys are required, or takes that back. */
export async function setPasskeyExempt(ctx: Ctx, userId: string, exempt: boolean): Promise<void> {
  requireScope(ctx, 'admin');
  await ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await tx.update(users).set({ passkeyExemptAt: exempt ? new Date() : null, updatedAt: new Date() }).where(eq(users.id, userId));
    if (!exempt && (await adminsWhoSignIn(tx, ctx.app, { required: await requiredOfWhom(tx), passkeysOn: (await passkeysOff(ctx.app)) === null })) === 0) throw lastAdmin();
  });
  ctx.app.schema.invalidate();
}

// ---------------------------------------------------------------------------
// What a person's profile says of it
// ---------------------------------------------------------------------------

/** Removing your password: whether you may, and what it still needs. */
export async function passwordState(app: AppServices, user: UserRow, session: SessionRef | null): Promise<NonNullable<MyPasskeys['password']>> {
  const set = Boolean(user.passwordHash);
  if (!set || !mayHavePasskeys(user) || (await passkeysOff(app)) !== null) return { set, removable: false, needs: null };
  const left = working(await app.db.select().from(passkeys).where(eq(passkeys.userId, user.id)), rpOf(app));
  if (!spare(left)) return { set, removable: false, needs: 'spare' };
  const proved = Boolean(confirmedUntil(session)) && session?.verifiedBy === 'passkey';
  return { set, removable: proved, needs: proved ? null : 'passkey' };
}

/** A spare: two passkeys that sign in here, or one its provider keeps backed up, so losing a device isn't losing the account. */
const spare = (left: { backedUp: boolean }[]) => left.length >= 2 || left.some((p) => p.backedUp);

/** The profile's word on D68: whether passkeys are required of you, which authenticators are taken, and your password. */
export async function moreOfMine(app: AppServices, user: UserRow, session: SessionRef | null): Promise<Pick<MyPasskeys, 'required' | 'authenticators' | 'password'>> {
  const list = await authenticatorList(app);
  const metadata = list ? await metadataInUse(app) : null;
  return {
    required: (await passkeyOwed(app, user)) !== 'no',
    authenticators: list ? list.map((a) => (metadata?.byAaguid.get(a) ? nameOf(metadata.byAaguid.get(a)!) : a)) : null,
    password: await passwordState(app, user, session),
  };
}

// ---------------------------------------------------------------------------
// No password
// ---------------------------------------------------------------------------

const passkeyProofFirst = () =>
  new AppError(403, 'passkey_proof_needed', 'Confirm it’s you with a passkey first', 'Removing your password takes one of your passkeys in the last ten minutes, so you know it signs you in.').said('passkeys.proofFirst');
const spareFirst = () =>
  conflict('Add a second passkey first', 'With no password, a passkey is your way in: keep a second one, or one your passkey provider syncs, in case you lose a device.').said('passkeys.spareFirst');
const noPasswordToRemove = () => conflict('You have no password', 'You sign in with passkeys alone already.').said('passkeys.noPasswordToRemove');

/**
 * Its person removes their password: from then on, passkeys alone sign them in. Their codes go with
 * it (a code only follows a password), and so do the other sessions no passkey signed in.
 */
export async function removePassword(app: AppServices, user: UserRow, session: SessionRef): Promise<void> {
  const rp = await requireOn(app, user);
  if (!user.passwordHash) throw noPasswordToRemove();
  if (!confirmedUntil(session) || session.verifiedBy !== 'passkey') throw passkeyProofFirst();
  await app.db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const [me] = await tx.select().from(users).where(eq(users.id, user.id)).for('update');
    if (!me?.passwordHash) throw noPasswordToRemove();
    if (!spare(working(await tx.select().from(passkeys).where(eq(passkeys.userId, me.id)), rp))) throw spareFirst();
    await tx.update(users).set({ passwordHash: null, passkeysOnly: true, updatedAt: new Date() }).where(eq(users.id, me.id));
    await tx.delete(userTotp).where(eq(userTotp.userId, me.id));
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, me.id));
    await tx.delete(sessions).where(and(eq(sessions.userId, me.id), ne(sessions.id, session.id), isNull(sessions.passkeyId)));
    await tellOf(tx, app, me.id, { change: 'password-removed', passkeyId: null, name: '' });
  });
  app.schema.invalidate();
  kickMail(app);
}

/** A password sign-in for an account that has none: said as what it is, not as a wrong password. */
export const passkeysOnlySignIn = () =>
  new AppError(401, 'passkeys_only', 'This account signs in with a passkey', 'It has no password: use “Sign in with a passkey”. Lost your passkeys? An administrator can send you a link to add one.').said('passkeys.onlySignIn');
export const confirmWithAPasskey = () =>
  badRequest('You sign in with passkeys: confirm it’s you with one of them', 'Your account has no password to type.').said('passkeys.confirmWithOne');
export const codesFollowPasswords = () =>
  conflict('Two-factor codes follow a password, and you have none', 'You sign in with passkeys alone: each one checks it’s you already.').said('passkeys.codesFollowPasswords');

/** The account a password sign-in names, when it signs in with passkeys alone. */
export async function passkeysOnlyAccount(db: Db, login: string): Promise<boolean> {
  const [u] = await db.select({ only: users.passkeysOnly, banned: users.banned, isBot: users.isBot }).from(users).where(sql`lower(${users.login}) = ${login.trim().toLowerCase()}`);
  return Boolean(u?.only && !u.banned && !u.isBot);
}

// ---------------------------------------------------------------------------
// A passkey a sign-in owes
// ---------------------------------------------------------------------------

/** A challenge for the passkey a password sign-in owes, bound to its ticket. */
export async function owedOptions(app: AppServices, ticketId: string, user: UserRow) {
  return registrationOptionsFor(app, user, 'owed', ticketId);
}

export async function addOwedPasskey(app: AppServices, ticketId: string, user: UserRow, input: { response: RegistrationResponseJSON; name?: string }, userAgent?: string) {
  return registerPasskey(app, user, { purpose: 'owed', boundTo: ticketId }, input, userAgent);
}

// ---------------------------------------------------------------------------
// Setup links
// ---------------------------------------------------------------------------

const linkGone = () =>
  notFound('Link', 'It was used already, it ran out, or a newer one was sent. Ask an administrator for a new one.').said('passkeys.setupGone');
const wrongPerson = (login: string, other: string) =>
  conflict(`You’re signed in as ${other}`, `This link is for ${login}. Sign out, then open it again.`).said('passkeys.setupWrongPerson', { other, login });

async function liveLink(db: Db, token: string) {
  const [row] = await db
    .select({ link: passkeySetupLinks, user: users })
    .from(passkeySetupLinks)
    .innerJoin(users, eq(users.id, passkeySetupLinks.userId))
    .where(and(eq(passkeySetupLinks.tokenHash, sha256(token)), isNull(passkeySetupLinks.usedAt), gt(passkeySetupLinks.expiresAt, new Date())));
  // A link is for an account with passkeys alone: one given a password since, or banned, has no use for it.
  if (!row || row.user.banned || row.user.isBot || !row.user.passkeysOnly) throw linkGone();
  return row;
}

/** Who this browser is signed in as, if anyone. */
async function signedInAs(db: Db, sessionToken: string | undefined): Promise<{ id: string; login: string } | null> {
  if (!sessionToken) return null;
  const [row] = await db
    .select({ id: users.id, login: users.login })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sha256(sessionToken)), gt(sessions.expiresAt, new Date())));
  return row ?? null;
}

/**
 * An administrator sends a link that adds a passkey to an account with no password: its first, or one
 * in place of every one it lost. Mailed to their address, the token minted as the mail is sent; or
 * shown, once, to hand over another way. A newer link voids the ones before it.
 */
export async function sendSetupLink(ctx: Ctx, userId: string, deliver?: 'email' | 'show'): Promise<PasskeySetupLink> {
  requireScope(ctx, 'admin');
  const [user] = await ctx.db.select().from(users).where(eq(users.id, userId));
  if (!user) throw notFound(`User ${userId}`).said('notFound.user', { id: userId });
  if (user.isBot) throw badRequest('An agent has no passkeys', 'Agents use API tokens.').said('passkeys.agentNoPasskeys');
  if (!user.passkeysOnly) {
    throw conflict(`${user.login} has a password`, 'A link adds a passkey to an account with none. Set a new password for them, or they add a passkey from their profile.').said('passkeys.setupHasPassword', { login: user.login });
  }
  await requireOn(ctx.app, user);
  const mailable = Boolean(user.email) && mailConfigured(ctx.app);
  const how = deliver ?? (mailable ? 'email' : 'show');
  if (how === 'email' && !mailable) {
    throw badRequest(user.email ? 'Mail isn’t set up here' : `${user.login} has no email`, 'Show the link instead, and give it to them yourself.').said(user.email ? 'passkeys.setupNoMail' : 'passkeys.setupNoEmail', { login: user.login });
  }
  // Its first passkey, or one in place of those it lost: the mail says which.
  const [held] = await ctx.db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.userId, user.id)).limit(1);
  const expiresAt = new Date(Date.now() + SETUP_TTL_MS);
  const url = await ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await tx.delete(passkeySetupLinks).where(and(eq(passkeySetupLinks.userId, user.id), isNull(passkeySetupLinks.usedAt)));
    if (how === 'email') {
      const id = newId();
      await enqueueMail(tx, ctx.app, { kind: 'passkey-setup', dedupeKey: `passkey-setup:${id}`, userId: user.id, payload: { madeBy: ctx.actor.user.id, first: !held, at: new Date().toISOString() }, messageId: `pks-${id}` });
      return null;
    }
    const token = randomToken('a4k_', 32);
    await tx.insert(passkeySetupLinks).values({ tokenHash: sha256(token), userId: user.id, madeBy: ctx.actor.user.id, expiresAt });
    return `${ctx.app.config.publicUrl}${SETUP_PAGE}#${token}`;
  });
  if (how === 'email') kickMail(ctx.app);
  return { mailed: how === 'email', url, expiresAt: expiresAt.toISOString() };
}

export async function renderSetupMail(app: AppServices, row: MailRow): Promise<RenderedMail | null> {
  const p = row.payload as { madeBy?: string | null; first?: boolean; at?: string };
  if (!row.userId) return null;
  const [u] = await app.db.select().from(users).where(eq(users.id, row.userId));
  if (!u || !u.email || u.isBot || u.banned || !u.passkeysOnly) return null;
  const [admin] = p.madeBy ? await app.db.select({ name: users.name }).from(users).where(eq(users.id, p.madeBy)) : [];
  const tr = translatorFor(localeOfPerson(app, u));
  const token = randomToken('a4k_', 32);
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + SETUP_TTL_MS);
  await app.db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await tx.delete(passkeySetupLinks).where(and(eq(passkeySetupLinks.userId, u.id), isNull(passkeySetupLinks.usedAt)));
    await tx.insert(passkeySetupLinks).values({ tokenHash, userId: u.id, madeBy: p.madeBy ?? null, expiresAt });
  });
  const words = { admin: admin?.name ?? '', named: admin ? 'yes' : 'no', login: u.login, when: emailTime(expiresAt.toISOString(), zoneOfUser(u), tr.locale) };
  const subject = tr.t(p.first ? 'server.passkeySetup.subjectFirst' : 'server.passkeySetup.subjectAgain');
  const { text, html } = composeMail(subject, {
    lang: langTag(tr.locale),
    lead: tr.t(p.first ? 'server.passkeySetup.leadFirst' : 'server.passkeySetup.leadAgain', words),
    sections: [{ head: tr.t('server.passkeySetup.how'), lines: [tr.t('server.passkeySetup.once', words)] }],
    action: { label: tr.t('server.passkeySetup.addAPasskey'), url: `${app.config.publicUrl}${SETUP_PAGE}#${token}` },
    why: tr.t('server.passkeySetup.why', words),
  });
  return {
    to: u.email,
    subject,
    text,
    html,
    headers: { ...AUTOMATIC },
    // A link nobody received is forgotten.
    onFailed: async () => {
      await app.db.delete(passkeySetupLinks).where(eq(passkeySetupLinks.tokenHash, tokenHash));
    },
  };
}

/** What a setup link is for, before it's used: opening it changes nothing. */
export async function setupInfo(app: AppServices, token: string, sessionToken: string | undefined): Promise<PasskeySetupInfo> {
  const { link, user } = await liveLink(app.db, token);
  const other = await signedInAs(app.db, sessionToken);
  return { login: user.login, name: user.name, expiresAt: link.expiresAt.toISOString(), signedInAs: other && other.id !== user.id ? other.login : null };
}

/** A challenge for the link's passkey, bound to this browser's ticket and to the link's account. */
export async function setupOptions(app: AppServices, token: string, ticket: string, sessionToken: string | undefined) {
  const { user } = await liveLink(app.db, token);
  const other = await signedInAs(app.db, sessionToken);
  if (other && other.id !== user.id) throw wrongPerson(user.login, other.login);
  return registrationOptionsFor(app, user, 'setup', sha256(ticket));
}

/**
 * The link's passkey, made: the link is taken in the same transaction (once: of two at once, one
 * wins and the other's passkey goes back out), the account's other links are voided, and every
 * session it had ends, since a lost passkey may be in someone else's hands. Then it signs them in.
 */
export async function finishSetup(
  app: AppServices,
  token: string,
  ticket: string | undefined,
  sessionToken: string | undefined,
  input: { response: RegistrationResponseJSON; name?: string },
  userAgent?: string,
): Promise<{ user: UserRow; passkeyId: string }> {
  const { link, user } = await liveLink(app.db, token);
  const other = await signedInAs(app.db, sessionToken);
  if (other && other.id !== user.id) throw wrongPerson(user.login, other.login);
  if (!ticket) throw linkGone();
  const made = await registerPasskey(app, user, { purpose: 'setup', boundTo: sha256(ticket) }, input, userAgent, async (tx) => {
    const [taken] = await tx
      .update(passkeySetupLinks)
      .set({ usedAt: new Date() })
      .where(and(eq(passkeySetupLinks.tokenHash, link.tokenHash), isNull(passkeySetupLinks.usedAt), gt(passkeySetupLinks.expiresAt, new Date())))
      .returning({ tokenHash: passkeySetupLinks.tokenHash });
    if (!taken) throw linkGone();
    await tx.delete(passkeySetupLinks).where(and(eq(passkeySetupLinks.userId, user.id), isNull(passkeySetupLinks.usedAt)));
    await tx.delete(sessions).where(eq(sessions.userId, user.id));
  });
  return { user, passkeyId: made.id };
}

/** For the people table: the unused link's expiry, per person. */
export async function setupLinksOf(db: Db, userIds: string[]): Promise<Map<string, string>> {
  if (!userIds.length) return new Map();
  const rows = await db.select({ userId: passkeySetupLinks.userId, expiresAt: passkeySetupLinks.expiresAt }).from(passkeySetupLinks).where(and(isNull(passkeySetupLinks.usedAt), gt(passkeySetupLinks.expiresAt, new Date())));
  return new Map(rows.filter((r) => userIds.includes(r.userId)).map((r) => [r.userId, r.expiresAt.toISOString()]));
}
