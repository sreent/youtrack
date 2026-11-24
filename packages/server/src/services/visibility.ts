import type { VisibleTo, VisibleToInput } from '@a4a/shared';
import { inArray, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { groups } from '../db/schema';
import { badRequest } from '../lib/errors';
import type { SchemaSnapshot } from './schema-cache';
import { userRefDto } from './values';

/**
 * Who an issue or a comment is limited to (D37). Not limited, everyone who sees its project (its
 * issue, for a comment) sees it. Limited, only the people and groups named, besides the few who
 * always do: administrators, the project's managers, and an issue's reporter and assignee or a
 * comment's author. The check itself is services/access.ts's.
 */
export interface Limits {
  limited: boolean;
  visibleUserIds: string[];
  visibleGroupIds: string[];
}

export const UNLIMITED: Limits = { limited: false, visibleUserIds: [], visibleGroupIds: [] };

/** The limits an input asks for, checked: people by login, groups by id or name. Null: no limit. */
export async function resolveVisibleTo(db: Db, s: SchemaSnapshot, input: VisibleToInput | null | undefined): Promise<Limits> {
  if (!input) return UNLIMITED;
  const userIds: string[] = [];
  const unknown: string[] = [];
  for (const raw of input.users ?? []) {
    const u = s.usersByLogin.get(raw.trim().replace(/^@/, '').toLowerCase());
    if (!u) unknown.push(raw);
    else if (!userIds.includes(u.id)) userIds.push(u.id);
  }
  if (unknown.length) throw badRequest(`No one has the login ${unknown.join(', ')}`, 'Name people by their login, as in an @-mention.').said('visibility.unknownLogins', { unknown });
  const refs = [...new Set((input.groups ?? []).map((g) => g.trim()).filter(Boolean))];
  const groupIds: string[] = [];
  if (refs.length) {
    const found = await db
      .select({ id: groups.id, name: groups.name })
      .from(groups)
      .where(or(inArray(groups.id, refs), inArray(sql`lower(${groups.name})`, refs.map((r) => r.toLowerCase()))));
    const missing = refs.filter((r) => !found.some((g) => g.id === r || g.name.toLowerCase() === r.toLowerCase()));
    if (missing.length) throw badRequest(`No group is called ${missing.join(', ')}`, 'Name groups as Administration › Groups lists them, or by id.').said('visibility.unknownGroups', { missing });
    for (const g of found) if (!groupIds.includes(g.id)) groupIds.push(g.id);
  }
  return { limited: true, visibleUserIds: userIds, visibleGroupIds: groupIds };
}

export function sameLimits(a: Limits, b: Limits): boolean {
  if (a.limited !== b.limited) return false;
  if (!a.limited) return true;
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((v) => y.includes(v));
  return same(a.visibleUserIds, b.visibleUserIds) && same(a.visibleGroupIds, b.visibleGroupIds);
}

async function groupNames(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await db.select({ id: groups.id, name: groups.name }).from(groups).where(inArray(groups.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Each row's limits as the API shows them, null when it isn't limited. One query for all of them. */
export async function visibleToDtos(db: Db, s: SchemaSnapshot, rows: readonly Limits[]): Promise<(VisibleTo | null)[]> {
  const names = await groupNames(
    db,
    rows.flatMap((r) => (r.limited ? r.visibleGroupIds : [])),
  );
  return rows.map((r) =>
    r.limited
      ? {
          users: r.visibleUserIds
            .map((id) => s.users.get(id))
            .filter((u): u is NonNullable<typeof u> => Boolean(u))
            .map(userRefDto),
          groups: r.visibleGroupIds.filter((id) => names.has(id)).map((id) => ({ id, name: names.get(id)! })),
        }
      : null,
  );
}

/** Limits in words, for an issue's history: null when it isn't limited. */
export async function describeLimits(db: Db, s: SchemaSnapshot, l: Limits): Promise<string | null> {
  if (!l.limited) return null;
  const [dto] = await visibleToDtos(db, s, [l]);
  const named = [...(dto?.users.map((u) => u.name) ?? []), ...(dto?.groups.map((g) => g.name) ?? [])];
  return named.length ? named.join(', ') : 'Only those who always see it';
}
