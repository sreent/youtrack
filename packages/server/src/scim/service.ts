/**
 * Provisioning over SCIM 2.0 (docs/architecture.md, D38): an identity provider makes, changes and
 * deactivates a4a's people and groups, under a token an administrator gave it.
 *
 * - The provider sees the people and groups it provisioned (or took over: below), not everyone.
 * - It writes through the same paths an administrator's changes take (services/users.ts,
 *   services/groups.ts), acting as the administrator who made the token, while they still are one.
 * - Deactivating someone (active false, or DELETE) bans them: their account, their history and
 *   what they wrote stay, they can't sign in, and their sessions end.
 * - Someone new whose email is on an account here already, confirmed, is that account: it is
 *   provisioned from then on. An unconfirmed match is refused, as single sign-on refuses it.
 * - Provisioned groups follow the provider (D27): who is in one is the provider's to say, by SCIM
 *   or a sign-in's groups claim. Its provider name is its externalId (with Entra, the group's
 *   object id, as a groups claim names it), or else its name.
 * - Writes are one at a time (`exclusive`), so two requests for one userName can't make two people.
 */
import type { ScimToken, ScimTokenCreated } from '@a4a/shared';
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { adminCtx, type Runtime } from '../app-services';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { groupMembers, groups, scimGroups, scimTokens, scimUsers, users } from '../db/schema';
import { randomToken, sha256 } from '../lib/crypto';
import { AppError, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { createGroup, deleteGroup, setProviderMembers, updateGroup } from '../services/groups';
import { freeLogin } from '../services/sso';
import { createUser, updateUser } from '../services/users';
import { attributesOf, bare, listResponse, memberIds, paging, parseFilter, patchOps, SCIM, scimBool, ScimError, text, type Filter } from './protocol';

export const SCIM_TOKEN_PREFIX = 'a4s_';

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type TokenRow = typeof scimTokens.$inferSelect;
const tokenDto = (t: TokenRow): ScimToken => ({ id: t.id, name: t.name, prefix: t.prefix, createdAt: t.createdAt.toISOString(), lastUsedAt: t.lastUsedAt?.toISOString() ?? null });

export async function listScimTokens(ctx: Ctx): Promise<ScimToken[]> {
  requireScope(ctx, 'admin');
  return (await ctx.db.select().from(scimTokens).where(isNull(scimTokens.revokedAt)).orderBy(asc(scimTokens.createdAt))).map(tokenDto);
}

export async function createScimToken(ctx: Ctx, name: string): Promise<ScimTokenCreated> {
  requireScope(ctx, 'admin');
  const token = randomToken(SCIM_TOKEN_PREFIX, 32);
  const [row] = await ctx.db
    .insert(scimTokens)
    .values({ id: newId(), name: name.trim(), tokenHash: sha256(token), prefix: token.slice(0, 10), createdById: ctx.actor.user.id })
    .returning();
  return { ...tokenDto(row!), token, baseUrl: `${ctx.app.config.publicUrl}/scim/v2` };
}

export async function revokeScimToken(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'admin');
  const [row] = await ctx.db.update(scimTokens).set({ revokedAt: new Date() }).where(and(eq(scimTokens.id, id), isNull(scimTokens.revokedAt))).returning({ id: scimTokens.id });
  if (!row) throw notFound('SCIM token', 'See the live ones in Administration → Provisioning.');
}

/** Who a SCIM token acts as: the administrator who made it, while they are one. Null otherwise. */
export async function scimActor(runtime: Runtime, bearer: string | undefined): Promise<Ctx | null> {
  if (!bearer?.startsWith(SCIM_TOKEN_PREFIX)) return null;
  const [row] = await runtime.db
    .select({ token: scimTokens, user: users })
    .from(scimTokens)
    .innerJoin(users, eq(users.id, scimTokens.createdById))
    .where(and(eq(scimTokens.tokenHash, sha256(bearer)), isNull(scimTokens.revokedAt)));
  if (!row || row.user.banned || row.user.isBot || row.user.role !== 'admin') return null;
  // Written at most once a minute: a provisioning run is many requests.
  if (!row.token.lastUsedAt || Date.now() - row.token.lastUsedAt.getTime() > 60_000) {
    await runtime.db.update(scimTokens).set({ lastUsedAt: new Date() }).where(eq(scimTokens.id, row.token.id));
  }
  const ctx = adminCtx(runtime, row.user, 'api');
  ctx.actor.tokenName = `SCIM: ${row.token.name}`;
  return ctx;
}

// ---------------------------------------------------------------------------
// One call
// ---------------------------------------------------------------------------

export interface ScimCall {
  runtime: Runtime;
  ctx: Ctx;
  /** https://a4a.example/scim/v2 */
  base: string;
}

/** a4a's own refusals, as SCIM says them. */
async function asScim<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError && !(e instanceof ScimError)) {
      const detail = [e.message, e.hint].filter(Boolean).join('. ');
      throw new ScimError(e.status, detail, e.status === 409 || e.code === 'login_taken' ? 'uniqueness' : e.status === 400 ? 'invalidValue' : undefined);
    }
    throw e;
  }
}

const one = <T>(call: ScimCall, fn: () => Promise<T>) => call.runtime.database.exclusive(() => asScim(fn));

const meta = (call: ScimCall, kind: 'User' | 'Group', id: string, created: Date, modified: Date) => ({
  resourceType: kind,
  created: created.toISOString(),
  lastModified: modified.toISOString(),
  location: `${call.base}/${kind}s/${id}`,
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

type UserRow = typeof users.$inferSelect;
type ScimUserRow = typeof scimUsers.$inferSelect;
type NameParts = ScimUserRow['nameParts'];

interface UserDraft {
  userName: string | null;
  externalId: string | null;
  active: boolean | undefined;
  email: string | null;
  parts: NameParts;
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;

function emailFrom(value: unknown): string | null {
  if (Array.isArray(value)) {
    const list = value.filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object');
    const chosen = list.find((e) => scimBool(e.primary) === true) ?? list.find((e) => String(e.type ?? '').toLowerCase() === 'work') ?? list[0];
    return chosen ? emailFrom(chosen.value) : null;
  }
  const t = text(value, 'An email');
  if (t && !EMAIL.test(t)) throw new ScimError(400, `"${t}" isn't an email address`, 'invalidValue');
  return t?.toLowerCase() ?? null;
}

/** One attribute of a user, as an operation sets or takes it. Attributes a4a doesn't keep are let be. */
function applyToUser(d: UserDraft, op: 'add' | 'replace' | 'remove', rawPath: string, value: unknown): void {
  const path = bare(rawPath).toLowerCase();
  const gone = op === 'remove';
  if (path === 'username') {
    if (gone) throw new ScimError(400, 'userName can’t be removed', 'mutability');
    d.userName = text(value, 'userName');
    if (!d.userName) throw new ScimError(400, 'userName can’t be empty', 'invalidValue');
  } else if (path === 'externalid') {
    d.externalId = gone ? null : text(value, 'externalId');
  } else if (path === 'active') {
    if (gone) return;
    const on = scimBool(value);
    if (on === undefined) throw new ScimError(400, 'active takes true or false', 'invalidValue');
    d.active = on;
  } else if (path === 'displayname') {
    d.parts = { ...d.parts, displayName: gone ? undefined : (text(value, 'displayName') ?? undefined) };
  } else if (path === 'name') {
    if (gone) d.parts = { displayName: d.parts.displayName };
    else for (const [k, v] of attributesOf(value, 'name')) applyToUser(d, op, k, v);
  } else if (path === 'name.formatted' || path === 'name.givenname' || path === 'name.familyname') {
    const key = ({ 'name.formatted': 'formatted', 'name.givenname': 'givenName', 'name.familyname': 'familyName' } as const)[path];
    d.parts = { ...d.parts, [key]: gone ? undefined : (text(value, rawPath) ?? undefined) };
  } else if (path === 'emails') {
    d.email = gone ? null : emailFrom(value);
  } else if (/^emails(\[[^\]]*\])?(\.value)?$/.test(path)) {
    d.email = gone ? null : emailFrom(value);
  }
}

function draftFromResource(body: unknown, current?: UserDraft): UserDraft {
  if (!body || typeof body !== 'object') throw new ScimError(400, 'Send a User resource: { "userName", "name", "emails", "active" }', 'invalidSyntax');
  const d: UserDraft = { userName: null, externalId: null, active: current?.active, email: null, parts: {} };
  for (const [path, value] of attributesOf(body)) {
    if (/^(schemas|id|meta|password)$/i.test(path)) continue;
    applyToUser(d, 'replace', path, value);
  }
  if (!d.userName) throw new ScimError(400, 'userName is required: the name the provider knows them by, e.g. anna@corp.com', 'invalidValue');
  return d;
}

/** The name a4a shows: the display name, else the parts. */
function nameOf(d: UserDraft, fallback: string): string {
  const p = d.parts;
  return (p.displayName || p.formatted || [p.givenName, p.familyName].filter(Boolean).join(' ') || fallback).slice(0, 200);
}

function userResource(call: ScimCall, u: UserRow, link: ScimUserRow) {
  const p = link.nameParts ?? {};
  return {
    schemas: [SCIM.user],
    id: u.id,
    ...(link.externalId ? { externalId: link.externalId } : {}),
    userName: link.userName,
    name: { formatted: p.formatted ?? u.name, ...(p.givenName ? { givenName: p.givenName } : {}), ...(p.familyName ? { familyName: p.familyName } : {}) },
    displayName: p.displayName ?? u.name,
    emails: u.email ? [{ value: u.email, type: 'work', primary: true }] : [],
    active: !u.banned,
    meta: meta(call, 'User', u.id, link.createdAt, link.updatedAt > u.updatedAt ? link.updatedAt : u.updatedAt),
  };
}

async function provisionedUser(db: Db, id: string): Promise<{ user: UserRow; link: ScimUserRow }> {
  const [row] = await db.select({ user: users, link: scimUsers }).from(scimUsers).innerJoin(users, eq(users.id, scimUsers.userId)).where(eq(scimUsers.userId, id));
  if (!row) throw new ScimError(404, `No provisioned user has the id ${id}`);
  return row;
}

async function userNameFree(db: Db, userName: string, except?: string): Promise<void> {
  const [taken] = await db.select({ userId: scimUsers.userId }).from(scimUsers).where(sql`lower(${scimUsers.userName}) = ${userName.toLowerCase()}`);
  if (taken && taken.userId !== except) throw new ScimError(409, `A user with the userName "${userName}" is provisioned already`, 'uniqueness');
}

/** An account here with this email that provisioning may take over; null when there is none. */
async function accountWithEmail(db: Db, email: string | null): Promise<string | null> {
  if (!email) return null;
  const found = await db
    .select({ id: users.id, emailVerified: users.emailVerified, linked: scimUsers.userId })
    .from(users)
    .leftJoin(scimUsers, eq(scimUsers.userId, users.id))
    .where(and(sql`lower(${users.email}) = ${email}`, eq(users.isBot, false)));
  if (!found.length) return null;
  if (found.length > 1) throw new ScimError(409, `More than one account here has the email ${email}. An administrator can change all but one in a4a, then retry`, 'uniqueness');
  const [m] = found;
  if (m!.linked) throw new ScimError(409, `The account with the email ${email} is provisioned under another userName`, 'uniqueness');
  if (!m!.emailVerified) {
    throw new ScimError(409, `An account here has the email ${email}, but no administrator has confirmed it. Confirm it in a4a (Administration → People: save their email), then retry`, 'uniqueness');
  }
  return m!.id;
}

/** Save a user's draft through a4a's own paths: name, email, banned; then what SCIM keeps of them. */
async function saveUser(call: ScimCall, user: UserRow, link: ScimUserRow | null, d: UserDraft): Promise<void> {
  const name = nameOf(d, user.name);
  const changes: { name?: string; email?: string | null; banned?: boolean } = {};
  if (name !== user.name) changes.name = name;
  if (d.email !== (user.email?.toLowerCase() ?? null)) changes.email = d.email;
  if (d.active !== undefined && d.active === user.banned) changes.banned = !d.active;
  if (Object.keys(changes).length) await updateUser(call.ctx, user.id, changes);
  const kept = { userName: d.userName!, externalId: d.externalId, nameParts: d.parts, updatedAt: new Date() };
  if (link) await call.ctx.db.update(scimUsers).set(kept).where(eq(scimUsers.userId, user.id));
  else await call.ctx.db.insert(scimUsers).values({ userId: user.id, ...kept });
}

export async function getScimUser(call: ScimCall, id: string) {
  const { user, link } = await provisionedUser(call.ctx.db, id);
  return userResource(call, user, link);
}

function userWhere(f: Filter): SQL {
  switch (f.attribute) {
    case 'username':
      return sql`lower(${scimUsers.userName}) = ${f.value.toLowerCase()}`;
    case 'externalid':
      return eq(scimUsers.externalId, f.value);
    case 'id':
      return eq(users.id, f.value);
    case 'emails':
    case 'emails.value':
      return sql`lower(${users.email}) = ${f.value.toLowerCase()}`;
    case 'displayname':
      return eq(users.name, f.value);
    default:
      throw new ScimError(400, `Users are found by userName, externalId, id, emails.value or displayName, not ${f.attribute}`, 'invalidFilter');
  }
}

export async function listScimUsers(call: ScimCall, query: { filter?: string; startIndex?: string; count?: string }) {
  const f = parseFilter(query.filter);
  const where = f ? userWhere(f) : undefined;
  const { startIndex, count } = paging(query);
  const [{ n } = { n: 0 }] = await call.ctx.db.select({ n: sql<number>`count(*)::int` }).from(scimUsers).innerJoin(users, eq(users.id, scimUsers.userId)).where(where);
  const rows = count
    ? await call.ctx.db
        .select({ user: users, link: scimUsers })
        .from(scimUsers)
        .innerJoin(users, eq(users.id, scimUsers.userId))
        .where(where)
        .orderBy(asc(scimUsers.createdAt), asc(users.id))
        .limit(count)
        .offset(startIndex - 1)
    : [];
  return listResponse(Number(n), startIndex, rows.map((r) => userResource(call, r.user, r.link)));
}

export async function createScimUser(call: ScimCall, body: unknown) {
  const d = draftFromResource(body);
  const id = await one(call, async () => {
    await userNameFree(call.ctx.db, d.userName!);
    const existing = await accountWithEmail(call.ctx.db, d.email);
    let user: UserRow;
    if (existing) {
      [user] = (await call.ctx.db.select().from(users).where(eq(users.id, existing))) as [UserRow];
    } else {
      const login = await freeLogin(call.ctx.db, d.userName!.split('@')[0]!);
      const made = await createUser(call.ctx, { login, name: nameOf(d, d.userName!), email: d.email, role: 'member' });
      [user] = (await call.ctx.db.select().from(users).where(eq(users.id, made.id))) as [UserRow];
    }
    await saveUser(call, user, null, d);
    return user.id;
  });
  return getScimUser(call, id);
}

export async function replaceScimUser(call: ScimCall, id: string, body: unknown) {
  await one(call, async () => {
    const { user, link } = await provisionedUser(call.ctx.db, id);
    const d = draftFromResource(body, { userName: link.userName, externalId: link.externalId, active: !user.banned, email: user.email, parts: link.nameParts });
    await userNameFree(call.ctx.db, d.userName!, user.id);
    await saveUser(call, user, link, d);
  });
  return getScimUser(call, id);
}

export async function patchScimUser(call: ScimCall, id: string, body: unknown) {
  const ops = patchOps(body);
  await one(call, async () => {
    const { user, link } = await provisionedUser(call.ctx.db, id);
    const d: UserDraft = { userName: link.userName, externalId: link.externalId, active: !user.banned, email: user.email?.toLowerCase() ?? null, parts: { ...link.nameParts } };
    for (const o of ops) {
      if (o.path) applyToUser(d, o.op, o.path, o.value);
      else for (const [path, value] of attributesOf(o.value)) applyToUser(d, o.op, path, value);
    }
    if (d.userName!.toLowerCase() !== link.userName.toLowerCase()) await userNameFree(call.ctx.db, d.userName!, user.id);
    await saveUser(call, user, link, d);
  });
  return getScimUser(call, id);
}

/** Deprovisioned: banned, out of the provisioned groups, and no longer the provider's to see. */
export async function deleteScimUser(call: ScimCall, id: string): Promise<void> {
  await one(call, async () => {
    const { user } = await provisionedUser(call.ctx.db, id);
    if (!user.banned) await updateUser(call.ctx, user.id, { banned: true });
    const theirs = await call.ctx.db
      .select({ groupId: groupMembers.groupId })
      .from(groupMembers)
      .innerJoin(scimGroups, eq(scimGroups.groupId, groupMembers.groupId))
      .where(eq(groupMembers.userId, user.id));
    for (const g of theirs) await setProviderMembers(call.runtime, g.groupId, { remove: [user.id] });
    await call.ctx.db.delete(scimUsers).where(eq(scimUsers.userId, user.id));
  });
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

type GroupRow = typeof groups.$inferSelect;
type ScimGroupRow = typeof scimGroups.$inferSelect;

async function membersOf(db: Db, groupIds: string[]): Promise<Map<string, Array<{ id: string; name: string }>>> {
  const out = new Map<string, Array<{ id: string; name: string }>>();
  if (!groupIds.length) return out;
  const rows = await db
    .select({ groupId: groupMembers.groupId, id: users.id, name: users.name })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(inArray(groupMembers.groupId, groupIds))
    .orderBy(asc(users.name));
  for (const r of rows) out.set(r.groupId, [...(out.get(r.groupId) ?? []), { id: r.id, name: r.name }]);
  return out;
}

function groupResource(call: ScimCall, g: GroupRow, link: ScimGroupRow, members: Array<{ id: string; name: string }> | null) {
  return {
    schemas: [SCIM.group],
    id: g.id,
    ...(link.externalId ? { externalId: link.externalId } : {}),
    displayName: g.name,
    ...(members ? { members: members.map((m) => ({ value: m.id, display: m.name, $ref: `${call.base}/Users/${m.id}` })) } : {}),
    meta: meta(call, 'Group', g.id, link.createdAt, link.updatedAt > g.updatedAt ? link.updatedAt : g.updatedAt),
  };
}

async function provisionedGroup(db: Db, id: string): Promise<{ group: GroupRow; link: ScimGroupRow }> {
  const [row] = await db.select({ group: groups, link: scimGroups }).from(scimGroups).innerJoin(groups, eq(groups.id, scimGroups.groupId)).where(eq(scimGroups.groupId, id));
  if (!row) throw new ScimError(404, `No provisioned group has the id ${id}`);
  return row;
}

/** Members must be people provisioning knows: those it provisioned. */
async function knownMembers(db: Db, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const found = new Set((await db.select({ id: scimUsers.userId }).from(scimUsers).where(inArray(scimUsers.userId, unique))).map((r) => r.id));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length) throw new ScimError(400, `No provisioned user has the id ${missing.slice(0, 3).join(', ')}: provision them first`, 'invalidValue');
  return unique;
}

export async function getScimGroup(call: ScimCall, id: string, excluded?: string) {
  const { group, link } = await provisionedGroup(call.ctx.db, id);
  const withMembers = !/\bmembers\b/i.test(excluded ?? '');
  return groupResource(call, group, link, withMembers ? ((await membersOf(call.ctx.db, [group.id])).get(group.id) ?? []) : null);
}

function groupWhere(f: Filter): SQL {
  switch (f.attribute) {
    case 'displayname':
      return sql`lower(${groups.name}) = ${f.value.toLowerCase()}`;
    case 'externalid':
      return eq(scimGroups.externalId, f.value);
    case 'id':
      return eq(groups.id, f.value);
    default:
      throw new ScimError(400, `Groups are found by displayName, externalId or id, not ${f.attribute}`, 'invalidFilter');
  }
}

export async function listScimGroups(call: ScimCall, query: { filter?: string; startIndex?: string; count?: string; excludedAttributes?: string }) {
  const f = parseFilter(query.filter);
  const where = f ? groupWhere(f) : undefined;
  const { startIndex, count } = paging(query);
  const [{ n } = { n: 0 }] = await call.ctx.db.select({ n: sql<number>`count(*)::int` }).from(scimGroups).innerJoin(groups, eq(groups.id, scimGroups.groupId)).where(where);
  const rows = count
    ? await call.ctx.db
        .select({ group: groups, link: scimGroups })
        .from(scimGroups)
        .innerJoin(groups, eq(groups.id, scimGroups.groupId))
        .where(where)
        .orderBy(asc(scimGroups.createdAt), asc(groups.id))
        .limit(count)
        .offset(startIndex - 1)
    : [];
  const withMembers = !/\bmembers\b/i.test(query.excludedAttributes ?? '');
  const members = withMembers ? await membersOf(call.ctx.db, rows.map((r) => r.group.id)) : null;
  return listResponse(Number(n), startIndex, rows.map((r) => groupResource(call, r.group, r.link, members ? (members.get(r.group.id) ?? []) : null)));
}

function groupBody(body: unknown): { displayName: string; externalId: string | null; members: string[] | undefined } {
  if (!body || typeof body !== 'object') throw new ScimError(400, 'Send a Group resource: { "displayName", "members" }', 'invalidSyntax');
  const b = body as Record<string, unknown>;
  const displayName = text(b.displayName, 'displayName');
  if (!displayName) throw new ScimError(400, 'displayName is required', 'invalidValue');
  return { displayName, externalId: text(b.externalId, 'externalId'), members: b.members === undefined ? undefined : memberIds(b.members) };
}

export async function createScimGroup(call: ScimCall, body: unknown) {
  const g = groupBody(body);
  const id = await one(call, async () => {
    const providerName = g.externalId ?? g.displayName;
    // A group an administrator made to follow this provider group already becomes the provisioned one.
    const [followed] = await call.ctx.db
      .select({ id: groups.id, name: groups.name, linked: scimGroups.groupId })
      .from(groups)
      .leftJoin(scimGroups, eq(scimGroups.groupId, groups.id))
      .where(sql`lower(${groups.providerName}) = ${providerName.toLowerCase()}`);
    if (followed?.linked) throw new ScimError(409, `The group "${followed.name}" is provisioned already`, 'uniqueness');
    let groupId = followed?.id;
    if (groupId) {
      if (followed!.name !== g.displayName) await updateGroup(call.ctx, groupId, { name: g.displayName });
    } else {
      groupId = (await createGroup(call.ctx, { name: g.displayName, providerName, description: `Provisioned by ${call.ctx.actor.tokenName?.replace(/^SCIM: /, '') ?? 'SCIM'}` })).id;
    }
    await call.ctx.db.insert(scimGroups).values({ groupId, externalId: g.externalId });
    if (g.members) await setProviderMembers(call.runtime, groupId, { exactly: await knownMembers(call.ctx.db, g.members) });
    return groupId;
  });
  return getScimGroup(call, id);
}

export async function replaceScimGroup(call: ScimCall, id: string, body: unknown) {
  const g = groupBody(body);
  await one(call, async () => {
    const { group } = await provisionedGroup(call.ctx.db, id);
    if (group.name !== g.displayName) await updateGroup(call.ctx, group.id, { name: g.displayName });
    await call.ctx.db.update(scimGroups).set({ externalId: g.externalId, updatedAt: new Date() }).where(eq(scimGroups.groupId, group.id));
    await setProviderMembers(call.runtime, group.id, { exactly: await knownMembers(call.ctx.db, g.members ?? []) });
  });
  return getScimGroup(call, id);
}

/** Answers nothing (204): a large group's members are many, and Entra doesn't read them back. */
export async function patchScimGroup(call: ScimCall, id: string, body: unknown): Promise<void> {
  const ops = patchOps(body);
  await one(call, async () => {
    const { group, link } = await provisionedGroup(call.ctx.db, id);
    let name = group.name;
    let externalId = link.externalId;
    const before = new Set((await call.ctx.db.select({ userId: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, group.id))).map((r) => r.userId));
    const members = new Set(before);
    const added: string[] = [];
    const apply = (op: 'add' | 'replace' | 'remove', rawPath: string, value: unknown) => {
      const path = bare(rawPath).toLowerCase();
      const single = /^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i.exec(bare(rawPath));
      if (path === 'displayname') {
        if (op === 'remove') throw new ScimError(400, 'displayName can’t be removed', 'mutability');
        name = text(value, 'displayName') ?? name;
      } else if (path === 'externalid') {
        externalId = op === 'remove' ? null : text(value, 'externalId');
      } else if (path === 'members') {
        const ids = value === undefined || value === null ? [] : memberIds(value);
        if (op === 'add') for (const m of ids) (members.add(m), added.push(m));
        else if (op === 'replace') {
          members.clear();
          for (const m of ids) (members.add(m), added.push(m));
        } else if (ids.length) for (const m of ids) members.delete(m);
        else members.clear();
      } else if (single) {
        if (op !== 'remove') throw new ScimError(400, `Add members with the path "members" and a value, not ${rawPath}`, 'invalidPath');
        members.delete(single[1]!);
      }
    };
    for (const o of ops) {
      if (o.path) apply(o.op, o.path, o.value);
      else for (const [path, value] of attributesOf(o.value)) apply(o.op, path, value);
    }
    await knownMembers(call.ctx.db, added.filter((m) => members.has(m) && !before.has(m)));
    if (name !== group.name) await updateGroup(call.ctx, group.id, { name });
    await call.ctx.db.update(scimGroups).set({ externalId, updatedAt: new Date() }).where(eq(scimGroups.groupId, group.id));
    await setProviderMembers(call.runtime, group.id, { exactly: [...members] });
  });
}

export async function deleteScimGroup(call: ScimCall, id: string): Promise<void> {
  await one(call, async () => {
    const { group } = await provisionedGroup(call.ctx.db, id);
    await deleteGroup(call.ctx, group.id);
  });
}
