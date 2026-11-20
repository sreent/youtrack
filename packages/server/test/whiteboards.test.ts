/**
 * Whiteboards (D58): a whiteboard someone can't see answers as missing, and a card holding what they
 * can't see shows nothing of it, for every reason; edits to one element and to different ones, at
 * once; converting notes and arrows, with failures among them and nothing made twice; the caps; the
 * live stream between two people; the events an outside system hears; and the MCP tools.
 */
import { WHITEBOARD_LIMITS, type WhiteboardBatchResult, type WhiteboardChangeFrame, type WhiteboardConvertResult, type WhiteboardDetail } from '@a4a/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../src/context';
import { issues } from '../src/db/schema';
import { createHttpApp } from '../src/http/app';
import { eventFeed, issueActivity } from '../src/services/activity';
import { createArticle } from '../src/services/articles';
import { issueTokenFor } from '../src/services/auth';
import { createIssue, deleteIssue, getIssue } from '../src/services/issues';
import { addMember, removeMember } from '../src/services/members';
import { createProject, updateProject } from '../src/services/projects';
import {
  applyWhiteboardBatch,
  convertWhiteboard,
  createWhiteboard,
  deleteWhiteboard,
  getWhiteboard,
  getWhiteboardCards,
  listWhiteboards,
  renameWhiteboard,
} from '../src/services/whiteboards';
import { toolByName } from '../src/tools/registry';
import { createWorld, type TestWorld } from './helpers';
import { openStream } from './sse-client';

let w: TestWorld;
let http: ReturnType<typeof createHttpApp>;
const tokens = { anna: '', ben: '', vera: '', admin: '' };
let anna: Ctx;
let ben: Ctx;
let serial = 0;
const eid = (prefix = 'el') => `${prefix}-${Date.now().toString(36)}-${++serial}`;

async function call(method: string, path: string, token: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await http.request(`/api/v1${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, text, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

/** A note, added through the service as anna. */
async function note(board: string, text: string, at = { x: 0, y: 0 }): Promise<string> {
  const id = eid('note');
  await applyWhiteboardBatch(anna, board, { ops: [{ op: 'add', id, kind: 'note', x: at.x, y: at.y, text }] });
  return id;
}

beforeAll(async () => {
  w = await createWorld();
  http = createHttpApp(w.app);
  anna = w.as(w.anna);
  ben = w.as(w.ben);
  await createProject(w.adminCtx, { key: 'SECRET', name: 'Merger', template: 'software', visibility: 'members' });
  await addMember(w.adminCtx, 'SECRET', { user: 'anna', role: 'member' });
  await addMember(w.adminCtx, 'BACK', { user: 'vera', role: 'viewer' });
  tokens.anna = (await issueTokenFor(w.app.db, w.anna.id, { name: 'anna', scopes: ['read', 'write'] })).token;
  tokens.ben = (await issueTokenFor(w.app.db, w.ben.id, { name: 'ben', scopes: ['read', 'write'] })).token;
  tokens.vera = (await issueTokenFor(w.app.db, w.viewer.id, { name: 'vera', scopes: ['read', 'write'] })).token;
  tokens.admin = (await issueTokenFor(w.app.db, w.admin.id, { name: 'admin', scopes: ['read', 'write', 'admin'] })).token;
});

afterAll(async () => {
  await w?.close();
});

describe('who sees a whiteboard', () => {
  it('answers a whiteboard in a project someone can’t read exactly as one that doesn’t exist, on every route', async () => {
    const hidden = await createWhiteboard(anna, { project: 'SECRET', name: 'Merger plan' });
    const paths: [string, string, unknown?][] = [
      ['GET', ''],
      ['PATCH', '', { name: 'x' }],
      ['DELETE', ''],
      ['POST', '/elements', { ops: [{ op: 'add', id: 'abcdef1', kind: 'note', x: 0, y: 0 }] }],
      ['GET', '/cards'],
      ['POST', '/convert', { project: 'BACK', notes: ['abcdef1'] }],
      ['GET', '/presence'],
      ['PUT', '/presence'],
      ['GET', '/stream'],
    ];
    for (const [method, tail, body] of paths) {
      const seen = await call(method, `/whiteboards/${hidden.id}${tail}`, tokens.ben, body);
      const none = await call(method, `/whiteboards/nosuchwhiteboard${tail}`, tokens.ben, body);
      expect(seen.status, `${method} ${tail}`).toBe(404);
      expect(seen.text.replaceAll(hidden.id, '?')).toBe(none.text.replaceAll('nosuchwhiteboard', '?'));
      expect(seen.text).not.toContain('Merger');
    }
    expect((await listWhiteboards(ben)).map((b) => b.id)).not.toContain(hidden.id);
    expect((await listWhiteboards(anna)).map((b) => b.id)).toContain(hidden.id);
  });

  it('lets a viewer read a whiteboard and refuses their changes, saying which permission it takes', async () => {
    await createProject(w.adminCtx, { key: 'VIEW', name: 'Viewed', template: 'software' });
    await addMember(w.adminCtx, 'VIEW', { user: 'ben', role: 'viewer' });
    const board = await createWhiteboard(anna, { project: 'VIEW', name: 'Viewer can read' });
    expect((await call('GET', `/whiteboards/${board.id}`, tokens.ben)).status).toBe(200);
    const refused = await call('POST', `/whiteboards/${board.id}/elements`, tokens.ben, { ops: [{ op: 'add', id: eid(), kind: 'note', x: 0, y: 0, text: 'hi' }] });
    expect(refused.status).toBe(403);
    expect(refused.text).toContain('change its issues');
    expect((await call('POST', '/whiteboards', tokens.ben, { project: 'VIEW', name: 'Mine' })).status).toBe(403);
    // A read-only account reads, and its every change is refused by its scope.
    expect((await call('GET', `/whiteboards/${board.id}`, tokens.vera)).status).toBe(200);
    expect((await call('POST', `/whiteboards/${board.id}/convert`, tokens.vera, { links: [{ arrow: 'abcdefg', relation: 'relates to' }] })).status).toBe(403);
    // Guests and the signed-out read nothing of whiteboards.
    expect((await http.request(`/api/v1/whiteboards/${board.id}`)).status).toBe(401);
  });

  it('lets only whoever made it, or a manager, delete it; the issues on its cards stay', async () => {
    const board = await createWhiteboard(anna, { project: 'BACK', name: 'To delete' });
    const issue = await createIssue(anna, { project: 'BACK', summary: 'Stays when its card goes' });
    await applyWhiteboardBatch(anna, board.id, { ops: [{ op: 'add', id: 'card-stays', kind: 'issue', x: 0, y: 0, issue: issue.id }] });
    await expect(deleteWhiteboard(ben, board.id)).rejects.toMatchObject({ status: 403, words: { key: 'whiteboards.onlyMakerOrManagers' } });
    await applyWhiteboardBatch(anna, board.id, { ops: [{ op: 'remove', id: 'card-stays' }] });
    expect((await getIssue(anna, issue.id)).summary).toBe('Stays when its card goes');
    await deleteWhiteboard(anna, board.id);
    await expect(getWhiteboard(anna, board.id)).rejects.toMatchObject({ status: 404 });
    expect((await getIssue(anna, issue.id)).id).toBe(issue.id);
  });
});

describe('cards show nothing of what their reader can’t see', () => {
  it('hides an issue in a project they don’t read, a limited one, a deleted one, and a limited article, all alike', async () => {
    const board = await createWhiteboard(anna, { project: 'BACK', name: 'Cards' });
    const open = await createIssue(anna, { project: 'BACK', summary: 'Open to all of BACK' });
    const secret = await createIssue(anna, { project: 'SECRET', summary: 'Acquire Initech' });
    const limited = await createIssue(anna, { project: 'BACK', summary: 'Salary review', visibleTo: { users: ['anna'] } });
    const doomed = await createIssue(anna, { project: 'BACK', summary: 'Soon deleted' });
    const article = await createArticle(anna, { project: 'BACK', title: 'Severance terms', body: 'Kept close.', visibleTo: { users: ['anna'] } });
    const ops = [
      { op: 'add' as const, id: 'card-open', kind: 'issue' as const, x: 0, y: 0, issue: open.id },
      { op: 'add' as const, id: 'card-secret', kind: 'issue' as const, x: 300, y: 0, issue: secret.id },
      { op: 'add' as const, id: 'card-limited', kind: 'issue' as const, x: 600, y: 0, issue: limited.id },
      { op: 'add' as const, id: 'card-doomed', kind: 'issue' as const, x: 900, y: 0, issue: doomed.id },
      { op: 'add' as const, id: 'card-article', kind: 'article' as const, x: 0, y: 300, article: article.id },
    ];
    await applyWhiteboardBatch(anna, board.id, { ops });
    await deleteIssue(w.adminCtx, doomed.id);
    const mine = new Map((await getWhiteboardCards(anna, board.id)).map((c) => [c.element, c]));
    expect(mine.get('card-secret')).toMatchObject({ shown: true, id: secret.id });
    expect(mine.get('card-limited')).toMatchObject({ shown: true, id: limited.id });
    expect(mine.get('card-article')).toMatchObject({ shown: true, id: article.id, summary: 'Severance terms' });
    const res = await call('GET', `/whiteboards/${board.id}`, tokens.ben);
    expect(res.status).toBe(200);
    const theirs = new Map((res.json as unknown as WhiteboardDetail).cards.map((c) => [c.element, c]));
    expect(theirs.get('card-open')).toMatchObject({ shown: true, id: open.id, summary: 'Open to all of BACK' });
    // Every reason reads the same: nothing but that it's hidden.
    for (const hidden of ['card-secret', 'card-limited', 'card-doomed', 'card-article']) expect(theirs.get(hidden)).toEqual({ element: hidden, shown: false });
    expect(mine.get('card-doomed')).toEqual({ element: 'card-doomed', shown: false });
    for (const word of [secret.id, 'Initech', limited.id, 'Salary', doomed.id, article.id, 'Severance']) expect(res.text).not.toContain(word);
    // The same on its own route, and to an agent reading it.
    expect(JSON.stringify(await getWhiteboardCards(ben, board.id))).not.toContain('Initech');
    const read = await toolByName('get_whiteboard')!.run(ben, { whiteboard: board.id });
    expect(JSON.stringify(read.data)).not.toMatch(/Initech|Salary|Severance|SECRET-/);
    expect((read.data as { outline: string }).outline).toContain('hidden');
  });

  it('shows a card’s state and assignee, and none of a private field', async () => {
    const board = await createWhiteboard(anna, { project: 'BACK', name: 'Live cards' });
    const issue = await createIssue(anna, { project: 'BACK', summary: 'Card with fields', fields: { Assignee: 'ben', State: 'In Progress' } });
    await applyWhiteboardBatch(anna, board.id, { ops: [{ op: 'add', id: 'card-fields', kind: 'issue', x: 0, y: 0, issue: issue.id }] });
    const [card] = await getWhiteboardCards(ben, board.id);
    expect(card).toMatchObject({ shown: true, summary: 'Card with fields', state: { name: 'In Progress' }, assignee: { login: 'ben' } });
    expect(Object.keys(card!).sort()).toEqual(['assignee', 'element', 'id', 'resolved', 'shown', 'state', 'summary']);
  });
});

describe('two people at once', () => {
  it('keeps every edit to different elements, made at the same moment', async () => {
    const board = await createWhiteboard(anna, { project: 'BACK', name: 'Many hands' });
    const ids = Array.from({ length: 12 }, (_, i) => `many-${i}`);
    await applyWhiteboardBatch(anna, board.id, { ops: ids.map((id, i) => ({ op: 'add' as const, id, kind: 'note' as const, x: i * 10, y: 0, text: `n${i}` })) });
    await Promise.all(ids.map((id, i) => applyWhiteboardBatch(i % 2 ? anna : ben, board.id, { ops: [{ op: 'update', id, set: { x: 1000 + i, y: 500 + i } }] })));
    const d = await getWhiteboard(anna, board.id);
    for (const [i, id] of ids.entries()) expect(d.elements.find((e) => e.id === id)).toMatchObject({ x: 1000 + i, y: 500 + i, text: `n${i}` });
    // Each batch took its own place in the whiteboard's order.
    expect(d.whiteboard.seq).toBe(13);
  });

  it('keeps a move and a rewrite of one note, made at once: different properties both land', async () => {
    const board = await createWhiteboard(anna, { project: 'BACK', name: 'One note' });
    const id = await note(board.id, 'Before');
    await Promise.all([
      applyWhiteboardBatch(anna, board.id, { ops: [{ op: 'update', id, set: { x: 320, y: 40 } }] }),
      applyWhiteboardBatch(ben, board.id, { ops: [{ op: 'update', id, set: { text: 'After' }, expect: { text: 'Before' } }] }),
    ]);
    expect((await getWhiteboard(anna, board.id)).elements[0]).toMatchObject({ x: 320, y: 40, text: 'After', version: 3 });
  });

  it('merges two rewrites of the same words rather than refusing one (D58’s revisit)', async () => {
    const board = await createWhiteboard(anna, { project: 'BACK', name: 'Same words' });
    const id = await note(board.id, 'Draft');
    const results = await Promise.all([
      applyWhiteboardBatch(anna, board.id, { ops: [{ op: 'update', id, set: { text: 'Anna’s' }, expect: { text: 'Draft' } }] }),
      applyWhiteboardBatch(ben, board.id, { ops: [{ op: 'update', id, set: { text: 'Ben’s' }, expect: { text: 'Draft' } }] }),
    ]);
    expect(results.every((r) => r.applied.includes(id) && !r.refused.length)).toBe(true);
    // Both people's lines stay: a line both changed keeps both, in order.
    const now = (await getWhiteboard(anna, board.id)).elements[0]!.text;
    expect(now?.split('\n').sort()).toEqual(['Anna’s', 'Ben’s']);
    // Each side's own lines land when they change different lines of one note.
    const two = await note(board.id, 'First line\nSecond line');
    const edits = await Promise.all([
      applyWhiteboardBatch(anna, board.id, { ops: [{ op: 'update', id: two, set: { text: 'Anna’s line\nSecond line' }, expect: { text: 'First line\nSecond line' } }] }),
      applyWhiteboardBatch(ben, board.id, { ops: [{ op: 'update', id: two, set: { text: 'First line\nBen’s line' }, expect: { text: 'First line\nSecond line' } }] }),
    ]);
    expect(edits.every((r) => !r.refused.length)).toBe(true);
    const merged = (await getWhiteboard(anna, board.id)).elements.find((e) => e.id === two)?.text;
    // Each person's typed line stays; the line mine rewrote away is gone, theirs kept it or not.
    expect(merged).toBe('Anna’s line\nBen’s line');
  });

  it('puts two moves of one note where the later put it, and refuses an undo of a move someone made since', async () => {
    const board = await createWhiteboard(anna, { project: 'BACK', name: 'Last writer' });
    const id = await note(board.id, 'Moving');
    await applyWhiteboardBatch(anna, board.id, { ops: [{ op: 'update', id, set: { x: 100 } }] });
    await applyWhiteboardBatch(ben, board.id, { ops: [{ op: 'update', id, set: { x: 200 } }] });
    expect((await getWhiteboard(anna, board.id)).elements[0]!.x).toBe(200);
    // Anna's undo puts back what she moved only if it's still where she left it.
    const undo = await applyWhiteboardBatch(anna, board.id, { ops: [{ op: 'update', id, set: { x: 0 }, expect: { x: 100 } }] });
    expect(undo.refused).toMatchObject([{ id, reason: 'changed', element: { x: 200 } }]);
    expect((await getWhiteboard(anna, board.id)).elements[0]!.x).toBe(200);
  });

  it('refuses an edit of what was removed meanwhile, alone, and takes an arrow away with what it joined', async () => {
    const board = await createWhiteboard(anna, { project: 'BACK', name: 'Removed meanwhile' });
    const a = await note(board.id, 'A');
    const b = await note(board.id, 'B', { x: 300, y: 0 });
    await applyWhiteboardBatch(anna, board.id, { ops: [{ op: 'add', id: 'arrow-ab', kind: 'arrow', x: 0, y: 0, from: a, to: b, label: 'leads to' }] });
    const removed = await applyWhiteboardBatch(ben, board.id, { ops: [{ op: 'remove', id: b }] });
    expect(removed.removed.sort()).toEqual(['arrow-ab', b].sort());
    const late = await applyWhiteboardBatch(anna, board.id, { ops: [{ op: 'update', id: b, set: { x: 5 } }, { op: 'update', id: a, set: { x: 7 } }] });
    expect(late.refused).toMatchObject([{ id: b, reason: 'gone' }]);
    expect(late.applied).toEqual([a]);
    // Undoing the removal adds it back as it was, under its own id.
    const back = await applyWhiteboardBatch(ben, board.id, { ops: [{ op: 'add', id: b, kind: 'note', x: 300, y: 0, text: 'B' }] });
    expect(back.applied).toEqual([b]);
    // An arrow with no label is undone expecting none, however the page says it.
    await applyWhiteboardBatch(anna, board.id, { ops: [{ op: 'add', id: 'arrow-bare', kind: 'arrow', x: 0, y: 0, from: a, to: b }] });
    const undone = await applyWhiteboardBatch(anna, board.id, { ops: [{ op: 'remove', id: 'arrow-bare', expect: { label: '' } }] });
    expect(undone.removed).toEqual(['arrow-bare']);
  });
});

describe('converting', () => {
  it('makes issues of two notes and a link of their arrow, each history saying where it came from, and never twice', async () => {
    const board = await createWhiteboard(anna, { project: 'BACK', name: 'Ideas to issues' });
    const login = await note(board.id, 'Login is slow\nIt takes 4 seconds on the mobile app.');
    const sso = await note(board.id, 'Add single sign-on', { x: 300, y: 0 });
    const empty = await note(board.id, '   ', { x: 600, y: 0 });
    await applyWhiteboardBatch(anna, board.id, { ops: [{ op: 'add', id: 'arrow-convert', kind: 'arrow', x: 0, y: 0, from: login, to: sso }] });
    const before = (await w.app.db.select().from(issues)).length;
    const dry = await convertWhiteboard(anna, board.id, { project: 'BACK', notes: [login, sso, empty], links: [{ arrow: 'arrow-convert', relation: 'depends on' }], dryRun: true });
    expect(dry.notes.map((n) => n.ok)).toEqual([true, true, false]);
    // Its ends are notes, so the issues it would link have no ids yet: the dry run says only how they'd relate.
    expect(dry.links[0]).toMatchObject({ ok: true, relation: 'depends on' });
    expect(dry.links[0]!.link).toBeUndefined();
    expect((await w.app.db.select().from(issues)).length).toBe(before);
    expect((await getWhiteboard(anna, board.id)).elements.find((e) => e.id === login)?.kind).toBe('note');

    const r = await convertWhiteboard(anna, board.id, { project: 'BACK', notes: [login, sso, empty], links: [{ arrow: 'arrow-convert', relation: 'depends on' }] });
    expect(r.notes[2]).toMatchObject({ ok: false, problem: { said: { key: 'whiteboards.emptyNote' } } });
    const [a, b] = [r.notes[0]!.issue!, r.notes[1]!.issue!];
    expect(r.links[0]).toMatchObject({ ok: true, made: true, link: `${a} depends on ${b}`, relation: 'depends on' });
    const first = await getIssue(anna, a);
    expect(first.summary).toBe('Login is slow');
    expect(first.description).toBe('It takes 4 seconds on the mobile app.');
    expect(first.links.some((l) => l.issue.id === b && l.phrase === 'depends on')).toBe(true);
    const history = await issueActivity(anna, a);
    expect(history.find((e) => e.type === 'issue.created')?.data).toMatchObject({ whiteboard: { id: board.id, name: 'Ideas to issues' } });
    // The card is its issue's, where the note was.
    const d = await getWhiteboard(anna, board.id);
    expect(d.elements.find((e) => e.id === login)).toMatchObject({ kind: 'issue', text: null, x: 0, y: 0 });
    expect(d.elements.find((e) => e.id === 'arrow-convert')).toMatchObject({ linked: 'depends on' });
    expect(d.cards.find((c) => c.element === login)).toMatchObject({ shown: true, id: a });

    // Again, as a retry would: nothing new is made.
    const again = await convertWhiteboard(anna, board.id, { project: 'BACK', notes: [login], links: [{ arrow: 'arrow-convert', relation: 'depends on' }] });
    expect(again.notes[0]).toMatchObject({ ok: true, already: true, issue: a });
    expect(again.links[0]).toMatchObject({ ok: true, made: false });
    expect((await getIssue(anna, a)).links.filter((l) => l.issue.id === b)).toHaveLength(1);
    expect((await w.app.db.select().from(issues)).length).toBe(before + 2);
  });

  it('refuses a project the person can’t report in, as a whole, and an arrow to a hidden issue as one to a note', async () => {
    const board = await createWhiteboard(anna, { project: 'BACK', name: 'Refusals' });
    const n = await note(board.id, 'Into a hidden project');
    await expect(convertWhiteboard(ben, board.id, { project: 'SECRET', notes: [n] })).rejects.toMatchObject({ status: 404 });
    const secret = await createIssue(anna, { project: 'SECRET', summary: 'Hidden end' });
    const mine = await createIssue(anna, { project: 'BACK', summary: 'Seen end' });
    await applyWhiteboardBatch(anna, board.id, {
      ops: [
        { op: 'add', id: 'end-hidden', kind: 'issue', x: 0, y: 300, issue: secret.id },
        { op: 'add', id: 'end-seen', kind: 'issue', x: 300, y: 300, issue: mine.id },
        { op: 'add', id: 'arrow-hidden', kind: 'arrow', x: 0, y: 0, from: 'end-seen', to: 'end-hidden' },
        { op: 'add', id: 'arrow-note', kind: 'arrow', x: 0, y: 0, from: 'end-seen', to: n },
      ],
    });
    const r = await convertWhiteboard(ben, board.id, { links: [{ arrow: 'arrow-hidden', relation: 'relates to' }, { arrow: 'arrow-note', relation: 'relates to' }] });
    expect(r.links.map((l) => l.problem?.message)).toEqual([r.links[1]!.problem?.message, r.links[1]!.problem?.message]);
    expect(JSON.stringify(r)).not.toContain(secret.id);
  });

  it('says only what a reader may know of where an issue came from', async () => {
    const board = await createWhiteboard(anna, { project: 'SECRET', name: 'Merger whiteboard' });
    const n = await note(board.id, 'Public follow-up');
    const r = await convertWhiteboard(anna, board.id, { project: 'BACK', notes: [n] });
    const id = r.notes[0]!.issue!;
    const toBen = (await issueActivity(ben, id)).find((e) => e.type === 'issue.created')!;
    expect(JSON.stringify(toBen.data)).not.toContain('Merger');
    expect((await issueActivity(anna, id)).find((e) => e.type === 'issue.created')!.data).toMatchObject({ whiteboard: { name: 'Merger whiteboard' } });
  });
});

describe('caps', () => {
  it('holds at most its number of elements, and words to the cap', async () => {
    const board = await createWhiteboard(anna, { project: 'BACK', name: 'Full' });
    const ops = Array.from({ length: WHITEBOARD_LIMITS.elements }, (_, i) => ({ op: 'add' as const, id: `full-${i}`, kind: 'text' as const, x: (i % 25) * 50, y: Math.floor(i / 25) * 50, text: '.' }));
    expect((await applyWhiteboardBatch(anna, board.id, { ops })).applied).toHaveLength(WHITEBOARD_LIMITS.elements);
    await expect(applyWhiteboardBatch(anna, board.id, { ops: [{ op: 'add', id: 'one-more', kind: 'note', x: 0, y: 0 }] })).rejects.toMatchObject({ status: 409, words: { key: 'whiteboards.full' } });
    // Swapping one for another, in one batch, fits.
    expect((await applyWhiteboardBatch(anna, board.id, { ops: [{ op: 'remove', id: 'full-0' }, { op: 'add', id: 'one-more', kind: 'note', x: 0, y: 0 }] })).applied).toHaveLength(2);
    const long = await call('POST', `/whiteboards/${board.id}/elements`, tokens.anna, { ops: [{ op: 'update', id: 'one-more', set: { text: 'x'.repeat(WHITEBOARD_LIMITS.text + 1) } }] });
    expect(long.status).toBe(400);
    const tooMany = await call('POST', `/whiteboards/${board.id}/elements`, tokens.anna, { ops: Array.from({ length: WHITEBOARD_LIMITS.ops + 1 }, () => ({ op: 'remove', id: 'one-more' })) });
    expect(tooMany.status).toBe(400);
    const far = await call('POST', `/whiteboards/${board.id}/elements`, tokens.anna, { ops: [{ op: 'update', id: 'one-more', set: { x: WHITEBOARD_LIMITS.coordinate * 2 } }] });
    expect(far.status).toBe(400);
  });
});

describe('live, and the events outside systems hear', () => {
  it('shows each person the other’s changes and who is looking, and tells a stream it can no longer see', async () => {
    await createProject(w.adminCtx, { key: 'LIVE', name: 'Live', template: 'software', visibility: 'members' });
    await addMember(w.adminCtx, 'LIVE', { user: 'anna', role: 'member' });
    await addMember(w.adminCtx, 'LIVE', { user: 'ben', role: 'member' });
    const board = await createWhiteboard(anna, { project: 'LIVE', name: 'Together' });
    const path = `/api/v1/whiteboards/${board.id}/stream`;
    const bens = await openStream(http.request, tokens.ben, { path });
    const annas = await openStream(http.request, tokens.anna, { path });
    await bens.waitFor((f) => f.event === 'viewers' && (JSON.parse(f.data) as unknown[]).length === 2);
    const added = await call('POST', `/whiteboards/${board.id}/elements`, tokens.anna, { ops: [{ op: 'add', id: 'live-note', kind: 'note', x: 10, y: 20, text: 'Hello Ben' }], client: 'tab-1' });
    expect(added.status).toBe(200);
    const frame = await bens.waitFor((f) => f.event === 'change', 2_000);
    const change = JSON.parse(frame.data) as WhiteboardChangeFrame;
    expect(change).toMatchObject({ seq: 1, client: 'tab-1', by: { login: 'anna' }, elements: [{ id: 'live-note', text: 'Hello Ben' }] });
    expect(frame.id).toBe('1');
    await annas.close();
    await bens.waitFor((f) => f.event === 'viewers' && (JSON.parse(f.data) as unknown[]).length === 1);
    // Resuming after the last change seen replays what came since.
    await applyWhiteboardBatch(anna, board.id, { ops: [{ op: 'update', id: 'live-note', set: { x: 99 } }] });
    const resumed = await openStream(http.request, tokens.anna, { path, lastEventId: '1' });
    expect(JSON.parse((await resumed.waitFor((f) => f.event === 'change')).data)).toMatchObject({ seq: 2, elements: [{ x: 99 }] });
    await resumed.close();
    // Taken off the project, Ben's open stream says the whiteboard is gone to him.
    await removeMember(w.adminCtx, 'LIVE', 'ben');
    await applyWhiteboardBatch(anna, board.id, { ops: [{ op: 'update', id: 'live-note', set: { x: 5 } }] });
    await bens.waitFor((f) => f.event === 'gone', 5_000);
    expect(bens.frames.filter((f) => f.event === 'change')).toHaveLength(2);
    await bens.close();
  });

  it('records the whiteboard’s life as events, and not its elements’ edits', async () => {
    const board = await createWhiteboard(anna, { project: 'BACK', name: 'Evented' });
    const n = await note(board.id, 'An event-worthy idea');
    await applyWhiteboardBatch(anna, board.id, { ops: [{ op: 'update', id: n, set: { x: 50 } }] });
    await renameWhiteboard(anna, board.id, { name: 'Evented, renamed' });
    const r = await convertWhiteboard(anna, board.id, { project: 'BACK', notes: [n] });
    await deleteWhiteboard(anna, board.id);
    const feed = (await eventFeed(anna, { project: 'BACK', limit: 50, order: 'desc' })).filter((e) => (e.data as { whiteboard?: { id?: string } }).whiteboard?.id === board.id);
    expect(feed.map((e) => e.type).reverse()).toEqual(['whiteboard.created', 'whiteboard.renamed', 'issue.created', 'whiteboard.converted', 'whiteboard.deleted']);
    expect(feed.find((e) => e.type === 'whiteboard.converted')!.data).toMatchObject({ issues: [r.notes[0]!.issue] });
    // Whoever can't read the project hears none of it.
    expect((await eventFeed(w.as(w.ben), { project: 'BACK', limit: 50, order: 'desc' })).length).toBeGreaterThan(0);
    const secretBoard = await createWhiteboard(anna, { project: 'SECRET', name: 'Quiet' });
    const benSees = await eventFeed(ben, { limit: 100, order: 'desc' });
    expect(benSees.some((e) => (e.data as { whiteboard?: { id?: string } }).whiteboard?.id === secretBoard.id)).toBe(false);
  });

  it('closes a project to someone, and their whiteboards with it', async () => {
    const board = await createWhiteboard(anna, { project: 'BACK', name: 'Closing' });
    expect((await call('GET', `/whiteboards/${board.id}`, tokens.ben)).status).toBe(200);
    await updateProject(w.adminCtx, 'BACK', { visibility: 'members' });
    expect((await call('GET', `/whiteboards/${board.id}`, tokens.ben)).status).toBe(404);
    await updateProject(w.adminCtx, 'BACK', { visibility: 'open' });
  });
});

describe('over MCP', () => {
  it('lists, reads, adds to and converts a whiteboard, previewing the changes, and deletes none', async () => {
    const board = await createWhiteboard(anna, { project: 'BACK', name: 'Agent board' });
    const issue = await createIssue(anna, { project: 'BACK', summary: 'Existing work' });
    const list = await toolByName('list_whiteboards')!.run(anna, { project: 'BACK' });
    expect(JSON.stringify(list.data)).toContain(board.id);
    const add = toolByName('add_to_whiteboard')!;
    const input = { whiteboard: 'Agent board', notes: [{ text: 'Cache the session', tone: 'idea', ref: 'n' }], issues: [{ issue: issue.id, ref: 'i' }], articles: [], arrows: [{ from: 'n', to: 'i', label: 'speeds up' }] };
    expect(await add.preview!(anna, input as never)).toContain('Add 1 note');
    expect((await getWhiteboard(anna, board.id)).elements).toHaveLength(0);
    await add.run(anna, input as never);
    const read = await toolByName('get_whiteboard')!.run(anna, { whiteboard: board.id });
    const outline = (read.data as { outline: string }).outline;
    expect(outline).toContain('Cache the session');
    expect(outline).toContain(issue.id);
    expect(outline).toMatch(/→ .*"speeds up"/);
    const noteId = (await getWhiteboard(anna, board.id)).elements.find((e) => e.kind === 'note')!.id;
    const arrowId = (await getWhiteboard(anna, board.id)).elements.find((e) => e.kind === 'arrow')!.id;
    const convert = toolByName('convert_whiteboard_notes')!;
    const ask = { whiteboard: board.id, project: 'BACK', notes: [noteId], links: [{ arrow: arrowId, relation: 'relates to' }] };
    expect(await convert.preview!(anna, ask as never)).toContain('Make 1 issue in BACK: “Cache the session”');
    expect((await getWhiteboard(anna, board.id)).elements.find((e) => e.id === noteId)!.kind).toBe('note');
    const done = await convert.run(anna, ask as never);
    expect(done.summary).toMatch(/^Made BACK-\d+, and 1 link$/);
    expect(convert.kind).toBe('changes');
    expect(toolByName('delete_whiteboard')).toBeUndefined();
    const res = (await convertWhiteboard(anna, board.id, { links: [{ arrow: arrowId, relation: 'relates to' }] })) as WhiteboardConvertResult;
    expect(res.links[0]!.made).toBe(false);
  });
});

describe('the batch answer', () => {
  it('says the seq, what changed and what it left, and changes nothing for a batch that changes nothing', async () => {
    const board = await createWhiteboard(anna, { project: 'BACK', name: 'Answers' });
    const id = await note(board.id, 'Same');
    const same: WhiteboardBatchResult = await applyWhiteboardBatch(anna, board.id, { ops: [{ op: 'update', id, set: { text: 'Same' } }] });
    expect(same).toMatchObject({ seq: 1, applied: [], elements: [] });
    const [row] = await w.app.db.select().from(issues).where(eq(issues.summary, '__none__'));
    expect(row).toBeUndefined();
  });
});
