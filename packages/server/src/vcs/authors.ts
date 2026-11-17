/**
 * Who wrote a commit, or opened a pull request, in a4a (D33): the one person whose confirmed
 * email the commit names, or whose login at the provider (recorded by an administrator) the
 * provider vouches for. When the email and the login name two people, it's nobody.
 *
 * What each vouches for:
 * - A commit's email is whatever its committer typed; an email counts once its person confirmed
 *   it (a link a4a mailed, opened signed in), or an administrator set it.
 * - A commit's login (GitHub's, Gitea's, Bitbucket's) is the account the provider matched that
 *   typed email to, by the provider's own confirmed emails. It vouches that the email is that
 *   account's, so a login match is as strong as an email match, and reaches emails a4a doesn't
 *   know (a provider's no-reply address, say).
 * - A pull request's author is the account that opened it, signed in at the provider.
 */
import { VCS_PROVIDER_NAMES, type VcsProvider } from '@a4a/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { UserRow } from '../context';
import type { Db } from '../db/client';
import { providerLogins, userEmails } from '../db/schema';
import type { SchemaSnapshot } from '../services/schema-cache';
import type { Person } from './payloads';

/** Who wrote a commit, in a4a, or why there's nobody: in words for the issue, and in detail for the delivery's log. */
export type Author = { user: UserRow; by: 'email' | 'login' | 'both' } | { user: null; why: string; detail: string };

/** A login as it's matched: without regard to case; a Bitbucket Cloud UUID without its braces. */
export function loginKey(provider: VcsProvider, login: string): string {
  const t = login.trim().toLowerCase();
  return provider === 'bitbucket' ? t.replace(/^\{(.*)\}$/, '$1') : t;
}

export async function authorOf(db: Db, s: SchemaSnapshot, provider: VcsProvider, person: Person): Promise<Author> {
  const usable = (id: string): UserRow | null => {
    const u = s.users.get(id);
    return u && !u.isBot && !u.banned ? u : null;
  };
  const at = VCS_PROVIDER_NAMES[provider];

  const email = person.email?.trim().toLowerCase() || null;
  const byEmail = new Map<string, UserRow>();
  let unconfirmed: UserRow | null = null;
  if (email) {
    for (const u of s.users.values()) {
      if (u.isBot || u.banned || u.email?.trim().toLowerCase() !== email) continue;
      if (u.emailVerified) byEmail.set(u.id, u);
      else unconfirmed ??= u;
    }
    const others = await db
      .select({ userId: userEmails.userId, confirmedAt: userEmails.confirmedAt })
      .from(userEmails)
      .where(sql`lower(${userEmails.email}) = ${email}`);
    for (const o of others) {
      const u = usable(o.userId);
      if (!u) continue;
      if (o.confirmedAt) byEmail.set(u.id, u);
      else unconfirmed ??= u;
    }
  }

  const keys = [...new Set(person.match.map((m) => loginKey(provider, m)).filter(Boolean))];
  const byLogin = new Map<string, UserRow>();
  if (keys.length) {
    const rows = await db
      .select({ userId: providerLogins.userId })
      .from(providerLogins)
      .where(and(eq(providerLogins.provider, provider), inArray(providerLogins.matchKey, keys)));
    for (const r of rows) {
      const u = usable(r.userId);
      if (u) byLogin.set(u.id, u);
    }
  }

  const all = new Map([...byEmail, ...byLogin]);
  if (all.size === 1) {
    const [user] = all.values();
    return { user: user!, by: byEmail.size && byLogin.size ? 'both' : byEmail.size ? 'email' : 'login' };
  }
  // The words for the issue name nobody; the delivery's log, which only administrators read, may.
  if (byEmail.size > 1) return { user: null, why: 'more than one person in a4a has its author’s email', detail: `more than one person in a4a has the email ${person.email}` };
  if (byLogin.size > 1) {
    return { user: null, why: `more than one person in a4a has its author’s login at ${at}`, detail: `more than one person in a4a has the login ${person.login ?? keys.join(', ')} at ${at}` };
  }
  if (all.size > 1) {
    const [e] = byEmail.values();
    const [l] = byLogin.values();
    return {
      user: null,
      why: `its author’s email and their login at ${at} are two different people’s in a4a`,
      detail: `the email ${person.email} is ${e!.name}’s, and the login ${person.login ?? keys[0]} at ${at} is ${l!.name}’s`,
    };
  }
  if (unconfirmed) {
    return {
      user: null,
      why: `${unconfirmed.name}’s email isn’t confirmed yet`,
      detail: `${unconfirmed.name}’s email ${person.email} isn’t confirmed: they can confirm it on their profile, or an administrator can under Administration`,
    };
  }
  if (!email && !keys.length) return { user: null, why: 'the commit names no email for its author', detail: 'the commit names no email for its author' };
  const known = [email ? `the confirmed email ${person.email}` : null, keys.length ? `the login ${person.login ?? keys[0]} at ${at}` : null].filter(Boolean).join(' or ');
  return { user: null, why: 'a4a doesn’t know who wrote it', detail: `nobody in a4a has ${known}` };
}
