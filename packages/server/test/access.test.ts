/**
 * Per-project access: roles, visibility and tokens limited to projects, and, above all, that a
 * person outside a members-only project learns nothing of it through any service.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createConversation } from '../src/ai/chat/agent';
import { setClaudeClientForTests, type ClaudeClient } from '../src/ai/client';
import { judgeDuplicates, summarizeIssue, wordsToQuery } from '../src/ai/nl';
import { findSimilar } from '../src/ai/similar';
import { dismissSuggestion, listPendingSuggestions, listSuggestions, triageConsumer, triageIssue } from '../src/ai/triage';
import { adminCtx } from '../src/app-services';
import { runCommand } from '../src/commands/executor';
import type { Ctx } from '../src/context';
import { aiSuggestions, users } from '../src/db/schema';
import { AppError } from '../src/lib/errors';
import { countIssues, parseQueryForApi, searchIssues } from '../src/search/service';
import { suggest } from '../src/search/suggest';
import { eventFeed, issueActivity } from '../src/services/activity';
import { visibleSchema, projectRolesOf, canUserReadProject } from '../src/services/access';
import { boardView, createBoard, createSprint, getBoard, listBoards, setSprintIssues, updateBoard } from '../src/services/boards';
import { addComment, deleteComment, listComments, updateComment } from '../src/services/comments';
import { addFieldValue, listFields } from '../src/services/fields';
import { createIssue, deleteIssue, getIssue, updateIssue } from '../src/services/issues';
import { linkIssues, listLinks } from '../src/services/links';
import { addMember, listMembers, removeMember, updateMember } from '../src/services/members';
import { createBaseline, getBaseline, getSchedule } from '../src/services/planning';
import { createProject, getProject, listProjects, updateProject } from '../src/services/projects';
import { createSavedSearch, listSavedSearches } from '../src/services/saved-searches';
import { fieldByName } from '../src/services/schema-cache';
import { insertUser } from '../src/services/users';
import { deleteWorkItem, listWorkItems, logWork } from '../src/services/workitems';
import { toolByName } from '../src/tools/registry';
import { createWorld, type TestWorld } from './helpers';
import { eq } from 'drizzle-orm';

// A stand-in for Claude that records what it was sent and answers from a script.
const script = { parsed: [] as unknown[], requests: [] as Record<string, unknown>[] };
const fake = {
  beta: {
    messages: {
      parse: async (body: Record<string, unknown>) => {
        script.requests.push(body);
        const next = script.parsed.shift();
        if (next === undefined) throw new Error('no scripted structured output left');
        return { stop_reason: 'end_turn', stop_details: null, parsed_output: next, model: 'claude-opus-5-5', content: [] };
      },
    },
  },
} as unknown as ClaudeClient;
const sentToClaude = () => JSON.stringify(script.requests);

let w: TestWorld;
let anna: Ctx; // a member of SECRET
let ben: Ctx; // outside it
let admin: Ctx;
let secretId = '';
let secretUid = '';
let backId = '';
let commentId = '';
let workId = '';
const CODEWORD = 'zebraquokka';

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

beforeAll(async () => {
  w = await createWorld();
  setClaudeClientForTests(fake);
  admin = w.adminCtx;
  anna = w.as(w.anna);
  ben = w.as(w.ben);
  await createProject(admin, { key: 'SECRET', name: 'Merger', description: 'Only its people', template: 'software', visibility: 'members' });
  const s = await w.app.schema.get();
  await addFieldValue(admin, fieldByName(s, 'Subsystem')!.id, { name: 'Diligence', project: 'SECRET' });
  await addMember(admin, 'SECRET', { user: 'anna', role: 'member' });
  const secret = await createIssue(anna, { project: 'SECRET', summary: `Acquire Initech ${CODEWORD}`, description: `The ${CODEWORD} plan`, fields: { Subsystem: 'Diligence' } });
  secretId = secret.id;
  secretUid = secret.uid;
  const back = await createIssue(anna, { project: 'BACK', summary: 'Rate limit the public API', description: 'Per token' });
  backId = back.id;
  await linkIssues(anna, back.id, 'depends on', secret.id);
  commentId = (await addComment(anna, secret.id, `Board meets on Friday about ${CODEWORD}`)).id;
  workId = (await logWork(anna, secret.id, { duration: '2h' })).id;
});

afterEach(() => {
  script.parsed = [];
  script.requests = [];
});

afterAll(async () => {
  setClaudeClientForTests(null);
  await w?.close();
});

describe('a members-only project, from outside', () => {
  it('is not listed, and answers exactly as a project that does not exist', async () => {
    expect((await listProjects(ben)).map((p) => p.key)).toEqual(['BACK', 'WEB']);
    expect((await listProjects(anna)).map((p) => p.key)).toEqual(['BACK', 'SECRET', 'WEB']);
    expect(await failure(getProject(ben, 'SECRET'), 'SECRET')).toEqual(await failure(getProject(ben, 'NOPE'), 'NOPE'));
    expect(await failure(getSchedule(ben, 'SECRET'), 'SECRET')).toEqual(await failure(getSchedule(ben, 'NOPE'), 'NOPE'));
    expect(await failure(listMembers(ben, 'SECRET'), 'SECRET')).toEqual(await failure(listMembers(ben, 'NOPE'), 'NOPE'));
    expect((await failure(getProject(ben, 'SECRET'))).status).toBe(404);
  });

  it('hides its issues, by readable id and by internal id, as missing ones', async () => {
    const [n] = secretId.split('-').slice(1);
    expect(await failure(getIssue(ben, secretId), secretId)).toEqual(await failure(getIssue(ben, `BACK-9${n}9`), `BACK-9${n}9`));
    expect((await failure(getIssue(ben, secretUid))).status).toBe(404);
    for (const attempt of [() => listComments(ben, secretId), () => listWorkItems(ben, secretId), () => listLinks(ben, secretId), () => issueActivity(ben, secretId), () => listSuggestions(ben, secretId)]) {
      expect((await failure(attempt())).status).toBe(404);
    }
    expect(await failure(updateComment(ben, commentId, 'x'))).toEqual(await failure(updateComment(ben, 'no-such-comment', 'x')));
    expect(await failure(deleteComment(ben, commentId))).toEqual(await failure(deleteComment(ben, 'no-such-comment')));
    expect(await failure(deleteWorkItem(ben, workId))).toEqual(await failure(deleteWorkItem(ben, 'no-such-work')));
    expect(await failure(updateIssue(ben, secretId, { summary: 'x' }), secretId)).toEqual(await failure(updateIssue(ben, 'BACK-999', { summary: 'x' }), 'BACK-999'));
    expect(await failure(deleteIssue(ben, secretId), secretId)).toEqual(await failure(deleteIssue(ben, 'BACK-999'), 'BACK-999'));
    expect(await failure(addComment(ben, secretId, 'hi'), secretId)).toEqual(await failure(addComment(ben, 'BACK-999', 'hi'), 'BACK-999'));
  });

  it('finds none of it in search, counts, completion or the query language', async () => {
    expect((await searchIssues(ben, CODEWORD)).total).toBe(0);
    expect((await searchIssues(anna, CODEWORD)).total).toBe(1);
    expect((await searchIssues(ben, '')).items.map((i) => i.project.key)).not.toContain('SECRET');
    // Naming the project is the same mistake as naming one that doesn't exist, with no "did you mean".
    const hidden = await parseQueryForApi(ben, 'project: SECRET');
    const missing = await parseQueryForApi(ben, 'project: SECRAT');
    expect(hidden.ok).toBe(false);
    expect(JSON.stringify(hidden.problems).split('SECRET').join('<X>')).toEqual(JSON.stringify(missing.problems).split('SECRAT').join('<X>'));
    expect(JSON.stringify(missing.problems)).not.toContain('SECRET');
    expect((await parseQueryForApi(ben, `issue id: ${secretId}`)).ok).toBe(false);
    expect((await parseQueryForApi(ben, 'Subsystem: Diligence')).ok).toBe(false);
    expect((await parseQueryForApi(anna, 'Subsystem: Diligence')).ok).toBe(true);
    const groups = await countIssues(ben, '', 'project');
    expect(groups.groups.map((g) => g.value)).not.toContain('SECRET');
    const completions = suggest(await visibleSchema(ben), 'project: SE', 'project: SE'.length);
    expect(completions.map((c) => c.label)).not.toContain('SECRET');
    expect(suggest(await visibleSchema(anna), 'project: SE', 'project: SE'.length).map((c) => c.label)).toContain('SECRET');
  });

  it("never shows its issue at the other end of a link, in a link's summary or in history", async () => {
    const backAsBen = await getIssue(ben, backId);
    expect(backAsBen.links).toEqual([]);
    expect(JSON.stringify(backAsBen)).not.toContain(CODEWORD);
    expect(await listLinks(ben, backId)).toEqual([]);
    expect((await getIssue(anna, backId)).links.map((l) => l.issue.id)).toEqual([secretId]);
    const history = await issueActivity(ben, backId);
    expect(history.map((e) => e.type)).not.toContain('link.created');
    expect(JSON.stringify(history)).not.toContain(secretId);
    expect((await issueActivity(anna, backId)).map((e) => e.type)).toContain('link.created');
  });

  it("keeps the feed to what one can see, and the feed's pages whole", async () => {
    const feed = await eventFeed(ben, { limit: 500 });
    expect(feed.length).toBeGreaterThan(0);
    expect(JSON.stringify(feed)).not.toContain(CODEWORD);
    expect(JSON.stringify(feed)).not.toContain(secretId);
    expect(feed.every((e) => e.project !== 'SECRET')).toBe(true);
    expect(JSON.stringify(await eventFeed(anna, { limit: 500 }))).toContain(CODEWORD);
    expect(await failure(eventFeed(ben, { project: 'SECRET' }), 'SECRET')).toEqual(await failure(eventFeed(ben, { project: 'SECRAT' }), 'SECRAT'));
    // Paging after the last event Ben can see still reaches events made since.
    const last = Math.max(...feed.map((e) => e.id));
    await addComment(anna, secretId, `More on ${CODEWORD}`);
    await addComment(anna, backId, 'Visible to all');
    const next = await eventFeed(ben, { after: last, order: 'asc' });
    expect(next.map((e) => e.type)).toEqual(['comment.created']);
    expect(next[0]!.issue?.id).toBe(backId);
  });

  it("shows no project's own values to people who can't see the project", async () => {
    const subsystem = (await listFields(ben)).find((f) => f.name === 'Subsystem')!;
    expect(subsystem.values.map((v) => v.name)).not.toContain('Diligence');
    expect((await listFields(anna)).find((f) => f.name === 'Subsystem')!.values.map((v) => v.name)).toContain('Diligence');
  });

  it('keeps commands from changing it, or naming it, alike', async () => {
    expect(await failure(runCommand(ben, { issues: [secretId], command: 'State Fixed' }), secretId)).toEqual(
      await failure(runCommand(ben, { issues: ['BACK-999'], command: 'State Fixed' }), 'BACK-999'),
    );
    const res = await runCommand(ben, { issues: [backId], command: `relates to ${secretId}`, dryRun: true });
    expect(res.results[0]!.errors.join(' ').split(secretId).join('<X>')).toBe(
      (await runCommand(ben, { issues: [backId], command: 'relates to BACK-999', dryRun: true })).results[0]!.errors.join(' ').split('BACK-999').join('<X>'),
    );
  });

  it('lists only the shared searches that make sense to the viewer', async () => {
    await createSavedSearch(anna, { name: 'The merger', query: 'project: SECRET #Unresolved', shared: true });
    await createSavedSearch(anna, { name: 'Everything open', query: '#Unresolved', shared: true });
    expect((await listSavedSearches(ben)).map((s) => s.name)).toEqual(['Everything open']);
    expect((await listSavedSearches(anna)).map((s) => s.name).sort()).toEqual(['Everything open', 'The merger']);
    // A search can't even be saved naming a project its owner can't see.
    expect((await failure(createSavedSearch(ben, { name: 'x', query: 'project: SECRET', shared: false }))).status).toBe(400);
  });

  it('shows a board spanning it with its own projects only, and hides a board wholly on it', async () => {
    const both = await createBoard(admin, { name: 'Both', projects: ['BACK', 'SECRET'] });
    const only = await createBoard(admin, { name: 'Only secret', projects: ['SECRET'], sprintsEnabled: true });
    const boards = await listBoards(ben);
    expect(boards.map((b) => b.name)).toContain('Both');
    expect(boards.map((b) => b.name)).not.toContain('Only secret');
    const seen = await getBoard(ben, both.id);
    expect(seen.projects.map((p) => p.key)).toEqual(['BACK']);
    const view = await boardView(ben, both.id);
    const keys = view.columns.flatMap((c) => c.issues.map((i) => i.project.key));
    expect(keys).toContain('BACK');
    expect(keys).not.toContain('SECRET');
    expect(JSON.stringify(view)).not.toContain(CODEWORD);
    expect((await boardView(anna, both.id)).columns.flatMap((c) => c.issues.map((i) => i.id))).toContain(secretId);
    expect(await failure(getBoard(ben, only.id))).toEqual(await failure(getBoard(ben, 'no-such-board')));
    expect(await failure(createSprint(ben, only.id, { name: 'S1' }))).toEqual(await failure(createSprint(ben, 'no-such-board', { name: 'S1' })));
    // Changing a board is for managers of all its projects.
    expect((await failure(updateBoard(ben, both.id, { name: 'Mine' }))).status).toBe(403);
  });

  it("names no outside dependency in a plan's warnings, and hides its baselines", async () => {
    const schedule = await getSchedule(ben, 'BACK');
    expect(JSON.stringify(schedule)).not.toContain(secretId);
    expect(JSON.stringify(await getSchedule(anna, 'BACK'))).toContain(secretId);
    const baseline = await createBaseline(admin, 'SECRET', { name: 'Deal plan' });
    expect(await failure(getBaseline(ben, baseline.id))).toEqual(await failure(getBaseline(ben, 'no-such-baseline')));
  });

  it('shows the assistant and MCP tools nothing of it', async () => {
    const run = async (ctx: Ctx, name: string, input: Record<string, unknown>) => {
      const tool = toolByName(name)!;
      return tool.run(ctx, tool.input.parse(input) as never);
    };
    expect(JSON.stringify((await run(ben, 'list_projects', {})).data)).not.toContain('SECRET');
    expect((await failure(run(ben, 'get_issue', { issue: secretId }))).status).toBe(404);
    expect(JSON.stringify((await run(ben, 'get_issue', { issue: backId })).data)).not.toContain(secretId);
    expect(JSON.stringify((await run(ben, 'search_issues', { query: CODEWORD })).data)).not.toContain(CODEWORD);
    expect(JSON.stringify((await run(ben, 'get_activity', { limit: 200 })).data)).not.toContain(CODEWORD);
    expect(JSON.stringify((await run(ben, 'find_similar_issues', { text: `Acquire Initech ${CODEWORD}` })).data)).not.toContain(secretId);
    expect(JSON.stringify((await run(ben, 'get_board', {})).data)).not.toContain('Only secret');
    expect((await failure(run(ben, 'list_project_members', { project: 'SECRET' }))).status).toBe(404);
    const people = (await run(anna, 'list_project_members', { project: 'SECRET' })).data as { visibility: string; people: { login: string; role: string; lead?: boolean }[] };
    expect(people.visibility).toBe('members only');
    // The administrator who made it leads it, which makes them its manager.
    expect(people.people.map((p) => [p.login, p.role, Boolean(p.lead)])).toEqual([
      ['admin', 'manager', true],
      ['anna', 'member', false],
    ]);
    expect((await failure(run(ben, 'add_comment', { issue: secretId, text: 'hi' }))).status).toBe(404);
    expect((await failure(run(ben, 'link_issues', { issue: backId, relation: 'relates to', other: secretId }))).status).toBe(404);
  });

  it('sends Claude none of it: similar issues, judging duplicates, words to a query, summaries', async () => {
    expect((await findSimilar(ben, { summary: `Acquire Initech ${CODEWORD}` })).map((c) => c.issue.id)).not.toContain(secretId);
    expect((await findSimilar(anna, { summary: `Acquire Initech ${CODEWORD}` })).map((c) => c.issue.id)).toContain(secretId);
    // A candidate list handed in from outside is checked again before it goes to Claude.
    const smuggled = [{ issue: { id: secretId, summary: 'x', resolved: false, state: null }, project: 'SECRET', score: 1, verdict: null, reason: null }];
    expect(await judgeDuplicates(ben, { summary: 'Acquire Initech' }, smuggled)).toEqual([]);
    expect(script.requests).toHaveLength(0);
    script.parsed.push({ query: '#Unresolved', explanation: 'Open issues' });
    await wordsToQuery(ben, 'what is open');
    expect(sentToClaude()).not.toContain('SECRET');
    expect(sentToClaude()).not.toContain('Diligence');
    script.parsed.push({ summary: '- Waits on nothing it can see' });
    await summarizeIssue(ben, backId);
    expect(sentToClaude()).not.toContain(secretId);
    const conversation = await createConversation(ben, { project: 'SECRET' }).catch((e: AppError) => e);
    expect(conversation).toBeInstanceOf(AppError);
  });

  it("keeps triage's possible duplicates to what every reader of the issue can see", async () => {
    const twin = await createIssue(anna, { project: 'BACK', summary: `Acquire Initech ${CODEWORD} too` });
    script.parsed.push({ fields: {}, summary: 'Nothing to add.' });
    await triageIssue(anna, twin.id);
    // Anna can see SECRET, but BACK's readers can't: it isn't offered to Claude for an issue in BACK.
    expect(sentToClaude()).not.toContain(secretId);
    // Stored suggestions are filtered as they are read: one naming a hidden issue shows without it.
    const [row] = await w.app.db
      .insert(aiSuggestions)
      .values({
        id: 'sugg-hidden',
        issueId: (await getIssue(anna, backId)).uid,
        kind: 'triage',
        status: 'pending',
        model: 'claude-opus-5-5',
        payload: { fields: [], tags: [], duplicates: [{ issue: secretId, summary: `Acquire Initech ${CODEWORD}`, verdict: 'duplicate', reason: `Same as ${secretId}` }], summary: `Looks like ${secretId}.` },
      })
      .returning();
    const asBen = (await listSuggestions(ben, backId)).find((s) => s.id === row!.id)!;
    expect(asBen.payload.duplicates).toEqual([]);
    expect(JSON.stringify(asBen)).not.toContain(secretId);
    expect((await listSuggestions(anna, backId)).find((s) => s.id === row!.id)!.payload.duplicates).toHaveLength(1);
    expect(JSON.stringify(await listPendingSuggestions(ben))).not.toContain(CODEWORD);
    expect(await failure(listPendingSuggestions(ben, { project: 'SECRET' }), 'SECRET')).toEqual(await failure(listPendingSuggestions(ben, { project: 'SECRAT' }), 'SECRAT'));
  });

  it('triages a members-only issue as a bot that reaches only that project and open ones', async () => {
    await updateProject(admin, 'SECRET', { settings: { triageMode: 'suggest' } });
    const fresh = await createIssue(anna, { project: 'SECRET', summary: 'Data room access' });
    script.parsed.push({ fields: { Assignee: { value: 'anna', confidence: 'high', reason: 'Runs it' } }, summary: 'Diligence work.' });
    const consumer = triageConsumer(w.app)!;
    await consumer.handle({
      id: 1,
      type: 'issue.created',
      occurredAt: new Date().toISOString(),
      actor: { id: w.anna.id, login: 'anna', name: 'Anna', channel: 'api', token: null },
      project: 'SECRET',
      issue: { id: fresh.id, summary: fresh.summary, resolved: false, state: 'Open' },
      changes: [],
      data: {},
    });
    const suggestions = await listSuggestions(anna, fresh.id);
    expect(suggestions).toHaveLength(1);
    // Only SECRET's people are offered as its assignee.
    const schema = JSON.stringify((script.requests[0] as { output_config: unknown }).output_config);
    expect(schema).toContain('anna');
    expect(schema).not.toContain('"ben"');
  });
});

describe('roles in a project', () => {
  let vic: Ctx; // a viewer of SECRET
  let max: Ctx; // a manager of SECRET

  beforeAll(async () => {
    const vicUser = await insertUser(w.app.db, { login: 'vic', name: 'Vic Viewer', role: 'member' });
    const maxUser = await insertUser(w.app.db, { login: 'max', name: 'Max Manager', role: 'member' });
    w.app.schema.invalidate();
    await addMember(admin, 'SECRET', { user: 'vic', role: 'viewer' });
    await addMember(admin, 'SECRET', { user: 'max', role: 'manager' });
    vic = w.as(vicUser);
    max = w.as(maxUser);
  });

  it('lets a viewer read and comment, and nothing more', async () => {
    expect((await getIssue(vic, secretId)).id).toBe(secretId);
    expect((await addComment(vic, secretId, 'A question from legal')).text).toBe('A question from legal');
    // Each call starts only when it's awaited: started together, the later refusals would go
    // unhandled while the first is awaited.
    for (const attempt of [
      () => updateIssue(vic, secretId, { summary: 'Changed' }),
      () => logWork(vic, secretId, { duration: '1h' }),
      () => linkIssues(vic, secretId, 'relates to', backId),
      () => deleteIssue(vic, secretId),
      () => createIssue(vic, { project: 'SECRET', summary: 'New' }),
      () =>
        runCommand(vic, { issues: [secretId], command: 'State Fixed' }).then((r) => {
          if (r.results[0]!.errors.length) throw new AppError(403, 'forbidden', r.results[0]!.errors[0]!);
        }),
    ]) {
      const f = await failure(attempt());
      expect(f.status).toBe(403);
      expect(f.message).toMatch(/SECRET/);
    }
    expect((await getProject(vic, 'SECRET')).access).toMatchObject({ role: 'viewer', read: true, comment: true, write: false, manage: false });
    // Deciding on what triage suggests is work on the issue, so a viewer can't.
    await w.app.db.insert(aiSuggestions).values({
      id: 'sugg-viewer',
      issueId: secretUid,
      kind: 'triage',
      status: 'pending',
      model: 'claude-opus-5-5',
      payload: { fields: [], tags: [], duplicates: [], summary: 'Nothing.' },
    });
    expect((await failure(dismissSuggestion(vic, 'sugg-viewer'))).status).toBe(403);
    expect((await failure(dismissSuggestion(ben, 'sugg-viewer'))).status).toBe(404);
    expect((await dismissSuggestion(anna, 'sugg-viewer')).status).toBe('dismissed');
  });

  it('lets a member change issues but not the project', async () => {
    expect((await updateIssue(anna, secretId, { description: 'Updated' })).description).toBe('Updated');
    for (const attempt of [
      () => updateProject(anna, 'SECRET', { name: 'Renamed' }),
      () => addMember(anna, 'SECRET', { user: 'ben', role: 'viewer' }),
      () => createBaseline(anna, 'SECRET', { name: 'Mine' }),
      () => createBoard(anna, { name: 'Mine', projects: ['SECRET'] }),
    ]) {
      expect((await failure(attempt())).status).toBe(403);
    }
    expect((await getProject(anna, 'SECRET')).access).toMatchObject({ role: 'member', write: true, manage: false });
  });

  it('lets a manager change its settings, people, boards and baselines', async () => {
    expect((await updateProject(max, 'SECRET', { description: 'The deal' })).description).toBe('The deal');
    expect((await addMember(max, 'SECRET', { user: 'ben', role: 'viewer' })).role).toBe('viewer');
    expect((await updateMember(max, 'SECRET', 'ben', { role: 'member' })).role).toBe('member');
    await removeMember(max, 'SECRET', 'ben');
    expect((await createBaseline(max, 'SECRET', { name: 'Max plan' })).name).toBe('Max plan');
    const board = await createBoard(max, { name: 'Deal board', projects: ['SECRET'], sprintsEnabled: true });
    const sprint = await createSprint(max, board.id, { name: 'Week 1' });
    // Putting an issue in a sprint is work on the issue: a member may.
    expect((await setSprintIssues(anna, sprint.id, [secretId], false)).issueCount).toBe(1);
    expect((await failure(setSprintIssues(vic, sprint.id, [secretId], false))).status).toBe(403);
    // A manager of SECRET alone can't make a board reach BACK too.
    expect((await failure(updateBoard(max, board.id, { projects: ['SECRET', 'BACK'] }))).status).toBe(403);
  });

  it('makes the lead a manager, and the lead can not be taken out without a new lead', async () => {
    await updateProject(admin, 'SECRET', { lead: 'vic' });
    expect((await getProject(vic, 'SECRET')).access).toMatchObject({ role: 'manager', via: 'lead', manage: true });
    const people = await listMembers(vic, 'SECRET');
    expect(people[0]).toMatchObject({ user: { login: 'vic' }, lead: true });
    await removeMember(admin, 'SECRET', 'vic'); // their row goes; leading keeps them in
    expect((await failure(removeMember(admin, 'SECRET', 'vic'))).status).toBe(400);
    await updateProject(admin, 'SECRET', { lead: null });
    expect(await failure(getProject(vic, 'SECRET'), 'SECRET')).toEqual(await failure(getProject(vic, 'NOPE'), 'NOPE'));
    await addMember(admin, 'SECRET', { user: 'vic', role: 'viewer' });
  });

  it('keeps a read-only account to reading, whatever its role in a project', async () => {
    await addMember(admin, 'SECRET', { user: 'vera', role: 'manager' });
    const vera = w.as(w.viewer);
    expect((await getIssue(vera, secretId)).id).toBe(secretId);
    expect((await failure(addComment(vera, secretId, 'hello'))).status).toBe(403);
    expect((await failure(updateProject(vera, 'SECRET', { name: 'x' }))).status).toBe(403);
    expect((await getProject(vera, 'SECRET')).access).toMatchObject({ role: 'manager', read: true, comment: false, write: false, manage: false });
    await removeMember(admin, 'SECRET', 'vera');
  });

  it('lets an open project keep someone to reading by naming them a viewer', async () => {
    await addMember(admin, 'WEB', { user: 'ben', role: 'viewer' });
    expect((await failure(createIssue(ben, { project: 'WEB', summary: 'x' }))).status).toBe(403);
    expect((await getProject(ben, 'WEB')).access).toMatchObject({ role: 'viewer', via: 'member' });
    await removeMember(admin, 'WEB', 'ben');
    expect((await createIssue(ben, { project: 'WEB', summary: 'Now I may' })).project.key).toBe('WEB');
  });

  it('needs write access to both ends of a link', async () => {
    const web = await createIssue(anna, { project: 'WEB', summary: 'Checkout copy' });
    await addMember(admin, 'WEB', { user: 'vic', role: 'member' });
    // Vic changes WEB's issues, but only reads SECRET's.
    const f = await failure(linkIssues(vic, web.id, 'relates to', secretId));
    expect(f.status).toBe(403);
    expect(f.message).toMatch(/link changes/);
    await removeMember(admin, 'WEB', 'vic');
  });

  it("assigns a members-only project's issues only to people who can see it", async () => {
    const f = await failure(updateIssue(anna, secretId, { fields: { Assignee: 'ben' } }));
    expect(f.status).toBe(400);
    expect(f.message).toMatch(/can't see SECRET/);
    expect((await failure(createIssue(anna, { project: 'SECRET', summary: 'x', fields: { Assignee: 'ben' } }))).status).toBe(400);
    const done = await updateIssue(anna, secretId, { fields: { Assignee: 'vic' } });
    expect(done.fields.find((x) => x.name === 'Assignee')!.value).toMatchObject({ login: 'vic' });
  });

  it('answers who can see a project, for notifications and the like', async () => {
    const roles = await projectRolesOf(w.app.db, (await getProject(admin, 'SECRET')).id, [w.anna.id, w.ben.id, w.admin.id]);
    expect(Object.fromEntries([...roles].map(([id, r]) => [id === w.anna.id ? 'anna' : id === w.admin.id ? 'admin' : 'other', r]))).toEqual({ anna: 'member', admin: 'manager' });
    expect(await canUserReadProject(w.app.db, w.ben.id, (await getProject(admin, 'SECRET')).id)).toBe(false);
  });

  it('takes effect at once when someone is taken out', async () => {
    const annaNow = w.as(w.anna);
    expect((await getIssue(annaNow, secretId)).id).toBe(secretId);
    await removeMember(admin, 'SECRET', 'anna');
    // The same context: access is worked out again after the change.
    expect((await failure(getIssue(annaNow, secretId))).status).toBe(404);
    await addMember(admin, 'SECRET', { user: 'anna', role: 'member' });
    expect((await getIssue(annaNow, secretId)).id).toBe(secretId);
  });

  it('gives one person one role: adding them twice at once leaves one row', async () => {
    const results = await Promise.allSettled([addMember(admin, 'BACK', { user: 'vic', role: 'member' }), addMember(admin, 'BACK', { user: 'vic', role: 'viewer' })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as AppError).status).toBe(409);
    expect((await listMembers(admin, 'BACK')).filter((m) => m.user.login === 'vic')).toHaveLength(1);
  });

  it('records changes to people and visibility in the project’s events', async () => {
    const events = await eventFeed(admin, { project: 'SECRET', types: ['project.member.added', 'project.member.removed', 'project.visibility.changed'], limit: 100 });
    expect(events.map((e) => e.type)).toContain('project.member.added');
    await updateProject(admin, 'WEB', { visibility: 'members' });
    const changed = await eventFeed(admin, { project: 'WEB', types: ['project.visibility.changed'] });
    expect(changed[0]!.data).toEqual({ from: 'open', to: 'members' });
    // Ben was never one of WEB's people: it's gone from his sight.
    expect((await listProjects(ben)).map((p) => p.key)).not.toContain('WEB');
    await updateProject(admin, 'WEB', { visibility: 'open' });
  });

  it('refuses unknown people and roles with what to do', async () => {
    expect((await failure(addMember(admin, 'SECRET', { user: 'nobody', role: 'member' }))).message).toMatch(/User nobody not found/);
    expect((await failure(addMember(admin, 'SECRET', { user: 'ben', role: 'owner' as never }))).status).toBe(400);
    expect((await failure(updateMember(admin, 'SECRET', 'ben', { role: 'member' }))).status).toBe(404);
  });
});

describe('administrators', () => {
  it('see and manage every project', async () => {
    const everyone = await listProjects(admin);
    expect(everyone.map((p) => p.key)).toContain('SECRET');
    expect(everyone.find((p) => p.key === 'SECRET')!.access).toMatchObject({ role: 'manager', via: 'admin', manage: true });
    const [bot] = await w.app.db.select().from(users).where(eq(users.login, 'triage'));
    // The server's own elevated context (as the triage bot uses) is an administrator too.
    expect((await listProjects(adminCtx(w.app, bot!))).map((p) => p.key)).toContain('SECRET');
  });
});
