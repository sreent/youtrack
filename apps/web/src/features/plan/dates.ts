import { intlLocale, weekdayNames } from '../../i18n';
/**
 * Calendar dates as the API sends them (YYYY-MM-DD), handled as UTC days so arithmetic never
 * shifts across a change of clocks; working days as a plan's calendar defines them; and dates
 * as people read them ("9 Nov", "9–20 Nov"), as the page's language writes a date and a range (Intl).
 */

const DAY = 86_400_000;
const WEEKDAYS = weekdayNames();

function utc(d: string): number {
  return Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
}

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(d: string, n: number): string {
  return iso(utc(d) + n * DAY);
}

/** The same day `n` months on, or that month's last when it's shorter: 31 Jan and a month is 28 Feb. */
export function addMonths(d: string, n: number): string {
  const first = new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return iso(first.getTime() + (Math.min(Number(d.slice(8, 10)), last) - 1) * DAY);
}

/** Calendar days from a to b (b − a). */
export function diffDays(a: string, b: string): number {
  return Math.round((utc(b) - utc(a)) / DAY);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(d: string): number {
  return new Date(utc(d)).getUTCDay();
}

export function mondayOf(d: string): string {
  const wd = weekday(d);
  return addDays(d, wd === 0 ? -6 : 1 - wd);
}

export function sundayOf(d: string): string {
  return addDays(mondayOf(d), 6);
}

/** Today in the browser's own time zone, as a calendar date. */
export function localToday(now = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${day}`;
}

export const minDate = (a: string, b: string) => (a < b ? a : b);
export const maxDate = (a: string, b: string) => (a > b ? a : b);

// ---------------------------------------------------------------------------
// As people read them
// ---------------------------------------------------------------------------

const yearOf = (d: string) => d.slice(0, 4);

/** A calendar day's formatter in the page's language, read as the UTC day it is. */
const dayFormat = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(intlLocale(), { ...opts, timeZone: 'UTC' });
const yearIf = (shown: boolean): Intl.DateTimeFormatOptions => (shown ? { year: 'numeric' } : {});

/** "9 Nov", or "9 Nov 2027" when it isn't this year, as the page's language writes a date ("11月9日"). */
export function dayMonth(d: string, thisYear = localToday().slice(0, 4)): string {
  return dayFormat({ day: 'numeric', month: 'short', ...yearIf(yearOf(d) !== thisYear) }).format(new Date(utc(d)));
}

/** "Fri 4 Dec", a weekday with its date, as the page's language puts them together. */
export function weekdayDayMonth(d: string, thisYear = localToday().slice(0, 4)): string {
  return dayFormat({ weekday: 'short', day: 'numeric', month: 'short', ...yearIf(yearOf(d) !== thisYear) }).format(new Date(utc(d)));
}

/** "Mon" */
export function weekdayName(d: string): string {
  return WEEKDAYS[weekday(d)]!;
}

/**
 * Two dates as one span, as the page's language writes a range (Intl's): "13 Nov", "9 – 13 Nov",
 * "30 Nov – 4 Dec", Japanese's "11/09～11/13". A sentence says it as a page shows it.
 */
export function span(a: string, b: string): string {
  if (a === b) return dayMonth(a);
  if (b < a) [a, b] = [b, a];
  const thisYear = localToday().slice(0, 4);
  return dayFormat({ day: 'numeric', month: 'short', ...yearIf(yearOf(a) !== thisYear || yearOf(b) !== thisYear) }).formatRange(new Date(utc(a)), new Date(utc(b)));
}


// ---------------------------------------------------------------------------
// Working days
// ---------------------------------------------------------------------------

export interface WorkCalendar {
  isWorking(d: string): boolean;
  /** Working days in [a, b]; 0 when b is before a. */
  inclusive(a: string, b: string): number;
  /** Signed working days from a to b: those in (a, b] when b is later, minus those in [b, a) when earlier. */
  between(a: string, b: string): number;
  /** `d` itself if it's a working day, else the next one. */
  next(d: string): string;
}

/** The plan's calendar (0 = Sunday … 6 = Saturday, and holidays); Monday to Friday when it names none. */
export function workCalendar(cal?: { workingDays?: number[]; holidays?: string[] } | null): WorkCalendar {
  const days = new Set((cal?.workingDays ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  if (days.size === 0) for (const d of [1, 2, 3, 4, 5]) days.add(d);
  const holidays = new Set(cal?.holidays ?? []);
  const isWorking = (d: string) => days.has(weekday(d)) && !holidays.has(d);
  const inclusive = (a: string, b: string) => {
    if (b < a) return 0;
    let n = 0;
    for (let d = a, i = 0; d <= b && i < 20_000; d = addDays(d, 1), i++) if (isWorking(d)) n++;
    return n;
  };
  return {
    isWorking,
    inclusive,
    between: (a, b) => (a === b ? 0 : a < b ? inclusive(addDays(a, 1), b) : -inclusive(b, addDays(a, -1))),
    next: (d) => {
      let cur = d;
      for (let i = 0; i < 400 && !isWorking(cur); i++) cur = addDays(cur, 1);
      return cur;
    },
  };
}
