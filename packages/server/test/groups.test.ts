/**
 * Groups (D27): a project gives a group a role as it gives one to a person, and someone's role is
 * the highest of their own and their groups'. Everything that asks who may do what sees it, at
 * once; groups from the identity provider are filled at sign-in only; and a project someone can't
 * see stays one that doesn't exist.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../src/context';
import { createHttpApp } from '../src/http/app';
import { AppError } from '../src/lib/errors';
import { issueTokenFor } from '../src/services/auth';
import { canUserReadProject, projectAccess, projectRolesOf, requireProject } from '../src/services/access';
import { eventFeed } from '../src/services/activity';
import {
  addGroupMember,
  addProjectGroup,
  createGroup,
  deleteGroup,
  getGroup,
  listGroups,
  listProjectGroups,
  providerGroupNames,
  removeGroupMember,
  removeProjectGroup,
  syncProviderGroups,
  updateGroup,
  updateProjectGroup,
} from '../src/services/groups';
import { createIssue, updateIssue } from '../src/services/issues';
import { addMember } from '../src/services/members';
import { createProject, listProjects } from '../src/services/projects';
import { toolByName } from '../src/tools/registry';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let admin: Ctx;
let secretId = '';

/** What a call that must fail failed with; the call starts only here, when it's awaited. */
async function failure(call: () => Promise<unknown>): Promise<{ status: number; message: string; hint?: string }> {
  try {
    await call();
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return { status: e.status, message: e.message, hint: e.hint };
  }
  throw new Error('expected it to fail');
}

beforeAll(async () => {
  w = await createWorld();
  admin = w.adminCtx;
  secretId = (await createProject(admin, { key: 'SECRET', name: 'Merger', template: 'software', visibility: 'members' })).id;
});

afterAll(async () => {
  await w?.close();
});

describe('a group with a role in a project', () => {
  it('lets its people into a members-only project, as far as its role goes, and no further once they leave it', async () => {
    const outsider = await failure(() => requireProject(w.as(w.anna), 'SECRET'));
    // Hidden answers in the very words of missing.
    expect(outsider).toEqual(await failure(() => requireProject(w.as(w.anna), 'NOPE')).then((f) => ({ ...f, message: f.message.replace('NOPE', 'SECRET') })));

    const team = await createGroup(admin, { name: 'Deal team', description: 'People on the merger' });
    await addGroupMember(admin, team.id, 'anna');
    await addProjectGroup(admin, 'SECRET', { group: 'deal team', role: 'viewer' });

    const anna = w.as(w.anna);
    expect((await requireProject(anna, 'SECRET')).key).toBe('SECRET');
    expect((await projectAccess(anna)).describe(secretId)).toMatchObject({ role: 'viewer', via: 'group', group: 'Deal team', write: false, comment: true });
    expect((await failure(() => createIssue(w.as(w.anna), { project: 'SECRET', summary: 'Valuation' }))).status).toBe(403);

    await updateProjectGroup(admin, 'SECRET', team.id, { role: 'member' });
    const issue = await createIssue(w.as(w.anna), { project: 'SECRET', summary: 'Valuation' });
    expect(issue.id).toMatch(/^SECRET-/);

    await removeGroupMember(admin, team.id, 'anna');
    expect(await failure(() => requireProject(w.as(w.anna), 'SECRET'))).toEqual(outsider);
    expect((await listProjects(w.as(w.anna))).map((p) => p.key)).not.toContain('SECRET');
  });

  it("gives someone the highest of their own role and their groups'", async () => {
    await createProject(admin, { key: 'OPEN', name: 'Open work', template: 'software' });
    const readers = await createGroup(admin, { name: 'Readers' });
    const writers = await createGroup(admin, { name: 'Writers' });
    await addGroupMember(admin, readers.id, 'ben');
    await addProjectGroup(admin, 'OPEN', { group: readers.id, role: 'viewer' });
    const openId = (await requireProject(admin, 'OPEN')).id;

    // An open project keeps a group to reading, as it keeps a person.
    expect((await projectAccess(w.as(w.ben))).describe(openId)).toMatchObject({ role: 'viewer', via: 'group', group: 'Readers' });
    // Their own role, when it's higher, and on a tie.
    await addMember(admin, 'OPEN', { user: 'ben', role: 'member' });
    expect((await projectAccess(w.as(w.ben))).describe(openId)).toMatchObject({ role: 'member', via: 'member', group: null });
    await addGroupMember(admin, writers.id, 'ben');
    await addProjectGroup(admin, 'OPEN', { group: writers.id, role: 'member' });
    expect((await projectAccess(w.as(w.ben))).describe(openId)).toMatchObject({ role: 'member', via: 'member' });
    // A group's, when that's higher; the first group by name, when two give it.
    const leads = await createGroup(admin, { name: 'Leads' });
    const managers = await createGroup(admin, { name: 'Managers' });
    for (const g of [leads, managers]) {
      await addGroupMember(admin, g.id, 'ben');
      await addProjectGroup(admin, 'OPEN', { group: g.id, role: 'manager' });
    }
    expect((await projectAccess(w.as(w.ben))).describe(openId)).toMatchObject({ role: 'manager', via: 'group', group: 'Leads', manage: true });
    // And what decides whom to tell, or assign, sees the same.
    expect((await projectRolesOf(admin.db, openId, [w.ben.id])).get(w.ben.id)).toBe('manager');
  });

  it('is seen at once by a request that already worked its access out', async () => {
    const vera = w.as(w.viewer);
    await failure(() => requireProject(vera, 'SECRET'));
    const auditors = await createGroup(admin, { name: 'Auditors' });
    await addProjectGroup(admin, 'SECRET', { group: auditors.id, role: 'viewer' });
    await addGroupMember(admin, auditors.id, 'vera');
    // The same context, within its two seconds: the change on this instance clears what it worked out.
    expect((await requireProject(vera, 'SECRET')).key).toBe('SECRET');
    expect(await canUserReadProject(admin.db, w.viewer.id, secretId)).toBe(true);
    await removeProjectGroup(admin, 'SECRET', auditors.id);
    expect((await failure(() => requireProject(vera, 'SECRET'))).status).toBe(404);
  });

  it('tells an agent who is in the groups with a role, so it assigns only to people who can see the project', async () => {
    const tool = toolByName('list_project_members')!;
    const team = await createGroup(admin, { name: 'Agents may read this' });
    await addGroupMember(admin, team.id, 'ben');
    await addProjectGroup(admin, 'SECRET', { group: team.id, role: 'viewer' });
    const out = await tool.run(w.as(w.ben), tool.input.parse({ project: 'SECRET' }) as never);
    const data = out.data as { you: Record<string, unknown>; groups: { name: string; role: string; people: string[] }[] };
    expect(data.you).toMatchObject({ role: 'viewer', through: 'the group Agents may read this' });
    expect(data.groups).toContainEqual({ name: 'Agents may read this', role: 'viewer', people: ['ben'] });
    await removeProjectGroup(admin, 'SECRET', team.id);
  });

  it("lets a members-only project's issues be assigned to a group's people, and to nobody else", async () => {
    const pair = await createGroup(admin, { name: 'Pair' });
    await addGroupMember(admin, pair.id, 'anna');
    await addProjectGroup(admin, 'SECRET', { group: pair.id, role: 'member' });
    const issue = await createIssue(admin, { project: 'SECRET', summary: 'Due diligence', fields: { Assignee: 'anna' } });
    expect(issue.fields.find((f) => f.name === 'Assignee')!.value).toMatchObject({ login: 'anna' });
    const f = await failure(() => updateIssue(admin, issue.id, { fields: { Assignee: 'ben' } }));
    expect(f.status).toBe(400);
    expect(f.message).toMatch(/can't see SECRET/);
  });
});

describe('who may change groups, and their roles', () => {
  it('lets anyone signed in see groups and who is in them, and only administrators change them', async () => {
    const seen = await listGroups(w.as(w.ben));
    expect(seen.map((g) => g.name)).toContain('Deal team');
    expect((await getGroup(w.as(w.ben), 'Pair')).members.map((m) => m.user.login)).toEqual(['anna']);
    for (const call of [
      () => createGroup(w.as(w.anna), { name: 'Mine' }),
      () => updateGroup(w.as(w.anna), 'Pair', { name: 'Ours' }),
      () => addGroupMember(w.as(w.anna), 'Pair', 'ben'),
      () => removeGroupMember(w.as(w.anna), 'Pair', 'anna'),
      () => deleteGroup(w.as(w.anna), 'Pair'),
    ]) {
      expect(await failure(call)).toMatchObject({ status: 403, message: 'This action requires an administrator' });
    }
  });

  it('counts only the projects a reader can see', async () => {
    const pair = (await listGroups(w.as(w.ben))).find((g) => g.name === 'Pair')!;
    expect(pair.projects).toBe(0);
    expect((await getGroup(w.as(w.ben), pair.id)).roles).toEqual([]);
    expect((await getGroup(admin, pair.id)).roles.map((r) => `${r.project.key}:${r.role}`)).toEqual(['SECRET:member']);
  });

  it("lets a project's managers give groups roles there, and answers others as for any project", async () => {
    await createProject(admin, { key: 'MGD', name: 'Managed', template: 'software', lead: 'ben' });
    const g = await createGroup(admin, { name: 'Helpers' });
    // Ben leads MGD, so manages it: he gives groups roles in it without being an administrator.
    expect((await addProjectGroup(w.as(w.ben), 'MGD', { group: 'Helpers', role: 'viewer' })).role).toBe('viewer');
    expect((await listProjectGroups(w.as(w.anna), 'MGD')).map((r) => r.group.name)).toEqual(['Helpers']);
    expect((await failure(() => updateProjectGroup(w.as(w.anna), 'MGD', g.id, { role: 'manager' }))).status).toBe(403);
    // A project Ben can't see: the same 404 as one that doesn't exist.
    const hidden = await failure(() => addProjectGroup(w.as(w.ben), 'SECRET', { group: 'Helpers', role: 'viewer' }));
    const missing = await failure(() => addProjectGroup(w.as(w.ben), 'NOPE', { group: 'Helpers', role: 'viewer' }));
    expect(hidden.status).toBe(404);
    expect(hidden.message.replace('SECRET', 'X')).toBe(missing.message.replace('NOPE', 'X'));
    expect((await failure(() => addProjectGroup(w.as(w.ben), 'MGD', { group: 'Helpers', role: 'member' }))).status).toBe(409);
  });

  it("writes each change of a group's role in the project's history", async () => {
    await createProject(admin, { key: 'HIST', name: 'History', template: 'software' });
    const g = await createGroup(admin, { name: 'Historians' });
    await addProjectGroup(admin, 'HIST', { group: g.id, role: 'viewer' });
    await updateProjectGroup(admin, 'HIST', g.id, { role: 'manager' });
    await removeProjectGroup(admin, 'HIST', g.id);
    await addProjectGroup(admin, 'HIST', { group: g.id, role: 'member' });
    await deleteGroup(admin, g.id);
    const events = await eventFeed(admin, { project: 'HIST', types: ['project.group.added', 'project.group.changed', 'project.group.removed'] });
    // The feed is newest first.
    expect(events.map((e) => [e.type, e.data]).reverse()).toEqual([
      ['project.group.added', { group: g.id, name: 'Historians', role: 'viewer' }],
      ['project.group.changed', { group: g.id, name: 'Historians', from: 'viewer', to: 'manager' }],
      ['project.group.removed', { group: g.id, name: 'Historians', role: 'manager' }],
      ['project.group.added', { group: g.id, name: 'Historians', role: 'member' }],
      ['project.group.removed', { group: g.id, name: 'Historians', role: 'member', deleted: true }],
    ]);
    // Someone outside a members-only project doesn't see its groups' history either: it answers as a missing one.
    const hidden = await failure(() => eventFeed(w.as(w.ben), { project: 'SECRET', types: ['project.group.added'] }));
    const missing = await failure(() => eventFeed(w.as(w.ben), { project: 'NOPE', types: ['project.group.added'] }));
    expect({ ...hidden, message: hidden.message.replace('SECRET', 'X') }).toEqual({ ...missing, message: missing.message.replace('NOPE', 'X') });
  });

  it('keeps names one of a kind, whatever their case', async () => {
    expect((await failure(() => createGroup(admin, { name: 'deal TEAM' }))).status).toBe(409);
    await createGroup(admin, { name: 'From the provider', providerName: 'eng-all' });
    const f = await failure(() => createGroup(admin, { name: 'Another', providerName: 'ENG-ALL' }));
    expect(f).toMatchObject({ status: 409 });
    expect(f.message).toMatch(/already comes from "ENG-ALL"/);
  });
});

describe('groups from the identity provider', () => {
  it('puts someone in exactly the groups the provider names, and never touches groups kept by hand', async () => {
    const eng = await createGroup(admin, { name: 'Engineering', providerName: 'cn=eng,ou=groups' });
    const ops = await createGroup(admin, { name: 'Operations', providerName: 'ops' });
    const byHand = await createGroup(admin, { name: 'ops-by-hand' });
    await addGroupMember(admin, byHand.id, 'anna');

    expect(await syncProviderGroups(w.app, w.anna.id, providerGroupNames(['CN=ENG,OU=GROUPS', 'ops', 'nobody-knows-this', 7, '']))).toBe(true);
    const inGroups = async () =>
      (await Promise.all([eng.id, ops.id, byHand.id].map(async (id) => ((await getGroup(admin, id)).members.some((m) => m.user.login === 'anna') ? (await getGroup(admin, id)).name : null)))).filter(Boolean);
    expect(await inGroups()).toEqual(['Engineering', 'Operations', 'ops-by-hand']);
    // Put there by the provider: by nobody.
    expect((await getGroup(admin, eng.id)).members[0]).toMatchObject({ user: { login: 'anna' }, addedBy: null });

    // The same again changes nothing; a name gone from the list takes them out of that group alone.
    expect(await syncProviderGroups(w.app, w.anna.id, ['cn=eng,ou=groups', 'ops'])).toBe(false);
    expect(await syncProviderGroups(w.app, w.anna.id, providerGroupNames('ops'))).toBe(true);
    expect(await inGroups()).toEqual(['Operations', 'ops-by-hand']);
    // A provider that names none: out of every group from the provider, and still in the one kept by hand.
    expect(await syncProviderGroups(w.app, w.anna.id, providerGroupNames(undefined))).toBe(true);
    expect(await inGroups()).toEqual(['ops-by-hand']);
  });

  it("refuses to change by hand who is in a group from the provider, and says where it's changed", async () => {
    const f = await failure(() => addGroupMember(admin, 'Engineering', 'ben'));
    expect(f).toMatchObject({ status: 400, message: 'Who is in Engineering comes from the identity provider' });
    expect(f.hint).toMatch(/providerName null/);
    expect((await failure(() => removeGroupMember(admin, 'Operations', 'anna'))).status).toBe(400);
  });

  it('empties a group kept by hand that starts coming from the provider, and keeps the people of one that stops', async () => {
    const g = await createGroup(admin, { name: 'Switching' });
    await addGroupMember(admin, g.id, 'ben');
    expect((await updateGroup(admin, g.id, { providerName: 'switching' })).members).toEqual([]);
    await syncProviderGroups(w.app, w.ben.id, ['switching']);
    // Another name at the provider: those put there under the old one are out, until it names them.
    expect((await updateGroup(admin, g.id, { providerName: 'switching-2' })).members).toEqual([]);
    expect((await updateGroup(admin, g.id, { providerName: 'SWITCHING-2', description: 'Same name, another case' })).description).toBe('Same name, another case');
    await syncProviderGroups(w.app, w.ben.id, ['switching-2']);
    expect((await getGroup(admin, g.id)).members.map((m) => m.user.login)).toEqual(['ben']);
    const kept = await updateGroup(admin, g.id, { providerName: null });
    expect(kept.members.map((m) => m.user.login)).toEqual(['ben']);
    expect(kept.providerName).toBeNull();
    // Kept by hand again: an administrator changes it, and the provider no longer does.
    await addGroupMember(admin, g.id, 'anna');
    expect(await syncProviderGroups(w.app, w.ben.id, [])).toBe(false);
    expect((await getGroup(admin, g.id)).members.map((m) => m.user.login).sort()).toEqual(['anna', 'ben']);
  });

  it('answers over HTTP as the services do, with the same 404 for a project out of sight', async () => {
    const app = createHttpApp(w.app);
    const token = async (u: typeof w.admin, scopes: ('read' | 'write' | 'admin')[]) => (await issueTokenFor(w.app.db, u.id, { name: `t-${u.login}`, scopes })).token;
    const [adminToken, benToken] = [await token(w.admin, ['read', 'write', 'admin']), await token(w.ben, ['read', 'write'])];
    const call = async (method: string, path: string, bearer: string, body?: unknown) => {
      const res = await app.request(`/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${bearer}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const made = await call('POST', '/groups', adminToken, { name: 'Over HTTP', description: 'Made by a script' });
    expect(made).toMatchObject({ status: 201, body: { name: 'Over HTTP', providerName: null, size: 0, members: [], roles: [] } });
    expect((await call('POST', `/groups/${made.body.id}/members`, adminToken, { user: 'ben' })).body.size).toBe(1);
    expect((await call('POST', '/groups', benToken, { name: 'Nope' })).status).toBe(403);
    expect((await call('GET', '/groups', benToken)).body.map((g: { name: string }) => g.name)).toContain('Over HTTP');
    expect((await call('POST', '/projects/OPEN/groups', adminToken, { group: 'Over HTTP', role: 'viewer' })).body).toMatchObject({ group: { name: 'Over HTTP' }, role: 'viewer' });
    const listed = (await call('GET', '/projects/OPEN/groups', benToken)).body as { group: { name: string }; people: { login: string }[] }[];
    // Anyone who sees the project sees who is in it, through its groups too.
    expect(listed.find((g) => g.group.name === 'Over HTTP')!.people.map((p) => p.login)).toEqual(['ben']);
    const hidden = await call('GET', '/projects/SECRET/groups', benToken);
    const missing = await call('GET', '/projects/NOPE/groups', benToken);
    expect(hidden.status).toBe(404);
    expect(JSON.stringify(hidden.body).replace('SECRET', 'X')).toBe(JSON.stringify(missing.body).replace('NOPE', 'X'));
    expect((await call('DELETE', `/projects/OPEN/groups/${made.body.id}`, adminToken)).status).toBe(204);
    expect((await call('DELETE', `/groups/${made.body.id}`, adminToken)).status).toBe(204);
    expect((await call('GET', `/groups/${made.body.id}`, adminToken)).status).toBe(404);
  });

  it('turns what a provider sends into names, whatever shape it comes in', () => {
    expect(providerGroupNames(['A', ' a ', 'B', null, 3, ['c']])).toEqual(['a', 'b']);
    expect(providerGroupNames('Solo')).toEqual(['solo']);
    expect(providerGroupNames(null)).toEqual([]);
  });
});
