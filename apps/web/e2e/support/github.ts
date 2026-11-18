/**
 * GitHub's API, as a GitHub App meets it (D54, D66), on this machine: the app's own JSON web tokens
 * checked with its public key, its installations on one account or several, each repository's
 * installation, and the installation tokens it trades them for, which carry only the permissions an
 * installation was given (checks: write only where a spec says). A spec starts it on a port of its
 * own and gives its address to the integration as GitHub Enterprise Server's API, which the server
 * may reach over plain http in tests (VCS_ALLOW_HTTP_LOOPBACK, playwright.config.ts).
 */
import { generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface GithubInstallation {
  id: number;
  account: string;
  type?: 'User' | 'Organization';
  repositories: string[];
  /** Whether it was given Checks: Read and write. */
  checks?: boolean;
}

export async function startGithub(app: { id: number; slug: string; installation?: GithubInstallation; installations?: GithubInstallation[] }) {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const installations = app.installations ?? (app.installation ? [app.installation] : []);
  const tokens = new Map<string, number>();
  const signed = (auth: string | undefined) => {
    const m = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(auth ?? '');
    if (!m || !verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), keys.publicKey, Buffer.from(m[3]!, 'base64url'))) return false;
    const claims = JSON.parse(Buffer.from(m[2]!, 'base64url').toString('utf8')) as { iss?: unknown; iat: number; exp: number };
    const now = Math.floor(Date.now() / 1000);
    return claims.iss === app.id && claims.exp > now && claims.exp - claims.iat <= 600;
  };
  const shown = (i: GithubInstallation) => ({ id: i.id, account: { login: i.account, type: i.type ?? 'Organization' }, repository_selection: 'selected', suspended_at: null });
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      const path = new URL(req.url ?? '/', 'http://github').pathname;
      const auth = req.headers.authorization;
      if (path === '/app') return signed(auth) ? send(200, { id: app.id, slug: app.slug }) : send(401, { message: 'A JSON web token could not be decoded' });
      if (path === '/app/installations') return signed(auth) ? send(200, installations.map(shown)) : send(401, { message: 'A JSON web token could not be decoded' });
      let m = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(path);
      if (m) {
        if (!signed(auth)) return send(401, { message: 'A JSON web token could not be decoded' });
        const i = installations.find((x) => x.repositories.includes(decodeURIComponent(m![1]!)));
        return i ? send(200, shown(i)) : send(404, { message: 'Not Found' });
      }
      m = /^\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(path);
      if (m) {
        if (!signed(auth)) return send(401, { message: 'A JSON web token could not be decoded' });
        const i = installations.find((x) => x.id === Number(m![1]));
        if (!i) return send(404, { message: 'Not Found' });
        if (!m[2]) return send(200, shown(i));
        const { permissions } = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { permissions?: Record<string, string> };
        if (permissions?.checks && !i.checks) return send(422, { message: 'The permissions requested are not granted to this installation.' });
        const token = `ghs_${randomUUID().replace(/-/g, '')}`;
        tokens.set(token, i.id);
        return send(201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions });
      }
      m = /^\/repos\/([^/]+\/[^/]+)$/.exec(path);
      if (m) {
        const i = installations.find((x) => x.id === tokens.get((auth ?? '').replace(/^Bearer /, '')));
        if (!i) return send(401, { message: 'Bad credentials' });
        return i.repositories.includes(decodeURIComponent(m[1]!)) ? send(200, { full_name: decodeURIComponent(m[1]!) }) : send(404, { message: 'Not Found' });
      }
      return send(404, { message: 'Not Found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    /** The installations, which a spec may change as it goes (give one Checks, say). */
    installations,
    /** The app's private key, as GitHub gives it: a .pem file, "BEGIN RSA PRIVATE KEY". */
    privateKey: keys.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string,
    /** A key of no app's. */
    otherKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }) as string,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
