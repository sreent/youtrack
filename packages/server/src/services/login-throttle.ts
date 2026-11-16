import { inArray, lt, sql, and, gt } from 'drizzle-orm';
import type { Db } from '../db/client';
import { loginThrottle } from '../db/schema';

/**
 * Sign-in throttling, shared by every instance through Postgres and kept across
 * restarts. Failures count per IP (one address trying many logins) and per login
 * (many addresses trying one), each in a fixed 15-minute window.
 *
 * An attempt is counted before the password is checked, so parallel guesses can't
 * slip past the limit between a check and a write; a correct password takes its
 * count back. The price of the per-login limit: someone who knows a login can keep
 * it locked by failing ten times a window. Its owner then waits for the window, as
 * the 429 says.
 */
export const LOGIN_THROTTLE = {
  windowMs: 15 * 60_000,
  /** Failures allowed per login in a window. */
  perLogin: 10,
  /** Failures allowed per IP in a window (an office behind one address shares it). */
  perIp: 50,
} as const;

export interface LoginAttempt {
  /** Seconds until another attempt is allowed; 0 when this one may go ahead. */
  wait: number;
  /** The password was right: take this attempt's count back. */
  succeeded(): Promise<void>;
}

function keysFor(ip: string, login: string): { ip: string; login: string } {
  // Capped: a key is an index entry, and no real login or address is longer.
  return { ip: `ip:${ip.trim().slice(0, 64)}`, login: `login:${login.trim().toLowerCase().slice(0, 64)}` };
}

/** Count an attempt for `ip` and `login`, in one upsert, and say whether it may go ahead. */
export async function beginLoginAttempt(db: Db, ip: string, login: string): Promise<LoginAttempt> {
  const keys = keysFor(ip, login);
  const window = sql`${LOGIN_THROTTLE.windowMs}::integer * interval '1 millisecond'`;
  const expired = sql`${loginThrottle.windowStart} <= now() - ${window}`;
  const rows = await db
    .insert(loginThrottle)
    .values([
      { key: keys.ip, windowStart: sql`now()`, failures: 1 },
      { key: keys.login, windowStart: sql`now()`, failures: 1 },
    ])
    .onConflictDoUpdate({
      target: loginThrottle.key,
      // Both read the row as it was: a window that has passed starts again at this attempt.
      set: {
        failures: sql`case when ${expired} then 1 else ${loginThrottle.failures} + 1 end`,
        windowStart: sql`case when ${expired} then now() else ${loginThrottle.windowStart} end`,
      },
    })
    .returning({
      key: loginThrottle.key,
      failures: loginThrottle.failures,
      wait: sql<number>`greatest(1, ceil(extract(epoch from (${loginThrottle.windowStart} + ${window} - now()))))::integer`,
    });
  let wait = 0;
  for (const r of rows) {
    const limit = r.key === keys.ip ? LOGIN_THROTTLE.perIp : LOGIN_THROTTLE.perLogin;
    if (r.failures > limit) wait = Math.max(wait, Number(r.wait));
  }
  return {
    wait,
    succeeded: async () => {
      await db
        .update(loginThrottle)
        .set({ failures: sql`${loginThrottle.failures} - 1` })
        .where(and(inArray(loginThrottle.key, [keys.ip, keys.login]), gt(loginThrottle.failures, 0)));
    },
  };
}

/** Housekeeping: forget windows that have passed. */
export async function pruneLoginThrottle(db: Db): Promise<void> {
  await db.delete(loginThrottle).where(lt(loginThrottle.windowStart, sql`now() - ${LOGIN_THROTTLE.windowMs}::integer * interval '1 millisecond'`));
}

/** "14 minutes", "1 minute", "30 seconds". */
export function waitInWords(seconds: number): string {
  if (seconds < 60) return seconds === 1 ? '1 second' : `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}
