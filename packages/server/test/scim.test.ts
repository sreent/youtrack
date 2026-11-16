/**
 * Provisioning over SCIM 2.0 (D38), with the requests Microsoft Entra ID sends, as its provisioning
 * service and its SCIM validator write them: capitalised ops, "False" for false, filtered paths,
 * a value with no path, members added and removed.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activities, groupMembers, groups, sessions, users } from '../src/db/schema';
import { createHttpApp } from '../src/http/app';
import { createToken } from '../src/services/auth';
import { addGroupMember, addProjectGroup } from '../src/services/groups';
import { createScimToken } from '../src/scim/service';
import { updateUser } from '../src/services/users';
import { createWorld, type TestWorld } from './helpers';

const BASE = 'http://localhost:3999';
let w: TestWorld;
let app: ReturnType<typeof createHttpApp>;
let token = '';

async function scim(method: string, path: string, body?: unknown, auth: string | null = token) {
  const headers: Record<string, string> = { 'content-type': 'application/scim+json' };
  if (auth) headers.authorization = `Bearer ${auth}`;
  const res = await app.request(`/scim/v2${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, type: res.headers.get('content-type'), challenge: res.headers.get('www-authenticate'), body: text ? JSON.parse(text) : null };
}

const patch = (...Operations: unknown[]) => ({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations });

/** Entra's create, as its validator sends it. */
const entraUser = (userName: string, email: string, extra: Record<string, unknown> = {}) => ({
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User', 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'],
  externalId: userName.split('@')[0],
  userName,
  active: true,
  emails: [{ primary: true, type: 'work', value: email }],
  meta: { resourceType: 'User' },
  name: { formatted: 'Given Family', familyName: 'Family', givenName: 'Given' },
  roles: [],
  'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': { department: 'Platform', employeeNumber: '42' },
  ...extra,
});

beforeAll(async () => {
  w = await createWorld({ config: { publicUrl: BASE } });
  app = createHttpApp(w.app);
  token = (await createScimToken(w.adminCtx, 'Microsoft Entra ID')).token;
});
afterAll(async () => {
  await w.close();
});

describe('SCIM tokens', () => {
  it('are made by administrators, shown once, and say where SCIM is', async () => {
    const login = await app.request('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'admin', password: 'password-admin' }) });
    const cookie = login.headers.getSetCookie().find((c) => c.startsWith('a4a_session='))!.split(';')[0]!;
    const made = await app.request('/api/v1/scim/tokens', { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: BASE }, body: JSON.stringify({ name: 'Okta' }) });
    expect(made.status).toBe(201);
    const created = JSON.parse(await made.text());
    expect(created).toMatchObject({ name: 'Okta', baseUrl: `${BASE}/scim/v2` });
    expect(created.token).toMatch(/^a4s_/);
    expect(created.prefix).toBe(created.token.slice(0, 10));
    const listed = JSON.parse(await (await app.request('/api/v1/scim/tokens', { headers: { cookie } })).text());
    expect(listed.map((t: { name: string }) => t.name)).toEqual(['Microsoft Entra ID', 'Okta']);
    expect(JSON.stringify(listed)).not.toContain(created.token);
    expect((await app.request(`/api/v1/scim/tokens/${created.id}`, { method: 'DELETE', headers: { cookie, origin: BASE } })).status).toBe(204);
    expect((await scim('GET', '/ServiceProviderConfig', undefined, created.token)).status).toBe(401);
    // Someone who isn't an administrator can't make one.
    const anna = await createToken(w.as(w.anna), { name: 'anna', scopes: ['read', 'write'] });
    const refused = await app.request('/api/v1/scim/tokens', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${anna.token}` }, body: JSON.stringify({ name: 'mine' }) });
    expect(refused.status).toBe(403);
  });

  it('are the only way in, and SCIM’s errors say so in SCIM’s words', async () => {
    const none = await scim('GET', '/Users', undefined, null);
    expect(none.status).toBe(401);
    expect(none.type).toBe('application/scim+json');
    expect(none.challenge).toMatch(/^Bearer/);
    expect(none.body).toMatchObject({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '401' });
    expect(none.body.detail).toMatch(/Administration → Provisioning/);
    const api = await createToken(w.adminCtx, { name: 'admin', scopes: ['read', 'write', 'admin'] });
    expect((await scim('GET', '/Users', undefined, api.token)).status).toBe(401);
    // And a SCIM token opens nothing else.
    expect((await app.request('/api/v1/me', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it('describe what a4a serves', async () => {
    const spc = await scim('GET', '/ServiceProviderConfig');
    expect(spc.status).toBe(200);
    expect(spc.type).toBe('application/scim+json');
    expect(spc.body).toMatchObject({ patch: { supported: true }, filter: { supported: true }, bulk: { supported: false }, authenticationSchemes: [{ type: 'oauthbearertoken' }] });
    expect((await scim('GET', '/ResourceTypes')).body.Resources.map((r: { id: string }) => r.id)).toEqual(['User', 'Group']);
    expect((await scim('GET', '/Schemas/urn:ietf:params:scim:schemas:core:2.0:User')).body.attributes.map((a: { name: string }) => a.name)).toContain('userName');
    expect((await scim('GET', '/Nothing')).status).toBe(404);
  });
});

describe('provisioning people', () => {
  let id = '';

  it('answers Entra’s test connection: a filter that matches nobody', async () => {
    const res = await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "non-existent user"')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] });
    expect((await scim('GET', `/Users?filter=${encodeURIComponent('userName co "x"')}`)).body).toMatchObject({ status: '400', scimType: 'invalidFilter' });
  });

  it('makes someone new, found by their userName from then on', async () => {
    const made = await scim('POST', '/Users', entraUser('Lea.Kim@corp.example', 'Lea.Kim@corp.example', { displayName: 'Lea Kim' }));
    expect(made.status).toBe(201);
    id = made.body.id;
    expect(made.body).toMatchObject({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'Lea.Kim@corp.example',
      externalId: 'Lea.Kim',
      displayName: 'Lea Kim',
      name: { givenName: 'Given', familyName: 'Family', formatted: 'Given Family' },
      emails: [{ value: 'lea.kim@corp.example', primary: true }],
      active: true,
      meta: { resourceType: 'User', location: `${BASE}/scim/v2/Users/${id}` },
    });
    const [row] = await w.app.db.select().from(users).where(eq(users.id, id));
    // An a4a login from the userName; the email vouched for, as an administrator's is; no password.
    expect(row).toMatchObject({ login: 'lea.kim', name: 'Lea Kim', email: 'lea.kim@corp.example', emailVerified: true, role: 'member', banned: false, passwordHash: null });
    const found = await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "lea.kim@corp.example"')}`);
    expect(found.body.totalResults).toBe(1);
    expect(found.body.Resources[0].id).toBe(id);
    expect((await scim('GET', `/Users/${id}`)).body.userName).toBe('Lea.Kim@corp.example');
    // The same userName again is refused.
    expect((await scim('POST', '/Users', entraUser('lea.kim@corp.example', 'other@corp.example'))).body).toMatchObject({ status: '409', scimType: 'uniqueness' });
  });

  it('takes Entra’s updates: filtered paths, dotted names, values with no path', async () => {
    const res = await scim(
      'PATCH',
      `/Users/${id}`,
      patch(
        { op: 'Replace', path: 'emails[type eq "work"].value', value: 'lea@corp.example' },
        { op: 'Replace', path: 'name.familyName', value: 'Kim-Park' },
        { op: 'Add', value: { displayName: 'Lea Kim-Park', 'name.givenName': 'Lea' } },
        { op: 'Add', path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department', value: 'Data' },
        { op: 'Replace', path: 'title', value: 'Engineer' },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ displayName: 'Lea Kim-Park', name: { givenName: 'Lea', familyName: 'Kim-Park' }, emails: [{ value: 'lea@corp.example' }] });
    const [row] = await w.app.db.select().from(users).where(eq(users.id, id));
    expect(row).toMatchObject({ name: 'Lea Kim-Park', email: 'lea@corp.example', emailVerified: true });
    const renamed = await scim('PATCH', `/Users/${id}`, patch({ op: 'Replace', path: 'userName', value: 'lea@corp.example' }));
    expect(renamed.body.userName).toBe('lea@corp.example');
  });

  it('deactivating bans, with "False" as Entra writes it, and ends their sessions; reactivating lets them back', async () => {
    await w.app.db.insert(sessions).values({ id: 'lea-session', userId: id, expiresAt: new Date(Date.now() + 86_400_000) });
    const off = await scim('PATCH', `/Users/${id}`, patch({ op: 'Replace', path: 'active', value: 'False' }));
    expect(off.status).toBe(200);
    expect(off.body.active).toBe(false);
    const [row] = await w.app.db.select().from(users).where(eq(users.id, id));
    expect(row!.banned).toBe(true);
    expect(await w.app.db.select().from(sessions).where(eq(sessions.userId, id))).toEqual([]);
    const on = await scim('PATCH', `/Users/${id}`, patch({ op: 'Replace', value: { active: 'True' } }));
    expect(on.body.active).toBe(true);
    const off2 = await scim('PATCH', `/Users/${id}`, patch({ op: 'replace', path: 'active', value: false }));
    expect(off2.body.active).toBe(false);
    expect((await scim('PATCH', `/Users/${id}`, patch({ op: 'Replace', path: 'active', value: 'maybe' }))).body).toMatchObject({ status: '400', scimType: 'invalidValue' });
    await scim('PATCH', `/Users/${id}`, patch({ op: 'Replace', path: 'active', value: true }));
  });

  it('takes over an account whose confirmed email it provisions, and refuses an unconfirmed one', async () => {
    await updateUser(w.adminCtx, w.anna.id, { email: 'anna@corp.example' });
    const anna = await scim('POST', '/Users', entraUser('anna@corp.example', 'ANNA@corp.example'));
    expect(anna.status).toBe(201);
    expect(anna.body.id).toBe(w.anna.id);
    const [row] = await w.app.db.select().from(users).where(eq(users.id, w.anna.id));
    expect(row!.login).toBe('anna');
    // Ben set his own email; no administrator confirmed it.
    await w.app.db.update(users).set({ email: 'ben@corp.example', emailVerified: false }).where(eq(users.id, w.ben.id));
    const ben = await scim('POST', '/Users', entraUser('ben@corp.example', 'ben@corp.example'));
    expect(ben.status).toBe(409);
    expect(ben.body).toMatchObject({ scimType: 'uniqueness' });
    expect(ben.body.detail).toMatch(/Confirm it in a4a/);
    // Only provisioned people are SCIM's to see.
    const all = await scim('GET', '/Users?startIndex=1&count=1');
    expect(all.body).toMatchObject({ totalResults: 2, startIndex: 1, itemsPerPage: 1 });
    expect((await scim('GET', `/Users/${w.ben.id}`)).status).toBe(404);
    const second = await scim('GET', '/Users?startIndex=2&count=5');
    expect(second.body.Resources.map((r: { id: string }) => r.id)).toEqual([w.anna.id]);
  });
});

describe('provisioning groups', () => {
  let groupId = '';
  let lea = '';

  it('makes a group that follows the provider, by the id Entra gives it', async () => {
    lea = (await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "lea@corp.example"')}`)).body.Resources[0].id;
    const made = await scim('POST', '/Groups', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group', 'http://schemas.microsoft.com/2006/11/ResourceManagement/ADSCIM/Group'],
      externalId: '8aa1a0c0-c4c3-4bc0-b4a5-2ef676900159',
      displayName: 'Platform',
      meta: { resourceType: 'Group' },
    });
    expect(made.status).toBe(201);
    groupId = made.body.id;
    expect(made.body).toMatchObject({ displayName: 'Platform', externalId: '8aa1a0c0-c4c3-4bc0-b4a5-2ef676900159', members: [] });
    const [g] = await w.app.db.select().from(groups).where(eq(groups.id, groupId));
    expect(g!.providerName).toBe('8aa1a0c0-c4c3-4bc0-b4a5-2ef676900159');
    const byName = await scim('GET', `/Groups?excludedAttributes=members&filter=${encodeURIComponent('displayName eq "platform"')}`);
    expect(byName.body.totalResults).toBe(1);
    expect(byName.body.Resources[0]).not.toHaveProperty('members');
    expect((await scim('GET', `/Groups/${groupId}?excludedAttributes=members`)).body).not.toHaveProperty('members');
  });

  it('adds and removes members as Entra does, and renames with a value that has no path', async () => {
    const add = await scim('PATCH', `/Groups/${groupId}`, patch({ op: 'Add', path: 'members', value: [{ $ref: null, value: lea }, { value: w.anna.id }] }));
    expect(add.status).toBe(204);
    expect((await scim('GET', `/Groups/${groupId}`)).body.members.map((m: { value: string }) => m.value).sort()).toEqual([lea, w.anna.id].sort());
    expect((await scim('PATCH', `/Groups/${groupId}`, patch({ op: 'Remove', path: 'members', value: [{ $ref: null, value: lea }] }))).status).toBe(204);
    expect((await scim('PATCH', `/Groups/${groupId}`, patch({ op: 'Remove', path: `members[value eq "${w.anna.id}"]` }))).status).toBe(204);
    expect((await scim('GET', `/Groups/${groupId}`)).body.members).toEqual([]);
    const renamed = await scim('PATCH', `/Groups/${groupId}`, patch({ op: 'Replace', value: { id: groupId, displayName: 'Platform team' } }));
    expect(renamed.status).toBe(204);
    expect((await scim('GET', `/Groups/${groupId}`)).body.displayName).toBe('Platform team');
    // Someone it didn't provision isn't its to add.
    expect((await scim('PATCH', `/Groups/${groupId}`, patch({ op: 'Add', path: 'members', value: [{ value: w.ben.id }] }))).body).toMatchObject({ status: '400', scimType: 'invalidValue' });
    await scim('PATCH', `/Groups/${groupId}`, patch({ op: 'Add', path: 'members', value: [{ value: lea }] }));
  });

  it('is the provider’s to fill: an administrator can’t add people by hand', async () => {
    await expect(addGroupMember(w.adminCtx, groupId, 'ben')).rejects.toMatchObject({ status: 400 });
  });

  it('deprovisioning someone bans them and takes them out of its groups', async () => {
    expect((await scim('DELETE', `/Users/${lea}`)).status).toBe(204);
    const [row] = await w.app.db.select().from(users).where(eq(users.id, lea));
    expect(row!.banned).toBe(true);
    expect(await w.app.db.select().from(groupMembers).where(eq(groupMembers.groupId, groupId))).toEqual([]);
    expect((await scim('GET', `/Users/${lea}`)).status).toBe(404);
  });

  it('deleting a group goes the way an administrator’s does: its project roles leave history', async () => {
    await addProjectGroup(w.adminCtx, 'BACK', { group: groupId, role: 'member' });
    expect((await scim('DELETE', `/Groups/${groupId}`)).status).toBe(204);
    expect(await w.app.db.select().from(groups).where(eq(groups.id, groupId))).toEqual([]);
    const history = await w.app.db.select().from(activities).where(eq(activities.type, 'project.group.removed'));
    expect(history.length).toBe(1);
    expect((await scim('GET', `/Groups/${groupId}`)).status).toBe(404);
  });

  it('stops working when its administrator stops being one', async () => {
    await updateUser(w.adminCtx, w.admin.id, { role: 'member' }).catch(() => {});
    await w.app.db.update(users).set({ role: 'member' }).where(eq(users.id, w.admin.id));
    expect((await scim('GET', '/Users')).status).toBe(401);
    await w.app.db.update(users).set({ role: 'admin' }).where(eq(users.id, w.admin.id));
    expect((await scim('GET', '/Users')).status).toBe(200);
  });
});
