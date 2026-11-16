/**
 * The extension against a stand-in VS Code and a fake a4a: its client, its sign-in, its webview,
 * and its commands. What needs VS Code itself (the views drawn, the browser opened) isn't run here.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { A4a, A4aError, fromSelection, nameIssue } from '../src/a4a';
import { activate, baseOf } from '../src/extension';
import { escapeHtml, issueHtml } from '../src/issue-html';
import { signIn } from '../src/oauth';
import { state, Uri } from './vscode';

interface Call {
  name: string;
  args: Record<string, unknown>;
  auth: string | undefined;
}

const calls: Call[] = [];
let server: http.Server;
let base = '';
let challenge = '';
const issue = {
  id: 'BACK-12',
  url: 'https://a4a.example/issues/BACK-12',
  summary: 'Login <script>alert(1)</script> loops',
  project: 'BACK',
  fields: { State: 'Open', Assignee: 'anna' },
  tags: ['auth'],
  reporter: 'ben',
  created: '2026-03-01',
  updated: '2026-03-02',
  resolved: null,
  description: 'Steps & <b>things</b>',
  comments: [{ by: 'anna', text: 'Seen it' }],
};

function result(res: http.ServerResponse, data: unknown, isError = false) {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError, content: [{ type: 'text', text: isError ? String(data) : JSON.stringify(data) }] } }));
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://x');
      const json = (status: number, v: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));
      if (url.pathname === '/.well-known/oauth-authorization-server') return json(200, { authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register` });
      if (url.pathname === '/oauth/register') return json(201, { client_id: 'vscode-client', ...JSON.parse(body) });
      if (url.pathname === '/oauth/authorize') {
        // As a4a's consent page would, once the person allows it: back to the app, with a code.
        challenge = url.searchParams.get('code_challenge') ?? '';
        const back = new URL(url.searchParams.get('redirect_uri')!);
        back.searchParams.set('code', 'code-1');
        back.searchParams.set('state', url.searchParams.get('state')!);
        res.writeHead(302, { location: back.href }).end();
        return;
      }
      if (url.pathname === '/oauth/token') {
        const f = new URLSearchParams(body);
        const ok = f.get('code') === 'code-1' && createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') === challenge && f.get('resource') === `${base}/mcp`;
        return ok ? json(200, { access_token: 'a4a_oauth_access', refresh_token: 'r1', expires_in: 3600 }) : json(400, { error: 'invalid_grant' });
      }
      if (url.pathname === '/mcp') {
        if (!['Bearer a4a_api_token', 'Bearer a4a_oauth_access'].includes(req.headers.authorization ?? '')) return json(401, { error: { message: 'unknown token' } });
        const msg = JSON.parse(body) as { params: { name: string; arguments: Record<string, unknown> } };
        calls.push({ name: msg.params.name, args: msg.params.arguments, auth: req.headers.authorization });
        switch (msg.params.name) {
          case 'get_current_user':
            return result(res, { login: 'anna', name: 'Anna Schmidt' });
          case 'search_issues':
            return result(res, { total: 1, returned: 1, issues: [{ id: 'BACK-12', summary: 'Login loops', state: 'Open', priority: 'Major', type: 'Bug', assignee: 'anna', updated: '2026-03-02 10:00' }] });
          case 'get_issue':
            return result(res, issue);
          case 'apply_command':
            return msg.params.arguments.command === 'State Nope' ? result(res, 'Unknown value "Nope" for State', true) : result(res, { changed: 1 });
          case 'create_issue':
            return result(res, { id: 'BACK-13' });
        }
        return result(res, 'no such tool', true);
      }
      json(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('the client', () => {
  it('calls a4a’s tools over MCP, and says what a4a refused in its words', async () => {
    const a4a = new A4a(base, async () => 'a4a_api_token');
    expect((await a4a.search('for: me')).issues[0]!.id).toBe('BACK-12');
    await expect(a4a.apply('BACK-12', 'State Nope')).rejects.toMatchObject({ message: 'Unknown value "Nope" for State', kind: 'refused' });
    await expect(new A4a(base, async () => 'wrong').me()).rejects.toMatchObject({ kind: 'auth' });
    await expect(new A4a(base, async () => null).me()).rejects.toBeInstanceOf(A4aError);
  });

  it('names an issue in a commit message once, and drafts an issue from selected code', () => {
    expect(nameIssue('Fix the loop', 'BACK-12')).toBe('BACK-12 Fix the loop');
    expect(nameIssue('BACK-12 Fix the loop', 'BACK-12')).toBe('BACK-12 Fix the loop');
    expect(nameIssue('', 'BACK-12')).toBe('BACK-12 ');
    const d = fromSelection({ path: 'src/auth/session.ts', startLine: 10, endLine: 12, code: 'if (a) {\n  loop();\n}', language: 'typescript' });
    expect(d.summary).toBe('In session.ts: if (a) {');
    expect(d.description).toBe('`src/auth/session.ts`, lines 10–12:\n\n```typescript\nif (a) {\n  loop();\n}\n```\n');
  });

  it('takes only https addresses, or this computer', () => {
    expect(baseOf('https://a4a.acme.example/')).toBe('https://a4a.acme.example');
    expect(baseOf('http://a4a.acme.example')).toBeNull();
    expect(baseOf('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
  });
});

describe('signing in', () => {
  it('registers, sends the browser to a4a, takes the code on a loopback port, and exchanges it with PKCE', async () => {
    let opened = '';
    const tokens = await signIn(
      base,
      async (url) => {
        opened = url;
        // The browser: follow a4a's redirect back to the extension's loopback port.
        const res = await fetch(url, { redirect: 'manual' });
        await fetch(res.headers.get('location')!);
      },
      { timeoutMs: 5000 },
    );
    const q = new URL(opened).searchParams;
    expect([q.get('client_id'), q.get('code_challenge_method'), q.get('scope'), q.get('resource')]).toEqual(['vscode-client', 'S256', 'read write', `${base}/mcp`]);
    expect(q.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(tokens).toMatchObject({ accessToken: 'a4a_oauth_access', refreshToken: 'r1', clientId: 'vscode-client' });
  });
});

describe('the issue’s webview', () => {
  it('draws with Ocean’s stylesheets alone, under a strict policy, its words escaped', () => {
    const html = issueHtml(issue, { cspSource: 'vscode-webview://x', styles: ['vscode-webview://x/media/ocean/css/tokens.css'], nonce: 'n0nce' });
    expect(html).toContain(`content="default-src 'none'; style-src vscode-webview://x; font-src vscode-webview://x; img-src vscode-webview://x https:; script-src 'nonce-n0nce'"`);
    expect(html).toContain(escapeHtml(issue.summary));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<b>things</b>');
    expect(html).not.toMatch(/<style|style="/);
    expect(html.match(/<link rel="stylesheet"/g)).toHaveLength(1);
  });
});

describe('the extension', () => {
  const secrets = new Map<string, string>();
  const context = {
    subscriptions: [] as { dispose(): void }[],
    extensionUri: Uri.parse('/ext'),
    secrets: { get: async (k: string) => secrets.get(k), store: async (k: string, v: string) => void secrets.set(k, v), delete: async (k: string) => void secrets.delete(k) },
  };
  beforeEach(() => {
    state.reset();
    calls.length = 0;
    secrets.clear();
    state.config.set('url', base);
    activate(context as never);
  });
  const run = (name: string, ...args: unknown[]) => (state.commands.get(name) as (...a: unknown[]) => Promise<unknown>)(...args);

  it('registers its commands, and keeps an API token in SecretStorage, not settings', async () => {
    expect([...state.commands.keys()].sort()).toEqual(
      ['a4a.applyCommand', 'a4a.insertIssueId', 'a4a.newIssueFromSelection', 'a4a.openIssue', 'a4a.refresh', 'a4a.search', 'a4a.signIn', 'a4a.signOut', 'a4a.useToken'].sort(),
    );
    state.inputs.push('a4a_api_token');
    await run('a4a.useToken');
    expect(state.shown).toContainEqual({ level: 'info', text: 'a4a knows the token as Anna Schmidt.' });
    expect(JSON.parse(secrets.get('a4a.tokens')!)).toEqual({ base, apiToken: 'a4a_api_token' });
    expect([...state.config.values()].join(' ')).not.toContain('a4a_api_token');
  });

  it("offers a4a's MCP server to VS Code's agent, with the token kept here", async () => {
    secrets.set('a4a.tokens', JSON.stringify({ base, apiToken: 'a4a_api_token' }));
    const [def] = (await state.mcp!.provideMcpServerDefinitions()) as { uri: Uri; headers: Record<string, string> }[];
    expect(def!.uri.value).toBe(`${base}/mcp`);
    const resolved = (await state.mcp!.resolveMcpServerDefinition(def)) as { headers: Record<string, string> };
    expect(resolved.headers.Authorization).toBe('Bearer a4a_api_token');
  });

  it('opens an issue beside the code, and applies a command from it', async () => {
    secrets.set('a4a.tokens', JSON.stringify({ base, apiToken: 'a4a_api_token' }));
    await run('a4a.openIssue', 'BACK-12');
    const panel = state.panels[0]!;
    expect(panel.html).toContain('/ext/media/ocean/css/components.css">');
    await panel.receive!({ type: 'command', issue: 'BACK-12', text: 'State Fixed' });
    expect(calls.at(-1)).toMatchObject({ name: 'apply_command', args: { issues: ['BACK-12'], command: 'State Fixed' } });
    expect(panel.posted).toContainEqual({ type: 'said', text: 'Applied: State Fixed' });
    await panel.receive!({ type: 'command', issue: 'BACK-12', text: 'State Nope' });
    expect(panel.posted.at(-1)).toEqual({ type: 'said', text: 'Unknown value "Nope" for State' });
  });

  it('makes an issue from the selected code, and names an issue in the commit message', async () => {
    secrets.set('a4a.tokens', JSON.stringify({ base, apiToken: 'a4a_api_token' }));
    state.editor = { text: 'while (true) retry();', startLine: 40, endLine: 40, path: 'src/sync.ts', languageId: 'typescript' };
    state.inputs.push('back', 'Sync retries forever');
    await run('a4a.newIssueFromSelection');
    expect(calls.at(-1)).toMatchObject({ name: 'create_issue', args: { project: 'BACK', summary: 'Sync retries forever', description: '`src/sync.ts`, line 40:\n\n```typescript\nwhile (true) retry();\n```\n' } });
    state.commitBox = { value: 'Stop retrying' };
    state.picks.push('BACK-12');
    await run('a4a.insertIssueId');
    expect(state.commitBox.value).toBe('BACK-12 Stop retrying');
  });

  it('asks to sign in first, rather than failing', async () => {
    await run('a4a.applyCommand');
    expect(state.shown).toContainEqual({ level: 'error', text: 'Sign in to a4a first: a4a: Sign in.' });
  });
});
