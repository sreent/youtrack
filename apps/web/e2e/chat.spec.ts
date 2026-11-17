/**
 * Chat with Teams (docs/architecture.md, D42).
 *
 * Added to a team, a4a's bot knows its channels; one is told of a project's issues from the project's
 * page, and the change cards reach it. Someone the bot doesn't know is sent a link in their personal
 * chat alone; opened in a4a, it links their Teams account to theirs, which their profile lists and
 * unlinks. Bot Framework here is the spec's own (support/teams.ts), whose key signs what it sends.
 */
import { randomUUID } from 'node:crypto';
import { unique, uniqueKey } from './support/api';
import { AUTH_FILE, BASE_URL, SECOND_AUTH_FILE, TEAMS } from './support/env';
import { expect, test } from './support/fixtures';
import { startTeams } from './support/teams';

// The second of the flows' administrators (support/env.ts says why).
test.use({ storageState: SECOND_AUTH_FILE });

let teams: Awaited<ReturnType<typeof startTeams>>;

test.beforeAll(async () => {
  teams = await startTeams();
});

test.afterAll(async () => {
  await teams?.close();
});

test('a channel is told of a project’s issues, and someone is linked by a link only they see', async ({ page, api, playwright, browser }) => {
  const key = uniqueKey('CH');
  const project = await api.createProject({ key, name: `Chat ${key}` });
  const team = `19:team-${unique()}@thread.tacv2`;
  const releases = `19:releases-${unique()}@thread.tacv2`;
  const teamName = `Eng ${unique()}`;
  teams.setChannels([{ id: team }, { id: releases, name: 'Releases' }]);

  // Bot Framework sends without a cookie, as nobody.
  const bot = await playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
  const send = (activity: Record<string, unknown>, token = teams.token()) =>
    bot.post(`${BASE_URL}/api/v1/chat/teams/messages`, { data: teams.activity(activity), headers: { authorization: `Bearer ${token}` } });
  // A forgery is refused before it's read.
  expect((await send({ type: 'message', text: 'help' }, 'not-a-token')).status()).toBe(401);
  const added = await send({
    type: 'conversationUpdate',
    recipient: { id: `28:${TEAMS.appId}` },
    membersAdded: [{ id: `28:${TEAMS.appId}` }],
    conversation: { id: team, conversationType: 'channel', tenantId: TEAMS.tenantId },
    channelData: { eventType: 'teamMemberAdded', tenant: { id: TEAMS.tenantId }, team: { id: team, name: teamName } },
  });
  expect(added.status()).toBe(200);

  // The Chat page: the bot is set up, and in the team.
  await page.goto('/chat');
  const teamsCard = page.getByRole('region', { name: 'Microsoft Teams' });
  await expect(teamsCard.getByText('set up', { exact: true })).toBeVisible();
  await expect(teamsCard.getByRole('list', { name: 'Teams a4a is in' })).toContainText(teamName);
  await expect(teamsCard.getByRole('link', { name: 'Download the Teams app' })).toHaveAttribute('href', '/api/v1/chat/teams/app-package');

  // The project's page tells a channel of its issues.
  await page.goto(`/projects/${key}`);
  const channels = page.getByRole('region', { name: 'Chat channels' });
  await expect(channels.getByText(`No channel hears of ${project.name} yet.`)).toBeVisible();
  await channels.getByLabel('Channel').selectOption({ label: `General, ${teamName} on Microsoft Teams` });
  await channels.getByRole('checkbox', { name: /^Assignments/ }).uncheck();
  await channels.getByRole('button', { name: 'Tell the channel' }).click();
  await expect(channels.getByText(`General hears of new issues, state changes and comments in ${project.name}.`)).toBeVisible();
  const row = channels.getByRole('region', { name: `Table of the channels told of ${project.name}` }).getByRole('row').filter({ hasText: 'General' });
  await expect(row).toContainText('New issues, state changes and comments');
  // A German page says what the channel hears of in German, from its kinds and the project's name;
  // the API's about stays English.
  const german = await browser.newContext({ locale: 'de-DE', storageState: AUTH_FILE });
  const deutsch = await german.newPage();
  await deutsch.goto(`/projects/${key}`);
  const kanäle = deutsch.getByRole('region', { name: 'Chat-Kanäle' });
  await expect(kanäle.getByRole('row').filter({ hasText: 'General' })).toContainText(`Neue Vorgänge, Statusänderungen und Kommentare in ${project.name}`);
  await german.close();

  // An issue reported there reaches the channel as a change card.
  const summary = `Exports stall at 99% ${unique()}`;
  const issue = await api.createIssue({ project: key, summary, fields: { Type: 'Bug' } });
  await expect.poll(() => teams.posted.filter((p) => p.conversationId === team && JSON.stringify(p.activity).includes(summary)).length, { timeout: 30_000 }).toBe(1);
  const post = teams.posted.find((p) => p.conversationId === team && JSON.stringify(p.activity).includes(summary))!;
  expect(post.activity.summary).toContain(issue.id);
  expect(JSON.stringify(post.activity.attachments)).toContain('"verb":"assign"');

  // Someone the bot doesn't know asks in the channel: the link goes to their personal chat alone.
  const dana = { id: `29:dana-${unique()}`, aadObjectId: randomUUID(), name: 'Dana Teams' };
  const asked = await send({
    type: 'message',
    id: `m-${unique()}`,
    text: `<at>a4a</at> ${issue.id}`,
    from: dana,
    recipient: { id: `28:${TEAMS.appId}` },
    conversation: { id: `${team};messageid=1`, conversationType: 'channel', tenantId: TEAMS.tenantId },
    channelData: { tenant: { id: TEAMS.tenantId }, team: { id: team, name: teamName }, channel: { id: team } },
  });
  expect(asked.status()).toBe(200);
  const personal = teams.posted.find((p) => p.conversationId === `a:personal-${dana.id}`)!;
  const link = /https?:\/\/\S+\/chat\/link\?token=\S+/.exec(String(personal.activity.text))![0];
  expect(teams.posted.filter((p) => p.conversationId.startsWith(team)).some((p) => String(p.activity.text).includes('/chat/link'))).toBe(false);

  // Opened in a4a: who it links, confirmed.
  await page.goto(link.replace(/^https?:\/\/[^/]+/, ''));
  await expect(page.getByRole('heading', { name: 'Link your Microsoft Teams account', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Dana Teams on Microsoft Teams' })).toBeVisible();
  await page.getByRole('button', { name: /^Link it to / }).click();
  await expect(page.getByRole('heading', { name: 'Linked', level: 1 })).toBeVisible();
  await expect.poll(() => teams.posted.filter((p) => p.conversationId === `a:personal-${dana.id}` && String(p.activity.text).startsWith("You're linked")).length).toBe(1);

  // Their profile lists it, and unlinks it.
  await page.goto('/me');
  const accounts = page.getByRole('region', { name: 'Chat accounts' });
  const dana_ = accounts.getByRole('listitem').filter({ hasText: 'Dana Teams on Microsoft Teams' });
  await expect(dana_).toBeVisible();
  await dana_.getByRole('button', { name: 'Unlink Dana Teams on Microsoft Teams' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Unlink it' }).click();
  await expect(accounts.getByText('Dana Teams on Microsoft Teams doesn’t act as you any more.')).toBeVisible();
  await expect(dana_).toHaveCount(0);

  // The channel stops hearing of the project.
  await page.goto(`/projects/${key}`);
  await row.getByRole('button', { name: /^Stop / }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Stop it' }).click();
  await expect(channels.getByText('General hears of it no more.')).toBeVisible();

  // A channel deleted in Teams stops what it hears of, and its row says why: in English here, and in
  // German on a German page, from the reason's words a4a kept.
  await channels.getByLabel('Channel').selectOption({ label: `Releases, ${teamName} on Microsoft Teams` });
  await channels.getByRole('button', { name: 'Tell the channel' }).click();
  await expect(channels.getByText(/^Releases hears of /)).toBeVisible();
  const deleted = await send({
    type: 'conversationUpdate',
    recipient: { id: `28:${TEAMS.appId}` },
    conversation: { id: team, conversationType: 'channel', tenantId: TEAMS.tenantId },
    channelData: { eventType: 'channelDeleted', tenant: { id: TEAMS.tenantId }, team: { id: team, name: teamName }, channel: { id: releases, name: 'Releases' } },
  });
  expect(deleted.status()).toBe(200);
  await page.reload();
  const releasesRow = channels.getByRole('region', { name: `Table of the channels told of ${project.name}` }).getByRole('row').filter({ hasText: 'Releases' });
  await expect(releasesRow).toContainText('stopped');
  await expect(releasesRow).toContainText('The channel was deleted');
  const german2 = await browser.newContext({ locale: 'de-DE', storageState: AUTH_FILE });
  const deutsch2 = await german2.newPage();
  await deutsch2.goto(`/projects/${key}`);
  await expect(deutsch2.getByRole('region', { name: 'Chat-Kanäle' }).getByRole('row').filter({ hasText: 'Releases' })).toContainText('Der Kanal wurde gelöscht.');
  await german2.close();
  await bot.dispose();
});
