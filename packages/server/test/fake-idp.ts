/**
 * A small OpenID Connect provider for tests, made with jose: discovery, a JWKS, an authorization
 * step a test plays the person's part in, and a token endpoint that checks the client, the
 * redirect URI and PKCE as a real one does. A test can make it misbehave in one way at a time.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';

export interface Person {
  sub: string;
  email?: string;
  email_verified?: unknown;
  /** Microsoft Entra ID's word for an email, where it sends no email_verified. */
  xms_edov?: unknown;
  /** Entra ID's object id and tenant for the person, which Teams names them by (D42). */
  oid?: string;
  tid?: string;
  name?: string;
  preferred_username?: string;
  /** The groups claim, under whatever name the test configures. */
  groups?: unknown;
}

/** One way to get the next ID token wrong. */
export interface Misbehaviour {
  nonce?: string;
  audience?: string;
  issuer?: string;
  expiresIn?: number;
  /** Sign with a key that isn't in the JWKS, under the published key's id. */
  wrongKey?: boolean;
}

interface Grant {
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string;
  person: Person;
}

export class FakeIdp {
  url = '';
  readonly clientId = 'a4a-test';
  readonly clientSecret = 'test-secret-value';
  private server: Server | null = null;
  private key!: CryptoKey;
  private otherKey!: CryptoKey;
  private jwk!: JWK;
  private codes = new Map<string, Grant>();
  /** Applied to the next token only. */
  next: Misbehaviour = {};
  /** What the token endpoint was last sent. */
  lastTokenRequest: URLSearchParams | null = null;

  async start(): Promise<void> {
    const pair = await generateKeyPair('RS256', { extractable: true });
    this.key = pair.privateKey;
    this.jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    this.otherKey = (await generateKeyPair('RS256')).privateKey;
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  /**
   * The person signs in at the provider: given the URL a4a sent the browser to, the URL the
   * provider sends the browser back to. Checks what a provider checks of the request.
   */
  approve(authorizeUrl: string, person: Person): string {
    const u = new URL(authorizeUrl);
    const p = u.searchParams;
    if (u.origin + u.pathname !== `${this.url}/authorize`) throw new Error(`not this provider: ${authorizeUrl}`);
    if (p.get('client_id') !== this.clientId || p.get('response_type') !== 'code') throw new Error('bad client or response type');
    if (p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) throw new Error('no PKCE');
    if (!p.get('state') || !p.get('nonce')) throw new Error('no state or nonce');
    if (!(p.get('scope') ?? '').split(' ').includes('openid')) throw new Error('not OpenID Connect');
    const code = randomBytes(16).toString('hex');
    this.codes.set(code, { clientId: this.clientId, redirectUri: p.get('redirect_uri')!, challenge: p.get('code_challenge')!, nonce: p.get('nonce')!, person });
    const back = new URL(p.get('redirect_uri')!);
    back.searchParams.set('code', code);
    back.searchParams.set('state', p.get('state')!);
    return back.href;
  }

  /** The person says no at the provider. */
  deny(authorizeUrl: string): string {
    const p = new URL(authorizeUrl).searchParams;
    const back = new URL(p.get('redirect_uri')!);
    back.searchParams.set('error', 'access_denied');
    back.searchParams.set('state', p.get('state')!);
    return back.href;
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const path = new URL(req.url ?? '/', this.url).pathname;
    if (req.method === 'GET' && path === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: this.url,
        authorization_endpoint: `${this.url}/authorize`,
        token_endpoint: `${this.url}/token`,
        jwks_uri: `${this.url}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      });
    }
    if (req.method === 'GET' && path === '/jwks') return json(200, { keys: [this.jwk] });
    if (req.method === 'POST' && path === '/token') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      this.lastTokenRequest = form;
      const auth = req.headers.authorization ?? '';
      const [id, secret] = Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString('utf8').split(':').map(decodeURIComponent);
      if (id !== this.clientId || secret !== this.clientSecret) return json(401, { error: 'invalid_client' });
      const grant = this.codes.get(form.get('code') ?? '');
      this.codes.delete(form.get('code') ?? '');
      if (!grant || form.get('grant_type') !== 'authorization_code') return json(400, { error: 'invalid_grant' });
      // The redirect URI must be the very one the authorization request carried.
      if (form.get('redirect_uri') !== grant.redirectUri) return json(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      const verifier = form.get('code_verifier') ?? '';
      if (createHash('sha256').update(verifier).digest('base64url') !== grant.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE' });
      const m = this.next;
      this.next = {};
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({ ...grant.person, nonce: m.nonce ?? grant.nonce })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(m.issuer ?? this.url)
        .setAudience(m.audience ?? this.clientId)
        .setSubject(grant.person.sub)
        .setIssuedAt(now - 5)
        .setExpirationTime(now + (m.expiresIn ?? 300))
        .sign(m.wrongKey ? this.otherKey : this.key);
      return json(200, { access_token: randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: idToken });
    }
    json(404, { error: 'not_found' });
  }
}
