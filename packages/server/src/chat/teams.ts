/**
 * Microsoft Teams (D42): a bot registered with Azure Bot Service, on a single-tenant Entra app.
 *
 * - What Teams sends is checked before anything in it is read: Bot Framework's JWT (signed with a key
 *   from its OpenID metadata, issued by api.botframework.com, for this bot, in date, endorsing Teams),
 *   whose service URL must be the activity's. Activities from another tenant are ignored.
 * - The bot calls Teams with a token from the tenant's Entra token endpoint (client credentials), kept
 *   until near its expiry, and only at Bot Framework's hosts.
 */
import { createPublicKey, verify as verifySignature, type JsonWebKey } from 'node:crypto';
import type { TrackerEvent } from '@a4a/shared';
import { and, eq } from 'drizzle-orm';
import { matchLocale, type Translator } from '@a4a/shared/i18n';
import type { AppServices, UserRow } from '../context';
import { problemFor, translatorFor } from '../i18n';
import { chatWorkspaces } from '../db/schema';
import { AppError, unauthorized } from '../lib/errors';
import { runCommand } from '../commands/executor';
import { addComment } from '../services/comments';
import { cardAttachment, cardChange, teamsChangeCard, teamsIssueCard, type CardIssue } from './cards';
import { callable, channelTr, ChatCallError, chatCtx, personTr, retryAfterMs, stopError, stopReason, type Answer } from './common';
import {
  channelByExternal,
  commandOutcome,
  issueForCard,
  linkUrl,
  markChannelGone,
  markWorkspaceRemoved,
  personFor,
  platformName,
  runChatCommand,
  upsertChannel,
  upsertWorkspace,
  type ChatPerson,
} from './service';

const ISSUER = 'https://api.botframework.com';
const CLOCK_SKEW_S = 300;
const KEYS_TTL_MS = 24 * 3_600_000;
const KEYS_REFETCH_MS = 60_000;
const LOGIN_HOSTS = ['login.botframework.com', 'login.microsoftonline.com', 'login.microsoftonline.us'];

/** The parts of an activity a4a reads. */
export interface TeamsActivity {
  type?: string;
  id?: string;
  name?: string;
  channelId?: string;
  serviceUrl?: string;
  text?: string;
  /** The language of the sender's Teams ("de-DE"): a4a's words for someone it doesn't know yet (D49). */
  locale?: string;
  value?: { action?: { type?: string; verb?: string; data?: Record<string, unknown> }; trigger?: string };
  from?: { id?: string; name?: string; aadObjectId?: string };
  recipient?: { id?: string; name?: string };
  conversation?: { id?: string; conversationType?: string; tenantId?: string; name?: string };
  membersAdded?: { id?: string }[];
  membersRemoved?: { id?: string }[];
  action?: string;
  channelData?: {
    eventType?: string;
    tenant?: { id?: string };
    team?: { id?: string; name?: string };
    channel?: { id?: string; name?: string };
  };
}

// ---------------------------------------------------------------------------
// Checking what Teams sends
// ---------------------------------------------------------------------------

interface Jwk extends JsonWebKey {
  kid?: string;
  endorsements?: string[];
}

const keyCache = new WeakMap<AppServices, { at: number; keys: Map<string, Jwk> }>();

async function getJson(app: AppServices, url: string, hosts: string[]): Promise<Record<string, unknown>> {
  if (!callable(app, url, hosts)) throw new Error(`a4a doesn't read ${url}: it isn't Bot Framework's`);
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Bot Framework's signing keys, from its OpenID metadata; fetched again for a key id it doesn't know. */
async function signingKey(app: AppServices, kid: string): Promise<Jwk | undefined> {
  const cfg = app.config.teams!;
  const metaHost = new URL(cfg.openIdMetadataUrl).hostname.toLowerCase();
  const hosts = [...new Set([...LOGIN_HOSTS, metaHost])];
  const cached = keyCache.get(app);
  const fresh = cached && Date.now() - cached.at < KEYS_TTL_MS;
  if (cached && fresh && cached.keys.has(kid)) return cached.keys.get(kid);
  if (cached && Date.now() - cached.at < KEYS_REFETCH_MS) return cached.keys.get(kid);
  const meta = await getJson(app, cfg.openIdMetadataUrl, hosts);
  const jwksUri = typeof meta.jwks_uri === 'string' ? meta.jwks_uri : '';
  const jwks = await getJson(app, jwksUri, hosts);
  const keys = new Map<string, Jwk>();
  for (const k of (Array.isArray(jwks.keys) ? jwks.keys : []) as Jwk[]) if (k.kid && k.kty === 'RSA') keys.set(k.kid, k);
  keyCache.set(app, { at: Date.now(), keys });
  return keys.get(kid);
}

const b64json = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();

/** Check Bot Framework's token on an activity, before anything else in it is read. */
export async function verifyTeamsRequest(app: AppServices, authorization: string | undefined, activity: Pick<TeamsActivity, 'serviceUrl' | 'channelId'>): Promise<void> {
  const cfg = app.config.teams;
  if (!cfg) throw new AppError(404, 'not_found', 'Teams isn’t set up here', 'Set TEAMS_APP_ID, TEAMS_APP_PASSWORD and TEAMS_TENANT_ID.').said('chat.teamsNotSetUp');
  const refuse = (why: string) => {
    console.warn(`chat: a Teams request was refused: ${why}`);
    // api only: Teams' Bot Framework posts here, signed, never a page
    return unauthorized('This request isn’t from Teams');
  };
  const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1];
  if (!token) throw refuse('no token');
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) throw refuse('not a JWT');
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = b64json(h);
    claims = b64json(p);
  } catch {
    throw refuse('unreadable');
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw refuse(`algorithm ${String(header.alg)}`);
  const jwk = await signingKey(app, header.kid).catch((e: unknown) => {
    console.warn(`chat: Bot Framework's keys couldn't be read: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  });
  if (!jwk) throw refuse('unknown key');
  const ok = verifySignature('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'));
  if (!ok) throw refuse('bad signature');
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== ISSUER) throw refuse(`issuer ${String(claims.iss)}`);
  const aud = claims.aud;
  if (!(aud === cfg.appId || (Array.isArray(aud) && aud.includes(cfg.appId)))) throw refuse('audience');
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < now) throw refuse('expired');
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_S > now) throw refuse('not yet valid');
  const serviceUrl = (claims.serviceurl ?? claims.serviceUrl) as unknown;
  if (typeof serviceUrl !== 'string' || !activity.serviceUrl || !sameUrl(serviceUrl, activity.serviceUrl)) throw refuse('service URL');
  if (jwk.endorsements?.length && activity.channelId && !jwk.endorsements.includes(activity.channelId)) throw refuse('endorsement');
}

// ---------------------------------------------------------------------------
// Calling Teams
// ---------------------------------------------------------------------------

const tokens = new WeakMap<AppServices, { token: string; until: number }>();

async function botToken(app: AppServices): Promise<string> {
  const hit = tokens.get(app);
  if (hit && hit.until > Date.now()) return hit.token;
  const cfg = app.config.teams!;
  if (!callable(app, cfg.tokenUrl, LOGIN_HOSTS)) throw new ChatCallError(`a4a doesn't ask ${cfg.tokenUrl} for tokens`, 'failed');
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.appId, client_secret: cfg.appPassword, scope: 'https://api.botframework.com/.default' }),
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  }).catch((e: unknown) => {
    throw new ChatCallError(`Entra didn't answer: ${e instanceof Error ? e.message : String(e)}`, 'retry');
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new ChatCallError(`Entra refused the bot a token: ${body.error_description?.split('\n')[0] ?? res.status}`, res.status >= 500 || res.status === 429 ? 'retry' : 'failed');
  }
  tokens.set(app, { token: body.access_token, until: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 300) * 1000 });
  return body.access_token;
}

/** A call to Teams at a service URL, as the bot. */
async function connector(app: AppServices, serviceUrl: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<Record<string, unknown> | null> {
  const cfg = app.config.teams;
  if (!cfg) throw new ChatCallError('Teams isn’t set up here', 'failed');
  if (!callable(app, serviceUrl, cfg.serviceHosts)) throw new ChatCallError(`${serviceUrl} isn't one of Bot Framework's hosts`, 'failed');
  const url = `${serviceUrl.replace(/\/+$/, '')}/${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${await botToken(app)}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
  } catch (e) {
    if (e instanceof ChatCallError) throw e;
    throw new ChatCallError(`Teams didn't answer: ${e instanceof Error ? e.message : String(e)}`, 'retry');
  }
  if (res.ok) return res.status === 204 ? null : ((await res.json().catch(() => null)) as Record<string, unknown> | null);
  const text = await res.text().catch(() => '');
  const code = /"code"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? '';
  if (res.status === 429 || res.status >= 500) throw new ChatCallError(`Teams answered ${res.status}`, 'retry', retryAfterMs(res.headers.get('retry-after')));
  if (res.status === 401) {
    tokens.delete(app);
    throw new ChatCallError('Teams refused the bot’s token', 'retry');
  }
  if (res.status === 403 || res.status === 404) {
    const why = /BotNotInConversationRoster|BotDisabledByAdmin/i.test(code) ? 'removed' : 'gone';
    // Teams' own code is said as it came; a bare status, in words.
    throw stopError(why, code ? { text: code, said: null } : stopReason(`Teams answered ${res.status}`, 'chat.stop.teamsAnswered', { status: String(res.status) }));
  }
  throw new ChatCallError(`Teams answered ${res.status}${code ? ` (${code})` : ''}`, 'failed');
}

const conv = (id: string) => `v3/conversations/${encodeURIComponent(id)}/activities`;

/** Post a message to a conversation; its activity id. */
export async function teamsSend(app: AppServices, serviceUrl: string, conversationId: string, activity: Record<string, unknown>): Promise<string | null> {
  const res = await connector(app, serviceUrl, 'POST', conv(conversationId), { type: 'message', ...activity });
  return typeof res?.id === 'string' ? res.id : null;
}

/** The bot's personal chat with someone, made if it isn't there yet. */
async function personalChat(app: AppServices, serviceUrl: string, tenantId: string, teamsUserId: string): Promise<string> {
  const cfg = app.config.teams!;
  const res = await connector(app, serviceUrl, 'POST', 'v3/conversations', {
    isGroup: false,
    bot: { id: `28:${cfg.appId}` },
    members: [{ id: teamsUserId }],
    tenantId,
    channelData: { tenant: { id: tenantId } },
  });
  if (typeof res?.id !== 'string') throw new ChatCallError('Teams made no personal chat', 'failed');
  return res.id;
}

/** A team's channels, as the bot sees them. */
async function teamChannels(app: AppServices, serviceUrl: string, teamId: string): Promise<{ id: string; name: string }[]> {
  const res = await connector(app, serviceUrl, 'GET', `v3/teams/${encodeURIComponent(teamId)}/conversations`);
  const list = Array.isArray(res?.conversations) ? (res.conversations as { id?: string; name?: string }[]) : [];
  return list.filter((c): c is { id: string; name?: string } => typeof c.id === 'string').map((c) => ({ id: c.id, name: c.name || 'General' }));
}

/** A message to someone: words, and the issues as cards for them alone, in the answer's language. */
function answerActivity(answer: Answer, refreshFor?: string): Record<string, unknown> {
  const tr = translatorFor(answer.locale);
  return {
    text: answer.text,
    textFormat: 'plain',
    ...(answer.issues?.length ? { attachments: answer.issues.map((i) => cardAttachment(teamsIssueCard(i, tr, { refreshFor }))) } : {}),
  };
}

/** A channel's news: the change card, from its template in Ocean, in the channel's language (D49). */
export function teamsChannelPost(app: AppServices, issue: CardIssue, event: TrackerEvent): Record<string, unknown> {
  const tr = channelTr(app);
  const change = cardChange(event, tr);
  return { summary: `${change.who} ${change.did}: ${issue.id}`, attachments: [cardAttachment(teamsChangeCard(issue, change, tr))] };
}

/** Whom a4a doesn't know yet: the language their Teams says, else the server's (D49). */
const senderTr = (app: AppServices, a: TeamsActivity): Translator => translatorFor(matchLocale(a.locale ?? null, app.config.defaultLocale));

// ---------------------------------------------------------------------------
// What Teams sends
// ---------------------------------------------------------------------------

/** "<at>a4a</at> BACK-12 State Fixed" → "BACK-12 State Fixed". */
export function plainText(text: string | undefined): string {
  return (text ?? '')
    .replace(/<at>[^<]*<\/at>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function tenantOf(a: TeamsActivity): string | undefined {
  return a.channelData?.tenant?.id ?? a.conversation?.tenantId;
}

function personOf(app: AppServices, a: TeamsActivity): ChatPerson | null {
  const id = a.from?.aadObjectId;
  const tenant = tenantOf(a);
  if (!id || !tenant) return null;
  return { platform: 'teams', workspaceExternalId: tenant, workspaceName: 'Microsoft Teams', externalUserId: id, name: a.from?.name ?? 'someone' };
}

const botMember = (app: AppServices, members: { id?: string }[] | undefined, recipient?: string) =>
  (members ?? []).some((m) => m.id && (m.id === recipient || m.id === `28:${app.config.teams!.appId}`));

/** The team an activity is in, as a4a keeps it. */
async function teamOf(app: AppServices, a: TeamsActivity) {
  const team = a.channelData?.team;
  if (!team?.id || !a.serviceUrl) return null;
  return upsertWorkspace(app.db, { platform: 'teams', externalId: team.id, name: team.name || 'A team', tenantId: tenantOf(a) ?? null, serviceUrl: a.serviceUrl });
}

async function workspaceOf(app: AppServices, teamId: string | undefined) {
  if (!teamId) return undefined;
  const [ws] = await app.db.select().from(chatWorkspaces).where(and(eq(chatWorkspaces.platform, 'teams'), eq(chatWorkspaces.externalId, teamId)));
  return ws;
}

async function onConversationUpdate(app: AppServices, a: TeamsActivity): Promise<void> {
  const event = a.channelData?.eventType;
  const teamId = a.channelData?.team?.id;
  if (!teamId || a.conversation?.conversationType !== 'channel') return;
  if (botMember(app, a.membersRemoved, a.recipient?.id) || event === 'teamDeleted' || event === 'teamArchived' || event === 'teamHardDeleted') {
    const ws = await workspaceOf(app, teamId);
    if (ws) {
      const why =
        event === 'teamDeleted' || event === 'teamHardDeleted'
          ? stopReason('The team was deleted', 'chat.stop.teamDeleted')
          : event === 'teamArchived'
            ? stopReason('The team was archived', 'chat.stop.teamArchived')
            : stopReason('a4a was removed from the team', 'chat.stop.removedFromTeam');
      await markWorkspaceRemoved(app.db, ws.id, why);
    }
    return;
  }
  const ws = await teamOf(app, a);
  if (!ws) return;
  if (botMember(app, a.membersAdded, a.recipient?.id) || event === 'teamRestored' || event === 'teamUnarchived') {
    // Added to a team: its channels, as Teams lists them; at least its General one.
    const channels = await teamChannels(app, a.serviceUrl!, teamId).catch(() => [{ id: teamId, name: 'General' }]);
    for (const c of channels) await upsertChannel(app.db, ws.id, c.id, c.name);
    return;
  }
  const channel = a.channelData?.channel;
  if (!channel?.id) return;
  if (event === 'channelCreated' || event === 'channelRenamed' || event === 'channelRestored') await upsertChannel(app.db, ws.id, channel.id, channel.name ?? 'A channel');
  if (event === 'channelDeleted') {
    const row = await channelByExternal(app.db, ws.id, channel.id);
    if (row) await markChannelGone(app.db, row.id, stopReason('The channel was deleted', 'chat.stop.channelDeleted'));
  }
}

/** The channel a channel's message is in, as a4a keeps it. */
async function channelOf(app: AppServices, a: TeamsActivity) {
  if (a.conversation?.conversationType !== 'channel') return null;
  const ws = await teamOf(app, a);
  const channelId = a.channelData?.channel?.id ?? a.conversation.id?.split(';')[0];
  if (!ws || !channelId) return null;
  const known = await channelByExternal(app.db, ws.id, channelId);
  return known ?? upsertChannel(app.db, ws.id, channelId, a.channelData?.channel?.name ?? 'A channel');
}

/**
 * Send someone a sign-in link where only they read it: their personal chat with the bot. In the
 * language of whom it's linked to, or else of their Teams.
 */
async function sendLink(app: AppServices, a: TeamsActivity, who: ChatPerson, linked: UserRow | null): Promise<void> {
  const tr = linked ? personTr(app, linked) : senderTr(app, a);
  const tenant = tenantOf(a)!;
  const personal = a.conversation?.conversationType === 'personal' ? a.conversation.id! : await personalChat(app, a.serviceUrl!, tenant, a.from!.id!);
  const url = await linkUrl(app, who, { serviceUrl: a.serviceUrl!, conversationId: personal });
  const text = tr.t(linked ? 'server.chat.linkAgain' : 'server.chat.linkFirst', { platform: platformName('teams'), url });
  await teamsSend(app, a.serviceUrl!, personal, { text, textFormat: 'plain' });
  if (personal !== a.conversation?.id) await teamsSend(app, a.serviceUrl!, a.conversation!.id!, { text: tr.t('server.chat.answeredPrivately'), textFormat: 'plain', replyToId: a.id });
}

async function onMessage(app: AppServices, a: TeamsActivity): Promise<void> {
  const who = personOf(app, a);
  if (!who || !a.serviceUrl || !a.conversation?.id || !a.from?.id) return;
  const text = plainText(a.text);
  const user = await personFor(app, who);
  if (!user || /^link$/i.test(text)) return sendLink(app, a, who, user);
  const channel = await channelOf(app, a);
  const answer = await runChatCommand(app, 'teams', user, text, { channelId: channel?.id ?? null });
  const inChannel = a.conversation.conversationType !== 'personal';
  if (inChannel && !answer.public) {
    // Only they may see what they asked for: in their personal chat, and a word in the channel.
    const personal = await personalChat(app, a.serviceUrl, tenantOf(a)!, a.from.id);
    await teamsSend(app, a.serviceUrl, personal, answerActivity(answer, a.from.id));
    await teamsSend(app, a.serviceUrl, a.conversation.id, { text: personTr(app, user).t('server.chat.answeredPrivately'), textFormat: 'plain', replyToId: a.id });
    return;
  }
  await teamsSend(app, a.serviceUrl, a.conversation.id, { ...answerActivity(answer, inChannel ? undefined : a.from.id), replyToId: a.id });
}

const message = (text: string) => ({ statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: text });

/** A card's action (Universal Actions): done as whoever acts, answered with the card as they see it. */
async function onAction(app: AppServices, a: TeamsActivity): Promise<Record<string, unknown>> {
  const who = personOf(app, a);
  const verb = a.value?.action?.verb ?? '';
  const data = a.value?.action?.data ?? {};
  const issueId = typeof data.issue === 'string' ? data.issue.toUpperCase() : '';
  if (!who || !issueId) return message(senderTr(app, a).t('server.chat.whichIssue'));
  const user = await personFor(app, who);
  if (!user) return message(senderTr(app, a).t('server.chat.whoAreYou'));
  const ctx = chatCtx(app, user, 'teams');
  // What they did, and the card after it, in their language (D49).
  const tr = personTr(app, user);
  let note: { text: string; bad?: boolean } | null = null;
  try {
    if (verb === 'assign') {
      const o = commandOutcome(await runCommand(ctx, { issues: [issueId], command: 'for me' }), tr);
      note = o.bad ? o : { text: tr.t('server.chat.assigned') };
    } else if (verb === 'state') {
      const state = typeof data.state === 'string' ? data.state.trim() : '';
      if (!state) note = { text: tr.t('server.chat.chooseState'), bad: true };
      else {
        const current = await issueForCard(ctx, issueId);
        const field = (await app.schema.get()).fields;
        const stateField = [...field.values()].find((f) => f.type === 'state' && current.states.includes(state));
        const o = commandOutcome(await runCommand(ctx, { issues: [issueId], command: `${stateField?.name ?? 'State'} ${state}` }), tr);
        note = o.bad ? o : { text: tr.t('server.chat.moved', { state }) };
      }
    } else if (verb === 'comment') {
      const text = typeof data.comment === 'string' ? data.comment.trim() : '';
      if (!text) note = { text: tr.t('server.chat.commentNeeded'), bad: true };
      else {
        await addComment(ctx, issueId, text.slice(0, 50_000));
        note = { text: tr.t('server.chat.commented') };
      }
    }
  } catch (e) {
    // Missing, or hidden from them, in the same words: the problem alone.
    if (e instanceof AppError && e.status === 404) return message(problemFor(tr, { message: e.message, words: e.words }));
    note = { text: e instanceof AppError ? problemFor(tr, e) : tr.t('server.chat.didntWork'), bad: true };
  }
  try {
    const issue = await issueForCard(ctx, issueId);
    return { statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value: teamsIssueCard(issue, tr, { refreshFor: a.from?.id ?? null, note }) };
  } catch (e) {
    // Gone from them since (deleted, or limited away): missing, in the same words.
    return message(e instanceof AppError ? problemFor(tr, { message: e.message, words: e.words }) : tr.t('server.chat.issueGone'));
  }
}

/**
 * Handle one activity Teams sent, already checked. Messages and changes to a team are answered with
 * 200 and nothing; a card's action with what Universal Actions expects.
 */
export async function handleTeamsActivity(app: AppServices, a: TeamsActivity): Promise<{ status: number; body?: unknown }> {
  const cfg = app.config.teams!;
  // One tenant: what comes from any other is ignored.
  if (tenantOf(a) !== cfg.tenantId) return { status: 200 };
  try {
    switch (a.type) {
      case 'conversationUpdate':
        await onConversationUpdate(app, a);
        return { status: 200 };
      case 'installationUpdate':
        if (/^remove/.test(a.action ?? '') && a.conversation?.conversationType === 'channel') {
          const ws = await workspaceOf(app, a.channelData?.team?.id);
          if (ws) await markWorkspaceRemoved(app.db, ws.id, stopReason('a4a was removed from the team', 'chat.stop.removedFromTeam'));
        }
        return { status: 200 };
      case 'message':
        await onMessage(app, a);
        return { status: 200 };
      case 'invoke':
        if (a.name === 'adaptiveCard/action') return { status: 200, body: await onAction(app, a) };
        return { status: 200, body: {} };
      default:
        return { status: 200 };
    }
  } catch (e) {
    // Teams retries what fails; a reply that couldn't be sent isn't worth sending twice.
    console.warn(`chat: a Teams ${a.type ?? 'activity'} wasn't handled: ${e instanceof Error ? e.message : String(e)}`);
    return { status: 200 };
  }
}

/** Tell someone their Teams account is linked, in the personal chat the link was sent to, in their language. */
export async function teamsLinked(app: AppServices, reply: { serviceUrl?: string; conversationId?: string } | null, user: Pick<UserRow, 'name' | 'locale'>): Promise<void> {
  if (!reply?.serviceUrl || !reply.conversationId || !app.config.teams) return;
  await teamsSend(app, reply.serviceUrl, reply.conversationId, { text: personTr(app, user).t('server.chat.linkedTeams', { name: user.name }), textFormat: 'plain' });
}
