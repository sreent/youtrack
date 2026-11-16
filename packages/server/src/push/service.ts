/**
 * Push notifications to people's devices (docs/architecture.md, D47): the server's key, the devices
 * people turn push on for, and one push sent to one device.
 *
 * - A device is a browser's push subscription, made where the person signed in, and kept while
 *   that sign-in lasts: signing out there, a new password or an administrator ending the sign-in
 *   ends it (the row goes with its session), so a phone handed on hears nothing more.
 * - Its address is the push service's, which the browser chose: someone else's. So a4a sends only
 *   to the known services' hosts (PUSH_HOSTS), over https, and to nowhere a request could name.
 * - What's sent is encrypted to the device (RFC 8291): the push service carries what it can't read.
 */
import { createHash } from 'node:crypto';
import type { PushDevice, PushKey, PushSubscriptionInput, PushTestResult } from '@a4a/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { PushConfig } from '../config';
import type { AppServices, Ctx } from '../context';
import { pushSubscriptions, sessions, settings } from '../db/schema';
import { badRequest, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { open, seal } from '../lib/secret-box';
import { requirePersonal } from '../services/watchers';
import { encryptPayload, generateVapidKeys, validPublicKey, vapidAuthorization, type VapidKeys } from './webpush';

export type DeviceRow = typeof pushSubscriptions.$inferSelect;

// ---------------------------------------------------------------------------
// The server's key
// ---------------------------------------------------------------------------

const VAPID_SETTING = 'vapidKeys';
const keySource = (app: AppServices) => ({ secretKey: app.config.secretKey, dataDir: app.config.dataDir });
const keys = new WeakMap<AppServices, Promise<VapidKeys>>();

/**
 * The key a4a signs pushes with: VAPID_* when set; otherwise a pair made the first time it's
 * needed and kept in the database, its private half sealed as other secrets are (SECRET_KEY), so
 * every instance signs with the same one. A browser subscribes with the public half, and its push
 * service sends only what that key signs.
 */
export function vapidKeys(app: AppServices): Promise<VapidKeys> {
  if (app.config.push.vapid) return Promise.resolve(app.config.push.vapid);
  let made = keys.get(app);
  if (!made) {
    made = (async () => {
      const fresh = generateVapidKeys();
      await app.db
        .insert(settings)
        .values({ key: VAPID_SETTING, value: { publicKey: fresh.publicKey, privateKey: seal(keySource(app), fresh.privateKey) } })
        .onConflictDoNothing();
      const [row] = await app.db.select().from(settings).where(eq(settings.key, VAPID_SETTING));
      const kept = row!.value as { publicKey: string; privateKey: string };
      const privateKey = open(keySource(app), kept.privateKey);
      if (!privateKey) {
        throw new Error("The push key in the database was sealed with another SECRET_KEY: set the SECRET_KEY it was made with, or give VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY");
      }
      return { publicKey: kept.publicKey, privateKey };
    })();
    made.catch(() => keys.delete(app));
    keys.set(app, made);
  }
  return made;
}

export async function pushKey(app: AppServices): Promise<PushKey> {
  if (!app.config.push.enabled) return { enabled: false, publicKey: null };
  return { enabled: true, publicKey: (await vapidKeys(app)).publicKey };
}

// ---------------------------------------------------------------------------
// Where a push may go
// ---------------------------------------------------------------------------

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Whether an address is a known push service's: https on its usual port, or plain http on this machine in tests. */
export function pushEndpointAllowed(config: PushConfig, endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'http:') return config.allowHttpLoopback && LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' || (url.port && url.port !== '443')) return false;
  const host = url.hostname.toLowerCase();
  return config.hosts.some((h) => (h.startsWith('*.') ? host.endsWith(h.slice(1)) : host === h));
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return 'an unknown address';
  }
}

/** What a device is, from its browser's words: "Chrome on Android". */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const browser = /Edg(A|iOS)?\//.test(ua)
    ? 'Edge'
    : /SamsungBrowser\//.test(ua)
      ? 'Samsung Internet'
      : /OPR\//.test(ua)
        ? 'Opera'
        : /(Firefox|FxiOS)\//.test(ua)
          ? 'Firefox'
          : /(Chrome|CriOS)\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : 'A browser';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /CrOS/.test(ua)
        ? 'ChromeOS'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : null;
  return os ? `${browser} on ${os}` : browser;
}

// ---------------------------------------------------------------------------
// A person's devices
// ---------------------------------------------------------------------------

function deviceDto(row: DeviceRow, endpoint?: string): PushDevice {
  return {
    id: row.id,
    label: row.label,
    service: hostOf(row.endpoint),
    createdAt: row.createdAt.toISOString(),
    lastSentAt: row.lastSentAt?.toISOString() ?? null,
    lastError: row.lastError,
    current: endpoint !== undefined && row.endpoint === endpoint,
  };
}

/**
 * Turn push on for the device that asks: its browser's subscription, for the person signed in
 * there and as long as that sign-in lasts. Given again (a new sign-in, a renewed subscription),
 * it's the same device, now theirs and this sign-in's.
 */
export async function registerDevice(ctx: Ctx, sessionId: string | null, input: PushSubscriptionInput, userAgent?: string): Promise<PushDevice> {
  requirePersonal(ctx);
  const config = ctx.app.config.push;
  if (!config.enabled) throw badRequest('This server sends no push notifications', 'An administrator can turn them on: PUSH, on unless "false".');
  if (ctx.actor.authMethod !== 'session' || !sessionId) {
    throw badRequest('Push notifications are for a browser you sign in on', 'Turn them on from your profile in a4a, in the browser on that device.');
  }
  if (!pushEndpointAllowed(config, input.endpoint)) {
    throw badRequest(`a4a doesn't send to ${hostOf(input.endpoint)}`, 'Push works in Chrome, Edge, Firefox and Safari. An administrator can add another push service to PUSH_HOSTS.');
  }
  if (!validPublicKey(input.keys.p256dh) || Buffer.from(input.keys.auth, 'base64url').length !== 16) {
    throw badRequest("The browser's push keys aren't ones a4a can encrypt to", 'Turn push off and on again on this device.');
  }
  const label = deviceLabel(userAgent);
  const row = await ctx.db.transaction(async (tx) => {
    // A renewed subscription replaces the one it renews, if it was this person's.
    if (input.oldEndpoint && input.oldEndpoint !== input.endpoint) {
      await tx.delete(pushSubscriptions).where(and(eq(pushSubscriptions.endpoint, input.oldEndpoint), eq(pushSubscriptions.userId, ctx.actor.user.id)));
    }
    const [saved] = await tx
      .insert(pushSubscriptions)
      .values({ id: newId(), userId: ctx.actor.user.id, sessionId, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, label })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { userId: ctx.actor.user.id, sessionId, p256dh: input.keys.p256dh, auth: input.keys.auth, label, failures: 0, lastError: null },
      })
      .returning();
    return saved!;
  });
  return deviceDto(row, input.endpoint);
}

export async function listDevices(ctx: Ctx, endpoint?: string): Promise<PushDevice[]> {
  requirePersonal(ctx);
  const rows = await ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, ctx.actor.user.id)).orderBy(desc(pushSubscriptions.createdAt));
  return rows.map((r) => deviceDto(r, endpoint));
}

/** Stop pushing to one of your devices: this one, or one you no longer have. */
export async function removeDevice(ctx: Ctx, id: string): Promise<void> {
  requirePersonal(ctx);
  const gone = await ctx.db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, ctx.actor.user.id)))
    .returning({ id: pushSubscriptions.id });
  if (!gone.length) throw notFound('Device', 'List your devices with GET /push/devices.');
}

// ---------------------------------------------------------------------------
// One push to one device
// ---------------------------------------------------------------------------

/** What a device is shown: the service worker draws it (apps/web/public/sw.js). */
export interface PushPayload {
  title: string;
  body: string;
  /** Pushes with one tag replace each other on the device: one per issue. */
  tag: string;
  /** Where tapping it goes, within a4a. */
  url: string;
  /** What's unread, for the app's badge. */
  unread: number | null;
  /** Whether a push replacing an earlier one alerts again. */
  renotify: boolean;
}

export interface PushOptions {
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  /** A newer push with the same topic replaces one the service is still holding for the device. */
  topic?: string;
  /** How long the service keeps it for a device that's away. */
  ttlSeconds?: number;
}

export type PushOutcome =
  | { ok: true }
  | {
      ok: false;
      /** The service says the device is gone (404, 410): it's forgotten. */
      gone: boolean;
      /** The service won't take this message as it is (400, 401, 403, 413): no use trying it again. */
      permanent: boolean;
      retryAfterMs: number | null;
      error: string;
    };

/** A topic for a push service: up to 32 characters of base64url, the same for one issue. */
export function topicFor(key: string): string {
  return createHash('sha256').update(key).digest('base64url').slice(0, 32);
}

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/** Twelve hours: a push older than that is old news, and the inbox has it. */
export const PUSH_TTL_SECONDS = 12 * 3600;

/** Encrypt a payload to one device and hand it to its push service. Never throws for what the service says. */
export async function sendPush(app: AppServices, device: Pick<DeviceRow, 'endpoint' | 'p256dh' | 'auth'>, payload: unknown, opts: PushOptions = {}): Promise<PushOutcome> {
  const fail = (error: string, more: { gone?: boolean; permanent?: boolean; retryAfterMs?: number | null } = {}): PushOutcome => ({
    ok: false,
    gone: more.gone ?? false,
    permanent: more.permanent ?? false,
    retryAfterMs: more.retryAfterMs ?? null,
    error,
  });
  if (!pushEndpointAllowed(app.config.push, device.endpoint)) return fail(`a4a doesn't send to ${hostOf(device.endpoint)} (PUSH_HOSTS)`, { gone: true });
  let body: Buffer;
  try {
    body = encryptPayload({ p256dh: device.p256dh, auth: device.auth }, Buffer.from(JSON.stringify(payload)));
  } catch (e) {
    return fail(`It couldn't be encrypted to the device: ${e instanceof Error ? e.message : String(e)}`, { permanent: true });
  }
  const url = new URL(device.endpoint);
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'content-encoding': 'aes128gcm',
    ttl: String(opts.ttlSeconds ?? PUSH_TTL_SECONDS),
    urgency: opts.urgency ?? 'normal',
    authorization: vapidAuthorization(await vapidKeys(app), url.origin, app.config.push.subject),
  };
  if (opts.topic) headers.topic = opts.topic;
  let res: Response;
  try {
    // A push service never sends a4a elsewhere: a redirect is an answer, not a place to go.
    res = await fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    return fail(`The push service didn't answer: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status >= 200 && res.status < 300) {
    await res.body?.cancel().catch(() => {});
    return { ok: true };
  }
  const said = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
  const error = `${hostOf(device.endpoint)} answered ${res.status}${said ? `: ${said}` : ''}`;
  if (res.status === 404 || res.status === 410) return fail(error, { gone: true });
  if (res.status === 429 || res.status >= 500) return fail(error, { retryAfterMs: retryAfterMs(res.headers.get('retry-after')) });
  return fail(error, { permanent: true });
}

/** Refusals in a row, not counting "gone", after which a device is forgotten. */
export const MAX_FAILURES = 5;

/** Keep what a push to a device came to: when it last took one, what it last refused, or that it's gone. */
export async function noteOutcome(app: AppServices, device: DeviceRow, outcome: PushOutcome): Promise<'sent' | 'ended' | 'failed'> {
  if (outcome.ok) {
    await app.db.update(pushSubscriptions).set({ lastSentAt: new Date(), failures: 0, lastError: null }).where(eq(pushSubscriptions.id, device.id));
    return 'sent';
  }
  if (outcome.gone || (outcome.permanent && device.failures + 1 >= MAX_FAILURES)) {
    await app.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, device.id));
    return 'ended';
  }
  await app.db
    .update(pushSubscriptions)
    .set({ lastError: outcome.error, ...(outcome.permanent ? { failures: sql`${pushSubscriptions.failures} + 1` } : {}) })
    .where(eq(pushSubscriptions.id, device.id));
  return 'failed';
}

/** Whether a device's sign-in still lasts: a device whose sign-in ended is forgotten, not pushed to. */
export async function deviceSignedIn(app: AppServices, device: DeviceRow): Promise<boolean> {
  if (!device.sessionId) return false;
  const [session] = await app.db.select({ expiresAt: sessions.expiresAt }).from(sessions).where(eq(sessions.id, device.sessionId));
  return Boolean(session && session.expiresAt > new Date());
}

/** A push to each of your devices now, to see they get them. */
export async function sendTestPush(ctx: Ctx): Promise<PushTestResult> {
  requirePersonal(ctx);
  if (!ctx.app.config.push.enabled) throw badRequest('This server sends no push notifications', 'An administrator can turn them on: PUSH, on unless "false".');
  const devices = await ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, ctx.actor.user.id));
  if (!devices.length) throw badRequest('Push is off on all your devices', 'Turn it on from your profile, on the device you want them on.');
  const result: PushTestResult = { sent: 0, failed: [], ended: 0 };
  for (const device of devices) {
    if (!(await deviceSignedIn(ctx.app, device))) {
      await ctx.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, device.id));
      result.ended++;
      continue;
    }
    const payload: PushPayload = {
      title: 'a4a',
      body: `Push notifications reach ${device.label}.`,
      tag: 'a4a-test',
      url: '/me',
      unread: null,
      renotify: true,
    };
    const outcome = await sendPush(ctx.app, device, payload, { urgency: 'high', ttlSeconds: 60 });
    const noted = await noteOutcome(ctx.app, device, outcome);
    if (noted === 'sent') result.sent++;
    else if (noted === 'ended') result.ended++;
    else result.failed.push({ device: device.label, error: outcome.ok ? '' : outcome.error });
  }
  return result;
}
