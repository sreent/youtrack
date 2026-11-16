/**
 * Per-project access over the channels: REST (not found means exactly not found), tokens limited
 * to projects, the live event stream, and MCP.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpApp } from '../src/http/app';
import { issueTokenFor } from '../src/services/auth';
import { addComment } from '../src/services/comments';
import { createIssue } from '../src/services/issues';
import { addMember } from '../src/services/members';
import { createProject } from '../src/services/projects';
import { createWorld, type TestWorld } from './helpers';

const BASE = 'http://localhost:3000';
let w: TestWorld;
let app: ReturnType<typeof createHttpApp>;
const tokens = { admin: '', anna: '', annaBack: '', ben: '', benRead: '' };
let secretId = '';
let backId = '';

async function call(method: string, path: string, bearer: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${bearer}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(`/api/v1${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** The same answer, but for the one word that names what was asked for. */
const sameBut = (a: unknown, wordA: string, b: unknown, wordB: string) => expect(JSON.stringify(a).split(wordA).join('<X>')).toBe(JSON.stringify(b).split(wordB).join('<X>'));

beforeAll(async () => {
  w = await createWorld();
  await w.app.live.start();
  app = createHttpApp(w.app);
  await createProject(w.adminCtx, { key: 'SECRET', name: 'Merger', template: 'software', visibility: 'members' });
  await addMember(w.adminCtx, 'SECRET', { user: 'anna', role: 'member' });
  secretId = (await createIssue(w.as(w.anna), { project: 'SECRET', summary: 'Acquire Initech' })).id;
  backId = (await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Rate limits' })).id;
  const s = await w.app.schema.get();
  const back = s.projectsByKey.get('BACK')!;
  tokens.admin = (await issueTokenFor(w.app.db, w.admin.id, { name: 'admin', scopes: ['read', 'write', 'admin'] })).token;
  tokens.anna = (await issueTokenFor(w.app.db, w.anna.id, { name: 'anna', scopes: ['read', 'write'] })).token;
  tokens.annaBack = (await issueTokenFor(w.app.db, w.anna.id, { name: 'back only', scopes: ['read', 'write'], projectIds: [back.id] })).token;
  tokens.ben = (await issueTokenFor(w.app.db, w.ben.id, { name: 'ben', scopes: ['read', 'write'] })).token;
  tokens.benRead = (await issueTokenFor(w.app.db, w.ben.id, { name: 'ben read', scopes: ['read'] })).token;
});

afterAll(async () => {
  w?.app.live.stop();
  await w?.close();
});

describe('REST', () => {
  it('answers 404 for a hidden project or issue in exactly the words used for a missing one', async () => {
    sameBut(await call('GET', '/projects/SECRET', tokens.ben), 'SECRET', await call('GET', '/projects/NOPEX', tokens.ben), 'NOPEX');
    sameBut(await call('GET', '/projects/SECRET/fields', tokens.ben), 'SECRET', await call('GET', '/projects/NOPEX/fields', tokens.ben), 'NOPEX');
    sameBut(await call('GET', '/projects/SECRET/members', tokens.ben), 'SECRET', await call('GET', '/projects/NOPEX/members', tokens.ben), 'NOPEX');
    sameBut(await call('GET', '/projects/SECRET/schedule', tokens.ben), 'SECRET', await call('GET', '/projects/NOPEX/schedule', tokens.ben), 'NOPEX');
    sameBut(await call('GET', `/issues/${secretId}`, tokens.ben), secretId, await call('GET', '/issues/BACK-999', tokens.ben), 'BACK-999');
    sameBut(await call('POST', `/issues/${secretId}/comments`, tokens.ben, { text: 'hi' }), secretId, await call('POST', '/issues/BACK-999/comments', tokens.ben, { text: 'hi' }), 'BACK-999');
    sameBut(
      await call('POST', '/issues', tokens.ben, { project: 'SECRET', summary: 'x' }),
      'SECRET',
      await call('POST', '/issues', tokens.ben, { project: 'NOPEX', summary: 'x' }),
      'NOPEX',
    );
    expect((await call('GET', `/issues/${secretId}`, tokens.ben)).status).toBe(404);
    expect((await call('GET', `/issues/${secretId}`, tokens.anna)).status).toBe(200);
  });

  it("lets only a project's managers change its people and who sees it", async () => {
    expect((await call('POST', '/projects/SECRET/members', tokens.anna, { user: 'ben', role: 'viewer' })).status).toBe(403);
    expect((await call('POST', '/projects/SECRET/members', tokens.ben, { user: 'ben', role: 'viewer' })).status).toBe(404);
    const added = await call('POST', '/projects/SECRET/members', tokens.admin, { user: 'ben', role: 'viewer' });
    expect(added).toMatchObject({ status: 201, body: { user: { login: 'ben' }, role: 'viewer', lead: false } });
    expect((await call('GET', `/issues/${secretId}`, tokens.ben)).status).toBe(200);
    expect((await call('PATCH', `/issues/${secretId}`, tokens.ben, { summary: 'x' })).status).toBe(403);
    expect((await call('PATCH', '/projects/SECRET/members/ben', tokens.admin, { role: 'member' })).body).toMatchObject({ role: 'member' });
    expect((await call('DELETE', '/projects/SECRET/members/ben', tokens.admin)).status).toBe(204);
    expect((await call('GET', `/issues/${secretId}`, tokens.ben)).status).toBe(404);
    expect((await call('PATCH', '/projects/SECRET', tokens.anna, { visibility: 'open' })).status).toBe(403);
    const opened = await call('PATCH', '/projects/SECRET', tokens.admin, { visibility: 'open' });
    expect(opened.body).toMatchObject({ visibility: 'open' });
    expect((await call('GET', `/issues/${secretId}`, tokens.ben)).status).toBe(200);
    expect((await call('PATCH', '/projects/SECRET', tokens.admin, { visibility: 'members' })).body.visibility).toBe('members');
    expect((await call('GET', `/issues/${secretId}`, tokens.ben)).status).toBe(404);
  });
});

describe('tokens limited to projects', () => {
  it('reach those projects only, as far as their person may', async () => {
    const projects = await call('GET', '/projects', tokens.annaBack);
    expect(projects.body.map((p: { key: string }) => p.key)).toEqual(['BACK']);
    expect((await call('GET', `/issues/${secretId}`, tokens.annaBack)).status).toBe(404);
    expect((await call('POST', '/issues', tokens.annaBack, { project: 'WEB', summary: 'x' })).status).toBe(404);
    expect((await call('POST', '/issues', tokens.annaBack, { project: 'BACK', summary: 'From a limited token' })).status).toBe(201);
    const found = await call('GET', `/issues?query=${encodeURIComponent('')}`, tokens.annaBack);
    expect(new Set(found.body.items.map((i: { project: { key: string } }) => i.project.key))).toEqual(new Set(['BACK']));
    expect((await call('GET', '/me', tokens.annaBack)).body.auth).toMatchObject({ method: 'token', projects: ['BACK'] });
    expect((await call('GET', '/me', tokens.anna)).body.auth.projects).toBeNull();
  });

  it('are made with projects you can see, never with the admin scope, and never wider than the token that makes them', async () => {
    const made = await call('POST', '/me/tokens', tokens.anna, { name: 'secret only', scopes: ['read'], projects: ['SECRET'] });
    expect(made).toMatchObject({ status: 201, body: { projects: ['SECRET'], scopes: ['read'] } });
    expect((await call('GET', '/projects', made.body.token)).body.map((p: { key: string }) => p.key)).toEqual(['SECRET']);
    sameBut(
      await call('POST', '/me/tokens', tokens.ben, { name: 'x', scopes: ['read'], projects: ['SECRET'] }),
      'SECRET',
      await call('POST', '/me/tokens', tokens.ben, { name: 'x', scopes: ['read'], projects: ['NOPEX'] }),
      'NOPEX',
    );
    const adminLimited = await call('POST', '/me/tokens', tokens.admin, { name: 'x', scopes: ['read', 'admin'], projects: ['BACK'] });
    expect(adminLimited.status).toBe(400);
    // A limited token passes its limit on, and can't give more scopes than it has.
    const child = await call('POST', '/me/tokens', tokens.annaBack, { name: 'child', scopes: ['read'] });
    expect(child.body.projects).toEqual(['BACK']);
    expect((await call('POST', '/me/tokens', tokens.annaBack, { name: 'wider', scopes: ['read'], projects: ['WEB'] })).status).toBe(404);
    expect((await call('POST', '/me/tokens', tokens.benRead, { name: 'more', scopes: ['read', 'write'] })).status).toBe(403);
    // Its person can widen it again.
    const widened = await call('PATCH', `/me/tokens/${child.body.id}`, tokens.anna, { projects: null });
    expect(widened.body.projects).toBeNull();
    expect((await call('GET', '/me/tokens', tokens.anna)).body.find((t: { id: string }) => t.id === made.body.id).projects).toEqual(['SECRET']);
  });
});

/** Read a Server-Sent Events response until `done` says so, or time runs out. */
async function readStream(res: Response, done: (text: string) => boolean, ms = 4000): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !done(text)) {
    const next = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, deadline - Date.now())))]);
    if (!next || next.done) break;
    text += decoder.decode(next.value);
  }
  await reader.cancel().catch(() => {});
  return text;
}

describe('the live stream', () => {
  it("sends each listener only the events of projects they can see", async () => {
    const open = (bearer: string) => app.request('/api/v1/events/stream', { headers: { authorization: `Bearer ${bearer}` } });
    const [benRes, annaRes] = await Promise.all([open(tokens.ben), open(tokens.anna)]);
    expect(benRes.status).toBe(200);
    const benText = readStream(benRes, (t) => t.includes('marker-visible'));
    const annaText = readStream(annaRes, (t) => t.includes('marker-visible'));
    await new Promise((r) => setTimeout(r, 100));
    await addComment(w.as(w.anna), secretId, 'marker-hidden about the merger');
    await addComment(w.as(w.anna), backId, 'marker-visible about rate limits');
    const [ben, anna] = await Promise.all([benText, annaText]);
    expect(ben).toContain('marker-visible');
    expect(ben).not.toContain('marker-hidden');
    expect(ben).not.toContain(secretId);
    expect(anna).toContain('marker-hidden');
    expect(anna).toContain('marker-visible');
  });
});

describe('MCP', () => {
  async function client(bearer: string) {
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
      fetch: async (input, init) => app.request(String(input), init as RequestInit),
    });
    const c = new Client({ name: 'test', version: '1.0.0' });
    await c.connect(transport);
    return c;
  }

  it('lists no resource of a hidden project, and reads none', async () => {
    const c = await client(tokens.ben);
    const { resources } = await c.listResources();
    expect(JSON.stringify(resources)).not.toContain('SECRET');
    await expect(c.readResource({ uri: `a4a://issues/${secretId}` })).rejects.toThrow();
    await expect(c.readResource({ uri: 'a4a://projects/SECRET' })).rejects.toThrow();
    const res = await c.callTool({ name: 'get_issue', arguments: { issue: secretId } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toBe(`Issue ${secretId} not found\nUse a readable id such as BACK-12.`);
    const members = await c.callTool({ name: 'list_project_members', arguments: { project: 'BACK' } });
    expect(JSON.parse((members.content as { text: string }[])[0]!.text)).toMatchObject({ project: 'BACK', visibility: 'open' });
    await c.close();
  });

  it('tells an agent on a limited token which projects it reaches', async () => {
    const c = await client(tokens.annaBack);
    const me = await c.callTool({ name: 'get_current_user', arguments: {} });
    expect(JSON.parse((me.content as { text: string }[])[0]!.text)).toMatchObject({ login: 'anna', onlyProjects: ['BACK'] });
    const projects = await c.callTool({ name: 'list_projects', arguments: {} });
    expect(JSON.parse((projects.content as { text: string }[])[0]!.text).map((p: { key: string }) => p.key)).toEqual(['BACK']);
    await c.close();
  });
});
