/**
 * Reports, dashboards and imports under per-project access: a members-only project stays hidden
 * through each of them, answering exactly as one that doesn't exist, and a viewer changes through
 * them nothing a viewer may not change.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../src/context';
import { activities } from '../src/db/schema';
import { AppError } from '../src/lib/errors';
import { addDays, todayISO } from '../src/lib/dates';
import { createBoard, createSprint, setSprintIssues } from '../src/services/boards';
import { createDashboard, defaultDashboard, getDashboard, listDashboards, updateDashboard } from '../src/services/dashboards';
import { addFieldValue } from '../src/services/fields';
import {
  checkImport,
  deleteImport,
  getImport,
  importRowsOf,
  listImports,
  runImport,
  undoImport,
  updateMapping,
  uploadImport,
  waitForImport,
} from '../src/services/imports';
import { createIssue, getIssue, updateIssue } from '../src/services/issues';
import { addMember } from '../src/services/members';
import { createProject } from '../src/services/projects';
import { burndownReport, createdResolvedReport, cycleTimeReport, flowReport, timeEntries, timeReport } from '../src/services/reports';
import { createSavedSearch } from '../src/services/saved-searches';
import { fieldByName } from '../src/services/schema-cache';
import { insertUser } from '../src/services/users';
import { logWork } from '../src/services/workitems';
import { toolByName } from '../src/tools/registry';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let admin: Ctx;
let anna: Ctx; // a member of SECRET
let ben: Ctx; // outside it; a member of the open projects
let vera: Ctx; // a viewer: read-only everywhere
let dina: Ctx; // a viewer of WEB, by her role in it
const CODEWORD = 'zebraquokka';
let secretIssue = '';
let backIssue = '';
let webIssue = '';
let secretOpen = '';
let backOpen = '';
let mergerSprint = '';
let mixedSprint = '';
let webSprint = '';

/** What an error says, with one key or id put back as a placeholder, to compare "hidden" with "missing". */
async function failure(p: Promise<unknown>, word?: string): Promise<{ status: number; code: string; message: string; hint?: string }> {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    const strip = (t?: string) => (word && t ? t.split(word).join('<X>') : t);
    return { status: e.status, code: e.code, message: strip(e.message)!, hint: strip(e.hint) };
  }
  throw new Error('expected it to fail');
}

/** The same failure for something hidden as for something missing, and a 404. */
async function sameAsMissing(hidden: (word: string) => Promise<unknown>, hiddenWord: string, missingWord: string) {
  const a = await failure(hidden(hiddenWord), hiddenWord);
  const b = await failure(hidden(missingWord), missingWord);
  expect(a).toEqual(b);
  expect(a.status === 404 || a.status === 400).toBe(true);
  return a;
}

const csv = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
};

const hides = (value: unknown) => {
  const text = JSON.stringify(value);
  expect(text).not.toContain(CODEWORD);
  expect(text).not.toContain('SECRET');
  expect(text).not.toContain('Merger');
};

beforeAll(async () => {
  w = await createWorld();
  admin = w.adminCtx;
  anna = w.as(w.anna);
  ben = w.as(w.ben);
  vera = w.as(w.viewer);
  const dinaRow = await insertUser(w.app.db, { login: 'dina', name: 'Dina Reader', role: 'member' });
  w.app.schema.invalidate();
  dina = w.as(dinaRow);
  await createProject(admin, { key: 'SECRET', name: 'Merger', template: 'software', visibility: 'members' });
  const s = await w.app.schema.get();
  await addFieldValue(admin, fieldByName(s, 'Subsystem')!.id, { name: 'Diligence', project: 'SECRET' });
  await addMember(admin, 'SECRET', { user: 'anna', role: 'member' });
  await addMember(admin, 'WEB', { user: 'dina', role: 'viewer' });

  secretIssue = (await createIssue(anna, { project: 'SECRET', summary: `Acquire Initech ${CODEWORD}`, fields: { Estimation: '2d', Subsystem: 'Diligence' } })).id;
  await updateIssue(anna, secretIssue, { fields: { State: 'In Progress' } });
  await logWork(anna, secretIssue, { duration: '3h', description: `Diligence on ${CODEWORD}` });
  await updateIssue(anna, secretIssue, { fields: { State: 'Fixed' } });
  backIssue = (await createIssue(ben, { project: 'BACK', summary: 'Rate limit the public API', fields: { Estimation: '1d' } })).id;
  await updateIssue(ben, backIssue, { fields: { State: 'In Progress' } });
  await logWork(ben, backIssue, { duration: '1h' });
  await updateIssue(ben, backIssue, { fields: { State: 'Fixed' } });
  webIssue = (await createIssue(admin, { project: 'WEB', summary: 'Polish the sign-in page', fields: { Estimation: '4h' } })).id;
  secretOpen = (await createIssue(anna, { project: 'SECRET', summary: `Vet the ${CODEWORD} board`, fields: { Estimation: '2d' } })).id;
  backOpen = (await createIssue(ben, { project: 'BACK', summary: 'Cache the rate limits', fields: { Estimation: '1d' } })).id;

  const today = todayISO();
  const span = { startDate: addDays(today, -2), endDate: addDays(today, 7) };
  const merger = await createBoard(admin, { name: 'Merger board', projects: ['SECRET'], sprintsEnabled: true });
  mergerSprint = (await createSprint(admin, merger.id, { name: 'M1', ...span })).id;
  await setSprintIssues(anna, mergerSprint, [secretIssue], false);
  const mixed = await createBoard(admin, { name: 'Mixed board', projects: ['BACK', 'SECRET'], sprintsEnabled: true });
  mixedSprint = (await createSprint(admin, mixed.id, { name: 'X1', ...span })).id;
  await setSprintIssues(admin, mixedSprint, [backIssue, secretIssue, backOpen, secretOpen], false);
  const web = await createBoard(admin, { name: 'Web board', projects: ['WEB'], sprintsEnabled: true });
  webSprint = (await createSprint(admin, web.id, { name: 'W1', ...span })).id;
  await setSprintIssues(admin, webSprint, [webIssue], false);
});

afterAll(async () => w?.close());

describe('reports, from outside a members-only project', () => {
  it("answer the project's key exactly as a key that doesn't exist", async () => {
    await sameAsMissing((k) => flowReport(ben, { project: k }), 'SECRET', 'NOPE');
    await sameAsMissing((k) => createdResolvedReport(ben, { project: k }), 'SECRET', 'NOPE');
    await sameAsMissing((k) => cycleTimeReport(ben, { project: k }), 'SECRET', 'NOPE');
    await sameAsMissing((k) => timeReport(ben, { project: k }), 'SECRET', 'NOPE');
    await sameAsMissing((k) => timeEntries(ben, { project: k }), 'SECRET', 'NOPE');
    // In a query, naming it is the same mistake as naming a project that doesn't exist.
    await sameAsMissing((k) => flowReport(ben, { query: `project: ${k}` }), 'SECRET', 'SECRAT');
    await sameAsMissing((k) => timeReport(ben, { query: `project: ${k}` }), 'SECRET', 'SECRAT');
    // Its members get the report.
    expect((await flowReport(anna, { project: 'SECRET' })).scope.issues).toBe(2);
  });

  it('leave its issues, its work and its states out of reports over every project', async () => {
    const mine = await createdResolvedReport(ben, {});
    const theirs = await createdResolvedReport(anna, {});
    expect(theirs.totals.created - mine.totals.created).toBe(2);
    expect(theirs.totals.resolved - mine.totals.resolved).toBe(1);
    hides(mine);

    const flow = await flowReport(ben, {});
    expect(flow.days.at(-1)!.total).toBe((await flowReport(anna, {})).days.at(-1)!.total - 2);
    hides(flow);

    const cycle = await cycleTimeReport(ben, {});
    expect(cycle.issues.map((i) => i.issue)).toEqual([backIssue]);
    expect((await cycleTimeReport(anna, {})).issues.map((i) => i.issue).sort()).toEqual([backIssue, secretIssue].sort());
    hides(cycle);

    const time = await timeReport(ben, {});
    expect(time.totalMinutes).toBe(60);
    expect(time.byIssue.map((i) => i.issue)).toEqual([backIssue]);
    expect((await timeReport(anna, {})).totalMinutes).toBe(240);
    hides(time);
    hides(await timeEntries(ben, {}));
  });

  it("treat a board only the project is on as a board that doesn't exist, and its sprint as a missing sprint", async () => {
    const board = await sameAsMissing((b) => burndownReport(ben, { board: b }), 'Merger board', 'Nope board');
    expect(board.status).toBe(404);
    expect(board.hint).not.toContain('Merger');
    await sameAsMissing((id) => burndownReport(ben, { sprint: id }), mergerSprint, 'no-such-sprint');
    await sameAsMissing((id) => burndownReport(ben, { board: 'Mixed board', sprint: id }), 'M1', 'M9');
    expect((await burndownReport(anna, { board: 'Merger board' })).sprint.name).toBe('M1');
  });

  it("count on a board shared with a visible project only the issues the viewer can see, as the board shows them", async () => {
    const mine = await burndownReport(ben, { board: 'Mixed board', by: 'count', timeZone: 'UTC' });
    const theirs = await burndownReport(anna, { board: 'Mixed board', by: 'count', timeZone: 'UTC' });
    expect(mine.projects.map((p) => p.key)).toEqual(['BACK']);
    expect(mine.added).toBe(1);
    expect(theirs.added).toBe(2);
    expect(mine.changes.map((c) => c.issue)).toEqual([backOpen]);
    expect(theirs.changes.map((c) => c.issue).sort()).toEqual([backOpen, secretOpen].sort());
    hides({ ...mine, sprint: undefined, warnings: undefined });
    const byEstimate = await burndownReport(ben, { board: 'Mixed board', timeZone: 'UTC' });
    expect(byEstimate.added).toBe(8 * 60);
  });

  it('say the same over MCP, where get_report answers a hidden project as a missing one', async () => {
    const tool = toolByName('get_report')!;
    const run = (ctx: Ctx, input: Record<string, unknown>) => tool.run(ctx, tool.input.parse(input) as never);
    for (const report of ['flow', 'cycle_time', 'created_resolved', 'time']) {
      await sameAsMissing((k) => run(ben, { report, project: k }), 'SECRET', 'NOPE');
    }
    await sameAsMissing((b) => run(ben, { report: 'burndown', board: b }), 'Merger board', 'Nope board');
    hides((await run(ben, { report: 'time' })).data);
    hides((await run(ben, { report: 'cycle_time' })).data);
  });
});

describe('dashboards, from outside a members-only project', () => {
  it("can't hold a widget naming what you can't see, which fails as naming what doesn't exist", async () => {
    const make = (params: Record<string, unknown>) => createDashboard(ben, { name: 'Mine', widgets: [{ id: 'a', kind: 'report', params } as never] });
    await sameAsMissing((k) => make({ report: 'flow', project: k }), 'SECRET', 'NOPE');
    await sameAsMissing((b) => make({ report: 'burndown', board: b }), 'Merger board', 'Nope board');
    await sameAsMissing((id) => make({ report: 'burndown', sprint: id }), mergerSprint, 'no-such-sprint');
    await sameAsMissing((k) => make({ report: 'cycle-time', query: `project: ${k}` }), 'SECRET', 'SECRAT');
    const search = (query: string) => createDashboard(ben, { name: 'Mine', widgets: [{ id: 'a', kind: 'search', query } as never] });
    await sameAsMissing((k) => search(`project: ${k}`), 'SECRET', 'SECRAT');
    const merger = await createSavedSearch(anna, { name: 'The merger', query: 'project: SECRET #Unresolved', shared: true });
    const saved = (id: string) => createDashboard(ben, { name: 'Mine', widgets: [{ id: 'a', kind: 'search', savedSearch: id } as never] });
    await sameAsMissing(saved, merger.id, 'no-such-search');
  });

  it("shows each viewer of a shared dashboard only the widgets that name what they can see", async () => {
    const merger = await createSavedSearch(anna, { name: 'Merger, open', query: 'project: SECRET #Unresolved', shared: true });
    const everyone = await createSavedSearch(anna, { name: 'All open', query: '#Unresolved', shared: true });
    const widgets = [
      { id: 'note', kind: 'note', text: 'Read me first' },
      { id: 'flow-secret', kind: 'report', title: 'Merger flow', params: { report: 'flow', project: 'SECRET' } },
      { id: 'flow-back', kind: 'report', title: 'Backend flow', params: { report: 'flow', project: 'back' } },
      { id: 'value', kind: 'report', title: 'Diligence work', params: { report: 'time', query: 'Subsystem: Diligence' } },
      { id: 'burn-merger', kind: 'report', title: 'Merger sprint', params: { report: 'burndown', board: 'Merger board' } },
      { id: 'burn-sprint', kind: 'report', title: 'M1 by id', params: { report: 'burndown', sprint: mergerSprint } },
      { id: 'burn-mixed', kind: 'report', title: 'Mixed sprint', params: { report: 'burndown', board: 'Mixed board' } },
      { id: 'search-secret', kind: 'search', title: 'Merger issues', query: 'project: SECRET', show: 'count' },
      { id: 'saved-secret', kind: 'search', savedSearch: merger.id, show: 'list' },
      { id: 'saved-all', kind: 'search', savedSearch: everyone.id, show: 'count' },
    ];
    const d = await createDashboard(anna, { name: 'Team', shared: true, widgets: widgets as never });
    expect(d.widgets).toHaveLength(widgets.length);
    const seen = await getDashboard(ben, d.id!);
    expect(seen.widgets.map((x) => x.id)).toEqual(['note', 'flow-back', 'burn-mixed', 'saved-all']);
    expect(JSON.stringify(seen)).not.toContain(mergerSprint);
    expect(JSON.stringify(seen)).not.toContain(merger.id);
    hides(seen.widgets);
    hides((await listDashboards(ben)).find((x) => x.id === d.id)!.widgets);
    // Its owner, and an administrator, see it whole.
    expect((await getDashboard(anna, d.id!)).widgets).toHaveLength(widgets.length);
    expect((await getDashboard(admin, d.id!)).widgets).toHaveLength(widgets.length);
    // And someone outside can't change it to find out.
    expect((await failure(updateDashboard(ben, d.id!, { name: 'Ours' }))).status).toBe(403);
  });

  it("answers someone else's private dashboard as a missing one, and starts no one on a board they can't see", async () => {
    const own = await createDashboard(anna, { name: 'Merger notes', widgets: [{ id: 'n', kind: 'note', text: CODEWORD } as never] });
    await sameAsMissing((id) => getDashboard(ben, id), own.id!, 'no-such-dashboard');
    await sameAsMissing((id) => updateDashboard(ben, id, { name: 'x' }), own.id!, 'no-such-dashboard');
    expect((await listDashboards(ben)).map((x) => x.id)).not.toContain(own.id);
    const sprintOf = async (ctx: Ctx) => (await defaultDashboard(ctx)).widgets.find((x) => x.id === 'sprint')?.title;
    expect(await sprintOf(anna)).toMatch(/^Merger board/);
    expect(await sprintOf(ben)).toMatch(/^Mixed board/);
  });
});

describe('imports, from outside a members-only project', () => {
  let secretImport = '';
  const FILE = ['Summary,Issue key,Assignee,Reporter', `Close the deal ${CODEWORD},ABC-1,Ben Okafor,Anna Schmidt`, 'Count the chairs,ABC-2,Anna Schmidt,Ben Okafor'].join('\n');

  beforeAll(async () => {
    secretImport = (await uploadImport(admin, { project: 'SECRET', fileName: 'merger.csv' }, csv(FILE))).id;
  });

  it("answer the project, and an import into it, exactly as ones that don't exist", async () => {
    await sameAsMissing((k) => uploadImport(ben, { project: k }, csv(FILE)), 'SECRET', 'NOPE');
    await sameAsMissing((k) => listImports(ben, k), 'SECRET', 'NOPE');
    expect((await listImports(ben)).map((i) => i.id)).not.toContain(secretImport);
    const missing = 'no-such-import';
    await sameAsMissing((id) => getImport(ben, id), secretImport, missing);
    await sameAsMissing((id) => updateMapping(ben, id, { options: { onExisting: 'skip' } }), secretImport, missing);
    await sameAsMissing((id) => checkImport(ben, id), secretImport, missing);
    await sameAsMissing((id) => runImport(ben, id), secretImport, missing);
    await sameAsMissing((id) => importRowsOf(ben, id, { offset: 0, limit: 10 }), secretImport, missing);
    await sameAsMissing((id) => undoImport(ben, id, { dryRun: true }), secretImport, missing);
    await sameAsMissing((id) => deleteImport(ben, id), secretImport, missing);
  });

  it('offers only its people as reporters and assignees, and assigns no one else', async () => {
    const imp = await getImport(admin, secretImport);
    const assignee = imp.values.find((v) => v.target === 'field:Assignee')!;
    expect(assignee.choices.map((c) => c.value)).not.toContain('ben');
    expect(assignee.choices.map((c) => c.value)).toContain('anna');
    expect(assignee.items.find((i) => i.value === 'Ben Okafor')).toMatchObject({ to: null, found: false });
    const reporter = imp.values.find((v) => v.target === 'reporter')!;
    expect(reporter.items.find((i) => i.value === 'Ben Okafor')!.to).toBeNull();
    // Choosing him by hand is refused: he can't see the project.
    const refused = await failure(updateMapping(admin, secretImport, { values: { 'field:Assignee': { 'Ben Okafor': 'ben' } } }));
    expect(refused.status).toBe(400);
    await runImport(admin, secretImport);
    await waitForImport(secretImport);
    const done = await getImport(admin, secretImport);
    expect(done.status).toBe('done');
    expect(done.result?.created).toBe(2);
    const rows = await importRowsOf(admin, secretImport, { offset: 0, limit: 10 });
    const first = await getIssue(anna, rows.items.find((r) => r.key === 'ABC-1')!.issue!);
    expect(first.fields.find((f) => f.name === 'Assignee')!.value).toBeNull();
    const second = await getIssue(anna, rows.items.find((r) => r.key === 'ABC-2')!.issue!);
    expect(second.reporter).toBeNull();
    // What the import made stays out of sight too.
    await sameAsMissing((id) => getIssue(ben, id), first.id, 'SECRET-999');
    hides(await createdResolvedReport(ben, {}));
  });

  it("are a project manager's to run: a member of the project reads none of them, and can't start one", async () => {
    const asMember = await failure(getImport(anna, secretImport));
    expect(asMember.status).toBe(403);
    expect((await failure(uploadImport(anna, { project: 'SECRET' }, csv(FILE)))).status).toBe(403);
    expect((await failure(undoImport(anna, secretImport, { dryRun: false }))).status).toBe(403);
    expect(await listImports(anna)).toEqual([]);
  });
});

describe('a viewer, through reports, dashboards and imports', () => {
  it("reads a project's reports, and keeps a dashboard of their own with them", async () => {
    expect((await flowReport(dina, { project: 'WEB' })).scope.issues).toBe(1);
    expect((await burndownReport(dina, { board: 'Web board' })).sprint.name).toBe('W1');
    const d = await createDashboard(dina, { name: 'Web', widgets: [{ id: 'f', kind: 'report', params: { report: 'flow', project: 'WEB' } } as never] });
    expect(d.canEdit).toBe(true);
  });

  it("can't put an issue in a sprint or take it out, so a burndown changes only by those who may", async () => {
    const before = await w.app.db.select({ n: sql<number>`count(*)::int` }).from(activities).where(and(eq(activities.type, 'sprint.issue_removed')));
    const out = await failure(setSprintIssues(dina, webSprint, [webIssue], true));
    expect(out.status).toBe(403);
    expect(out.message).toContain('WEB');
    const later = await w.app.db.select({ n: sql<number>`count(*)::int` }).from(activities).where(and(eq(activities.type, 'sprint.issue_removed')));
    expect(later[0]!.n).toBe(before[0]!.n);
    expect((await burndownReport(admin, { board: 'Web board', by: 'count', timeZone: 'UTC' })).remaining).toBe(1);
    const extra = (await createIssue(admin, { project: 'WEB', summary: 'Another' })).id;
    expect((await failure(setSprintIssues(dina, webSprint, [extra], false))).status).toBe(403);
  });

  it("imports nothing, into a project they view or one they're a member of, and undoes nothing", async () => {
    const file = 'Summary\nOne\n';
    expect((await failure(uploadImport(dina, { project: 'WEB' }, csv(file)))).status).toBe(403);
    expect((await failure(uploadImport(ben, { project: 'BACK' }, csv(file)))).status).toBe(403);
    expect((await failure(uploadImport(vera, { project: 'BACK' }, csv(file)))).status).toBe(403);
    const web = await uploadImport(admin, { project: 'WEB' }, csv(file));
    for (const p of [getImport(dina, web.id), checkImport(dina, web.id), runImport(dina, web.id), undoImport(dina, web.id, { dryRun: true }), deleteImport(dina, web.id)]) {
      expect((await failure(p)).status).toBe(403);
    }
  });

  it("with a read-only account, keeps no dashboard and changes no one else's", async () => {
    expect((await failure(createDashboard(vera, { name: 'Mine' }))).status).toBe(403);
    const shared = await createDashboard(anna, { name: 'Open to all', shared: true });
    expect((await getDashboard(vera, shared.id!)).canEdit).toBe(false);
    expect((await failure(updateDashboard(vera, shared.id!, { name: 'Mine now' }))).status).toBe(403);
    expect((await failure(updateDashboard(dina, shared.id!, { name: 'Mine now' }))).status).toBe(403);
  });
});
