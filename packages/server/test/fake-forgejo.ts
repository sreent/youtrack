/**
 * A Forgejo (or Gitea) as its OAuth2 provider meets a4a (D54, D66), on this machine: the authorization
 * code checked with the app's secret, the redirect and the PKCE verifier, as Forgejo checks them;
 * GET /api/v1/user for whose a token is; and its OpenID discovery document, which says what it
 * offers. As documented, Forgejo offers neither revocation nor scopes; a test can give this one
 * either: a scope in the token's answer, introspection (RFC 7662) that says the grant's, and
 * revocation (RFC 7009) that ends a token.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ForgeMode {
  /** Where the instance says what it granted: nowhere, in the token's answer, or by introspection. */
  scopes: 'none' | 'answer' | 'introspection';
  /** What it says it granted. */
  granted: string;
  /** Whether it offers revocation, in its discovery document. */
  revokes: boolean;
}

export interface FakeForgejo {
  url: string;
  mode: ForgeMode;
  account: { id: number; login: string };
  /** Each code's PKCE challenge, as the browser's sign-in would have left it. */
  challenges: Map<string, string>;
  exchanges: URLSearchParams[];
  /** Tokens asked who they are with, in order. */
  asked: string[];
  revoked: { token: string; hint: string | null }[];
  introspected: string[];
  /** Tokens it gave, and whether each still works. */
  live: Set<string>;
  close(): Promise<void>;
}

export async function startFakeForgejo(opts: { clientId: string; clientSecret: string; callback: () => string }): Promise<FakeForgejo> {
  const f: Omit<FakeForgejo, 'url' | 'close'> = {
    mode: { scopes: 'none', granted: 'read:user', revokes: false },
    account: { id: 31, login: 'Anna-S' },
    challenges: new Map(),
    exchanges: [],
    asked: [],
    revoked: [],
    introspected: [],
    live: new Set(),
  };
  let n = 0;
  const client = (auth: string | undefined) => auth === `Basic ${Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64')}`;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      const form = () => new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      if (url.pathname === '/.well-known/openid-configuration') {
        // Gitea's and Forgejo's document, with what this one offers beside it.
        return send(200, {
          issuer: `${base}/`,
          authorization_endpoint: `${base}/login/oauth/authorize`,
          token_endpoint: `${base}/login/oauth/access_token`,
          userinfo_endpoint: `${base}/login/oauth/userinfo`,
          scopes_supported: ['openid', 'profile', 'email', 'groups'],
          code_challenge_methods_supported: ['plain', 'S256'],
          ...(f.mode.scopes === 'introspection' ? { introspection_endpoint: `${base}/login/oauth/introspect` } : {}),
          ...(f.mode.revokes ? { revocation_endpoint: `${base}/login/oauth/revoke` } : {}),
        });
      }
      if (url.pathname === '/login/oauth/access_token' && req.method === 'POST') {
        const body = form();
        f.exchanges.push(body);
        const code = body.get('code') ?? '';
        const pkce = createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url') === f.challenges.get(code);
        if (body.get('grant_type') !== 'authorization_code' || body.get('client_id') !== opts.clientId || body.get('client_secret') !== opts.clientSecret || !pkce || body.get('redirect_uri') !== opts.callback()) {
          return send(400, { error: 'unauthorized_client', error_description: 'invalid code' });
        }
        f.challenges.delete(code);
        n++;
        const [access, refresh] = [`forgejo_access_${n}`, `forgejo_refresh_${n}`];
        f.live.add(access).add(refresh);
        return send(200, { access_token: access, token_type: 'bearer', expires_in: 3600, refresh_token: refresh, ...(f.mode.scopes === 'answer' ? { scope: f.mode.granted } : {}) });
      }
      if (url.pathname === '/login/oauth/introspect' && req.method === 'POST' && f.mode.scopes === 'introspection') {
        if (!client(req.headers.authorization)) return send(401, { message: 'no valid authorization' });
        const token = form().get('token') ?? '';
        f.introspected.push(token);
        return send(200, f.live.has(token) ? { active: true, scope: f.mode.granted, username: f.account.login } : { active: false });
      }
      if (url.pathname === '/login/oauth/revoke' && req.method === 'POST' && f.mode.revokes) {
        if (!client(req.headers.authorization)) return send(401, { message: 'no valid authorization' });
        const body = form();
        const token = body.get('token') ?? '';
        f.revoked.push({ token, hint: body.get('token_type_hint') });
        // A refresh token ends its grant: the access token with it.
        f.live.delete(token);
        if (token.startsWith('forgejo_refresh_')) f.live.delete(token.replace('refresh', 'access'));
        return res.writeHead(200).end();
      }
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (url.pathname === '/api/v1/user') {
        f.asked.push(bearer);
        return f.live.has(bearer) ? send(200, { ...f.account, username: f.account.login }) : send(401, { message: 'invalid token' });
      }
      send(404, { message: 'not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return Object.assign(f, { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
}
