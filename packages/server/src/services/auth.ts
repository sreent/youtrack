import type { ApiToken, Scope } from '@tracklet/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { effectiveScopes, requireScope, type Actor, type Ctx } from '../context';
import type { Db } from '../db/client';
import { apiTokens, sessions, users } from '../db/schema';
import { randomToken, sha256, verifyPassword } from '../lib/crypto';
import { notFound, unauthorized } from '../lib/errors';
import { newId } from '../lib/ids';
import type { UserRow } from './schema-cache';

export const SESSION_COOKIE = 'tracklet_session';
const TOKEN_PREFIX = 'trk_';

export async function login(
  db: Db,
  loginName: string,
  password: string,
  ttlDays: number,
  userAgent?: string,
): Promise<{ token: string; user: UserRow; expiresAt: Date }> {
  const [user] = await db.select().from(users).where(sql`lower(${users.login}) = ${loginName.trim().toLowerCase()}`);
  const ok = user && !user.banned && !user.isBot && (await verifyPassword(password, user.passwordHash));
  if (!ok) throw unauthorized('Wrong login or password');
  const token = randomToken('tls_', 32);
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);
  await db.insert(sessions).values({ id: sha256(token), userId: user.id, expiresAt, userAgent: userAgent?.slice(0, 300) });
  return { token, user, expiresAt };
}

export async function logout(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sha256(token)));
}

export async function actorFromSession(db: Db, token: string): Promise<Actor | null> {
  const [row] = await db
    .select({ user: users, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, sha256(token)));
  if (!row || row.expiresAt < new Date() || row.user.banned) return null;
  return {
    user: row.user,
    scopes: effectiveScopes(row.user.role),
    channel: 'web',
    tokenId: null,
    tokenName: null,
    authMethod: 'session',
  };
}

const lastUsedWrites = new Map<string, number>();

export async function actorFromToken(db: Db, bearer: string, channel: 'api' | 'mcp'): Promise<Actor | null> {
  if (!bearer.startsWith(TOKEN_PREFIX)) return null;
  const [row] = await db
    .select({ token: apiTokens, user: users })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(and(eq(apiTokens.tokenHash, sha256(bearer)), isNull(apiTokens.revokedAt)));
  if (!row || row.user.banned) return null;
  if (row.token.expiresAt && row.token.expiresAt < new Date()) return null;
  const now = Date.now();
  if ((lastUsedWrites.get(row.token.id) ?? 0) < now - 60_000) {
    lastUsedWrites.set(row.token.id, now);
    void db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.token.id)).catch(() => {});
  }
  return {
    user: row.user,
    scopes: effectiveScopes(row.user.role, row.token.scopes),
    channel,
    tokenId: row.token.id,
    tokenName: row.token.name,
    authMethod: 'token',
  };
}

function tokenDto(t: typeof apiTokens.$inferSelect): ApiToken {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    scopes: t.scopes as Scope[],
    createdAt: t.createdAt.toISOString(),
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    expiresAt: t.expiresAt?.toISOString() ?? null,
  };
}

export async function issueTokenFor(
  db: Db,
  userId: string,
  input: { name: string; scopes: Scope[]; expiresInDays?: number | null },
): Promise<ApiToken & { token: string }> {
  const token = randomToken(TOKEN_PREFIX, 32);
  const [row] = await db
    .insert(apiTokens)
    .values({
      id: newId(),
      userId,
      name: input.name,
      tokenHash: sha256(token),
      prefix: token.slice(0, 10),
      scopes: [...new Set(input.scopes)],
      expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
    })
    .returning();
  return { ...tokenDto(row!), token };
}

export async function createToken(
  ctx: Ctx,
  input: { name: string; scopes: Scope[]; expiresInDays?: number | null },
): Promise<ApiToken & { token: string }> {
  // A token can be created with any scopes; they are always capped by the user's role.
  requireScope(ctx, 'read');
  if (ctx.actor.authMethod === 'token') requireScope(ctx, 'write');
  return issueTokenFor(ctx.db, ctx.actor.user.id, input);
}

export async function listTokens(ctx: Ctx): Promise<ApiToken[]> {
  requireScope(ctx, 'read');
  const rows = await ctx.db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, ctx.actor.user.id), isNull(apiTokens.revokedAt)));
  return rows.map(tokenDto);
}

export async function revokeToken(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'read');
  const res = await ctx.db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, ctx.actor.user.id), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });
  if (!res.length) throw notFound('Token');
}

export async function needsSetup(db: Db): Promise<boolean> {
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.isBot, false), eq(users.role, 'admin')));
  return Number(n) === 0;
}
