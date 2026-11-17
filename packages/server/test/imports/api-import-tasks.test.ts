/**
 * Importing from Asana and ClickUp (docs/architecture.md, D61), through D29's path: tasks read over
 * the API page by page into rows, mapped as an export's columns are, checked, run with the token
 * again for the files, run again without making anything twice, and undone. Against fakes of their
 * APIs on this machine, shaped as their documentation gives the answers.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../src/context';
import { activities, attachments, comments, externalIssues, importRows, imports, issueWatchers, workItems } from '../../src/db/schema';
import { asanaToMarkdown, deltaToMarkdown } from '../../src/imports/markup';
import { baseAddress, paging } from '../../src/imports/readers';
import { checklistsMarkdown } from '../../src/imports/readers-tasks';
import { checkProblemWords } from '../../src/lib/errors';
import { continueFetch, importFromApi, waitForFetch } from '../../src/services/api-imports';
import { checkImport, getImport, importRowsOf, runImport, undoImport, waitForImport } from '../../src/services/imports';
import { getIssue } from '../../src/services/issues';
import { createProject } from '../../src/services/projects';
import { updateUser } from '../../src/services/users';
import { presentField } from '../../src/tools/registry';
import { createWorld, type TestWorld } from '../helpers';
import { json, serve, type Fake } from './fake-trackers';

let w: TestWorld;
let admin: Ctx;
const fakes: Fake[] = [];
const pageSize = paging.pageSize;
const at = (d: number, h = 9) => new Date(Date.UTC(2026, 2, d, h)).toISOString();
const msAt = (d: number, h = 9) => String(Date.UTC(2026, 2, d, h));
const field = (i: Awaited<ReturnType<typeof getIssue>>, name: string) => presentField(i.fields.find((f) => f.name === name)!);

/** Everything the console was told while a test ran: a token must never be in it. */
const logged: string[] = [];

beforeAll(async () => {
  w = await createWorld({ config: { importAllowHttpLoopback: true } });
  admin = w.adminCtx;
  await updateUser(admin, 'admin', { email: 'ada@example.com' });
  await updateUser(admin, 'anna', { email: 'anna@example.com' });
  await updateUser(admin, 'ben', { email: 'ben@example.com' });
  for (const key of ['ASA', 'ASB', 'CLK']) await createProject(admin, { key, name: `Tasks ${key}`, template: 'software' });
  for (const level of ['error', 'warn', 'log', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
});

afterAll(async () => {
  vi.restoreAllMocks();
  for (const f of fakes) await f.close();
  await w.close();
});

afterEach(() => {
  paging.pageSize = pageSize;
});

/** Every place a token could have been written down. */
async function everythingKept(): Promise<string> {
  const rows = await w.app.db.execute(
    sql`SELECT coalesce((SELECT json_agg(i)::text FROM imports i), '') || coalesce((SELECT json_agg(r)::text FROM import_rows r), '') || coalesce((SELECT json_agg(a)::text FROM activities a), '') || coalesce((SELECT json_agg(e)::text FROM external_issues e), '') || coalesce((SELECT json_agg(c)::text FROM comments c), '') AS all`,
  );
  const list = (rows as unknown as { rows?: { all: string }[] }).rows ?? (rows as unknown as { all: string }[]);
  return list[0]?.all ?? '';
}

/** A refusal, as the API would answer it: its words must be the catalog's (D49). */
async function refusal(p: Promise<unknown>) {
  const e = (await p.catch((x: unknown) => x)) as { status?: number; message: string; hint?: string; words?: { key: string; values?: Record<string, string | number> } };
  expect(e).toBeInstanceOf(Error);
  if (e.words) checkProblemWords(e.message, e.hint, e.words);
  return e;
}

async function fetched(started: { id: string }) {
  await waitForFetch(started.id);
  const imp = await getImport(admin, started.id);
  expect(imp.status, imp.error ?? '').toBe('ready');
  return imp;
}

async function ran(id: string, credentials?: { token: string }) {
  await runImport(admin, id, { credentials });
  await waitForImport(id);
  const done = await getImport(admin, id);
  expect(done.status, done.error ?? '').toBe('done');
  const rows = await importRowsOf(admin, id, { offset: 0, limit: 50 });
  return { done, made: new Map(rows.items.map((r) => [r.key, r.issue!])) };
}

async function uidOf(readable: string): Promise<string> {
  const [ex] = await w.app.db.select({ issueId: externalIssues.issueId }).from(externalIssues).where(eq(externalIssues.readableId, readable));
  return ex!.issueId!;
}

async function watchersOf(readable: string): Promise<Record<string, string>> {
  const rows = await w.app.db.select({ userId: issueWatchers.userId, reason: issueWatchers.reason }).from(issueWatchers).where(eq(issueWatchers.issueId, await uidOf(readable)));
  const login = (id: string) => [w.admin, w.anna, w.ben].find((u) => u.id === id)?.login ?? id;
  return Object.fromEntries(rows.map((r) => [login(r.userId), r.reason]));
}

describe('rich text as Markdown', () => {
  it("turns Asana's rich text into Markdown", () => {
    expect(
      asanaToMarkdown(
        '<body><h1>Why</h1>We launch in <strong>May</strong> &amp; <em>June</em>.\nSee <a href="https://example.com/plan">the plan</a>, ask <a data-asana-gid="42" data-asana-type="user" href="https://app.asana.com/0/42">@Anna</a>.\n\n<ol><li>Press<ul><li>Blog</li></ul></li><li><code>npm run ship</code></li></ol><blockquote>Quoted</blockquote><pre>x &lt; 1</pre><hr/><table><tr><td>a</td><td>b|c</td></tr><tr><td>1</td><td>2</td></tr></table><u>under</u> <s>gone</s></body>',
      ),
    ).toBe(
      [
        '# Why',
        'We launch in **May** & *June*.  \nSee [the plan](https://example.com/plan), ask @Anna.',
        '1. Press\n   - Blog\n2. `npm run ship`',
        '> Quoted',
        '```\nx < 1\n```',
        '---',
        '| a | b\\|c |\n| --- | --- |\n| 1 | 2 |',
        'under ~~gone~~',
      ].join('\n\n'),
    );
    expect(asanaToMarkdown(null)).toBe('');
    expect(asanaToMarkdown('<body>Unclosed <strong>bold')).toBe('Unclosed **bold**');
  });

  it("turns ClickUp's comment blocks into Markdown, and its checklists into Markdown's", () => {
    expect(
      deltaToMarkdown([
        { text: 'Shipped to ' },
        { text: 'beta', attributes: { bold: true } },
        { text: ', thanks ' },
        { type: 'tag', user: { username: 'Ben Okafor' } },
        { text: '\nNotes', attributes: { link: 'https://example.com/notes' } },
        { text: '\n' },
        { text: 'one' },
        { text: '\n', attributes: { list: { list: 'bullet' } } },
        { text: 'done' },
        { text: '\n', attributes: { list: { list: 'checked' } } },
        { text: 'make ship' },
        { text: '\n', attributes: { 'code-block': { 'code-block': 'plain' } } },
      ]),
    ).toBe('Shipped to **beta**, thanks @Ben Okafor\n\n[Notes](https://example.com/notes)\n\n- one\n- [x] done\n\n```\nmake ship\n```');
    expect(deltaToMarkdown('not blocks')).toBeNull();
    expect(
      checklistsMarkdown([
        { name: 'Release', orderindex: 0, items: [{ name: 'Write notes', resolved: false, orderindex: 1, children: [{ name: 'Changelog', resolved: true }] }, { name: 'Tag the build', resolved: true, orderindex: 0 }] },
        { name: 'Empty', items: [] },
      ]),
    ).toBe('**Release**\n\n- [x] Tag the build\n- [ ] Write notes\n  - [x] Changelog');
  });
});

describe('where an import from Asana or ClickUp reads', () => {
  const policy = { allowHosts: [], allowHttpLoopback: false };
  it("reads their APIs from the address people open them at, and nothing inside the network", () => {
    expect(baseAddress(policy, 'asana', 'https://app.asana.com/0/1204/list').href).toBe('https://app.asana.com/');
    expect(baseAddress(policy, 'clickup', 'https://app.clickup.com/9012/v/li/901').href).toBe('https://api.clickup.com/');
    expect(() => baseAddress(policy, 'asana', 'http://app.asana.com')).toThrow('a4a reads other trackers over https only');
    expect(() => baseAddress(policy, 'clickup', 'https://192.168.1.10')).toThrow('192.168.1.10 is inside the network, and a4a reads only from public addresses');
    expect(() => baseAddress(policy, 'asana', 'https://169.254.169.254/latest')).toThrow(/inside the network/);
  });
});

// ---------------------------------------------------------------------------
// Asana
// ---------------------------------------------------------------------------

// Made-up tokens in each service's shape, put together here so no scanner takes a literal for a real one.
const AS_TOKEN = ['2', '1204000000000000', '1205999999999999'].join('/') + ':' + '0f1e2d3c'.repeat(4);
const anna = { gid: '9001', name: 'Anna Schmidt', email: 'anna@example.com' };
const ben = { gid: '9002', name: 'Ben Okafor', email: 'ben@example.com' };
const ada = { gid: '9003', name: 'Ada Admin', email: 'ada@example.com' };
const zed = { gid: '9004', name: 'Zed Remote' };

function asanaTasks() {
  const inProject = (section: string) => [{ project: { gid: '111' }, section: { name: section } }, { project: { gid: '222' }, section: { name: 'Elsewhere' } }];
  return {
    t1: {
      gid: '1001',
      name: 'Plan the launch',
      resource_subtype: 'default_task',
      html_notes: '<body>We launch in <strong>May</strong>.\n<ul><li>Press</li><li>Docs</li></ul></body>',
      completed: false,
      created_at: at(1),
      modified_at: at(2),
      due_on: '2026-05-01',
      start_on: '2026-04-01',
      assignee: anna,
      followers: [ben, zed],
      created_by: zed,
      tags: [{ name: 'launch' }],
      memberships: inProject('In progress'),
      num_subtasks: 2,
      custom_fields: [
        { name: 'Priority', resource_subtype: 'enum', enum_value: { name: 'High' } },
        { name: 'Platforms', resource_subtype: 'multi_enum', multi_enum_values: [{ name: 'iOS' }, { name: 'Android' }] },
        { name: 'Effort', resource_subtype: 'number', number_value: 5 },
        { name: 'Customer', resource_subtype: 'text', text_value: 'Acme' },
        { name: 'Review date', resource_subtype: 'date', date_value: { date: '2026-04-15', date_time: null } },
        { name: 'Reviewers', resource_subtype: 'people', people_value: [anna] },
        { name: 'State', resource_subtype: 'text', text_value: 'Theirs' },
      ],
      dependencies: [{ gid: '1003' }, { gid: '4040' }],
    } as Record<string, unknown>,
    t1a: { gid: '1011', name: 'Write the press release', completed: true, completed_at: at(3), created_at: at(1, 10), modified_at: at(3), parent: { gid: '1001' }, num_subtasks: 0, memberships: [] },
    t2: { gid: '1002', name: 'Pick a date', completed: true, completed_at: at(5), created_at: at(1), modified_at: at(5), memberships: inProject('Done'), num_subtasks: 0, tags: [] },
    t3: { gid: '1003', name: 'Launch day', resource_subtype: 'milestone', completed: false, created_at: at(2), modified_at: at(2), memberships: inProject('To do'), num_subtasks: 0 },
  };
}

interface FakeAsana extends Fake {
  tasks: ReturnType<typeof asanaTasks>;
  stories: Record<string, unknown>[];
  slowDown: boolean;
  failPage2: number;
  expireOffset: number;
  downloads: { auth: string | undefined }[];
}

async function fakeAsana(): Promise<FakeAsana> {
  const media = await serve((req, url, _body, res) => {
    fake.downloads.push({ auth: req.headers.authorization });
    if (url.pathname === '/s3/brief.txt' && url.searchParams.get('sig') === 'fresh') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('Launch brief.');
      return;
    }
    res.writeHead(403);
    res.end();
  });
  fakes.push(media);
  const page = (data: unknown[], next: string | null) => ({ data, next_page: next ? { offset: next, path: '/x', uri: 'https://x' } : null });
  const fake = (await serve((req, url, _body, res) => {
    const p = url.pathname.replace(/^\/api\/1\.0/, '');
    if (req.headers.authorization !== `Bearer ${AS_TOKEN}`) return json(res, 401, { errors: [{ message: 'Not Authorized' }] });
    if (p === '/users/me') return json(res, 200, { data: { gid: '1', name: 'Ima Porter', email: 'ima@acme.example' } });
    if (p === '/projects/111') return json(res, 200, { data: { gid: '111', name: 'Launch' } });
    if (p === '/projects/999') return json(res, 403, { errors: [{ message: 'You do not have access to this project' }] });
    if (p.startsWith('/projects/') && !p.startsWith('/projects/111')) return json(res, 404, { errors: [{ message: `project: Unknown object: ${p.split('/')[2]}` }] });
    if (p === '/projects/111/task_counts') return json(res, 200, { data: { num_tasks: 3 } });
    const t = fake.tasks;
    if (p === '/projects/111/tasks') {
      const offset = url.searchParams.get('offset');
      if (!offset) return json(res, 200, page([t.t1, t.t2], 'o2'));
      if (offset === 'o2' && fake.slowDown) {
        fake.slowDown = false;
        return json(res, 429, { errors: [{ message: 'You have made too many requests recently.' }] }, { 'retry-after': '1' });
      }
      if (offset === 'o2' && fake.failPage2 > 0) {
        fake.failPage2--;
        return json(res, 500, { errors: [{ message: `Server error while reading for ${AS_TOKEN}` }] });
      }
      if (offset === 'o2' && fake.expireOffset > 0) {
        fake.expireOffset--;
        return json(res, 400, { errors: [{ message: 'offset: Your pagination token has expired.' }] });
      }
      if (offset === 'o2') return json(res, 200, page([t.t3], null));
      return json(res, 400, { errors: [{ message: 'offset: Your pagination token has expired.' }] });
    }
    if (p === '/tasks/1001/subtasks') return json(res, 200, page([t.t1a], null));
    if (/^\/tasks\/\d+\/subtasks$/.test(p)) return json(res, 200, page([], null));
    if (p === '/tasks/1001/stories') return json(res, 200, page(fake.stories, null));
    if (/^\/tasks\/\d+\/stories$/.test(p)) return json(res, 200, page([{ gid: 's9', type: 'system', text: 'created this task', created_at: at(1) }], null));
    if (p === '/attachments') {
      if (url.searchParams.get('parent') !== '1001') return json(res, 200, page([], null));
      return json(res, 200, page([{ gid: '7001', name: 'brief.txt', size: 13, host: 'asana', created_at: at(1, 12) }, { gid: '7002', name: 'Plan in Drive', host: 'gdrive', created_at: at(1, 12) }], null));
    }
    if (p === '/attachments/7001') return json(res, 200, { data: { gid: '7001', download_url: `${media.url}/s3/brief.txt?sig=fresh` } });
    json(res, 404, { errors: [{ message: 'Not found' }] });
  })) as FakeAsana;
  fake.tasks = asanaTasks();
  fake.stories = [
    { gid: 's1', type: 'comment', resource_subtype: 'comment_added', html_text: '<body>Looks <em>good</em> to me</body>', text: 'Looks good to me', created_at: at(2, 11), created_by: anna },
    { gid: 's2', type: 'system', resource_subtype: 'assigned', text: 'assigned to Anna Schmidt', created_at: at(2, 12), created_by: ben },
  ];
  fake.slowDown = true;
  fake.failPage2 = 0;
  fake.expireOffset = 0;
  fake.downloads = [];
  fakes.push(fake);
  return fake;
}

describe('Asana', () => {
  let asana: FakeAsana;
  const credentials = { token: AS_TOKEN };
  beforeAll(async () => {
    asana = await fakeAsana();
  });

  it("says at once when the token, the project or the address is wrong: a private project as a missing one, and never the token", async () => {
    const start = (query: string, token = AS_TOKEN, url = asana.url) => importFromApi(admin, { project: 'ASA', source: 'asana', url, query, credentials: { token } });
    const wrong = await refusal(start('111', 'not-the-token-1234'));
    expect(wrong).toMatchObject({ status: 400, message: "Asana didn't accept the token" });
    expect(wrong.hint).toMatch(/personal access token/);
    expect(JSON.stringify(wrong)).not.toContain('not-the-token-1234');
    const hidden = await refusal(start('999'));
    const missing = await refusal(start('998'));
    expect(hidden).toMatchObject({ status: 400, message: 'Asana has no project 999 the token can see' });
    expect(hidden.message.replace('999', '998')).toBe(missing.message);
    expect(await refusal(start('launch'))).toMatchObject({ message: '"launch" isn\'t an Asana project' });
    expect(await refusal(importFromApi(admin, { project: 'ASA', source: 'asana', url: asana.url, query: '111', credentials: { token: AS_TOKEN, email: 'ima@acme.example' } }))).toMatchObject({ message: 'Asana takes a token alone' });
    expect(await refusal(start('111', AS_TOKEN, 'https://10.0.0.5'))).toMatchObject({ message: '10.0.0.5 is inside the network, and a4a reads only from public addresses' });
    expect(await w.app.db.select().from(imports).where(eq(imports.source, 'asana'))).toEqual([]);
  });

  it("reads a project's tasks page by page, waiting out a 429, with their subtasks, comments and files, and maps them", async () => {
    paging.pageSize = 2;
    const started = await importFromApi(admin, { project: 'ASA', source: 'asana', url: `${asana.url}/0/111/list`, query: 'https://app.asana.com/0/111/list', credentials });
    expect(started.origin).toMatchObject({ kind: 'asana', url: asana.url, query: 'https://app.asana.com/0/111/list', account: 'Ima Porter', bring: { work: false }, fetch: { total: 3 } });
    const imp = await fetched(started);
    // Three tasks and a subtask; its other subtask the token can't read is left out, and counted.
    expect(imp.rows).toBe(4);
    expect(imp.origin!.fetch).toMatchObject({ complete: true, issues: 4, comments: 1, files: 1, fileBytes: 13, left: { issues: 1, comments: 0, keys: [] } });
    expect(asana.seen.filter((s) => s.path === '/api/1.0/projects/111/tasks').map((s) => [s.query.get('offset'), s.query.get('limit')])).toEqual([
      [null, '2'],
      ['o2', '2'],
      ['o2', '2'],
    ]);
    const target = (name: string) => imp.columns.find((c) => c.name === name)?.target;
    expect(
      Object.fromEntries(['Issue key', 'Summary', 'Description', 'Reporter', 'Created', 'Resolved', 'State', 'Section', 'Type', 'Assignee', 'Watchers', 'Tags', 'Due date', 'Parent', 'depends on', 'Priority', 'State (field)'].map((n) => [n, target(n)])),
    ).toEqual({
      'Issue key': 'key',
      Summary: 'summary',
      Description: 'description',
      Reporter: 'reporter',
      Created: 'created',
      Resolved: 'resolved',
      State: 'field:State',
      Section: 'ignore',
      Type: 'field:Type',
      Assignee: 'field:Assignee',
      Watchers: 'watchers',
      Tags: 'tags',
      'Due date': 'field:Due date',
      Parent: 'parent',
      'depends on': 'link:depends on',
      Priority: 'field:Priority',
      'State (field)': 'ignore',
    });
    // Each kind of custom field, as a cell.
    const sample = (name: string) => imp.columns.find((c) => c.name === name)?.samples[0];
    expect(['Platforms', 'Effort', 'Customer', 'Review date', 'Reviewers'].map(sample)).toEqual(['iOS, Android', '5', 'Acme', '2026-04-15', 'Anna Schmidt <anna@example.com>']);
    // People by their email; someone Asana gives no email for, and who isn't here, is nobody.
    expect(imp.values.find((v) => v.target === 'field:Assignee')!.items).toEqual([{ value: 'Anna Schmidt <anna@example.com>', count: 1, to: 'anna', found: true }]);
    expect(imp.values.find((v) => v.target === 'watchers')!.items).toEqual([
      { value: 'Ben Okafor <ben@example.com>', count: 1, to: 'ben', found: true },
      { value: 'Zed Remote', count: 1, to: null, found: false },
    ]);
    expect(imp.values.find((v) => v.target === 'field:State')!.items.map((i) => [i.value, i.to])).toEqual([
      ['Completed', 'Done'],
      ['In progress', 'In Progress'],
      ['To do', 'Open'],
    ]);
    expect(JSON.stringify(imp)).not.toContain(AS_TOKEN);
  });

  it('checks, then runs with the token again for the files: states, people, watchers, subtasks, dependencies, comments and files', async () => {
    const [{ id }] = await w.app.db.select({ id: imports.id }).from(imports).where(eq(imports.source, 'asana'));
    const check = await checkImport(admin, id!);
    expect(check.counts).toMatchObject({ created: 4, comments: 1, files: 1, links: 2, linksMissing: 1, failed: 0 });
    expect(check.problems.map((p) => p.message)).toContain('4040 is neither in this file nor imported before, so its link is left out');
    expect(check.warnings.join(' ')).toMatch(/1 issue is for only some people to see in Asana, so it is left out\./);

    expect(await refusal(runImport(admin, id!))).toMatchObject({ status: 400, message: 'It brings 1 file from Asana, and a4a needs the token again to download them' });
    const { done, made } = await ran(id!, credentials);
    expect(done.result).toMatchObject({ created: 4, comments: 1, files: 1, failed: 0 });

    const t1 = await getIssue(admin, made.get('1001')!);
    expect([t1.summary, t1.description, field(t1, 'State'), field(t1, 'Priority'), field(t1, 'Assignee'), field(t1, 'Due date'), t1.reporter]).toEqual([
      'Plan the launch',
      'We launch in **May**.\n\n- Press\n- Docs',
      'In Progress',
      'Critical',
      'anna',
      '2026-05-01',
      null,
    ]);
    expect(t1.tags.map((t) => t.name)).toEqual(['launch']);
    expect(t1.createdAt).toBe(at(1));
    expect(t1.links.filter((l) => l.phrase === 'depends on').map((l) => l.issue.id)).toEqual([made.get('1003')]);
    // Its followers watch it here, as its assignee does; Zed isn't here.
    expect(await watchersOf(made.get('1001')!)).toEqual({ anna: 'assignee', ben: 'explicit' });
    // A completed task is resolved, when it was completed, and a subtask is a subtask.
    const sub = await getIssue(admin, made.get('1011')!);
    expect([field(sub, 'State'), sub.resolvedAt]).toEqual(['Done', at(3)]);
    expect(sub.links.filter((l) => l.phrase === 'subtask of').map((l) => l.issue.id)).toEqual([made.get('1001')]);
    expect(field(await getIssue(admin, made.get('1003')!), 'State')).toBe('Open');

    const id1 = await uidOf(made.get('1001')!);
    const said = await w.app.db.select().from(comments).where(eq(comments.issueId, id1));
    expect(said.map((c) => [c.text, c.authorId, c.createdAt.toISOString()])).toEqual([['Looks *good* to me', w.anna.id, at(2, 11)]]);
    // Its file, from where Asana says it is now, without the token: that's another origin.
    const [brief] = await w.app.db.select().from(attachments).where(eq(attachments.issueId, id1));
    expect(brief).toMatchObject({ name: 'brief.txt', size: 13, uploadedById: w.admin.id });
    expect(asana.downloads).toEqual([{ auth: undefined }]);
    // Quietly: every activity of the import says so.
    const acts = await w.app.db.select({ data: sql<unknown>`${activities.payload}->'data'->'imported'` }).from(activities).where(eq(activities.issueId, id1));
    expect(acts.length).toBeGreaterThan(2);
    expect(acts.every((a) => a.data)).toBe(true);
    expect(await everythingKept()).not.toContain(AS_TOKEN);
  });

  it('runs again from a new fetch: only what changed there, nothing twice, no file brought again, a new follower watching', async () => {
    asana.tasks.t1.name = 'Plan the May launch';
    asana.tasks.t1.modified_at = at(9);
    asana.tasks.t1.followers = [ben, zed, ada];
    asana.stories.push({ gid: 's3', type: 'comment', html_text: '<body>Dates are set.</body>', created_at: at(9), created_by: ben });
    const issuesBefore = (await w.app.db.select({ n: sql<number>`count(*)::int` }).from(externalIssues))[0]!.n;
    const again = await fetched(await importFromApi(admin, { project: 'ASA', source: 'asana', url: asana.url, query: '111', credentials }));
    const check = await checkImport(admin, again.id);
    expect(check.counts).toMatchObject({ created: 0, updated: 1, unchanged: 3, comments: 1, files: 0 });
    const { done, made } = await ran(again.id, credentials);
    expect(done.result).toMatchObject({ created: 0, updated: 1, unchanged: 3, comments: 1, files: 0 });
    expect(asana.downloads).toHaveLength(1);
    expect((await w.app.db.select({ n: sql<number>`count(*)::int` }).from(externalIssues))[0]!.n).toBe(issuesBefore);
    const t1 = await getIssue(admin, made.get('1001')!);
    expect(t1.summary).toBe('Plan the May launch');
    expect(await watchersOf(made.get('1001')!)).toEqual({ anna: 'assignee', ben: 'explicit', admin: 'explicit' });
    const said = await w.app.db.select({ text: comments.text }).from(comments).where(eq(comments.issueId, await uidOf(made.get('1001')!)));
    expect(said.map((c) => c.text).sort()).toEqual(['Dates are set.', 'Looks *good* to me']);
  });

  it('undoes the import: the issues it made go, their files with them', async () => {
    const [first] = await w.app.db.select({ id: imports.id }).from(imports).where(eq(imports.source, 'asana')).orderBy(imports.createdAt).limit(1);
    const preview = await undoImport(admin, first!.id, { dryRun: true });
    expect([preview.remove.length, preview.keep]).toEqual([4, []]);
    expect((await undoImport(admin, first!.id, { dryRun: false })).remove).toHaveLength(4);
    expect(await w.app.db.select({ id: attachments.id }).from(attachments).where(eq(attachments.name, 'brief.txt'))).toEqual([]);
    expect(await w.app.db.select().from(externalIssues).where(eq(externalIssues.source, 'asana'))).toEqual([]);
  });

  it('carries on a fetch that stopped from its last page, with the token again, reading nothing twice', async () => {
    paging.pageSize = 2;
    asana.failPage2 = 1;
    const storiesBefore = asana.seen.filter((s) => s.path === '/api/1.0/tasks/1001/stories').length;
    const subtasksBefore = asana.seen.filter((s) => s.path === '/api/1.0/tasks/1001/subtasks').length;
    const started = await importFromApi(admin, { project: 'ASB', source: 'asana', url: asana.url, query: '111', credentials, bring: { files: false } });
    await waitForFetch(started.id);
    const stopped = await getImport(admin, started.id);
    expect(stopped.status).toBe('failed');
    expect(stopped.error).toBe('It stopped reading: Asana answered 500: Server error while reading for … Try again later: what has been read so far is kept.');
    expect([stopped.rows, stopped.origin!.fetch.complete]).toEqual([3, false]);
    expect(await refusal(continueFetch(admin, started.id, { token: 'wrong-token-5678' }))).toMatchObject({ message: "Asana didn't accept the token" });
    // A refused place is read past once, from the first page; refused again, the fetch stops rather than go round.
    asana.expireOffset = 2;
    await continueFetch(admin, started.id, credentials);
    await waitForFetch(started.id);
    expect((await getImport(admin, started.id)).error).toBe('It stopped reading: Asana refused the request: offset: Your pagination token has expired. Check the project: its address in Asana, or its id.');
    // Its place has expired there meanwhile: it reads from the first page, past what it kept.
    asana.expireOffset = 1;
    const pagesBefore = asana.seen.filter((s) => s.path === '/api/1.0/projects/111/tasks').length;
    await continueFetch(admin, started.id, credentials);
    const done = await fetched(started);
    expect(done.rows).toBe(4);
    expect(asana.seen.filter((s) => s.path === '/api/1.0/projects/111/tasks').slice(pagesBefore).map((s) => s.query.get('offset'))).toEqual(['o2', null, 'o2']);
    const keys = (await w.app.db.select({ cells: importRows.cells }).from(importRows).where(eq(importRows.importId, started.id))).map((r) => (r.cells as string[])[0]);
    expect(keys.sort()).toEqual(['1001', '1002', '1003', '1011']);
    // The tasks kept before the stop weren't read again for their comments, nor their subtasks.
    expect(asana.seen.filter((s) => s.path === '/api/1.0/tasks/1001/stories').length).toBe(storiesBefore + 1);
    expect(asana.seen.filter((s) => s.path === '/api/1.0/tasks/1001/subtasks').length).toBe(subtasksBefore + 1);
    expect(done.origin!.fetch.left.issues).toBe(1);
    expect(await everythingKept()).not.toContain(AS_TOKEN);
    expect(logged.join('\n')).not.toContain(AS_TOKEN);
    expect(logged.join('\n')).not.toContain('wrong-token-5678');
  });
});

// ---------------------------------------------------------------------------
// ClickUp
// ---------------------------------------------------------------------------

const CU_TOKEN = ['pk', '4242', 'FAKETOKENFORTESTS0123456789ABCDE'].join('_');
const cuAnna = { id: 11, username: 'Anna Schmidt', email: 'anna@example.com' };
const cuBen = { id: 12, username: 'Ben Okafor', email: 'ben@example.com' };
const cuZed = { id: 13, username: 'Zed Remote', email: 'zed@elsewhere.example' };

function clickupTasks() {
  return {
    c1: {
      id: '86a1',
      custom_id: 'APP-1',
      name: 'Ship the app',
      markdown_description: 'Ready for **review**.',
      status: { status: 'in progress', type: 'custom' },
      date_created: msAt(1),
      date_updated: msAt(2),
      date_closed: null,
      creator: cuBen,
      assignees: [cuAnna, cuBen],
      watchers: [cuBen, cuZed],
      tags: [{ name: 'mobile' }],
      parent: null,
      priority: { id: '1', priority: 'urgent' },
      due_date: msAt(20, 4),
      start_date: msAt(10, 4),
      points: 3,
      time_estimate: 9_000_000,
      time_spent: 5_400_000,
      checklists: [{ name: 'Release', orderindex: 0, items: [{ name: 'Tag the build', resolved: true, orderindex: 0 }, { name: 'Write notes', resolved: false, orderindex: 1, children: [] }] }],
      custom_fields: [
        { name: 'Team', type: 'drop_down', type_config: { options: [{ id: 'o1', name: 'Mobile', orderindex: 0 }, { id: 'o2', name: 'Web', orderindex: 1 }] }, value: 0 },
        { name: 'Platforms', type: 'labels', type_config: { options: [{ id: 'l1', label: 'iOS' }, { id: 'l2', label: 'Android' }] }, value: ['l1', 'l2'] },
        { name: 'Effort', type: 'number', value: '5' },
        { name: 'Customer', type: 'short_text', value: 'Acme' },
        { name: 'Review date', type: 'date', value: msAt(15, 12) },
        { name: 'Reviewers', type: 'users', value: [cuAnna] },
        { name: 'Signed off', type: 'checkbox', value: true },
        { name: 'Margin', type: 'short_text', value: '12%', hide_from_guests: true },
        { name: 'Priority', type: 'drop_down', type_config: { options: [] }, value: null },
      ],
      dependencies: [
        { task_id: '86a1', depends_on: '86a3', type: 1 },
        { task_id: '86a9', depends_on: '86a1', type: 1 },
      ],
      linked_tasks: [{ task_id: '86a1', link_id: '86zz' }],
    } as Record<string, unknown>,
    c1a: { id: '86a2', name: 'Screenshots', status: { status: 'complete', type: 'closed' }, date_created: msAt(1, 10), date_updated: msAt(4), date_closed: msAt(4), date_done: msAt(4), assignees: [], watchers: [], parent: '86a1', time_spent: 0 },
    c2: { id: '86a3', name: 'Store listing', status: { status: 'to do', type: 'open' }, date_created: msAt(2), date_updated: msAt(2), assignees: [], watchers: [], priority: null, time_spent: 0 },
  };
}

interface FakeClickUp extends Fake {
  tasks: ReturnType<typeof clickupTasks>;
  slowDown: boolean;
  downloads: { auth: string | undefined }[];
}

async function fakeClickUp(): Promise<FakeClickUp> {
  const media = await serve((req, url, _body, res) => {
    fake.downloads.push({ auth: req.headers.authorization });
    res.writeHead(url.pathname === '/t1/notes.txt' ? 200 : 404, { 'content-type': 'text/plain' });
    res.end(url.pathname === '/t1/notes.txt' ? 'Release notes.' : '');
  });
  fakes.push(media);
  const fake = (await serve((req, url, _body, res) => {
    const p = url.pathname.replace(/^\/api\/v2/, '');
    if (req.headers.authorization !== CU_TOKEN) return json(res, 401, { err: 'Token invalid', ECODE: 'OAUTH_025' });
    if (p === '/user') return json(res, 200, { user: { id: 1, username: 'Ima Porter', email: 'ima@acme.example' } });
    if (p === '/list/901') return json(res, 200, { id: '901', name: 'App', task_count: 3 });
    if (p === '/list/902') return json(res, 401, { err: 'Team not authorized', ECODE: 'OAUTH_027' });
    if (p.startsWith('/list/') && !p.startsWith('/list/901')) return json(res, 404, { err: 'List not found', ECODE: 'SUBCAT_016' });
    const t = fake.tasks;
    if (p === '/list/901/task') {
      const page = url.searchParams.get('page');
      if (page === '0') return json(res, 200, { tasks: [t.c1, t.c1a], last_page: false });
      if (fake.slowDown) {
        fake.slowDown = false;
        return json(res, 429, { err: 'Rate limit reached', ECODE: 'APP_002' }, { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000)) });
      }
      return json(res, 200, { tasks: [t.c2], last_page: true });
    }
    if (p === '/task/86a1/comment') {
      if (url.searchParams.get('start_id')) return json(res, 200, { comments: [] });
      return json(res, 200, {
        comments: [
          { id: 'cm2', comment: [{ text: 'Shipped to ' }, { text: 'beta', attributes: { bold: true } }, { text: '\n' }], comment_text: 'Shipped to beta', user: cuBen, date: msAt(3, 12) },
          { id: 'cm1', comment_text: 'On it', user: cuAnna, date: msAt(2, 9) },
        ],
      });
    }
    if (/^\/task\/[^/]+\/comment$/.test(p)) return json(res, 200, { comments: [] });
    if (p === '/task/86a1/time') {
      return json(res, 200, {
        data: [
          {
            user: cuAnna,
            time: 5_400_000,
            intervals: [
              { id: 'i1', start: msAt(2, 9), end: msAt(2, 10), time: '3600000', source: 'clickup' },
              { id: 'i2', start: msAt(3, 9), end: msAt(3, 9), time: '1800000', source: 'clickup' },
            ],
          },
        ],
      });
    }
    if (p === '/task/86a1') return json(res, 200, { ...t.c1, attachments: [{ id: 'att1', title: 'notes.txt', url: `${media.url}/t1/notes.txt`, size: 14, mimetype: 'text/plain', user: cuAnna, date: msAt(2, 10) }] });
    if (p.startsWith('/task/')) {
      const one = Object.values(t).find((x) => x.id === p.split('/')[2]);
      return one ? json(res, 200, { ...one, attachments: [] }) : json(res, 404, { err: 'Task not found', ECODE: 'ITEM_013' });
    }
    json(res, 404, { err: 'Route not found', ECODE: 'APP_001' });
  })) as FakeClickUp;
  fake.tasks = clickupTasks();
  fake.slowDown = true;
  fake.downloads = [];
  fakes.push(fake);
  return fake;
}

describe('ClickUp', () => {
  let cu: FakeClickUp;
  const credentials = { token: CU_TOKEN };
  beforeAll(async () => {
    cu = await fakeClickUp();
  });

  it("says at once when the token or the List is wrong: one the token can't open as a missing one, never the token", async () => {
    const start = (query: string, token = CU_TOKEN) => importFromApi(admin, { project: 'CLK', source: 'clickup', url: cu.url, query, credentials: { token } });
    const wrong = await refusal(start('901', 'pk_0_not_it'));
    expect(wrong).toMatchObject({ status: 400, message: "ClickUp didn't accept the token" });
    expect(JSON.stringify(wrong)).not.toContain('pk_0_not_it');
    const hidden = await refusal(start('902'));
    expect(hidden).toMatchObject({ status: 400, message: 'ClickUp has no List 902 the token can see' });
    expect((await refusal(start('903'))).message).toBe(hidden.message.replace('902', '903'));
    expect(await refusal(start('Ship the app'))).toMatchObject({ message: '"Ship the app" isn\'t a ClickUp List' });
  });

  it("reads a List's tasks page by page with their subtasks, waiting out a 429 until its reset, and maps them", async () => {
    const started = await importFromApi(admin, { project: 'CLK', source: 'clickup', url: cu.url, query: 'https://app.clickup.com/9012/v/li/901', credentials });
    expect(started.origin).toMatchObject({ kind: 'clickup', account: 'Ima Porter', fetch: { total: 3 } });
    const imp = await fetched(started);
    expect(imp.rows).toBe(3);
    expect(imp.origin!.fetch).toMatchObject({ issues: 3, comments: 2, work: 2, files: 1, fileBytes: 14 });
    expect(cu.seen.filter((s) => s.path === '/api/v2/list/901/task').map((s) => [s.query.get('page'), s.query.get('subtasks'), s.query.get('include_closed')])).toEqual([
      ['0', 'true', 'true'],
      ['1', 'true', 'true'],
      ['1', 'true', 'true'],
    ]);
    const target = (name: string) => imp.columns.find((c) => c.name === name)?.target;
    expect(
      Object.fromEntries(['Issue key', 'Status', 'Priority', 'Assignee', 'Watchers', 'Estimation', 'Due date', 'Parent', 'depends on', 'is required for', 'relates to', 'Margin (hidden from guests)', 'Priority (field)', 'Time spent'].map((n) => [n, target(n)])),
    ).toEqual({
      'Issue key': 'key',
      Status: 'field:State',
      Priority: 'field:Priority',
      Assignee: 'field:Assignee',
      Watchers: 'watchers',
      Estimation: 'field:Estimation',
      'Due date': 'field:Due date',
      Parent: 'parent',
      'depends on': 'link:depends on',
      'is required for': 'link:is required for',
      'relates to': 'link:relates to',
      'Margin (hidden from guests)': 'ignore',
      'Priority (field)': undefined,
      'Time spent': undefined,
    });
    const sample = (name: string) => imp.columns.find((c) => c.name === name)?.samples[0];
    expect(['Team', 'Platforms', 'Effort', 'Customer', 'Review date', 'Reviewers', 'Signed off', 'Story points', 'Custom task ID'].map(sample)).toEqual([
      'Mobile',
      'iOS, Android',
      '5',
      'Acme',
      at(15, 12),
      'Anna Schmidt <anna@example.com>',
      'true',
      '3',
      'APP-1',
    ]);
    // Its first assignee is its assignee; the other, and its watchers, watch it. People by their email.
    expect(imp.values.find((v) => v.target === 'watchers')!.items.map((i) => [i.value, i.to])).toEqual([
      ['Ben Okafor <ben@example.com>', 'ben'],
      ['Zed Remote <zed@elsewhere.example>', null],
    ]);
  });

  it('runs: statuses by name, priorities, people, checklists, comments, time tracked, files and links, and makes nothing twice when run again', async () => {
    const [{ id }] = await w.app.db.select({ id: imports.id }).from(imports).where(eq(imports.source, 'clickup'));
    const check = await checkImport(admin, id!);
    // Its subtask's parent and the task it waits on are here; the task it blocks and the one linked to it aren't.
    expect(check.counts).toMatchObject({ created: 3, comments: 2, work: 2, files: 1, links: 2, linksMissing: 2 });
    const { done, made } = await ran(id!, credentials);
    expect(done.result).toMatchObject({ created: 3, comments: 2, work: 2, files: 1, failed: 0 });
    const c1 = await getIssue(admin, made.get('86a1')!);
    expect([c1.summary, c1.description, field(c1, 'State'), field(c1, 'Priority'), field(c1, 'Assignee'), field(c1, 'Estimation'), c1.reporter?.login]).toEqual([
      'Ship the app',
      'Ready for **review**.\n\n**Release**\n\n- [x] Tag the build\n- [ ] Write notes',
      'In Progress',
      'Show-stopper',
      'anna',
      '2h 30m',
      'ben',
    ]);
    expect(await watchersOf(made.get('86a1')!)).toEqual({ anna: 'assignee', ben: 'reporter' });
    expect(c1.links.filter((l) => l.phrase === 'depends on').map((l) => l.issue.id)).toEqual([made.get('86a3')]);
    const sub = await getIssue(admin, made.get('86a2')!);
    expect([field(sub, 'State'), sub.resolvedAt]).toEqual(['Done', at(4)]);
    expect(sub.links.filter((l) => l.phrase === 'subtask of').map((l) => l.issue.id)).toEqual([made.get('86a1')]);
    expect(field(await getIssue(admin, made.get('86a3')!), 'State')).toBe('Open');

    const id1 = await uidOf(made.get('86a1')!);
    const said = await w.app.db.select().from(comments).where(eq(comments.issueId, id1));
    expect(said.map((c) => [c.text, c.authorId]).sort()).toEqual([
      ['On it', w.anna.id],
      ['Shipped to **beta**', w.ben.id],
    ]);
    const work = await w.app.db.select().from(workItems).where(eq(workItems.issueId, id1));
    expect(work.map((x) => [x.date, x.minutes, x.authorId]).sort()).toEqual([
      ['2026-03-02', 60, w.anna.id],
      ['2026-03-03', 30, w.anna.id],
    ]);
    const [notes] = await w.app.db.select().from(attachments).where(eq(attachments.issueId, id1));
    expect(notes).toMatchObject({ name: 'notes.txt', size: 14, uploadedById: w.anna.id });
    expect(cu.downloads).toEqual([{ auth: undefined }]);

    const again = await fetched(await importFromApi(admin, { project: 'CLK', source: 'clickup', url: cu.url, query: '901', credentials }));
    const rerun = await ran(again.id, credentials);
    expect(rerun.done.result).toMatchObject({ created: 0, updated: 0, unchanged: 3, comments: 0, work: 0, files: 0 });
    expect(cu.downloads).toHaveLength(1);
    expect(await w.app.db.select().from(externalIssues).where(and(eq(externalIssues.source, 'clickup')))).toHaveLength(3);
    expect(await everythingKept()).not.toContain(CU_TOKEN);
    expect(logged.join('\n')).not.toContain(CU_TOKEN);
  });
});
