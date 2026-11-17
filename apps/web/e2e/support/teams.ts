/**
 * Bot Framework, as the server's Teams bot meets it (D42), on this machine: its OpenID metadata and
 * signing key, Entra's token endpoint, and the connector posts go to. The server is set up with its
 * address before it starts (playwright.config.ts); its key is kept in the run's folder, so a retried
 * spec signs with the key the server read the first time.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { RUN_DIR, TEAMS } from './env';

export interface Posted {
  conversationId: string;
  activity: { text?: string; summary?: string; attachments?: unknown[] };
}

function key(): KeyObject {
  const file = path.join(RUN_DIR, 'teams-key.pem');
  if (!existsSync(file)) writeFileSync(file, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return createPrivateKey(readFileSync(file, 'utf8'));
}

export async function startTeams() {
  const privateKey = key();
  const jwk = { ...createPublicKey(privateKey).export({ format: 'jwk' }), kid: 'e2e-key', use: 'sig', endorsements: ['msteams'] };
  const posted: Posted[] = [];
  let channels: { id: string; name?: string }[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (body += c));
    req.on('end', () => {
      const send = (status: number, data: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      const url = (req.url ?? '').split('?')[0]!;
      if (url === '/openid') return send(200, { issuer: 'https://api.botframework.com', jwks_uri: `${TEAMS.url}/keys` });
      if (url === '/keys') return send(200, { keys: [jwk] });
      if (url === '/token') return send(200, { access_token: 'e2e-bot-token', expires_in: 3600 });
      if (url === '/amer/v3/conversations' && req.method === 'POST') {
        const members = (JSON.parse(body) as { members?: { id?: string }[] }).members;
        return send(200, { id: `a:personal-${members?.[0]?.id ?? 'someone'}` });
      }
      if (/^\/amer\/v3\/teams\/[^/]+\/conversations$/.test(url)) return send(200, { conversations: channels });
      const m = /^\/amer\/v3\/conversations\/([^/]+)\/activities/.exec(url);
      if (m && req.method === 'POST') {
        posted.push({ conversationId: decodeURIComponent(m[1]!), activity: JSON.parse(body) as Posted['activity'] });
        return send(200, { id: `activity-${posted.length}` });
      }
      return send(404, { error: { code: 'NotFound' } });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(new URL(TEAMS.url).port), '127.0.0.1', resolve);
  });
  const serviceUrl = `${TEAMS.url}/amer/`;
  /** Bot Framework's token on what it sends the bot. */
  const token = () => {
    const now = Math.floor(Date.now() / 1000);
    const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const signed = `${part({ alg: 'RS256', typ: 'JWT', kid: 'e2e-key' })}.${part({ iss: 'https://api.botframework.com', aud: TEAMS.appId, exp: now + 3600, nbf: now - 10, serviceurl: serviceUrl })}`;
    return `${signed}.${sign('RSA-SHA256', Buffer.from(signed), privateKey).toString('base64url')}`;
  };
  return {
    serviceUrl,
    posted,
    token,
    setChannels: (list: { id: string; name?: string }[]) => (channels = list),
    activity: (a: Record<string, unknown>) => ({ channelId: 'msteams', serviceUrl, ...a }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
