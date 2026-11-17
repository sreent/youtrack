/**
 * MCP's newer client identification (D38): apps known by a client ID metadata document, read with
 * the SSRF guard, and the step-up an app allowed only to read gets when it tries to change things.
 * The documents are served by a server made for the test, on this machine.
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { oauthClients } from '../src/db/schema';
import { createHttpApp } from '../src/http/app';
import { keepFor } from '../src/oauth/client-documents';
import { startSession } from '../src/services/auth';
import { TOOLS } from '../src/tools/registry';
import { createWorld, type TestWorld } from './helpers';

const BASE = 'http://localhost:3000';
const MCP = `${BASE}/mcp`;
const CALLBACK = 'http://127.0.0.1:8765/callback';
let w: TestWorld;
let app: ReturnType<typeof createHttpApp>;
let docs: http.Server;
let origin = '';
const served = new Map<string, { status?: number; type?: string; body: string; headers?: Record<string, string> }>();
const reads: string[] = [];
const sessions = { anna: '', vera: '' };
let addresses = 0;
const from = () => `10.3.${Math.floor(++addresses / 250)}.${addresses % 250}`;

/** A document at a path of the test's server, naming itself unless told otherwise. */
function serve(path: string, doc: Record<string, unknown> | string, opts: { status?: number; type?: string; headers?: Record<string, string> } = {}) {
  const url = `${origin}${path}`;
  const body = typeof doc === 'string' ? doc : JSON.stringify({ client_id: url, client_name: 'Doc Agent', redirect_uris: [CALLBACK], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none', ...doc });
  served.set(path, { body, ...opts });
  return url;
}

async function asPerson(session: string, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { cookie: `a4a_session=${session}`, origin: BASE, 'x-forwarded-for': from() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(`/api/v1${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function authorizeParams(clientId: string) {
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'st-1',
    resource: MCP,
    scope: 'read write',
  });
  return { params, verifier };
}

/** The person on the consent page, then the app at the token endpoint: an access token, or what went wrong. */
async function connect(clientId: string, session = sessions.anna, scopes = ['read', 'write']) {
  const { params, verifier } = authorizeParams(clientId);
  const check = await asPerson(session, 'GET', `/oauth/authorize?${params}`);
  if (!check.body?.ok) return { check: check.body, token: null };
  const decided = await asPerson(session, 'POST', '/oauth/authorize', { request: Object.fromEntries(params), allow: true, scopes, projects: null });
  const code = new URL(decided.body.redirect).searchParams.get('code')!;
  const res = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': from() },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: verifier, resource: MCP }).toString(),
  });
  const token = JSON.parse(await res.text());
  return { check: check.body, token: token.access_token as string | undefined, tokenResponse: token };
}

async function rawMcp(bearer: string, body: unknown) {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${bearer}`, 'x-forwarded-for': from() },
    body: JSON.stringify(body),
  });
  return { status: res.status, challenge: res.headers.get('www-authenticate'), body: JSON.parse(await res.text()) };
}

beforeAll(async () => {
  docs = http.createServer((req, res) => {
    reads.push(req.url ?? '');
    const doc = served.get(req.url ?? '');
    if (!doc) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(doc.status ?? 200, { 'content-type': doc.type ?? 'application/json', ...doc.headers });
    res.end(doc.body);
  });
  await new Promise<void>((resolve) => docs.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(docs.address() as AddressInfo).port}`;
  w = await createWorld({ config: { publicUrl: BASE, mcpOAuth: true, trustProxy: 1, oauthClientDocumentsAllowHttpLoopback: true } });
  app = createHttpApp(w.app);
  sessions.anna = (await startSession(w.app.db, w.anna.id, 1)).token;
  sessions.vera = (await startSession(w.app.db, w.viewer.id, 1)).token;
});

afterAll(async () => {
  await w?.close();
  await new Promise<void>((resolve) => docs.close(() => resolve()));
});

describe('client ID metadata documents', () => {
  it('are offered in the server’s metadata', async () => {
    const meta = JSON.parse(await (await app.request('/.well-known/oauth-authorization-server')).text());
    expect(meta.client_id_metadata_document_supported).toBe(true);
  });

  it('let an app connect with its document’s address as its id, the host shown on the consent page', async () => {
    const id = serve('/apps/doc-agent.json', { client_name: 'Doc Agent', software_id: 'doc-agent' }, { headers: { 'cache-control': 'public, max-age=600' } });
    const before = reads.length;
    const { check, token } = await connect(id);
    expect(check).toMatchObject({ ok: true, client: { id, name: 'Doc Agent', documentHost: new URL(origin).host, redirectHost: '127.0.0.1:8765' } });
    expect(token).toMatch(/^a4o_|./);
    expect(reads.length).toBe(before + 1);
    const [row] = await w.app.db.select().from(oauthClients).where(eq(oauthClients.id, id));
    expect(row!.documentExpiresAt!.getTime() - row!.documentFetchedAt!.getTime()).toBe(600_000);
    // The token works at /mcp, as any app's.
    const transport = new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': from() } }, fetch: async (input, init) => app.request(String(input), init) });
    const c = new Client({ name: 'test', version: '1.0.0' });
    await c.connect(transport);
    const me = await c.callTool({ name: 'get_current_user', arguments: {} });
    expect(JSON.parse((me.content as { text: string }[])[0]!.text)).toMatchObject({ login: 'anna' });
    await c.close();
  });

  it('read the document once while it holds, and again once it has run out', async () => {
    const id = `${origin}/apps/doc-agent.json`;
    const before = reads.length;
    expect((await connect(id)).check.ok).toBe(true);
    expect(reads.length).toBe(before);
    served.get('/apps/doc-agent.json')!.body = JSON.stringify({ client_id: id, client_name: 'Doc Agent 2', redirect_uris: [CALLBACK] });
    await w.app.db.update(oauthClients).set({ documentExpiresAt: new Date(Date.now() - 1000) }).where(eq(oauthClients.id, id));
    const again = await connect(id);
    expect(again.check.client.name).toBe('Doc Agent 2');
    expect(reads.length).toBe(before + 1);
  });

  it('keep a reading between five minutes and a day', () => {
    expect(keepFor(undefined)).toBe(3600);
    expect(keepFor('max-age=10')).toBe(300);
    expect(keepFor('public, max-age=999999')).toBe(86_400);
    expect(keepFor('no-store')).toBe(300);
  });

  it('refuse a document that doesn’t hold, and say why on a4a’s own page', async () => {
    const cases: Array<[string, RegExp]> = [
      [serve('/bad/other-id.json', { client_id: 'https://elsewhere.example/app.json' }), /names another client_id/],
      [serve('/bad/secret.json', { client_secret: 'shh' }), /client secret/],
      [serve('/bad/confidential.json', { token_endpoint_auth_method: 'client_secret_basic' }), /public clients/],
      [serve('/bad/redirect.json', '', { status: 302, headers: { location: 'http://10.0.0.1/app.json' } }), /follows no redirects/],
      [serve('/bad/html.json', '<html></html>', { type: 'text/html' }), /isn’t JSON/],
      [serve('/bad/big.json', { client_name: 'x'.repeat(6000) }), /larger than 5 KB/],
      [serve('/bad/no-redirects.json', { redirect_uris: [] }), /redirect_uris/],
      [serve('/bad/plain-http-redirect.json', { redirect_uris: ['http://app.example/callback'] }), /neither https nor http to this computer/],
      [`${origin}/bad/missing.json`, /answered 404/],
      [`${origin}/`, /needs a path/],
      [`${origin}/apps/../apps/doc-agent.json`, /\. or \.\./],
      [`${origin}/apps/%2e%2e/apps/doc-agent.json`, /\. or \.\./],
      [`${origin}/apps/doc-agent.json#x`, /fragment/],
    ];
    for (const [id, why] of cases) {
      const { params } = authorizeParams(id);
      const res = await asPerson(sessions.anna, 'GET', `/oauth/authorize?${params}`);
      expect(res.body, id).toMatchObject({ ok: false, error: 'invalid_client' });
      expect(res.body.message, id).toMatch(why);
      // Errors are shown on a4a's page: nothing is sent to an address the document named.
      expect(res.body.redirect, id).toBeNull();
    }
  });

  it('read nothing inside the network, however it is named, in production', async () => {
    const config = w.app.config;
    config.oauthClientDocumentsAllowHttpLoopback = false;
    try {
      const before = reads.length;
      for (const [id, why] of [
        [serve('/apps/never-read.json', {}), /https/],
        ['https://127.0.0.1/app.json', /inside the network/],
        ['https://10.1.2.3/app.json', /inside the network/],
        ['https://[::1]/app.json', /inside the network/],
        ['https://169.254.169.254/latest/meta-data.json', /inside the network/],
        ['https://localhost/app.json', /inside the network/],
        ['https://user:pw@app.example/app.json', /name and password/],
      ] as const) {
        const { params } = authorizeParams(id);
        const res = await asPerson(sessions.anna, 'GET', `/oauth/authorize?${params}`);
        expect(res.body, id).toMatchObject({ ok: false, error: 'invalid_client' });
        expect(res.body.message, id).toMatch(why);
      }
      expect(reads.length).toBe(before);
    } finally {
      config.oauthClientDocumentsAllowHttpLoopback = true;
    }
  });

  it('are unknown ids when an administrator turns them off', async () => {
    w.app.config.oauthClientDocuments = false;
    try {
      const meta = JSON.parse(await (await app.request('/.well-known/oauth-authorization-server')).text());
      expect(meta.client_id_metadata_document_supported).toBe(false);
      const { params } = authorizeParams(serve('/apps/off.json', {}));
      const res = await asPerson(sessions.anna, 'GET', `/oauth/authorize?${params}`);
      expect(res.body).toMatchObject({ ok: false, error: 'invalid_client' });
      expect(res.body.message).toMatch(/isn’t registered/);
    } finally {
      w.app.config.oauthClientDocuments = true;
    }
  });
});

describe('stepping up to write', () => {
  const changing = TOOLS.find((t) => t.kind === 'changes')!.name;
  const reading = 'get_current_user';
  const call = (name: string) => ({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: {} } });

  it('asks an app allowed only to read for write when it calls a tool that changes things', async () => {
    const id = serve('/apps/reader.json', { client_name: 'Reader' });
    const { token } = await connect(id, sessions.anna, ['read']);
    const res = await rawMcp(token!, call(changing));
    expect(res.status).toBe(403);
    expect(res.challenge).toMatch(/^Bearer realm="a4a", error="insufficient_scope", error_description="[^"]+", resource_metadata="http:\/\/localhost:3000\/\.well-known\/oauth-protected-resource\/mcp", scope="read write"$/);
    expect(res.body.error).toMatchObject({ code: 'insufficient_scope' });
    // In a batch too.
    expect((await rawMcp(token!, [call(reading), call(changing)])).status).toBe(403);
    // Reading is let through.
    expect((await rawMcp(token!, call(reading))).status).not.toBe(403);
    // Asked again, the person allows writing: the same call goes through.
    const stepped = await connect(id, sessions.anna, ['read', 'write']);
    expect((await rawMcp(stepped.token!, call(changing))).status).not.toBe(403);
  });

  it('doesn’t ask when the person couldn’t allow it: a viewer’s app gets the tool’s own refusal', async () => {
    const id = serve('/apps/viewer.json', { client_name: 'Viewer app' });
    const { token } = await connect(id, sessions.vera, ['read']);
    expect(token).toBeTruthy();
    expect((await rawMcp(token!, call(changing))).status).not.toBe(403);
  });
});
