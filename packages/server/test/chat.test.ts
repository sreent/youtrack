/**
 * Chat with Teams and Slack (docs/architecture.md, D42): requests checked before they're read, the
 * line a channel's posts never cross, people acting as themselves, and channels that go.
 */
import type { IssueDetail } from '@a4a/shared';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpApp } from '../src/http/app';
import { chatConsumer, ChatWorker, queueChatPosts } from '../src/chat/outbox';
import { teamsAppPackage } from '../src/chat/package';
import { acceptChatLink, chatLinkInfo, createChatSubscription, listChatChannels, listChatSubscriptions, myChatAccounts } from '../src/chat/service';
import type { Ctx, UserRow } from '../src/context';
import { activities, chatOutbox, chatSubscriptions, helpdeskRequests, requesters, userIdentities } from '../src/db/schema';
import { OutboxWorker } from '../src/events/worker';
import { newId } from '../src/lib/ids';
import { addComment } from '../src/services/comments';
import { createIssue, getIssue, setIssueVisibility, updateIssue } from '../src/services/issues';
import { addMember } from '../src/services/members';
import { createProject } from '../src/services/projects';
import { toolByName } from '../src/tools/registry';
import { FakeSlack, FakeTeams } from './fake-chat';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let http: ReturnType<typeof createHttpApp>;
let teams: FakeTeams;
let slack: FakeSlack;
let outbox: OutboxWorker;
let sender: ChatWorker;

const TEAM = '19:team-general@thread.tacv2';
const RELEASES = '19:releases@thread.tacv2';
const ANNA_TEAMS = '29:anna-teams-id';
const BEN_TEAMS = '29:ben-teams-id';

/** As the web would act for someone signed in. */
function web(user: UserRow): Ctx {
  const ctx = w.as(user);
  return { ...ctx, actor: { ...ctx.actor, channel: 'web', authMethod: 'session' } };
}

async function fromTeams(activity: Record<string, unknown>, token = teams.token()) {
  const res = await http.request('/api/v1/chat/teams/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ channelId: 'msteams', serviceUrl: teams.serviceUrl, ...activity }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

const channelData = (extra: Record<string, unknown> = {}) => ({ tenant: { id: teams.tenantId }, team: { id: TEAM, name: 'Engineering' }, ...extra });

function inChannel(text: string, from: { id: string; aadObjectId: string; name: string }, channel = TEAM) {
  return fromTeams({
    type: 'message',
    id: `m-${newId(6)}`,
    text: `<at>a4a</at> ${text}`,
    from,
    recipient: { id: `28:${teams.appId}` },
    conversation: { id: `${channel};messageid=1`, conversationType: 'channel', tenantId: teams.tenantId },
    channelData: channelData({ channel: { id: channel } }),
  });
}

function inPersonal(text: string, from: { id: string; aadObjectId: string; name: string }) {
  return fromTeams({
    type: 'message',
    id: `m-${newId(6)}`,
    text,
    from,
    recipient: { id: `28:${teams.appId}` },
    conversation: { id: `a:personal-${from.id}`, conversationType: 'personal', tenantId: teams.tenantId },
    channelData: { tenant: { id: teams.tenantId } },
  });
}

const anna = () => ({ id: ANNA_TEAMS, aadObjectId: 'oid-anna', name: 'Anna Schmidt' });
const ben = () => ({ id: BEN_TEAMS, aadObjectId: 'oid-ben', name: 'Ben Okafor' });

async function fromSlack(path: string, body: string, headers: Record<string, string> = slack.signed(body), type = 'application/x-www-form-urlencoded') {
  const res = await http.request(`/api/v1/chat/slack/${path}`, { method: 'POST', headers: { 'content-type': type, ...headers }, body });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

const slash = (text: string, user = 'U0ANNA', channel = 'C0ENG') =>
  new URLSearchParams({ team_id: slack.teamId, user_id: user, user_name: user.toLowerCase(), channel_id: channel, channel_name: channel === 'C0ENG' ? 'eng' : 'directmessage', text, command: '/a4a' }).toString();

/** Run the outbox's chat consumer, then post what it queued. */
async function deliver() {
  await outbox.drain();
  await sender.drain();
}

const value = (i: IssueDetail, name: string) => {
  const v = i.fields.find((f) => f.name === name)?.value as { login?: string; name?: string } | null | undefined;
  return v?.login ?? v?.name ?? null;
};

const cardText = (activity: Record<string, unknown>) => JSON.stringify(activity.attachments ?? []);

beforeAll(async () => {
  teams = await new FakeTeams().start();
  slack = await new FakeSlack().start();
  teams.channels = [{ id: TEAM }, { id: RELEASES, name: 'Releases' }];
  w = await createWorld({
    config: {
      teams: {
        appId: teams.appId,
        appPassword: teams.appPassword,
        tenantId: teams.tenantId,
        openIdMetadataUrl: `${teams.url}/openid`,
        tokenUrl: `${teams.url}/token`,
        serviceHosts: [],
      },
      slackApiUrl: slack.apiUrl,
      chatAllowHttpLoopback: true,
    },
  });
  http = createHttpApp(w.app);
  outbox = new OutboxWorker(w.app, [chatConsumer(w.app)], {}, [], () => {});
  await outbox.drain();
  sender = new ChatWorker(w.app);
  // Anna signs in with Entra ID: Teams knows her by her object id.
  await w.app.db.insert(userIdentities).values({ id: newId(), provider: 'https://login.microsoftonline.com/x/v2.0', subject: 'sub-anna', userId: w.anna.id, objectId: 'oid-anna', tenantId: teams.tenantId });
  await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Exports time out on big projects' });
});

afterAll(async () => {
  await w?.close();
  await teams?.stop();
  await slack?.stop();
});

describe('Teams: what it sends is checked before it is read', () => {
  const ping = { type: 'message', text: 'help', from: anna(), conversation: { id: 'a:x', conversationType: 'personal' }, channelData: { tenant: { id: '' } } };

  it('refuses no token, a forged one, another audience, an old one, and another service URL', async () => {
    ping.channelData.tenant.id = teams.tenantId;
    expect((await fromTeams(ping, '')).status).toBe(401);
    expect((await fromTeams(ping, teams.token({}, { key: teams.forgerKey }))).status).toBe(401);
    expect((await fromTeams(ping, teams.token({ aud: 'someone-else' }))).status).toBe(401);
    expect((await fromTeams(ping, teams.token({ exp: Math.floor(Date.now() / 1000) - 3600 }))).status).toBe(401);
    expect((await fromTeams(ping, teams.token({ iss: 'https://sts.windows.net/evil/' }))).status).toBe(401);
    expect((await fromTeams(ping, teams.token({ serviceurl: 'https://smba.trafficmanager.net/emea/' }))).status).toBe(401);
    expect((await fromTeams(ping, teams.token({}, { kid: 'unknown' }))).status).toBe(401);
    expect(teams.posted).toHaveLength(0);
  });

  it('ignores another tenant', async () => {
    const res = await fromTeams({ ...ping, channelData: { tenant: { id: 'another-tenant' } } });
    expect(res.status).toBe(200);
    expect(teams.posted).toHaveLength(0);
  });
});

describe('Teams: a team, its channels, and people', () => {
  it('keeps a team it is added to, and its channels', async () => {
    const res = await fromTeams({
      type: 'conversationUpdate',
      recipient: { id: `28:${teams.appId}` },
      membersAdded: [{ id: `28:${teams.appId}` }],
      conversation: { id: TEAM, conversationType: 'channel', tenantId: teams.tenantId },
      channelData: channelData({ eventType: 'teamMemberAdded' }),
    });
    expect(res.status).toBe(200);
    const channels = await listChatChannels(w.as(w.anna));
    expect(channels.map((c) => `${c.workspace} ${c.name}`).sort()).toEqual(['Engineering General', 'Engineering Releases']);
  });

  it('knows someone who signs in with Entra ID, and acts as them', async () => {
    const res = await inPersonal('BACK-1 for me', anna());
    expect(res.status).toBe(200);
    const reply = teams.postsTo(`a:personal-${ANNA_TEAMS}`).at(-1)!;
    expect(reply.text).toMatch(/^Done: /);
    expect(cardText(reply)).toContain('Exports time out on big projects');
    expect(value(await getIssue(w.adminCtx, 'BACK-1'), 'Assignee')).toBe('anna');
    const [act] = await w.app.db.select().from(activities).orderBy(desc(activities.id)).limit(1);
    expect(act!.channel).toBe('chat');
    expect(act!.actorId).toBe(w.anna.id);
  });

  it('sends someone it doesn’t know a link, in their personal chat alone, and acts as them once they confirm', async () => {
    await inChannel('search Exports', ben());
    // Not in the channel: a word there, and the link in a personal chat.
    const channelReply = teams.postsTo(`${TEAM};messageid=1`).at(-1)!;
    expect(channelReply.text).toBe('I’ve answered you in our personal chat.');
    const personal = teams.postsTo(`a:personal-${BEN_TEAMS}`).at(-1)!;
    const token = /\/chat\/link\?token=([^\s]+)/.exec(String(personal.text))?.[1];
    expect(token).toBeTruthy();
    const info = await chatLinkInfo(web(w.ben), decodeURIComponent(token!));
    expect(info).toMatchObject({ platform: 'teams', name: 'Ben Okafor', linkedTo: null });
    // An agent, or a token, can't link a person.
    await expect(acceptChatLink(w.as(w.ben), decodeURIComponent(token!))).rejects.toThrow(/Only a person/);
    const account = await acceptChatLink(web(w.ben), decodeURIComponent(token!), async (row, user) => {
      const { teamsLinked } = await import('../src/chat/teams');
      await teamsLinked(w.app, row.reply, user.name);
    });
    expect(account).toMatchObject({ platform: 'teams', name: 'Ben Okafor', via: 'link' });
    expect(String(teams.postsTo(`a:personal-${BEN_TEAMS}`).at(-1)!.text)).toMatch(/You're linked: I act as Ben Okafor/);
    // Used once.
    await expect(acceptChatLink(web(w.ben), decodeURIComponent(token!))).rejects.toThrow(/Link not found/);
    await inPersonal('comment BACK-1 I can look at it on Monday', ben());
    expect(String(teams.postsTo(`a:personal-${BEN_TEAMS}`).at(-1)!.text)).toBe('Commented on BACK-1.');
    expect((await myChatAccounts(web(w.ben))).map((a) => a.via)).toEqual(['link']);
    expect((await myChatAccounts(web(w.anna))).map((a) => a.via)).toEqual(['entra']);
  });
});

describe('a channel’s news, and the line it never crosses', () => {
  let secret: IssueDetail;

  it('is subscribed by someone in the channel, as them, and says so there', async () => {
    await inChannel('subscribe BACK new state comments', anna());
    const said = teams.postsTo(`${TEAM};messageid=1`).at(-1)!;
    expect(said.text).toBe('Anna Schmidt subscribed this channel: New issues, state changes and comments in Backend.');
    const subs = await listChatSubscriptions(w.as(w.anna), { project: 'BACK' });
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ kinds: ['created', 'state', 'commented'], createdBy: { login: 'anna' }, ended: null });
  });

  it('posts a new issue, a state change and a comment, as change cards', async () => {
    const before = teams.postsTo(TEAM).length;
    const issue = await createIssue(w.as(w.ben), { project: 'BACK', summary: 'The token cache leaks memory' });
    await updateIssue(w.as(w.ben), issue.id, { fields: { State: 'In Progress' } });
    await addComment(w.as(w.ben), issue.id, 'It grows by a megabyte an hour.');
    // Assignee changes aren't asked for: not posted.
    await updateIssue(w.as(w.ben), issue.id, { fields: { Assignee: 'ben' } });
    await deliver();
    const posts = teams.postsTo(TEAM).slice(before);
    expect(posts.map((p) => p.summary)).toEqual([`Ben Okafor reported it: ${issue.id}`, `Ben Okafor changed State: ${issue.id}`, `Ben Okafor commented: ${issue.id}`]);
    expect(cardText(posts[2]!)).toContain('It grows by a megabyte an hour.');
    expect(cardText(posts[2]!)).toContain('"verb":"assign"');
    // Handed over twice, posted once.
    await queueChatPosts(w.app, await lastEvent());
    await sender.drain();
    expect(teams.postsTo(TEAM).length).toBe(before + 3);
  });

  it('never posts an issue or a comment limited to some people', async () => {
    const before = teams.postsTo(TEAM).length;
    secret = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Rotate the leaked signing key', visibleTo: { users: ['ben'], groups: [] } });
    await addComment(w.as(w.anna), 'BACK-1', 'Only for Ben: the key is in the vault.', { visibleTo: { users: ['ben'], groups: [] } });
    await addComment(w.as(w.anna), secret.id, 'Done.');
    await deliver();
    expect(teams.postsTo(TEAM).length).toBe(before);
    expect(JSON.stringify(teams.posted)).not.toContain('signing key');
  });

  it('doesn’t post what was limited after it was queued', async () => {
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Customer list export' });
    await outbox.drain();
    await setIssueVisibility(w.as(w.anna), issue.id, { visibleTo: { users: ['anna'], groups: [] } });
    const before = teams.postsTo(TEAM).length;
    await sender.drain();
    expect(teams.postsTo(TEAM).length).toBe(before);
    const [row] = await w.app.db.select().from(chatOutbox).where(eq(chatOutbox.eventId, (await eventOf(issue.id, 'issue.created')).id));
    expect(row).toMatchObject({ status: 'skipped' });
  });

  it('keeps a help desk’s internal notes, and a requester’s address, off the channel', async () => {
    const issue = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Invoices show the wrong VAT' });
    const requesterId = newId();
    await w.app.db.insert(requesters).values({ id: requesterId, email: 'carla@customer.example', name: 'Carla Customer' });
    const [row] = await w.app.db.select().from(activities).where(eq(activities.type, 'issue.created')).orderBy(desc(activities.id)).limit(1);
    await w.app.db.insert(helpdeskRequests).values({ issueId: row!.issueId!, projectId: row!.projectId!, requesterId });
    await deliver();
    const before = teams.postsTo(TEAM).length;
    await addComment(w.as(w.anna), issue.id, 'Internal: finance changed the rate in March.');
    await addComment(w.as(w.anna), issue.id, 'We’ve fixed the rate; new invoices are right.', { visibility: 'public' });
    await deliver();
    const posts = teams.postsTo(TEAM).slice(before);
    expect(posts).toHaveLength(1);
    expect(cardText(posts[0]!)).toContain('new invoices are right');
    expect(JSON.stringify(teams.posted)).not.toContain('finance changed the rate');
    expect(JSON.stringify(teams.posted)).not.toContain('carla@customer.example');
  });

  it('takes a project open to its members alone only from someone who manages it', async () => {
    await createProject(w.adminCtx, { key: 'SEC', name: 'Security', template: 'software', visibility: 'members' });
    await addMember(w.adminCtx, 'SEC', { user: 'anna', role: 'member' });
    await addMember(w.adminCtx, 'SEC', { user: 'ben', role: 'manager' });
    const [general] = (await listChatChannels(w.as(w.anna))).filter((c) => c.name === 'General');
    await expect(createChatSubscription(w.as(w.anna), { channel: general!.id, project: 'SEC' })).rejects.toThrow(/open to its members alone/);
    await expect(createChatSubscription(w.as(w.viewer), { channel: general!.id, project: 'SEC' })).rejects.toThrow();
    const sub = await createChatSubscription(w.as(w.ben), { channel: general!.id, project: 'SEC', kinds: ['created'] });
    expect(sub.about).toBe('New issues in Security');
  });
});

describe('Teams: a card’s actions, as whoever acts', () => {
  const invoke = (from: ReturnType<typeof anna>, verb: string, data: Record<string, unknown>) =>
    fromTeams({
      type: 'invoke',
      name: 'adaptiveCard/action',
      from,
      conversation: { id: `${TEAM};messageid=1`, conversationType: 'channel', tenantId: teams.tenantId },
      channelData: channelData(),
      value: { action: { type: 'Action.Execute', verb, data }, trigger: 'manual' },
    });

  it('assigns, moves and comments as them, and answers with the card refreshed for them alone', async () => {
    const issue = await createIssue(w.as(w.ben), { project: 'BACK', summary: 'Retry webhooks on 502' });
    let res = await invoke(anna(), 'assign', { issue: issue.id });
    expect(res.body).toMatchObject({ statusCode: 200, type: 'application/vnd.microsoft.card.adaptive' });
    const card = res.body!.value as { refresh: { userIds: string[] } };
    expect(card.refresh.userIds).toEqual([ANNA_TEAMS]);
    expect(JSON.stringify(card)).toContain('Assigned to you.');
    expect(value(await getIssue(w.adminCtx, issue.id), 'Assignee')).toBe('anna');
    res = await invoke(anna(), 'state', { issue: issue.id, state: 'Fixed' });
    expect(JSON.stringify(res.body)).toContain('Moved to Fixed.');
    expect(value(await getIssue(w.adminCtx, issue.id), 'State')).toBe('Fixed');
    res = await invoke(anna(), 'comment', { issue: issue.id, comment: 'Shipped in 2.0' });
    expect(JSON.stringify(res.body)).toContain('Commented.');
  });

  it('answers someone it doesn’t know, and an issue hidden from them, without a card', async () => {
    const res = await invoke({ id: '29:x', aadObjectId: 'oid-nobody', name: 'Nobody' }, 'assign', { issue: 'BACK-1' });
    expect(res.body).toMatchObject({ type: 'application/vnd.microsoft.activity.message' });
    expect(String(res.body!.value)).toMatch(/don’t know who you are/);
    const hidden = await createIssue(w.as(w.ben), { project: 'BACK', summary: 'Ben only', visibleTo: { users: ['ben'], groups: [] } });
    const refused = await invoke(anna(), 'assign', { issue: hidden.id });
    // Limited away from her, it's missing, in the same words.
    expect(String(refused.body!.value)).toBe(`Issue ${hidden.id} not found`);
  });
});

describe('when posting fails', () => {
  it('waits as long as Teams asks, then posts', async () => {
    await deliver();
    teams.failures.set(TEAM, [{ status: 429, retryAfter: '120' }]);
    await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Slow search on tags' });
    await deliver();
    const [row] = await w.app.db.select().from(chatOutbox).orderBy(desc(chatOutbox.createdAt)).limit(1);
    expect(row).toMatchObject({ status: 'pending', attempts: 1 });
    expect(row!.sendAfter.getTime() - Date.now()).toBeGreaterThan(100_000);
  });

  it('ends a channel’s subscriptions when the channel is gone, and says why', async () => {
    const [releases] = (await listChatChannels(w.as(w.anna))).filter((c) => c.name === 'Releases');
    await createChatSubscription(w.as(w.anna), { channel: releases!.id, project: 'BACK', kinds: ['created'] });
    teams.failures.set(RELEASES, [{ status: 404, body: { error: { code: 'ConversationNotFound', message: 'Conversation not found.' } } }]);
    await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Release notes miss the date' });
    await deliver();
    const subs = (await listChatSubscriptions(w.as(w.anna))).filter((s) => s.channel.id === releases!.id);
    expect(subs[0]!.ended?.reason).toBe('ConversationNotFound');
    expect(subs[0]!.channel.gone).toBe('ConversationNotFound');
  });
});

describe('Slack', () => {
  it('connects with the app’s token, and knows the channels it is in', async () => {
    const res = await http.request('/api/v1/chat/slack', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await adminToken()}` }, body: JSON.stringify({ botToken: slack.botToken, signingSecret: slack.signingSecret }) });
    expect(res.status).toBe(200);
    const status = (await res.json()) as { slack: { connected: boolean; workspace: string }; channels: { name: string; platform: string }[] };
    expect(status.slack).toMatchObject({ connected: true, workspace: 'Acme' });
    expect(status.channels.filter((c) => c.platform === 'slack').map((c) => c.name)).toEqual(['#eng']);
  });

  it('refuses a request it can’t prove came from Slack', async () => {
    const body = slash('help');
    expect((await fromSlack('commands', body, slack.signed(body, { secret: 'not-the-secret-00000000' }))).status).toBe(401);
    expect((await fromSlack('commands', body, slack.signed(body, { at: Math.floor(Date.now() / 1000) - 600 }))).status).toBe(401);
    expect((await fromSlack('commands', body, {})).status).toBe(401);
    const check = JSON.stringify({ type: 'url_verification', challenge: 'c-123' });
    expect((await fromSlack('events', check, slack.signed(check), 'application/json')).body).toEqual({ challenge: 'c-123' });
  });

  it('links someone with a link only they see, then acts as them, answering them alone', async () => {
    let res = await fromSlack('commands', slash('BACK-1'));
    expect(res.body!.response_type).toBe('ephemeral');
    const token = /\/chat\/link\?token=([^\s]+)/.exec(String(res.body!.text))?.[1];
    await acceptChatLink(web(w.anna), decodeURIComponent(token!), async (row, user) => {
      const { slackLinked } = await import('../src/chat/slack');
      await slackLinked(w.app, row.externalUserId, user.name);
    });
    expect(slack.callsOf('chat.postMessage').at(-1)!.body).toMatchObject({ channel: 'U0ANNA' });
    res = await fromSlack('commands', slash('BACK-1 State Fixed'));
    expect(res.body).toMatchObject({ response_type: 'ephemeral' });
    expect(String(res.body!.text)).toMatch(/^Done: /);
    expect(value(await getIssue(w.adminCtx, 'BACK-1'), 'State')).toBe('Fixed');
  });

  it('subscribes a channel in public, posts its news as blocks, and does a button’s action as whoever pressed it', async () => {
    const res = await fromSlack('commands', slash('subscribe BACK new'));
    expect(res.body).toMatchObject({ response_type: 'in_channel', text: 'Anna Schmidt subscribed this channel: New issues in Backend.' });
    const issue = await createIssue(w.as(w.ben), { project: 'BACK', summary: 'Login button is grey' });
    await deliver();
    const post = slack.callsOf('chat.postMessage').find((c) => c.body.channel === 'C0ENG' && String(c.body.text).includes(issue.id))!;
    expect(JSON.stringify(post.body.blocks)).toContain('Login button is grey');
    const payload = { type: 'block_actions', team: { id: slack.teamId }, user: { id: 'U0ANNA', name: 'anna' }, channel: { id: 'C0ENG' }, actions: [{ action_id: 'assign', value: issue.id }] };
    const form = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    expect((await fromSlack('interactions', form)).status).toBe(200);
    await expect.poll(async () => value(await getIssue(w.adminCtx, issue.id), 'Assignee')).toBe('anna');
    await expect.poll(() => slack.callsOf('chat.postEphemeral').length).toBeGreaterThan(0);
    expect(slack.callsOf('chat.postEphemeral').at(-1)!.body).toMatchObject({ channel: 'C0ENG', user: 'U0ANNA' });
  });

  it('unfurls a link to an issue anyone reading the project may see, and nothing limited', async () => {
    const open = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Dark mode flickers' });
    const hidden = await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Pen test findings', visibleTo: { users: ['anna'], groups: [] } });
    const event = (id: string) =>
      JSON.stringify({ type: 'event_callback', team_id: slack.teamId, event: { type: 'link_shared', user: 'U0ANNA', channel: 'C0ENG', message_ts: '1.2', links: [{ url: `${w.app.config.publicUrl}/issues/${id}` }] } });
    await fromSlack('events', event(hidden.id), slack.signed(event(hidden.id)), 'application/json');
    expect(slack.callsOf('chat.unfurl')).toHaveLength(0);
    await fromSlack('events', event(open.id), slack.signed(event(open.id)), 'application/json');
    expect(JSON.stringify(slack.callsOf('chat.unfurl').at(-1)!.body)).toContain('Dark mode flickers');
  });

  it('ends its channels’ subscriptions when the app is removed', async () => {
    const body = JSON.stringify({ type: 'event_callback', team_id: slack.teamId, event: { type: 'app_uninstalled' } });
    expect((await fromSlack('events', body, slack.signed(body), 'application/json')).status).toBe(200);
    const subs = (await listChatSubscriptions(w.adminCtx)).filter((s) => s.channel.platform === 'slack');
    expect(subs.every((s) => s.ended?.reason === 'The app was removed from Slack')).toBe(true);
  });
});

describe('the rest', () => {
  it('gives an administrator the Teams app package, naming the bot', () => {
    const zip = teamsAppPackage(w.app);
    expect(zip.subarray(0, 4).toString('hex')).toBe('504b0304');
    const text = zip.toString('latin1');
    expect(text).toContain('manifest.json');
    expect(text).toContain(`"botId": "${teams.appId}"`);
    expect(text).toContain('color.png');
  });

  it('lets an agent list channels and subscribe one over MCP, but not link anyone', async () => {
    const list = await toolByName('list_chat_channels')!.run(w.as(w.anna), {});
    expect((list.data as { name: string }[]).map((c) => c.name)).toContain('General');
    expect(toolByName('link_chat_account')).toBeUndefined();
    const subs = await toolByName('list_chat_subscriptions')!.run(w.as(w.anna), { project: 'BACK' });
    expect((subs.data as unknown[]).length).toBeGreaterThan(0);
  });

  it('keeps a subscription’s rows apart from who can’t see them', async () => {
    const all = await w.app.db.select().from(chatSubscriptions);
    const seen = await listChatSubscriptions(w.as(w.viewer));
    expect(seen.length).toBeLessThan(all.length);
    expect(seen.some((s) => s.project?.key === 'SEC')).toBe(false);
  });
});

async function eventOf(issueId: string, type: string) {
  const [row] = await w.app.db
    .select()
    .from(activities)
    .where(and(eq(activities.type, type), eq(activities.issueId, await internalId(issueId))))
    .orderBy(desc(activities.id))
    .limit(1);
  return row!;
}

async function internalId(readable: string): Promise<string> {
  const { findIssue } = await import('../src/services/issues');
  return (await findIssue(w.app.db, await w.app.schema.get(), readable))!.id;
}

async function lastEvent() {
  const { toEventDto } = await import('../src/events/activity');
  const [row] = await w.app.db.select().from(activities).where(eq(activities.type, 'comment.created')).orderBy(desc(activities.id)).limit(1);
  return toEventDto(await w.app.schema.get(), row!);
}

let adminTokenValue: string | null = null;
async function adminToken(): Promise<string> {
  if (adminTokenValue) return adminTokenValue;
  const { issueTokenFor } = await import('../src/services/auth');
  const created = await issueTokenFor(w.app.db, w.admin.id, { name: 'chat test', scopes: ['read', 'write', 'admin'] });
  adminTokenValue = created.token;
  return adminTokenValue;
}
