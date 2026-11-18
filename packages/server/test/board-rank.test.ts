/**
 * Ranking cards on the board itself (D53): within a column and into another at a place, one change
 * to the issue's state and its place; a move a state machine refuses, refused whole; keys written
 * afresh before one would pass its limit (D65); the backlog's permission; two people
 * ranking one column at once; lanes; the event others see it by; and REST and MCP.
 */
import type { Board } from '@a4a/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boardRanks, issues as issuesTable } from '../src/db/schema';
import { createHttpApp } from '../src/http/app';
import { rankIssue } from '../src/services/agile';
import { eventFeed, issueActivity } from '../src/services/activity';
import { issueTokenFor } from '../src/services/auth';
import { boardView, createBoard } from '../src/services/boards';
import { createIssue, findVisibleIssue, getIssue, updateIssue } from '../src/services/issues';
import { addMember } from '../src/services/members';
import { createProject } from '../src/services/projects';
import { insertUser } from '../src/services/users';
import { toolByName } from '../src/tools/registry';
import { createMachine } from '../src/workflow/machines';
import { RANK_KEY_LIMIT, keyAt } from '@a4a/shared/ranks';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let board: Board;

async function refused(call: () => Promise<unknown>): Promise<{ status: number; code: string; message: string; words?: { key: string } }> {
  try {
    await call();
  } catch (e) {
    return e as { status: number; code: string; message: string; words?: { key: string } };
  }
  throw new Error('expected a refusal');
}

/** A column's cards, by summary, as the board shows them. */
async function column(name: string, b = board, ctx = w.as(w.anna)): Promise<string[]> {
  const view = await boardView(ctx, b.id);
  return view.columns.find((c) => c.name === name)!.issues.map((i) => i.summary);
}

const stateOf = async (id: string) => (await getIssue(w.adminCtx, id)).fields.find((f) => f.name === 'State')?.value as { name: string } | null;

/** Every key on a board, by summary (D65). */
async function ranks(b = board): Promise<Map<string, string>> {
  const rows = await w.app.db.select({ summary: issuesTable.summary, key: boardRanks.key }).from(boardRanks).innerJoin(issuesTable, eq(issuesTable.id, boardRanks.issueId)).where(eq(boardRanks.boardId, b.id));
  return new Map(rows.map((r) => [r.summary, r.key]));
}

async function setRank(b: Board, issue: string, key: string) {
  const row = await findVisibleIssue(w.adminCtx, issue);
  await w.app.db
    .insert(boardRanks)
    .values({ boardId: b.id, issueId: row!.id, key })
    .onConflictDoUpdate({ target: [boardRanks.boardId, boardRanks.issueId], set: { key } });
}

/** Issues made one after another, so their numbers (and the query's order) are theirs. */
async function issues(project: string, summaries: string[], fields: Record<string, string> = {}) {
  const made = [];
  for (const summary of summaries) made.push(await createIssue(w.as(w.anna), { project, summary, fields }));
  return made;
}

beforeAll(async () => {
  w = await createWorld();
  await createProject(w.adminCtx, { key: 'RNK', name: 'Ranked', template: 'software', lead: 'ben' });
  await addMember(w.adminCtx, 'RNK', { user: 'anna', role: 'member' });
  board = await createBoard(w.as(w.ben), {
    name: 'Ranked board',
    projects: ['RNK'],
    columns: [
      { name: 'Open', values: ['Open'] },
      { name: 'In Progress', values: ['In Progress'] },
      { name: 'Done', values: ['Fixed', "Won't fix"] },
    ],
  });
});
afterAll(async () => w?.close());

describe('ranking on the board', () => {
  it('ranks a card within its column, in one order with the backlog, nothing jumping the first time', async () => {
    const ctx = w.as(w.anna);
    await issues('RNK', ['Alpha', 'Bravo', 'Charlie', 'Delta'], { State: 'Open' });
    // Nothing has a place yet: the board's query's order, whatever it is.
    const [s0, s1, s2, s3] = await column('Open');
    expect([s0, s1, s2, s3].sort()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
    const id = async (summary: string) => (await boardView(ctx, board.id)).columns.flatMap((c) => c.issues).find((i) => i.summary === summary)!.id;

    // The last just after the first: the first takes a place, and nothing above it moves.
    const out = await rankIssue(ctx, board.id, { issue: await id(s3!), after: await id(s0!), column: 'Open' });
    expect(out).toEqual({ changes: [], placed: true });
    expect(await column('Open')).toEqual([s0, s3, s1, s2]);
    // Up and down a place, as Alt and an arrow do.
    await rankIssue(ctx, board.id, { issue: await id(s2!), before: await id(s0!), column: 'Open' });
    expect(await column('Open')).toEqual([s2, s0, s3, s1]);
    await rankIssue(ctx, board.id, { issue: await id(s2!), after: await id(s0!), column: 'Open' });
    expect(await column('Open')).toEqual([s0, s2, s3, s1]);
    // Where it already is, nothing is written and nothing is said.
    const before = (await issueActivity(w.adminCtx, await id(s2!))).filter((e) => e.type === 'board.issue_ranked').length;
    expect(await rankIssue(ctx, board.id, { issue: await id(s2!), after: await id(s0!), column: 'Open' })).toEqual({ changes: [], placed: false });
    // In its column, with nobody to be placed against, it keeps its place.
    expect(await rankIssue(ctx, board.id, { issue: await id(s2!), column: 'Open' })).toEqual({ changes: [], placed: false });
    const events = (await issueActivity(w.adminCtx, await id(s2!))).filter((e) => e.type === 'board.issue_ranked');
    expect(events).toHaveLength(before);
    expect(events[0]).toMatchObject({ data: { boardId: board.id, board: 'Ranked board' }, actor: { login: 'anna' } });
  });

  it('moves a card into another column at a place: its state and its place in one change', async () => {
    const ctx = w.as(w.anna);
    const [echo, foxtrot, golf] = await issues('RNK', ['Echo', 'Foxtrot', 'Golf'], { State: 'In Progress' });
    await rankIssue(ctx, board.id, { issue: foxtrot!.id, after: echo!.id, column: 'In Progress' });
    await rankIssue(ctx, board.id, { issue: golf!.id, after: foxtrot!.id, column: 'In Progress' });
    const [hotel] = await issues('RNK', ['Hotel'], { State: 'Open' });
    const fresh = await getIssue(ctx, hotel!.id);

    const out = await rankIssue(ctx, board.id, { issue: hotel!.id, after: echo!.id, column: 'In Progress', expectedVersion: fresh.version });
    expect(out).toEqual({ changes: [{ field: 'State', from: 'Open', to: 'In Progress' }], placed: true });
    expect(await column('In Progress')).toEqual(['Echo', 'Hotel', 'Foxtrot', 'Golf']);
    expect(await column('Open')).not.toContain('Hotel');
    // One change of the issue's own, with its version, and its place beside it.
    const history = await issueActivity(w.adminCtx, hotel!.id);
    expect(history.filter((e) => e.type === 'issue.updated')).toHaveLength(1);
    expect((await getIssue(ctx, hotel!.id)).version).toBe(fresh.version + 1);
    expect(history.some((e) => e.type === 'board.issue_ranked')).toBe(true);

    // Into a column with nobody to place it against: the column's first value, and its place kept.
    const kept = (await ranks()).get('Golf');
    expect(await rankIssue(ctx, board.id, { issue: golf!.id, column: 'Done' })).toEqual({ changes: [{ field: 'State', from: 'In Progress', to: 'Fixed' }], placed: false });
    expect((await ranks()).get('Golf')).toBe(kept);
    // A card ranked within a column of two values keeps its own.
    const [india] = await issues('RNK', ['India'], { State: "Won't fix" });
    await rankIssue(ctx, board.id, { issue: india!.id, before: golf!.id, column: 'Done' });
    expect((await stateOf(india!.id))?.name).toBe("Won't fix");
    expect(await column('Done')).toEqual(['India', 'Golf']);

    // Someone changed it since it was read: refused (409), and its place too.
    const place = (await ranks()).get('Foxtrot');
    await updateIssue(w.as(w.ben), foxtrot!.id, { fields: { Priority: 'Critical' } });
    const stale = await refused(() => rankIssue(ctx, board.id, { issue: foxtrot!.id, before: india!.id, column: 'Done', expectedVersion: 1 }));
    expect([stale.status, stale.words?.key]).toEqual([409, 'issues.changedMeanwhile']);
    expect((await stateOf(foxtrot!.id))?.name).toBe('In Progress');
    expect((await ranks()).get('Foxtrot')).toBe(place);
    // Its place alone needs no version: what else changed on the issue doesn't stop a rank.
    await rankIssue(ctx, board.id, { issue: foxtrot!.id, before: echo!.id, column: 'In Progress', expectedVersion: 1 });
    expect((await column('In Progress'))[0]).toBe('Foxtrot');
  });

  it('refuses whole a move its state machine refuses, and still ranks the card within its column', async () => {
    await createProject(w.adminCtx, { key: 'RNM', name: 'Machined', template: 'software', lead: 'ben' });
    await addMember(w.adminCtx, 'RNM', { user: 'anna', role: 'member' });
    const machined = await createBoard(w.as(w.ben), { name: 'Machined board', projects: ['RNM'], columns: [{ name: 'Open', values: ['Open'] }, { name: 'In Progress', values: ['In Progress'] }, { name: 'In Review', values: ['In Review'] }] });
    const [juliet, kilo, lima] = await issues('RNM', ['Juliet', 'Kilo', 'Lima'], { State: 'Open' });
    await updateIssue(w.adminCtx, lima!.id, { fields: { State: 'In Progress' } });
    await rankIssue(w.as(w.anna), machined.id, { issue: kilo!.id, before: juliet!.id, column: 'Open' });
    // From Open, only to In Review.
    await createMachine(w.as(w.ben), { project: 'RNM', field: 'State', transitions: [{ name: 'Review', from: ['Open'], to: 'In Review' }, { name: 'Reopen', from: ['*'], to: 'Open' }] });
    const place = (await ranks(machined)).get('Juliet');

    const no = await refused(() => rankIssue(w.as(w.anna), machined.id, { issue: juliet!.id, before: lima!.id, column: 'In Progress' }));
    expect([no.status, no.code, no.message]).toEqual([422, 'refused_by_state_machine', "State can't go from Open to In Progress"]);
    expect((await stateOf(juliet!.id))?.name).toBe('Open');
    expect((await ranks(machined)).get('Juliet')).toBe(place);
    expect((await issueActivity(w.adminCtx, juliet!.id)).filter((e) => e.type === 'board.issue_ranked')).toHaveLength(0);

    // Anna can't take it to In Progress, but she may still rank it among the Open ones.
    await rankIssue(w.as(w.anna), machined.id, { issue: juliet!.id, before: kilo!.id, column: 'Open' });
    expect(await column('Open', machined)).toEqual(['Juliet', 'Kilo']);
    // And where the machine allows, the move goes through, place and all.
    await rankIssue(w.as(w.anna), machined.id, { issue: kilo!.id, column: 'In Review' });
    expect(await column('In Review', machined)).toEqual(['Kilo']);
  });

  it("takes the backlog's permission, and answers what the caller can't see as missing", async () => {
    const [mike, november] = await issues('RNK', ['Mike', 'November'], { State: 'Open' });
    // Carl is a viewer of the project: he reads the board, and may not change its issues.
    const carl = await insertUser(w.app.db, { login: 'carl', name: 'Carl Viewer', role: 'member' });
    w.app.schema.invalidate();
    await addMember(w.adminCtx, 'RNK', { user: 'carl', role: 'viewer' });
    const viewer = await refused(() => rankIssue(w.as(carl), board.id, { issue: mike!.id, after: november!.id, column: 'Open' }));
    expect([viewer.status, viewer.words?.key, viewer.message]).toEqual([403, 'access.roleDoesNotAllow', "Your role in RNK doesn't let you change its issues"]);
    // Vera's account only reads.
    expect((await refused(() => rankIssue(w.as(w.viewer), board.id, { issue: mike!.id, column: 'Open' }))).words?.key).toBe('access.readOnly');
    // A read-only token never ranks.
    const readOnly = { ...w.as(w.anna), actor: { ...w.as(w.anna).actor, scopes: ['read' as const] } };
    expect((await refused(() => rankIssue(readOnly, board.id, { issue: mike!.id, column: 'Open' }))).status).toBe(403);
    // An issue of a project Anna can't see is missing, in the words of one that doesn't exist.
    await createProject(w.adminCtx, { key: 'RNS', name: 'Secret', template: 'software', visibility: 'members', lead: 'ben' });
    const secret = await createIssue(w.as(w.ben), { project: 'RNS', summary: 'Secret' });
    const hidden = await refused(() => rankIssue(w.as(w.anna), board.id, { issue: secret.id, after: mike!.id, column: 'Open' }));
    const missing = await refused(() => rankIssue(w.as(w.anna), board.id, { issue: 'RNS-999', after: mike!.id, column: 'Open' }));
    expect([hidden.status, hidden.message.replace(secret.id, 'X')]).toEqual([404, missing.message.replace('RNS-999', 'X')]);
    const hiddenAnchor = await refused(() => rankIssue(w.as(w.anna), board.id, { issue: mike!.id, after: secret.id, column: 'Open' }));
    expect(hiddenAnchor.status).toBe(404);
    // Bad input says what to do.
    const column = await refused(() => rankIssue(w.as(w.anna), board.id, { issue: mike!.id, column: 'Doing' }));
    expect([column.status, column.message, column.words?.key]).toEqual([400, 'This board has no column "Doing"', 'agile.noSuchColumn']);
    expect((await refused(() => rankIssue(w.as(w.anna), board.id, { issue: mike!.id, column: 'Open', lane: 'anna' }))).words?.key).toBe('agile.noLanes');
    expect((await refused(() => rankIssue(w.as(w.anna), board.id, { issue: mike!.id, after: mike!.id, column: 'Open' }))).words?.key).toBe('agile.nextToItself');
    expect((await refused(() => rankIssue(w.as(w.anna), board.id, { issue: mike!.id, after: november!.id, before: november!.id }))).words?.key).toBe('agile.afterOrBefore');
    // A sprint that isn't the board's is missing.
    const sprinted = await createBoard(w.as(w.ben), { name: 'Sprinted board', projects: ['RNK'], sprintsEnabled: true });
    expect((await refused(() => rankIssue(w.as(w.anna), sprinted.id, { issue: mike!.id, after: november!.id, column: 'Open', sprint: 'nope' }))).words?.key).toBe('notFound.sprintUnnamed');
  });

  it('writes the board’s keys afresh, in one transaction, before a key would pass its limit', async () => {
    const [oscar, papa, quebec] = await issues('RNK', ['Oscar', 'Papa', 'Quebec'], { State: 'Blocked' });
    const tight = await createBoard(w.as(w.ben), { name: 'Tight board', projects: ['RNK'], columns: [{ name: 'Blocked', values: ['Blocked'] }] });
    // Two neighbours whose keys leave room only for one longer than the limit (D65).
    const long = 'a0' + '1'.repeat(RANK_KEY_LIMIT - 2);
    await setRank(tight, oscar!.id, long);
    await setRank(tight, papa!.id, long + '1');
    expect(await column('Blocked', tight)).toEqual(['Oscar', 'Papa', 'Quebec']);
    await rankIssue(w.as(w.anna), tight.id, { issue: quebec!.id, after: oscar!.id, column: 'Blocked' });
    expect(await column('Blocked', tight)).toEqual(['Oscar', 'Quebec', 'Papa']);
    const after = await ranks(tight);
    expect([...after.values()].every((k) => k.length <= 4)).toBe(true);
    expect(new Set(after.values()).size).toBe(after.size);
  });

  it('lands both of two moves made at once in one column, each where it was put', async () => {
    const ctx = w.as(w.anna);
    const [romeo, sierra, tango, uniform] = await issues('RNK', ['Romeo', 'Sierra', 'Tango', 'Uniform'], { State: 'In Review' });
    const busy = await createBoard(w.as(w.ben), { name: 'Busy board', projects: ['RNK'], columns: [{ name: 'In Review', values: ['In Review'] }, { name: 'Done', values: ['Fixed'] }] });
    for (const [i, x] of [romeo, sierra, tango, uniform].entries()) await setRank(busy, x!.id, keyAt(i));
    // Both just after Romeo: each lands right after it, the later of the two first.
    await Promise.all([
      rankIssue(ctx, busy.id, { issue: tango!.id, after: romeo!.id, column: 'In Review' }),
      rankIssue(w.as(w.ben), busy.id, { issue: uniform!.id, after: romeo!.id, column: 'In Review' }),
    ]);
    const shown = await column('In Review', busy);
    expect(shown[0]).toBe('Romeo');
    expect(shown.slice(1, 3).sort()).toEqual(['Tango', 'Uniform']);
    expect(shown[3]).toBe('Sierra');
    // Into a gap that takes a key past its limit, at once: one writes the board's keys afresh, the other places itself among what that left.
    const romeoKey = (await ranks(busy)).get('Romeo')!;
    await setRank(busy, romeo!.id, romeoKey + '1'.repeat(RANK_KEY_LIMIT));
    await setRank(busy, sierra!.id, romeoKey + '1'.repeat(RANK_KEY_LIMIT) + '1');
    await Promise.all([
      rankIssue(ctx, busy.id, { issue: tango!.id, after: romeo!.id, column: 'In Review' }),
      rankIssue(w.as(w.ben), busy.id, { issue: uniform!.id, before: sierra!.id, column: 'In Review' }),
    ]);
    const now = await column('In Review', busy);
    expect(now[0]).toBe('Romeo');
    expect(now.slice(1, 3).sort()).toEqual(['Tango', 'Uniform']);
    expect(now[3]).toBe('Sierra');
    const all = await ranks(busy);
    expect(new Set(all.values()).size).toBe(all.size);
    // One moves a card out of the column while the other ranks within it: both hold.
    await Promise.all([
      rankIssue(ctx, busy.id, { issue: romeo!.id, column: 'Done' }),
      rankIssue(w.as(w.ben), busy.id, { issue: sierra!.id, before: tango!.id, column: 'In Review' }),
    ]);
    expect(await column('Done', busy)).toContain('Romeo');
    expect((await column('In Review', busy))[0]).toBe('Sierra');
  });

  it("keeps one order across lanes, and moves a card into another lane at a place in the same change", async () => {
    const ctx = w.as(w.anna);
    const laned = await createBoard(w.as(w.ben), { name: 'Laned board', projects: ['RNK'], swimlaneField: 'Assignee', columns: [{ name: 'Verified', values: ['Verified'] }] });
    await issues('RNK', ['Victor', 'Whiskey'], { State: 'Verified', Assignee: 'anna' });
    await issues('RNK', ['Xray', 'Yankee'], { State: 'Verified', Assignee: 'ben' });
    const byName = new Map((await boardView(ctx, laned.id)).columns[0]!.issues.map((i) => [i.summary, i.id]));
    // Each lane shows its cards in the board's one order: the column's, filtered.
    const lane = (all: string[], of: string[]) => all.filter((x) => of.includes(x));
    const [a0, a1] = lane(await column('Verified', laned), ['Victor', 'Whiskey']);
    const [b0, b1] = lane(await column('Verified', laned), ['Xray', 'Yankee']);
    await rankIssue(ctx, laned.id, { issue: byName.get(a1!)!, before: byName.get(a0!)!, column: 'Verified' });
    expect(lane(await column('Verified', laned), ['Victor', 'Whiskey'])).toEqual([a1, a0]);
    expect(lane(await column('Verified', laned), ['Xray', 'Yankee'])).toEqual([b0, b1]);
    // Into Ben's lane, between his two: the assignee and the place, at once.
    const out = await rankIssue(ctx, laned.id, { issue: byName.get(a0!)!, after: byName.get(b0!)!, column: 'Verified', lane: 'ben' });
    expect(out).toEqual({ changes: [{ field: 'Assignee', from: 'anna', to: 'ben' }], placed: true });
    expect(lane(await column('Verified', laned), [a0!, b0!, b1!])).toEqual([b0, a0, b1]);
    // The lane of nobody, keeping its place.
    expect(await rankIssue(ctx, laned.id, { issue: byName.get(b1!)!, column: 'Verified', lane: null })).toMatchObject({ placed: false });
    expect((await getIssue(ctx, byName.get(b1!)!)).fields.find((f) => f.name === 'Assignee')?.value).toBeNull();
  });

  it("is an event that whoever sees the issue hears, and nobody else", async () => {
    await createProject(w.adminCtx, { key: 'RNP', name: 'Private', template: 'software', visibility: 'members', lead: 'ben' });
    const priv = await createBoard(w.as(w.ben), { name: 'Private board', projects: ['RNP'] });
    // Anna isn't one of its people: Ben makes its issues.
    const zulu = await createIssue(w.as(w.ben), { project: 'RNP', summary: 'Zulu', fields: { State: 'Open' } });
    const alef = await createIssue(w.as(w.ben), { project: 'RNP', summary: 'Alef', fields: { State: 'Open' } });
    await rankIssue(w.as(w.ben), priv.id, { issue: alef.id, before: zulu.id, column: 'Open' });
    const heard = (await eventFeed(w.as(w.ben), { types: ['board.issue_ranked'], project: 'RNP' })).map((e) => e.issue?.id);
    expect(heard).toContain(alef.id);
    expect((await eventFeed(w.as(w.anna), { types: ['board.issue_ranked'] })).map((e) => e.issue?.id)).not.toContain(alef.id);
  });
});

describe('over REST and MCP', () => {
  it('ranks through the board’s rank endpoint and the rank_issue tool', async () => {
    const app = createHttpApp(w.app);
    const token = (await issueTokenFor(w.app.db, w.anna.id, { name: 'anna', scopes: ['read', 'write'] })).token;
    const call = async (method: string, path: string, body?: unknown) => {
      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await app.request(`/api/v1${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const [one, two] = await issues('RNK', ['Rest one', 'Rest two'], { State: 'Submitted' });
    const fresh = await getIssue(w.as(w.anna), two!.id);
    const moved = await call('POST', `/boards/${board.id}/rank`, { issue: two!.id, column: 'Open', expectedVersion: fresh.version });
    expect(moved.status).toBe(204);
    expect((await stateOf(two!.id))?.name).toBe('Open');
    const bad = await call('POST', `/boards/${board.id}/rank`, { issue: one!.id, column: 'Doing' });
    expect([bad.status, bad.body.error.key]).toEqual([400, 'agile.noSuchColumn']);
    const stale = await call('POST', `/boards/${board.id}/rank`, { issue: two!.id, column: 'In Progress', expectedVersion: fresh.version });
    expect(stale.status).toBe(409);
    expect((await call('GET', `/boards/${board.id}/view`)).body.order).toContain(two!.id);

    const tool = toolByName('rank_issue')!;
    expect([tool.kind, tool.destructive]).toEqual(['changes', true]);
    const input = { board: 'Ranked board', issue: one!.id, column: 'In Progress', after: two!.id };
    // The preview is a dry run: it says the change and makes none.
    expect(await tool.preview!(w.as(w.anna), input)).toBe(`Rank ${one!.id} on Ranked board: State Submitted → In Progress, placed just after ${two!.id}`);
    expect((await stateOf(one!.id))?.name).toBe('Submitted');
    const ran = await tool.run(w.as(w.anna), input);
    expect(ran.summary).toBe(`Ranked ${one!.id} on Ranked board: State Submitted → In Progress, placed just after ${two!.id}`);
    expect((await stateOf(one!.id))?.name).toBe('In Progress');
    await expect(tool.run(w.as(w.anna), { ...input, board: 'No such board' })).rejects.toMatchObject({ status: 404 });
  });
});

