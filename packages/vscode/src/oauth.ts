/**
 * Signing in to a4a from VS Code, as any MCP app does (D28): the a4a's own metadata, the app
 * registered as a public client (dynamic registration), the browser sent to a4a's consent page,
 * and the code sent back to a loopback port only this process listens on (RFC 8252), exchanged
 * with PKCE. The token is for a4a's MCP server, which is how the extension talks to it.
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Fetch } from './a4a';

export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  /** When it runs out, in ms since 1970. */
  expiresAt: number | null;
  clientId: string;
}

interface Metadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

const b64url = (b: Buffer) => b.toString('base64url');

export function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

async function json<T>(fetchImpl: Fetch, url: string, init?: RequestInit): Promise<T> {
  const res = await fetchImpl(url, init);
  const text = await res.text();
  if (!res.ok) {
    let said = '';
    try {
      const j = JSON.parse(text) as { error_description?: string; error?: string };
      said = j.error_description ?? j.error ?? '';
    } catch {
      // not JSON
    }
    throw new Error(`${new URL(url).pathname} answered ${res.status}${said ? `: ${said}` : ''}`);
  }
  return JSON.parse(text) as T;
}

/** The address a token is for: a4a's MCP server (RFC 8707). */
const resourceOf = (base: string) => `${base}/mcp`;

function form(fields: Record<string, string>): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(fields).toString() };
}

function tokensOf(got: { access_token: string; refresh_token?: string; expires_in?: number }, clientId: string): Tokens {
  return { accessToken: got.access_token, refreshToken: got.refresh_token ?? null, expiresAt: got.expires_in ? Date.now() + got.expires_in * 1000 : null, clientId };
}

/**
 * The whole round trip: listen on a loopback port, register, send the browser (through `open`),
 * wait for the code, exchange it. Gives up after `timeoutMs`.
 */
export async function signIn(base: string, open: (url: string) => PromiseLike<unknown>, opts: { fetchImpl?: Fetch; timeoutMs?: number; clientId?: string | null } = {}): Promise<Tokens> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const meta = await json<Metadata>(fetchImpl, `${base}/.well-known/oauth-authorization-server`);
  const state = b64url(randomBytes(16));
  const { verifier, challenge } = pkce();
  let resolve!: (v: { code: string }) => void;
  let reject!: (e: Error) => void;
  const got = new Promise<{ code: string }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') return void res.writeHead(404).end();
    const done = (words: string) => res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(words);
    if (url.searchParams.get('state') !== state) {
      done('That sign-in was not the one VS Code started. Go back to VS Code and sign in again.');
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      done('a4a said no, so VS Code is not signed in. You can close this tab.');
      reject(new Error(url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? 'a4a sent no code'));
      return;
    }
    done('Signed in: you can close this tab and go back to VS Code.');
    resolve({ code });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
  const timer = setTimeout(() => reject(new Error('The sign-in took too long.')), opts.timeoutMs ?? 5 * 60_000);
  try {
    let clientId = opts.clientId ?? null;
    if (!clientId) {
      if (!meta.registration_endpoint) throw new Error('This a4a takes no app registrations: use an API token instead.');
      const reg = await json<{ client_id: string }>(fetchImpl, meta.registration_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        // A loopback redirect is matched on any port (RFC 8252), so one registration serves each sign-in.
        body: JSON.stringify({ client_name: 'a4a for VS Code', redirect_uris: ['http://127.0.0.1/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
      });
      clientId = reg.client_id;
    }
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256', scope: 'read write', resource: resourceOf(base) });
    await open(`${meta.authorization_endpoint}?${q}`);
    const { code } = await got;
    const tokens = await json<{ access_token: string; refresh_token?: string; expires_in?: number }>(
      fetchImpl,
      meta.token_endpoint,
      form({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource: resourceOf(base) }),
    );
    return tokensOf(tokens, clientId);
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

/** A new access token for one that ran out. */
export async function refresh(base: string, tokens: Tokens, fetchImpl: Fetch = fetch): Promise<Tokens> {
  if (!tokens.refreshToken) throw new Error('Sign in again.');
  const meta = await json<Metadata>(fetchImpl, `${base}/.well-known/oauth-authorization-server`);
  const got = await json<{ access_token: string; refresh_token?: string; expires_in?: number }>(
    fetchImpl,
    meta.token_endpoint,
    form({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: tokens.clientId, resource: resourceOf(base) }),
  );
  return { ...tokensOf(got, tokens.clientId), refreshToken: got.refresh_token ?? tokens.refreshToken };
}
