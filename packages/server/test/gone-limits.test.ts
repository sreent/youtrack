/**
 * What was limited stays hidden once its issue is deleted (D37): a limited issue's history, the
 * links that name it, and a comment limited on a deleted issue are missing to anyone who doesn't
 * see all of its project, in the feed, the live stream, webhooks, reports and the inbox.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TrackerEvent } from '@a4a/shared';
import type { Ctx, UserRow } from '../src/context';
import { OutboxWorker } from '../src/events/worker';
import { notifierConsumer } from '../src/notify/notifier';
import { eventFeed } from '../src/services/activity';
import { eventLimited, eventSeen, projectAccess } from '../src/services/access';
import { addComment, setCommentVisibility } from '../src/services/comments';
import { createIssue, deleteIssue, setIssueVisibility, updateIssue } from '../src/services/issues';
import { linkIssues } from '../src/services/links';
import { addMember } from '../src/services/members';
import { listNotifications } from '../src/services/notifications';
import { createProject } from '../src/services/projects';
import { createdResolvedReport } from '../src/services/reports';
import { insertUser } from '../src/services/users';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let admin: Ctx;
let anna: Ctx; // reports the issues
let ben: Ctx; // outside every limit
let chloe: Ctx; // manages GONE
let erin: Ctx; // named on the limits
let outbox: OutboxWorker;

async function person(login: string, name: string): Promise<UserRow> {
  const u = await insertUser(w.app.db, { login, name, role: 'member' });
  w.app.schema.invalidate();
  return u;
}

/** The events in a project's feed that say a word, anywhere in them. */
const saying = async (ctx: Ctx, word: string) => (await eventFeed(ctx, { project: 'GONE', limit: 500 })).filter((e) => JSON.stringify(e).toLowerCase().includes(word));
const view = async (ctx: Ctx) => projectAccess(ctx);

beforeAll(async () => {
  w = await createWorld();
  admin = w.adminCtx;
  anna = w.as(w.anna);
  ben = w.as(w.ben);
  chloe = w.as(await person('chloe', 'Chloé Martin'));
  erin = w.as(await person('erin', 'Erin Hall'));
  await createProject(admin, { key: 'GONE', name: 'Gone' });
  await addMember(admin, 'GONE', { user: 'chloe', role: 'manager' });
  outbox = new OutboxWorker(w.app, [notifierConsumer(w.app)], {}, [], () => {});
  await outbox.drain();
});

afterAll(async () => {
  await w?.close();
});

describe('an issue deleted while it was limited', () => {
  let created: TrackerEvent;

  beforeAll(async () => {
    const plain = await createIssue(anna, { project: 'GONE', summary: 'Plain heron' });
    const secret = await createIssue(anna, { project: 'GONE', summary: 'Kestrel acquisition', visibleTo: { users: ['erin'] } });
    await updateIssue(anna, secret.id, { summary: 'Kestrel acquisition, final terms' });
    await addComment(anna, secret.id, 'Kestrel signs on Monday');
    await linkIssues(anna, plain.id, 'relates to', secret.id);
    // While it stands, D37 keeps it from Ben.
    expect(await saying(ben, 'kestrel')).toEqual([]);
    created = (await eventFeed(admin, { project: 'GONE', types: ['issue.created'] })).find((e) => e.issue?.id === secret.id)!;
    await deleteIssue(anna, secret.id);
  });

  it('keeps every event of it, and every link naming it, out of the feed of anyone who does not see all of its project', async () => {
    expect(await saying(ben, 'kestrel')).toEqual([]);
    // Who was in its limit lost it with the issue, as its deletion is told only to its managers.
    expect(await saying(erin, 'kestrel')).toEqual([]);
    const forManager = (await saying(chloe, 'kestrel')).map((e) => e.type);
    expect(forManager).toEqual(expect.arrayContaining(['issue.created', 'issue.updated', 'comment.created', 'link.created', 'issue.deleted']));
    expect((await saying(ben, 'heron')).length).toBeGreaterThan(0);
  });

  it('keeps its events from an open live stream and from webhooks', async () => {
    const s = await w.app.schema.get();
    expect(await eventSeen(await view(ben), w.app.db, s, created)).toBe(false);
    expect(await eventSeen(await view(erin), w.app.db, s, created)).toBe(false);
    expect(await eventSeen(await view(chloe), w.app.db, s, created)).toBe(true);
    expect(await eventLimited(w.app.db, s, created)).toBe(true);
  });

  it('counts for nothing in reports, but for who see all of its project', async () => {
    const createdIn = async (ctx: Ctx) => (await createdResolvedReport(ctx, { project: 'GONE' })).buckets.reduce((n, b) => n + b.created, 0);
    expect(await createdIn(chloe)).toBe((await createdIn(ben)) + 1);
  });
});

describe('the inbox, once an issue limited away from someone is deleted', () => {
  it('lists nothing of it, not even what it was called', async () => {
    const issue = await createIssue(anna, { project: 'GONE', summary: 'Osprey layoffs' });
    await updateIssue(anna, issue.id, { fields: { Assignee: 'ben' } });
    await outbox.drain();
    const named = async () => (await listNotifications(ben)).items.filter((n) => n.issue.summary.includes('Osprey'));
    expect((await named()).length).toBe(1);
    await setIssueVisibility(anna, issue.id, { visibleTo: { users: ['erin'], groups: [] } });
    await updateIssue(anna, issue.id, { fields: { Assignee: 'erin' } });
    expect(await named()).toEqual([]);
    await deleteIssue(anna, issue.id);
    await outbox.drain();
    expect(await named()).toEqual([]);
  });
});

describe('a comment limited on an issue that is deleted', () => {
  it('stays out of the feed and the live stream for anyone it was limited away from', async () => {
    const issue = await createIssue(anna, { project: 'GONE', summary: 'Plover office move' });
    const comment = await addComment(anna, issue.id, 'Plover lease costs 40k');
    // Limited after it was written: its first event says nothing of a limit.
    await setCommentVisibility(anna, comment.id, { users: ['erin'], groups: [] });
    const said = (await eventFeed(admin, { project: 'GONE', types: ['comment.created'] })).find((e) => (e.data as { commentId?: string }).commentId === comment.id)!;
    await deleteIssue(anna, issue.id);
    expect(await saying(ben, '40k')).toEqual([]);
    expect((await saying(chloe, '40k')).length).toBeGreaterThan(0);
    // The issue wasn't limited: its own history stays, for everyone who sees the project.
    expect((await saying(ben, 'plover office')).map((e) => e.type)).toEqual(expect.arrayContaining(['issue.created', 'issue.deleted']));
    const s = await w.app.schema.get();
    expect(await eventSeen(await view(ben), w.app.db, s, said)).toBe(false);
    expect(await eventLimited(w.app.db, s, said)).toBe(true);
  });
});
