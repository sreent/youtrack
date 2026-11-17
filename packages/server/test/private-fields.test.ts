/**
 * Fields only some people see (D50): a project's managers make a field private there; only people
 * whose role reads private fields get it, and only those whose role changes them set it. To anyone
 * else it isn't there, in the words used for a field that doesn't exist, wherever an issue is read.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueForCard } from '../src/chat/service';
import { runCommand } from '../src/commands/executor';
import type { Ctx } from '../src/context';
import { createWebhook, webhookConsumer } from '../src/events/webhooks';
import { OutboxWorker } from '../src/events/worker';
import { createHttpApp } from '../src/http/app';
import { AppError } from '../src/lib/errors';
import { notifierConsumer } from '../src/notify/notifier';
import { countIssues, parseQueryForApi, searchIssues } from '../src/search/service';
import { eventFeed, issueActivity } from '../src/services/activity';
import { issueTokenFor } from '../src/services/auth';
import { eventFor, scopeFields } from '../src/services/access';
import { boardView, createBoard } from '../src/services/boards';
import { attachField, createField, updateField } from '../src/services/fields';
import { issuesPerFieldReport } from '../src/services/more-reports';
import { cloneIssue, moveIssue } from '../src/services/move';
import { changeOf, scriptInput } from '../src/workflow/script-issue';
import { findIssue } from '../src/services/issues';
import { openStream } from './sse-client';
import { createIssue, getIssue, updateIssue } from '../src/services/issues';
import { addMember } from '../src/services/members';
import { listNotifications } from '../src/services/notifications';
import { createRole } from '../src/services/roles';
import { insertUser } from '../src/services/users';
import { watchIssue } from '../src/services/watchers';
import { toolByName } from '../src/tools/registry';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let admin: Ctx;
let anna: Ctx; // a member of BACK, as everyone is in an open project: no private fields
let ben: Ctx; // "Team" in BACK: reads its private fields, and may not change them
let chloe: Ctx; // manages BACK: reads and changes them
let outbox: OutboxWorker;
let riskId: string;
let customerId: string;
const hook: { server?: Server; url: string; got: string[] } = { url: '', got: [] };

async function failure(call: () => Promise<unknown>): Promise<AppError> {
  try {
    await call();
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error('expected it to fail');
}

const names = (fields: { name: string }[]) => fields.map((f) => f.name);

beforeAll(async () => {
  w = await createWorld();
  admin = w.adminCtx;
  anna = w.as(w.anna);
  ben = w.as(w.ben);
  chloe = w.as(await insertUser(w.app.db, { login: 'chloe', name: 'Chloé Martin', role: 'member' }));
  w.app.schema.invalidate();
  await addMember(admin, 'BACK', { user: 'chloe', role: 'manager' });
  await createRole(admin, { name: 'Team', permissions: ['read', 'comment', 'create', 'edit', 'readPrivate'] });
  await addMember(admin, 'BACK', { user: 'ben', role: 'Team' });
  const risk = await createField(admin, { name: 'Risk', type: 'enum', multi: false, description: '', values: [{ name: 'Low' }, { name: 'High' }] });
  const customer = await createField(admin, { name: 'Customer', type: 'string', multi: false, description: '', values: [] });
  riskId = risk.id;
  customerId = customer.id;
  await attachField(admin, 'BACK', risk.id, {});
  await attachField(admin, 'BACK', customer.id, {});
  await attachField(admin, 'WEB', customer.id, {});
  hook.server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hook.got.push(body);
      res.end();
    });
  });
  await new Promise<void>((r) => hook.server!.listen(0, '127.0.0.1', r));
  hook.url = `http://127.0.0.1:${(hook.server.address() as AddressInfo).port}/hook`;
  await createWebhook(admin, { url: hook.url, events: ['*'] });
  outbox = new OutboxWorker(w.app, [notifierConsumer(w.app), webhookConsumer(w.app)], {}, [], () => {});
  await outbox.drain();
});

afterAll(async () => {
  await outbox?.stop();
  await new Promise((r) => hook.server?.close(r));
  await w?.close();
});

describe('making a field private', () => {
  it("is its project's managers' to do, and not for State or Assignee", async () => {
    expect((await failure(() => attachField(anna, 'BACK', riskId, { private: true }))).status).toBe(403);
    const fields = await attachField(chloe, 'BACK', riskId, { private: true });
    expect(fields.find((f) => f.name === 'Risk')?.private).toBe(true);
    await attachField(chloe, 'BACK', customerId, { private: true });
    const s = await w.app.schema.get();
    for (const name of ['State', 'Assignee']) {
      const id = [...s.fields.values()].find((f) => f.name === name)!.id;
      const e = await failure(() => attachField(chloe, 'BACK', id, { private: true }));
      expect(e.status).toBe(400);
      expect(e.words?.key).toBe('fields.cantBePrivate');
    }
  });

  it('leaves the field out of the project as anyone else reads it, its name too', async () => {
    const app = createHttpApp(w.app);
    const token = (await issueTokenFor(w.app.db, w.anna.id, { name: 'anna', scopes: ['read'] })).token;
    const res = await app.request('/api/v1/projects/BACK/fields', { headers: { authorization: `Bearer ${token}` } });
    const list = (await res.json()) as { name: string; private: boolean }[];
    expect(names(list)).not.toContain('Risk');
    expect(names(list)).not.toContain('Customer');
    // In WEB it's public, and everyone sees it there.
    const web = (await (await app.request('/api/v1/projects/WEB/fields', { headers: { authorization: `Bearer ${token}` } })).json()) as { name: string; private: boolean }[];
    expect(web.find((f) => f.name === 'Customer')?.private).toBe(false);
    const project = await toolByName('get_project')!.run(anna, { project: 'BACK' });
    expect(JSON.stringify(project.data)).not.toContain('Risk');
    const asBen = await toolByName('get_project')!.run(ben, { project: 'BACK' });
    expect(JSON.stringify(asBen.data)).toContain('Risk');
  });
});

describe('reading an issue', () => {
  let id: string;
  let web: string;
  beforeAll(async () => {
    id = (await createIssue(chloe, { project: 'BACK', summary: 'Renewal for Acme', fields: { Risk: 'High', Customer: 'Acme' } })).id;
    web = (await createIssue(chloe, { project: 'WEB', summary: 'Acme landing page', fields: { Customer: 'Acme' } })).id;
    await outbox.drain();
  });

  it('gives it only to who reads private fields, marked private', async () => {
    expect(names((await getIssue(anna, id)).fields)).not.toContain('Risk');
    expect(names((await getIssue(anna, id)).fields)).not.toContain('Customer');
    const seen = (await getIssue(ben, id)).fields.find((f) => f.name === 'Risk');
    expect(seen?.private).toBe(true);
    expect((seen?.value as { name: string }).name).toBe('High');
    // Public in WEB: there it's an ordinary field.
    expect((await getIssue(anna, web)).fields.find((f) => f.name === 'Customer')?.private).toBeUndefined();
    const list = await searchIssues(anna, 'project: BACK');
    expect(list.items.every((i) => !names(i.fields).includes('Risk'))).toBe(true);
    const mcp = await toolByName('get_issue')!.run(anna, { issue: id, comments: 0 });
    expect(JSON.stringify(mcp.data)).not.toContain('High');
    expect(JSON.stringify(mcp.data)).not.toContain('Risk');
  });

  it("answers a search by it as by a field that doesn't exist, and as empty where it's kept", async () => {
    const hidden = await parseQueryForApi(anna, 'Risk: High');
    const none = await parseQueryForApi(anna, 'Rizk: High');
    expect(hidden.ok).toBe(false);
    expect(hidden.problems.map((p) => p.message.replace('Risk', 'Rizk'))).toEqual(none.problems.map((p) => p.message));
    expect(JSON.stringify(hidden.problems)).not.toMatch(/Risk"\?|Did you mean "Risk/);
    expect((await parseQueryForApi(anna, '#High')).ok).toBe(false);
    expect((await parseQueryForApi(anna, 'has: Risk')).ok).toBe(false);
    expect((await parseQueryForApi(ben, 'Risk: High')).ok).toBe(true);
    // Customer is public in WEB, so it's a word anna knows; BACK's values are kept from her.
    const found = await searchIssues(anna, 'Customer: Acme');
    expect(found.items.map((i) => i.id)).toEqual([web]);
    expect((await searchIssues(chloe, 'Customer: Acme')).items.map((i) => i.id).sort()).toEqual([id, web].sort());
    expect((await searchIssues(anna, 'Customer: empty project: BACK')).items.map((i) => i.id)).toContain(id);
    // Grouping by it counts BACK's issues as having none; by Risk, it can't.
    const counted = await countIssues(anna, 'project: BACK', 'Customer');
    expect(counted.groups.find((g) => g.value === 'Acme')).toBeUndefined();
    expect((await countIssues(chloe, 'project: BACK', 'Customer')).groups.find((g) => g.value === 'Acme')?.count).toBe(1);
    expect((await failure(() => countIssues(anna, '', 'Risk'))).words?.key).toBe('query.cannotGroupBy');
  });

  it('sorts by it as if it were empty where it is kept', async () => {
    const a = await createIssue(chloe, { project: 'BACK', summary: 'Aardvark Inc renewal', fields: { Customer: 'Aardvark' } });
    const z = await createIssue(chloe, { project: 'WEB', summary: 'Zebra site', fields: { Customer: 'Zebra' } });
    const q = `issue id: ${a.id}, ${z.id} sort by: Customer asc`;
    expect((await searchIssues(chloe, q)).items.map((i) => i.id)).toEqual([a.id, z.id]);
    // To anna, Aardvark is empty, and empty sorts last.
    expect((await searchIssues(anna, q)).items.map((i) => i.id)).toEqual([z.id, a.id]);
  });
});

describe('changing it', () => {
  let id: string;
  beforeAll(async () => {
    id = (await createIssue(chloe, { project: 'BACK', summary: 'Contract terms' })).id;
  });

  it('is refused to anyone who may not see it, as a field the project lacks', async () => {
    const e = await failure(() => updateIssue(anna, id, { fields: { Risk: 'High' } }));
    const lacks = await failure(() => updateIssue(anna, id, { fields: { Rizk: 'High' } }));
    expect(e.status).toBe(400);
    expect(e.message).toBe(lacks.message.replace('Rizk', 'Risk'));
    expect(e.hint).toBe(lacks.hint);
    expect(e.hint).not.toContain('Risk');
    expect(e.hint).not.toContain('Customer');
    // Setting it to what it holds already says the same: trying values tells nothing.
    await updateIssue(chloe, id, { fields: { Risk: 'Low' } });
    expect((await failure(() => updateIssue(anna, id, { fields: { Risk: 'Low' } }))).message).toBe(e.message);
    const cmd = await runCommand(anna, { issues: [id], command: 'Risk High' });
    expect(cmd.applied).toBe(false);
    const none = await runCommand(anna, { issues: [id], command: 'Rizk High' });
    expect(cmd.problems.map((p) => p.message.replace('Risk', 'Rizk'))).toEqual(none.problems.map((p) => p.message));
    expect((await failure(() => createIssue(anna, { project: 'BACK', summary: 'x', fields: { Risk: 'High' } }))).message).toBe(e.message);
    const tool = await failure(() => toolByName('update_issue')!.run(anna, { issue: id, fields: { Risk: 'High' } } as never));
    expect(tool.message).toBe(e.message);
  });

  it("is refused, saying why, to who sees it and may not change it; a manager changes it", async () => {
    const e = await failure(() => updateIssue(ben, id, { fields: { Risk: 'High' } }));
    expect(e.status).toBe(403);
    expect(e.words).toMatchObject({ key: 'access.roleDoesNotAllow', values: { permission: 'editPrivate' } });
    const cmd = await runCommand(ben, { issues: [id], command: 'Risk High' });
    expect(cmd.results[0]!.errors[0]).toContain('change its private fields');
    const done = await runCommand(chloe, { issues: [id], command: 'Risk High' });
    expect(done.applied).toBe(true);
    // A read-only token of a manager's reads it and doesn't change it.
    expect((await getIssue(ben, id)).fields.find((f) => f.name === 'Risk')).toBeTruthy();
  });

  it("asks nothing of a reporter who can't see a required private field", async () => {
    await attachField(chloe, 'BACK', customerId, { private: true, required: true });
    expect((await createIssue(anna, { project: 'BACK', summary: 'Asked by a member' })).id).toMatch(/^BACK-/);
    expect((await failure(() => createIssue(chloe, { project: 'BACK', summary: 'Asked by a manager' }))).words?.key).toBe('issues.fieldRequired');
    await attachField(chloe, 'BACK', customerId, { private: true, required: false });
  });
});

describe('its changes', () => {
  let id: string;
  beforeAll(async () => {
    id = (await createIssue(chloe, { project: 'BACK', summary: 'Quarterly review', fields: { Customer: 'Globex' } })).id;
    await watchIssue(anna, id);
    await watchIssue(ben, id);
    await outbox.drain();
    hook.got.length = 0;
  });

  it("aren't in the history, the feed or the inbox of anyone it's kept from", async () => {
    await updateIssue(chloe, id, { fields: { Risk: 'High' } });
    await updateIssue(chloe, id, { fields: { Risk: 'Low', Priority: 'Critical' } });
    await outbox.drain();
    const mine = await issueActivity(anna, id);
    const changes = mine.flatMap((e) => e.changes.map((c) => c.field));
    expect(changes).toContain('Priority');
    expect(changes).not.toContain('Risk');
    expect(mine.filter((e) => e.type === 'issue.updated')).toHaveLength(1);
    const created = mine.find((e) => e.type === 'issue.created')!;
    expect(Object.keys(created.data.fields as Record<string, unknown>)).not.toContain('Customer');
    expect(JSON.stringify(mine)).not.toContain('Globex');
    const feed = await eventFeed(anna, { issue: id });
    expect(JSON.stringify(feed)).not.toMatch(/Risk|Globex/);
    expect((await issueActivity(ben, id)).flatMap((e) => e.changes.map((c) => c.field))).toContain('Risk');
    const mcp = await toolByName('get_activity')!.run(anna, { issue: id, limit: 50 });
    expect(JSON.stringify(mcp.data)).not.toContain('Risk');
    // The inbox: the change to Risk alone told her nothing; the other, only of Priority.
    const inbox = (await listNotifications(anna, { issue: id })).items;
    expect(inbox.flatMap((n) => n.events).filter((e) => e.type === 'issue.updated')).toHaveLength(1);
    expect(JSON.stringify(inbox)).not.toContain('Risk');
    const bens = (await listNotifications(ben, { issue: id })).items;
    expect(JSON.stringify(bens)).toContain('Risk');
  });

  it('never reach a webhook: an administrator made it, and nobody knows who reads its end', async () => {
    expect(hook.got.length).toBeGreaterThan(0);
    const sent = hook.got.map((b) => JSON.parse(b) as { type: string; changes: { field: string }[] });
    expect(sent.filter((e) => e.type === 'issue.updated')).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toMatch(/Risk|Globex/);
  });

  it('are kept by the names the field had, after it is renamed', async () => {
    await updateField(admin, riskId, { name: 'Exposure' });
    const mine = await issueActivity(anna, id);
    expect(JSON.stringify(mine)).not.toMatch(/Risk|Exposure/);
    expect(mine.filter((e) => e.type === 'issue.updated')).toHaveLength(1);
    await updateField(admin, riskId, { name: 'Risk' });
  });
});

describe('everywhere else an issue is read', () => {
  let id: string;
  beforeAll(async () => {
    id = (await createIssue(chloe, { project: 'BACK', summary: 'A pilot for a new customer', fields: { Risk: 'High', Customer: 'Initech' } })).id;
  });

  it('gives a board no lane, card value or field of it', async () => {
    const board = await createBoard(chloe, { name: 'Risk board', projects: ['BACK'], swimlaneField: 'Risk' });
    const mine = await boardView(anna, board.id);
    expect(mine.board.swimlaneField).toBeNull();
    expect(mine.swimlanes).toEqual([]);
    expect(JSON.stringify(mine.columns)).not.toMatch(/Initech|"Risk"/);
    const bens = await boardView(ben, board.id);
    expect(bens.board.swimlaneField).toBe('Risk');
    expect(bens.swimlanes).toContain('High');
    expect((await failure(() => createBoard(anna, { name: 'Mine', projects: ['BACK'], swimlaneField: 'Risk' }))).status).toBe(404);
  });

  it("counts it in no report of someone it's kept from", async () => {
    const e = await failure(() => issuesPerFieldReport(anna, { project: 'BACK', field: 'Risk' }));
    expect(e.words?.key).toBe('moreReports.noSuchField');
    expect(e.hint).not.toContain('Risk');
    const report = await issuesPerFieldReport(ben, { project: 'BACK', field: 'Risk' });
    expect(report.values.find((v) => v.label === 'High')?.count).toBeGreaterThan(0);
    // Public in WEB, Customer is a field she can count by, and BACK's values count as none.
    const counted = await issuesPerFieldReport(anna, { field: 'Customer' });
    expect(counted.values.map((v) => v.label)).not.toContain('Initech');
  });

  it("never goes to a channel's card, whoever vouches for it, nor to an app's script", async () => {
    const s = await w.app.schema.get();
    const card = await issueForCard(chloe, id, { everyone: true });
    expect(JSON.stringify(card)).not.toContain('Initech');
    expect(card.facts.map((f) => f.title)).not.toContain('Risk');
    const created = (await eventFeed(chloe, { issue: id })).find((e) => e.type === 'issue.created')!;
    expect(created.data.fields).toHaveProperty('Risk');
    expect(eventFor(null, s, created)!.data.fields).not.toHaveProperty('Risk');
    const row = (await findIssue(w.app.db, s, id))!;
    const app = await scriptInput(w.app.db, s, row, changeOf('updated', null, [{ field: 'Risk', from: 'Low', to: 'High' }]), { unlimited: true });
    expect(Object.keys(app.issue.fields)).not.toContain('Risk');
    expect(app.change.changes).toEqual([]);
    const rule = await scriptInput(w.app.db, s, row, changeOf('updated', null, []));
    expect(rule.issue.fields.Risk).toBe('High');
    // What everyone reads (a channel, triage) knows no Risk at all.
    expect([...scopeFields(s, null).fields.values()].map((f) => f.name)).not.toContain('Risk');
  });

  it("moves an issue without telling or showing the mover what they can't see", async () => {
    const moving = await createIssue(chloe, { project: 'BACK', summary: 'Moves to WEB', fields: { Risk: 'High', Customer: 'Umbrella' } });
    const plan = await moveIssue(anna, moving.id, { project: 'WEB', dryRun: true });
    expect(JSON.stringify(plan)).not.toMatch(/Umbrella|Risk|High/);
    const done = await moveIssue(anna, moving.id, { project: 'WEB' });
    // Customer is public in WEB: carried there, it would show anna what BACK kept from her. It stays behind.
    const moved = await getIssue(chloe, done.to);
    expect(moved.fields.find((f) => f.name === 'Customer')?.value).toBeNull();
    expect(JSON.stringify(await getIssue(anna, done.to))).not.toContain('Umbrella');
    expect(JSON.stringify(await issueActivity(anna, done.to))).not.toMatch(/Umbrella|Risk/);
    const clone = await cloneIssue(anna, id, {});
    expect((await getIssue(chloe, clone.id)).fields.find((f) => f.name === 'Customer')?.value).toBeNull();
  });

  it("doesn't stream its changes to someone it's kept from", async () => {
    await w.app.live.start();
    const app = createHttpApp(w.app);
    const token = (await issueTokenFor(w.app.db, w.anna.id, { name: 'anna-live', scopes: ['read'] })).token;
    const stream = await openStream((path, init) => app.request(path, init), token, { query: '?project=BACK' });
    try {
      await stream.waitFor((f) => f.event === 'ready');
      await updateIssue(chloe, id, { fields: { Risk: 'Low' } });
      await updateIssue(chloe, id, { fields: { Customer: 'Hooli', Priority: 'Major' } });
      const [only] = await stream.waitForEvents(1);
      await new Promise((r) => setTimeout(r, 300));
      expect(stream.events()).toHaveLength(1);
      expect(only!.changes.map((c) => c.field)).toEqual(['Priority']);
      expect(JSON.stringify(stream.events())).not.toMatch(/Hooli|Risk/);
    } finally {
      await stream.close();
      w.app.live.stop();
    }
  });
});
