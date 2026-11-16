/**
 * Access in depth (D37): an issue or a comment limited to some people and groups is missing to
 * everyone else, in the same words, wherever issues and comments are read; roles are sets of
 * permissions an administrator can add to; and a project can be read without signing in.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx, UserRow } from '../src/context';
import { OutboxWorker } from '../src/events/worker';
import { createHttpApp } from '../src/http/app';
import { AppError } from '../src/lib/errors';
import { notifierConsumer } from '../src/notify/notifier';
import { countIssues, searchIssues } from '../src/search/service';
import { issueActivity, eventFeed } from '../src/services/activity';
import { eventLimited } from '../src/services/access';
import { issueTokenFor } from '../src/services/auth';
import { addComment, deleteComment, listComments, setCommentVisibility, updateComment } from '../src/services/comments';
import { addGroupMember, createGroup } from '../src/services/groups';
import { createIssue, deleteIssue, getIssue, setIssueVisibility, updateIssue } from '../src/services/issues';
import { linkIssues } from '../src/services/links';
import { addMember, removeMember, updateMember } from '../src/services/members';
import { listNotifications } from '../src/services/notifications';
import { createProject, listProjects } from '../src/services/projects';
import { createRole, deleteRole, listRoles, updateRole } from '../src/services/roles';
import { insertUser } from '../src/services/users';
import { listWatchers } from '../src/services/watchers';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let admin: Ctx;
let anna: Ctx;
let ben: Ctx;
let chloe: Ctx; // manages BACK
let erin: Ctx; // named on the limited issue
let dan: Ctx; // in the Security group
let outbox: OutboxWorker;

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

async function person(login: string, name: string): Promise<UserRow> {
  const u = await insertUser(w.app.db, { login, name, role: 'member' });
  w.app.schema.invalidate();
  return u;
}

beforeAll(async () => {
  w = await createWorld();
  admin = w.adminCtx;
  anna = w.as(w.anna);
  ben = w.as(w.ben);
  chloe = w.as(await person('chloe', 'Chloé Martin'));
  erin = w.as(await person('erin', 'Erin Hall'));
  dan = w.as(await person('dan', 'Dan Iwu'));
  await addMember(admin, 'BACK', { user: 'chloe', role: 'manager' });
  await createGroup(admin, { name: 'Security' });
  await addGroupMember(admin, 'Security', 'dan');
  outbox = new OutboxWorker(w.app, [notifierConsumer(w.app)], {}, [], () => {});
  await outbox.drain();
});

afterAll(async () => {
  await w?.close();
});

describe('an issue limited to some people and groups', () => {
  let limitedId = '';
  let plainId = '';

  it('is missing to everyone else, in the words used for an issue that does not exist', async () => {
    const limited = await createIssue(anna, { project: 'BACK', summary: 'Breach at Initech kestrel', visibleTo: { users: ['erin'], groups: ['Security'] } });
    limitedId = limited.id;
    expect(limited.limited).toBe(true);
    expect(limited.visibleTo?.users.map((u) => u.login)).toEqual(['erin']);
    expect(limited.visibleTo?.groups.map((g) => g.name)).toEqual(['Security']);
    const hidden = await failure(() => getIssue(ben, limitedId));
    const missing = await failure(() => getIssue(ben, 'BACK-999'));
    expect(hidden.status).toBe(404);
    expect(hidden.message.replace(limitedId, 'X')).toBe(missing.message.replace('BACK-999', 'X'));
    expect(hidden.hint).toBe(missing.hint);
    // Who still sees it: an administrator, a manager, its reporter, the person and the group named.
    for (const who of [admin, chloe, anna, erin, dan]) expect((await getIssue(who, limitedId)).summary).toContain('kestrel');
  });

  it('never matches a search, nor counts, for anyone else', async () => {
    expect((await searchIssues(ben, 'kestrel')).total).toBe(0);
    expect((await searchIssues(erin, 'kestrel')).total).toBe(1);
    expect((await countIssues(ben, 'kestrel')).total).toBe(0);
    const backFor = async (ctx: Ctx) => (await listProjects(ctx)).find((p) => p.key === 'BACK')!.issueCount;
    expect(await backFor(erin)).toBe((await backFor(ben)) + 1);
  });

  it('is seen by whoever it is assigned to', async () => {
    await updateIssue(anna, limitedId, { fields: { Assignee: 'ben' } });
    expect((await getIssue(ben, limitedId)).id).toBe(limitedId);
    await updateIssue(anna, limitedId, { fields: { Assignee: null } });
    expect((await failure(() => getIssue(ben, limitedId))).status).toBe(404);
  });

  it('leaves its links, and their events, out for anyone else', async () => {
    const plain = await createIssue(anna, { project: 'BACK', summary: 'Rotate the keys' });
    plainId = plain.id;
    await linkIssues(anna, plainId, 'relates to', limitedId);
    expect((await getIssue(ben, plainId)).links).toEqual([]);
    expect((await getIssue(erin, plainId)).links.map((l) => l.issue.id)).toEqual([limitedId]);
    expect((await issueActivity(ben, plainId)).some((e) => e.type === 'link.created')).toBe(false);
    expect((await issueActivity(erin, plainId)).some((e) => e.type === 'link.created')).toBe(true);
  });

  it('keeps its events out of the feed, and out of the live stream', async () => {
    const feed = await eventFeed(ben, { project: 'BACK' });
    expect(feed.some((e) => e.issue?.id === limitedId)).toBe(false);
    expect((await eventFeed(erin, { project: 'BACK' })).some((e) => e.issue?.id === limitedId)).toBe(true);
    const created = (await eventFeed(admin, { project: 'BACK', types: ['issue.created'] })).find((e) => e.issue?.id === limitedId)!;
    expect(await eventLimited(w.app.db, await w.app.schema.get(), created)).toBe(true);
  });

  it('tells, and makes watch, only people who see it', async () => {
    await addComment(anna, limitedId, 'Over to @vera and @erin');
    await outbox.drain();
    const watchers = (await listWatchers(admin, limitedId)).watchers.map((x) => x.user.login);
    expect(watchers).toContain('erin');
    expect(watchers).not.toContain('vera');
    // Ben watched it while it was his; no longer seeing it, he hears nothing of it, nor finds it in his inbox.
    expect((await listNotifications(ben)).items.some((n) => n.issue.id === limitedId)).toBe(false);
    expect((await listNotifications(erin)).items.some((n) => n.issue.id === limitedId)).toBe(true);
  });

  it('can be widened and narrowed by whoever may edit it, and never away from themselves', async () => {
    const away = await failure(() => setIssueVisibility(erin, limitedId, { visibleTo: { users: [], groups: ['Security'] } }));
    expect(away.status).toBe(400);
    expect(away.message).toBe(`That would hide ${limitedId} from you`);
    const opened = await setIssueVisibility(anna, limitedId, { visibleTo: null });
    expect(opened.limited).toBe(false);
    expect((await getIssue(ben, limitedId)).id).toBe(limitedId);
    const history = await issueActivity(anna, limitedId);
    expect(history.some((e) => e.type === 'issue.updated' && e.changes?.some((c) => c.field === 'Visible to' && c.from === 'Erin Hall, Security' && c.to === null))).toBe(true);
    await setIssueVisibility(anna, limitedId, { visibleTo: { users: ['erin'], groups: [] } });
    expect((await failure(() => getIssue(dan, limitedId))).status).toBe(404);
    const unknown = await failure(() => setIssueVisibility(anna, limitedId, { visibleTo: { users: ['nobody-here'], groups: [] } }));
    expect(unknown.status).toBe(400);
  });

  it('stays hidden once deleted: only who saw all of its project see that it went', async () => {
    const gone = await createIssue(anna, { project: 'BACK', summary: 'Short-lived osprey', visibleTo: { users: [], groups: [] } });
    await deleteIssue(anna, gone.id);
    const deleted = (feed: { type: string; issue?: { id: string } | null }[]) => feed.some((e) => e.type === 'issue.deleted' && e.issue?.id === gone.id);
    expect(deleted(await eventFeed(ben, { project: 'BACK' }))).toBe(false);
    expect(deleted(await eventFeed(chloe, { project: 'BACK' }))).toBe(true);
  });
});

describe('a comment limited to some people', () => {
  let issueId = '';
  let commentId = '';

  it('is left out for everyone else: its issue, its count, search and the feed', async () => {
    issueId = (await createIssue(anna, { project: 'BACK', summary: 'Vendor rollout' })).id;
    const c = await addComment(anna, issueId, 'The heron quote is 40k', { visibleTo: { users: ['erin'] } });
    commentId = c.id;
    expect(c.visibleTo?.users.map((u) => u.login)).toEqual(['erin']);
    expect((await listComments(ben, issueId)).map((x) => x.id)).not.toContain(commentId);
    for (const who of [erin, anna, chloe, admin]) expect((await listComments(who, issueId)).map((x) => x.id)).toContain(commentId);
    expect((await getIssue(ben, issueId)).commentCount).toBe(0);
    expect((await getIssue(erin, issueId)).commentCount).toBe(1);
    expect((await searchIssues(ben, 'heron')).total).toBe(0);
    expect((await searchIssues(erin, 'heron')).total).toBe(1);
    const feed = await eventFeed(ben, { project: 'BACK', types: ['comment.created'] });
    expect(feed.some((e) => (e.data as { commentId?: string }).commentId === commentId)).toBe(false);
  });

  it('answers as missing to whoever does not see it, in the same words', async () => {
    const hidden = await failure(() => updateComment(ben, commentId, 'mine now'));
    const missing = await failure(() => updateComment(ben, 'no-such-comment', 'mine now'));
    expect(hidden).toEqual(missing);
    expect(await failure(() => deleteComment(ben, commentId))).toEqual(missing);
    expect(await failure(() => setCommentVisibility(ben, commentId, null))).toEqual(missing);
  });

  it('is limited, or opened, by its author or a manager; a public one is not', async () => {
    const opened = await setCommentVisibility(chloe, commentId, null);
    expect(opened.visibleTo).toBeNull();
    expect((await listComments(ben, issueId)).map((x) => x.id)).toContain(commentId);
    const notTheirs = await failure(() => setCommentVisibility(ben, commentId, { users: ['ben'] }));
    expect(notTheirs.status).toBe(403);
    const pub = await failure(() => addComment(anna, issueId, 'Hello', { visibility: 'public', visibleTo: { users: ['erin'] } }));
    expect(pub.status).toBe(400);
  });
});

describe('roles as sets of permissions', () => {
  it('lists the built-in three first, with what each allows', async () => {
    const roles = await listRoles(ben);
    expect(roles.slice(0, 3).map((r) => [r.id, r.builtin])).toEqual([
      ['manager', true],
      ['member', true],
      ['viewer', true],
    ]);
    expect(roles.find((r) => r.id === 'viewer')!.permissions).toEqual(['read', 'comment', 'costs']);
  });

  it('lets an administrator make one, and nobody else', async () => {
    expect((await failure(() => createRole(anna, { name: 'Reporter', permissions: ['read', 'create'] }))).status).toBe(403);
    const noRead = await failure(() => createRole(admin, { name: 'Ghost', permissions: ['create'] }));
    expect(noRead.status).toBe(400);
    const builtinName = await failure(() => createRole(admin, { name: 'manager', permissions: ['read'] }));
    expect(builtinName.status).toBe(409);
    const role = await createRole(admin, { name: 'Reporter', description: 'Files and comments', permissions: ['create', 'read', 'comment'] });
    expect(role.permissions).toEqual(['read', 'comment', 'create']);
    expect((await failure(() => createRole(admin, { name: 'reporter', permissions: ['read'] }))).status).toBe(409);
  });

  it('gives exactly its permissions in a project, as a person or a group has it', async () => {
    await createProject(admin, { key: 'OPS', name: 'Operations', template: 'software', visibility: 'members' });
    await addMember(admin, 'OPS', { user: 'ben', role: 'Reporter' });
    const ops = (await listProjects(ben)).find((p) => p.key === 'OPS')!;
    expect(ops.access.roleName).toBe('Reporter');
    expect(ops.access.permissions).toEqual(['read', 'comment', 'create']);
    const filed = await createIssue(ben, { project: 'OPS', summary: 'Disk full on db-2' });
    await addComment(ben, filed.id, 'Seen again at noon');
    const edit = await failure(() => updateIssue(ben, filed.id, { summary: 'Disk nearly full on db-2' }));
    expect(edit.status).toBe(403);
    expect(edit.message).toContain("Your role in OPS doesn't let you");
    expect((await failure(() => deleteIssue(ben, filed.id))).status).toBe(403);
  });

  it('changes what everyone with it may do at once', async () => {
    await updateRole(admin, 'Reporter', { permissions: ['read', 'comment', 'create', 'edit'] });
    const filed = (await searchIssues(ben, 'project: OPS')).items[0]!;
    expect((await updateIssue(ben, filed.id, { summary: 'Disk nearly full on db-2' })).summary).toBe('Disk nearly full on db-2');
  });

  it("can't be deleted while it is given, and the built-in ones can't be changed", async () => {
    expect((await failure(() => deleteRole(admin, 'Reporter'))).status).toBe(409);
    expect((await failure(() => updateRole(admin, 'manager', { permissions: ['read'] }))).status).toBe(400);
    await updateMember(admin, 'OPS', 'ben', { role: 'viewer' });
    await deleteRole(admin, 'Reporter');
    expect((await listRoles(admin)).some((r) => r.name === 'Reporter')).toBe(false);
    await removeMember(admin, 'OPS', 'ben');
  });
});

describe('over HTTP', () => {
  it('limits an issue and a comment through their visibility endpoints, and lists roles', async () => {
    const app = createHttpApp(w.app);
    const token = (await issueTokenFor(w.app.db, w.anna.id, { name: 'anna', scopes: ['read', 'write'] })).token;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(`/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
    };
    const issue = await createIssue(anna, { project: 'BACK', summary: 'Pay rises' });
    const put = await call('PUT', `/issues/${issue.id}/visibility`, { visibleTo: { users: ['erin'] } });
    expect(put.status).toBe(200);
    expect(put.body?.limited).toBe(true);
    const c = await call('POST', `/issues/${issue.id}/comments`, { text: 'Numbers attached', visibleTo: { groups: ['Security'] } });
    expect(c.status).toBe(201);
    expect((c.body?.visibleTo as { groups: { name: string }[] }).groups[0]!.name).toBe('Security');
    const lifted = await call('PUT', `/comments/${String(c.body?.id)}/visibility`, { visibleTo: null });
    expect(lifted.body?.visibleTo).toBeNull();
    const roles = await call('GET', '/roles');
    expect(roles.status).toBe(200);
  });
});
