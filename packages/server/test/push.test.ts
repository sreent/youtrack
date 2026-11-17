/**
 * Push notifications to people's devices (docs/architecture.md, D47): turning push on for a
 * device, what the notifier queues, what reaches the push service and decrypts there, and what
 * ends a device: the service saying it's gone, its sign-in ending, refusals in a row.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { systemCtx } from '../src/app-services';
import { DEFAULT_PUSH_HOSTS } from '../src/config';
import type { Ctx, UserRow } from '../src/context';
import { notifications, pushOutbox, pushSubscriptions, sessions } from '../src/db/schema';
import { OutboxWorker } from '../src/events/worker';
import { createHttpApp } from '../src/http/app';
import { sha256 } from '../src/lib/crypto';
import { notifierConsumer } from '../src/notify/notifier';
import { PUSH_SETTLE_MS, PushWorker, pushSends } from '../src/push/outbox';
import { deviceLabel, pushEndpointAllowed, sendTestPush, vapidKeys } from '../src/push/service';
import { addComment } from '../src/services/comments';
import { createIssue, setIssueVisibility, updateIssue } from '../src/services/issues';
import { markNotifications, updateNotificationSettings } from '../src/services/notifications';
import { startSession } from '../src/services/auth';
import { createWorld, type TestWorld } from './helpers';
import { fakePush, type FakeDevice, type FakePush } from './fake-push';

let w: TestWorld;
let push: FakePush;
let outbox: OutboxWorker;
let http: ReturnType<typeof createHttpApp>;
const PUBLIC = 'http://a4a.test';
const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

const as = (u: UserRow): Ctx => systemCtx(w.app, u, 'web');
/** The push sender, past every push's settle time. */
const sender = (aheadMs = PUSH_SETTLE_MS + 1000) => new PushWorker(w.app, () => new Date(Date.now() + aheadMs));

async function signIn(u: UserRow): Promise<string> {
  return (await startSession(w.app.db, u.id, 30, CHROME_ANDROID)).token;
}

function post(path: string, token: string, body: unknown) {
  return http.request(`/api/v1${path}`, {
    method: 'POST',
    headers: { cookie: `a4a_session=${token}`, origin: PUBLIC, 'content-type': 'application/json', 'user-agent': CHROME_ANDROID },
    body: JSON.stringify(body),
  });
}

async function turnOn(token: string, device: FakeDevice) {
  const res = await post('/push/devices', token, { endpoint: device.endpoint, keys: device.keys });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; label: string; current: boolean };
}

/** What reached a device, decrypted. */
const to = (device: FakeDevice) => push.received.filter((r) => r.path === new URL(device.endpoint).pathname);

beforeAll(async () => {
  push = await fakePush();
  w = await createWorld({
    config: {
      publicUrl: PUBLIC,
      notifyWindowMs: 60_000,
      push: { enabled: true, vapid: null, subject: 'mailto:a4a@example.com', hosts: DEFAULT_PUSH_HOSTS, allowHttpLoopback: true },
    },
  });
  outbox = new OutboxWorker(w.app, [notifierConsumer(w.app)], {}, [], () => {});
  await outbox.drain();
  http = createHttpApp(w.app);
});

afterAll(async () => {
  await w?.close();
  await push?.close();
});

beforeEach(async () => {
  // Each test starts with no devices and nothing waiting.
  await w.app.db.delete(pushSubscriptions);
  push.received.length = 0;
  for (const u of [w.anna, w.ben]) await updateNotificationSettings(as(u), { push: 'direct' });
});

describe("the server's key", () => {
  it('is made once and kept, the same for every instance, its private half sealed', async () => {
    const res = await http.request('/api/v1/push/key', { headers: { cookie: `a4a_session=${await signIn(w.anna)}` } });
    const key = (await res.json()) as { enabled: boolean; publicKey: string };
    expect(key.enabled).toBe(true);
    expect(Buffer.from(key.publicKey, 'base64url')).toHaveLength(65);
    // Another instance (a runtime of its own, the same database) reads the same pair.
    const other = await vapidKeys({ ...w.app } as typeof w.app);
    expect(other.publicKey).toBe(key.publicKey);
    const { settings } = await import('../src/db/schema');
    const [row] = await w.app.db.select().from(settings).where(eq(settings.key, 'vapidKeys'));
    expect(JSON.stringify(row!.value)).not.toContain(other.privateKey);
  });
});

describe('turning push on for a device', () => {
  it('keeps a browser signed in as the person, named by its browser', async () => {
    const device = push.device('phone');
    const token = await signIn(w.anna);
    const saved = await turnOn(token, device);
    expect(saved).toMatchObject({ label: 'Chrome on Android', current: true });
    const list = await http.request(`/api/v1/push/devices?endpoint=${encodeURIComponent(device.endpoint)}`, { headers: { cookie: `a4a_session=${token}` } });
    expect(((await list.json()) as { current: boolean; service: string }[]).map((d) => [d.current, d.service])).toEqual([[true, '127.0.0.1']]);
    // Given again from a new sign-in, it's the same device, now that sign-in's.
    const again = await signIn(w.anna);
    expect((await turnOn(again, device)).id).toBe(saved.id);
    const [row] = await w.app.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, saved.id));
    expect(row!.sessionId).toBe(sha256(again));
  });

  it('refuses an API token, a push service a4a doesn’t know, and keys it can’t encrypt to', async () => {
    const device = push.device();
    const token = await signIn(w.anna);
    const { issueTokenFor } = await import('../src/services/auth');
    const api = await issueTokenFor(w.app.db, w.anna.id, { name: 'phone', scopes: ['read', 'write'] });
    const byToken = await http.request('/api/v1/push/devices', {
      method: 'POST',
      headers: { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: device.endpoint, keys: device.keys }),
    });
    expect(byToken.status).toBe(400);
    expect(((await byToken.json()) as { error: { message: string } }).error.message).toMatch(/browser you sign in on/);

    const elsewhere = await post('/push/devices', token, { endpoint: 'https://push.evil.example/send/1', keys: device.keys });
    expect(elsewhere.status).toBe(400);
    expect(((await elsewhere.json()) as { error: { message: string; hint: string } }).error).toMatchObject({ message: "a4a doesn't send to push.evil.example" });

    const bad = await post('/push/devices', token, { endpoint: device.endpoint, keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: device.keys.auth } });
    expect(bad.status).toBe(400);
    expect(await w.app.db.select().from(pushSubscriptions)).toHaveLength(0);
  });

  it('sends only to the browsers’ push services, over https', () => {
    const config = { ...w.app.config.push, allowHttpLoopback: false };
    expect(pushEndpointAllowed(config, 'https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(pushEndpointAllowed(config, 'https://wns2-par02p.notify.windows.com/w/?token=x')).toBe(true);
    expect(pushEndpointAllowed(config, 'https://notify.windows.com.evil.example/w')).toBe(false);
    expect(pushEndpointAllowed(config, 'http://fcm.googleapis.com/fcm/send/abc')).toBe(false);
    expect(pushEndpointAllowed(config, 'https://fcm.googleapis.com:8443/fcm/send/abc')).toBe(false);
    expect(pushEndpointAllowed(config, 'https://user:pw@fcm.googleapis.com/x')).toBe(false);
    expect(pushEndpointAllowed(config, 'http://127.0.0.1:9/push')).toBe(false);
    expect(pushEndpointAllowed({ ...config, allowHttpLoopback: true }, 'http://127.0.0.1:9/push')).toBe(true);
    expect(pushEndpointAllowed({ ...config, allowHttpLoopback: true }, 'http://10.0.0.5/push')).toBe(false);
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1')).toBe('Safari on iOS');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0')).toBe('Edge on Windows');
  });
});

describe('what the notifier pushes', () => {
  it('pushes an assignment a moment later, encrypted to the device, signed with the key', async () => {
    const device = push.device('anna');
    await turnOn(await signIn(w.anna), device);
    const issue = await createIssue(as(w.ben), { project: 'BACK', summary: 'Checkout fails for every card', fields: { Assignee: 'anna' } });
    await outbox.drain();
    const [queued] = await w.app.db.select().from(pushOutbox);
    expect(queued!.sendAfter.getTime()).toBeGreaterThan(Date.now());
    // Not before it's due.
    await new PushWorker(w.app).drain();
    expect(to(device)).toHaveLength(0);
    await sender().drain();
    const [got] = to(device);
    expect(got!.payload).toMatchObject({
      title: `${issue.id}: Checkout fails for every card`,
      body: 'Ben Okafor reported it and assigned it to you',
      url: `/issues/${issue.id}`,
      unread: 1,
      renotify: true,
    });
    expect(got!.headers).toMatchObject({ 'content-encoding': 'aes128gcm', ttl: '43200', urgency: 'high' });
    expect(got!.headers.topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    expect(got!.vapid).toMatchObject({ aud: push.url, sub: 'mailto:a4a@example.com', key: (await vapidKeys(w.app)).publicKey });
    const [sent] = await w.app.db.select().from(pushOutbox);
    expect(sent!.status).toBe('sent');
  });

  it('sends a burst on one issue as one push, and again only when it calls on them more', async () => {
    const device = push.device('anna');
    await turnOn(await signIn(w.anna), device);
    await updateNotificationSettings(as(w.anna), { push: 'all' });
    const issue = await createIssue(as(w.anna), { project: 'BACK', summary: 'Export times out on big projects' });
    await outbox.drain();
    for (const text of ['Seen on the staging box too.', 'And with the CSV export.']) await addComment(as(w.ben), issue.id, text);
    await outbox.drain();
    await sender().drain();
    expect(to(device)).toHaveLength(1);
    expect(to(device)[0]!.payload).toMatchObject({ body: 'Ben Okafor commented twice\nAnd with the CSV export.' });
    // Another comment folds in: no new push. A mention folding in calls on her: it pushes again.
    await addComment(as(w.ben), issue.id, 'One more.');
    await outbox.drain();
    await sender().drain();
    expect(to(device)).toHaveLength(1);
    await addComment(as(w.ben), issue.id, '@anna could you look at this?');
    await outbox.drain();
    await sender().drain();
    expect(to(device)).toHaveLength(2);
    expect((to(device)[1]!.payload as { body: string; tag: string }).body).toMatch(/^Ben Okafor mentioned you/);
    expect((to(device)[0]!.payload as { tag: string }).tag).toBe((to(device)[1]!.payload as { tag: string }).tag);
  });

  it('follows the person’s level: direct leaves out what they watch, none sends nothing', async () => {
    expect([pushSends('direct', 'watching'), pushSends('direct', 'mentioned'), pushSends('all', 'subscribed'), pushSends('none', 'assigned')]).toEqual([false, true, true, false]);
    const device = push.device('anna');
    await turnOn(await signIn(w.anna), device);
    const issue = await createIssue(as(w.anna), { project: 'BACK', summary: 'Footer is a pixel off' });
    await addComment(as(w.ben), issue.id, 'I see it too.');
    await outbox.drain();
    await updateNotificationSettings(as(w.anna), { push: 'none' });
    await updateIssue(as(w.ben), issue.id, { fields: { Assignee: 'anna' } });
    await outbox.drain();
    expect(await w.app.db.select().from(pushOutbox).where(eq(pushOutbox.subscriptionId, (await w.app.db.select().from(pushSubscriptions))[0]!.id))).toHaveLength(0);
  });

  it('sends nothing once read, or once the issue is limited away from them', async () => {
    const device = push.device('anna');
    await turnOn(await signIn(w.anna), device);
    const read = await createIssue(as(w.ben), { project: 'BACK', summary: 'Read before it went', fields: { Assignee: 'anna' } });
    // Mentioned, not assigned: an assignee always sees their issue (D37).
    const hidden = await createIssue(as(w.ben), { project: 'BACK', summary: 'Limited before it went', description: 'For @anna to look at.' });
    await outbox.drain();
    const mine = await w.app.db.select().from(notifications).where(eq(notifications.userId, w.anna.id));
    const ofRead = mine.find((x) => (x.issue as { id: string }).id === read.id)!;
    await markNotifications(as(w.anna), { ids: [ofRead.id] });
    const limited = await setIssueVisibility(systemCtx(w.app, w.admin, 'web'), hidden.id, { visibleTo: { users: ['ben'], groups: [] } });
    expect(limited.limited).toBe(true);
    const { getIssue } = await import('../src/services/issues');
    await expect(getIssue(as(w.anna), hidden.id)).rejects.toThrow(/not found/i);
    await sender().drain();
    expect(to(device).map((r) => r.payload)).toEqual([]);
    expect((await w.app.db.select().from(pushOutbox)).map((r) => r.status).sort()).toEqual(['skipped', 'skipped']);
  });
});

describe('what ends a device', () => {
  it('forgets a device its push service says is gone', async () => {
    const device = push.device('gone');
    await turnOn(await signIn(w.anna), device);
    push.answer(device, 410);
    await createIssue(as(w.ben), { project: 'BACK', summary: 'Sent to a phone since reset', fields: { Assignee: 'anna' } });
    await outbox.drain();
    await sender().drain();
    expect(await w.app.db.select().from(pushSubscriptions)).toHaveLength(0);
    expect(await w.app.db.select().from(pushOutbox)).toHaveLength(0);
  });

  it('tries again later when the service is busy, as long as it asks', async () => {
    const device = push.device('busy');
    await turnOn(await signIn(w.anna), device);
    push.answer(device, 429, 503);
    await createIssue(as(w.ben), { project: 'BACK', summary: 'Pushed on the third try', fields: { Assignee: 'anna' } });
    await outbox.drain();
    await sender().drain();
    let [row] = await w.app.db.select().from(pushOutbox);
    expect(row).toMatchObject({ status: 'pending', attempts: 1 });
    expect(row!.lastError).toMatch(/answered 429/);
    await sender(PUSH_SETTLE_MS + 60_000).drain();
    [row] = await w.app.db.select().from(pushOutbox);
    expect(row).toMatchObject({ status: 'pending', attempts: 2 });
    await sender(PUSH_SETTLE_MS + 10 * 60_000).drain();
    [row] = await w.app.db.select().from(pushOutbox);
    expect(row!.status).toBe('sent');
    expect(to(device)).toHaveLength(3);
  });

  it('forgets a device after five refusals in a row', async () => {
    const device = push.device('refusing');
    await turnOn(await signIn(w.anna), device);
    push.answer(device, 403, 403, 403, 403, 403);
    for (let i = 0; i < 5; i++) {
      const issue = await createIssue(as(w.ben), { project: 'BACK', summary: `Refused ${i}`, fields: { Assignee: 'anna' } });
      await outbox.drain();
      await sender().drain();
      expect(issue.id).toBeTruthy();
    }
    expect(await w.app.db.select().from(pushSubscriptions)).toHaveLength(0);
  });

  it('ends with the sign-in that turned it on', async () => {
    const device = push.device('signed-out');
    const token = await signIn(w.anna);
    await turnOn(token, device);
    const out = await http.request('/api/v1/auth/logout', { method: 'POST', headers: { cookie: `a4a_session=${token}`, origin: PUBLIC } });
    expect(out.status).toBe(204);
    expect(await w.app.db.select().from(pushSubscriptions)).toHaveLength(0);

    // A sign-in that ran out is no better: nothing is sent, and the device is forgotten.
    const later = await signIn(w.anna);
    await turnOn(later, device);
    await w.app.db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.id, sha256(later)));
    await createIssue(as(w.ben), { project: 'BACK', summary: 'After the sign-in ran out', fields: { Assignee: 'anna' } });
    await outbox.drain();
    await sender().drain();
    expect(to(device)).toHaveLength(0);
    expect(await w.app.db.select().from(pushSubscriptions)).toHaveLength(0);
  });

  it('sends a test push to each device now, and says how it went', async () => {
    const phone = push.device('phone');
    const old = push.device('old');
    await turnOn(await signIn(w.anna), phone);
    await turnOn(await signIn(w.anna), old);
    push.answer(old, 404);
    const result = await sendTestPush(as(w.anna));
    expect(result).toEqual({ sent: 1, failed: [], ended: 1 });
    expect(to(phone)[0]!.payload).toMatchObject({ title: 'a4a', body: 'Push notifications reach Chrome on Android.', url: '/me' });
  });
});
