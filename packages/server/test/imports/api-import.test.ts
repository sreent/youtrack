import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { systemCtx } from '../../src/app-services';
import type { Ctx } from '../../src/context';
import { activities, attachments, comments, externalIssues, importRows, imports, issues, workItems } from '../../src/db/schema';
import { adfToMarkdown, wikiToMarkdown } from '../../src/imports/markup';
import { paging } from '../../src/imports/readers';
import { checkAddress, isPublicAddress, Remote, RemoteError } from '../../src/imports/remote';
import { continueFetch, importFromApi, waitForFetch } from '../../src/services/api-imports';
import { getIssue } from '../../src/services/issues';
import { checkImport, getImport, importRowsOf, runImport, undoImport, waitForImport } from '../../src/services/imports';
import { createProject } from '../../src/services/projects';
import { createWorld, type TestWorld } from '../helpers';
import { DC_TOKEN, fakeJiraCloud, fakeJiraDataCenter, fakeYouTrack, JIRA_EMAIL, JIRA_TOKEN, YT_TOKEN, type FakeJira, type FakeYouTrack } from './fake-trackers';

let w: TestWorld;
let admin: Ctx;
const pageSize = paging.pageSize;

beforeAll(async () => {
  w = await createWorld({ config: { importAllowHttpLoopback: true } });
  admin = systemCtx(w.app, w.admin, 'web');
  admin.actor.scopes = ['read', 'write', 'admin'];
  await createProject(w.adminCtx, { key: 'YTI', name: 'From YouTrack', template: 'software' });
  await createProject(w.adminCtx, { key: 'JIR', name: 'From Jira', template: 'software' });
  await createProject(w.adminCtx, { key: 'OPS', name: 'Operations', template: 'software' });
  await createProject(w.adminCtx, { key: 'RES', name: 'Resumed', template: 'software' });
  await createProject(w.adminCtx, { key: 'SECRET', name: 'Members only', template: 'software', visibility: 'members' });
});
afterAll(async () => w?.close());
afterEach(() => {
  paging.pageSize = pageSize;
});

const fieldValue = (i: Awaited<ReturnType<typeof getIssue>>, name: string) => {
  const v = i.fields.find((f) => f.name === name)?.value as unknown;
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map((x) => (x as { name?: string; login?: string }).name ?? (x as { login?: string }).login).join(', ');
  if (typeof v === 'object') return (v as { login?: string; name?: string; presentation?: string }).login ?? (v as { name?: string }).name ?? (v as { presentation?: string }).presentation ?? null;
  return String(v);
};

/** Every place a token could have been written down. */
async function everythingKept(): Promise<string> {
  const rows = await w.app.db.execute(
    sql`SELECT coalesce((SELECT json_agg(i)::text FROM imports i), '') || coalesce((SELECT json_agg(r)::text FROM import_rows r), '') || coalesce((SELECT json_agg(a)::text FROM activities a), '') || coalesce((SELECT json_agg(e)::text FROM external_issues e), '') AS all`,
  );
  const list = (rows as unknown as { rows?: { all: string }[] }).rows ?? (rows as unknown as { all: string }[]);
  return list[0]?.all ?? '';
}

describe('where an import may read from', () => {
  const strict = { allowHosts: [], allowHttpLoopback: false };

  it('reads public https addresses, and nothing inside the network', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700::1111')).toBe(true);
    for (const a of ['10.1.2.3', '172.16.0.9', '192.168.1.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1']) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    expect(checkAddress(strict, 'https://example.youtrack.cloud', 'x').host).toBe('example.youtrack.cloud');
    const refused = (url: string) => {
      try {
        checkAddress(strict, url, 'https://example.youtrack.cloud');
      } catch (e) {
        return (e as RemoteError).message;
      }
      return 'allowed';
    };
    expect(refused('http://example.youtrack.cloud')).toBe('a4a reads other trackers over https only');
    expect(refused('https://jane:secret@example.youtrack.cloud')).toBe('The address has a name and password in it');
    expect(refused('https://10.0.0.5')).toMatch(/inside the network/);
    expect(refused('https://169.254.169.254/latest/meta-data')).toMatch(/inside the network/);
    expect(refused('https://[::1]:8443')).toMatch(/inside the network/);
    expect(refused('ftp://example.com')).toMatch(/can't read from a ftp address/);
    expect(refused('not a url')).toMatch(/isn't a web address/);
    // An administrator may allow a host inside by name; https still.
    expect(checkAddress({ allowHosts: ['10.0.0.5'], allowHttpLoopback: false }, 'https://10.0.0.5', 'x').host).toBe('10.0.0.5');
    // Plain http, to this machine only, when tests say so.
    expect(checkAddress({ allowHosts: [], allowHttpLoopback: true }, 'http://127.0.0.1:8080', 'x').port).toBe('8080');
    expect(() => checkAddress({ allowHosts: [], allowHttpLoopback: true }, 'http://example.com', 'x')).toThrow(/https only/);
  });

  it('checks what a name resolves to as it connects, so a name for an inside address is refused', async () => {
    const remote = new Remote(new URL('https://localhost:9'), 'Bearer x', ['x'], { allowHosts: [], allowHttpLoopback: false }, { name: 'YouTrack', example: 'e', authHint: 'a', badRequestHint: 'b' });
    const failure = await remote.json('/api/users/me').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RemoteError);
    expect((failure as RemoteError).kind).toBe('address');
    expect((failure as RemoteError).message).toBe('localhost is inside the network, and a4a reads only from public addresses');
    expect((failure as RemoteError).hint).toMatch(/IMPORT_ALLOW_HOSTS/);
  });
});

describe('Jira rich text as Markdown', () => {
  it('turns Atlassian Document Format into Markdown', () => {
    const md = adfToMarkdown({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Why' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'See ' },
            { type: 'text', text: 'the docs', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
            { type: 'text', text: ', ' },
            { type: 'text', text: 'urgent', marks: [{ type: 'em' }, { type: 'strong' }] },
            { type: 'text', text: ' and ' },
            { type: 'text', text: 'x = 1', marks: [{ type: 'code' }] },
            { type: 'hardBreak' },
            { type: 'mention', attrs: { text: '@Anna' } },
          ],
        },
        { type: 'orderedList', attrs: { order: 3 }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'third' }] }] }] },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }] },
        { type: 'rule' },
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }, { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }] },
            { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '1|2' }] }] }, { type: 'tableCell', content: [] }] },
          ],
        },
        { type: 'mediaSingle', content: [{ type: 'media', attrs: { alt: 'screen.png' } }] },
        { type: 'taskList', content: [{ type: 'taskItem', attrs: { state: 'DONE' }, content: [{ type: 'text', text: 'shipped' }] }] },
      ],
    });
    expect(md).toBe(
      [
        '### Why',
        'See [the docs](https://example.com), ***urgent*** and `x = 1`  \n@Anna',
        '3. third',
        '> quoted',
        '---',
        '| a | b |\n| --- | --- |\n| 1\\|2 |  |',
        '(a file: screen.png)',
        '- [x] shipped',
      ].join('\n\n'),
    );
    expect(adfToMarkdown('plain')).toBe('plain');
    expect(adfToMarkdown(null)).toBe('');
  });

  it('turns wiki markup into Markdown', () => {
    expect(
      wikiToMarkdown('h1. Title\n*bold* and _it_ and {{code}} and -gone-\n* one\n** two\n# first\n[docs|https://example.com] [~anna]\n{code:java}\nint x = 1;\n{code}\nbq. said\n||a||b||\n|1|2|\n----'),
    ).toBe(
      [
        '# Title',
        '**bold** and *it* and `code` and ~~gone~~',
        '- one',
        '  - two',
        '1. first',
        '[docs](https://example.com) @anna',
        '',
        '```java\nint x = 1;\n```',
        '',
        '> said',
        '| a | b |',
        '| --- | --- |',
        '| 1 | 2 |',
        '---',
      ].join('\n'),
    );
  });
});

describe('importing from YouTrack', () => {
  let yt: FakeYouTrack;
  beforeAll(async () => {
    yt = await fakeYouTrack();
  });
  afterAll(async () => yt?.close());

  const credentials = { token: YT_TOKEN };

  it('says at once when the token or the query is wrong, never repeating the token', async () => {
    const wrong = await importFromApi(admin, { project: 'YTI', source: 'youtrack', url: yt.url, query: 'project: YT', credentials: { token: 'perm:nope' } }).catch((e: unknown) => e);
    expect(wrong).toMatchObject({ status: 400, code: 'source_refused', message: "YouTrack didn't accept the token" });
    expect((wrong as { hint: string }).hint).toMatch(/permanent token/);
    expect(JSON.stringify(wrong)).not.toContain('perm:nope');

    const none = await importFromApi(admin, { project: 'YTI', source: 'youtrack', url: yt.url, query: 'project: NONE', credentials }).catch((e: unknown) => e);
    expect(none).toMatchObject({ status: 400, message: 'Nothing in YouTrack matches project: NONE' });

    const email = await importFromApi(admin, { project: 'YTI', source: 'youtrack', url: yt.url, query: 'project: YT', credentials: { ...credentials, email: 'jane@example.com' } }).catch((e: unknown) => e);
    expect(email).toMatchObject({ status: 400, message: 'YouTrack takes a token alone' });
  });

  it('is for the project\'s managers, and a hidden project answers as a missing one, before anything is read', async () => {
    const before = yt.seen.length;
    const member = await importFromApi(w.as(w.anna), { project: 'YTI', source: 'youtrack', url: yt.url, query: 'project: YT', credentials }).catch((e: unknown) => e);
    expect(member).toMatchObject({ status: 403 });
    const hidden = await importFromApi(w.as(w.anna), { project: 'SECRET', source: 'youtrack', url: yt.url, query: 'project: YT', credentials }).catch((e: unknown) => e);
    const missing = await importFromApi(w.as(w.anna), { project: 'NOPE', source: 'youtrack', url: yt.url, query: 'project: YT', credentials }).catch((e: unknown) => e);
    expect(hidden).toMatchObject({ status: 404 });
    expect((hidden as Error).message).toBe((missing as Error).message.replace('NOPE', 'SECRET'));
    expect(yt.seen.length).toBe(before);
  });

  it('reads the issues page by page, waiting out a 429, and maps them as an export of the same columns', async () => {
    paging.pageSize = 2;
    yt.slowDownAt = 2;
    const started = await importFromApi(admin, { project: 'YTI', source: 'youtrack', url: `${yt.url}/issues/YT-1?tab=comments`, query: 'project: YT', credentials });
    expect(started.status).toBe('fetching');
    expect(started.origin).toMatchObject({ kind: 'youtrack', url: yt.url, query: 'project: YT', account: 'Jane Remote', deployment: null, fetch: { complete: false, total: 4 } });
    expect(started.fileName).toBe(`YouTrack 127.0.0.1:${yt.port}: project: YT`);
    await waitForFetch(started.id);
    const imp = await getImport(admin, started.id);
    expect(imp.status).toBe('ready');
    expect(imp.rows).toBe(3);
    expect(imp.origin!.fetch).toEqual({ complete: true, issues: 3, comments: 2, work: 1, files: 2, fileBytes: 33, total: 4, left: { issues: 1, comments: 1, keys: ['YT-3'] } });
    // The 429 was waited out, and every page asked for in order, sorted so pages don't shift.
    const pages = yt.seen.filter((s) => s.path === '/api/issues').map((s) => s.query.get('$skip'));
    expect(pages).toEqual(['0', '2', '2', '4']);
    expect(yt.seen.find((s) => s.path === '/api/issues')!.query.get('query')).toBe('project: YT sort by: created asc');
    const target = (name: string) => imp.columns.find((c) => c.name === name)?.target;
    expect(target('Issue Id')).toBe('key');
    expect(target('Summary')).toBe('summary');
    expect(target('Reporter')).toBe('reporter');
    expect(target('State')).toBe('field:State');
    expect(target('Priority')).toBe('field:Priority');
    expect(target('Assignee')).toBe('field:Assignee');
    expect(target('Estimation')).toBe('field:Estimation');
    expect(target('Due Date')).toBe('field:Due date');
    expect(target('Tags')).toBe('tags');
    expect(target('subtask of')).toBe('parent');
    expect(target('depends on')).toBe('link:depends on');
    // Work items come one by one, so the total of spent time doesn't come too.
    expect(imp.columns.some((c) => c.name === 'Spent time')).toBe(false);
    const people = imp.values.find((v) => v.target === 'field:Assignee')!;
    expect(people.items).toEqual([{ value: 'Anna Schmidt', count: 1, to: 'anna', found: true }]);
  });

  it('checks, then runs with the token again for the files, keeping dates, people, comments, work and links', async () => {
    const [{ id }] = await w.app.db.select({ id: imports.id }).from(imports).where(eq(imports.status, 'ready'));
    const check = await checkImport(admin, id!);
    expect(check.counts).toMatchObject({ created: 3, comments: 2, work: 1, files: 2, links: 4, linksMissing: 0 });
    expect(check.warnings.join(' ')).toMatch(/1 issue is for only some people to see in YouTrack, so it is left out: YT-3/);
    expect(check.warnings.join(' ')).toMatch(/1 comment is for only some people to see in YouTrack/);

    const noToken = await runImport(admin, id!).catch((e: unknown) => e);
    expect(noToken).toMatchObject({ status: 400, message: 'It brings 2 files from YouTrack, and a4a needs the token again to download them' });
    await runImport(admin, id!, { credentials });
    await waitForImport(id!);
    const done = await getImport(admin, id!);
    expect(done.status).toBe('done');
    expect(done.result).toMatchObject({ created: 3, comments: 2, work: 1, files: 2, failed: 0 });
    expect(yt.downloads.sort()).toEqual(['f-1', 'f-2']);

    const rows = await importRowsOf(admin, id!, { offset: 0, limit: 10 });
    const made = new Map(rows.items.map((r) => [r.key, r.issue!]));
    const yt1 = await getIssue(admin, made.get('YT-1')!);
    expect(yt1.summary).toBe('Plan the release');
    expect(yt1.description).toBe('We ship **2.0** in April.');
    expect(fieldValue(yt1, 'State')).toBe('Open');
    expect(fieldValue(yt1, 'Priority')).toBe('Major');
    expect(fieldValue(yt1, 'Assignee')).toBe('anna');
    expect(yt1.tags.map((t) => t.name)).toEqual(['release']);
    expect(yt1.reporter?.login).toBe('ben');
    expect(yt1.createdAt).toBe(new Date(Date.UTC(2024, 3, 1, 9)).toISOString());

    const [row1] = await w.app.db.select().from(issues).where(eq(issues.id, await idOf(made.get('YT-1')!)));
    const notes = await w.app.db.select().from(comments).where(eq(comments.issueId, row1!.id));
    expect(notes.map((c) => c.text)).toEqual(['Dates are in the plan.']); // the limited one and the deleted one stay behind
    expect(notes[0]!.authorId).toBe(w.anna.id);
    const work = await w.app.db.select().from(workItems).where(eq(workItems.issueId, row1!.id));
    expect(work.map((x) => [x.date, x.minutes, x.authorId, x.description])).toEqual([['2024-04-02', 90, w.anna.id, 'Drafting the plan']]);
    const files1 = await w.app.db.select().from(attachments).where(eq(attachments.issueId, row1!.id));
    expect(files1.map((f) => [f.name, f.size, f.contentType, f.uploadedById, f.commentId])).toEqual([['notes.txt', 18, 'text/plain; charset=utf-8', w.ben.id, null]]);
    expect(files1[0]!.createdAt.toISOString()).toBe(new Date(Date.UTC(2024, 3, 1, 10)).toISOString());

    // YT-2: a subtask of YT-1, and its file on the comment it was on there, by someone not here.
    const yt2 = await getIssue(admin, made.get('YT-2')!);
    const linked = (phrase: string) => yt2.links.filter((l) => l.phrase === phrase).map((l) => l.issue.id);
    expect(linked('subtask of')).toEqual([made.get('YT-1')]);
    expect(linked('depends on')).toEqual([made.get('YT-1')]);
    const id2 = await idOf(made.get('YT-2')!);
    const [zedSaid] = await w.app.db.select().from(comments).where(eq(comments.issueId, id2));
    expect(zedSaid!.text).toBe('**Zed Remote** wrote in YouTrack:\n\nThe log is attached.');
    const [log] = await w.app.db.select().from(attachments).where(eq(attachments.issueId, id2));
    expect(log).toMatchObject({ name: 'build.log', commentId: zedSaid!.id, uploadedById: w.admin.id });

    // Quietly: every activity of the import says so, files included.
    const acts = await w.app.db.select({ type: activities.type, data: sql<unknown>`${activities.payload}->'data'->'imported'` }).from(activities).where(eq(activities.issueId, row1!.id));
    expect(acts.length).toBeGreaterThan(3);
    expect(acts.every((a) => a.data)).toBe(true);
    expect(acts.map((a) => a.type)).toEqual(expect.arrayContaining(['issue.created', 'comment.created', 'work.logged', 'attachment.added']));

    // The token went nowhere a4a keeps anything.
    expect(await everythingKept()).not.toContain(YT_TOKEN);
  });

  it('runs again from a new fetch: only what changed there, nothing twice, no file downloaded again', async () => {
    const yt1 = yt.issues[0]!;
    yt1.summary = 'Plan the 2.0 release';
    yt1.updated = Date.UTC(2024, 3, 5, 9);
    yt1.comments.push({ id: 'c-14', text: 'Moved to May.', created: Date.UTC(2024, 3, 5, 9), deleted: false, visibility: { $type: 'UnlimitedVisibility' }, author: { login: 'anna.s', fullName: 'Anna Schmidt', email: null, $type: 'User' } });
    yt1.timeTracking!.workItems.push({ id: 'w-2', date: Date.UTC(2024, 3, 5), duration: { minutes: 30 }, text: '', author: { login: 'ola', fullName: 'Ola Gone', email: null, $type: 'User' } });
    yt.downloads.length = 0;
    const issuesBefore = (await w.app.db.select({ id: issues.id }).from(issues)).length;

    const again = await importFromApi(admin, { project: 'YTI', source: 'youtrack', url: yt.url, query: 'project: YT', credentials });
    await waitForFetch(again.id);
    const check = await checkImport(admin, again.id);
    expect(check.counts).toMatchObject({ created: 0, updated: 1, unchanged: 2, comments: 1, work: 1, files: 0 });
    await runImport(admin, again.id, { credentials });
    await waitForImport(again.id);
    const done = await getImport(admin, again.id);
    expect(done.result).toMatchObject({ created: 0, updated: 1, unchanged: 2, comments: 1, work: 1, files: 0 });
    expect(yt.downloads).toEqual([]);
    expect((await w.app.db.select({ id: issues.id }).from(issues)).length).toBe(issuesBefore);

    const [ex] = await w.app.db.select().from(externalIssues).where(and(eq(externalIssues.source, 'youtrack'), eq(externalIssues.externalKey, 'YT-1')));
    const updated = await getIssue(admin, ex!.readableId);
    expect(updated.summary).toBe('Plan the 2.0 release');
    const work = await w.app.db.select().from(workItems).where(eq(workItems.issueId, ex!.issueId!));
    expect(work.map((x) => [x.minutes, x.authorId, x.description]).sort()).toEqual([
      [30, null, '(logged by Ola Gone in YouTrack)'],
      [90, w.anna.id, 'Drafting the plan'],
    ]);
  });

  it('undoes an import of issues, their files with them', async () => {
    const [first] = await w.app.db.select({ id: imports.id }).from(imports).where(and(eq(imports.status, 'done'), sql`${imports.fileName} LIKE 'YouTrack%'`)).orderBy(imports.createdAt).limit(1);
    const preview = await undoImport(admin, first!.id, { dryRun: true });
    expect(preview.remove).toHaveLength(3);
    expect(preview.keep).toEqual([]);
    const undone = await undoImport(admin, first!.id, { dryRun: false });
    expect(undone.remove).toHaveLength(3);
    const left = await w.app.db
      .select({ id: attachments.id })
      .from(attachments)
      .innerJoin(issues, eq(issues.id, attachments.issueId))
      .where(sql`${issues.projectId} = (SELECT id FROM projects WHERE key = 'YTI')`);
    expect(left).toEqual([]);
  });
});

async function idOf(readable: string): Promise<string> {
  const [ex] = await w.app.db.select({ issueId: externalIssues.issueId }).from(externalIssues).where(eq(externalIssues.readableId, readable));
  return ex!.issueId!;
}

describe('a fetch that stops', () => {
  let yt: FakeYouTrack;
  beforeAll(async () => {
    yt = await fakeYouTrack();
  });
  afterAll(async () => yt?.close());

  it('carries on from its last page with the token again, reading nothing twice', async () => {
    paging.pageSize = 1;
    yt.failAt = { skip: 2, times: 1 };
    const started = await importFromApi(admin, { project: 'RES', source: 'youtrack', url: yt.url, query: 'project: YT', credentials: { token: YT_TOKEN }, bring: { files: false } });
    await waitForFetch(started.id);
    const stopped = await getImport(admin, started.id);
    expect(stopped.status).toBe('failed');
    expect(stopped.error).toBe('It stopped reading: YouTrack answered 500: Something broke Try again later: what has been read so far is kept.');
    expect(stopped.origin!.fetch.complete).toBe(false);
    expect(stopped.rows).toBe(2);
    await expect(checkImport(admin, started.id)).rejects.toMatchObject({ status: 409, message: 'It is still reading the issues' });

    const wrong = await continueFetch(admin, started.id, { token: 'perm:wrong' }).catch((e: unknown) => e);
    expect(wrong).toMatchObject({ status: 400, message: "YouTrack didn't accept the token" });
    await continueFetch(admin, started.id, { token: YT_TOKEN });
    await waitForFetch(started.id);
    const done = await getImport(admin, started.id);
    expect(done.status).toBe('ready');
    expect(done.rows).toBe(3);
    const keys = (await w.app.db.select({ cells: importRows.cells }).from(importRows).where(eq(importRows.importId, started.id))).map((r) => (r.cells as string[])[0]);
    expect(keys.sort()).toEqual(['YT-1', 'YT-2', 'YT-4']);
    // Without files, it runs without the token.
    await runImport(admin, started.id);
    await waitForImport(started.id);
    expect((await getImport(admin, started.id)).result).toMatchObject({ created: 3, files: 0 });
  });
});

describe('importing from Jira Cloud', () => {
  let jira: FakeJira;
  beforeAll(async () => {
    jira = await fakeJiraCloud();
  });
  afterAll(async () => jira?.close());

  const credentials = { email: JIRA_EMAIL, token: JIRA_TOKEN };

  it("says what Jira says of a JQL it can't read", async () => {
    const bad = await importFromApi(admin, { project: 'JIR', source: 'jira', url: jira.url, query: 'badfield = 1', credentials }).catch((e: unknown) => e);
    expect(bad).toMatchObject({ status: 400, message: "Jira refused the request: Field 'badfield' does not exist or you do not have permission to view it." });
    expect((bad as { hint: string }).hint).toMatch(/Check the JQL/);
  });

  it('reads pages by their token, comments past the first page, worklogs and rich text', async () => {
    const started = await importFromApi(admin, { project: 'JIR', source: 'jira', url: `${jira.url}/browse/ABC-1`, query: 'project = ABC', credentials });
    expect(started.origin).toMatchObject({ kind: 'jira', deployment: 'cloud', account: 'Jane Remote', url: jira.url });
    await waitForFetch(started.id);
    const imp = await getImport(admin, started.id);
    expect(imp.status).toBe('ready');
    expect(imp.rows).toBe(3);
    expect(imp.origin!.fetch).toMatchObject({ issues: 3, comments: 2, work: 1, files: 1, left: { issues: 1, comments: 1, keys: ['ABC-4'] } });
    const search = jira.seen.filter((s) => s.path === '/rest/api/3/search/jql');
    expect(search.map((s) => s.query.get('nextPageToken'))).toEqual([null, 'page-2']);
    expect(search[0]!.query.get('jql')).toBe('project = ABC ORDER BY created ASC');
    const target = (name: string) => imp.columns.find((c) => c.name === name)?.target;
    expect(target('Issue key')).toBe('key');
    expect(target('Issue id')).toBe('external-id');
    expect(target('Status')).toBe('field:State');
    expect(target('Issue Type')).toBe('field:Type');
    expect(target('Labels')).toBe('tags');
    expect(target('Sprint')).toBe('sprint');
    expect(target('Parent')).toBe('parent');
    expect(target('Original Estimate')).toBe('field:Estimation');
    expect(target('Outward issue link (Blocks)')).toBe('link:is required for');
    expect(target('Inward issue link (Blocks)')).toBe('link:depends on');
    expect(imp.columns.some((c) => c.name === 'Rank' || c.name === 'Time Spent')).toBe(false);
    expect(imp.values.find((v) => v.target === 'field:Priority')!.items.find((i) => i.value === 'High')).toMatchObject({ to: 'Critical', found: true });

    await runImport(admin, started.id, { credentials });
    await waitForImport(started.id);
    const done = await getImport(admin, started.id);
    expect(done.result).toMatchObject({ created: 3, comments: 2, work: 1, files: 1, failed: 0 });
    const rows = await importRowsOf(admin, started.id, { offset: 0, limit: 10 });
    const abc1 = await getIssue(admin, rows.items.find((r) => r.key === 'ABC-1')!.issue!);
    expect(abc1.description).toBe('## Steps\n\nOpen **Safari** and sign in.\n\n- A blank page\n- No error\n\n```js\nlogin()\n```');
    expect(fieldValue(abc1, 'Estimation')).toBe('1d');
    const id1 = await idOf(abc1.id);
    const said = await w.app.db.select().from(comments).where(eq(comments.issueId, id1));
    expect(said.map((c) => c.text).sort()).toEqual(['**Zed Remote** wrote in Jira:\n\nMe too', 'I can reproduce it']);
    const [shot] = await w.app.db.select().from(attachments).where(eq(attachments.issueId, id1));
    expect(shot).toMatchObject({ name: 'screenshot.png', contentType: 'image/png', uploadedById: w.ben.id });
    // Its file came from another origin, by a redirect, without the credentials.
    const fromMedia = jira.media.seen.find((s) => s.path === '/file/10100');
    expect(fromMedia?.auth).toBeUndefined();
    const abc2 = await getIssue(admin, rows.items.find((r) => r.key === 'ABC-2')!.issue!);
    expect(abc2.links.filter((l) => l.phrase === 'subtask of').map((l) => l.issue.id)).toEqual([abc1.id]);
    expect(await everythingKept()).not.toContain(JIRA_TOKEN);
  });
});

describe('importing from Jira Data Center', () => {
  it('pages by startAt with a personal access token, and reads wiki markup', async () => {
    const dc = await fakeJiraDataCenter();
    try {
      const started = await importFromApi(admin, { project: 'OPS', source: 'jira', url: dc.url, query: 'project = OPS', credentials: { token: DC_TOKEN } });
      expect(started.origin).toMatchObject({ deployment: 'datacenter', fetch: { total: 3 } });
      await waitForFetch(started.id);
      const imp = await getImport(admin, started.id);
      expect(imp.rows).toBe(3);
      expect(dc.seen.filter((s) => s.path === '/rest/api/2/search').map((s) => [s.query.get('startAt'), s.query.get('maxResults')])).toEqual([
        [null, '0'],
        ['0', '50'],
        ['2', '50'],
      ]);
      await runImport(admin, started.id);
      await waitForImport(started.id);
      const rows = await importRowsOf(admin, started.id, { offset: 0, limit: 10 });
      const ops1 = await getIssue(admin, rows.items.find((r) => r.key === 'OPS-1')!.issue!);
      expect(ops1.description).toBe('## What happens\n- the job starts at 02:00\n- it ends at **09:00**\n\n```bash\nrun-backup --all\n```\n\nSee [the runbook](https://wiki.example.com/backups).');
      const [said] = await w.app.db.select().from(comments).where(eq(comments.issueId, await idOf(ops1.id)));
      expect(said!.text).toBe('Seen again on **Monday**.');
      expect(await everythingKept()).not.toContain(DC_TOKEN);
    } finally {
      await dc.close();
    }
  });
});
