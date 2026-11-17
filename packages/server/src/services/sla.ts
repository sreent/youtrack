/**
 * SLA policies and the clocks they run (D45).
 *
 * - A desk's policies are tried in order; the first whose query a request matches covers it, with
 *   a first-response target, a resolution target, or both, in the desk's working hours. A desk with
 *   no policies and D24's first-response hours has that one target, as before.
 * - Each target is a clock (`sla_clocks`): business time used before the stretch now counting, and
 *   while it counts, the instants it turns at risk and runs out. Those are wall-clock instants, fixed
 *   while it counts, so a search compares them with now and nothing has to tick to be right.
 * - The clocks follow the request through the write path (`afterRequestChange`, in the change's own
 *   transaction): paused while it waits on its requester, resumed when they answer, stopped when
 *   met, and the resolution's restarted with what's left of it when the request is reopened.
 * - What time alone brings (at risk, past the target) the worker says, as the lease holder: an
 *   `sla.warning` or `sla.breached` event, once a stretch, and the request's "SLA status" field.
 * - The status is a field of the project ("SLA status": On track, At risk, Paused, Breached, Met),
 *   kept by the help desk's agent, so boards, reports and rules read it as any field.
 */
import { SLA_STATUSES, SLA_TARGETS, type RequestSla, type SlaClock, type SlaClockState, type SlaPolicy, type SlaPolicyInput, type SlaReport, type SlaStatus, type SlaTarget } from '@a4a/shared';
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { adminCtx } from '../app-services';
import { requireScope, type AppServices, type Ctx } from '../context';
import type { Db } from '../db/client';
import { comments, helpdeskRequests, issueFieldValues, issues, projectFields, slaClocks, slaPolicies } from '../db/schema';
import { publishActivities, recordActivity, type ActivityRow } from '../events/activity';
import { addBusinessMs, businessMsBetween, calendarOf, type Calendar } from '../helpdesk/business-time';
import { badRequest, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { addDays } from '../lib/dates';
import { localDate, startOfDay, timeZoneOrThrow } from '../reports/tz';
import { condition, meets, ruleWorld } from '../workflow/match';
import { requireProject } from './access';
import { createFieldRaw } from './fields';
import { issueRefsById, stateNames } from './issue-refs';
import { applyChanges, type FieldChangeSpec } from './issues';
import { projectSettings } from './projects';
import type { ProjectRow, SchemaSnapshot } from './schema-cache';

type IssueRow = typeof issues.$inferSelect;
type PolicyRow = typeof slaPolicies.$inferSelect;
type ClockRow = typeof slaClocks.$inferSelect;
type RequestRow = typeof helpdeskRequests.$inferSelect;

/** The field the help desk's agent keeps each request's status in. */
export const SLA_STATUS_FIELD = 'SLA status';
const STATUS_TONES: Record<SlaStatus, 'good' | 'warn' | 'bad' | 'idle' | null> = { 'On track': null, 'At risk': 'warn', Paused: 'idle', Breached: 'bad', Met: 'good' };
/** D24's first-response hours, for a desk without policies: one target, no warning. */
const LEGACY = 'legacy';
/** The help desk's agent (services/helpdesk.ts), known here by its login so this module needn't import that one. */
const HELPDESK_BOT = 'helpdesk';

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

function policyDto(p: PolicyRow): SlaPolicy {
  return { id: p.id, name: p.name, query: p.query, firstResponseMinutes: p.firstResponseMinutes, resolutionMinutes: p.resolutionMinutes, warnMinutes: p.warnMinutes, position: p.position };
}

async function policiesOf(db: Db, projectId: string): Promise<PolicyRow[]> {
  return db.select().from(slaPolicies).where(eq(slaPolicies.projectId, projectId)).orderBy(asc(slaPolicies.position), asc(slaPolicies.createdAt));
}

export async function listPolicies(ctx: Ctx, key: string): Promise<SlaPolicy[]> {
  const project = await requireProject(ctx, key, 'read');
  return (await policiesOf(ctx.db, project.id)).map(policyDto);
}

/** A policy's query must read in the project's words, and it needs a target: a 400 says which. */
async function checkPolicy(ctx: Ctx, project: ProjectRow, input: SlaPolicyInput): Promise<void> {
  if (input.firstResponseMinutes == null && input.resolutionMinutes == null) {
    throw badRequest('A policy needs a target', 'Give a first-response target, a resolution target, or both.').said('sla.needsTarget');
  }
  const query = input.query?.trim() ?? '';
  if (query) {
    const s = await ctx.app.schema.get();
    const { problems } = condition(ruleWorld(s, project.id), query, { meId: null, projectId: project.id });
    if (problems.length) throw badRequest(`The policy's query doesn't read: ${problems[0]!.message}`, problems[0]!.hint ?? 'Write it as you would a search, such as Priority: Critical.').said('sla.queryDoesntRead', { problem: problems[0]!.message, hasHint: problems[0]!.hint ? 'yes' : 'no', hint: problems[0]!.hint ?? '' });
  }
}

export async function createPolicy(ctx: Ctx, key: string, input: SlaPolicyInput): Promise<SlaPolicy> {
  requireScope(ctx, 'write');
  const project = await requireProject(ctx, key, 'manage');
  await checkPolicy(ctx, project, input);
  const existing = await policiesOf(ctx.db, project.id);
  const id = newId();
  await ctx.db.insert(slaPolicies).values({
    id,
    projectId: project.id,
    name: input.name.trim(),
    query: input.query?.trim() ?? '',
    firstResponseMinutes: input.firstResponseMinutes ?? null,
    resolutionMinutes: input.resolutionMinutes ?? null,
    warnMinutes: input.warnMinutes ?? 60,
    position: existing.length ? Math.max(...existing.map((p) => p.position)) + 1 : 0,
  });
  await ensureStatusField(ctx.app, project.id);
  await resyncOpen(ctx.app, project.id);
  return policyDto((await policiesOf(ctx.db, project.id)).find((p) => p.id === id)!);
}

async function ownPolicy(ctx: Ctx, project: ProjectRow, id: string): Promise<PolicyRow> {
  const [row] = await ctx.db.select().from(slaPolicies).where(and(eq(slaPolicies.id, id), eq(slaPolicies.projectId, project.id)));
  if (!row) throw notFound('SLA policy', 'It may have been deleted: reload the desk’s settings.').said('sla.policyNotFound');
  return row;
}

export async function updatePolicy(ctx: Ctx, key: string, id: string, input: SlaPolicyInput): Promise<SlaPolicy> {
  requireScope(ctx, 'write');
  const project = await requireProject(ctx, key, 'manage');
  await ownPolicy(ctx, project, id);
  await checkPolicy(ctx, project, input);
  await ctx.db
    .update(slaPolicies)
    .set({
      name: input.name.trim(),
      query: input.query?.trim() ?? '',
      firstResponseMinutes: input.firstResponseMinutes ?? null,
      resolutionMinutes: input.resolutionMinutes ?? null,
      warnMinutes: input.warnMinutes ?? 60,
      updatedAt: new Date(),
    })
    .where(eq(slaPolicies.id, id));
  await resyncOpen(ctx.app, project.id);
  return policyDto(await ownPolicy(ctx, project, id));
}

export async function deletePolicy(ctx: Ctx, key: string, id: string): Promise<void> {
  requireScope(ctx, 'write');
  const project = await requireProject(ctx, key, 'manage');
  await ownPolicy(ctx, project, id);
  await ctx.db.delete(slaPolicies).where(eq(slaPolicies.id, id));
  await resyncOpen(ctx.app, project.id);
}

export async function reorderPolicies(ctx: Ctx, key: string, ids: string[]): Promise<SlaPolicy[]> {
  requireScope(ctx, 'write');
  const project = await requireProject(ctx, key, 'manage');
  const existing = await policiesOf(ctx.db, project.id);
  if (ids.length !== existing.length || !existing.every((p) => ids.includes(p.id))) {
    throw badRequest('Give every policy of the desk, once each', 'Reload the desk’s settings, then order them again.').said('sla.orderEveryPolicy');
  }
  await ctx.db.transaction(async (tx) => {
    for (const [i, id] of ids.entries()) await tx.update(slaPolicies).set({ position: i, updatedAt: new Date() }).where(eq(slaPolicies.id, id));
  });
  await resyncOpen(ctx.app, project.id);
  return (await policiesOf(ctx.db, project.id)).map(policyDto);
}

/**
 * After the desk's policies, hours or waiting states change, its open requests follow them now,
 * rather than at their next change. A desk has few open requests; each is its own transaction.
 */
export async function resyncOpen(app: AppServices, projectId: string): Promise<void> {
  const open = await app.db
    .select({ id: helpdeskRequests.issueId })
    .from(helpdeskRequests)
    .innerJoin(issues, eq(issues.id, helpdeskRequests.issueId))
    .where(and(eq(helpdeskRequests.projectId, projectId), isNull(issues.resolvedAt)))
    .limit(2000);
  for (const { id } of open) await syncRequest(app, id);
}

// ---------------------------------------------------------------------------
// The status field
// ---------------------------------------------------------------------------

/**
 * The "SLA status" field, made the first time a desk gets a policy, and on the desk's project. An
 * administrator's field of that name of another type is left alone: then there's no field to keep.
 */
export async function ensureStatusField(app: AppServices, projectId: string): Promise<void> {
  const s = await app.schema.get();
  let field = s.fieldsByName.get(SLA_STATUS_FIELD.toLowerCase());
  if (field && field.type !== 'enum') return;
  if (!field) {
    try {
      await createFieldRaw(app.db, {
        name: SLA_STATUS_FIELD,
        type: 'enum',
        description: "How a help desk request stands against its SLA targets (D45). The help desk's agent keeps it.",
        values: SLA_STATUSES.map((name) => ({ name, tone: STATUS_TONES[name] })),
      });
    } catch {
      // Another instance made it first.
    }
    app.schema.invalidate();
    field = (await app.schema.get()).fieldsByName.get(SLA_STATUS_FIELD.toLowerCase());
    if (!field) return;
  }
  await app.db.insert(projectFields).values({ projectId, fieldId: field.id, required: false, ordinal: 90 }).onConflictDoNothing();
  app.schema.invalidate();
}

/** Set the status field, as the help desk's agent, when it says otherwise: the change's own activity. */
async function mirrorStatus(tx: Db, app: AppServices, s: SchemaSnapshot, issue: IssueRow, status: SlaStatus | null): Promise<ActivityRow[]> {
  const field = s.fieldsByName.get(SLA_STATUS_FIELD.toLowerCase());
  if (!field || field.type !== 'enum' || !(s.projectFields.get(issue.projectId) ?? []).some((pf) => pf.fieldId === field.id)) return [];
  const bot = s.usersByLogin.get(HELPDESK_BOT);
  if (!bot?.isBot) return [];
  const value = status ? (s.valuesByField.get(field.id) ?? []).find((v) => v.name === status && (!v.projectId || v.projectId === issue.projectId)) : null;
  if (status && !value) return [];
  const [current] = await tx.select({ valueId: issueFieldValues.valueId }).from(issueFieldValues).where(and(eq(issueFieldValues.issueId, issue.id), eq(issueFieldValues.fieldId, field.id)));
  if ((current?.valueId ?? null) === (value?.id ?? null)) return [];
  const ctx = adminCtx(app, bot, 'helpdesk');
  ctx.actor.projectIds = [issue.projectId];
  const res = await applyChanges(tx, ctx, issue, { fields: [{ field, mode: 'set', values: value ? [{ valueId: value.id }] : [] }], data: { sla: true } }, { guards: false, machines: false });
  return res.activities;
}

// ---------------------------------------------------------------------------
// The clocks
// ---------------------------------------------------------------------------

interface Facts {
  now: number;
  created: number;
  /** It waits on its requester: in a waiting state, and they haven't answered since. */
  waiting: boolean;
  firstReplyAt: number | null;
  resolvedAt: number | null;
}

interface Want {
  target: SlaTarget;
  minutes: number | null;
  policyId: string | null;
  warnMs: number;
}

type ClockValues = Omit<ClockRow, 'issueId' | 'target' | 'updatedAt'>;

function safeCalendar(project: ProjectRow): Calendar | null {
  try {
    return calendarOf(projectSettings(project).helpdesk.businessHours);
  } catch {
    // Hours that no longer read (a zone renamed) count every hour, rather than refuse a change.
    return null;
  }
}

/** Close the stretch now counting at `end`: the time it used, and when it went past its target if it did meanwhile. */
function closeStretch(c: ClockValues, end: number, targetMs: number, cal: Calendar | null): void {
  if (!c.runningSince) return;
  const from = c.runningSince.getTime();
  const span = businessMsBetween(from, Math.max(end, from), cal);
  if (!c.breachedAt && c.usedMs <= targetMs && c.usedMs + span > targetMs) c.breachedAt = new Date(addBusinessMs(from, targetMs - c.usedMs, cal));
  c.usedMs += span;
  c.runningSince = null;
}

/** One target's clock as the request now stands; null when no policy gives it the target. */
export function stepClock(prev: ClockValues | null, want: Want, f: Facts, cal: Calendar | null): ClockValues | null {
  if (want.minutes == null) return null;
  const targetMs = want.minutes * 60_000;
  const c: ClockValues = prev
    ? { ...prev }
    : { policyId: null, targetMinutes: want.minutes, usedMs: 0, runningSince: new Date(f.created), dueAt: null, warnAt: null, metAt: null, breachedAt: null, warnedAt: null, breachToldAt: null };
  c.policyId = want.policyId;
  c.targetMinutes = want.minutes;
  const stopAt = want.target === 'first_response' ? (f.firstReplyAt ?? f.resolvedAt) : f.resolvedAt;
  if (stopAt !== null) {
    if (!c.metAt) {
      closeStretch(c, stopAt, targetMs, cal);
      c.metAt = new Date(stopAt);
    }
  } else {
    // Reopened: what's left of it counts again, from now.
    if (c.metAt) c.metAt = null;
    if (f.waiting) closeStretch(c, f.now, targetMs, cal);
    else if (!c.runningSince) c.runningSince = new Date(f.now);
  }
  if (!c.breachedAt && c.usedMs > targetMs) c.breachedAt = new Date(f.now); // a shorter target, since
  const before = c.dueAt?.getTime() ?? null;
  if (c.runningSince) {
    const from = c.runningSince.getTime();
    const left = targetMs - c.usedMs;
    c.dueAt = new Date(addBusinessMs(from, Math.max(left, 0), cal));
    c.warnAt = new Date(addBusinessMs(from, Math.max(left - want.warnMs, 0), cal));
  } else {
    c.dueAt = null;
    c.warnAt = null;
  }
  // A new stretch may warn again; a breach is said once.
  if ((c.dueAt?.getTime() ?? null) !== before) c.warnedAt = null;
  return c;
}

export function clockState(c: Pick<ClockRow, 'metAt' | 'breachedAt' | 'dueAt' | 'warnAt' | 'runningSince'>, now: number): SlaClockState {
  if (c.metAt) return c.breachedAt ? 'missed' : 'met';
  if (c.breachedAt || (c.dueAt && c.dueAt.getTime() <= now)) return 'breached';
  if (!c.runningSince) return 'paused';
  if (c.warnAt && c.warnAt.getTime() <= now) return 'at_risk';
  return 'running';
}

export function statusOf(states: SlaClockState[]): SlaStatus | null {
  if (!states.length) return null;
  if (states.some((s) => s === 'breached' || s === 'missed')) return 'Breached';
  if (states.every((s) => s === 'met')) return 'Met';
  if (states.includes('at_risk')) return 'At risk';
  if (states.includes('running')) return 'On track';
  return 'Paused';
}

/** The first policy whose query the request matches; D24's hours, without policies. */
async function coveringPolicy(db: Db, s: SchemaSnapshot, issue: IssueRow, project: ProjectRow, policies: PolicyRow[]): Promise<PolicyRow | null> {
  if (!policies.length) {
    const hours = projectSettings(project).helpdesk.firstResponseHours;
    if (!hours) return null;
    return { id: LEGACY, projectId: project.id, name: 'First response', query: '', firstResponseMinutes: Math.round(hours * 60), resolutionMinutes: null, warnMinutes: 0, position: 0, createdAt: new Date(0), updatedAt: new Date(0) };
  }
  const world = ruleWorld(s, project.id);
  const conds = policies.map((p) => {
    if (!p.query.trim()) return null;
    const c = condition(world, p.query, { meId: null, projectId: project.id });
    // A query that no longer reads (a field renamed) covers nothing, rather than everything.
    return c.problems.length ? sql`FALSE` : c.where;
  });
  const hits = await meets(db, issue.id, conds);
  const i = hits.findIndex(Boolean);
  return i < 0 ? null : policies[i]!;
}

export async function firstTeamReply(db: Db, issueId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: sql<Date | string | null>`min(${comments.createdAt})` })
    .from(comments)
    .where(and(eq(comments.issueId, issueId), eq(comments.visibility, 'public'), isNull(comments.requesterId), isNull(comments.deletedAt)));
  return row?.at ? new Date(row.at) : null;
}

async function lastRequesterAnswer(db: Db, issueId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: sql<Date | string | null>`max(${comments.createdAt})` })
    .from(comments)
    .where(and(eq(comments.issueId, issueId), isNotNull(comments.requesterId), isNull(comments.deletedAt)));
  return row?.at ? new Date(row.at) : null;
}

/** Whether a state is one the desk waits on its requester in. */
export function isWaitingState(project: ProjectRow, state: string | null): boolean {
  if (!state) return false;
  const lower = state.toLowerCase();
  return projectSettings(project).helpdesk.waitingStates.some((w) => w.toLowerCase() === lower);
}

/**
 * The move a requester's answer makes (D45): out of a waiting state, to the desk's resume state,
 * when the desk names one and the project has it. Nothing otherwise.
 */
export async function resumeFields(db: Db, s: SchemaSnapshot, issue: IssueRow): Promise<FieldChangeSpec[]> {
  const project = s.projects.get(issue.projectId);
  const resume = project ? projectSettings(project).helpdesk.resumeState : null;
  if (!project || !resume) return [];
  if (!isWaitingState(project, (await stateNames(db, s, [issue.id])).get(issue.id) ?? null)) return [];
  const field = (s.projectFields.get(project.id) ?? []).map((pf) => s.fields.get(pf.fieldId)).find((f) => f?.type === 'state');
  if (!field) return [];
  const value = (s.valuesByField.get(field.id) ?? []).find((v) => v.name.toLowerCase() === resume.toLowerCase() && (!v.projectId || v.projectId === project.id));
  return value ? [{ field, mode: 'set', values: [{ valueId: value.id }] }] : [];
}

/**
 * Bring a request's clocks to how it stands now, in the caller's transaction, and its status field
 * with them. Returns the activities the status field's change made, for the caller to publish.
 */
export async function syncClocks(tx: Db, app: AppServices, s: SchemaSnapshot, issue: IssueRow, request: RequestRow, at = new Date()): Promise<ActivityRow[]> {
  const project = s.projects.get(issue.projectId);
  if (!project) return [];
  const now = at.getTime();
  const cal = safeCalendar(project);
  const policy = await coveringPolicy(tx, s, issue, project, await policiesOf(tx, project.id));
  const state = (await stateNames(tx, s, [issue.id])).get(issue.id) ?? null;
  const waitingState = isWaitingState(project, state);
  let waitingSince = request.waitingSince;
  if (waitingState && !waitingSince) waitingSince = at;
  if (!waitingState) waitingSince = null;
  if ((waitingSince?.getTime() ?? null) !== (request.waitingSince?.getTime() ?? null)) {
    await tx.update(helpdeskRequests).set({ waitingSince }).where(eq(helpdeskRequests.issueId, issue.id));
  }
  const answer = waitingSince ? await lastRequesterAnswer(tx, issue.id) : null;
  const facts: Facts = {
    now,
    created: request.createdAt.getTime(),
    waiting: waitingState && !(answer && waitingSince && answer > waitingSince),
    firstReplyAt: (await firstTeamReply(tx, issue.id))?.getTime() ?? null,
    resolvedAt: issue.resolvedAt?.getTime() ?? null,
  };
  const existing = await tx.select().from(slaClocks).where(eq(slaClocks.issueId, issue.id));
  const states: SlaClockState[] = [];
  for (const target of SLA_TARGETS) {
    const prev = existing.find((c) => c.target === target) ?? null;
    const minutes = target === 'first_response' ? policy?.firstResponseMinutes : policy?.resolutionMinutes;
    const next = stepClock(prev, { target, minutes: minutes ?? null, policyId: policy && policy.id !== LEGACY ? policy.id : null, warnMs: (policy?.warnMinutes ?? 0) * 60_000 }, facts, cal);
    if (!next) {
      // A policy that no longer gives this target: a clock still counting goes; one that stopped stays, as what happened.
      if (prev && !prev.metAt) await tx.delete(slaClocks).where(and(eq(slaClocks.issueId, issue.id), eq(slaClocks.target, target)));
      else if (prev) states.push(clockState(prev, now));
      continue;
    }
    states.push(clockState(next, now));
    if (!prev) await tx.insert(slaClocks).values({ issueId: issue.id, target, ...next });
    else if (differs(prev, next)) await tx.update(slaClocks).set({ ...next, updatedAt: at }).where(and(eq(slaClocks.issueId, issue.id), eq(slaClocks.target, target)));
  }
  return mirrorStatus(tx, app, s, issue, statusOf(states));
}

function differs(a: ClockValues, b: ClockValues): boolean {
  const keys = Object.keys(b) as (keyof ClockValues)[];
  return keys.some((k) => {
    const x = a[k];
    const y = b[k];
    return x instanceof Date || y instanceof Date ? (x as Date | null)?.getTime() !== (y as Date | null)?.getTime() : x !== y;
  });
}

/**
 * The write path's hook (services/issues.ts): after any change to a help desk request, in its
 * transaction, its clocks follow. Imports and the status field's own change don't come here.
 */
export async function afterRequestChange(tx: Db, app: AppServices, s: SchemaSnapshot, issue: IssueRow): Promise<ActivityRow[]> {
  const [request] = await tx.select().from(helpdeskRequests).where(eq(helpdeskRequests.issueId, issue.id));
  if (!request) return [];
  return syncClocks(tx, app, s, issue, request);
}

/** Bring one request's clocks up to date in a transaction of its own, and publish what that changed. */
export async function syncRequest(app: AppServices, issueId: string, at = new Date()): Promise<void> {
  const activities = await app.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [issue] = await tx.select().from(issues).where(eq(issues.id, issueId)).for('update');
    const [request] = await tx.select().from(helpdeskRequests).where(eq(helpdeskRequests.issueId, issueId));
    if (!issue || !request) return [];
    return syncClocks(tx, app, await app.schema.get(tx), issue, request, at);
  });
  await publishActivities(app, activities);
}

// ---------------------------------------------------------------------------
// What time alone brings: the worker's chore
// ---------------------------------------------------------------------------

/**
 * Say what time has brought since the last look: a target turning at risk, once a stretch, and one
 * going past, once. Each request in a transaction of its own, as the help desk's agent; its status
 * field follows. Returns how many requests it spoke of.
 */
export async function slaTick(app: AppServices, at = new Date()): Promise<number> {
  const due = await app.db
    .selectDistinct({ issueId: slaClocks.issueId })
    .from(slaClocks)
    .where(and(isNull(slaClocks.metAt), or(and(lte(slaClocks.warnAt, at), isNull(slaClocks.warnedAt)), and(lte(slaClocks.dueAt, at), isNull(slaClocks.breachToldAt)))))
    .limit(200);
  let told = 0;
  for (const { issueId } of due) {
    const activities = await app.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const [issue] = await tx.select().from(issues).where(eq(issues.id, issueId)).for('update');
      if (!issue) return [];
      const s = await app.schema.get(tx);
      const bot = s.usersByLogin.get(HELPDESK_BOT);
      if (!bot) return [];
      const ctx = adminCtx(app, bot, 'helpdesk');
      ctx.actor.projectIds = [issue.projectId];
      const ref = (await issueRefsById(tx, s, [issue.id])).get(issue.id);
      const clocks = await tx.select().from(slaClocks).where(eq(slaClocks.issueId, issueId));
      const out: ActivityRow[] = [];
      const names = await policyNames(tx, clocks.map((c) => c.policyId));
      for (const c of clocks) {
        if (c.metAt) continue;
        const data = { target: c.target, policy: (c.policyId && names.get(c.policyId)) ?? null, dueAt: c.dueAt?.toISOString() ?? null, targetMinutes: c.targetMinutes };
        if (c.dueAt && c.dueAt <= at && !c.breachToldAt) {
          await tx.update(slaClocks).set({ breachedAt: c.breachedAt ?? c.dueAt, breachToldAt: at, warnedAt: c.warnedAt ?? at, updatedAt: at }).where(and(eq(slaClocks.issueId, issueId), eq(slaClocks.target, c.target)));
          out.push(await recordActivity(tx, ctx, { type: 'sla.breached', projectId: issue.projectId, issueId, payload: { issue: ref, data } }));
        } else if (c.warnAt && c.warnAt <= at && !c.warnedAt && !c.breachedAt) {
          await tx.update(slaClocks).set({ warnedAt: at, updatedAt: at }).where(and(eq(slaClocks.issueId, issueId), eq(slaClocks.target, c.target)));
          out.push(await recordActivity(tx, ctx, { type: 'sla.warning', projectId: issue.projectId, issueId, payload: { issue: ref, data } }));
        }
      }
      const fresh = await tx.select().from(slaClocks).where(eq(slaClocks.issueId, issueId));
      out.push(...(await mirrorStatus(tx, app, s, issue, statusOf(fresh.map((c) => clockState(c, at.getTime()))))));
      return out;
    });
    if (activities.length) told++;
    await publishActivities(app, activities);
  }
  return told;
}

async function policyNames(db: Db, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!wanted.length) return new Map();
  const rows = await db.select({ id: slaPolicies.id, name: slaPolicies.name }).from(slaPolicies).where(inArray(slaPolicies.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ---------------------------------------------------------------------------
// Reading them
// ---------------------------------------------------------------------------

function clockDto(c: ClockRow, now: number, cal: Calendar | null): SlaClock {
  const usedMs = c.usedMs + (c.runningSince && !c.metAt ? businessMsBetween(c.runningSince.getTime(), now, cal) : 0);
  const used = Math.floor(usedMs / 60_000);
  return {
    target: c.target as SlaTarget,
    state: clockState(c, now),
    targetMinutes: c.targetMinutes,
    usedMinutes: used,
    leftMinutes: c.targetMinutes - used,
    dueAt: c.dueAt?.toISOString() ?? null,
    warnAt: c.warnAt?.toISOString() ?? null,
    metAt: c.metAt?.toISOString() ?? null,
    breachedAt: (c.breachedAt ?? (c.dueAt && c.dueAt.getTime() <= now && !c.metAt ? c.dueAt : null))?.toISOString() ?? null,
  };
}

/** A request's SLA as it stands, for its page. */
export async function requestSla(db: Db, s: SchemaSnapshot, issueId: string, projectId: string, waitingSince: Date | null, now = Date.now()): Promise<RequestSla> {
  const project = s.projects.get(projectId);
  const cal = project ? safeCalendar(project) : null;
  const clocks = await db.select().from(slaClocks).where(eq(slaClocks.issueId, issueId)).orderBy(asc(slaClocks.target));
  const policyId = clocks.find((c) => c.policyId)?.policyId ?? null;
  const [policy] = policyId ? await db.select({ id: slaPolicies.id, name: slaPolicies.name }).from(slaPolicies).where(eq(slaPolicies.id, policyId)) : [];
  const dtos = clocks.sort((a, b) => SLA_TARGETS.indexOf(a.target as SlaTarget) - SLA_TARGETS.indexOf(b.target as SlaTarget)).map((c) => clockDto(c, now, cal));
  return {
    policy: policy ?? null,
    status: statusOf(dtos.map((c) => c.state)),
    clocks: dtos,
    waiting: Boolean(waitingSince) && dtos.some((c) => c.state === 'paused'),
    businessHours: cal !== null,
  };
}

/**
 * Met and breached, by policy, per week: each target counted in the week it was met, or went past
 * its target (so a breached target counts once, in the week it was breached).
 */
export async function slaReport(ctx: Ctx, key: string, opts: { from?: string; to?: string; timeZone?: string | null }): Promise<SlaReport> {
  const project = await requireProject(ctx, key, 'read');
  const tz = timeZoneOrThrow(opts.timeZone ?? projectSettings(project).helpdesk.businessHours?.timeZone ?? null);
  const today = localDate(Date.now(), tz);
  const to = opts.to ?? today;
  const from = opts.from ?? addDays(to, -7 * 11);
  if (from > to) throw badRequest('The report starts after it ends', 'Give a from date on or before the to date.').said('sla.reportStartsAfterEnd');
  const start = new Date(startOfDay(mondayOf(from), tz));
  const end = new Date(startOfDay(addDays(to, 1), tz));
  const rows = await ctx.db
    .select({ target: slaClocks.target, policy: slaPolicies.name, metAt: slaClocks.metAt, breachedAt: slaClocks.breachedAt, dueAt: slaClocks.dueAt })
    .from(slaClocks)
    .innerJoin(helpdeskRequests, eq(helpdeskRequests.issueId, slaClocks.issueId))
    .leftJoin(slaPolicies, eq(slaPolicies.id, slaClocks.policyId))
    .where(
      and(
        eq(helpdeskRequests.projectId, project.id),
        or(and(gte(slaClocks.metAt, start), lt(slaClocks.metAt, end)), and(gte(slaClocks.breachedAt, start), lt(slaClocks.breachedAt, end)), and(isNull(slaClocks.metAt), isNull(slaClocks.breachedAt), gte(slaClocks.dueAt, start), lt(slaClocks.dueAt, sql`least(${end}, now())`))),
      ),
    );
  const weeks = new Map<string, Map<string, { firstResponse: { met: number; breached: number }; resolution: { met: number; breached: number } }>>();
  const slot = (week: string, policy: string) => {
    let byPolicy = weeks.get(week);
    if (!byPolicy) weeks.set(week, (byPolicy = new Map()));
    let counts = byPolicy.get(policy);
    if (!counts) byPolicy.set(policy, (counts = { firstResponse: { met: 0, breached: 0 }, resolution: { met: 0, breached: 0 } }));
    return counts;
  };
  for (const r of rows) {
    const breachedAt = r.breachedAt ?? (r.dueAt && !r.metAt && r.dueAt.getTime() <= Date.now() ? r.dueAt : null);
    const at = breachedAt ?? r.metAt;
    if (!at || at < start || at >= end) continue;
    const counts = slot(mondayOf(localDate(at.getTime(), tz)), r.policy ?? '(none)')[r.target === 'first_response' ? 'firstResponse' : 'resolution'];
    if (breachedAt) counts.breached++;
    else counts.met++;
  }
  const out: SlaReport['weeks'] = [];
  for (let week = mondayOf(from); week <= to; week = addDays(week, 7)) {
    const byPolicy = weeks.get(week);
    out.push({ week, policies: byPolicy ? [...byPolicy.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([policy, c]) => ({ policy, ...c })) : [] });
  }
  return { timeZone: tz, weeks: out };
}

function mondayOf(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((day + 6) % 7));
}

/** The status field's id, when the snapshot has it: for tests and the web. */
export function statusFieldOf(s: SchemaSnapshot) {
  return s.fieldsByName.get(SLA_STATUS_FIELD.toLowerCase()) ?? null;
}
