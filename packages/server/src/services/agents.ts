/**
 * Agents acting as themselves (docs/architecture.md, D34).
 *
 * - An agent's account is a bot an administrator added. a4a's own agents (triage, workflow, the
 *   help desk) act for a4a itself: they take no tokens and no work.
 * - Its tokens are its administrators' to issue, list and revoke. With one, an agent over MCP or the
 *   API acts as itself: its changes are its own, under its name, and "me" is the agent.
 * - What an agent changed on its own, a person who may change the issue can undo from its history,
 *   unless what it changed has changed since. The undo goes through the write path as that person,
 *   says which change it undoes (data.undoes), and happens once.
 * - A person's own edit in a view (a command on the list's chosen issues, a drag, a typed cell) is
 *   undone the same way, by that person alone, for 30 days; several made as one undo as one group.
 */
import { isOwnAgent, type AgentAccount, type ApiToken, type Scope, type TrackerEvent, type UndoResult, type UndoState } from '@a4a/shared';
import { and, asc, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { requireScope, scopesForRole, type Ctx } from '../context';
import type { Db } from '../db/client';
import { activities, agentChanges, apiTokens, issueLinks, issueTags, issues, tags } from '../db/schema';
import { publishActivities, toEventDto, type ActivityPayload, type ActivityRow } from '../events/activity';
import { listIn } from '../i18n';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors';
import type { ListSaid, ProblemSaid } from '@a4a/shared/i18n';
import { canUserReadProject, eventFor, eventSeen, projectAccess, requireProject, seenIssueIds } from './access';
import { actsAsAgent, textHash, type AgentUndo, type LinkUndo } from './agent-changes';
import { issueTokenFor, keysFor, tokenDto, tokenScopes } from './auth';
import { issueRef, issueRefsById, readableId, stateNames, type IssueRow } from './issue-refs';
import { applyChanges, fieldValuesOf, type ChangeSpec, type FieldChangeSpec, type LinkSpec } from './issues';
import type { SchemaSnapshot, UserRow } from './schema-cache';
import { userDto } from './users';
import { presentValues, sameValues, type ResolvedValue } from './values';

// ---------------------------------------------------------------------------
// Agents and their tokens
// ---------------------------------------------------------------------------

/** An agent an administrator added, by id or login. A person, or one of a4a's own, is refused with why. */
function agentOf(s: SchemaSnapshot, idOrLogin: string): UserRow {
  const u = s.users.get(idOrLogin) ?? s.usersByLogin.get(idOrLogin.trim().toLowerCase());
  if (!u) throw notFound(`User ${idOrLogin}`).said('notFound.user', { id: idOrLogin });
  if (!u.isBot) throw badRequest(`${u.name} is a person, not an agent`, 'A person makes their own tokens while signed in, under Agents and tokens.').said('agents.isAPerson', { name: u.name });
  if (isOwnAgent(u)) {
    throw badRequest(`${u.login} is a4a's own agent`, 'It acts for a4a itself and takes no tokens. Add an agent of your own for a tool to act as.').said('agents.isA4asOwn', { login: u.login });
  }
  // An app's agent acts for its app alone (D48), and takes no tokens.
  if ([...s.apps.values()].some((a) => a.agentId === u.id)) {
    throw badRequest(`${u.login} is an app's agent`, 'It acts for its app alone, and takes no tokens. Add an agent of your own for a tool to act as.').said('agents.isAnAppsAgent', { login: u.login });
  }
  return u;
}

/** The agents administrators added, each with its tokens that aren't revoked. */
/** A role in an English sentence, with its article: the API's words (D49); a page says it from its catalog. */
const ROLE_WORDS: Record<string, string> = { admin: 'an administrator', member: 'a member', viewer: 'a viewer', guest: 'a guest' };

export async function listAgents(ctx: Ctx): Promise<AgentAccount[]> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const appAgents = new Set([...s.apps.values()].map((a) => a.agentId));
  const agents = [...s.users.values()].filter((u) => u.isBot && !isOwnAgent(u) && !appAgents.has(u.id)).sort((a, b) => a.login.localeCompare(b.login));
  if (!agents.length) return [];
  const rows = await ctx.db
    .select()
    .from(apiTokens)
    .where(and(inArray(apiTokens.userId, agents.map((a) => a.id)), isNull(apiTokens.revokedAt)));
  const keyOf = await keysFor(ctx);
  return agents.map((a) => ({
    agent: userDto(a),
    tokens: rows
      .filter((t) => t.userId === a.id)
      .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())
      .map((t) => tokenDto(t, keyOf)),
  }));
}

/**
 * Issue a token to an agent, so a tool acts as the agent rather than for a person. Like any token it
 * may do no more than its agent's role, and no more than the token that asks, if a token asks; limited
 * to projects, each must be one the agent can see, or the token would reach nothing there.
 */
export async function issueAgentToken(
  ctx: Ctx,
  idOrLogin: string,
  input: { name: string; scopes: Scope[]; expiresInDays?: number | null; projects?: string[] | null },
): Promise<ApiToken & { token: string }> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const agent = agentOf(s, idOrLogin);
  if (agent.banned) throw badRequest(`${agent.login} is banned`, 'Lift the ban under Administration first; its tokens work again then.').said('agents.banned', { login: agent.login });
  const scopes = tokenScopes(ctx, input.scopes);
  const beyond = scopes.filter((sc) => !scopesForRole(agent.role).includes(sc));
  if (beyond.length) {
    throw badRequest(
      `${agent.login} is ${ROLE_WORDS[agent.role] ?? agent.role}, so a token for it can't have the ${listIn('en', beyond, 'or')} scope`,
      `Leave out ${listIn('en', beyond)}, or change its role under Administration first.`,
    ).said('agents.scopeBeyondRoleAs', { login: agent.login, role: agent.role, scopes: listIn(ctx.locale, beyond, 'or'), scopesAnd: listIn(ctx.locale, beyond) });
  }
  let projectIds: string[] | null = null;
  if (input.projects) {
    if (scopes.includes('admin')) {
      throw badRequest('A token limited to projects can’t have the admin scope', 'Administration reaches every project: leave out the admin scope, or the projects.').said('agents.adminScopeWithProjects');
    }
    const ids: string[] = [];
    for (const key of input.projects) {
      const project = await requireProject(ctx, key);
      if (!(await canUserReadProject(ctx.db, agent.id, project.id))) {
        throw badRequest(`${agent.login} can't see ${project.key}`, `Add ${agent.login} to ${project.key}'s people first, or leave ${project.key} out.`).said('agents.cantSeeProject', { login: agent.login, key: project.key });
      }
      ids.push(project.id);
    }
    projectIds = [...new Set(ids)];
  }
  const { token, ...row } = await issueTokenFor(ctx.db, agent.id, { name: input.name, scopes, expiresInDays: input.expiresInDays, projectIds });
  return { ...tokenDto(row, await keysFor(ctx)), token };
}

export async function revokeAgentToken(ctx: Ctx, idOrLogin: string, tokenId: string): Promise<void> {
  requireScope(ctx, 'admin');
  const agent = agentOf(await ctx.app.schema.get(), idOrLogin);
  const res = await ctx.db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, agent.id), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });
  if (!res.length) throw notFound('Token').said('notFound.tokenUnnamed');
}

// ---------------------------------------------------------------------------
// Where a kept change stands, and undoing it (D34, and its revisit for a person's edit in a view)
// ---------------------------------------------------------------------------

type ChangeRow = typeof agentChanges.$inferSelect;

/** How a person or an agent is named in a sentence: a person by their name, an agent by its login. */
function nameOf(s: SchemaSnapshot, userId: string | null | undefined): string {
  const u = userId ? s.users.get(userId) : undefined;
  return u ? (u.isBot ? u.login : u.name) : 'someone';
}

/**
 * Whether the reader may see a kept change's undo, and ask for it: an agent's is anyone's who may
 * change the issue (D34); a person's edit in a view is theirs alone. To anyone else, a view edit is a
 * change like any: there's nothing to undo there.
 */
const undoableBy = (rec: ChangeRow, userId: string): boolean => rec.kind !== 'view' || rec.actorId === userId;

/** What the issue is like now, read once for every change of it that's looked at. */
interface Now {
  issue: IssueRow;
  values: Map<string, ResolvedValue[]>;
  tags: Set<string>;
  /** Later changes to the issue, newest first, for who changed a field since. */
  later: ActivityRow[];
}

async function issueNow(db: Db, issueId: string, after: number): Promise<Now | null> {
  const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
  if (!issue) return null;
  const tagRows = await db
    .select({ name: tags.name })
    .from(issueTags)
    .innerJoin(tags, eq(tags.id, issueTags.tagId))
    .where(eq(issueTags.issueId, issueId));
  const later = await db
    .select()
    .from(activities)
    .where(and(eq(activities.issueId, issueId), eq(activities.type, 'issue.updated'), gt(activities.id, after)))
    .orderBy(desc(activities.id));
  return { issue, values: await fieldValuesOf(db, issueId), tags: new Set(tagRows.map((t) => t.name.toLowerCase())), later };
}

/** Who changed a field of the issue after the agent did, the latest of them; undefined when nobody did. */
function changedBy(s: SchemaSnapshot, now: Now, field: string, since: number): string | undefined {
  const row = now.later.find((a) => a.id > since && ((a.payload as ActivityPayload).changes ?? []).some((c) => c.field === field));
  return row ? nameOf(s, row.actorId) : undefined;
}

async function linkExists(db: Db, s: SchemaSnapshot, undo: LinkUndo): Promise<boolean> {
  const type = s.linkPhrases.find((p) => p.type.id === undo.typeId)?.type;
  const forward = and(eq(issueLinks.sourceId, undo.sourceId), eq(issueLinks.targetId, undo.targetId));
  const either = type && !type.directed ? or(forward, and(eq(issueLinks.sourceId, undo.targetId), eq(issueLinks.targetId, undo.sourceId))) : forward;
  const rows = await db.select({ id: issueLinks.id }).from(issueLinks).where(and(eq(issueLinks.typeId, undo.typeId), either));
  return rows.length > 0;
}

/**
 * What stops an agent's change being undone, in words, or nothing: what it changed has changed since
 * (undoing it would overwrite someone), or what it would put back is gone.
 */
/** Why a change can't be undone: in the API's English, and as a page says it (D49). */
type Stop = { words: string; said: ProblemSaid };
const stop = (words: string, key: string, values?: Record<string, string | number | ListSaid | ProblemSaid>): Stop => ({
  words,
  said: values ? { key, values: values as ProblemSaid['values'] } : { key },
});
const ISSUE_GONE = stop('the issue is gone', 'agents.stop.issueGone');
const ISSUE_HIDDEN = stop('one of its issues is no longer one you can see', 'agents.stop.issueHidden');
/** A reason on one issue of a group, said with the issue it is on. */
const onIssue = (id: string, x: Stop): Stop => stop(`${id}: ${x.words}`, 'agents.stop.onIssue', { id, reason: x.said });

async function whatStops(db: Db, s: SchemaSnapshot, rec: ChangeRow, now: Now): Promise<Stop[]> {
  const undo = rec.undo as AgentUndo;
  const key = s.projects.get(now.issue.projectId)?.key ?? 'its project';
  const out: Stop[] = [];
  if (undo.kind === 'link') {
    const exists = await linkExists(db, s, undo);
    const type = s.linkPhrases.find((p) => p.type.id === undo.typeId)?.type;
    if (!type) out.push(stop('that kind of link is no longer in a4a', 'agents.stop.linkTypeGone'));
    else if (undo.created && !exists) out.push(stop('the link was taken away since', 'agents.stop.linkTakenAway'));
    else if (!undo.created && exists) out.push(stop('the link is there again', 'agents.stop.linkBack'));
    else if (!undo.created) {
      const ends = await db.select({ id: issues.id }).from(issues).where(inArray(issues.id, [undo.sourceId, undo.targetId]));
      if (ends.length < 2) out.push(stop('the issue at its other end is gone', 'agents.stop.otherEndGone'));
    }
    return out;
  }
  const attached = new Set((s.projectFields.get(now.issue.projectId) ?? []).map((pf) => pf.fieldId));
  for (const f of undo.fields) {
    const field = s.fields.get(f.fieldId);
    if (!field || !attached.has(f.fieldId)) {
      out.push(stop(`${f.name} is no longer a field of ${key}`, 'agents.stop.fieldGone', { field: f.name, project: key }));
      continue;
    }
    const current = now.values.get(f.fieldId) ?? [];
    if (!sameValues(current, f.after)) {
      const by = changedBy(s, now, field.name, rec.activityId);
      const value = presentValues(s, field, current);
      out.push(
        stop(`${field.name} is ${value ?? 'empty'} now${by ? `: ${by} changed it since` : ''}`, 'agents.stop.fieldChanged', {
          field: field.name,
          hasValue: value ? 'yes' : 'no',
          value: value ?? '',
          hasBy: by ? 'yes' : 'no',
          by: by ?? '',
        }),
      );
      continue;
    }
    for (const v of f.before) {
      if (v.valueId && !s.values.get(v.valueId)) out.push(stop(`the ${field.name} it had is no longer one of its values`, 'agents.stop.valueGone', { field: field.name }));
      const user = v.userId ? s.users.get(v.userId) : undefined;
      if (v.userId && (!user || user.banned)) out.push(stop(`the ${field.name} it had can no longer be given`, 'agents.stop.userGone', { field: field.name }));
    }
  }
  if (undo.summary && now.issue.summary !== undo.summary.after) {
    const by = changedBy(s, now, 'Summary', rec.activityId);
    out.push(stop(`the summary changed since${by ? `, by ${by}` : ''}`, 'agents.stop.summaryChanged', { hasBy: by ? 'yes' : 'no', by: by ?? '' }));
  }
  if (undo.description && textHash(now.issue.description) !== undo.description.afterHash) {
    const by = changedBy(s, now, 'Description', rec.activityId);
    out.push(stop(`the description changed since${by ? `, by ${by}` : ''}`, 'agents.stop.descriptionChanged', { hasBy: by ? 'yes' : 'no', by: by ?? '' }));
  }
  if (undo.tags) {
    const off = undo.tags.added.filter((t) => !now.tags.has(t.toLowerCase()));
    const on = undo.tags.removed.filter((t) => now.tags.has(t.toLowerCase()));
    if (off.length) out.push(stop(`${off.length === 1 ? 'the tag' : 'the tags'} ${off.join(', ')} ${off.length === 1 ? 'was' : 'were'} taken off since`, 'agents.stop.tagsOff', { n: off.length, tags: off }));
    if (on.length) out.push(stop(`${on.length === 1 ? 'the tag' : 'the tags'} ${on.join(', ')} ${on.length === 1 ? 'is' : 'are'} on again`, 'agents.stop.tagsOn', { n: on.length, tags: on }));
  }
  return out;
}

/**
 * What stops a change, or its whole group, being undone: each row's reasons, a group's said with the
 * issue each is on. An issue the reader no longer sees is said as one, unnamed.
 */
async function groupStops(db: Db, s: SchemaSnapshot, recs: ChangeRow[], seen: Set<string> | null): Promise<Stop[]> {
  const earliest = new Map<string, number>();
  for (const rec of recs) earliest.set(rec.issueId, Math.min(earliest.get(rec.issueId) ?? rec.activityId, rec.activityId));
  const nows = new Map<string, Now | null>();
  const out: Stop[] = [];
  const grouped = recs.length > 1 || recs.some((r) => r.groupId !== null);
  let hidden = false;
  for (const rec of recs) {
    if (seen && !seen.has(rec.issueId)) {
      hidden = true;
      continue;
    }
    if (!nows.has(rec.issueId)) nows.set(rec.issueId, await issueNow(db, rec.issueId, earliest.get(rec.issueId)!));
    const now = nows.get(rec.issueId)!;
    const stops = now ? await whatStops(db, s, rec, now) : [ISSUE_GONE];
    out.push(...(grouped && now ? stops.map((x) => onIssue(readableId(s, now.issue), x)) : stops));
  }
  if (hidden) out.push(ISSUE_HIDDEN);
  return out;
}

const sentence = (parts: string[]) => {
  const text = parts.join('; ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** Where a kept change stands, in the API's English (`note`) and as a page says it (`noteWords`, D49). */
type UndoStanding = NonNullable<TrackerEvent['undo']> & { state: UndoState; note: string; noteWords: ProblemSaid[] };

/** The rows of a kept change's group, in id order: those of the same kind by the same actor. */
function sameGroup(rec: ChangeRow) {
  return and(eq(agentChanges.groupId, rec.groupId!), eq(agentChanges.kind, rec.kind), rec.actorId ? eq(agentChanges.actorId, rec.actorId) : isNull(agentChanges.actorId));
}

/**
 * In an issue's history, where each kept change stands: undone (and by whom), or changed since (and
 * what), or undoable; who may undo it (`by`); and for one of a group, the group and its other issues.
 * A person's edit in a view says so to its author alone (D34's revisit). Other changes carry nothing.
 */
export async function undoStandings(ctx: Ctx, s: SchemaSnapshot, events: TrackerEvent[]): Promise<Map<number, UndoStanding>> {
  const db = ctx.db;
  const out = new Map<number, UndoStanding>();
  const ids = events.map((e) => e.id);
  if (!ids.length) return out;
  const me = ctx.actor.user.id;
  const found = await db
    .select()
    .from(agentChanges)
    .where(or(inArray(agentChanges.activityId, ids), inArray(agentChanges.pairActivityId, ids)));
  const recs = found.filter((rec) => undoableBy(rec, me));
  // A group's other rows, read once for each group.
  const groupIds = [...new Set(recs.flatMap((r) => (r.groupId ? [r.groupId] : [])))];
  const groupRows = groupIds.length ? await db.select().from(agentChanges).where(inArray(agentChanges.groupId, groupIds)).orderBy(asc(agentChanges.id)) : [];
  const membersOf = (rec: ChangeRow) => (rec.groupId ? groupRows.filter((g) => g.groupId === rec.groupId && g.kind === rec.kind && g.actorId === rec.actorId) : [rec]);
  const seen = await seenIssueIds(ctx, [...new Set([...recs, ...groupRows].map((r) => r.issueId))]);
  const refs = await issueRefsById(db, s, [...seen]);
  const standingOf = new Map<string, Omit<UndoStanding, 'others'>>();
  for (const rec of recs) {
    const members = membersOf(rec);
    const key = rec.groupId ?? rec.id;
    if (!standingOf.has(key)) {
      const undone = members.find((m) => m.undoneActivityId !== null);
      let standing: Omit<UndoStanding, 'others'>;
      if (undone) {
        const known = undone.undoneById ? s.users.has(undone.undoneById) : false;
        const name = nameOf(s, undone.undoneById);
        standing = { state: 'undone', note: `${name} undid it`, noteWords: [{ key: 'agents.undoneBy', values: { who: known ? 'named' : 'someone', name: known ? name : '' } }] };
      } else {
        const stops = await groupStops(db, s, members, rec.groupId ? seen : null);
        // Each reason as a page says it, a sentence of its own (D49); the note joins them as the API does.
        standing = stops.length ? { state: 'changed_since', note: sentence(stops.map((x) => x.words)), noteWords: stops.map((x) => x.said) } : { state: 'possible', note: '', noteWords: [] };
      }
      standingOf.set(key, { ...standing, by: rec.kind === 'view' ? 'author' : 'anyone', ...(rec.groupId ? { group: rec.groupId } : {}) });
    }
    const others = rec.groupId
      ? [...new Set(members.filter((m) => m.issueId !== rec.issueId && seen.has(m.issueId)).map((m) => m.issueId))]
          .flatMap((id) => (refs.get(id) ? [refs.get(id)!.id] : []))
          .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      : [];
    const standing: UndoStanding = { ...standingOf.get(key)!, ...(rec.groupId ? { others } : {}) };
    out.set(rec.activityId, standing);
    if (rec.pairActivityId !== null) out.set(rec.pairActivityId, standing);
  }
  return out;
}

/** What undoing a change asks of the write path: the values, text, tags or link the agent changed, put back. */
async function inverse(db: Db, s: SchemaSnapshot, rec: ChangeRow, issue: IssueRow): Promise<ChangeSpec> {
  const undo = rec.undo as AgentUndo;
  if (undo.kind === 'link') {
    const self = issue.id;
    const outward = undo.sourceId === self;
    const otherId = outward ? undo.targetId : undo.sourceId;
    const phrase =
      s.linkPhrases.find((p) => p.type.id === undo.typeId && p.direction === (outward ? 'outward' : 'inward')) ??
      s.linkPhrases.find((p) => p.type.id === undo.typeId && p.direction === 'both');
    const [target] = await db.select().from(issues).where(eq(issues.id, otherId));
    if (!phrase || !target) throw new AppError(409, 'changed_since', 'Nothing was undone: the link can no longer be put back').said('agents.undoLinkGone');
    const link: LinkSpec = { phrase, target, remove: undo.created };
    return { links: [link] };
  }
  const fields: FieldChangeSpec[] = undo.fields.map((f) => ({ field: s.fields.get(f.fieldId)!, mode: 'set', values: f.before.map(stored) }));
  return {
    fields,
    ...(undo.summary ? { summary: undo.summary.before } : {}),
    ...(undo.description ? { description: undo.description.before } : {}),
    ...(undo.tags ? { addTags: undo.tags.removed, removeTags: undo.tags.added } : {}),
  };
}

/** A value as the write path stores it, leaving out what JSON kept as null. */
function stored(v: ResolvedValue): ResolvedValue {
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== undefined)) as ResolvedValue;
}

const NOT_UNDOABLE = () =>
  new AppError(400, 'not_undoable', 'Only a change an agent made on its own, or one you made in a view in the last 30 days, can be undone', 'Change it back on the issue, as any change.').said(
    'agents.onlyAgentsOwnChange',
  );

/**
 * Undo a kept change, as the person asking (D34): an agent's change on its own, which anyone who may
 * change the issue undoes (and, for a link, the issue at its other end), or a person's edit in a view,
 * which only they undo; to anyone else that's a change like any, with nothing to undo there.
 *
 * It undoes all of the change, and all of its group, or none of it. The group's rows are locked first,
 * in id order, then their issues, in id order, so two undos of the group happen once and an edit to
 * one of its issues meanwhile is seen. If anything it changed has changed since, it says what, on
 * which issue, and changes nothing. An agent can't undo: a person decides.
 */
export async function undoAgentChange(ctx: Ctx, eventId: number): Promise<UndoResult> {
  requireScope(ctx, 'write');
  if (actsAsAgent(ctx)) {
    throw forbidden('An agent can’t undo a change', 'Undoing is for a person who may change the issue, from its history.').said('agents.agentCantUndo');
  }
  const s = await ctx.app.schema.get();
  const [row] = await ctx.db.select().from(activities).where(eq(activities.id, eventId));
  // An event the caller can't see is answered exactly as one that doesn't exist: a change only to
  // private fields kept from them too (D50).
  const view = await projectAccess(ctx);
  if (!row || !(await eventSeen(view, ctx.db, s, toEventDto(s, row))) || !eventFor(view, s, toEventDto(s, row))) throw notFound(`Event ${eventId}`).said('notFound.event', { id: eventId });
  const [found] = await ctx.db
    .select()
    .from(agentChanges)
    .where(or(eq(agentChanges.activityId, eventId), eq(agentChanges.pairActivityId, eventId)));
  if (!found || !undoableBy(found, ctx.actor.user.id)) throw NOT_UNDOABLE();

  const result = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    // One undo at a time: the change's rows first (its group's, in id order), then their issues in id
    // order, as the write path locks them.
    const recs = await tx
      .select()
      .from(agentChanges)
      .where(found.groupId ? sameGroup(found) : eq(agentChanges.id, found.id))
      .orderBy(asc(agentChanges.id))
      .for('update');
    if (!recs.length) throw notFound(`Event ${eventId}`).said('notFound.event', { id: eventId });
    const done = recs.find((r) => r.undoneActivityId !== null);
    if (done) {
      throw new AppError(409, 'already_undone', `${nameOf(s, done.undoneById)} undid it already`, 'It is in the issue’s history, as the change after it.').said('agents.undoneAlreadyBy', {
        name: nameOf(s, done.undoneById),
      });
    }
    const issueIds = [...new Set(recs.map((r) => r.issueId))].sort();
    const locked = await tx.select().from(issues).where(inArray(issues.id, issueIds)).orderBy(asc(issues.id)).for('update');
    const byId = new Map(locked.map((i) => [i.id, i]));
    if (found.groupId === null && !byId.has(found.issueId)) throw notFound(`Event ${eventId}`).said('notFound.event', { id: eventId });
    // A group's issue the person no longer sees stops it, said without naming it.
    const seen = found.groupId ? await seenIssueIds(ctx, issueIds, tx) : null;
    const stops = await groupStops(tx, s, recs, seen);
    if (stops.length) {
      const words = stops.map((x) => x.words);
      throw new AppError(409, 'changed_since', `Nothing was undone: ${words.join('; ')}`, 'Change it on the issue instead, if it should change.', { changedSince: words }).said('agents.nothingUndoneBecause', {
        reasons: stops.map((x) => x.said),
      });
    }
    const applied: { rec: ChangeRow; result: Awaited<ReturnType<typeof applyChanges>> }[] = [];
    for (const rec of recs) {
      const issue = byId.get(rec.issueId)!;
      const spec = await inverse(tx, s, rec, issue);
      const res = await applyChanges(tx, ctx, issue, { ...spec, data: { undoes: rec.activityId } });
      if (!res.activities.length) {
        throw rec.kind === 'view'
          ? new AppError(409, 'changed_since', 'Nothing was undone: it is as it was before you changed it').said('agents.alreadyAsBeforeYours')
          : new AppError(409, 'changed_since', 'Nothing was undone: it is as it was before the agent changed it').said('agents.alreadyAsBefore');
      }
      byId.set(issue.id, res.issue);
      applied.push({ rec, result: res });
    }
    const at = new Date();
    let marked = 0;
    for (const { rec, result: res } of applied) {
      const set = await tx
        .update(agentChanges)
        .set({ undoneActivityId: res.activities[0]!.id, undoneById: ctx.actor.user.id, undoneAt: at })
        .where(and(eq(agentChanges.id, rec.id), isNull(agentChanges.undoneActivityId)))
        .returning({ id: agentChanges.id });
      marked += set.length;
    }
    if (marked !== applied.length) throw new AppError(409, 'already_undone', 'Someone undid it already').said('agents.undoneAlready');
    return { applied, issue: byId.get(found.issueId) ?? applied[0]!.result.issue, group: found.groupId };
  });

  const all = result.applied.flatMap((a) => a.result.activities);
  await publishActivities(ctx.app, all);
  const touched = [...new Set(result.applied.map((a) => a.result.issue.id))];
  const states = await stateNames(ctx.db, s, touched);
  const issueRefs = new Map(result.applied.map((a) => [a.result.issue.id, issueRef(s, a.result.issue, states.get(a.result.issue.id) ?? null)]));
  return {
    undoes: found.activityId,
    issue: issueRef(s, result.issue, states.get(result.issue.id) ?? null),
    changes: result.applied.flatMap((a) => a.result.changes),
    events: all.map((a) => toEventDto(s, a)),
    ...(result.group ? { group: result.group, issues: [...issueRefs.values()] } : {}),
  };
}
