/**
 * Builds from Forgejo's Actions runs (docs/architecture.md, D55), through a Gitea or Forgejo
 * integration's own webhook, as GitHub's workflow runs come (D46): Forgejo 17's workflow_run_*
 * events, and 12 to 16's action_run_*. Forgejo's documentation shows no sample of either, so the
 * fixtures are its own shapes, field for field, from its source (modules/structs/action.go and
 * hook.go, services/webhook/notifier.go); the push a run carries is its push delivery's shape.
 */
import type { IssueDetail } from '@a4a/shared';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBuildSource, issueBuilds, listBuilds, rotateBuildToken } from '../src/ci/builds';
import { activities, buildIssues, builds, fieldValues, vcsDeliveries } from '../src/db/schema';
import { createHttpApp } from '../src/http/app';
import { checkProblemWords, type AppError } from '../src/lib/errors';
import { issueActivity } from '../src/services/activity';
import { createIssue, getIssue, updateIssue } from '../src/services/issues';
import { addMember } from '../src/services/members';
import { updateUser } from '../src/services/users';
import { presentField } from '../src/tools/registry';
import { createIntegration } from '../src/vcs/integrations';
import { readDelivery } from '../src/vcs/payloads';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let http: ReturnType<typeof createHttpApp>;
let forgejo: { id: string; secret: string };
let source: string;

type Json = Record<string, any>;
const fixture = (name: string): Json => JSON.parse(readFileSync(new URL(`./fixtures/vcs/${name}.json`, import.meta.url), 'utf8'));
const sha = () => randomUUID().replace(/-/g, '').padEnd(40, '0');
const fieldOf = (i: IssueDetail, name: string) => presentField(i.fields.find((f) => f.name === name)!);
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: AppError) => e);
const minutes = (n: number) => new Date(Date.UTC(2026, 10, 16, 12, 0, 0) + n * 60_000);

/** A Forgejo run as its webhook sends it: Forgejo 17's shape, or with `old`, 12 to 16's. */
function runOf(o: {
  index: number;
  head: string;
  status: string;
  at: Date;
  branch?: string;
  workflow?: string;
  pushed?: { id: string; message: string }[];
  pullRequest?: number;
  old?: boolean;
}): Json {
  const body = fixture(o.old ? 'forgejo-action-run' : 'forgejo-workflow-run');
  const run = body.run;
  const done = ['success', 'failure', 'cancelled', 'skipped'].includes(o.status);
  Object.assign(run, {
    id: 190_000 + o.index,
    index_in_repo: o.index,
    commit_sha: o.head,
    status: o.status,
    workflow_id: o.workflow ?? 'ci.yml',
    prettyref: o.pullRequest ? `#${o.pullRequest}` : (o.branch ?? 'main'),
    html_url: `https://git.acme.example/acme/infra/actions/runs/${o.index}`,
    started: new Date(o.at.getTime() - 180_000).toISOString(),
    // Forgejo 17 writes a time not yet set as null; 12 to 16, as Go's zero time.
    stopped: done ? o.at.toISOString() : o.old ? '0001-01-01T00:00:00Z' : null,
    updated: o.at.toISOString(),
  });
  if (o.pullRequest) {
    run.event = 'pull_request';
    run.event_payload = JSON.stringify({ action: 'synchronized', number: o.pullRequest, pull_request: { number: o.pullRequest, head: { ref: o.branch, sha: o.head }, base: { ref: 'main' } }, repository: { full_name: 'acme/infra' } });
  } else {
    const push = JSON.parse(run.event_payload);
    const commits = (o.pushed ?? [{ id: o.head, message: 'Tidy up\n' }]).map((c, i) => ({ ...push.commits[0], id: c.id, message: c.message, timestamp: new Date(o.at.getTime() - 600_000 + i * 1000).toISOString() }));
    Object.assign(push, { ref: `refs/heads/${o.branch ?? 'main'}`, after: o.head, commits, head_commit: { ...commits.at(-1), id: o.head } });
    run.event_payload = JSON.stringify(push);
  }
  if (o.old) body.action = o.status === 'success' ? 'success' : 'failure';
  else body.action = done ? 'run_completed' : 'run_status_changed';
  return body;
}

/** A delivery as Forgejo signs and names it (services/webhook/shared/payloader.go): every header it sends. */
async function fromForgejo(event: string, payload: unknown, opts: { secret?: string; delivery?: string } = {}) {
  const body = JSON.stringify(payload, null, 2);
  const sig = createHmac('sha256', opts.secret ?? forgejo.secret).update(body).digest('hex');
  const delivery = opts.delivery ?? randomUUID();
  const res = await http.request(`/api/v1/vcs/hooks/${forgejo.id}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forgejo-delivery': delivery,
      'x-forgejo-event': event,
      'x-forgejo-event-type': event,
      'x-forgejo-signature': sig,
      'x-gitea-delivery': delivery,
      'x-gitea-event': event,
      'x-gitea-signature': sig,
      'x-github-delivery': delivery,
      'x-github-event': event,
      'x-hub-signature-256': `sha256=${sig}`,
    },
    body,
  });
  return { status: res.status, body: (await res.json()) as Json };
}

async function newIssue(summary: string, resolved: boolean): Promise<IssueDetail> {
  const i = await createIssue(w.as(w.anna), { project: 'BACK', summary, fields: { Type: 'Bug' } });
  return resolved ? updateIssue(w.as(w.anna), i.id, { fields: { State: 'Fixed' } }) : i;
}

const buildNamed = async (name: string) => (await w.app.db.select().from(builds).where(eq(builds.name, name)))[0];
const recordedFor = async (name: string) => (await w.app.db.select().from(activities).where(eq(activities.type, 'build.recorded'))).filter((a) => (a.payload as Json).data?.build === name);

beforeAll(async () => {
  w = await createWorld();
  http = createHttpApp(w.app);
  await updateUser(w.adminCtx, 'anna', { email: 'anna@example.com' });
  await addMember(w.adminCtx, 'BACK', { user: 'anna', role: 'member' });
  const made = await createIntegration(w.adminCtx, { provider: 'gitea', name: 'acme/infra', projects: ['BACK'] });
  forgejo = { id: made.id, secret: made.secret };
  source = (await createBuildSource(w.adminCtx, { kind: 'gitea', name: 'Forgejo Actions: CI', project: 'BACK', integration: forgejo.id, branch: 'main', workflow: 'ci.yml' })).id;
});

afterAll(async () => {
  await w.close();
});

describe('a build source of Forgejo or Gitea runs', () => {
  it('takes a Gitea or Forgejo integration, and no other', async () => {
    const github = await createIntegration(w.adminCtx, { provider: 'github', name: 'acme/site', projects: ['BACK'] });
    const wrong = await refusal(createBuildSource(w.adminCtx, { kind: 'gitea', name: 'x', project: 'BACK', integration: github.id }));
    expect(wrong).toMatchObject({ status: 400, words: { key: 'ci.notGitea', values: { integration: 'acme/site' } } });
    expect(await refusal(createBuildSource(w.adminCtx, { kind: 'gitea', name: 'x', project: 'BACK' }))).toMatchObject({ words: { key: 'ci.giteaIntegrationNeeded' } });
    expect(await refusal(createBuildSource(w.adminCtx, { kind: 'github', name: 'x', project: 'BACK', integration: forgejo.id }))).toMatchObject({ words: { key: 'ci.notGithub' } });
    // Its runs come signed by the integration: there's no token of its own to give.
    expect(await refusal(rotateBuildToken(w.adminCtx, source))).toMatchObject({ words: { key: 'ci.signedByGiteaIntegration' } });
    // Only an administrator says where builds come from.
    expect(await refusal(createBuildSource(w.as(w.anna), { kind: 'gitea', name: 'x', project: 'BACK', integration: forgejo.id }))).toMatchObject({ status: 403 });
    // Each says in en.json what the API says, word for word, for a page to say in its language.
    for (const e of [wrong, await refusal(createBuildSource(w.adminCtx, { kind: 'gitea', name: 'x', project: 'BACK' })), await refusal(rotateBuildToken(w.adminCtx, source))]) {
      expect(() => checkProblemWords(e!.message, e!.hint, e!.words!)).not.toThrow();
    }
  });
});

describe("Forgejo's Actions runs", () => {
  let fixed: IssueDetail;
  let open: IssueDetail;
  const head = sha();

  it('take a finished run as a build of the commits its push brought, with no token', async () => {
    fixed = await newIssue('Invoice total rounds twice', true);
    open = await newIssue('Export is slow', false);
    const pushed = [
      { id: sha(), message: `Round once\n\nFixes ${fixed.id}\n` },
      { id: head, message: `Stream the export (${open.id})\n` },
    ];
    // Waiting, then running: not builds yet.
    expect((await fromForgejo('workflow_run_waiting', runOf({ index: 57, head, status: 'waiting', at: minutes(0), pushed }))).body).toMatchObject({ outcome: 'ignored' });
    expect((await fromForgejo('workflow_run_running', runOf({ index: 57, head, status: 'running', at: minutes(1), pushed }))).body).toMatchObject({ outcome: 'ignored' });
    expect(await buildNamed('57')).toBeUndefined();

    // a4a never saw the push: the run carries it, and its messages name the issues.
    const r = await fromForgejo('workflow_run_success', runOf({ index: 57, head, status: 'success', at: minutes(4), pushed }));
    expect(r).toMatchObject({ status: 200, body: { outcome: 'processed', applied: 1 } });
    // What Forgejo shows the repository's administrators names no issue.
    expect(JSON.stringify(r.body)).not.toContain(fixed.id);
    expect(fieldOf(await getIssue(w.adminCtx, fixed.id), 'Fixed in build')).toBe('57');
    expect(fieldOf(await getIssue(w.adminCtx, open.id), 'Fixed in build')).toBeNull();
    expect(await buildNamed('57')).toMatchObject({
      sourceId: source,
      status: 'success',
      url: 'https://git.acme.example/acme/infra/actions/runs/57',
      repository: 'acme/infra',
      branch: 'main',
      headSha: head,
      finishedAt: minutes(4),
      marked: 1,
    });
    const change = (await issueActivity(w.adminCtx, fixed.id)).find((e) => e.changes.some((c) => c.field === 'Fixed in build'));
    expect(change?.actor).toMatchObject({ channel: 'ci', token: 'Forgejo Actions: CI', isBot: true });
    expect(await issueBuilds(w.adminCtx, open.id)).toEqual([expect.objectContaining({ build: '57', outcome: 'open', said: { key: 'builds.note.notResolved' } })]);
    const [listed] = await listBuilds(w.as(w.anna), 'BACK');
    expect(listed).toMatchObject({ name: '57', status: 'success', source: { name: 'Forgejo Actions: CI', kind: 'gitea' } });
  });

  it('make one build of the same delivery twice, and of the old event beside the new one', async () => {
    const delivery = randomUUID();
    const body = runOf({ index: 57, head, status: 'success', at: minutes(4) });
    expect((await fromForgejo('workflow_run_success', body, { delivery })).body).toMatchObject({ outcome: 'ignored' });
    expect((await fromForgejo('workflow_run_success', body, { delivery })).body).toMatchObject({ outcome: 'duplicate' });
    // Forgejo 17 still sends action_run_success too, under a delivery of its own; and 12 to 16 a recover.
    const old = runOf({ index: 57, head, status: 'success', at: minutes(4), old: true });
    expect((await fromForgejo('action_run_success', old)).body).toMatchObject({ outcome: 'ignored', message: 'Read: that build was recorded already.' });
    expect((await fromForgejo('action_run_recover', { ...old, action: 'recover' })).body).toMatchObject({ outcome: 'ignored' });
    expect((await w.app.db.select().from(builds).where(eq(builds.name, '57'))).length).toBe(1);
    expect((await w.app.db.select().from(fieldValues).where(eq(fieldValues.name, '57'))).length).toBe(1);
    expect((await recordedFor('57')).length).toBe(1);
    const [log] = await w.app.db.select().from(vcsDeliveries).where(and(eq(vcsDeliveries.integrationId, forgejo.id), eq(vcsDeliveries.event, 'action_run_success')));
    expect(log?.message).toContain('recorded already');
  });

  it('never step a build back for a state that comes late', async () => {
    // A running state delivered after the run finished, and a failure older than the success.
    expect((await fromForgejo('workflow_run_running', runOf({ index: 57, head, status: 'running', at: minutes(2) }))).body).toMatchObject({ outcome: 'ignored' });
    await fromForgejo('workflow_run_failure', runOf({ index: 57, head, status: 'failure', at: minutes(3) }));
    expect(await buildNamed('57')).toMatchObject({ status: 'success', finishedAt: minutes(4), marked: 1 });
    expect(fieldOf(await getIssue(w.adminCtx, fixed.id), 'Fixed in build')).toBe('57');
  });

  it('mark an issue resolved since, when the same run is told again', async () => {
    // As D46 has a later report of a build do: the issue it left open is looked at again.
    await updateIssue(w.as(w.anna), open.id, { fields: { State: 'Fixed' } });
    const again = await fromForgejo('workflow_run_success', runOf({ index: 57, head, status: 'success', at: minutes(4) }));
    expect(again.body).toMatchObject({ outcome: 'processed', applied: 1 });
    expect(fieldOf(await getIssue(w.adminCtx, open.id), 'Fixed in build')).toBe('57');
    expect(await buildNamed('57')).toMatchObject({ status: 'success', marked: 2 });
    expect((await recordedFor('57')).length).toBe(2);
  });

  it('mark nothing with a failed run; run again, passing, it marks what it held', async () => {
    const shipped = await newIssue('Search loses focus', true);
    const c = sha();
    const pushed = [{ id: c, message: `Keep focus (${shipped.id})\n` }];
    expect((await fromForgejo('workflow_run_failure', runOf({ index: 58, head: c, status: 'failure', at: minutes(10), pushed }))).body).toMatchObject({ outcome: 'processed', applied: 0 });
    expect(await buildNamed('58')).toMatchObject({ status: 'failure', valueId: null });
    expect(await issueBuilds(w.adminCtx, shipped.id)).toEqual([expect.objectContaining({ build: '58', outcome: 'refused', note: 'The build failed', said: { key: 'builds.note.failed' } })]);
    expect((await w.app.db.select().from(fieldValues).where(eq(fieldValues.name, '58'))).length).toBe(0);
    // Re-run: the same run, a new attempt, waiting and then passing.
    expect((await fromForgejo('workflow_run_waiting', runOf({ index: 58, head: c, status: 'waiting', at: minutes(20), pushed }))).body).toMatchObject({ outcome: 'ignored' });
    expect(await buildNamed('58')).toMatchObject({ status: 'failure' });
    expect((await fromForgejo('workflow_run_success', runOf({ index: 58, head: c, status: 'success', at: minutes(24), pushed }))).body).toMatchObject({ outcome: 'processed', applied: 1 });
    expect(fieldOf(await getIssue(w.adminCtx, shipped.id), 'Fixed in build')).toBe('58');
    // The first attempt's failure, sent again late, leaves the pass as it is.
    await fromForgejo('workflow_run_failure', runOf({ index: 58, head: c, status: 'failure', at: minutes(10), pushed }));
    expect(await buildNamed('58')).toMatchObject({ status: 'success', marked: 1 });
    expect(await issueBuilds(w.adminCtx, shipped.id)).toEqual([expect.objectContaining({ build: '58', outcome: 'marked' })]);
  });

  it("read Forgejo 12 to 16's action_run_failure, which says how the run ended", async () => {
    const left = await newIssue('Avatar upload rejects PNGs', true);
    const c = sha();
    const r = await fromForgejo('action_run_failure', runOf({ index: 59, head: c, status: 'cancelled', at: minutes(30), old: true, pushed: [{ id: c, message: `Accept PNG (${left.id})` }] }));
    expect(r.body).toMatchObject({ outcome: 'processed', applied: 0 });
    expect(await buildNamed('59')).toMatchObject({ status: 'cancelled', finishedAt: minutes(30) });
    expect(await issueBuilds(w.adminCtx, left.id)).toEqual([expect.objectContaining({ build: '59', outcome: 'refused', said: { key: 'builds.note.cancelled' } })]);
  });

  it('take no skipped run, nor one of another workflow or branch', async () => {
    expect((await fromForgejo('workflow_run_skipped', runOf({ index: 60, head: sha(), status: 'skipped', at: minutes(40) }))).body).toMatchObject({ outcome: 'ignored' });
    expect((await fromForgejo('workflow_run_success', runOf({ index: 61, head: sha(), status: 'success', at: minutes(41), workflow: 'lint.yml' }))).body).toMatchObject({ outcome: 'ignored' });
    expect((await fromForgejo('workflow_run_success', runOf({ index: 62, head: sha(), status: 'success', at: minutes(42), branch: 'feature/x' }))).body).toMatchObject({ outcome: 'ignored' });
    // A pull request's run is on its head branch, so a source of main doesn't take it either.
    expect((await fromForgejo('workflow_run_success', runOf({ index: 63, head: sha(), status: 'success', at: minutes(43), pullRequest: 7, branch: 'feature/y' }))).body).toMatchObject({ outcome: 'ignored' });
    for (const n of ['60', '61', '62', '63']) expect(await buildNamed(n)).toBeUndefined();
  });

  it('ignore an event a4a has no use for, and refuse a forged one before reading it', async () => {
    const job = { action: 'job_completed', job: { id: 1, name: 'test', status: 'success' }, run: runOf({ index: 64, head: sha(), status: 'success', at: minutes(50) }).run };
    expect((await fromForgejo('workflow_job_success', job)).body).toMatchObject({ outcome: 'ignored' });
    const forged = await fromForgejo('workflow_run_success', runOf({ index: 64, head: sha(), status: 'success', at: minutes(50) }), { secret: 'not-the-secret' });
    expect(forged.status).toBe(401);
    expect(await buildNamed('64')).toBeUndefined();
    const [refused] = await w.app.db.select().from(vcsDeliveries).where(and(eq(vcsDeliveries.integrationId, forgejo.id), eq(vcsDeliveries.outcome, 'refused')));
    expect(refused).toMatchObject({ event: 'workflow_run_success', statusCode: 401 });
  });

  it('make one build, one value and one mark of two deliveries of a run at once', async () => {
    const both = await newIssue('Timezone off by one', true);
    const c = sha();
    const pushed = [{ id: c, message: `Use the person's zone (${both.id})` }];
    const [a, b] = await Promise.all([
      fromForgejo('workflow_run_success', runOf({ index: 65, head: c, status: 'success', at: minutes(60), pushed })),
      fromForgejo('action_run_success', runOf({ index: 65, head: c, status: 'success', at: minutes(60), pushed, old: true })),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.outcome, b.body.outcome].sort()).toEqual(['ignored', 'processed']);
    expect((await w.app.db.select().from(builds).where(eq(builds.name, '65'))).length).toBe(1);
    expect((await w.app.db.select().from(fieldValues).where(eq(fieldValues.name, '65'))).length).toBe(1);
    const build = await buildNamed('65');
    expect(build).toMatchObject({ status: 'success', marked: 1 });
    expect((await w.app.db.select().from(buildIssues).where(eq(buildIssues.buildId, build!.id))).map((r) => r.outcome)).toEqual(['marked']);
    expect(fieldOf(await getIssue(w.adminCtx, both.id), 'Fixed in build')).toBe('65');
    expect((await recordedFor('65')).length).toBe(1);
  });
});

describe('what a run says, read', () => {
  it("names a pull request's run by its number, on its head branch", () => {
    const d = readDelivery('gitea', 'workflow_run_success', runOf({ index: 66, head: 'a'.repeat(40), status: 'success', at: minutes(70), pullRequest: 12, branch: 'fix/login' }));
    expect(d).toMatchObject({ kind: 'workflow_run', action: 'completed', number: 66, branch: 'fix/login', conclusion: 'success', path: 'ci.yml', pushed: [] });
  });

  it('reads a tag as no branch, and a run that carries no push by its head alone', () => {
    const body = runOf({ index: 67, head: 'b'.repeat(40), status: 'success', at: minutes(71) });
    body.run.event_payload = JSON.stringify({ ...JSON.parse(body.run.event_payload), ref: 'refs/tags/v1.4.0' });
    expect(readDelivery('gitea', 'workflow_run_success', body)).toMatchObject({ branch: null, number: 67 });
    body.run.event = 'workflow_dispatch';
    body.run.event_payload = 'not json';
    expect(readDelivery('gitea', 'workflow_run_success', body)).toMatchObject({ branch: 'main', headMessage: '', headAt: null, pushed: [] });
  });
});

describe("Gitea's workflow_run, in GitHub's shape", () => {
  it('takes a run of the workflow its file names, ref and all', async () => {
    const c = sha();
    const run = {
      action: 'completed',
      workflow: { id: 3, name: 'CI', path: '.gitea/workflows/ci.yml', state: 'active' },
      workflow_run: {
        id: 812,
        run_number: 70,
        run_attempt: 1,
        display_title: 'Sharpen the logo',
        event: 'push',
        head_branch: 'main',
        head_sha: c,
        path: 'ci.yml@refs/heads/main',
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://git.acme.example/acme/infra/actions/runs/70',
        updated_at: minutes(80).toISOString(),
      },
      repository: { full_name: 'acme/infra' },
    };
    const body = JSON.stringify(run);
    const sig = createHmac('sha256', forgejo.secret).update(body).digest('hex');
    const res = await http.request(`/api/v1/vcs/hooks/${forgejo.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gitea-event': 'workflow_run', 'x-gitea-delivery': randomUUID(), 'x-gitea-signature': sig },
      body,
    });
    expect(await res.json()).toMatchObject({ outcome: 'processed' });
    expect(await buildNamed('70')).toMatchObject({ status: 'success', headSha: c, url: 'https://git.acme.example/acme/infra/actions/runs/70' });
  });
});
