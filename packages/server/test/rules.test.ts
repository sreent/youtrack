import type { IssueDetail, RulePreview, RuleRun } from '@a4a/shared';
import { and, count, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { adminCtx } from '../src/app-services';
import { runCommand } from '../src/commands/executor';
import type { UserRow } from '../src/context';
import { activities, comments, issues, projects, ruleRuns, rules } from '../src/db/schema';
import { OutboxWorker } from '../src/events/worker';
import { AppError } from '../src/lib/errors';
import { eventFeed, issueActivity } from '../src/services/activity';
import { addComment } from '../src/services/comments';
import { createIssue, getIssue, updateIssue } from '../src/services/issues';
import { addMember } from '../src/services/members';
import { createProject, updateProject } from '../src/services/projects';
import { addFieldValue } from '../src/services/fields';
import { fieldByName } from '../src/services/schema-cache';
import { insertUser } from '../src/services/users';
import { presentField } from '../src/tools/registry';
import { MAX_DEPTH, RuleEngine } from '../src/workflow/engine';
import { checkRulePart, createRule, deleteRule, getRule, listRuleRuns, listRules, previewRule, updateRule } from '../src/workflow/rules';
import { nextRunAfter } from '../src/workflow/words';
import { addDays, todayISO } from '../src/lib/dates';
import { createHttpApp } from '../src/http/app';
import { issueTokenFor } from '../src/services/auth';
import { toolByName } from '../src/tools/registry';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let engine: RuleEngine;
let worker: OutboxWorker;

const value = (i: IssueDetail, name: string) => presentField(i.fields.find((f) => f.name === name)!);
const tagsOf = (i: IssueDetail) => i.tags.map((t) => t.name).sort();

/** Let the outbox catch up, a few passes, so chains of rules play out. */
async function settle() {
  for (let i = 0; i < 6; i++) await worker.drain();
}

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, ms = 3000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  w = await createWorld();
  engine = new RuleEngine(w.app, () => {});
  worker = new OutboxWorker(w.app, [engine.consumer()], {}, [], () => {});
  await worker.drain(); // the consumer's cursor starts here
  // Ben manages WEB; Anna is a member of both, and manages neither.
  await updateProject(w.adminCtx, 'WEB', { lead: 'ben' });
});

afterEach(async () => {
  await w.app.db.delete(rules);
  w.app.schema.invalidate();
});

afterAll(async () => {
  await worker.stop();
  await w?.close();
});

describe('rules on a change', () => {
  it('acts when an issue is created and matches, as the workflow agent', async () => {
    const rule = await createRule(w.adminCtx, {
      project: 'BACK',
      name: 'Critical bugs go to Anna',
      kind: 'change',
      trigger: 'created',
      query: 'Type: Bug Priority: Critical',
      command: 'Assignee anna tag urgent',
    });
    expect(rule.sentence).toBe('When an issue is created, if it matches “Type: Bug Priority: Critical”, then apply “Assignee anna tag urgent”.');
    const bug = await createIssue(w.as(w.ben), { project: 'BACK', summary: 'Checkout crashes', fields: { Type: 'Bug', Priority: 'Critical' } });
    const task = await createIssue(w.as(w.ben), { project: 'BACK', summary: 'Tidy the docs', fields: { Type: 'Task', Priority: 'Critical' } });
    await settle();

    const after = await getIssue(w.adminCtx, bug.id);
    expect(value(after, 'Assignee')).toBe('anna');
    expect(tagsOf(after)).toEqual(['urgent']);
    expect(value(await getIssue(w.adminCtx, task.id), 'Assignee')).toBeNull();

    const history = await issueActivity(w.adminCtx, bug.id);
    const byRule = history.find((e) => e.type === 'issue.updated')!;
    expect(byRule.actor).toMatchObject({ login: 'workflow', channel: 'automation' });
    expect(byRule.data.automation).toMatchObject({ rule: rule.id, name: 'Critical bugs go to Anna', depth: 1 });

    const runs = await listRuleRuns(w.adminCtx, { rule: rule.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: 'applied', issue: bug.id, by: { login: 'ben' } });
    expect(runs[0]!.changes.map((c) => c.field).sort()).toEqual(['Assignee', 'Tags']);
  });

  it('leaves an import be: it brings history in, and is no change happening now', async () => {
    await createRule(w.adminCtx, { project: 'BACK', name: 'Critical issues get tagged', kind: 'change', trigger: 'created', query: 'Priority: Critical', command: 'tag urgent' });
    const imported = { createdAt: new Date('2025-03-01'), updatedAt: new Date('2025-03-02'), resolvedAt: null, reporterId: w.ben.id, data: { source: 'jira', key: 'OLD-8' } };
    const old = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Imported: payments double-charge', fields: { Priority: 'Critical' } }, { imported });
    const now = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Payments double-charge again', fields: { Priority: 'Critical' } });
    await settle();
    expect(tagsOf(await getIssue(w.adminCtx, old.id))).toEqual([]);
    expect(tagsOf(await getIssue(w.adminCtx, now.id))).toEqual(['urgent']);
  });

  it('acts only when the named field changes, with "me" as whoever changed it', async () => {
    await createRule(w.adminCtx, {
      project: 'BACK',
      name: 'Starting it takes it',
      kind: 'change',
      trigger: 'updated',
      field: 'State',
      query: 'State: In Progress has: -Assignee',
      command: 'for me',
    });
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Rotate the keys' });
    await updateIssue(w.as(w.ben), issue.id, { fields: { Priority: 'Major' } });
    await settle();
    expect(value(await getIssue(w.adminCtx, issue.id), 'Assignee')).toBeNull();

    await updateIssue(w.as(w.ben), issue.id, { fields: { State: 'In Progress' } });
    await settle();
    expect(value(await getIssue(w.adminCtx, issue.id), 'Assignee')).toBe('ben');
  });

  it('acts when an issue gets a comment', async () => {
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Which browser?', tags: ['needs-info'] });
    await createRule(w.adminCtx, { project: 'BACK', name: 'An answer clears needs-info', kind: 'change', trigger: 'commented', query: 'tag: needs-info', command: 'remove tag needs-info' });
    await settle();
    expect(tagsOf(await getIssue(w.adminCtx, issue.id))).toEqual(['needs-info']);
    await addComment(w.as(w.ben), issue.id, 'Safari 18.');
    await settle();
    expect(tagsOf(await getIssue(w.adminCtx, issue.id))).toEqual([]);
  });

  it('does nothing when turned off, and global rules act in every project', async () => {
    const off = await createRule(w.adminCtx, { project: 'BACK', name: 'Tag new ones', kind: 'change', trigger: 'created', query: '', command: 'tag fresh' });
    await updateRule(w.adminCtx, off.id, { enabled: false });
    await createRule(w.adminCtx, { project: null, name: 'Everywhere', kind: 'change', trigger: 'created', query: 'Type: Feature', command: 'tag idea' });
    const a = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'A', fields: { Type: 'Feature' } });
    const b = await createIssue(w.as(w.anna), { project: 'WEB', summary: 'B', fields: { Type: 'Feature' } });
    await settle();
    expect(tagsOf(await getIssue(w.adminCtx, a.id))).toEqual(['idea']);
    expect(tagsOf(await getIssue(w.adminCtx, b.id))).toEqual(['idea']);
  });

  it('logs a rule that fails, and the others and the outbox go on', async () => {
    const s = await w.app.schema.get();
    await addFieldValue(w.adminCtx, fieldByName(s, 'Subsystem')!.id, { name: 'Payments', project: 'BACK' });
    // A global rule naming a value only BACK has: in WEB it can't apply.
    const broken = await createRule(w.adminCtx, { project: null, name: 'Payments bugs', kind: 'change', trigger: 'created', query: 'summary: payment', command: 'Subsystem Payments' });
    const fine = await createRule(w.adminCtx, { project: 'WEB', name: 'Tag payments', kind: 'change', trigger: 'created', query: 'summary: payment', command: 'tag money' });
    const issue = await createIssue(w.as(w.anna), { project: 'WEB', summary: 'The payment page is slow' });
    await settle();
    const [failed] = await listRuleRuns(w.adminCtx, { rule: broken.id });
    expect(failed).toMatchObject({ outcome: 'failed', issue: issue.id });
    expect(failed!.message).toContain('Payments');
    expect(tagsOf(await getIssue(w.adminCtx, issue.id))).toEqual(['money']);
    expect((await listRuleRuns(w.adminCtx, { rule: fine.id }))[0]).toMatchObject({ outcome: 'applied' });
    // The outbox went on past it: a later change is handled too.
    const later = await createIssue(w.as(w.anna), { project: 'WEB', summary: 'Another payment bug' });
    await settle();
    expect(tagsOf(await getIssue(w.adminCtx, later.id))).toEqual(['money']);
  });
});

describe('loops', () => {
  it('stops rules that undo each other: a rule acts once on an issue for each change a person makes', async () => {
    const start = await createRule(w.adminCtx, { project: 'BACK', name: 'Open means in progress', kind: 'change', trigger: 'updated', field: 'State', query: 'State: Open', command: 'State In Progress' });
    const back = await createRule(w.adminCtx, { project: 'BACK', name: 'In progress means open', kind: 'change', trigger: 'updated', field: 'State', query: 'State: In Progress', command: 'State Open' });
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Ping-pong' });
    await updateIssue(w.as(w.ben), issue.id, { fields: { State: 'In Progress' } });
    await settle();
    await settle();
    // Ben: In Progress. "back": Open. "start": In Progress. "back" again would undo it, but it acted for this change already.
    expect(value(await getIssue(w.adminCtx, issue.id), 'State')).toBe('In Progress');
    expect((await listRuleRuns(w.adminCtx, { rule: back.id })).filter((r) => r.outcome === 'applied')).toHaveLength(1);
    expect((await listRuleRuns(w.adminCtx, { rule: start.id })).filter((r) => r.outcome === 'applied')).toHaveLength(1);
    const updates = (await issueActivity(w.adminCtx, issue.id)).filter((e) => e.type === 'issue.updated');
    expect(updates.map((e) => (e.data.automation as { depth?: number } | undefined)?.depth ?? 0)).toEqual([0, 1, 2]);
  });

  it(`lets rules set off rules only ${MAX_DEPTH} steps deep`, async () => {
    const steps = [
      ['Minor', 'Normal'],
      ['Normal', 'Major'],
      ['Major', 'Critical'],
      ['Critical', 'Show-stopper'],
    ];
    const made = [];
    for (const [from, to] of steps) {
      made.push(await createRule(w.adminCtx, { project: 'BACK', name: `${from} to ${to}`, kind: 'change', trigger: 'updated', field: 'Priority', query: `Priority: ${from}`, command: `Priority ${to}` }));
    }
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Escalates' });
    await updateIssue(w.as(w.ben), issue.id, { fields: { Priority: 'Minor' } });
    for (let i = 0; i < 3; i++) await settle();
    expect(value(await getIssue(w.adminCtx, issue.id), 'Priority')).toBe('Critical');
    const last = await listRuleRuns(w.adminCtx, { rule: made[3]!.id });
    expect(last).toHaveLength(1);
    expect(last[0]).toMatchObject({ outcome: 'skipped', issue: issue.id });
    expect(last[0]!.message).toContain(`${MAX_DEPTH} steps`);
  });

  it('does nothing again when an event comes again (the outbox is at least once)', async () => {
    const rule = await createRule(w.adminCtx, { project: 'BACK', name: 'Note new bugs', kind: 'change', trigger: 'created', query: 'Type: Bug', command: 'tag triage', comment: 'Tagged for triage.' });
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Replayed', fields: { Type: 'Bug' } });
    await settle();
    const created = (await issueActivity(w.adminCtx, issue.id)).find((e) => e.type === 'issue.created')!;
    await engine.onEvent(created);
    await engine.onEvent(created);
    const [{ n } = { n: 0 }] = await w.app.db.select({ n: count() }).from(comments).where(eq(comments.issueId, (await getIssue(w.adminCtx, issue.id)).uid));
    expect(Number(n)).toBe(1);
    expect(await listRuleRuns(w.adminCtx, { rule: rule.id })).toHaveLength(1);
  });
});

describe('scheduled rules', () => {
  it('gives every matching issue the command when its turn comes, once', async () => {
    const today = todayISO();
    const late = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Late', fields: { 'Due date': addDays(today, -3) } });
    const soon = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Soon', fields: { 'Due date': addDays(today, 3) } });
    const done = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Done late', fields: { 'Due date': addDays(today, -3), State: 'Fixed' } });
    const rule = await createRule(w.adminCtx, {
      project: 'BACK',
      name: 'Overdue',
      kind: 'schedule',
      schedule: { every: 'day', at: '08:30' },
      query: '#Unresolved Due date: Overdue',
      command: 'tag overdue',
    });
    expect(rule.sentence).toBe('Every day at 08:30, if an issue matches “#Unresolved Due date: Overdue”, then apply “tag overdue”.');
    const due = new Date(rule.nextRunAt!);
    expect(due.getHours()).toBe(8);
    expect(due.getMinutes()).toBe(30);
    // Not yet its turn.
    expect(await engine.runDue(undefined, new Date(due.getTime() - 60_000))).toBe(0);
    expect(tagsOf(await getIssue(w.adminCtx, late.id))).toEqual([]);

    expect(await engine.runDue(undefined, new Date(due.getTime() + 60_000))).toBe(1);
    expect(tagsOf(await getIssue(w.adminCtx, late.id))).toEqual(['overdue']);
    expect(tagsOf(await getIssue(w.adminCtx, soon.id))).toEqual([]);
    expect(tagsOf(await getIssue(w.adminCtx, done.id))).toEqual([]);
    // Its turn is taken: the same moment again runs nothing.
    expect(await engine.runDue(undefined, new Date(due.getTime() + 60_000))).toBe(0);
    const [summary] = (await listRuleRuns(w.adminCtx, { rule: rule.id })).filter((r) => r.issue === null);
    expect(summary).toMatchObject({ outcome: 'applied', message: 'Checked 1 issue, changed 1.' });
    const [again] = await w.app.db.select().from(rules).where(eq(rules.id, rule.id));
    expect(again!.nextRunAt!.getTime()).toBe(nextRunAfter({ every: 'day', at: '08:30' }, new Date(due.getTime() + 60_000)).getTime());
  });

  it('runs only where the worker holds its lease', async () => {
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Hourly' });
    const rule = await createRule(w.adminCtx, { project: 'BACK', name: 'Hourly tag', kind: 'schedule', schedule: { every: 'hour' }, query: 'summary: Hourly', command: 'tag swept' });
    await w.app.db.update(rules).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(rules.id, rule.id));
    // `worker` holds the lease (it drained last); another instance's worker, with the rule chores, stands by.
    await worker.drain();
    const standby = new OutboxWorker(w.app, [], { holder: 'standby' }, new RuleEngine(w.app, () => {}).chores(), () => {});
    await standby.drain();
    expect(tagsOf(await getIssue(w.adminCtx, issue.id))).toEqual([]);
    await worker.stop(); // gives up the lease
    await standby.drain();
    expect(tagsOf(await getIssue(w.adminCtx, issue.id))).toEqual(['swept']);
    await standby.stop();
    worker = new OutboxWorker(w.app, [engine.consumer()], {}, [], () => {});
    await worker.drain();
  });

  it('says "me" means nobody in a rule that runs on its own', async () => {
    const preview = await previewRule(w.adminCtx, { project: 'BACK', name: 'Mine', kind: 'schedule', schedule: { every: 'hour' }, query: 'for: me', command: 'tag mine' });
    expect(preview.ok).toBe(false);
    expect(preview.problems[0]).toMatchObject({ part: 'query', message: 'A scheduled rule runs on its own, so "me" stands for nobody', start: 5, end: 7 });
  });
});

describe('guards', () => {
  async function counts(issueUid: string) {
    const [a] = await w.app.db.select({ n: count() }).from(activities).where(eq(activities.issueId, issueUid));
    const [c] = await w.app.db.select({ n: count() }).from(comments).where(eq(comments.issueId, issueUid));
    return { activities: Number(a!.n), comments: Number(c!.n) };
  }

  it("refuses a change that breaks it, and leaves nothing of it behind", async () => {
    const guard = await createRule(w.adminCtx, { project: 'BACK', name: "Won't fix says why", kind: 'guard', query: "State: Won't fix", requires: 'has: comments', message: "Say in a comment why it won't be fixed." });
    expect(guard.sentence).toBe("When a change would make an issue match “State: Won't fix”, if it doesn't also match “has: comments”, then refuse the change: “Say in a comment why it won't be fixed.”");
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Old browser support' });
    const before = await getIssue(w.adminCtx, issue.id);
    const had = await counts(before.uid);

    await expect(updateIssue(w.as(w.ben), issue.id, { fields: { State: "Won't fix", Priority: 'Minor' }, addTags: ['wontfix'] })).rejects.toMatchObject({
      status: 422,
      code: 'refused_by_rule',
      message: "Say in a comment why it won't be fixed.",
    });
    const after = await getIssue(w.adminCtx, issue.id);
    expect(after.version).toBe(before.version);
    expect(value(after, 'State')).toBe('Open');
    expect(value(after, 'Priority')).toBe('Normal');
    expect(tagsOf(after)).toEqual([]);
    expect(await counts(before.uid)).toEqual(had);

    // Through a command, the issue's result says why; with a comment it goes through.
    const refused = await runCommand(w.as(w.ben), { issues: [issue.id], command: "State Won't fix" });
    expect(refused.applied).toBe(false);
    expect(refused.results[0]!.errors[0]).toContain("Say in a comment why it won't be fixed.");
    const ok = await runCommand(w.as(w.ben), { issues: [issue.id], command: "State Won't fix", comment: 'IE 11 is out of support.' });
    expect(ok.applied).toBe(true);
    expect(value(await getIssue(w.adminCtx, issue.id), 'State')).toBe("Won't fix");

    // Each refusal is in the guard's run log, with whose change it was.
    const refusals = await waitFor(async () => {
      const runs = (await listRuleRuns(w.adminCtx, { rule: guard.id })).filter((r) => r.outcome === 'refused');
      return runs.length === 2 && runs;
    });
    expect(refusals[0]).toMatchObject({ issue: issue.id, by: { login: 'ben' } });
  });

  it('refuses a new issue that breaks it, without using up its number', async () => {
    await createRule(w.adminCtx, { project: 'WEB', name: 'Show-stoppers have an owner', kind: 'guard', query: 'Priority: Show-stopper', requires: 'has: Assignee', message: 'A show-stopper needs someone on it.' });
    const [{ next } = { next: 0 }] = await w.app.db.select({ next: projects.nextNumber }).from(projects).where(sql`${projects.key} = 'WEB'`);
    const [{ n: before } = { n: 0 }] = await w.app.db.select({ n: count() }).from(issues);
    await expect(createIssue(w.as(w.anna), { project: 'WEB', summary: 'Site down', fields: { Priority: 'Show-stopper' } })).rejects.toMatchObject({ code: 'refused_by_rule' });
    const [{ n: after } = { n: 0 }] = await w.app.db.select({ n: count() }).from(issues);
    expect(after).toBe(before);
    const made = await createIssue(w.as(w.anna), { project: 'WEB', summary: 'Site down', fields: { Priority: 'Show-stopper', Assignee: 'ben' } });
    expect(made.number).toBe(next);
  });

  it('lets an issue that broke it before it existed be changed in other ways', async () => {
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Legacy', fields: { State: "Won't fix" } });
    await createRule(w.adminCtx, { project: 'BACK', name: "Won't fix says why", kind: 'guard', query: "State: Won't fix", requires: 'has: comments', message: 'Say why.' });
    const changed = await updateIssue(w.as(w.ben), issue.id, { fields: { Priority: 'Major' } });
    expect(value(changed, 'Priority')).toBe('Major');
    const preview = await previewRule(w.adminCtx, { project: 'BACK', name: 'x', kind: 'guard', query: "State: Won't fix", requires: 'has: comments', message: 'Say why.' });
    expect(preview.breaking).toBeGreaterThanOrEqual(1);
    expect(preview.sample.map((x) => x.issue.id)).toContain(issue.id);
  });

  it("refuses a rule's own change, and the rule logs that it failed", async () => {
    await createRule(w.adminCtx, { project: 'BACK', name: 'Owners', kind: 'guard', query: 'Priority: Show-stopper', requires: 'has: Assignee', message: 'A show-stopper needs someone on it.' });
    const bump = await createRule(w.adminCtx, { project: 'BACK', name: 'Outages are show-stoppers', kind: 'change', trigger: 'created', query: 'summary: outage', command: 'Priority Show-stopper' });
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Outage in eu-west' });
    await settle();
    expect(value(await getIssue(w.adminCtx, issue.id), 'Priority')).toBe('Normal');
    const [run] = await listRuleRuns(w.adminCtx, { rule: bump.id });
    expect(run).toMatchObject({ outcome: 'failed', issue: issue.id });
    expect(run!.message).toContain('A show-stopper needs someone on it.');
  });
});

describe('managing rules', () => {
  const draft = { project: 'WEB', name: 'Tag it', kind: 'change' as const, trigger: 'created' as const, query: '', command: 'tag seen' };

  it("needs the project's manager or an administrator", async () => {
    await expect(createRule(w.as(w.viewer), draft)).rejects.toMatchObject({ status: 403 });
    await expect(createRule(w.as(w.anna), draft)).rejects.toMatchObject({ status: 403 });
    const mine = await createRule(w.as(w.ben), draft); // Ben leads WEB
    await expect(createRule(w.as(w.ben), { ...draft, project: 'BACK' })).rejects.toMatchObject({ status: 403 });
    await expect(createRule(w.as(w.ben), { ...draft, project: null })).rejects.toMatchObject({ status: 403 });
    await expect(updateRule(w.as(w.anna), mine.id, { enabled: false })).rejects.toMatchObject({ status: 403 });
    await expect(deleteRule(w.as(w.anna), mine.id)).rejects.toMatchObject({ status: 403 });
    // Anyone who can read the project can read its rules.
    expect((await listRules(w.as(w.viewer), { project: 'WEB' })).map((r) => r.id)).toEqual([mine.id]);
    // An administrator's token without the write scope can't make one either.
    const readOnly = adminCtx(w.app, w.admin, 'api');
    readOnly.actor.scopes = ['read'];
    await expect(createRule(readOnly, draft)).rejects.toMatchObject({ status: 403 });
    await createRule(w.adminCtx, { ...draft, project: null });
  });

  it('refuses a rule that needs fixing, with each problem where it is', async () => {
    await expect(createRule(w.adminCtx, { ...draft, query: 'State: Fixd' })).rejects.toMatchObject({
      status: 400,
      details: { problems: [{ part: 'query', message: 'Unknown value "Fixd" for State', start: 7, end: 11, fix: 'Fixed' }] },
    });
    await expect(createRule(w.adminCtx, { ...draft, command: 'Assignee zed' })).rejects.toMatchObject({ status: 400 });
    await expect(createRule(w.adminCtx, { ...draft, command: '' })).rejects.toMatchObject({ details: { problems: [{ part: 'command' }] } });
    await expect(createRule(w.adminCtx, { ...draft, trigger: null })).rejects.toMatchObject({ details: { problems: [{ part: 'trigger' }] } });
    await expect(createRule(w.adminCtx, { project: 'WEB', name: 'g', kind: 'guard', query: '', requires: '' })).rejects.toMatchObject({ status: 400 });
  });

  it('turns off without fixing, and refuses a stale change', async () => {
    const rule = await createRule(w.adminCtx, draft);
    const off = await updateRule(w.adminCtx, rule.id, { enabled: false, expectedVersion: rule.version });
    expect(off).toMatchObject({ enabled: false, version: rule.version + 1 });
    await expect(updateRule(w.adminCtx, rule.id, { name: 'Late', expectedVersion: rule.version })).rejects.toMatchObject({ status: 409 });
  });

  it('previews which issues it would touch and what it would change, changing nothing', async () => {
    const issue = await createIssue(w.as(w.anna), { project: 'WEB', summary: 'Preview me', fields: { Type: 'Bug' } });
    const before = await getIssue(w.adminCtx, issue.id);
    const preview = await previewRule(w.as(w.ben), { project: 'WEB', name: 'Bugs to me', kind: 'change', trigger: 'created', query: 'Type: Bug summary: preview', command: 'for me Major' });
    expect(preview).toMatchObject({ ok: true, matching: 1 });
    expect(preview.sample[0]!.issue.id).toBe(issue.id);
    expect(preview.sample[0]!.changes).toEqual([
      { field: 'Assignee', from: null, to: 'ben' },
      { field: 'Priority', from: 'Normal', to: 'Major' },
    ]);
    expect((await getIssue(w.adminCtx, issue.id)).version).toBe(before.version);
    const bad = await previewRule(w.adminCtx, { ...draft, query: 'Stat: Open' });
    expect(bad.ok).toBe(false);
    expect(bad.problems[0]).toMatchObject({ part: 'query', fix: 'State' });
  });

  it('shows what in a saved rule no longer reads, and such a rule does nothing', async () => {
    const s = await w.app.schema.get();
    const value = await addFieldValue(w.adminCtx, fieldByName(s, 'Subsystem')!.id, { name: 'Search', project: 'WEB' });
    const rule = await createRule(w.adminCtx, { project: 'WEB', name: 'Search bugs', kind: 'change', trigger: 'created', query: 'Subsystem: Search', command: 'tag search' });
    await w.app.db.execute(sql`UPDATE field_values SET name = 'Find' WHERE id = ${value.id}`);
    w.app.schema.invalidate();
    const [listed] = await listRules(w.adminCtx, { project: 'WEB' });
    expect(listed!.problems[0]).toMatchObject({ part: 'query', message: 'Unknown value "Search" for Subsystem' });
    const issue = await createIssue(w.as(w.anna), { project: 'WEB', summary: 'Find is slow', fields: { Subsystem: 'Find' } });
    await settle();
    expect(tagsOf(await getIssue(w.adminCtx, issue.id))).toEqual([]);
    const runs = await listRuleRuns(w.adminCtx, { rule: rule.id });
    expect(runs[0]).toMatchObject({ outcome: 'failed' });
    expect(runs[0]!.message).toContain('no longer reads');
  });

  it("lets whoever reads a project read its run log, and forgets a rule's runs with it", async () => {
    const rule = await createRule(w.adminCtx, draft);
    await createIssue(w.as(w.anna), { project: 'WEB', summary: 'Seen' });
    await settle();
    expect((await listRuleRuns(w.as(w.viewer), { project: 'WEB' })).map((r) => r.rule.name)).toEqual(['Tag it']);
    await expect(listRuleRuns(w.as(w.viewer), { project: 'NOPE' })).rejects.toMatchObject({ status: 404 });
    await deleteRule(w.adminCtx, rule.id);
    const [row] = await w.app.db.select({ n: count() }).from(ruleRuns).where(and(eq(ruleRuns.ruleId, rule.id)));
    expect(Number(row!.n)).toBe(0);
  });
});

describe('over REST and MCP', () => {
  async function client() {
    const http = createHttpApp(w.app);
    const admin = (await issueTokenFor(w.app.db, w.admin.id, { name: 'ops', scopes: ['read', 'write', 'admin'] })).token;
    const anna = (await issueTokenFor(w.app.db, w.anna.id, { name: 'anna-cli', scopes: ['read', 'write'] })).token;
    return async (token: string, method: string, path: string, body?: unknown) => {
      const res = await http.request(`/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, tokens: { admin, anna } };
    };
  }

  it('makes, previews, checks, changes and lists rules, and is in the OpenAPI document', async () => {
    const call = await client();
    const { admin, anna } = (await call('', 'GET', '/health')).tokens;
    const draft = { project: 'BACK', name: 'Blocked needs a reason', kind: 'guard', query: 'State: Blocked', requires: 'has: comments', message: 'Say what blocks it.' };
    const checked = await call(anna, 'POST', '/rules/check', { project: 'BACK', kind: 'guard', part: 'query', text: 'State: Blokced', caret: 14 });
    expect(checked.status).toBe(200);
    expect(checked.body.problems[0]).toMatchObject({ message: 'Unknown value "Blokced" for State', fix: 'Blocked' });
    const preview = await call(anna, 'POST', '/rules/preview', draft);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ ok: true, breaking: 0 });
    expect((await call(anna, 'POST', '/rules', draft)).status).toBe(403);
    const made = await call(admin, 'POST', '/rules', draft);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ kind: 'guard', enabled: true, project: 'BACK', problems: [] });
    const off = await call(admin, 'PATCH', `/rules/${made.body.id}`, { enabled: false, expectedVersion: made.body.version });
    expect(off.body).toMatchObject({ enabled: false, requires: 'has: comments' });
    const bad = await call(admin, 'POST', '/rules', { ...draft, requires: 'has: commnets' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.problems[0]).toMatchObject({ part: 'requires', message: 'Unknown attribute "commnets" for has:', hint: 'Did you mean "comments"?' });
    expect((await call(anna, 'GET', '/rules?project=BACK')).body.map((r: { name: string }) => r.name)).toEqual(['Blocked needs a reason']);
    expect((await call(anna, 'GET', `/rule-runs?rule=${made.body.id}`)).status).toBe(200);
    expect((await call(admin, 'DELETE', `/rules/${made.body.id}`)).status).toBe(204);
    const doc = (await call('', 'GET', '/openapi.json')).body as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/rules', '/rules/{id}', '/rules/preview', '/rules/check', '/rule-runs', '/vcs/integrations', '/vcs/hooks/{id}', '/issues/{id}/vcs']),
    );
  });

  it('gives agents list_rules and preview_rule, and no way to make one', async () => {
    await createRule(w.adminCtx, { project: 'BACK', name: 'Critical bugs go to Anna', kind: 'change', trigger: 'created', query: 'Type: Bug Priority: Critical', command: 'Assignee anna' });
    const listed = await toolByName('list_rules')!.run(w.as(w.anna), { project: 'BACK' });
    expect(listed.data).toEqual([
      expect.objectContaining({ name: 'Critical bugs go to Anna', kind: 'change', on: true, rule: 'When an issue is created, if it matches “Type: Bug Priority: Critical”, then apply “Assignee anna”.' }),
    ]);
    const previewed = await toolByName('preview_rule')!.run(w.as(w.anna), { project: 'BACK', kind: 'schedule', every: 'day', at: '07:30', query: '#Unresolved Priority: Critcal', command: 'tag hot' });
    expect(previewed.data).toMatchObject({ ok: false, fixed: { query: '#Unresolved Priority: Critical' } });
    expect(toolByName('preview_rule')!.kind).toBe('reads');
    expect(['create_rule', 'update_rule', 'delete_rule'].map((n) => toolByName(n))).toEqual([undefined, undefined, undefined]);
  });
});

/** What an error says, with one key or id put back as a placeholder, to compare "hidden" with "missing". */
async function failure(p: Promise<unknown>, word?: string): Promise<{ status: number; code: string; message: string; hint?: string }> {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    const strip = (t?: string) => (word && t ? t.split(word).join('<X>') : t);
    return { status: e.status, code: e.code, message: strip(e.message)!, hint: strip(e.hint) };
  }
  throw new Error('expected it to fail');
}

describe('a members-only project, through rules', () => {
  // SECRET: only its people see it. Anna manages it and Dana is one of its viewers; Ben is outside it (he leads WEB).
  let dana: UserRow;
  let secretIssue = '';
  let backId = '';
  const byIssue = (runs: RuleRun[]) => runs.map((r) => r.issue).sort();

  beforeAll(async () => {
    await createProject(w.adminCtx, { key: 'SECRET', name: 'Merger', template: 'software', visibility: 'members' });
    dana = await insertUser(w.app.db, { login: 'dana', name: 'Dana Reyes', role: 'member' });
    w.app.schema.invalidate();
    await addMember(w.adminCtx, 'SECRET', { user: 'anna', role: 'manager' });
    await addMember(w.adminCtx, 'SECRET', { user: 'dana', role: 'viewer' });
    const s = await w.app.schema.get();
    backId = s.projectsByKey.get('BACK')!.id;
    await addFieldValue(w.adminCtx, fieldByName(s, 'Subsystem')!.id, { name: 'Diligence', project: 'SECRET' });
    secretIssue = (await createIssue(w.as(w.anna), { project: 'SECRET', summary: 'Acquire Initech', fields: { Subsystem: 'Diligence' } })).id;
    await settle();
  });

  it('answers for its rules, their runs and its name exactly as for ones that do not exist', async () => {
    const ben = w.as(w.ben);
    const rule = await createRule(w.as(w.anna), { project: 'SECRET', name: 'Diligence is urgent', kind: 'change', trigger: 'created', query: 'Subsystem: Diligence', command: 'tag urgent' });
    const sneak = { project: 'SECRET', name: 'x', kind: 'change' as const, trigger: 'created' as const, query: '', command: 'tag x' };
    // One at a time: the second call starts once the first has failed, so no failure goes unheard.
    const alike = async (hidden: () => Promise<unknown>, missing: () => Promise<unknown>, word: string, other: string) => {
      const a = await failure(hidden(), word);
      const b = await failure(missing(), other);
      expect(a).toEqual(b);
      expect(a.status).toBe(404);
    };
    await alike(() => listRules(ben, { project: 'SECRET' }), () => listRules(ben, { project: 'SECRAT' }), 'SECRET', 'SECRAT');
    await alike(() => getRule(ben, rule.id), () => getRule(ben, 'no-such-rule'), rule.id, 'no-such-rule');
    await alike(() => listRuleRuns(ben, { rule: rule.id }), () => listRuleRuns(ben, { rule: 'no-such-rule' }), rule.id, 'no-such-rule');
    await alike(() => listRuleRuns(ben, { project: 'SECRET' }), () => listRuleRuns(ben, { project: 'SECRAT' }), 'SECRET', 'SECRAT');
    await alike(() => updateRule(ben, rule.id, { enabled: false }), () => updateRule(ben, 'no-such-rule', { enabled: false }), rule.id, 'no-such-rule');
    await alike(() => deleteRule(ben, rule.id), () => deleteRule(ben, 'no-such-rule'), rule.id, 'no-such-rule');
    await alike(() => createRule(ben, sneak), () => createRule(ben, { ...sneak, project: 'SECRAT' }), 'SECRET', 'SECRAT');
    await alike(() => previewRule(ben, sneak), () => previewRule(ben, { ...sneak, project: 'SECRAT' }), 'SECRET', 'SECRAT');
    await alike(
      () => checkRulePart(ben, { project: 'SECRET', kind: 'change', part: 'query', text: '' }),
      () => checkRulePart(ben, { project: 'SECRAT', kind: 'change', part: 'query', text: '' }),
      'SECRET',
      'SECRAT',
    );
    await alike(() => toolByName('list_rules')!.run(ben, { project: 'SECRET' }), () => toolByName('list_rules')!.run(ben, { project: 'SECRAT' }), 'SECRET', 'SECRAT');
    await alike(() => toolByName('preview_rule')!.run(ben, { rule: rule.id }), () => toolByName('preview_rule')!.run(ben, { rule: 'no-such-rule' }), rule.id, 'no-such-rule');
    expect((await listRules(ben)).map((r) => r.id)).not.toContain(rule.id);
    expect((await listRules(w.as(w.anna))).map((r) => r.id)).toContain(rule.id);
    // Over REST too.
    const http = createHttpApp(w.app);
    const token = (await issueTokenFor(w.app.db, w.ben.id, { name: 'ben-cli', scopes: ['read', 'write'] })).token;
    const get = async (path: string) => {
      const res = await http.request(`/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: res.status, body: JSON.stringify(await res.json()) };
    };
    expect((await get(`/rules/${rule.id}`)).status).toBe(404);
    const [hidden, missing] = [await get('/rules?project=SECRET'), await get('/rules?project=SECRAT')];
    expect(hidden.status).toBe(404);
    expect(hidden.body.split('SECRET').join('<X>')).toBe(missing.body.split('SECRAT').join('<X>'));
  });

  it("gives a rule elsewhere nothing of it: its names are unknown words, its issues unknown issues, its count no one's", async () => {
    const ben = w.as(w.ben);
    const web = { project: 'WEB', name: 'Probe', kind: 'change' as const, trigger: 'created' as const, query: '', command: 'tag x' };
    const said = async (p: Promise<RulePreview>, word: string) => JSON.stringify((await p).problems).split(word).join('<X>');
    expect(await said(previewRule(ben, { ...web, query: 'project: SECRET' }), 'SECRET')).toBe(await said(previewRule(ben, { ...web, query: 'project: SECRAT' }), 'SECRAT'));
    expect(await said(previewRule(ben, { ...web, query: 'Subsystem: Diligence' }), 'Diligence')).toBe(await said(previewRule(ben, { ...web, query: 'Subsystem: Diligance' }), 'Diligance'));
    expect(await said(previewRule(ben, { ...web, command: `relates to ${secretIssue}` }), secretIssue)).toBe(await said(previewRule(ben, { ...web, command: 'relates to BACK-999' }), 'BACK-999'));
    const hiddenRule = await failure(createRule(ben, { ...web, command: `relates to ${secretIssue}` }), secretIssue);
    expect(hiddenRule).toEqual(await failure(createRule(ben, { ...web, command: 'relates to BACK-999' }), 'BACK-999'));
    expect(JSON.stringify(await previewRule(ben, { ...web, query: 'project: SECRAT' }))).not.toContain('SECRET');
    // A rule for every project, previewed by someone outside it, counts and shows only what they can see.
    const all = { project: null, name: 'All', kind: 'schedule' as const, schedule: { every: 'hour' as const }, query: '', command: 'tag x' };
    const [outside, inside] = [await previewRule(ben, all), await previewRule(w.adminCtx, all)];
    const secretCount = Number((await w.app.db.select({ n: count() }).from(issues).where(eq(issues.projectId, (await w.app.schema.get()).projectsByKey.get('SECRET')!.id)))[0]!.n);
    expect(secretCount).toBeGreaterThan(0);
    expect(inside.matching - outside.matching).toBe(secretCount);
    expect(JSON.stringify(outside)).not.toContain('SECRET');
    expect(JSON.stringify((await previewRule(ben, { ...all, query: 'Subsystem: Diligence' })).problems).split('Diligence').join('<X>')).toBe(
      JSON.stringify((await previewRule(ben, { ...all, query: 'Subsystem: Diligance' })).problems).split('Diligance').join('<X>'),
    );
    const typed = (who: typeof ben) => checkRulePart(who, { project: null, kind: 'change', part: 'query', text: 'project: SE', caret: 11 });
    expect((await typed(ben)).suggestions.map((x) => x.label)).not.toContain('SECRET');
    expect((await typed(w.as(w.anna))).suggestions.map((x) => x.label)).toContain('SECRET');
  });

  it('is acted in by a rule for every project, and what it did there stays there', async () => {
    const everywhere = await createRule(w.adminCtx, { project: null, name: 'Merger watch', kind: 'change', trigger: 'created', query: 'summary: merger', command: 'tag watched' });
    const inside = await createIssue(w.as(w.anna), { project: 'SECRET', summary: 'Merger timeline' });
    const outside = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Merger of two caches' });
    await settle();
    expect(tagsOf(await getIssue(w.as(w.anna), inside.id))).toEqual(['watched']);
    expect(tagsOf(await getIssue(w.as(w.anna), outside.id))).toEqual(['watched']);
    expect(byIssue(await listRuleRuns(w.as(w.ben), { rule: everywhere.id }))).toEqual([outside.id]);
    expect(byIssue(await listRuleRuns(w.as(w.anna), { rule: everywhere.id }))).toEqual([inside.id, outside.id].sort());
    expect(JSON.stringify(await listRules(w.as(w.ben)))).not.toContain(inside.id);
    expect((await eventFeed(w.as(w.ben), { limit: 500 })).some((e) => e.project === 'SECRET')).toBe(false);
    expect((await eventFeed(w.as(w.anna), { limit: 500 })).some((e) => e.project === 'SECRET' && e.data.automation)).toBe(true);
  });

  it("shows how a scheduled rule for every project went only to those who see every project", async () => {
    const sweep = await createRule(w.adminCtx, { project: null, name: 'Sweep', kind: 'schedule', schedule: { every: 'hour' }, query: 'summary: acquisition', command: 'tag swept' });
    const inside = await createIssue(w.as(w.anna), { project: 'SECRET', summary: 'Acquisition costs' });
    const outside = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Acquisition of tokens' });
    await w.app.db.update(rules).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(rules.id, sweep.id));
    await engine.runDue();
    expect(tagsOf(await getIssue(w.as(w.anna), inside.id))).toEqual(['swept']);
    // The run's summary counts SECRET's issues too, so Ben sees only what it did in BACK.
    const theirs = await listRuleRuns(w.as(w.ben), { rule: sweep.id });
    expect(byIssue(theirs)).toEqual([outside.id]);
    const all = await listRuleRuns(w.adminCtx, { rule: sweep.id });
    expect(all.find((r) => r.issue === null)?.message).toBe('Checked 2 issues, changed 2.');
    expect((await listRules(w.as(w.ben))).find((r) => r.id === sweep.id)?.lastRun?.issue).toBe(outside.id);
  });

  it('keeps a rule to its own project, members only or not', async () => {
    const back = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'A cache' });
    // Anna manages SECRET and can see BACK, and still a rule of SECRET can't link to BACK's issues, nor one for every project to one issue.
    await expect(createRule(w.as(w.anna), { project: 'SECRET', name: 'x', kind: 'change', trigger: 'created', query: '', command: `relates to ${back.id}` })).rejects.toMatchObject({
      status: 400,
      details: { problems: [{ part: 'command', message: `${back.id} is in BACK, and a rule of SECRET changes only SECRET's issues` }] },
    });
    await expect(createRule(w.adminCtx, { project: null, name: 'x', kind: 'change', trigger: 'created', query: '', command: `relates to ${secretIssue}` })).rejects.toMatchObject({
      status: 400,
      details: { problems: [{ part: 'command', hint: 'Make it a rule of SECRET.' }] },
    });
    // Even a rule that got past those checks: the workflow agent reaches only the project of the issue it acts on.
    await w.app.db.insert(rules).values({ id: 'reach', projectId: backId, name: 'Reach', kind: 'change', trigger: 'created', query: '', command: `relates to ${secretIssue}` });
    w.app.schema.invalidate();
    const probe = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Probe' });
    await settle();
    expect((await getIssue(w.adminCtx, probe.id)).links).toEqual([]);
    expect((await getIssue(w.adminCtx, secretIssue)).links).toEqual([]);
    expect((await listRuleRuns(w.adminCtx, { rule: 'reach' }))[0]).toMatchObject({ outcome: 'failed', issue: probe.id, message: `Unknown issue ${secretIssue}` });
    // A token for some projects reaches no further, and makes no rule for every project.
    const limited = adminCtx(w.app, w.admin, 'api');
    limited.actor.projectIds = [backId];
    expect(await failure(listRules(limited, { project: 'SECRET' }), 'SECRET')).toEqual(await failure(listRules(limited, { project: 'SECRAT' }), 'SECRAT'));
    await expect(createRule(limited, { project: null, name: 'x', kind: 'change', trigger: 'created', query: '', command: 'tag x' })).rejects.toMatchObject({ status: 403 });
    await createRule(limited, { project: 'BACK', name: 'Fine', kind: 'change', trigger: 'created', query: '', command: 'tag x' });
  });

  it('lets a viewer read its rules and set them off, but make, change or stop none of them', async () => {
    const viewer = w.as(dana);
    const issue = await createIssue(w.as(w.anna), { project: 'SECRET', summary: 'Who signs?', tags: ['waiting'] });
    await settle();
    const draft = { project: 'SECRET', name: 'An answer clears waiting', kind: 'change' as const, trigger: 'commented' as const, query: 'tag: waiting', command: 'remove tag waiting' };
    await expect(createRule(viewer, draft)).rejects.toMatchObject({ status: 403 });
    await expect(createRule(viewer, { ...draft, project: null })).rejects.toMatchObject({ status: 403 });
    const rule = await createRule(w.as(w.anna), draft);
    expect((await listRules(viewer, { project: 'SECRET' })).map((r) => r.id)).toEqual([rule.id]);
    for (const change of [{ enabled: false }, { command: 'State Fixed' }, { name: 'Mine now' }]) {
      await expect(updateRule(viewer, rule.id, change)).rejects.toMatchObject({ status: 403 });
    }
    await expect(deleteRule(viewer, rule.id)).rejects.toMatchObject({ status: 403 });
    expect(await getRule(w.as(w.anna), rule.id)).toMatchObject({ enabled: true, command: 'remove tag waiting', version: rule.version });

    // Previewing, which a viewer may, changes nothing.
    const before = await getIssue(w.as(w.anna), issue.id);
    const preview = await previewRule(viewer, { ...draft, command: 'State Fixed' });
    expect(preview.sample.find((x) => x.issue.id === issue.id)?.changes).toEqual([{ field: 'State', from: 'Open', to: 'Fixed' }]);
    expect((await getIssue(w.as(w.anna), issue.id)).version).toBe(before.version);
    // She can't change the issue herself. She may comment, and the managers' rule acts on that, as the
    // workflow agent: what it changes is theirs to say, and "me" is all she brings to it.
    await expect(updateIssue(viewer, issue.id, { summary: 'Mine now' })).rejects.toMatchObject({ status: 403 });
    await addComment(viewer, issue.id, 'Chloé signs.');
    await settle();
    expect(tagsOf(await getIssue(w.as(w.anna), issue.id))).toEqual([]);
    const byRule = (await issueActivity(w.as(w.anna), issue.id)).find((e) => e.type === 'issue.updated' && e.data.automation);
    expect(byRule!.actor).toMatchObject({ login: 'workflow', channel: 'automation' });
    expect(byRule!.data.automation).toMatchObject({ rule: rule.id, by: dana.id });
  });
});
