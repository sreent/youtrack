/** Days away as people read them. */
import type { Absence, AbsenceHalf, AbsenceKind } from '@a4a/shared';
import { span, weekdayDayMonth } from '../plan/dates';
import { t } from '../../i18n';

export const KIND_WORDS: Record<AbsenceKind, string> = {
  holiday: t('away.words.holiday'),
  sick: t('away.words.sick'),
  training: t('away.words.training'),
  other: t('away.words.somethingElse'),
};

/** The kinds, in the order the form offers them. Not imported from @a4a/shared's values, which would bring zod, and its eval, into the page. */
export const KINDS = Object.keys(KIND_WORDS) as AbsenceKind[];

export const HALF_WORDS: Record<AbsenceHalf, string> = { morning: t('away.words.theMorning'), afternoon: t('away.words.theAfternoon') };

/** "Fri 4 Dec", "the morning of Fri 4 Dec", "2 – 6 Dec". */
export function whenWords(a: Pick<Absence, 'from' | 'to' | 'half'>): string {
  const day = weekdayDayMonth(a.from);
  if (a.half) return t('away.words.of', { v: HALF_WORDS[a.half], day: day });
  return a.from === a.to ? day : span(a.from, a.to);
}

/** "Away 2 – 6 Dec", for the outcome line. */
export function awayWords(a: Pick<Absence, 'from' | 'to' | 'half'>): string {
  return t('away.words.away', { whenWords: whenWords(a) });
}
