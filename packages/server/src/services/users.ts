import { OWN_AGENTS, type Role, type User } from '@a4a/shared';
import { eq, sql } from 'drizzle-orm';
import { isAdmin, requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { sessions, users } from '../db/schema';
import { hashPassword, verifyPassword } from '../lib/crypto';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors';
import { colorFor, newId } from '../lib/ids';
import { accessChanged } from './access';
import { findUser, type UserRow } from './schema-cache';
import { signInsOf } from './sso';

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
  if (!u) throw notFound(`User ${idOrLogin}`);
  return (await userDtos(ctx, [u]))[0]!;
}

export interface NewUser {
  login: string;
  name: string;
  email?: string | null;
  /** The email is vouched for (an administrator set it, or an identity provider verified it). */
  emailVerified?: boolean;
  password?: string;
  role?: Role;
  isBot?: boolean;
  hourlyRate?: number | null;
  capacityHoursPerDay?: number;
}

export async function insertUser(db: Db, input: NewUser): Promise<UserRow> {
  const existing = await db.select().from(users).where(sql`lower(${users.login}) = ${input.login.toLowerCase()}`);
  // Its own code, so a caller racing another for the same login can tell and try another.
  if (existing.length) throw new AppError(400, 'login_taken', `Login "${input.login}" is already taken`);
  const [row] = await db
    .insert(users)
    .values({
      id: newId(),
      login: input.login,
      name: input.name,
      email: input.email ?? null,
      emailVerified: Boolean(input.email) && (input.emailVerified ?? false),
      passwordHash: input.password ? await hashPassword(input.password) : null,
      role: input.role ?? 'member',
      isBot: input.isBot ?? false,
      avatarColor: colorFor(input.login),
      hourlyRate: input.hourlyRate ?? null,
      capacityHoursPerDay: input.capacityHoursPerDay ?? 8,
    })
    .returning();
  return row!;
}

export async function createUser(ctx: Ctx, input: NewUser): Promise<User> {
  requireScope(ctx, 'admin');
  // a4a makes its own agents' accounts itself (the help desk's, the first time a request comes in).
  if ((OWN_AGENTS as readonly string[]).includes(input.login.trim().toLowerCase())) {
    throw new AppError(400, 'login_taken', `Login "${input.login}" belongs to a4a's own agent`, 'Choose another login: a4a makes that account itself.');
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
    hourlyRate?: number | null;
    capacityHoursPerDay?: number;
  },
): Promise<User> {
  const s = await ctx.app.schema.get();
  const target = s.users.get(idOrLogin) ?? findUser(s, idOrLogin, ctx.actor.user.id);
  if (!target) throw notFound(`User ${idOrLogin}`);
  const self = target.id === ctx.actor.user.id;
  const adminOnly = input.role !== undefined || input.banned !== undefined || input.hourlyRate !== undefined;
  if (!self || adminOnly) requireScope(ctx, 'admin');
  else requireScope(ctx, 'write');
  if (self && input.role && input.role !== 'admin' && target.role === 'admin') {
    throw badRequest('You cannot remove your own admin role');
  }
  if (input.password && self && !ctx.app.config.passwordLogin) {
    throw badRequest('Passwords aren’t used here', `You sign in with ${ctx.app.config.oidc?.name ?? ctx.app.config.saml?.name ?? 'single sign-on'}.`);
  }
  // An email counts for single sign-on when an administrator sets it; one people set for
  // themselves doesn't, until an administrator confirms it by saving it.
  const emailVerified =
    input.email === undefined ? undefined : input.email !== null && (isAdmin(ctx) || (input.email.toLowerCase() === (target.email ?? '').toLowerCase() && target.emailVerified));
  const [row] = await ctx.db
    .update(users)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.email !== undefined ? { email: input.email, emailVerified } : {}),
      ...(input.password ? { passwordHash: await hashPassword(input.password) } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.banned !== undefined ? { banned: input.banned } : {}),
      ...(input.hourlyRate !== undefined ? { hourlyRate: input.hourlyRate } : {}),
      ...(input.capacityHoursPerDay !== undefined ? { capacityHoursPerDay: input.capacityHoursPerDay } : {}),
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
  input: { name?: string; email?: string | null; password?: string; currentPassword?: string },
): Promise<User> {
  requireScope(ctx, 'write');
  if (input.password && !ctx.app.config.passwordLogin) {
    throw badRequest('Passwords aren’t used here', `You sign in with ${ctx.app.config.oidc?.name ?? ctx.app.config.saml?.name ?? 'single sign-on'}.`);
  }
  if (input.password) {
    const ok = await verifyPassword(input.currentPassword ?? '', ctx.actor.user.passwordHash);
    if (!ok && ctx.actor.user.passwordHash) throw forbidden('Current password is incorrect');
  }
  return updateUser(ctx, ctx.actor.user.id, { name: input.name, email: input.email, password: input.password });
}

export async function deleteUser(ctx: Ctx, idOrLogin: string): Promise<void> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const target = s.users.get(idOrLogin) ?? findUser(s, idOrLogin, ctx.actor.user.id);
  if (!target) throw notFound(`User ${idOrLogin}`);
  if (target.id === ctx.actor.user.id) throw badRequest('You cannot delete yourself');
  await ctx.db.delete(users).where(eq(users.id, target.id));
  ctx.app.schema.invalidate();
  accessChanged(ctx.app);
}

export { isAdmin };
