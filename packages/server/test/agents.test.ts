import type { IssueDetail, TrackerEvent } from '@a4a/shared';
import { sayProblem, type ProblemSaid } from '@a4a/shared/i18n';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminCtx, systemCtx } from '../src/app-services';
import type { Ctx, UserRow } from '../src/context';
import { WORKFLOW_BOT } from '../src/db/defaults';
import { OutboxWorker } from '../src/events/worker';
import { createHttpApp } from '../src/http/app';
import { AppError } from '../src/lib/errors';
import { issueActivity } from '../src/services/activity';
import { issueAgentToken, listAgents, revokeAgentToken, undoAgentChange } from '../src/services/agents';
import { actorFromToken, createToken, issueTokenFor } from '../src/services/auth';
import { addComment } from '../src/services/comments';
import { createIssue, getIssue, updateIssue } from '../src/services/issues';
import { addMember } from '../src/services/members';
import { createProject } from '../src/services/projects';
import { createUser } from '../src/services/users';
import { searchIssues } from '../src/search/service';
import { suggestCommand } from '../src/commands/parser';
import { toolByName } from '../src/tools/registry';
import { linkIssues } from '../src/services/links';
import { RuleEngine } from '../src/workflow/engine';
import { createRule } from '../src/workflow/rules';
import { presentField } from '../src/tools/registry';
import { translatorFor } from '../src/i18n';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let claude: UserRow;
let claudeToken: string;

const value = (i: IssueDetail, name: string) => presentField(i.fields.find((f) => f.name === name)!);
const tagsOf = (i: IssueDetail) => i.tags.map((t) => t.name).sort();

/** The context a request with this token gets, as the server builds it. */
async function viaToken(token: string, channel: 'api' | 'mcp' = 'mcp'): Promise<Ctx> {
  const actor = await actorFromToken(w.app.db, token, channel);
  if (!actor) throw new Error('the token was refused');
  return { app: w.app, db: w.app.db, actor };
}

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

const history = (issue: string) => issueActivity(w.adminCtx, issue);
const updatesOf = async (issue: string): Promise<TrackerEvent[]> => (await history(issue)).filter((e) => e.type === 'issue.updated');

beforeAll(async () => {
  w = await createWorld();
  const made = await createUser(w.adminCtx, { login: 'claude', name: 'Claude', role: 'member', isBot: true });
  claude = (await w.app.schema.get()).users.get(made.id)!;
  claudeToken = (await issueAgentToken(w.adminCtx, 'claude', { name: 'laptop', scopes: ['read', 'write'] })).token;
});

afterAll(async () => {
  await w?.close();
});

describe('tokens issued to an agent', () => {
  it('lets a tool act as the agent itself: its changes are its own, under its name', async () => {
    const ctx = await viaToken(claudeToken);
    expect(ctx.actor.user.login).toBe('claude');
    expect(ctx.actor.tokenName).toBe('laptop');
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Flaky login test' });
    await updateIssue(ctx, issue.id, { fields: { Priority: 'Major' } });
    const [change] = await updatesOf(issue.id);
    expect(change!.actor).toMatchObject({ login: 'claude', isBot: true, channel: 'mcp', token: 'laptop' });
    // A person's own change says it's a person's.
    await updateIssue(w.as(w.anna), issue.id, { fields: { Priority: 'Minor' } });
    expect((await updatesOf(issue.id))[1]!.actor).toMatchObject({ login: 'anna', isBot: false });
  });

  it('says so over MCP, where "me" is the agent', async () => {
    const ctx = await viaToken(claudeToken);
    const me = await toolByName('get_current_user')!.run(ctx, {});
    expect(me.data).toMatchObject({ login: 'claude', agent: true, token: 'laptop' });
    expect(me.summary).toBe('Acting as claude, an agent, as itself');
    const person = await toolByName('get_current_user')!.run(w.as(w.anna), {});
    expect((person.data as { agent?: boolean }).agent).toBeUndefined();
  });

  it('are listed for administrators, without a4a’s own agents', async () => {
    const agents = await listAgents(w.adminCtx);
    expect(agents.map((a) => a.agent.login)).toEqual(['claude']);
    expect(agents[0]!.tokens.map((t) => t.name)).toEqual(['laptop']);
    expect((await failure(listAgents(w.as(w.anna)))).status).toBe(403);
  });

  it('are refused for a person, for a4a’s own agents, beyond the agent’s role, and to anyone but an administrator', async () => {
    const asks: [() => Promise<unknown>, number, RegExp][] = [
      [() => issueAgentToken(w.adminCtx, 'anna', { name: 'x', scopes: ['read'] }), 400, /Anna Schmidt is a person, not an agent/],
      [() => issueAgentToken(w.adminCtx, 'triage', { name: 'x', scopes: ['read'] }), 400, /triage is a4a's own agent/],
      [() => issueAgentToken(w.adminCtx, 'nobody', { name: 'x', scopes: ['read'] }), 404, /User nobody not found/],
      [() => issueAgentToken(w.adminCtx, 'claude', { name: 'x', scopes: ['read', 'admin'] }), 400, /claude is a member, so a token for it can't have the admin scope/],
      [() => issueAgentToken(w.as(w.anna), 'claude', { name: 'x', scopes: ['read'] }), 403, /administrator/],
    ];
    for (const [attempt, status, words] of asks) {
      const e = await failure(attempt());
      expect(e.status).toBe(status);
      expect(e.message).toMatch(words);
    }
  });

  it('reach only projects the agent can see, when limited to some', async () => {
    await createProject(w.adminCtx, { key: 'SEC', name: 'Secret', template: 'software', visibility: 'members' });
    const refused = await failure(issueAgentToken(w.adminCtx, 'claude', { name: 'sec', scopes: ['read'], projects: ['SEC'] }));
    expect(refused.message).toBe("claude can't see SEC");
    expect(refused.hint).toBe("Add claude to SEC's people first, or leave SEC out.");
    const back = await issueAgentToken(w.adminCtx, 'claude', { name: 'back only', scopes: ['read'], projects: ['BACK'] });
    expect(back.projects).toEqual(['BACK']);
    const ctx = await viaToken(back.token, 'api');
    const found = await searchIssues(ctx, 'project: WEB').catch((e: unknown) => e);
    expect(found).toBeInstanceOf(AppError);
  });

  it('are never made by the agent itself, and stop when revoked', async () => {
    const ctx = await viaToken(claudeToken);
    const e = await failure(createToken(ctx, { name: 'mine', scopes: ['read'] }));
    expect([e.status, e.message]).toEqual([403, 'An agent can’t make its own tokens']);
    const spare = await issueAgentToken(w.adminCtx, 'claude', { name: 'spare', scopes: ['read'] });
    expect(await actorFromToken(w.app.db, spare.token, 'api')).not.toBeNull();
    await revokeAgentToken(w.adminCtx, 'claude', spare.id);
    expect(await actorFromToken(w.app.db, spare.token, 'api')).toBeNull();
    expect((await failure(revokeAgentToken(w.adminCtx, 'claude', spare.id))).status).toBe(404);
  });
});

describe('agents as assignees', () => {
  it('takes an agent, and its token finds its work with "for: me"', async () => {
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Write the migration guide', fields: { Assignee: 'claude' } });
    expect(value(issue, 'Assignee')).toBe('claude');
    const mine = await searchIssues(await viaToken(claudeToken), 'for: me #Unresolved');
    expect(mine.items.map((i) => i.id)).toContain(issue.id);
    const theirs = await searchIssues(w.as(w.anna), 'for: me');
    expect(theirs.items.map((i) => i.id)).not.toContain(issue.id);
  });

  it('never takes a4a’s own agents, and offers only people and added agents', async () => {
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Rotate the keys' });
    const e = await failure(updateIssue(w.as(w.anna), issue.id, { fields: { Assignee: 'triage' } }));
    expect([e.status, e.message, e.hint]).toEqual([400, "triage is a4a's own agent, and takes no work", 'Give Assignee a person, or an agent an administrator added.']);
    const s = await w.app.schema.get();
    const offered = suggestCommand('Assignee ', 'Assignee '.length, s, [s.projectsByKey.get('BACK')!.id], 100).map((i) => i.insert.trim());
    expect(offered).toContain('claude');
    expect(offered).not.toContain('triage');
    expect(offered).not.toContain(WORKFLOW_BOT);
    const people = await toolByName('list_users')!.run(w.as(w.anna), {});
    const logins = (people.data as { login: string; bot?: boolean }[]).map((p) => p.login);
    expect(logins).toContain('claude');
    expect(logins).not.toContain('triage');
  });

  it('takes an agent in a members-only project only once it is one of its people', async () => {
    const issue = await createIssue(w.adminCtx, { project: 'SEC', summary: 'Audit the vault' });
    const e = await failure(updateIssue(w.adminCtx, issue.id, { fields: { Assignee: 'claude' } }));
    expect(e.message).toBe("Claude can't see SEC, so can't be the value of Assignee");
    await addMember(w.adminCtx, 'SEC', { user: 'claude', role: 'member' });
    expect(value(await updateIssue(w.adminCtx, issue.id, { fields: { Assignee: 'claude' } }), 'Assignee')).toBe('claude');
  });
});

describe('undoing what an agent did on its own', () => {
  let agent: Ctx;
  beforeAll(async () => {
    agent = await viaToken(claudeToken);
  });

  it('puts fields, tags and the summary back, as the person asking, once', async () => {
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Exports time out', fields: { Priority: 'Normal', Type: 'Bug' }, tags: ['perf'] });
    await updateIssue(agent, issue.id, { summary: 'Exports time out on big projects', fields: { Priority: 'Critical', State: 'In Progress' }, addTags: ['urgent'], removeTags: ['perf'] });
    const [change] = await updatesOf(issue.id);
    expect(change!.undo).toEqual({ state: 'possible', note: '', noteWords: [], by: 'anyone' });

    const done = await undoAgentChange(w.as(w.anna), change!.id);
    expect(done.undoes).toBe(change!.id);
    const after = await getIssue(w.adminCtx, issue.id);
    expect([after.summary, value(after, 'Priority'), value(after, 'State'), tagsOf(after)]).toEqual(['Exports time out', 'Normal', 'Open', ['perf']]);
    const [, undo] = await updatesOf(issue.id);
    expect(undo!.actor).toMatchObject({ login: 'anna', isBot: false });
    expect(undo!.data.undoes).toBe(change!.id);
    expect(undo!.undo).toBeUndefined();
    const undone = (await updatesOf(issue.id))[0]!.undo;
    expect(undone).toEqual({ state: 'undone', note: 'Anna Schmidt undid it', noteWords: [{ key: 'agents.undoneBy', values: { who: 'named', name: 'Anna Schmidt' } }], by: 'anyone' });
    // A page says the note in its person's language, from its words (D49).
    expect(sayProblem(translatorFor('de'), undone!.noteWords![0] as ProblemSaid)).toBe('Anna Schmidt hat die Änderung rückgängig gemacht.');

    const again = await failure(undoAgentChange(w.as(w.ben), change!.id));
    expect([again.status, again.code, again.message]).toEqual([409, 'already_undone', 'Anna Schmidt undid it already']);
  });

  it('undoes nothing when what it changed has changed since, and says what', async () => {
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Search is slow' });
    await updateIssue(agent, issue.id, { fields: { State: 'Fixed', Priority: 'Major' } });
    await updateIssue(w.as(w.ben), issue.id, { fields: { State: 'In Progress' } });
    const [change] = await updatesOf(issue.id);
    expect(change!.undo).toEqual({
      state: 'changed_since',
      note: 'State is In Progress now: Ben Okafor changed it since',
      noteWords: [{ key: 'agents.stop.fieldChanged', values: { field: 'State', hasValue: 'yes', value: 'In Progress', hasBy: 'yes', by: 'Ben Okafor' } }],
      by: 'anyone',
    });
    expect(sayProblem(translatorFor('de'), change!.undo!.noteWords![0] as ProblemSaid)).toBe('State ist jetzt In Progress: Ben Okafor hat es inzwischen geändert.');
    const e = await failure(undoAgentChange(w.as(w.anna), change!.id));
    expect([e.status, e.code, e.message]).toEqual([409, 'changed_since', 'Nothing was undone: State is In Progress now: Ben Okafor changed it since']);
    const now = await getIssue(w.adminCtx, issue.id);
    expect([value(now, 'State'), value(now, 'Priority')]).toEqual(['In Progress', 'Major']);
  });

  it('minds only what the agent changed', async () => {
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Cache headers' });
    await updateIssue(agent, issue.id, { fields: { Priority: 'Critical' } });
    await updateIssue(w.as(w.ben), issue.id, { fields: { State: 'In Progress' }, addTags: ['web'] });
    const [change] = await updatesOf(issue.id);
    await undoAgentChange(w.as(w.anna), change!.id);
    const now = await getIssue(w.adminCtx, issue.id);
    expect([value(now, 'Priority'), value(now, 'State'), tagsOf(now)]).toEqual(['Normal', 'In Progress', ['web']]);
  });

  it('puts a description back whole, however long', async () => {
    const long = `${'The importer reads every row twice. '.repeat(120)}End.`;
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Importer reads twice', description: long });
    await updateIssue(agent, issue.id, { description: 'Short.' });
    const [change] = await updatesOf(issue.id);
    await undoAgentChange(w.as(w.anna), change!.id);
    expect((await getIssue(w.adminCtx, issue.id)).description).toBe(long);
  });

  it('takes away a link it made, from either issue, once', async () => {
    const a = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Upgrade the driver' });
    const b = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Pool exhaustion' });
    await linkIssues(agent, a.id, 'depends on', b.id);
    const there = (await history(b.id)).find((e) => e.type === 'link.created')!;
    expect(there.undo?.state).toBe('possible');
    await undoAgentChange(w.as(w.anna), there.id);
    expect((await getIssue(w.adminCtx, a.id)).links).toEqual([]);
    const here = (await history(a.id)).find((e) => e.type === 'link.created')!;
    expect(here.undo?.state).toBe('undone');
    expect((await history(a.id)).find((e) => e.type === 'link.deleted')!.data.undoes).toBe(here.id);
  });

  it('is for a person who may change the issue, never an agent; and hides what the caller can’t see', async () => {
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Retry storms' });
    await updateIssue(agent, issue.id, { fields: { Priority: 'Critical' } });
    const [change] = await updatesOf(issue.id);
    const secret = await createIssue(w.adminCtx, { project: 'SEC', summary: 'Vault keys' });
    await updateIssue(agent, secret.id, { fields: { Priority: 'Critical' } });
    const [hidden] = await updatesOf(secret.id);
    const attempts: [() => Promise<unknown>, number, string][] = [
      [() => undoAgentChange(w.as(w.viewer), change!.id), 403, 'Your role is read-only'],
      [() => undoAgentChange(agent, change!.id), 403, 'An agent can’t undo a change'],
      [() => undoAgentChange(systemCtx(w.app, w.anna, 'mcp'), change!.id), 403, 'An agent can’t undo a change'],
      [() => undoAgentChange(w.as(w.anna), hidden!.id), 404, `Event ${hidden!.id} not found`],
      [() => undoAgentChange(w.as(w.anna), 9_999_999), 404, 'Event 9999999 not found'],
    ];
    for (const [attempt, status, message] of attempts) {
      const e = await failure(attempt());
      expect([e.status, e.message]).toEqual([status, message]);
    }
    expect(value(await getIssue(w.adminCtx, issue.id), 'Priority')).toBe('Critical');
  });

  it('leaves a person’s own change and an agent’s comment to be changed as any', async () => {
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Disk fills up' });
    await updateIssue(w.as(w.ben), issue.id, { fields: { Priority: 'Major' } });
    await addComment(agent, issue.id, 'The logs rotate weekly; daily would do.');
    const events = await history(issue.id);
    const own = events.find((e) => e.type === 'issue.updated')!;
    const said = events.find((e) => e.type === 'comment.created')!;
    expect([own.undo, said.undo]).toEqual([undefined, undefined]);
    for (const id of [own.id, said.id]) {
      const e = await failure(undoAgentChange(w.as(w.anna), id));
      expect([e.status, e.code]).toEqual([400, 'not_undoable']);
    }
  });

  it('undoes the assistant’s change and a rule’s, and the rule doesn’t redo it', async () => {
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Mobile layout breaks' });
    await updateIssue(systemCtx(w.app, w.anna, 'assistant'), issue.id, { fields: { Priority: 'Major' } });
    const [byAssistant] = await updatesOf(issue.id);
    expect(byAssistant!.undo?.state).toBe('possible');
    await undoAgentChange(w.as(w.anna), byAssistant!.id);

    const engine = new RuleEngine(w.app, () => {});
    const worker = new OutboxWorker(w.app, [engine.consumer()], {}, [], () => {});
    await worker.drain();
    await createRule(w.adminCtx, { project: 'BACK', name: 'Critical work is urgent', kind: 'change', trigger: 'updated', query: 'Priority: Critical', command: 'tag urgent' });
    const hot = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Payments fail' });
    await updateIssue(w.as(w.anna), hot.id, { fields: { Priority: 'Critical' } });
    for (let i = 0; i < 4; i++) await worker.drain();
    expect(tagsOf(await getIssue(w.adminCtx, hot.id))).toEqual(['urgent']);
    const byRule = (await updatesOf(hot.id)).find((e) => e.actor.login === WORKFLOW_BOT)!;
    expect(byRule.undo?.state).toBe('possible');
    await undoAgentChange(w.as(w.anna), byRule.id);
    for (let i = 0; i < 4; i++) await worker.drain();
    expect(tagsOf(await getIssue(w.adminCtx, hot.id))).toEqual([]);
    await worker.stop();
  });

  it('isn’t kept for an import', async () => {
    const imported = { createdAt: new Date('2025-01-01'), updatedAt: new Date('2025-01-02'), resolvedAt: null, reporterId: w.ben.id, data: { source: 'jira', key: 'OLD-1' } };
    const bot = adminCtx(w.app, claude, 'mcp');
    const issue = await createIssue(bot, { project: 'BACK', summary: 'Imported one' }, { imported });
    await updateIssue(bot, issue.id, { fields: { Priority: 'Major' } }, { data: { imported: { source: 'jira', key: 'OLD-1' } } });
    expect((await updatesOf(issue.id))[0]!.undo).toBeUndefined();
  });
});

describe('over HTTP', () => {
  it('issues an agent its token, and undoes its change', async () => {
    const app = createHttpApp(w.app);
    const admin = (await issueTokenFor(w.app.db, w.admin.id, { name: 'admin script', scopes: ['read', 'write', 'admin'] })).token;
    const anna = (await issueTokenFor(w.app.db, w.anna.id, { name: 'anna script', scopes: ['read', 'write'] })).token;
    const call = async (method: string, path: string, token: string, body?: unknown) => {
      const res = await app.request(`/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const made = await call('POST', '/users/claude/tokens', admin, { name: 'ci', scopes: ['read', 'write'] });
    expect(made.status).toBe(201);
    expect(made.body.token).toMatch(/^a4a_/);
    expect((await call('GET', '/me', made.body.token)).body).toMatchObject({ login: 'claude', isBot: true });
    expect((await call('POST', '/users/claude/tokens', anna, { name: 'x', scopes: ['read'] })).status).toBe(403);
    expect((await call('GET', '/agents', admin)).body.map((a: { agent: { login: string } }) => a.agent.login)).toEqual(['claude']);

    const issue = await call('POST', '/issues', anna, { project: 'BACK', summary: 'Broken badge' });
    await call('PATCH', `/issues/${issue.body.id}`, made.body.token, { fields: { Priority: 'Critical' } });
    const events = (await call('GET', `/issues/${issue.body.id}/activity`, anna)).body as TrackerEvent[];
    const change = events.find((e) => e.type === 'issue.updated')!;
    expect(change.undo).toEqual({ state: 'possible', note: '', noteWords: [], by: 'anyone' });
    const undone = await call('POST', `/events/${change.id}/undo`, anna);
    expect(undone.status).toBe(200);
    expect(undone.body).toMatchObject({ undoes: change.id, changes: [{ field: 'Priority', from: 'Critical', to: 'Normal' }] });
    expect((await call('POST', `/events/${change.id}/undo`, anna)).body).toMatchObject({ error: { code: 'already_undone' } });
    expect((await call('DELETE', `/users/claude/tokens/${made.body.id}`, admin)).status).toBe(204);
    expect((await call('GET', '/me', made.body.token)).status).toBe(401);
  });
});
