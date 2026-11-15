import { DEFAULT_DAYS_PER_WEEK, DEFAULT_HOURS_PER_DAY } from './constants';

/**
 * Durations ("periods") are stored as minutes. Presentation follows YouTrack:
 * 1w = 5d, 1d = 8h by default.
 */
export interface PeriodOptions {
  hoursPerDay?: number;
  daysPerWeek?: number;
}

const UNIT_RE = /(\d+(?:\.\d+)?)\s*(w|d|h|m)\b/gi;

/** Parse "1w 2d 3h 30m", "90m", "1.5h", "2d" or a bare number of minutes. Returns null when invalid. */
export function parsePeriod(input: string | number, opts: PeriodOptions = {}): number | null {
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? Math.round(input) : null;
  const text = input.trim().toLowerCase();
  if (!text) return null;
  if (/^\d+$/.test(text)) return parseInt(text, 10);
  const hpd = opts.hoursPerDay ?? DEFAULT_HOURS_PER_DAY;
  const dpw = opts.daysPerWeek ?? DEFAULT_DAYS_PER_WEEK;
  let total = 0;
  let consumed = '';
  for (const match of text.matchAll(UNIT_RE)) {
    const value = parseFloat(match[1]!);
    const unit = match[2]!;
    consumed += match[0];
    if (unit === 'w') total += value * dpw * hpd * 60;
    else if (unit === 'd') total += value * hpd * 60;
    else if (unit === 'h') total += value * 60;
    else total += value;
  }
  if (!consumed || consumed.replace(/\s+/g, '') !== text.replace(/\s+/g, '')) return null;
  return Math.round(total);
}

/** Format minutes as "1w 2d 3h 30m" (omitting zero parts). */
export function formatPeriod(minutes: number, opts: PeriodOptions = {}): string {
  if (!minutes || minutes <= 0) return '0m';
  const hpd = opts.hoursPerDay ?? DEFAULT_HOURS_PER_DAY;
  const dpw = opts.daysPerWeek ?? DEFAULT_DAYS_PER_WEEK;
  const perDay = hpd * 60;
  const perWeek = dpw * perDay;
  let rest = Math.round(minutes);
  const parts: string[] = [];
  const w = Math.floor(rest / perWeek);
  rest -= w * perWeek;
  const d = Math.floor(rest / perDay);
  rest -= d * perDay;
  const h = Math.floor(rest / 60);
  rest -= h * 60;
  if (w) parts.push(`${w}w`);
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (rest) parts.push(`${rest}m`);
  return parts.join(' ');
}
