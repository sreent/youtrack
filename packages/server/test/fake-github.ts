/**
 * GitHub's API as a GitHub App meets it, on this machine (D54, D66): the app's JSON web tokens checked
 * with its public key as GitHub checks them, its installations on several accounts, each repository's
 * installation, installation tokens that carry only the permissions asked for and granted, the compare
 * a build reads, and check runs, made, updated and found again, refused to a token that may not write
 * them, and rate-limited when a test says so.
 */
import { generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeInstallation {
  id: number;
  account: string;
  type?: 'User' | 'Organization';
  repositories: string[];
  suspended?: boolean;
  gone?: boolean;
  /** What it was given: contents read by default, and checks only when said. */
  permissions?: { contents?: 'read'; checks?: 'write' };
}

export interface FakeCheckRun {
  id: number;
  repository: string;
  headSha: string;
  externalId: string | null;
  name: string;
  conclusion: string;
  title: string;
  summary: string;
  installation: number;
}

export interface FakeGithub {
  url: string;
  appId: number;
  /** The app's private key, as GitHub gives it: PKCS#1, "BEGIN RSA PRIVATE KEY". */
  privateKey: string;
  installations: FakeInstallation[];
  tokens: Map<string, { installation: number; permissions: Record<string, string>; expiresAt: number; revoked: boolean }>;
  exchanges: { installation: number; permissions: unknown }[];
  /** Each repository's installation, as it was asked for. */
  lookups: string[];
  compared: { repository: string; range: string; installation: number }[];
  ranges: Map<string, { sha: string; commit: { message: string } }[]>;
  runs: FakeCheckRun[];
  /** Each request to the check runs API: what, on which repository, with which installation's token. */
  writes: { method: string; repository: string; installation: number }[];
  /** Answer the next so many check run writes with GitHub's rate limit (403, nothing remaining). */
  limitNext: number;
  close(): Promise<void>;
}

export async function startFakeGithub(opts: { appId?: number; slug?: string } = {}): Promise<FakeGithub> {
  const appId = opts.appId ?? 424242;
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const gh: Omit<FakeGithub, 'url' | 'close'> = {
    appId,
    privateKey: keys.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string,
    installations: [],
    tokens: new Map(),
    exchanges: [],
    lookups: [],
    compared: [],
    ranges: new Map(),
    runs: [],
    writes: [],
    limitNext: 0,
  };
  const appSigned = (auth: string | undefined) => {
    const m = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(auth ?? '');
    if (!m) return false;
    if (!verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), keys.publicKey, Buffer.from(m[3]!, 'base64url'))) return false;
    const claims = JSON.parse(Buffer.from(m[2]!, 'base64url').toString('utf8')) as { iat: number; exp: number; iss: unknown };
    const now = Math.floor(Date.now() / 1000);
    return claims.iss === appId && claims.iat <= now - 30 && claims.exp > now && claims.exp - claims.iat <= 600;
  };
  const live = (i: FakeInstallation | undefined) => (i && !i.gone ? i : undefined);
  const tokenOf = (auth: string | undefined) => {
    const t = gh.tokens.get((auth ?? '').replace(/^Bearer /, ''));
    if (!t || t.revoked || t.expiresAt <= Date.now()) return null;
    const i = live(gh.installations.find((x) => x.id === t.installation));
    return i ? { t, i } : null;
  };
  const asGithub = (i: FakeInstallation) => ({
    id: i.id,
    account: { login: i.account, type: i.type ?? 'Organization' },
    repository_selection: 'selected',
    suspended_at: i.suspended ? '2026-11-01T00:00:00Z' : null,
  });
  let nextRun = 5000;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
      const url = new URL(req.url ?? '/', 'http://fake');
      const path = url.pathname;
      const auth = req.headers.authorization;
      const body = () => JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, any>;
      if (path === '/app') return appSigned(auth) ? send(200, { id: appId, slug: opts.slug ?? 'a4a-acme' }) : send(401, { message: 'A JSON web token could not be decoded' });
      if (path === '/app/installations') return appSigned(auth) ? send(200, gh.installations.filter((i) => !i.gone).map(asGithub)) : send(401, {});
      let m = /^\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(path);
      if (m) {
        if (!appSigned(auth)) return send(401, { message: 'A JSON web token could not be decoded' });
        const i = live(gh.installations.find((x) => x.id === Number(m![1])));
        if (!i) return send(404, { message: 'Not Found' });
        if (!m[2]) return send(200, asGithub(i));
        if (i.suspended) return send(403, { message: 'This installation has been suspended' });
        const permissions = (body().permissions ?? {}) as Record<string, string>;
        const granted = { contents: 'read', ...i.permissions } as Record<string, string | undefined>;
        if (Object.entries(permissions).some(([k, v]) => granted[k] !== v && !(granted[k] === 'write' && v === 'read'))) {
          return send(422, { message: 'The permissions requested are not granted to this installation.' });
        }
        gh.exchanges.push({ installation: i.id, permissions });
        const token = `ghs_${randomUUID().replace(/-/g, '')}`;
        const expiresAt = Date.now() + 60 * 60_000;
        gh.tokens.set(token, { installation: i.id, permissions, expiresAt, revoked: false });
        return send(201, { token, expires_at: new Date(expiresAt).toISOString(), permissions });
      }
      m = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(path);
      if (m) {
        if (!appSigned(auth)) return send(401, {});
        const repository = decodeURIComponent(m[1]!);
        gh.lookups.push(repository);
        const i = gh.installations.find((x) => !x.gone && x.repositories.includes(repository));
        return i ? send(200, asGithub(i)) : send(404, { message: 'Not Found' });
      }
      m = /^\/repos\/([^/]+\/[^/]+?)(\/.*)?$/.exec(path);
      if (!m) return send(404, { message: 'Not Found' });
      const repository = decodeURIComponent(m[1]!);
      const rest = m[2] ?? '';
      const held = tokenOf(auth);
      if (!held) return send(401, { message: 'Bad credentials' });
      if (!held.i.repositories.includes(repository)) return send(404, { message: 'Not Found' });
      if (!rest) return send(200, { full_name: repository });
      const compare = /^\/compare\/(.+)$/.exec(rest);
      if (compare) {
        if (!held.t.permissions.contents) return send(403, { message: 'Resource not accessible by integration' });
        const range = decodeURIComponent(compare[1]!);
        gh.compared.push({ repository, range, installation: held.i.id });
        const commits = gh.ranges.get(range) ?? [];
        return send(200, { total_commits: commits.length, commits });
      }
      // Check runs: only with checks: write, and rate-limited when a test says so.
      const runs = /^\/check-runs(?:\/(\d+))?$/.exec(rest);
      const listed = /^\/commits\/([^/]+)\/check-runs$/.exec(rest);
      if (!runs && !listed) return send(404, { message: 'Not Found' });
      if (held.t.permissions.checks !== 'write') return send(403, { message: 'Resource not accessible by integration' });
      gh.writes.push({ method: req.method ?? 'GET', repository, installation: held.i.id });
      if (listed) {
        const sha = decodeURIComponent(listed[1]!);
        const name = url.searchParams.get('check_name');
        const found = gh.runs.filter((r) => r.repository === repository && r.headSha === sha && (!name || r.name === name));
        return send(200, { total_count: found.length, check_runs: found.map((r) => ({ id: r.id, external_id: r.externalId, name: r.name })) });
      }
      if (gh.limitNext > 0) {
        gh.limitNext--;
        return send(403, { message: 'API rate limit exceeded for installation.' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 120) });
      }
      const b = body();
      if (req.method === 'POST' && !runs![1]) {
        if (!b.head_sha || !b.name || b.status !== 'completed' || !b.conclusion) return send(422, { message: 'Invalid request.' });
        const run: FakeCheckRun = {
          id: nextRun++,
          repository,
          headSha: b.head_sha,
          externalId: b.external_id ?? null,
          name: b.name,
          conclusion: b.conclusion,
          title: b.output?.title ?? '',
          summary: b.output?.summary ?? '',
          installation: held.i.id,
        };
        gh.runs.push(run);
        return send(201, { id: run.id, head_sha: run.headSha, external_id: run.externalId });
      }
      if (req.method === 'PATCH' && runs![1]) {
        const run = gh.runs.find((r) => r.id === Number(runs![1]) && r.repository === repository);
        if (!run) return send(404, { message: 'Not Found' });
        Object.assign(run, { conclusion: b.conclusion ?? run.conclusion, title: b.output?.title ?? run.title, summary: b.output?.summary ?? run.summary });
        return send(200, { id: run.id });
      }
      return send(404, { message: 'Not Found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return Object.assign(gh, {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  });
}
