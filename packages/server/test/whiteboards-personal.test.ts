/**
 * A person's own whiteboard (docs/architecture.md, D58's revisit): made without a project, its owner's,
 * shared with everyone signed in or limited to the people and groups named; its readers change it, its
 * events reach them and nobody else, a guest never sees it, and its owner alone deletes it and says who
 * else reads it. A project's whiteboards stay as D58 has them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../src/context';
import { createHttpApp } from '../src/http/app';
import { eventFeed } from '../src/services/activity';
import { issueTokenFor } from '../src/services/auth';
import { addGroupMember, createGroup } from '../src/services/groups';
import { createProject, updateProject } from '../src/services/projects';
import {
  applyWhiteboardBatch,
  createWhiteboard,
  deleteWhiteboard,
  getWhiteboard,
  listWhiteboards,
  setWhiteboardSharing,
} from '../src/services/whiteboards';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let http: ReturnType<typeof createHttpApp>;
let anna: Ctx;
let ben: Ctx;
let guest: Ctx;
let tokens: { anna: string; ben: string; vera: string; admin: string } = { anna: '', ben: '', vera: '', admin: '' };

beforeAll(async () => {
  w = await createWorld();
  http = createHttpApp(w.app);
  anna = w.as(w.anna);
  ben = w.as(w.ben);
  guest = w.as({ ...w.anna, guest: true } as never);
  tokens.anna = (await issueTokenFor(w.app.db, w.anna.id, { name: 'anna', scopes: ['read', 'write'] })).token;
  tokens.ben = (await issueTokenFor(w.app.db, w.ben.id, { name: 'ben', scopes: ['read', 'write'] })).token;
  tokens.vera = (await issueTokenFor(w.app.db, w.viewer.id, { name: 'vera', scopes: ['read', 'write'] })).token;
  tokens.admin = (await issueTokenFor(w.app.db, w.admin.id, { name: 'admin', scopes: ['read', 'write', 'admin'] })).token;
  await updateProject(w.adminCtx, 'BACK', { guestAccess: true });
});

afterAll(async () => {
  await w?.close();
});

async function call(method: string, path: string, token: string, body?: unknown) {
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await http.request(`/api/v1${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, text, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

describe("a person's own whiteboard", () => {
  it("is its owner's, shared with everyone signed in, in nobody's project list, and never a guest's", async () => {
    const own = await createWhiteboard(anna, { name: 'My scratch board' });
    expect(own.project).toBeNull();
    expect(own.owner).toMatchObject({ login: 'anna' });
    expect(own.share).toBe('everyone');
    expect(own.access).toEqual({ edit: true, delete: true, share: true });

    // The owner and everyone signed in see it; a project's list doesn't include it, and a guest never does.
    const all = await listWhiteboards(anna);
    expect(all.map((b) => b.id)).toContain(own.id);
    const benSees = await getWhiteboard(ben, own.id);
    expect(benSees.whiteboard.access).toMatchObject({ edit: true, share: false });
    const projects = await listWhiteboards(anna, { project: 'BACK' });
    expect(projects.map((b) => b.id)).not.toContain(own.id);
    // A guest, not signed in: the personal board answers as one that doesn't exist.
    const guestRead = await call('GET', `/whiteboards/${own.id}`, '');
    expect(guestRead.status).toBe(404);
    const guestList = await call('GET', '/whiteboards', '');
    expect((guestList.json as unknown as { id: string }[]).map((b) => b.id)).not.toContain(own.id);
  });

  it("limited to the people and groups named: they change it, everyone else hears nothing", async () => {
    const team = await createGroup(w.adminCtx, { name: 'Board gang' });
    await addGroupMember(w.adminCtx, team.id, 'vera');
    const own = await createWhiteboard(anna, { name: 'Just us', share: 'limited', sharedWith: { users: ['ben'], groups: ['Board gang'] } });
    expect(own.share).toBe('limited');
    expect(own.sharedWith.users.map((u) => u.login)).toEqual(['ben']);
    expect(own.sharedWith.groups.map((g) => g.name)).toEqual(['Board gang']);

    // Ben, named, changes it; Vera, in the named group, reads it; a stranger hears of none of it.
    await applyWhiteboardBatch(ben, own.id, { ops: [{ op: 'add', id: 'n-personal-1', kind: 'note', x: 0, y: 0, text: 'Ours' }] });
    const vera = w.as(w.viewer);
    const seen = await getWhiteboard(vera, own.id);
    expect(seen.elements.map((e) => e.text)).toContain('Ours');
    const outside = await call('GET', `/whiteboards/${own.id}`, tokens.admin, undefined);
    // An administrator: a manager of every project, but named by no personal whiteboard's sharing.
    expect(outside.status).toBe(404);
    const outsider = w.as(w.admin);
    await expect(getWhiteboard(outsider, own.id)).rejects.toThrow();

    // Its events: Ben's feed has the making; a stranger's has no event naming it.
    const mine = (feed: { type: string; data?: { whiteboard?: { id?: string } } }[]) => feed.some((e) => e.type === 'whiteboard.created' && e.data?.whiteboard?.id === own.id);
    const benFeed = (await eventFeed(w.as(w.ben), {})) as { type: string; data?: { whiteboard?: { id?: string } } }[];
    expect(mine(benFeed)).toBe(true);
    const outsiderFeed = (await eventFeed(outsider, {})) as { type: string; data?: { whiteboard?: { id?: string } } }[];
    expect(mine(outsiderFeed)).toBe(false);
  });

  it("its owner says who else reads it, and only its owner deletes it", async () => {
    const own = await createWhiteboard(anna, { name: 'Then shared', share: 'everyone' });
    const byBen = await getWhiteboard(ben, own.id);
    expect(byBen.whiteboard.access.edit).toBe(true);
    // Limited away: Ben, not named, loses it entirely.
    const limited = await setWhiteboardSharing(anna, own.id, { share: 'limited', sharedWith: { users: ['vera'], groups: [] } });
    expect(limited.share).toBe('limited');
    expect(limited.sharedWith.users.map((u) => u.login)).toEqual(['vera']);
    await expect(getWhiteboard(ben, own.id)).rejects.toThrow();
    // Ben can't delete it; the owner can, and Vera still reads of its going.
    await expect(deleteWhiteboard(ben, own.id)).rejects.toThrow();
    await deleteWhiteboard(anna, own.id);
    const veraFeed = (await eventFeed(w.as(w.viewer), {})).map((e) => e.type);
    expect(veraFeed).toContain('whiteboard.deleted');
  });

  it("says so when a limited whiteboard names nobody", async () => {
    await expect(createWhiteboard(anna, { name: 'Nobody reads it', share: 'limited', sharedWith: { users: [], groups: [] } })).rejects.toThrow();
  });
});
