/**
 * Slack (D42): one workspace per a4a, connected by an administrator with its app's bot token and
 * signing secret, both sealed. Every request Slack sends is checked with the signing secret (v0: an
 * HMAC-SHA256 of "v0:<timestamp>:<raw body>", the timestamp within five minutes) before anything in it
 * is read. a4a calls Slack's Web API alone (SLACK_API_URL, for tests).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TrackerEvent } from '@a4a/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { requireScope, type AppServices, type Ctx, type UserRow } from '../context';
import { sha256 } from '../lib/crypto';
import { chatChannels, chatWorkspaces } from '../db/schema';
import { AppError, asSentence, badRequest, conflict, notFound, unauthorized } from '../lib/errors';
import { runCommand } from '../commands/executor';
import { findVisibleIssue } from '../services/issues';
import type { Translator } from '@a4a/shared/i18n';
import { problemFor, translatorFor } from '../i18n';
import { cardChange, fallbackText, slackBlocks, slackText, type CardIssue } from './cards';
import { checkIssueForm, describeWithReplies, draftFor, firstTime, isRefusal, makeChatIssue, openIssueForm, REPLIES_MAX, threadMayHear, type ChatReply, type IssueForm, type MadeIssue, type Refusal } from './issues';
import { FORM_MAX, mrkdwnToMarkdown, slackMentions } from './markdown';
import { callable, channelTr, ChatCallError, chatCtx, openSecret, personTr, retryAfterMs, sealSecret, stopError, stopReason, type Answer, type StopReason } from './common';
import {
  channelByExternal,
  chatStatus,
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
  whyNotFor,
  type ChatPerson,
} from './service';

type WorkspaceRow = typeof chatWorkspaces.$inferSelect;

const MAX_AGE_S = 5 * 60;
/** Slack's answers that mean a channel can't be posted to, and those that mean the app is gone. */
const CHANNEL_GONE: Record<string, StopReason> = {
  channel_not_found: stopReason('The channel was deleted, or a4a can’t see it', 'chat.stop.channelNotFound'),
  is_archived: stopReason('The channel was archived', 'chat.stop.channelArchived'),
  not_in_channel: stopReason('a4a isn’t in the channel: invite it with /invite @a4a', 'chat.stop.notInChannel'),
};
const APP_GONE = new Set(['invalid_auth', 'account_inactive', 'token_revoked', 'token_expired', 'not_authed', 'team_access_not_granted', 'no_permission']);

/** The connected workspace, if there is one. */
export async function slackWorkspace(app: AppServices): Promise<WorkspaceRow | undefined> {
  const [ws] = await app.db.select().from(chatWorkspaces).where(and(eq(chatWorkspaces.platform, 'slack'), isNull(chatWorkspaces.removedAt)));
  return ws;
}

/** Check a request from Slack against the workspace's signing secret; the workspace, when it holds. */
export async function verifySlackRequest(app: AppServices, header: (name: string) => string | undefined, raw: string): Promise<WorkspaceRow> {
  const ws = await slackWorkspace(app);
  if (!ws) throw notFound('Slack connection', 'An administrator connects Slack on the Chat page.').said('chat.slackNotConnected');
  const secret = openSecret(app, ws.signingSecret);
  const ts = header('x-slack-request-timestamp') ?? '';
  const sig = header('x-slack-signature') ?? '';
  const refuse = (why: string) => {
    console.warn(`chat: a Slack request was refused: ${why}`);
    // api only: Slack posts here, signed, never a page
    return unauthorized('This request isn’t from Slack');
  };
  if (!secret) throw refuse('no signing secret (SECRET_KEY changed?)');
  if (!/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > MAX_AGE_S) throw refuse('stale or missing timestamp');
  const expected = Buffer.from(`v0=${createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')}`);
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw refuse('bad signature');
  // A signed request is taken once: the same one again, within its five minutes, is a replay (D60).
  if (!(await firstTime(app.db, `slack:${sha256(sig)}`, new Date((Number(ts) + MAX_AGE_S) * 1000 + 60_000)))) throw refuse('replayed');
  return ws;
}

/** One Web API method, with the bot's token: its answer, or a ChatCallError saying what to do. */
export async function slackCall(app: AppServices, token: string, method: string, params: Record<string, unknown>, opts: { json?: boolean; timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
  const url = `${app.config.slackApiUrl}/${method}`;
  if (!callable(app, url, ['slack.com'])) throw new ChatCallError(`a4a doesn't call ${url}`, 'failed');
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': opts.json ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded',
      },
      body: opts.json ? JSON.stringify(params) : new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, typeof v === 'string' ? v : JSON.stringify(v)])),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      redirect: 'error',
    });
  } catch (e) {
    throw new ChatCallError(`Slack didn't answer: ${e instanceof Error ? e.message : String(e)}`, 'retry');
  }
  if (res.status === 429 || res.status >= 500) throw new ChatCallError(`Slack answered ${res.status}`, 'retry', retryAfterMs(res.headers.get('retry-after')));
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.ok === true) return body;
  const error = typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
  if (error === 'ratelimited') throw new ChatCallError('Slack is limiting a4a', 'retry', retryAfterMs(res.headers.get('retry-after')));
  if (CHANNEL_GONE[error]) throw stopError('gone', CHANNEL_GONE[error], error);
  if (APP_GONE.has(error)) throw stopError('removed', stopReason(`Slack refused a4a's token (${error}): the app was removed, or its token revoked`, 'chat.stop.slackTokenRefused', { error }));
  throw new ChatCallError(`Slack said ${error}`, 'failed', undefined, undefined, error);
}

const tokenOf = (app: AppServices, ws: WorkspaceRow) => {
  const token = openSecret(app, ws.botToken);
  if (!token) throw stopError('removed', stopReason('a4a can’t read the Slack token it keeps (SECRET_KEY changed?)', 'chat.stop.slackTokenUnreadable'));
  return token;
};

// ---------------------------------------------------------------------------
// Connecting, for administrators
// ---------------------------------------------------------------------------

/** Connect the workspace whose app's token and signing secret an administrator gives. */
export async function connectSlack(ctx: Ctx, input: { botToken: string; signingSecret: string }) {
  requireScope(ctx, 'admin');
  const app = ctx.app;
  let auth: Record<string, unknown>;
  try {
    auth = await slackCall(app, input.botToken, 'auth.test', {});
  } catch (e) {
    throw badRequest(`Slack didn't take the token: ${e instanceof Error ? e.message : String(e)}`, "Copy the Bot User OAuth Token from OAuth & Permissions in the app's settings.").said('chat.slackTokenRefused', { error: asSentence(e instanceof Error ? e.message : String(e)) });
  }
  const teamId = String(auth.team_id ?? '');
  if (!teamId) throw badRequest('Slack didn’t say which workspace the token is for').said('chat.slackNoWorkspace');
  const current = await slackWorkspace(app);
  if (current && current.externalId !== teamId) throw conflict(`a4a is connected to ${current.name} already`, 'Disconnect it first: one Slack workspace per a4a.').said('chat.slackConnectedAlready', { workspace: current.name });
  const ws = await upsertWorkspace(ctx.db, { platform: 'slack', externalId: teamId, name: String(auth.team ?? teamId), connectedById: ctx.actor.user.id });
  await ctx.db
    .update(chatWorkspaces)
    .set({ botToken: sealSecret(app, input.botToken), signingSecret: sealSecret(app, input.signingSecret), botUserId: typeof auth.user_id === 'string' ? auth.user_id : null, connectedById: ctx.actor.user.id, createdAt: new Date() })
    .where(eq(chatWorkspaces.id, ws.id));
  // The channels it's in already; others are known when it's invited, or asked in.
  try {
    const list = await slackCall(app, input.botToken, 'conversations.list', { types: 'public_channel,private_channel', exclude_archived: 'true', limit: '200' });
    for (const c of (Array.isArray(list.channels) ? list.channels : []) as { id?: string; name?: string; is_member?: boolean }[]) {
      if (c.id && c.is_member) await upsertChannel(ctx.db, ws.id, c.id, `#${c.name ?? c.id}`);
    }
  } catch (e) {
    console.warn(`chat: Slack's channels weren't listed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return chatStatus(ctx);
}

export async function disconnectSlack(ctx: Ctx): Promise<void> {
  requireScope(ctx, 'admin');
  const ws = await slackWorkspace(ctx.app);
  if (!ws) throw notFound('Slack connection').said('chat.slackConnectionNotFound');
  await markWorkspaceRemoved(ctx.db, ws.id, stopReason(`Disconnected by ${ctx.actor.user.name}`, 'chat.stop.disconnectedBy', { name: ctx.actor.user.name }), { forgetSecrets: true });
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

/** A channel's news, as Block Kit, in the channel's language (D49): the message's ts. */
export async function slackPost(app: AppServices, ws: WorkspaceRow, channel: string, issue: CardIssue, event: TrackerEvent): Promise<string | null> {
  const tr = channelTr(app);
  const change = cardChange(event, tr);
  const res = await slackCall(app, tokenOf(app, ws), 'chat.postMessage', { channel, text: fallbackText(issue, tr, change), blocks: slackBlocks(issue, tr, { change }), unfurl_links: false, unfurl_media: false }, { json: true });
  return typeof res.ts === 'string' ? res.ts : null;
}

/** A channel's post, changed in place as its issue changes (D42's revisit): the same ts, new words and blocks. */
export async function slackUpdate(app: AppServices, ws: WorkspaceRow, channel: string, ts: string, issue: CardIssue, event: TrackerEvent): Promise<void> {
  const tr = channelTr(app);
  const change = cardChange(event, tr);
  await slackCall(app, tokenOf(app, ws), 'chat.update', { channel, ts, text: fallbackText(issue, tr, change), blocks: slackBlocks(issue, tr, { change }) }, { json: true });
}

/** Something for one person alone, where they are; a direct message when there's no channel. */
async function tellOne(app: AppServices, ws: WorkspaceRow, user: string, channel: string | undefined, answer: Answer | { text: string; blocks: unknown[] }): Promise<void> {
  const blocks = 'blocks' in answer ? answer.blocks : answerBlocks(answer);
  const body = { text: answer.text, blocks };
  if (channel) await slackCall(app, tokenOf(app, ws), 'chat.postEphemeral', { channel, user, ...body }, { json: true });
  else await slackCall(app, tokenOf(app, ws), 'chat.postMessage', { channel: user, ...body }, { json: true });
}

function answerBlocks(answer: Answer): unknown[] {
  const tr = translatorFor(answer.locale);
  return [{ type: 'section', text: { type: 'mrkdwn', text: answer.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') } }, ...(answer.issues ?? []).flatMap((i) => slackBlocks(i, tr))];
}

/** Tell someone their Slack account is linked, in a direct message, in their language. */
export async function slackLinked(app: AppServices, externalUserId: string, user: Pick<UserRow, 'name' | 'locale'>): Promise<void> {
  const ws = await slackWorkspace(app);
  if (!ws) return;
  const tr = personTr(app, user);
  await tellOne(app, ws, externalUserId, undefined, { text: tr.t('server.chat.linkedSlack', { name: user.name }), locale: tr.locale });
}

// ---------------------------------------------------------------------------
// What Slack sends
// ---------------------------------------------------------------------------

const personOf = (ws: WorkspaceRow, userId: string, name: string): ChatPerson => ({
  platform: 'slack',
  workspaceExternalId: ws.externalId,
  workspaceName: ws.name,
  externalUserId: userId,
  name,
});

/** The link to sign in with: in the language of whom it's linked to, or else the server's (Slack doesn't say theirs). */
const linkWords = (app: AppServices, url: string, linked: UserRow | null) =>
  (linked ? personTr(app, linked) : channelTr(app)).t(linked ? 'server.chat.linkAgain' : 'server.chat.linkFirst', { platform: platformName('slack'), url });

/** /a4a …: answered at once, for the person alone unless it's a channel's subscription. */
export async function slackCommand(app: AppServices, ws: WorkspaceRow, form: URLSearchParams): Promise<Record<string, unknown>> {
  if (form.get('team_id') !== ws.externalId) return { response_type: 'ephemeral', text: channelTr(app).t('server.chat.otherWorkspace') };
  const userId = form.get('user_id') ?? '';
  const who = personOf(ws, userId, form.get('user_name') ?? userId);
  const text = (form.get('text') ?? '').trim();
  const user = await personFor(app, who);
  if (!user || /^link$/i.test(text)) return { response_type: 'ephemeral', text: linkWords(app, await linkUrl(app, who), user) };
  const channelId = form.get('channel_id') ?? '';
  const inChannel = /^[CG]/.test(channelId) && form.get('channel_name') !== 'directmessage';
  const channel = inChannel ? ((await channelByExternal(app.db, ws.id, channelId)) ?? (await upsertChannel(app.db, ws.id, channelId, `#${form.get('channel_name') ?? channelId}`))) : null;
  const answer = await runChatCommand(app, 'slack', user, text, { channelId: channel?.id ?? null });
  return { response_type: answer.public ? 'in_channel' : 'ephemeral', text: answer.text, blocks: answerBlocks(answer) };
}

interface BlockAction {
  action_id?: string;
  value?: string;
  selected_option?: { value?: string };
}

/** A button or a menu on a4a's message: done as whoever used it, answered for them alone. */
export async function slackInteraction(app: AppServices, ws: WorkspaceRow, payload: Record<string, unknown>): Promise<void> {
  if (payload.type !== 'block_actions') return;
  const team = (payload.team as { id?: string } | undefined)?.id ?? (payload.user as { team_id?: string } | undefined)?.team_id;
  if (team !== ws.externalId) return;
  const slackUser = payload.user as { id?: string; username?: string; name?: string } | undefined;
  const channel = (payload.channel as { id?: string } | undefined)?.id;
  const action = (payload.actions as BlockAction[] | undefined)?.[0];
  if (!slackUser?.id || !action || action.action_id === 'open') return;
  const who = personOf(ws, slackUser.id, slackUser.name ?? slackUser.username ?? slackUser.id);
  const user = await personFor(app, who);
  if (!user) return tellOne(app, ws, slackUser.id, channel, { text: linkWords(app, await linkUrl(app, who), null), locale: channelTr(app).locale });
  const ctx = chatCtx(app, user, 'slack');
  // What they did, and the issue after it, in their language (D49).
  const tr = personTr(app, user);
  let issueId = '';
  let note: { text: string; bad: boolean };
  try {
    if (action.action_id === 'assign') {
      issueId = String(action.value ?? '').toUpperCase();
      const o = commandOutcome(await runCommand(ctx, { issues: [issueId], command: 'for me' }, tr), tr);
      note = o.bad ? o : { text: tr.t('server.chat.assigned'), bad: false };
    } else if (action.action_id === 'state') {
      const [id, ...state] = String(action.selected_option?.value ?? '').split('|');
      issueId = (id ?? '').toUpperCase();
      const name = state.join('|');
      const field = [...(await app.schema.get()).fields.values()].find((f) => f.type === 'state');
      const o = commandOutcome(await runCommand(ctx, { issues: [issueId], command: `${field?.name ?? 'State'} ${name}` }, tr), tr);
      note = o.bad ? o : { text: tr.t('server.chat.moved', { state: name }), bad: false };
    } else return;
  } catch (e) {
    note = { text: e instanceof AppError ? problemFor(tr, { message: e.message, words: e.words }) : tr.t('server.chat.didntWork'), bad: true };
  }
  try {
    const issue = await issueForCard(ctx, issueId);
    await tellOne(app, ws, slackUser.id, channel, { text: note.text, blocks: slackBlocks(issue, tr, { note: note.text }) });
  } catch (e) {
    await tellOne(app, ws, slackUser.id, channel, { text: e instanceof AppError ? problemFor(tr, { message: e.message, words: e.words }) : note.text, locale: tr.locale });
  }
}

/** Links to a4a's issues unfurled: only for a linked person who sees one a channel may be told of. */
async function unfurl(app: AppServices, ws: WorkspaceRow, e: Record<string, unknown>): Promise<void> {
  const links = (Array.isArray(e.links) ? e.links : []) as { url?: string }[];
  const who = personOf(ws, String(e.user ?? ''), String(e.user ?? ''));
  const user = await personFor(app, who);
  if (!user) return;
  const ctx = chatCtx(app, user, 'slack');
  const origin = new URL(app.config.publicUrl).origin;
  const unfurls: Record<string, unknown> = {};
  for (const l of links.slice(0, 5)) {
    let url: URL;
    try {
      url = new URL(l.url ?? '');
    } catch {
      continue;
    }
    const id = /^\/issues\/([A-Za-z][A-Za-z0-9]*-\d+)\/?$/.exec(url.pathname)?.[1];
    if (url.origin !== origin || !id) continue;
    const row = await findVisibleIssue(ctx, id);
    // A channel may be told only what every reader of the project may see, vouched for by who shared it.
    if (!row || row.limited) continue;
    const s = await app.schema.get();
    const project = s.projects.get(row.projectId);
    if (!project || (await whyNotFor(app.db, user.id, row.projectId, project.name))) continue;
    // The channel reads it: in the channel's language (D49).
    unfurls[l.url!] = { blocks: slackBlocks(await issueForCard(ctx, id, { everyone: true }), channelTr(app), { actions: false }) };
  }
  if (!Object.keys(unfurls).length) return;
  const where = typeof e.unfurl_id === 'string' && typeof e.source === 'string' ? { unfurl_id: e.unfurl_id, source: e.source } : { channel: e.channel, ts: e.message_ts };
  await slackCall(app, tokenOf(app, ws), 'chat.unfurl', { ...where, unfurls }, { json: true });
}

/** The Events API: its URL check, links to unfurl, and channels and the app coming and going. */
export async function slackEvent(app: AppServices, ws: WorkspaceRow, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (body.type === 'url_verification') return { challenge: body.challenge };
  if (body.type !== 'event_callback' || body.team_id !== ws.externalId) return {};
  const e = (body.event ?? {}) as Record<string, unknown>;
  const channelId = typeof e.channel === 'string' ? e.channel : ((e.channel as { id?: string } | undefined)?.id ?? '');
  const gone = async (reason: StopReason) => {
    const row = await channelByExternal(app.db, ws.id, channelId);
    if (row) await markChannelGone(app.db, row.id, reason);
  };
  switch (e.type) {
    case 'link_shared':
      await unfurl(app, ws, e).catch((err: unknown) => console.warn(`chat: Slack links weren't unfurled: ${err instanceof Error ? err.message : String(err)}`));
      break;
    case 'channel_deleted':
    case 'group_deleted':
      await gone(stopReason('The channel was deleted', 'chat.stop.channelDeleted'));
      break;
    case 'channel_archive':
    case 'group_archive':
      await gone(stopReason('The channel was archived', 'chat.stop.channelArchived'));
      break;
    case 'channel_rename':
    case 'group_rename': {
      const c = e.channel as { id?: string; name?: string } | undefined;
      const row = c?.id ? await channelByExternal(app.db, ws.id, c.id) : undefined;
      if (row && c?.name) await upsertChannel(app.db, ws.id, row.externalId, `#${c.name}`);
      break;
    }
    case 'member_joined_channel':
      if (e.user === ws.botUserId && channelId) {
        const info = await slackCall(app, tokenOf(app, ws), 'conversations.info', { channel: channelId }).catch(() => ({}) as Record<string, unknown>);
        const name = (info.channel as { name?: string } | undefined)?.name;
        await upsertChannel(app.db, ws.id, channelId, `#${name ?? channelId}`);
      }
      break;
    case 'member_left_channel':
      if (e.user === ws.botUserId) await gone(stopReason('a4a was taken out of the channel', 'chat.stop.takenOutOfChannel'));
      break;
    case 'app_uninstalled':
    case 'tokens_revoked':
      await markWorkspaceRemoved(app.db, ws.id, stopReason('The app was removed from Slack', 'chat.stop.slackAppRemoved'), { forgetSecrets: true });
      break;
    default:
      break;
  }
  return {};
}

// ---------------------------------------------------------------------------
// A message made an issue (D60): the message shortcut, its modal, and what's sent
// ---------------------------------------------------------------------------

/** The message shortcut's callback ID, as the app's settings name it (Interactivity & Shortcuts). */
export const SLACK_ISSUE_SHORTCUT = 'a4a_create_issue';
/** Calls made within Slack's three seconds wait this long at most. */
const QUICK_MS = 2_000;

interface SlackMessage {
  type?: string;
  subtype?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  ts?: string;
  thread_ts?: string;
  reply_count?: number;
  text?: string;
  files?: { name?: string; title?: string; permalink?: string; mode?: string }[];
}

/** A link into Slack's own pages, https on its hosts, or nothing. */
function slackLink(raw: unknown): string | null {
  try {
    const url = new URL(String(raw ?? ''));
    return url.protocol === 'https:' && (url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com')) ? url.href : null;
  } catch {
    return null;
  }
}

/** People's names by their Slack ids, as Slack shows them; one who can't be asked keeps their id. */
async function slackNames(app: AppServices, ws: WorkspaceRow, ids: string[]): Promise<Map<string, string>> {
  const token = tokenOf(app, ws);
  const names = new Map<string, string>();
  await Promise.all(
    [...new Set(ids)].slice(0, 20).map(async (id) => {
      const res = await slackCall(app, token, 'users.info', { user: id }, { timeoutMs: QUICK_MS }).catch(() => null);
      const u = res?.user as { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } | undefined;
      const name = u?.profile?.display_name || u?.profile?.real_name || u?.real_name || u?.name;
      if (name) names.set(id, name);
    }),
  );
  return names;
}

const plain = (text: string, max = 2000) => ({ type: 'plain_text', text: text.slice(0, max) });

/** A modal saying one thing, with nothing to send: a refusal, or how to link. */
function noticeView(tr: Translator, text: string): Record<string, unknown> {
  return {
    type: 'modal',
    title: plain(tr.t('server.chat.issue.title'), 24),
    close: plain(tr.t('server.chat.issue.close'), 24),
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: slackText(text) } }],
  };
}

/** The modal: the projects they may create in, a summary, the message as the description, and its thread's replies when it has any. */
function issueView(form: IssueForm, tr: Translator, from: string, thread: boolean): Record<string, unknown> {
  const options = form.projects.slice(0, 100).map((p) => ({ text: plain(`${p.name} (${p.key})`, 75), value: p.key }));
  const chosen = options.find((o) => o.value === form.project);
  const input = (block: string, label: string, element: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'input', block_id: block, label: plain(label), element, ...extra });
  return {
    type: 'modal',
    callback_id: SLACK_ISSUE_SHORTCUT,
    // The form's draft, which names who opened it: what comes back is checked against it, never trusted.
    private_metadata: form.draft,
    title: plain(tr.t('server.chat.issue.title'), 24),
    submit: plain(tr.t('server.chat.issue.create'), 24),
    close: plain(tr.t('server.chat.issue.cancel'), 24),
    blocks: [
      { type: 'context', elements: [{ type: 'mrkdwn', text: slackText(from) }] },
      input('project', tr.t('server.chat.issue.project'), { type: 'static_select', action_id: 'value', placeholder: plain(tr.t('server.chat.issue.chooseProject'), 150), options, ...(chosen ? { initial_option: chosen } : {}) }),
      input('summary', tr.t('server.chat.issue.summary'), { type: 'plain_text_input', action_id: 'value', max_length: 500, ...(form.summary ? { initial_value: form.summary } : {}) }),
      input(
        'description',
        tr.t('server.chat.issue.description'),
        { type: 'plain_text_input', action_id: 'value', multiline: true, max_length: FORM_MAX, ...(form.description ? { initial_value: form.description } : {}) },
        { optional: true, ...(form.cut ? { hint: plain(tr.t('server.chat.issue.cut', { max: FORM_MAX })) } : {}) },
      ),
      ...(thread
        ? [input('replies', tr.t('server.chat.issue.thread'), { type: 'checkboxes', action_id: 'value', options: [{ text: plain(tr.t('server.chat.issue.withReplies', { max: REPLIES_MAX }), 75), value: 'yes' }] }, { optional: true })]
        : []),
      ...(form.files ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: slackText(tr.t('server.chat.issue.files', { n: form.files })) }] }] : []),
    ],
  };
}

/**
 * The message shortcut ("Create an a4a issue"): a modal on the message, opened with the shortcut's
 * trigger within Slack's three seconds. Answered already; this opens what it says. Someone a4a doesn't
 * know is told how to link, and nothing else; a message in a channel a4a isn't in, or deleted, or someone
 * making issues too fast, is refused there, in their language.
 */
export async function slackIssueShortcut(app: AppServices, ws: WorkspaceRow, payload: Record<string, unknown>): Promise<void> {
  if (payload.callback_id !== SLACK_ISSUE_SHORTCUT) return;
  const team = (payload.team as { id?: string } | undefined)?.id ?? (payload.user as { team_id?: string } | undefined)?.team_id;
  const slackUser = payload.user as { id?: string; username?: string; name?: string } | undefined;
  const trigger = typeof payload.trigger_id === 'string' ? payload.trigger_id : '';
  if (team !== ws.externalId || !slackUser?.id || !trigger) return;
  const token = tokenOf(app, ws);
  const open = async (view: Record<string, unknown>) => {
    await slackCall(app, token, 'views.open', { trigger_id: trigger, view }, { json: true, timeoutMs: QUICK_MS });
  };
  const who = personOf(ws, slackUser.id, slackUser.name ?? slackUser.username ?? slackUser.id);
  const user = await personFor(app, who);
  if (!user) return open(noticeView(channelTr(app), linkWords(app, await linkUrl(app, who), null)));
  const tr = personTr(app, user);
  const ctx = chatCtx(app, user, 'slack');
  const channelId = (payload.channel as { id?: string } | undefined)?.id ?? '';
  const message = (payload.message ?? {}) as SlackMessage;
  // Only a channel's message: a direct one has no channel to answer in, nor anyone a4a vouches for.
  if (!/^[CG]/.test(channelId)) return open(noticeView(tr, tr.t('server.chat.issue.onlyChannels')));
  if (!message.ts || message.subtype === 'tombstone' || message.subtype === 'message_deleted') return open(noticeView(tr, tr.t('server.chat.issue.deleted')));
  const text = message.text ?? '';
  // Within Slack's three seconds, side by side: whether a4a is in the channel, the message's link, and names.
  const [info, permalink, names] = await Promise.all([
    slackCall(app, token, 'conversations.info', { channel: channelId }, { timeoutMs: QUICK_MS }).catch((e: unknown) => e),
    slackCall(app, token, 'chat.getPermalink', { channel: channelId, message_ts: message.ts }, { timeoutMs: QUICK_MS }).catch(() => null),
    slackNames(app, ws, [...(message.user ? [message.user] : []), ...slackMentions(text)]),
  ]);
  // Slack not answering isn't a4a missing from the channel: said as what it is.
  if (info instanceof ChatCallError && info.outcome === 'retry') return open(noticeView(tr, tr.t('server.chat.issue.didntAnswer', { platform: platformName('slack') })));
  const channel = info instanceof Error ? null : (info as { channel?: { name?: string; is_member?: boolean; is_archived?: boolean } }).channel;
  const channelName = `#${channel?.name ?? (payload.channel as { name?: string } | undefined)?.name ?? channelId}`;
  if (!channel?.is_member || channel.is_archived) return open(noticeView(tr, tr.t('server.chat.issue.notInChannel', { platform: 'slack', channel: channelName })));
  const row = await upsertChannel(app.db, ws.id, channelId, channelName);
  const authorName = (message.user && names.get(message.user)) || message.username || message.user || '?';
  const author = message.user ? await personFor(app, personOf(ws, message.user, authorName)) : null;
  const files = (message.files ?? []).filter((f) => f.mode !== 'tombstone' && f.mode !== 'hidden_by_limit');
  const form = await openIssueForm(
    ctx,
    slackUser.id,
    {
      platform: 'slack',
      workspace: { id: ws.id, name: ws.name },
      channel: { id: row.id, name: channelName },
      ref: message.ts,
      thread: message.thread_ts ?? message.ts,
      url: slackLink((permalink as { permalink?: unknown } | null)?.permalink),
      author: { name: authorName, externalId: message.user ?? null, userId: author?.id ?? null },
      sentAt: Number.isFinite(Number(message.ts)) ? new Date(Number(message.ts) * 1000) : null,
      markdown: mrkdwnToMarkdown(text, names),
      files: files.map((f) => ({ name: (f.title || f.name || '').slice(0, 200), url: slackLink(f.permalink) })),
      moreFiles: 0,
    },
    tr,
  );
  if (isRefusal(form)) return open(noticeView(tr, form.text));
  const thread = (message.reply_count ?? 0) > 0 || Boolean(message.thread_ts && message.thread_ts !== message.ts);
  await open(issueView(form, tr, tr.t('server.chat.issue.from', { author: authorName, channel: channelName }), thread));
}

/** The message again, from Slack, as the form is sent: still there, and the replies after it in its thread when they're asked for. */
async function slackThread(app: AppServices, ws: WorkspaceRow, channel: string, draft: { messageRef: string; threadRef: string }, replies: boolean): Promise<{ found: boolean; replies: ChatReply[] }> {
  let res: Record<string, unknown>;
  try {
    res = await slackCall(app, tokenOf(app, ws), 'conversations.replies', { channel, ts: draft.threadRef, oldest: draft.messageRef, inclusive: 'true', limit: String(REPLIES_MAX + 2) }, { timeoutMs: QUICK_MS });
  } catch (e) {
    if (e instanceof ChatCallError && (e.code === 'thread_not_found' || e.code === 'message_not_found')) return { found: false, replies: [] };
    throw e;
  }
  const messages = (Array.isArray(res.messages) ? res.messages : []) as SlackMessage[];
  const own = messages.find((m) => m.ts === draft.messageRef);
  if (!own || own.subtype === 'tombstone') return { found: false, replies: [] };
  if (!replies) return { found: true, replies: [] };
  // Slack's ts are the same width, so they sort as text: the replies after the message, in order.
  const later = messages.filter((m) => m.ts && m.ts > draft.messageRef && m.ts !== draft.threadRef && m.subtype !== 'tombstone').slice(0, REPLIES_MAX);
  const names = await slackNames(app, ws, later.flatMap((m) => [...(m.user ? [m.user] : []), ...slackMentions(m.text ?? '')]));
  return { found: true, replies: later.map((m) => ({ author: (m.user && names.get(m.user)) || m.username || m.user || '?', markdown: mrkdwnToMarkdown(m.text ?? '', names) })) };
}

type ViewState = Record<string, Record<string, { value?: string | null; selected_option?: { value?: string } | null; selected_options?: { value?: string }[] }>>;

/**
 * The modal sent: answered within Slack's three seconds, with what was wrong under its field when
 * something was (`response_action: errors`), or closed once the issue is made. The person is then told,
 * where only they see it, and the thread where D42's line allows.
 */
export async function slackIssueSubmitted(app: AppServices, ws: WorkspaceRow, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const view = (payload.view ?? {}) as { callback_id?: string; private_metadata?: string; state?: { values?: ViewState } };
  const team = (payload.team as { id?: string } | undefined)?.id ?? (payload.user as { team_id?: string } | undefined)?.team_id;
  const slackUser = payload.user as { id?: string; username?: string; name?: string } | undefined;
  if (view.callback_id !== SLACK_ISSUE_SHORTCUT || team !== ws.externalId || !slackUser?.id) return {};
  const errors = (field: string, text: string) => ({ response_action: 'errors', errors: { [field === 'form' ? 'project' : field]: text } });
  const who = personOf(ws, slackUser.id, slackUser.name ?? slackUser.username ?? slackUser.id);
  const user = await personFor(app, who);
  if (!user) return errors('project', linkWords(app, await linkUrl(app, who), null));
  const tr = personTr(app, user);
  const ctx = chatCtx(app, user, 'slack');
  const draft = await draftFor(app.db, String(view.private_metadata ?? ''), 'slack', user, slackUser.id);
  if (!draft) return errors('project', tr.t('server.chat.issue.expired'));
  const [channel] = draft.channelId ? await app.db.select().from(chatChannels).where(eq(chatChannels.id, draft.channelId)) : [];
  const values = view.state?.values ?? {};
  const input = {
    project: values.project?.value?.selected_option?.value ?? '',
    summary: values.summary?.value?.value ?? '',
    description: (values.description?.value?.value ?? '').slice(0, FORM_MAX),
  };
  let made: MadeIssue | Refusal;
  if (draft.issueId) made = await makeChatIssue(ctx, draft, { ...input, replies: 0, cut: false }, tr);
  else {
    const checked = await checkIssueForm(ctx, input, tr);
    if (isRefusal(checked)) return errors(checked.field, checked.text);
    if (!channel) return errors('project', tr.t('server.chat.issue.expired'));
    let thread: Awaited<ReturnType<typeof slackThread>>;
    try {
      const asked = (values.replies?.value?.selected_options ?? []).some((o) => o.value === 'yes');
      thread = await slackThread(app, ws, channel.externalId, draft, asked);
    } catch (e) {
      if (e instanceof ChatCallError && (e.outcome === 'gone' || e.outcome === 'removed')) return errors('project', tr.t('server.chat.issue.notInChannel', { platform: 'slack', channel: draft.channelName }));
      return errors('project', tr.t('server.chat.issue.didntAnswer', { platform: platformName('slack') }));
    }
    if (!thread.found) return errors('project', tr.t('server.chat.issue.deleted'));
    const description = describeWithReplies(input.description, thread.replies);
    made = await makeChatIssue(ctx, draft, { project: checked.key, summary: input.summary, description: description.text, replies: thread.replies.length, cut: description.cut }, tr);
  }
  if (isRefusal(made)) return errors(made.field, made.text);
  const done = made;
  // Slack has its answer first: the rest is said after.
  void slackIssueMade(app, ws, ctx, slackUser.id, channel?.externalId, draft.threadRef, done, tr).catch((e: unknown) =>
    console.warn(`chat: a Slack issue's answers weren't sent: ${e instanceof Error ? e.message : String(e)}`),
  );
  return { response_action: 'clear' };
}

/**
 * Tell the person it's done, where only they see it, with the issue's id and link; and the thread, for
 * everyone, only where D42's line allows (threadMayHear), in the channel's language.
 */
async function slackIssueMade(app: AppServices, ws: WorkspaceRow, ctx: Ctx, slackUserId: string, channel: string | undefined, thread: string, made: MadeIssue, tr: Translator): Promise<void> {
  const note = tr.t(made.again ? 'server.chat.issue.madeAlready' : 'server.chat.issue.made', { id: made.issue.id });
  await tellOne(app, ws, slackUserId, channel, { text: note, blocks: slackBlocks(await issueForCard(ctx, made.issue.id), tr, { note, actions: false }) });
  if (made.again || !channel || !(await threadMayHear(ctx, made.issue))) return;
  const [still] = await app.db.select().from(chatChannels).where(and(eq(chatChannels.workspaceId, ws.id), eq(chatChannels.externalId, channel)));
  if (!still || still.goneAt) return;
  // What the channel reads: the issue as its maker reads it, and only what every reader of the project may see.
  const issue = await issueForCard(ctx, made.issue.id, { everyone: true });
  const words = channelTr(app);
  const change = { who: ctx.actor.user.name, did: words.t('server.chat.issue.didMake'), details: [], kind: 'created' as const };
  await slackCall(
    app,
    tokenOf(app, ws),
    'chat.postMessage',
    { channel, thread_ts: thread, text: fallbackText(issue, words, change), blocks: slackBlocks(issue, words, { change }), unfurl_links: false, unfurl_media: false },
    { json: true },
  );
}
