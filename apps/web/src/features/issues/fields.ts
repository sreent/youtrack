import type { IssueField, OptionValue, PeriodValue, UserRef } from '@a4a/shared';
import { fieldOf } from '../../components/Badges';

/** Reading an issue's typed field values without guessing at their shape. */

export function isOption(v: unknown): v is OptionValue {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'ordinal' in v && 'isResolved' in v;
}
export function isUser(v: unknown): v is UserRef {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'login' in v;
}
export function isPeriod(v: unknown): v is PeriodValue {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'minutes' in v && 'presentation' in v;
}

export function userOf(fields: IssueField[], name: string): UserRef | null {
  const v = fieldOf(fields, name)?.value;
  return isUser(v) ? v : null;
}

/** A field's value in words, for lines that say what something is. */
export function valueText(f: IssueField): string {
  const v = f.value;
  if (v === null) return '';
  if (Array.isArray(v)) return v.map((x) => (isUser(x) ? x.name : x.name)).join(', ');
  if (isOption(v)) return v.name;
  if (isUser(v)) return v.name;
  if (isPeriod(v)) return v.presentation;
  return String(v);
}
