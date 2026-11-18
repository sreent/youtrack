/**
 * CCs in depth (D67). A desk's manager sets its cap and lets everyone on a request hear each other, on
 * a card that says what each does and whom it trusts. A request comes by email from a sender a4a
 * can't vouch for, copying two people: they're held, and the acknowledgement asks the requester to
 * confirm them by a link; on its page she copies one and drops the other. Then, signed in to the
 * portal, she takes the one she copied off again. Light, dark and a phone's width at each step.
 *
 * The run's server sends no email (playwright.config.ts), so this spec starts one that does, and a
 * mail server for it (support/mail.ts).
 */
import type { Locator, Page } from '@playwright/test';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { expect, prepareContext, test } from './support/fixtures';
import { message, postMail } from './support/helpdesk';
import { startMailServer, startMailingServer, type MailServer, type MailingServer } from './support/mail';

const DESK = 'support@depth.example';
const JANE = 'jane@customer.example';
const OLA = 'ola@customer.example';
const BOB = 'bob@customer.example';

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

/** Shots in light, dark and at a phone's width (a card of the page, or the whole page), without sideways scroll. */
async function shoot(page: Page, name: string, card?: Locator) {
  const take = (path: string) => (card ? card.screenshot({ path }) : page.screenshot({ path, fullPage: true }));
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await take(test.info().outputPath(`${name}-${scheme}.png`));
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoSidewaysScroll(page);
  await take(test.info().outputPath(`${name}-390.png`));
  await page.setViewportSize({ width: 1280, height: 900 });
}

test('a held CC is confirmed by the acknowledgement’s link, and the requester takes them off on the portal', async ({ browser }) => {
  test.setTimeout(180_000);
  const team = await browser.newContext({ baseURL: server.url, locale: 'en-GB', viewport: { width: 1280, height: 900 } });
  const watch = await prepareContext(team);
  const page = await team.newPage();

  // Its administrator signs in, and sets up a desk that takes mail.
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
  await call('POST', '/projects', { key: 'CCD', name: 'Depth', template: 'software' });
  await call('PATCH', '/projects/CCD', { settings: { helpdesk: { enabled: true } } });
  await call('PUT', '/projects/CCD/helpdesk/mail', { address: DESK });
  const { url: webhook } = await call<{ url: string }>('POST', '/projects/CCD/helpdesk/mail/secret');

  // The desk's switches: a cap of its own, and everyone hearing each other. The card says what it trusts.
  await page.goto('/projects/CCD');
  const card = page.getByRole('region', { name: 'People copied on requests' });
  await expect(card.getByText(/This server names no mail server whose DMARC results it trusts/)).toBeVisible();
  await card.getByLabel('At most this many copied on a request').fill('5');
  await card.getByRole('checkbox', { name: /Let everyone on a request hear each other/ }).check();
  await expect(card.getByRole('checkbox', { name: /Hold a new request’s Cc until its requester confirms it/ })).toBeChecked();
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByText('Saved.')).toBeVisible();
  const desk = await call<{ settings: { helpdesk: { ccsMax: number; ccsRelay: boolean; ccsConfirm: boolean } } }>('GET', '/projects/CCD');
  expect(desk.settings.helpdesk).toMatchObject({ ccsMax: 5, ccsRelay: true, ccsConfirm: true });
  await expectAccessible(page);
  await shoot(page, 'request-ccs-depth-desk', card);

  // Jane asks by email, copying Ola and Bob; nothing vouches for her sender, so they're held.
  const asked = await postMail(webhook, message({ from: `Jane Doe <${JANE}>`, to: DESK, subject: 'The scanner is offline', body: 'Since this morning.', headers: [`Cc: Ola Berg <${OLA}>, ${BOB}`] }));
  expect(asked.body).toMatchObject({ outcome: 'request' });
  expect((asked.body as { reason: string }).reason).toContain(`held ${OLA}, ${BOB} for its requester to confirm`);
  const ack = await mail.waitFor(JANE, (m) => m.text.includes('/portal#hdc_'));
  expect(ack.text).toContain('They hear nothing until you confirm them');
  await page.goto('/issues/CCD-1');
  const request = page.getByRole('region', { name: 'Help desk request' });
  await expect(request.getByText('Waiting for Jane Doe to confirm')).toBeVisible();

  // The link opens a page of its own: she copies Ola and drops Bob, once.
  const own = await browser.newContext({ baseURL: server.url, locale: 'en-GB', viewport: { width: 1280, height: 900 } });
  const ownWatch = await prepareContext(own);
  const jane = await own.newPage();
  await jane.goto(/(\/portal#hdc_[A-Za-z0-9_-]{43})/.exec(ack.text)![1]!);
  await expect(jane.getByRole('heading', { name: 'Confirm whom you copied' })).toBeVisible();
  await expect(jane.getByRole('checkbox', { name: new RegExp(OLA) })).toBeChecked();
  await jane.getByRole('checkbox', { name: new RegExp(BOB) }).uncheck();
  await expectAccessible(jane);
  await shoot(jane, 'request-ccs-depth-confirm');
  await jane.getByRole('button', { name: 'Copy whom I chose' }).click();
  await expect(jane.getByRole('status')).toHaveText('1 person is copied: they get the team’s replies from now on.');
  await expect(jane.getByText('1 is dropped, and told nothing.')).toBeVisible();
  // Used, the link says so, as a stale or unknown one would, and offers the portal; its API's 401 is expected.
  ownWatch.allow(/status of 401/);
  await jane.reload();
  await expect(jane.getByText(/This link has expired or was used/)).toBeVisible();
  await expect(jane.getByRole('link', { name: 'Open the portal' })).toBeVisible();

  // Signed in to the portal, she takes Ola off again.
  await jane.goto('/portal?request=CCD-1');
  await jane.getByRole('textbox', { name: 'Your email' }).fill(JANE);
  await jane.getByRole('button', { name: 'Email me a link' }).click();
  const link = await mail.waitFor(JANE, (m) => m.text.includes('/portal#hdl_'));
  await jane.goto(/(\/portal#hdl_[A-Za-z0-9_-]{43})/.exec(link.text)![1]!);
  await jane.getByRole('list', { name: 'Requests' }).getByRole('button', { name: 'The scanner is offline' }).click();
  const copied = jane.getByRole('region', { name: 'Copied' });
  await expect(copied.getByText('Ola Berg')).toBeVisible();
  await expectAccessible(jane);
  await shoot(jane, 'request-ccs-depth-portal');
  await copied.getByRole('button', { name: `Stop copying ${OLA}` }).click();
  await expect(copied.getByRole('status')).toHaveText(`${OLA} is no longer copied: they hear nothing more of it.`);
  await expect(copied.getByText('Nobody is copied.')).toBeVisible();

  // The request's history names her as who took Ola off, on the portal.
  await page.reload();
  const history = page.getByRole('region', { name: 'History and comments' });
  await expect(history.getByText(`stopped copying ${OLA}, on the portal`)).toBeVisible();

  expect(watch.unexpected()).toEqual([]);
  expect(ownWatch.unexpected()).toEqual([]);
  await own.close();
  await team.close();
});
