/**
 * Articles limited to some people (D51): an article limited to some people and groups, and
 * everything under it, is missing to everyone else, in the same words, wherever articles are read:
 * the tree, search, versions, files, mentions, the feed and the live stream, and MCP.
 */
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx, UserRow } from '../src/context';
import { createHttpApp } from '../src/http/app';
import { AppError } from '../src/lib/errors';
import { eventFeed } from '../src/services/activity';
import { articleEventSeen, eventLimited, projectAccess, redactUnseenIds, whoSeesArticle } from '../src/services/access';
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
  setArticleVisibility,
  updateArticle,
} from '../src/services/articles';
import { articleUploadTarget, attachmentForDownload, getAttachment, listArticleAttachments, readAttachmentText, storeAttachment } from '../src/services/attachments';
import { issueTokenFor } from '../src/services/auth';
import { addComment, listComments } from '../src/services/comments';
import { addGroupMember, createGroup } from '../src/services/groups';
import { createIssue } from '../src/services/issues';
import { addMember } from '../src/services/members';
import { mentionsConsumer } from '../src/services/mentions';
import { insertUser } from '../src/services/users';
import { createWorld, type TestWorld } from './helpers';
import { openStream } from './sse-client';

let w: TestWorld;
let admin: Ctx;
let anna: Ctx; // writes the articles
let ben: Ctx; // outside every limit
let chloe: Ctx; // manages BACK
let erin: Ctx; // named on the limits
let dan: Ctx; // in the Payroll group
let erinUser: UserRow;

/** What a call that must fail failed with; the call starts only here, when it's awaited. */
async function failure(call: () => Promise<unknown>): Promise<{ status: number; message: string; hint?: string }> {
  try {
    await call();
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return { status: e.status, message: e.message, hint: e.hint };
  }
  throw new Error('expected it to fail');
}

/** The failure, with the id it names taken out, so a hidden article's can be held against a missing one's. */
async function missingAs(call: () => Promise<unknown>, id: string) {
  const f = await failure(call);
  return { status: f.status, message: f.message.replace(id, 'X'), hint: f.hint?.replace(id, 'X') };
}

async function person(login: string, name: string): Promise<UserRow> {
  const u = await insertUser(w.app.db, { login, name, role: 'member' });
  w.app.schema.invalidate();
  return u;
}

/** Index the mentions of what changed since `after`, as the outbox worker would. */
async function runMentions(after: number) {
  const consumer = mentionsConsumer(w.app);
  for (const e of await eventFeed(admin, { after, limit: 500 })) if (!consumer.types || consumer.types.includes(e.type)) await consumer.handle(e);
}
const lastEventId = async () => (await eventFeed(admin, { limit: 1, order: 'desc' }))[0]?.id ?? 0;
const ids = (tree: { id: string }[]) => tree.map((a) => a.id);

beforeAll(async () => {
  w = await createWorld();
  admin = w.adminCtx;
  anna = w.as(w.anna);
  ben = w.as(w.ben);
  chloe = w.as(await person('chloe', 'Chloé Martin'));
  erinUser = await person('erin', 'Erin Hall');
  erin = w.as(erinUser);
  dan = w.as(await person('dan', 'Dan Iwu'));
  await addMember(admin, 'BACK', { user: 'chloe', role: 'manager' });
  await createGroup(admin, { name: 'Payroll' });
  await addGroupMember(admin, 'Payroll', 'dan');
});

afterAll(async () => {
  await w?.close();
});

describe('an article limited to some people and groups', () => {
  let secret = '';
  let plain = '';

  beforeAll(async () => {
    plain = (await createArticle(anna, { project: 'BACK', title: 'Onboarding', body: 'Welcome aboard.' })).id;
    const made = await createArticle(anna, { project: 'BACK', title: 'Salary bands for kestrel', body: 'Band C starts at 70k.', visibleTo: { users: ['erin'], groups: ['Payroll'] } });
    secret = made.id;
    expect(made.limited).toBe(true);
    expect(made.visibleTo?.users.map((u) => u.login)).toEqual(['erin']);
    expect(made.visibleTo?.groups.map((g) => g.name)).toEqual(['Payroll']);
  });

  it('is missing to everyone else, in the words used for an article that does not exist', async () => {
    const hidden = await missingAs(() => getArticle(ben, secret), secret);
    expect(hidden.status).toBe(404);
    expect(hidden).toEqual(await missingAs(() => getArticle(ben, 'BACK-A-999'), 'BACK-A-999'));
    // Who still sees it: an administrator, a manager, its author, the person and the group named.
    for (const who of [admin, chloe, anna, erin, dan]) expect((await getArticle(who, secret)).title).toContain('kestrel');
  });

  it('is left out of the tree, and its place goes to the next one', async () => {
    const third = await createArticle(anna, { project: 'BACK', title: 'Holidays' });
    const forBen = await articleTree(ben, 'BACK');
    expect(ids(forBen)).not.toContain(secret);
    expect(ids(await articleTree(erin, 'BACK'))).toContain(secret);
    // Numbered among what Ben sees, so no gap says something is there.
    expect(forBen.map((a) => a.position)).toEqual(forBen.map((_, i) => i));
    expect((await getArticle(ben, third.id)).position).toBe(forBen.findIndex((a) => a.id === third.id));
    // A place Ben gives counts among what he sees: first is first for everyone.
    await updateArticle(ben, third.id, { position: 0 });
    expect((await articleTree(admin, 'BACK'))[0]!.id).toBe(third.id);
    await deleteArticle(anna, third.id);
  });

  it('matches no search, and counts for nothing, for anyone else', async () => {
    expect((await searchArticles(ben, { query: 'kestrel' })).total).toBe(0);
    expect((await searchArticles(ben, { project: 'BACK' })).items.map((a) => a.id)).not.toContain(secret);
    expect((await searchArticles(erin, { query: 'kestrel' })).total).toBe(1);
    expect((await searchArticles(dan, { query: 'kestrel' })).total).toBe(1);
  });

  it('keeps its versions, diffs and every change to itself from anyone else, as missing', async () => {
    await updateArticle(anna, secret, { body: 'Band C starts at 72k.' });
    const missing = { status: 404, message: 'Article X not found', hint: 'Use a readable id such as BACK-A-3.' };
    expect(await missingAs(() => listArticleVersions(ben, secret), secret)).toMatchObject(missing);
    expect(await missingAs(() => getArticleVersion(ben, secret, 2), secret)).toMatchObject(missing);
    expect(await missingAs(() => restoreArticleVersion(ben, secret, 1), secret)).toMatchObject(missing);
    expect(await missingAs(() => updateArticle(ben, secret, { title: 'Mine now' }), secret)).toMatchObject(missing);
    expect(await missingAs(() => setArticleVisibility(ben, secret, null), secret)).toMatchObject(missing);
    expect(await missingAs(() => deleteArticle(ben, secret), secret)).toMatchObject(missing);
    expect((await getArticleVersion(erin, secret, 2)).diff.some((l) => l.op === 'add' && l.text.includes('72k'))).toBe(true);
  });

  it('keeps its files, their previews and their bytes to who sees it', async () => {
    const file = await storeAttachment(anna, await articleUploadTarget(anna, secret), { name: 'bands.csv', stream: Readable.from([Buffer.from('band,from\nC,72000\n')]) });
    const none = await failure(() => getAttachment(ben, 'no-such-file'));
    expect(await failure(() => getAttachment(ben, file.id))).toEqual(none);
    expect(await failure(() => attachmentForDownload(ben, file.id))).toEqual(none);
    expect(await failure(() => readAttachmentText(ben, file.id))).toEqual(none);
    expect((await missingAs(() => listArticleAttachments(ben, secret), secret)).status).toBe(404);
    expect((await missingAs(() => articleUploadTarget(ben, secret), secret)).status).toBe(404);
    expect((await readAttachmentText(erin, file.id)).text).toContain('72000');
    // Its file's events, as its own, are left out of the feed for anyone else.
    const feed = await eventFeed(ben, { project: 'BACK' });
    expect(feed.some((e) => (e.data as { article?: { id?: string } }).article?.id === secret)).toBe(false);
    expect((await eventFeed(erin, { project: 'BACK', types: ['attachment.added'] })).some((e) => (e.data as { article?: { id?: string } }).article?.id === secret)).toBe(true);
  });

  it('leaves its events out of the feed, and keeps them from webhooks', async () => {
    const about = (feed: { data: unknown }[]) => feed.filter((e) => (e.data as { article?: { id?: string } }).article?.id === secret);
    expect(about(await eventFeed(ben, { project: 'BACK' }))).toEqual([]);
    expect(about(await eventFeed(erin, { project: 'BACK' })).map((e) => (e as { type: string }).type)).toContain('article.created');
    const created = about(await eventFeed(admin, { project: 'BACK', types: ['article.created'] }))[0] as Parameters<typeof eventLimited>[2];
    expect(await eventLimited(w.app.db, await w.app.schema.get(), created)).toBe(true);
    const open = (await eventFeed(admin, { project: 'BACK', types: ['article.created'] })).find((e) => (e.data as { article?: { id?: string } }).article?.id === plain)!;
    expect(await eventLimited(w.app.db, await w.app.schema.get(), open)).toBe(false);
  });

  it('is told of only to those who see it', async () => {
    const all = [w.anna.id, w.ben.id, erinUser.id, chloe.actor.user.id, dan.actor.user.id];
    const told = await whoSeesArticle(w.app.db, (await getArticle(admin, secret)).uid, all);
    expect([...told].sort()).toEqual([w.anna.id, erinUser.id, chloe.actor.user.id, dan.actor.user.id].sort());
    expect((await whoSeesArticle(w.app.db, (await getArticle(admin, plain)).uid, all)).size).toBe(all.length);
  });

  it('can be widened and narrowed by whoever may change it, and never away from themselves', async () => {
    const away = await failure(() => setArticleVisibility(erin, secret, { users: [], groups: ['Payroll'] }));
    expect(away.status).toBe(400);
    expect(away.message).toBe(`That would hide ${secret} from you`);
    const opened = await setArticleVisibility(anna, secret, null);
    expect(opened.limited).toBe(false);
    expect(opened.version).toBe(2); // its content keeps its version
    expect((await getArticle(ben, secret)).id).toBe(secret);
    const changed = (await eventFeed(anna, { project: 'BACK', types: ['article.updated'] })).filter((e) => e.changes.some((c) => c.field === 'Visible to'));
    expect(changed.at(-1)?.changes).toEqual([{ field: 'Visible to', from: 'Erin Hall, Payroll', to: null }]);
    await setArticleVisibility(anna, secret, { users: ['erin'], groups: [] });
    expect((await failure(() => getArticle(dan, secret))).status).toBe(404);
    expect((await failure(() => setArticleVisibility(anna, secret, { users: ['nobody-here'] }))).status).toBe(400);
  });
});

describe('what sits under a limited article', () => {
  let top = '';
  let under = '';
  let deeper = '';
  let loose = '';

  beforeAll(async () => {
    top = (await createArticle(anna, { project: 'BACK', title: 'Restructuring heron', visibleTo: { users: ['erin'] } })).id;
    under = (await createArticle(anna, { project: 'BACK', title: 'Heron: who moves where', parent: top })).id;
    // Limited to Ben himself, under an article Ben can't see: he still can't.
    deeper = (await createArticle(anna, { project: 'BACK', title: 'Heron: Ben’s new team', parent: under, visibleTo: { users: ['ben'] } })).id;
    loose = (await createArticle(ben, { project: 'BACK', title: 'Team lunch' })).id;
  });

  it('is never seen by someone who cannot see what it sits under', async () => {
    for (const id of [top, under, deeper]) expect((await failure(() => getArticle(ben, id))).status).toBe(404);
    expect(ids(await articleTree(ben, 'BACK'))).not.toContain(under);
    expect((await searchArticles(ben, { query: 'heron' })).total).toBe(0);
    expect((await getArticle(erin, under)).limitedAbove.map((a) => a.id)).toEqual([top]);
    // Erin sees what's under the top, but not what's limited to Ben below it.
    expect((await getArticle(erin, under)).children).toEqual([]);
    expect((await getArticle(erin, under)).childCount).toBe(0);
    expect((await getArticle(chloe, under)).children.map((c) => c.id)).toEqual([deeper]);
    const told = await whoSeesArticle(w.app.db, (await getArticle(admin, deeper)).uid, [w.ben.id, erinUser.id, w.anna.id]);
    expect([...told]).toEqual([w.anna.id]);
  });

  it('is no place to put an article, for someone who cannot see it, in the words of one that is not there', async () => {
    const hidden = await missingAs(() => createArticle(ben, { project: 'BACK', title: 'Mine', parent: top }), top);
    expect(hidden.status).toBe(400);
    expect(hidden).toEqual(await missingAs(() => createArticle(ben, { project: 'BACK', title: 'Mine', parent: 'BACK-A-999' }), 'BACK-A-999'));
    expect(await missingAs(() => updateArticle(ben, loose, { parent: top }), top)).toEqual(hidden);
  });

  it('hides an article moved under it, at once, and shows it again moved out', async () => {
    await updateArticle(erin, loose, { parent: under });
    expect((await failure(() => getArticle(ben, loose))).status).toBe(404);
    expect(ids(await articleTree(ben, 'BACK'))).not.toContain(loose);
    expect((await getArticle(erin, loose)).limitedAbove.map((a) => a.id)).toEqual([top]);
    await updateArticle(erin, loose, { parent: null });
    expect((await getArticle(ben, loose)).limitedAbove).toEqual([]);
  });

  it('holds up deleting what it sits under, saying only that some people see it', async () => {
    const hush = (await createArticle(anna, { project: 'BACK', title: 'Heron: severance', parent: under, visibleTo: { users: ['erin'] } })).id;
    await setArticleVisibility(anna, top, null);
    try {
      // Ben now sees the top, what's under it, and what's limited to him; not what's limited to Erin.
      expect((await getArticle(ben, under)).children.map((c) => c.id)).toEqual([deeper]);
      const held = await failure(() => deleteArticle(ben, under));
      expect(held.status).toBe(409);
      expect(held.message).toBe(`${under} has articles under it that only some people see`);
      expect(held.hint).toBe('A manager of BACK sees them, and can move them.');
    } finally {
      await setArticleVisibility(anna, top, { users: ['erin'] });
      await deleteArticle(anna, hush);
    }
  });

  it('stays hidden once deleted: only who saw all of its project see that it went, or what it was', async () => {
    const gone = (await createArticle(anna, { project: 'BACK', title: 'Short-lived osprey', parent: top })).id;
    await updateArticle(anna, gone, { body: 'osprey' });
    await deleteArticle(anna, gone);
    const about = (feed: { data: unknown }[]) => feed.filter((e) => (e.data as { article?: { id?: string } }).article?.id === gone).length;
    expect(about(await eventFeed(erin, { project: 'BACK' }))).toBe(0);
    expect(about(await eventFeed(ben, { project: 'BACK' }))).toBe(0);
    expect(about(await eventFeed(chloe, { project: 'BACK' }))).toBe(3);
    const deleted = (await eventFeed(admin, { project: 'BACK', types: ['article.deleted'] })).find((e) => (e.data as { article?: { id?: string } }).article?.id === gone)!;
    expect(await articleEventSeen(await projectAccess(ben), w.app.db, await w.app.schema.get(), deleted)).toBe(false);
  });
});

describe('mentions of a limited article', () => {
  it('keep its id as text in an issue comment, never its title, and redact it in agents’ words', async () => {
    const issue = await createIssue(anna, { project: 'BACK', summary: 'Payroll export breaks' });
    const secret = (await createArticle(anna, { project: 'BACK', title: 'Payroll runbook falcon', body: `Fixes for ${issue.id}.`, visibleTo: { users: ['erin'] } })).id;
    const after = await lastEventId();
    const comment = await addComment(anna, issue.id, `Steps are in ${secret}.`);
    await runMentions(after);
    // People's own words stay as they wrote them: the id alone, which leads Ben to nothing.
    expect((await listComments(ben, issue.id)).find((c) => c.id === comment.id)?.text).toBe(`Steps are in ${secret}.`);
    expect((await failure(() => getArticle(ben, secret))).status).toBe(404);
    // An article that mentions the issue is listed only for those who see the article.
    expect((await articlesMentioningIssue(ben, issue.id)).map((a) => a.id)).not.toContain(secret);
    expect((await articlesMentioningIssue(erin, issue.id)).map((a) => a.id)).toContain(secret);
    // What mentions the article is listed for who sees it.
    expect((await getArticle(erin, secret)).mentionedIn.issues.map((i) => i.id)).toContain(issue.id);
    // Words an agent wrote name it only to those who see it, as hidden issues are.
    expect(await redactUnseenIds(ben, `See ${secret} and ${issue.id}`)).toBe(`See an article you can’t see and ${issue.id}`);
    expect(await redactUnseenIds(erin, `See ${secret}`)).toBe(`See ${secret}`);
  });
});

describe('over HTTP, and to an open live stream', () => {
  it('limits through its visibility endpoint, answering as missing in the same words', async () => {
    const app = createHttpApp(w.app);
    const annaToken = (await issueTokenFor(w.app.db, w.anna.id, { name: 'anna-kb', scopes: ['read', 'write'] })).token;
    const benToken = (await issueTokenFor(w.app.db, w.ben.id, { name: 'ben-kb', scopes: ['read', 'write'] })).token;
    const call = (token: string, method: string, path: string, body?: unknown) =>
      app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const made = (await (await call(annaToken, 'POST', '/articles', { project: 'BACK', title: 'Board minutes' })).json()) as { id: string };
    const limited = await call(annaToken, 'PUT', `/articles/${made.id}/visibility`, { visibleTo: { users: ['erin'], groups: [] } });
    expect(limited.status).toBe(200);
    expect(((await limited.json()) as { limited: boolean }).limited).toBe(true);
    const hidden = await call(benToken, 'GET', `/articles/${made.id}`);
    const missing = await call(benToken, 'GET', '/articles/BACK-A-999');
    expect(hidden.status).toBe(404);
    const words = (r: unknown, id: string) => JSON.stringify(r).replaceAll(id, 'X');
    expect(words(await hidden.json(), made.id)).toBe(words(await missing.json(), 'BACK-A-999'));
    expect((await call(benToken, 'PUT', `/articles/${made.id}/visibility`, { visibleTo: null })).status).toBe(404);
  });

  it('stops telling someone of an article once its limit is narrowed away from them', async () => {
    const app = createHttpApp(w.app);
    const token = (await issueTokenFor(w.app.db, w.ben.id, { name: 'ben-live', scopes: ['read'] })).token;
    const watched = (await createArticle(anna, { project: 'BACK', title: 'Office move plover' })).id;
    const stream = await openStream(app.request, token);
    try {
      const about = () => stream.events().filter((e) => (e.data as { article?: { id?: string } }).article?.id === watched);
      await updateArticle(anna, watched, { body: 'We move in May.' });
      await stream.waitFor((f) => f.data.includes(watched) && f.data.includes('article.updated'));
      const before = about().length;
      await setArticleVisibility(anna, watched, { users: ['erin'] });
      await updateArticle(anna, watched, { body: 'We move in June, to the fourth floor.' });
      // Something Ben does see comes after, so whatever was to come before it has come.
      const marker = await createIssue(anna, { project: 'BACK', summary: 'Plover marker' });
      await stream.waitFor((f) => f.data.includes(marker.id));
      expect(about().length).toBe(before);
      expect((await failure(() => getArticle(ben, watched))).status).toBe(404);
    } finally {
      await stream.close();
    }
  });
});
