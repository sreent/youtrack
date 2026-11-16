/** Times, money and counts, as Ocean writes them. */

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

/** As people read times: today's alone ("10:02"), older ones with their day ("Mon 9 Nov, 10:02"). */
export function whenRead(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay(d, now)) return time;
  const day = d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
  return `${day.replace(',', '')}, ${time}`;
}

/** A day heading in a conversation: "Today", "Yesterday", or the day. */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (sameDay(d, now)) return 'Today';
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

/** A calendar date as people read it ("9 Nov 2026"), from YYYY-MM-DD. */
export function dateRead(isoDate: string | null | undefined): string {
  if (!isoDate) return '';
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1));
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function money(amount: number | null | undefined, currency = 'USD'): string {
  if (amount === null || amount === undefined) return '';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${Math.round(amount).toLocaleString('en-GB')} ${currency}`;
  }
}

/** "1 issue", "3 issues". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
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
