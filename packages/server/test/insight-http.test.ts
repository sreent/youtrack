import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '../src/app-services';
import { loadConfig } from '../src/config';
import { openDatabase, type Database } from '../src/db/client';
import { createHttpApp } from '../src/http/app';
import { waitForImport } from '../src/services/imports';
import { freshPostgres } from './helpers';

const BASE = 'http://localhost:3998';
let runtime: Runtime;
let database: Database;
let pg: Awaited<ReturnType<typeof freshPostgres>>;
let app: ReturnType<typeof createHttpApp>;
let token = '';
let readToken = '';
let miaCookie = '';

type Auth = 'token' | 'read' | 'mia' | 'none';
async function call(method: string, path: string, opts: { body?: unknown; auth?: Auth; raw?: string; type?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.raw !== undefined) headers['content-type'] = opts.type ?? 'text/csv';
  const auth = opts.auth ?? 'token';
  if (auth === 'token') headers.authorization = `Bearer ${token}`;
  if (auth === 'read') headers.authorization = `Bearer ${readToken}`;
  if (auth === 'mia') {
    headers.cookie = miaCookie;
    headers.origin = BASE;
  }
  const res = await app.request(`/api/v1${path}`, { method, headers, body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // CSV
  }
  return { status: res.status, body: body as any, text, headers: res.headers };
}

beforeAll(async () => {
  const config = loadConfig({ aiEnabled: false, seedDemo: false, publicUrl: BASE, webDist: undefined });
  pg = await freshPostgres();
  database = await openDatabase(pg ? { url: pg.url } : { memory: true });
  runtime = await createRuntime(config, database);
  app = createHttpApp(runtime);
  const setup = await app.request('/api/v1/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'ada', name: 'Ada Admin', password: 'correct horse battery', seedDemo: true }),
  });
  const cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0]!;
  const mk = async (scopes: string[]) => {
    const r = await app.request('/api/v1/me/tokens', { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: BASE }, body: JSON.stringify({ name: scopes.join('-'), scopes }) });
    return ((await r.json()) as { token: string }).token;
  };
  token = await mk(['read', 'write', 'admin']);
  readToken = await mk(['read']);
  await call('POST', '/users', { body: { login: 'mia', name: 'Mia Member', password: 'mia-password-1', role: 'member' } });
  const login = await app.request('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'mia', password: 'mia-password-1' }) });
  miaCookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
});

afterAll(async () => {
  await database?.close();
  await pg?.drop();
});

describe('reports over REST', () => {
  it('answers whether the demo sprint is on track, by estimate and by count', async () => {
    const b = await call('GET', `/reports/burndown?board=${encodeURIComponent('Backend sprints')}&by=count&timeZone=UTC`, { auth: 'read' });
    expect(b.status).toBe(200);
    expect(b.body.sprint.name).toBe('Sprint 14');
    // Planned the afternoon before it began: five issues. The SSO bug and the slow query were
    // reported during it, so they joined as scope added.
    expect(b.body.start).toBe(5);
    expect(b.body.added).toBe(2);
    expect(b.body.completed).toBe(1); // the webhook fix
    expect(b.body.status.words).toMatch(/^(On track|Behind|Ahead)/);
    const csv = await call('GET', `/reports/burndown.csv?board=${encodeURIComponent('Backend sprints')}`, { auth: 'read' });
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('content-disposition')).toContain('burndown-Sprint-14.csv');
    expect(csv.text.split('\r\n')[0]).toBe('Date,Remaining (hours),Ideal (hours),Completed (hours),Added (hours),Removed (hours),Reopened (hours),Spent (hours)');
    // A byte order mark first, so a spreadsheet reads it as UTF-8 (text() takes it off).
    const raw = await app.request('/api/v1/reports/flow.csv?project=BACK', { headers: { authorization: `Bearer ${readToken}` } });
    expect([...new Uint8Array(await raw.arrayBuffer()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('serves flow, created against resolved, cycle time and time, as JSON and CSV', async () => {
    const flow = await call('GET', '/reports/flow?project=BACK&timeZone=UTC');
    expect(flow.status).toBe(200);
    expect(flow.body.days).toHaveLength(30);
    expect(flow.body.days.at(-1).total).toBe(12);
    const flowCsv = await call('GET', '/reports/flow.csv?project=BACK');
    expect(flowCsv.text.split('\r\n')[0]).toContain('Date,Submitted,Open,In Progress');
    const cr = await call('GET', '/reports/created-resolved?project=MIG&from=2026-01-01&interval=month');
    expect(cr.status).toBe(200);
    expect(cr.body.interval).toBe('month');
    const cycle = await call('GET', '/reports/cycle-time?project=BACK');
    expect(cycle.status).toBe(200);
    expect(cycle.body.startStates).toEqual(['In Progress']);
    const time = await call('GET', '/reports/time?project=MIG&from=2026-01-01');
    expect(time.status).toBe(200);
    expect(time.body.totalMinutes).toBeGreaterThan(0);
    const entries = await call('GET', '/reports/time.csv?project=MIG&from=2026-01-01&rows=entries');
    expect(entries.text.split('\r\n')[0]).toBe('Date,Person,Login,Project,Issue,Summary,Minutes,Hours,Duration,Note');
    const byPerson = await call('GET', '/reports/time.csv?project=MIG&from=2026-01-01&rows=person');
    expect(byPerson.text).toContain('Total,');
  });

  it('keeps a summary from becoming a formula in someone\'s spreadsheet', async () => {
    const issue = await call('POST', '/issues', { body: { project: 'WEB', summary: '=cmd|"/c calc"!A1' } });
    await call('POST', `/issues/${issue.body.id}/work-items`, { body: { duration: '1h', date: '2026-11-02' } });
    const csv = await call('GET', '/reports/time.csv?project=WEB&from=2026-11-01&to=2026-11-03');
    expect(csv.text).toContain(`"'=cmd|""/c calc""!A1"`);
  });

  it('says what to fix in a bad request', async () => {
    const bad = await call('GET', '/reports/flow?project=BACK&from=2026-13-01');
    expect(bad.status).toBe(400);
    const zone = await call('GET', '/reports/cycle-time?timeZone=Moon');
    expect(zone.status).toBe(400);
    expect(zone.body.error.hint).toContain('IANA');
    expect((await call('GET', '/reports/burndown')).status).toBe(400);
    expect((await call('GET', '/reports/flow', { auth: 'none' })).status).toBe(401);
  });

  it('lists the reports in the OpenAPI document, the upload as CSV', async () => {
    const doc = await call('GET', '/openapi.json', { auth: 'none' });
    for (const p of ['/reports/burndown', '/reports/flow', '/reports/cycle-time', '/reports/time.csv', '/dashboards', '/imports', '/imports/{id}/run']) expect(doc.body.paths[p]).toBeTruthy();
    expect(doc.body.paths['/imports'].post.requestBody.content['text/csv']).toBeTruthy();
  });
});

describe('get_report over MCP', () => {
  it('tells an agent whether a sprint is on track, read-only', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${readToken}` } },
      fetch: async (input, init) => app.request(String(input), init as RequestInit),
    });
    const c = new Client({ name: 'test', version: '1.0.0' });
    await c.connect(transport);
    const { tools } = await c.listTools();
    expect(tools.find((t) => t.name === 'get_report')!.annotations).toMatchObject({ readOnlyHint: true });
    const res = await c.callTool({ name: 'get_report', arguments: { report: 'burndown', board: 'Backend sprints' } });
    const data = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(data.sprint).toBe('Sprint 14');
    expect(['on_track', 'behind', 'ahead']).toContain(data.verdict);
    expect(data.says).toBeTruthy();
    const cycle = await c.callTool({ name: 'get_report', arguments: { report: 'cycle_time', project: 'BACK' } });
    expect(cycle.isError).toBeFalsy();
    const time = await c.callTool({ name: 'get_report', arguments: { report: 'time', project: 'MIG', from: '2026-01-01' } });
    expect(JSON.parse((time.content as { text: string }[])[0]!.text).totalHours).toBeGreaterThan(0);
    const bad = await c.callTool({ name: 'get_report', arguments: { report: 'flow', project: 'NOPE' } });
    expect(bad.isError).toBe(true);
    await c.close();
  });
});

describe('dashboards', () => {
  let id = '';
  it('starts someone with a default: their issues, the current sprint, and how work goes', async () => {
    const d = await call('GET', '/dashboards/default', { auth: 'mia' });
    expect(d.status).toBe(200);
    expect(d.body.id).toBeNull();
    expect(d.body.widgets.map((x: { id: string }) => x.id)).toEqual(['mine', 'sprint', 'flow', 'cycle']);
  });

  it('saves widgets, in order, and refuses a change made over someone else\'s', async () => {
    const widgets = [
      { id: 'b', kind: 'report', title: 'Sprint', params: { report: 'burndown', board: 'Backend sprints' } },
      { id: 'n', kind: 'note', text: 'Release on **Friday**.', width: 'full' },
      { id: 's', kind: 'search', query: 'project: BACK #Unresolved', show: 'count' },
    ];
    const created = await call('POST', '/dashboards', { body: { name: 'Team', widgets, shared: true } });
    expect(created.status).toBe(201);
    id = created.body.id;
    expect(created.body.widgets.map((w: { id: string; width: string }) => [w.id, w.width])).toEqual([
      ['b', 'half'],
      ['n', 'full'],
      ['s', 'half'],
    ]);
    const moved = await call('PATCH', `/dashboards/${id}`, { body: { widgets: [widgets[2], widgets[0], widgets[1]], expectedVersion: 1 } });
    expect(moved.status).toBe(200);
    expect(moved.body.version).toBe(2);
    const stale = await call('PATCH', `/dashboards/${id}`, { body: { name: 'Mine now', expectedVersion: 1 } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.currentVersion).toBe(2);
  });

  it('checks what widgets name, and gives each its own id', async () => {
    expect((await call('POST', '/dashboards', { body: { name: 'x', widgets: [{ id: 'a', kind: 'report', params: { report: 'flow', project: 'NOPE' } }] } })).status).toBe(404);
    expect((await call('POST', '/dashboards', { body: { name: 'x', widgets: [{ id: 'a', kind: 'note', text: '' }, { id: 'a', kind: 'note', text: '' }] } })).status).toBe(400);
    const badQuery = await call('POST', '/dashboards', { body: { name: 'x', widgets: [{ id: 'a', kind: 'search', query: 'Stat: Open' }] } });
    expect(badQuery.status).toBe(400);
    expect((await call('POST', '/dashboards', { body: { name: 'x', widgets: [{ id: 'a', kind: 'chart' }] } })).status).toBe(400);
  });

  it('shows a shared one to everyone, lets only its owner change it, and keeps a private one private', async () => {
    const list = await call('GET', '/dashboards', { auth: 'mia' });
    expect(list.body.map((d: { name: string; mine: boolean; canEdit: boolean }) => [d.name, d.mine, d.canEdit])).toEqual([['Team', false, false]]);
    expect((await call('PATCH', `/dashboards/${id}`, { auth: 'mia', body: { name: 'Taken' } })).status).toBe(403);
    expect((await call('DELETE', `/dashboards/${id}`, { auth: 'mia' })).status).toBe(403);
    const own = await call('POST', '/dashboards', { auth: 'mia', body: { name: 'Mia\'s' } });
    expect(own.status).toBe(201);
    expect((await call('GET', `/dashboards/${own.body.id}`)).status).toBe(404); // not even an admin sees it
    expect((await call('POST', '/dashboards', { auth: 'read', body: { name: 'No' } })).status).toBe(403);
    expect((await call('DELETE', `/dashboards/${own.body.id}`, { auth: 'mia' })).status).toBe(204);
  });
});

describe('imports over REST', () => {
  const csv = 'Issue key,Summary,Status,Priority,Created\r\nOLD-1,"Moved over, with a comma",Done,High,2024-01-02 10:00\r\nOLD-2,Still open,To Do,Low,2024-01-03 11:00\r\n';
  it('uploads, checks, runs and reports, for administrators', async () => {
    expect((await call('POST', '/imports?project=WEB', { raw: csv, auth: 'read' })).status).toBe(403);
    expect((await call('POST', '/imports?project=WEB', { raw: csv, type: 'application/json' })).status).toBe(400);
    const up = await call('POST', '/imports?project=WEB&fileName=old.csv', { raw: csv });
    expect(up.status).toBe(201);
    expect(up.body.source).toBe('jira');
    const id = up.body.id;
    const check = await call('POST', `/imports/${id}/check`);
    expect(check.status).toBe(200);
    expect(check.body.counts).toMatchObject({ created: 2, failed: 0 });
    const run = await call('POST', `/imports/${id}/run`);
    expect(run.status).toBe(202);
    await waitForImport(id);
    const done = await call('GET', `/imports/${id}`);
    expect(done.body.status).toBe('done');
    expect(done.body.result).toMatchObject({ created: 2 });
    const rows = await call('GET', `/imports/${id}/rows?status=created`);
    expect(rows.body.items.map((r: { key: string }) => r.key)).toEqual(['OLD-1', 'OLD-2']);
    const undo = await call('POST', `/imports/${id}/undo`, { body: {} });
    expect(undo.body).toMatchObject({ applied: false, remove: [expect.any(String), expect.any(String)] });
    const list = await call('GET', '/imports?project=WEB');
    expect(list.body.map((i: { id: string }) => i.id)).toContain(id);
  });
});
