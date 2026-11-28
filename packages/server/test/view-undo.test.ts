/**
 * Undo for a person's change made in a view (D34's revisit): kept as an agent's is, undone by its
 * author alone, a group all at once or not at all, pruned after 30 days. Runs on PGlite, and on
 * Postgres with TEST_DATABASE_URL, where the races run too.
 */
import type { IssueDetail, TrackerEvent } from '@a4a/shared';
import { sayProblem, type ProblemSaid } from '@a4a/shared/i18n';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemCtx } from '../src/app-services';
import { runCommand } from '../src/commands/executor';
import type { Ctx } from '../src/context';
import type { Db } from '../src/db/client';
import { agentChanges, issues } from '../src/db/schema';
import { OutboxWorker } from '../src/events/worker';
import { createHttpApp } from '../src/http/app';
import { translatorFor } from '../src/i18n';
import { AppError } from '../src/lib/errors';
import { issueActivity } from '../src/services/activity';
import { pruneViewEdits } from '../src/services/agent-changes';
import { undoAgentChange } from '../src/services/agents';
import { issueTokenFor } from '../src/services/auth';
import { applyChanges, createIssue, fieldValuesOf, getIssue, updateIssue } from '../src/services/issues';
import { deleteLinkById, linkIssues } from '../src/services/links';
import { fieldByName } from '../src/services/schema-cache';
import { presentField } from '../src/tools/registry';
import { RuleEngine } from '../src/workflow/engine';
import { createRule } from '../src/workflow/rules';
import { createWorld, type TestWorld } from './helpers';

const ON_POSTGRES = Boolean(process.env.TEST_DATABASE_URL);
let w: TestWorld;
let anna: Ctx;
let ben: Ctx;

const value = (i: IssueDetail, name: string) => presentField(i.fields.find((f) => f.name === name)!);
const priorities = async (ids: string[]) => Promise.all(ids.map(async (id) => value(await getIssue(w.adminCtx, id), 'Priority')));
const updates = async (ctx: Ctx, issue: string): Promise<TrackerEvent[]> => (await issueActivity(ctx, issue)).filter((e) => e.type === 'issue.updated');

/** What a call that should fail threw, started only when awaited. */
async function failure(attempt: Promise<unknown>): Promise<AppError> {
  try {
    await attempt;
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error('it succeeded');
}

async function three(summary: string): Promise<IssueDetail[]> {
  const made: IssueDetail[] = [];
  // One at a time, so their numbers follow the list's order.
  for (const n of [1, 2, 3]) made.push(await createIssue(anna, { project: 'BACK', summary: `${summary} ${n}`, fields: { Priority: 'Normal' } }));
  return made;
}

/** A command on the list's chosen issues: one group, its answer naming what undoes it. */
async function inList(ctx: Ctx, list: IssueDetail[], command: string) {
  const res = await runCommand(ctx, { issues: list.map((i) => i.id), command, view: { name: 'list' } });
  expect(res.results.flatMap((r) => r.errors)).toEqual([]);
  return res;
}

/** Until some statement waits on a lock another transaction holds. */
async function untilWaiting(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const waiting = (await w.app.db.execute(sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`)) as unknown as { rows: { n: number }[] };
    if ((waiting.rows[0]?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('nothing waited on a lock');
}

beforeAll(async () => {
  w = await createWorld();
  anna = w.as(w.anna);
  ben = w.as(w.ben);
});

afterAll(async () => {
  await w?.close();
});

describe('a change made in a view', () => {
  it('is undone by its author, and to anyone else there is nothing to undo there', async () => {
    const issue = await createIssue(anna, { project: 'BACK', summary: 'Typed in a cell', fields: { Priority: 'Normal' } });
    const done = await updateIssue(anna, issue.id, { fields: { Priority: 'Major' }, view: { name: 'table' } });
    const [change] = await updates(anna, issue.id);
    expect(done.undo).toEqual({ event: change!.id });
    expect(change!.data.view).toBe('table');
    expect(change!.undo).toEqual({ state: 'possible', note: '', noteWords: [], by: 'author' });
    // Ben sees the change, and no undo on it: it's Anna's.
    const [seen] = await updates(ben, issue.id);
    expect(seen!.id).toBe(change!.id);
    expect(seen!.undo).toBeUndefined();

    // To Ben it answers as a person's own change does: in the same words.
    const own = await updateIssue(ben, (await createIssue(anna, { project: 'BACK', summary: 'Plain' })).id, { fields: { Priority: 'Minor' } });
    const [plain] = await updates(ben, own.id);
    const asOwn = await failure(undoAgentChange(ben, plain!.id));
    const asView = await failure(undoAgentChange(ben, change!.id));
    expect([asView.status, asView.code, asView.message, asView.hint]).toEqual([asOwn.status, asOwn.code, asOwn.message, asOwn.hint]);
    expect([asView.status, asView.code]).toEqual([400, 'not_undoable']);
    expect(value(await getIssue(w.adminCtx, issue.id), 'Priority')).toBe('Major');

    const undone = await undoAgentChange(anna, change!.id);
    expect(undone).toMatchObject({ undoes: change!.id, changes: [{ field: 'Priority', from: 'Major', to: 'Normal' }] });
    expect(undone.group).toBeUndefined();
    const [, back] = await updates(anna, issue.id);
    expect(back!.data.undoes).toBe(change!.id);
    expect(back!.actor).toMatchObject({ login: 'anna', isBot: false });
    expect(back!.undo).toBeUndefined();
    expect((await updates(anna, issue.id))[0]!.undo).toMatchObject({ state: 'undone', note: 'Anna Schmidt undid it', by: 'author' });
    const again = await failure(undoAgentChange(anna, change!.id));
    expect([again.status, again.code, again.message]).toEqual([409, 'already_undone', 'Anna Schmidt undid it already']);
  });

  it('keeps nothing for a dry run, or when nothing changed', async () => {
    const issue = await createIssue(anna, { project: 'BACK', summary: 'Same value', fields: { Priority: 'Normal' } });
    const same = await updateIssue(anna, issue.id, { fields: { Priority: 'Normal' }, view: { name: 'table' } });
    expect(same.undo).toBeUndefined();
    const tried = await runCommand(anna, { issues: [issue.id], command: 'Priority Major', view: { name: 'list' }, dryRun: true });
    expect(tried.undo).toBeUndefined();
    expect(await w.app.db.select().from(agentChanges).where(eq(agentChanges.issueId, issue.uid))).toEqual([]);
  });

  it('is an agent’s change still when the assistant made it, which anyone who may change the issue undoes', async () => {
    const issue = await createIssue(anna, { project: 'BACK', summary: 'Read from words', fields: { Priority: 'Normal' } });
    await updateIssue(systemCtx(w.app, w.anna, 'assistant'), issue.id, { fields: { Priority: 'Critical' }, view: { name: 'list' } });
    const [change] = await updates(ben, issue.id);
    expect(change!.undo).toEqual({ state: 'possible', note: '', noteWords: [], by: 'anyone' });
    await undoAgentChange(ben, change!.id);
    expect(value(await getIssue(w.adminCtx, issue.id), 'Priority')).toBe('Normal');
  });
});

describe('a command on the list’s chosen issues', () => {
  it('is one group, undone as one', async () => {
    const list = await three('Group undo');
    const ran = await inList(anna, list, 'Priority Critical');
    expect(ran.applied).toBe(true);
    expect(ran.undo?.group).toMatch(/^[A-Za-z0-9_-]+$/);
    const events = await Promise.all(list.map(async (i) => (await updates(anna, i.id))[0]!));
    expect(events.map((e) => e.undo?.group)).toEqual([ran.undo!.group, ran.undo!.group, ran.undo!.group]);
    expect(events[1]!.undo).toMatchObject({ state: 'possible', by: 'author' });
    expect(events[1]!.undo!.others).toEqual([list[0]!.id, list[2]!.id]);
    expect(events.map((e) => e.id)).toContain(ran.undo!.event);

    // From any of its issues, all three go back.
    const undone = await undoAgentChange(anna, events[1]!.id);
    expect(undone.group).toBe(ran.undo!.group);
    expect(undone.issues!.map((i) => i.id).sort()).toEqual(list.map((i) => i.id).sort());
    expect(await priorities(list.map((i) => i.id))).toEqual(['Normal', 'Normal', 'Normal']);
    for (const i of list) expect((await updates(anna, i.id))[0]!.undo!.state).toBe('undone');
    const again = await failure(undoAgentChange(anna, events[2]!.id));
    expect([again.status, again.code]).toEqual([409, 'already_undone']);
  });

  it('undoes nothing when one of its issues changed since, and names what and who', async () => {
    const list = await three('Changed since');
    const ran = await inList(anna, list, 'Priority Critical');
    await updateIssue(ben, list[2]!.id, { fields: { Priority: 'Minor' } });
    const [first] = await updates(anna, list[0]!.id);
    const why = `${list[2]!.id}: Priority is Minor now: Ben Okafor changed it since`;
    expect(first!.undo).toMatchObject({ state: 'changed_since', note: why.charAt(0).toUpperCase() + why.slice(1) });
    const e = await failure(undoAgentChange(anna, ran.undo!.event));
    expect([e.status, e.code, e.message]).toEqual([409, 'changed_since', `Nothing was undone: ${why}`]);
    // A page says it in its person's language (D49), the issue with each reason.
    expect(sayProblem(translatorFor('en'), e.words as ProblemSaid)).toBe(
      `Nothing was undone. ${list[2]!.id}: Priority is Minor now: Ben Okafor changed it since. Change it on the issue instead, if it should change.`,
    );
    expect(sayProblem(translatorFor('de'), e.words as ProblemSaid)).toContain(`${list[2]!.id}: Priority ist jetzt Minor: Ben Okafor hat es inzwischen geändert.`);
    expect(await priorities(list.map((i) => i.id))).toEqual(['Critical', 'Critical', 'Minor']);
  });

  it('changes every issue or none: one that can’t change stops them all', async () => {
    const back = await createIssue(anna, { project: 'BACK', summary: 'Has a subsystem', fields: { Priority: 'Normal' } });
    const web = await createIssue(anna, { project: 'WEB', summary: 'Has none of BACK’s' });
    const ran = await runCommand(anna, { issues: [back.id, web.id], command: 'Subsystem API', view: { name: 'list' } });
    expect(ran.applied).toBe(false);
    expect(ran.undo).toBeUndefined();
    expect(ran.results.find((r) => r.issue === web.id)!.errors).toHaveLength(1);
    expect(ran.results.find((r) => r.issue === back.id)).toMatchObject({ changes: [], errors: [] });
    expect(value(await getIssue(w.adminCtx, back.id), 'Subsystem')).toBeNull();
  });

  it('undoes nothing of a group whose issue its author can no longer see, and says so without naming it', async () => {
    const mine = await createIssue(anna, { project: 'BACK', summary: 'Seen', fields: { Priority: 'Normal' } });
    const limited = await createIssue(ben, { project: 'BACK', summary: 'Soon hidden', fields: { Priority: 'Normal' } });
    const ran = await inList(anna, [mine, limited], 'Priority Major');
    await w.app.db.update(issues).set({ limited: true, visibleUserIds: [w.ben.id], visibleGroupIds: [] }).where(eq(issues.id, limited.uid));
    const e = await failure(undoAgentChange(anna, ran.undo!.event));
    expect([e.status, e.code, e.message]).toEqual([409, 'changed_since', 'Nothing was undone: one of its issues is no longer one you can see']);
    expect(e.message).not.toContain(limited.id);
    expect(value(await getIssue(w.adminCtx, mine.id), 'Priority')).toBe('Major');
  });
});

describe('a link made in a view', () => {
  it('is taken away by its undo, and one taken away is made again', async () => {
    const a = await createIssue(anna, { project: 'BACK', summary: 'Bar dragged' });
    const b = await createIssue(anna, { project: 'BACK', summary: 'Onto this bar' });
    const links = await linkIssues(anna, a.id, 'depends on', b.id, false, { name: 'timeline' });
    const made = links.find((l) => l.issue.id === b.id)!;
    expect(made.undo).toBeDefined();
    const there = (await issueActivity(anna, b.id)).find((e) => e.type === 'link.created')!;
    expect(there.undo).toMatchObject({ state: 'possible', by: 'author' });
    expect((await issueActivity(ben, b.id)).find((e) => e.type === 'link.created')!.undo).toBeUndefined();
    await undoAgentChange(anna, made.undo!.event);
    expect((await getIssue(w.adminCtx, a.id)).links).toEqual([]);

    await linkIssues(anna, a.id, 'depends on', b.id);
    const linkId = (await getIssue(w.adminCtx, a.id)).links[0]!.id;
    const removed = await deleteLinkById(anna, linkId, { name: 'timeline' });
    expect((await getIssue(w.adminCtx, a.id)).links).toEqual([]);
    await undoAgentChange(anna, removed!.event);
    expect((await getIssue(w.adminCtx, a.id)).links.map((l) => [l.phrase, l.issue.id])).toEqual([['depends on', b.id]]);
  });

  it('and fields in one call are one group of their own', async () => {
    const a = await createIssue(anna, { project: 'BACK', summary: 'Both at once', fields: { Priority: 'Normal' } });
    const b = await createIssue(anna, { project: 'BACK', summary: 'Its predecessor' });
    const ran = await runCommand(anna, { issues: [a.id], command: `Priority Major depends on ${b.id}`, view: { name: 'timeline' } });
    expect(ran.undo?.group).toBeDefined();
    await undoAgentChange(anna, ran.undo!.event);
    const now = await getIssue(w.adminCtx, a.id);
    expect([value(now, 'Priority'), now.links]).toEqual(['Normal', []]);
  });
});

describe('what undoing a view edit needs', () => {
  it('goes after 30 days, while an agent’s stays', async () => {
    const issue = await createIssue(anna, { project: 'BACK', summary: 'Pruned', fields: { Priority: 'Normal' } });
    const viewEdit = await updateIssue(anna, issue.id, { fields: { Priority: 'Major' }, view: { name: 'table' } });
    await updateIssue(systemCtx(w.app, w.anna, 'mcp'), issue.id, { fields: { State: 'In Progress' } });
    const kept = async () => (await w.app.db.select({ kind: agentChanges.kind }).from(agentChanges).where(eq(agentChanges.issueId, issue.uid))).map((r) => r.kind).sort();
    expect(await kept()).toEqual(['agent', 'view']);
    const day = 86_400_000;
    // The clock is passed: 29 days on, it's kept; 31 days on, the view edit's has gone.
    const [row] = await w.app.db.select({ at: agentChanges.createdAt }).from(agentChanges).where(and(eq(agentChanges.issueId, issue.uid), eq(agentChanges.kind, 'view')));
    expect(await pruneViewEdits(w.app.db, new Date(row!.at.getTime() + 29 * day))).toBe(0);
    expect(await kept()).toEqual(['agent', 'view']);
    await pruneViewEdits(w.app.db, new Date(row!.at.getTime() + 31 * day));
    expect(await kept()).toEqual(['agent']);
    const [change] = await updates(anna, issue.id);
    expect(change!.undo).toBeUndefined();
    expect((await failure(undoAgentChange(anna, viewEdit.undo!.event))).code).toBe('not_undoable');
  });
});

describe('rules', () => {
  it('don’t run on an undo, though they run on the edit and on the same change made by hand', async () => {
    const engine = new RuleEngine(w.app, () => {});
    const worker = new OutboxWorker(w.app, [engine.consumer()], {}, [], () => {});
    await worker.drain();
    await createRule(w.adminCtx, { project: 'BACK', name: 'Back to normal is noted', kind: 'change', trigger: 'updated', query: 'Priority: Normal', command: 'tag normal-again' });
    const drain = async () => {
      for (let i = 0; i < 4; i++) await worker.drain();
    };
    const undone = await createIssue(anna, { project: 'BACK', summary: 'Undone in a view', fields: { Priority: 'Normal' } });
    const byHand = await createIssue(anna, { project: 'BACK', summary: 'Changed back by hand', fields: { Priority: 'Normal' } });
    await drain();
    const edit = await updateIssue(anna, undone.id, { fields: { Priority: 'Critical' }, view: { name: 'table' } });
    await updateIssue(anna, byHand.id, { fields: { Priority: 'Critical' } });
    await drain();
    await undoAgentChange(anna, edit.undo!.event);
    await updateIssue(anna, byHand.id, { fields: { Priority: 'Normal' } });
    await drain();
    const tagsOf = async (id: string) => (await getIssue(w.adminCtx, id)).tags.map((t) => t.name);
    expect(value(await getIssue(w.adminCtx, undone.id), 'Priority')).toBe('Normal');
    expect(await tagsOf(undone.id)).toEqual([]);
    expect(await tagsOf(byHand.id)).toEqual(['normal-again']);
    await worker.stop();
  });
});

describe('races, on Postgres', () => {
  it.runIf(ON_POSTGRES)('two undos of one group leave exactly one, and the other is told it was undone', async () => {
    for (let round = 0; round < 4; round++) {
      const list = await three(`Raced undo ${round}`);
      const ran = await inList(anna, list, 'Priority Critical');
      const [one, other] = await Promise.all([updates(anna, list[0]!.id), updates(anna, list[2]!.id)]);
      const outcomes = await Promise.allSettled([undoAgentChange(anna, one[0]!.id), undoAgentChange(anna, other[0]!.id)]);
      const won = outcomes.filter((o) => o.status === 'fulfilled');
      const lost = outcomes.flatMap((o) => (o.status === 'rejected' ? [o.reason as AppError] : []));
      expect(won).toHaveLength(1);
      expect(lost.map((e) => [e.status, e.code])).toEqual([[409, 'already_undone']]);
      expect(await priorities(list.map((i) => i.id))).toEqual(['Normal', 'Normal', 'Normal']);
      for (const i of list) expect((await updates(anna, i.id)).filter((e) => e.data.undoes !== undefined)).toHaveLength(1);
      expect(ran.undo!.group).toBeDefined();
    }
  });

  it.runIf(ON_POSTGRES)('an undo waits for an edit to one of its issues, then undoes nothing and says who changed what', async () => {
    const list = await three('Raced edit');
    const ran = await inList(anna, list, 'Priority Critical');
    const s = await w.app.schema.get();
    let commit!: () => void;
    let editing!: () => void;
    const held = new Promise<void>((r) => (commit = r));
    const begun = new Promise<void>((r) => (editing = r));
    // Ben's edit to the second issue holds its row while the undo starts.
    const edit = w.app.db.transaction(async (tx) => {
      const [row] = await tx.select().from(issues).where(eq(issues.id, list[1]!.uid));
      await applyChanges(tx as unknown as Db, ben, row!, { fields: [{ field: fieldByName(s, 'Priority')!, mode: 'set', values: [{ valueId: [...s.values.values()].find((v) => v.name === 'Minor' && v.fieldId === fieldByName(s, 'Priority')!.id)!.id }] }] });
      editing();
      await held;
    });
    await begun;
    const undoing = failure(undoAgentChange(anna, ran.undo!.event));
    await untilWaiting();
    commit();
    await edit;
    const e = await undoing;
    expect([e.status, e.code, e.message]).toEqual([409, 'changed_since', `Nothing was undone: ${list[1]!.id}: Priority is Minor now: Ben Okafor changed it since`]);
    expect(await priorities(list.map((i) => i.id))).toEqual(['Critical', 'Minor', 'Critical']);
    expect((await fieldValuesOf(w.app.db, list[0]!.uid)).size).toBeGreaterThan(0);
  });
});

describe('over HTTP', () => {
  it('takes `view` on PATCH, the link routes and commands, and answers what undoes it', async () => {
    const app = createHttpApp(w.app);
    const annaToken = (await issueTokenFor(w.app.db, w.anna.id, { name: 'anna', scopes: ['read', 'write'] })).token;
    const benToken = (await issueTokenFor(w.app.db, w.ben.id, { name: 'ben', scopes: ['read', 'write'] })).token;
    const call = async (method: string, path: string, token: string, body?: unknown) => {
      const res = await app.request(`/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const a = (await call('POST', '/issues', annaToken, { project: 'BACK', summary: 'Over HTTP a', fields: { Priority: 'Normal' } })).body;
    const b = (await call('POST', '/issues', annaToken, { project: 'BACK', summary: 'Over HTTP b', fields: { Priority: 'Normal' } })).body;

    const patched = await call('PATCH', `/issues/${a.id}`, annaToken, { fields: { Priority: 'Major' }, view: { name: 'table' } });
    expect(patched.status).toBe(200);
    expect(patched.body.undo).toEqual({ event: expect.any(Number) });
    expect((await call('PATCH', `/issues/${a.id}`, annaToken, { fields: { Priority: 'Minor' }, view: { name: 'gantt' } })).status).toBe(400);
    expect((await call('POST', `/events/${patched.body.undo.event}/undo`, benToken)).body.error.code).toBe('not_undoable');
    expect((await call('POST', `/events/${patched.body.undo.event}/undo`, annaToken)).status).toBe(200);

    const ran = await call('POST', '/commands', annaToken, { issues: [a.id, b.id], command: 'Priority Critical', view: { name: 'list' } });
    expect(ran.status).toBe(200);
    expect(ran.body.undo).toEqual({ event: expect.any(Number), group: expect.any(String) });
    const undone = await call('POST', `/events/${ran.body.undo.event}/undo`, annaToken);
    expect(undone.body).toMatchObject({ group: ran.body.undo.group, issues: [{}, {}] });

    const linked = await call('POST', `/issues/${a.id}/links`, annaToken, { relation: 'depends on', issue: b.id, view: { name: 'timeline' } });
    expect(linked.body[0].undo).toEqual({ event: expect.any(Number) });
    const removed = await call('DELETE', `/links/${linked.body[0].id}?view=timeline`, annaToken);
    expect(removed).toMatchObject({ status: 200, body: { undo: { event: expect.any(Number) } } });
    await call('POST', `/issues/${a.id}/links`, annaToken, { relation: 'depends on', issue: b.id });
    const plainLink = (await call('GET', `/issues/${a.id}/links`, annaToken)).body[0].id;
    expect((await call('DELETE', `/links/${plainLink}`, annaToken)).status).toBe(204);
  });
});
