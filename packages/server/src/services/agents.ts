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
 */
import { isOwnAgent, type AgentAccount, type ApiToken, type Scope, type TrackerEvent, type UndoResult, type UndoState } from '@a4a/shared';
import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { requireScope, scopesForRole, type Ctx } from '../context';
import type { Db } from '../db/client';
import { activities, agentChanges, apiTokens, issueLinks, issueTags, issues, tags } from '../db/schema';
import { publishActivities, toEventDto, type ActivityPayload, type ActivityRow } from '../events/activity';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors';
import { canUserReadProject, eventVisible, projectAccess, requireProject } from './access';
import { actsAsAgent, textHash, type AgentUndo, type LinkUndo } from './agent-changes';
import { issueTokenFor, keysFor, tokenDto, tokenScopes } from './auth';
import { issueRef, stateNames, type IssueRow } from './issue-refs';
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
  if (!u) throw notFound(`User ${idOrLogin}`);
  if (!u.isBot) throw badRequest(`${u.name} is a person, not an agent`, 'A person makes their own tokens while signed in, under Agents and tokens.');
  if (isOwnAgent(u)) {
    throw badRequest(`${u.login} is a4a's own agent`, 'It acts for a4a itself and takes no tokens. Add an agent of your own for a tool to act as.');
  }
  return u;
}

/** The agents administrators added, each with its tokens that aren't revoked. */
export async function listAgents(ctx: Ctx): Promise<AgentAccount[]> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const agents = [...s.users.values()].filter((u) => u.isBot && !isOwnAgent(u)).sort((a, b) => a.login.localeCompare(b.login));
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
  if (agent.banned) throw badRequest(`${agent.login} is banned`, 'Lift the ban under Administration first; its tokens work again then.');
  const scopes = tokenScopes(ctx, input.scopes);
  const beyond = scopes.filter((sc) => !scopesForRole(agent.role).includes(sc));
  if (beyond.length) {
    throw badRequest(
      `${agent.login} is a ${agent.role}, so a token for it can't have the ${beyond.join(' or ')} scope`,
      `Leave out ${beyond.join(' and ')}, or change its role under Administration first.`,
    );
  }
  let projectIds: string[] | null = null;
  if (input.projects) {
    if (scopes.includes('admin')) {
      throw badRequest('A token limited to projects can’t have the admin scope', 'Administration reaches every project: leave out the admin scope, or the projects.');
    }
    const ids: string[] = [];
    for (const key of input.projects) {
      const project = await requireProject(ctx, key);
      if (!(await canUserReadProject(ctx.db, agent.id, project.id))) {
        throw badRequest(`${agent.login} can't see ${project.key}`, `Add ${agent.login} to ${project.key}'s people first, or leave ${project.key} out.`);
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
  if (!res.length) throw notFound('Token');
}

// ---------------------------------------------------------------------------
// Where an agent's change stands, and undoing it
// ---------------------------------------------------------------------------

type ChangeRow = typeof agentChanges.$inferSelect;

/** How a person or an agent is named in a sentence: a person by their name, an agent by its login. */
function nameOf(s: SchemaSnapshot, userId: string | null | undefined): string {
  const u = userId ? s.users.get(userId) : undefined;
  return u ? (u.isBot ? u.login : u.name) : 'someone';
}

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
async function whatStops(db: Db, s: SchemaSnapshot, rec: ChangeRow, now: Now): Promise<string[]> {
  const undo = rec.undo as AgentUndo;
  const key = s.projects.get(now.issue.projectId)?.key ?? 'its project';
  const out: string[] = [];
  if (undo.kind === 'link') {
    const exists = await linkExists(db, s, undo);
    const type = s.linkPhrases.find((p) => p.type.id === undo.typeId)?.type;
    if (!type) out.push('that kind of link is no longer in a4a');
    else if (undo.created && !exists) out.push('the link was taken away since');
    else if (!undo.created && exists) out.push('the link is there again');
    else if (!undo.created) {
      const ends = await db.select({ id: issues.id }).from(issues).where(inArray(issues.id, [undo.sourceId, undo.targetId]));
      if (ends.length < 2) out.push('the issue at its other end is gone');
    }
    return out;
  }
  const attached = new Set((s.projectFields.get(now.issue.projectId) ?? []).map((pf) => pf.fieldId));
  for (const f of undo.fields) {
    const field = s.fields.get(f.fieldId);
    if (!field || !attached.has(f.fieldId)) {
      out.push(`${f.name} is no longer a field of ${key}`);
      continue;
    }
    const current = now.values.get(f.fieldId) ?? [];
    if (!sameValues(current, f.after)) {
      const by = changedBy(s, now, field.name, rec.activityId);
      out.push(`${field.name} is ${presentValues(s, field, current) ?? 'empty'} now${by ? `: ${by} changed it since` : ''}`);
      continue;
    }
    for (const v of f.before) {
      if (v.valueId && !s.values.get(v.valueId)) out.push(`the ${field.name} it had is no longer one of its values`);
      const user = v.userId ? s.users.get(v.userId) : undefined;
      if (v.userId && (!user || user.banned)) out.push(`the ${field.name} it had can no longer be given`);
    }
  }
  if (undo.summary && now.issue.summary !== undo.summary.after) {
    const by = changedBy(s, now, 'Summary', rec.activityId);
    out.push(`the summary changed since${by ? `, by ${by}` : ''}`);
  }
  if (undo.description && textHash(now.issue.description) !== undo.description.afterHash) {
    const by = changedBy(s, now, 'Description', rec.activityId);
    out.push(`the description changed since${by ? `, by ${by}` : ''}`);
  }
  if (undo.tags) {
    const off = undo.tags.added.filter((t) => !now.tags.has(t.toLowerCase()));
    const on = undo.tags.removed.filter((t) => now.tags.has(t.toLowerCase()));
    if (off.length) out.push(`${off.length === 1 ? 'the tag' : 'the tags'} ${off.join(', ')} ${off.length === 1 ? 'was' : 'were'} taken off since`);
    if (on.length) out.push(`${on.length === 1 ? 'the tag' : 'the tags'} ${on.join(', ')} ${on.length === 1 ? 'is' : 'are'} on again`);
  }
  return out;
}

const sentence = (parts: string[]) => {
  const text = parts.join('; ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/**
 * In an issue's history, where each change an agent made on its own stands: undone (and by whom), or
 * changed since (and what), or undoable. Changes a person made carry nothing.
 */
export async function undoStandings(db: Db, s: SchemaSnapshot, events: TrackerEvent[]): Promise<Map<number, { state: UndoState; note: string }>> {
  const out = new Map<number, { state: UndoState; note: string }>();
  const ids = events.map((e) => e.id);
  if (!ids.length) return out;
  const recs = await db
    .select()
    .from(agentChanges)
    .where(or(inArray(agentChanges.activityId, ids), inArray(agentChanges.pairActivityId, ids)));
  // Each issue is read once, with the changes after its earliest agent's change here.
  const earliest = new Map<string, number>();
  for (const rec of recs) earliest.set(rec.issueId, Math.min(earliest.get(rec.issueId) ?? rec.activityId, rec.activityId));
  const nows = new Map<string, Now | null>();
  for (const rec of recs) {
    let standing: { state: UndoState; note: string };
    if (rec.undoneActivityId !== null) {
      standing = { state: 'undone', note: `${nameOf(s, rec.undoneById)} undid it` };
    } else {
      if (!nows.has(rec.issueId)) nows.set(rec.issueId, await issueNow(db, rec.issueId, earliest.get(rec.issueId)!));
      const now = nows.get(rec.issueId);
      const stops = now ? await whatStops(db, s, rec, now) : ['the issue is gone'];
      standing = stops.length ? { state: 'changed_since', note: sentence(stops) } : { state: 'possible', note: '' };
    }
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
    if (!phrase || !target) throw new AppError(409, 'changed_since', 'Nothing was undone: the link can no longer be put back');
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

/**
 * Undo a change an agent made on its own, as the person asking, who must be able to change the issue
 * (and, for a link, the issue at its other end). It undoes all of the change or none of it: if anything
 * it changed has changed since, it says what, and changes nothing. An agent can't undo: a person decides.
 */
export async function undoAgentChange(ctx: Ctx, eventId: number): Promise<UndoResult> {
  requireScope(ctx, 'write');
  if (actsAsAgent(ctx)) {
    throw forbidden('An agent can’t undo a change', 'Undoing is for a person who may change the issue, from its history.');
  }
  const s = await ctx.app.schema.get();
  const [row] = await ctx.db.select().from(activities).where(eq(activities.id, eventId));
  // An event the caller can't see is answered exactly as one that doesn't exist.
  if (!row || !eventVisible(await projectAccess(ctx), s, toEventDto(s, row))) throw notFound(`Event ${eventId}`);
  const [found] = await ctx.db
    .select()
    .from(agentChanges)
    .where(or(eq(agentChanges.activityId, eventId), eq(agentChanges.pairActivityId, eventId)));
  if (!found) {
    throw new AppError(
      400,
      'not_undoable',
      'Only a change an agent made on its own can be undone',
      'Change it back on the issue, as any change. (a4a keeps what undoing needs for changes agents make from now on.)',
    );
  }

  const result = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    // One undo at a time: the change's row first, then its issue, as the write path locks it.
    const [rec] = await tx.select().from(agentChanges).where(eq(agentChanges.id, found.id)).for('update');
    if (!rec) throw notFound(`Event ${eventId}`);
    if (rec.undoneActivityId !== null) {
      throw new AppError(409, 'already_undone', `${nameOf(s, rec.undoneById)} undid it already`, 'It is in the issue’s history, as the change after it.');
    }
    const [issue] = await tx.select().from(issues).where(eq(issues.id, rec.issueId)).for('update');
    if (!issue) throw notFound(`Event ${eventId}`);
    const now = await issueNow(tx, issue.id, rec.activityId);
    const stops = now ? await whatStops(tx, s, rec, now) : ['the issue is gone'];
    if (stops.length) {
      throw new AppError(409, 'changed_since', `Nothing was undone: ${stops.join('; ')}`, 'Change it on the issue instead, if it should change.', { changedSince: stops });
    }
    const spec = await inverse(tx, s, rec, issue);
    const applied = await applyChanges(tx, ctx, issue, { ...spec, data: { undoes: rec.activityId } });
    if (!applied.activities.length) {
      throw new AppError(409, 'changed_since', 'Nothing was undone: it is as it was before the agent changed it');
    }
    const marked = await tx
      .update(agentChanges)
      .set({ undoneActivityId: applied.activities[0]!.id, undoneById: ctx.actor.user.id, undoneAt: new Date() })
      .where(and(eq(agentChanges.id, rec.id), isNull(agentChanges.undoneActivityId)))
      .returning({ id: agentChanges.id });
    if (!marked.length) throw new AppError(409, 'already_undone', 'Someone undid it already');
    return { applied, activityId: rec.activityId };
  });

  await publishActivities(ctx.app, result.applied.activities);
  const states = await stateNames(ctx.db, s, [result.applied.issue.id]);
  return {
    undoes: result.activityId,
    issue: issueRef(s, result.applied.issue, states.get(result.applied.issue.id) ?? null),
    changes: result.applied.changes,
    events: result.applied.activities.map((a) => toEventDto(s, a)),
  };
}
