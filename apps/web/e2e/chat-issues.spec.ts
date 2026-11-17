/**
 * An issue made from a Slack message (docs/architecture.md, D60).
 *
 * Slack is connected with its app's token and signing secret; someone a4a doesn't know uses the
 * message shortcut and is shown a sign-in link, in a modal only they see, which links their Slack
 * account to the person signed in. The shortcut then opens the form; sent, it makes the issue as
 * them, and they're told where only they see it. The issue's page names where it came from, in light,
 * in dark and at a phone's width. Slack's Web API here is the spec's own (support/slack.ts), and what
 * Slack sends the server is signed with the app's secret, as the chat tests do.
 */
import type { Page } from '@playwright/test';
import { unique, uniqueKey } from './support/api';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { BASE_URL, SLACK } from './support/env';
import { expect, test } from './support/fixtures';
import { startSlack } from './support/slack';

let slack: Awaited<ReturnType<typeof startSlack>>;

test.beforeAll(async () => {
  slack = await startSlack();
});

test.afterAll(async () => {
  await slack?.close();
});

/** Shots of the source's card in light and dark, and of the page at a phone's width, without sideways scroll. */
async function shoot(page: Page, name: string) {
  const card = page.getByRole('region', { name: 'Where it came from' });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await card.screenshot({ path: test.info().outputPath(`${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoSidewaysScroll(page);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath(`${name}-390.png`), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
}

test('a Slack message made an issue, as its person, says where it came from on the issue’s page', async ({ page, api, playwright }) => {
  test.setTimeout(120_000);
  await api.post('/chat/slack', { botToken: SLACK.botToken, signingSecret: SLACK.signingSecret });
  const key = uniqueKey('SL');
  await api.createProject({ key, name: `Slack ${key}` });
  const dana = `UE2E${unique().toUpperCase()}`;
  slack.people[dana] = 'Dana Slack';
  slack.people.UE2EBEN = 'Ben Okafor';
  const ts = `${Math.floor(Date.now() / 1000)}.000100`;
  const message = {
    type: 'message',
    ts,
    user: 'UE2EBEN',
    text: `*Exports* stall at 99% for <@${dana}> ${unique()}\nIt started after the upgrade: <https://example.com/log|the log>. &lt;script&gt;alert(1)&lt;/script&gt;`,
    files: [{ name: 'trace.log', title: 'trace.log', permalink: 'https://acme.slack.com/files/UE2EBEN/F1/trace.log' }],
  };
  slack.threads.set(`CE2EENG:${ts}`, [message]);

  // Slack sends without a cookie, as nobody, and signs what it sends.
  const bot = await playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
  const send = (payload: unknown, signed = true) => {
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    return bot.post(`${BASE_URL}/api/v1/chat/slack/interactions`, { data: body, headers: { 'content-type': 'application/x-www-form-urlencoded', ...(signed ? slack.signed(body) : {}) } });
  };
  const shortcut = () => ({
    type: 'message_action',
    callback_id: 'a4a_create_issue',
    trigger_id: `trigger-${unique()}`,
    team: { id: SLACK.teamId, domain: 'acme' },
    user: { id: dana, name: 'dana' },
    channel: { id: 'CE2EENG', name: 'eng' },
    message,
    message_ts: ts,
  });
  // A request Slack didn't sign is refused before it's read.
  expect((await send(shortcut(), false)).status()).toBe(401);

  // Someone a4a doesn't know: a modal with a link to sign in with, and nothing else.
  const before = slack.callsOf('views.open').length;
  expect((await send(shortcut())).status()).toBe(200);
  await expect.poll(() => slack.callsOf('views.open').length).toBe(before + 1);
  const notice = JSON.stringify(slack.callsOf('views.open').at(-1)!.body);
  expect(notice).not.toContain('Exports');
  const link = /https?:\/\/[^\s"\\]+\/chat\/link\?token=[^\s"\\]+/.exec(notice)![0];
  await page.goto(link.replace(/^https?:\/\/[^/]+/, ''));
  await expect(page.getByRole('heading', { name: 'Link your Slack account', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: /^Link it to / }).click();
  await expect(page.getByRole('heading', { name: 'Linked', level: 1 })).toBeVisible();

  // Linked, the shortcut opens the form: the project offered, the message as the description.
  expect((await send(shortcut())).status()).toBe(200);
  await expect.poll(() => slack.callsOf('views.open').length).toBe(before + 2);
  const view = slack.callsOf('views.open').at(-1)!.body.view as { private_metadata: string; blocks: { block_id?: string; element?: { options?: { value: string }[]; initial_value?: string } }[] };
  expect(view.blocks.find((b) => b.block_id === 'project')!.element!.options!.map((o) => o.value)).toContain(key);
  const summary = view.blocks.find((b) => b.block_id === 'summary')!.element!.initial_value!;
  const description = view.blocks.find((b) => b.block_id === 'description')!.element!.initial_value!;
  expect(summary).toMatch(/^Exports stall at 99% for @Dana Slack /);
  expect(description).toContain('\\<script\\>');

  const sent = await send({
    type: 'view_submission',
    team: { id: SLACK.teamId },
    user: { id: dana, name: 'dana' },
    view: {
      id: `V${unique()}`,
      callback_id: 'a4a_create_issue',
      private_metadata: view.private_metadata,
      state: { values: { project: { value: { selected_option: { value: key } } }, summary: { value: { value: summary } }, description: { value: { value: description } } } },
    },
  });
  expect(await sent.json()).toEqual({ response_action: 'clear' });
  // Told where only they see it, with the issue's id.
  await expect.poll(() => slack.callsOf('chat.postEphemeral').filter((c) => c.body.user === dana).length).toBe(1);
  const said = String(slack.callsOf('chat.postEphemeral').find((c) => c.body.user === dana)!.body.text);
  const id = /^Created (\S+) from the message\.$/.exec(said)![1]!;

  // The issue's page: the message as its description, with nothing in it that runs, and where it came from.
  await page.goto(`/issues/${id}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Exports stall at 99%');
  const text = page.getByRole('region', { name: 'Description' });
  await expect(text).toContainText('It started after the upgrade');
  await expect(text).toContainText('<script>alert(1)</script>');
  await expect(text.getByRole('link', { name: 'the log' })).toHaveAttribute('href', 'https://example.com/log');
  const card = page.getByRole('region', { name: 'Where it came from' });
  await expect(card).toContainText('From a Slack message in #eng, Acme');
  await expect(card).toContainText('Sent by Ben Okafor on');
  await expect(card.getByRole('link', { name: 'Open the message in Slack' })).toHaveAttribute('href', `https://acme.slack.com/archives/CE2EENG/p${ts.replace('.', '')}`);
  await expect(card.getByRole('list', { name: 'Files in the message' }).getByRole('link', { name: 'trace.log' })).toHaveAttribute('href', 'https://acme.slack.com/files/UE2EBEN/F1/trace.log');
  // Made as them, through chat: its history says so.
  await expect(page.getByText(/via Slack/).first()).toBeVisible();
  await expectAccessible(page);
  await shoot(page, 'chat-issue-source');

  await api.delete('/chat/slack');
  await bot.dispose();
});
