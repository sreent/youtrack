/**
 * The installations of a GitHub integration's app that a4a knows of (D66), kept to list them on the
 * integrations page with their accounts: all of them when the app is given or tested, and each as a
 * repository is read or reported to through it. What GitHub said last of one (suspended, gone) is
 * kept beside it, so the page says it too. Tokens are never here: they live in memory (github-app.ts).
 */
import type { VcsInstallation } from '@a4a/shared';
import { and, asc, eq, inArray, notInArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { vcsInstallations } from '../db/schema';
import type { InstallationFacts } from './github-app';

/** How many of the repositories read through one installation it keeps, to show. */
const KEEP_REPOSITORIES = 10;

type Row = typeof vcsInstallations.$inferSelect;

async function upsert(db: Db, integrationId: string, f: InstallationFacts, repositories?: string[]): Promise<void> {
  const now = new Date();
  const set = {
    account: f.account,
    accountType: f.accountType,
    repositorySelection: f.selection,
    suspendedAt: f.suspended ? now : null,
    goneAt: null,
    seenAt: now,
    ...(repositories ? { repositories } : {}),
  };
  await db
    .insert(vcsInstallations)
    .values({ integrationId, installationId: f.id, ...set, repositories: repositories ?? [] })
    .onConflictDoUpdate({ target: [vcsInstallations.integrationId, vcsInstallations.installationId], set });
}

/**
 * The app's installations as GitHub listed them: each kept, and, when the list is the whole of them,
 * any a4a knew that isn't in it marked gone.
 */
export async function keepInstallations(db: Db, integrationId: string, list: InstallationFacts[], opts: { whole?: boolean } = {}): Promise<void> {
  for (const f of list) await upsert(db, integrationId, f);
  if (!opts.whole) return;
  const ids = list.map((f) => f.id);
  await db
    .update(vcsInstallations)
    .set({ goneAt: new Date() })
    .where(and(eq(vcsInstallations.integrationId, integrationId), ...(ids.length ? [notInArray(vcsInstallations.installationId, ids)] : [])));
}

/** A repository read (or reported to) through an installation, as GitHub said just now: the latest first, a few. */
export async function noteRepository(db: Db, integrationId: string, f: InstallationFacts, repository: string): Promise<void> {
  const [row] = await db
    .select({ repositories: vcsInstallations.repositories })
    .from(vcsInstallations)
    .where(and(eq(vcsInstallations.integrationId, integrationId), eq(vcsInstallations.installationId, f.id)));
  const repositories = [repository, ...(row?.repositories ?? []).filter((r) => r.toLowerCase() !== repository.toLowerCase())].slice(0, KEEP_REPOSITORIES);
  await upsert(db, integrationId, f, repositories);
}

/** What GitHub said of an installation when a token was asked for: it's gone, or suspended. */
export async function markInstallation(db: Db, integrationId: string, installationId: string, what: 'gone' | 'suspended'): Promise<void> {
  await db
    .update(vcsInstallations)
    .set(what === 'gone' ? { goneAt: new Date() } : { suspendedAt: new Date() })
    .where(and(eq(vcsInstallations.integrationId, integrationId), eq(vcsInstallations.installationId, installationId)));
}

/** Forget an integration's installations: its app was removed, or another given. */
export async function forgetInstallations(db: Db, integrationId: string): Promise<void> {
  await db.delete(vcsInstallations).where(eq(vcsInstallations.integrationId, integrationId));
}

const dto = (r: Row): VcsInstallation => ({
  id: r.installationId,
  account: r.account,
  accountType: r.accountType === 'Organization' ? 'organization' : r.accountType === 'User' ? 'user' : null,
  allRepositories: r.repositorySelection === 'all',
  repositories: r.repositories,
  suspended: Boolean(r.suspendedAt),
  gone: Boolean(r.goneAt),
});

/** Each integration's installations, as the page lists them: by account, those that went last. */
export async function installationsOf(db: Db, integrationIds: string[]): Promise<Map<string, VcsInstallation[]>> {
  const out = new Map<string, VcsInstallation[]>();
  if (!integrationIds.length) return out;
  const rows = await db.select().from(vcsInstallations).where(inArray(vcsInstallations.integrationId, integrationIds)).orderBy(asc(vcsInstallations.account), asc(vcsInstallations.installationId));
  for (const r of rows) out.set(r.integrationId, [...(out.get(r.integrationId) ?? []), dto(r)]);
  for (const [id, list] of out) out.set(id, [...list.filter((i) => !i.gone), ...list.filter((i) => i.gone)]);
  return out;
}
