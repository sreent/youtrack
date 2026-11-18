/**
 * A GitHub App across its installations, and its check runs on pull requests (docs/architecture.md,
 * D66), against the fake GitHub (fake-github.ts): an app on two accounts reads each repository through
 * that repository's own installation, its token kept per installation; a suspended installation says
 * so for its repository, in the delivery's log; and a check run names a pull request's issues as
 * anyone who sees the repository may read them, kept current through the outbox, once per change,
 * within each installation's limit.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBuildSource } from '../src/ci/builds';
import { activities, buildChecks, vcsChecks, vcsInstallations, vcsIntegrations } from '../src/db/schema';
import { toEventDto } from '../src/events/activity';
import { createHttpApp } from '../src/http/app';
import { createToken } from '../src/services/auth';
import { createIssue, deleteIssue, updateIssue } from '../src/services/issues';
import { createProject, updateProject } from '../src/services/projects';
import { checksConsumer, ChecksSender, sendCheck } from '../src/vcs/checks';
import { getJson, ReadError } from '../src/vcs/commits';
import { listIntegrations, listVcsDeliveries } from '../src/vcs/integrations';
import type { IntegrationRow } from '../src/vcs/links';
import { readWith } from '../src/vcs/tokens';
import { startFakeGithub, type FakeGithub } from './fake-github';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let gh: FakeGithub;
let http: ReturnType<typeof createHttpApp>;
let adminToken = '';
let integration = '';
let secret = '';
const sender = () => new ChecksSender(w.app);

const rowOf = async (): Promise<IntegrationRow> => (await w.app.db.select().from(vcsIntegrations).where(eq(vcsIntegrations.id, integration)))[0]!;

async function rest(method: string, path: string, body?: unknown) {
  const res = await http.request(`/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (res.status === 204 ? {} : await res.json()) as Record<string, any> };
}

/** A delivery from the app's one webhook, signed with the integration's secret. */
async function deliver(event: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const res = await http.request(`/api/v1/vcs/hooks/${integration}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': randomUUID(), 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` },
    body,
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const sha = (c: string) => c.repeat(40).slice(0, 40);
const pull = (o: { repository: string; number: number; title: string; body?: string; head: string; base?: string; state?: string; merged?: boolean }) => ({
  action: 'opened',
  repository: { full_name: o.repository },
  pull_request: {
    number: o.number,
    html_url: `https://github.com/${o.repository}/pull/${o.number}`,
    state: o.state ?? 'open',
    merged: o.merged ?? false,
    title: o.title,
    body: o.body ?? '',
    updated_at: new Date().toISOString(),
    user: { login: 'anna-s' },
    head: { ref: 'feature/avatars', sha: o.head },
    base: { ref: 'main', sha: o.base ?? sha('0') },
  },
});

beforeAll(async () => {
  gh = await startFakeGithub();
  gh.installations.push(
    { id: 77, account: 'acme', type: 'Organization', repositories: ['acme/backend', 'acme/web'], permissions: { checks: 'write' } },
    { id: 78, account: 'beta', type: 'User', repositories: ['beta/site'] },
  );
  w = await createWorld();
  http = createHttpApp(w.app);
  adminToken = (await createToken(w.adminCtx, { name: 'admin', scopes: ['read', 'write', 'admin'] })).token;
  // WEB is open to guests: its issues' words are public already. OPS isn't the integration's.
  await updateProject(w.adminCtx, 'WEB', { guestAccess: true });
  await createProject(w.adminCtx, { key: 'OPS', name: 'Operations', template: 'software' });
});

afterAll(async () => {
  await gh.close();
  await w.close();
});

describe('an app installed on several accounts', () => {
  it('is given to an integration not named after a repository, with no question which, and lists both installations with their accounts', async () => {
    const r = await rest('POST', '/vcs/integrations', { provider: 'github', name: 'Acme and Beta', projects: ['BACK', 'WEB'], baseUrl: gh.url, githubApp: { appId: String(gh.appId), privateKey: gh.privateKey } });
    expect(r.status).toBe(201);
    integration = r.body.id;
    secret = r.body.secret;
    expect(r.body.githubApp).toMatchObject({ installationId: '77', account: 'acme' });
    expect(r.body.githubApp.installations).toEqual([
      { id: '77', account: 'acme', accountType: 'organization', allRepositories: false, repositories: [], suspended: false, gone: false },
      { id: '78', account: 'beta', accountType: 'user', allRepositories: false, repositories: [], suspended: false, gone: false },
    ]);
    expect(r.body.checks).toEqual({ enabled: false, states: false, requireResolved: false, problem: null, problemAt: null });
  });

  it('reads each repository through its own installation, keeping the token per installation and the installation per repository', async () => {
    const row = await rowOf();
    const [lookups, exchanges] = [gh.lookups.length, gh.exchanges.length];
    expect(await readWith(w.app, row, (t) => getJson(`${gh.url}/repos/beta/site`, t), 'beta/site')).toEqual({ full_name: 'beta/site' });
    expect(gh.exchanges.at(-1)).toEqual({ installation: 78, permissions: { contents: 'read' } });
    // acme's token was taken when the app was given: held, not taken again.
    expect(await readWith(w.app, row, (t) => getJson(`${gh.url}/repos/acme/backend`, t), 'acme/backend')).toEqual({ full_name: 'acme/backend' });
    expect(gh.exchanges.length).toBe(exchanges + 1);
    expect(gh.lookups.slice(lookups)).toEqual(['beta/site', 'acme/backend']);
    // Read again, at once: no lookup and no exchange.
    await Promise.all([1, 2, 3].map(() => readWith(w.app, row, (t) => getJson(`${gh.url}/repos/beta/site`, t), 'beta/site')));
    expect(gh.lookups.length).toBe(lookups + 2);
    expect(gh.exchanges.length).toBe(exchanges + 1);
    const [listed] = await listIntegrations(w.adminCtx);
    expect(listed!.githubApp!.installations.map((i) => [i.account, i.repositories])).toEqual([
      ['acme', ['acme/backend']],
      ['beta', ['beta/site']],
    ]);
  });

  it('takes a new token once when GitHub refuses one, and no more', async () => {
    const row = await rowOf();
    for (const t of gh.tokens.values()) if (t.installation === 78) t.revoked = true;
    const exchanges = gh.exchanges.length;
    expect(await readWith(w.app, row, (t) => getJson(`${gh.url}/repos/beta/site`, t), 'beta/site')).toEqual({ full_name: 'beta/site' });
    expect(gh.exchanges.length).toBe(exchanges + 1);
    let calls = 0;
    const refused = await readWith(w.app, row, async () => {
      calls++;
      throw new ReadError('the access token was refused (401)', 401);
    }, 'beta/site').catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ReadError);
    expect(calls).toBe(2);
    // A repository no installation holds says so, for that repository.
    const nowhere = await readWith(w.app, row, async (t) => t, 'gamma/x').catch((e: unknown) => e);
    expect((nowhere as ReadError).message).toBe('as the GitHub App: The app isn’t installed on gamma/x. Install it there from the app’s page on GitHub (Install App), or give the installation to read through.');
  });

  it('says a suspended installation is so for its repository, in the delivery’s log, and reads the others', async () => {
    await createBuildSource(w.adminCtx, { kind: 'github', name: 'Beta CI', project: 'BACK', integration, branch: 'main', workflow: 'CI' });
    const run = (repository: string, n: number, head: string) => ({
      action: 'completed',
      repository: { full_name: repository },
      workflow_run: { id: 9000 + n, run_attempt: 1, run_number: n, name: 'CI', path: '.github/workflows/ci.yml', head_branch: 'main', head_sha: head, conclusion: 'success', html_url: null, updated_at: new Date().toISOString(), head_commit: { message: 'Merge', timestamp: new Date().toISOString() } },
    });
    expect((await deliver('workflow_run', run('beta/site', 1, sha('a')))).status).toBe(200);
    gh.installations.find((i) => i.id === 78)!.suspended = true;
    for (const t of gh.tokens.values()) if (t.installation === 78) t.revoked = true;
    expect((await deliver('workflow_run', run('beta/site', 2, sha('b')))).status).toBe(200);
    const [log] = await listVcsDeliveries(w.adminCtx, integration, 1);
    expect(log!.message).toContain("GitHub's compare couldn't be read");
    expect(log!.message).toContain('as the GitHub App: The app’s installation 78 is suspended. Unsuspend it on GitHub, in the settings of the account it’s installed on, under GitHub Apps.');
    const [listed] = await listIntegrations(w.adminCtx);
    expect(listed!.githubApp!.installations.find((i) => i.id === '78')).toMatchObject({ account: 'beta', suspended: true });
    // acme's repositories read as before.
    expect(await readWith(w.app, await rowOf(), (t) => getJson(`${gh.url}/repos/acme/web`, t), 'acme/web')).toEqual({ full_name: 'acme/web' });
    gh.installations.find((i) => i.id === 78)!.suspended = false;
  });
});

describe('check runs on pull requests', () => {
  const ids: Record<string, string> = {};

  it('turn on only where the app may write checks, which GitHub is asked', async () => {
    const token = await rest('POST', '/vcs/integrations', { provider: 'github', name: 'acme/tokens', accessToken: 'ghp_person' });
    expect((await rest('PATCH', `/vcs/integrations/${token.body.id}`, { checks: { enabled: true } })).body.error).toMatchObject({ key: 'vcs.checks.needsApp' });
    await rest('DELETE', `/vcs/integrations/${token.body.id}`);
    const acme = gh.installations.find((i) => i.id === 77)!;
    acme.permissions = {};
    const refused = await rest('PATCH', `/vcs/integrations/${integration}`, { checks: { enabled: true } });
    expect(refused).toMatchObject({ status: 400, body: { error: { key: 'vcs.githubApp.cantWriteChecks' } } });
    expect(refused.body.error.hint).toContain('Checks: Read and write');
    acme.permissions = { checks: 'write' };
    const on = await rest('PATCH', `/vcs/integrations/${integration}`, { checks: { enabled: true } });
    expect(on.body.checks).toMatchObject({ enabled: true, states: false, requireResolved: false });
    expect(gh.exchanges.at(-1)).toEqual({ installation: 77, permissions: { checks: 'write' } });
  });

  it('names the issues by id and link alone, a summary only where guests read, and never one limited to some people', async () => {
    ids.open = (await createIssue(w.adminCtx, { project: 'BACK', summary: 'Session cookie leaks the tenant', fields: { Type: 'Bug' } })).id;
    ids.limited = (await createIssue(w.adminCtx, { project: 'BACK', summary: 'Breach at Initech kestrel', fields: { Type: 'Bug' }, visibleTo: { users: ['anna'], groups: [] } })).id;
    ids.guest = (await createIssue(w.adminCtx, { project: 'WEB', summary: 'Avatar upload rejects PNGs', fields: { Type: 'Bug' } })).id;
    const fixed = await createIssue(w.adminCtx, { project: 'WEB', summary: 'Dark mode loses contrast', fields: { Type: 'Bug' } });
    ids.fixed = (await updateIssue(w.adminCtx, fixed.id, { fields: { State: 'Fixed' } })).id;
    await createIssue(w.adminCtx, { project: 'OPS', summary: 'Rotate the keys', fields: { Type: 'Task' } });
    // Its commits name WEB-2, read as the app from its base to its head.
    gh.ranges.set(`${sha('0')}...${sha('c')}`, [{ sha: sha('c'), commit: { message: `Keep contrast (${ids.fixed})` } }]);
    const got = await deliver('pull_request', pull({ repository: 'acme/backend', number: 12, title: `${ids.open} ${ids.guest}: avatars`, body: `Also ${ids.limited}, BACK-999 and OPS-1.`, head: sha('c') }));
    expect(got.status).toBe(200);
    expect(JSON.stringify(got.body)).not.toContain(ids.limited);
    await sender().drain();
    expect(gh.runs).toHaveLength(1);
    const run = gh.runs[0]!;
    expect(run).toMatchObject({ repository: 'acme/backend', headSha: sha('c'), name: 'a4a', conclusion: 'neutral', title: 'Names 3 issues', installation: 77 });
    const base = w.app.config.publicUrl.replace(/\/+$/, '');
    expect(run.summary).toBe(
      [
        'The a4a issues this pull request names, in its title, its branch, its description or its commits:',
        `- [${ids.open}](${base}/issues/${ids.open})\n- [${ids.guest}](${base}/public/issues/${ids.guest}) Avatar upload rejects PNGs\n- [${ids.fixed}](${base}/public/issues/${ids.fixed}) Dark mode loses contrast`,
        '2 more ids it names are no issue a4a can show here: there are none by them, or they aren’t for everyone to see.',
      ].join('\n\n'),
    );
    // The limited issue reads as one that doesn't exist; the team's summaries and states aren't said, nor OPS's id.
    for (const hidden of [ids.limited, 'BACK-999', 'OPS-1', 'Session cookie', 'Breach', 'Fixed', 'Submitted']) expect(run.summary).not.toContain(hidden);
    expect(gh.compared.at(-1)).toMatchObject({ repository: 'acme/backend', installation: 77 });
  });

  it('adds each issue’s state when told to, and fails while one isn’t resolved when the rule is on', async () => {
    await rest('PATCH', `/vcs/integrations/${integration}`, { checks: { states: true } });
    await sender().drain();
    const run = gh.runs[0]!;
    expect(gh.runs).toHaveLength(1);
    expect(run.summary).toContain(`- [${ids.open}](`);
    expect(run.summary).toMatch(new RegExp(`\\[${ids.fixed}\\]\\([^)]+\\) Dark mode loses contrast · Fixed`));
    expect(run.summary).toMatch(new RegExp(`\\[${ids.open}\\]\\([^)]+\\) · Open`));
    expect(run.conclusion).toBe('neutral');
    await rest('PATCH', `/vcs/integrations/${integration}`, { checks: { states: false, requireResolved: true } });
    await sender().drain();
    expect(run).toMatchObject({ conclusion: 'failure', title: '2 issues it names aren’t resolved' });
    expect(run.summary).toContain(`- [${ids.open}](${w.app.config.publicUrl.replace(/\/+$/, '')}/issues/${ids.open}) · not resolved`);
    expect(run.summary).toContain('It fails while an issue it names isn’t resolved, or an id names no issue a4a shows here.');
    expect(run.summary).not.toContain('· Open');
  });

  it('is written again when a named issue changes state, once, however often the event comes', async () => {
    const consumer = checksConsumer(w.app);
    const writes = gh.writes.length;
    await updateIssue(w.adminCtx, ids.open, { fields: { State: 'Fixed' } });
    await updateIssue(w.adminCtx, ids.guest, { fields: { State: 'Fixed' } });
    const s = await w.app.schema.get();
    const events = (await w.app.db.select().from(activities).orderBy(desc(activities.id)).limit(2)).map((r) => toEventDto(s, r)).reverse();
    for (const e of events) await consumer.handle(e);
    await sender().drain();
    expect(gh.writes.length).toBe(writes + 1);
    // Only the ids it can't show hold it back now: failure, said without naming them.
    expect(gh.runs[0]).toMatchObject({ conclusion: 'failure', title: '2 ids name no issue a4a shows' });
    // The same events again (the outbox runs at least once): the same words, written to nobody.
    for (const e of events) await consumer.handle(e);
    await sender().drain();
    expect(gh.writes.length).toBe(writes + 1);
    expect(gh.runs).toHaveLength(1);
    const [row] = await w.app.db.select().from(vcsChecks).where(eq(vcsChecks.number, 12));
    expect(row).toMatchObject({ dueAt: null, conclusion: 'failure' });
  });

  it('gets a run of its own for a new head, and stops when the pull request closes', async () => {
    await deliver('pull_request', { ...pull({ repository: 'acme/backend', number: 12, title: `${ids.open}`, head: sha('d') }), action: 'synchronize' });
    await sender().drain();
    expect(gh.runs.map((r) => r.headSha)).toEqual([sha('c'), sha('d')]);
    expect(gh.runs[1]).toMatchObject({ conclusion: 'neutral', title: 'Names 1 issue', externalId: expect.any(String) });
    // Closed: nothing more is written, whatever changes.
    await deliver('pull_request', { ...pull({ repository: 'acme/backend', number: 12, title: `${ids.open}`, head: sha('d'), state: 'closed', merged: true }), action: 'closed' });
    const writes = gh.writes.length;
    await updateIssue(w.adminCtx, ids.open, { fields: { State: 'Open' } });
    const s = await w.app.schema.get();
    const [last] = await w.app.db.select().from(activities).orderBy(desc(activities.id)).limit(1);
    expect(await checksConsumer(w.app).handle(toEventDto(s, last!))).toBeUndefined();
    await sender().drain();
    expect(gh.writes.length).toBe(writes);
  });

  it('writes no more than its limit a minute through one installation, and waits out GitHub’s', async () => {
    await rest('PATCH', `/vcs/integrations/${integration}`, { checks: { requireResolved: false } });
    w.app.config.vcsChecksPerMinute = 2;
    await w.app.db.update(vcsInstallations).set({ checksWindowAt: null, checksInWindow: 0 });
    for (const n of [20, 21, 22]) await deliver('pull_request', pull({ repository: 'acme/web', number: n, title: `${ids.guest} avatars`, head: sha(String(n % 10)) }));
    const runs = gh.runs.length;
    await sender().drain();
    expect(gh.runs.length).toBe(runs + 2);
    const [waiting] = await w.app.db.select().from(vcsChecks).where(eq(vcsChecks.number, 22));
    expect(waiting!.dueAt!.getTime()).toBeGreaterThan(Date.now() + 30_000);
    // The minute over, it goes.
    await w.app.db.update(vcsInstallations).set({ checksWindowAt: new Date(Date.now() - 2 * 60_000) });
    await w.app.db.update(vcsChecks).set({ dueAt: new Date() }).where(eq(vcsChecks.number, 22));
    await sender().drain();
    expect(gh.runs.length).toBe(runs + 3);
    // GitHub's own limit: the installation waits until it resets, and the check with it.
    gh.limitNext = 1;
    w.app.config.vcsChecksPerMinute = 20;
    await deliver('pull_request', pull({ repository: 'acme/web', number: 23, title: `${ids.guest}`, head: sha('e') }));
    await sender().drain();
    expect(gh.runs.length).toBe(runs + 3);
    const [paused] = await w.app.db.select().from(vcsInstallations).where(eq(vcsInstallations.installationId, '77'));
    expect(paused!.checksPausedUntil!.getTime()).toBeGreaterThan(Date.now() + 60_000);
    const [held] = await w.app.db.select().from(vcsChecks).where(eq(vcsChecks.number, 23));
    expect(held!.dueAt!.getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(held!.problem).toBeNull();
    await w.app.db.update(vcsInstallations).set({ checksPausedUntil: null });
  });

  it('stays due when its pull request changes while its check is being written', async () => {
    await deliver('pull_request', pull({ repository: 'acme/web', number: 30, title: `${ids.guest}`, head: sha('7') }));
    // The row as the sender claimed it; then a new head comes before that write settles.
    const [claimed] = await w.app.db.select().from(vcsChecks).where(eq(vcsChecks.number, 30));
    await deliver('pull_request', { ...pull({ repository: 'acme/web', number: 30, title: `${ids.guest}`, head: sha('8') }), action: 'synchronize' });
    await sendCheck(w.app, claimed!);
    expect(gh.runs.filter((r) => r.headSha === sha('7'))).toHaveLength(1);
    // What went was the old head's: it's due again, for the new one.
    const [after] = await w.app.db.select().from(vcsChecks).where(eq(vcsChecks.number, 30));
    expect(after!.dueAt).not.toBeNull();
    await sender().drain();
    expect(gh.runs.filter((r) => r.headSha === sha('8'))).toHaveLength(1);
  });

  it('stops naming an issue once it is deleted, in the words it uses for one limited since', async () => {
    const doomed = await createIssue(w.adminCtx, { project: 'WEB', summary: 'Old banner', fields: { Type: 'Task' } });
    await deliver('pull_request', pull({ repository: 'acme/web', number: 40, title: `${doomed.id} and ${ids.guest}`, head: sha('9') }));
    await sender().drain();
    const run = () => gh.runs.find((r) => r.headSha === sha('9'))!;
    expect(run().summary).toContain(`[${doomed.id}]`);
    await deleteIssue(w.adminCtx, doomed.id);
    const s = await w.app.schema.get();
    const [last] = await w.app.db.select().from(activities).orderBy(desc(activities.id)).limit(1);
    expect(last!.type).toBe('issue.deleted');
    await checksConsumer(w.app).handle(toEventDto(s, last!));
    await sender().drain();
    expect(run().summary).not.toContain(doomed.id);
    expect(run().summary).toContain('One more id it names is no issue a4a can show here: there’s none by it, or it isn’t for everyone to see.');
  });

  it('says on the integration why a check didn’t go: an installation that may not write checks', async () => {
    await deliver('pull_request', pull({ repository: 'beta/site', number: 3, title: `${ids.guest}`, head: sha('f') }));
    await sender().drain();
    expect(gh.runs.some((r) => r.repository === 'beta/site')).toBe(false);
    const [listed] = (await listIntegrations(w.adminCtx)).filter((i) => i.id === integration);
    expect(listed!.checks!.problem).toBe(
      'beta/site#3: as the GitHub App: The app may not write checks. In the app’s settings on GitHub, give it Checks: Read and write under Repository permissions, then accept the new permissions on each of its installations.',
    );
    const [row] = await w.app.db.select().from(vcsChecks).where(eq(vcsChecks.number, 3));
    expect(row!.attempts).toBe(1);
    expect(row!.dueAt!.getTime()).toBeGreaterThan(Date.now() + 30_000);
  });
});


describe('a build’s own check run', () => {
  it('reports the run’s result on its head commit, updates it on a rerun, and writes nothing for an identical report', async () => {
    const source = await createBuildSource(w.adminCtx, { kind: 'github', name: 'Build result CI', project: 'BACK', integration, branch: 'main', workflow: 'CI', reportCheck: true });
    expect(source.reportCheck).toBe(true);
    const head = sha('4');
    const run = (attempt: number, conclusion: string) => ({
      action: 'completed',
      repository: { full_name: 'acme/backend' },
      workflow_run: {
        id: 12001,
        run_attempt: attempt,
        run_number: 91,
        name: 'CI',
        path: '.github/workflows/ci.yml',
        head_branch: 'main',
        head_sha: head,
        conclusion,
        html_url: `https://github.com/acme/backend/actions/runs/12001/attempts/${attempt}`,
        updated_at: new Date(Date.now() + attempt * 1000).toISOString(),
        head_commit: { message: 'Build the release', timestamp: new Date().toISOString() },
      },
    });

    const delivered = await deliver('workflow_run', run(1, 'failure'));
    expect(delivered, JSON.stringify(delivered)).toMatchObject({ status: 200, body: { outcome: 'processed' } });
    await sender().drain();
    const queued = await w.app.db.select().from(buildChecks);
    expect(queued).toHaveLength(1);
    const made = gh.runs.find((r) => r.headSha === head && r.name === 'a4a: Build result CI');
    expect(made).toMatchObject({ repository: 'acme/backend', conclusion: 'failure', title: '91: failed', installation: 77 });
    expect(made?.summary).toContain('https://github.com/acme/backend/actions/runs/12001/attempts/1');

    expect((await deliver('workflow_run', run(2, 'success'))).status).toBe(200);
    await sender().drain();
    const all = gh.runs.filter((r) => r.headSha === head && r.name === 'a4a: Build result CI');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ conclusion: 'success', title: '91: passed' });

    const writes = gh.writes.length;
    expect((await deliver('workflow_run', run(2, 'success'))).body.outcome).toBe('ignored');
    await sender().drain();
    expect(gh.writes.length).toBe(writes);
  });
});


/** A fake of GitLab's API: it answers only to its token, recording the statuses written and the compares read. */
interface FakeGitlab {
  url: string;
  token: string;
  statuses: { project: string; sha: string; auth: string | undefined; body: Record<string, any> }[];
  compares: { project: string; from: string; to: string }[];
  answer(path: string, fn: (u: URL) => unknown): void;
  close(): Promise<void>;
}

async function fakeGitlab(token: string): Promise<FakeGitlab> {
  const statuses: FakeGitlab['statuses'] = [];
  const compares: FakeGitlab['compares'] = [];
  const routes = new Map<string, (u: URL) => unknown>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers['private-token'] !== token) return send(401, { message: '401 Unauthorized' });
      const project = decodeURIComponent(/^\/api\/v4\/projects\/([^/]+)\//.exec(u.pathname)?.[1] ?? '');
      if (/\/repository\/compare$/.test(u.pathname)) {
        compares.push({ project, from: u.searchParams.get('from') ?? '', to: u.searchParams.get('to') ?? '' });
        return send(200, (routes.get('compare') ?? (() => ({ commits: [] })))(u));
      }
      if (/\/statuses\/[^/]+$/.test(u.pathname) && req.method === 'POST') {
        statuses.push({ project, sha: u.pathname.split('/').pop() ?? '', auth: String(req.headers['private-token']), body: JSON.parse(text || '{}') });
        return send(201, { sha: u.pathname.split('/').pop(), status: 'success' });
      }
      const fn = routes.get(u.pathname);
      if (!fn) return send(404, { message: '404 Project Not Found' });
      return send(200, fn(u));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    token,
    statuses,
    compares,
    answer: (path, fn) => routes.set(path, fn),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("commit statuses on GitLab's pull requests", () => {
  let gl: FakeGitlab;
  let glId = '';
  let glSecret = '';

  /** A GitLab delivery from its webhook, the secret token it signs with in a header. */
  const deliverGitlab = async (event: string, payload: unknown) => {
    const body = JSON.stringify(payload);
    const res = await http.request(`/api/v1/vcs/hooks/${glId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gitlab-event': event, 'x-gitlab-event-uuid': randomUUID(), 'x-gitlab-token': glSecret },
      body,
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  /** A merge request as GitLab sends one: its head commit, and the base its commits lie between. */
  const mr = (o: { iid: number; title: string; head: string; base?: string; state?: string }) => ({
    object_kind: 'merge_request',
    user: { name: 'Anna Schmidt', username: 'anna-s' },
    project: { path_with_namespace: 'acme/backend' },
    object_attributes: {
      iid: o.iid,
      title: o.title,
      description: '',
      state: o.state ?? 'opened',
      action: 'open',
      url: `https://gitlab.example/acme/backend/-/merge_requests/${o.iid}`,
      source_branch: 'feature/avatars',
      target_branch: 'main',
      updated_at: new Date().toISOString(),
      last_commit: { id: o.head, message: 'Fix the avatar upload' },
      diff_refs: { base_sha: o.base ?? sha('0') },
    },
  });

  beforeAll(async () => {
    gl = await fakeGitlab('glpat-status-token');
    const r = await rest('POST', '/vcs/integrations', { provider: 'gitlab', name: 'acme/backend', projects: ['BACK', 'WEB'], baseUrl: `${gl.url}/api/v4`, accessToken: 'glpat-status-token' });
    expect(r.status).toBe(201);
    glId = r.body.id;
    glSecret = r.body.secret;
    expect(r.body).toMatchObject({ hasAccessToken: true, baseUrl: `${gl.url}/api/v4`, checks: { enabled: false } });
    // On, with its token in place: no permission to ask a provider for, as GitHub's app is asked.
    const on = await rest('PATCH', `/vcs/integrations/${glId}`, { checks: { enabled: true } });
    expect(on.body.checks).toMatchObject({ enabled: true, states: false, requireResolved: false });
  });
  afterAll(() => gl.close());

  it('is refused when the integration holds no token to write them with', async () => {
    const bare = await rest('POST', '/vcs/integrations', { provider: 'gitlab', name: 'acme/no-token' });
    const on = await rest('PATCH', `/vcs/integrations/${bare.body.id}`, { checks: { enabled: true } });
    expect([on.status, on.body.error.key]).toEqual([400, 'vcs.checks.needsToken']);
    await rest('DELETE', `/vcs/integrations/${bare.body.id}`);
  });

  it('writes one status per changed head, in the words a check run uses, ids as plain words', async () => {
    const mine = (await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Avatar upload rejects PNGs' })).id;
    const guest = (await createIssue(w.as(w.anna), { project: 'WEB', summary: 'Dark mode loses contrast' })).id;
    const head = sha('e');
    gl.answer('compare', () => ({ commits: [{ id: sha('1'), message: `Also ${guest}` }] }));
    const res = await deliverGitlab('merge_request', mr({ iid: 31, title: `Fixes ${mine}`, head }));
    expect(res.body).toMatchObject({ outcome: 'processed' });
    // GitLab shows the reply in its webhook's test page; the log keeps the words with the check in them.
    expect(res.body.message).toContain('Read: 1 link made, 0 commands applied.');
    expect((await listVcsDeliveries(w.adminCtx, glId))[0]!.message).toContain('Its check is due.');
    await sender().drain();
    expect(gl.statuses).toHaveLength(1);
    expect(gl.statuses[0]).toMatchObject({ project: 'acme/backend', sha: head, auth: 'glpat-status-token' });
    expect(gl.statuses[0]!.body).toMatchObject({ state: 'success', name: 'a4a', context: 'a4a', target_url: 'https://gitlab.example/acme/backend/-/merge_requests/31', description: `Names 2 issues: ${mine}, ${guest}` });
    // The ids its commits name, read from GitLab's compare with the token, base to head.
    expect(gl.compares).toEqual([{ project: 'acme/backend', from: sha('0'), to: head }]);
    const [row] = await w.app.db.select().from(vcsChecks).where(eq(vcsChecks.integrationId, glId));
    expect(row).toMatchObject({ checkRunId: `gitlab:${head}`, problem: null });
    expect(row!.issueIds).toHaveLength(2);

    // The rule makes it failed, in GitLab's own word; a new head gets a status of its own.
    await rest('PATCH', `/vcs/integrations/${glId}`, { checks: { enabled: true, requireResolved: true } });
    await sender().drain();
    expect(gl.statuses).toHaveLength(2);
    expect(gl.statuses[1]!.body).toMatchObject({ state: 'failed', description: `2 issues it names aren’t resolved: ${mine}, ${guest}` });
    const moved = sha('f');
    await deliverGitlab('merge_request', mr({ iid: 31, title: `Fixes ${mine}`, head: moved }));
    await sender().drain();
    expect(gl.statuses.map((s) => s.sha)).toEqual([head, head, moved]);

    // The same words again: nothing more is written.
    const writes = gl.statuses.length;
    await deliverGitlab('merge_request', mr({ iid: 31, title: `Fixes ${mine}`, head: moved }));
    await sender().drain();
    expect(gl.statuses).toHaveLength(writes);
  });
});
