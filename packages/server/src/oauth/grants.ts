/**
 * The apps a person allowed, as Agents and tokens shows them beside their API tokens, and the
 * housekeeping that keeps OAuth's tables small (D28).
 */
import type { OAuthGrant, OAuthScope } from '@a4a/shared';
import { and, asc, eq, isNull, lt, notExists, or, sql } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { oauthClients, oauthCodes, oauthGrants, oauthTokens } from '../db/schema';
import { notFound } from '../lib/errors';
import { projectAccess } from '../services/access';
import { REMEMBER_MS } from './common';

const hostOf = (uri: string) => {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
};

/** The person's apps, oldest first, each with where it sends them back and what it may do. */
export async function listGrants(ctx: Ctx): Promise<OAuthGrant[]> {
  requireScope(ctx, 'read');
  const rows = await ctx.db
    .select({ grant: oauthGrants, client: oauthClients })
    .from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
    .where(and(eq(oauthGrants.userId, ctx.actor.user.id), isNull(oauthGrants.revokedAt)))
    .orderBy(asc(oauthGrants.createdAt));
  const view = await projectAccess(ctx);
  return rows.map(({ grant, client }) => ({
    id: grant.id,
    client: { id: client.id, name: client.name, redirectHosts: [...new Set(client.redirectUris.map(hostOf))] },
    scopes: grant.scopes as OAuthScope[],
    projects: grant.projectIds ? grant.projectIds.filter((id) => view.canRead(id)).map((id) => view.keyOf(id)!) : null,
    createdAt: grant.createdAt.toISOString(),
    updatedAt: grant.updatedAt.toISOString(),
    lastUsedAt: grant.lastUsedAt?.toISOString() ?? null,
  }));
}

/** Revoke an app: its grant and every token it holds, at once. The next time, it asks again. */
export async function revokeGrant(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'read');
  const now = new Date();
  const done = await ctx.db
    .update(oauthGrants)
    .set({ revokedAt: now })
    .where(and(eq(oauthGrants.id, id), eq(oauthGrants.userId, ctx.actor.user.id), isNull(oauthGrants.revokedAt)))
    .returning({ id: oauthGrants.id });
  if (!done.length) throw notFound('App');
  await ctx.db.update(oauthTokens).set({ revokedAt: now }).where(and(eq(oauthTokens.grantId, id), isNull(oauthTokens.revokedAt)));
}

/**
 * Housekeeping, by the lease holder. Codes go ten minutes after they expire (a used one is kept
 * until then, so coming back revokes its tokens); tokens once expired (a rotated refresh token
 * stays until then, so its reuse is caught); revoked grants after 30 days; grants unused for 90,
 * so the app asks again; and apps nobody allowed within a day, or used for 90 days.
 */
export async function pruneOAuth(db: Db): Promise<void> {
  const ago = (ms: number) => new Date(Date.now() - ms);
  const DAY = 86_400_000;
  await db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, ago(10 * 60_000)));
  await db.delete(oauthTokens).where(lt(oauthTokens.expiresAt, new Date()));
  await db
    .delete(oauthGrants)
    .where(
      or(
        lt(oauthGrants.revokedAt, ago(30 * DAY)),
        and(isNull(oauthGrants.revokedAt), sql`coalesce(${oauthGrants.lastUsedAt}, ${oauthGrants.updatedAt}) < ${ago(REMEMBER_MS).toISOString()}::timestamptz`),
      ),
    );
  await db
    .delete(oauthClients)
    .where(
      and(
        notExists(db.select({ one: sql`1` }).from(oauthGrants).where(eq(oauthGrants.clientId, oauthClients.id))),
        or(and(isNull(oauthClients.lastUsedAt), lt(oauthClients.createdAt, ago(DAY))), lt(oauthClients.lastUsedAt, ago(REMEMBER_MS))),
      ),
    );
}
