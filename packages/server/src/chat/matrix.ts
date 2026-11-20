/**
 * Matrix (D42's revisit): one homeserver per a4a, connected by an administrator with an access token
 * (kept sealed) and a room to post to. a4a calls the Client-Server API alone: posts are plain text
 * with a formatted copy, and the same line no post crosses holds. People can't act from Matrix yet:
 * the bot listens nowhere there, so nobody links an account; subscribing a room is a page's job.
 */
import type { TrackerEvent } from '@a4a/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { requireScope, type AppServices, type Ctx } from '../context';
import { chatChannels, chatWorkspaces } from '../db/schema';
import { newId } from '../lib/ids';
import { badRequest } from '../lib/errors';
import { callableUrl } from '../events/webhooks';
import { cardChange, fallbackText, type CardIssue } from './cards';
import { channelByExternal, chatStatus, linkUrl, markWorkspaceRemoved, personFor, platformName, runChatCommand, upsertChannel, upsertWorkspace, type ChatPerson } from './service';
import { callable, channelTr, ChatCallError, chatCtx, openSecret, personTr, retryAfterMs, sealSecret, stopError, stopReason } from './common';

type WorkspaceRow = typeof chatWorkspaces.$inferSelect;

/** The connected homeserver, if there is one. */
export async function matrixWorkspace(app: AppServices): Promise<WorkspaceRow | undefined> {
  const [ws] = await app.db.select().from(chatWorkspaces).where(and(eq(chatWorkspaces.platform, 'matrix'), isNull(chatWorkspaces.removedAt)));
  return ws;
}

const tokenOf = (app: AppServices, ws: WorkspaceRow) => {
  const token = openSecret(app, ws.botToken);
  if (!token) throw stopError('removed', stopReason('a4a can\'t read the Matrix token it keeps (SECRET_KEY changed?)', 'chat.stop.matrixTokenUnreadable'));
  return token;
};

/** One Client-Server API call, with the bot's token: its answer, or a ChatCallError saying what to do. */
export async function matrixCall(app: AppServices, token: string, homeserver: string, path: string, body?: unknown, method = body === undefined ? 'GET' : 'PUT'): Promise<Record<string, unknown>> {
  const url = `${homeserver.replace(/\/+$/, '')}/_matrix/client/v3${path}`;
  if (!callableUrl(url)) throw new ChatCallError(`a4a doesn't call ${url}: a homeserver is https`, 'failed');
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
  } catch (e) {
    throw new ChatCallError(`Matrix didn't answer: ${e instanceof Error ? e.message : String(e)}`, 'retry');
  }
  if (res.status === 429 || res.status >= 500) {
    const b = (await res.json().catch(() => ({}))) as { retry_after_ms?: number };
    throw new ChatCallError(`Matrix answered ${res.status}`, 'retry', b.retry_after_ms ?? retryAfterMs(res.headers.get('retry-after')));
  }
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown> & { errcode?: string; error?: string };
  if (res.ok) return out;
  if (out.errcode === 'M_UNKNOWN_TOKEN' || out.errcode === 'M_MISSING_TOKEN') throw stopError('removed', stopReason(`Matrix refused a4a's token (${out.errcode}): the session was revoked`, 'chat.stop.matrixTokenRefused', { error: out.errcode ?? 'M_UNKNOWN_TOKEN' }));
  if (out.errcode === 'M_FORBIDDEN') throw stopError('removed', stopReason('Matrix refuses a4a there: the account is no longer in the room, or the homeserver blocks it', 'chat.stop.matrixForbidden'));
  if (out.errcode === 'M_NOT_FOUND' || out.errcode === 'M_UNKNOWN') throw stopError('gone', stopReason('The room was deleted, or a4a can\'t see it', 'chat.stop.matrixRoomGone'));
  throw new ChatCallError(`Matrix said ${out.errcode ?? `HTTP ${res.status}`}`, 'failed', undefined, undefined, out.errcode);
}

// ---------------------------------------------------------------------------
// Connecting, for administrators
// ---------------------------------------------------------------------------

/** Connect the homeserver whose access token an administrator gives. */
export async function connectMatrix(ctx: Ctx, input: { homeserver: string; accessToken: string }) {
  requireScope(ctx, 'admin');
  const app = ctx.app;
  let hs = input.homeserver.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(hs)) hs = `https://${hs}`;
  if (!callableUrl(hs)) throw badRequest('A homeserver is an https address, or this machine for trying it out', 'Give the address people sign in at, e.g. https://matrix.org.').said('chat.matrixBadHomeserver');
  const who = await matrixCall(app, input.accessToken, hs, '/account/whoami');
  if (typeof who.user_id !== 'string') throw badRequest('That token doesn\'t say who it is: Matrix didn\'t answer with a user', 'Give the access token of the account that should post, from its settings.').said('chat.matrixBadToken');
  const ws = await upsertWorkspace(app.db, { platform: 'matrix', externalId: who.user_id, name: who.user_id, serviceUrl: hs, connectedById: ctx.actor.user.id });
  await app.db.update(chatWorkspaces).set({ botToken: sealSecret(app, input.accessToken), name: who.user_id }).where(eq(chatWorkspaces.id, ws.id));
  // Its rooms, as its channels, listed now and whenever the page asks.
  await refreshMatrixRooms(app, who.user_id);
  return chatStatus(ctx);
}

/** Forget the homeserver: its subscriptions stop, with their reason. */
export async function disconnectMatrix(ctx: Ctx): Promise<void> {
  requireScope(ctx, 'admin');
  const ws = await matrixWorkspace(ctx.app);
  if (!ws) return;
  await markWorkspaceRemoved(ctx.app.db, ws.id, stopReason('An administrator disconnected Matrix', 'chat.stop.matrixDisconnected'));
}

// ---------------------------------------------------------------------------
// Rooms, as channels
// ---------------------------------------------------------------------------

/** The rooms the bot's account is in, kept as channels, whatever they're called. */
export async function refreshMatrixRooms(app: AppServices, userId: string): Promise<void> {
  const ws = await matrixWorkspace(app);
  if (!ws) return;
  const token = tokenOf(app, ws);
  const homeserver = ws.serviceUrl;
  if (!homeserver) throw stopError('removed', stopReason('The homeserver has no address', 'chat.stop.noServiceUrl'));
  const joined = await matrixCall(app, token, homeserver, '/joined_rooms');
  const rooms = Array.isArray(joined.joined_rooms) ? (joined.joined_rooms as string[]) : [];
  for (const roomId of rooms.slice(0, 200)) {
    let name = roomId;
    try {
      const state = await matrixCall(app, token, homeserver, `/rooms/${encodeURIComponent(roomId)}/state/m.room.name`);
      if (typeof state.name === 'string' && state.name.trim()) name = state.name.trim();
    } catch (e) {
      if (e instanceof ChatCallError && e.outcome !== 'gone') throw e;
    }
    await upsertChannel(app.db, ws.id, roomId, name);
  }
}

/** One room's post: plain text, with a formatted copy. */
export async function matrixPost(app: AppServices, ws: WorkspaceRow, roomId: string, issue: CardIssue, event: TrackerEvent): Promise<string | null> {
  const tr = channelTr(app);
  const text = fallbackText(issue, tr, cardChange(event, tr));
  const html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  const txn = newId();
  const res = await matrixCall(app, tokenOf(app, ws), ws.serviceUrl!, `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`, { msgtype: 'm.text', body: text, format: 'org.matrix.custom.html', formatted_body: html }, 'PUT');
  return typeof res.event_id === 'string' ? res.event_id : null;
}
// ---------------------------------------------------------------------------
// The bot listens (D42's revisit): what people say to it in its rooms
// ---------------------------------------------------------------------------

const personOf = (ws: WorkspaceRow, userId: string): ChatPerson => ({
  platform: 'matrix',
  workspaceExternalId: ws.externalId,
  workspaceName: ws.name,
  externalUserId: userId,
  name: userId,
});

/** A message is for the bot when it names it: its user id, or the !a4a word. */
function addressed(botId: string, text: string): boolean {
  return text.startsWith('!a4a') || text.includes(botId);
}

/** One plain-text message to a room: the bot's answers and links. */
export async function matrixSendText(app: AppServices, ws: WorkspaceRow, roomId: string, text: string): Promise<void> {
  const txn = newId();
  await matrixCall(app, tokenOf(app, ws), ws.serviceUrl!, `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`, { msgtype: 'm.text', body: text }, 'PUT');
}

// What the bot has seen, briefly: a cursor reset re-reads recent events, and each is answered once.
const seen = new Map<string, { events: Set<string>; since: string; at: number }>();

/**
 * The bot's one turn: long-poll /sync once, and answer what names it, as the person who said it. A
 * workspace not connected does nothing; the homeserver must be https, as every call to it is.
 */
export async function syncMatrix(app: AppServices): Promise<void> {
  const ws = await matrixWorkspace(app);
  if (!ws || !ws.serviceUrl) return;
  const key = ws.id;
  const memory = seen.get(key) ?? { events: new Set<string>(), since: '', at: 0 };
  seen.set(key, memory);
  if (Date.now() - memory.at < 10_000) return;
  memory.at = Date.now();
  for (const id of [...memory.events]) if (memory.events.size > 500) memory.events.delete(id);
  let res: Record<string, unknown>;
  try {
    res = await matrixCall(app, tokenOf(app, ws), ws.serviceUrl, `/sync?since=${encodeURIComponent(memory.since)}&timeout=15000`, undefined, 'GET');
  } catch (e) {
    if (e instanceof ChatCallError && e.outcome !== 'retry') throw e;
    return;
  }
  if (typeof res.next_batch === 'string') memory.since = res.next_batch;
  const rooms = (res.rooms as { join?: Record<string, { timeline?: { events?: Record<string, unknown>[] } }> } | undefined)?.join ?? {};
  for (const roomId of Object.keys(rooms)) {
    const events = rooms[roomId]!.timeline?.events ?? [];
    for (const raw of events) {
      const e = raw as { type?: string; event_id?: string; sender?: string; content?: { body?: string; msgtype?: string } };
      if (e.type !== 'm.room.message' || !e.event_id || !e.sender || e.sender === ws.externalId) continue;
      if (memory.events.has(e.event_id)) continue;
      memory.events.add(e.event_id);
      const text = (e.content?.body ?? '').trim();
      if (!text || !addressed(ws.externalId, text)) continue;
      // The room, as a channel, so a subscription works from here too.
      const channel = (await channelByExternal(app.db, ws.id, roomId)) ?? (await upsertChannel(app.db, ws.id, roomId, roomId));
      const who = personOf(ws, e.sender);
      const user = await personFor(app, who);
      const clean = text.replace(/^!a4a\s*/i, '').replace(new RegExp(`^${ws.externalId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`), '').trim();
      if (!user || /^link$/i.test(clean)) {
        const url = await linkUrl(app, who);
        const tr = user ? personTr(app, user) : channelTr(app);
        await matrixSendText(app, ws, roomId, tr.t(user ? 'server.chat.linkAgain' : 'server.chat.linkFirst', { platform: platformName('matrix'), url })).catch(() => {});
        continue;
      }
      const answer = await runChatCommand(app, 'matrix', user, clean, { channelId: channel?.id ?? null });
      await matrixSendText(app, ws, roomId, answer.text).catch(() => {});
    }
  }
}
/** A room's post, changed in place as its issue changes (D42's revisit): the same event, new content. */
export async function matrixUpdate(app: AppServices, ws: WorkspaceRow, roomId: string, eventId: string, issue: CardIssue, event: TrackerEvent): Promise<void> {
  const tr = channelTr(app);
  const change = cardChange(event, tr);
  const text = fallbackText(issue, tr, change);
  await matrixCall(app, tokenOf(app, ws), ws.serviceUrl!, `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(eventId)}`, {
    msgtype: 'm.text',
    body: `* ${text}`,
    format: 'org.matrix.custom.html',
    formatted_body: `<p>${text}</p>`,
    'm.new_content': { msgtype: 'm.text', body: text, format: 'org.matrix.custom.html', formatted_body: `<p>${text}</p>` },
    'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
  }, 'PUT');
}
