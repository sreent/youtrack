/** Times, money and counts, as Ocean writes them, in the page's language (D49). */
import { formatPeriod } from '@a4a/shared/periods';
import { getLocale, intlLocale, t } from '../../i18n';

const pad = (n: number) => String(n).padStart(2, '0');

/** The ledger's time: to the second, in UTC, compared rather than read ("2026-11-15 14:02:06Z"). */
export function utcSecond(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

/** A run's time: today's alone, to the second ("14:02:06"). */
export function clock(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Whether a time is today's, which `whenRead` writes as a clock time alone: a message words the two apart (`{day, select, today {…} other {…}}`). */
export function isToday(iso: string, now = new Date()): boolean {
  return sameDay(new Date(iso), now);
}

/** As people read times: today's alone ("10:02"), older ones with their day ("Mon 9 Nov, 10:02"). */
export function whenRead(iso: string, now = new Date()): string {
  const d = new Date(iso);
  // Today's time alone, as the page's language writes one ("14:05", Indonesian's "14.05").
  if (sameDay(d, now)) return d.toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  // The day and the time together, as the page's language joins them (Japanese has no comma), on a 24-hour clock.
  return d.toLocaleString(intlLocale(), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

/** A day heading in a conversation: "Today", "Yesterday", or the day. */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (sameDay(d, now)) return t('common.format.today');
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return t('common.format.yesterday');
  return d.toLocaleDateString(intlLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

/** A calendar date as people read it ("9 Nov 2026"), from YYYY-MM-DD. */
export function dateRead(isoDate: string | null | undefined): string {
  if (!isoDate) return '';
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1));
  return dt.toLocaleDateString(intlLocale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function money(amount: number | null | undefined, currency = 'USD'): string {
  if (amount === null || amount === undefined) return '';
  try {
    return new Intl.NumberFormat(intlLocale(), { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${Math.round(amount).toLocaleString(intlLocale())} ${currency}`;
  }
}

/** "1 issue", "3 issues": a counted thing's message, an ICU plural of `n` (D49). */
export function count(n: number, key: string): string {
  return t(key, { n });
}

/** "Update an issue" → "update an issue", for "assistant asks to …". */
export function lowerFirst(s: string): string {
  return s ? s[0]!.toLowerCase() + s.slice(1) : s;
}

export function excerpt(text: string, max = 140): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export const ISSUE_ID = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;

/**
 * Intl's narrowest unit width for the page's language. Thai's narrow glues the unit to its number
 * ("1.5ชม.") while Thai sets a number off with a space, so Thai takes the short width ("1.5 ชม.").
 */
const unitDisplay = (): 'narrow' | 'short' => (getLocale() === 'th' ? 'short' : 'narrow');

/** Hours as a figure with its unit in the page's language, at most one decimal: "16h", "5.3h" in English (D49). */
export function hoursWords(h: number): string {
  return new Intl.NumberFormat(intlLocale(), { style: 'unit', unit: 'hour', unitDisplay: unitDisplay(), maximumFractionDigits: 1 }).format(h);
}

const PERIOD_UNITS = { w: 'week', d: 'day', h: 'hour', m: 'minute' } as const;

/**
 * Time worked as its reader says it: a4a's period ("1w 2d 3h 30m", "0m"), each part with its unit in the
 * page's language (D49). It's for reading; what people type, and the period a field holds, stay a4a's notation.
 */
export function periodWords(minutes: number, opts?: Parameters<typeof formatPeriod>[1]): string {
  const parts = formatPeriod(minutes, opts)
    .split(' ')
    .map((p) => new Intl.NumberFormat(intlLocale(), { style: 'unit', unit: PERIOD_UNITS[p.slice(-1) as keyof typeof PERIOD_UNITS], unitDisplay: unitDisplay() }).format(Number(p.slice(0, -1))));
  return new Intl.ListFormat(intlLocale(), { type: 'unit', style: 'narrow' }).format(parts);
}
