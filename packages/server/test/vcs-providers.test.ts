/**
 * Bitbucket Cloud, Bitbucket Data Center, Gitea and Forgejo (D33): each one's signature, its
 * payloads (fixtures shaped as each documents them), the commits Bitbucket leaves out read from a
 * fake of its REST API, and who wrote what, by a confirmed email or a login at the provider.
 */
import type { IssueDetail, IssueVcs, VcsIntegrationCreated } from '@a4a/shared';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpApp } from '../src/http/app';
import { AppError } from '../src/lib/errors';
import { createIssue, getIssue } from '../src/services/issues';
import { updateUser } from '../src/services/users';
import { presentField } from '../src/tools/registry';
import { createIntegration, listIntegrations, listVcsDeliveries, testIntegration, updateIntegration } from '../src/vcs/integrations';
import { issueVcs } from '../src/vcs/links';
import { addProviderLogin } from '../src/vcs/logins';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let http: ReturnType<typeof createHttpApp>;

const fixture = (name: string) => readFileSync(new URL(`./fixtures/vcs/${name}.json`, import.meta.url), 'utf8');
const json = <T = Record<string, any>>(name: string): T => JSON.parse(fixture(name)) as T;
const hmac = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');
const value = (i: IssueDetail, name: string) => presentField(i.fields.find((f) => f.name === name)!);
const vcsOf = (id: string): Promise<IssueVcs> => issueVcs(w.adminCtx, id);
const lastDelivery = async (id: string) => (await listVcsDeliveries(w.adminCtx, id))[0]!;

async function post(id: string, body: string, headers: Record<string, string>, ip = '203.0.113.9') {
  const res = await http.request(`/api/v1/vcs/hooks/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...headers },
    body,
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/** As Bitbucket Cloud sends it: X-Event-Key, X-Request-UUID (in braces), X-Hub-Signature. */
const fromCloud = (hook: VcsIntegrationCreated, event: string, payload: unknown, delivery = `{${randomUUID()}}`, secret = hook.secret) => {
  const body = JSON.stringify(payload);
  return post(hook.id, body, { 'x-event-key': event, 'x-request-uuid': delivery, 'x-attempt-number': '1', 'x-hub-signature': `sha256=${hmac(secret, body)}`, 'user-agent': 'Bitbucket-Webhooks/2.0' });
};
/** As Bitbucket Data Center sends it: X-Event-Key, X-Request-Id, X-Hub-Signature. */
const fromDc = (hook: VcsIntegrationCreated, event: string, payload: unknown, delivery: string = randomUUID(), signed = true) => {
  const body = JSON.stringify(payload);
  return post(hook.id, body, { 'x-event-key': event, 'x-request-id': delivery, ...(signed ? { 'x-hub-signature': `sha256=${hmac(hook.secret, body)}` } : {}) });
};

/** A fake of Bitbucket's REST APIs (Cloud's and Data Center's): it answers only to the token. */
interface FakeBitbucket {
  url: string;
  token: string;
  asked: { path: string; auth: string | undefined }[];
  answer(path: string, fn: (u: URL) => unknown): void;
  close(): Promise<void>;
}

async function fakeBitbucket(token: string): Promise<FakeBitbucket> {
  const asked: FakeBitbucket['asked'] = [];
  const routes = new Map<string, (u: URL) => unknown>();
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    asked.push({ path: `${u.pathname}${u.search}`, auth: req.headers.authorization });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { errors: [{ message: 'Authentication failed. Please check your credentials and try again.' }] });
    const fn = routes.get(u.pathname);
    if (!fn) return send(404, { errors: [{ message: 'Not found' }] });
    return send(200, fn(u));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    token,
    asked,
    answer: (path, fn) => routes.set(path, fn),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected a refusal');
};

let fake: FakeBitbucket;

beforeAll(async () => {
  w = await createWorld();
  w.app.config.trustProxy = 1;
  http = createHttpApp(w.app);
  // Emails an administrator sets are confirmed.
  await updateUser(w.adminCtx, 'anna', { email: 'anna@example.com' });
  await updateUser(w.adminCtx, 'ben', { email: 'ben@example.com' });
  for (const summary of ['Login fails on Safari with SSO', 'Exports slow the database down', 'Replace the token cache', 'Rotate the keys', 'Rate limits for exports', 'Spare']) {
    await createIssue(w.as(w.anna), { project: 'BACK', summary });
  }
  fake = await fakeBitbucket('bb-read-token');
});

afterAll(async () => {
  await fake?.close();
  await w?.close();
});

describe('Bitbucket Cloud', () => {
  let cloud: VcsIntegrationCreated;
  beforeAll(async () => {
    cloud = await createIntegration(w.adminCtx, { provider: 'bitbucket', name: 'acme/shop', projects: ['BACK'] });
  });

  it('checks X-Hub-Signature, and links a push: a command runs as the author its confirmed email names', async () => {
    const push = json('bitbucket-push');
    const unsigned = await post(cloud.id, JSON.stringify(push), { 'x-event-key': 'repo:push', 'x-request-uuid': `{${randomUUID()}}` });
    expect(unsigned.status).toBe(401);
    expect(unsigned.body.error.message).toContain('No X-Hub-Signature');
    const forged = await fromCloud(cloud, 'repo:push', push, undefined, 'not-the-secret');
    expect([forged.status, forged.body.error.message]).toEqual([401, 'The signature does not match: is the secret in Bitbucket Cloud the one a4a gave?']);

    const delivery = `{${randomUUID()}}`;
    const res = await fromCloud(cloud, 'repo:push', push, delivery);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, outcome: 'processed', linked: 2, applied: 1 });
    expect(value(await getIssue(w.adminCtx, 'BACK-1'), 'State')).toBe('Fixed');
    expect((await vcsOf('BACK-1')).commits[0]).toMatchObject({
      repository: 'acme/shop',
      sha: 'c2d3e4f5a60718293a4b5c6d7e8f901234567890',
      title: 'Fix the SSO redirect loop on Safari',
      url: 'https://bitbucket.org/acme/shop/commits/c2d3e4f5a60718293a4b5c6d7e8f901234567890',
      branch: 'main',
      command: 'Fixed',
      applied: true,
      author: { name: 'Anna Schmidt', login: 'anna', user: { login: 'anna' } },
      integration: { provider: 'bitbucket' },
    });
    expect((await vcsOf('BACK-2')).commits[0]).toMatchObject({ command: null, author: { name: 'Jordi Mallach', user: null } });

    // Its request id, braces and all, is claimed: sent again, it changes nothing.
    const again = await fromCloud(cloud, 'repo:push', push, delivery);
    expect(again.body).toMatchObject({ outcome: 'duplicate' });
    expect((await lastDelivery(cloud.id)).outcome).toBe('duplicate');
  });

  it('reads the commits a truncated push left out with an access token, and says how to get them without one', async () => {
    const push = json('bitbucket-push');
    const change = push.push.changes[0];
    change.truncated = true;
    change.commits = change.commits.slice(0, 1);
    const from = change.old.target.hash as string;
    const to = change.new.target.hash as string;

    const without = await fromCloud(cloud, 'repo:push', push);
    expect(without.body).toMatchObject({ outcome: 'processed' });
    expect((await lastDelivery(cloud.id)).message).toContain('Bitbucket sent the latest 1 of more commits on main; give the integration an access token so a4a reads the rest');

    fake.answer('/2.0/repositories/acme/shop/commits', (u) =>
      u.searchParams.get('page') === '2'
        ? { values: [{ hash: 'd4e5f6a70819203a4b5c6d7e8f9012345678abcd', message: 'Docs for the keys (BACK-4)', date: '2026-11-16T07:00:00+00:00', author: { raw: 'Jordi Mallach <jordi@softcatala.example>' } }] }
        : {
            pagelen: 2,
            values: [
              change.commits[0],
              {
                hash: 'e5f6a70819203a4b5c6d7e8f9012345678abcdef',
                message: 'Smaller token cache\n\nBACK-3 #In Progress',
                date: '2026-11-16T08:00:00+00:00',
                author: { raw: 'Anna Schmidt <anna@example.com>', user: { display_name: 'Anna Schmidt', nickname: 'anna', account_id: '557058:11111111-2222-3333-4444-555555555555' } },
                links: { html: { href: 'https://bitbucket.org/acme/shop/commits/e5f6a70819203a4b5c6d7e8f9012345678abcdef' } },
              },
            ],
            next: `${fake.url}/2.0/repositories/acme/shop/commits?include=${to}&exclude=${from}&page=2`,
          },
    );
    const updated = await updateIntegration(w.adminCtx, cloud.id, { accessToken: fake.token, baseUrl: fake.url });
    expect(updated).toMatchObject({ hasAccessToken: true, baseUrl: fake.url });
    expect(JSON.stringify(await listIntegrations(w.adminCtx))).not.toContain(fake.token);

    const asked = fake.asked.length;
    const res = await fromCloud(cloud, 'repo:push', push);
    expect(res.body).toMatchObject({ outcome: 'processed', applied: 1 });
    expect(fake.asked.slice(asked)).toEqual([
      { path: `/2.0/repositories/acme/shop/commits?include=${to}&pagelen=100&exclude=${from}`, auth: `Bearer ${fake.token}` },
      { path: `/2.0/repositories/acme/shop/commits?include=${to}&exclude=${from}&page=2`, auth: `Bearer ${fake.token}` },
    ]);
    expect(value(await getIssue(w.adminCtx, 'BACK-3'), 'State')).toBe('In Progress');
    expect((await vcsOf('BACK-4')).commits[0]).toMatchObject({ sha: 'd4e5f6a70819203a4b5c6d7e8f9012345678abcd', url: null });
  });

  it('reads a new branch from where it left the main branch, and says when the token is refused', async () => {
    const push = json('bitbucket-push');
    const change = push.push.changes[0];
    change.truncated = true;
    change.old = null;
    change.created = true;
    change.new.name = 'feature/keys';
    fake.answer('/2.0/repositories/acme/shop', () => ({ mainbranch: { name: 'main', type: 'branch' } }));
    const asked = fake.asked.length;
    await fromCloud(cloud, 'repo:push', push);
    expect(fake.asked.slice(asked, asked + 2).map((a) => a.path)).toEqual([
      '/2.0/repositories/acme/shop?fields=mainbranch.name',
      `/2.0/repositories/acme/shop/commits?include=${change.new.target.hash}&pagelen=100&exclude=main`,
    ]);

    await updateIntegration(w.adminCtx, cloud.id, { accessToken: 'an-old-token' });
    await fromCloud(cloud, 'repo:push', push);
    const message = (await lastDelivery(cloud.id)).message;
    expect(message).toContain(`a4a couldn’t read the commits on feature/keys from 127.0.0.1`);
    expect(message).toContain('the access token was refused (401)');
    await updateIntegration(w.adminCtx, cloud.id, { accessToken: fake.token });
  });

  it('links a pull request by its description, with its author known by their account, and keeps its state', async () => {
    // A nickname isn't unique at Bitbucket, so it isn't a login a4a takes.
    const nickname = await failure(addProviderLogin(w.adminCtx, 'ben', { provider: 'bitbucket', login: 'ben' }));
    expect([nickname.status, nickname.message, nickname.hint]).toEqual([
      400,
      'That doesn’t look like a login at Bitbucket Cloud',
      'Bitbucket Cloud’s nicknames aren’t unique, so give their account id (557058:…) or their UUID ({…}), from their profile',
    ]);
    // Its UUID as the profile shows it: braces, in capitals.
    await addProviderLogin(w.adminCtx, 'ben', { provider: 'bitbucket', login: '{7E6D5C4B-3A29-4180-9F8E-7D6C5B4A3928}' });

    const pr = json('bitbucket-pullrequest');
    const opened = await fromCloud(cloud, 'pullrequest:created', pr);
    expect(opened.body).toMatchObject({ outcome: 'processed', linked: 1 });
    expect((await vcsOf('BACK-5')).pullRequests[0]).toMatchObject({
      repository: 'acme/shop',
      number: 7,
      title: 'Rate limits for exports',
      url: 'https://bitbucket.org/acme/shop/pull-requests/7',
      state: 'open',
      branch: 'feature/export-limits',
      target: 'main',
      author: { login: 'ben', user: { login: 'ben' } },
    });

    pr.pullrequest.state = 'MERGED';
    await fromCloud(cloud, 'pullrequest:fulfilled', pr);
    expect((await vcsOf('BACK-5')).pullRequests[0]!.state).toBe('merged');
    pr.pullrequest.state = 'DECLINED';
    await fromCloud(cloud, 'pullrequest:rejected', pr);
    expect((await vcsOf('BACK-5')).pullRequests[0]!.state).toBe('closed');

    const ignored = await fromCloud(cloud, 'pullrequest:approved', pr);
    expect(ignored.body).toMatchObject({ outcome: 'ignored' });
  });
});

describe('Bitbucket Data Center', () => {
  let dc: VcsIntegrationCreated;
  beforeAll(async () => {
    dc = await createIntegration(w.adminCtx, { provider: 'bitbucket-dc', name: 'PROJ/backend', projects: ['BACK'], baseUrl: `${fake.url}/`, accessToken: fake.token });
    fake.answer('/rest/api/1.0/projects/PROJ/repos/backend/commits', () => json('bitbucket-dc-commits'));
  });

  it('needs an https address, and takes a token for Bitbucket, GitHub, GitLab and Gitea', async () => {
    const none = await failure(createIntegration(w.adminCtx, { provider: 'bitbucket-dc', name: 'PROJ/x' }));
    expect([none.status, none.message]).toEqual([400, 'Give Bitbucket Data Center’s address']);
    const plain = await failure(createIntegration(w.adminCtx, { provider: 'bitbucket-dc', name: 'PROJ/x', baseUrl: 'http://bitbucket.acme.example' }));
    expect([plain.status, plain.message]).toEqual([400, 'Bitbucket’s address must be https']);
    const glPlain = await failure(createIntegration(w.adminCtx, { provider: 'gitlab', name: 'acme/x', baseUrl: 'http://gitlab.acme.example', accessToken: 'glpat_x' }));
    expect([glPlain.status, glPlain.message]).toEqual([400, 'GitLab’s API’s address must be https']);
    // GitLab and Gitea take one too, since D70, to write commit statuses on their pull requests; the
    // token is sealed as GitHub's is, and GitLab's address is gitlab.com unless another is given.
    const gitlab = await createIntegration(w.adminCtx, { provider: 'gitlab', name: 'acme/code', accessToken: 'glpat_x' });
    expect(gitlab).toMatchObject({ hasAccessToken: true, baseUrl: null });
    const gitea = await createIntegration(w.adminCtx, { provider: 'gitea', name: 'acme/forge', baseUrl: 'https://git.acme.example/api/v1', accessToken: 'd3v_x' });
    expect(gitea).toMatchObject({ hasAccessToken: true, baseUrl: 'https://git.acme.example/api/v1' });
    // GitHub takes one since D46, to ask which commits a build holds, and keeps it sealed.
    const github = await createIntegration(w.adminCtx, { provider: 'github', name: 'acme/x', accessToken: 'ghp_x' });
    expect(github).toMatchObject({ hasAccessToken: true });
    const remove = await failure(updateIntegration(w.adminCtx, dc.id, { baseUrl: null }));
    expect(remove.message).toBe('Give Bitbucket Data Center’s address');
    // Kept without its trailing slash; the token is never shown.
    expect(dc).toMatchObject({ baseUrl: fake.url, hasAccessToken: true });
    expect(JSON.stringify(dc)).not.toContain(fake.token);
    expect(JSON.stringify(gitlab)).not.toContain('glpat_x');
  });

  it("answers Test connection's unsigned ping, and refuses anything else unsigned", async () => {
    const before = (await listVcsDeliveries(w.adminCtx, dc.id)).length;
    const ping = await fromDc(dc, 'diagnostics:ping', { test: true }, randomUUID(), false);
    expect(ping).toMatchObject({ status: 200, body: { ok: true, outcome: 'ignored' } });
    expect((await listVcsDeliveries(w.adminCtx, dc.id)).length).toBe(before);
    const signedPing = await fromDc(dc, 'diagnostics:ping', { test: true });
    expect(signedPing.body).toMatchObject({ outcome: 'processed', message: 'Bitbucket Data Center can reach a4a, and the signature is right.' });
    const unsigned = await fromDc(dc, 'repo:refs_changed', json('bitbucket-dc-refs-changed'), randomUUID(), false);
    expect(unsigned.status).toBe(401);
  });

  it('reads the commits a push moved with the access token, and runs a command as their author', async () => {
    const asked = fake.asked.length;
    const delivery = randomUUID();
    const res = await fromDc(dc, 'repo:refs_changed', json('bitbucket-dc-refs-changed'), delivery);
    expect(res.body).toMatchObject({ outcome: 'processed', linked: 2, applied: 1 });
    expect(fake.asked.slice(asked)).toEqual([
      {
        path: '/rest/api/1.0/projects/PROJ/repos/backend/commits?until=178864a7d521b6f5e720b386b2c2b0ef8563e0dc&limit=100&start=0&since=ecddabb624f6f5ba43816f5926e580a5f680a932',
        auth: `Bearer ${fake.token}`,
      },
    ]);
    expect((await vcsOf('BACK-1')).commits.find((c) => c.repository === 'PROJ/backend')).toMatchObject({
      sha: '178864a7d521b6f5e720b386b2c2b0ef8563e0dc',
      url: `${fake.url}/projects/PROJ/repos/backend/commits/178864a7d521b6f5e720b386b2c2b0ef8563e0dc`,
      branch: 'master',
      author: { name: 'Anna Schmidt', login: 'anna', user: { login: 'anna' } },
      command: 'Fixed',
      at: '2026-11-16T09:12:44.000Z',
    });
    expect((await fromDc(dc, 'repo:refs_changed', json('bitbucket-dc-refs-changed'), delivery)).body).toMatchObject({ outcome: 'duplicate' });
  });

  it('reads a new branch from where it left the default branch; without a token it links nothing, and says why', async () => {
    fake.answer('/rest/api/1.0/projects/PROJ/repos/backend/branches/default', () => ({ id: 'refs/heads/master', displayId: 'master', type: 'BRANCH', latestCommit: 'ecddabb624f6f5ba43816f5926e580a5f680a932', isDefault: true }));
    const push = json('bitbucket-dc-refs-changed');
    push.changes = [{ ref: { id: 'refs/heads/feature/keys', displayId: 'feature/keys', type: 'BRANCH' }, refId: 'refs/heads/feature/keys', fromHash: '0'.repeat(40), toHash: '178864a7d521b6f5e720b386b2c2b0ef8563e0dc', type: 'ADD' }];
    const asked = fake.asked.length;
    await fromDc(dc, 'repo:refs_changed', push);
    expect(fake.asked.slice(asked).map((a) => a.path)).toEqual([
      '/rest/api/1.0/projects/PROJ/repos/backend/branches/default',
      '/rest/api/1.0/projects/PROJ/repos/backend/commits?until=178864a7d521b6f5e720b386b2c2b0ef8563e0dc&limit=100&start=0&since=ecddabb624f6f5ba43816f5926e580a5f680a932',
    ]);

    const blind = await createIntegration(w.adminCtx, { provider: 'bitbucket-dc', name: 'PROJ/blind', baseUrl: fake.url });
    const res = await fromDc(blind, 'repo:refs_changed', json('bitbucket-dc-refs-changed'));
    expect(res.body).toMatchObject({ outcome: 'processed', linked: 0 });
    expect((await lastDelivery(blind.id)).message).toContain('Bitbucket Data Center sends no commits with a push; give the integration an access token so a4a reads the commits on master');
    const tested = await testIntegration(w.adminCtx, blind.id);
    expect(tested).toMatchObject({ delivered: true, outcome: 'processed' });
    expect(tested.message).toContain("It has no access token, so it can't read the commits pushes move: give it one.");
  });

  it('links a pull request with its author known by their username, and follows it to merged and declined', async () => {
    await addProviderLogin(w.adminCtx, 'ben', { provider: 'bitbucket-dc', login: 'ben' });
    const pr = json('bitbucket-dc-pr-opened');
    const res = await fromDc(dc, 'pr:opened', pr);
    expect(res.body).toMatchObject({ outcome: 'processed', linked: 1 });
    expect((await vcsOf('BACK-3')).pullRequests[0]).toMatchObject({
      repository: 'PROJ/backend',
      number: 12,
      url: 'https://bitbucket.acme.example/projects/PROJ/repos/backend/pull-requests/12',
      branch: 'feature/token-cache',
      target: 'master',
      state: 'open',
      author: { name: 'Ben Okafor', login: 'ben', user: { login: 'ben' } },
    });
    pr.pullRequest.state = 'MERGED';
    await fromDc(dc, 'pr:merged', pr);
    expect((await vcsOf('BACK-3')).pullRequests[0]!.state).toBe('merged');
    pr.pullRequest.state = 'DECLINED';
    await fromDc(dc, 'pr:declined', pr);
    expect((await vcsOf('BACK-3')).pullRequests[0]!.state).toBe('closed');
  });
});

describe('Gitea and Forgejo', () => {
  let gitea: VcsIntegrationCreated;
  beforeAll(async () => {
    gitea = await createIntegration(w.adminCtx, { provider: 'gitea', name: 'acme/infra', projects: ['BACK'] });
  });

  it("checks Gitea's, Forgejo's or GitHub's signature header, and refuses an empty one", async () => {
    const body = JSON.stringify({ ref: 'refs/heads/main', after: 'b'.repeat(40), repository: { full_name: 'acme/infra' }, commits: [] });
    const sig = hmac(gitea.secret, body);
    const ways: Record<string, string>[] = [{ 'x-gitea-signature': sig }, { 'x-forgejo-signature': sig, 'x-forgejo-event': 'push' }, { 'x-hub-signature-256': `sha256=${sig}` }];
    for (const headers of ways) {
      const res = await post(gitea.id, body, { 'x-gitea-event': 'push', 'x-gitea-delivery': randomUUID(), ...headers });
      expect([res.status, res.body.outcome]).toEqual([200, 'processed']);
    }
    // Without a secret, Gitea still sends the header, empty.
    const empty = await post(gitea.id, body, { 'x-gitea-event': 'push', 'x-gitea-delivery': randomUUID(), 'x-gitea-signature': '' });
    expect([empty.status, empty.body.error.message]).toEqual([401, 'No X-Gitea-Signature: give the webhook in Forgejo/Gitea the secret a4a showed when it was added.']);
  });

  it('runs a command as the person whose login Gitea matched the commit to, though a4a knows not its email', async () => {
    const unknown = await (async () => {
      const body = fixture('gitea-push');
      return post(gitea.id, body, { 'x-gitea-event': 'push', 'x-gitea-delivery': randomUUID(), 'x-gitea-signature': hmac(gitea.secret, body) });
    })();
    expect(unknown.body).toMatchObject({ linked: 1, applied: 0 });
    expect((await vcsOf('BACK-4')).commits.find((c) => c.repository === 'acme/infra')).toMatchObject({ applied: false, note: 'Not applied: a4a doesn’t know who wrote it' });
    expect((await lastDelivery(gitea.id)).message).toContain('nobody in a4a has the confirmed email ben.okafor@users.noreply.git.acme.example or the login bokafor at Forgejo/Gitea');

    await addProviderLogin(w.adminCtx, 'ben', { provider: 'gitea', login: 'BOkafor' });
    const push = json('gitea-push');
    push.commits[0].id = 'a1fefe4224043ba2feb48d137756c8a9331c449a';
    const body = JSON.stringify(push);
    const res = await post(gitea.id, body, { 'x-forgejo-event': 'push', 'x-forgejo-delivery': randomUUID(), 'x-forgejo-signature': hmac(gitea.secret, body) });
    expect(res.body).toMatchObject({ linked: 1, applied: 1 });
    expect(value(await getIssue(w.adminCtx, 'BACK-4'), 'State')).toBe('In Progress');
    expect((await vcsOf('BACK-4')).commits.find((c) => c.sha === 'a1fefe4224043ba2feb48d137756c8a9331c449a')).toMatchObject({ applied: true, author: { login: 'bokafor', user: { login: 'ben' } } });
  });

  it('keeps a merged pull request, as Gitea sends one closed and merged', async () => {
    const body = fixture('gitea-pull-request');
    const res = await post(gitea.id, body, { 'x-gitea-event': 'pull_request', 'x-gitea-delivery': randomUUID(), 'x-gitea-signature': hmac(gitea.secret, body) });
    expect(res.body).toMatchObject({ outcome: 'processed', linked: 1 });
    expect((await vcsOf('BACK-4')).pullRequests[0]).toMatchObject({ number: 3, state: 'merged', branch: 'keys', target: 'main', author: { user: { login: 'ben' } } });
  });
});

describe('who wrote it', () => {
  it('is nobody when the email names one person and the login another', async () => {
    const hook = await createIntegration(w.adminCtx, { provider: 'github', name: 'acme/both', projects: ['BACK'] });
    await addProviderLogin(w.adminCtx, 'ben', { provider: 'github', login: 'ben-o' });
    const body = JSON.stringify({
      ref: 'refs/heads/main',
      repository: { full_name: 'acme/both' },
      commits: [{ id: 'f0f0f0f0a1b2c3d4e5f60718293a4b5c6d7e8f90', message: 'Spare a test (BACK-6 #Fixed)', author: { name: 'Anna Schmidt', email: 'anna@example.com', username: 'ben-o' } }],
    });
    const res = await post(hook.id, body, { 'x-github-event': 'push', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': `sha256=${hmac(hook.secret, body)}` });
    expect(res.body).toMatchObject({ linked: 1, applied: 0 });
    expect((await vcsOf('BACK-6')).commits[0]).toMatchObject({ applied: false, note: 'Not applied: its author’s email and their login at GitHub are two different people’s in a4a', author: { user: null } });
    // Only the delivery's log, which administrators read, says whose.
    expect((await lastDelivery(hook.id)).message).toContain('the email anna@example.com is Anna Schmidt’s, and the login ben-o at GitHub is Ben Okafor’s');
  });

  it('records a login once, for one person, and only an administrator does', async () => {
    const twice = await addProviderLogin(w.adminCtx, 'ben', { provider: 'github', login: 'Ben-O' });
    expect(twice.login).toBe('ben-o');
    const taken = await failure(addProviderLogin(w.adminCtx, 'anna', { provider: 'github', login: 'BEN-O' }));
    expect([taken.status, taken.message]).toEqual([409, 'That login at GitHub is Ben Okafor’s already']);
    const member = await failure(addProviderLogin(w.as(w.anna), 'anna', { provider: 'github', login: 'anna-s' }));
    expect(member.status).toBe(403);
    const shape = await failure(addProviderLogin(w.adminCtx, 'anna', { provider: 'github', login: 'Anna Schmidt' }));
    expect([shape.status, shape.hint]).toEqual([400, 'Their GitHub username, as in github.com/anna-s']);
  });

  it('tests each kind of integration by sending itself a signed delivery', async () => {
    for (const provider of ['bitbucket', 'bitbucket-dc', 'gitea'] as const) {
      const hook = await createIntegration(w.adminCtx, { provider, name: `acme/test-${provider}`, ...(provider === 'bitbucket-dc' ? { baseUrl: 'https://bitbucket.acme.example', accessToken: 'x' } : {}) });
      const tested = await testIntegration(w.adminCtx, hook.id);
      expect(tested, provider).toMatchObject({ delivered: true, outcome: 'processed' });
      expect(tested.message).toContain('signed with the secret, and the signature checked out');
    }
  });
});
