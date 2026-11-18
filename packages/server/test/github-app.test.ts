/**
 * GitHub as an App (docs/architecture.md, D54): a GitHub integration reads as a GitHub App, not with
 * a person's token. The fake GitHub here checks each JSON web token as GitHub does (RS256 with the
 * app's public key, issued a minute back, ten minutes long at most), trades it for installation
 * tokens that expire, and answers as GitHub does when the app isn't installed or its installation
 * went.
 */
import { createHmac, generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBuildSource } from '../src/ci/builds';
import { vcsIntegrations } from '../src/db/schema';
import { createHttpApp } from '../src/http/app';
import { createToken } from '../src/services/auth';
import { createIssue, updateIssue } from '../src/services/issues';
import { getJson, ReadError } from '../src/vcs/commits';
import { forgetInstallationToken } from '../src/vcs/github-app';
import { createIntegration, testIntegration, updateIntegration } from '../src/vcs/integrations';
import type { IntegrationRow } from '../src/vcs/links';
import { readWith } from '../src/vcs/tokens';
import { createWorld, type TestWorld } from './helpers';

const APP_ID = 424242;
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
/** As GitHub gives it: PKCS#1, "BEGIN RSA PRIVATE KEY". */
const PEM = keys.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
const OTHER_PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;

interface FakeInstallation {
  id: number;
  account: string;
  repositories: string[];
  suspended?: boolean;
  gone?: boolean;
}

/** What the fake GitHub knows and saw. */
const gh = {
  installations: [] as FakeInstallation[],
  tokens: new Map<string, { installation: number; expiresAt: number; revoked: boolean }>(),
  exchanges: [] as { installation: number; permissions: unknown }[],
  claims: [] as { iat: number; exp: number; iss: unknown }[],
  compared: [] as { range: string; token: string }[],
  ranges: new Map<string, { sha: string; commit: { message: string } }[]>(),
  lifetimeMs: 60 * 60_000,
  /** What /app answers instead, when set. */
  answer: 0,
  /** Whether the app was given Contents: read. */
  readsContents: true,
};

let w: TestWorld;
let http: ReturnType<typeof createHttpApp>;
let fake: Server;
let api = '';
let adminToken = '';

/** A JSON web token GitHub takes: the app's, RS256, a minute back, ten minutes at most, unexpired. */
function appSigned(auth: string | undefined): boolean {
  const m = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(auth ?? '');
  if (!m) return false;
  const header = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8')) as { alg?: string };
  if (header.alg !== 'RS256' || !verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), keys.publicKey, Buffer.from(m[3]!, 'base64url'))) return false;
  const claims = JSON.parse(Buffer.from(m[2]!, 'base64url').toString('utf8')) as { iat: number; exp: number; iss: unknown };
  gh.claims.push(claims);
  const now = Math.floor(Date.now() / 1000);
  return claims.iss === APP_ID && claims.iat <= now - 30 && claims.exp > now && claims.exp - claims.iat <= 600;
}

/** The installation an installation token is for, while it's good. */
function tokenFor(auth: string | undefined): FakeInstallation | null {
  const t = gh.tokens.get((auth ?? '').replace(/^Bearer /, ''));
  if (!t || t.revoked || t.expiresAt <= Date.now()) return null;
  return gh.installations.find((i) => i.id === t.installation && !i.gone) ?? null;
}

const asGithub = (i: FakeInstallation) => ({ id: i.id, account: { login: i.account }, suspended_at: i.suspended ? '2026-11-01T00:00:00Z' : null });

beforeAll(async () => {
  fake = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      const path = new URL(req.url ?? '/', 'http://fake').pathname;
      const auth = req.headers.authorization;
      if (path === '/app' && gh.answer) return send(gh.answer, { message: "I'm a teapot" });
      if (path === '/app') return appSigned(auth) ? send(200, { id: APP_ID, slug: 'a4a-acme', name: 'a4a for Acme' }) : send(401, { message: 'A JSON web token could not be decoded' });
      if (path === '/app/installations') return appSigned(auth) ? send(200, gh.installations.filter((i) => !i.gone).map(asGithub)) : send(401, {});
      let m = /^\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(path);
      if (m) {
        if (!appSigned(auth)) return send(401, { message: 'A JSON web token could not be decoded' });
        const i = gh.installations.find((x) => x.id === Number(m![1]) && !x.gone);
        if (!i) return send(404, { message: 'Not Found' });
        if (!m[2]) return send(200, asGithub(i));
        if (i.suspended) return send(403, { message: 'This installation has been suspended' });
        if (!gh.readsContents) return send(422, { message: 'The permissions requested are not granted to this installation.' });
        const { permissions } = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { permissions?: unknown };
        gh.exchanges.push({ installation: i.id, permissions });
        const token = `ghs_${randomUUID().replace(/-/g, '')}`;
        const expiresAt = Date.now() + gh.lifetimeMs;
        gh.tokens.set(token, { installation: i.id, expiresAt, revoked: false });
        return send(201, { token, expires_at: new Date(expiresAt).toISOString(), permissions, repository_selection: 'selected' });
      }
      m = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(path);
      if (m) {
        if (!appSigned(auth)) return send(401, {});
        const i = gh.installations.find((x) => !x.gone && x.repositories.includes(decodeURIComponent(m![1]!)));
        return i ? send(200, asGithub(i)) : send(404, { message: 'Not Found' });
      }
      m = /^\/repos\/([^/]+\/[^/]+?)(?:\/compare\/(.+))?$/.exec(path);
      if (m) {
        if (!gh.tokens.has((auth ?? '').replace(/^Bearer /, ''))) return send(401, { message: 'Bad credentials' });
        const i = tokenFor(auth);
        if (!i) return send(401, { message: 'Bad credentials' });
        const repository = decodeURIComponent(m[1]!);
        if (!i.repositories.includes(repository)) return send(404, { message: 'Not Found' });
        if (!m[2]) return send(200, { full_name: repository });
        const range = decodeURIComponent(m[2]);
        gh.compared.push({ range, token: (auth ?? '').replace(/^Bearer /, '') });
        const commits = gh.ranges.get(range) ?? [];
        return send(200, { total_commits: commits.length, commits });
      }
      send(404, { message: 'Not Found' });
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  api = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  w = await createWorld();
  http = createHttpApp(w.app);
  adminToken = (await createToken(w.adminCtx, { name: 'admin', scopes: ['read', 'write', 'admin'] })).token;
});

afterAll(async () => {
  vi.useRealTimers();
  await new Promise<void>((r) => fake.close(() => r()));
  await w.close();
});

const rowOf = async (id: string): Promise<IntegrationRow> => (await w.app.db.select().from(vcsIntegrations).where(eq(vcsIntegrations.id, id)))[0]!;
const asApp = (installationId?: string) => ({ appId: String(APP_ID), privateKey: PEM, ...(installationId ? { installationId } : {}) });

/** The REST API as an administrator, with the problem's words checked against the catalog. */
async function rest(method: string, path: string, body?: unknown) {
  const res = await http.request(`/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe('a GitHub integration as a GitHub App', () => {
  let integration = '';

  it('checks the app with GitHub before keeping it, finds its installation on the repository, and keeps its key sealed', async () => {
    gh.installations.push({ id: 77, account: 'acme', repositories: ['acme/backend', 'acme/web'] }, { id: 78, account: 'beta', repositories: ['beta/site'] });
    const r = await rest('POST', '/vcs/integrations', { provider: 'github', name: 'acme/backend', projects: ['BACK'], baseUrl: api, githubApp: asApp() });
    expect(r.status).toBe(201);
    integration = r.body.id;
    expect(r.body).toMatchObject({ provider: 'github', hasAccessToken: false, githubApp: { appId: '424242', slug: 'a4a-acme', installationId: '77', account: 'acme' } });
    expect(JSON.stringify(r.body)).not.toContain('PRIVATE KEY');
    const row = await rowOf(integration);
    expect(row.githubAppKey).toMatch(/^v1\./);
    // Neither the key nor a token is in the database as it was given.
    expect(JSON.stringify(row)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(row)).not.toContain('ghs_');
    // The token GitHub made for it reads contents and nothing more.
    expect(gh.exchanges.at(-1)).toEqual({ installation: 77, permissions: { contents: 'read' } });
    // Each JSON web token is ten minutes long and begins a minute back.
    for (const c of gh.claims) {
      expect(c.exp - c.iat).toBe(600);
      expect(c.iss).toBe(APP_ID);
    }
  });

  it('reads as the app with the token it holds, one exchange for reads at once, and a new token when the old nears its end', async () => {
    const row = await rowOf(integration);
    const before = gh.exchanges.length;
    // The token taken while checking the app is held: the first read takes none.
    expect(await readWith(w.app, row, (t) => getJson(`${api}/repos/acme/backend`, t))).toEqual({ full_name: 'acme/backend' });
    expect(gh.exchanges.length).toBe(before);
    forgetInstallationToken(row.id);
    const both = await Promise.all([1, 2, 3].map(() => readWith(w.app, row, async (t) => t)));
    expect(new Set(both).size).toBe(1);
    expect(gh.exchanges.length).toBe(before + 1);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // 56 minutes on, the hour-long token has four minutes left: a new one is taken.
      vi.setSystemTime(Date.now() + 56 * 60_000);
      const later = await readWith(w.app, row, (t) => getJson(`${api}/repos/acme/backend`, t).then(() => t));
      expect(later).not.toBe(both[0]);
      expect(gh.exchanges.length).toBe(before + 2);
      vi.setSystemTime(Date.now() + 10 * 60_000);
      expect(await readWith(w.app, row, async (t) => t)).toBe(later);
      expect(gh.exchanges.length).toBe(before + 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes a new token once when GitHub ends one early, and says what it is when it reads nothing', async () => {
    const row = await rowOf(integration);
    const held = await readWith(w.app, row, async (t) => t);
    gh.tokens.get(held)!.revoked = true;
    const before = gh.exchanges.length;
    expect(await readWith(w.app, row, (t) => getJson(`${api}/repos/acme/backend`, t))).toEqual({ full_name: 'acme/backend' });
    expect(gh.exchanges.length).toBe(before + 1);
    // beta's repository reads through beta's own installation (D66); one the app isn't installed on says so.
    expect(await readWith(w.app, row, (t) => getJson(`${api}/repos/beta/site`, t), 'beta/site')).toEqual({ full_name: 'beta/site' });
    expect(gh.exchanges.at(-1)).toMatchObject({ installation: 78 });
    const elsewhere = await readWith(w.app, row, (t) => getJson(`${api}/repos/gamma/site`, t), 'gamma/site').catch((e: unknown) => e);
    expect(elsewhere).toBeInstanceOf(ReadError);
    expect((elsewhere as ReadError).message).toContain('The app isn’t installed on gamma/site');
  });

  it('reads the range a CI sends as the app, where the integration has no token', async () => {
    const issue = await createIssue(w.adminCtx, { project: 'BACK', summary: 'Avatar upload rejects PNGs', fields: { Type: 'Bug' } });
    const fixed = await updateIssue(w.adminCtx, issue.id, { fields: { State: 'Fixed' } });
    const source = await createBuildSource(w.adminCtx, { kind: 'generic', name: 'Jenkins', project: 'BACK' });
    const [from, to] = ['a'.repeat(40), 'b'.repeat(40)];
    gh.ranges.set(`${from}...${to}`, [{ sha: to, commit: { message: `Accept PNG (${fixed.id})` } }]);
    const res = await http.request(`/api/v1/builds/hooks/${source.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${source.token}` },
      body: JSON.stringify({ build: '2.0.1', repository: 'acme/backend', range: { from, to } }),
    });
    expect(res.status).toBe(200);
    expect(gh.compared.at(-1)!.range).toBe(`${from}...${to}`);
    expect(gh.compared.at(-1)!.token).toMatch(/^ghs_/);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ marked: 1 });
  });

  it('says plainly what is wrong: not a key, a key GitHub refuses, an app not installed on the repository, an installation that went', async () => {
    const notKey = await rest('POST', '/vcs/integrations', { provider: 'github', name: 'acme/web', baseUrl: api, githubApp: { appId: String(APP_ID), privateKey: 'ssh-rsa AAAA not a pem' } });
    expect(notKey).toMatchObject({ status: 400, body: { error: { key: 'vcs.githubApp.notAKey' } } });
    const refused = await rest('POST', '/vcs/integrations', { provider: 'github', name: 'acme/web', baseUrl: api, githubApp: { appId: String(APP_ID), privateKey: OTHER_PEM } });
    expect(refused).toMatchObject({ status: 400, body: { error: { key: 'vcs.githubApp.keyRefused', values: { status: 401 } } } });
    const notApp = await rest('POST', '/vcs/integrations', { provider: 'github', name: 'acme/web', baseUrl: api, githubApp: { appId: 'acme', privateKey: PEM } });
    expect(notApp.body.error.key).toBe('vcs.githubApp.notAnAppId');
    const elsewhere = await rest('POST', '/vcs/integrations', { provider: 'github', name: 'acme/mobile', baseUrl: api, githubApp: asApp() });
    expect(elsewhere).toMatchObject({ status: 400, body: { error: { key: 'vcs.githubApp.notInstalledOn', values: { repository: 'acme/mobile' } } } });
    expect(elsewhere.body.error.message).toBe('The app isn’t installed on acme/mobile');
    const gone = await rest('POST', '/vcs/integrations', { provider: 'github', name: 'acme/web', baseUrl: api, githubApp: asApp('999') });
    expect(gone.body.error).toMatchObject({ key: 'vcs.githubApp.installationGone', values: { id: '999' } });
    // Given an installation that wasn't given the repository it's named after.
    const notGiven = await rest('POST', '/vcs/integrations', { provider: 'github', name: 'acme/backend', baseUrl: api, githubApp: asApp('78') });
    expect(notGiven.body.error).toMatchObject({ key: 'vcs.githubApp.notGiven', values: { id: '78', repository: 'acme/backend' } });
    // Not named after a repository, with the app on two accounts: no question which now, since each repository reads through its own (D66).
    const several = await rest('POST', '/vcs/integrations', { provider: 'github', name: 'Everything at Acme', baseUrl: api, githubApp: asApp() });
    expect(several.status).toBe(201);
    expect(several.body.githubApp.installations.map((i: { account: string }) => i.account)).toEqual(['acme', 'beta']);
    await w.app.db.delete(vcsIntegrations).where(eq(vcsIntegrations.id, several.body.id));
    const unreachable = await rest('POST', '/vcs/integrations', { provider: 'github', name: 'acme/web', baseUrl: 'http://127.0.0.1:9', githubApp: asApp() });
    expect(unreachable.body.error).toMatchObject({ key: 'vcs.githubApp.unreachable', values: { host: '127.0.0.1:9' } });
    gh.answer = 418;
    const odd = await rest('POST', '/vcs/integrations', { provider: 'github', name: 'acme/web', baseUrl: api, githubApp: asApp() });
    expect(odd.body.error).toMatchObject({ key: 'vcs.githubApp.answered', values: { status: 418 } });
    gh.answer = 0;
    gh.readsContents = false;
    const noContents = await rest('POST', '/vcs/integrations', { provider: 'github', name: 'acme/web', baseUrl: api, githubApp: asApp() });
    expect(noContents.body.error.key).toBe('vcs.githubApp.cantReadContents');
    gh.readsContents = true;
    const acme = gh.installations.find((i) => i.id === 77)!;
    acme.suspended = true;
    const suspended = await rest('POST', '/vcs/integrations', { provider: 'github', name: 'acme/web', baseUrl: api, githubApp: asApp() });
    expect(suspended.body.error).toMatchObject({ key: 'vcs.githubApp.suspended', values: { id: '77' } });
    acme.suspended = false;
    for (const i of gh.installations) i.gone = true;
    const nowhere = await rest('POST', '/vcs/integrations', { provider: 'github', name: 'Everything at Acme', baseUrl: api, githubApp: asApp() });
    expect(nowhere.body.error.key).toBe('vcs.githubApp.notInstalled');
    for (const i of gh.installations) i.gone = false;
    // Nothing was made of any of them.
    expect((await w.app.db.select().from(vcsIntegrations)).map((r) => r.id)).toEqual([integration]);
  });

  it('says when the installation was removed or suspended since, on a test and where builds read', async () => {
    const acme = gh.installations.find((i) => i.id === 77)!;
    acme.suspended = true;
    const suspended = await testIntegration(w.adminCtx, integration);
    expect(suspended.delivered).toBe(false);
    expect(suspended.message).toContain('The app’s installation 77 is suspended.');
    acme.suspended = false;
    acme.gone = true;
    forgetInstallationToken(integration);
    const read = await readWith(w.app, await rowOf(integration), async (t) => t).catch((e: unknown) => e);
    expect((read as ReadError).message).toBe(
      'as the GitHub App: The app’s installation 77 is gone. It was uninstalled, or is another app’s. Install the app again, and give the integration its new installation.',
    );
    acme.gone = false;
    const ok = await testIntegration(w.adminCtx, integration);
    expect(ok).toMatchObject({ delivered: true });
    expect(ok.message).toContain('a4a took a token as the GitHub App a4a-acme, so it reads as the app.');
  });

  it('switches: a token ends the app, an app ends the token, both at once is refused, and only GitHub takes one', async () => {
    const withToken = await updateIntegration(w.adminCtx, integration, { accessToken: 'ghp_person_token' });
    expect(withToken).toMatchObject({ hasAccessToken: true, githubApp: null });
    expect((await rowOf(integration)).githubAppKey).toBeNull();
    const back = await updateIntegration(w.adminCtx, integration, { githubApp: asApp() });
    expect(back).toMatchObject({ hasAccessToken: false, githubApp: { installationId: '77' } });
    const both = await rest('PATCH', `/vcs/integrations/${integration}`, { accessToken: 'ghp_x', githubApp: asApp() });
    expect(both).toMatchObject({ status: 400, body: { error: { key: 'vcs.githubApp.notBoth' } } });
    const gitlab = await rest('POST', '/vcs/integrations', { provider: 'gitlab', name: 'acme/backend', githubApp: asApp() });
    expect(gitlab.body.error).toMatchObject({ key: 'vcs.githubApp.onlyGithub', values: { provider: 'GitLab' } });
    const off = await updateIntegration(w.adminCtx, integration, { githubApp: null });
    expect(off).toMatchObject({ hasAccessToken: false, githubApp: null });
    const nothing = await readWith(w.app, await rowOf(integration), async (t) => t).catch((e: unknown) => e);
    expect((nothing as ReadError).message).toBe('the integration has no access token');
  });

  it("takes a GitHub App's own webhook as the integration's: its deliveries are signed with the one secret", async () => {
    const made = await createIntegration(w.adminCtx, { provider: 'github', name: 'acme/web', baseUrl: api, githubApp: asApp() });
    const body = JSON.stringify({ zen: 'Keep it logically awesome.', hook_id: 1, hook: { type: 'App', app_id: APP_ID, events: ['push', 'pull_request', 'workflow_run'] } });
    const res = await http.request(`/api/v1/vcs/hooks/${made.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'ping',
        'x-github-delivery': randomUUID(),
        'x-github-hook-installation-target-type': 'integration',
        'x-github-hook-installation-target-id': String(APP_ID),
        'x-hub-signature-256': `sha256=${createHmac('sha256', made.secret).update(body).digest('hex')}`,
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: 'processed' });
  });
});
