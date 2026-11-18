/**
 * Issues made from Teams and Slack messages (docs/architecture.md, D60): requests checked before
 * they're read and taken once, people acting as themselves, the projects they may create in and no
 * other, the message converted with nothing in it that runs, the thread's replies up to a cap, the
 * thread told only where D42's line allows, the source shown as the issue is, and a limit per person.
 */
import { findMentions } from '@a4a/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teamsManifest } from '../src/chat/package';
import { mrkdwnToMarkdown, teamsHtmlToMarkdown } from '../src/chat/markdown';
import type { UserRow } from '../src/context';
import { activities, chatAccounts, chatIssueSources, issues, issueWatchers, userIdentities, users } from '../src/db/schema';
import { createHttpApp } from '../src/http/app';
import { newId } from '../src/lib/ids';
import { connectSlack } from '../src/chat/slack';
import { getIssue, setIssueVisibility } from '../src/services/issues';
import { addMember } from '../src/services/members';
import { createProject } from '../src/services/projects';
import { toolByName } from '../src/tools/registry';
import { FakeSlack, FakeTeams } from './fake-chat';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let http: ReturnType<typeof createHttpApp>;
let teams: FakeTeams;
let slack: FakeSlack;

const TEAM = '19:team-issues@thread.tacv2';
const ANNA_TEAMS = '29:anna-teams-id';

type Block = { type: string; block_id?: string; element?: Record<string, unknown>; elements?: { text?: string }[]; text?: { text?: string }; hint?: { text?: string } };
type View = { private_metadata?: string; blocks: Block[]; title?: { text?: string } };

async function fromSlack(path: string, body: string, headers: Record<string, string> = slack.signed(body)) {
  const res = await http.request(`/api/v1/chat/slack/${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

const form = (payload: unknown) => new URLSearchParams({ payload: JSON.stringify(payload) }).toString();

/** Slack's message shortcut, on a message, by someone, in a channel. */
const shortcut = (message: Record<string, unknown>, opts: { user?: string; channel?: string; channelName?: string } = {}) => ({
  type: 'message_action',
  callback_id: 'a4a_create_issue',
  trigger_id: `trigger-${newId(8)}`,
  team: { id: slack.teamId, domain: 'acme' },
  user: { id: opts.user ?? 'U0ANNA', name: 'anna' },
  channel: { id: opts.channel ?? 'C0ENG', name: opts.channelName ?? 'eng' },
  message: { type: 'message', ...message },
  message_ts: message.ts,
});

/** Send the shortcut, and the modal Slack was asked to open. */
async function openModal(payload: Record<string, unknown>): Promise<View> {
  const before = slack.callsOf('views.open').length;
  const res = await fromSlack('interactions', form(payload));
  expect(res.status).toBe(200);
  await expect.poll(() => slack.callsOf('views.open').length).toBe(before + 1);
  return slack.callsOf('views.open').at(-1)!.body.view as View;
}

const block = (view: View, id: string) => view.blocks.find((b) => b.block_id === id);
const viewText = (view: View) => JSON.stringify(view);

/** The modal sent, as Slack sends it: its draft, and what the person chose and wrote. */
function submission(view: View, values: { project?: string; summary?: string; description?: string; replies?: boolean }, user = 'U0ANNA') {
  return {
    type: 'view_submission',
    team: { id: slack.teamId },
    user: { id: user, name: user.toLowerCase() },
    view: {
      id: `V${newId(6)}`,
      hash: newId(8),
      callback_id: 'a4a_create_issue',
      private_metadata: view.private_metadata,
      state: {
        values: {
          project: { value: { type: 'static_select', selected_option: values.project ? { value: values.project } : null } },
          summary: { value: { type: 'plain_text_input', value: values.summary ?? null } },
          description: { value: { type: 'plain_text_input', value: values.description ?? null } },
          ...(values.replies === undefined ? {} : { replies: { value: { type: 'checkboxes', selected_options: values.replies ? [{ value: 'yes' }] : [] } } }),
        },
      },
    },
  };
}

async function submit(view: View, values: Parameters<typeof submission>[1], user?: string) {
  const res = await fromSlack('interactions', form(submission(view, values, user)));
  expect(res.status).toBe(200);
  return res.body ?? {};
}

/** The issue a form made, as whoever reads it. */
async function madeFrom(view: View, as: UserRow = w.anna) {
  const [row] = await w.app.db.select().from(chatIssueSources).where(eq(chatIssueSources.id, view.private_metadata!));
  expect(row?.issueId).toBeTruthy();
  return getIssue(w.as(as), row!.issueId!);
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

const anna = () => ({ id: ANNA_TEAMS, aadObjectId: 'oid-anna', name: 'Anna Schmidt' });

/** A message in the team's General channel, as a message action sends it. */
function teamsMessage(over: Record<string, unknown> = {}) {
  const id = String(Date.now() + Math.floor(Math.random() * 1000));
  return {
    id,
    createdDateTime: '2026-11-17T09:30:00.000Z',
    linkToMessage: `https://teams.microsoft.com/l/message/${encodeURIComponent(TEAM)}/${id}?tenantId=${teams.tenantId}`,
    from: { user: { id: 'oid-ben', displayName: 'Ben Okafor', userIdentityType: 'aadUser' } },
    body: { contentType: 'html', content: '<p>The <b>export</b> stalls for <at id="0">Anna Schmidt</at><script>alert(1)</script></p><p><a href="javascript:alert(1)">click</a> <a href="https://example.com/log">the log</a></p>' },
    attachments: [
      { id: 'a1', contentType: 'reference', name: 'spec.docx', contentUrl: 'https://acme.sharepoint.com/sites/eng/Shared%20Documents/spec.docx' },
      { id: 'a2', contentType: 'reference', name: 'evil.html', contentUrl: 'javascript:alert(1)' },
    ],
    ...over,
  };
}

function messageAction(name: string, from: ReturnType<typeof anna>, value: Record<string, unknown>) {
  return fromTeams({
    type: 'invoke',
    name,
    id: `act-${newId(8)}`,
    from,
    recipient: { id: `28:${teams.appId}` },
    conversation: { id: `${TEAM};messageid=1`, conversationType: 'channel', tenantId: teams.tenantId },
    channelData: { tenant: { id: teams.tenantId }, team: { id: TEAM, name: 'Engineering' }, channel: { id: TEAM } },
    value: { commandId: 'createIssue', commandContext: 'message', ...value },
  });
}

const task = (body: Record<string, unknown> | null) => body!.task as { type: string; value: unknown };
const cardOf = (body: Record<string, unknown> | null) => (task(body).value as { card: { content: unknown } }).card.content;

beforeAll(async () => {
  teams = await new FakeTeams().start();
  slack = await new FakeSlack().start();
  teams.channels = [{ id: TEAM }];
  w = await createWorld({
    config: {
      teams: { appId: teams.appId, appPassword: teams.appPassword, tenantId: teams.tenantId, openIdMetadataUrl: `${teams.url}/openid`, tokenUrl: `${teams.url}/token`, serviceHosts: [] },
      slackApiUrl: slack.apiUrl,
      chatAllowHttpLoopback: true,
      chatIssueLimit: 20,
    },
  });
  http = createHttpApp(w.app);
  await connectSlack(w.adminCtx, { botToken: slack.botToken, signingSecret: slack.signingSecret });
  slack.people = { U0BEN: 'Ben Okafor', U0ANNA: 'Anna Schmidt', U0CARL: 'Carl Outside' };
  // Anna and Ben are linked in Slack; Anna is known in Teams by her Entra sign-in, Ben by a link.
  const link = (platform: string, workspace: string, external: string, user: UserRow) =>
    w.app.db.insert(chatAccounts).values({ id: newId(), platform, workspaceExternalId: workspace, workspaceName: 'Acme', externalUserId: external, userId: user.id, name: user.name });
  await link('slack', slack.teamId, 'U0ANNA', w.anna);
  await link('slack', slack.teamId, 'U0BEN', w.ben);
  await link('slack', slack.teamId, 'U0ADMIN', w.admin);
  await link('teams', teams.tenantId, 'oid-ben', w.ben);
  await w.app.db.insert(userIdentities).values({ id: newId(), provider: 'https://login.microsoftonline.com/x/v2.0', subject: 'sub-anna', userId: w.anna.id, objectId: 'oid-anna', tenantId: teams.tenantId });
  // Security is for its members: Anna is one, Ben manages it. Docs Anna only reads; Hidden she isn't in.
  await createProject(w.adminCtx, { key: 'SEC', name: 'Security', template: 'software', visibility: 'members' });
  await addMember(w.adminCtx, 'SEC', { user: 'anna', role: 'member' });
  await addMember(w.adminCtx, 'SEC', { user: 'ben', role: 'manager' });
  await createProject(w.adminCtx, { key: 'DOCS', name: 'Documentation', template: 'software', visibility: 'members' });
  await addMember(w.adminCtx, 'DOCS', { user: 'anna', role: 'viewer' });
  await createProject(w.adminCtx, { key: 'HID', name: 'Hidden', template: 'software', visibility: 'members' });
  // The bot is added to a team in Teams.
  await fromTeams({
    type: 'conversationUpdate',
    recipient: { id: `28:${teams.appId}` },
    membersAdded: [{ id: `28:${teams.appId}` }],
    conversation: { id: TEAM, conversationType: 'channel', tenantId: teams.tenantId },
    channelData: { eventType: 'teamMemberAdded', tenant: { id: teams.tenantId }, team: { id: TEAM, name: 'Engineering' } },
  });
});

afterAll(async () => {
  await w?.close();
  await teams?.stop();
  await slack?.stop();
});

describe('the message, as Markdown', () => {
  it('converts Slack’s mrkdwn, names people without mentioning them, and keeps nothing that runs', () => {
    const md = mrkdwnToMarkdown(
      '*Exports* stall for <@U0ANNA> on _big_ projects ~again~: <https://example.com/a?b=1&amp;c=2|the log>, <javascript:alert(1)|click> &lt;script&gt;alert(1)&lt;/script&gt; [x](javascript:alert(1)) `a*b` <!here> <#C1|eng>\n&gt; quoted\n- not a list\n```if (a &lt; b) {}```',
      new Map([['U0ANNA', 'anna']]),
    );
    expect(md).toContain('**Exports** stall for @⁠anna on _big_ projects ~~again~~');
    expect(md).toContain('[the log](https://example.com/a?b=1&c=2)');
    expect(md).toContain('\\<script\\>alert(1)\\</script\\>');
    expect(md).toContain('\\[x\\](javascript:alert(1))');
    expect(md).toContain('`a*b`');
    expect(md).toContain('> quoted\n\\- not a list');
    expect(md).toContain('```\nif (a < b) {}\n```');
    // Typed Markdown stays text: no link to it is left unescaped.
    expect(md).not.toMatch(/(^|[^\\])\]\(javascript:/);
    // A Slack name isn't an a4a login: nobody in a4a is mentioned, however the names fall.
    expect(findMentions(md, (l) => l)).toEqual([]);
  });

  it('converts Teams’ HTML, and leaves out scripts, frames, handlers and links that run', () => {
    const md = teamsHtmlToMarkdown(
      '<div>Hi <at id="0">anna</at>, the <b>export</b> fails <i>again</i><br>line two<script>alert(1)</script><iframe src="https://evil.example"></iframe><img src="x" onerror="alert(1)" alt="screenshot"></div><p><a href="javascript:alert(1)">click</a> <a href="https://example.com/x(1)">the log</a> &lt;b&gt;not bold&lt;/b&gt; *stars*</p><ul><li>one</li><li>two</li></ul><pre>code &lt;here&gt;</pre><blockquote>quoted</blockquote>',
    );
    expect(md).toContain('Hi @⁠anna, the **export** fails _again_\\\nline two');
    expect(md).not.toMatch(/alert|iframe|evil|onerror/);
    expect(md).toContain('screenshot');
    expect(md).toContain('click [the log](https://example.com/x%281%29)');
    expect(md).toContain('\\<b\\>not bold\\</b\\> \\*stars\\*');
    expect(md).toContain('- one\n- two');
    expect(md).toContain('```\ncode <here>\n```');
    expect(md).toContain('> quoted');
    expect(findMentions(md, (l) => l)).toEqual([]);
  });
});

describe('Slack: a message shortcut makes an issue', () => {
  let made: Awaited<ReturnType<typeof madeFrom>>;

  it('refuses what it can’t prove came from Slack, and a signed request sent again', async () => {
    const body = form(shortcut({ ts: '1700000000.000001', user: 'U0BEN', text: 'Hello' }));
    expect((await fromSlack('interactions', body, {})).status).toBe(401);
    expect((await fromSlack('interactions', body, slack.signed(body, { secret: 'not-the-secret-000000000000' }))).status).toBe(401);
    expect(slack.callsOf('views.open')).toHaveLength(0);
    const signed = slack.signed(body);
    expect((await fromSlack('interactions', body, signed)).status).toBe(200);
    // The same request again, within its five minutes: a replay, refused before it's read.
    expect((await fromSlack('interactions', body, signed)).status).toBe(401);
    await expect.poll(() => slack.callsOf('views.open').length).toBe(1);
  });

  it('tells someone it doesn’t know how to link, and nothing else', async () => {
    const view = await openModal(shortcut({ ts: '1700000000.000002', user: 'U0BEN', text: 'Secret plans' }, { user: 'U0CARL' }));
    expect(viewText(view)).toMatch(/\/chat\/link\?token=/);
    expect(view.blocks.some((b) => b.type === 'input')).toBe(false);
    expect(viewText(view)).not.toContain('Secret plans');
    expect(view.private_metadata).toBeUndefined();
  });

  it('offers only the projects they may create in, with the message as Markdown, and makes the issue as them', async () => {
    const ts = '1700000000.000100';
    const text = '*Exports* time out for <@U0ANNA> on big projects\nSee <https://example.com/log|the log> and <javascript:alert(1)|this> &lt;script&gt;alert(1)&lt;/script&gt;';
    slack.threads.set(`C0ENG:${ts}`, [{ ts, user: 'U0BEN', text }]);
    const view = await openModal(
      shortcut({
        ts,
        user: 'U0BEN',
        text,
        files: [
          { name: 'trace.log', title: 'trace.log', permalink: 'https://acme.slack.com/files/U0BEN/F1/trace.log' },
          { name: 'evil.html', permalink: 'javascript:alert(1)' },
        ],
      }),
    );
    const options = (block(view, 'project')!.element!.options as { value: string }[]).map((o) => o.value);
    // Backend, Security and Web app: not Documentation, which she only reads, nor Hidden, which she can't see.
    expect(options).toEqual(['BACK', 'SEC', 'WEB']);
    expect(block(view, 'summary')!.element!.initial_value).toBe('Exports time out for @Anna Schmidt on big projects');
    const description = String(block(view, 'description')!.element!.initial_value);
    expect(description).toContain('**Exports** time out for @⁠Anna Schmidt');
    expect(description).toContain('[the log](https://example.com/log)');
    expect(description).not.toContain('javascript');
    expect(description).toContain('\\<script\\>');
    expect(viewText(view)).toContain('From Ben Okafor’s message in #eng.');
    expect(viewText(view)).toContain('The message’s 2 files are linked from the issue, not copied.');
    // A message with no thread offers no replies.
    expect(block(view, 'replies')).toBeUndefined();

    expect(await submit(view, { project: 'BACK', summary: 'Exports time out on big projects', description })).toEqual({ response_action: 'clear' });
    made = await madeFrom(view);
    expect(made).toMatchObject({ summary: 'Exports time out on big projects', description, reporter: { login: 'anna' } });
    expect(made.source).toEqual({
      platform: 'slack',
      workspace: 'Acme',
      channel: '#eng',
      url: 'https://acme.slack.com/archives/C0ENG/p1700000000000100',
      author: 'Ben Okafor',
      sentAt: new Date(1_700_000_000_000).toISOString(),
      replies: 0,
      files: [
        { name: 'trace.log', url: 'https://acme.slack.com/files/U0BEN/F1/trace.log' },
        { name: 'evil.html', url: null },
      ],
      moreFiles: 0,
      cut: false,
    });
    // As her, "via Slack", and its event says where it came from, with no more of the message than the issue holds.
    const [created] = await w.app.db.select().from(activities).where(and(eq(activities.type, 'issue.created'), eq(activities.issueId, made.uid)));
    expect(created).toMatchObject({ channel: 'chat', actorId: w.anna.id, tokenName: 'Slack' });
    expect((created!.payload as { data: { chat: unknown } }).data.chat).toEqual({ platform: 'slack', workspace: 'Acme', channel: '#eng', url: made.source!.url, author: 'Ben Okafor', sentAt: made.source!.sentAt });
    // The message is Ben's, and he's linked and sees it: he watches it.
    const watchers = await w.app.db.select().from(issueWatchers).where(eq(issueWatchers.issueId, made.uid));
    expect(watchers.map((x) => [x.userId, x.reason]).sort()).toEqual(
      [
        [w.anna.id, 'reporter'],
        [w.ben.id, 'message'],
      ].sort(),
    );
    // She's told, where only she sees it; the thread, in a project anyone who reads it may hear of, too.
    await expect.poll(() => slack.callsOf('chat.postEphemeral').filter((c) => String(c.body.text) === `Created ${made.id} from the message.`).length).toBe(1);
    expect(slack.callsOf('chat.postEphemeral').at(-1)!.body).toMatchObject({ channel: 'C0ENG', user: 'U0ANNA' });
    await expect.poll(() => slack.callsOf('chat.postMessage').filter((c) => c.body.thread_ts === ts).length).toBe(1);
    const thread = slack.callsOf('chat.postMessage').find((c) => c.body.thread_ts === ts)!;
    expect(thread.body.channel).toBe('C0ENG');
    expect(JSON.stringify(thread.body.blocks)).toContain('*Anna Schmidt* made an issue of this message');
    expect(JSON.stringify(thread.body.blocks)).toContain(made.id);
  });

  it('takes a form once, however often it is sent, at once or after', async () => {
    const ts = '1700000000.000200';
    slack.threads.set(`C0ENG:${ts}`, [{ ts, user: 'U0BEN', text: 'Twice' }]);
    const view = await openModal(shortcut({ ts, user: 'U0BEN', text: 'Twice' }));
    const values = { project: 'WEB', summary: 'Twice', description: 'Twice' };
    const both = await Promise.all([submit(view, values), submit(view, values)]);
    expect(both).toEqual([{ response_action: 'clear' }, { response_action: 'clear' }]);
    expect(await submit(view, values)).toEqual({ response_action: 'clear' });
    const rows = await w.app.db.select().from(chatIssueSources).where(eq(chatIssueSources.id, view.private_metadata!));
    expect(rows).toHaveLength(1);
    const issue = await madeFrom(view);
    expect(await w.app.db.select({ id: issues.id }).from(issues).where(eq(issues.summary, 'Twice'))).toHaveLength(1);
    await expect.poll(() => slack.callsOf('chat.postEphemeral').filter((c) => String(c.body.text) === `${issue.id} was created from this message already.`).length).toBe(2);
  });

  it('brings the replies after the message, the first twenty, quoted under their authors', async () => {
    const ts = '1700000001.000100';
    const replies = Array.from({ length: 25 }, (_, i) => ({ ts: `1700000001.${String(200 + i).padStart(6, '0')}`, user: i % 2 ? 'U0ANNA' : 'U0BEN', text: `Reply number ${i + 1}`, thread_ts: ts }));
    slack.threads.set(`C0ENG:${ts}`, [{ ts, user: 'U0BEN', text: 'Login fails after the upgrade' }, ...replies]);
    const view = await openModal(shortcut({ ts, user: 'U0BEN', text: 'Login fails after the upgrade', reply_count: 25 }));
    expect(viewText(view)).toContain('Add the replies after it, the first 20');
    expect(await submit(view, { project: 'BACK', summary: 'Login fails after the upgrade', description: 'Login fails after the upgrade', replies: true })).toEqual({ response_action: 'clear' });
    const issue = await madeFrom(view);
    expect(issue.description).toContain('Login fails after the upgrade\n\n---\n\n**Ben Okafor**\n\n> Reply number 1');
    expect(issue.description).toContain('**Anna Schmidt**\n\n> Reply number 2');
    expect(issue.description).toContain('> Reply number 20');
    expect(issue.description).not.toContain('Reply number 21');
    expect(issue.source).toMatchObject({ replies: 20 });
  });

  it('refuses a project they may not create in, or can’t see, as missing, under the project', async () => {
    const ts = '1700000002.000100';
    slack.threads.set(`C0ENG:${ts}`, [{ ts, user: 'U0BEN', text: 'Forged' }]);
    const view = await openModal(shortcut({ ts, user: 'U0BEN', text: 'Forged' }));
    for (const project of ['HID', 'DOCS', 'NOPE']) {
      expect(await submit(view, { project, summary: 'Forged', description: '' })).toEqual({
        response_action: 'errors',
        errors: { project: `Project ${project} not found. Projects you can file in: BACK, SEC, WEB.` },
      });
    }
    expect(await submit(view, { project: 'BACK', summary: '   ', description: '' })).toEqual({ response_action: 'errors', errors: { summary: 'Give it a summary.' } });
    const [row] = await w.app.db.select().from(chatIssueSources).where(eq(chatIssueSources.id, view.private_metadata!));
    expect(row!.issueId).toBeNull();
    // Someone else can't send her form.
    expect(await submit(view, { project: 'BACK', summary: 'Mine now', description: '' }, 'U0BEN')).toEqual({
      response_action: 'errors',
      errors: { project: 'This form has expired, or isn’t yours: start again from the message.' },
    });
  });

  it('posts no link in the thread where the channel may not be told of the project', async () => {
    const ts = '1700000003.000100';
    slack.threads.set(`C0ENG:${ts}`, [{ ts, user: 'U0BEN', text: 'Rotate the keys' }]);
    const view = await openModal(shortcut({ ts, user: 'U0BEN', text: 'Rotate the keys' }));
    // Security is for its members, and Anna doesn't manage it: she can't vouch for the channel's people.
    expect(await submit(view, { project: 'SEC', summary: 'Rotate the keys', description: 'Rotate the keys' })).toEqual({ response_action: 'clear' });
    const issue = await madeFrom(view);
    await expect.poll(() => slack.callsOf('chat.postEphemeral').filter((c) => String(c.body.text) === `Created ${issue.id} from the message.`).length).toBe(1);
    // Ben, who manages it, may: his issue's thread hears of it.
    const ts2 = '1700000003.000200';
    slack.threads.set(`C0ENG:${ts2}`, [{ ts: ts2, user: 'U0ANNA', text: 'Rotate the other keys' }]);
    const his = await openModal(shortcut({ ts: ts2, user: 'U0ANNA', text: 'Rotate the other keys' }, { user: 'U0BEN' }));
    expect(await submit(his, { project: 'SEC', summary: 'Rotate the other keys', description: '' }, 'U0BEN')).toEqual({ response_action: 'clear' });
    await expect.poll(() => slack.callsOf('chat.postMessage').filter((c) => c.body.thread_ts === ts2).length).toBe(1);
    expect(slack.callsOf('chat.postMessage').filter((c) => c.body.thread_ts === ts)).toHaveLength(0);
  });

  it('refuses a deleted message, a channel it isn’t in, and a direct message, in the person’s language', async () => {
    let view = await openModal(shortcut({ ts: '1700000004.000100', subtype: 'tombstone', text: 'This message was deleted.' }));
    expect(viewText(view)).toContain('That message was deleted.');
    slack.members = new Set(['C0ENG']);
    try {
      view = await openModal(shortcut({ ts: '1700000004.000200', user: 'U0BEN', text: 'Elsewhere' }, { channel: 'C0SUPPORT', channelName: 'support' }));
      expect(viewText(view)).toContain('I’m not in #support: invite me with /invite @a4a, then try again.');
    } finally {
      slack.members = null;
    }
    view = await openModal(shortcut({ ts: '1700000004.000300', user: 'U0BEN', text: 'Just us' }, { channel: 'D0DIRECT' }));
    expect(viewText(view)).toContain('I make issues only from messages in channels I’m in.');
    // Deleted between the form opening and its sending.
    const ts = '1700000004.000400';
    await w.app.db.update(users).set({ locale: 'de' }).where(eq(users.id, w.anna.id));
    try {
      view = await openModal(shortcut({ ts, user: 'U0BEN', text: 'Gone soon' }));
      expect(viewText(view)).toContain('Aus der Nachricht von Ben Okafor in #eng.');
      expect(await submit(view, { project: 'BACK', summary: 'Gone soon', description: '' })).toEqual({ response_action: 'errors', errors: { project: 'Diese Nachricht wurde gelöscht.' } });
    } finally {
      await w.app.db.update(users).set({ locale: null }).where(eq(users.id, w.anna.id));
    }
  });

  it('stops someone making issues too fast, counted across chats, and lets them go on later', async () => {
    const limit = w.app.config.chatIssueLimit;
    const at = new Date();
    const rows = Array.from({ length: limit }, () => ({
      id: newId(),
      platform: 'teams',
      workspaceName: 'Engineering',
      channelName: 'General',
      messageRef: newId(),
      threadRef: newId(),
      authorName: 'Someone',
      createdById: w.admin.id,
      createdByExternalId: 'oid-admin',
      expiresAt: at,
      madeAt: at,
    }));
    await w.app.db.insert(chatIssueSources).values(rows);
    await w.app.db.update(users).set({ locale: 'de' }).where(eq(users.id, w.admin.id));
    try {
      const ts = '1700000005.000100';
      slack.threads.set(`C0ENG:${ts}`, [{ ts, user: 'U0BEN', text: 'One more' }]);
      const refused = await openModal(shortcut({ ts, user: 'U0BEN', text: 'One more' }, { user: 'U0ADMIN' }));
      expect(viewText(refused)).toContain(`Sie haben in den letzten zehn Minuten ${limit} Vorgänge aus dem Chat angelegt`);
      // Ten minutes on, they may again.
      await w.app.db.update(chatIssueSources).set({ madeAt: new Date(Date.now() - 11 * 60_000) }).where(eq(chatIssueSources.createdById, w.admin.id));
      const view = await openModal(shortcut({ ts, user: 'U0BEN', text: 'One more' }, { user: 'U0ADMIN' }));
      expect(block(view, 'project')).toBeDefined();
      // Over the limit between the form's opening and its sending: refused when it's sent.
      await w.app.db.update(chatIssueSources).set({ madeAt: new Date() }).where(and(eq(chatIssueSources.createdById, w.admin.id), eq(chatIssueSources.platform, 'teams')));
      const sent = await submit(view, { project: 'BACK', summary: 'One more', description: '' }, 'U0ADMIN');
      expect(String((sent.errors as { project: string }).project)).toMatch(/^Sie haben in den letzten zehn Minuten/);
    } finally {
      await w.app.db.update(users).set({ locale: null }).where(eq(users.id, w.admin.id));
    }
  });

  it('shows where it came from to whoever sees the issue, over REST and MCP, and to nobody else', async () => {
    const { issueTokenFor } = await import('../src/services/auth');
    const token = (await issueTokenFor(w.app.db, w.viewer.id, { name: 'reads', scopes: ['read'] })).token;
    const res = await http.request(`/api/v1/issues/${made.id}`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { source: { channel: string } }).source.channel).toBe('#eng');
    const tool = await toolByName('get_issue')!.run(w.as(w.viewer), { issue: made.id, comments: 0 });
    expect((tool.data as { source: unknown }).source).toMatchObject({ chat: 'slack', channel: '#eng', author: 'Ben Okafor', url: made.source!.url });
    // Limited to Anna, it's missing to Vera, its source with it: the same 404 as for no issue at all.
    await setIssueVisibility(w.as(w.anna), made.id, { visibleTo: { users: ['anna'], groups: [] } });
    const hidden = await http.request(`/api/v1/issues/${made.id}`, { headers: { authorization: `Bearer ${token}` } });
    const none = await http.request('/api/v1/issues/BACK-9999', { headers: { authorization: `Bearer ${token}` } });
    expect(hidden.status).toBe(404);
    expect(((await hidden.json()) as { error: { message: string } }).error.message).toBe(`Issue ${made.id} not found`);
    expect(none.status).toBe(404);
    await expect(toolByName('get_issue')!.run(w.as(w.viewer), { issue: made.id, comments: 0 })).rejects.toThrow(/not found/);
    expect((await getIssue(w.as(w.anna), made.id)).source).not.toBeNull();
  });
});

describe('Teams: a message action makes an issue', () => {
  it('refuses a forged token, and an activity sent again', async () => {
    const message = teamsMessage();
    const activity = {
      type: 'invoke',
      name: 'composeExtension/fetchTask',
      id: `act-${newId(8)}`,
      from: anna(),
      conversation: { id: `${TEAM};messageid=1`, conversationType: 'channel', tenantId: teams.tenantId },
      channelData: { tenant: { id: teams.tenantId }, team: { id: TEAM, name: 'Engineering' }, channel: { id: TEAM } },
      value: { commandId: 'createIssue', commandContext: 'message', messagePayload: message },
    };
    expect((await fromTeams(activity, teams.token({}, { key: teams.forgerKey }))).status).toBe(401);
    expect((await fromTeams(activity)).status).toBe(200);
    expect((await fromTeams(activity)).status).toBe(401);
  });

  it('opens Ocean’s form in the person’s language, and makes the issue as them, answered in the dialog', async () => {
    const message = teamsMessage();
    const opened = await messageAction('composeExtension/fetchTask', anna(), { messagePayload: message });
    expect(task(opened.body)).toMatchObject({ type: 'continue', value: { title: 'Create an issue' } });
    const card = JSON.stringify(cardOf(opened.body));
    expect(card).toContain('From Ben Okafor’s message in General.');
    for (const p of ['"value":"BACK"', '"value":"SEC"', '"value":"WEB"']) expect(card).toContain(p);
    expect(card).not.toContain('"value":"DOCS"');
    expect(card).not.toContain('"value":"HID"');
    expect(card).toContain('"value":"The export stalls for @Anna Schmidt"');
    expect(card).not.toMatch(/alert|javascript/);
    expect(card).toContain('The message’s 2 files are linked from the issue, not copied.');
    const draft = (JSON.parse(card) as { actions: { data: { draft: string } }[] }).actions[0]!.data.draft;
    const description = String((JSON.parse(card) as { body: { id?: string; value?: string }[] }).body.find((b) => b.id === 'description')!.value);

    // A project she may not create in comes back as the form, saying so.
    const refused = await messageAction('composeExtension/submitAction', anna(), { data: { draft, project: 'HID', summary: 'Export stalls', description }, messagePayload: message });
    expect(JSON.stringify(cardOf(refused.body))).toContain('Project HID not found. Projects you can file in: BACK, SEC, WEB.');

    const sent = await messageAction('composeExtension/submitAction', anna(), { data: { draft, project: 'BACK', summary: 'Export stalls', description }, messagePayload: message });
    const done = JSON.stringify(cardOf(sent.body));
    const [row] = await w.app.db.select().from(chatIssueSources).where(eq(chatIssueSources.id, draft));
    const issue = await getIssue(w.as(w.anna), row!.issueId!);
    expect(done).toContain(`Created ${issue.id} from the message.`);
    // In a dialog there's nothing to act on: no Universal Actions, only the link to a4a.
    expect(done).not.toContain('Action.Execute');
    expect(issue.source).toMatchObject({ platform: 'teams', workspace: 'Engineering', channel: 'General', url: message.linkToMessage, author: 'Ben Okafor', sentAt: '2026-11-17T09:30:00.000Z' });
    expect(issue.source!.files).toEqual([
      { name: 'spec.docx', url: 'https://acme.sharepoint.com/sites/eng/Shared%20Documents/spec.docx' },
      { name: 'evil.html', url: null },
    ]);
    expect(issue.description).toContain('The **export** stalls for @⁠Anna Schmidt');
    expect(issue.description).not.toMatch(/alert|javascript/);
    // The thread, in Backend, which anyone who reads it may hear of: a reply to the message.
    await expect.poll(() => teams.postsTo(`${TEAM};messageid=${message.id}`).length).toBe(1);
    expect(JSON.stringify(teams.postsTo(`${TEAM};messageid=${message.id}`)[0])).toContain('made an issue of this message');
    // Sent again: the same issue, said so.
    const again = await messageAction('composeExtension/submitAction', anna(), { data: { draft, project: 'BACK', summary: 'Export stalls', description }, messagePayload: message });
    expect(JSON.stringify(cardOf(again.body))).toContain(`${issue.id} was created from this message already.`);

    // In German, for a German profile.
    await w.app.db.update(users).set({ locale: 'de' }).where(eq(users.id, w.anna.id));
    try {
      const german = JSON.stringify(cardOf((await messageAction('composeExtension/fetchTask', anna(), { messagePayload: teamsMessage() })).body));
      for (const word of ['"label":"Projekt"', '"label":"Zusammenfassung"', '"title":"Anlegen"', 'Aus der Nachricht von Ben Okafor in General.']) expect(german).toContain(word);
    } finally {
      await w.app.db.update(users).set({ locale: null }).where(eq(users.id, w.anna.id));
    }
  });

  it('sends someone it doesn’t know a link in their personal chat, and refuses a deleted message', async () => {
    const someone = { id: '29:someone', aadObjectId: 'oid-someone', name: 'Someone New' };
    const res = await messageAction('composeExtension/fetchTask', someone, { messagePayload: teamsMessage() });
    expect(task(res.body)).toEqual({ type: 'message', value: 'I’ve answered you in our personal chat.' });
    expect(String(teams.postsTo('a:personal-29:someone').at(-1)!.text)).toMatch(/\/chat\/link\?token=/);
    const deleted = await messageAction('composeExtension/fetchTask', anna(), { messagePayload: teamsMessage({ deleted: true }) });
    expect(task(deleted.body)).toEqual({ type: 'message', value: 'That message was deleted.' });
  });

  it('adds the message action to the app’s manifest', () => {
    const manifest = teamsManifest(w.app) as { composeExtensions: { botId: string; commands: Record<string, unknown>[] }[] };
    expect(manifest.composeExtensions[0]).toMatchObject({ botId: teams.appId, commands: [{ id: 'createIssue', type: 'action', context: ['message'], fetchTask: true, title: 'Create an a4a issue' }] });
  });
});
