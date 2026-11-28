/**
 * Plans of a search (D72): a saved search's or a query's issues, across projects, each on its own project's
 * calendar (D73), as their reader sees them; the cap and what's said when it's met; dependencies by the type,
 * not its phrase; what each task says about who may change it and where its dates are set; a saved search's
 * baselines; and the same answer over REST and MCP.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Baseline, PlanSchedule } from '@a4a/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issues, linkTypes } from '../src/db/schema';
import { createHttpApp } from '../src/http/app';
import { newId } from '../src/lib/ids';
import { issueTokenFor } from '../src/services/auth';
import { createIssue, updateIssue } from '../src/services/issues';
import { addMember } from '../src/services/members';
import {
  costReportOf,
  createBaseline,
  createSearchBaseline,
  deleteBaseline,
  getBaseline,
  getPlanSchedule,
  getSchedule,
  levelLoaded,
  listSearchBaselines,
  loadPlan,
  whatIfPlan,
} from '../src/services/planning';
import { createProject, getProject } from '../src/services/projects';
import { createRole } from '../src/services/roles';
import { createSavedSearch } from '../src/services/saved-searches';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
const task = (s: PlanSchedule, id: string) => s.tasks.find((t) => t.issue.id === id)!;
const said = (e: unknown) => ({ status: (e as { status?: number }).status, message: (e as Error).message, key: (e as { words?: { key: string } }).words?.key });
const refused = async (p: Promise<unknown>) => said(await p.then(() => null, (e: unknown) => e));

beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => w?.close());

describe('a search across projects, each on its own calendar (D73)', () => {
  // ALP works Monday to Friday, BET Sunday to Thursday; both begin Friday 5 January 2035.
  let a1 = '';
  let b1 = '';
  let b0 = '';
  let a2 = '';
  beforeAll(async () => {
    const ctx = w.adminCtx;
    await createProject(ctx, { key: 'ALP', name: 'Alpha site', template: 'waterfall', plan: { startDate: '2035-01-05', workingDays: [1, 2, 3, 4, 5] } });
    await createProject(ctx, { key: 'BET', name: 'Beta site', template: 'waterfall', plan: { startDate: '2035-01-05', workingDays: [0, 1, 2, 3, 4], currency: 'EUR', budget: 5000 } });
    a1 = (await createIssue(ctx, { project: 'ALP', summary: 'Pour the kestrel slab', fields: { Estimation: '1d' } })).id;
    b1 = (await createIssue(ctx, { project: 'BET', summary: 'Frame the kestrel walls', fields: { Estimation: '1d' }, links: [{ relation: 'depends on', issue: a1 }] })).id;
    b0 = (await createIssue(ctx, { project: 'BET', summary: 'Order the kestrel windows', fields: { Estimation: '1d' } })).id;
    a2 = (await createIssue(ctx, { project: 'ALP', summary: 'Inspect the kestrel frame', fields: { Estimation: '1d' }, links: [{ relation: 'depends on', issue: b1 }] })).id;
  });

  it('plans each issue on its project’s days, and a dependency across them as D73 works it out', async () => {
    const s = await getPlanSchedule(w.adminCtx, { query: 'kestrel' });
    expect(s.scope).toEqual({ query: 'kestrel' });
    expect([s.total, s.truncated]).toEqual([4, false]);
    expect(s.projects).toEqual([
      { key: 'ALP', name: 'Alpha site', calendar: 'ALP' },
      { key: 'BET', name: 'Beta site', calendar: 'BET' },
    ]);
    // The plan's own calendar is its first project's, by key.
    expect([s.project.key, s.calendar.workingDays]).toEqual(['ALP', [1, 2, 3, 4, 5]]);
    expect(s.calendars!.BET!.workingDays).toEqual([0, 1, 2, 3, 4]);
    // Friday's slab lets Beta frame on its Sunday; Alpha inspects on its next day, Monday.
    expect([task(s, a1).start, task(s, a1).finish, task(s, a1).calendar]).toEqual(['2035-01-05', '2035-01-05', 'ALP']);
    expect([task(s, b1).start, task(s, b1).finish, task(s, b1).calendar, task(s, b1).scheduledFrom]).toEqual(['2035-01-07', '2035-01-07', 'BET', 'dependencies']);
    expect([task(s, a2).start, task(s, a2).finish]).toEqual(['2035-01-08', '2035-01-08']);
    // Beta's first day is its Sunday too; the chain across both has no false slack.
    expect(task(s, b0).start).toBe('2035-01-07');
    expect([task(s, a1).slackDays, task(s, b1).slackDays, task(s, a2).slackDays]).toEqual([0, 0, 0]);
    expect(s.criticalPath).toEqual([a1, b1, a2]);
    expect(s.finish).toBe('2035-01-08');
    expect(task(s, a1).project).toBe('ALP');
  });

  it('costs each project in its own currency, with no budget of the plan’s own', async () => {
    const c = costReportOf(await loadPlan(w.adminCtx, { query: 'kestrel' }));
    expect(c.budget).toBeNull();
    expect(c.byCalendar!.map((k) => [k.calendar, k.currency, k.budget])).toEqual([
      ['ALP', 'USD', null],
      ['BET', 'EUR', 5000],
    ]);
    expect(c.byCurrency!.map((k) => k.currency)).toEqual(['EUR', 'USD']);
    // A project's own report says per calendar too, its one.
    const mine = costReportOf(await loadPlan(w.adminCtx, { query: '', project: 'BET' }));
    expect([mine.budget, mine.byCalendar!.map((k) => k.calendar)]).toEqual([5000, ['BET']]);
  });

  it('narrows to one project, keeping its calendar the plan’s own', async () => {
    const s = await getPlanSchedule(w.adminCtx, { query: 'kestrel', project: 'BET' });
    expect(s.tasks.map((t) => t.issue.id).sort()).toEqual([b0, b1].sort());
    expect([s.project.key, s.calendar.currency]).toEqual(['BET', 'EUR']);
    // A1 is outside it now, so B1 waits for nothing in the plan.
    expect(task(s, b1).predecessors).toEqual([]);
  });

  it('keeps every dependency when the Depend type’s phrases are renamed', async () => {
    const [depend] = await w.app.db.select().from(linkTypes).where(eq(linkTypes.dependency, true));
    expect(depend!.outward).toBe('depends on');
    await w.app.db.update(linkTypes).set({ outward: 'needs', inward: 'is needed by' }).where(eq(linkTypes.id, depend!.id));
    w.app.schema.invalidate();
    try {
      const s = await getPlanSchedule(w.adminCtx, { query: 'kestrel' });
      expect(task(s, b1).predecessors).toEqual([a1]);
      expect(task(s, a2).predecessors).toEqual([b1]);
      expect(s.finish).toBe('2035-01-08');
    } finally {
      await w.app.db.update(linkTypes).set({ outward: depend!.outward, inward: depend!.inward }).where(eq(linkTypes.id, depend!.id));
      w.app.schema.invalidate();
    }
  });

  it('answers what-if on the scope, on the union of its calendars', async () => {
    const res = await whatIfPlan(w.adminCtx, { scope: { query: 'kestrel' }, overrides: [{ issue: a1, delayDays: 1 }] });
    // The slab slips to Monday; Beta frames on Tuesday, Alpha inspects on Wednesday.
    expect(task(res.after, a2).start).toBe('2035-01-10');
    expect(res.after.total).toBe(4);
    expect(res.finishDeltaDays).toBe(2);
  });
});

describe('a shared saved search, read by two people', () => {
  let searchId = '';
  let secret = '';
  let shipped = '';
  beforeAll(async () => {
    await createProject(w.adminCtx, { key: 'SEC', name: 'Merger', template: 'waterfall', visibility: 'members' });
    await addMember(w.adminCtx, 'SEC', { user: 'anna', role: 'member' });
    const anna = w.as(w.anna);
    secret = (await createIssue(anna, { project: 'SEC', summary: 'Sign the zebracorn contract', fields: { Estimation: '2d' } })).id;
    shipped = (await createIssue(anna, { project: 'BACK', summary: 'Ship the zebracorn API', fields: { Estimation: '1d' }, links: [{ relation: 'depends on', issue: secret }] })).id;
    searchId = (await createSavedSearch(anna, { name: 'Zebracorn', query: 'zebracorn', shared: true })).id;
  });

  it('gives each only what they see, and never names a predecessor hidden from them', async () => {
    const annas = await getPlanSchedule(w.as(w.anna), { savedSearch: searchId });
    expect(annas.tasks.map((t) => t.issue.id).sort()).toEqual([shipped, secret].sort());
    expect(task(annas, shipped).predecessors).toEqual([secret]);
    expect(annas.projects!.map((p) => p.key)).toEqual(['BACK', 'SEC']);

    const bens = await getPlanSchedule(w.as(w.ben), { savedSearch: searchId });
    expect(bens.tasks.map((t) => t.issue.id)).toEqual([shipped]);
    expect([bens.total, bens.truncated]).toEqual([1, false]);
    expect(task(bens, shipped).predecessors).toEqual([]);
    expect(bens.projects!.map((p) => p.key)).toEqual(['BACK']);
    const text = JSON.stringify(bens);
    for (const hidden of [secret, 'SEC', 'Merger', 'Sign the zebracorn contract']) expect(text).not.toContain(hidden);
  });

  it('answers a search someone may not read as one that doesn’t exist', async () => {
    const own = (await createSavedSearch(w.as(w.anna), { name: 'Mine', query: 'zebracorn', shared: false })).id;
    const names = (await createSavedSearch(w.as(w.anna), { name: 'Merger only', query: 'project: SEC', shared: true })).id;
    const missing = await refused(getPlanSchedule(w.as(w.ben), { savedSearch: 'no-such-search' }));
    expect(missing).toEqual({ status: 404, message: 'Saved search not found', key: 'savedSearches.notFound' });
    expect(await refused(getPlanSchedule(w.as(w.ben), { savedSearch: own }))).toEqual(missing);
    // A shared search whose query names what Ben can't see doesn't read for him: missing, not its problems.
    expect(await refused(getPlanSchedule(w.as(w.ben), { savedSearch: names }))).toEqual(missing);
    expect(await refused(listSearchBaselines(w.as(w.ben), own))).toEqual(missing);
    // A project the reader can't see is missing in the words of one that doesn't exist.
    expect((await refused(getPlanSchedule(w.as(w.ben), { query: '', project: 'SEC' }))).status).toBe(404);
  });
});

describe('the cap: a plan holds 2,000 issues, and says when it holds fewer than its search', () => {
  async function bulk(key: string, n: number) {
    await createProject(w.adminCtx, { key, name: `Bulk ${key}`, template: 'blank' });
    const project = (await w.app.schema.get()).projectsByKey.get(key)!;
    for (let from = 1; from <= n; from += 500) {
      const rows = Array.from({ length: Math.min(500, n - from + 1) }, (_, i) => ({ id: newId(), projectId: project.id, number: from + i, summary: `Bulk issue ${from + i}`, reporterId: w.admin.id }));
      await w.app.db.insert(issues).values(rows);
    }
  }
  beforeAll(async () => {
    await bulk('MID', 1200);
    await bulk('BIG', 2050);
  }, 120_000);

  it('plans every one of 1,200 issues a query finds (no 1,000 clamp)', async () => {
    const s = await getPlanSchedule(w.adminCtx, { query: 'project: MID' });
    expect([s.tasks.length, s.total, s.truncated]).toEqual([1200, 1200, false]);
    // Today's route, by query, as well.
    expect((await getSchedule(w.adminCtx, 'MID', { query: 'project: MID' })).tasks).toHaveLength(1200);
  }, 120_000);

  it('plans the first 2,000 of 2,050, by project and number, and says it was cut short', async () => {
    const s = await getPlanSchedule(w.adminCtx, { query: 'project: BIG' });
    expect([s.tasks.length, s.total, s.truncated]).toEqual([2000, 2050, true]);
    const ids = new Set(s.tasks.map((t) => t.issue.id));
    expect([ids.has('BIG-1'), ids.has('BIG-2000'), ids.has('BIG-2001')]).toEqual([true, true, false]);
    // The page words it from `truncated`; a project's answer, which has nowhere else, says it in a warning.
    expect(s.warnings.some((x) => x.startsWith('Only the first'))).toBe(false);
    const project = await getSchedule(w.adminCtx, 'BIG');
    expect(project.tasks).toHaveLength(2000);
    expect(project.warnings).toContain('Only the first 2000 of 2050 issues are planned, by project and number: narrow the search to plan the rest');
  }, 120_000);
});

describe('who may change each task, and where its dates are set', () => {
  let edt = '';
  let back = '';
  beforeAll(async () => {
    await createProject(w.adminCtx, { key: 'EDT', name: 'Editing', template: 'waterfall' });
    await addMember(w.adminCtx, 'EDT', { user: 'ben', role: 'viewer' });
    edt = (await createIssue(w.as(w.anna), { project: 'EDT', summary: 'Survey the osprey nest', fields: { 'Start date': '2035-02-05', 'Due date': '2035-02-20', Estimation: '2d' } })).id;
    back = (await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Count the osprey eggs', fields: { 'Due date': '2035-02-22' } })).id;
  });

  it('says editable as the write path would, and each role’s field in the issue’s own project', async () => {
    const bens = await getPlanSchedule(w.as(w.ben), { query: 'osprey' });
    expect([task(bens, edt).editable, task(bens, back).editable]).toEqual([false, true]);
    expect(task(bens, edt).set).toEqual({
      start: { field: 'Start date', value: '2035-02-05' },
      end: { field: 'Due date', value: '2035-02-20' },
      duration: null,
      estimate: { field: 'Estimation', value: 960 },
    });
    // BACK plans no start from a field of its own (it has none), and has no estimate set on this issue.
    expect(task(bens, back).set).toEqual({ start: null, end: { field: 'Due date', value: '2035-02-22' }, duration: null, estimate: { field: 'Estimation', value: null } });
    const annas = await getPlanSchedule(w.as(w.anna), { query: 'osprey' });
    expect(task(annas, edt).editable).toBe(true);
    // A read-only token changes nothing, whatever the role.
    const token = { ...w.as(w.anna), actor: { ...w.as(w.anna).actor, scopes: ['read' as const] } };
    expect(task(await getPlanSchedule(token, { query: 'osprey' }), edt).editable).toBe(false);
  });
});

describe('levelling a plan across projects keeps each project’s start (D73)', () => {
  // CUA has no start date of its own: it begins at its earliest Start date. Levelling writes the review's,
  // which would become that and take the runbook with it, so CUA keeps where it began; CUB, unmoved, keeps none.
  it('writes keepStarts per project, so each begins where it did', async () => {
    const ctx = w.adminCtx;
    await createProject(ctx, { key: 'CUA', name: 'Cutover A', template: 'waterfall' });
    await createProject(ctx, { key: 'CUB', name: 'Cutover B', template: 'waterfall' });
    const runbook = await createIssue(ctx, { project: 'CUA', summary: 'Write the pelican runbook', fields: { Type: 'Task', Assignee: 'anna', Estimation: '3d' } });
    const review = await createIssue(ctx, { project: 'CUA', summary: 'Review the pelican runbook', fields: { Type: 'Task', Assignee: 'anna', Estimation: '2d' } });
    await createIssue(ctx, { project: 'CUB', summary: 'Rehearse the pelican cutover', fields: { Type: 'Task', Assignee: 'ben', Estimation: '2d' } });
    const before = await getPlanSchedule(ctx, { query: 'pelican' });
    const proposal = await levelLoaded(ctx, await loadPlan(ctx, { query: 'pelican' }), { mode: 'allow_delay', dryRun: true });
    expect(Object.keys(proposal.starts)).toEqual([review.id]);
    // Two calendars: the plan has no one start of its own to keep.
    expect(proposal.keepsStart).toBeNull();
    await levelLoaded(ctx, await loadPlan(ctx, { query: 'pelican' }), { mode: 'allow_delay', dryRun: false, expect: proposal.starts });
    expect((await getProject(ctx, 'CUA')).settings.plan.startDate).toBe(task(before, runbook.id).start);
    expect((await getProject(ctx, 'CUB')).settings.plan.startDate).toBeNull();
    const after = await getPlanSchedule(ctx, { query: 'pelican' });
    expect(task(after, runbook.id).start).toBe(task(before, runbook.id).start);
    expect(after.finish).toBe(proposal.finishAfter);
  });
});

describe('baselines of a saved search', () => {
  let one = '';
  let both = '';
  let mine = '';
  let taken: Baseline;
  beforeAll(async () => {
    const ctx = w.adminCtx;
    await createProject(ctx, { key: 'BLA', name: 'Baseline A', template: 'waterfall', lead: 'anna', plan: { startDate: '2035-03-05' } });
    await createProject(ctx, { key: 'BLB', name: 'Baseline B', template: 'waterfall', plan: { startDate: '2035-03-05' } });
    await addMember(ctx, 'BLB', { user: 'anna', role: 'member' });
    // Ben reads BLA without the costs permission, and BLB as anyone does, with it.
    const noCosts = await createRole(ctx, { name: 'Reader without costs', permissions: ['read', 'comment'] });
    await addMember(ctx, 'BLA', { user: 'ben', role: noCosts.id });
    const anna = w.as(w.anna);
    await createIssue(anna, { project: 'BLA', summary: 'Plan the quokka wombat survey', fields: { Assignee: 'anna', Estimation: '2d' } });
    await createIssue(anna, { project: 'BLB', summary: 'Fund the wombat survey', fields: { Assignee: 'anna', Estimation: '1d' } });
    one = (await createSavedSearch(anna, { name: 'Quokka', query: 'quokka', shared: true })).id;
    both = (await createSavedSearch(anna, { name: 'Wombat', query: 'wombat', shared: true })).id;
    mine = (await createSavedSearch(anna, { name: 'Wombat, mine', query: 'wombat', shared: false })).id;
  });

  it('is taken by its owner managing every project it holds, or by an administrator', async () => {
    const anna = w.as(w.anna);
    taken = await createSearchBaseline(anna, one, { name: 'Kickoff', note: 'Agreed' });
    expect([taken.savedSearch, taken.projectKey, taken.taskCount, taken.currency]).toEqual([one, '', 1, 'USD']);
    expect(taken.projects).toEqual([{ key: 'BLA', currency: 'USD', plannedCost: 1440 }]);
    expect(taken.plannedCost).toBe(1440);

    const unmanaged = await refused(createSearchBaseline(anna, both, { name: 'Both' }));
    expect(unmanaged).toMatchObject({ status: 403, key: 'plans.baselineNeedsManage' });
    expect(unmanaged.message).toContain('you don\'t manage BLB');
    expect(await refused(createSearchBaseline(w.as(w.ben), one, { name: 'Mine now' }))).toMatchObject({ status: 403, key: 'plans.baselineOnlyOwner' });
    expect(await refused(createSearchBaseline(w.as(w.ben), mine, { name: 'Mine now' }))).toEqual({ status: 404, message: 'Saved search not found', key: 'savedSearches.notFound' });
    const admins = await createSearchBaseline(w.adminCtx, both, { name: 'Both, by the office' });
    expect(admins.projects!.map((p) => p.key)).toEqual(['BLA', 'BLB']);
  });

  it('is read by whoever reads the search, without money where they lack the costs permission', async () => {
    const [b] = await listSearchBaselines(w.as(w.ben), both);
    expect(b!.projects).toEqual([
      { key: 'BLA', currency: 'USD', plannedCost: null },
      { key: 'BLB', currency: 'USD', plannedCost: 720 },
    ]);
    expect([b!.plannedCost, b!.taskCount]).toEqual([720, 2]);
    expect((await getBaseline(w.as(w.ben), b!.id)).projects).toEqual(b!.projects);
    const compared = await getPlanSchedule(w.as(w.ben), { savedSearch: both }, { baseline: b!.id });
    const byProject = (key: string) => compared.tasks.find((t) => t.project === key)!;
    expect(compared.baseline!.name).toBe('Both, by the office');
    expect([byProject('BLA').baseline!.cost, byProject('BLA').variance!.cost, byProject('BLA').plannedCost]).toEqual([null, null, null]);
    expect(byProject('BLB').baseline!.cost).toBe(720);
  });

  it('is compared with, as its search’s own, and answers as missing in any other plan', async () => {
    const anna = w.as(w.anna);
    const quokka = (await getPlanSchedule(anna, { savedSearch: one })).tasks[0]!;
    await updateIssue(anna, quokka.issue.id, { fields: { Estimation: '3d' } });
    const s = await getPlanSchedule(anna, { savedSearch: one }, { baseline: taken.id });
    expect(s.baseline).toMatchObject({ id: taken.id, name: 'Kickoff' });
    expect(task(s, quokka.issue.id).variance).toMatchObject({ finishDays: 1, effortMinutes: 480, cost: 720 });
    const other = await refused(getPlanSchedule(anna, { savedSearch: both }, { baseline: taken.id }));
    expect(other).toMatchObject({ status: 404, key: 'plans.baselineNotFoundList' });
    expect((await refused(getPlanSchedule(anna, { query: 'quokka', project: 'BLA' }, { baseline: taken.id }))).key).toBe('planning.baselineNotFoundList');
    // A project's baselines stay the scope `project: KEY`'s.
    const kept = await createBaseline(anna, 'BLA', { name: 'BLA of record' });
    expect((await getPlanSchedule(anna, { query: '', project: 'BLA' }, { baseline: kept.id })).baseline!.name).toBe('BLA of record');
    expect((await refused(getPlanSchedule(anna, { savedSearch: one }, { baseline: kept.id }))).key).toBe('plans.baselineNotFoundList');
  });

  it('refuses over REST in the words its catalogs say (D49)', async () => {
    const app = createHttpApp(w.app);
    const bearer = async (userId: string) => (await issueTokenFor(w.app.db, userId, { name: 'refusals', scopes: ['read', 'write'] })).token;
    const [anna, ben] = [await bearer(w.anna.id), await bearer(w.ben.id)];
    const call = async (token: string, method: string, path: string, body?: unknown) => {
      const res = await app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as { error?: { code?: string; message?: string } } };
    };
    expect((await call(ben, 'POST', `/saved-searches/${one}/baselines`, { name: 'Mine now' })).status).toBe(403);
    const unmanaged = await call(anna, 'POST', `/saved-searches/${both}/baselines`, { name: 'Both' });
    expect([unmanaged.status, JSON.stringify(unmanaged.body)]).toEqual([403, expect.stringContaining('BLB')]);
    expect((await call(anna, 'GET', `/plans/schedule?savedSearch=${both}&baseline=${taken.id}`)).status).toBe(404);
    expect((await call(ben, 'GET', `/saved-searches/${mine}/baselines`)).status).toBe(404);
  });

  it('is deleted by whoever may take one, and is gone', async () => {
    expect(await refused(deleteBaseline(w.as(w.ben), taken.id))).toMatchObject({ status: 403, key: 'plans.baselineOnlyOwner' });
    await deleteBaseline(w.as(w.anna), taken.id);
    expect(await refused(getBaseline(w.as(w.anna), taken.id))).toMatchObject({ status: 404, key: 'planning.baselineNotFound' });
    expect((await listSearchBaselines(w.as(w.anna), one)).map((b) => b.id)).not.toContain(taken.id);
  });
});

describe('over REST and MCP', () => {
  let app: ReturnType<typeof createHttpApp>;
  let token = '';
  let searchId = '';
  beforeAll(async () => {
    app = createHttpApp(w.app);
    token = (await issueTokenFor(w.app.db, w.anna.id, { name: 'anna', scopes: ['read', 'write'] })).token;
    searchId = (await createSavedSearch(w.as(w.anna), { name: 'Quokka again', query: 'quokka', shared: false })).id;
  });
  async function call(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.request(`/api/v1${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  async function mcp() {
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (input, init) => app.request(String(input), init as RequestInit),
    });
    const c = new Client({ name: 'test', version: '1.0.0' });
    await c.connect(transport);
    return c;
  }

  it('reads a scope from the query string, and refuses one that names neither or both', async () => {
    const res = await call('GET', `/plans/schedule?savedSearch=${searchId}`);
    expect(res.status).toBe(200);
    expect(res.body.scope).toEqual({ savedSearch: searchId });
    expect((await call('GET', '/plans/schedule?query=quokka&project=BLA')).body.total).toBe(1);
    expect((await call('GET', '/plans/schedule')).status).toBe(400);
    expect((await call('GET', `/plans/schedule?savedSearch=${searchId}&query=quokka`)).status).toBe(400);
    const whatIf = await call('POST', '/plans/what-if', { scope: { savedSearch: searchId }, overrides: [{ issue: (res.body as unknown as PlanSchedule).tasks[0]!.issue.id, delayDays: 2 }] });
    expect([whatIf.status, whatIf.body.finishDeltaDays]).toEqual([200, 2]);
    const baselines = await call('POST', `/saved-searches/${searchId}/baselines`, { name: 'Over REST' });
    expect([baselines.status, baselines.body.savedSearch]).toEqual([201, searchId]);
    expect(((await call('GET', `/saved-searches/${searchId}/baselines`)).body as unknown as Baseline[]).map((b) => b.name)).toEqual(['Over REST']);
  });

  it('answers get_plan as the route does', async () => {
    const route = (await call('GET', `/plans/schedule?savedSearch=${searchId}`)).body as unknown as PlanSchedule;
    const c = await mcp();
    const res = await c.callTool({ name: 'get_plan', arguments: { saved_search: searchId } });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect([data.start, data.finish, data.total, data.truncated, data.criticalPath]).toEqual([route.start, route.finish, route.total, route.truncated, route.criticalPath]);
    expect(data.tasks.map((t: { id: string; start: string; finish: string; project: string }) => [t.id, t.start, t.finish, t.project])).toEqual(route.tasks.map((t) => [t.issue.id, t.start, t.finish, t.project]));
    expect(data.tasks[0].set.estimate).toBe('Estimation: 3d');
    expect(data.baselines.map((b: { name: string }) => b.name)).toEqual(['Over REST']);
    const whatIf = await c.callTool({ name: 'get_plan', arguments: { saved_search: searchId, what_if: [{ issue: route.tasks[0]!.issue.id, delay_days: 2 }] } });
    expect(JSON.parse((whatIf.content as { text: string }[])[0]!.text).finishDeltaWorkingDays).toBe(2);
    const neither = await c.callTool({ name: 'get_plan', arguments: {} });
    expect(neither.isError).toBe(true);
    const hidden = await c.callTool({ name: 'get_plan', arguments: { saved_search: 'no-such-search' } });
    expect((hidden.content as { text: string }[])[0]!.text).toContain('Saved search not found');
    await c.close();
  });
});
