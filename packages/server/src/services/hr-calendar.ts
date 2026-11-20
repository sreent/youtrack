/**
 * An HR calendar (D36's revisit): an iCal feed on a person, set by an administrator. Its events
 * are filed as their days away, one whole or half day each, marked `source: 'hr'`; only the feed
 * changes them (the person's edits are refused), and a row whose event leaves the feed is gone.
 */
import type { AppServices } from '../context';
import { absences, users } from '../db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { newId } from '../lib/ids';

interface HrEvent {
  uid: string;
  /** The first day away, and the first day back (exclusive), as YYYY-MM-DD. */
  from: string;
  to: string;
  /** 'morning' | 'afternoon' on a one-day event whose time says so; null for whole days. */
  half: string | null;
  summary: string;
}

/** One ICS feed, unfolded: a line that continues starts with a space or a tab. */
function unfold(raw: string): string {
  return raw
    .split(String.fromCharCode(10))
    .map((l) => (/^[ \t]/.test(l) ? l.slice(1) : l))
    .join(String.fromCharCode(10))
    .split(String.fromCharCode(13) + String.fromCharCode(10))
    .join(String.fromCharCode(10));
}

/** A DATE or DATE-TIME property's day, as YYYY-MM-DD. */
function dayOf(v: string): string | null {
  const m = /^([0-9]{8})/.exec(v);
  if (!m) return null;
  return `${m[1]!.slice(0, 4)}-${m[1]!.slice(4, 6)}-${m[1]!.slice(6, 8)}`;
}

/** The minutes after midnight a DATE-TIME names; null for a whole-day value. */
function minutesOf(v: string): number | null {
  const m = /^[0-9]{8}T([0-9]{2})([0-9]{2})/.exec(v);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** The VEVENTs of an ICS feed: each with its UID, its days, and what it says. */
export function parseIcs(raw: string): HrEvent[] {
  const out: HrEvent[] = [];
  const text = unfold(raw);
  for (const block of text.split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0] ?? '';
    const props: Record<string, { value?: string; params?: Record<string, string> }> = {};
    for (const line of body.split(String.fromCharCode(10))) {
      const [keyRaw, ...rest] = line.split(':');
      if (!keyRaw) continue;
      const value = rest.join(':');
      const [name, ...paramBits] = keyRaw.split(';');
      const params: Record<string, string> = {};
      for (const p of paramBits) {
        const [pn, ...pv] = p.split('=');
        if (pn) params[pn.toUpperCase()] = (pv.join('=') || 'true').replace(/^"|"$/g, '').replace(/\"/g, '"');
      }
      props[name.toUpperCase()] = { value, params };
    }
    const uid = props['UID']?.value;
    if (!uid) continue;
    const start = props['DTSTART']?.value;
    if (!start) continue;
    const isDate = props['DTSTART']?.params?.VALUE === 'DATE';
    const from = isDate ? dayOf(start) : dayOf(start);
    if (!from) continue;
    const endVal = props['DTEND']?.value;
    const endIsDate = props['DTEND']?.params?.VALUE === 'DATE';
    const to = endVal ? dayOf(endVal) ?? from : from;
    const sm = minutesOf(start);
    const em = endVal && !endIsDate ? minutesOf(endVal) : null;
    const single = to === from;
    let half: string | null = null;
    if (single && sm !== null) {
      const endMin = em ?? sm + 240;
      if (endMin <= 720) half = 'morning';
      else if (sm >= 720) half = 'afternoon';
    }
    out.push({ uid, from, to, half, summary: props['SUMMARY']?.value ?? '' });
  }
  return out;
}

/** The days [from, to) of an event, as dates. */
function daysOf(e: HrEvent): string[] {
  if (e.to === e.from) return [e.from];
  const out: string[] = [];
  const d = new Date(`${e.from}T00:00:00Z`);
  const end = new Date(`${e.to}T00:00:00Z`);
  for (; d < end; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

/** One person's feed, fetched and filed. Returns how many rows it made and removed. */
export async function syncHrFeed(app: AppServices, userId: string, url: string): Promise<{ made: number; removed: number }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`The HR calendar at ${url} answered ${res.status}`);
  const events = parseIcs(await res.text());
  const uids = new Set(events.map((e) => e.uid));
  const existing = await app.db.select().from(absences).where(and(eq(absences.userId, userId), eq(absences.source, 'hr')));
  let made = 0;
  let removed = 0;
  for (const row of existing) {
    if (row.externalId && !uids.has(row.externalId)) {
      await app.db.delete(absences).where(eq(absences.id, row.id));
      removed += 1;
    }
  }
  const overlaps = await app.db.select({ from: absences.startDate, to: absences.endDate }).from(absences).where(eq(absences.userId, userId));
  const taken = (d: string) => overlaps.some((o) => d >= o.from && d <= o.to);
  for (const e of events) {
    const days = daysOf(e).filter((d) => !taken(d));
    if (!days.length) continue;
    const prior = existing.find((x) => x.externalId === e.uid);
    const from = days[0]!;
    const to = days[days.length - 1]!;
    if (prior) {
      await app.db.update(absences).set({ startDate: from, endDate: to, half: e.half, note: e.summary }).where(eq(absences.id, prior.id));
    } else {
      await app.db.insert(absences).values({ id: newId(), userId, startDate: from, endDate: to, half: e.half, kind: 'other', note: e.summary, source: 'hr', externalId: e.uid, version: 1 });
      made += 1;
    }
  }
  return { made, removed };
}

/** Every person whose HR calendar says so: fetched and filed, each on their own. */
export async function syncHrCalendars(app: AppServices): Promise<void> {
  const rows = await app.db.select({ id: users.id, url: users.hrCalendar }).from(users).where(isNull(users.banned));
  for (const row of rows) {
    if (!row.url) continue;
    try {
      await syncHrFeed(app, row.id, row.url);
    } catch (e) {
      console.warn(`HR calendar for ${row.id} failed`, e);
    }
  }
}
