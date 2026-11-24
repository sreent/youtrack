import type { ApiToken, Scope } from '@a4a/shared';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { effectiveScopes, requireScope, type Actor, type Ctx } from '../context';
import type { Db } from '../db/client';
import { apiTokens, sessions, users } from '../db/schema';
import { randomToken, sha256, verifyPassword } from '../lib/crypto';
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors';
import { newId } from '../lib/ids';
import { projectAccess, requireProject } from './access';
import type { UserRow } from './schema-cache';

export const SESSION_COOKIE = 'a4a_session';
const TOKEN_PREFIX = 'a4a_';

export async function login(
  db: Db,
  loginName: string,
  password: string,
  ttlDays: number,
  userAgent?: string,
): Promise<{ token: string; user: UserRow; expiresAt: Date }> {
  const user = await passwordUser(db, loginName, password);
  if (!user) throw unauthorized('Wrong login or password').said('wrongLogin');
  return { ...(await startSession(db, user.id, ttlDays, userAgent, { with: 'password' })), user };
}

/** The person whose a4a password this is, if they may sign in; null otherwise. Starts nothing. */
export async function passwordUser(db: Db, loginName: string, password: string): Promise<UserRow | null> {
  const [user] = await db.select().from(users).where(sql`lower(${users.login}) = ${loginName.trim().toLowerCase()}`);
  const ok = user && !user.banned && !user.isBot && (await verifyPassword(password, user.passwordHash));
  return ok ? user : null;
}

/**
 * How a session was signed in (D62): the first factor (`password`, `ldap`, `oidc`, `saml`), then a
 * second step's (`+totp`, `+recovery`, `+passkey`); or `passkey`, both at once. With the passkey it took.
 */
export interface SignInHow {
  with: string;
  passkeyId?: string | null;
}

/** A new session, with a token never used before (sign-in never carries an old session over). */
export async function startSession(db: Db, userId: string, ttlDays: number, userAgent?: string, how: SignInHow = { with: 'password' }): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken('tls_', 32);
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);
  // How its person proved it's them (D68): a passkey, first or second, or else their password.
  const verifiedBy = how.with.includes('passkey') ? 'passkey' : 'password';
  await db.insert(sessions).values({ id: sha256(token), userId, expiresAt, userAgent: userAgent?.slice(0, 300), signedInWith: how.with, passkeyId: how.passkeyId ?? null, verifiedBy });
  // Not through the people cache: when someone last signed in is read fresh, where it's shown.
  await db.update(users).set({ lastSignInAt: new Date() }).where(eq(users.id, userId));
  return { token, expiresAt };
}

export async function logout(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sha256(token)));
}

/** Housekeeping: expired sessions are refused already; this only keeps the table small. */
export async function pruneSessions(db: Db): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
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

/**
 * Per instance on purpose: it only spares the database a write per request. With N
 * instances a token's last-used time is written at most N times a minute.
 */
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
  const projectIds = row.token.projectIds ?? null;
  const now = Date.now();
  if ((lastUsedWrites.get(row.token.id) ?? 0) < now - 60_000) {
    lastUsedWrites.set(row.token.id, now);
    void db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.token.id)).catch(() => {});
  }
  // A token limited to projects never administers: administration reaches every project.
  const scopes = effectiveScopes(row.user.role, row.token.scopes).filter((sc) => !(projectIds && sc === 'admin'));
  return {
    user: row.user,
    scopes,
    channel,
    tokenId: row.token.id,
    tokenName: row.token.name,
    authMethod: 'token',
    projectIds,
  };
}

/** A token as its owner sees it: its projects by key, leaving out any they can no longer see. */
export function tokenDto(t: typeof apiTokens.$inferSelect, keyOf: (projectId: string) => string | undefined): ApiToken {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    scopes: t.scopes as Scope[],
    projects: t.projectIds ? t.projectIds.map(keyOf).filter((k): k is string => Boolean(k)) : null,
    createdAt: t.createdAt.toISOString(),
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    expiresAt: t.expiresAt?.toISOString() ?? null,
  };
}

export async function keysFor(ctx: Ctx): Promise<(projectId: string) => string | undefined> {
  const view = await projectAccess(ctx);
  return (id) => (view.canRead(id) ? view.keyOf(id) : undefined);
}

/**
 * The project ids a new or changed token may be limited to. Each must be a project the caller can
 * see (one they can't is "not found", as one that doesn't exist). A token limited to projects can
 * only give a token those projects or fewer, so a limit is never lifted by making a new token.
 */
async function tokenProjects(ctx: Ctx, keys: string[] | null | undefined, scopes: Scope[]): Promise<string[] | null> {
  const inherited = ctx.actor.projectIds ?? null;
  if (keys === undefined || keys === null) {
    if (inherited) return [...inherited];
    return null;
  }
  if (scopes.includes('admin')) {
    throw badRequest('A token limited to projects can’t have the admin scope', 'Administration reaches every project: leave out the admin scope, or the projects.').said('auth.adminScopeWithProjects');
  }
  const ids: string[] = [];
  for (const key of keys) ids.push((await requireProject(ctx, key)).id);
  return [...new Set(ids)];
}

/** A token's scopes never exceed what creates it: a token can make only a token that may do as much as it, or less. */
export function tokenScopes(ctx: Ctx, scopes: Scope[]): Scope[] {
  const unique = [...new Set(scopes)];
  if (ctx.actor.authMethod === 'token') {
    const more = unique.filter((sc) => !ctx.actor.scopes.includes(sc));
    if (more.length) throw forbidden(`This token can’t make a token with the ${more.join(', ')} scope`, 'Create it while signed in, or from a token that has it.').said('auth.tokenCantGrantScope', { scopes: more });
  }
  return unique;
}

export async function issueTokenFor(
  db: Db,
  userId: string,
  input: { name: string; scopes: Scope[]; expiresInDays?: number | null; projectIds?: string[] | null },
): Promise<typeof apiTokens.$inferSelect & { token: string }> {
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
      projectIds: input.projectIds ?? null,
      expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
    })
    .returning();
  return { ...row!, token };
}

export async function createToken(
  ctx: Ctx,
  input: { name: string; scopes: Scope[]; expiresInDays?: number | null; projects?: string[] | null },
): Promise<ApiToken & { token: string }> {
  // Scopes are always capped by the person's role, and by the token that asks, if a token asks.
  requireScope(ctx, 'read');
  if (ctx.actor.authMethod === 'token') requireScope(ctx, 'write');
  // An agent's tokens are its administrators' to issue (D34): one leaked can't make itself another.
  if (ctx.actor.user.isBot) {
    throw forbidden('An agent can’t make its own tokens', 'An administrator issues its tokens, under Agents and tokens.').said('auth.agentCantMakeTokens');
  }
  const scopes = tokenScopes(ctx, input.scopes);
  const projectIds = await tokenProjects(ctx, input.projects, scopes);
  const { token, ...row } = await issueTokenFor(ctx.db, ctx.actor.user.id, { ...input, scopes, projectIds });
  return { ...tokenDto(row, await keysFor(ctx)), token };
}

export async function listTokens(ctx: Ctx): Promise<ApiToken[]> {
  requireScope(ctx, 'read');
  const rows = await ctx.db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, ctx.actor.user.id), isNull(apiTokens.revokedAt)));
  const keyOf = await keysFor(ctx);
  return rows.map((r) => tokenDto(r, keyOf));
}

/** Rename a token, or change which projects it reaches (null: every project you can see). */
export async function updateToken(ctx: Ctx, id: string, input: { name?: string; projects?: string[] | null }): Promise<ApiToken> {
  requireScope(ctx, 'read');
  if (ctx.actor.authMethod === 'token') requireScope(ctx, 'write');
  const [current] = await ctx.db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, ctx.actor.user.id), isNull(apiTokens.revokedAt)));
  if (!current) throw notFound('Token').said('notFound.tokenUnnamed');
  const projectIds = input.projects === undefined ? current.projectIds : await tokenProjects(ctx, input.projects, current.scopes as Scope[]);
  const [row] = await ctx.db
    .update(apiTokens)
    .set({ ...(input.name !== undefined ? { name: input.name } : {}), projectIds })
    .where(eq(apiTokens.id, id))
    .returning();
  return tokenDto(row!, await keysFor(ctx));
}

export async function revokeToken(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'read');
  const res = await ctx.db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, ctx.actor.user.id), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });
  if (!res.length) throw notFound('Token').said('notFound.tokenUnnamed');
}

export async function needsSetup(db: Db): Promise<boolean> {
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.isBot, false), eq(users.role, 'admin')));
  return Number(n) === 0;
}
