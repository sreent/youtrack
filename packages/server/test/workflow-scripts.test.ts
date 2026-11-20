/**
 * Scripted workflows (D40): rules written in JavaScript, state machines, and custom actions, on the
 * one write path every change takes.
 */
import type { IssueDetail } from '@a4a/shared';
import { notesIn } from '@a4a/shared/notes';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands/executor';
import { rules, ruleRuns, stateMachines, workflowActions } from '../src/db/schema';
import { OutboxWorker } from '../src/events/worker';
import { createHttpApp } from '../src/http/app';
import { issueActivity } from '../src/services/activity';
import { issueAgentToken, undoAgentChange } from '../src/services/agents';
import { actorFromToken, issueTokenFor } from '../src/services/auth';
import { createUser } from '../src/services/users';
import { addComment, listComments } from '../src/services/comments';
import { createIssue, getIssue, updateIssue } from '../src/services/issues';
import { updateProject } from '../src/services/projects';
import { presentField } from '../src/tools/registry';
import { createAction, issueWorkflow, runAction, runTransition, updateAction } from '../src/workflow/actions';
import { RuleEngine } from '../src/workflow/engine';
import { createMachine, updateMachine } from '../src/workflow/machines';
import { checkRulePart, createRule, listRuleRuns, previewRule, setScriptLibrary, testRule, updateRule } from '../src/workflow/rules';
import { createWebhook } from '../src/events/webhooks';
import { translatorFor } from '../src/i18n';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let engine: RuleEngine;
let worker: OutboxWorker;

const value = (i: IssueDetail, name: string) => presentField(i.fields.find((f) => f.name === name)!);
const tagsOf = (i: IssueDetail) => i.tags.map((t) => t.name).sort();

async function settle() {
  for (let i = 0; i < 6; i++) await worker.drain();
}

beforeAll(async () => {
  w = await createWorld();
  engine = new RuleEngine(w.app, () => {});
  worker = new OutboxWorker(w.app, [engine.consumer()], {}, [], () => {});
  await worker.drain();
  // Ben manages WEB; Anna is a member of both and manages neither; Vera only reads.
  await updateProject(w.adminCtx, 'WEB', { lead: 'ben' });
});

afterEach(async () => {
  await settle();
  await w.app.db.delete(rules);
  await w.app.db.delete(stateMachines);
  await w.app.db.delete(workflowActions);
  w.app.schema.invalidate();
});

afterAll(async () => {
  await worker.stop();
  await w?.close();
});

describe('scripted rules', () => {
  it('runs on a change, and does what it asks through the command executor, as the workflow agent', async () => {
    const rule = await createRule(w.adminCtx, {
      project: 'BACK',
      name: 'Triage critical bugs',
      kind: 'change',
      trigger: 'created',
      query: 'Type: Bug',
      script: `if (issue.fields.Priority === 'Critical') {
  apply('tag triaged Assignee ' + change.by.login);
  comment('Critical: ' + issue.summary);
  log('triaged', issue.id);
}`,
    });
    expect(rule.script).toContain('triaged');
    expect(rule.sentence).toBe('When an issue is created, if it matches “Type: Bug”, then run its script.');
    const bug = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Checkout crashes', fields: { Type: 'Bug', Priority: 'Critical' } });
    await settle();
    const after = await getIssue(w.adminCtx, bug.id);
    expect(tagsOf(after)).toContain('triaged');
    // "me" in its command is whoever set it off; the change is the workflow agent's.
    expect(value(after, 'Assignee')).toBe('anna');
    const comment = (await listComments(w.adminCtx, bug.id)).find((c) => c.text === 'Critical: Checkout crashes');
    expect(comment?.author?.login).toBe('workflow');
    const [run] = await listRuleRuns(w.adminCtx, { rule: rule.id });
    expect(run).toMatchObject({ outcome: 'applied', issue: bug.id });
    expect(run!.message).toMatch(/Logged: triaged BACK-\d+/);
    expect(run!.changes.map((c) => c.field)).toEqual(expect.arrayContaining(['Assignee', 'Tags']));

    // A normal bug: the script runs and asks for nothing.
    const minor = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Typo', fields: { Type: 'Bug', Priority: 'Minor' } });
    await settle();
    expect(tagsOf(await getIssue(w.adminCtx, minor.id))).not.toContain('triaged');
  });

  it('acts once for each change a person makes, however its own changes set it off again', async () => {
    const rule = await createRule(w.adminCtx, {
      project: 'BACK',
      name: 'Flip priority',
      kind: 'change',
      trigger: 'updated',
      field: 'Priority',
      script: `apply('Priority ' + (issue.fields.Priority === 'Major' ? 'Minor' : 'Major'))`,
    });
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Ping pong', fields: { Priority: 'Normal' } });
    await updateIssue(w.as(w.anna), issue.id, { fields: { Priority: 'Critical' } });
    await settle();
    expect(value(await getIssue(w.adminCtx, issue.id), 'Priority')).toBe('Major');
    const runs = await listRuleRuns(w.adminCtx, { rule: rule.id });
    expect(runs.filter((r) => r.outcome === 'applied')).toHaveLength(1);
  });

  it('writes down where a script went wrong, a refusal, and a script that runs too long', async () => {
    const broken = await createRule(w.adminCtx, { project: 'BACK', name: 'Broken', kind: 'change', trigger: 'created', script: 'const x = 1;\nissue.nothing.here();' });
    const shy = await createRule(w.adminCtx, { project: 'BACK', name: 'Shy', kind: 'change', trigger: 'created', script: "refuse('Not my kind of issue')" });
    const slow = await createRule(w.adminCtx, { project: 'BACK', name: 'Slow', kind: 'change', trigger: 'created', script: 'while (true) {}' });
    const elsewhere = await createRule(w.adminCtx, { project: 'BACK', name: 'Reach out', kind: 'change', trigger: 'created', script: "apply('tag far', 'WEB-1')" });
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Sets them all off' });
    await settle();
    const [b] = await listRuleRuns(w.adminCtx, { rule: broken.id });
    expect(b).toMatchObject({ outcome: 'failed' });
    expect(b!.message).toMatch(/Its script stopped: TypeError: .* \(line 2\)/);
    expect((await listRuleRuns(w.adminCtx, { rule: shy.id }))[0]).toMatchObject({ outcome: 'skipped', message: 'It did nothing: Not my kind of issue' });
    expect((await listRuleRuns(w.adminCtx, { rule: slow.id }))[0]!.message).toMatch(/ran past 250 ms/);
    expect((await listRuleRuns(w.adminCtx, { rule: elsewhere.id }))[0]!.message).toMatch(/can't change WEB-1: a script changes its issue, or one linked to it in BACK/);
    expect(tagsOf(await getIssue(w.adminCtx, issue.id))).toEqual([]);
  });

  it('changes an issue linked to the one it runs on: its parent', async () => {
    const rule = await createRule(w.adminCtx, {
      project: 'BACK',
      name: 'Tell the parent',
      kind: 'change',
      trigger: 'updated',
      field: 'State',
      script: `if (issue.resolved && issue.parent && issue.parent.state !== 'Fixed') apply('tag subtask-done', issue.parent.id)`,
    });
    const parent = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Epic' });
    const child = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Part', links: [{ relation: 'subtask of', issue: parent.id }] });
    await updateIssue(w.as(w.anna), child.id, { fields: { State: 'Fixed' } });
    await settle();
    expect(tagsOf(await getIssue(w.adminCtx, parent.id))).toEqual(['subtask-done']);
    // What it changed there is kept as data, the issue and each of its changes a note (D49), which a page joins as its language does.
    const [run] = await listRuleRuns(w.adminCtx, { rule: rule.id });
    const tags = run!.message.match(/Tags → (.*)$/)?.[1];
    expect(run!.message).toBe(`Also changed ${parent.id}: Tags → ${tags}`);
    expect(run!.said).toEqual([{ key: 'rules.run.alsoChanged', values: { others: [{ key: 'rules.run.otherChanged', values: { issue: parent.id, changes: [{ key: 'rules.run.fieldTo', values: { field: 'Tags', to: tags } }] } }] } }]);
    expect(notesIn(translatorFor('ja'), run!.said, run!.message)).toBe(`ほかに${parent.id}（Tags → ${tags}）を変更しました。`);
  });

  it('runs on a schedule over the issues its query matches', async () => {
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Stale', fields: { Priority: 'Minor' } });
    const rule = await createRule(w.adminCtx, {
      project: 'BACK',
      name: 'Nudge',
      kind: 'schedule',
      schedule: { every: 'day', at: '09:00' },
      query: 'summary: Stale',
      script: `if (change.kind === 'scheduled' && !issue.tags.includes('nudged')) apply('tag nudged')`,
    });
    const [row] = await w.app.db.select().from(rules).where(eq(rules.id, rule.id));
    await engine.runScheduled(row!);
    expect(tagsOf(await getIssue(w.adminCtx, issue.id))).toEqual(['nudged']);
  });

  it('is an administrator’s to write: a manager can only turn one off', async () => {
    const asBen = w.as(w.ben);
    await expect(createRule(asBen, { project: 'WEB', name: 'Mine', kind: 'change', trigger: 'created', script: "apply('tag x')" })).rejects.toMatchObject({ status: 403 });
    const rule = await createRule(w.adminCtx, { project: 'WEB', name: 'Admin’s', kind: 'change', trigger: 'created', script: "apply('tag x')" });
    await expect(updateRule(asBen, rule.id, { script: "apply('tag y')" })).rejects.toMatchObject({ status: 403 });
    await expect(updateRule(asBen, rule.id, { name: 'Renamed' })).rejects.toMatchObject({ status: 403 });
    expect((await updateRule(asBen, rule.id, { enabled: false })).enabled).toBe(false);
    // A syntax error is refused where it is.
    await expect(createRule(w.adminCtx, { project: 'WEB', name: 'Bad', kind: 'change', trigger: 'created', script: "apply('x'\n" })).rejects.toMatchObject({ status: 400 });
    const check = await checkRulePart(w.adminCtx, { project: 'WEB', kind: 'change', part: 'script', text: "const a = 1;\nconst b = ;\n" });
    expect(check.problems).toHaveLength(1);
    expect("const a = 1;\nconst b = ;\n".slice(check.problems[0]!.start, check.problems[0]!.end)).toBe('const b = ;');
  });

  it('previews and test-runs a script on an issue, saving nothing', async () => {
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Try me', fields: { Priority: 'Major' } });
    const draft = {
      project: 'BACK',
      name: 'Bump',
      kind: 'change' as const,
      trigger: 'updated' as const,
      query: 'summary: Try',
      script: "log('was', issue.fields.Priority); apply('Priority Critical tag bumped'); comment('Bumped')",
    };
    const run = await testRule(w.adminCtx, { ...draft, issue: issue.id });
    expect(run).toMatchObject({ ok: true, logs: ['was Major'], comments: ['Bumped'], refusal: null });
    expect(run.applies[0]!.changes.map((c) => [c.field, c.to])).toEqual([
      ['Priority', 'Critical'],
      ['Tags', 'bumped'],
    ]);
    const preview = await previewRule(w.adminCtx, draft);
    expect(preview.sample.find((x) => x.issue.id === issue.id)?.changes.map((c) => c.field)).toEqual(['Priority', 'Tags']);
    const still = await getIssue(w.adminCtx, issue.id);
    expect(value(still, 'Priority')).toBe('Major');
    expect(tagsOf(still)).toEqual([]);
    // Only administrators run scripts by hand, or preview one that isn't saved; anyone who reads
    // the project previews one that is.
    await expect(testRule(w.as(w.anna), { ...draft, issue: issue.id })).rejects.toMatchObject({ status: 403 });
    expect((await previewRule(w.as(w.anna), draft)).note).toMatch(/Only administrators run a script that isn't saved/);
    await createRule(w.adminCtx, draft);
    expect((await previewRule(w.as(w.anna), draft)).sample.find((x) => x.issue.id === issue.id)?.changes.map((c) => c.field)).toEqual(['Priority', 'Tags']);
    const failing = await testRule(w.adminCtx, { ...draft, script: 'nope(', issue: issue.id });
    expect(failing).toMatchObject({ ok: false, error: { kind: 'syntax' } });
  });
});

describe('scripted guards', () => {
  it('refuse a change in their own words, inside the write path, and take all of it back', async () => {
    await createRule(w.adminCtx, {
      project: 'BACK',
      name: 'Say how it was fixed',
      kind: 'guard',
      script: `const fixing = change.changes.some((c) => c.field === 'State' && c.to === 'Fixed');
if (fixing && !issue.comments.length) refuse('Say how it was fixed in a comment first');`,
    });
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Guarded', fields: { Priority: 'Minor' } });
    await expect(updateIssue(w.as(w.anna), issue.id, { fields: { State: 'Fixed', Priority: 'Major' } })).rejects.toMatchObject({
      status: 422,
      code: 'refused_by_rule',
      message: 'Say how it was fixed in a comment first',
    });
    const unchanged = await getIssue(w.adminCtx, issue.id);
    expect(value(unchanged, 'State')).not.toBe('Fixed');
    expect(value(unchanged, 'Priority')).toBe('Minor');
    await addComment(w.as(w.anna), issue.id, 'Fixed by retrying the request.');
    await updateIssue(w.as(w.anna), issue.id, { fields: { State: 'Fixed' } });
    expect(value(await getIssue(w.adminCtx, issue.id), 'State')).toBe('Fixed');
  });

  it('judge a new issue too, and let everything through while broken', async () => {
    const guard = await createRule(w.adminCtx, { project: 'WEB', name: 'No TODO', kind: 'guard', script: "if (issue.summary.includes('TODO')) refuse('Write what it is, not TODO')" });
    await expect(createIssue(w.as(w.anna), { project: 'WEB', summary: 'TODO later' })).rejects.toMatchObject({ code: 'refused_by_rule' });
    await updateRule(w.adminCtx, guard.id, { script: "if (issue.summary.includes('TODO')) undefinedThing()" });
    // A broken guard refuses nothing, and says so in its run log.
    const made = await createIssue(w.as(w.anna), { project: 'WEB', summary: 'TODO now' });
    expect(made.summary).toBe('TODO now');
    await new Promise((r) => setTimeout(r, 50));
    const runs = await w.app.db.select().from(ruleRuns).where(eq(ruleRuns.ruleId, guard.id));
    expect(runs.map((r) => r.outcome)).toEqual(expect.arrayContaining(['refused', 'failed']));
  });
});

describe('state machines', () => {
  async function machine(ctx = w.adminCtx) {
    return createMachine(ctx, {
      project: 'BACK',
      field: 'State',
      transitions: [
        { name: 'Accept', from: ['Submitted'], to: 'Open' },
        { name: 'Start work', from: ['Submitted', 'Open'], to: 'In Progress', condition: 'has: Assignee', command: 'tag started' },
        { name: 'Send to review', from: ['In Progress'], to: 'In Review' },
        { name: 'Approve', from: ['In Review'], to: 'Fixed' },
        { name: 'Reopen', from: ['*'], to: 'Open' },
      ],
    });
  }

  it('refuses a change that skips it, however it is made, and says where the issue can go', async () => {
    const m = await machine();
    expect(m.problems).toEqual([]);
    expect(m.states).toContain('In Review');
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Moves', fields: { State: 'Open' } });
    const refused = await updateIssue(w.as(w.anna), issue.id, { fields: { State: 'Fixed' } }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ status: 422, code: 'refused_by_state_machine', message: "State can't go from Open to Fixed" });
    expect((refused as { hint?: string }).hint).toBe('From Open it can go to In Progress (Start work).');
    // The command bar goes the same way.
    const bar = await runCommand(w.as(w.anna), { issues: [issue.id], command: 'State Fixed' });
    expect(bar.results[0]!.errors[0]).toMatch(/can't go from Open to Fixed/);
    // An issue starts wherever it's put.
    const done = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Born fixed', fields: { State: 'Fixed' } });
    expect(value(done, 'State')).toBe('Fixed');
  });

  it("checks a transition's condition first, and applies its command after, as whoever moves it", async () => {
    await machine();
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Needs an owner', fields: { State: 'Open' } });
    await expect(runTransition(w.as(w.anna), issue.id, { transition: 'Start work' })).rejects.toMatchObject({
      code: 'refused_by_state_machine',
      message: `“Start work” needs ${issue.id} to match “has: Assignee” first`,
    });
    const wf = await issueWorkflow(w.as(w.anna), issue.id);
    expect(wf.transitions).toEqual([{ field: 'State', name: 'Start work', to: 'In Progress', allowed: false, why: 'It needs the issue to match “has: Assignee”' }]);
    await updateIssue(w.as(w.anna), issue.id, { fields: { Assignee: 'anna' } });
    const moved = await runTransition(w.as(w.anna), issue.id, { transition: 'Start work' });
    expect(value(moved, 'State')).toBe('In Progress');
    expect(tagsOf(moved)).toEqual(['started']);
    const updated = (await issueActivity(w.adminCtx, issue.id)).filter((e) => e.type === 'issue.updated');
    expect(updated.some((e) => e.data?.transition === 'Start work' && e.actor.login === 'anna')).toBe(true);
    // By name in the command language too; and by value, which finds its transition.
    await runCommand(w.as(w.anna), { issues: [issue.id], command: 'Send to review' });
    await updateIssue(w.as(w.anna), issue.id, { fields: { State: 'Fixed' } });
    expect(value(await getIssue(w.adminCtx, issue.id), 'State')).toBe('Fixed');
    // Someone who can only read is offered nothing.
    expect(await issueWorkflow(w.as(w.viewer), issue.id)).toEqual({ transitions: [], actions: [] });
  });

  it('leaves history alone: an import is not a move', async () => {
    await machine();
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Imported', fields: { State: 'Open' } });
    await updateIssue(w.adminCtx, issue.id, { fields: { State: 'Fixed' } }, { data: { imported: { source: 'test' } } });
    expect(value(await getIssue(w.adminCtx, issue.id), 'State')).toBe('Fixed');
  });

  it('lets a person undo what an agent moved, though no transition goes back', async () => {
    await createMachine(w.adminCtx, { project: 'WEB', field: 'State', transitions: [{ name: 'Start', from: ['Open'], to: 'In Progress' }] });
    await createUser(w.adminCtx, { login: 'robo', name: 'Robo', role: 'member', isBot: true });
    const token = (await issueAgentToken(w.adminCtx, 'robo', { name: 'ci', scopes: ['read', 'write'] })).token;
    const agent = { app: w.app, db: w.app.db, actor: (await actorFromToken(w.app.db, token, 'mcp'))! };
    const issue = await createIssue(w.as(w.anna), { project: 'WEB', summary: 'Moved by an agent', fields: { State: 'Open' } });
    await runTransition(agent, issue.id, { transition: 'Start' });
    await expect(updateIssue(w.as(w.anna), issue.id, { fields: { State: 'Open' } })).rejects.toMatchObject({ code: 'refused_by_state_machine' });
    const moved = (await issueActivity(w.adminCtx, issue.id)).find((e) => e.type === 'issue.updated' && e.actor.login === 'robo')!;
    await undoAgentChange(w.as(w.anna), moved.id);
    expect(value(await getIssue(w.adminCtx, issue.id), 'State')).toBe('Open');
  });

  it("is checked when it's saved, is the project manager's, and refuses nothing while off", async () => {
    await expect(
      createMachine(w.adminCtx, { project: 'BACK', field: 'State', transitions: [{ name: 'Go', from: ['Open'], to: 'Nowhere' }] }),
    ).rejects.toMatchObject({ status: 400, details: { problems: [expect.objectContaining({ part: 'to', transition: 0 })] } });
    await expect(
      createMachine(w.adminCtx, {
        project: 'BACK',
        field: 'State',
        transitions: [
          { name: 'One', from: ['Open'], to: 'Fixed' },
          { name: 'Two', from: ['*'], to: 'Fixed', command: 'State Open' },
        ],
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(createMachine(w.adminCtx, { project: 'BACK', field: 'Priority', transitions: [{ name: 'Up', from: ['Minor'], to: 'Major' }] })).resolves.toBeTruthy();
    await expect(createMachine(w.as(w.anna), { project: 'WEB', field: 'State', transitions: [{ name: 'Go', from: ['Open'], to: 'Fixed' }] })).rejects.toMatchObject({ status: 403 });
    const web = await createMachine(w.as(w.ben), { project: 'WEB', field: 'State', transitions: [{ name: 'Go', from: ['Open'], to: 'Fixed' }] });
    const issue = await createIssue(w.as(w.anna), { project: 'WEB', summary: 'Free', fields: { State: 'Open' } });
    await expect(updateIssue(w.as(w.anna), issue.id, { fields: { State: 'In Progress' } })).rejects.toMatchObject({ code: 'refused_by_state_machine' });
    await updateMachine(w.as(w.ben), web.id, { enabled: false });
    await updateIssue(w.as(w.anna), issue.id, { fields: { State: 'In Progress' } });
    expect(value(await getIssue(w.adminCtx, issue.id), 'State')).toBe('In Progress');
  });
});

describe('custom actions', () => {
  it('runs a command action as whoever presses it, where its condition holds, and by name as a command', async () => {
    const action = await createAction(w.as(w.ben), { project: 'WEB', name: 'Escalate', command: 'Priority Critical tag escalated', condition: '#Unresolved' });
    expect(action.problems).toEqual([]);
    const issue = await createIssue(w.as(w.anna), { project: 'WEB', summary: 'On fire', fields: { Priority: 'Normal' } });
    const wf = await issueWorkflow(w.as(w.anna), issue.id);
    expect(wf.actions).toEqual([{ id: action.id, name: 'Escalate', scripted: false, allowed: true, why: null }]);
    const after = await runAction(w.as(w.anna), issue.id, action.id);
    expect(value(after, 'Priority')).toBe('Critical');
    expect(tagsOf(after)).toEqual(['escalated']);
    const other = await createIssue(w.as(w.anna), { project: 'WEB', summary: 'Also on fire' });
    const res = await runCommand(w.as(w.anna), { issues: [other.id], command: 'escalate' });
    expect(res.description).toBe('run the action “Escalate”');
    expect(res.results[0]!.errors).toEqual([]);
    expect(tagsOf(await getIssue(w.adminCtx, other.id))).toEqual(['escalated']);
    // Not offered for a resolved issue, and not for someone who can only read.
    await updateIssue(w.as(w.anna), other.id, { fields: { State: 'Fixed' } });
    expect((await issueWorkflow(w.as(w.anna), other.id)).actions).toEqual([]);
    await expect(runAction(w.as(w.viewer), issue.id, action.id)).rejects.toMatchObject({ status: 403 });
    // Its name can't be a value, which reads as setting it.
    await expect(createAction(w.as(w.ben), { project: 'WEB', name: 'Critical', command: 'tag x' })).rejects.toMatchObject({ status: 400 });
  });

  it("runs a scripted action (an administrator's) over an issue and its subtasks, all or nothing", async () => {
    await expect(createAction(w.as(w.ben), { project: 'WEB', name: 'Close all', script: "apply('State Done')" })).rejects.toMatchObject({ status: 403 });
    const action = await createAction(w.adminCtx, {
      project: 'WEB',
      name: 'Close subtasks',
      script: `const open = issue.subtasks.filter((t) => !t.resolved);
if (!open.length) refuse('It has no open subtasks');
for (const t of open) apply('State Done', t.id);
comment('Closed ' + open.length + ' subtasks');`,
    });
    const parent = await createIssue(w.as(w.anna), { project: 'WEB', summary: 'Release' });
    const a = await createIssue(w.as(w.anna), { project: 'WEB', summary: 'Part A', links: [{ relation: 'subtask of', issue: parent.id }] });
    const b = await createIssue(w.as(w.anna), { project: 'WEB', summary: 'Part B', links: [{ relation: 'subtask of', issue: parent.id }] });
    // Run as a command, it may change only its own issue.
    const bar = await runCommand(w.as(w.anna), { issues: [parent.id], command: 'Close subtasks' });
    expect(bar.results[0]!.errors[0]).toMatch(/changes only/);
    await runAction(w.as(w.anna), parent.id, action.id);
    const last = (await listComments(w.adminCtx, parent.id)).at(-1);
    expect(last?.text).toBe('Closed 2 subtasks');
    expect(last?.author?.login).toBe('anna');
    for (const id of [a.id, b.id]) expect(value(await getIssue(w.adminCtx, id), 'State')).toBe('Done');
    await expect(runAction(w.as(w.anna), parent.id, action.id)).rejects.toMatchObject({ status: 422, code: 'refused_by_action', message: 'It has no open subtasks' });
    // A manager can turn it off, and not change it.
    await expect(updateAction(w.as(w.ben), action.id, { name: 'Close' })).rejects.toMatchObject({ status: 403 });
    expect((await updateAction(w.as(w.ben), action.id, { enabled: false })).enabled).toBe(false);
  });
});

describe('over REST', () => {
  it('offers the issue page its transitions and actions, and test runs to administrators', async () => {
    const http = createHttpApp(w.app);
    const admin = (await issueTokenFor(w.app.db, w.admin.id, { name: 'ops', scopes: ['read', 'write', 'admin'] })).token;
    const anna = (await issueTokenFor(w.app.db, w.anna.id, { name: 'anna-cli', scopes: ['read', 'write'] })).token;
    const call = async (token: string, method: string, path: string, body?: unknown) => {
      const res = await http.request(`/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const m = await call(admin, 'POST', '/state-machines', { project: 'WEB', field: 'State', transitions: [{ name: 'Start', from: ['Open'], to: 'In Progress' }] });
    expect(m.status).toBe(201);
    const act = await call(admin, 'POST', '/workflow-actions', { project: 'WEB', name: 'Flag', command: 'tag flagged' });
    expect(act.status).toBe(201);
    const issue = await createIssue(w.as(w.anna), { project: 'WEB', summary: 'Over the wire', fields: { State: 'Open' } });
    const wf = await call(anna, 'GET', `/issues/${issue.id}/workflow`);
    expect(wf.body).toEqual({ transitions: [{ field: 'State', name: 'Start', to: 'In Progress', allowed: true, why: null }], actions: [{ id: act.body.id, name: 'Flag', scripted: false, allowed: true, why: null }] });
    expect((await call(anna, 'POST', `/issues/${issue.id}/transitions`, { transition: 'Start' })).body.fields.find((f: { name: string }) => f.name === 'State')).toBeTruthy();
    const ran = await call(anna, 'POST', `/issues/${issue.id}/actions/${act.body.id}`, {});
    expect(ran.status).toBe(200);
    expect(ran.body.tags.map((t: { name: string }) => t.name)).toEqual(['flagged']);
    const skip = await call(anna, 'PATCH', `/issues/${issue.id}`, { fields: { State: 'Done' } });
    expect(skip).toMatchObject({ status: 422, body: { error: { code: 'refused_by_state_machine' } } });
    const test = { project: 'WEB', name: 'T', kind: 'change', trigger: 'created', script: "log(issue.id)", issue: issue.id };
    expect((await call(anna, 'POST', '/rules/test', test)).status).toBe(403);
    expect((await call(admin, 'POST', '/rules/test', test)).body).toMatchObject({ ok: true, logs: [issue.id] });
  });
});
describe("a script calls out, and a project's scripts share a library (D40's revisit)", () => {
  it('calls only the webhook it names, by its origin, with its own body', async () => {
    const hook = await createWebhook(w.adminCtx, { url: 'https://hooks.example/deliver', events: ['*'], project: 'BACK' });
    const rule = await createRule(w.adminCtx, { project: 'BACK', name: 'Ring the hook', kind: 'change', trigger: 'created', query: 'Type: Bug', script: `call('https://hooks.example', { n: 1 }); log('asked');` });
    const ring = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Ring it', fields: { Type: 'Bug' } });
    await settle();
    const events = await issueActivity(w.adminCtx, ring.id);
    const called = events.filter((e) => e.type === 'script.called');
    const runs = await listRuleRuns(w.adminCtx, { project: 'BACK' });
    expect(called.length, runs[0]?.message).toBe(1);
    expect(called[0]!.data).toMatchObject({ webhook: hook.id });
    expect(runs[0]!.message).toContain('Called https://hooks.example');
  });
  it('runs its project\'s library before every script in it, as `library`', async () => {
    await setScriptLibrary(w.adminCtx, 'BACK', '({ twice: (n) => n * 2 })');
    const rule = await createRule(w.adminCtx, { project: 'BACK', name: 'Twice', kind: 'change', trigger: 'created', query: 'Type: Bug', script: `apply('tag doubled'); comment('Twice ' + library.twice(4));` });
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Twice four', fields: { Type: 'Bug' } });
    await settle();
    const after = await getIssue(w.adminCtx, issue.id);
    const runs = await listRuleRuns(w.adminCtx, { project: 'BACK', rule: rule.id });
    expect(tagsOf(after), runs[0]?.message).toContain('doubled');
  });
});
