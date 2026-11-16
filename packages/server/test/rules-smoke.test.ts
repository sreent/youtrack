import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxWorker } from '../src/events/worker';
import { createIssue, getIssue, updateIssue } from '../src/services/issues';
import { RuleEngine } from '../src/workflow/engine';
import { createRule, listRuleRuns } from '../src/workflow/rules';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let worker: OutboxWorker;

beforeAll(async () => {
  w = await createWorld();
  worker = new OutboxWorker(w.app, [new RuleEngine(w.app).consumer()], () => {});
  await worker.drain();
});

afterAll(async () => {
  await worker.stop();
  await w?.close();
});

describe('smoke', () => {
  it('applies a rule on creation and refuses with a guard', async () => {
    await createRule(w.adminCtx, { project: 'BACK', name: 'Critical bugs to Anna', kind: 'change', trigger: 'created', query: 'Type: Bug Priority: Critical', command: 'Assignee anna tag urgent' });
    const issue = await createIssue(w.as(w.ben), { project: 'BACK', summary: 'Crash', fields: { Type: 'Bug', Priority: 'Critical' } });
    for (let i = 0; i < 3; i++) await worker.drain();
    const after = await getIssue(w.adminCtx, issue.id);
    expect(after.tags.map((t) => t.name)).toContain('urgent');
    expect(after.fields.find((f) => f.name === 'Assignee')!.value).toMatchObject({ login: 'anna' });
    const runs = await listRuleRuns(w.adminCtx, { project: 'BACK' });
    expect(runs[0]).toMatchObject({ outcome: 'applied', issue: issue.id });

    await createRule(w.adminCtx, { project: 'BACK', name: "Won't fix says why", kind: 'guard', query: "State: Won't fix", requires: 'has: comments', message: 'Say why in a comment.' });
    await expect(updateIssue(w.as(w.ben), issue.id, { fields: { State: "Won't fix" } })).rejects.toMatchObject({ code: 'refused_by_rule', message: 'Say why in a comment.' });
    const still = await getIssue(w.adminCtx, issue.id);
    expect(still.version).toBe(after.version);
  });
});
