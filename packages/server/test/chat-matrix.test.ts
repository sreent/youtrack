/**
 * Matrix (D42's revisit): an administrator connects a homeserver with its bot account's token (kept
 * sealed), its rooms are the channels, a subscribed room hears of a project's issues as plain text
 * with a formatted copy, a revoked token ends it, and disconnecting forgets it.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatConsumer, ChatWorker } from '../src/chat/outbox';
import { OutboxWorker } from '../src/events/worker';
import { createHttpApp } from '../src/http/app';
import { createIssue } from '../src/services/issues';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let http: ReturnType<typeof createHttpApp>;
let outbox: OutboxWorker;
let sender: ChatWorker;
let homeserver: Server;
let port: number;
const sent: { room: string; body: Record<string, unknown> }[] = [];
let syncSeen = 0;

async function call(method: string, path: string, token: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await http.request(`/api/v1${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

beforeAll(async () => {
  homeserver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      res.setHeader('content-type', 'application/json');
      if (url.includes('/sync')) {
        // The bot's one turn: the first sync reads the message, the rest are empty.
        const first = syncSeen++ === 0 ? [{ type: 'm.room.message', event_id: '$e1', sender: '@anna:mock', content: { body: '!a4a help', msgtype: 'm.text' } }, { type: 'm.room.message', event_id: '$e2', sender: '@vera:mock', content: { body: '!a4a link', msgtype: 'm.text' } }] : [];
        return res.end(JSON.stringify({ next_batch: `b${syncSeen}`, rooms: { join: { '!room:mock': { timeline: { events: first } } } } }));
      }
      if (url.endsWith('/account/whoami')) return res.end(JSON.stringify({ user_id: '@a4a:mock', device_id: 'D' }));
      if (url.endsWith('/joined_rooms')) return res.end(JSON.stringify({ joined_rooms: ['!room:mock'] }));
      if (url.includes('/state/m.room.name')) return res.end(JSON.stringify({ name: 'Engineering' }));
      if (url.includes('/send/m.room.message/')) {
        sent.push({ room: '!room:mock', body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown> });
        return res.end(JSON.stringify({ event_id: `$e${sent.length}` }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ errcode: 'M_NOT_FOUND', error: 'no such endpoint' }));
    });
  });
  await new Promise<void>((done) => homeserver.listen(0, '127.0.0.1', done));
  port = (homeserver.address() as { port: number }).port;
  w = await createWorld({ config: { chatAllowHttpLoopback: true } });
  http = createHttpApp(w.app);
  outbox = new OutboxWorker(w.app, [chatConsumer(w.app)], {}, [], () => {});
  await outbox.drain();
  sender = new ChatWorker(w.app);
});

afterAll(async () => {
  await sender?.stop();
  await outbox?.stop();
  await new Promise<void>((done) => homeserver.close(() => done()));
  await w?.close();
});

describe('Matrix', () => {
  it('connects, lists its rooms, posts to a subscribed room as text, and disconnects', async () => {
    const token = (await (await import('../src/services/auth')).issueTokenFor(w.app.db, w.admin.id, { name: 'admin', scopes: ['read', 'write', 'admin'] })).token;
    const up = await call('POST', '/chat/matrix', token, { homeserver: `http://127.0.0.1:${port}`, accessToken: 'syt_bot' });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const st = (up.body as { matrix: { connected: boolean; userId: string } }).matrix;
    expect(st.connected).toBe(true);
    expect(st.userId).toBe('@a4a:mock');
    // Its rooms, read as channels.
    const rooms = await call('POST', '/chat/matrix/rooms', token, {});
    const channels = (rooms.body as { channels: { id: string; name: string; platform: string }[] }).channels;
    const room = channels.find((c) => c.platform === 'matrix');
    expect(room).toMatchObject({ name: 'Engineering' });
    // Subscribe it to the project, and an issue's news reaches it as text.
    const sub = await call('POST', '/chat/subscriptions', token, { channel: room!.id, project: 'BACK' });
    expect(sub.status).toBe(201);
    await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Ring the room' });
    for (let i = 0; i < 6 && !sent.length; i++) {
      await outbox.drain();
      await sender.drain();
    }
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]!.body.msgtype).toBe('m.text');
    expect(String(sent[0]!.body.body)).toContain('Ring the room');
    expect(sent[0]!.body.format).toBe('org.matrix.custom.html');
    // Disconnecting forgets it.
    const off = await call('DELETE', '/chat/matrix', token);
    expect(off.status).toBe(204);
    const after = await call('GET', '/chat/status', token);
    expect((after.body as { matrix: { connected: boolean } }).matrix.connected).toBe(false);
  });
  it('the bot listens over /sync: what names it is answered in the room, and a stranger is sent the link', async () => {
    const token = (await (await import('../src/services/auth')).issueTokenFor(w.app.db, w.admin.id, { name: 'admin', scopes: ['read', 'write', 'admin'] })).token;
    await call('POST', '/chat/matrix', token, { homeserver: `http://127.0.0.1:${port}`, accessToken: 'syt_bot' });
    await (await import('../src/chat/matrix')).syncMatrix(w.app);
    // @anna:mock is known (an a4a account by the same login? none is linked yet) - their !a4a help
    // is answered in the room; @vera:mock, nobody a4a knows, is sent the one-time link.
    const posts = sent.filter((s) => s.body.msgtype === 'm.text' && typeof s.body.body === 'string').map((s) => String(s.body.body));
    expect(posts.filter((p) => p.includes('/chat/link')).length, JSON.stringify(posts)).toBeGreaterThanOrEqual(2);
    expect(posts.length).toBeGreaterThanOrEqual(2);
  });
});
