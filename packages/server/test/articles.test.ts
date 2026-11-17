import { findRefs, parseArticleId } from '@a4a/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCommand } from '../src/commands/parser';
import { createHttpApp } from '../src/http/app';
import { diffLines } from '../src/lib/diff';
import { prepareQuery, searchIssues } from '../src/search/service';
import { eventFeed } from '../src/services/activity';
import {
  articlesMentioningIssue,
  articleTree,
  createArticle,
  deleteArticle,
  getArticle,
  getArticleVersion,
  listArticleVersions,
  restoreArticleVersion,
  searchArticles,
  updateArticle,
} from '../src/services/articles';
import { issueTokenFor } from '../src/services/auth';
import { addComment, deleteComment } from '../src/services/comments';
import { parseReadableId } from '../src/services/issue-refs';
import { createIssue, updateIssue } from '../src/services/issues';
import { addMember, removeMember } from '../src/services/members';
import { mentionsConsumer } from '../src/services/mentions';
import { updateProject } from '../src/services/projects';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
const as = (u: 'anna' | 'ben' | 'viewer' | 'admin') => w.as(w[u]);

/** Make a project members only, with these people in it, while `run` runs; then open it again. */
async function membersOnly(key: string, people: string[], run: () => Promise<void>) {
  await updateProject(w.adminCtx, key, { visibility: 'members' });
  for (const login of people) await addMember(w.adminCtx, key, { user: login, role: 'member' });
  try {
    await run();
  } finally {
    for (const login of people) await removeMember(w.adminCtx, key, login);
    await updateProject(w.adminCtx, key, { visibility: 'open' });
  }
}

beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w?.close();
});

/** What the outbox worker would hand the mentions consumer, for the events since `after`. */
async function runMentions(after: number) {
  const consumer = mentionsConsumer(w.app);
  const events = await eventFeed(w.adminCtx, { after, limit: 500 });
  for (const e of events) if (!consumer.types || consumer.types.includes(e.type)) await consumer.handle(e);
}
async function lastEventId() {
  return (await eventFeed(w.adminCtx, { limit: 1, order: 'desc' }))[0]?.id ?? 0;
}

describe('ids', () => {
  it('reads article ids and issue ids apart, outside code', () => {
    const refs = findRefs('See BACK-12 and BACK-A-3, WEB-A-10; not `BACK-9`, not\n```\nBACK-A-4\n```\nnor BACK-A-x or back-a-5.');
    expect(refs.map((r) => [r.kind, r.id])).toEqual([
      ['issue', 'BACK-12'],
      ['article', 'BACK-A-3'],
      ['article', 'WEB-A-10'],
    ]);
    expect(parseArticleId('back-a-3')).toEqual({ key: 'BACK', number: 3 });
    expect(parseArticleId('BACK-12')).toBeNull();
    expect(parseReadableId('BACK-A-3')).toBeNull();
    // "A" can't be a project key (keys have two characters at least), so no issue hides inside.
    expect(findRefs('BACK-A-3').map((r) => r.id)).toEqual(['BACK-A-3']);
    // An id in an address is part of the address.
    expect(findRefs('https://ci.example.com/BACK-12/log?issue=BACK-13 and #BACK-14, or BACK-15.').map((r) => r.id)).toEqual(['BACK-15']);
  });

  it("are no issue ids to the query and command languages", async () => {
    const s = await w.app.schema.get();
    const issueId = parseCommand('subtask of BACK-A-3', s, [s.projectsByKey.get('BACK')!.id]);
    expect(issueId.problems.length).toBeGreaterThan(0);
    const term = await prepareQuery(w.adminCtx, 'issue id: BACK-A-3');
    expect(term.compiled.problems[0]?.message).toContain('is not an issue id');
    // As free text it's a search, not an error.
    await expect(searchIssues(w.adminCtx, 'BACK-A-3')).resolves.toMatchObject({ total: 0 });
  });
});

describe('articles and their versions', () => {
  it('numbers articles per project, keeps a version per save, and diffs them', async () => {
    const first = await createArticle(as('anna'), { project: 'BACK', title: 'Deploying the API', body: 'Run make deploy.\nWatch the logs.' });
    expect(first).toMatchObject({ id: 'BACK-A-1', version: 1, parent: null, position: 0, createdBy: { login: 'anna' } });
    const web = await createArticle(as('ben'), { project: 'WEB', title: 'Release checklist' });
    expect(web.id).toBe('WEB-A-1');

    const v2 = await updateArticle(as('ben'), 'BACK-A-1', { body: 'Run make deploy.\nWatch the logs for five minutes.\nRoll back with make rollback.', expectedVersion: 1 });
    expect(v2.version).toBe(2);
    expect(v2.updatedBy?.login).toBe('ben');
    const v3 = await updateArticle(as('anna'), 'back-a-1', { title: 'Deploying the public API' });
    expect(v3.version).toBe(3);
    // Nothing new, no new version.
    expect((await updateArticle(as('anna'), 'BACK-A-1', { title: 'Deploying the public API', body: v3.body })).version).toBe(3);

    const versions = await listArticleVersions(as('viewer'), 'BACK-A-1');
    expect(versions.map((v) => [v.version, v.author?.login, v.title])).toEqual([
      [3, 'anna', 'Deploying the public API'],
      [2, 'ben', 'Deploying the API'],
      [1, 'anna', 'Deploying the API'],
    ]);
    const two = await getArticleVersion(as('viewer'), 'BACK-A-1', 2);
    expect(two.against).toBe(1);
    expect(two.diff).toEqual([
      { op: 'same', text: 'Run make deploy.' },
      { op: 'del', text: 'Watch the logs.' },
      { op: 'add', text: 'Watch the logs for five minutes.' },
      { op: 'add', text: 'Roll back with make rollback.' },
    ]);
    const one = await getArticleVersion(as('viewer'), 'BACK-A-1', 1);
    expect(one.against).toBeNull();
    expect(one.diff.every((l) => l.op === 'add')).toBe(true);
    await expect(getArticleVersion(as('viewer'), 'BACK-A-1', 9)).rejects.toMatchObject({ status: 404 });

    const restored = await restoreArticleVersion(as('anna'), 'BACK-A-1', 1);
    expect(restored).toMatchObject({ version: 4, title: 'Deploying the API', body: 'Run make deploy.\nWatch the logs.' });
    const events = (await eventFeed(w.adminCtx, { project: 'BACK', types: ['article.created', 'article.updated'], order: 'asc', limit: 50 })).filter(
      (e) => (e.data.article as { id: string }).id === 'BACK-A-1',
    );
    expect(events.map((e) => e.type)).toEqual(['article.created', 'article.updated', 'article.updated', 'article.updated']);
    expect(events[1]!.changes).toEqual([{ field: 'Content', from: null, to: '2 lines added, 1 removed' }]);
  });

  it('refuses a stale save with the version it now has', async () => {
    const a = await createArticle(as('anna'), { project: 'BACK', title: 'On-call' });
    await updateArticle(as('ben'), a.id, { body: 'Ben was here first.', expectedVersion: 1 });
    await expect(updateArticle(as('anna'), a.id, { body: 'Anna, late.', expectedVersion: 1 })).rejects.toMatchObject({ status: 409, details: { currentVersion: 2 } });
    expect((await getArticle(as('anna'), a.id)).body).toBe('Ben was here first.');
  });

  it('checks what it is given', async () => {
    await expect(createArticle(as('anna'), { project: 'NOPE', title: 'x' })).rejects.toMatchObject({ status: 404 });
    await expect(createArticle(as('anna'), { project: 'BACK', title: '   ' })).rejects.toMatchObject({ status: 400 });
    await expect(getArticle(as('anna'), 'BACK-12')).rejects.toMatchObject({ status: 404, hint: expect.stringContaining("is an issue's id") });
    await expect(createArticle(as('anna'), { project: 'BACK', title: 'x', parent: 'WEB-A-1' })).rejects.toMatchObject({ status: 400 });
  });

  it('diffs lines as a person would read them', () => {
    expect(diffLines('a\nb\nc', 'a\nc\nd')).toEqual([
      { op: 'same', text: 'a' },
      { op: 'del', text: 'b' },
      { op: 'same', text: 'c' },
      { op: 'add', text: 'd' },
    ]);
    expect(diffLines('', '')).toEqual([]);
    const long = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n');
    const edited = long.replace('line 1500', 'line fifteen hundred');
    expect(diffLines(long, edited).filter((l) => l.op !== 'same')).toEqual([
      { op: 'del', text: 'line 1500' },
      { op: 'add', text: 'line fifteen hundred' },
    ]);
  });
});

describe('the tree', () => {
  it('moves articles, keeps siblings in order, and allows no cycle', async () => {
    const guide = await createArticle(as('anna'), { project: 'WEB', title: 'Guide' });
    const setup = await createArticle(as('anna'), { project: 'WEB', title: 'Setup', parent: guide.id });
    const tools = await createArticle(as('anna'), { project: 'WEB', title: 'Tools', parent: setup.id });
    const style = await createArticle(as('anna'), { project: 'WEB', title: 'Style', parent: guide.id, position: 0 });
    let detail = await getArticle(as('anna'), tools.id);
    expect(detail.path.map((p) => p.title)).toEqual(['Guide', 'Setup']);
    expect((await getArticle(as('anna'), guide.id)).children.map((c) => c.title)).toEqual(['Style', 'Setup']);

    // Guide under Tools would put Guide under itself.
    await expect(updateArticle(as('anna'), guide.id, { parent: tools.id })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('sits under') });
    await expect(updateArticle(as('anna'), guide.id, { parent: guide.id })).rejects.toMatchObject({ status: 400 });
    await expect(updateArticle(as('anna'), tools.id, { parent: 'BACK-A-1' })).rejects.toMatchObject({ status: 400 });

    // Two moves at once that would make a loop between them: one of them is refused.
    const results = await Promise.allSettled([updateArticle(as('anna'), style.id, { parent: setup.id }), updateArticle(as('ben'), setup.id, { parent: style.id })]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const tree = await articleTree(as('anna'), 'WEB');
    const byId = new Map(tree.map((a) => [a.id, a]));
    for (const a of tree) {
      const seen = new Set<string>();
      for (let p = a.parent; p; p = byId.get(p)?.parent ?? null) {
        expect(seen.has(p)).toBe(false);
        seen.add(p);
      }
    }

    // Tools to the top, first in line; the others shift down, gap-free.
    detail = await updateArticle(as('anna'), tools.id, { parent: null, position: 0 });
    expect(detail.parent).toBeNull();
    const top = (await articleTree(as('anna'), 'WEB')).filter((a) => a.parent === null);
    expect(top.map((a) => [a.title, a.position])).toEqual([
      ['Tools', 0],
      ['Release checklist', 1],
      ['Guide', 2],
    ]);
    const moved = (await eventFeed(w.adminCtx, { project: 'WEB', types: ['article.updated'], limit: 1, order: 'desc' }))[0]!;
    expect(moved.changes).toEqual([{ field: 'Parent', from: setup.id, to: null }]);

    // Reorder among siblings.
    await updateArticle(as('anna'), guide.id, { position: 0 });
    expect((await articleTree(as('anna'), 'WEB')).filter((a) => a.parent === null).map((a) => a.title)).toEqual(['Guide', 'Tools', 'Release checklist']);
  });

  it('keeps an article with articles under it, and closes the gap a deleted one leaves', async () => {
    const shelf = await createArticle(as('anna'), { project: 'WEB', title: 'Shelf' });
    const one = await createArticle(as('anna'), { project: 'WEB', title: 'One', parent: shelf.id });
    const two = await createArticle(as('anna'), { project: 'WEB', title: 'Two', parent: shelf.id });
    await expect(deleteArticle(as('anna'), shelf.id)).rejects.toMatchObject({ status: 409, hint: expect.stringContaining('Move them') });
    await deleteArticle(as('anna'), one.id);
    expect((await getArticle(as('anna'), two.id)).position).toBe(0);
    await expect(getArticle(as('anna'), one.id)).rejects.toMatchObject({ status: 404 });
    // Numbers are never reused.
    expect((await createArticle(as('anna'), { project: 'WEB', title: 'Three', parent: shelf.id })).number).toBeGreaterThan(two.number);
  });
});

describe('search', () => {
  beforeAll(async () => {
    await createArticle(as('anna'), { project: 'BACK', title: 'Runbook: database failover', body: 'When the primary fails, promote the replica and repoint the pooler.' });
    await createArticle(as('anna'), { project: 'BACK', title: 'Coding style', body: 'We format with the defaults. Failover code lives in db/ha.' });
    await createArticle(as('ben'), { project: 'WEB', title: 'Browser support', body: 'Safari 16 and later.' });
  });

  it('finds words in titles first, then bodies, by prefix, with what matched', async () => {
    const res = await searchArticles(as('viewer'), { query: 'failov' });
    expect(res.items.map((a) => a.title)).toEqual(['Runbook: database failover', 'Coding style']);
    const style = res.items[1]!;
    expect(style.snippet.some((p) => p.match && /failover/i.test(p.text))).toBe(true);
    expect((await searchArticles(as('viewer'), { query: 'promote replica' })).items.map((a) => a.id)).toEqual([res.items[0]!.id]);
  });

  it('forgives a misspelt title, and keeps to a project when asked', async () => {
    expect((await searchArticles(as('viewer'), { query: 'Runbok' })).items[0]?.title).toBe('Runbook: database failover');
    const web = await searchArticles(as('viewer'), { query: 'safari', project: 'WEB' });
    expect(web.items.map((a) => a.project)).toEqual(['WEB']);
    expect((await searchArticles(as('viewer'), { query: 'safari', project: 'BACK' })).total).toBe(0);
    const latest = await searchArticles(as('viewer'), { project: 'BACK', limit: 2 });
    expect(latest.items).toHaveLength(2);
    expect(latest.total).toBeGreaterThan(2);
  });
});

describe('mentions', () => {
  it('links issues and articles both ways, and lets a deleted comment take its mention', async () => {
    const issue = await createIssue(as('anna'), { project: 'BACK', summary: 'Failover took 20 minutes', description: 'See the runbook.' });
    const runbook = await createArticle(as('anna'), { project: 'BACK', title: 'Failover drill', body: `Last drill: ${issue.id}. See \`BACK-999\` for nothing.` });
    expect((await articlesMentioningIssue(as('viewer'), issue.id)).map((a) => a.id)).toEqual([runbook.id]);

    const since = await lastEventId();
    await updateIssue(as('anna'), issue.id, { description: `Steps are in ${runbook.id}.` });
    const comment = await addComment(as('ben'), issue.id, `Also ${runbook.id}, and WEB-A-1.`);
    await runMentions(since);
    let detail = await getArticle(as('viewer'), runbook.id);
    expect(detail.mentionedIn.issues.map((i) => i.id)).toEqual([issue.id]);
    // The same mentions, read again, change nothing.
    await runMentions(since);
    expect((await getArticle(as('viewer'), runbook.id)).mentionedIn.issues).toHaveLength(1);

    const before = await lastEventId();
    await updateIssue(as('anna'), issue.id, { description: 'Nothing to see.' });
    await deleteComment(as('ben'), comment.id);
    // Before the consumer runs, the deleted comment no longer counts.
    detail = await getArticle(as('viewer'), runbook.id);
    expect(detail.mentionedIn.issues.map((i) => i.id)).toEqual([issue.id]);
    await runMentions(before);
    expect((await getArticle(as('viewer'), runbook.id)).mentionedIn.issues).toEqual([]);

    // Article to article, not counting itself.
    const other = await createArticle(as('anna'), { project: 'WEB', title: 'Notes', body: `Read ${runbook.id} first. I am the notes.` });
    expect((await getArticle(as('viewer'), runbook.id)).mentionedIn.articles.map((a) => a.id)).toEqual([other.id]);
    await updateArticle(as('anna'), other.id, { body: `I mention myself: ${other.id}.` });
    expect((await getArticle(as('viewer'), runbook.id)).mentionedIn.articles).toEqual([]);
    expect((await getArticle(as('viewer'), other.id)).mentionedIn.articles).toEqual([]);
  });
});

describe('access', () => {
  it('lets a viewer read but not write, and a read-only token neither write', async () => {
    await expect(createArticle(as('viewer'), { project: 'BACK', title: 'Nope' })).rejects.toMatchObject({ status: 403 });
    await expect(updateArticle(as('viewer'), 'BACK-A-1', { body: 'x' })).rejects.toMatchObject({ status: 403 });
    await expect(deleteArticle(as('viewer'), 'BACK-A-1')).rejects.toMatchObject({ status: 403 });
    const readOnly = { ...as('anna'), actor: { ...as('anna').actor, scopes: ['read' as const], authMethod: 'token' as const } };
    await expect(createArticle(readOnly, { project: 'BACK', title: 'Nope' })).rejects.toMatchObject({ status: 403 });
    expect((await getArticle(readOnly, 'BACK-A-1')).id).toBe('BACK-A-1');
  });

  it("hides a project's articles from who may not see the project, in the words of a missing one", async () => {
    await membersOnly('BACK', ['anna'], async () => {
      await expect(getArticle(as('ben'), 'BACK-A-1')).rejects.toMatchObject({ status: 404 });
      await expect(articleTree(as('ben'), 'BACK')).rejects.toMatchObject({ status: 404 });
      await expect(updateArticle(as('ben'), 'BACK-A-1', { body: 'x' })).rejects.toMatchObject({ status: 404 });
      const all = await searchArticles(as('ben'), { query: 'failover' });
      expect(all.items.every((a) => a.project !== 'BACK')).toBe(true);
      // An article Ben can see doesn't tell him of BACK's mentions of it.
      const web = await getArticle(as('ben'), 'WEB-A-1');
      expect(web.mentionedIn.issues.every((i) => !i.id.startsWith('BACK-'))).toBe(true);
      // Hidden and missing can't be told apart, and no hint names another project.
      const words = (e: unknown) => ({ status: (e as { status: number }).status, message: (e as Error).message, hint: (e as { hint?: string }).hint });
      const hidden = words(await getArticle(as('ben'), 'BACK-A-1').catch((e) => e));
      const missing = words(await getArticle(as('ben'), 'BACK-A-999').catch((e) => e));
      expect({ ...hidden, message: hidden.message.replace('BACK-A-1', 'X') }).toEqual({ ...missing, message: missing.message.replace('BACK-A-999', 'X') });
      const hiddenProject = words(await articleTree(as('ben'), 'BACK').catch((e) => e));
      const noProject = words(await articleTree(as('ben'), 'NOPE').catch((e) => e));
      expect({ ...hiddenProject, message: hiddenProject.message.replace('BACK', 'X') }).toEqual({ ...noProject, message: noProject.message.replace('NOPE', 'X') });
      expect(`${noProject.hint ?? ''}`).not.toMatch(/BACK|WEB/);
      await expect(createArticle(as('ben'), { project: 'BACK', title: 'Nope' })).rejects.toMatchObject({ status: 404 });
      // Anna is one of its people, and sees it.
      expect((await getArticle(as('anna'), 'BACK-A-1')).id).toBe('BACK-A-1');
    });
  });

  it("lets a project's viewer read its articles, not write them", async () => {
    await addMember(w.adminCtx, 'BACK', { user: 'ben', role: 'viewer' });
    try {
      expect((await getArticle(as('ben'), 'BACK-A-1')).id).toBe('BACK-A-1');
      await expect(createArticle(as('ben'), { project: 'BACK', title: 'Nope' })).rejects.toMatchObject({ status: 403 });
      await expect(updateArticle(as('ben'), 'BACK-A-1', { body: 'x' })).rejects.toMatchObject({ status: 403 });
    } finally {
      await removeMember(w.adminCtx, 'BACK', 'ben');
    }
  });
});

describe('REST and MCP', () => {
  let app: ReturnType<typeof createHttpApp>;
  let token = '';
  beforeAll(async () => {
    app = createHttpApp(w.app);
    token = (await issueTokenFor(w.app.db, w.anna.id, { name: 'docs-bot', scopes: ['read', 'write'] })).token;
  });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(`/api/v1${url}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  it('serves the knowledge base over REST', async () => {
    const made = await call('POST', '/articles', { project: 'BACK', title: 'Made over REST', body: 'Hello' });
    expect(made.status).toBe(201);
    expect((await call('GET', `/articles/${made.body.id}`)).body.title).toBe('Made over REST');
    expect((await call('PATCH', `/articles/${made.body.id}`, { body: 'Hello again', expectedVersion: 1 })).body.version).toBe(2);
    expect((await call('PATCH', `/articles/${made.body.id}`, { body: 'Late', expectedVersion: 1 })).status).toBe(409);
    expect((await call('GET', `/articles/${made.body.id}/versions`)).body.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect((await call('GET', `/articles/${made.body.id}/versions/2`)).body.diff).toEqual([
      { op: 'del', text: 'Hello' },
      { op: 'add', text: 'Hello again' },
    ]);
    expect((await call('GET', '/projects/BACK/articles')).body.some((a: { id: string }) => a.id === made.body.id)).toBe(true);
    expect((await call('GET', `/articles?query=${encodeURIComponent('made over')}`)).body.items[0].id).toBe(made.body.id);
    expect((await call('DELETE', `/articles/${made.body.id}`)).status).toBe(204);
    const doc = (await (await app.request('/api/v1/openapi.json')).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/articles', '/articles/{id}', '/articles/{id}/versions', '/projects/{key}/articles', '/issues/{id}/attachments', '/attachments/{id}/content']));
  });

  it('lets an agent find, read and write documentation, with a preview first', async () => {
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3999/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (input, init) => app.request(String(input), init as RequestInit),
    });
    const c = new Client({ name: 'test', version: '1.0.0' });
    await c.connect(transport);
    const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);
    const { tools } = await c.listTools();
    expect(tools.find((t) => t.name === 'update_article')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tools.find((t) => t.name === 'search_articles')!.annotations).toMatchObject({ readOnlyHint: true });

    const found = data(await c.callTool({ name: 'search_articles', arguments: { query: 'failover' } }));
    expect(found.articles.some((a: { snippet: string }) => a.snippet.includes('**failover**') || a.snippet.includes('**Failover**'))).toBe(true);
    const made = data(await c.callTool({ name: 'create_article', arguments: { project: 'BACK', title: 'API errors', body: 'Every error has a hint.', parent: 'BACK-A-1' } }));
    const read = data(await c.callTool({ name: 'get_article', arguments: { article: made.id } }));
    expect(read).toMatchObject({ title: 'API errors', version: 1, under: ['BACK-A-1 Deploying the API'], body: 'Every error has a hint.' });

    const { TOOLS } = await import('../src/tools/registry');
    const update = TOOLS.find((t) => t.name === 'update_article')!;
    const ctx = { ...w.as(w.anna), actor: { ...w.as(w.anna).actor, channel: 'mcp' as const } };
    const preview = await update.preview!(ctx, update.input.parse({ article: made.id, body: 'Every error has a hint.\nAnd a code.', expected_version: 1 }));
    expect(preview).toContain('1 line added');
    expect(preview).toContain('+ And a code.');
    expect(await getArticle(w.as(w.anna), made.id)).toMatchObject({ version: 1 });
    const done = data(await c.callTool({ name: 'update_article', arguments: { article: made.id, body: 'Every error has a hint.\nAnd a code.', expected_version: 1 } }));
    expect(done.version).toBe(2);
    const stale = await c.callTool({ name: 'update_article', arguments: { article: made.id, body: 'x', expected_version: 1 } });
    expect(stale.isError).toBe(true);
    const versions = await listArticleVersions(w.as(w.anna), made.id);
    expect(versions[0]).toMatchObject({ channel: 'mcp', token: 'docs-bot' });
    await c.close();
  });
});
