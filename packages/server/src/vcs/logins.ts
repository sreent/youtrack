/**
 * People's logins at version control providers, as administrators record them (D33): a commit
 * or pull request the provider says that account wrote is the person's. authors.ts says what each
 * provider vouches for. A login is one person's at a time.
 */
import { VCS_PROVIDER_NAMES, type ProviderLogin, type VcsProvider } from '@a4a/shared';
import { and, asc, eq } from 'drizzle-orm';
import { requireScope, type Ctx, type UserRow } from '../context';
import { providerLogins } from '../db/schema';
import { AppError, badRequest, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { findUser, type SchemaSnapshot } from '../services/schema-cache';
import { userRefDto } from '../services/values';
import { loginKey } from './authors';

type LoginRow = typeof providerLogins.$inferSelect;

const UUID = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;
/** Atlassian account ids: "557058:c0d3…" (a number, a colon, a UUID), or 24 hex digits. */
const ACCOUNT_ID = /^(\d+:[0-9a-f-]{20,}|[0-9a-f]{24})$/i;

/** What a login looks like at each provider; what doesn't is likely a name typed in its place. */
const SHAPES: Record<VcsProvider, { ok: (login: string) => boolean; hint: string }> = {
  github: { ok: (l) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(l), hint: 'Their GitHub username, as in github.com/anna-s' },
  gitlab: { ok: (l) => /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,254}$/.test(l), hint: 'Their GitLab username, as in gitlab.com/anna.s' },
  gitea: { ok: (l) => /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,39}$/.test(l), hint: 'Their username there, as in their profile’s address' },
  bitbucket: {
    ok: (l) => UUID.test(l) || ACCOUNT_ID.test(l),
    hint: 'Bitbucket Cloud’s nicknames aren’t unique, so give their account id (557058:…) or their UUID ({…}), from their profile',
  },
  'bitbucket-dc': { ok: (l) => /^[A-Za-z0-9._@+-]{1,255}$/.test(l), hint: 'Their Bitbucket Data Center username' },
};

function dto(s: SchemaSnapshot, row: LoginRow): ProviderLogin {
  const by = row.addedById ? s.users.get(row.addedById) : undefined;
  return {
    id: row.id,
    provider: row.provider as VcsProvider,
    login: row.login,
    addedBy: by ? userRefDto(by) : null,
    connected: Boolean(row.providerUserId),
    createdAt: row.createdAt.toISOString(),
  };
}

async function person(ctx: Ctx, idOrLogin: string): Promise<{ s: SchemaSnapshot; u: UserRow }> {
  const s = await ctx.app.schema.get();
  const u = s.users.get(idOrLogin) ?? findUser(s, idOrLogin, ctx.actor.user.id);
  if (!u) throw notFound(`User ${idOrLogin}`);
  return { s, u };
}

/** A person's logins: theirs to read, and administrators'. */
export async function listProviderLogins(ctx: Ctx, idOrLogin: string): Promise<ProviderLogin[]> {
  requireScope(ctx, 'read');
  const { s, u } = await person(ctx, idOrLogin);
  if (u.id !== ctx.actor.user.id) requireScope(ctx, 'admin');
  const rows = await ctx.db.select().from(providerLogins).where(eq(providerLogins.userId, u.id)).orderBy(asc(providerLogins.provider), asc(providerLogins.createdAt));
  return rows.map((r) => dto(s, r));
}

/** Record a person's login at a provider (administrators). */
export async function addProviderLogin(ctx: Ctx, idOrLogin: string, input: { provider: VcsProvider; login: string }): Promise<ProviderLogin> {
  requireScope(ctx, 'admin');
  const { s, u } = await person(ctx, idOrLogin);
  if (u.isBot) throw badRequest('A bot writes no commits', 'Record the login of the person who does.');
  const login = input.login.trim().replace(/^@/, '');
  const shape = SHAPES[input.provider];
  if (!shape.ok(login)) throw badRequest(`That doesn’t look like a login at ${VCS_PROVIDER_NAMES[input.provider]}`, shape.hint);
  const matchKey = loginKey(input.provider, login);
  const [taken] = await ctx.db
    .select()
    .from(providerLogins)
    .where(and(eq(providerLogins.provider, input.provider), eq(providerLogins.matchKey, matchKey)));
  if (taken) {
    if (taken.userId === u.id) return dto(s, taken);
    const other = s.users.get(taken.userId);
    throw new AppError(409, 'conflict', `That login at ${VCS_PROVIDER_NAMES[input.provider]} is ${other?.name ?? 'someone else'}’s already`, `Remove it from ${other?.name ?? 'them'} first: a login is one person’s.`);
  }
  const [row] = await ctx.db
    .insert(providerLogins)
    .values({ id: newId(), userId: u.id, provider: input.provider, login, matchKey, addedById: ctx.actor.user.id })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new AppError(409, 'conflict', `That login at ${VCS_PROVIDER_NAMES[input.provider]} was just recorded for someone`, 'Reload, and look again.');
  return dto(s, row);
}

/**
 * Forget a person's login at a provider: administrators, or the person themselves for an account
 * they connected (D46), which is theirs to disconnect.
 */
export async function removeProviderLogin(ctx: Ctx, idOrLogin: string, id: string): Promise<void> {
  requireScope(ctx, 'write');
  const { u } = await person(ctx, idOrLogin);
  const [row] = await ctx.db.select().from(providerLogins).where(and(eq(providerLogins.id, id), eq(providerLogins.userId, u.id)));
  const own = u.id === ctx.actor.user.id && Boolean(row?.providerUserId);
  if (!own) requireScope(ctx, 'admin');
  if (!row) throw notFound('Login');
  await ctx.db.delete(providerLogins).where(eq(providerLogins.id, row.id));
}
