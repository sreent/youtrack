/**
 * An HR calendar (D36's revisit): its iCal feed's days are filed as the person's, whole or half,
 * marked the feed's own; an event leaving the feed leaves with its row; the person can't edit them.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, type TestWorld } from './helpers';
import { syncHrFeed } from '../src/services/hr-calendar';
import { listAbsences, updateAbsence, deleteAbsence } from '../src/services/absences';
import { updateUser } from '../src/services/users';

let w: TestWorld;
let server: Server;
let port = 0;
let feed = '';

beforeAll(async () => {
  w = await createWorld();
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/calendar');
    res.end(feed);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('an HR calendar', () => {
  it('files its whole and half days, keeps them the feed\'s own, and takes back what left it', async () => {
    const who = w.anna;
    feed = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:ev-1@hr.example',
      'DTSTART;VALUE=DATE:20261130',
      'DTEND;VALUE=DATE:20261203',
      'SUMMARY:Leave',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:ev-2@hr.example',
      'DTSTART:20261207T090000Z',
      'DTEND:20261207T110000Z',
      'SUMMARY:Appointment',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join(String.fromCharCode(13, 10));
    await updateUser(w.adminCtx, 'anna', { hrCalendar: `http://127.0.0.1:${port}/cal.ics` });
    const made = await syncHrFeed(w.app, who.id, `http://127.0.0.1:${port}/cal.ics`);
    expect(made.made).toBe(2);
    const rows = await listAbsences(w.adminCtx, { user: 'anna' });
    expect(rows).toHaveLength(2);
    const whole = rows.find((r) => r.from === '2026-11-30');
    expect(whole).toMatchObject({ from: '2026-11-30', to: '2026-12-02', half: null });
    const half = rows.find((r) => r.from === '2026-12-07');
    expect(half).toMatchObject({ from: '2026-12-07', to: '2026-12-07', half: 'morning' });
    // The feed's rows are its own: the person can't change or remove them.
    const refused = await (async () => {
      try { await updateAbsence(w.as(w.anna), whole!.id, { note: 'no' }); return null; } catch (e) { return e as { status: number }; }
    })();
    expect(refused?.status).toBe(403);
    // The event leaves the feed: its row goes too, and the other stays.
    feed = feed.split('ev-1@hr.example')[0] + 'BEGIN:VEVENT' + String.fromCharCode(13, 10) + 'UID:ev-2@hr.example' + feed.split('UID:ev-2@hr.example')[1]!;
    await syncHrFeed(w.app, who.id, `http://127.0.0.1:${port}/cal.ics`);
    const after = await listAbsences(w.adminCtx, { user: 'anna' });
    expect(after.map((r) => r.from)).toEqual(['2026-12-07']);
  });
});
