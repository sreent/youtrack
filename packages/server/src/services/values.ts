import { formatPeriod, isOwnAgent, parsePeriod, TONES, type IssueFieldValue, type OptionValue, type Tone, type UserRef } from '@a4a/shared';
import type { issueFieldValues } from '../db/schema';
import { parseDateInput } from '../lib/dates';
import { badRequest } from '../lib/errors';
import { didYouMean } from '../lib/text';
import {
  allowedValues,
  findUser,
  findValue,
  type FieldRow,
  type FieldValueRow,
  type SchemaSnapshot,
  type UserRow,
} from './schema-cache';

export type IFVRow = typeof issueFieldValues.$inferSelect;

/** One stored value of a custom field (a row in issue_field_values minus ids). */
export interface ResolvedValue {
  valueId?: string | null;
  userId?: string | null;
  textValue?: string | null;
  numberValue?: number | null;
  dateValue?: string | null;
}

const EMPTY_WORDS = new Set(['', 'none', 'null', 'empty', 'unassigned', 'no value']);

export function isEmptyWord(v: string): boolean {
  return EMPTY_WORDS.has(v.trim().toLowerCase());
}

/**
 * Resolve user input for a field into stored values. Returns [] to clear the field.
 * Throws a 400 with a "did you mean" hint when a value is unknown.
 */
export function resolveFieldInput(
  s: SchemaSnapshot,
  field: FieldRow,
  projectId: string,
  raw: string | number | null | string[],
  meId: string,
): ResolvedValue[] {
  if (raw === null) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  if (!field.multi && items.length > 1) {
    throw badRequest(`Field "${field.name}" takes a single value`);
  }
  const out: ResolvedValue[] = [];
  for (const item of items) {
    if (typeof item === 'string' && isEmptyWord(item)) continue;
    out.push(resolveOne(s, field, projectId, item, meId));
  }
  return out;
}

function resolveOne(
  s: SchemaSnapshot,
  field: FieldRow,
  projectId: string,
  item: string | number,
  meId: string,
): ResolvedValue {
  const text = String(item).trim();
  switch (field.type) {
    case 'enum':
    case 'state':
    case 'version': {
      const v = findValue(s, field.id, projectId, text);
      if (!v) {
        const names = allowedValues(s, field.id, projectId).map((x) => x.name);
        const guess = didYouMean(text, names);
        throw badRequest(
          `Unknown value "${text}" for ${field.name}`,
          guess ? `Did you mean "${guess}"? Allowed: ${names.join(', ')}` : `Allowed: ${names.join(', ')}`,
        );
      }
      return { valueId: v.id };
    }
    case 'user': {
      const u = findUser(s, text, meId);
      if (!u) {
        const guess = didYouMean(text, [...s.usersByLogin.keys()]);
        throw badRequest(`Unknown user "${text}" for ${field.name}`, guess ? `Did you mean "${guess}"?` : 'Use a login, a full name, or "me".');
      }
      if (u.banned) throw badRequest(`User "${u.login}" is banned`);
      // a4a's own agents act for a4a itself and take no work; an agent an administrator added does (D34).
      if (isOwnAgent(u)) throw badRequest(`${u.login} is a4a's own agent, and takes no work`, `Give ${field.name} a person, or an agent an administrator added.`);
      return { userId: u.id };
    }
    case 'string':
    case 'text':
      return { textValue: text };
    case 'integer': {
      const n = Number(text);
      if (!Number.isInteger(n)) throw badRequest(`${field.name} expects a whole number, got "${text}"`);
      return { numberValue: n };
    }
    case 'float': {
      const n = Number(text);
      if (!Number.isFinite(n)) throw badRequest(`${field.name} expects a number, got "${text}"`);
      return { numberValue: n };
    }
    case 'date': {
      const d = parseDateInput(text);
      if (!d) throw badRequest(`${field.name} expects a date (YYYY-MM-DD, today, tomorrow, +3d), got "${text}"`);
      return { dateValue: d };
    }
    case 'period': {
      const minutes = parsePeriod(typeof item === 'number' ? item : text);
      if (minutes === null) throw badRequest(`${field.name} expects a duration like "2d 4h" or "90m", got "${text}"`);
      return { numberValue: minutes };
    }
  }
}

/** Human-readable presentation of stored values, used in history and changes. */
export function presentValues(s: SchemaSnapshot, field: FieldRow, rows: ResolvedValue[]): string | null {
  if (!rows.length) return null;
  const parts = rows.map((r) => presentOne(s, field, r)).filter((x): x is string => x !== null);
  return parts.length ? parts.join(', ') : null;
}

function presentOne(s: SchemaSnapshot, field: FieldRow, r: ResolvedValue): string | null {
  switch (field.type) {
    case 'enum':
    case 'state':
    case 'version':
      return r.valueId ? (s.values.get(r.valueId)?.name ?? '?') : null;
    case 'user':
      return r.userId ? (s.users.get(r.userId)?.login ?? '?') : null;
    case 'string':
    case 'text':
      return r.textValue ?? null;
    case 'integer':
    case 'float':
      return r.numberValue === null || r.numberValue === undefined ? null : String(r.numberValue);
    case 'date':
      return r.dateValue ?? null;
    case 'period':
      return r.numberValue === null || r.numberValue === undefined ? null : formatPeriod(r.numberValue);
  }
}

export function toneOf(t: string | null | undefined): Tone | null {
  return t && (TONES as readonly string[]).includes(t) ? (t as Tone) : null;
}

export function optionDto(v: FieldValueRow): OptionValue {
  return { id: v.id, name: v.name, tone: toneOf(v.tone), isResolved: v.isResolved, ordinal: v.ordinal };
}

export function userRefDto(u: UserRow): UserRef {
  return { id: u.id, login: u.login, name: u.name, avatarColor: u.avatarColor, isBot: u.isBot };
}

/** DTO value for an issue field, following the field's type and multiplicity. */
export function fieldValueDto(s: SchemaSnapshot, field: FieldRow, rows: ResolvedValue[]): IssueFieldValue {
  switch (field.type) {
    case 'enum':
    case 'state':
    case 'version': {
      const opts = rows
        .map((r) => (r.valueId ? s.values.get(r.valueId) : undefined))
        .filter((v): v is FieldValueRow => Boolean(v))
        .map(optionDto);
      return field.multi ? opts : (opts[0] ?? null);
    }
    case 'user': {
      const us = rows
        .map((r) => (r.userId ? s.users.get(r.userId) : undefined))
        .filter((u): u is UserRow => Boolean(u))
        .map(userRefDto);
      return field.multi ? us : (us[0] ?? null);
    }
    case 'string':
    case 'text':
      return rows[0]?.textValue ?? null;
    case 'integer':
    case 'float':
      return rows[0]?.numberValue ?? null;
    case 'date':
      return rows[0]?.dateValue ?? null;
    case 'period': {
      const m = rows[0]?.numberValue;
      return m === null || m === undefined ? null : { minutes: m, presentation: formatPeriod(m) };
    }
  }
}

export function sameValues(a: ResolvedValue[], b: ResolvedValue[]): boolean {
  const key = (r: ResolvedValue) =>
    [r.valueId ?? '', r.userId ?? '', r.textValue ?? '', r.numberValue ?? '', r.dateValue ?? ''].join('|');
  const ka = a.map(key).sort();
  const kb = b.map(key).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

export function rowToResolved(r: IFVRow): ResolvedValue {
  return {
    valueId: r.valueId,
    userId: r.userId,
    textValue: r.textValue,
    numberValue: r.numberValue,
    dateValue: r.dateValue,
  };
}
