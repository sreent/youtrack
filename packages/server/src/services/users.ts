import type { Role, User } from '@tracklet/shared';
import { eq, sql } from 'drizzle-orm';
import { isAdmin, requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { sessions, users } from '../db/schema';
import { hashPassword, verifyPassword } from '../lib/crypto';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { colorFor, newId } from '../lib/ids';
import { findUser, type UserRow } from './schema-cache';

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

export async function listUsers(ctx: Ctx, search?: string): Promise<User[]> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const q = search?.trim().toLowerCase();
  return [...s.users.values()]
    .filter((u) => !q || u.login.toLowerCase().includes(q) || u.name.toLowerCase().includes(q))
    .map(userDto);
}

export async function getUser(ctx: Ctx, idOrLogin: string): Promise<User> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const u = s.users.get(idOrLogin) ?? findUser(s, idOrLogin, ctx.actor.user.id);
  if (!u) throw notFound(`User ${idOrLogin}`);
  return userDto(u);
}

export interface NewUser {
  login: string;
  name: string;
  email?: string | null;
  password?: string;
  role?: Role;
  isBot?: boolean;
  hourlyRate?: number | null;
  capacityHoursPerDay?: number;
}

export async function insertUser(db: Db, input: NewUser): Promise<UserRow> {
  const existing = await db.select().from(users).where(sql`lower(${users.login}) = ${input.login.toLowerCase()}`);
  if (existing.length) throw badRequest(`Login "${input.login}" is already taken`);
  const [row] = await db
    .insert(users)
    .values({
      id: newId(),
      login: input.login,
      name: input.name,
      email: input.email ?? null,
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
  const row = await insertUser(ctx.db, input);
  ctx.app.schema.invalidate();
  return userDto(row);
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
  const [row] = await ctx.db
    .update(users)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
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
  return userDto(row!);
}

export async function updateMe(
  ctx: Ctx,
  input: { name?: string; email?: string | null; password?: string; currentPassword?: string },
): Promise<User> {
  requireScope(ctx, 'write');
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
}

export { isAdmin };
