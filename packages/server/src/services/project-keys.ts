/**
 * Renaming a project's key (D52). The project keeps the key it had, as an alias, for good:
 *
 * - its issues keep their numbers, so OLD-12 is NEW-12, and every OLD-12 written anywhere (links,
 *   text, commit messages and branches, chat, emails, the ids moved issues kept) still finds it;
 * - `project: OLD` in a query still finds the project, so saved searches, subscriptions, rules,
 *   boards and dashboards read as they did;
 * - no other project can take OLD. Renaming the project back to a key it had takes that key off
 *   its list, since it is its key again.
 *
 * One transaction, with the project's row locked: the key changes and the old one becomes an alias
 * together, so nothing reads a project with no key, or a key with no project. Issue numbers are
 * taken on that same row, so an issue made meanwhile waits for the rename and takes its number
 * under the key the project has then. Two renames of one project queue on the row too.
 *
 * What a4a wrote down before keeps its words: activities, notes, chat posts, webhooks already sent,
 * baselines and imports name OLD-12, which finds NEW-12. Only `mentions`, an index of what names
 * what rather than a record of what happened, is rewritten, as a move rewrites it (D41).
 */
import type { Project, RenameProjectKeyInput } from '@a4a/shared';
import { eq, sql } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { projectKeyAliases, projects } from '../db/schema';
import { publishActivities, recordActivity, type ActivityRow } from '../events/activity';
import { badRequest, conflict, notFound } from '../lib/errors';
import { accessChanged, requireProject } from './access';
import { getProject } from './projects';

/** A key as a new project's is checked (CreateProjectBody), upper-cased: a letter, then 1 to 9 letters or digits. */
const KEY = /^[A-Z][A-Z0-9]{1,9}$/;

/** The project that has `key` now, and the one that had it before a rename: ids, or null. Inside a transaction, pass it. */
export async function keyHolders(db: Db, key: string): Promise<{ now: string | null; before: string | null }> {
  const upper = key.trim().toUpperCase();
  const [now] = await db.select({ id: projects.id }).from(projects).where(sql`upper(${projects.key}) = ${upper}`);
  const [before] = await db.select({ id: projectKeyAliases.projectId }).from(projectKeyAliases).where(eq(projectKeyAliases.key, upper));
  return { now: now?.id ?? null, before: before?.id ?? null };
}

/** Postgres's unique violation, however the driver wraps it. */
export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return (err?.code ?? err?.cause?.code) === '23505';
}

/** Taken, in the same words whoever has it: a project the caller can't see is never named. */
const taken = (key: string) =>
  conflict(`The key ${key} is taken`, 'Another project has it, or had it before it was renamed, and a key stays with its project for good. Choose another.').said('projectKeys.taken', { key });

export async function renameProjectKey(ctx: Ctx, key: string, input: RenameProjectKeyInput): Promise<Project> {
  requireScope(ctx, 'write');
  // Its managers (and administrators) rename it: the key is the project's, and every id it gave out keeps working (D52).
  const p = await requireProject(ctx, key, 'manage');
  const to = input.key.trim().toUpperCase();
  if (!KEY.test(to)) {
    throw badRequest(`${input.key.trim()} can't be a project key`, 'Use 2 to 10 letters and digits, starting with a letter, such as CORE.').said('projectKeys.badKey', { key: input.key.trim() });
  }
  const expected = input.expectedKey?.trim().toUpperCase() || null;
  let done: { from: string; activity: ActivityRow } | null = null;
  try {
    done = await ctx.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      // Its row, locked: a second rename, or an issue taking a number, waits for this one.
      const [row] = await tx.select().from(projects).where(eq(projects.id, p.id)).for('update');
      if (!row) throw notFound(`Project ${key.trim().toUpperCase()}`).said('notFound.project', { id: key.trim().toUpperCase() });
      const from = row.key.toUpperCase();
      // Its key already (a retry, or the same rename twice): nothing changes.
      if (to === from) return null;
      if (expected && expected !== from) {
        throw conflict(`${expected} was renamed ${from} meanwhile`, `Read the project again, and rename it from ${from} if you still want ${to}.`, { currentKey: from }).said('projectKeys.renamedMeanwhile', { expected, key: from, to });
      }
      const holders = await keyHolders(tx, to);
      if ((holders.now && holders.now !== p.id) || (holders.before && holders.before !== p.id)) throw taken(to);
      // Back to a key it had: that key is its own again, not an alias.
      if (holders.before === p.id) await tx.delete(projectKeyAliases).where(eq(projectKeyAliases.key, to));
      await tx.insert(projectKeyAliases).values({ key: from, projectId: p.id, renamedById: ctx.actor.user.id });
      await tx.update(projects).set({ key: to, updatedAt: new Date() }).where(eq(projects.id, p.id));
      await rewriteMentions(tx, from, to);
      const activity = await recordActivity(tx, ctx, { type: 'project.key.changed', projectId: p.id, issueId: null, payload: { data: { from, to, name: row.name } } });
      // Every instance reads the new key once this commits (and this one at once).
      await ctx.app.schema.invalidateOnCommit(tx);
      return { from, activity };
    });
  } catch (e) {
    // Another project took the key between our look and our write: its row's unique key says so.
    if (isUniqueViolation(e)) throw taken(to);
    throw e;
  }
  if (done) {
    ctx.app.schema.invalidate();
    accessChanged(ctx.app);
    await publishActivities(ctx.app, [done.activity]);
  }
  return getProject(ctx, to);
}

/**
 * What names OLD-12 (or OLD-A-3) names NEW-12 now. A text that named both keeps one row for it.
 * Mentions are an index, read by the id an issue or article has now, so they follow the key.
 */
async function rewriteMentions(tx: Db, from: string, to: string): Promise<void> {
  const prefix = `${from}-`;
  const renamed = sql`${`${to}-`} || substr(m.target, ${prefix.length + 1})`;
  await tx.execute(
    sql`DELETE FROM mentions m WHERE left(upper(m.target), ${prefix.length}) = ${prefix}
        AND EXISTS (SELECT 1 FROM mentions x WHERE x.source_type = m.source_type AND x.source_id = m.source_id AND x.target = ${renamed})`,
  );
  await tx.execute(sql`UPDATE mentions m SET target = ${renamed} WHERE left(upper(m.target), ${prefix.length}) = ${prefix}`);
}
