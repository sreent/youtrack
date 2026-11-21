/**
 * Customer groups in the help desk (D56): the companies, teams or organizations a desk's requesters
 * belong to.
 *
 * - A group is its desk's own, as its SLA policies are. It has a name, the email domains that put a
 *   requester in it by themselves, and requesters added by hand. A domain names one group at a desk,
 *   and someone added by hand is in that group, whatever their address says: one group per requester
 *   at a desk, at most.
 * - A request is filed under its requester's group then, and keeps it, as it keeps its project:
 *   joining or leaving a group, or a domain added or taken off, moves no request already filed. The
 *   team gives a request another group, or none, through the write path (`requestGroup`), in its
 *   history.
 * - Its SLA counts in the group's own hours, where it has some; a new request goes to one of the
 *   group's dedicated agents; and its members see, or answer, each other's requests on the portal,
 *   unless one is kept private (services/portal.ts, through the seam's `requesterSees`).
 */
import { isOwnAgent, type BusinessHours, type Change, type CustomerGroup, type CustomerGroupInput, type CustomerGroupMember, type CustomerSharing } from '@a4a/shared';
import { and, asc, eq, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { adminCtx } from '../app-services';
import { requireScope, type AppServices, type Ctx } from '../context';
import type { Db } from '../db/client';
import { absences, customerGroupAgents, customerGroupDomains, customerGroupMembers, customerGroups, helpdeskRequests, issueFieldValues, issues, portalProviders, requesters, users } from '../db/schema';
import type { ActivityRow } from '../events/activity';
import { calendarOf } from '../helpdesk/business-time';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { localDate, serverTimeZone } from '../reports/tz';
import { emailDomain, issueSeenSql, projectAccess, projectGrantsOf, requesterMayComment, requireProject } from './access';
import { readableId } from './issue-refs';
import { applyChanges, type ChangeSpec } from './issues';
import { projectSettings } from './projects';
import type { ProjectRow, SchemaSnapshot } from './schema-cache';
import { restartStretches, resyncOpen } from './sla';
import { userRefDto } from './values';
import { assigneeFieldOf } from './watchers';

export type GroupRow = typeof customerGroups.$inferSelect;
type IssueRow = typeof issues.$inferSelect;
type RequestRow = typeof helpdeskRequests.$inferSelect;

/** The names a request's history gives its group and its privacy (D56): a4a's own, beside its fields'. */
export const GROUP_CHANGE = 'Customer group';
export const PRIVATE_CHANGE = 'Private';
const MAX_GROUPS = 200;

const groupMissing = () => notFound('Customer group', 'It may have been deleted: reload the desk’s settings.').said('customerGroups.groupNotFound');

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/** The group a requester is in at a desk: the one they were added to by hand, else their address's domain's. */
export async function groupOfRequester(db: Db, projectId: string, requester: { id: string | null; email: string }): Promise<GroupRow | null> {
  if (requester.id) {
    const [hand] = await db
      .select({ g: customerGroups })
      .from(customerGroupMembers)
      .innerJoin(customerGroups, eq(customerGroups.id, customerGroupMembers.groupId))
      .where(and(eq(customerGroupMembers.projectId, projectId), eq(customerGroupMembers.requesterId, requester.id)));
    if (hand) return hand.g;
  }
  const domain = emailDomain(requester.email);
  if (!domain) return null;
  const [byDomain] = await db
    .select({ g: customerGroups })
    .from(customerGroupDomains)
    .innerJoin(customerGroups, eq(customerGroups.id, customerGroupDomains.groupId))
    .where(and(eq(customerGroupDomains.projectId, projectId), eq(customerGroupDomains.domain, domain)));
  return byDomain?.g ?? null;
}

/** The groups a requester is in, at most one per desk: by hand first, else by their address's domain. */
export async function groupsOfRequester(db: Db, requester: { id: string; email: string }): Promise<GroupRow[]> {
  const hand = await db
    .select({ g: customerGroups })
    .from(customerGroupMembers)
    .innerJoin(customerGroups, eq(customerGroups.id, customerGroupMembers.groupId))
    .where(eq(customerGroupMembers.requesterId, requester.id));
  const desks = new Set(hand.map((h) => h.g.projectId));
  const domain = emailDomain(requester.email);
  const byDomain = domain
    ? await db.select({ g: customerGroups }).from(customerGroupDomains).innerJoin(customerGroups, eq(customerGroups.id, customerGroupDomains.groupId)).where(eq(customerGroupDomains.domain, domain))
    : [];
  return [...hand.map((h) => h.g), ...byDomain.map((d) => d.g).filter((g) => !desks.has(g.projectId))];
}

/** What a requester's groups share with them, by group: for the seam's `requesterSees`. */
export function sharingOf(groups: readonly GroupRow[]): Map<string, CustomerSharing> {
  return new Map(groups.map((g) => [g.id, g.sharing as CustomerSharing]));
}

/**
 * Someone writing to a request by email who isn't its requester, when its group lets its members
 * answer each other's requests and they're one of them (D56): who they are, made a requester if
 * they never asked anything. Null otherwise, and the message is refused as before (D30).
 */
export async function commentingColleague(db: Db, request: RequestRow, email: string, name: string): Promise<{ id: string; name: string } | null> {
  if (!request.groupId || request.private) return null;
  const [known] = await db.select().from(requesters).where(sql`lower(${requesters.email}) = ${email.toLowerCase()}`);
  const theirs = await groupOfRequester(db, request.projectId, { id: known?.id ?? null, email });
  if (!theirs || !requesterMayComment(request, { id: known?.id ?? '' }, sharingOf([theirs]))) return null;
  if (known) return { id: known.id, name: known.name };
  const made = await requesterByEmail(db, email, name);
  return { id: made.id, name: made.name };
}

/** A requester by their email, made when new, their name kept when known. */
export async function requesterByEmail(db: Db, email: string, name?: string): Promise<typeof requesters.$inferSelect> {
  const clean = email.trim();
  const res = await db.execute(sql`
    INSERT INTO requesters (id, email, name) VALUES (${newId()}, ${clean}, ${name?.trim() || clean.split('@')[0] || clean})
    ON CONFLICT ((lower(email))) DO UPDATE SET updated_at = requesters.updated_at
    RETURNING id`);
  const id = String((res as unknown as { rows: { id: string }[] }).rows[0]!.id);
  const [row] = await db.select().from(requesters).where(eq(requesters.id, id));
  return row!;
}

// ---------------------------------------------------------------------------
// Reading groups
// ---------------------------------------------------------------------------

async function groupsOf(db: Db, projectId: string): Promise<GroupRow[]> {
  return db.select().from(customerGroups).where(eq(customerGroups.projectId, projectId)).orderBy(asc(sql`lower(${customerGroups.name})`));
}

async function dtos(db: Db, s: SchemaSnapshot, project: ProjectRow, rows: GroupRow[], seen?: SQL): Promise<CustomerGroup[]> {
  const ids = rows.map((r) => r.id);
  if (!ids.length) return [];
  const domains = await db.select().from(customerGroupDomains).where(inArray(customerGroupDomains.groupId, ids)).orderBy(asc(customerGroupDomains.domain));
  const agents = await db.select().from(customerGroupAgents).where(inArray(customerGroupAgents.groupId, ids)).orderBy(asc(customerGroupAgents.position));
  const members = await db.select({ id: customerGroupMembers.groupId, n: sql<number>`count(*)::int` }).from(customerGroupMembers).where(inArray(customerGroupMembers.groupId, ids)).groupBy(customerGroupMembers.groupId);
  const open = await db
    .select({ id: helpdeskRequests.groupId, n: sql<number>`count(*)::int` })
    .from(helpdeskRequests)
    .innerJoin(issues, eq(issues.id, helpdeskRequests.issueId))
    // Counted as every count is: only what the reader sees (D37).
    .where(and(inArray(helpdeskRequests.groupId, ids), isNull(issues.resolvedAt), seen))
    .groupBy(helpdeskRequests.groupId);
  const grants = await projectGrantsOf(db, project.id, agents.map((a) => a.userId));
  const tied = [...new Set(rows.map((g) => g.providerId).filter((id): id is string => Boolean(id)))];
  const providers = new Map(tied.length ? (await db.select({ id: portalProviders.id, name: portalProviders.name }).from(portalProviders).where(inArray(portalProviders.id, tied))).map((x) => [x.id, x]) : []);
  return rows.map((g) => ({
    id: g.id,
    name: g.name,
    domains: domains.filter((d) => d.groupId === g.id).map((d) => d.domain),
    sharing: g.sharing as CustomerSharing,
    businessHours: (g.businessHours as BusinessHours | null) ?? null,
    agents: agents
      .filter((a) => a.groupId === g.id)
      .flatMap((a) => {
        const u = s.users.get(a.userId);
        return u ? [{ user: userRefDto(u), assignable: assignable(u, grants.get(u.id)) }] : [];
      }),
    members: Number(members.find((m) => m.id === g.id)?.n ?? 0),
    openRequests: Number(open.find((o) => o.id === g.id)?.n ?? 0),
    provider: (g.providerId && providers.get(g.providerId)) || null,
  }));
}

/** Whether the help desk may give someone a request: a person of the project who may change its issues (a read-only account never may). */
function assignable(u: { isBot: boolean; login: string; banned: boolean; role: string }, grant: { permissions: ReadonlySet<string> } | undefined): boolean {
  return !u.banned && u.role !== 'viewer' && !isOwnAgent(u) && Boolean(grant?.permissions.has('edit'));
}

export async function listCustomerGroups(ctx: Ctx, key: string): Promise<CustomerGroup[]> {
  const project = await requireProject(ctx, key, 'read');
  const s = await ctx.app.schema.get();
  return dtos(ctx.db, s, project, await groupsOf(ctx.db, project.id), issueSeenSql(await projectAccess(ctx), s));
}

async function ownGroup(db: Db, project: ProjectRow, id: string): Promise<GroupRow> {
  const [row] = await db.select().from(customerGroups).where(and(eq(customerGroups.id, id), eq(customerGroups.projectId, project.id)));
  if (!row) throw groupMissing();
  return row;
}

/** A desk's group by its id or its name, in any case; a 404 otherwise. */
export async function groupByRef(db: Db, projectId: string, ref: string): Promise<GroupRow> {
  const [row] = await db
    .select()
    .from(customerGroups)
    .where(and(eq(customerGroups.projectId, projectId), sql`(${customerGroups.id} = ${ref.trim()} OR lower(${customerGroups.name}) = ${ref.trim().toLowerCase()})`));
  if (!row) throw groupMissing();
  return row;
}

export async function getCustomerGroup(ctx: Ctx, key: string, id: string): Promise<CustomerGroup> {
  const project = await requireProject(ctx, key, 'read');
  const s = await ctx.app.schema.get();
  return (await dtos(ctx.db, s, project, [await ownGroup(ctx.db, project, id)], issueSeenSql(await projectAccess(ctx), s)))[0]!;
}

// ---------------------------------------------------------------------------
// Changing groups: administrators, or the desk's managers
// ---------------------------------------------------------------------------

/** What a group's settings must be: a name of its own, domains no other group has, agents who can be given requests, hours that read. */
async function checked(ctx: Ctx, project: ProjectRow, input: CustomerGroupInput, self: string | null) {
  const s = await ctx.app.schema.get();
  const name = input.name.trim().replace(/\s+/g, ' ');
  const others = (await groupsOf(ctx.db, project.id)).filter((g) => g.id !== self);
  const same = others.find((g) => g.name.toLowerCase() === name.toLowerCase());
  if (same) throw conflict(`${project.key} has a customer group called ${same.name}`, 'Give this one another name.').said('customerGroups.nameTaken', { project: project.key, name: same.name });
  if (!self && others.length >= MAX_GROUPS) throw badRequest(`A desk has ${MAX_GROUPS} customer groups at most`, 'Delete one that is no longer used.').said('customerGroups.tooMany', { n: MAX_GROUPS });
  const domains = [...new Set((input.domains ?? []).map((d) => d.trim().toLowerCase()))];
  if (domains.length) {
    const taken = await ctx.db
      .select({ domain: customerGroupDomains.domain, group: customerGroups.name, groupId: customerGroups.id })
      .from(customerGroupDomains)
      .innerJoin(customerGroups, eq(customerGroups.id, customerGroupDomains.groupId))
      .where(and(eq(customerGroupDomains.projectId, project.id), inArray(customerGroupDomains.domain, domains)));
    const clash = taken.find((t) => t.groupId !== self);
    if (clash) {
      throw conflict(`${clash.domain} puts requesters in ${clash.group} already`, `A domain names one group at a desk: take it from ${clash.group} first.`).said('customerGroups.domainTaken', { domain: clash.domain, group: clash.group });
    }
  }
  const logins = [...new Set((input.agents ?? []).map((l) => l.trim().toLowerCase()))];
  const agents = logins.map((login) => {
    const u = s.usersByLogin.get(login);
    if (!u) throw badRequest(`Unknown user "${login}"`, 'Use the login of someone of the project.').said('customerGroups.unknownAgent', { login });
    return u;
  });
  const grants = await projectGrantsOf(ctx.db, project.id, agents.map((u) => u.id));
  for (const u of agents) {
    if (!assignable(u, grants.get(u.id))) {
      throw badRequest(`${u.login} can't be given ${project.key}'s requests`, `Choose someone of ${project.key} who may change its issues.`).said('customerGroups.agentCantTakeRequests', { login: u.login, project: project.key });
    }
  }
  // Hours that don't read are a 400 that says what's wrong (business-time.ts).
  calendarOf(input.businessHours ?? null);
  // Its people sign in through one of the desk's providers, and no other way (D63): left out keeps it.
  const provider = input.provider === undefined ? undefined : input.provider;
  if (provider && !projectSettings(project).helpdesk.signIn.providers.includes(provider)) {
    throw badRequest(`${project.key} doesn't offer that identity provider to its requesters`, 'Choose one the desk offers, under How requesters sign in.').said('customerGroups.providerNotOffered', { project: project.key });
  }
  return { name, domains, agents, sharing: (input.sharing ?? 'none') as CustomerSharing, businessHours: input.businessHours ?? null, provider };
}

function uniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code;
  return code === '23505';
}

async function writeGroup(ctx: Ctx, project: ProjectRow, id: string, c: Awaited<ReturnType<typeof checked>>, isNew: boolean): Promise<void> {
  try {
    await ctx.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const values = { name: c.name, sharing: c.sharing, businessHours: c.businessHours, ...(c.provider !== undefined ? { providerId: c.provider } : {}), updatedAt: new Date() };
      if (isNew) await tx.insert(customerGroups).values({ id, projectId: project.id, ...values });
      else await tx.update(customerGroups).set(values).where(eq(customerGroups.id, id));
      await tx.delete(customerGroupDomains).where(eq(customerGroupDomains.groupId, id));
      if (c.domains.length) await tx.insert(customerGroupDomains).values(c.domains.map((domain) => ({ projectId: project.id, domain, groupId: id })));
      await tx.delete(customerGroupAgents).where(eq(customerGroupAgents.groupId, id));
      if (c.agents.length) await tx.insert(customerGroupAgents).values(c.agents.map((u, position) => ({ groupId: id, userId: u.id, position })));
    });
  } catch (e) {
    // Someone named a group the same, or took a domain, at the same moment.
    if (uniqueViolation(e)) throw conflict('Another change to the desk’s customer groups came first', 'Reload the desk’s settings and try again.').said('customerGroups.changedMeanwhile');
    throw e;
  }
  // The query language reads groups by name, and the desk's open requests follow the group's hours.
  ctx.app.schema.invalidate();
  await resyncOpen(ctx.app, project.id);
}

export async function createCustomerGroup(ctx: Ctx, key: string, input: CustomerGroupInput): Promise<CustomerGroup> {
  requireScope(ctx, 'write');
  const project = await requireProject(ctx, key, 'manage');
  const c = await checked(ctx, project, input, null);
  const id = newId();
  await writeGroup(ctx, project, id, c, true);
  return getCustomerGroup(ctx, key, id);
}

export async function updateCustomerGroup(ctx: Ctx, key: string, id: string, input: CustomerGroupInput): Promise<CustomerGroup> {
  requireScope(ctx, 'write');
  const project = await requireProject(ctx, key, 'manage');
  await ownGroup(ctx.db, project, id);
  await writeGroup(ctx, project, id, await checked(ctx, project, input, id), false);
  return getCustomerGroup(ctx, key, id);
}

/** Its requests keep everything but the group: they're in none from now on. */
export async function deleteCustomerGroup(ctx: Ctx, key: string, id: string): Promise<void> {
  requireScope(ctx, 'write');
  const project = await requireProject(ctx, key, 'manage');
  await ownGroup(ctx.db, project, id);
  await ctx.db.delete(customerGroups).where(eq(customerGroups.id, id));
  ctx.app.schema.invalidate();
  await resyncOpen(ctx.app, project.id);
}

// ---------------------------------------------------------------------------
// Members added by hand
// ---------------------------------------------------------------------------

export async function listGroupMembers(ctx: Ctx, key: string, id: string): Promise<CustomerGroupMember[]> {
  const project = await requireProject(ctx, key, 'read');
  await ownGroup(ctx.db, project, id);
  const rows = await ctx.db
    .select({ m: customerGroupMembers, r: requesters, by: users.login })
    .from(customerGroupMembers)
    .innerJoin(requesters, eq(requesters.id, customerGroupMembers.requesterId))
    .leftJoin(users, eq(users.id, customerGroupMembers.addedById))
    .where(eq(customerGroupMembers.groupId, id))
    .orderBy(asc(sql`lower(${requesters.email})`))
    .limit(2000);
  return rows.map(({ m, r, by }) => ({ requester: { id: r.id, name: r.name, email: r.email }, addedAt: m.addedAt.toISOString(), addedBy: by ?? null }));
}

/**
 * Add a requester by hand, by their email: made a requester if they never asked anything, so a
 * manager can add someone before their first request. One group at a desk: someone in another is
 * refused, naming it, rather than moved without a word.
 */
export async function addGroupMember(ctx: Ctx, key: string, id: string, input: { email: string; name?: string }): Promise<CustomerGroupMember> {
  requireScope(ctx, 'write');
  const project = await requireProject(ctx, key, 'manage');
  const group = await ownGroup(ctx.db, project, id);
  const r = await requesterByEmail(ctx.db, input.email, input.name);
  await ctx.db.insert(customerGroupMembers).values({ projectId: project.id, requesterId: r.id, groupId: group.id, addedById: ctx.actor.user.id }).onConflictDoNothing();
  const [row] = await ctx.db
    .select({ m: customerGroupMembers, g: customerGroups.name })
    .from(customerGroupMembers)
    .innerJoin(customerGroups, eq(customerGroups.id, customerGroupMembers.groupId))
    .where(and(eq(customerGroupMembers.projectId, project.id), eq(customerGroupMembers.requesterId, r.id)));
  if (row && row.m.groupId !== group.id) {
    throw conflict(`${r.email} is in ${row.g} at this desk`, `A requester is in one group at a desk: take them out of ${row.g} first.`).said('customerGroups.inAnotherGroup', { email: r.email, group: row.g });
  }
  return { requester: { id: r.id, name: r.name, email: r.email }, addedAt: (row?.m.addedAt ?? new Date()).toISOString(), addedBy: ctx.actor.user.login };
}

export async function removeGroupMember(ctx: Ctx, key: string, id: string, requesterId: string): Promise<void> {
  requireScope(ctx, 'write');
  const project = await requireProject(ctx, key, 'manage');
  await ownGroup(ctx.db, project, id);
  const gone = await ctx.db
    .delete(customerGroupMembers)
    .where(and(eq(customerGroupMembers.groupId, id), eq(customerGroupMembers.requesterId, requesterId)))
    .returning();
  if (!gone.length) throw notFound('Member', 'They may have been taken out already: reload the group.').said('customerGroups.memberNotFound');
}

// ---------------------------------------------------------------------------
// A request's group, through the write path
// ---------------------------------------------------------------------------

/**
 * What a change to a request's group or privacy is (services/issues.ts calls this in `applyChanges`,
 * before anything is written): the history's lines, and what the request's row becomes.
 */
export async function requestGrouping(tx: Db, s: SchemaSnapshot, issue: IssueRow, spec: Pick<ChangeSpec, 'requestGroup' | 'requestPrivate'>) {
  const [request] = await tx.select().from(helpdeskRequests).where(eq(helpdeskRequests.issueId, issue.id));
  if (!request) {
    throw badRequest(`${readableId(s, issue)} is no help desk request`, 'Only requests filed through a help desk have a customer group.').said('customerGroups.notARequest', { id: readableId(s, issue) });
  }
  const changes: Change[] = [];
  const patch: { groupId?: string | null; private?: boolean } = {};
  if (spec.requestGroup && spec.requestGroup.groupId !== request.groupId) {
    // Held until the change commits, so the group can't be deleted from under it.
    const next = spec.requestGroup.groupId
      ? (await tx.select().from(customerGroups).where(and(eq(customerGroups.id, spec.requestGroup.groupId), eq(customerGroups.projectId, issue.projectId))).for('key share'))[0]
      : null;
    if (spec.requestGroup.groupId && !next) throw groupMissing();
    const [before] = request.groupId ? await tx.select({ name: customerGroups.name }).from(customerGroups).where(eq(customerGroups.id, request.groupId)) : [];
    changes.push({ field: GROUP_CHANGE, from: before?.name ?? null, to: next?.name ?? null });
    patch.groupId = next?.id ?? null;
  }
  if (spec.requestPrivate !== undefined && spec.requestPrivate !== request.private) {
    changes.push({ field: PRIVATE_CHANGE, from: request.private ? 'yes' : 'no', to: spec.requestPrivate ? 'yes' : 'no' });
    patch.private = spec.requestPrivate;
  }
  return { request, changes, patch };
}

/**
 * Write it, in the change's transaction. A request that changes group keeps the time its clocks
 * used: the stretch counting now closes in its old group's hours, and what's left counts in the
 * new one's, as `applyChanges` then brings its clocks up to date.
 */
export async function writeGrouping(tx: Db, app: AppServices, s: SchemaSnapshot, issue: IssueRow, g: Awaited<ReturnType<typeof requestGrouping>>): Promise<void> {
  if (!Object.keys(g.patch).length) return;
  if (g.patch.groupId !== undefined) {
    const project = s.projects.get(issue.projectId);
    if (project) await restartStretches(tx, project, issue.id, g.request.groupId, new Date());
  }
  await tx.update(helpdeskRequests).set(g.patch).where(eq(helpdeskRequests.issueId, issue.id));
}

// ---------------------------------------------------------------------------
// Dedicated agents
// ---------------------------------------------------------------------------

/**
 * Whether anyone but the help desk's agent ever set or cleared a request's assignee: a person, a
 * rule, an agent acting for someone. Their choice stands, and the desk never assigns it again.
 */
async function assignedBySomeoneElse(db: Db, issueId: string, botId: string, field: string): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT 1 FROM activities a
    WHERE a.issue_id = ${issueId} AND a.type = 'issue.updated' AND a.actor_id IS DISTINCT FROM ${botId}
      AND a.payload->'changes' @> ${JSON.stringify([{ field }])}::jsonb
    LIMIT 1`);
  return ((res as unknown as { rows: unknown[] }).rows ?? []).length > 0;
}

/**
 * The group's agents in the order the desk tries them: of those it may give a request now (a person
 * of the project who may change its issues, not away all day today), whoever has the fewest open
 * requests at the desk, and between equals the one the group names first.
 */
export async function agentOrder(db: Db, s: SchemaSnapshot, project: ProjectRow, groupId: string, fieldId: string, timeZone: string): Promise<string[]> {
  const agents = await db.select().from(customerGroupAgents).where(eq(customerGroupAgents.groupId, groupId)).orderBy(asc(customerGroupAgents.position));
  if (!agents.length) return [];
  const ids = agents.map((a) => a.userId);
  const grants = await projectGrantsOf(db, project.id, ids);
  const today = localDate(Date.now(), timeZone);
  const away = new Set(
    (await db.select({ userId: absences.userId }).from(absences).where(and(inArray(absences.userId, ids), lte(absences.startDate, today), gte(absences.endDate, today), isNull(absences.half)))).map(
      (a) => a.userId,
    ),
  );
  const able = agents.filter((a) => {
    const u = s.users.get(a.userId);
    return u && assignable(u, grants.get(u.id)) && !away.has(u.id);
  });
  if (!able.length) return [];
  const open = await db
    .select({ userId: issueFieldValues.userId, n: sql<number>`count(*)::int` })
    .from(issueFieldValues)
    .innerJoin(helpdeskRequests, eq(helpdeskRequests.issueId, issueFieldValues.issueId))
    .innerJoin(issues, eq(issues.id, issueFieldValues.issueId))
    .where(
      and(
        eq(helpdeskRequests.projectId, project.id),
        isNull(issues.resolvedAt),
        eq(issueFieldValues.fieldId, fieldId),
        inArray(
          issueFieldValues.userId,
          able.map((a) => a.userId),
        ),
      ),
    )
    .groupBy(issueFieldValues.userId);
  const count = (id: string) => Number(open.find((o) => o.userId === id)?.n ?? 0);
  return [...able].sort((a, b) => count(a.userId) - count(b.userId) || a.position - b.position).map((a) => a.userId);
}

/**
 * Give a request to one of its group's dedicated agents, as the help desk's agent (`bot`), in the
 * caller's transaction and the request's history. Only a request nobody is assigned to, that
 * nobody else ever assigned; when none of the agents can take it (a guard refuses, nobody may), it
 * stays unassigned, as a request without a group does. Says the activities, to publish after commit.
 */
export async function assignToGroupAgent(tx: Db, bot: Ctx, issue: IssueRow, group: GroupRow): Promise<ActivityRow[]> {
  const s = await bot.app.schema.get(tx);
  const project = s.projects.get(issue.projectId);
  const field = assigneeFieldOf(s);
  if (!project || !field || !(s.projectFields.get(project.id) ?? []).some((pf) => pf.fieldId === field.id)) return [];
  const [taken] = await tx.select({ userId: issueFieldValues.userId }).from(issueFieldValues).where(and(eq(issueFieldValues.issueId, issue.id), eq(issueFieldValues.fieldId, field.id)));
  if (taken || (await assignedBySomeoneElse(tx, issue.id, bot.actor.user.id, field.name))) return [];
  // One at a time per group, so two requests filed together each see the other's agent.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`a4a:customer-group:${group.id}`}))`);
  const zone = (group.businessHours as BusinessHours | null)?.timeZone ?? projectSettings(project).helpdesk.businessHours?.timeZone ?? serverTimeZone();
  // The desk acts on its own here, not for its requester: automation, as the help desk's agent (rule 6).
  const desk = adminCtx(bot.app, bot.actor.user, 'automation');
  desk.actor.projectIds = [project.id];
  for (const userId of await agentOrder(tx, s, project, group.id, field.id, zone)) {
    try {
      const res = await tx.transaction(async (sp) =>
        applyChanges(sp as unknown as Db, desk, issue, { fields: [{ field, mode: 'set', values: [{ userId }] }], data: { customerGroup: group.name } }),
      );
      return res.activities;
    } catch (e) {
      // A guard refused, or they lost the project a moment ago: the next one.
      if (!(e instanceof AppError) || e.status >= 500) throw e;
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// D45's organizations, made groups
// ---------------------------------------------------------------------------

/**
 * Once, at start, before anything serves (app-services.ts, under the start's lock): each email domain
 * a desk named as an organization (D45) becomes a group of its own, named for it, whose members read
 * each other's requests as they did; the desk's requests from that domain are filed under it. The
 * desk's settings lose the list in the same transaction, so this runs once. Says how many groups it made.
 */
export async function migrateOrganizations(db: Db): Promise<number> {
  const res = await db.execute(sql`SELECT id, settings->'helpdesk'->'organizations' AS orgs FROM projects WHERE jsonb_typeof(settings->'helpdesk'->'organizations') = 'array'`);
  const rows = (res as unknown as { rows: { id: string; orgs: unknown }[] }).rows;
  let made = 0;
  for (const p of rows) {
    const orgs = [...new Set((Array.isArray(p.orgs) ? p.orgs : []).map((d) => String(d).trim().toLowerCase()).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)))];
    await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      for (const domain of orgs) {
        const [taken] = await tx.select().from(customerGroupDomains).where(and(eq(customerGroupDomains.projectId, p.id), eq(customerGroupDomains.domain, domain)));
        if (taken) continue;
        const [named] = await tx.select().from(customerGroups).where(and(eq(customerGroups.projectId, p.id), sql`lower(${customerGroups.name}) = ${domain}`));
        const id = named?.id ?? newId();
        if (!named) {
          await tx.insert(customerGroups).values({ id, projectId: p.id, name: domain, sharing: 'read' });
          made++;
        }
        await tx.insert(customerGroupDomains).values({ projectId: p.id, domain, groupId: id });
        await tx.execute(sql`
          UPDATE helpdesk_requests r SET group_id = ${id}
          FROM requesters q
          WHERE q.id = r.requester_id AND r.project_id = ${p.id} AND r.group_id IS NULL AND lower(split_part(q.email, '@', 2)) = ${domain}`);
      }
      await tx.execute(sql`UPDATE projects SET settings = settings #- '{helpdesk,organizations}' WHERE id = ${p.id}`);
    });
  }
  return made;
}
/**
 * The group's members, as addresses to copy (D56's revisit): those added by hand, and the
 * requesters its domains name, less the requester themself. A group's members hear of its
 * requests, as the request's CCs (D57).
 */
export async function groupMemberEmails(db: Db, group: GroupRow, excludeEmail: string): Promise<{ email: string; name: string }[]> {
  const hand = await db.select({ email: requesters.email, name: requesters.name }).from(customerGroupMembers).innerJoin(requesters, eq(requesters.id, customerGroupMembers.requesterId)).where(eq(customerGroupMembers.groupId, group.id));
  const domains = await db.select({ domain: customerGroupDomains.domain }).from(customerGroupDomains).where(eq(customerGroupDomains.groupId, group.id));
  const list = new Map<string, string>();
  for (const m of hand) if (m.email.toLowerCase() !== excludeEmail.toLowerCase()) list.set(m.email.toLowerCase(), m.name);
  if (domains.length) {
    const domainSet = new Set(domains.map((d) => d.domain.toLowerCase()));
    const all = await db.select({ email: requesters.email, name: requesters.name }).from(requesters);
    for (const r of all) {
      const domain = r.email.slice(r.email.indexOf('@') + 1).toLowerCase();
      if (!domainSet.has(domain)) continue;
      if (r.email.toLowerCase() !== excludeEmail.toLowerCase() && !list.has(r.email.toLowerCase())) list.set(r.email.toLowerCase(), r.name);
    }
  }
  return [...list].map(([email, name]) => ({ email, name }));
}
/**
 * The customers a4a knows, across the desks the caller can read (D56's revisit): each name once,
 * with its domains, so a desk's manager naming a new group picks one the other desks already serve.
 */
export async function customerDirectory(ctx: Ctx): Promise<{ name: string; domains: string[] }[]> {
  const view = await projectAccess(ctx);
  const s = await ctx.app.schema.get();
  const readable = [...s.projects.values()].filter((p) => view.canRead(p.id)).map((p) => p.id);
  if (!readable.length) return [];
  const rows = await ctx.db.select({ name: customerGroups.name, domain: customerGroupDomains.domain }).from(customerGroups).leftJoin(customerGroupDomains, eq(customerGroupDomains.groupId, customerGroups.id)).where(inArray(customerGroups.projectId, readable));
  const byName = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = byName.get(r.name.toLowerCase()) ?? new Set<string>();
    byName.set(r.name.toLowerCase(), set);
    if (r.domain) set.add(r.domain.toLowerCase());
  }
  return [...byName.entries()].map(([name, set]) => ({ name, domains: [...set].sort() })).sort((a, b) => a.name.localeCompare(b.name));
}
