/**
 * Guests beyond issues (D64): someone not signed in reads the boards, reports, plans and whiteboards of
 * the projects an administrator opened to anyone, through the same seam as issues, and nothing else:
 * no other project, no limited issue or article, no private field, no money, no days away, no loads,
 * nobody looking; every write refused, the guest rate limit applying, and a project closed again closed.
 */
import type { Board, BoardView, Schedule, WhiteboardCard, WhiteboardDetail } from '@a4a/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../src/context';
import { createHttpApp } from '../src/http/app';
import { addDays, todayISO, weekday } from '../src/lib/dates';
import { createAbsence } from '../src/services/absences';
import { createArticle } from '../src/services/articles';
import { issueTokenFor } from '../src/services/auth';
import { createBoard, createSprint, setSprintIssues } from '../src/services/boards';
import { attachField, createField } from '../src/services/fields';
import { guestMayRequest } from '../src/services/guests';
import { createIssue, updateIssue } from '../src/services/issues';
import { addMember } from '../src/services/members';
import { createBaseline, getSchedule } from '../src/services/planning';
import { createProject, updateProject } from '../src/services/projects';
import { createRole } from '../src/services/roles';
import { applyWhiteboardBatch, createWhiteboard } from '../src/services/whiteboards';
import { GUEST_STREAM_LIMITS } from '../src/http/routes/whiteboards';
import { createWorld, type TestWorld } from './helpers';
import { openStream, type SseClient } from './sse-client';

let w: TestWorld;
let admin: Ctx;
let anna: Ctx;
let app: ReturnType<typeof createHttpApp>;
let annaToken = '';
/** The Monday at least a week from today, and the days of its week. */
let mon = '';
const day = (n: number) => addDays(mon, n);

type Answer = { status: number; body: unknown };
/** A request as a guest: no credentials at all. */
async function guest(method: string, path: string, body?: unknown): Promise<Answer> {
  const res = await app.request(`/api/v1${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // a CSV, or a stream
  }
  return { status: res.status, body: parsed };
}

/** An answer's words with an id taken out, to compare a hidden thing's answer with a missing one's. */
const words = (a: Answer, id: string) => JSON.stringify(a.body).split(id).join('X');

async function eventually(check: () => Promise<boolean>, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('never came true');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const ids = {
  open: '',
  limited: '',
  back: '',
  webBoard: '',
  bothBoard: '',
  backBoard: '',
  narrowBoard: '',
  sprintBoard: '',
  roadmap: '',
  backRoom: '',
  article: '',
  limitedArticle: '',
  baseline: '',
};

beforeAll(async () => {
  w = await createWorld();
  admin = w.adminCtx;
  anna = w.as(w.anna);
  const today = todayISO();
  mon = addDays(today, 7 + ((8 - weekday(today)) % 7));
  // Guests have a generous allowance here; their own limit is tested on an app of its own.
  w.app.config.guestRateLimit = 100_000;
  app = createHttpApp(w.app);
  annaToken = (await issueTokenFor(w.app.db, w.anna.id, { name: 'anna-guests', scopes: ['read', 'write'] })).token;

  // WEB is open to guests; BACK isn't. GPL, a plan, is too.
  await updateProject(admin, 'WEB', { guestAccess: true });
  await createProject(admin, { key: 'GPL', name: 'Garden plan', template: 'waterfall' });
  await updateProject(admin, 'GPL', { guestAccess: true, settings: { plan: { budget: 50_000 } } });

  // A field private in WEB (D50).
  const risk = await createField(admin, { name: 'Risk', type: 'enum', multi: false, description: '', values: [{ name: 'Low' }, { name: 'High' }] });
  await attachField(admin, 'WEB', risk.id, { private: true });

  const open = await createIssue(anna, { project: 'WEB', summary: 'Public roadmap page', fields: { Subsystem: 'UI' } });
  await updateIssue(admin, open.id, { fields: { Risk: 'High' } });
  const limited = await createIssue(anna, { project: 'WEB', summary: 'Pricing experiment', visibleTo: { users: [], groups: [] } });
  const back = await createIssue(anna, { project: 'BACK', summary: 'Rotate the database keys', fields: { Subsystem: 'API' } });
  Object.assign(ids, { open: open.id, limited: limited.id, back: back.id });

  ids.webBoard = (await createBoard(admin, { name: 'Web board', projects: ['WEB'] })).id;
  ids.bothBoard = (await createBoard(admin, { name: 'Both projects', projects: ['WEB', 'BACK'] })).id;
  ids.backBoard = (await createBoard(admin, { name: 'Back board', projects: ['BACK'] })).id;
  // A query naming a value only BACK has.
  ids.narrowBoard = (await createBoard(admin, { name: 'API work', projects: ['WEB', 'BACK'], query: 'Subsystem: API' })).id;
  const sprints = await createBoard(admin, { name: 'Web sprints', projects: ['WEB'], sprintsEnabled: true });
  ids.sprintBoard = sprints.id;
  const sprint = await createSprint(admin, sprints.id, { name: 'Sprint 1', startDate: day(-14), endDate: day(14) });
  await setSprintIssues(admin, sprint.id, [open.id, limited.id], false);

  ids.article = (await createArticle(anna, { project: 'WEB', title: 'How to contribute', body: 'Open a pull request.' })).id;
  ids.limitedArticle = (await createArticle(anna, { project: 'WEB', title: 'Partner terms', body: 'Kept to a few.', visibleTo: { users: ['anna'], groups: [] } })).id;

  const roadmap = await createWhiteboard(anna, { project: 'WEB', name: 'Roadmap' });
  ids.roadmap = roadmap.id;
  await applyWhiteboardBatch(anna, roadmap.id, {
    ops: [
      { op: 'add', id: 'note-1', kind: 'note', x: 0, y: 0, text: 'Ship the roadmap page' },
      { op: 'add', id: 'card-open', kind: 'issue', x: 300, y: 0, issue: open.id },
      { op: 'add', id: 'card-limited', kind: 'issue', x: 600, y: 0, issue: limited.id },
      { op: 'add', id: 'card-back', kind: 'issue', x: 900, y: 0, issue: back.id },
      { op: 'add', id: 'card-article', kind: 'article', x: 0, y: 300, article: ids.article },
      { op: 'add', id: 'card-limited-article', kind: 'article', x: 300, y: 300, article: ids.limitedArticle },
    ],
  });
  ids.backRoom = (await createWhiteboard(anna, { project: 'BACK', name: 'Back room' })).id;
});

afterAll(async () => {
  await w.close();
});

describe('boards', () => {
  it('lists the boards of guest-open projects, naming only those projects', async () => {
    const list = (await guest('GET', '/boards')).body as Board[];
    const names = list.map((b) => b.name);
    expect(names).toEqual(expect.arrayContaining(['Web board', 'Both projects', 'Web sprints']));
    expect(names).not.toContain('Back board');
    expect(list.find((b) => b.id === ids.bothBoard)!.projects.map((p) => p.key)).toEqual(['WEB']);
    // A board only a closed project has is missing, in the words of one that doesn't exist.
    expect(words(await guest('GET', `/boards/${ids.backBoard}`), ids.backBoard)).toBe(words(await guest('GET', '/boards/nope'), 'nope'));
    expect((await guest('GET', `/boards/${ids.backBoard}/view`)).status).toBe(404);
  });

  it('shows across projects only the cards a guest may see, and counts only those', async () => {
    const view = (await guest('GET', `/boards/${ids.bothBoard}/view`)).body as BoardView;
    const cards = view.columns.flatMap((c) => c.issues);
    expect(cards.map((i) => i.id)).toEqual([ids.open]);
    expect(view.order).toEqual([ids.open]);
    expect(view.columns.reduce((n, c) => n + c.count, 0)).toBe(1);
    // The private field isn't on the card (D50), and BACK's values aren't named.
    expect(cards[0]!.fields.map((f) => f.name)).not.toContain('Risk');
    expect(JSON.stringify(view)).not.toMatch(/Rotate the database|Pricing experiment|BACK/);
    // A sprint counts what a guest sees: the limited issue is in it, and not in its count.
    const sprint = (await guest('GET', `/boards/${ids.sprintBoard}/view`)).body as BoardView;
    expect(sprint.sprint).toMatchObject({ name: 'Sprint 1', issueCount: 1 });
  });

  it('says nothing of a query that names what a guest can’t see', async () => {
    const board = (await guest('GET', `/boards/${ids.narrowBoard}`)).body as Board;
    expect(board.query).toBeNull();
    const view = await guest('GET', `/boards/${ids.narrowBoard}/view`);
    expect(view.status).toBe(400);
    expect(JSON.stringify(view.body)).toContain('This board’s query names something you can’t see');
    expect(JSON.stringify(view.body)).not.toContain('API');
    // Whoever sees every project on it reads it whole.
    expect((await boardAsAnna(ids.narrowBoard)).query).toBe('Subsystem: API');
  });

  it('ranks, moves and plans nothing, and reads no backlog, velocity or sprint plan', async () => {
    const view = (await guest('GET', `/boards/${ids.sprintBoard}/view`)).body as BoardView;
    const sprint = view.sprint!.id;
    for (const [method, path, body] of [
      ['POST', `/boards/${ids.webBoard}/rank`, { issue: ids.open, column: 'Open' }],
      ['PATCH', `/boards/${ids.webBoard}`, { name: 'Mine now' }],
      ['DELETE', `/boards/${ids.webBoard}`, undefined],
      ['POST', '/boards', { name: 'Spam', projects: ['WEB'] }],
      ['POST', `/boards/${ids.sprintBoard}/sprints`, { name: 'Sprint 2' }],
      ['PATCH', `/sprints/${sprint}`, { name: 'Renamed' }],
      ['POST', `/sprints/${sprint}/issues`, { issues: [ids.open], remove: true }],
      ['GET', `/boards/${ids.sprintBoard}/backlog`, undefined],
      ['GET', `/boards/${ids.sprintBoard}/velocity`, undefined],
      ['GET', `/sprints/${sprint}/plan`, undefined],
    ] as const) {
      expect([method, path, (await guest(method, path, body)).status]).toEqual([method, path, 401]);
    }
  });
});

/** A board as Anna, who sees both its projects, reads it. */
async function boardAsAnna(id: string): Promise<Board> {
  const res = await app.request(`/api/v1/boards/${id}`, { headers: { authorization: `Bearer ${annaToken}` } });
  return (await res.json()) as Board;
}

describe('reports', () => {
  const window = `from=${encodeURIComponent(addDays(todayISO(), -6))}&to=${encodeURIComponent(todayISO())}`;
  const createdIn = (body: unknown) => ((body as { buckets: { created: number }[] }).buckets ?? []).reduce((n, b) => n + b.created, 0);

  it('count only the issues a guest sees, in the projects open to guests', async () => {
    const asGuest = await guest('GET', `/reports/created-resolved?project=WEB&${window}`);
    expect(asGuest.status).toBe(200);
    const asAnna = await app.request(`/api/v1/reports/created-resolved?project=WEB&${window}`, { headers: { authorization: `Bearer ${annaToken}` } });
    // Anna reported the limited issue, so she counts it; a guest doesn't.
    expect(createdIn(asGuest.body)).toBe(createdIn(await asAnna.json()) - 1);
    // Every project a guest sees: WEB and GPL, never BACK.
    const everywhere = await guest('GET', `/reports/issues-per-field?field=Project`);
    expect(JSON.stringify(everywhere.body)).not.toContain('BACK');
    const perField = (await guest('GET', '/reports/issues-per-field?project=WEB&field=Priority')).body as { total: number };
    expect(perField.total).toBe(1);
  });

  it('answer a closed project, or a private field, as one that doesn’t exist', async () => {
    expect(words(await guest('GET', `/reports/flow?project=BACK&${window}`), 'BACK')).toBe(words(await guest('GET', `/reports/flow?project=NOPE&${window}`), 'NOPE'));
    expect(words(await guest('GET', '/reports/issues-per-field?project=WEB&field=Risk'), 'Risk')).toBe(words(await guest('GET', '/reports/issues-per-field?project=WEB&field=Nonesuch'), 'Nonesuch'));
    // A burndown of a board guests can't see is a missing one.
    expect((await guest('GET', `/reports/burndown?board=${ids.backBoard}`)).status).toBe(404);
    const burn = await guest('GET', `/reports/burndown?board=${ids.sprintBoard}&by=count`);
    expect(burn.status).toBe(200);
  });

  it('come as CSV too, and never as the time report, which is the team’s', async () => {
    const csv = await guest('GET', `/reports/cycle-time.csv?project=WEB&${window}`);
    expect(csv.status).toBe(200);
    expect(String(csv.body)).not.toContain('Pricing experiment');
    expect((await guest('GET', `/reports/time?project=WEB&${window}`)).status).toBe(401);
    expect((await guest('GET', `/reports/time.csv?project=WEB&${window}`)).status).toBe(401);
  });
});

describe('plans', () => {
  beforeAll(async () => {
    await createIssue(anna, { project: 'GPL', summary: 'Lay the foundations', fields: { Assignee: 'anna', Estimation: '2d', 'Start date': day(0) } });
    // A window that falls on her day away: the engine warns that she's away.
    await createIssue(anna, { project: 'GPL', summary: 'Inspect the site', fields: { Assignee: 'anna', 'Start date': day(1), 'Due date': day(1) } });
    await createIssue(anna, { project: 'GPL', summary: 'Choose the contractor', fields: { Estimation: '1d' }, visibleTo: { users: [], groups: [] } });
    await createAbsence(anna, { from: day(1), kind: 'holiday', note: 'Lisbon' });
    ids.baseline = (await createBaseline(admin, 'GPL', { name: 'As agreed' })).id;
  });

  it('show a guest the plan’s tasks and dates, and none of its money, days away or limited tasks', async () => {
    const team = await getSchedule(admin, 'GPL');
    const answer = await guest('GET', '/projects/GPL/schedule');
    expect(answer.status).toBe(200);
    const s = answer.body as Schedule;
    expect(s.tasks.map((t) => t.issue.summary).sort()).toEqual(['Inspect the site', 'Lay the foundations']);
    // The same dates as the team's: worked out on everyone's own days.
    expect(s.finish).toBe(team.finish);
    expect(s.tasks.find((t) => t.issue.summary === 'Lay the foundations')!.finish).toBe(team.tasks.find((t) => t.issue.summary === 'Lay the foundations')!.finish);
    // No money: the team's plan has it.
    expect(team.tasks.some((t) => (t.plannedCost ?? 0) > 0)).toBe(true);
    expect(team.calendar.budget).toBe(50_000);
    expect(s.tasks.every((t) => t.plannedCost === null && t.actualCost === null)).toBe(true);
    expect(s.calendar.budget).toBeNull();
    // Nobody's days away, in the list or in a warning.
    expect(team.away.map((a) => a.assignee)).toEqual(['anna']);
    expect(team.warnings.some((x) => x.includes('away'))).toBe(true);
    expect(s.away).toEqual([]);
    expect(s.warnings.some((x) => x.includes('away'))).toBe(false);
    expect(JSON.stringify(s)).not.toMatch(/Lisbon|"kind"|Choose the contractor/);
    // The project's budget is money too.
    expect(((await guest('GET', '/projects/GPL')).body as { settings: { plan: { budget: number | null } } }).settings.plan.budget).toBeNull();
  });

  it('read no baseline, and answer one as a missing one', async () => {
    const real = await guest('GET', `/projects/GPL/schedule?baseline=${ids.baseline}`);
    expect(real.status).toBe(404);
    expect(words(real, ids.baseline)).toBe(words(await guest('GET', '/projects/GPL/schedule?baseline=nope'), 'nope'));
  });

  it('keep loads, costs, baselines, what-ifs and levelling to the team', async () => {
    for (const [method, path, body] of [
      ['GET', '/projects/GPL/resources', undefined],
      ['GET', '/projects/GPL/costs', undefined],
      ['GET', '/projects/GPL/baselines', undefined],
      ['GET', `/baselines/${ids.baseline}`, undefined],
      ['POST', '/projects/GPL/schedule/what-if', { overrides: [{ issue: 'GPL-1', delayDays: 2 }] }],
      ['POST', '/projects/GPL/level', { mode: 'within_slack', dryRun: true }],
      ['POST', '/projects/GPL/baselines', { name: 'Mine' }],
      ['GET', '/absences', undefined],
    ] as const) {
      expect([method, path, (await guest(method, path, body)).status]).toEqual([method, path, 401]);
    }
  });

  it('keep money from a role without the costs permission, by the permission, and days away from guests alone', async () => {
    await createRole(admin, { name: 'Onlooker', permissions: ['read'] });
    await addMember(admin, 'GPL', { user: 'ben', role: 'Onlooker' });
    const bens = await getSchedule(w.as(w.ben), 'GPL');
    expect(bens.tasks.every((t) => t.plannedCost === null)).toBe(true);
    expect(bens.calendar.budget).toBeNull();
    // Signed in, he reads when someone is away, as D36 has it.
    expect(bens.away.map((a) => a.assignee)).toEqual(['anna']);
  });

  it('answer a closed project’s plan as a missing project', async () => {
    expect(words(await guest('GET', '/projects/BACK/schedule'), 'BACK')).toBe(words(await guest('GET', '/projects/NOPE/schedule'), 'NOPE'));
  });
});

describe('whiteboards', () => {
  const streams: SseClient[] = [];
  const guestStream = () => openStream(app.request, null, { path: `/api/v1/whiteboards/${ids.roadmap}/stream` });
  afterAll(async () => {
    for (const s of streams) await s.close();
  });

  it('list and read the whiteboards of guest-open projects, each card as a guest may see it', async () => {
    const list = (await guest('GET', '/whiteboards')).body as { id: string; name: string }[];
    expect(list.map((b) => b.name)).toContain('Roadmap');
    expect(list.map((b) => b.name)).not.toContain('Back room');
    expect(words(await guest('GET', `/whiteboards/${ids.backRoom}`), ids.backRoom)).toBe(words(await guest('GET', '/whiteboards/nope'), 'nope'));

    const d = (await guest('GET', `/whiteboards/${ids.roadmap}`)).body as WhiteboardDetail;
    expect(d.whiteboard.access).toEqual({ edit: false, delete: false });
    const byElement = new Map(d.cards.map((c) => [c.element, c]));
    expect(byElement.get('card-open')).toMatchObject({ shown: true, id: ids.open, summary: 'Public roadmap page' });
    expect(byElement.get('card-article')).toMatchObject({ shown: true, summary: 'How to contribute' });
    // A limited issue, another project's issue and a limited article: each only hidden, the same way.
    for (const hidden of ['card-limited', 'card-back', 'card-limited-article']) expect(byElement.get(hidden)).toEqual({ element: hidden, shown: false });
    expect(JSON.stringify(d)).not.toMatch(/Pricing experiment|Rotate the database|Partner terms/);
    const cards = (await guest('GET', `/whiteboards/${ids.roadmap}/cards`)).body as WhiteboardCard[];
    expect(cards.filter((c) => c.shown).length).toBe(2);
  });

  it('streams the changes live to a guest, who is never told who’s looking, nor counted', async () => {
    const annas = await openStream(app.request, annaToken, { path: `/api/v1/whiteboards/${ids.roadmap}/stream` });
    streams.push(annas);
    const mine = await guestStream();
    streams.push(mine);
    await mine.waitFor((f) => f.event === 'ready');
    await annas.waitFor((f) => f.event === 'viewers' && (JSON.parse(f.data) as unknown[]).length === 1);
    // While both are open, the detail a guest reads names nobody looking.
    expect(((await guest('GET', `/whiteboards/${ids.roadmap}`)).body as WhiteboardDetail).viewers).toEqual([]);
    await applyWhiteboardBatch(anna, ids.roadmap, { ops: [{ op: 'add', id: 'note-live', kind: 'note', x: 0, y: 600, text: 'Seen live' }] });
    const frame = await mine.waitFor((f) => f.event === 'change', 3_000);
    expect(JSON.parse(frame.data)).toMatchObject({ elements: [{ id: 'note-live', text: 'Seen live' }] });
    expect(mine.frames.some((f) => f.event === 'viewers')).toBe(false);
    // Anna's stream still counts one viewer, herself.
    const lastViewers = annas.frames.filter((f) => f.event === 'viewers').at(-1)!;
    expect((JSON.parse(lastViewers.data) as { user: { login: string } }[]).map((v) => v.user.login)).toEqual(['anna']);
    expect((await guest('GET', `/whiteboards/${ids.roadmap}/presence`)).status).toBe(401);
    expect((await guest('PUT', `/whiteboards/${ids.roadmap}/presence`)).status).toBe(401);
  });

  it('holds a few open streams per address, and frees one as it closes', async () => {
    // One guest stream is open from the test before.
    for (let i = 1; i < GUEST_STREAM_LIMITS.perAddress; i++) streams.push(await guestStream());
    const refused = await guest('GET', `/whiteboards/${ids.roadmap}/stream`);
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: { message: 'Too many whiteboards are open live without signing in', key: 'whiteboards.guestStreams' } });
    await streams.pop()!.close();
    await eventually(async () => {
      const res = await app.request(`/api/v1/whiteboards/${ids.roadmap}/stream`, { headers: { accept: 'text/event-stream' } });
      const ok = res.status === 200;
      await res.body?.cancel();
      return ok;
    });
  });

  it('changes nothing for a guest', async () => {
    for (const [method, path, body] of [
      ['POST', `/whiteboards/${ids.roadmap}/elements`, { ops: [{ op: 'remove', id: 'note-1' }] }],
      ['POST', `/whiteboards/${ids.roadmap}/convert`, { project: 'WEB', notes: ['note-1'] }],
      ['PATCH', `/whiteboards/${ids.roadmap}`, { name: 'Mine' }],
      ['DELETE', `/whiteboards/${ids.roadmap}`, undefined],
      ['POST', '/whiteboards', { project: 'WEB', name: 'Spam' }],
    ] as const) {
      expect([method, path, (await guest(method, path, body)).status]).toEqual([method, path, 401]);
    }
    expect(((await guest('GET', `/whiteboards/${ids.roadmap}`)).body as WhiteboardDetail).elements.some((e) => e.id === 'note-1')).toBe(true);
  });
});

describe('the rest stays as D37 has it', () => {
  it('limits guests per address on every new route, apart from people who sign in', async () => {
    w.app.config.guestRateLimit = 30;
    const limited = createHttpApp(w.app);
    w.app.config.guestRateLimit = 100_000;
    const statuses: number[] = [];
    for (let i = 0; i < 36; i++) statuses.push((await limited.request(`/api/v1/boards/${ids.webBoard}/view`)).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses).toContain(429);
    expect((await limited.request('/api/v1/boards', { headers: { authorization: `Bearer ${annaToken}` } })).status).toBe(200);
  });

  it('says in OpenAPI which routes answer a guest, and they are the ones a guest reaches', async () => {
    const doc = (await (await app.request('/api/v1/openapi.json')).json()) as { paths: Record<string, Record<string, { security?: Record<string, unknown>[] }>> };
    const wrong: string[] = [];
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        const said = (op.security ?? []).some((r) => Object.keys(r).length === 0) && (op.security ?? []).length > 0;
        const reaches = guestMayRequest(method.toUpperCase(), path.replace(/\{[^}]+\}/g, 'X-1'));
        if (said !== reaches) wrong.push(`${method.toUpperCase()} ${path}: ${said ? 'said, not reached' : 'reached, not said'}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(doc.paths['/boards/{id}/view']!.get!.security).toContainEqual({});
  });

  it('closes everything again when the project is closed to guests', async () => {
    const open = await openStream(app.request, null, { path: `/api/v1/whiteboards/${ids.roadmap}/stream` });
    await open.waitFor((f) => f.event === 'ready');
    await updateProject(admin, 'WEB', { guestAccess: false });
    await applyWhiteboardBatch(anna, ids.roadmap, { ops: [{ op: 'update', id: 'note-1', set: { x: 40 } }] });
    await open.waitFor((f) => f.event === 'gone', 5_000);
    await open.close();
    expect(((await guest('GET', '/boards')).body as Board[]).some((b) => b.projects.some((p) => p.key === 'WEB'))).toBe(false);
    expect((await guest('GET', `/boards/${ids.webBoard}/view`)).status).toBe(404);
    expect((await guest('GET', `/whiteboards/${ids.roadmap}`)).status).toBe(404);
    expect((await guest('GET', `/reports/flow?project=WEB`)).status).toBe(404);
    expect((await guest('GET', '/projects/WEB/schedule')).status).toBe(404);
    // GPL is still open.
    expect((await guest('GET', '/projects/GPL/schedule')).status).toBe(200);
  });
});
