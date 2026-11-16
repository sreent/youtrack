/**
 * Days away (docs/architecture.md, D36): a person's whole days, or the morning or afternoon of a
 * day, when plans skip their work. Anyone who may read sees when someone is away, as a team's
 * calendar does; why (the kind and the note) only the person, administrators and whoever entered
 * it. A person enters their own; a manager of a project someone works in, or an administrator,
 * may enter them for that person. They aren't events: the feed would tell everyone who can read
 * it when someone is away, so who entered each and when is kept on it.
 */
import {
  MAX_ABSENCE_DAYS,
  type Absence,
  type AbsenceHalf,
  type AbsenceKind,
  type CreateAbsenceInput,
  type LoadWindow,
  type Preferences,
  type UpdateAbsenceInput,
} from '@a4a/shared';
import { and, asc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import { can, isAdmin, requireScope, type Ctx, type UserRow } from '../context';
import type { Db } from '../db/client';
import { absences, userPreferences } from '../db/schema';
import { addDays, diffDays, todayISO } from '../lib/dates';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import type { PlanAbsence } from '../planning';
import { AWAY_LOOK_AHEAD_DAYS, AWAY_LOOK_BACK_DAYS } from '../planning/availability';
import { accessFor, projectAccess } from './access';
import { findUser } from './schema-cache';
import { userRefDto } from './values';
import { requirePersonal } from './watchers';

type AbsenceRow = typeof absences.$inferSelect;

/** By default a list starts a month back, so the days just past are still there to correct. */
const LIST_LOOK_BACK_DAYS = 31;

// ---------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------

/**
 * Whether the caller may enter, change and remove days away for `user`: their own; anyone's, as
 * an administrator; or, as a manager of a project, those of people who work in it (may change
 * its issues, as they would signing in).
 */
export async function mayEnterFor(ctx: Ctx, user: UserRow, db: Db = ctx.db): Promise<boolean> {
  if (!can(ctx, 'write')) return false;
  if (user.id === ctx.actor.user.id || isAdmin(ctx)) return true;
  const mine = await projectAccess(ctx, db);
  const managed = (mine.visibleIds() ?? []).filter((id) => mine.canManage(id));
  if (!managed.length) return false;
  const theirs = await accessFor(db, user);
  return managed.some((id) => theirs.canWrite(id));
}

/** Whether the caller sees why someone is away: it's theirs, they entered it, or they're an administrator. */
function seesWhy(ctx: Ctx, row: AbsenceRow): boolean {
  const me = ctx.actor.user.id;
  return row.userId === me || row.createdById === me || isAdmin(ctx);
}

function toDto(ctx: Ctx, users: Map<string, UserRow>, row: AbsenceRow, canChange: boolean): Absence {
  const user = users.get(row.userId);
  const by = row.createdById ? users.get(row.createdById) : undefined;
  const why = seesWhy(ctx, row);
  return {
    id: row.id,
    user: user ? userRefDto(user) : { id: row.userId, login: row.userId, name: row.userId, avatarColor: 'slate', isBot: false },
    from: row.startDate,
    to: row.endDate,
    half: (row.half as AbsenceHalf | null) ?? null,
    kind: why ? (row.kind as AbsenceKind) : null,
    note: why ? row.note : null,
    version: row.version,
    createdBy: by ? userRefDto(by) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    canChange,
  };
}

async function personNamed(ctx: Ctx, login: string | undefined): Promise<UserRow> {
  const s = await ctx.app.schema.get();
  if (!login?.trim()) return ctx.actor.user;
  const u = findUser(s, login, ctx.actor.user.id);
  if (!u) throw notFound(`User ${login.trim()}`, 'People are named by login, as in GET /users.');
  return u;
}

/** "3 Dec", "2 to 6 Dec", "the morning of 3 Dec": how an absence's days read in a message. */
export function daysWords(from: string, to: string, half: string | null): string {
  const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  if (half) return `the ${half} of ${day(from)}`;
  return from === to ? day(from) : `${day(from)} to ${day(to)}`;
}

// ---------------------------------------------------------------------------
// Checking one
// ---------------------------------------------------------------------------

interface Days {
  from: string;
  to: string;
  half: AbsenceHalf | null;
}

/** Dates in order, a year at most, and a half day only on one day: each refusal says how to put it right. */
function checkDays(d: Days): void {
  if (d.to < d.from) throw badRequest(`The last day away, ${d.to}, is before the first, ${d.from}`, `Give the first day as "from" and the last as "to": from ${d.to} to ${d.from}.`);
  const days = diffDays(d.from, d.to) + 1;
  if (days > MAX_ABSENCE_DAYS) {
    throw badRequest(
      `An absence runs ${MAX_ABSENCE_DAYS} days at most, and this one runs ${days}`,
      `Enter it a year at a time: from ${d.from} to ${addDays(d.from, MAX_ABSENCE_DAYS - 1)} first.`,
    );
  }
  if (d.half && d.from !== d.to) throw badRequest('Half a day away is one day', `Give the same date as "from" and "to" (${d.from}), or leave out "half" for whole days.`);
}

/** Two absences share time unless they're the morning and the afternoon of one day. */
function overlap(a: Days, b: Days): boolean {
  if (a.from > b.to || b.from > a.to) return false;
  return !(a.half && b.half && a.from === b.from && a.half !== b.half);
}

/**
 * Refuses days that overlap the person's others, inside the transaction that writes them, with
 * the person's absences locked: two entered at once can't both pass.
 */
async function refuseOverlap(tx: Db, user: UserRow, d: Days, except?: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`a4a:absences:${user.id}`}))`);
  const near = await tx
    .select()
    .from(absences)
    .where(and(eq(absences.userId, user.id), lte(absences.startDate, d.to), gte(absences.endDate, d.from), except ? ne(absences.id, except) : undefined));
  const clash = near.find((r) => overlap(d, { from: r.startDate, to: r.endDate, half: (r.half as AbsenceHalf | null) ?? null }));
  if (clash) {
    throw conflict(`${user.name} is already away ${daysWords(clash.startDate, clash.endDate, clash.half)}`, 'Change that absence instead, or remove it first.', { absence: clash.id });
  }
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export async function listAbsences(ctx: Ctx, opts: { user?: string; from?: string; to?: string } = {}): Promise<Absence[]> {
  requireScope(ctx, 'read');
  const user = await personNamed(ctx, opts.user);
  const from = opts.from ?? addDays(todayISO(), -LIST_LOOK_BACK_DAYS);
  const rows = await ctx.db
    .select()
    .from(absences)
    .where(and(eq(absences.userId, user.id), gte(absences.endDate, from), opts.to ? lte(absences.startDate, opts.to) : undefined))
    .orderBy(asc(absences.startDate), asc(absences.createdAt));
  const s = await ctx.app.schema.get();
  const canChange = await mayEnterFor(ctx, user);
  return rows.map((r) => toDto(ctx, s.users, r, canChange));
}

export async function createAbsence(ctx: Ctx, input: CreateAbsenceInput): Promise<Absence> {
  requireScope(ctx, 'write');
  const user = await personNamed(ctx, input.user);
  if (user.isBot) throw badRequest(`${user.login} is an agent, and agents are never away`, 'Days away are for people.');
  if (!(await mayEnterFor(ctx, user))) {
    throw forbidden('You can enter days away for yourself, and for people who work in a project you manage', 'An administrator can enter them for anyone.');
  }
  const d: Days = { from: input.from, to: input.to ?? input.from, half: input.half ?? null };
  checkDays(d);
  const row = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await refuseOverlap(tx, user, d);
    const [created] = await tx
      .insert(absences)
      .values({
        id: newId(),
        userId: user.id,
        startDate: d.from,
        endDate: d.to,
        half: d.half,
        kind: input.kind ?? 'holiday',
        note: input.note?.trim() ?? '',
        createdById: ctx.actor.user.id,
        updatedById: ctx.actor.user.id,
      })
      .returning();
    return created!;
  });
  const s = await ctx.app.schema.get();
  return toDto(ctx, s.users, row, true);
}

async function changeable(ctx: Ctx, id: string): Promise<{ row: AbsenceRow; user: UserRow }> {
  requireScope(ctx, 'write');
  const [row] = await ctx.db.select().from(absences).where(eq(absences.id, id));
  if (!row) throw notFound('Absence');
  const s = await ctx.app.schema.get();
  const user = s.users.get(row.userId);
  if (!user) throw notFound('Absence');
  if (!(await mayEnterFor(ctx, user))) {
    throw forbidden(`You can't change ${user.name}'s days away`, 'They can, as can a manager of a project they work in, or an administrator.');
  }
  return { row, user };
}

export async function updateAbsence(ctx: Ctx, id: string, input: UpdateAbsenceInput): Promise<Absence> {
  const { row, user } = await changeable(ctx, id);
  const s = await ctx.app.schema.get();
  if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) {
    throw conflict('These days away changed since you read them', 'Look at them again, then change them.', { absence: toDto(ctx, s.users, row, true) });
  }
  const from = input.from ?? row.startDate;
  const to = input.to ?? (input.from && row.startDate === row.endDate ? input.from : row.endDate);
  // A half day stretched over several days becomes whole days, unless "half" says otherwise.
  const half = input.half !== undefined ? input.half : from === to ? ((row.half as AbsenceHalf | null) ?? null) : null;
  const d: Days = { from, to, half };
  checkDays(d);
  const updated = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await refuseOverlap(tx, user, d, row.id);
    const [next] = await tx
      .update(absences)
      .set({
        startDate: d.from,
        endDate: d.to,
        half: d.half,
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.note !== undefined ? { note: input.note.trim() } : {}),
        version: row.version + 1,
        updatedById: ctx.actor.user.id,
        updatedAt: new Date(),
      })
      .where(and(eq(absences.id, row.id), eq(absences.version, row.version)))
      .returning();
    if (!next) throw conflict('These days away changed since you read them', 'Look at them again, then change them.');
    return next;
  });
  return toDto(ctx, s.users, updated, true);
}

export async function deleteAbsence(ctx: Ctx, id: string): Promise<void> {
  const { row } = await changeable(ctx, id);
  await ctx.db.delete(absences).where(eq(absences.id, row.id));
}

/**
 * The days away the engine plans around, for these people: those that touch the year before
 * today or the five after it, which is all it looks at.
 */
export async function absencesForPlan(db: Db, userIds: readonly string[], today: string): Promise<PlanAbsence[]> {
  if (!userIds.length) return [];
  const rows = await db
    .select({ userId: absences.userId, from: absences.startDate, to: absences.endDate, half: absences.half })
    .from(absences)
    .where(and(inArray(absences.userId, [...userIds]), gte(absences.endDate, addDays(today, -AWAY_LOOK_BACK_DAYS)), lte(absences.startDate, addDays(today, AWAY_LOOK_AHEAD_DAYS))));
  return rows.map((r) => ({ resourceId: r.userId, from: r.from, to: r.to, half: (r.half as AbsenceHalf | null) ?? null }));
}

// ---------------------------------------------------------------------------
// What each person chose to see
// ---------------------------------------------------------------------------

export async function getPreferences(ctx: Ctx): Promise<Preferences> {
  requireScope(ctx, 'read');
  const [row] = await ctx.db.select().from(userPreferences).where(eq(userPreferences.userId, ctx.actor.user.id));
  const saved = (row?.preferences ?? {}) as { loadWindow?: LoadWindow | null };
  return { loadWindow: saved.loadWindow ?? null };
}

/** Keeps what's given, and only that: a key left out stays as it was. */
export async function updatePreferences(ctx: Ctx, input: { loadWindow?: LoadWindow | null }): Promise<Preferences> {
  requirePersonal(ctx);
  if (input.loadWindow && 'from' in input.loadWindow && input.loadWindow.to < input.loadWindow.from) {
    throw badRequest(`The window ends, ${input.loadWindow.to}, before it starts, ${input.loadWindow.from}`, 'Give its first day as "from" and its last as "to".');
  }
  const current = await getPreferences(ctx);
  const next: Preferences = { ...current, ...(input.loadWindow !== undefined ? { loadWindow: input.loadWindow } : {}) };
  await ctx.db
    .insert(userPreferences)
    .values({ userId: ctx.actor.user.id, preferences: next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: userPreferences.userId, set: { preferences: next, updatedAt: new Date() } });
  return next;
}
