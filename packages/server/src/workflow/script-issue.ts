/**
 * What a workflow script is given (docs/architecture.md, D40): the issue it runs on, what happened
 * to it, and its project, as plain data. It is read on whichever connection the caller holds: a
 * guard runs inside the write path's transaction, before commit, and reads the issue as the change
 * left it there (on PGlite, which has one connection, reading on the pool would wait on itself).
 *
 * A script reads only what the rule's own project holds: issues linked to it from another project
 * are left out, as a rule reads only its project (match.ts, ruleWorld).
 */
import type { Change } from '@a4a/shared';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Db } from '../db/client';
import { comments, issueFieldValues, issueLinks, issues, issueTags, tags } from '../db/schema';
import { readableId, stateNames, type IssueRow } from '../services/issue-refs';
import type { FieldRow, SchemaSnapshot, UserRow } from '../services/schema-cache';
import { rowToResolved, type ResolvedValue } from '../services/values';

/** Comments a script sees: the latest ones. */
export const SCRIPT_COMMENTS = 20;
/** Linked issues a script sees, at most. */
export const SCRIPT_LINKS = 100;

export type ScriptValue = string | number | null;

export interface ScriptRelated {
  id: string;
  summary: string;
  state: string | null;
  resolved: boolean;
}

export interface ScriptIssue {
  id: string;
  summary: string;
  description: string;
  project: string;
  /** Each of the project's fields by name: one value, or a list for a field of several. */
  fields: Record<string, ScriptValue | ScriptValue[]>;
  tags: string[];
  resolved: boolean;
  reporter: string | null;
  created: string;
  updated: string;
  links: (ScriptRelated & { phrase: string })[];
  parent: ScriptRelated | null;
  subtasks: ScriptRelated[];
  comments: { author: string | null; text: string; created: string }[];
}

export interface ScriptChange {
  /** What happened: the issue was created, changed or commented on; a scheduled turn; an action someone ran; a test run. */
  kind: 'created' | 'updated' | 'commented' | 'scheduled' | 'action' | 'test';
  by: { login: string; name: string; agent: boolean } | null;
  changes: { field: string; from: string | null; to: string | null }[];
  comment: string | null;
  action: string | null;
}

export interface ScriptInput {
  issue: ScriptIssue;
  change: ScriptChange;
  project: { key: string; name: string };
}

/** One value as a script reads it: names for values and people (their login), numbers as numbers, a period in minutes, a date as YYYY-MM-DD. */
function valueOf(s: SchemaSnapshot, field: FieldRow, r: ResolvedValue): ScriptValue {
  switch (field.type) {
    case 'enum':
    case 'state':
    case 'version':
      return r.valueId ? (s.values.get(r.valueId)?.name ?? null) : null;
    case 'user':
      return r.userId ? (s.users.get(r.userId)?.login ?? null) : null;
    case 'string':
    case 'text':
      return r.textValue ?? null;
    case 'date':
      return r.dateValue ?? null;
    default:
      return r.numberValue ?? null;
  }
}

export function byOf(user: UserRow | undefined | null): ScriptChange['by'] {
  return user ? { login: user.login, name: user.name, agent: user.isBot } : null;
}

export function changeOf(kind: ScriptChange['kind'], by: UserRow | undefined | null, changes: Change[] = [], extra: { comment?: string | null; action?: string | null } = {}): ScriptChange {
  return {
    kind,
    by: byOf(by),
    changes: changes.filter((c) => c.field !== 'Comment').map((c) => ({ field: c.field, from: c.from ?? null, to: c.to ?? null })),
    comment: extra.comment ?? null,
    action: extra.action ?? null,
  };
}

/** The issue as a script reads it, from `db` (inside a transaction, the transaction). */
export async function scriptIssue(db: Db, s: SchemaSnapshot, issue: IssueRow): Promise<ScriptIssue> {
  const project = s.projects.get(issue.projectId);
  const valueRows = await db.select().from(issueFieldValues).where(eq(issueFieldValues.issueId, issue.id));
  const fields: ScriptIssue['fields'] = {};
  for (const pf of s.projectFields.get(issue.projectId) ?? []) {
    const field = s.fields.get(pf.fieldId);
    if (!field) continue;
    const values = valueRows
      .filter((r) => r.fieldId === field.id)
      .map((r) => valueOf(s, field, rowToResolved(r)))
      .filter((v) => v !== null);
    fields[field.name] = field.multi ? values : (values[0] ?? null);
  }
  const tagRows = await db.select({ name: tags.name }).from(issueTags).innerJoin(tags, eq(tags.id, issueTags.tagId)).where(eq(issueTags.issueId, issue.id));

  // Links, within the project: a parent, subtasks, and the rest by how they read from this issue.
  const linkRows = await db
    .select()
    .from(issueLinks)
    .where(or(eq(issueLinks.sourceId, issue.id), eq(issueLinks.targetId, issue.id)))
    .limit(SCRIPT_LINKS);
  const otherIds = [...new Set(linkRows.map((r) => (r.sourceId === issue.id ? r.targetId : r.sourceId)))];
  const others = otherIds.length
    ? await db
        .select()
        .from(issues)
        .where(and(inArray(issues.id, otherIds), eq(issues.projectId, issue.projectId)))
    : [];
  const states = await stateNames(db, s, others.map((o) => o.id));
  const related = new Map(
    others.map((o): [string, ScriptRelated] => [o.id, { id: readableId(s, o), summary: o.summary, state: states.get(o.id) ?? null, resolved: o.resolvedAt !== null }]),
  );
  let parent: ScriptRelated | null = null;
  const subtasks: ScriptRelated[] = [];
  const links: ScriptIssue['links'] = [];
  for (const r of linkRows) {
    const type = s.linkTypes.find((t) => t.id === r.typeId);
    const outward = r.sourceId === issue.id;
    const other = related.get(outward ? r.targetId : r.sourceId);
    if (!type || !other) continue;
    if (type.aggregation) {
      // The source of a subtask link is the parent.
      if (outward) subtasks.push(other);
      else parent = other;
      continue;
    }
    links.push({ phrase: outward || !type.directed ? type.outward : type.inward, ...other });
  }

  const commentRows = await db
    .select({ authorId: comments.authorId, text: comments.text, createdAt: comments.createdAt })
    .from(comments)
    .where(and(eq(comments.issueId, issue.id), isNull(comments.deletedAt)))
    .orderBy(desc(comments.createdAt))
    .limit(SCRIPT_COMMENTS);

  return {
    id: readableId(s, issue),
    summary: issue.summary,
    description: issue.description,
    project: project?.key ?? '?',
    fields,
    tags: tagRows.map((t) => t.name),
    resolved: issue.resolvedAt !== null,
    reporter: issue.reporterId ? (s.users.get(issue.reporterId)?.login ?? null) : null,
    created: issue.createdAt.toISOString(),
    updated: issue.updatedAt.toISOString(),
    links,
    parent,
    subtasks,
    comments: commentRows.reverse().map((c) => ({ author: c.authorId ? (s.users.get(c.authorId)?.login ?? null) : null, text: c.text, created: c.createdAt.toISOString() })),
  };
}

export async function scriptInput(db: Db, s: SchemaSnapshot, issue: IssueRow, change: ScriptChange): Promise<ScriptInput> {
  const project = s.projects.get(issue.projectId);
  return { issue: await scriptIssue(db, s, issue), change, project: { key: project?.key ?? '?', name: project?.name ?? '?' } };
}

/**
 * The issues a script may apply a command to besides its own: those linked to it in any way
 * (its parent, its subtasks, the rest), in its project. By readable id.
 */
export function reachable(input: ScriptIssue): Set<string> {
  return new Set([...input.links.map((l) => l.id), ...(input.parent ? [input.parent.id] : []), ...input.subtasks.map((t) => t.id)]);
}
