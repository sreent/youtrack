/**
 * Chat (D42): where a4a's bot is, which channels hear of what, who people are there, and what they
 * ask it. Teams' and Slack's own protocols are in teams.ts and slack.ts; this is what they share.
 *
 * - A channel is subscribed by someone who may read what it will hear of, and who vouches for its
 *   people: a project open to everyone takes anyone who reads it; one open to its members alone,
 *   someone who manages it. Each post is checked against its subscriber's access again.
 * - A chat account acts as the a4a account it's linked to, with that account's access, through the
 *   one write path. Teams knows people who sign in through Microsoft Entra ID by their object id.
 */
import {
  CHAT_CHANGE_KINDS,
  CHAT_PLATFORM_NAMES,
  DEFAULT_CHAT_KINDS,
  type ChatAccount,
  type ChatChangeKind,
  type ChatChannel,
  type ChatLink,
  type ChatPlatform,
  type ChatStatus,
  type ChatSubscription,
  type CreateChatSubscriptionInput,
} from '@a4a/shared';
import type { Translator } from '@a4a/shared/i18n';
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { requireScope, type AppServices, type Ctx, type UserRow } from '../context';
import type { Db } from '../db/client';
import { chatAccounts, chatChannels, chatLinkTokens, chatSubscriptions, chatWorkspaces, projects, savedSearches, userIdentities, users } from '../db/schema';
import { randomToken, sha256 } from '../lib/crypto';
import { intlTag, problemFor, translatorFor } from '../i18n';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { excerpt } from '../lib/text';
import { runCommand } from '../commands/executor';
import { searchIssues } from '../search/service';
import { projectAccess, projectGrantsOf, requireProject } from '../services/access';
import { addComment } from '../services/comments';
import { createIssue, getIssue } from '../services/issues';
import { findFollowableSearch } from '../services/subscriptions';
import { userRefDto } from '../services/values';
import { cardIssue, type CardIssue } from './cards';
import { channelTr, chatCtx, personTr, type Answer } from './common';

type WorkspaceRow = typeof chatWorkspaces.$inferSelect;
type ChannelRow = typeof chatChannels.$inferSelect;
type SubscriptionRow = typeof chatSubscriptions.$inferSelect;

/** Someone in a chat, as its service names them. */
export interface ChatPerson {
  platform: ChatPlatform;
  /** Teams: the tenant. Slack: the workspace (T…). */
  workspaceExternalId: string;
  workspaceName: string;
  /** Teams: their Entra object id. Slack: their user id. */
  externalUserId: string;
  name: string;
}

/** How long a sign-in link from the bot works. */
export const LINK_TTL_MS = 15 * 60_000;

// ---------------------------------------------------------------------------
// Workspaces and channels
// ---------------------------------------------------------------------------

export async function upsertWorkspace(
  db: Db,
  input: { platform: ChatPlatform; externalId: string; name: string; tenantId?: string | null; serviceUrl?: string | null; connectedById?: string | null },
): Promise<WorkspaceRow> {
  const [row] = await db
    .insert(chatWorkspaces)
    .values({ id: newId(), platform: input.platform, externalId: input.externalId, name: input.name, tenantId: input.tenantId ?? null, serviceUrl: input.serviceUrl ?? null, connectedById: input.connectedById ?? null })
    .onConflictDoUpdate({
      target: [chatWorkspaces.platform, chatWorkspaces.externalId],
      set: {
        name: input.name,
        ...(input.tenantId ? { tenantId: input.tenantId } : {}),
        ...(input.serviceUrl ? { serviceUrl: input.serviceUrl } : {}),
        ...(input.connectedById ? { connectedById: input.connectedById } : {}),
        removedAt: null,
        removedReason: null,
      },
    })
    .returning();
  return row!;
}

export async function upsertChannel(db: Db, workspaceId: string, externalId: string, name: string): Promise<ChannelRow> {
  const [row] = await db
    .insert(chatChannels)
    .values({ id: newId(), workspaceId, externalId, name: name || externalId })
    .onConflictDoUpdate({ target: [chatChannels.workspaceId, chatChannels.externalId], set: { name: name || externalId, goneAt: null, goneReason: null } })
    .returning();
  return row!;
}

/** End the subscriptions of a channel, or of every channel of a workspace, saying why. */
async function endSubscriptions(db: Db, channelIds: string[], reason: string): Promise<void> {
  if (!channelIds.length) return;
  await db
    .update(chatSubscriptions)
    .set({ endedAt: new Date(), endedReason: reason })
    .where(and(inArray(chatSubscriptions.channelId, channelIds), isNull(chatSubscriptions.endedAt)));
}

/** a4a can't post to a channel any more: it's marked, and what it was subscribed to ends. */
export async function markChannelGone(db: Db, channelId: string, reason: string): Promise<void> {
  await db.update(chatChannels).set({ goneAt: new Date(), goneReason: reason }).where(and(eq(chatChannels.id, channelId), isNull(chatChannels.goneAt)));
  await endSubscriptions(db, [channelId], reason);
}

/** The app, or the bot, is gone from a workspace: every channel's subscriptions there end. */
export async function markWorkspaceRemoved(db: Db, workspaceId: string, reason: string, opts: { forgetSecrets?: boolean } = {}): Promise<void> {
  await db
    .update(chatWorkspaces)
    .set({ removedAt: new Date(), removedReason: reason, ...(opts.forgetSecrets ? { botToken: null, signingSecret: null } : {}) })
    .where(eq(chatWorkspaces.id, workspaceId));
  const channels = await db.select({ id: chatChannels.id }).from(chatChannels).where(eq(chatChannels.workspaceId, workspaceId));
  await endSubscriptions(db, channels.map((c) => c.id), reason);
}

export async function channelByExternal(db: Db, workspaceId: string, externalId: string): Promise<ChannelRow | undefined> {
  const [row] = await db.select().from(chatChannels).where(and(eq(chatChannels.workspaceId, workspaceId), eq(chatChannels.externalId, externalId)));
  return row;
}

function channelDto(c: ChannelRow, ws: WorkspaceRow): ChatChannel {
  return {
    id: c.id,
    platform: ws.platform as ChatPlatform,
    workspace: ws.name,
    name: c.name,
    gone: ws.removedAt ? (ws.removedReason ?? 'The app was removed') : c.goneAt ? (c.goneReason ?? 'a4a can no longer post there') : null,
  };
}

async function channelsWithWorkspaces(db: Db, ids?: string[]): Promise<Map<string, { channel: ChannelRow; workspace: WorkspaceRow }>> {
  const rows = await db
    .select({ channel: chatChannels, workspace: chatWorkspaces })
    .from(chatChannels)
    .innerJoin(chatWorkspaces, eq(chatWorkspaces.id, chatChannels.workspaceId))
    .where(ids ? (ids.length ? inArray(chatChannels.id, ids) : sql`FALSE`) : undefined)
    .orderBy(asc(chatWorkspaces.name), asc(chatChannels.name));
  return new Map(rows.map((r) => [r.channel.id, r]));
}

/** Who isn't a guest, and isn't someone a4a doesn't know, may see what channels a4a can post to. */
function requireMember(ctx: Ctx): void {
  requireScope(ctx, 'read');
  if (ctx.actor.guest) throw forbidden('Sign in to see chat channels');
}

/** The channels a4a can post to, for subscribing one. */
export async function listChatChannels(ctx: Ctx): Promise<ChatChannel[]> {
  requireMember(ctx);
  const all = await channelsWithWorkspaces(ctx.db);
  return [...all.values()].filter((r) => !r.channel.goneAt && !r.workspace.removedAt).map((r) => channelDto(r.channel, r.workspace));
}

// ---------------------------------------------------------------------------
// Status, for administrators
// ---------------------------------------------------------------------------

export async function chatStatus(ctx: Ctx): Promise<ChatStatus> {
  requireScope(ctx, 'admin');
  const base = `${ctx.app.config.publicUrl}/api/v1/chat`;
  const teams = ctx.app.config.teams;
  const workspaces = await ctx.db.select().from(chatWorkspaces).orderBy(asc(chatWorkspaces.name));
  const slack = workspaces.filter((w) => w.platform === 'slack').sort((a, b) => Number(Boolean(a.removedAt)) - Number(Boolean(b.removedAt)))[0];
  const s = await ctx.app.schema.get();
  const by = slack?.connectedById ? s.users.get(slack.connectedById) : undefined;
  const all = await channelsWithWorkspaces(ctx.db);
  return {
    teams: {
      configured: Boolean(teams),
      botId: teams?.appId ?? null,
      tenantId: teams?.tenantId ?? null,
      messagingEndpoint: `${base}/teams/messages`,
      teams: workspaces
        .filter((w) => w.platform === 'teams')
        .map((w) => ({ id: w.id, name: w.name, installedAt: w.createdAt.toISOString(), removed: w.removedAt ? (w.removedReason ?? 'removed') : null })),
    },
    slack: {
      connected: Boolean(slack && !slack.removedAt),
      workspace: slack?.name ?? null,
      connectedBy: by ? userRefDto(by) : null,
      connectedAt: slack ? slack.createdAt.toISOString() : null,
      removed: slack?.removedAt ? (slack.removedReason ?? 'removed') : null,
      requestUrls: { commands: `${base}/slack/commands`, interactivity: `${base}/slack/interactions`, events: `${base}/slack/events` },
    },
    channels: [...all.values()].map((r) => channelDto(r.channel, r.workspace)),
  };
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

const KIND_WORDS: Record<ChatChangeKind, string> = {
  created: 'server.chat.kind.created',
  state: 'server.chat.kind.state',
  assigned: 'server.chat.kind.assigned',
  commented: 'server.chat.kind.commented',
  fields: 'server.chat.kind.fields',
};

/**
 * "New issues, state changes and comments in Backend", in a language: English for the API, the
 * server's for a channel (D49).
 */
export function aboutChannel(kinds: readonly string[], target: { project?: string | null; search?: string | null }, tr: Translator): string {
  const words = CHAT_CHANGE_KINDS.filter((k) => kinds.includes(k)).map((k) => tr.t(KIND_WORDS[k]));
  const listed = words.length ? new Intl.ListFormat(intlTag(tr.locale), { style: 'long', type: 'conjunction' }).format(words) : tr.t('server.chat.kind.nothing');
  const what = `${listed.charAt(0).toUpperCase()}${listed.slice(1)}`;
  return target.project
    ? tr.t('server.chat.about.project', { what, project: target.project })
    : tr.t('server.chat.about.search', { what, search: target.search ?? tr.t('server.chat.about.aSavedSearch') });
}

/** The API's words are English (D49). */
const ENGLISH = translatorFor('en');

/**
 * Whether someone may have a channel told of a project's issues: they read it, and, when it's open to
 * its members alone, they manage it, since the channel's people may not be members. Null when they may;
 * otherwise why not, in words for the page.
 */
export async function whyNotFor(db: Db, userId: string | null, projectId: string, projectName: string): Promise<string | null> {
  if (!userId) return 'Its subscriber’s account is gone';
  const grant = (await projectGrantsOf(db, projectId, [userId])).get(userId);
  if (!grant) return `Its subscriber can no longer see ${projectName}`;
  const [p] = await db.select({ visibility: projects.visibility }).from(projects).where(eq(projects.id, projectId));
  if (p?.visibility === 'members' && !grant.permissions.has('manage')) return `${projectName} is open to its members alone, and its subscriber doesn’t manage it`;
  return null;
}

async function subscriptionDtos(ctx: Ctx, rows: SubscriptionRow[]): Promise<ChatSubscription[]> {
  if (!rows.length) return [];
  const s = await ctx.app.schema.get();
  const channels = await channelsWithWorkspaces(ctx.db, [...new Set(rows.map((r) => r.channelId))]);
  const searchIds = [...new Set(rows.map((r) => r.savedSearchId).filter((x): x is string => Boolean(x)))];
  const searches = new Map(searchIds.length ? (await ctx.db.select().from(savedSearches).where(inArray(savedSearches.id, searchIds))).map((r) => [r.id, r]) : []);
  const out: ChatSubscription[] = [];
  for (const r of rows) {
    const ch = channels.get(r.channelId);
    if (!ch) continue;
    const project = r.projectId ? s.projects.get(r.projectId) : undefined;
    const search = r.savedSearchId ? searches.get(r.savedSearchId) : undefined;
    const by = r.createdById ? s.users.get(r.createdById) : undefined;
    out.push({
      id: r.id,
      channel: channelDto(ch.channel, ch.workspace),
      target: r.projectId ? 'project' : 'search',
      project: project ? { key: project.key, name: project.name } : null,
      search: search ? { id: search.id, name: search.name } : null,
      kinds: CHAT_CHANGE_KINDS.filter((k) => r.kinds.includes(k)),
      about: aboutChannel(r.kinds, { project: project?.name, search: search?.name }, ENGLISH),
      createdBy: by ? userRefDto(by) : null,
      createdAt: r.createdAt.toISOString(),
      ended: r.endedAt ? { at: r.endedAt.toISOString(), reason: r.endedReason ?? 'It stopped' } : null,
    });
  }
  return out;
}

/**
 * Channel subscriptions the caller may see: an administrator, all of them; anyone else, those of
 * projects they read, and their own. `project` narrows them to one project's.
 */
export async function listChatSubscriptions(ctx: Ctx, filter: { project?: string } = {}): Promise<ChatSubscription[]> {
  requireMember(ctx);
  const project = filter.project ? await requireProject(ctx, filter.project, 'read') : undefined;
  const rows = await ctx.db
    .select()
    .from(chatSubscriptions)
    .where(project ? eq(chatSubscriptions.projectId, project.id) : undefined)
    .orderBy(asc(chatSubscriptions.endedAt), desc(chatSubscriptions.createdAt));
  const view = await projectAccess(ctx);
  const me = ctx.actor.user.id;
  const visible = rows.filter((r) => view.admin || r.createdById === me || (r.projectId !== null && view.canRead(r.projectId)));
  return subscriptionDtos(ctx, visible);
}

async function ownSubscription(ctx: Ctx, id: string): Promise<SubscriptionRow> {
  requireScope(ctx, 'write');
  const [row] = await ctx.db.select().from(chatSubscriptions).where(eq(chatSubscriptions.id, id));
  const view = await projectAccess(ctx);
  // What the caller can't see is missing, as anywhere else.
  if (!row || !(view.admin || row.createdById === ctx.actor.user.id || (row.projectId && view.canRead(row.projectId)))) throw notFound('Chat subscription');
  if (!(view.admin || row.createdById === ctx.actor.user.id || (row.projectId && view.canManage(row.projectId)))) {
    throw forbidden('Only whoever subscribed the channel, the project’s managers and administrators can change it');
  }
  return row;
}

function kindsFrom(input: readonly string[] | undefined): ChatChangeKind[] {
  const kinds = CHAT_CHANGE_KINDS.filter((k) => (input ?? DEFAULT_CHAT_KINDS).includes(k));
  if (!kinds.length) throw badRequest('Choose what the channel hears of', `One or more of: ${CHAT_CHANGE_KINDS.join(', ')}.`);
  return kinds;
}

/** Subscribe a channel to a project's issues, or a saved search's, as the caller, who vouches for its people. */
export async function createChatSubscription(ctx: Ctx, input: CreateChatSubscriptionInput): Promise<ChatSubscription> {
  requireScope(ctx, 'write');
  requireMember(ctx);
  if (Boolean(input.project) === Boolean(input.savedSearch)) throw badRequest('Subscribe the channel to a project or to a saved search', 'Send one of project and savedSearch.');
  const [ch] = [...(await channelsWithWorkspaces(ctx.db, [input.channel])).values()];
  if (!ch) throw notFound('Channel', 'GET /chat/channels lists those a4a can post to.');
  if (ch.channel.goneAt || ch.workspace.removedAt) throw badRequest(`a4a can no longer post to ${ch.channel.name}`, channelDto(ch.channel, ch.workspace).gone ?? undefined);
  const kinds = kindsFrom(input.kinds);
  let projectId: string | null = null;
  let searchId: string | null = null;
  if (input.project) {
    const project = await requireProject(ctx, input.project, 'read');
    const why = await whyNotFor(ctx.db, ctx.actor.user.id, project.id, project.name);
    if (why) throw forbidden(`${project.name} is open to its members alone: only someone who manages it can have a channel told of it`, 'Ask one of its managers.');
    projectId = project.id;
  } else {
    searchId = (await findFollowableSearch(ctx, input.savedSearch!)).id;
  }
  const [same] = await ctx.db
    .select({ id: chatSubscriptions.id })
    .from(chatSubscriptions)
    .where(
      and(
        eq(chatSubscriptions.channelId, ch.channel.id),
        isNull(chatSubscriptions.endedAt),
        projectId ? eq(chatSubscriptions.projectId, projectId) : eq(chatSubscriptions.savedSearchId, searchId!),
      ),
    );
  if (same) throw conflict(`${ch.channel.name} hears of it already`, 'Change what it hears of instead.');
  const [row] = await ctx.db
    .insert(chatSubscriptions)
    .values({ id: newId(), channelId: ch.channel.id, projectId, savedSearchId: searchId, kinds, createdById: ctx.actor.user.id })
    .returning();
  return (await subscriptionDtos(ctx, [row!]))[0]!;
}

export async function updateChatSubscription(ctx: Ctx, id: string, input: { kinds: string[] }): Promise<ChatSubscription> {
  const row = await ownSubscription(ctx, id);
  if (row.endedAt) throw conflict('This subscription has stopped', 'Subscribe the channel again.');
  const [updated] = await ctx.db.update(chatSubscriptions).set({ kinds: kindsFrom(input.kinds) }).where(eq(chatSubscriptions.id, id)).returning();
  return (await subscriptionDtos(ctx, [updated!]))[0]!;
}

export async function deleteChatSubscription(ctx: Ctx, id: string): Promise<void> {
  await ownSubscription(ctx, id);
  await ctx.db.delete(chatSubscriptions).where(eq(chatSubscriptions.id, id));
}

// ---------------------------------------------------------------------------
// People: who a chat account is in a4a, and linking one
// ---------------------------------------------------------------------------

/** The a4a account a chat account acts as, or null: unlinked, or one that can't act (banned, an agent's). */
export async function personFor(app: AppServices, who: ChatPerson): Promise<UserRow | null> {
  let user: UserRow | undefined;
  if (who.platform === 'teams') {
    // Signed in through Entra ID: Teams names them as Entra does.
    const [hit] = await app.db
      .select({ user: users })
      .from(userIdentities)
      .innerJoin(users, eq(users.id, userIdentities.userId))
      .where(and(eq(userIdentities.objectId, who.externalUserId), eq(userIdentities.tenantId, who.workspaceExternalId)))
      .limit(1);
    user = hit?.user;
  }
  if (!user) {
    const [hit] = await app.db
      .select({ user: users })
      .from(chatAccounts)
      .innerJoin(users, eq(users.id, chatAccounts.userId))
      .where(and(eq(chatAccounts.platform, who.platform), eq(chatAccounts.workspaceExternalId, who.workspaceExternalId), eq(chatAccounts.externalUserId, who.externalUserId)));
    user = hit?.user;
  }
  if (!user || user.banned || user.isBot) return null;
  return user;
}

/** A sign-in link for someone a4a doesn't know yet, to send them where only they read it. */
export async function linkUrl(app: AppServices, who: ChatPerson, reply: { serviceUrl?: string; conversationId?: string } | null = null): Promise<string> {
  const token = randomToken('', 24);
  await app.db.delete(chatLinkTokens).where(sql`${chatLinkTokens.expiresAt} < now()`);
  await app.db.insert(chatLinkTokens).values({
    tokenHash: sha256(token),
    platform: who.platform,
    workspaceExternalId: who.workspaceExternalId,
    workspaceName: who.workspaceName,
    externalUserId: who.externalUserId,
    name: excerpt(who.name || who.externalUserId, 100),
    reply,
    expiresAt: new Date(Date.now() + LINK_TTL_MS),
  });
  return `${app.config.publicUrl}/chat/link?token=${encodeURIComponent(token)}`;
}

async function liveLink(ctx: Ctx, token: string) {
  requireMember(ctx);
  const [row] = await ctx.db
    .select()
    .from(chatLinkTokens)
    .where(and(eq(chatLinkTokens.tokenHash, sha256(token)), isNull(chatLinkTokens.usedAt), gt(chatLinkTokens.expiresAt, new Date())));
  if (!row) throw notFound('Link', 'It works once, for 15 minutes. Ask the bot for another: say "link" to it.');
  return row;
}

/** What a sign-in link would link, for the page that asks to confirm it. */
export async function chatLinkInfo(ctx: Ctx, token: string): Promise<ChatLink> {
  const row = await liveLink(ctx, token);
  const [linked] = await ctx.db
    .select({ user: users })
    .from(chatAccounts)
    .innerJoin(users, eq(users.id, chatAccounts.userId))
    .where(and(eq(chatAccounts.platform, row.platform), eq(chatAccounts.workspaceExternalId, row.workspaceExternalId), eq(chatAccounts.externalUserId, row.externalUserId)));
  return {
    platform: row.platform as ChatPlatform,
    workspace: row.workspaceName,
    name: row.name,
    expiresAt: row.expiresAt.toISOString(),
    linkedTo: linked ? userRefDto(linked.user) : null,
  };
}

/**
 * Link the chat account a sign-in link names to whoever confirms it, signed in on the web: a person,
 * never an agent or a token. Used once. Afterwards the bot says so where it sent the link.
 */
export async function acceptChatLink(ctx: Ctx, token: string, tell?: (row: typeof chatLinkTokens.$inferSelect, user: UserRow) => Promise<void>): Promise<ChatAccount> {
  if (ctx.actor.authMethod !== 'session' || ctx.actor.channel !== 'web' || ctx.actor.user.isBot) {
    throw forbidden('Only a person, signed in on the web, can link their chat account', 'Open the link in your browser.');
  }
  requireScope(ctx, 'read');
  await liveLink(ctx, token);
  const [row] = await ctx.db
    .update(chatLinkTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(chatLinkTokens.tokenHash, sha256(token)), isNull(chatLinkTokens.usedAt)))
    .returning();
  if (!row) throw notFound('Link', 'It was used just now. Ask the bot for another: say "link" to it.');
  const [account] = await ctx.db
    .insert(chatAccounts)
    .values({
      id: newId(),
      platform: row.platform,
      workspaceExternalId: row.workspaceExternalId,
      workspaceName: row.workspaceName,
      externalUserId: row.externalUserId,
      userId: ctx.actor.user.id,
      name: row.name,
    })
    .onConflictDoUpdate({
      target: [chatAccounts.platform, chatAccounts.workspaceExternalId, chatAccounts.externalUserId],
      set: { userId: ctx.actor.user.id, name: row.name, workspaceName: row.workspaceName, linkedAt: new Date() },
    })
    .returning();
  await tell?.(row, ctx.actor.user).catch((e: unknown) => console.warn(`chat: couldn't say a link was made: ${e instanceof Error ? e.message : String(e)}`));
  return accountDto(account!);
}

function accountDto(a: typeof chatAccounts.$inferSelect): ChatAccount {
  return { id: a.id, platform: a.platform as ChatPlatform, workspace: a.workspaceName, name: a.name, linkedAt: a.linkedAt.toISOString(), via: 'link' };
}

/** The caller's chat accounts: those they linked, and Teams' knowing them by their Entra ID sign-in. */
export async function myChatAccounts(ctx: Ctx): Promise<ChatAccount[]> {
  requireMember(ctx);
  const rows = await ctx.db.select().from(chatAccounts).where(eq(chatAccounts.userId, ctx.actor.user.id)).orderBy(asc(chatAccounts.linkedAt));
  const out = rows.map(accountDto);
  const teams = ctx.app.config.teams;
  if (teams) {
    const [entra] = await ctx.db
      .select()
      .from(userIdentities)
      .where(and(eq(userIdentities.userId, ctx.actor.user.id), eq(userIdentities.tenantId, teams.tenantId), sql`${userIdentities.objectId} IS NOT NULL`))
      .limit(1);
    if (entra) {
      out.unshift({ id: `entra:${entra.id}`, platform: 'teams', workspace: 'Microsoft Entra ID', name: ctx.actor.user.name, linkedAt: entra.createdAt.toISOString(), via: 'entra' });
    }
  }
  return out;
}

export async function unlinkChatAccount(ctx: Ctx, id: string): Promise<void> {
  requireMember(ctx);
  if (id.startsWith('entra:')) {
    throw badRequest('Teams knows you by your Microsoft Entra ID sign-in, which isn’t a link', 'An administrator can stop the Teams bot, or remove it from a team.');
  }
  const res = await ctx.db
    .delete(chatAccounts)
    .where(and(eq(chatAccounts.id, id), eq(chatAccounts.userId, ctx.actor.user.id)))
    .returning({ id: chatAccounts.id });
  if (!res.length) throw notFound('Chat account');
}

// ---------------------------------------------------------------------------
// What people ask the bot
// ---------------------------------------------------------------------------


const KIND_ALIASES: Record<string, ChatChangeKind> = {
  new: 'created',
  created: 'created',
  issues: 'created',
  state: 'state',
  states: 'state',
  assigned: 'assigned',
  assignments: 'assigned',
  assignee: 'assigned',
  comment: 'commented',
  comments: 'commented',
  commented: 'commented',
  fields: 'fields',
  changes: 'fields',
  other: 'fields',
};

/** An issue as the person sees it, for a card. */
export async function issueForCard(ctx: Ctx, id: string): Promise<CardIssue> {
  const detail = await getIssue(ctx, id);
  return cardIssue(ctx.app, await ctx.app.schema.get(), detail);
}

/**
 * What a command did to an issue, in a line, in its person's language: its changes, or why not. The
 * command's own words (what it changes, a problem with how it's written) are the command language's.
 */
export function commandOutcome(res: Awaited<ReturnType<typeof runCommand>>, tr: Translator): { text: string; bad: boolean } {
  if (res.problems.length) return { text: res.problems.map((p) => (p.hint ? `${p.message} (${p.hint})` : p.message)).join('; '), bad: true };
  const r = res.results[0];
  if (r?.errors.length) return { text: r.errors.join('; '), bad: true };
  if (!r?.changes.length) return { text: tr.t('server.chat.nothingToChange'), bad: false };
  return { text: tr.t('server.chat.done', { change: res.description }), bad: false };
}

function errorWords(e: unknown, tr: Translator): string {
  if (e instanceof AppError) return problemFor(tr, e);
  return e instanceof Error ? e.message : String(e);
}

/**
 * Do what someone asked the bot, as them. `channel` is where they asked when it's a channel a4a
 * knows (for subscribing it); an answer is for them alone unless it's marked public.
 */
export async function runChatCommand(app: AppServices, platform: ChatPlatform, user: UserRow, raw: string, where: { channelId?: string | null } = {}): Promise<Answer> {
  const ctx = chatCtx(app, user, platform);
  // Said to them in their language, and the cards beside it too; the bot's own words (help, new,
  // search, subscribe) are its commands', the same in every language.
  const tr = personTr(app, user);
  const locale = tr.locale;
  const text = raw.replace(/\s+/g, ' ').trim();
  try {
    if (!text || /^(help|\?)$/i.test(text)) return { text: tr.t('server.chat.help'), locale };
    let m: RegExpExecArray | null;
    if ((m = /^(?:new|create|report)\s+([A-Za-z][A-Za-z0-9]*)\s+(.+)$/i.exec(text))) {
      const created = await createIssue(ctx, { project: m[1]!, summary: m[2]!.slice(0, 500) });
      return { text: tr.t('server.chat.reported', { id: created.id }), locale, issues: [cardIssue(app, await app.schema.get(), created)] };
    }
    if ((m = /^(?:search|find)\s+(.+)$/i.exec(text))) {
      const found = await searchIssues(ctx, m[1]!, 0, 5);
      if (!found.total) return { text: tr.t('server.chat.nothingMatches'), locale };
      const shown = await Promise.all(found.items.map((i) => issueForCard(ctx, i.id)));
      const text =
        found.total > shown.length
          ? tr.t('server.chat.matchesFirst', { total: found.total, shown: shown.length, url: `${app.config.publicUrl}/issues?q=${encodeURIComponent(m[1]!)}` })
          : tr.t('server.chat.matches', { total: found.total });
      return { text, locale, issues: shown };
    }
    if ((m = /^comment\s+([A-Za-z][A-Za-z0-9]*-\d+)\s+(.+)$/i.exec(text))) {
      await addComment(ctx, m[1]!, raw.trim().replace(/^comment\s+\S+\s+/i, '').slice(0, 50_000));
      return { text: tr.t('server.chat.commentedOn', { id: m[1]!.toUpperCase() }), locale, issues: [await issueForCard(ctx, m[1]!)] };
    }
    if ((m = /^(subscribe|unsubscribe)\b\s*(.*)$/i.exec(text))) return await subscribeHere(ctx, m[1]!.toLowerCase() === 'subscribe', m[2]!, where.channelId ?? null, tr);
    if ((m = /^([A-Za-z][A-Za-z0-9]*-\d+)\s*(.*)$/.exec(text))) {
      const id = m[1]!.toUpperCase();
      if (!m[2]) return { text: id, locale, issues: [await issueForCard(ctx, id)] };
      const outcome = commandOutcome(await runCommand(ctx, { issues: [id], command: m[2] }), tr);
      return { text: outcome.text, locale, issues: [await issueForCard(ctx, id)] };
    }
    return { text: tr.t('server.chat.unknown', { text: excerpt(text, 60) }), locale };
  } catch (e) {
    return { text: errorWords(e, tr), locale };
  }
}

/**
 * subscribe BACK [kinds], subscribe "Saved search" [kinds], unsubscribe BACK: for the channel asked in.
 * Said to the person in theirs; what the whole channel reads, in the channel's (D49).
 */
async function subscribeHere(ctx: Ctx, on: boolean, rest: string, channelId: string | null, tr: Translator): Promise<Answer> {
  const locale = tr.locale;
  if (!channelId) return { text: tr.t('server.chat.askInChannel'), locale };
  const m = /^(?:"([^"]+)"|“([^”]+)”|(\S+))\s*(.*)$/.exec(rest.trim());
  if (!m) return { text: tr.t(on ? 'server.chat.sayWhich' : 'server.chat.sayWhichUnsubscribe'), locale };
  const quoted = m[1] ?? m[2];
  const word = m[3];
  const target = quoted ? { savedSearch: quoted } : { project: word! };
  if (on) {
    const named = m[4]!.split(/[\s,]+/).filter(Boolean);
    const kinds = named.map((w) => KIND_ALIASES[w.toLowerCase()]).filter((k): k is ChatChangeKind => Boolean(k));
    if (named.length && kinds.length !== named.length) return { text: tr.t('server.chat.kinds', { kinds: Object.keys(KIND_ALIASES).join(', ') }), locale };
    const sub = await createChatSubscription(ctx, { channel: channelId, ...target, kinds: kinds.length ? kinds : [...DEFAULT_CHAT_KINDS] });
    const channel = channelTr(ctx.app);
    const about = aboutChannel(sub.kinds, { project: sub.project?.name, search: sub.search?.name }, channel);
    return { text: channel.t('server.chat.subscribed', { name: ctx.actor.user.name, about }), locale: channel.locale, public: true };
  }
  const mine = (await listChatSubscriptions(ctx)).filter(
    (s) => s.channel.id === channelId && !s.ended && (quoted ? s.search?.name.toLowerCase() === quoted.toLowerCase() : s.project?.key === word!.toUpperCase()),
  );
  if (!mine.length) return { text: tr.t('server.chat.hearsNothing'), locale };
  for (const s of mine) await deleteChatSubscription(ctx, s.id);
  const channel = channelTr(ctx.app);
  const about = mine.map((s) => aboutChannel(s.kinds, { project: s.project?.name, search: s.search?.name }, channel)).join('; ');
  return { text: channel.t('server.chat.unsubscribed', { name: ctx.actor.user.name, about }), locale: channel.locale, public: true };
}

/** Where the platform's name reads in a sentence. */
export const platformName = (p: ChatPlatform) => CHAT_PLATFORM_NAMES[p];
