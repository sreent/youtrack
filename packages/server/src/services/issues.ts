import {
  type Change,
  type CreateIssueInput,
  type FieldsInputT,
  type Issue,
  type IssueDetail,
  type IssueField,
  type IssueLink,
  type IssueRef,
  type UpdateIssueInput,
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
  assertCanReadProject,
  assertCanWriteProject,
  canReadProject,
  projectAccess,
  projectRolesOf,
} from './access';
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
import {
  fieldValueDto,
  presentValues,
  resolveFieldInput,
  rowToResolved,
  sameValues,
  userRefDto,
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
    return row;
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
  if (!row) throw notFound(`Issue ${idOrReadable}`, 'Use a readable id such as BACK-12.');
  return row;
}

/** The issue if it exists and the caller may read it; otherwise undefined, whichever it is. */
export async function findVisibleIssue(ctx: Ctx, idOrReadable: string, db: Db = ctx.db): Promise<IssueRow | undefined> {
  const s = await ctx.app.schema.get(db);
  const row = await findIssue(db, s, idOrReadable);
  if (!row || !(await canReadProject(ctx, row.projectId, db))) return undefined;
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

function buildFields(s: SchemaSnapshot, projectId: string, values: Map<string, ResolvedValue[]>): IssueField[] {
  return projectFieldList(s, projectId).map((f) => ({
    fieldId: f.id,
    name: f.name,
    type: f.type,
    multi: f.multi,
    value: fieldValueDto(s, f, values.get(f.id) ?? []),
  }));
}

/** Batch-map issue rows to list DTOs, preserving order. */
export async function issueDtos(ctx: Ctx, rows: IssueRow[]): Promise<Issue[]> {
  if (!rows.length) return [];
  const s = await ctx.app.schema.get();
  const ids = rows.map((r) => r.id);
  const [fieldRows, tagRows, commentCounts] = await Promise.all([
    loadFieldRows(ctx.db, ids),
    ctx.db
      .select({ issueId: issueTags.issueId, tagId: issueTags.tagId })
      .from(issueTags)
      .where(inArray(issueTags.issueId, ids)),
    ctx.db
      .select({ issueId: comments.issueId, n: sql<number>`count(*)::int` })
      .from(comments)
      .where(and(inArray(comments.issueId, ids), isNull(comments.deletedAt)))
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
      fields: buildFields(s, r.projectId, fieldRows.get(r.id) ?? new Map()),
      tags: (tagsByIssue.get(r.id) ?? [])
        .map((id) => s.tags.get(id))
        .filter((t): t is NonNullable<typeof t> => Boolean(t))
        .map(tagDto),
      commentCount: counts.get(r.id) ?? 0,
    };
  });
}

/** An issue's links, leaving out those whose other end the caller can't see. */
export async function issueLinksOf(ctx: Ctx, issueId: string): Promise<IssueLink[]> {
  const s = await ctx.app.schema.get();
  const view = await projectAccess(ctx);
  const rows = await ctx.db
    .select()
    .from(issueLinks)
    .where(or(eq(issueLinks.sourceId, issueId), eq(issueLinks.targetId, issueId)));
  const otherIds = rows.map((r) => (r.sourceId === issueId ? r.targetId : r.sourceId));
  const others = otherIds.length ? await ctx.db.select({ id: issues.id, projectId: issues.projectId }).from(issues).where(inArray(issues.id, otherIds)) : [];
  const seen = new Set(others.filter((o) => view.canRead(o.projectId)).map((o) => o.id));
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
  const [links, spent, pending] = await Promise.all([
    issueLinksOf(ctx, row.id),
    ctx.db
      .select({ total: sql<number>`coalesce(sum(${workItems.minutes}), 0)::int` })
      .from(workItems)
      .where(eq(workItems.issueId, row.id)),
    ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(aiSuggestions)
      .where(and(eq(aiSuggestions.issueId, row.id), eq(aiSuggestions.status, 'pending'))),
  ]);
  const aggregation = new Set(s.linkTypes.filter((t) => t.aggregation).map((t) => t.id));
  const parentLink = links.find((l) => aggregation.has(l.typeId) && l.direction === 'inward');
  const subtasks = links.filter((l) => aggregation.has(l.typeId) && l.direction === 'outward').map((l) => l.issue);
  const updatedBy = row.updatedById ? s.users.get(row.updatedById) : undefined;
  return {
    ...base!,
    description: row.description,
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
): FieldChangeSpec[] {
  if (!input) return [];
  const attached = new Set((s.projectFields.get(project.id) ?? []).map((pf) => pf.fieldId));
  const out: FieldChangeSpec[] = [];
  for (const [name, raw] of Object.entries(input)) {
    const field = fieldByName(s, name);
    if (!field || !attached.has(field.id)) {
      const names = projectFieldList(s, project.id).map((f) => f.name);
      throw badRequest(`Project ${project.key} has no field "${name}"`, `Fields: ${names.join(', ')}`);
    }
    out.push({ field, mode: 'set', values: resolveFieldInput(s, field, project.id, raw, meId) });
  }
  return out;
}

export function resolveLinkPhrase(s: SchemaSnapshot, relation: string): LinkPhrase {
  const lower = relation.trim().toLowerCase().replace(/\s+/g, ' ');
  const found = s.linkPhrases.find((p) => p.phrase === lower) ?? s.linkPhrases.find((p) => p.type.name.toLowerCase() === lower);
  if (!found) {
    throw badRequest(
      `Unknown link relation "${relation}"`,
      `Use one of: ${[...new Set(s.linkPhrases.map((p) => p.display))].join(', ')}`,
    );
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
 * is written and the returned changes describe what would happen.
 */
export async function applyChanges(
  tx: Db,
  ctx: Ctx,
  stale: IssueRow,
  spec: ChangeSpec,
  opts: { dryRun?: boolean } = {},
): Promise<ApplyResult> {
  const s = await ctx.app.schema.get(tx);
  // Lock the issue row for the rest of the transaction so concurrent changes to the
  // same issue serialise (no lost updates on multi-value fields or tags), and work
  // from the row as it is now rather than as the caller last read it.
  const lockedRows = opts.dryRun
    ? await tx.select().from(issues).where(eq(issues.id, stale.id))
    : await tx.select().from(issues).where(eq(issues.id, stale.id)).for('update');
  const issue = lockedRows[0];
  if (!issue) throw notFound(`Issue ${readableId(s, stale)}`);
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
    );
  }
  const changes: Change[] = [];
  const current = await fieldValuesOf(tx, issue.id);
  const pfs = s.projectFields.get(project.id) ?? [];
  const fieldUpdates: { field: FieldRow; values: ResolvedValue[] }[] = [];

  for (const fs of spec.fields ?? []) {
    const before = current.get(fs.field.id) ?? [];
    const after = mergeValues(fs.field, before, fs);
    if (sameValues(before, after)) continue;
    const pf = pfs.find((p) => p.fieldId === fs.field.id);
    if (pf?.required && after.length === 0) throw badRequest(`${fs.field.name} is required in ${project.key}`);
    if (fs.field.type === 'user') {
      const added = after.map((v) => v.userId).filter((id): id is string => Boolean(id) && !before.some((b) => b.userId === id));
      await assertPeopleSeeProject(tx, s, project, fs.field, added);
    }
    fieldUpdates.push({ field: fs.field, values: after });
    changes.push({ field: fs.field.name, from: presentValues(s, fs.field, before), to: presentValues(s, fs.field, after) });
  }

  const patch: Partial<typeof issues.$inferInsert> = {};
  if (spec.summary !== undefined && spec.summary.trim() !== issue.summary) {
    const summary = spec.summary.trim();
    if (!summary) throw badRequest('Summary cannot be empty');
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
    if (l.target.id === issue.id) throw badRequest('An issue cannot be linked to itself');
    // A link shows on both issues and changes both histories, so it needs both: never reveal
    // an issue the caller can't see, and never change one they may only read.
    if (!(await canReadProject(ctx, l.target.projectId, tx))) throw notFound(`Issue ${readableId(s, l.target)}`);
    if (!opts.dryRun) {
      await assertCanWriteProject(ctx, l.target.projectId, tx).catch((e: unknown) => {
        if (e instanceof AppError && e.status === 403) {
          throw forbidden(`${e.message}, and a link changes ${readableId(s, l.target)} too`, e.hint);
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
        if (parent.length) throw badRequest(`${readableId(s, issue)} already has a parent`, 'Remove the existing "subtask of" link first.');
      }
      linkOps.push({ spec: l, endpoints, existingId });
      changes.push({
        field: 'Links',
        from: l.remove ? `${l.phrase.display} ${readableId(s, l.target)}` : null,
        to: l.remove ? null : `${l.phrase.display} ${readableId(s, l.target)}`,
      });
    }
  }

  const comment = spec.comment?.trim();
  if (comment) changes.push({ field: 'Comment', from: null, to: excerpt(comment, 200) });

  if (opts.dryRun || !changes.length) return { changes, activities: [], issue };

  // ---- write ---------------------------------------------------------------
  const activities: ActivityRow[] = [];
  for (const u of fieldUpdates) {
    await tx.delete(issueFieldValues).where(and(eq(issueFieldValues.issueId, issue.id), eq(issueFieldValues.fieldId, u.field.id)));
    if (u.values.length) {
      await tx.insert(issueFieldValues).values(u.values.map((v) => ({ issueId: issue.id, fieldId: u.field.id, ...v })));
    }
  }
  if (toAdd.length) {
    const rows = await ensureTags(tx, ctx, toAdd);
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
    throw conflict(`${readableId(s, issue)} changed while it was being updated`, 'Retry the change.');
  }
  const states = await stateNames(tx, s, [issue.id]);
  const ref = issueRef(s, updated!, states.get(issue.id) ?? null);

  if (fieldOrMetaChanged) {
    activities.push(
      await recordActivity(tx, ctx, {
        type: 'issue.updated',
        projectId: issue.projectId,
        issueId: issue.id,
        payload: { issue: ref, changes: changes.filter((c) => c.field !== 'Links' && c.field !== 'Comment'), ...(spec.data ? { data: spec.data } : {}) },
      }),
    );
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
    activities.push(
      await recordActivity(tx, ctx, {
        type,
        projectId: issue.projectId,
        issueId: issue.id,
        payload: { issue: ref, data: { ...spec.data, phrase: op.spec.phrase.display, target: targetRef } },
      }),
    );
    activities.push(
      await recordActivity(tx, ctx, {
        type,
        projectId: op.spec.target.projectId,
        issueId: op.spec.target.id,
        payload: { issue: targetRef, data: { ...spec.data, phrase: inverse, target: ref } },
      }),
    );
  }

  if (comment) {
    const id = newId();
    await tx.insert(comments).values({ id, issueId: issue.id, authorId: ctx.actor.user.id, text: comment, channel: ctx.actor.channel });
    activities.push(
      await recordActivity(tx, ctx, {
        type: 'comment.created',
        projectId: issue.projectId,
        issueId: issue.id,
        payload: { issue: ref, data: { ...spec.data, commentId: id, text: excerpt(comment, 1000) } },
      }),
    );
  }

  return { changes, activities, issue: updated! };
}

function isCommentOnly(spec: ChangeSpec): boolean {
  return (
    Boolean(spec.comment?.trim()) &&
    spec.summary === undefined &&
    spec.description === undefined &&
    !spec.fields?.length &&
    !spec.addTags?.length &&
    !spec.removeTags?.length &&
    !spec.links?.length
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
    `${names} can't see ${project.key}, so can't be its ${field.name}`,
    `Only ${project.key}'s people see it. Add ${outside.length === 1 ? 'them' : 'each of them'} to the project first, or choose someone who is in it.`,
  );
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
}

/** Everything a new issue needs, checked, before anything is written. Reads through `db`. */
async function prepareIssue(ctx: Ctx, input: CreateIssueInput, db: Db): Promise<PreparedIssue> {
  const s = await ctx.app.schema.get(db);
  const view = await projectAccess(ctx, db);
  const project = projectByKey(s, input.project);
  if (!project || !view.canRead(project.id)) {
    // Only the projects the caller can file in: a hidden project's key is never named.
    const open = [...s.projects.values()].filter((p) => view.canWrite(p.id) && !p.archived).map((p) => p.key);
    throw notFound(`Project ${input.project}`, open.length ? `Projects you can file in: ${open.join(', ')}` : 'You can file issues in no project yet.');
  }
  await assertCanWriteProject(ctx, project.id, db);
  if (project.archived) throw badRequest(`Project ${project.key} is archived`);
  const summary = input.summary.trim();
  if (!summary) throw badRequest('Summary cannot be empty');

  const specs = resolveFieldsInput(s, project, input.fields, ctx.actor.user.id);
  const pfs = s.projectFields.get(project.id) ?? [];
  const values = new Map<string, ResolvedValue[]>();
  for (const pf of pfs) {
    const field = s.fields.get(pf.fieldId);
    if (!field) continue;
    const given = specs.find((sp) => sp.field.id === field.id);
    if (given) values.set(field.id, given.values);
    else if (pf.defaultValue !== null && pf.defaultValue !== undefined) {
      values.set(field.id, resolveFieldInput(s, field, project.id, pf.defaultValue as string | string[], ctx.actor.user.id));
    }
    if (pf.required && !(values.get(field.id)?.length)) throw badRequest(`${field.name} is required in ${project.key}`);
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
  if (parent && !subtaskPhrase) throw badRequest('No subtask link type is configured');
  const links: LinkSpec[] = linkTargets.map((l) => ({ phrase: l.phrase, target: l.target }));
  if (parent && subtaskPhrase) links.unshift({ phrase: subtaskPhrase, target: parent });
  return { s, project, summary, description: input.description ?? '', specs, values, resolved, tags: input.tags ?? [], links };
}

/** Write a prepared issue inside `tx`, with its activity. */
async function insertIssue(tx: Db, ctx: Ctx, p: PreparedIssue, opts: CreateOptions): Promise<{ issue: IssueRow; activities: ActivityRow[] }> {
  const { s, project, summary, values, specs } = p;
  const imported = opts.imported;
  const activities: ActivityRow[] = [];
  const [{ number } = { number: 0 }] = await tx
    .update(projects)
    .set({ nextNumber: sql`${projects.nextNumber} + 1` })
    .where(eq(projects.id, project.id))
    .returning({ number: sql<number>`${projects.nextNumber} - 1` });
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
    })
    .returning();
  const fieldRowsToInsert = [...values.entries()].flatMap(([fieldId, vals]) => vals.map((v) => ({ issueId: id, fieldId, ...v })));
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
        },
      },
    }),
  );

  if (p.links.length) {
    const res = await applyChanges(tx, ctx, row!, { links: p.links, ...(imported ? { data: { imported: imported.data } } : {}) });
    activities.push(...res.activities);
    return { issue: res.issue, activities };
  }
  return { issue: row!, activities };
}

export async function createIssue(ctx: Ctx, input: CreateIssueInput, opts: CreateOptions = {}): Promise<IssueDetail> {
  requireScope(ctx, 'write');
  const prepared = await prepareIssue(ctx, input, ctx.db);
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
  return insertIssue(tx, ctx, await prepareIssue(ctx, input, tx), opts);
}

export async function updateIssue(ctx: Ctx, idOrReadable: string, input: UpdateIssueInput, opts: { data?: Record<string, unknown> } = {}): Promise<IssueDetail> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const issue = await resolveIssue(ctx, idOrReadable);
  const project = s.projects.get(issue.projectId)!;
  const spec: ChangeSpec = {
    summary: input.summary,
    description: input.description,
    fields: resolveFieldsInput(s, project, input.fields, ctx.actor.user.id),
    addTags: input.addTags,
    removeTags: input.removeTags,
    expectedVersion: input.expectedVersion,
    data: opts.data,
  };
  const result = await ctx.db.transaction(async (tx) => applyChanges(tx as unknown as Db, ctx, issue, spec));
  await publishActivities(ctx.app, result.activities);
  return issueDetail(ctx, result.issue);
}

export async function deleteIssue(ctx: Ctx, idOrReadable: string): Promise<void> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const issue = await resolveIssue(ctx, idOrReadable);
  await assertCanWriteProject(ctx, issue.projectId);
  const states = await stateNames(ctx.db, s, [issue.id]);
  const ref: IssueRef = issueRef(s, issue, states.get(issue.id) ?? null);
  const activity = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.delete(issues).where(eq(issues.id, issue.id));
    return recordActivity(tx, ctx, { type: 'issue.deleted', projectId: issue.projectId, issueId: null, payload: { issue: ref } });
  });
  await publishActivities(ctx.app, [activity]);
}
