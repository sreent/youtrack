import {
  type Change,
  type CommentVisibility,
  type CreateIssueInput,
  type FieldsInputT,
  type Issue,
  type IssueDetail,
  type IssueField,
  type IssueLink,
  type IssueRef,
  type UpdateIssueInput,
  type VisibleToInput,
} from '@a4a/shared';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import {
  aiSuggestions,
  comments,
  issueFieldValues,
  issueLinks,
  issues,
  issueTags,
  projects,
  tags,
  workItems,
} from '../db/schema';
import { publishActivities, recordActivity, type ActivityRow } from '../events/activity';
import {
  assertCanCommentProject,
  assertCanProject,
  assertCanReadProject,
  assertCanSetFields,
  assertCanWriteProject,
  canReadProject,
  commentSeenSql,
  goneLimitsOf,
  hiddenFields,
  privateFieldIds,
  projectAccess,
  projectRolesOf,
  scopeFields,
  seenIssueIds,
  seesField,
  seesIssueRow,
} from './access';
import { describeLimits, resolveVisibleTo, sameLimits, UNLIMITED, visibleToDtos, type Limits } from './visibility';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { excerpt } from '../lib/text';
import { issueRef, issueRefsById, parseReadableId, readableId, stateNames, type IssueRow } from './issue-refs';
import {
  fieldByName,
  projectByKey,
  type FieldRow,
  type LinkPhrase,
  type ProjectRow,
  type SchemaSnapshot,
} from './schema-cache';
import { ensureTags, tagDto } from './tags';
import { issueIdByAlias, formerIdsOf } from './aliases';
import { enforceRequiredWhen, fieldsApplying, missingNow, requiredWhen } from './conditions';
import { ruleWorld } from '../workflow/match';
import { hasVoted, reactionsOf } from './votes';
import { todayIn } from '../reports/tz';
import { zoneOf } from './time-zones';
import { addWatchers, assigneeFieldOf, loginsOf, mentionsAdded, mentionsIn, watcherIds, whoSees } from './watchers';
import { enforceGuards, guardChecks, guardsHeld } from '../workflow/guards';
import { machineMoves, transitionSpecs } from '../workflow/machines';
import { changeOf } from '../workflow/script-issue';
import { enforceScriptGuards } from '../workflow/scripts';
import { actsAsAgent, keepAgentChange, textHash, type FieldsUndo } from './agent-changes';
import { afterRequestChange } from './sla';
import {
  fieldValueDto,
  presentValues,
  resolveFieldInput,
  rowToResolved,
  sameValues,
  userRefDto,
  ownerOfNew,
  valueRow,
  type ResolvedValue,
} from './values';

export type { IssueRow };

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export async function findIssue(db: Db, s: SchemaSnapshot, idOrReadable: string): Promise<IssueRow | undefined> {
  const parsed = parseReadableId(idOrReadable);
  if (parsed) {
    const project = projectByKey(s, parsed.key);
    if (!project) return undefined;
    const [row] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.projectId, project.id), eq(issues.number, parsed.number)));
    if (row) return row;
    // An id it had before it moved still finds it (D41).
    const moved = await issueIdByAlias(db, project.id, parsed.number);
    if (!moved) return undefined;
    const [now] = await db.select().from(issues).where(eq(issues.id, moved));
    return now;
  }
  const [row] = await db.select().from(issues).where(eq(issues.id, idOrReadable.trim()));
  return row;
}

/**
 * An issue the caller may read. One they can't see answers exactly as one that doesn't exist.
 * Inside a transaction, pass it as `db`.
 */
export async function resolveIssue(ctx: Ctx, idOrReadable: string, db: Db = ctx.db): Promise<IssueRow> {
  requireScope(ctx, 'read');
  const row = await findVisibleIssue(ctx, idOrReadable, db);
  if (!row) throw notFound(`Issue ${idOrReadable}`, 'Use a readable id such as BACK-12.').said('issues.notFound', { id: idOrReadable });
  return row;
}

/** The issue if it exists and the caller may read it; otherwise undefined, whichever it is. */
export async function findVisibleIssue(ctx: Ctx, idOrReadable: string, db: Db = ctx.db): Promise<IssueRow | undefined> {
  const s = await ctx.app.schema.get(db);
  const row = await findIssue(db, s, idOrReadable);
  if (!row || !(await canReadProject(ctx, row.projectId, db))) return undefined;
  // Limited away from the caller (D37), it's missing as surely as one in a hidden project.
  if (row.limited && !(await seesIssueRow(await projectAccess(ctx, db), db, s, row))) return undefined;
  return row;
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

async function loadFieldRows(db: Db, issueIds: string[]) {
  const byIssue = new Map<string, Map<string, ResolvedValue[]>>();
  if (!issueIds.length) return byIssue;
  const rows = await db.select().from(issueFieldValues).where(inArray(issueFieldValues.issueId, issueIds));
  for (const r of rows) {
    let m = byIssue.get(r.issueId);
    if (!m) byIssue.set(r.issueId, (m = new Map()));
    const list = m.get(r.fieldId) ?? [];
    list.push(rowToResolved(r));
    m.set(r.fieldId, list);
  }
  return byIssue;
}

export async function fieldValuesOf(db: Db, issueId: string): Promise<Map<string, ResolvedValue[]>> {
  return (await loadFieldRows(db, [issueId])).get(issueId) ?? new Map();
}

function projectFieldList(s: SchemaSnapshot, projectId: string): FieldRow[] {
  return (s.projectFields.get(projectId) ?? [])
    .map((pf) => s.fields.get(pf.fieldId))
    .filter((f): f is FieldRow => Boolean(f));
}

/** An issue's fields, leaving out those kept from whoever reads it (`hidden`, D50); a private one they see says so. */
function buildFields(s: SchemaSnapshot, projectId: string, values: Map<string, ResolvedValue[]>, hidden?: ReadonlySet<string>): IssueField[] {
  const own = privateFieldIds(s, projectId);
  return projectFieldList(s, projectId)
    .filter((f) => !hidden?.has(f.id))
    .map((f) => ({
      fieldId: f.id,
      name: f.name,
      type: f.type,
      multi: f.multi,
      value: fieldValueDto(s, f, values.get(f.id) ?? []),
      ...(own.has(f.id) ? { private: true } : {}),
    }));
}

/** Batch-map issue rows to list DTOs, preserving order. */
export async function issueDtos(ctx: Ctx, rows: IssueRow[]): Promise<Issue[]> {
  if (!rows.length) return [];
  const s = await ctx.app.schema.get();
  const ids = rows.map((r) => r.id);
  const view = await projectAccess(ctx);
  const commentSeen = commentSeenSql(view, 'comments');
  // A project's private fields reach only who may read them (D50).
  const hidden = hiddenFields(view, s);
  const [fieldRows, tagRows, commentCounts] = await Promise.all([
    loadFieldRows(ctx.db, ids),
    ctx.db
      .select({ issueId: issueTags.issueId, tagId: issueTags.tagId })
      .from(issueTags)
      .where(inArray(issueTags.issueId, ids)),
    ctx.db
      .select({ issueId: comments.issueId, n: sql<number>`count(*)::int` })
      .from(comments)
      .where(and(inArray(comments.issueId, ids), isNull(comments.deletedAt), commentSeen))
      .groupBy(comments.issueId),
  ]);
  const tagsByIssue = new Map<string, string[]>();
  for (const t of tagRows) tagsByIssue.set(t.issueId, [...(tagsByIssue.get(t.issueId) ?? []), t.tagId]);
  const counts = new Map(commentCounts.map((c) => [c.issueId, Number(c.n)]));
  return rows.map((r) => {
    const project = s.projects.get(r.projectId)!;
    const reporter = r.reporterId ? s.users.get(r.reporterId) : undefined;
    return {
      id: `${project.key}-${r.number}`,
      uid: r.id,
      number: r.number,
      project: { id: project.id, key: project.key, name: project.name },
      summary: r.summary,
      reporter: reporter ? userRefDto(reporter) : null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      version: r.version,
      fields: buildFields(s, r.projectId, fieldRows.get(r.id) ?? new Map(), hidden.get(r.projectId)),
      tags: (tagsByIssue.get(r.id) ?? [])
        .map((id) => s.tags.get(id))
        .filter((t): t is NonNullable<typeof t> => Boolean(t))
        .map(tagDto),
      commentCount: counts.get(r.id) ?? 0,
      votes: r.votes,
      limited: r.limited,
    };
  });
}

/** An issue's links, leaving out those whose other end the caller can't see. */
export async function issueLinksOf(ctx: Ctx, issueId: string): Promise<IssueLink[]> {
  const s = await ctx.app.schema.get();
  const rows = await ctx.db
    .select()
    .from(issueLinks)
    .where(or(eq(issueLinks.sourceId, issueId), eq(issueLinks.targetId, issueId)));
  const otherIds = rows.map((r) => (r.sourceId === issueId ? r.targetId : r.sourceId));
  const seen = await seenIssueIds(ctx, otherIds);
  const refs = await issueRefsById(ctx.db, s, otherIds.filter((id) => seen.has(id)));
  const out: IssueLink[] = [];
  for (const r of rows) {
    const type = s.linkTypes.find((t) => t.id === r.typeId);
    if (!type) continue;
    const outward = r.sourceId === issueId;
    const other = refs.get(outward ? r.targetId : r.sourceId);
    if (!other) continue;
    out.push({
      id: r.id,
      typeId: type.id,
      typeName: type.name,
      phrase: outward ? type.outward : type.inward,
      direction: type.directed ? (outward ? 'outward' : 'inward') : 'both',
      issue: other,
    });
  }
  return out;
}

export async function issueDetail(ctx: Ctx, row: IssueRow): Promise<IssueDetail> {
  const s = await ctx.app.schema.get();
  const [base] = await issueDtos(ctx, [row]);
  const [links, spent, pending, [visibleTo]] = await Promise.all([
    issueLinksOf(ctx, row.id),
    ctx.db
      .select({ total: sql<number>`coalesce(sum(${workItems.minutes}), 0)::int` })
      .from(workItems)
      .where(eq(workItems.issueId, row.id)),
    ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(aiSuggestions)
      .where(and(eq(aiSuggestions.issueId, row.id), eq(aiSuggestions.status, 'pending'))),
    visibleToDtos(ctx.db, s, [row]),
  ]);
  const aggregation = new Set(s.linkTypes.filter((t) => t.aggregation).map((t) => t.id));
  const parentLink = links.find((l) => aggregation.has(l.typeId) && l.direction === 'inward');
  const subtasks = links.filter((l) => aggregation.has(l.typeId) && l.direction === 'outward').map((l) => l.issue);
  const updatedBy = row.updatedById ? s.users.get(row.updatedById) : undefined;
  const me = ctx.actor.user.id;
  const [voted, reactionMap, formerIds, applying] = await Promise.all([
    hasVoted(ctx.db, row.id, me),
    reactionsOf(ctx.db, s, row.id, me, { anonymous: Boolean(ctx.actor.guest) }),
    formerIdsOf(ctx.db, s, row.id),
    // Answered in the project's words as the caller reads them: a condition that reads a private field
    // kept from them holds always, as one that no longer reads does, so it says nothing of the value (D50).
    fieldsApplying(ctx.db, scopeFields(ruleWorld(s, row.projectId), await projectAccess(ctx)), row.projectId, row.id),
  ]);
  return {
    ...base!,
    // A field with a condition says whether it applies now; the others always do (D41).
    fields: base!.fields.map((f) => (applying.has(f.fieldId) ? { ...f, applies: applying.get(f.fieldId)! } : f)),
    voted,
    reactions: reactionMap.get(`issue:${row.id}`) ?? [],
    formerIds,
    description: row.description,
    visibleTo: visibleTo ?? null,
    updatedBy: updatedBy ? userRefDto(updatedBy) : null,
    links,
    parent: parentLink?.issue ?? null,
    subtasks,
    spentMinutes: Number(spent[0]?.total ?? 0),
    pendingSuggestions: Number(pending[0]?.n ?? 0),
  };
}

export async function getIssue(ctx: Ctx, idOrReadable: string): Promise<IssueDetail> {
  requireScope(ctx, 'read');
  return issueDetail(ctx, await resolveIssue(ctx, idOrReadable));
}

// ---------------------------------------------------------------------------
// Field input resolution
// ---------------------------------------------------------------------------

export interface FieldChangeSpec {
  field: FieldRow;
  mode: 'set' | 'add' | 'remove';
  values: ResolvedValue[];
}

export function resolveFieldsInput(
  s: SchemaSnapshot,
  project: ProjectRow,
  input: FieldsInputT | undefined,
  meId: string,
  /** "today" for dates typed as words, where whoever asks is (D31). */
  today?: string,
  /** Where a moment typed without an offset is read (D41). */
  zone?: string,
): FieldChangeSpec[] {
  if (!input) return [];
  const attached = new Set((s.projectFields.get(project.id) ?? []).map((pf) => pf.fieldId));
  const out: FieldChangeSpec[] = [];
  for (const [name, raw] of Object.entries(input)) {
    const field = fieldByName(s, name);
    if (!field || !attached.has(field.id)) throw noSuchField(s, project, name);
    out.push({ field, mode: 'set', values: resolveFieldInput(s, field, project.id, raw, meId, today, zone) });
  }
  return out;
}

/**
 * A field the project doesn't have, naming those it has. Given the snapshot as the caller sees it
 * (`scopeFields`), a private field kept from them is one of these, in the same words (D50).
 */
export function noSuchField(s: SchemaSnapshot, project: ProjectRow, name: string): AppError {
  const names = projectFieldList(s, project.id).map((f) => f.name);
  return badRequest(`Project ${project.key} has no field "${name}"`, `Fields: ${names.join(', ')}`).said('issues.noSuchField', { project: project.key, name, names: names.join(', ') });
}

export function resolveLinkPhrase(s: SchemaSnapshot, relation: string): LinkPhrase {
  const lower = relation.trim().toLowerCase().replace(/\s+/g, ' ');
  const found = s.linkPhrases.find((p) => p.phrase === lower) ?? s.linkPhrases.find((p) => p.type.name.toLowerCase() === lower);
  if (!found) {
    throw badRequest(
      `Unknown link relation "${relation}"`,
      `Use one of: ${[...new Set(s.linkPhrases.map((p) => p.display))].join(', ')}`,
    ).said('issues.unknownLinkRelation', { relation, relations: [...new Set(s.linkPhrases.map((p) => p.display))].join(', ') });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Applying changes (shared by update, commands, AI and MCP)
// ---------------------------------------------------------------------------

export interface LinkSpec {
  phrase: LinkPhrase;
  target: IssueRow;
  remove?: boolean;
}

export interface ChangeSpec {
  summary?: string;
  description?: string;
  fields?: FieldChangeSpec[];
  addTags?: string[];
  removeTags?: string[];
  links?: LinkSpec[];
  comment?: string;
  expectedVersion?: number;
  /** Said about the change in its activity, e.g. that it accepts what triage worked out. */
  data?: Record<string, unknown>;
  /** Who the comment is for: 'public' also reaches the requester of a help desk request. */
  commentVisibility?: CommentVisibility;
  /** The requester of a help desk request wrote the comment, on their tracking page (services/helpdesk.ts). */
  commentRequester?: { id: string; name: string };
  /** Which of a state machine's transitions the change makes, by name, when it was asked for by name (D40). */
  transition?: { fieldId: string; name: string };
  /** Who sees the issue from now on (D37): a change to it, like a field's, which takes the edit permission. */
  visibleTo?: Limits;
  /** Who sees the comment (D37); not limited when left out. */
  commentVisibleTo?: Limits;
}

export interface ApplyResult {
  changes: Change[];
  activities: ActivityRow[];
  issue: IssueRow;
}

function mergeValues(field: FieldRow, current: ResolvedValue[], spec: FieldChangeSpec): ResolvedValue[] {
  if (spec.mode === 'set' || !field.multi) {
    if (spec.mode === 'remove') {
      return current.filter((c) => !spec.values.some((v) => sameValues([v], [c])));
    }
    return spec.values;
  }
  if (spec.mode === 'add') {
    const next = [...current];
    for (const v of spec.values) if (!next.some((c) => sameValues([c], [v]))) next.push(v);
    return next;
  }
  return current.filter((c) => !spec.values.some((v) => sameValues([v], [c])));
}

function linkEndpoints(phrase: LinkPhrase, self: IssueRow, other: IssueRow) {
  return phrase.direction === 'inward' ? { sourceId: other.id, targetId: self.id } : { sourceId: self.id, targetId: other.id };
}

/**
 * Validate and apply a change set to one issue inside `tx`. With `dryRun`, nothing
 * is written and the returned changes describe what would happen. The project's guards
 * (workflow rules that refuse a change) are checked before commit, unless `guards` is false
 * because the caller checks them itself.
 */
export async function applyChanges(
  tx: Db,
  ctx: Ctx,
  stale: IssueRow,
  spec: ChangeSpec,
  opts: { dryRun?: boolean; guards?: boolean; machines?: boolean; /** A transition's own command (D40): the project's, not the actor's choice. */ privateOk?: boolean } = {},
): Promise<ApplyResult> {
  const s = await ctx.app.schema.get(tx);
  // Lock the issue row for the rest of the transaction so concurrent changes to the
  // same issue serialise (no lost updates on multi-value fields or tags), and work
  // from the row as it is now rather than as the caller last read it.
  const lockedRows = opts.dryRun
    ? await tx.select().from(issues).where(eq(issues.id, stale.id))
    : await tx.select().from(issues).where(eq(issues.id, stale.id)).for('update');
  const issue = lockedRows[0];
  if (!issue) throw notFound(`Issue ${readableId(s, stale)}`).said('notFound.issue', { id: readableId(s, stale) });
  // A comment alone needs only a role in the project (a viewer comments); anything else changes
  // the issue. A dry run changes nothing, so reading is enough to preview.
  if (opts.dryRun) await assertCanReadProject(ctx, issue.projectId, tx);
  else if (isCommentOnly(spec)) await assertCanCommentProject(ctx, issue.projectId, tx);
  else await assertCanWriteProject(ctx, issue.projectId, tx);
  const project = s.projects.get(issue.projectId)!;
  if (spec.expectedVersion !== undefined && spec.expectedVersion !== issue.version) {
    throw conflict(
      `${readableId(s, issue)} was changed by someone else (version ${issue.version}, you sent ${spec.expectedVersion})`,
      'Reload the issue and re-apply your change.',
      { currentVersion: issue.version },
    ).said('issues.changedMeanwhile', { id: readableId(s, issue), version: issue.version, expectedVersion: spec.expectedVersion });
  }
  const changes: Change[] = [];
  // A private field is set only by who may change it, and one kept from the actor is a field the
  // project doesn't have (D50): every field named, changed or not, so trying values tells nothing.
  const view = await projectAccess(ctx, tx);
  if (!opts.privateOk && spec.fields?.length) {
    await assertCanSetFields(ctx, issue.projectId, spec.fields.map((f) => f.field.id), (id) => noSuchField(scopeFields(s, view), project, s.fields.get(id)?.name ?? id), tx);
  }
  const current = await fieldValuesOf(tx, issue.id);
  const pfs = s.projectFields.get(project.id) ?? [];
  const fieldUpdates: { field: FieldRow; values: ResolvedValue[] }[] = [];

  for (const fs of spec.fields ?? []) {
    const before = current.get(fs.field.id) ?? [];
    const after = mergeValues(fs.field, before, fs);
    if (sameValues(before, after)) continue;
    const pf = pfs.find((p) => p.fieldId === fs.field.id);
    if (pf?.required && !pf.condition && after.length === 0) throw badRequest(`${fs.field.name} is required in ${project.key}`).said('issues.fieldRequired', { field: fs.field.name, project: project.key });
    if (fs.field.type === 'user') {
      const added = after.map((v) => v.userId).filter((id): id is string => Boolean(id) && !before.some((b) => b.userId === id));
      await assertPeopleSeeProject(tx, s, project, fs.field, added);
    }
    fieldUpdates.push({ field: fs.field, values: after });
    changes.push({ field: fs.field.name, from: presentValues(s, fs.field, before), to: presentValues(s, fs.field, after) });
  }
  // An owned field's value given to an issue nobody has: the value's owner takes it, in the same
  // change, unless the change says who does (D41).
  const owned = await ownerAssignment(tx, s, project, spec.fields ?? [], current, fieldUpdates);
  if (owned) {
    fieldUpdates.push(owned);
    changes.push({ field: owned.field.name, from: null, to: presentValues(s, owned.field, owned.values) });
  }

  const patch: Partial<typeof issues.$inferInsert> = {};
  if (spec.summary !== undefined && spec.summary.trim() !== issue.summary) {
    const summary = spec.summary.trim();
    if (!summary) throw badRequest('Summary cannot be empty').said('issues.summaryEmpty');
    patch.summary = summary;
    changes.push({ field: 'Summary', from: issue.summary, to: summary });
  }
  if (spec.description !== undefined && spec.description !== issue.description) {
    patch.description = spec.description;
    changes.push({ field: 'Description', from: excerpt(issue.description, 2000) || null, to: excerpt(spec.description, 2000) || null });
  }

  // Tags
  const currentTagRows = await tx
    .select({ id: tags.id, name: tags.name })
    .from(issueTags)
    .innerJoin(tags, eq(tags.id, issueTags.tagId))
    .where(eq(issueTags.issueId, issue.id));
  const currentTagNames = currentTagRows.map((t) => t.name);
  const addTagNames = (spec.addTags ?? []).map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
  const removeTagNames = new Set((spec.removeTags ?? []).map((t) => t.trim().replace(/^#/, '').toLowerCase()));
  const toAdd = addTagNames.filter((n) => !currentTagNames.some((c) => c.toLowerCase() === n.toLowerCase()));
  const toRemove = currentTagRows.filter((t) => removeTagNames.has(t.name.toLowerCase()));
  if (toAdd.length || toRemove.length) {
    const after = [...currentTagNames.filter((n) => !toRemove.some((r) => r.name === n)), ...toAdd];
    changes.push({ field: 'Tags', from: currentTagNames.join(', ') || null, to: after.join(', ') || null });
  }

  // Links (validated before writing anything)
  const linkOps: { spec: LinkSpec; endpoints: { sourceId: string; targetId: string }; existingId: string | null }[] = [];
  for (const l of spec.links ?? []) {
    if (l.target.id === issue.id) throw badRequest('An issue cannot be linked to itself').said('issues.selfLink');
    // A link shows on both issues and changes both histories, so it needs both: never reveal
    // an issue the caller can't see, and never change one they may only read.
    if (!(await canReadProject(ctx, l.target.projectId, tx))) throw notFound(`Issue ${readableId(s, l.target)}`).said('notFound.issue', { id: readableId(s, l.target) });
    if (!opts.dryRun) {
      await assertCanWriteProject(ctx, l.target.projectId, tx).catch((e: unknown) => {
        if (e instanceof AppError && e.status === 403) {
          throw forbidden(`A link changes ${readableId(s, l.target)} too: ${e.message}`, e.hint).said('issues.linkChangesTooBecause', { id: readableId(s, l.target), problem: e.words ?? { key: 'forbidden' } });
        }
        throw e;
      });
    }
    const endpoints = linkEndpoints(l.phrase, issue, l.target);
    const existing = await tx
      .select({ id: issueLinks.id })
      .from(issueLinks)
      .where(
        and(
          eq(issueLinks.typeId, l.phrase.type.id),
          l.phrase.direction === 'both'
            ? or(
                and(eq(issueLinks.sourceId, issue.id), eq(issueLinks.targetId, l.target.id)),
                and(eq(issueLinks.sourceId, l.target.id), eq(issueLinks.targetId, issue.id)),
              )
            : and(eq(issueLinks.sourceId, endpoints.sourceId), eq(issueLinks.targetId, endpoints.targetId)),
        ),
      );
    const existingId = existing[0]?.id ?? null;
    if (l.remove ? existingId : !existingId) {
      if (!l.remove && l.phrase.type.aggregation && l.phrase.direction === 'inward') {
        // "subtask of X": an issue has one parent; replacing is explicit via remove first.
        const parent = await tx
          .select({ id: issueLinks.id })
          .from(issueLinks)
          .where(and(eq(issueLinks.typeId, l.phrase.type.id), eq(issueLinks.targetId, issue.id)));
        if (parent.length) throw badRequest(`${readableId(s, issue)} already has a parent`, 'Remove the existing "subtask of" link first.').said('issues.hasParent', { id: readableId(s, issue) });
      }
      linkOps.push({ spec: l, endpoints, existingId });
      changes.push({
        field: 'Links',
        from: l.remove ? `${l.phrase.display} ${readableId(s, l.target)}` : null,
        to: l.remove ? null : `${l.phrase.display} ${readableId(s, l.target)}`,
      });
    }
  }

  if (spec.visibleTo && !sameLimits(spec.visibleTo, issue)) {
    // Nobody limits an issue away from themselves: they'd lose it the moment they saved.
    if (!(await seesIssueRow(await projectAccess(ctx, tx), tx, s, { ...issue, ...spec.visibleTo }))) {
      throw badRequest(`That would hide ${readableId(s, issue)} from you`, 'Add yourself, or a group you are in, to who sees it.').said('issues.wouldHide', { id: readableId(s, issue) });
    }
    patch.limited = spec.visibleTo.limited;
    patch.visibleUserIds = spec.visibleTo.visibleUserIds;
    patch.visibleGroupIds = spec.visibleTo.visibleGroupIds;
    changes.push({ field: 'Visible to', from: await describeLimits(tx, s, issue), to: await describeLimits(tx, s, spec.visibleTo) });
  }

  const comment = spec.comment?.trim();
  if (comment) changes.push({ field: 'Comment', from: null, to: excerpt(comment, 200) });

  // State machines (D40): each change to a governed field must be one of its transitions. An import
  // brings history, and an undo puts back what was: neither is a move.
  const history = Boolean((spec.data as { imported?: unknown } | undefined)?.imported) || (spec.data as { undoes?: unknown } | undefined)?.undoes !== undefined;
  const moves = opts.machines === false || history ? [] : await machineMoves(tx, ctx, s, issue, fieldUpdates, current, spec.transition);

  if (opts.dryRun || !changes.length) return { changes, activities: [], issue };

  // Guards: whether each holds before the change, so that one the change breaks refuses it below.
  // An import's changes are history: the guards, made for new work, don't judge them.
  const guards = opts.guards === false || (spec.data as { imported?: unknown } | undefined)?.imported ? [] : guardChecks(ctx, s, issue.projectId);
  const heldBefore = guards.length ? await guardsHeld(tx, guards, issue.id) : [];
  // Fields required while a condition holds, and which were missing already (D41).
  // One kept from the actor asks nothing of them: it isn't there for them (D50).
  const needs = opts.guards === false || (spec.data as { imported?: unknown } | undefined)?.imported ? [] : requiredWhen(s, issue.projectId).filter((n) => seesField(view, s, issue.projectId, n.fieldId));
  const missingBefore = needs.length ? await missingNow(tx, issue.id, needs) : [];

  // ---- write ---------------------------------------------------------------
  const activities: ActivityRow[] = [];
  for (const u of fieldUpdates) {
    await tx.delete(issueFieldValues).where(and(eq(issueFieldValues.issueId, issue.id), eq(issueFieldValues.fieldId, u.field.id)));
    if (u.values.length) {
      await tx.insert(issueFieldValues).values(u.values.map((v) => ({ issueId: issue.id, fieldId: u.field.id, ...valueRow(v) })));
    }
  }
  let addedTags: string[] = [];
  if (toAdd.length) {
    const rows = await ensureTags(tx, ctx, toAdd);
    addedTags = rows.map((t) => t.name);
    await tx
      .insert(issueTags)
      .values(rows.map((t) => ({ issueId: issue.id, tagId: t.id })))
      .onConflictDoNothing();
  }
  if (toRemove.length) {
    await tx.delete(issueTags).where(and(eq(issueTags.issueId, issue.id), inArray(issueTags.tagId, toRemove.map((t) => t.id))));
  }

  const resolvedAt = await computeResolvedAt(tx, s, issue, fieldUpdates);
  const fieldOrMetaChanged = changes.some((c) => c.field !== 'Links' && c.field !== 'Comment');
  const [updated] = await tx
    .update(issues)
    .set({
      ...patch,
      resolvedAt,
      updatedAt: new Date(),
      updatedById: ctx.actor.user.id,
      version: sql`${issues.version} + 1`,
    })
    .where(and(eq(issues.id, issue.id), eq(issues.version, issue.version)))
    .returning();
  if (!updated) {
    // Unreachable while the row lock is held; kept as a guard for future callers.
    throw conflict(`${readableId(s, issue)} changed while it was being updated`, 'Retry the change.').said('issues.changedWhileUpdating', { id: readableId(s, issue) });
  }
  const states = await stateNames(tx, s, [issue.id]);
  const ref = issueRef(s, updated!, states.get(issue.id) ?? null);

  // Who to tell, and who watches it now: a new assignee, people newly mentioned, whoever comments.
  // Text from a help desk's requester mentions nobody: the public can't page the team.
  const fromOutside = ctx.actor.channel === 'helpdesk';
  // An import brings history, not news: who wrote its text there makes nobody here watch.
  const imported = Boolean((spec.data as { imported?: unknown } | undefined)?.imported);
  // A change an agent made on its own keeps what undoing it puts back (D34).
  const keep = !imported && actsAsAgent(ctx);
  const assigneeField = assigneeFieldOf(s);
  const assigneeUpdate = assigneeField ? fieldUpdates.find((u) => u.field.id === assigneeField.id) : undefined;
  const assigned = assigneeUpdate
    ? loginsOf(s, assigneeUpdate.values).filter((l) => !loginsOf(s, current.get(assigneeField!.id)).includes(l))
    : [];
  // Only people who can see the project are told or watch: a mention of anyone else tells nobody.
  const commenter = comment && !fromOutside && !imported ? [ctx.actor.user.login] : [];
  const mentionedNow = patch.description !== undefined && !fromOutside && !imported ? mentionsAdded(s, issue.description, patch.description) : [];
  const mentionedInComment = comment && !fromOutside && !imported ? mentionsIn(s, comment) : [];
  const seeing = await whoSees(tx, s, issue.projectId, [...assigned, ...commenter, ...mentionedNow, ...mentionedInComment], updated!);
  const describedMentions = mentionedNow.filter((l) => seeing.has(l.toLowerCase()));
  const commentLimits = spec.commentVisibleTo ?? UNLIMITED;
  const commentSeeing = commentLimits.limited
    ? await whoSees(tx, s, issue.projectId, mentionedInComment, updated!, { authorId: ctx.actor.user.id, ...commentLimits })
    : seeing;
  const commentMentions = mentionedInComment.filter((l) => commentSeeing.has(l.toLowerCase()));
  await addWatchers(
    tx,
    s,
    issue,
    [
      ...assigned.map((login) => ({ login, reason: 'assignee' as const })),
      ...commenter.map((login) => ({ login, reason: 'commenter' as const })),
      ...[...describedMentions, ...commentMentions].map((login) => ({ login, reason: 'mentioned' as const })),
    ],
    seeing,
  );
  const told = { ...(assigned.length ? { assigned } : {}), ...(describedMentions.length ? { mentions: describedMentions } : {}) };

  if (fieldOrMetaChanged) {
    const via = moves.length ? { transition: moves.map((m) => m.transition.name).join(', ') } : {};
    const data = spec.data || assigned.length || describedMentions.length || moves.length ? { ...spec.data, ...told, ...via } : undefined;
    activities.push(
      await recordActivity(tx, ctx, {
        type: 'issue.updated',
        projectId: issue.projectId,
        issueId: issue.id,
        payload: { issue: ref, changes: changes.filter((c) => c.field !== 'Links' && c.field !== 'Comment'), ...(data ? { data } : {}) },
      }),
    );
    if (keep) {
      const undo: FieldsUndo = {
        kind: 'fields',
        fields: fieldUpdates.map((u) => ({ fieldId: u.field.id, name: u.field.name, before: current.get(u.field.id) ?? [], after: u.values })),
        ...(patch.summary !== undefined ? { summary: { before: issue.summary, after: patch.summary } } : {}),
        ...(patch.description !== undefined ? { description: { before: issue.description, afterHash: textHash(patch.description) } } : {}),
        ...(toAdd.length || toRemove.length ? { tags: { added: addedTags, removed: toRemove.map((t) => t.name) } } : {}),
      };
      await keepAgentChange(tx, ctx, { issueId: issue.id, activityId: activities[activities.length - 1]!.id, undo });
    }
  }

  for (const op of linkOps) {
    const targetRef = (await issueRefsById(tx, s, [op.spec.target.id])).get(op.spec.target.id)!;
    if (op.spec.remove && op.existingId) {
      await tx.delete(issueLinks).where(eq(issueLinks.id, op.existingId));
    } else {
      await tx.insert(issueLinks).values({
        id: newId(),
        typeId: op.spec.phrase.type.id,
        sourceId: op.endpoints.sourceId,
        targetId: op.endpoints.targetId,
        createdById: ctx.actor.user.id,
      });
    }
    const inverse = op.spec.phrase.direction === 'outward' ? op.spec.phrase.type.inward : op.spec.phrase.type.outward;
    const type = op.spec.remove ? 'link.deleted' : 'link.created';
    const here = await recordActivity(tx, ctx, {
      type,
      projectId: issue.projectId,
      issueId: issue.id,
      payload: { issue: ref, data: { ...spec.data, phrase: op.spec.phrase.display, target: targetRef } },
    });
    const there = await recordActivity(tx, ctx, {
      type,
      projectId: op.spec.target.projectId,
      issueId: op.spec.target.id,
      payload: { issue: targetRef, data: { ...spec.data, phrase: inverse, target: ref } },
    });
    activities.push(here, there);
    if (keep) {
      await keepAgentChange(tx, ctx, {
        issueId: issue.id,
        activityId: here.id,
        pairActivityId: there.id,
        undo: { kind: 'link', typeId: op.spec.phrase.type.id, sourceId: op.endpoints.sourceId, targetId: op.endpoints.targetId, created: !op.spec.remove },
      });
    }
  }

  if (comment) {
    const id = newId();
    const visibility = spec.commentVisibility ?? 'internal';
    await tx.insert(comments).values({
      id,
      issueId: issue.id,
      authorId: ctx.actor.user.id,
      text: comment,
      channel: ctx.actor.channel,
      visibility,
      requesterId: spec.commentRequester?.id ?? null,
      ...commentLimits,
    });
    activities.push(
      await recordActivity(tx, ctx, {
        type: 'comment.created',
        projectId: issue.projectId,
        issueId: issue.id,
        payload: {
          issue: ref,
          data: {
            ...spec.data,
            commentId: id,
            text: excerpt(comment, 1000),
            ...(visibility === 'public' ? { visibility } : {}),
            ...(commentLimits.limited ? { limited: true } : {}),
            ...(spec.commentRequester ? { requester: { name: spec.commentRequester.name } } : {}),
            ...(commentMentions.length ? { mentions: commentMentions } : {}),
          },
        },
      }),
    );
  }

  // What the transitions made also do: their commands, as whoever made the move, in this transaction.
  let final = updated!;
  for (const extra of moves.length ? await transitionSpecs(tx, ctx, s, final, moves) : []) {
    const res = await applyChanges(tx, ctx, final, extra, { guards: false, machines: false, privateOk: true });
    changes.push(...res.changes);
    activities.push(...res.activities);
    final = res.issue;
  }

  // Everything is written and nothing is committed: a change that breaks a guard is refused here,
  // and the caller's transaction takes all of it back.
  await enforceRequiredWhen(tx, issue.id, needs, missingBefore);
  await enforceGuards(tx, ctx, s, guards, heldBefore, final);
  if (opts.guards !== false && !imported) {
    await enforceScriptGuards(tx, ctx, s, final, changeOf(isCommentOnly(spec) ? 'commented' : 'updated', s.users.get(ctx.actor.user.id), changes, { comment: comment ?? null }), false);
  }

  // A help desk request's SLA clocks follow the change, in its transaction (D45): paused, resumed,
  // met, reopened. Not an import's, which is history, nor the status field's own change.
  if (!imported && !(spec.data as { sla?: unknown } | undefined)?.sla) {
    activities.push(...(await afterRequestChange(tx, ctx.app, s, final)));
  }

  return { changes, activities, issue: final };
}

/**
 * The assignee an owned field's change brings (D41): when the issue has nobody, the change doesn't
 * say who, and a value it gains has an owner who can see the project.
 */
async function ownerAssignment(
  db: Db,
  s: SchemaSnapshot,
  project: ProjectRow,
  specs: { field: FieldRow }[],
  current: Map<string, ResolvedValue[]>,
  updates: { field: FieldRow; values: ResolvedValue[] }[],
): Promise<{ field: FieldRow; values: ResolvedValue[] } | null> {
  const assignee = assigneeFieldOf(s);
  if (!assignee || !(s.projectFields.get(project.id) ?? []).some((pf) => pf.fieldId === assignee.id)) return null;
  if (specs.some((sp) => sp.field.id === assignee.id) || current.get(assignee.id)?.length) return null;
  for (const u of updates) {
    const owner = ownerOfNew(s, u.field, current.get(u.field.id) ?? [], u.values);
    if (owner && (await whoSees(db, s, project.id, [owner.login])).has(owner.login.toLowerCase())) return { field: assignee, values: [{ userId: owner.id }] };
  }
  return null;
}

function isCommentOnly(spec: ChangeSpec): boolean {
  return (
    Boolean(spec.comment?.trim()) &&
    spec.summary === undefined &&
    spec.description === undefined &&
    !spec.fields?.length &&
    !spec.addTags?.length &&
    !spec.removeTags?.length &&
    !spec.links?.length &&
    spec.visibleTo === undefined
  );
}

/**
 * In a project only its people see, someone set in a user field (an assignee) must be one of
 * them: otherwise they'd be told about, or own, an issue they can't open.
 */
async function assertPeopleSeeProject(db: Db, s: SchemaSnapshot, project: ProjectRow, field: FieldRow, userIds: string[]): Promise<void> {
  if (!userIds.length || project.visibility !== 'members') return;
  const roles = await projectRolesOf(db, project.id, userIds);
  const outside = userIds.filter((id) => !roles.has(id));
  if (!outside.length) return;
  const names = outside.map((id) => s.users.get(id)?.name ?? id).join(', ');
  throw badRequest(
    `${names} can't see ${project.key}, so can't be the value of ${field.name}`,
    `Only ${project.key}'s people see it. Add ${outside.length === 1 ? 'them' : 'each of them'} to the project first, or choose someone who is in it.`,
  ).said('issues.cantBeValueOf', { names, project: project.key, field: field.name, n: outside.length });
}

async function computeResolvedAt(
  tx: Db,
  s: SchemaSnapshot,
  issue: IssueRow,
  updates: { field: FieldRow; values: ResolvedValue[] }[],
): Promise<Date | null> {
  const stateUpdate = updates.find((u) => u.field.type === 'state');
  if (!stateUpdate) return issue.resolvedAt;
  const resolved = stateUpdate.values.some((v) => (v.valueId ? s.values.get(v.valueId)?.isResolved : false));
  if (!resolved) return null;
  return issue.resolvedAt ?? new Date();
}

// ---------------------------------------------------------------------------
// Create / update / delete
// ---------------------------------------------------------------------------

/**
 * For imports only: the issue as the other tracker had it. The issue keeps its own created and
 * updated dates and its reporter (null when nobody here is them), and its activity says it was
 * imported, with `data` (the import, the other tracker's key and dates), while the activity's
 * actor stays the person who ran the import.
 */
export interface ImportedOrigin {
  createdAt: Date;
  updatedAt: Date;
  /** When it was resolved there; used only when it comes in resolved. */
  resolvedAt: Date | null;
  reporterId: string | null;
  data: Record<string, unknown>;
}

export interface CreateOptions {
  imported?: ImportedOrigin;
  /** Said about it in its activity, e.g. that a help desk's requester asked for it. */
  data?: Record<string, unknown>;
  /** More to write in the creating transaction, once the issue exists (services/helpdesk.ts). */
  inTransaction?: (tx: Db, row: IssueRow) => Promise<void>;
  /** Values it takes as they are, already resolved: a clone's (services/move.ts). Given fields win. */
  carry?: { field: FieldRow; values: ResolvedValue[] }[];
}

interface PreparedIssue {
  s: SchemaSnapshot;
  project: ProjectRow;
  summary: string;
  description: string;
  specs: FieldChangeSpec[];
  values: Map<string, ResolvedValue[]>;
  resolved: boolean;
  tags: string[];
  links: LinkSpec[];
  limits: Limits;
}

/** Everything a new issue needs, checked, before anything is written. Reads through `db`. */
async function prepareIssue(ctx: Ctx, input: CreateIssueInput, db: Db, carry: CreateOptions['carry'] = []): Promise<PreparedIssue> {
  const s = await ctx.app.schema.get(db);
  const view = await projectAccess(ctx, db);
  const project = projectByKey(s, input.project);
  if (!project || !view.canRead(project.id)) {
    // Only the projects the caller can file in: a hidden project's key is never named.
    const open = [...s.projects.values()].filter((p) => view.allows(p.id, 'create') && !p.archived).map((p) => p.key);
    throw notFound(`Project ${input.project}`, open.length ? `Projects you can file in: ${open.join(', ')}` : 'You can file issues in no project yet.').said('issues.projectNotFound', { project: input.project, n: open.length, projects: open.join(', ') });
  }
  await assertCanProject(ctx, project.id, 'create', db);
  if (project.archived) throw badRequest(`Project ${project.key} is archived`).said('issues.projectArchived', { project: project.key });
  const summary = input.summary.trim();
  if (!summary) throw badRequest('Summary cannot be empty').said('issues.summaryEmpty');

  const today = todayIn(zoneOf(ctx));
  // Named as the reporter sees the project: a private field kept from them is one it doesn't have (D50).
  const given = resolveFieldsInput(scopeFields(s, view), project, input.fields, ctx.actor.user.id, today, zoneOf(ctx));
  await assertCanSetFields(ctx, project.id, given.map((g) => g.field.id), (id) => noSuchField(scopeFields(s, view), project, s.fields.get(id)?.name ?? id), db);
  // What a clone carries, of the private fields, only where its reporter could set them.
  const own = privateFieldIds(s, project.id);
  const setsPrivate = view.allows(project.id, 'readPrivate') && view.allows(project.id, 'editPrivate');
  const specs = [
    ...given,
    ...carry
      .filter((c) => !given.some((g) => g.field.id === c.field.id) && (setsPrivate || !own.has(c.field.id)))
      .map((c) => ({ field: c.field, mode: 'set' as const, values: c.values })),
  ];
  const pfs = s.projectFields.get(project.id) ?? [];
  const values = new Map<string, ResolvedValue[]>();
  for (const pf of pfs) {
    const field = s.fields.get(pf.fieldId);
    if (!field) continue;
    const given = specs.find((sp) => sp.field.id === field.id);
    if (given) values.set(field.id, given.values);
    else if (pf.defaultValue !== null && pf.defaultValue !== undefined) {
      values.set(field.id, resolveFieldInput(s, field, project.id, pf.defaultValue as string | string[], ctx.actor.user.id, today, zoneOf(ctx)));
    }
  }
  const owned = await ownerAssignment(
    db,
    s,
    project,
    specs,
    new Map(),
    [...values.entries()].flatMap(([fid, vals]) => (s.fields.get(fid) ? [{ field: s.fields.get(fid)!, values: vals }] : [])),
  );
  if (owned) values.set(owned.field.id, owned.values);
  for (const pf of pfs) {
    const field = s.fields.get(pf.fieldId);
    if (!field) continue;
    // A field required only while a condition holds is checked once the issue is written (D41).
    // A private field kept from the reporter isn't theirs to fill (D50).
    if (pf.required && !pf.condition && !(values.get(field.id)?.length) && seesField(view, s, project.id, field.id)) throw badRequest(`${field.name} is required in ${project.key}`).said('issues.fieldRequired', { field: field.name, project: project.key });
    if (field.type === 'user') {
      await assertPeopleSeeProject(db, s, project, field, (values.get(field.id) ?? []).map((v) => v.userId).filter((id): id is string => Boolean(id)));
    }
  }
  const resolved = [...values.entries()].some(([fid, vals]) => {
    const f = s.fields.get(fid);
    return f?.type === 'state' && vals.some((v) => (v.valueId ? s.values.get(v.valueId)?.isResolved : false));
  });

  const parent = input.parent ? await resolveIssue(ctx, input.parent, db) : undefined;
  const linkTargets = await Promise.all(
    (input.links ?? []).map(async (l) => ({ phrase: resolveLinkPhrase(s, l.relation), target: await resolveIssue(ctx, l.issue, db) })),
  );
  const subtaskPhrase = s.linkPhrases.find((p) => p.type.aggregation && p.direction === 'inward');
  if (parent && !subtaskPhrase) throw badRequest('No subtask link type is configured').said('issues.noSubtaskLinkType');
  const links: LinkSpec[] = linkTargets.map((l) => ({ phrase: l.phrase, target: l.target }));
  if (parent && subtaskPhrase) links.unshift({ phrase: subtaskPhrase, target: parent });
  const limits = await resolveVisibleTo(db, s, input.visibleTo);
  return { s, project, summary, description: input.description ?? '', specs, values, resolved, tags: input.tags ?? [], links, limits };
}

/** Write a prepared issue inside `tx`, with its activity. */
async function insertIssue(tx: Db, ctx: Ctx, p: PreparedIssue, opts: CreateOptions): Promise<{ issue: IssueRow; activities: ActivityRow[] }> {
  const { summary, values, specs } = p;
  let { s, project } = p;
  const imported = opts.imported;
  const activities: ActivityRow[] = [];
  const [{ number, key } = { number: 0, key: project.key }] = await tx
    .update(projects)
    .set({ nextNumber: sql`${projects.nextNumber} + 1` })
    .where(eq(projects.id, project.id))
    .returning({ number: sql<number>`${projects.nextNumber} - 1`, key: projects.key });
  // The project was renamed while this waited for its row (D52): read its key as it is now, so the
  // issue's own event names it as it is.
  if (key !== project.key) {
    ctx.app.schema.drop();
    s = await ctx.app.schema.get(tx);
    project = s.projects.get(project.id) ?? { ...project, key };
  }
  const id = newId();
  const now = new Date();
  const [row] = await tx
    .insert(issues)
    .values({
      id,
      projectId: project.id,
      number: Number(number),
      summary,
      description: p.description,
      reporterId: imported ? imported.reporterId : ctx.actor.user.id,
      updatedById: ctx.actor.user.id,
      ...(imported ? { createdAt: imported.createdAt, updatedAt: imported.updatedAt } : {}),
      resolvedAt: p.resolved ? (imported ? (imported.resolvedAt ?? imported.updatedAt) : now) : null,
      ...p.limits,
    })
    .returning();
  const fieldRowsToInsert = [...values.entries()].flatMap(([fieldId, vals]) => vals.map((v) => ({ issueId: id, fieldId, ...valueRow(v) })));
  if (fieldRowsToInsert.length) await tx.insert(issueFieldValues).values(fieldRowsToInsert);

  const fieldsPresentation: Record<string, string | null> = {};
  for (const [fid, vals] of values) {
    const f = s.fields.get(fid);
    if (f) fieldsPresentation[f.name] = presentValues(s, f, vals);
  }
  const tagRows = p.tags.length ? await ensureTags(tx, ctx, p.tags) : [];
  if (tagRows.length) {
    await tx
      .insert(issueTags)
      .values(tagRows.map((t) => ({ issueId: id, tagId: t.id })))
      .onConflictDoNothing();
  }
  // Its reporter, its assignee and the people its description mentions watch it, and the last
  // two are told. A help desk's requester mentions nobody. An imported issue comes in quietly:
  // its reporter there and its assignee watch it, and nobody is told (it's history, not news).
  const assigneeField = assigneeFieldOf(s);
  const assigned = assigneeField ? loginsOf(s, values.get(assigneeField.id)) : [];
  const fromOutside = ctx.actor.channel === 'helpdesk';
  const reporterLogin = imported ? (imported.reporterId ? s.users.get(imported.reporterId)?.login : undefined) : ctx.actor.user.login;
  const reporter = fromOutside || !reporterLogin ? [] : [reporterLogin];
  const mentionedIn = fromOutside || imported ? [] : mentionsIn(s, p.description);
  const seeing = await whoSees(tx, s, project.id, [...reporter, ...assigned, ...mentionedIn], row!);
  const mentions = mentionedIn.filter((l) => seeing.has(l.toLowerCase()));
  await addWatchers(
    tx,
    s,
    { id, projectId: project.id },
    [
      ...reporter.map((login) => ({ login, reason: 'reporter' as const })),
      ...assigned.map((login) => ({ login, reason: 'assignee' as const })),
      ...mentions.map((login) => ({ login, reason: 'mentioned' as const })),
    ],
    seeing,
  );
  const told = imported ? {} : { ...(assigned.length ? { assigned } : {}), ...(mentions.length ? { mentions } : {}) };
  const states = await stateNames(tx, s, [id]);
  activities.push(
    await recordActivity(tx, ctx, {
      type: 'issue.created',
      projectId: project.id,
      issueId: id,
      payload: {
        issue: issueRef(s, row!, states.get(id) ?? null),
        data: {
          summary,
          fields: fieldsPresentation,
          // Which fields the reporter chose (the rest are project defaults), so an
          // agent filling fields on its own never overrides a person's choice.
          explicitFields: specs.map((sp) => sp.field.name),
          tags: tagRows.map((t) => t.name),
          description: excerpt(p.description, 1000),
          ...(imported ? { imported: imported.data } : {}),
          ...told,
          ...(opts.data ?? {}),
        },
      },
    }),
  );

  let issue = row!;
  if (p.links.length) {
    const res = await applyChanges(tx, ctx, issue, { links: p.links, ...(imported ? { data: { imported: imported.data } } : {}) }, { guards: false });
    activities.push(...res.activities);
    issue = res.issue;
  }
  // A new issue has no "before": it must keep every guard it matches, or it isn't made at all.
  // An imported one is history, which the team's guards, made for new work, don't judge.
  if (!imported) {
    const view = await projectAccess(ctx, tx);
    await enforceRequiredWhen(tx, issue.id, requiredWhen(s, project.id).filter((n) => seesField(view, s, project.id, n.fieldId)), null);
  }
  if (!imported) {
    await enforceGuards(tx, ctx, s, guardChecks(ctx, s, project.id), null, issue);
    await enforceScriptGuards(tx, ctx, s, issue, changeOf('created', s.users.get(ctx.actor.user.id)), true);
  }
  await opts.inTransaction?.(tx, issue);
  return { issue, activities };
}

export async function createIssue(ctx: Ctx, input: CreateIssueInput, opts: CreateOptions = {}): Promise<IssueDetail> {
  requireScope(ctx, 'write');
  const prepared = await prepareIssue(ctx, input, ctx.db, opts.carry);
  const { issue: created, activities } = await ctx.db.transaction(async (txRaw) => insertIssue(txRaw as unknown as Db, ctx, prepared, opts));
  await publishActivities(ctx.app, activities);
  ctx.app.hooks.onIssueCreated?.(created.id, ctx.actor);
  return issueDetail(ctx, created);
}

/**
 * Create an issue inside the caller's transaction, as an import does, so the issue and what records
 * where it came from commit together. The caller publishes the activities after its commit; no hook
 * runs (an imported issue is not new work to triage).
 */
export async function createIssueInTx(tx: Db, ctx: Ctx, input: CreateIssueInput, opts: CreateOptions = {}): Promise<{ issue: IssueRow; activities: ActivityRow[] }> {
  requireScope(ctx, 'write');
  return insertIssue(tx, ctx, await prepareIssue(ctx, input, tx, opts.carry), opts);
}

export async function updateIssue(ctx: Ctx, idOrReadable: string, input: UpdateIssueInput, opts: { data?: Record<string, unknown> } = {}): Promise<IssueDetail> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const issue = await resolveIssue(ctx, idOrReadable);
  const project = s.projects.get(issue.projectId)!;
  const spec: ChangeSpec = {
    summary: input.summary,
    description: input.description,
    // Named as the caller sees the project: a private field kept from them is one it doesn't have (D50).
    fields: resolveFieldsInput(scopeFields(s, await projectAccess(ctx)), project, input.fields, ctx.actor.user.id, todayIn(zoneOf(ctx)), zoneOf(ctx)),
    addTags: input.addTags,
    removeTags: input.removeTags,
    expectedVersion: input.expectedVersion,
    data: opts.data,
  };
  const result = await ctx.db.transaction(async (tx) => applyChanges(tx as unknown as Db, ctx, issue, spec));
  await publishActivities(ctx.app, result.activities);
  return issueDetail(ctx, result.issue);
}

/**
 * Limit who sees an issue to some people and groups, or lift the limit (D37). A change to the issue
 * like any other: through applyChanges, in its history, with its version.
 */
export async function setIssueVisibility(ctx: Ctx, idOrReadable: string, input: { visibleTo: VisibleToInput | null; expectedVersion?: number }): Promise<IssueDetail> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const issue = await resolveIssue(ctx, idOrReadable);
  const visibleTo = await resolveVisibleTo(ctx.db, s, input.visibleTo);
  const result = await ctx.db.transaction(async (tx) => applyChanges(tx as unknown as Db, ctx, issue, { visibleTo, expectedVersion: input.expectedVersion }));
  await publishActivities(ctx.app, result.activities);
  return issueDetail(ctx, result.issue);
}

export async function deleteIssue(ctx: Ctx, idOrReadable: string): Promise<void> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const issue = await resolveIssue(ctx, idOrReadable);
  await assertCanProject(ctx, issue.projectId, 'delete');
  const states = await stateNames(ctx.db, s, [issue.id]);
  const ref: IssueRef = issueRef(s, issue, states.get(issue.id) ?? null);
  const activity = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    // Its watchers are told it's gone; their rows go with it, so the activity names them.
    const watchers = (await watcherIds(tx, issue.id)).map((id) => s.users.get(id)?.login).filter((l): l is string => Boolean(l));
    // What was limited, kept before the rows that say so go, so its history stays as hidden (D37).
    const gone = await goneLimitsOf(tx, s, issue);
    await tx.delete(issues).where(eq(issues.id, issue.id));
    return recordActivity(tx, ctx, {
      type: 'issue.deleted',
      projectId: issue.projectId,
      issueId: null,
      // Limited (D37), it stays as hidden once gone: only who saw all of its project see that it went.
      payload: {
        issue: ref,
        ...(watchers.length || issue.limited ? { data: { ...(watchers.length ? { watchers } : {}), ...(issue.limited ? { limited: true } : {}) } } : {}),
        ...(gone ? { gone } : {}),
      },
    });
  });
  await publishActivities(ctx.app, [activity]);
}
