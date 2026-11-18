/**
 * An OpenID Connect provider for the specs that sign in through one (D63), on this machine:
 * discovery, its keys, an authorization step that signs in whoever the spec names and sends the
 * browser straight back, and a token endpoint that checks the client, the redirect URI and PKCE as
 * a real one does. Its ID tokens are RS256, signed with node's own crypto.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface IdpPerson {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
}

export interface FakeIdp {
  url: string;
  clientId: string;
  clientSecret: string;
  /** Who signs in at the next authorization; null says no, as a person cancelling would. */
  person: IdpPerson | null;
  close(): Promise<void>;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export async function startIdp(): Promise<FakeIdp> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'e2e', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { redirectUri: string; challenge: string; nonce: string; person: IdpPerson }>();
  const idp: FakeIdp = { url: '', clientId: 'a4a-e2e', clientSecret: 'e2e-client-secret', person: null, close: async () => {} };
  const token = (claims: Record<string, unknown>) => {
    const signed = `${b64url(JSON.stringify({ alg: 'RS256', kid: 'e2e', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
    return `${signed}.${b64url(sign('sha256', Buffer.from(signed), privateKey))}`;
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', idp.url);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: idp.url,
        authorization_endpoint: `${idp.url}/authorize`,
        token_endpoint: `${idp.url}/token`,
        jwks_uri: `${idp.url}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/authorize') {
      const p = url.searchParams;
      const back = new URL(p.get('redirect_uri') ?? '');
      if (!idp.person || p.get('client_id') !== idp.clientId || p.get('code_challenge_method') !== 'S256' || !p.get('nonce')) {
        back.searchParams.set('error', 'access_denied');
      } else {
        const code = randomBytes(16).toString('hex');
        codes.set(code, { redirectUri: back.href, challenge: p.get('code_challenge') ?? '', nonce: p.get('nonce') ?? '', person: idp.person });
        back.searchParams.set('code', code);
      }
      back.searchParams.set('state', p.get('state') ?? '');
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const [id, secret] = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString('utf8').split(':').map(decodeURIComponent);
        if (id !== idp.clientId || secret !== idp.clientSecret) return json(401, { error: 'invalid_client' });
        const grant = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        if (!grant || form.get('redirect_uri') !== grant.redirectUri) return json(400, { error: 'invalid_grant' });
        if (createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== grant.challenge) return json(400, { error: 'invalid_grant' });
        const now = Math.floor(Date.now() / 1000);
        const idToken = token({ ...grant.person, iss: idp.url, aud: idp.clientId, nonce: grant.nonce, iat: now - 5, exp: now + 300 });
        return json(200, { access_token: randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: idToken });
      });
      return;
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  idp.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  idp.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return idp;
}
