/**
 * Calendar-date helpers. Dates are ISO strings (YYYY-MM-DD) and are handled as
 * UTC calendar days so arithmetic never shifts across DST boundaries. "Today"
 * is taken from the server's local clock.
 */

export function todayISO(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isISODate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function toUTC(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

export function fromUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number): string {
  const d = toUTC(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUTC(d);
}

export function addMonths(iso: string, n: number): string {
  const d = toUTC(iso);
  d.setUTCMonth(d.getUTCMonth() + n);
  return fromUTC(d);
}

/** Calendar days from a to b (b - a). */
export function diffDays(a: string, b: string): number {
  return Math.round((toUTC(b).getTime() - toUTC(a).getTime()) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(iso: string): number {
  return toUTC(iso).getUTCDay();
}

export function startOfWeek(iso: string): string {
  const wd = weekday(iso);
  return addDays(iso, wd === 0 ? -6 : 1 - wd); // Monday
}

export function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export function startOfYear(iso: string): string {
  return `${iso.slice(0, 4)}-01-01`;
}

export function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

export function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

export interface DateRange {
  /** Inclusive start (ISO date) or null for open */
  from: string | null;
  /** Exclusive end (ISO date) or null for open */
  to: string | null;
}

const REL_RE = /^([+-])?(\d+)\s*(d|w|m|y)$/i;

/**
 * Parse a date expression used in queries and field inputs:
 * 2026-01-31, today, yesterday, tomorrow, "this week", "last month", -7d, +2w,
 * {minus 7d}, {plus 1w}. Returns a range (single dates span one day).
 */
export function parseDateExpression(raw: string, today = todayISO()): DateRange | null {
  let text = raw.trim().toLowerCase().replace(/^\{|\}$/g, '').replace(/\s+/g, ' ');
  if (!text) return null;
  if (isISODate(text)) return { from: text, to: addDays(text, 1) };
  const day = (d: string): DateRange => ({ from: d, to: addDays(d, 1) });
  switch (text) {
    case 'today':
      return day(today);
    case 'yesterday':
      return day(addDays(today, -1));
    case 'tomorrow':
      return day(addDays(today, 1));
    case 'this week': {
      const s = startOfWeek(today);
      return { from: s, to: addDays(s, 7) };
    }
    case 'last week': {
      const s = addDays(startOfWeek(today), -7);
      return { from: s, to: addDays(s, 7) };
    }
    case 'next week': {
      const s = addDays(startOfWeek(today), 7);
      return { from: s, to: addDays(s, 7) };
    }
    case 'this month': {
      const s = startOfMonth(today);
      return { from: s, to: addMonths(s, 1) };
    }
    case 'last month': {
      const s = addMonths(startOfMonth(today), -1);
      return { from: s, to: addMonths(s, 1) };
    }
    case 'next month': {
      const s = addMonths(startOfMonth(today), 1);
      return { from: s, to: addMonths(s, 1) };
    }
    case 'this year': {
      const s = startOfYear(today);
      return { from: s, to: addMonths(s, 12) };
    }
    case 'last year': {
      const s = addMonths(startOfYear(today), -12);
      return { from: s, to: addMonths(s, 12) };
    }
  }
  text = text.replace(/^minus /, '-').replace(/^plus /, '+');
  const m = REL_RE.exec(text);
  if (m) {
    const sign = m[1] === '+' ? 1 : -1; // bare "7d" means 7 days ago, like "-7d"
    const n = parseInt(m[2]!, 10) * sign;
    const unit = m[3]!.toLowerCase();
    let d = today;
    if (unit === 'd') d = addDays(today, n);
    else if (unit === 'w') d = addDays(today, n * 7);
    else if (unit === 'm') d = addMonths(today, n);
    else d = addMonths(today, n * 12);
    return day(d);
  }
  return null;
}

/** A single concrete date for field input ("tomorrow", "+3d", "2026-03-01"). */
export function parseDateInput(raw: string, today = todayISO()): string | null {
  const text = raw.trim().toLowerCase();
  const rel = /^(\d+)\s*(d|w)$/.exec(text); // in field input "3d" means in 3 days
  if (rel) return addDays(today, parseInt(rel[1]!, 10) * (rel[2] === 'w' ? 7 : 1));
  const r = parseDateExpression(raw, today);
  return r?.from ?? null;
}
