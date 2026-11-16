/**
 * Moments, for date-and-time fields (D41). Stored as instants; written by people in their own time
 * zone unless they give an offset.
 */
import { serverTimeZone, todayIn, zonedTime } from '../reports/tz';
import { addDays } from './dates';

const UNIT_MS: Record<string, number> = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

function validClock(h: number, min: number, sec: number): boolean {
  return h >= 0 && h <= 23 && min >= 0 && min <= 59 && sec >= 0 && sec <= 59;
}

function local(date: string, h: number, min: number, sec: number, zone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m || !validClock(h, min, sec)) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // A calendar day that exists: 2026-02-30 doesn't.
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return new Date(zonedTime(y, mo, d, h, min, sec, zone));
}

/**
 * A moment someone wrote, as an instant. It takes an ISO instant with an offset
 * ("2026-11-20T14:00Z", "2026-11-20T15:00+01:00"); a local time, read in `zone`
 * ("2026-11-20 15:00", "2026-11-20T15:00"); a day alone (its midnight in `zone`); "now";
 * "today", "tomorrow" or "yesterday", with or without a time ("tomorrow 09:30"); or a
 * distance from now ("+2h", "-30m", "+3d"). Null for anything else.
 */
export function parseDateTimeInput(raw: string, zone: string = serverTimeZone(), now: number = Date.now()): Date | null {
  const text = raw.trim();
  const lower = text.toLowerCase();
  if (!text) return null;
  if (lower === 'now') return new Date(now);
  const rel = /^([+-])(\d{1,5})\s*(m|min|h|d|w)$/.exec(lower);
  if (rel) return new Date(now + (rel[1] === '-' ? -1 : 1) * Number(rel[2]) * UNIT_MS[rel[3]!]!);
  const named = /^(today|tomorrow|yesterday)(?:[ t](\d{1,2}):(\d{2}))?$/.exec(lower);
  if (named) {
    const today = todayIn(zone, now);
    const day = named[1] === 'today' ? today : addDays(today, named[1] === 'tomorrow' ? 1 : -1);
    return local(day, Number(named[2] ?? 0), Number(named[3] ?? 0), 0, zone);
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const t = Date.parse(text);
    return Number.isNaN(t) ? null : new Date(t);
  }
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/i.exec(text);
  if (m) return local(m[1]!, Number(m[2] ?? 0), Number(m[3] ?? 0), Number(m[4] ?? 0), zone);
  return null;
}

/** An instant as history and email show it, the same for every reader: "2026-11-20 14:00 UTC". */
export function formatInstant(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
