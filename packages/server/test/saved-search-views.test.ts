/**
 * A saved search remembers how it's shown (D72): its owner's view and grouping are kept, with its version,
 * so a change made since is refused rather than written over; anyone else's choice lives in their own
 * address. A shared one lists with its view; one whose owner was deleted waits for an administrator to
 * adopt it; deleting one takes its baselines, and says how many first.
 */
import { VIEW_LIMITS } from '@a4a/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserRow } from '../src/context';
import { baselines, savedSearches } from '../src/db/schema';
import { createHttpApp } from '../src/http/app';
import { AppError } from '../src/lib/errors';
import { newId } from '../src/lib/ids';
import { issueTokenFor } from '../src/services/auth';
import { attachField, createField } from '../src/services/fields';
import { adoptSavedSearch, createSavedSearch, deleteSavedSearch, listSavedSearches, updateSavedSearch } from '../src/services/saved-searches';
import { insertUser } from '../src/services/users';
import { createWorld, type TestWorld } from './helpers';

const ON_POSTGRES = Boolean(process.env.TEST_DATABASE_URL);
let w: TestWorld;
let http: ReturnType<typeof createHttpApp>;
const tokens = new Map<string, string>();

beforeAll(async () => {
  w = await createWorld();
  http = createHttpApp(w.app);
  for (const u of [w.admin, w.anna, w.ben]) tokens.set(u.id, (await issueTokenFor(w.app.db, u.id, { name: 'test', scopes: u === w.admin ? ['read', 'write', 'admin'] : ['read', 'write'] })).token);
  const notes = await createField(w.adminCtx, { name: 'Release notes', type: 'text', multi: false, description: '', values: [] });
  await attachField(w.adminCtx, 'BACK', notes.id, {});
});
afterAll(async () => {
  await w?.close();
});

async function call(who: UserRow, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${tokens.get(who.id)}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await http.request(`/api/v1${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function failure(call: () => Promise<unknown>): Promise<AppError> {
  try {
    await call();
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error('expected it to fail');
}

async function ownerless(name: string, query = 'project: BACK'): Promise<string> {
  const id = newId();
  await w.app.db.insert(savedSearches).values({ id, ownerId: null, name, query, shared: true });
  return id;
}

describe("a saved search's view", () => {
  it('is kept when its owner changes it, with its version, and opens in it', async () => {
    const created = await call(w.anna, 'POST', '/saved-searches', { name: 'Anna plan', query: 'project: BACK', view: { kind: 'timeline', group: 'Priority' } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ view: { kind: 'timeline', group: 'Priority' }, version: 0 });
    const id = created.body.id as string;
    const changed = await call(w.anna, 'PATCH', `/saved-searches/${id}`, { view: { kind: 'list', group: 'State', timeline: { zoom: 'month' } }, expectedVersion: 0 });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ view: { kind: 'list', group: 'State', timeline: { zoom: 'month', order: 'plan', columns: [], baseline: null } }, version: 1 });
    // A field's name is kept as the field has it, however it was typed.
    expect((await call(w.anna, 'PATCH', `/saved-searches/${id}`, { view: { kind: 'list', group: 'state' }, expectedVersion: 1 })).body.view.group).toBe('State');
    // Every change counts, a rename too; without expectedVersion it's written whatever came between.
    expect((await call(w.anna, 'PATCH', `/saved-searches/${id}`, { name: 'Anna’s plan' })).body).toMatchObject({ name: 'Anna’s plan', version: 3, view: { group: 'State' } });
    expect((await listSavedSearches(w.as(w.anna))).find((s) => s.id === id)).toMatchObject({ version: 3, view: { kind: 'list', group: 'State' } });
  });

  it('refuses a change sent with a stale version, saying the version now', async () => {
    const s = await createSavedSearch(w.as(w.anna), { name: 'Stale', query: 'project: BACK', shared: false });
    await updateSavedSearch(w.as(w.anna), s.id, { view: { kind: 'list', group: 'Type' }, expectedVersion: 0 });
    const stale = await call(w.anna, 'PATCH', `/saved-searches/${s.id}`, { view: { kind: 'list', group: 'Priority' }, expectedVersion: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ details: { currentVersion: 1 }, key: 'savedSearches.changedSince', values: { name: 'Stale', version: 1, expectedVersion: '0' } });
    // Read again, the change goes in on the version now.
    expect((await call(w.anna, 'PATCH', `/saved-searches/${s.id}`, { view: { kind: 'list', group: 'Priority' }, expectedVersion: 1 })).body).toMatchObject({ version: 2, view: { group: 'Priority' } });
  });

  it('keeps one of two changes sent at once with the same version, and refuses the other', async () => {
    // Both read version 0 before either writes. The version is checked by the write itself: checked
    // after reading the row instead, both pass the check and the second overwrites the first.
    const s = await createSavedSearch(w.as(w.anna), { name: 'Raced', query: 'project: BACK', shared: false });
    const results = await Promise.allSettled(
      (['Type', 'Priority'] as const).map((group) => updateSavedSearch(w.as(w.anna), s.id, { view: { kind: 'list', group }, expectedVersion: 0 })),
    );
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((refused.reason as AppError).status).toBe(409);
    const kept = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ view: { group: string | null } }>).value;
    const [row] = await w.app.db.select().from(savedSearches).where(eq(savedSearches.id, s.id));
    expect(row).toMatchObject({ version: 1, view: { group: kept.view.group } });
  });

  it("can't be changed by anyone else, and another's private search is missing to them", async () => {
    const shared = await createSavedSearch(w.as(w.anna), { name: 'Anna shared', query: 'project: BACK', shared: true });
    const mine = await createSavedSearch(w.as(w.anna), { name: 'Anna only', query: 'project: BACK', shared: false });
    const e = await failure(() => updateSavedSearch(w.as(w.ben), shared.id, { view: { kind: 'list', group: 'Type' }, expectedVersion: 0 }));
    expect(e.status).toBe(403);
    expect(e.words?.key).toBe('savedSearches.onlyOwner');
    const http403 = await call(w.ben, 'PATCH', `/saved-searches/${shared.id}`, { view: { kind: 'timeline', group: null } });
    expect(http403.status).toBe(403);
    const missing = await call(w.ben, 'PATCH', `/saved-searches/${mine.id}`, { view: { kind: 'timeline', group: null } });
    const none = await call(w.ben, 'PATCH', `/saved-searches/nothing-here`, { view: { kind: 'timeline', group: null } });
    expect([missing.status, missing.body.error.message]).toEqual([404, none.body.error.message]);
    expect((await listSavedSearches(w.as(w.anna))).find((s) => s.id === shared.id)?.version).toBe(0);
  });

  it('is listed with a shared search, to everyone it reads for', async () => {
    const plan = await createSavedSearch(w.as(w.anna), { name: 'Team timeline', query: 'project: BACK #Unresolved', shared: true, view: { kind: 'timeline', group: 'Assignee' } });
    expect((await listSavedSearches(w.as(w.ben))).find((s) => s.id === plan.id)).toMatchObject({ owner: { login: 'anna' }, view: { kind: 'timeline', group: 'Assignee' }, version: 0 });
    expect((await call(w.ben, 'GET', '/saved-searches')).body.find((s: { id: string }) => s.id === plan.id).view).toEqual({ kind: 'timeline', group: 'Assignee' });
  });

  it('is refused over its limits, or grouped by what is no field', async () => {
    const s = await createSavedSearch(w.as(w.anna), { name: 'Capped', query: 'project: BACK', shared: false });
    const tooMany = Array.from({ length: VIEW_LIMITS.timelineColumns + 1 }, (_, i) => `Column ${i}`);
    const over = [
      { kind: 'list', group: 'x'.repeat(VIEW_LIMITS.column + 1) },
      { kind: 'timeline', group: null, timeline: { columns: tooMany } },
      { kind: 'table', group: null, table: { columns: [{ field: 'Summary', width: VIEW_LIMITS.maxWidth + 1 }] } },
      { kind: 'timeline', group: null, timeline: { baseline: 'b'.repeat(VIEW_LIMITS.id + 1) } },
      { kind: 'gantt', group: null },
    ];
    for (const view of over) {
      const res = await call(w.anna, 'PATCH', `/saved-searches/${s.id}`, { view, expectedVersion: 0 });
      expect(res.status, JSON.stringify(view)).toBe(400);
    }
    // Past the route, the service holds the same limits, for every other channel.
    expect((await failure(() => updateSavedSearch(w.as(w.anna), s.id, { view: { kind: 'timeline', group: null, timeline: { zoom: 'week', order: 'plan', columns: tooMany, baseline: null } } }))).words?.key).toBe('savedSearches.viewDoesntRead');
    const unknown = await call(w.anna, 'PATCH', `/saved-searches/${s.id}`, { view: { kind: 'list', group: 'Nonsuch' } });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatchObject({ key: 'issues.cannotGroupBy', values: { field: 'Nonsuch' } });
    expect((await call(w.anna, 'PATCH', `/saved-searches/${s.id}`, { view: { kind: 'list', group: 'Release notes' } })).status).toBe(400);
    expect((await listSavedSearches(w.as(w.anna))).find((x) => x.id === s.id)?.version).toBe(0);
  });

  it('reads as a list when what is kept no longer reads', async () => {
    const s = await createSavedSearch(w.as(w.anna), { name: 'From later', query: 'project: BACK', shared: false });
    await w.app.db.update(savedSearches).set({ view: { kind: 'mindmap', group: null } }).where(eq(savedSearches.id, s.id));
    expect((await listSavedSearches(w.as(w.anna))).find((x) => x.id === s.id)?.view).toEqual({ kind: 'list', group: null });
  });
});

describe('a saved search whose owner was deleted', () => {
  it('says to anyone else that an administrator can adopt it', async () => {
    const id = await ownerless('Left behind');
    const e = await failure(() => updateSavedSearch(w.as(w.ben), id, { view: { kind: 'timeline', group: null } }));
    expect([e.status, e.words?.key]).toEqual([403, 'savedSearches.ownerless']);
    expect(e.message).toBe('Nobody owns this saved search now: its owner was deleted');
    expect(e.hint).toBe('An administrator can adopt it, and then change it.');
    const adopt = await call(w.ben, 'POST', `/saved-searches/${id}/adopt`);
    expect([adopt.status, adopt.body.error.key]).toEqual([403, 'savedSearches.ownerless']);
  });

  it('becomes the administrator’s own when they adopt it, to change as its owner', async () => {
    const id = await ownerless('Team plan', 'project: BACK #Unresolved');
    const adopted = await call(w.admin, 'POST', `/saved-searches/${id}/adopt`);
    expect(adopted.status).toBe(200);
    expect(adopted.body).toMatchObject({ id, owner: { login: 'admin' }, shared: true, version: 1 });
    expect((await call(w.admin, 'PATCH', `/saved-searches/${id}`, { view: { kind: 'timeline', group: null }, expectedVersion: 1 })).body).toMatchObject({ version: 2, view: { kind: 'timeline' } });
    // Theirs now: someone else still can't change it, and it can't be adopted again.
    expect((await failure(() => updateSavedSearch(w.as(w.ben), id, { name: 'Mine' }))).words?.key).toBe('savedSearches.onlyOwner');
    const again = await call(w.admin, 'POST', `/saved-searches/${id}/adopt`);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ key: 'savedSearches.hasOwner', values: { name: 'Team plan', owner: 'Ada Admin' } });
  });

  it('is adopted by one of two administrators adopting it at once', async () => {
    const id = await ownerless('Raced plan');
    const other = await insertUser(w.app.db, { login: 'ida', name: 'Ida Admin', role: 'admin' });
    w.app.schema.invalidate();
    const results = await Promise.allSettled([adoptSavedSearch(w.adminCtx, id), adoptSavedSearch(w.as(other), id)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason as AppError).words?.key).toBe('savedSearches.hasOwner');
    const [row] = await w.app.db.select().from(savedSearches).where(eq(savedSearches.id, id));
    expect([w.admin.id, other.id]).toContain(row!.ownerId);
    expect(row!.version).toBe(1);
  });

  it('is refused to adopt once someone owns it, and to anyone who is not an administrator', async () => {
    const s = await createSavedSearch(w.as(w.anna), { name: 'Owned', query: 'project: BACK', shared: true });
    expect((await failure(() => adoptSavedSearch(w.adminCtx, s.id))).status).toBe(409);
    expect((await failure(() => adoptSavedSearch(w.as(w.ben), s.id))).words?.key).toBe('savedSearches.adoptIsAdmins');
  });
});

describe('deleting a saved search with baselines', () => {
  it('is refused without confirm, saying how many go with it; with it, they go too', async () => {
    const s = await createSavedSearch(w.as(w.anna), { name: 'Baselined', query: 'project: BACK', shared: false, view: { kind: 'timeline', group: null } });
    for (const name of ['Plan of record', 'Re-plan']) await w.app.db.insert(baselines).values({ id: newId(), savedSearchId: s.id, name, createdById: w.anna.id });
    const refused = await call(w.anna, 'DELETE', `/saved-searches/${s.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ key: 'savedSearches.hasBaselines', values: { name: 'Baselined', n: 2 }, details: { baselines: 2 } });
    expect(refused.body.error.message).toBe('"Baselined" has 2 baselines, which would be deleted with it');
    expect((await call(w.anna, 'DELETE', `/saved-searches/${s.id}?confirm=false`)).status).toBe(409);
    // Someone else can't, confirm or not.
    expect((await call(w.ben, 'DELETE', `/saved-searches/${s.id}?confirm=true`)).status).toBe(404);
    expect((await call(w.anna, 'DELETE', `/saved-searches/${s.id}?confirm=true`)).status).toBe(204);
    expect(await w.app.db.select().from(baselines).where(eq(baselines.savedSearchId, s.id))).toEqual([]);
  });

  it('asks nothing of one without baselines', async () => {
    const s = await createSavedSearch(w.as(w.anna), { name: 'Plain', query: 'project: BACK', shared: false });
    await deleteSavedSearch(w.as(w.anna), s.id);
    expect((await listSavedSearches(w.as(w.anna))).find((x) => x.id === s.id)).toBeUndefined();
    const one = await createSavedSearch(w.as(w.anna), { name: 'One baseline', query: 'project: BACK', shared: false });
    await w.app.db.insert(baselines).values({ id: newId(), savedSearchId: one.id, name: 'Only', createdById: w.anna.id });
    expect((await failure(() => deleteSavedSearch(w.as(w.anna), one.id))).message).toBe('"One baseline" has a baseline, which would be deleted with it');
  });

  it.runIf(ON_POSTGRES)('counts a baseline being taken while it is deleted, rather than delete it unasked', async () => {
    // The race: a baseline is taken of the search in a transaction that hasn't committed when the delete
    // begins. The delete locks the search's row, so it waits for the baseline, then counts it and asks.
    // Counting without that lock, it counts none, and its delete takes the baseline along unasked.
    const s = await createSavedSearch(w.as(w.anna), { name: 'Raced baseline', query: 'project: BACK', shared: false });
    let commit!: () => void;
    let inserted!: () => void;
    const held = new Promise<void>((r) => (commit = r));
    const begun = new Promise<void>((r) => (inserted = r));
    const taking = w.app.db.transaction(async (tx) => {
      await tx.insert(baselines).values({ id: newId(), savedSearchId: s.id, name: 'Taken meanwhile', createdById: w.anna.id });
      inserted();
      await held;
    });
    await begun;
    const deleting = deleteSavedSearch(w.as(w.anna), s.id).then(
      () => null,
      (e: unknown) => e,
    );
    for (let i = 0; i < 100; i++) {
      const waiting = (await w.app.db.execute(sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`)) as unknown as { rows: { n: number }[] };
      if ((waiting.rows[0]?.n ?? 0) > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    commit();
    await taking;
    const outcome = await deleting;
    expect(outcome).toBeInstanceOf(AppError);
    expect((outcome as AppError).words).toMatchObject({ key: 'savedSearches.hasBaselines', values: { n: 1 } });
    expect(await w.app.db.select({ id: baselines.id }).from(baselines).where(eq(baselines.savedSearchId, s.id))).toHaveLength(1);
  });
});
