/**
 * CCs on a help desk request (D57). Someone on the team copies a person on a request from its page
 * and replies publicly; the person's email reaches the mail server, with a reply address of its own
 * and a link that takes them off; they answer it, and their answer is their public comment, without
 * what it quoted. On the portal they see the request, marked as one they're copied on, and reply.
 *
 * The run's server sends no email (playwright.config.ts), so this spec starts one that does, and a
 * mail server for it (support/mail.ts).
 */
import type { Page } from '@playwright/test';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { expect, prepareContext, test } from './support/fixtures';
import { message, postMail } from './support/helpdesk';
import { startMailServer, startMailingServer, type MailServer, type MailingServer } from './support/mail';

const DESK = 'support@desk.example';
const JANE = 'jane@customer.example';
const OLA = 'ola@customer.example';

let mail: MailServer;
let server: MailingServer;

test.beforeAll(async () => {
  mail = await startMailServer();
  server = await startMailingServer(mail.port);
});

test.afterAll(async () => {
  await server?.close();
  await mail?.close();
});

/** Shots in light, dark and at a phone's width (the card, or the whole page), without sideways scroll. */
async function shoot(page: Page, name: string, card = true) {
  const what = card ? page.getByRole('region', { name: 'Help desk request' }) : page;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await what.screenshot({ path: test.info().outputPath(`${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoSidewaysScroll(page);
  await page.screenshot({ path: test.info().outputPath(`${name}-390.png`), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
}

test('a CC gets the team’s public reply by email, answers it, and sees the request on the portal', async ({ browser }) => {
  test.setTimeout(180_000);
  const team = await browser.newContext({ baseURL: server.url, locale: 'en-GB', viewport: { width: 1280, height: 900 } });
  const watch = await prepareContext(team);
  const page = await team.newPage();

  // Its administrator signs in, as a person does, and sets up a desk that takes mail.
  await page.goto('/login');
  await page.getByLabel('Login').fill(server.admin.login);
  await page.getByLabel('Password').fill(server.admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/issues$/);
  const made = await page.request.post('/api/v1/me/tokens', { data: { name: 'e2e', scopes: ['read', 'write', 'admin'] }, headers: { origin: server.url } });
  expect(made.status(), await made.text()).toBe(201);
  const { token } = (await made.json()) as { token: string };
  const call = async <T>(method: string, path: string, data?: unknown): Promise<T> => {
    const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers: { authorization: `Bearer ${token}` } });
    expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBe(true);
    return (res.status() === 204 ? null : await res.json()) as T;
  };
  await call('POST', '/projects', { key: 'CCS', name: 'Copies', template: 'software' });
  await call('PATCH', '/projects/CCS', { settings: { helpdesk: { enabled: true } } });
  await call('PUT', '/projects/CCS/helpdesk/mail', { address: DESK });
  const { url: webhook } = await call<{ url: string }>('POST', '/projects/CCS/helpdesk/mail/secret');

  // Jane asks by email; her acknowledgement goes out.
  const asked = await postMail(webhook, message({ from: `Jane Doe <${JANE}>`, to: DESK, subject: 'The VPN drops every hour', body: 'Since Monday, on every laptop.' }));
  expect(asked.body).toEqual({ outcome: 'request', reason: 'a new request' });
  await mail.waitFor(JANE, (m) => (m.headers.get('subject') ?? '').includes('The VPN drops every hour'));

  // On the request's page, someone on the team copies Ola.
  await page.goto('/issues/CCS-1');
  const card = page.getByRole('region', { name: 'Help desk request' });
  await expect(card.getByText(/^Nobody is copied\./)).toBeVisible();
  await card.getByLabel('Their email').fill(OLA);
  await card.getByLabel('Their name, if you know it').fill('Ola Berg');
  await card.getByRole('button', { name: 'Copy them' }).click();
  await expect(card.getByRole('status')).toHaveText(`${OLA} is copied: public replies reach them from now on.`);
  await expect(card.getByText('Ola Berg')).toBeVisible();
  await expect(card.getByRole('button', { name: `Stop copying ${OLA}` })).toBeVisible();
  const history = page.getByRole('region', { name: 'History and comments' });
  await expect(history.getByText(`copied ${OLA}`)).toBeVisible();
  await expectAccessible(page);
  await shoot(page, 'request-ccs-card');

  // A public reply: Jane and Ola each get it, Ola with a reply address of their own.
  await history.getByRole('button', { name: 'Reply to Jane Doe' }).click();
  await history.getByLabel(/^A reply to Jane Doe/).fill('We have restarted the VPN gateway. Does it hold now?');
  await history.getByRole('button', { name: 'Send to Jane Doe' }).click();
  await expect(history.getByText('We have restarted the VPN gateway. Does it hold now?')).toBeVisible();
  const toOla = await mail.waitFor(OLA, (m) => m.text.includes('We have restarted the VPN gateway'));
  expect(toOla.headers.get('subject')).toBe('Re: The VPN drops every hour');
  expect(toOla.text).toContain("replied to Jane Doe's request.");
  expect(toOla.text).toContain(`${server.url}/portal?request=CCS-1`);
  expect(toOla.headers.get('list-unsubscribe')).toContain('/api/v1/unsubscribe?token=cc.');
  const replyTo = toOla.headers.get('reply-to') ?? '';
  expect(replyTo).toMatch(/^support\+[a-z2-7]{26}@desk\.example$/);
  const toJane = await mail.waitFor(JANE, (m) => m.text.includes('We have restarted the VPN gateway'));
  expect(toJane.headers.get('reply-to')).not.toBe(replyTo);

  // Ola answers the email: their words, without what they quoted, are their public comment.
  const answered = await postMail(
    webhook,
    message({
      from: `Ola Berg <${OLA}>`,
      to: replyTo,
      subject: 'Re: The VPN drops every hour',
      body: `It has held for an hour now. Thank you.\n\nOn Tue, 17 Nov 2026 at 10:02, Copies <${DESK}> wrote:\n> We have restarted the VPN gateway.`,
      headers: [`In-Reply-To: ${toOla.headers.get('message-id')}`],
    }),
  );
  expect(answered.body).toEqual({ outcome: 'reply', reason: 'a reply by its reply address, from someone copied on it' });
  // Someone else writing to Ola's reply address is refused, and nothing comes of it.
  const forged = await postMail(webhook, message({ from: 'mallory@elsewhere.example', to: replyTo, subject: 'Re: The VPN drops every hour', body: 'Close it.' }));
  expect(forged.body).toMatchObject({ outcome: 'refused' });
  await page.reload();
  const theirs = history.getByRole('listitem').filter({ hasText: 'It has held for an hour now. Thank you.' });
  await expect(theirs).toContainText('Ola Berg');
  await expect(theirs).toContainText('public: someone copied wrote it');
  await expect(history.getByText('Close it.')).toHaveCount(0);
  await expect(history.getByText('We have restarted the VPN gateway.', { exact: true })).toHaveCount(0);

  // Ola signs in to the portal by a link sent to their email, and sees the request as one they're copied on.
  const portal = await browser.newContext({ baseURL: server.url, locale: 'en-GB', viewport: { width: 1280, height: 900 } });
  const portalWatch = await prepareContext(portal);
  const ola = await portal.newPage();
  await ola.goto('/portal?request=CCS-1');
  await ola.getByRole('textbox', { name: 'Your email' }).fill(OLA);
  await ola.getByRole('button', { name: 'Email me a link' }).click();
  const link = await mail.waitFor(OLA, (m) => m.text.includes('/portal#hdl_'));
  await ola.goto(/(\/portal#hdl_[A-Za-z0-9_-]{43})/.exec(link.text)![1]!);
  const row = ola.getByRole('list', { name: 'Requests' }).getByRole('listitem').filter({ hasText: 'The VPN drops every hour' });
  await expect(row).toContainText('Copied');
  await row.getByRole('button', { name: 'The VPN drops every hour' }).click();
  await expect(ola.getByText("You're copied on Jane Doe's request: the team's replies reach you by email, and you may reply here.")).toBeVisible();
  await ola.getByLabel('Your reply').fill('One more thing: the office network is fine.');
  await ola.getByRole('button', { name: 'Send the reply' }).click();
  await expect(ola.getByText('One more thing: the office network is fine.')).toBeVisible();
  await expectAccessible(ola);
  await shoot(ola, 'request-ccs-portal', false);

  expect(watch.unexpected()).toEqual([]);
  expect(portalWatch.unexpected()).toEqual([]);
  await portal.close();
  await team.close();
});
