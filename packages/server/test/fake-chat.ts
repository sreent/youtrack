/**
 * Fakes of the chat services a4a talks to (D42), on port 0: Bot Framework for Teams (its OpenID
 * metadata and keys, Entra's token endpoint, the connector a bot posts to) and Slack's Web API.
 */
import { createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

async function listen(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void | Promise<void>): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (body += c));
    req.on('end', () => void Promise.resolve(handler(req, body, res)).catch((e: unknown) => res.writeHead(500).end(String(e))));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => void
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));

export interface Posted {
  conversationId: string;
  activity: Record<string, unknown>;
}

/** Bot Framework and Entra, as a Teams bot meets them. */
export class FakeTeams {
  readonly appId = '0f1e2d3c-aaaa-bbbb-cccc-123456789abc';
  readonly appPassword = 'bot-secret';
  readonly tenantId = '72f988bf-0000-1111-2222-333344445555';
  readonly kid = 'key-1';
  url = '';
  posted: Posted[] = [];
  personalChats: string[] = [];
  tokensIssued = 0;
  /** A conversation's next answers: a status and body, and a Retry-After. */
  failures = new Map<string, { status: number; body?: unknown; retryAfter?: string }[]>();
  channels: { id: string; name?: string }[] = [];
  private server: Server | null = null;
  private privateKey: KeyObject;
  private publicJwk: Record<string, unknown>;
  /** Another key, Bot Framework's in nobody's dreams: what a forger signs with. */
  readonly forgerKey: KeyObject;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = privateKey;
    this.publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: this.kid, use: 'sig', endorsements: ['msteams'] };
    this.forgerKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  }

  get serviceUrl() {
    return `${this.url}/amer/`;
  }

  async start(): Promise<this> {
    const { server, url } = await listen((req, body, res) => this.handle(req, body, res));
    this.server = server;
    this.url = url;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  /** Bot Framework's token on a request to the bot. */
  token(claims: Record<string, unknown> = {}, opts: { key?: KeyObject; kid?: string } = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT', kid: opts.kid ?? this.kid };
    const payload = { iss: 'https://api.botframework.com', aud: this.appId, exp: now + 3600, nbf: now - 10, serviceurl: this.serviceUrl, ...claims };
    const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const signed = `${part(header)}.${part(payload)}`;
    return `${signed}.${sign('RSA-SHA256', Buffer.from(signed), opts.key ?? this.privateKey).toString('base64url')}`;
  }

  postsTo(conversationId: string): Record<string, unknown>[] {
    return this.posted.filter((p) => p.conversationId === conversationId).map((p) => p.activity);
  }

  private handle(req: IncomingMessage, body: string, res: ServerResponse): void {
    const path = (req.url ?? '').split('?')[0]!;
    if (req.method === 'GET' && path === '/openid') return json(res, 200, { issuer: 'https://api.botframework.com', jwks_uri: `${this.url}/keys` });
    if (req.method === 'GET' && path === '/keys') return json(res, 200, { keys: [this.publicJwk] });
    if (req.method === 'POST' && path === '/token') {
      const form = new URLSearchParams(body);
      if (form.get('client_id') !== this.appId || form.get('client_secret') !== this.appPassword) return json(res, 401, { error: 'invalid_client', error_description: 'Bad secret' });
      this.tokensIssued++;
      return json(res, 200, { access_token: `bot-token-${this.tokensIssued}`, expires_in: 3600, token_type: 'Bearer' });
    }
    if (!path.startsWith('/amer/v3/')) return json(res, 404, { error: { code: 'NotFound' } });
    if (!/^Bearer bot-token-\d+$/.test(req.headers.authorization ?? '')) return json(res, 401, { error: { code: 'Unauthorized' } });
    const rest = path.slice('/amer/v3/'.length);
    if (req.method === 'POST' && rest === 'conversations') {
      const b = JSON.parse(body) as { members?: { id?: string }[] };
      const id = `a:personal-${b.members?.[0]?.id ?? 'someone'}`;
      this.personalChats.push(id);
      return json(res, 200, { id });
    }
    const teams = /^teams\/([^/]+)\/conversations$/.exec(rest);
    if (req.method === 'GET' && teams) return json(res, 200, { conversations: this.channels });
    const m = /^conversations\/([^/]+)\/activities(?:\/[^/]+)?$/.exec(rest);
    if (req.method === 'POST' && m) {
      const conversationId = decodeURIComponent(m[1]!);
      const fail = this.failures.get(conversationId)?.shift();
      if (fail) return json(res, fail.status, fail.body ?? {}, fail.retryAfter ? { 'retry-after': fail.retryAfter } : {});
      this.posted.push({ conversationId, activity: JSON.parse(body) as Record<string, unknown> });
      return json(res, 200, { id: `activity-${this.posted.length}` });
    }
    return json(res, 404, { error: { code: 'NotFound' } });
  }
}

export interface SlackCall {
  method: string;
  body: Record<string, unknown>;
  token: string;
}

/** Slack's Web API, as a4a's app calls it. */
export class FakeSlack {
  readonly teamId = 'T0ACME';
  readonly botToken = 'xoxb-1111-2222-acme';
  readonly signingSecret = '8f742231b10e8888abcd99yyyzzz85a5';
  readonly botUserId = 'UA4ABOT';
  url = '';
  calls: SlackCall[] = [];
  /** A method's next answers. */
  failures = new Map<string, { status?: number; body?: Record<string, unknown>; retryAfter?: string }[]>();
  private server: Server | null = null;

  async start(): Promise<this> {
    const { server, url } = await listen((req, body, res) => this.handle(req, body, res));
    this.server = server;
    this.url = url;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  get apiUrl() {
    return `${this.url}/api`;
  }

  callsOf(method: string): SlackCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Headers as Slack signs a request it sends. */
  signed(body: string, opts: { secret?: string; at?: number } = {}): Record<string, string> {
    const ts = String(opts.at ?? Math.floor(Date.now() / 1000));
    const sig = `v0=${createHmac('sha256', opts.secret ?? this.signingSecret).update(`v0:${ts}:${body}`).digest('hex')}`;
    return { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig };
  }

  private handle(req: IncomingMessage, raw: string, res: ServerResponse): void {
    const method = (req.url ?? '').replace(/^\/api\//, '').split('?')[0]!;
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const body = (req.headers['content-type'] ?? '').startsWith('application/json') ? (JSON.parse(raw || '{}') as Record<string, unknown>) : Object.fromEntries(new URLSearchParams(raw));
    this.calls.push({ method, body, token });
    const fail = this.failures.get(method)?.shift();
    if (fail) return json(res, fail.status ?? 200, fail.body ?? { ok: false, error: 'failed' }, fail.retryAfter ? { 'retry-after': fail.retryAfter } : {});
    if (token !== this.botToken) return json(res, 200, { ok: false, error: 'invalid_auth' });
    switch (method) {
      case 'auth.test':
        return json(res, 200, { ok: true, team_id: this.teamId, team: 'Acme', user_id: this.botUserId, bot_id: 'B1' });
      case 'conversations.list':
        return json(res, 200, { ok: true, channels: [{ id: 'C0ENG', name: 'eng', is_member: true }, { id: 'C0RANDOM', name: 'random', is_member: false }] });
      case 'conversations.info':
        return json(res, 200, { ok: true, channel: { id: body.channel, name: 'support' } });
      case 'chat.postMessage':
        return json(res, 200, { ok: true, ts: `${Date.now() / 1000}`, channel: body.channel });
      default:
        return json(res, 200, { ok: true });
    }
  }
}
