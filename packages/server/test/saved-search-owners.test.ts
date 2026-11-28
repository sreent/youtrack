/**
 * A shared saved search outlives its owner (D72): deleting someone takes their private searches with
 * them and leaves their shared ones without an owner, for an administrator to adopt. An ownerless
 * search is a shared one to everyone, by the rule shared ones follow, and administrators see every one.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserRow } from '../src/context';
import { savedSearches } from '../src/db/schema';
import { newId } from '../src/lib/ids';
import { createSavedSearch, listSavedSearches, updateSavedSearch } from '../src/services/saved-searches';
import { listSubscriptions, subscribe } from '../src/services/subscriptions';
import { deleteUser, insertUser } from '../src/services/users';
import { createWorld, type TestWorld } from './helpers';

const ON_POSTGRES = Boolean(process.env.TEST_DATABASE_URL);
let w: TestWorld;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w?.close();
});

async function someone(login: string): Promise<UserRow> {
  const u = await insertUser(w.app.db, { login, name: `Someone ${login}`, role: 'member' });
  w.app.schema.invalidate();
  return u;
}

const searchRows = (ids: string[]) => w.app.db.select({ id: savedSearches.id, ownerId: savedSearches.ownerId, shared: savedSearches.shared }).from(savedSearches).where(inArray(savedSearches.id, ids));

describe('deleting someone', () => {
  it('takes their private saved searches, and leaves their shared ones ownerless, still followed', async () => {
    const leo = await someone('leo');
    const plan = await createSavedSearch(w.as(leo), { name: 'Team plan', query: 'project: BACK #Unresolved', shared: true });
    const own = await createSavedSearch(w.as(leo), { name: 'Leo only', query: 'for: me', shared: false });
    await subscribe(w.as(w.ben), { savedSearch: plan.id, events: 'new' });

    await deleteUser(w.adminCtx, leo.id);

    expect(await searchRows([plan.id, own.id])).toEqual([{ id: plan.id, ownerId: null, shared: true }]);
    expect((await listSavedSearches(w.as(w.ben))).find((s) => s.id === plan.id)).toMatchObject({ name: 'Team plan', shared: true, owner: null, view: { kind: 'list' }, version: 0 });
    expect((await listSubscriptions(w.as(w.ben))).map((s) => s.search?.id)).toContain(plan.id);
    // Nobody's own now: changing it takes an administrator, as someone else's search does.
    await expect(updateSavedSearch(w.as(w.ben), plan.id, { name: 'Mine now' })).rejects.toThrow('Only its owner can change a saved search');
    expect(await updateSavedSearch(w.adminCtx, plan.id, { name: 'Team plan, adopted' })).toMatchObject({ name: 'Team plan, adopted', owner: null });
  });

  it.runIf(ON_POSTGRES)('takes a search unshared while they were being deleted, rather than leave it private with no owner', async () => {
    // The race: their shared search is unshared in a transaction that hasn't committed when the delete
    // begins. The delete waits for it under the lock on their searches, then takes it as private.
    const mo = await someone('mo');
    const plan = await createSavedSearch(w.as(mo), { name: 'Mo plan', query: '#Unresolved', shared: true });
    let commit!: () => void;
    let unshared!: () => void;
    const held = new Promise<void>((r) => (commit = r));
    const changed = new Promise<void>((r) => (unshared = r));
    const unsharing = w.app.db.transaction(async (tx) => {
      await tx.update(savedSearches).set({ shared: false }).where(eq(savedSearches.id, plan.id));
      unshared();
      await held;
    });
    await changed;
    const deleting = deleteUser(w.adminCtx, mo.id);
    // Until the delete waits on the unshare's row.
    for (let i = 0; i < 100; i++) {
      const waiting = (await w.app.db.execute(sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`)) as unknown as { rows: { n: number }[] };
      if ((waiting.rows[0]?.n ?? 0) > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    commit();
    await unsharing;
    await deleting;
    expect(await searchRows([plan.id])).toEqual([]);
  });
});

describe('an ownerless saved search', () => {
  it('is listed to administrators whether or not it reads or is shared, and to others only as a shared one that reads', async () => {
    const insert = async (name: string, query: string, shared: boolean) => {
      const id = newId();
      await w.app.db.insert(savedSearches).values({ id, ownerId: null, name, query, shared });
      return id;
    };
    const reads = await insert('Left behind', 'project: BACK', true);
    const broken = await insert('Left broken', 'project: NOPE', true);
    const hidden = await insert('Left private', 'project: BACK', false);
    const listed = async (u: UserRow) => (await listSavedSearches(w.as(u))).filter((s) => [reads, broken, hidden].includes(s.id)).map((s) => s.name).sort();
    expect(await listed(w.admin)).toEqual(['Left behind', 'Left broken', 'Left private']);
    expect(await listed(w.anna)).toEqual(['Left behind']);
    expect(await listed(w.viewer)).toEqual(['Left behind']);
    // Unshared by an administrator, it keeps no one subscribed: there's no owner to keep.
    await subscribe(w.as(w.anna), { savedSearch: reads, events: 'all' });
    await updateSavedSearch(w.adminCtx, reads, { shared: false });
    expect((await listSubscriptions(w.as(w.anna))).map((s) => s.search?.id)).not.toContain(reads);
    expect(await listed(w.anna)).toEqual([]);
  });
});
