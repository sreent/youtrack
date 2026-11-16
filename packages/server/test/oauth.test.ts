/**
 * OAuth 2.1 for remote MCP (docs/architecture.md, D28), over HTTP. The MCP SDK's own client does
 * what an MCP client does (discovery, registration, PKCE, the code exchange, refresh), and these
 * tests stand in for the browser on a4a's consent page, through the same API the page uses.
 */
import { createHash, randomBytes } from 'node:crypto';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpApp } from '../src/http/app';
import { oauthCodes, oauthTokens } from '../src/db/schema';
import { pruneOAuth } from '../src/oauth/grants';
import { issueTokenFor, startSession } from '../src/services/auth';
import { createIssue } from '../src/services/issues';
import { createProject } from '../src/services/projects';
import { updateUser } from '../src/services/users';
import { createWorld, type TestWorld } from './helpers';

const BASE = 'http://localhost:3000';
const MCP = `${BASE}/mcp`;
const CALLBACK = 'http://127.0.0.1:8765/callback';
let w: TestWorld;
let app: ReturnType<typeof createHttpApp>;
const sessions = { anna: '', vera: '', ben: '' };
let addresses = 0;

/** Each call from its own address (one proxy in front), so the per-address limits stay out of the way. */
const from = () => `10.1.${Math.floor(++addresses / 250)}.${addresses % 250}`;

/** The app, as fetch: what the SDK's client and transport call. */
const fetchIn = async (input: string | URL | Request, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-forwarded-for', from());
  return app.request(String(input instanceof Request ? input.url : input), { ...init, headers });
};

/** A JSON call as a signed-in person, from a4a's own page (the Origin a browser sends). */
async function asPerson(session: string, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { cookie: `a4a_session=${session}`, origin: BASE, 'x-forwarded-for': from() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(`/api/v1${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** POST to the root endpoints, as a form, from an address of its own. */
async function form(path: string, fields: Record<string, string>) {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': from() },
    body: new URLSearchParams(fields).toString(),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

async function register(metadata: Record<string, unknown>) {
  const res = await app.request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': from() },
    body: JSON.stringify(metadata),
  });
  return { status: res.status, body: JSON.parse(await res.text()) };
}

/** What an MCP client keeps: as the SDK's OAuthClientProvider asks for it, in memory. */
class Agent implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = '';
  authUrl: URL | undefined;
  constructor(
    private name = 'Test agent',
    private redirect = CALLBACK,
    private scope?: string,
  ) {}
  get redirectUrl() {
    return this.redirect;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.name,
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.scope ? { scope: this.scope } : {}),
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

/** The browser on a4a's consent page: what the page is told, and where the decision sends it. */
async function consent(session: string, authUrl: URL, decision: { allow?: boolean; scopes?: string[]; projects?: string[] | null } = {}) {
  const request = Object.fromEntries(authUrl.searchParams);
  const check = await asPerson(session, 'GET', `/oauth/authorize?${authUrl.searchParams}`);
  const decided = await asPerson(session, 'POST', '/oauth/authorize', { request, allow: decision.allow ?? true, scopes: decision.scopes ?? ['read', 'write'], projects: decision.projects ?? null });
  return { check: check.body, status: decided.status, redirect: decided.body?.redirect ? new URL(decided.body.redirect) : null, error: decided.body?.error };
}

/** An agent signed in all the way: registered, allowed by the person, its code exchanged. */
async function signedIn(session: string, agent = new Agent(), decision: Parameters<typeof consent>[2] = {}) {
  expect(await auth(agent, { serverUrl: MCP, fetchFn: fetchIn })).toBe('REDIRECT');
  const { redirect } = await consent(session, agent.authUrl!, decision);
  const code = redirect!.searchParams.get('code');
  expect(code).toMatch(/^a4c_/);
  expect(await auth(agent, { serverUrl: MCP, authorizationCode: code!, fetchFn: fetchIn })).toBe('AUTHORIZED');
  return agent;
}

async function mcp(bearer: string) {
  const transport = new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers: { authorization: `Bearer ${bearer}` } }, fetch: fetchIn });
  const c = new Client({ name: 'test', version: '1.0.0' });
  await c.connect(transport);
  return c;
}

async function whoami(bearer: string) {
  const c = await mcp(bearer);
  const res = await c.callTool({ name: 'get_current_user', arguments: {} });
  await c.close();
  return JSON.parse((res.content as { text: string }[])[0]!.text);
}

async function mcpStatus(bearer?: string) {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  return { status: res.status, challenge: res.headers.get('www-authenticate') };
}

const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

/** An authorization request made by hand, for what the SDK would never send. */
function handmade(clientId: string, extra: Record<string, string | undefined> = {}) {
  const verifier = randomBytes(32).toString('base64url');
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challengeOf(verifier),
    code_challenge_method: 'S256',
    state: 'st-1',
    resource: MCP,
    scope: 'read write',
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete params[k];
    else params[k] = v;
  }
  return { url: new URL(`${BASE}/oauth/authorize?${new URLSearchParams(params)}`), verifier };
}

beforeAll(async () => {
  w = await createWorld({ config: { publicUrl: BASE, mcpOAuth: true, trustProxy: 1 } });
  app = createHttpApp(w.app);
  sessions.anna = (await startSession(w.app.db, w.anna.id, 1)).token;
  sessions.vera = (await startSession(w.app.db, w.viewer.id, 1)).token;
  sessions.ben = (await startSession(w.app.db, w.ben.id, 1)).token;
  await createProject(w.adminCtx, { key: 'SECRET', name: 'Merger', template: 'software', visibility: 'members' });
  await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Rate limits for exports' });
  await createIssue(w.as(w.anna), { project: 'WEB', summary: 'Dark mode toggle' });
});

afterAll(async () => {
  await w?.close();
});

describe('discovery', () => {
  it('names where to sign in when /mcp is asked without a token', async () => {
    const res = await mcpStatus();
    expect(res.status).toBe(401);
    expect(res.challenge).toBe(`Bearer realm="a4a", resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", scope="read write"`);
  });

  it('serves the protected resource metadata at the address named, and at the root', async () => {
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        resource: MCP,
        authorization_servers: [BASE],
        scopes_supported: ['read', 'write'],
        bearer_methods_supported: ['header'],
        resource_name: 'a4a',
        resource_documentation: `${BASE}/api/docs`,
      });
    }
  });

  it('describes the authorization server: public clients, PKCE with S256, codes and refresh tokens', async () => {
    const res = await app.request('/.well-known/oauth-authorization-server');
    expect(await res.json()).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      revocation_endpoint: `${BASE}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      authorization_response_iss_parameter_supported: true,
    });
    // Nothing else is served in its place, such as the web app's page.
    const oidc = await app.request('/.well-known/openid-configuration');
    expect(oidc.status).toBe(404);
    expect(await oidc.json()).toMatchObject({ error: 'not_found' });
  });

  it('answers any origin at its own endpoints, and only there', async () => {
    const pre = await app.request('/oauth/token', { method: 'OPTIONS', headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    const meta = await app.request('/.well-known/oauth-authorization-server', { headers: { origin: 'https://app.example' } });
    expect(meta.headers.get('access-control-allow-origin')).toBe('*');
    expect(meta.headers.get('access-control-allow-credentials')).toBeNull();
    for (const path of ['/mcp', '/api/v1/auth/setup']) {
      const res = await app.request(path, { headers: { origin: 'https://app.example' } });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('says on the sign-in status that apps may sign in', async () => {
    const res = await app.request('/api/v1/auth/setup');
    expect(await res.json()).toMatchObject({ mcpOAuth: true });
  });
});

describe('registration', () => {
  it('registers a public client: an id, never a secret', async () => {
    const res = await register({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'client_secret_post' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      client_name: 'Claude',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    expect(res.body.client_id).toMatch(/^a4a-app-/);
    expect(res.body.client_secret).toBeUndefined();
  });

  it('refuses a redirect URI that is neither https nor this computer, and anything else it can’t do', async () => {
    const refused = [
      [{ redirect_uris: ['http://evil.example/cb'] }, 'invalid_redirect_uri'],
      [{ redirect_uris: ['javascript:alert(1)'] }, 'invalid_redirect_uri'],
      [{ redirect_uris: ['https://app.example/cb#frag'] }, 'invalid_redirect_uri'],
      [{ redirect_uris: ['https://user:pw@app.example/cb'] }, 'invalid_redirect_uri'],
      [{ redirect_uris: [] }, 'invalid_redirect_uri'],
      [{}, 'invalid_redirect_uri'],
      [{ redirect_uris: [CALLBACK], grant_types: ['client_credentials'] }, 'invalid_client_metadata'],
      [{ redirect_uris: [CALLBACK], response_types: ['token'] }, 'invalid_client_metadata'],
    ] as const;
    for (const [metadata, error] of refused) {
      const res = await register(metadata);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(error);
    }
    for (const ok of ['http://127.0.0.1/cb', 'http://localhost:33418/cb', 'http://[::1]:9/cb']) expect((await register({ redirect_uris: [ok] })).status).toBe(201);
  });

  it('keeps an app’s name to one plain line', async () => {
    const res = await register({ client_name: 'Claude‮\n\tlegit  ', redirect_uris: [CALLBACK] });
    expect(res.body.client_name).toBe('Claude legit');
  });

  it('limits registrations from one address', async () => {
    const one = createHttpApp(w.app);
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await one.request('/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.9.9.9' },
        body: JSON.stringify({ redirect_uris: [CALLBACK] }),
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 201)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

describe('signing an agent in', () => {
  it('takes an MCP client from a 401 to tools, as the SDK does it, acting as the person under the app’s name', async () => {
    const agent = await signedIn(sessions.anna);
    expect(agent.saved).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'read write' });
    expect(agent.saved!.access_token).toMatch(/^a4o_/);
    expect(agent.saved!.refresh_token).toMatch(/^a4r_/);
    expect(await whoami(agent.saved!.access_token)).toMatchObject({ login: 'anna', scopes: ['read', 'write'], via: 'mcp', token: 'Test agent' });

    // What it changes is recorded as Anna's, through MCP, under the app's name.
    const c = await mcp(agent.saved!.access_token);
    const made = await c.callTool({ name: 'create_issue', arguments: { project: 'BACK', summary: 'Filed by an app' } });
    expect(made.isError).toBeFalsy();
    const id = JSON.parse((made.content as { text: string }[])[0]!.text).id as string;
    await c.close();
    const history = await asPerson(sessions.anna, 'GET', `/issues/${id}/activity`);
    expect(history.body[0].actor).toMatchObject({ login: 'anna', channel: 'mcp', token: 'Test agent' });
  });

  it('shows the person what asks, and sends the code only to the address registered, with state and iss', async () => {
    const agent = new Agent('Claude');
    await auth(agent, { serverUrl: MCP, fetchFn: fetchIn });
    const { check, redirect } = await consent(sessions.anna, agent.authUrl!);
    expect(check).toMatchObject({
      ok: true,
      client: { name: 'Claude', redirectUri: CALLBACK, redirectHost: '127.0.0.1:8765', local: true },
      asked: ['read', 'write'],
      canWrite: true,
      remembered: null,
      ready: false,
    });
    expect(`${redirect!.origin}${redirect!.pathname}`).toBe(CALLBACK);
    expect(redirect!.searchParams.get('state')).toBe(agent.authUrl!.searchParams.get('state'));
    expect(redirect!.searchParams.get('iss')).toBe(BASE);
  });

  it('remembers what the person allowed: the same app asking no more carries on, asking more asks again', async () => {
    const reg = await register({ client_name: 'Reader', redirect_uris: [CALLBACK] });
    const first = handmade(reg.body.client_id, { scope: 'read' });
    await consent(sessions.ben, first.url, { scopes: ['read'], projects: ['WEB'] });
    const again = await asPerson(sessions.ben, 'GET', `/oauth/authorize?${handmade(reg.body.client_id, { scope: 'read' }).url.searchParams}`);
    expect(again.body).toMatchObject({ ok: true, ready: true, remembered: { scopes: ['read'], projects: ['WEB'] }, asked: ['read'] });
    const more = await asPerson(sessions.ben, 'GET', `/oauth/authorize?${handmade(reg.body.client_id, { scope: 'read write' }).url.searchParams}`);
    expect(more.body).toMatchObject({ ok: true, ready: false, asked: ['read', 'write'], remembered: { scopes: ['read'] } });
    // As the SDK asks: for what the server supports, the same each time. Allowed read only, it's remembered.
    const agent = new Agent('Asks for all');
    await signedIn(sessions.ben, agent, { scopes: ['read'] });
    agent.saved = undefined;
    await auth(agent, { serverUrl: MCP, fetchFn: fetchIn });
    expect((await asPerson(sessions.ben, 'GET', `/oauth/authorize?${agent.authUrl!.searchParams}`)).body).toMatchObject({ ready: true, remembered: { scopes: ['read'] } });
  });

  it('lets a desktop app come back on another loopback port, but nowhere it didn’t register', async () => {
    const agent = new Agent('Desktop', 'http://127.0.0.1/callback');
    await auth(agent, { serverUrl: MCP, fetchFn: fetchIn });
    const id = agent.info!.client_id;
    const port = handmade(id, { redirect_uri: 'http://127.0.0.1:51234/callback' });
    const ok = await consent(sessions.anna, port.url);
    expect(ok.redirect!.origin).toBe('http://127.0.0.1:51234');
    for (const elsewhere of ['http://127.0.0.1:51234/other', 'https://evil.example/callback', 'http://evil.example/callback']) {
      const bad = handmade(id, { redirect_uri: elsewhere });
      const check = await asPerson(sessions.anna, 'GET', `/oauth/authorize?${bad.url.searchParams}`);
      expect(check.body).toMatchObject({ ok: false, error: 'invalid_request', redirect: null });
      const decided = await asPerson(sessions.anna, 'POST', '/oauth/authorize', { request: Object.fromEntries(bad.url.searchParams), allow: true });
      expect(decided.status).toBe(400);
    }
  });

  it('shows an unknown app’s request on a4a’s page, and sends it nowhere', async () => {
    const { url } = handmade('a4a-app-nobody');
    const check = await asPerson(sessions.anna, 'GET', `/oauth/authorize?${url.searchParams}`);
    expect(check.body).toMatchObject({ ok: false, error: 'invalid_client', redirect: null });
  });

  it('sends a malformed request back to the app it came from, in OAuth’s words', async () => {
    const reg = await register({ redirect_uris: [CALLBACK] });
    const cases: [Record<string, string | undefined>, string][] = [
      [{ code_challenge: undefined }, 'invalid_request'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ code_challenge: 'short' }, 'invalid_request'],
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ resource: 'https://elsewhere.example/mcp' }, 'invalid_target'],
    ];
    for (const [extra, error] of cases) {
      const { url } = handmade(reg.body.client_id, extra);
      const check = await asPerson(sessions.anna, 'GET', `/oauth/authorize?${url.searchParams}`);
      expect(check.body.ok).toBe(false);
      const back = new URL(check.body.redirect);
      expect([`${back.origin}${back.pathname}`, back.searchParams.get('error'), back.searchParams.get('state')]).toEqual([CALLBACK, error, 'st-1']);
    }
  });

  it('tells the app the person declined', async () => {
    const reg = await register({ redirect_uris: [CALLBACK] });
    const { url } = handmade(reg.body.client_id);
    const { redirect } = await consent(sessions.anna, url, { allow: false });
    expect(redirect!.searchParams.get('error')).toBe('access_denied');
    expect(redirect!.searchParams.get('code')).toBeNull();
  });

  it('lets only a person on a4a’s page decide: not a token', async () => {
    const reg = await register({ redirect_uris: [CALLBACK] });
    const { url } = handmade(reg.body.client_id);
    const token = (await issueTokenFor(w.app.db, w.anna.id, { name: 'script', scopes: ['read', 'write'] })).token;
    const res = await app.request(`/api/v1/oauth/authorize?${url.searchParams}`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
    // Nor a page elsewhere, with the person's cookie.
    const cross = await app.request('/api/v1/oauth/authorize', {
      method: 'POST',
      headers: { cookie: `a4a_session=${sessions.anna}`, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ request: Object.fromEntries(url.searchParams), allow: true }),
    });
    expect(cross.status).toBe(403);
  });
});

describe('what the app may do', () => {
  it('can’t make changes for a person whose role only reads, whatever it asks', async () => {
    const agent = new Agent('Viewer’s agent');
    await auth(agent, { serverUrl: MCP, fetchFn: fetchIn });
    const { check, redirect } = await consent(sessions.vera, agent.authUrl!, { scopes: ['read', 'write'] });
    expect(check).toMatchObject({ canWrite: false });
    await auth(agent, { serverUrl: MCP, authorizationCode: redirect!.searchParams.get('code')!, fetchFn: fetchIn });
    expect(agent.saved!.scope).toBe('read');
    const c = await mcp(agent.saved!.access_token);
    const made = await c.callTool({ name: 'create_issue', arguments: { project: 'BACK', summary: 'Not allowed' } });
    expect(made.isError).toBe(true);
    await c.close();
  });

  it('reaches only the projects the person chose', async () => {
    const agent = await signedIn(sessions.anna, new Agent('Backend only'), { projects: ['BACK'] });
    expect(await whoami(agent.saved!.access_token)).toMatchObject({ onlyProjects: ['BACK'] });
    const c = await mcp(agent.saved!.access_token);
    const found = await c.callTool({ name: 'search_issues', arguments: { query: '' } });
    const text = (found.content as { text: string }[])[0]!.text;
    expect(text).toContain('BACK-');
    expect(text).not.toContain('WEB-');
    await c.close();
  });

  it('can’t be given a project the person can’t see, which answers as one that doesn’t exist', async () => {
    const reg = await register({ redirect_uris: [CALLBACK] });
    const { url } = handmade(reg.body.client_id);
    const hidden = await consent(sessions.ben, url, { projects: ['SECRET'] });
    const missing = await consent(sessions.ben, handmade(reg.body.client_id).url, { projects: ['NOPE'] });
    expect(hidden.status).toBe(404);
    expect(hidden.error.message.replace('SECRET', 'X')).toBe(missing.error.message.replace('NOPE', 'X'));
  });

  it('works at /mcp alone: the REST API refuses an app’s token', async () => {
    const agent = await signedIn(sessions.anna, new Agent('Audience'));
    const res = await app.request('/api/v1/me', { headers: { authorization: `Bearer ${agent.saved!.access_token}` } });
    expect(res.status).toBe(401);
    expect(JSON.parse(await res.text()).error.message).toBe('This token is an app’s, for MCP: it works at /mcp only');
  });
});

describe('codes and tokens', () => {
  it('exchanges a code once, and a code that comes back revokes what it gave', async () => {
    const reg = await register({ redirect_uris: [CALLBACK] });
    const { url, verifier } = handmade(reg.body.client_id);
    const code = (await consent(sessions.anna, url)).redirect!.searchParams.get('code')!;
    const exchange = { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.body.client_id, redirect_uri: CALLBACK, resource: MCP };
    const first = await form('/oauth/token', exchange);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect((await mcpStatus(first.body.access_token)).status).toBe(200);
    const second = await form('/oauth/token', exchange);
    expect(second.body).toMatchObject({ error: 'invalid_grant' });
    expect((await mcpStatus(first.body.access_token)).status).toBe(401);
    expect((await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: first.body.refresh_token, client_id: reg.body.client_id })).body.error).toBe('invalid_grant');
  });

  it('refuses the wrong verifier, redirect, resource or app, and a wrong try uses the code up', async () => {
    const reg = await register({ redirect_uris: [CALLBACK] });
    const other = await register({ redirect_uris: [CALLBACK] });
    const wrong: [Record<string, string>, string][] = [
      [{ code_verifier: randomBytes(32).toString('base64url') }, 'invalid_grant'],
      [{ redirect_uri: 'http://127.0.0.1:8765/elsewhere' }, 'invalid_grant'],
      [{ resource: 'https://elsewhere.example/mcp' }, 'invalid_target'],
      [{ client_id: other.body.client_id }, 'invalid_grant'],
      [{ client_id: 'a4a-app-nobody' }, 'invalid_client'],
    ];
    for (const [change, error] of wrong) {
      const { url, verifier } = handmade(reg.body.client_id);
      const code = (await consent(sessions.anna, url)).redirect!.searchParams.get('code')!;
      const right = { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.body.client_id, redirect_uri: CALLBACK };
      const res = await form('/oauth/token', { ...right, ...change });
      expect(res.body.error).toBe(error);
      if (error === 'invalid_grant') expect((await form('/oauth/token', right)).body.error).toBe('invalid_grant');
    }
  });

  it('lets a code expire after two minutes', async () => {
    const reg = await register({ redirect_uris: [CALLBACK] });
    const { url, verifier } = handmade(reg.body.client_id);
    const code = (await consent(sessions.anna, url)).redirect!.searchParams.get('code')!;
    await w.app.db.update(oauthCodes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(oauthCodes.id, createHash('sha256').update(code).digest('hex')));
    const res = await form('/oauth/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.body.client_id, redirect_uri: CALLBACK });
    expect(res.body).toMatchObject({ error: 'invalid_grant', error_description: 'The code expired: exchange it within two minutes' });
  });

  it('rotates the refresh token on each use, and a reused one revokes its whole family', async () => {
    const agent = await signedIn(sessions.anna, new Agent('Rotating'));
    const first = agent.saved!;
    // The SDK renews with the refresh token it has.
    expect(await auth(agent, { serverUrl: MCP, fetchFn: fetchIn })).toBe('AUTHORIZED');
    const second = agent.saved!;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await mcpStatus(second.access_token)).status).toBe(200);
    // The first refresh token again: someone else has it. Everything since that code goes.
    const reuse = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: first.refresh_token!, client_id: agent.info!.client_id });
    expect(reuse.body).toMatchObject({ error: 'invalid_grant' });
    expect(reuse.body.error_description).toContain('used already');
    expect((await mcpStatus(second.access_token)).status).toBe(401);
    const next = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: second.refresh_token!, client_id: agent.info!.client_id });
    expect(next.body.error).toBe('invalid_grant');
  });

  it('asks a client whose token expired to sign in again, at /mcp', async () => {
    const agent = await signedIn(sessions.anna, new Agent('Expiring'));
    await w.app.db.update(oauthTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(oauthTokens.id, createHash('sha256').update(agent.saved!.access_token).digest('hex')));
    const res = await mcpStatus(agent.saved!.access_token);
    expect(res.status).toBe(401);
    expect(res.challenge).toContain('error="invalid_token"');
    expect(res.challenge).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
  });

  it('revokes at the revocation endpoint: a refresh token takes its family with it', async () => {
    const agent = await signedIn(sessions.anna, new Agent('Revoking'));
    const res = await form('/oauth/revoke', { token: agent.saved!.refresh_token!, client_id: agent.info!.client_id });
    expect(res.status).toBe(200);
    expect((await mcpStatus(agent.saved!.access_token)).status).toBe(401);
    // Unknown tokens, or another app's, are answered the same, and nothing happens to them.
    const other = await signedIn(sessions.anna, new Agent('Other'));
    expect((await form('/oauth/revoke', { token: other.saved!.access_token, client_id: agent.info!.client_id })).status).toBe(200);
    expect((await mcpStatus(other.saved!.access_token)).status).toBe(200);
    expect((await form('/oauth/revoke', { token: 'a4o_nothing', client_id: agent.info!.client_id })).status).toBe(200);
  });
});

describe('the person stays in charge', () => {
  it('lists the apps they allowed, and revoking one ends its tokens at once', async () => {
    const agent = await signedIn(sessions.anna, new Agent('Listed app'), { projects: ['BACK'] });
    const list = await asPerson(sessions.anna, 'GET', '/me/oauth-grants');
    const mine = list.body.find((g: { client: { name: string } }) => g.client.name === 'Listed app');
    expect(mine).toMatchObject({ client: { redirectHosts: ['127.0.0.1:8765'] }, scopes: ['read', 'write'], projects: ['BACK'] });
    // Nobody else sees it, or can revoke it.
    expect((await asPerson(sessions.ben, 'GET', '/me/oauth-grants')).body.some((g: { id: string }) => g.id === mine.id)).toBe(false);
    expect((await asPerson(sessions.ben, 'DELETE', `/me/oauth-grants/${mine.id}`)).status).toBe(404);
    expect((await asPerson(sessions.anna, 'DELETE', `/me/oauth-grants/${mine.id}`)).status).toBe(204);
    expect((await mcpStatus(agent.saved!.access_token)).status).toBe(401);
    const renew = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: agent.saved!.refresh_token!, client_id: agent.info!.client_id });
    expect(renew.body.error).toBe('invalid_grant');
    // The next time, it asks again.
    agent.saved = undefined;
    await auth(agent, { serverUrl: MCP, fetchFn: fetchIn });
    expect((await asPerson(sessions.anna, 'GET', `/oauth/authorize?${agent.authUrl!.searchParams}`)).body).toMatchObject({ remembered: null, ready: false });
  });

  it('stops an app at once when its person is banned, and narrows it when their role is', async () => {
    const someone = await signedIn(sessions.ben, new Agent('Ben’s agent'));
    await updateUser(w.adminCtx, w.ben.id, { role: 'viewer' });
    expect(await whoami(someone.saved!.access_token)).toMatchObject({ scopes: ['read'] });
    await updateUser(w.adminCtx, w.ben.id, { banned: true });
    expect((await mcpStatus(someone.saved!.access_token)).status).toBe(401);
    await updateUser(w.adminCtx, w.ben.id, { banned: false, role: 'member' });
  });
});

describe('housekeeping', () => {
  it('prunes expired tokens and apps nobody allowed', async () => {
    const unused = await register({ redirect_uris: [CALLBACK] });
    const agent = await signedIn(sessions.anna, new Agent('Pruned'));
    const { oauthClients } = await import('../src/db/schema');
    await w.app.db.update(oauthClients).set({ createdAt: new Date(Date.now() - 2 * 86_400_000) }).where(eq(oauthClients.id, unused.body.client_id));
    await w.app.db.update(oauthTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(oauthTokens.id, createHash('sha256').update(agent.saved!.access_token).digest('hex')));
    await pruneOAuth(w.app.db);
    expect(await w.app.db.select().from(oauthClients).where(eq(oauthClients.id, unused.body.client_id))).toHaveLength(0);
    expect(await w.app.db.select().from(oauthTokens).where(eq(oauthTokens.id, createHash('sha256').update(agent.saved!.access_token).digest('hex')))).toHaveLength(0);
    // The app that is allowed stays, and renews.
    expect(await auth(agent, { serverUrl: MCP, fetchFn: fetchIn })).toBe('AUTHORIZED');
  });
});

describe('with OAuth off', () => {
  it('has no metadata, and /mcp asks for a token only', async () => {
    w.app.config.mcpOAuth = false;
    try {
      expect((await app.request('/.well-known/oauth-authorization-server')).status).toBe(404);
      expect((await app.request('/.well-known/oauth-protected-resource/mcp')).status).toBe(404);
      expect((await mcpStatus()).challenge).toBe('Bearer realm="a4a"');
      expect(await (await app.request('/api/v1/auth/setup')).json()).toMatchObject({ mcpOAuth: false });
      expect((await register({ redirect_uris: [CALLBACK] })).status).toBe(404);
    } finally {
      w.app.config.mcpOAuth = true;
    }
  });
});
