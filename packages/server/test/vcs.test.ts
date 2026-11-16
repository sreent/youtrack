import type { IssueDetail, IssueVcs } from '@a4a/shared';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activities, vcsDeliveries } from '../src/db/schema';
import { createHttpApp } from '../src/http/app';
import { issueActivity } from '../src/services/activity';
import { createIssue, getIssue } from '../src/services/issues';
import { updateMe, updateUser } from '../src/services/users';
import { presentField, toolByName } from '../src/tools/registry';
import { createIntegration, listIntegrations, listVcsDeliveries, rotateIntegrationSecret, testIntegration, updateIntegration } from '../src/vcs/integrations';
import { mentions } from '../src/vcs/mentions';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let http: ReturnType<typeof createHttpApp>;
let github: { id: string; secret: string };
let gitlab: { id: string; secret: string };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/vcs/${name}.json`, import.meta.url), 'utf8');
const value = (i: IssueDetail, name: string) => presentField(i.fields.find((f) => f.name === name)!);
const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

async function post(id: string, body: string, headers: Record<string, string>, ip = '203.0.113.7') {
  const res = await http.request(`/api/v1/vcs/hooks/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...headers },
    body,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

const fromGithub = (event: string, body: string, delivery = randomUUID(), secret = github.secret) =>
  post(github.id, body, { 'x-github-event': event, 'x-github-delivery': delivery, 'x-hub-signature-256': sign(secret, body), 'user-agent': 'GitHub-Hookshot/2f8e7a1' });
const fromGitlab = (event: string, body: string, token = gitlab.secret, key = randomUUID()) =>
  post(gitlab.id, body, { 'x-gitlab-event': event, 'x-gitlab-token': token, 'idempotency-key': key, 'x-gitlab-event-uuid': randomUUID(), 'user-agent': 'GitLab/17.6.0' });

async function vcsOf(id: string): Promise<IssueVcs> {
  const res = await http.request(`/api/v1/issues/${id}/vcs`, { headers: { cookie: '' } });
  expect(res.status).toBe(401); // it needs someone signed in
  const { issueVcs } = await import('../src/vcs/links');
  return issueVcs(w.as(w.viewer), id);
}

beforeAll(async () => {
  w = await createWorld();
  http = createHttpApp(w.app);
  // Emails an administrator sets are verified; one a person sets for themselves isn't, until one confirms it.
  await updateUser(w.adminCtx, 'anna', { email: 'anna@example.com' });
  await updateUser(w.adminCtx, 'vera', { email: 'vera@example.com' });
  await updateMe(w.as(w.ben), { email: 'ben@example.com' });
  for (const summary of ['Login fails on Safari with SSO', 'Exports slow the database down', 'Replace the token cache', 'Spare', 'Rate limits for exports']) {
    await createIssue(w.as(w.anna), { project: 'BACK', summary });
  }
  await createIssue(w.as(w.anna), { project: 'WEB', summary: 'The date picker needs a mouse' });
  await createIssue(w.as(w.anna), { project: 'WEB', summary: 'Cards lose their focus ring' });
  const gh = await createIntegration(w.adminCtx, { provider: 'github', name: 'acme/backend', projects: ['BACK'] });
  const gl = await createIntegration(w.adminCtx, { provider: 'gitlab', name: 'acme/web', projects: [] });
  github = { id: gh.id, secret: gh.secret };
  gitlab = { id: gl.id, secret: gl.secret };
  expect(gh.webhookUrl).toBe(`${w.app.config.publicUrl}/api/v1/vcs/hooks/${gh.id}`);
});

afterAll(async () => {
  await w?.close();
});

describe('finding issues and commands in what people write', () => {
  const keys = new Set(['BACK', 'WEB']);
  it('reads ids, and the command after # to the end of the line', () => {
    expect(mentions('Fix login\n\nBACK-12 #Fixed', keys)).toEqual([{ id: 'BACK-12', command: 'Fixed' }]);
    expect(mentions('Throttle (back-2 #State In Progress Assignee anna).', keys)).toEqual([{ id: 'BACK-2', command: 'State In Progress Assignee anna' }]);
    expect(mentions('BACK-1 #Fixed BACK-2 #Open', keys)).toEqual([
      { id: 'BACK-1', command: 'Fixed' },
      { id: 'BACK-2', command: 'Open' },
    ]);
    expect(mentions('BACK-1 #subtask of BACK-3', keys)).toEqual([
      { id: 'BACK-1', command: 'subtask of BACK-3' },
      { id: 'BACK-3', command: null },
    ]);
  });
  it('leaves alone what only looks like an id or a command', () => {
    expect(mentions('SHA-256 of UTF-8 names, see PR #45', keys)).toEqual([]);
    expect(mentions('BACK-3 #45 and BACK-3 again', keys)).toEqual([{ id: 'BACK-3', command: null }]);
    expect(mentions('Closes BACK-5 #Fixed', keys, false)).toEqual([{ id: 'BACK-5', command: null }]);
    expect(mentions('feature/web-2-focus-ring', keys)).toEqual([{ id: 'WEB-2', command: null }]);
  });
});

describe('GitHub', () => {
  it('links pushed commits, and runs a command as its verified author when they may change the project', async () => {
    const res = await fromGithub('push', fixture('github-push'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, outcome: 'processed', linked: 4, applied: 1 });

    // BACK-1 #Fixed, by Anna, whose email an administrator set: applied, as her, through the integration.
    const one = await getIssue(w.adminCtx, 'BACK-1');
    expect(value(one, 'State')).toBe('Fixed');
    const [commit] = (await vcsOf('BACK-1')).commits;
    expect(commit).toMatchObject({
      repository: 'acme/backend',
      sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      title: 'Fix the SSO redirect loop on Safari',
      branch: 'main',
      url: 'https://github.com/acme/backend/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      author: { name: 'Anna Schmidt', login: 'anna-schmidt', user: { login: 'anna' } },
      command: 'Fixed',
      applied: true,
      note: 'State: Open → Fixed',
      integration: { name: 'acme/backend', provider: 'github' },
    });
    const history = await issueActivity(w.adminCtx, 'BACK-1');
    const linked = history.find((e) => e.type === 'commit.linked')!;
    expect(linked.actor).toMatchObject({ login: 'anna', channel: 'vcs', token: 'acme/backend' });
    expect(linked.data).toMatchObject({ sha: commit!.sha, command: 'Fixed', applied: true });
    expect(history.find((e) => e.type === 'issue.updated')!.actor).toMatchObject({ login: 'anna', channel: 'vcs' });

    // BACK-2's command came from someone a4a doesn't know: linked, not applied, and why.
    expect(value(await getIssue(w.adminCtx, 'BACK-2'), 'State')).toBe('Open');
    expect((await vcsOf('BACK-2')).commits[0]).toMatchObject({ command: 'State In Progress Assignee anna', applied: false, note: 'Not applied: a4a doesn’t know who wrote it', author: { user: null } });
    const two = (await issueActivity(w.adminCtx, 'BACK-2')).find((e) => e.type === 'commit.linked')!;
    expect(two.actor).toMatchObject({ id: null, channel: 'vcs' });

    // BACK-3: two commits by Vera, a viewer: both linked, her #Fixed not applied.
    const three = await vcsOf('BACK-3');
    expect(three.commits).toHaveLength(2);
    expect(three.commits.find((c) => c.command)).toMatchObject({ command: 'Fixed', applied: false, note: 'Not applied: Vera Viewer can’t change issues in BACK' });
    expect(value(await getIssue(w.adminCtx, 'BACK-3'), 'State')).toBe('Open');

    const [delivery] = await listVcsDeliveries(w.adminCtx, github.id);
    expect(delivery).toMatchObject({ event: 'push', outcome: 'processed', statusCode: 200, linked: 4, applied: 1 });
    expect(delivery!.message).toContain('nobody in a4a has the verified email jordi@softcatala.example');
  });

  it('refuses a delivery whose signature is wrong or missing, and logs it', async () => {
    const body = fixture('github-push');
    const before = await w.app.db.select({ n: count() }).from(activities);
    const forged = await fromGithub('push', body, randomUUID(), 'not-the-secret');
    expect(forged.status).toBe(401);
    expect((forged.body.error as { message: string }).message).toContain('does not match');
    const bare = await post(github.id, body, { 'x-github-event': 'push', 'x-github-delivery': randomUUID() });
    expect(bare.status).toBe(401);
    // A body changed after signing is refused too.
    const tampered = await post(github.id, body.replace('BACK-1 #Fixed', 'BACK-1 #Obsolete'), { 'x-github-event': 'push', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': sign(github.secret, body) });
    expect(tampered.status).toBe(401);
    expect(await w.app.db.select({ n: count() }).from(activities)).toEqual(before);
    const refused = (await listVcsDeliveries(w.adminCtx, github.id)).filter((d) => d.outcome === 'refused');
    expect(refused).toHaveLength(3);
    expect(refused.map((d) => d.statusCode)).toEqual([401, 401, 401]);
  });

  it('does a delivery once: one sent again is a duplicate and changes nothing', async () => {
    const body = JSON.stringify({ ...JSON.parse(fixture('github-push')), commits: [{ ...JSON.parse(fixture('github-push')).commits[0], id: 'f60718293a4b5c6d7e8f9012345678a1b2c3d4e5', message: 'Log the redirect\n\nBACK-5 #Major' }] });
    const delivery = randomUUID();
    const first = await fromGithub('push', body, delivery);
    expect(first.body).toMatchObject({ outcome: 'processed', linked: 1, applied: 1 });
    expect(value(await getIssue(w.adminCtx, 'BACK-5'), 'Priority')).toBe('Major');
    const events = (await issueActivity(w.adminCtx, 'BACK-5')).length;
    const again = await fromGithub('push', body, delivery);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ outcome: 'duplicate' });
    expect((await issueActivity(w.adminCtx, 'BACK-5')).length).toBe(events);
    // Sent with another delivery id (as a provider's "redeliver" may), the commit is linked already: still nothing twice.
    const other = await fromGithub('push', body);
    expect(other.body).toMatchObject({ outcome: 'processed', linked: 0, applied: 0 });
    expect((await issueActivity(w.adminCtx, 'BACK-5')).length).toBe(events);
  });

  it('does the same commit once when deliveries race', async () => {
    const base = JSON.parse(fixture('github-push'));
    const body = JSON.stringify({ ...base, commits: [{ ...base.commits[0], id: '18293a4b5c6d7e8f9012345678a1b2c3d4e5f607', message: 'Retry exports\n\nBACK-5 #tag raced' }] });
    const delivery = randomUUID();
    // The same delivery twice at once, and the same commit in another delivery at the same time.
    const answers = await Promise.all([fromGithub('push', body, delivery), fromGithub('push', body, delivery), fromGithub('push', body)]);
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200]);
    expect(answers.filter((a) => a.body.outcome === 'duplicate')).toHaveLength(1);
    expect(answers.reduce((n, a) => n + Number(a.body.linked ?? 0), 0)).toBe(1);
    expect(answers.reduce((n, a) => n + Number(a.body.applied ?? 0), 0)).toBe(1);
    const tagged = (await issueActivity(w.adminCtx, 'BACK-5')).filter((e) => e.type === 'issue.updated' && e.changes.some((c) => c.to?.includes('raced')));
    expect(tagged).toHaveLength(1);
  });

  it('handles again a delivery that failed the first time', async () => {
    const delivery = randomUUID();
    const broken = await fromGithub('push', '{"ref": "refs/heads/main", "repository": {}}', delivery);
    expect(broken.status).toBe(400);
    const body = JSON.stringify({ ...JSON.parse(fixture('github-push')), commits: [] });
    const retried = await fromGithub('push', body, delivery);
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ outcome: 'processed' });
  });

  it("links a pull request by its title, branch and description, and keeps its state current", async () => {
    const opened = fixture('github-pull-request-opened');
    const res = await fromGithub('pull_request', opened);
    expect(res.body).toMatchObject({ outcome: 'processed', linked: 2 });
    const [pr] = (await vcsOf('BACK-2')).pullRequests;
    expect(pr).toMatchObject({ number: 42, title: 'BACK-2: throttle exports per account', state: 'open', branch: 'feature/back-2-throttle-exports', target: 'main', author: { login: 'jmallach' } });
    expect((await vcsOf('BACK-5')).pullRequests[0]).toMatchObject({ number: 42, state: 'open' });

    const merged = JSON.parse(opened);
    merged.action = 'closed';
    merged.pull_request.state = 'closed';
    merged.pull_request.merged = true;
    merged.pull_request.merged_at = '2026-11-16T11:02:00Z';
    merged.pull_request.updated_at = '2026-11-16T11:02:00Z';
    await fromGithub('pull_request', JSON.stringify(merged));
    expect((await vcsOf('BACK-2')).pullRequests[0]).toMatchObject({ number: 42, state: 'merged' });
    expect((await vcsOf('BACK-5')).pullRequests[0]).toMatchObject({ state: 'merged' });
    const moved = (await issueActivity(w.adminCtx, 'BACK-2')).filter((e) => e.type.startsWith('pull_request.'));
    expect(moved.map((e) => [e.type, e.data.state, e.data.from ?? null])).toEqual([
      ['pull_request.linked', 'open', null],
      ['pull_request.updated', 'merged', 'open'],
    ]);

    const closed = structuredClone(merged);
    closed.pull_request.merged = false;
    closed.pull_request.merged_at = null;
    await fromGithub('pull_request', JSON.stringify(closed));
    expect((await vcsOf('BACK-2')).pullRequests[0]!.state).toBe('closed');
  });

  it('answers a ping, and ignores events it does not read', async () => {
    const ping = await fromGithub('ping', JSON.stringify({ zen: 'Design for failure.', hook_id: 109948940 }));
    expect(ping.body).toMatchObject({ outcome: 'processed' });
    const star = await fromGithub('star', JSON.stringify({ action: 'created', starred_at: '2026-11-16T11:00:00Z' }));
    expect(star.body).toMatchObject({ outcome: 'ignored' });
  });

  it('only looks for ids of its own projects', async () => {
    const body = JSON.stringify({ ...JSON.parse(fixture('github-push')), commits: [{ ...JSON.parse(fixture('github-push')).commits[0], id: '0718293a4b5c6d7e8f9012345678a1b2c3d4e5f6', message: 'WEB-1 #Fixed' }] });
    const res = await fromGithub('push', body);
    expect(res.body).toMatchObject({ linked: 0 });
    expect(value(await getIssue(w.adminCtx, 'WEB-1'), 'State')).toBe('Open');
  });
});

describe('GitLab', () => {
  it('checks the secret token and links pushes; an unverified email runs no command', async () => {
    const wrong = await fromGitlab('Push Hook', fixture('gitlab-push'), 'guess');
    expect(wrong.status).toBe(401);
    const res = await fromGitlab('Push Hook', fixture('gitlab-push'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'processed', linked: 2, applied: 1 });
    expect(value(await getIssue(w.adminCtx, 'WEB-1'), 'State')).toBe('Fixed');
    // Ben set his email himself: until an administrator confirms it, his commits link only.
    expect(value(await getIssue(w.adminCtx, 'WEB-2'), 'State')).toBe('Open');
    expect((await vcsOf('WEB-2')).commits[0]).toMatchObject({ command: 'In Review', applied: false, note: 'Not applied: Ben Okafor’s email isn’t verified yet' });
  });

  it('keeps a merge request current, opened to merged', async () => {
    const opened = fixture('gitlab-merge-request');
    expect((await fromGitlab('Merge Request Hook', opened)).body).toMatchObject({ linked: 1 });
    expect((await vcsOf('WEB-2')).pullRequests[0]).toMatchObject({ number: 7, state: 'open', branch: 'web-2-focus-ring', url: 'https://gitlab.example.com/acme/web/-/merge_requests/7' });
    const merged = JSON.parse(opened);
    merged.object_attributes.state = 'merged';
    merged.object_attributes.action = 'merge';
    merged.object_attributes.updated_at = '2026-11-16 10:00:00 UTC';
    expect((await fromGitlab('Merge Request Hook', JSON.stringify(merged))).body).toMatchObject({ outcome: 'processed' });
    expect((await vcsOf('WEB-2')).pullRequests[0]).toMatchObject({ number: 7, state: 'merged', at: '2026-11-16T10:00:00.000Z' });
  });

  it('dedupes on its Idempotency-Key', async () => {
    const key = randomUUID();
    const body = JSON.stringify({ ...JSON.parse(fixture('gitlab-push')), commits: [] });
    expect((await fromGitlab('Push Hook', body, gitlab.secret, key)).body).toMatchObject({ outcome: 'processed' });
    expect((await fromGitlab('Push Hook', body, gitlab.secret, key)).body).toMatchObject({ outcome: 'duplicate' });
  });
});

describe('managing integrations', () => {
  it('is for administrators, and shows a secret only once', async () => {
    await expect(listIntegrations(w.as(w.anna))).rejects.toMatchObject({ status: 403 });
    await expect(createIntegration(w.as(w.anna), { provider: 'github', name: 'x' })).rejects.toMatchObject({ status: 403 });
    const listed = await listIntegrations(w.adminCtx);
    expect(JSON.stringify(listed)).not.toContain(github.secret);
    expect(JSON.stringify(listed)).not.toContain(gitlab.secret);
    expect(listed.find((i) => i.id === github.id)).toMatchObject({ provider: 'github', projects: ['BACK'], secretPrefix: github.secret.slice(0, 6) });
  });

  it('sends a test through its own handling', async () => {
    expect(await testIntegration(w.adminCtx, github.id)).toMatchObject({ delivered: true, outcome: 'processed' });
    const gl = await testIntegration(w.adminCtx, gitlab.id);
    expect(gl).toMatchObject({ delivered: true, outcome: 'processed' });
    expect(gl.message).toContain("can't check");
    expect((await listVcsDeliveries(w.adminCtx, github.id))[0]).toMatchObject({ test: true, event: 'ping' });
  });

  it('takes nothing while paused, and stops the old secret when given a new one', async () => {
    await updateIntegration(w.adminCtx, github.id, { active: false });
    const paused = await fromGithub('ping', JSON.stringify({ zen: 'Half measures are as bad as nothing at all.' }));
    expect(paused.status).toBe(202);
    expect(paused.body).toMatchObject({ outcome: 'ignored' });
    await updateIntegration(w.adminCtx, github.id, { active: true });
    const rotated = await rotateIntegrationSecret(w.adminCtx, github.id);
    expect(rotated.secret).not.toBe(github.secret);
    expect((await fromGithub('ping', '{}')).status).toBe(401);
    github.secret = rotated.secret;
    expect((await fromGithub('ping', '{}')).status).toBe(200);
  });

  it('limits refused deliveries from one address, and logs no more of them', async () => {
    const flood = await createIntegration(w.adminCtx, { provider: 'gitlab', name: 'flood' });
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) {
      const res = await post(flood.id, '{}', { 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': `guess-${i}` }, '198.51.100.9');
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
    const [{ n } = { n: 0 }] = await w.app.db.select({ n: count() }).from(vcsDeliveries).where(eq(vcsDeliveries.integrationId, flood.id));
    expect(Number(n)).toBe(30);
    // Another address is not held back by it.
    expect((await post(flood.id, '{}', { 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': 'x' }, '198.51.100.10')).status).toBe(401);
  });

  it('refuses an unknown integration and a body too large', async () => {
    expect((await post('nope', '{}', {})).status).toBe(404);
    const huge = 'x'.repeat(6 * 1024 * 1024);
    expect((await post(github.id, huge, { 'x-github-event': 'push' })).status).toBe(413);
  });
});

describe('agents', () => {
  it('get the commits and pull requests with an issue', async () => {
    const tool = toolByName('get_issue')!;
    const res = await tool.run(w.as(w.anna), { issue: 'BACK-2', comments: 0 });
    const data = res.data as { commits: { sha: string; command?: string; applied?: boolean; note?: string }[]; pullRequests: { number: number; state: string }[] };
    expect(data.commits[0]).toMatchObject({ sha: 'b2c3d4e5f607', command: 'State In Progress Assignee anna', applied: false });
    expect(data.pullRequests[0]).toMatchObject({ number: 42, state: 'closed' });
  });
});
