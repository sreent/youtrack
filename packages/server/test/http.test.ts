import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '../src/app-services';
import { loadConfig } from '../src/config';
import { openDatabase, type Database } from '../src/db/client';
import { createHttpApp } from '../src/http/app';
import { freshPostgres } from './helpers';

const BASE = 'http://localhost:3999';
let runtime: Runtime;
let database: Database;
let pg: Awaited<ReturnType<typeof freshPostgres>>;
let app: ReturnType<typeof createHttpApp>;
let cookie = '';
let token = '';
let readToken = '';

async function call(method: string, path: string, opts: { body?: unknown; auth?: 'cookie' | 'token' | 'read' | 'none'; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const auth = opts.auth ?? 'token';
  if (auth === 'cookie') {
    headers.cookie = cookie;
    headers.origin = BASE;
  }
  if (auth === 'token') headers.authorization = `Bearer ${token}`;
  if (auth === 'read') headers.authorization = `Bearer ${readToken}`;
  const res = await app.request(`/api/v1${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

beforeAll(async () => {
  const config = loadConfig({ aiEnabled: false, seedDemo: false, publicUrl: BASE, webDist: undefined });
  pg = await freshPostgres();
  database = await openDatabase(pg ? { url: pg.url } : { memory: true });
  runtime = await createRuntime(config, database);
  app = createHttpApp(runtime);
});

afterAll(async () => {
  await database?.close();
  await pg?.drop();
});

describe('setup and authentication', () => {
  it('creates the first administrator with demo data and signs them in', async () => {
    expect((await call('GET', '/auth/setup', { auth: 'none' })).body).toMatchObject({ needsSetup: true });
    const res = await app.request('/api/v1/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'ada', name: 'Ada Admin', password: 'correct horse battery', seedDemo: true }),
    });
    expect(res.status).toBe(201);
    cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect(cookie).toMatch(/^tracklet_session=/);
    expect((await call('GET', '/auth/setup', { auth: 'none' })).body.needsSetup).toBe(false);
    const again = await call('POST', '/auth/setup', { auth: 'none', body: { login: 'eve', name: 'Eve', password: 'password123' } });
    expect(again.status).toBe(409);
  });

  it('knows who you are from the session', async () => {
    const me = await call('GET', '/me', { auth: 'cookie' });
    expect(me.body).toMatchObject({ login: 'ada', role: 'admin', auth: { method: 'session', scopes: ['read', 'write', 'admin'] } });
    expect((await call('GET', '/me', { auth: 'none' })).status).toBe(401);
  });

  it('refuses cookie-authenticated writes from another site', async () => {
    const res = await app.request('/api/v1/tags', {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  it('issues tokens whose scopes narrow the role', async () => {
    const full = await call('POST', '/me/tokens', { auth: 'cookie', body: { name: 'ci', scopes: ['read', 'write'] } });
    expect(full.status).toBe(201);
    token = full.body.token;
    expect(token).toMatch(/^trk_/);
    const ro = await call('POST', '/me/tokens', { auth: 'cookie', body: { name: 'explorer', scopes: ['read'] } });
    readToken = ro.body.token;
    const me = await call('GET', '/me', { auth: 'read' });
    expect(me.body.auth).toMatchObject({ method: 'token', scopes: ['read'], tokenName: 'explorer' });
    const denied = await call('POST', '/issues', { auth: 'read', body: { project: 'BACK', summary: 'Nope' } });
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toContain('write');
    const list = await call('GET', '/me/tokens', { auth: 'cookie' });
    expect(list.body.map((t: { name: string }) => t.name).sort()).toEqual(['ci', 'explorer']);
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect((await call('GET', '/me', { auth: 'none', headers: { authorization: 'Bearer trk_wrong' } })).status).toBe(401);
  });
});

describe('issues over REST', () => {
  it('searches the seeded data with the query language', async () => {
    const res = await call('GET', `/issues?query=${encodeURIComponent('project: BACK #Unresolved Priority: Critical sort by: updated desc')}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.items.every((i: { project: { key: string } }) => i.project.key === 'BACK')).toBe(true);
    const bad = await call('GET', `/issues?query=${encodeURIComponent('State: Fixd')}`);
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.problems[0].hint).toContain('Fixed');
  });

  it('creates once per Idempotency-Key', async () => {
    const body = { project: 'BACK', summary: 'Retry-safe issue', fields: { Priority: 'Major' } };
    const first = await call('POST', '/issues', { body, headers: { 'idempotency-key': 'k-1' } });
    expect(first.status).toBe(201);
    const second = await call('POST', '/issues', { body, headers: { 'idempotency-key': 'k-1' } });
    expect(second.status).toBe(201);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(second.body.id).toBe(first.body.id);
    const other = await call('POST', '/issues', { body: { ...body, summary: 'Different' }, headers: { 'idempotency-key': 'k-1' } });
    expect(other.status).toBe(422);
  });

  it('rejects stale updates and invalid input with clear errors', async () => {
    const issue = (await call('POST', '/issues', { body: { project: 'WEB', summary: 'Versioned' } })).body;
    const ok = await call('PATCH', `/issues/${issue.id}`, { body: { fields: { Priority: 'Critical' }, expectedVersion: issue.version } });
    expect(ok.status).toBe(200);
    const stale = await call('PATCH', `/issues/${issue.id}`, { body: { summary: 'Late edit', expectedVersion: issue.version } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.currentVersion).toBe(issue.version + 1);
    const invalid = await call('POST', '/issues', { body: { project: 'WEB' } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('validation_failed');
    const unknown = await call('PATCH', `/issues/${issue.id}`, { body: { fields: { Priority: 'Urgentish' } } });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.hint).toContain('Allowed');
  });

  it('applies commands in bulk and records the channel in history', async () => {
    const found = (await call('GET', `/issues?query=${encodeURIComponent('project: WEB #Unresolved')}&limit=3`)).body.items.map((i: { id: string }) => i.id);
    const preview = await call('POST', '/commands', { body: { issues: found, command: 'tag triaged Major', dryRun: true } });
    expect(preview.body.applied).toBe(false);
    expect(preview.body.description).toBe('add tag triaged; set Priority to Major');
    const done = await call('POST', '/commands', { body: { issues: found, command: 'tag triaged', comment: 'Looked at in triage.' } });
    expect(done.body.applied).toBe(true);
    const history = await call('GET', `/issues/${found[0]}/activity`);
    const last = history.body.filter((e: { type: string }) => e.type === 'issue.updated').at(-1);
    expect(last.actor).toMatchObject({ login: 'ada', channel: 'api', token: 'ci' });
  });

  it('serves an OpenAPI 3.1 document', async () => {
    const res = await app.request('/api/v1/openapi.json');
    const doc = await res.json();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/issues', '/issues/{id}', '/commands', '/search/count', '/boards/{id}/view', '/events', '/webhooks']));
    expect(doc.components.schemas.Issue).toBeDefined();
    expect(doc.components.securitySchemes.bearerAuth).toBeDefined();
  });

  it('shows boards with sprints from the demo', async () => {
    const boards = (await call('GET', '/boards')).body;
    const sprintBoard = boards.find((b: { name: string }) => b.name === 'Backend sprints');
    const view = (await call('GET', `/boards/${sprintBoard.id}/view`)).body;
    expect(view.sprint.name).toBe('Sprint 14');
    expect(view.columns.map((c: { name: string }) => c.name)).toContain('Done');
    expect(view.columns.reduce((n: number, c: { count: number }) => n + c.count, 0)).toBe(7);
  });
});

describe('MCP', () => {
  async function client(bearer: string) {
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
      fetch: (input, init) => app.request(String(input), init as RequestInit),
    });
    const c = new Client({ name: 'test', version: '1.0.0' });
    await c.connect(transport);
    return c;
  }

  it('requires a token', async () => {
    const res = await app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });

  it('lists annotated tools, resources and prompts', async () => {
    const c = await client(token);
    expect(c.getInstructions()).toContain('query language');
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['search_issues', 'get_issue', 'create_issue', 'apply_command', 'find_similar_issues', 'get_board']));
    expect(names).not.toContain('delete_issue');
    expect(tools.find((t) => t.name === 'search_issues')!.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find((t) => t.name === 'apply_command')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const { resources } = await c.listResources();
    expect(resources.map((r) => r.uri)).toEqual(expect.arrayContaining(['tracklet://guide/query-language', 'tracklet://guide/commands']));
    const { prompts } = await c.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(expect.arrayContaining(['work_on_issue', 'triage_backlog', 'report_bug', 'status_report']));
    await c.close();
  });

  it('runs tools as the token owner, through the same rules as REST', async () => {
    const c = await client(token);
    const search = await c.callTool({ name: 'search_issues', arguments: { query: 'project: BACK tag: regression' } });
    const data = JSON.parse((search.content as { text: string }[])[0]!.text);
    expect(data.issues[0].summary).toBe('Login fails on Safari with SSO');
    const similar = await c.callTool({ name: 'find_similar_issues', arguments: { text: 'Safari SSO login broken' } });
    const sim = JSON.parse((similar.content as { text: string }[])[0]!.text);
    expect(sim.map((s: { summary: string }) => s.summary)).toContain('Login fails on Safari with SSO');
    const bad = await c.callTool({ name: 'search_issues', arguments: { query: 'Stat: Open' } });
    expect(bad.isError).toBe(true);
    expect((bad.content as { text: string }[])[0]!.text).toContain('Did you mean "State"');
    const created = await c.callTool({ name: 'create_issue', arguments: { project: 'WEB', summary: 'Filed by an agent', fields: { Type: 'Task' } } });
    const issue = JSON.parse((created.content as { text: string }[])[0]!.text);
    const history = await call('GET', `/issues/${issue.id}/activity`);
    expect(history.body[0].actor).toMatchObject({ login: 'ada', channel: 'mcp', token: 'ci' });
    const doc = await c.readResource({ uri: `tracklet://issues/${issue.id}` });
    expect((doc.contents[0] as { text: string }).text).toContain('Filed by an agent');
    await c.close();
  });

  it('keeps read-only tokens read-only', async () => {
    const c = await client(readToken);
    const res = await c.callTool({ name: 'add_comment', arguments: { issue: 'BACK-2', text: 'hi' } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toContain('write');
    await c.close();
  });
});
