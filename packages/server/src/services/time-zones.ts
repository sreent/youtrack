/**
 * Whose time zone a date is read in (D31). A person's own, from their profile, or else the server's:
 * "today" in their searches, the hour their digest comes, the times in their email, the day their
 * logged work falls on. An agent acting for a person reads dates as that person does. Rules,
 * scheduled work and agents with no zone of their own (the workflow agent, triage) read them in the
 * server's, so a rule means the same whoever's change sets it off.
 */
import type { Ctx, UserRow } from '../context';
import { badRequest } from '../lib/errors';
import { serverTimeZone } from '../reports/tz';

/** The zone's canonical IANA name ("US/Eastern" is America/New_York), or null if this server doesn't know it. */
export function canonicalTimeZone(name: string): string | null {
  const zone = name.trim();
  if (!zone) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** A zone someone chose, canonical; a 400 with a hint when it isn't one. */
export function timeZoneOrRefuse(name: string): string {
  const zone = canonicalTimeZone(name);
  if (!zone) throw badRequest(`Unknown time zone "${name}"`, 'Use an IANA name such as Europe/Berlin, America/New_York or UTC.');
  return zone;
}

/** A person's zone: their own while this server still knows it, else the server's. */
export function zoneOfUser(user: Pick<UserRow, 'timeZone'> | null | undefined): string {
  const own = user?.timeZone ? canonicalTimeZone(user.timeZone) : null;
  return own ?? serverTimeZone();
}

/** The zone a call reads dates in: its person's (an agent's own, or the server's, when it has none). */
export function zoneOf(ctx: Ctx): string {
  return zoneOfUser(ctx.actor.user);
}
