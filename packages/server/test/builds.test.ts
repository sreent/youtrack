/**
 * Builds from CI (docs/architecture.md, D46): a build marks the resolved issues its commits name,
 * once, as its source; one that failed marks nothing; a forged or replayed one changes nothing.
 */
import type { IssueDetail } from '@a4a/shared';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBuildSource, issueBuilds, listBuilds, listBuildSources, rotateBuildToken } from '../src/ci/builds';
import { activities, builds } from '../src/db/schema';
import { translatorFor } from '../src/i18n';
import { createHttpApp } from '../src/http/app';
import { searchIssues } from '../src/search/service';
import { issueActivity } from '../src/services/activity';
import { createIssue, getIssue, updateIssue } from '../src/services/issues';
import { addMember } from '../src/services/members';
import { createProject } from '../src/services/projects';
import { updateUser } from '../src/services/users';
import { presentField } from '../src/tools/registry';
import { createIntegration, updateIntegration } from '../src/vcs/integrations';
import { createRule, deleteRule } from '../src/workflow/rules';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let http: ReturnType<typeof createHttpApp>;
let github: { id: string; secret: string };
let ci: { id: string; token: string; hookUrl: string };
let fake: Server;
let fakeUrl = '';
const compared: string[] = [];
/** What the fake GitHub answers for a compare: by the range asked. */
const ranges = new Map<string, { sha: string; commit: { message: string } }[]>();

const sha = () => randomUUID().replace(/-/g, '').padEnd(40, '0');
const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const fieldOf = (i: IssueDetail, name: string) => presentField(i.fields.find((f) => f.name === name)!);

async function fromGithub(event: string, payload: unknown, secret = github.secret) {
  const body = JSON.stringify(payload);
  const res = await http.request(`/api/v1/vcs/hooks/${github.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': randomUUID(), 'x-hub-signature-256': sign(secret, body) },
    body,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function postBuild(payload: unknown, token = ci.token) {
  const res = await http.request(`/api/v1/builds/hooks/${ci.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function push(commits: { id: string; message: string; at: Date }[], branch = 'main') {
  return {
    ref: `refs/heads/${branch}`,
    after: commits.at(-1)?.id ?? sha(),
    repository: { full_name: 'acme/backend' },
    pusher: { name: 'anna', email: 'anna@example.com' },
    commits: commits.map((c) => ({
      id: c.id,
      message: c.message,
      timestamp: c.at.toISOString(),
      url: `https://github.com/acme/backend/commit/${c.id}`,
      author: { name: 'Anna Schmidt', email: 'anna@example.com', username: 'anna-s' },
    })),
  };
}

function run(o: { number: number; head: string; at: Date; workflow?: string; branch?: string; conclusion?: string; action?: string; message?: string }) {
  return {
    action: o.action ?? 'completed',
    repository: { full_name: 'acme/backend' },
    workflow_run: {
      id: 9000 + o.number,
      run_attempt: 1,
      run_number: o.number,
      name: o.workflow ?? 'CI',
      path: `.github/workflows/${(o.workflow ?? 'CI').toLowerCase()}.yml`,
      head_branch: o.branch ?? 'main',
      head_sha: o.head,
      conclusion: o.conclusion ?? 'success',
      html_url: `https://github.com/acme/backend/actions/runs/${9000 + o.number}`,
      updated_at: new Date(o.at.getTime() + 60_000).toISOString(),
      head_commit: { message: o.message ?? 'Merge', timestamp: o.at.toISOString() },
    },
  };
}

async function newIssue(summary: string, resolved: boolean): Promise<IssueDetail> {
  const i = await createIssue(w.as(w.anna), { project: 'BACK', summary, fields: { Type: 'Bug' } });
  return resolved ? updateIssue(w.as(w.anna), i.id, { fields: { State: 'Fixed' } }) : i;
}

beforeAll(async () => {
  w = await createWorld();
  http = createHttpApp(w.app);
  await updateUser(w.adminCtx, 'anna', { email: 'anna@example.com' });
  await addMember(w.adminCtx, 'BACK', { user: 'anna', role: 'member' });
  fake = createServer((req, res) => {
    const m = /^\/repos\/acme\/backend\/compare\/([^/]+)$/.exec(req.url ?? '');
    if (!m || req.headers.authorization !== 'Bearer ghp_build_reader') {
      res.writeHead(m ? 401 : 404, { 'content-type': 'application/json' }).end('{"message":"Bad credentials"}');
      return;
    }
    compared.push(decodeURIComponent(m[1]!));
    const commits = ranges.get(decodeURIComponent(m[1]!)) ?? [];
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ total_commits: commits.length, commits }));
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  const made = await createIntegration(w.adminCtx, { provider: 'github', name: 'acme/backend', projects: ['BACK'] });
  github = { id: made.id, secret: made.secret };
  const source = await createBuildSource(w.adminCtx, { kind: 'generic', name: 'Jenkins: backend', project: 'BACK' });
  ci = { id: source.id, token: source.token!, hookUrl: source.hookUrl! };
});

afterAll(async () => {
  await new Promise<void>((r) => fake.close(() => r()));
  await w.close();
});

describe('a CI that posts its builds', () => {
  it('gives the project "Fixed in build" when it has no build field, and shows its token once', async () => {
    const [listed] = await listBuildSources(w.adminCtx);
    expect(listed).toMatchObject({ kind: 'generic', project: 'BACK', field: 'Fixed in build', tokenPrefix: ci.token.slice(0, 11) });
    expect(listed).not.toHaveProperty('token');
    expect(ci.hookUrl).toMatch(new RegExp(`/api/v1/builds/hooks/${ci.id}$`));
  });

  it('refuses a build without its token, and records nothing', async () => {
    expect((await postBuild({ build: '0.9.0' }, 'a4a_ci_not-the-token')).status).toBe(401);
    expect((await postBuild({ build: '0.9.0' }, '')).status).toBe(401);
    expect(await w.app.db.select().from(builds).where(eq(builds.name, '0.9.0'))).toEqual([]);
  });

  it('marks the resolved issues its commits name, once, as the source, and leaves open ones', async () => {
    const fixed = await newIssue('Session cookie lost on redirect', true);
    const open = await newIssue('Slow export', false);
    const [a, b] = [sha(), sha()];
    const t = new Date(Date.now() - 3_600_000);
    expect((await fromGithub('push', push([{ id: a, message: `Keep the cookie\n\n${fixed.id}`, at: t }, { id: b, message: `Stream it ${open.id}`, at: t }]))).status).toBe(200);

    const r = await postBuild({ build: '1.0.1', status: 'success', url: 'https://ci.acme.example/job/backend/101/', commits: [a, b] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ build: '1.0.1', outcome: 'recorded', commits: 2, marked: 1 });
    // The CI's log says counts, never which issues.
    expect(String(r.body.message)).not.toContain(fixed.id);

    expect(fieldOf(await getIssue(w.adminCtx, fixed.id), 'Fixed in build')).toBe('1.0.1');
    expect(fieldOf(await getIssue(w.adminCtx, open.id), 'Fixed in build')).toBeNull();
    const history = await issueActivity(w.adminCtx, fixed.id);
    const change = history.find((e) => e.changes.some((c) => c.field === 'Fixed in build'));
    expect(change?.actor).toMatchObject({ channel: 'ci', token: 'Jenkins: backend', login: 'builds', isBot: true });
    expect(change?.data).toMatchObject({ build: { name: '1.0.1' } });
    // Why it was left, in English for the API, and in the catalogs' words for a page in another language.
    expect(await issueBuilds(w.adminCtx, open.id)).toEqual([expect.objectContaining({ build: '1.0.1', outcome: 'open', note: 'Not resolved yet', said: { key: 'builds.note.notResolved' } })]);

    // Posted again: the same build, nothing marked twice. Once the open one is resolved, it's marked.
    expect((await postBuild({ build: '1.0.1', commits: [a, b] })).body).toMatchObject({ outcome: 'again', marked: 0 });
    await updateIssue(w.as(w.anna), open.id, { fields: { State: 'Fixed' } });
    expect((await postBuild({ build: '1.0.1', commits: [] })).body).toMatchObject({ outcome: 'again', marked: 1 });
    expect(fieldOf(await getIssue(w.adminCtx, open.id), 'Fixed in build')).toBe('1.0.1');
    const recorded = await w.app.db.select().from(activities).where(eq(activities.type, 'build.recorded'));
    expect(recorded.length).toBe(3);

    const [listed] = await listBuilds(w.as(w.anna), 'BACK');
    expect(listed).toMatchObject({ name: '1.0.1', status: 'success', marked: 2, commits: 2, source: { name: 'Jenkins: backend' } });
    expect(listed!.issues.map((i) => [i.issue.id, i.outcome]).sort()).toEqual([[fixed.id, 'marked'], [open.id, 'marked']].sort());
  });

  it('reads issue ids from the messages it sends, and leaves an issue that names a build already', async () => {
    const byMessage = await newIssue('Typo on the login page', true);
    const r = await postBuild({ build: '1.0.2', commits: [{ sha: sha(), message: `Fix the typo (${byMessage.id})` }, { message: `Also ${byMessage.id}` }] });
    expect(r.body).toMatchObject({ outcome: 'recorded', marked: 1 });
    expect(fieldOf(await getIssue(w.adminCtx, byMessage.id), 'Fixed in build')).toBe('1.0.2');
    // A later build naming it again leaves it: the fix went out in 1.0.2.
    expect((await postBuild({ build: '1.0.3', commits: [{ message: `Revert, then ${byMessage.id} again` }] })).body).toMatchObject({ marked: 0 });
    expect(fieldOf(await getIssue(w.adminCtx, byMessage.id), 'Fixed in build')).toBe('1.0.2');
    expect(await issueBuilds(w.adminCtx, byMessage.id)).toEqual([
      expect.objectContaining({ build: '1.0.3', outcome: 'already', note: 'It says 1.0.2 already', said: { key: 'builds.note.saysAlready', values: { build: '1.0.2' } } }),
      expect.objectContaining({ build: '1.0.2', outcome: 'marked' }),
    ]);
  });

  it('keeps a failed build out of the build field, and marks nothing with it', async () => {
    const fixed = await newIssue('Crash on empty search', true);
    const r = await postBuild({ build: '1.0.4', status: 'failure', commits: [{ message: fixed.id }] });
    expect(r.body).toMatchObject({ status: 'failure', marked: 0 });
    expect(fieldOf(await getIssue(w.adminCtx, fixed.id), 'Fixed in build')).toBeNull();
    expect(await issueBuilds(w.adminCtx, fixed.id)).toEqual([expect.objectContaining({ build: '1.0.4', outcome: 'refused', note: 'The build failed', said: { key: 'builds.note.failed' } })]);
    const s = await w.app.schema.get();
    const field = [...s.fields.values()].find((f) => f.name === 'Fixed in build')!;
    expect((s.valuesByField.get(field.id) ?? []).map((v) => v.name)).not.toContain('1.0.4');
    // Re-run, it passes: now it's a build.
    expect((await postBuild({ build: '1.0.4', status: 'success' })).body).toMatchObject({ status: 'success', marked: 1 });
  });

  it("keeps a guard's refusal as the problem it is, for a page to say in its language", async () => {
    const unowned = await newIssue('Search box loses focus', true);
    const guard = await createRule(w.adminCtx, { project: 'BACK', name: 'A shipped fix has an owner', kind: 'guard', query: 'has: {Fixed in build}', requires: 'has: Assignee', message: 'A shipped fix needs someone on it.' });
    try {
      expect((await postBuild({ build: '1.0.9', commits: [{ message: unowned.id }] })).body).toMatchObject({ marked: 0 });
      const [left] = await issueBuilds(w.adminCtx, unowned.id);
      expect(left).toMatchObject({ build: '1.0.9', outcome: 'refused' });
      // The API's note is the refusal's English; a page says the problem from its key, in its language.
      expect(left!.note).toContain('A shipped fix needs someone on it');
      expect(left!.said?.key).toMatch(/^problem\.workflow\./);
      expect(translatorFor('en').t(left!.said!.key, left!.said!.values)).toContain('A shipped fix needs someone on it');
    } finally {
      await deleteRule(w.adminCtx, guard.id);
    }
  });

  it('finds issues by build, and by a range of builds in the order they came', async () => {
    const one = await searchIssues(w.adminCtx, 'project: BACK Fixed in build: 1.0.1');
    expect(one.total).toBe(2);
    const range = await searchIssues(w.adminCtx, 'project: BACK Fixed in build: 1.0.2 .. 1.0.4');
    expect(range.total).toBe(2);
    const open = await searchIssues(w.adminCtx, 'project: BACK Fixed in build: 1.0.2 .. *');
    expect(open.total).toBe(2);
    const wrong = await searchIssues(w.adminCtx, 'project: BACK Fixed in build: 1.0.2 .. 7.7.7').catch((e: Error) => e);
    expect(wrong).toBeInstanceOf(Error);
  });

  it('gives a new token, and the old one stops working', async () => {
    const old = ci.token;
    const rotated = await rotateBuildToken(w.adminCtx, ci.id);
    ci.token = rotated.token!;
    expect((await postBuild({ build: '1.0.5' }, old)).status).toBe(401);
    expect((await postBuild({ build: '1.0.5' })).status).toBe(200);
  });
});

describe("GitHub's workflow runs", () => {
  let source: string;
  it('takes a finished run of its workflow on its branch as a build of the commits pushed since', async () => {
    source = (await createBuildSource(w.adminCtx, { kind: 'github', name: 'GitHub Actions: CI', project: 'BACK', integration: github.id, branch: 'main', workflow: 'CI' })).id;
    const fixed = await newIssue('Wrong total on invoices', true);
    const c = sha();
    const t = new Date(Date.now() - 600_000);
    await fromGithub('push', push([{ id: c, message: `Round once (${fixed.id})`, at: t }]));

    // Not finished, another workflow, another branch: not builds.
    expect((await fromGithub('workflow_run', run({ number: 41, head: c, at: t, action: 'in_progress' }))).body).toMatchObject({ outcome: 'ignored' });
    expect((await fromGithub('workflow_run', run({ number: 7, head: c, at: t, workflow: 'Lint' }))).body).toMatchObject({ outcome: 'ignored' });
    expect((await fromGithub('workflow_run', run({ number: 41, head: c, at: t, branch: 'feature/x' }))).body).toMatchObject({ outcome: 'ignored' });
    // Forged: refused before anything is read.
    expect((await fromGithub('workflow_run', run({ number: 41, head: c, at: t }), 'not-the-secret')).status).toBe(401);

    const r = await fromGithub('workflow_run', run({ number: 41, head: c, at: t }));
    expect(r.body).toMatchObject({ outcome: 'processed', applied: 1 });
    expect(fieldOf(await getIssue(w.adminCtx, fixed.id), 'Fixed in build')).toBe('41');
    const [b] = await w.app.db.select().from(builds).where(eq(builds.name, '41'));
    expect(b).toMatchObject({ sourceId: source, status: 'success', headSha: c, branch: 'main' });
  });

  it("asks GitHub's compare which commits a run holds, with the integration's token", async () => {
    await updateIntegration(w.adminCtx, github.id, { accessToken: 'ghp_build_reader', baseUrl: fakeUrl });
    const fixed = await newIssue('Timezone off by one in reports', true);
    const [prev] = await w.app.db.select().from(builds).where(eq(builds.name, '41'));
    const head = sha();
    // A commit a4a never saw pushed (a squash on GitHub), naming the issue in its message.
    ranges.set(`${prev!.headSha}...${head}`, [{ sha: sha(), commit: { message: `Use the person's zone\n\nFixes ${fixed.id}` } }]);
    const r = await fromGithub('workflow_run', run({ number: 42, head, at: new Date() }));
    expect(r.body).toMatchObject({ outcome: 'processed', applied: 1 });
    expect(compared).toContain(`${prev!.headSha}...${head}`);
    expect(fieldOf(await getIssue(w.adminCtx, fixed.id), 'Fixed in build')).toBe('42');
    // The token is kept sealed, never as given.
    const [row] = await w.app.db.select().from((await import('../src/db/schema')).vcsIntegrations).where(eq((await import('../src/db/schema')).vcsIntegrations.id, github.id));
    expect(row!.accessToken).not.toContain('ghp_build_reader');
  });

  it('reads a range a CI sends from GitHub, through an integration of the repository', async () => {
    const fixed = await newIssue('Avatar upload rejects PNGs', true);
    const [from, to] = [sha(), sha()];
    ranges.set(`${from}...${to}`, [{ sha: to, commit: { message: `Accept PNG (${fixed.id})` } }]);
    const r = await postBuild({ build: '1.0.6', repository: 'acme/backend', range: { from, to } });
    expect(r.body).toMatchObject({ marked: 1 });
    const unknown = await postBuild({ build: '1.0.7', repository: 'acme/elsewhere', range: { from, to } });
    expect(unknown.status).toBe(400);
  });

  it('shows a build only the issues the caller can see', async () => {
    await createProject(w.adminCtx, { key: 'SEC', name: 'Security', template: 'software', visibility: 'members' }).catch(() => undefined);
    const hidden = await createIssue(w.adminCtx, { project: 'BACK', summary: 'Token leak in logs', fields: { Type: 'Bug' }, visibleTo: { users: ['admin'], groups: [] } });
    await updateIssue(w.adminCtx, hidden.id, { fields: { State: 'Fixed' } });
    await postBuild({ build: '1.0.8', commits: [{ message: `Scrub (${hidden.id})` }] });
    const [mine] = await listBuilds(w.as(w.anna), 'BACK');
    expect(mine!.name).toBe('1.0.8');
    expect(mine!.issues).toEqual([]);
    const [theirs] = await listBuilds(w.adminCtx, 'BACK');
    expect(theirs!.issues.map((i) => i.issue.id)).toEqual([hidden.id]);
  });
});
