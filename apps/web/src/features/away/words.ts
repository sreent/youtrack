/** Days away as people read them. */
import type { Absence, AbsenceHalf, AbsenceKind } from '@a4a/shared';
import { dayMonth, span, weekdayName } from '../plan/dates';

export const KIND_WORDS: Record<AbsenceKind, string> = {
  holiday: 'Holiday',
  sick: 'Sick',
  training: 'Training',
  other: 'Something else',
};

/** The kinds, in the order the form offers them. Not imported from @a4a/shared's values, which would bring zod, and its eval, into the page. */
export const KINDS = Object.keys(KIND_WORDS) as AbsenceKind[];

export const HALF_WORDS: Record<AbsenceHalf, string> = { morning: 'the morning', afternoon: 'the afternoon' };

/** "Fri 4 Dec", "the morning of Fri 4 Dec", "2 to 6 Dec". */
export function whenWords(a: Pick<Absence, 'from' | 'to' | 'half'>): string {
  const day = `${weekdayName(a.from)} ${dayMonth(a.from)}`;
  if (a.half) return `${HALF_WORDS[a.half]} of ${day}`;
  return a.from === a.to ? day : span(a.from, a.to, ' to ');
}

/** "Away 2 to 6 Dec", for the outcome line. */
export function awayWords(a: Pick<Absence, 'from' | 'to' | 'half'>): string {
  return `away ${whenWords(a)}`;
}
