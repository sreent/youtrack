/**
 * Renaming a project's key (D52): the old key stays the project's for good, and every id it gave
 * out keeps finding its issue, wherever it was written.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../src/context';
import { projectKeyAliases, projects } from '../src/db/schema';
import { createHttpApp } from '../src/http/app';
import { AppError } from '../src/lib/errors';
import { searchIssues } from '../src/search/service';
import { eventFeed } from '../src/services/activity';
import { addComment } from '../src/services/comments';
import { createDashboard, getDashboard } from '../src/services/dashboards';
import { createIssue, findIssue, getIssue, updateIssue } from '../src/services/issues';
import { addMember } from '../src/services/members';
import { mentionsConsumer, mentionsOf } from '../src/services/mentions';
import { moveIssue } from '../src/services/move';
import { createBaseline, getSchedule } from '../src/services/planning';
import { renameProjectKey } from '../src/services/project-keys';
import { createProject, getProject } from '../src/services/projects';
import { flowReport } from '../src/services/reports';
import { createSavedSearch } from '../src/services/saved-searches';
import { linkIssues } from '../src/services/links';
import { toolByName } from '../src/tools/registry';
import { createIntegration } from '../src/vcs/integrations';
import { issueVcs } from '../src/vcs/links';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let admin: Ctx;
let anna: Ctx;
let ben: Ctx;

async function failure(call: () => Promise<unknown>): Promise<{ status: number; message: string; hint?: string; key?: string; details?: unknown }> {
  try {
    await call();
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return { status: e.status, message: e.message, hint: e.hint, key: e.words?.key, details: e.details };
  }
  throw new Error('expected it to fail');
}

const ids = async (ctx: Ctx, query: string) => (await searchIssues(ctx, query)).items.map((i) => i.id);
const lastEventId = async () => (await eventFeed(w.adminCtx, { limit: 1, order: 'desc' }))[0]?.id ?? 0;
async function runMentions(after: number) {
  const consumer = mentionsConsumer(w.app);
  for (const e of await eventFeed(w.adminCtx, { after, limit: 500 })) if (!consumer.types || consumer.types.includes(e.type)) await consumer.handle(e);
}
/** Every key held, now or before, and by whom: for checking no key is ever two projects'. */
async function holdersOf(key: string): Promise<string[]> {
  const now = await w.app.db.select({ id: projects.id }).from(projects).where(sql`upper(${projects.key}) = ${key}`);
  const before = await w.app.db.select({ id: projectKeyAliases.projectId }).from(projectKeyAliases).where(eq(projectKeyAliases.key, key));
  return [...now, ...before].map((r) => r.id);
}

beforeAll(async () => {
  w = await createWorld();
  admin = w.adminCtx;
  anna = w.as(w.anna);
  ben = w.as(w.ben);
});

afterAll(async () => {
  await w?.close();
});

describe("renaming a project's key", () => {
  it('keeps every old id finding its issue, and the old key finding the project, in queries too', async () => {
    await createProject(admin, { key: 'RNA', name: 'Renamed one', template: 'software' });
    await addMember(admin, 'RNA', { user: 'anna', role: 'manager' });
    const first = await createIssue(anna, { project: 'RNA', summary: 'Before the rename', fields: { Priority: 'Critical' } });
    const second = await createIssue(anna, { project: 'RNA', summary: 'Also before the rename' });
    await addComment(anna, second.id, `Same as ${first.id}`);
    const before = await lastEventId();
    const mentioning = await createIssue(ben, { project: 'BACK', summary: 'Mentions the old id', description: `See ${first.id}.` });
    await runMentions(before);
    const saved = await createSavedSearch(ben, { name: 'Renamed criticals', query: 'project: RNA Priority: Critical', shared: true });
    const board = await createDashboard(admin, { name: 'Renamed things', shared: true, widgets: [{ id: 'flow', kind: 'report', title: 'Flow', params: { report: 'flow', project: 'RNA' } } as never] });

    const renamed = await renameProjectKey(anna, 'RNA', { key: 'rnb' });
    expect(renamed).toMatchObject({ key: 'RNB', formerKeys: ['RNA'], issueCount: 2 });
    expect(first.id).toBe('RNA-1');
    // Its issues keep their numbers, and the old ids find them, in services and the query language.
    expect((await getIssue(ben, 'RNA-1')).id).toBe('RNB-1');
    expect((await getIssue(ben, 'rna-2')).id).toBe('RNB-2');
    expect((await findIssue(w.app.db, await w.app.schema.get(), 'RNA-1'))?.id).toBe(first.uid);
    expect((await getProject(ben, 'RNA')).key).toBe('RNB');
    expect(await ids(ben, 'project: RNA sort by: created asc')).toEqual(['RNB-1', 'RNB-2']);
    expect(await ids(ben, 'issue id: RNA-2')).toEqual(['RNB-2']);
    expect(await ids(ben, 'RNA-1')).toContain('RNB-1');
    expect(await ids(ben, saved.query)).toEqual(['RNB-1']);
    expect(await ids(ben, 'project: RNB Priority: Critical')).toEqual(['RNB-1']);
    // A shared dashboard's widget named it by its old key: still shown to someone who sees the project.
    expect((await getDashboard(ben, board.id)).widgets).toHaveLength(1);
    // Mentions follow it: what named RNA-1 names RNB-1, and RNA-1 written later counts as RNB-1.
    expect((await mentionsOf(ben, 'RNB-1')).issues.map((i) => i.id)).toEqual([mentioning.id]);
    const since = await lastEventId();
    const later = await createIssue(ben, { project: 'WEB', summary: 'Names the old id later', description: 'Like RNA-1' });
    await runMentions(since);
    expect((await mentionsOf(ben, 'RNB-1')).issues.map((i) => i.id).sort()).toEqual([mentioning.id, later.id].sort());
    // New issues take the new key; the old one is never given to another issue.
    expect((await createIssue(anna, { project: 'RNA', summary: 'Filed by the old key' })).id).toBe('RNB-3');
    // History is left as it was written, and its ids find the issues.
    const feed = await eventFeed(admin, { after: before - 1, limit: 500 });
    expect(feed.find((e) => e.type === 'issue.created' && e.issue?.summary === 'Mentions the old id')?.issue?.id).toBe(mentioning.id);
    const event = feed.find((e) => e.type === 'project.key.changed');
    expect(event).toMatchObject({ project: 'RNB', data: { from: 'RNA', to: 'RNB' }, actor: { login: 'anna' } });
    // Events keep the ids they were written with; the project reads as it is now.
    const all = await eventFeed(admin, { limit: 500 });
    expect(all.filter((e) => e.type === 'issue.created' && e.project === 'RNB').map((e) => e.issue?.id).sort()).toEqual(['RNA-1', 'RNA-2', 'RNB-3']);
  });

  it("checks the new key as a new project's is, and keeps every key a project had for it", async () => {
    await createProject(admin, { key: 'KCA', name: 'Key checks', template: 'blank' });
    for (const bad of ['K', '1KC', 'K-C', 'KEYSTOOLONG1']) {
      expect(await failure(() => renameProjectKey(admin, 'KCA', { key: bad }))).toMatchObject({ status: 400, key: 'projectKeys.badKey' });
    }
    // Another project's key, now or before, is taken, in the same words.
    const taken = await failure(() => renameProjectKey(admin, 'KCA', { key: 'web' }));
    expect(taken).toMatchObject({ status: 409, key: 'projectKeys.taken', message: 'The key WEB is taken' });
    await createProject(admin, { key: 'KCB', name: 'Key checks too', template: 'blank' });
    await renameProjectKey(admin, 'KCB', { key: 'KCC' });
    expect(await failure(() => renameProjectKey(admin, 'KCA', { key: 'KCB' }))).toEqual({ ...taken, message: 'The key KCB is taken', details: undefined });
    // A new project can't take a key a project had either.
    expect(await failure(() => createProject(admin, { key: 'KCB', name: 'Squatter', template: 'blank' }))).toMatchObject({ status: 400, key: 'projects.keyTaken' });
    // Its own key: nothing changes, nothing is recorded.
    const events = await lastEventId();
    expect((await renameProjectKey(admin, 'KCA', { key: 'kca' })).formerKeys).toEqual([]);
    expect(await lastEventId()).toBe(events);
  });

  it('renames back to a key it had, which is then its key and not an alias', async () => {
    await createProject(admin, { key: 'BKA', name: 'Back and forth', template: 'software' });
    const issue = await createIssue(admin, { project: 'BKA', summary: 'Goes by three ids' });
    await renameProjectKey(admin, 'BKA', { key: 'BKB' });
    await renameProjectKey(admin, 'BKB', { key: 'BKC' });
    const back = await renameProjectKey(admin, 'BKC', { key: 'BKA' });
    expect(back).toMatchObject({ key: 'BKA', formerKeys: ['BKB', 'BKC'] });
    for (const id of ['BKA-1', 'BKB-1', 'BKC-1']) expect((await getIssue(admin, id)).id).toBe(issue.id);
    expect(await holdersOf('BKA')).toEqual([back.id]);
    // Addressed by a key it had, it's the same project.
    expect((await renameProjectKey(admin, 'BKB', { key: 'BKD' })).formerKeys).toEqual(['BKB', 'BKC', 'BKA']);
  });

  it('is for its managers; anyone else is refused, and a hidden project answers as a missing one', async () => {
    await createProject(admin, { key: 'MGA', name: 'Managed', template: 'blank' });
    await addMember(admin, 'MGA', { user: 'ben', role: 'member' });
    const refused = await failure(() => renameProjectKey(ben, 'MGA', { key: 'MGB' }));
    expect(refused.status).toBe(403);
    await createProject(admin, { key: 'HDA', name: 'Hidden', template: 'blank', visibility: 'members' });
    await renameProjectKey(admin, 'HDA', { key: 'HDB' });
    // Neither its key now nor the one it had says it exists, to someone who can't see it.
    const missing = await failure(() => renameProjectKey(ben, 'NOSUCH', { key: 'HDC' }));
    expect(await failure(() => renameProjectKey(ben, 'HDA', { key: 'HDC' }))).toEqual({ ...missing, message: 'Project HDA not found' });
    expect(await failure(() => getProject(ben, 'HDA'))).toMatchObject({ status: 404 });
    // The query language calls it an unknown word, by either key, as it does a misspelt one.
    for (const k of ['HDA', 'HDB']) expect(await failure(() => searchIssues(ben, `project: ${k}`))).toMatchObject({ status: 400, message: expect.stringContaining(`Unknown project "${k}"`) });
    expect(await ids(admin, 'project: HDA')).toEqual([]);
    expect((await getProject(admin, 'MGA')).key).toBe('MGA');
  });

  it('links a commit that names the old id, and a branch named after it', async () => {
    await createProject(admin, { key: 'VCA', name: 'Version control', template: 'software' });
    const issue = await createIssue(admin, { project: 'VCA', summary: 'Named in a commit' });
    const github = await createIntegration(admin, { provider: 'github', name: 'acme/rekey', projects: ['VCA'] });
    await renameProjectKey(admin, 'VCA', { key: 'VCB' });
    const http = createHttpApp(w.app);
    const sha = 'b1c2d3e4f5a60718293a4b5c6d7e8f9012345678';
    const body = JSON.stringify({
      ref: 'refs/heads/VCA-1-fix-the-login',
      before: '0000000000000000000000000000000000000000',
      after: sha,
      repository: { full_name: 'acme/rekey', html_url: 'https://github.com/acme/rekey' },
      pusher: { name: 'anna' },
      commits: [{ id: sha, message: 'Fix the login\n\nVCA-1', timestamp: '2026-11-16T09:10:02+01:00', url: `https://github.com/acme/rekey/commit/${sha}`, author: { name: 'Anna', email: 'nobody@example.com', username: 'anna' } }],
      head_commit: null,
    });
    const res = await http.request(`/api/v1/vcs/hooks/${github.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': `sha256=${createHmac('sha256', github.secret).update(body).digest('hex')}`, 'user-agent': 'GitHub-Hookshot/2f8e7a1' },
      body,
    });
    expect(res.status).toBe(200);
    const vcs = await issueVcs(admin, 'VCB-1');
    expect(vcs.commits.map((c) => c.sha)).toEqual([sha]);
    expect(issue.id).toBe('VCA-1');
  });

  it('serialises two renames at once: the second, which named the key it saw, is told it changed', async () => {
    await createProject(admin, { key: 'TWA', name: 'Two at once', template: 'blank' });
    const results = await Promise.allSettled([renameProjectKey(admin, 'TWA', { key: 'TWB', expectedKey: 'TWA' }), renameProjectKey(admin, 'TWA', { key: 'TWC', expectedKey: 'TWA' })]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toMatchObject({ status: 409, words: { key: 'projectKeys.renamedMeanwhile' } });
    const now = (won[0] as PromiseFulfilledResult<{ key: string }>).value.key;
    expect((lost[0]!.reason as AppError).details).toEqual({ currentKey: now });
    expect((await getProject(admin, 'TWA')).formerKeys).toEqual(['TWA']);
    // Without the key it saw, the second renames from where the first left it.
    await createProject(admin, { key: 'TWD', name: 'Two again', template: 'blank' });
    await Promise.all([renameProjectKey(admin, 'TWD', { key: 'TWE' }), renameProjectKey(admin, 'TWD', { key: 'TWF' })]);
    const p = await getProject(admin, 'TWD');
    expect([...p.formerKeys, p.key].sort()).toEqual(['TWD', 'TWE', 'TWF']);
  });

  it('gives a key to one project only, when a rename and a new project race for it', async () => {
    for (let round = 0; round < 3; round++) {
      const from = `RCA${round}`;
      const to = `RCB${round}`;
      const p = await createProject(admin, { key: from, name: `Race ${round}`, template: 'blank' });
      const results = await Promise.allSettled([renameProjectKey(admin, from, { key: to }), createProject(admin, { key: to, name: `Rival ${round}`, template: 'blank' })]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const reason = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!.reason as AppError;
      expect(['projectKeys.taken', 'projects.keyTaken']).toContain(reason.words?.key);
      expect(await holdersOf(to)).toHaveLength(1);
      // And the key it leaves stays its own, however close a new project comes.
      const again = await Promise.allSettled([renameProjectKey(admin, p.id === (await getProject(admin, from)).id ? from : to, { key: `RCC${round}` }), createProject(admin, { key: from, name: `Late ${round}`, template: 'blank' })]);
      expect(again[1]).toMatchObject({ status: 'rejected', reason: { words: { key: 'projects.keyTaken' } } });
      expect(await holdersOf(from)).toEqual([p.id]);
    }
  });

  it('numbers issues made during a rename under the key the project has when each takes its number', async () => {
    await createProject(admin, { key: 'NWA', name: 'New during', template: 'software' });
    await createIssue(admin, { project: 'NWA', summary: 'Before' });
    const before = await lastEventId();
    const made = await Promise.all([
      renameProjectKey(admin, 'NWA', { key: 'NWB' }),
      ...[1, 2, 3, 4, 5].map((n) => createIssue(anna, { project: 'NWA', summary: `During ${n}` })),
    ]);
    const issues = made.slice(1) as Awaited<ReturnType<typeof createIssue>>[];
    const numbers = issues.map((i) => Number(i.id.split('-')[1])).sort((a, b) => a - b);
    expect(numbers).toEqual([2, 3, 4, 5, 6]);
    for (const n of numbers) {
      expect((await getIssue(admin, `NWA-${n}`)).id).toBe(`NWB-${n}`);
      expect((await getIssue(admin, `NWB-${n}`)).id).toBe(`NWB-${n}`);
    }
    const feed = await eventFeed(admin, { after: before, limit: 100 });
    const renamedAt = feed.find((e) => e.type === 'project.key.changed')!.id;
    for (const e of feed.filter((x) => x.type === 'issue.created')) {
      // An issue numbered after the rename is named by the new key in its own event.
      expect(e.issue!.id).toMatch(e.id > renamedAt ? /^NWB-\d+$/ : /^NW[AB]-\d+$/);
    }
  });

  it('reads history across the rename as one issue each, in reports and the plan', async () => {
    await createProject(admin, { key: 'HSA', name: 'History', template: 'waterfall' });
    const a = await createIssue(admin, { project: 'HSA', summary: 'Changes before and after', fields: { Estimation: '2d', 'Start date': '2026-11-02' } });
    await createIssue(admin, { project: 'HSA', summary: 'Untouched' });
    await updateIssue(admin, a.id, { fields: { State: 'In Progress' } });
    const baseline = await createBaseline(admin, 'HSA', { name: 'Before the rename' });
    await renameProjectKey(admin, 'HSA', { key: 'HSB' });
    await updateIssue(admin, 'HSB-1', { fields: { State: 'Fixed' } });
    const flow = await flowReport(admin, { project: 'HSB' });
    expect(flow.scope.issues).toBe(2);
    expect(flow.days[flow.days.length - 1]!.total).toBe(2);
    const schedule = await getSchedule(admin, 'HSB', { baseline: baseline.id });
    expect(schedule.tasks.find((t) => t.id === 'HSB-1')?.baseline).not.toBeNull();
  });

  it('keeps a link to a renamed project in the feed of someone who sees both ends', async () => {
    await createProject(admin, { key: 'LKA', name: 'Linked, members only', template: 'software', visibility: 'members' });
    await addMember(admin, 'LKA', { user: 'ben', role: 'member' });
    const here = await createIssue(ben, { project: 'LKA', summary: 'Depends on the other' });
    await createProject(admin, { key: 'LKB', name: 'Other end, members only', template: 'software', visibility: 'members' });
    await addMember(admin, 'LKB', { user: 'ben', role: 'member' });
    const there = await createIssue(ben, { project: 'LKB', summary: 'The other end' });
    await linkIssues(ben, here.id, 'relates to', there.id);
    await renameProjectKey(admin, 'LKB', { key: 'LKC' });
    const feed = await eventFeed(ben, { issue: here.id });
    expect(feed.filter((e) => e.type === 'link.created')).toHaveLength(1);
  });

  it('over HTTP and MCP, with the same checks', async () => {
    await createProject(admin, { key: 'APA', name: 'Over the API', template: 'software' });
    await createIssue(admin, { project: 'APA', summary: 'Asked for by its old id' });
    const http = createHttpApp(w.app);
    const token = (await import('../src/services/auth')).createToken;
    const made = await token(admin, { name: 'rekey', scopes: ['read', 'write', 'admin'] });
    const call = (path: string, init: RequestInit = {}) =>
      http.request(`/api/v1${path}`, { ...init, headers: { authorization: `Bearer ${made.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
    const res = await call('/projects/APA/key', { method: 'POST', body: JSON.stringify({ key: 'APB', expectedKey: 'APA' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ key: 'APB', formerKeys: ['APA'] });
    expect(await (await call('/issues/APA-1')).json()).toMatchObject({ id: 'APB-1' });
    const stale = await call('/projects/APA/key', { method: 'POST', body: JSON.stringify({ key: 'APC', expectedKey: 'APA' }) });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { key: 'projectKeys.renamedMeanwhile', details: { currentKey: 'APB' } } });
    const bad = await call('/projects/APB/key', { method: 'POST', body: JSON.stringify({ key: 'A' }) });
    expect(bad.status).toBe(400);

    const tool = toolByName('rename_project_key')!;
    expect(tool.kind).toBe('changes');
    const input = tool.input.parse({ project: 'APA', key: 'APD' }) as never;
    expect(await tool.preview!(admin, input)).toContain('Rename APB (Over the API) to APD');
    const out = await tool.run(admin, input);
    expect(out.data).toMatchObject({ key: 'APD', former_keys: ['APA', 'APB'] });
    expect((await failure(() => tool.run(ben, tool.input.parse({ project: 'APD', key: 'APE' }) as never))).status).toBe(403);
  });

  it('carries the old ids of issues that moved before, under the key their project had', async () => {
    await createProject(admin, { key: 'MVA', name: 'Moved from', template: 'software' });
    const issue = await createIssue(admin, { project: 'MVA', summary: 'Moves away, then its old project is renamed' });
    const moved = await moveIssue(admin, issue.id, { project: 'WEB' });
    await renameProjectKey(admin, 'MVA', { key: 'MVB' });
    expect((await getIssue(admin, 'MVA-1')).id).toBe(moved.to);
    expect((await getIssue(admin, 'MVB-1')).id).toBe(moved.to);
  });
});
