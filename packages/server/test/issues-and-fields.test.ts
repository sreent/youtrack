/**
 * Issues and fields (D41): moving an issue to another project, whose old id keeps finding it;
 * cloning; votes and reactions; group, build, owned and date-and-time fields; and fields that show,
 * and are required, only while their issue matches a condition.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../src/context';
import { runCommand } from '../src/commands/executor';
import { createHttpApp } from '../src/http/app';
import { AppError } from '../src/lib/errors';
import { countIssues, searchIssues } from '../src/search/service';
import { eventFeed } from '../src/services/activity';
import { issueTokenFor } from '../src/services/auth';
import { addComment, listComments } from '../src/services/comments';
import { addFieldValue, attachField, createField, updateField, updateFieldValue } from '../src/services/fields';
import { createGroup } from '../src/services/groups';
import { createIssue, findIssue, getIssue, updateIssue } from '../src/services/issues';
import { addMember } from '../src/services/members';
import { mentionsConsumer, mentionsOf } from '../src/services/mentions';
import { cloneIssue, moveIssue } from '../src/services/move';
import { createProject } from '../src/services/projects';
import { fieldByName } from '../src/services/schema-cache';
import { reactToComment, reactToIssue, setVote } from '../src/services/votes';
import { toolByName } from '../src/tools/registry';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let admin: Ctx;
let anna: Ctx;
let ben: Ctx;

async function failure(call: () => Promise<unknown>): Promise<{ status: number; message: string; hint?: string; details?: unknown }> {
  try {
    await call();
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return { status: e.status, message: e.message, hint: e.hint, details: e.details };
  }
  throw new Error('expected it to fail');
}

/** What the outbox worker would hand the mentions consumer, for the events since `after`. */
async function runMentions(after: number) {
  const consumer = mentionsConsumer(w.app);
  for (const e of await eventFeed(w.adminCtx, { after, limit: 500 })) if (!consumer.types || consumer.types.includes(e.type)) await consumer.handle(e);
}
const lastEventId = async () => (await eventFeed(w.adminCtx, { limit: 1, order: 'desc' }))[0]?.id ?? 0;

const ids = async (ctx: Ctx, query: string) => (await searchIssues(ctx, query)).items.map((i) => i.id);
const field = (issue: { fields: { name: string; value: unknown; applies?: boolean }[] }, name: string) => issue.fields.find((f) => f.name === name);

beforeAll(async () => {
  w = await createWorld();
  admin = w.adminCtx;
  anna = w.as(w.anna);
  ben = w.as(w.ben);
});

afterAll(async () => {
  await w?.close();
});

describe('new field types', () => {
  it('a group field takes a group, by name, in fields, commands, queries and counts', async () => {
    await createGroup(admin, { name: 'Backend team' });
    await createGroup(admin, { name: 'Design' });
    const team = await createField(admin, { name: 'Team', type: 'group', multi: false, description: '', values: [] });
    await attachField(admin, 'BACK', team.id, {});
    const a = await createIssue(anna, { project: 'BACK', summary: 'Group field one', fields: { Team: 'backend team' } });
    expect(field(a, 'Team')?.value).toMatchObject({ name: 'Backend team' });
    const b = await createIssue(anna, { project: 'BACK', summary: 'Group field two' });
    await runCommand(anna, { issues: [b.id], command: 'Team Design', dryRun: false });
    expect(field(await getIssue(anna, b.id), 'Team')?.value).toMatchObject({ name: 'Design' });
    expect(await ids(anna, 'Team: {Backend team}')).toEqual([a.id]);
    expect(await ids(anna, 'has: Team sort by: Team')).toEqual([a.id, b.id]);
    const unknown = await failure(() => updateIssue(anna, a.id, { fields: { Team: 'Backend tem' } }));
    expect(unknown).toMatchObject({ status: 400, hint: expect.stringContaining('Backend team') });
    const counted = await countIssues(anna, 'project: BACK has: Team', 'Team');
    expect(counted.groups).toEqual(expect.arrayContaining([{ value: 'Backend team', count: 1 }, { value: 'Design', count: 1 }]));
  });

  it('a date-and-time field is a moment: typed in the asker\'s zone, asked about by the day', async () => {
    const deadline = await createField(admin, { name: 'Deadline', type: 'datetime', multi: false, description: '', values: [] });
    await attachField(admin, 'BACK', deadline.id, {});
    const a = await createIssue(anna, { project: 'BACK', summary: 'Moment one', fields: { Deadline: '2026-11-20 15:30' } });
    expect(field(a, 'Deadline')?.value).toBe('2026-11-20T15:30:00.000Z');
    const b = await createIssue(anna, { project: 'BACK', summary: 'Moment two', fields: { Deadline: '2026-11-19T23:00:00+01:00' } });
    expect(field(b, 'Deadline')?.value).toBe('2026-11-19T22:00:00.000Z');
    await runCommand(anna, { issues: [b.id], command: 'Deadline 2026-11-21 08:15', dryRun: false });
    expect(field(await getIssue(anna, b.id), 'Deadline')?.value).toBe('2026-11-21T08:15:00.000Z');
    expect(await ids(anna, 'Deadline: 2026-11-20')).toEqual([a.id]);
    expect(await ids(anna, 'Deadline: 2026-11-20 .. 2026-11-21 sort by: Deadline desc')).toEqual([b.id, a.id]);
    expect(await failure(() => updateIssue(anna, a.id, { fields: { Deadline: '2026-02-30 10:00' } }))).toMatchObject({ status: 400 });
  });

  it('a build field takes a build twice without complaint, so CI can report each one', async () => {
    const builds = await createField(admin, { name: 'Fixed in build', type: 'build', multi: false, description: '', values: [] });
    const first = await addFieldValue(admin, builds.id, { name: '2026.11.101' });
    const again = await addFieldValue(admin, builds.id, { name: '2026.11.101' });
    expect(again.id).toBe(first.id);
    await attachField(admin, 'BACK', builds.id, {});
    const a = await createIssue(anna, { project: 'BACK', summary: 'Built', fields: { 'Fixed in build': '2026.11.101' } });
    expect(await ids(anna, 'Fixed in build: 2026.11.101')).toEqual([a.id]);
  });

  it("an owned field's value has an owner, who takes an issue about it that nobody has", async () => {
    const s = await w.app.schema.get();
    const subsystem = fieldByName(s, 'Subsystem')!;
    expect(subsystem.type).toBe('owned');
    const api = (s.valuesByField.get(subsystem.id) ?? []).find((v) => v.name === 'API')!;
    const value = await updateFieldValue(admin, subsystem.id, api.id, { owner: 'ben' });
    expect(value.owner).toMatchObject({ login: 'ben' });
    // Made with it: assigned to its owner.
    const made = await createIssue(anna, { project: 'BACK', summary: 'Owned at birth', fields: { Subsystem: 'API' } });
    expect(field(made, 'Assignee')?.value).toMatchObject({ login: 'ben' });
    // Given it later, in the same change, with the assignee in its history.
    const later = await createIssue(anna, { project: 'BACK', summary: 'Owned later' });
    const changed = await updateIssue(anna, later.id, { fields: { Subsystem: 'API' } });
    expect(field(changed, 'Assignee')?.value).toMatchObject({ login: 'ben' });
    const feed = await eventFeed(anna, { issue: later.id });
    expect(feed.find((e) => e.type === 'issue.updated')?.changes.map((c) => c.field)).toEqual(expect.arrayContaining(['Subsystem', 'Assignee']));
    // Someone already has it, or the change says who does: the owner doesn't take it.
    const taken = await createIssue(anna, { project: 'BACK', summary: 'Taken', fields: { Assignee: 'anna' } });
    expect(field(await updateIssue(anna, taken.id, { fields: { Subsystem: 'API' } }), 'Assignee')?.value).toMatchObject({ login: 'anna' });
    const nobody = await createIssue(anna, { project: 'BACK', summary: 'Nobody', fields: { Subsystem: 'API', Assignee: null } });
    expect(field(nobody, 'Assignee')?.value).toBeNull();
    // An enum field becomes owned and back; nothing else does.
    const priority = fieldByName(s, 'Priority')!;
    expect((await updateField(admin, priority.id, { type: 'owned' })).type).toBe('owned');
    expect((await updateField(admin, priority.id, { type: 'enum' })).type).toBe('enum');
    expect(await failure(() => updateField(admin, fieldByName(s, 'State')!.id, { type: 'owned' }))).toMatchObject({ status: 400 });
  });
});

describe('conditional fields', () => {
  it('a field shows, and is required, only while its issue matches the condition', async () => {
    const s = await w.app.schema.get();
    const builds = fieldByName(s, 'Fixed in build')!;
    expect(await failure(() => attachField(admin, 'BACK', builds.id, { required: true, condition: 'State: Fixd' }))).toMatchObject({
      status: 400,
      hint: expect.stringContaining('Fixed'),
    });
    const attached = await attachField(admin, 'BACK', builds.id, { required: true, condition: 'State: Fixed' });
    expect(attached.find((f) => f.name === 'Fixed in build')?.condition).toBe('State: Fixed');
    // Leaving the condition out of a later call leaves it as it is.
    expect((await attachField(admin, 'BACK', builds.id, { required: true })).find((f) => f.name === 'Fixed in build')?.condition).toBe('State: Fixed');

    const open = await createIssue(anna, { project: 'BACK', summary: 'Needs a build when fixed', fields: { State: 'Open' } });
    expect(field(open, 'Fixed in build')).toMatchObject({ applies: false });
    const refused = await failure(() => updateIssue(anna, open.id, { fields: { State: 'Fixed' } }));
    expect(refused).toMatchObject({ status: 400, message: 'Fixed in build is required when State: Fixed', details: { requiredField: 'Fixed in build' } });
    expect(field(await getIssue(anna, open.id), 'State')?.value).toMatchObject({ name: 'Open' });
    const fixed = await updateIssue(anna, open.id, { fields: { State: 'Fixed', 'Fixed in build': '2026.11.101' } });
    expect(field(fixed, 'Fixed in build')).toMatchObject({ applies: true, value: { name: '2026.11.101' } });
    expect(await failure(() => updateIssue(anna, open.id, { fields: { 'Fixed in build': null } }))).toMatchObject({ status: 400 });
    // A comment on an issue that missed it before the condition existed is no change to refuse.
    expect(await failure(() => createIssue(anna, { project: 'BACK', summary: 'Born fixed', fields: { State: 'Fixed' } }))).toMatchObject({ status: 400 });
    const born = await createIssue(anna, { project: 'BACK', summary: 'Born fixed', fields: { State: 'Fixed', 'Fixed in build': '2026.11.101' } });
    expect(field(born, 'Fixed in build')).toMatchObject({ applies: true });
    await attachField(admin, 'BACK', builds.id, { required: false, condition: null });
  });
});

describe('votes and reactions', () => {
  it('people vote once each, not for what they reported, and the count sorts and searches', async () => {
    const a = await createIssue(admin, { project: 'WEB', summary: 'Wanted by many' });
    const b = await createIssue(admin, { project: 'WEB', summary: 'Wanted by one' });
    expect(await setVote(anna, a.id, true)).toEqual({ votes: 1, voted: true });
    expect(await setVote(anna, a.id, true)).toEqual({ votes: 1, voted: true });
    expect(await setVote(ben, a.id, true)).toEqual({ votes: 2, voted: true });
    expect(await setVote(ben, b.id, true)).toEqual({ votes: 1, voted: true });
    expect(await failure(() => setVote(admin, a.id, true))).toMatchObject({ status: 400 });
    const detail = await getIssue(anna, a.id);
    expect(detail).toMatchObject({ votes: 2, voted: true, version: a.version });
    expect(await ids(anna, 'project: WEB votes: 2')).toEqual([a.id]);
    expect(await ids(anna, 'project: WEB votes: 1 .. * sort by: votes desc')).toEqual([a.id, b.id]);
    expect(await ids(anna, 'project: WEB voter: me')).toEqual([a.id]);
    expect(await setVote(anna, a.id, false)).toEqual({ votes: 1, voted: false });
    expect(await ids(anna, 'project: WEB has: votes sort by: votes')).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it('reactions toggle, on the description and on comments, and say who', async () => {
    const issue = await createIssue(admin, { project: 'WEB', summary: 'React to me' });
    expect(await reactToIssue(anna, issue.id, '👍')).toEqual([{ emoji: '👍', count: 1, mine: true, people: [expect.objectContaining({ login: 'anna' })] }]);
    await reactToIssue(ben, issue.id, '👍');
    await reactToIssue(ben, issue.id, '🎉');
    const seen = await getIssue(anna, issue.id);
    expect(seen.reactions.map((r) => [r.emoji, r.count, r.mine])).toEqual([
      ['👍', 2, true],
      ['🎉', 1, false],
    ]);
    expect((await reactToIssue(anna, issue.id, '👍')).map((r) => [r.emoji, r.count])).toEqual([
      ['👍', 1],
      ['🎉', 1],
    ]);
    const comment = await addComment(anna, issue.id, 'Looks good');
    expect(comment.reactions).toEqual([]);
    await reactToComment(ben, comment.id, '❤️');
    expect((await listComments(anna, issue.id))[0]!.reactions).toEqual([{ emoji: '❤️', count: 1, mine: false, people: [expect.objectContaining({ login: 'ben' })] }]);
  });
});

describe('moving and cloning', () => {
  it("moves an issue: the next number there, its values by name, problems first, and its old id still finds it", async () => {
    const issue = await createIssue(anna, {
      project: 'BACK',
      summary: 'Belongs in the web app',
      description: 'The login page.',
      fields: { Priority: 'Critical', Subsystem: 'Auth', Assignee: 'anna' },
      tags: ['moving'],
    });
    await addComment(anna, issue.id, 'It is a web thing');
    const old = issue.id;
    const before = await lastEventId();
    const mentioning = await createIssue(ben, { project: 'BACK', summary: 'Mentions it', description: `See ${old}.` });
    await runMentions(before);

    const plan = await moveIssue(anna, old, { project: 'WEB', dryRun: true });
    expect(plan).toMatchObject({ from: old, moved: false, project: { key: 'WEB' } });
    expect(plan.problems).toEqual([expect.objectContaining({ field: 'Subsystem', choices: ['UI'] })]);
    const refused = await failure(() => moveIssue(anna, old, { project: 'WEB' }));
    expect(refused).toMatchObject({ status: 400, message: expect.stringContaining('Subsystem "Auth"') });
    expect((await getIssue(anna, old)).id).toBe(old);

    const moved = await moveIssue(anna, old, { project: 'WEB', fields: { Subsystem: 'UI' } });
    expect(moved).toMatchObject({ from: old, moved: true, problems: [] });
    expect(moved.to).toMatch(/^WEB-\d+$/);
    const now = await getIssue(anna, old);
    expect(now).toMatchObject({ id: moved.to, uid: issue.uid, formerIds: [old], project: { key: 'WEB' } });
    expect(field(now, 'Priority')?.value).toMatchObject({ name: 'Critical' });
    expect(field(now, 'Subsystem')?.value).toMatchObject({ name: 'UI' });
    expect(now.tags.map((t) => t.name)).toEqual(['moving']);
    expect(await listComments(anna, old)).toHaveLength(1);
    expect((await findIssue(w.app.db, await w.app.schema.get(), old))?.id).toBe(issue.uid);
    // The query language, mentions and history follow it.
    expect(await ids(anna, `issue id: ${old}`)).toEqual([moved.to]);
    expect(await ids(anna, old)).toContain(moved.to);
    expect((await mentionsOf(anna, moved.to)).issues.map((i) => i.id)).toEqual([mentioning.id]);
    const since = await lastEventId();
    const later = await createIssue(ben, { project: 'BACK', summary: 'Mentions the old id later', description: `Like ${old}` });
    await runMentions(since);
    expect((await mentionsOf(anna, moved.to)).issues.map((i) => i.id).sort()).toEqual([mentioning.id, later.id].sort());
    const feed = await eventFeed(anna, { issue: moved.to });
    expect(feed.find((e) => e.type === 'issue.moved')).toMatchObject({ data: { from: old, to: moved.to } });
    // Its old number is never given out again.
    const next = await createIssue(anna, { project: 'BACK', summary: 'After the move' });
    expect(next.id).not.toBe(old);
    // Moving back gives it a new number in BACK, and both old ids still find it.
    const back = await moveIssue(anna, moved.to, { project: 'BACK', fields: { Subsystem: 'Auth' } });
    expect(back.to).not.toBe(old);
    expect((await getIssue(anna, moved.to)).formerIds).toEqual([old, moved.to]);
  });

  it('takes the right to change issues in both projects', async () => {
    await createProject(admin, { key: 'OPS', name: 'Operations', template: 'software', visibility: 'members' });
    await addMember(admin, 'OPS', { user: 'ben', role: 'viewer' });
    const issue = await createIssue(ben, { project: 'BACK', summary: 'Ben may not move this to OPS' });
    expect(await failure(() => moveIssue(ben, issue.id, { project: 'OPS' }))).toMatchObject({ status: 403 });
    // A project someone can't see answers as one that doesn't exist.
    expect(await failure(() => moveIssue(anna, issue.id, { project: 'OPS' }))).toMatchObject({ status: 404 });
    expect(await failure(() => moveIssue(w.as(w.viewer), issue.id, { project: 'WEB' }))).toMatchObject({ status: 403 });
  });

  it('clones an issue: its words, values and tags, linked back, and nothing else', async () => {
    const parent = await createIssue(anna, { project: 'BACK', summary: 'Parent' });
    const original = await createIssue(anna, {
      project: 'BACK',
      summary: 'Clone me',
      description: 'Steps to reproduce.',
      fields: { Priority: 'Major', Subsystem: 'Database' },
      tags: ['cloned'],
      parent: parent.id,
    });
    await addComment(anna, original.id, 'Stays with the original');
    await setVote(ben, original.id, true);
    const copy = await cloneIssue(ben, original.id, {});
    expect(copy).toMatchObject({ summary: 'Clone me', description: 'Steps to reproduce.', reporter: { login: 'ben' }, votes: 0, parent: { id: parent.id } });
    expect(copy.id).not.toBe(original.id);
    expect(field(copy, 'Priority')?.value).toMatchObject({ name: 'Major' });
    expect(field(copy, 'Subsystem')?.value).toMatchObject({ name: 'Database' });
    expect(copy.tags.map((t) => t.name)).toEqual(['cloned']);
    expect(copy.links.map((l) => `${l.phrase} ${l.issue.id}`)).toEqual(expect.arrayContaining([`clones ${original.id}`]));
    expect((await getIssue(anna, original.id)).links.map((l) => `${l.phrase} ${l.issue.id}`)).toEqual(expect.arrayContaining([`is cloned by ${copy.id}`]));
    expect(await listComments(anna, copy.id)).toEqual([]);
    // Into another project: what doesn't carry over is left to its defaults.
    const elsewhere = await cloneIssue(anna, original.id, { project: 'WEB', summary: 'Clone me, on the web' });
    expect(elsewhere).toMatchObject({ project: { key: 'WEB' }, summary: 'Clone me, on the web' });
    expect(field(elsewhere, 'Subsystem')?.value).toBeNull();
    expect(field(elsewhere, 'Priority')?.value).toMatchObject({ name: 'Major' });
  });

  it('over MCP and HTTP', async () => {
    const issue = await createIssue(admin, { project: 'BACK', summary: 'Moved by an agent', fields: { Subsystem: 'API' } });
    const dry = await toolByName('move_issue')!.run(anna, { issue: issue.id, project: 'WEB', dry_run: true });
    expect(dry.data).toMatchObject({ moved: false, problems: [expect.objectContaining({ field: 'Subsystem' })] });
    const done = await toolByName('move_issue')!.run(anna, { issue: issue.id, project: 'WEB', fields: { Subsystem: null } });
    expect(done.data).toMatchObject({ from: issue.id, moved: true });
    const voted = await toolByName('vote_issue')!.run(ben, { issue: issue.id, vote: true });
    expect(voted.data).toEqual({ votes: 1, voted: true });
    const cloned = await toolByName('clone_issue')!.run(ben, { issue: issue.id });
    expect(cloned.summary).toMatch(/^Cloned BACK-\d+ as WEB-\d+$/);

    const app = createHttpApp(w.app);
    const token = (await issueTokenFor(w.app.db, w.anna.id, { name: 't-anna', scopes: ['read', 'write'] })).token;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(`/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    // Its old id, in an address.
    const got = await call('GET', `/issues/${issue.id}`);
    expect(got).toMatchObject({ status: 200, body: { formerIds: [issue.id], votes: 1 } });
    expect(await call('POST', `/issues/${issue.id}/vote`)).toMatchObject({ status: 200, body: { votes: 2, voted: true } });
    expect(await call('DELETE', `/issues/${issue.id}/vote`)).toMatchObject({ status: 200, body: { votes: 1, voted: false } });
    expect(await call('POST', `/issues/${issue.id}/reactions`, { emoji: '🚀' })).toMatchObject({ status: 200, body: [{ emoji: '🚀', count: 1, mine: true }] });
    expect(await call('POST', `/issues/${issue.id}/reactions`, { emoji: '🦄' })).toMatchObject({ status: 400 });
    const plan = await call('POST', `/issues/${got.body.id}/move`, { project: 'BACK', dryRun: true });
    expect(plan).toMatchObject({ status: 200, body: { from: got.body.id, moved: false } });
    const copy = await call('POST', `/issues/${got.body.id}/clone`, {});
    expect(copy).toMatchObject({ status: 201, body: { summary: 'Moved by an agent' } });
  });
});
