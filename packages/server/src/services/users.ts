import { OWN_AGENTS, type Role, type User } from '@a4a/shared';
import { eq, sql } from 'drizzle-orm';
import { isAdmin, requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { sessions, users } from '../db/schema';
import { hashPassword, verifyPassword } from '../lib/crypto';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors';
import { colorFor, newId } from '../lib/ids';
import { accessChanged } from './access';
import { setPasskeyExempt } from './passkey-policy';
import { deletePrivateSearchesOf } from './saved-searches';
import { requireOn } from './passkeys';
import { findUser, type UserRow } from './schema-cache';
import { signInsOf } from './sso';
import { timeZoneOrRefuse } from './time-zones';

export function userDto(u: UserRow): User {
  return {
    id: u.id,
    login: u.login,
    name: u.name,
    avatarColor: u.avatarColor,
    isBot: u.isBot,
    email: u.email,
    role: u.role as Role,
    banned: u.banned,
    hourlyRate: u.hourlyRate,
    capacityHoursPerDay: u.capacityHoursPerDay,
    workWeek: u.workWeek ?? null,
    createdAt: u.createdAt.toISOString(),
  };
}

/** People as the caller sees them; administrators also see how each signs in. */
async function userDtos(ctx: Ctx, people: UserRow[]): Promise<User[]> {
  if (!isAdmin(ctx)) return people.map(userDto);
  const signIns = await signInsOf(ctx.app, ctx.db, people);
  return people.map((u) => ({ ...userDto(u), signIn: signIns.get(u.id) }));
}

export async function listUsers(ctx: Ctx, search?: string): Promise<User[]> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const q = search?.trim().toLowerCase();
  return userDtos(
    ctx,
    [...s.users.values()].filter((u) => !q || u.login.toLowerCase().includes(q) || u.name.toLowerCase().includes(q)),
  );
}

export async function getUser(ctx: Ctx, idOrLogin: string): Promise<User> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const u = s.users.get(idOrLogin) ?? findUser(s, idOrLogin, ctx.actor.user.id);
  if (!u) throw notFound(`User ${idOrLogin}`).said('notFound.user', { id: idOrLogin });
  return (await userDtos(ctx, [u]))[0]!;
}

export interface NewUser {
  login: string;
  name: string;
  email?: string | null;
  /** The email is vouched for (an administrator set it, or an identity provider verified it). */
  emailVerified?: boolean;
  password?: string;
  /** No password: passkeys alone sign them in, the first added from a link an administrator sends (D68). */
  passkeysOnly?: boolean;
  role?: Role;
  isBot?: boolean;
  hourlyRate?: number | null;
  capacityHoursPerDay?: number;
  workWeek?: number[] | null;
}

export async function insertUser(db: Db, input: NewUser): Promise<UserRow> {
  const existing = await db.select().from(users).where(sql`lower(${users.login}) = ${input.login.toLowerCase()}`);
  // Its own code, so a caller racing another for the same login can tell and try another.
  if (existing.length) throw new AppError(400, 'login_taken', `Login "${input.login}" is already taken`).said('users.loginTaken', { login: input.login });
  const [row] = await db
    .insert(users)
    .values({
      id: newId(),
      login: input.login,
      name: input.name,
      email: input.email ?? null,
      emailVerified: Boolean(input.email) && (input.emailVerified ?? false),
      passwordHash: input.password ? await hashPassword(input.password) : null,
      passkeysOnly: Boolean(input.passkeysOnly) && !input.password,
      role: input.role ?? 'member',
      isBot: input.isBot ?? false,
      avatarColor: colorFor(input.login),
      hourlyRate: input.hourlyRate ?? null,
      capacityHoursPerDay: input.capacityHoursPerDay ?? 8,
      workWeek: input.workWeek ?? null,
    })
    .returning();
  return row!;
}

export async function createUser(ctx: Ctx, input: NewUser): Promise<User> {
  requireScope(ctx, 'admin');
  // a4a makes its own agents' accounts itself (the help desk's, the first time a request comes in).
  if ((OWN_AGENTS as readonly string[]).includes(input.login.trim().toLowerCase())) {
    throw new AppError(400, 'login_taken', `Login "${input.login}" belongs to a4a's own agent`, 'Choose another login: a4a makes that account itself.').said('users.loginIsAgents', { login: input.login });
  }
  if (input.passkeysOnly) {
    if (input.isBot) throw badRequest('An agent has no passkeys', 'Agents use API tokens.').said('passkeys.agentNoPasskeys');
    if (input.password) throw badRequest('Give a password, or passkeys alone: not both', 'With passkeys alone, they add their first from a link you send.').said('passkeys.passwordOrPasskeys');
    // Its first passkey comes from a link: where none can be made, nothing would ever sign it in.
    await requireOn(ctx.app);
  }
  // An email an administrator gives is one single sign-on may find the person by.
  const row = await insertUser(ctx.db, { ...input, emailVerified: Boolean(input.email) });
  ctx.app.schema.invalidate();
  return (await userDtos(ctx, [row]))[0]!;
}

export async function updateUser(
  ctx: Ctx,
  idOrLogin: string,
  input: {
    name?: string;
    email?: string | null;
    password?: string;
    role?: Role;
    banned?: boolean;
    /** Where passkeys are required, they sign in without one: their password and a code (D68). */
    passkeyExempt?: boolean;
    hourlyRate?: number | null;
    capacityHoursPerDay?: number;
    /** Hours on each weekday, Sunday first (D43), or null for the plan's working days. */
    workWeek?: number[] | null;
    /** A canonical IANA name (services/time-zones.ts checks it), or null for the server's. */
    timeZone?: string | null;
    /** One of LOCALES, or null for their browser's (D49). */
    locale?: string | null;
    /** Their HR calendar (D36's revisit): an iCal feed; administrators set it. */
    hrCalendar?: string | null;
  },
): Promise<User> {
  const s = await ctx.app.schema.get();
  const target = s.users.get(idOrLogin) ?? findUser(s, idOrLogin, ctx.actor.user.id);
  if (!target) throw notFound(`User ${idOrLogin}`).said('notFound.user', { id: idOrLogin });
  const self = target.id === ctx.actor.user.id;
  const adminOnly = input.role !== undefined || input.banned !== undefined || input.hourlyRate !== undefined || input.passkeyExempt !== undefined || input.hrCalendar !== undefined;
  if (!self || adminOnly) requireScope(ctx, 'admin');
  else requireScope(ctx, 'write');
  if (self && input.role && input.role !== 'admin' && target.role === 'admin') {
    throw badRequest('You cannot remove your own admin role').said('users.ownAdminRole');
  }
  if (input.password && self && !ctx.app.config.passwordLogin) {
    throw badRequest('Passwords aren’t used here', `You sign in with ${ctx.app.config.oidc?.name ?? ctx.app.config.saml?.name ?? 'single sign-on'}.`).said('users.noPasswords', { named: ctx.app.config.oidc?.name ?? ctx.app.config.saml?.name ? 'yes' : 'no', provider: ctx.app.config.oidc?.name ?? ctx.app.config.saml?.name ?? '' });
  }
  // Its own transaction, which refuses taking it back where no administrator would sign in (D68).
  if (input.passkeyExempt !== undefined) await setPasskeyExempt(ctx, target.id, input.passkeyExempt);
  // An email counts for single sign-on when an administrator sets it; one people set for
  // themselves doesn't, until an administrator confirms it by saving it.
  const emailVerified =
    input.email === undefined ? undefined : input.email !== null && (isAdmin(ctx) || (input.email.toLowerCase() === (target.email ?? '').toLowerCase() && target.emailVerified));
  const [row] = await ctx.db
    .update(users)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.email !== undefined ? { email: input.email, emailVerified } : {}),
      // A password ends passkeys alone (D68): an administrator's reset, or its person's choice.
      ...(input.password ? { passwordHash: await hashPassword(input.password), passkeysOnly: false } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.banned !== undefined ? { banned: input.banned } : {}),
      ...(input.hourlyRate !== undefined ? { hourlyRate: input.hourlyRate } : {}),
      ...(input.capacityHoursPerDay !== undefined ? { capacityHoursPerDay: input.capacityHoursPerDay } : {}),
      ...(input.workWeek !== undefined ? { workWeek: input.workWeek } : {}),
      ...(input.hrCalendar !== undefined ? { hrCalendar: input.hrCalendar } : {}),
      ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
      updatedAt: new Date(),
    })
    .where(eq(users.id, target.id))
    .returning();
  if (input.banned || input.password) await ctx.db.delete(sessions).where(eq(sessions.userId, target.id));
  ctx.app.schema.invalidate();
  if (input.role !== undefined || input.banned !== undefined) accessChanged(ctx.app);
  return (await userDtos(ctx, [row!]))[0]!;
}

export async function updateMe(
  ctx: Ctx,
  input: { name?: string; email?: string | null; password?: string; currentPassword?: string; timeZone?: string | null; locale?: string | null; workWeek?: number[] | null },
): Promise<User> {
  requireScope(ctx, 'write');
  // A zone this server doesn't know is refused before anything changes; one it knows is kept by its canonical name.
  const timeZone = input.timeZone === undefined || input.timeZone === null ? input.timeZone : timeZoneOrRefuse(input.timeZone);
  if (input.password && !ctx.app.config.passwordLogin) {
    throw badRequest('Passwords aren’t used here', `You sign in with ${ctx.app.config.oidc?.name ?? ctx.app.config.saml?.name ?? 'single sign-on'}.`).said('users.noPasswords', { named: ctx.app.config.oidc?.name ?? ctx.app.config.saml?.name ? 'yes' : 'no', provider: ctx.app.config.oidc?.name ?? ctx.app.config.saml?.name ?? '' });
  }
  if (input.password) {
    const ok = await verifyPassword(input.currentPassword ?? '', ctx.actor.user.passwordHash);
    if (!ok && ctx.actor.user.passwordHash) throw forbidden('Current password is incorrect').said('users.wrongPassword');
  }
  return updateUser(ctx, ctx.actor.user.id, { name: input.name, email: input.email, password: input.password, timeZone, locale: input.locale, workWeek: input.workWeek });
}

export async function deleteUser(ctx: Ctx, idOrLogin: string): Promise<void> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const target = s.users.get(idOrLogin) ?? findUser(s, idOrLogin, ctx.actor.user.id);
  if (!target) throw notFound(`User ${idOrLogin}`).said('notFound.user', { id: idOrLogin });
  if (target.id === ctx.actor.user.id) throw badRequest('You cannot delete yourself').said('users.deleteYourself');
  await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    // Their private searches go with them; their shared ones, a team's plans, stay, with no owner (D72).
    await deletePrivateSearchesOf(tx, target.id);
    await tx.delete(users).where(eq(users.id, target.id));
  });
  ctx.app.schema.invalidate();
  accessChanged(ctx.app);
}

export { isAdmin };
