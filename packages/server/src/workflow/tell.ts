/**
 * Whom a rule tells about an issue it acts on: its assignee, its reporter, its watchers, the
 * project's managers (its lead and its people with the manager role, their own or a group's; not
 * every administrator), and
 * people the rule names. Never an agent or a banned account, never whoever set the rule off (as the
 * notifier never tells whoever acted), and only people who can see the issue as they would signing
 * in (services/access.ts). The notifier checks that again when it delivers.
 */
import type { RuleNotify } from '@a4a/shared';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { UserRow } from '../context';
import type { Db } from '../db/client';
import { groupMembers, issueFieldValues, projectGroupRoles, projectMembers } from '../db/schema';
import { projectRolesOf } from '../services/access';
import type { IssueRow } from '../services/issues';
import type { SchemaSnapshot } from '../services/schema-cache';
import { assigneeFieldOf, watcherIds } from '../services/watchers';

export async function recipientsFor(
  db: Db,
  s: SchemaSnapshot,
  notify: Pick<RuleNotify, 'to' | 'people'>,
  issue: IssueRow,
  opts: { exclude?: string | null } = {},
): Promise<UserRow[]> {
  const ids = new Set<string>();
  const to = new Set(notify.to);
  if (to.has('assignee')) {
    const field = assigneeFieldOf(s);
    if (field) {
      const rows = await db
        .select({ userId: issueFieldValues.userId })
        .from(issueFieldValues)
        .where(and(eq(issueFieldValues.issueId, issue.id), eq(issueFieldValues.fieldId, field.id), isNotNull(issueFieldValues.userId)));
      for (const r of rows) if (r.userId) ids.add(r.userId);
    }
  }
  if (to.has('reporter') && issue.reporterId) ids.add(issue.reporterId);
  if (to.has('watchers')) for (const id of await watcherIds(db, issue.id)) ids.add(id);
  if (to.has('managers')) {
    const lead = s.projects.get(issue.projectId)?.leadId;
    if (lead) ids.add(lead);
    const rows = await db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, issue.projectId), eq(projectMembers.role, 'manager')));
    for (const r of rows) ids.add(r.userId);
    // Managers by a group's role count as managers by their own (D27).
    const viaGroups = await db
      .select({ userId: groupMembers.userId })
      .from(projectGroupRoles)
      .innerJoin(groupMembers, eq(groupMembers.groupId, projectGroupRoles.groupId))
      .where(and(eq(projectGroupRoles.projectId, issue.projectId), eq(projectGroupRoles.role, 'manager')));
    for (const r of viaGroups) ids.add(r.userId);
  }
  for (const login of notify.people) {
    const u = s.usersByLogin.get(login.trim().toLowerCase());
    if (u) ids.add(u.id);
  }
  if (opts.exclude) ids.delete(opts.exclude);
  const people = [...ids].map((id) => s.users.get(id)).filter((u): u is UserRow => Boolean(u && !u.isBot && !u.banned));
  if (!people.length) return [];
  const seeing = await projectRolesOf(db, issue.projectId, people.map((u) => u.id));
  return people.filter((u) => seeing.has(u.id)).sort((a, b) => a.name.localeCompare(b.name));
}

/** Who among `ids` is in the set the rule reads, for a project's rule naming people who can't see it. */
export async function seeingProject(db: Db, projectId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  return new Set((await projectRolesOf(db, projectId, ids)).keys());
}

/** Logins as typed, tidied: trimmed, without @, each once. */
export function tidyLogins(people: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of people) {
    const login = raw.trim().replace(/^@/, '');
    if (!login || seen.has(login.toLowerCase())) continue;
    seen.add(login.toLowerCase());
    out.push(login);
  }
  return out;
}
