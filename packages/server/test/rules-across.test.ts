/**
 * Rules across issues (docs/architecture.md, D32): a further condition on related issues, acting
 * on related issues, telling people, and calling a webhook.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IssueDetail } from '@a4a/shared';
import { notesIn } from '@a4a/shared/notes';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { activities, mailOutbox, notificationSettings, rules, users, webhookDeliveries, webhooks } from '../src/db/schema';
import { createWebhook, deleteWebhook, webhookConsumer } from '../src/events/webhooks';
import { OutboxWorker } from '../src/events/worker';
import { hmacSha256 } from '../src/lib/crypto';
import { notifierConsumer } from '../src/notify/notifier';
import { toEventDto } from '../src/events/activity';
import { translatorFor } from '../src/i18n';
import { issueActivity } from '../src/services/activity';
import { addComment } from '../src/services/comments';
import { createIssue, getIssue, updateIssue } from '../src/services/issues';
import { linkIssues } from '../src/services/links';
import { addMember, removeMember } from '../src/services/members';
import { listNotifications } from '../src/services/notifications';
import { createProject, updateProject } from '../src/services/projects';
import { watchIssue } from '../src/services/watchers';
import { presentField } from '../src/tools/registry';
import { MAX_DEPTH, RuleEngine } from '../src/workflow/engine';
import { createRule, listRuleRuns, previewRule, updateRule } from '../src/workflow/rules';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let engine: RuleEngine;
let worker: OutboxWorker;
let receiver: { server: Server; url: string; got: { headers: IncomingMessage['headers']; body: string }[]; status: number };

const value = (i: IssueDetail, name: string) => presentField(i.fields.find((f) => f.name === name)!);
const tagsOf = (i: IssueDetail) => i.tags.map((t) => t.name).sort();
const state = async (id: string) => value(await getIssue(w.adminCtx, id), 'State');

/** Let the outbox catch up, a few passes, so chains of rules play out and messages are delivered. */
async function settle() {
  for (let i = 0; i < 8; i++) await worker.drain();
}

async function family(project: string, parentSummary: string, children: string[]) {
  const parent = await createIssue(w.as(w.ben), { project, summary: parentSummary });
  const kids: IssueDetail[] = [];
  for (const summary of children) {
    const kid = await createIssue(w.as(w.ben), { project, summary });
    await linkIssues(w.adminCtx, kid.id, 'subtask of', parent.id);
    kids.push(kid);
  }
  await settle();
  return { parent, kids };
}

beforeAll(async () => {
  // Email is on, so the outbox is written; no mail sender runs here, and nothing listens on port 9.
  w = await createWorld({ config: { smtpUrl: 'smtp://127.0.0.1:9', notifyWindowMs: 0 } });
  engine = new RuleEngine(w.app, () => {});
  worker = new OutboxWorker(w.app, [engine.consumer(), notifierConsumer(w.app), webhookConsumer(w.app)], {}, [], () => {});
  await worker.drain();
  await updateProject(w.adminCtx, 'WEB', { lead: 'ben' });
  for (const u of [w.anna, w.ben, w.viewer]) await w.app.db.update(users).set({ email: `${u.login}@example.com`, emailVerified: true }).where(eq(users.id, u.id));
  w.app.schema.invalidate();

  const got: { headers: IncomingMessage['headers']; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ headers: req.headers, body });
      res.statusCode = receiver.status;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  receiver = { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, got, status: 200 };
});

afterEach(async () => {
  await w.app.db.delete(rules);
  w.app.schema.invalidate();
  receiver.got.length = 0;
  receiver.status = 200;
});

afterAll(async () => {
  await worker.stop();
  await new Promise((r) => receiver.server.close(r));
  await w?.close();
});

describe('rules across issues', () => {
  it('fixes a parent when the last of its subtasks is resolved: the classic', async () => {
    const rule = await createRule(w.adminCtx, {
      project: 'BACK',
      name: 'Done subtasks fix their parent',
      kind: 'change',
      trigger: 'updated',
      field: 'State',
      query: '#Resolved',
      related: { of: 'siblings', match: 'all', query: '#Resolved' },
      target: { to: 'parent' },
      command: 'State Fixed',
    });
    expect(rule.sentence).toBe(
      "When an issue's State changes, if it matches “#Resolved” and all of its parent's subtasks match “#Resolved”, then apply “State Fixed” to its parent.",
    );
    const { parent, kids } = await family('BACK', 'Ship the export', ['Write the exporter', 'Document the export']);
    const before = await state(parent.id);

    await updateIssue(w.as(w.ben), kids[0]!.id, { fields: { State: 'Fixed' } });
    await settle();
    expect(await state(parent.id)).toBe(before);

    await updateIssue(w.as(w.anna), kids[1]!.id, { fields: { State: 'Verified' } });
    await settle();
    expect(await state(parent.id)).toBe('Fixed');

    const history = await issueActivity(w.adminCtx, parent.id);
    const byRule = history.find((e) => e.type === 'issue.updated' && e.data.automation)!;
    expect(byRule.actor).toMatchObject({ login: 'workflow', channel: 'automation' });
    expect(byRule.data.automation).toMatchObject({ name: 'Done subtasks fix their parent', depth: 1, by: w.anna.id });
    const runs = await listRuleRuns(w.adminCtx, { rule: rule.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: 'applied', issue: parent.id, by: { login: 'anna' } });

    // A subtask reopened and resolved again: the parent is Fixed already, and the run says so.
    await updateIssue(w.as(w.ben), kids[0]!.id, { fields: { State: 'Open' } });
    await updateIssue(w.as(w.ben), kids[0]!.id, { fields: { State: 'Fixed' } });
    await settle();
    const again = await listRuleRuns(w.adminCtx, { rule: rule.id });
    expect(again[0]).toMatchObject({ outcome: 'unchanged', issue: parent.id });
  });

  it('asks all, or any, of its subtasks, and needs at least one for "all"', async () => {
    const all = await createRule(w.adminCtx, {
      project: 'BACK',
      name: 'All done',
      kind: 'change',
      trigger: 'updated',
      field: 'Priority',
      related: { of: 'subtasks', match: 'all', query: '#Resolved' },
      command: 'tag all-done',
    });
    expect(all.sentence).toBe("When an issue's Priority changes, if all of its subtasks match “#Resolved”, then apply “tag all-done”.");
    await createRule(w.adminCtx, {
      project: 'BACK',
      name: 'Any blocked',
      kind: 'change',
      trigger: 'updated',
      field: 'Priority',
      related: { of: 'subtasks', match: 'any', query: 'State: Blocked' },
      command: 'tag has-blocked',
    });
    const { parent, kids } = await family('BACK', 'Migrate the queue', ['Drain the old queue', 'Switch the writers']);
    const alone = await createIssue(w.as(w.ben), { project: 'BACK', summary: 'No subtasks here' });
    await updateIssue(w.as(w.ben), kids[0]!.id, { fields: { State: 'Fixed' } });
    await updateIssue(w.as(w.ben), kids[1]!.id, { fields: { State: 'Blocked' } });
    for (const id of [parent.id, alone.id]) await updateIssue(w.as(w.ben), id, { fields: { Priority: 'Major' } });
    await settle();
    expect(tagsOf(await getIssue(w.adminCtx, parent.id))).toEqual(['has-blocked']);
    expect(tagsOf(await getIssue(w.adminCtx, alone.id))).toEqual([]);

    await updateIssue(w.as(w.ben), kids[1]!.id, { fields: { State: 'Fixed' } });
    await updateIssue(w.as(w.ben), parent.id, { fields: { Priority: 'Critical' } });
    await settle();
    expect(tagsOf(await getIssue(w.adminCtx, parent.id))).toEqual(['all-done', 'has-blocked']);
  });

  it('acts on the issues linked to it by a phrase, and on its subtasks', async () => {
    await createRule(w.adminCtx, {
      project: 'BACK',
      name: 'Unblock what waits',
      kind: 'change',
      trigger: 'updated',
      field: 'State',
      query: '#Resolved',
      target: { to: 'linked', phrase: 'is required for' },
      command: 'tag unblocked',
    });
    const base = await createIssue(w.as(w.ben), { project: 'BACK', summary: 'Upgrade the driver' });
    const waiting = await createIssue(w.as(w.ben), { project: 'BACK', summary: 'Use the new pool' });
    const unrelated = await createIssue(w.as(w.ben), { project: 'BACK', summary: 'Tidy logs' });
    await linkIssues(w.adminCtx, waiting.id, 'depends on', base.id);
    await linkIssues(w.adminCtx, unrelated.id, 'relates to', base.id);
    await updateIssue(w.as(w.ben), base.id, { fields: { State: 'Fixed' } });
    await settle();
    expect(tagsOf(await getIssue(w.adminCtx, waiting.id))).toEqual(['unblocked']);
    expect(tagsOf(await getIssue(w.adminCtx, unrelated.id))).toEqual([]);
    expect(tagsOf(await getIssue(w.adminCtx, base.id))).toEqual([]);

    await createRule(w.adminCtx, { project: 'BACK', name: 'Close the children', kind: 'change', trigger: 'updated', field: 'State', query: "State: {Won't fix}", target: { to: 'subtasks' }, command: 'State Obsolete' });
    const { parent, kids } = await family('BACK', 'Old dashboard', ['Old chart', 'Old table']);
    await updateIssue(w.as(w.ben), parent.id, { fields: { State: "Won't fix" } });
    await settle();
    for (const k of kids) expect(await state(k.id)).toBe('Obsolete');
  });

  it('carries a chain up a hierarchy, and stops it at the depth limit', async () => {
    await createRule(w.adminCtx, {
      project: 'BACK',
      name: 'Fix the parent',
      kind: 'change',
      trigger: 'updated',
      field: 'State',
      query: '#Resolved',
      related: { of: 'siblings', match: 'all', query: '#Resolved' },
      target: { to: 'parent' },
      command: 'State Fixed',
    });
    // Five levels: each the only subtask of the one above.
    const levels: IssueDetail[] = [];
    for (let i = 0; i < MAX_DEPTH + 2; i++) levels.push(await createIssue(w.as(w.ben), { project: 'BACK', summary: `Level ${i}` }));
    for (let i = 0; i + 1 < levels.length; i++) await linkIssues(w.adminCtx, levels[i]!.id, 'subtask of', levels[i + 1]!.id);
    await settle();
    await updateIssue(w.as(w.ben), levels[0]!.id, { fields: { State: 'Fixed' } });
    await settle();
    const states = await Promise.all(levels.map((l) => state(l.id)));
    // The change, then three rules deep; the fourth step is where it stops.
    expect(states.slice(0, MAX_DEPTH + 1)).toEqual(Array(MAX_DEPTH + 1).fill('Fixed'));
    expect(states[MAX_DEPTH + 1]).not.toBe('Fixed');
    // The run log says so on the issue it would have changed.
    const skipped = (await listRuleRuns(w.adminCtx, { project: 'BACK' })).filter((r) => r.outcome === 'skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ issue: levels[MAX_DEPTH + 1]!.id, message: expect.stringContaining(`stop after ${MAX_DEPTH} steps`) });
  });

  it('acts once per issue in a loop between linked issues', async () => {
    const rule = await createRule(w.adminCtx, { project: 'BACK', name: 'Touch the related', kind: 'change', trigger: 'updated', target: { to: 'linked', phrase: 'relates to' }, command: 'tag touched' });
    const a = await createIssue(w.as(w.ben), { project: 'BACK', summary: 'Left' });
    const b = await createIssue(w.as(w.ben), { project: 'BACK', summary: 'Right' });
    await linkIssues(w.adminCtx, a.id, 'relates to', b.id);
    await settle();
    await updateIssue(w.as(w.ben), a.id, { fields: { Priority: 'Major' } });
    await settle();
    expect(tagsOf(await getIssue(w.adminCtx, a.id))).toEqual(['touched']);
    expect(tagsOf(await getIssue(w.adminCtx, b.id))).toEqual(['touched']);
    const runs = await listRuleRuns(w.adminCtx, { rule: rule.id });
    expect(runs.filter((r) => r.outcome === 'applied').map((r) => r.issue).sort()).toEqual([a.id, b.id].sort());
    expect(runs.filter((r) => r.outcome === 'failed')).toEqual([]);
  });

  it("reads and acts only in its own project, and says so without naming the other", async () => {
    await createProject(w.adminCtx, { key: 'VAULT', name: 'Vault', template: 'software', visibility: 'members' });
    const rule = await createRule(w.adminCtx, { project: 'BACK', name: 'Parent follows', kind: 'change', trigger: 'updated', field: 'State', query: '#Resolved', target: { to: 'parent' }, command: 'State Fixed' });
    const hidden = await createIssue(w.adminCtx, { project: 'VAULT', summary: 'Secret parent' });
    const kid = await createIssue(w.as(w.ben), { project: 'BACK', summary: 'Visible child' });
    await linkIssues(w.adminCtx, kid.id, 'subtask of', hidden.id);
    await settle();
    await updateIssue(w.as(w.ben), kid.id, { fields: { State: 'Fixed' } });
    await settle();
    expect(await state(hidden.id)).not.toBe('Fixed');
    const runs = await listRuleRuns(w.as(w.ben), { rule: rule.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: 'skipped', issue: kid.id });
    expect(runs[0]!.message).toContain('another project');
    expect(runs[0]!.message).not.toContain('VAULT');
    expect(runs[0]!.message).not.toContain(hidden.id);

    // Its further condition doesn't see the other project's subtasks either.
    await createRule(w.adminCtx, { project: 'BACK', name: 'All done here', kind: 'change', trigger: 'updated', field: 'Priority', related: { of: 'subtasks', match: 'all', query: '#Resolved' }, command: 'tag all-done' });
    const { parent, kids } = await family('BACK', 'Mixed family', ['Done here']);
    const elsewhere = await createIssue(w.adminCtx, { project: 'VAULT', summary: 'Open over there' });
    await linkIssues(w.adminCtx, elsewhere.id, 'subtask of', parent.id);
    await updateIssue(w.as(w.ben), kids[0]!.id, { fields: { State: 'Fixed' } });
    await updateIssue(w.as(w.ben), parent.id, { fields: { Priority: 'Major' } });
    await settle();
    expect(tagsOf(await getIssue(w.adminCtx, parent.id))).toEqual(['all-done']);
  });
});

describe('rules that tell people', () => {
  it('tells its assignee and the people it names, never whoever set it off, in their inbox and by email', async () => {
    const rule = await createRule(w.adminCtx, {
      project: 'BACK',
      name: 'Critical bugs are news',
      kind: 'change',
      trigger: 'created',
      query: 'Priority: Critical',
      notify: { to: ['assignee', 'reporter'], people: ['vera'], message: 'A critical bug came in: look at it now.' },
    });
    expect(rule.sentence).toBe('When an issue is created, if it matches “Priority: Critical”, then tell its assignee, its reporter and @vera “A critical bug came in: look at it now.”');
    await w.app.db.insert(notificationSettings).values({ userId: w.viewer.id, email: 'none', digest: false }).onConflictDoNothing();
    const issue = await createIssue(w.as(w.ben), { project: 'BACK', summary: 'Payments fail', fields: { Priority: 'Critical', Assignee: 'anna' } });
    await settle();

    const anna = (await listNotifications(w.as(w.anna), { limit: 50 })).items.find((n) => n.issue.id === issue.id)!;
    expect(anna.kind).toBe('rule');
    expect(anna.title).toBe('The rule “Critical bugs are news” tells you');
    const told = anna.events.find((e) => e.type === 'rule.notified')!;
    expect(told.data).toMatchObject({ message: 'A critical bug came in: look at it now.', people: ['anna', 'vera'] });
    expect((await listNotifications(w.as(w.viewer), { limit: 50 })).items.some((n) => n.issue.id === issue.id && n.kind === 'rule')).toBe(true);
    // Ben reported it, so he set the rule off: he isn't told.
    expect((await listNotifications(w.as(w.ben), { limit: 50 })).items.some((n) => n.issue.id === issue.id && n.kind === 'rule')).toBe(false);

    // Anna's level sends what calls on her; Vera's sends nothing.
    const mails = await w.app.db.select({ userId: mailOutbox.userId }).from(mailOutbox).where(sql`${mailOutbox.dedupeKey} LIKE 'notification:%'`);
    expect(mails.map((m) => m.userId)).toContain(w.anna.id);
    expect(mails.map((m) => m.userId)).not.toContain(w.viewer.id);

    const [run] = await listRuleRuns(w.adminCtx, { rule: rule.id });
    expect(run).toMatchObject({ outcome: 'applied', issue: issue.id });
    expect(run!.message).toBe('Told Anna Schmidt and Vera Viewer');
    // A page says it in its own language, the names joined as that language joins a list.
    expect(notesIn(translatorFor('de'), run!.said, run!.message)).toBe('Benachrichtigt: Anna Schmidt und Vera Viewer.');
    expect(notesIn(translatorFor('ja'), run!.said, run!.message)).toBe('Anna Schmidt、Vera Viewerに通知しました。');
    expect(notesIn(translatorFor('zh'), run!.said, run!.message)).toBe('通知了 Anna Schmidt 和 Vera Viewer。');
    expect(notesIn(translatorFor('ko'), run!.said, run!.message)).toBe('Anna Schmidt 및 Vera Viewer에게 알렸습니다.');
    expect(notesIn(translatorFor('th'), run!.said, run!.message)).toBe('แจ้ง Anna Schmidt และ Vera Viewer แล้ว');

    // The issue's history says it.
    const history = await issueActivity(w.adminCtx, issue.id);
    expect(history.find((e) => e.type === 'rule.notified')!.actor).toMatchObject({ login: 'workflow', channel: 'automation' });
  });

  it('tells only people who can see the issue, and refuses to name one who never could', async () => {
    await createProject(w.adminCtx, { key: 'HUSH', name: 'Hush', template: 'software', visibility: 'members' });
    await addMember(w.adminCtx, 'HUSH', { user: 'anna', role: 'member' });
    await expect(
      createRule(w.adminCtx, { project: 'HUSH', name: 'Tell Ben', kind: 'change', trigger: 'created', notify: { to: [], people: ['ben'], message: 'New.' } }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("Ben Okafor can't see HUSH") });

    const rule = await createRule(w.adminCtx, { project: 'HUSH', name: 'Tell the watchers', kind: 'change', trigger: 'commented', notify: { to: ['watchers'], people: [], message: 'Someone replied.' } });
    const issue = await createIssue(w.adminCtx, { project: 'HUSH', summary: 'Quiet', fields: { Assignee: 'anna' } });
    // Ben watched it while he could see it, then lost the project.
    await addMember(w.adminCtx, 'HUSH', { user: 'ben', role: 'member' });
    await watchIssue(w.as(w.ben), issue.id);
    await removeMember(w.adminCtx, 'HUSH', 'ben');
    await settle();
    await addComment(w.adminCtx, issue.id, 'Any news?');
    await settle();
    const [run] = await listRuleRuns(w.adminCtx, { rule: rule.id });
    expect(run!.message).toBe('Told Anna Schmidt');
    expect((await listNotifications(w.as(w.ben), { limit: 50 })).items.some((n) => n.issue.id === issue.id)).toBe(false);
  });

  it('tells again on each scheduled run', async () => {
    const issue = await createIssue(w.as(w.anna), { project: 'WEB', summary: 'Old idea', tags: ['stale'] });
    await settle();
    const rule = await createRule(w.adminCtx, { project: 'WEB', name: 'Stale reminder', kind: 'schedule', schedule: { every: 'day', at: '09:00' }, query: 'tag: stale', notify: { to: ['reporter'], people: [], message: 'Still needed?' } });
    expect(rule.sentence).toBe('Every day at 09:00, if an issue matches “tag: stale”, then tell its reporter “Still needed?”');
    const [row] = await w.app.db.select().from(rules).where(eq(rules.id, rule.id));
    await engine.runScheduled(row!);
    await engine.runScheduled(row!);
    await settle();
    const told = await w.app.db
      .select({ id: activities.id })
      .from(activities)
      .where(and(eq(activities.type, 'rule.notified'), eq(activities.issueId, (await getIssue(w.adminCtx, issue.id)).uid)));
    expect(told).toHaveLength(2);
  });
});

describe('rules that call a webhook', () => {
  it('calls the webhook it names, signed with its secret, once for each change', { timeout: 20_000 }, async () => {
    const hook = await createWebhook(w.adminCtx, { url: receiver.url, events: [] });
    // A project's manager can't make a rule that calls one: its address and secret are an administrator's.
    await expect(
      createRule(w.as(w.ben), { project: 'WEB', name: 'Page', kind: 'change', trigger: 'created', call: { webhook: hook.id } }),
    ).rejects.toMatchObject({ status: 403 });

    const rule = await createRule(w.adminCtx, { project: 'WEB', name: 'Page the on-call', kind: 'change', trigger: 'created', query: 'Priority: Show-stopper', call: { webhook: hook.id } });
    expect(rule.sentence).toBe(`When an issue is created, if it matches “Priority: Show-stopper”, then call ${new URL(receiver.url).origin}.`);
    expect(rule.call).toEqual({ webhook: hook.id, origin: new URL(receiver.url).origin });

    const issue = await createIssue(w.as(w.anna), { project: 'WEB', summary: 'Site down', fields: { Priority: 'Show-stopper', Assignee: 'ben' } });
    await createIssue(w.as(w.anna), { project: 'WEB', summary: 'Typo', fields: { Priority: 'Minor' } });
    await settle();
    expect(receiver.got).toHaveLength(1);
    const [call] = receiver.got;
    expect(call!.headers['x-a4a-event']).toBe('rule.called');
    expect(call!.headers['x-a4a-signature']).toBe(`sha256=${hmacSha256(hook.secret, call!.body)}`);
    const body = JSON.parse(call!.body) as { type: string; issue: { id: string }; data: { automation: { name: string } } };
    expect(body).toMatchObject({ type: 'rule.called', issue: { id: issue.id }, data: { automation: { name: 'Page the on-call' } } });

    // The same event again (the outbox is at least once): nothing is called twice.
    const [created] = await w.app.db.select().from(activities).where(and(eq(activities.type, 'issue.created'), eq(activities.issueId, (await getIssue(w.adminCtx, issue.id)).uid)));
    await engine.onEvent(toEventDto(await w.app.schema.get(), created!));
    await settle();
    expect(receiver.got).toHaveLength(1);

    // A webhook a rule calls can't be removed from under it.
    await expect(deleteWebhook(w.adminCtx, hook.id)).rejects.toMatchObject({ status: 409 });
    // Its manager can turn it off, and nothing else.
    await expect(updateRule(w.as(w.ben), rule.id, { name: 'Renamed' })).rejects.toMatchObject({ status: 403 });
    await updateRule(w.as(w.ben), rule.id, { enabled: false });

    // A receiver that fails: three tries, each in the webhook's deliveries, and the rule still ran.
    await updateRule(w.adminCtx, rule.id, { enabled: true });
    receiver.status = 500;
    await createIssue(w.as(w.anna), { project: 'WEB', summary: 'Site down again', fields: { Priority: 'Show-stopper', Assignee: 'ben' } });
    await settle();
    const tries = await w.app.db.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.webhookId, hook.id), eq(webhookDeliveries.success, false)));
    expect(tries.map((t) => [t.eventType, t.statusCode])).toEqual([
      ['rule.called', 500],
      ['rule.called', 500],
      ['rule.called', 500],
    ]);
    expect((await listRuleRuns(w.adminCtx, { rule: rule.id }))[0]).toMatchObject({ outcome: 'applied' });
  });

  it('calls only an https webhook, or one on this machine', async () => {
    const plain = await createWebhook(w.adminCtx, { url: 'http://hooks.example.com/a4a', events: ['issue.created'], active: false });
    await expect(createRule(w.adminCtx, { project: 'WEB', name: 'Plain', kind: 'change', trigger: 'created', call: { webhook: plain.id } })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("Its webhook's address isn't https"),
    });
    // And a webhook can't listen for a rule's call: it goes only where a rule sends it.
    await expect(createWebhook(w.adminCtx, { url: receiver.url, events: ['rule.called'] })).rejects.toMatchObject({ status: 400 });
    await w.app.db.delete(webhooks).where(eq(webhooks.id, plain.id));
  });
});

describe('what a rule says, and what needs fixing', () => {
  it('says each new part in its sentence', async () => {
    const preview = (input: Parameters<typeof previewRule>[1]) => previewRule(w.adminCtx, input);
    expect((await preview({ project: 'BACK', name: 'x', kind: 'change', trigger: 'created', related: { of: 'parent', query: 'State: Open' }, command: 'tag child' })).sentence).toBe(
      'When an issue is created, if its parent matches “State: Open”, then apply “tag child”.',
    );
    expect((await preview({ project: 'BACK', name: 'x', kind: 'change', trigger: 'updated', related: { of: 'linked', phrase: 'depends on', match: 'any', query: '#Unresolved' }, command: 'tag waiting' })).sentence).toBe(
      'When an issue changes, if any issue it depends on matches “#Unresolved”, then apply “tag waiting”.',
    );
    expect(
      (
        await preview({
          project: 'BACK',
          name: 'x',
          kind: 'change',
          trigger: 'updated',
          field: 'State',
          query: '#Unresolved',
          target: { to: 'parent' },
          notify: { to: ['watchers', 'managers'], people: [], message: 'A subtask was reopened.' },
        })
      ).sentence,
    ).toBe("When an issue's State changes, if it matches “#Unresolved”, then tell its parent's watchers and the project's managers “A subtask was reopened.”");
    expect(
      (await preview({ project: 'BACK', name: 'x', kind: 'schedule', schedule: { every: 'hour' }, related: { of: 'subtasks', query: '#Resolved' }, target: { to: 'subtasks' }, command: 'tag old' })).sentence,
    ).toBe('Every hour, for every issue where all of its subtasks match “#Resolved”, then apply “tag old” to its subtasks.');
  });

  it('underlines what it can fix', async () => {
    const problems = async (input: Parameters<typeof previewRule>[1]) => (await previewRule(w.adminCtx, input)).problems.map((p) => `${p.part}: ${p.message}${p.hint ? ` (${p.hint})` : ''}`);
    expect(await problems({ project: 'BACK', name: 'x', kind: 'change', trigger: 'created', target: { to: 'linked', phrase: 'blocks' }, command: 'tag x' })).toEqual([
      expect.stringMatching(/^target: There is no link “blocks” here \(Say one of: .*depends on.*\)$/),
    ]);
    expect(await problems({ project: 'BACK', name: 'x', kind: 'change', trigger: 'created', target: { to: 'linked', phrase: 'subtask of' }, command: 'tag x' })).toEqual([
      'target: “subtask of” is a subtask link (Say “its parent” instead.)',
    ]);
    expect(await problems({ project: 'BACK', name: 'x', kind: 'change', trigger: 'created', related: { of: 'subtasks', query: ' ' }, command: 'tag x' })).toEqual([
      'related: Say what they must match (e.g. #Resolved)',
    ]);
    expect(await problems({ project: 'BACK', name: 'x', kind: 'change', trigger: 'created', notify: { to: [], people: ['nobody-here'], message: 'Hi.' } })).toEqual([
      'notify: There is no one called “nobody-here” (Name someone by their login, e.g. anna.)',
    ]);
    expect(await problems({ project: 'BACK', name: 'x', kind: 'change', trigger: 'created', notify: { to: [], people: [], message: 'Hi.' } })).toEqual([
      "notify: Say whom it tells: its assignee, its reporter, its watchers, the project's managers, or people by name",
    ]);
    expect(await problems({ project: 'BACK', name: 'x', kind: 'change', trigger: 'created' })).toEqual([
      'command: Say what it does: a change to make, a comment to post, whom to tell, or a webhook to call (e.g. tag urgent)',
    ]);
  });

  it('previews the issues it would act on, and whom it would tell', async () => {
    const parent = await createIssue(w.as(w.ben), { project: 'BACK', summary: 'Preview parent', fields: { Assignee: 'ben' } });
    const kid = await createIssue(w.as(w.ben), { project: 'BACK', summary: 'Preview child', tags: ['preview-child'], fields: { State: 'Fixed', Assignee: 'anna' } });
    await linkIssues(w.adminCtx, kid.id, 'subtask of', parent.id);
    const kids = [kid];
    const p = await previewRule(w.as(w.anna), {
      project: 'BACK',
      name: 'x',
      kind: 'change',
      trigger: 'updated',
      field: 'State',
      query: '#Resolved tag: preview-child',
      related: { of: 'siblings', query: '#Resolved' },
      target: { to: 'parent' },
      command: 'State Fixed',
      notify: { to: ['assignee'], people: [], message: 'All done.' },
    });
    expect(p.ok).toBe(true);
    expect(p.matching).toBe(1);
    expect(p.sample).toHaveLength(1);
    expect(p.sample[0]).toMatchObject({ issue: { id: parent.id }, via: { id: kids[0]!.id }, told: [{ login: 'ben' }] });
    expect(p.sample[0]!.changes.map((c) => `${c.field}: ${c.to}`)).toEqual(['State: Fixed']);
    expect(p.note).toContain('It acts on its parent.');
  });
});

