/**
 * Requesters' passkeys (docs/architecture.md, D69) in Chromium, with its virtual authenticator (CDP's
 * WebAuthn domain) in place of a phone or a laptop's fingerprint reader. A desk's manager takes
 * passkeys on the desk's page; its requester signs in to the portal by an emailed link, adds a passkey
 * on the account page, signs out, and signs in with it alone. The team then sees on the request that
 * they have one, and removes it, which signs that session out. Light, dark and at 390px.
 *
 * Browsers make passkeys only for a domain, and the run's own server is at an IP address and sends no
 * email, so this runs on a server of its own at http://localhost, beside a mail server of its own
 * (support/mail.ts), as passkeys.spec.ts does.
 */
import type { CDPSession, Page } from '@playwright/test';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { expect, prepareContext, test } from './support/fixtures';
import { message, postMail } from './support/helpdesk';
import { startMailServer, startMailingServer, type MailServer, type MailingServer } from './support/mail';

const REQUESTER = 'lena@customer.example';

let mail: MailServer;
let server: MailingServer;

test.beforeAll(async () => {
  mail = await startMailServer();
  server = await startMailingServer(mail.port, { localhost: true });
});

test.afterAll(async () => {
  await server?.close();
  await mail?.close();
});

/** A platform authenticator that verifies its person. While `present`, it answers by itself, the autofill's quiet request too. */
async function authenticator(page: Page): Promise<{ present(on: boolean): Promise<void> }> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { present: async (enabled) => void (await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled })) };
}

/** Light, dark and on a phone: axe finds nothing, and nothing scrolls sideways. */
async function inEveryLight(p: Page, name: string, ready: () => Promise<void>) {
  for (const [colorScheme, width] of [['light', 1280], ['dark', 1280], ['light', 390]] as const) {
    await p.emulateMedia({ colorScheme });
    await p.setViewportSize({ width, height: 900 });
    await ready();
    await p.screenshot({ path: test.info().outputPath(`${name}-${colorScheme}-${width}.png`), fullPage: true });
    await expectAccessible(p);
    await expectNoSidewaysScroll(p);
  }
  await p.emulateMedia({ colorScheme: 'light' });
  await p.setViewportSize({ width: 1280, height: 900 });
}

test('a requester signs in by link, adds a passkey, signs out and back in with it; the team sees it and removes it', async ({ browser }) => {
  test.setTimeout(240_000);

  // The team: an administrator, who manages every desk, makes one that takes requests by email.
  const team = await browser.newContext({ baseURL: server.url, locale: 'en-GB', viewport: { width: 1280, height: 900 } });
  const teamWatch = await prepareContext(team);
  const page = await team.newPage();
  await page.goto('/login');
  await page.getByLabel('Login').fill(server.admin.login);
  await page.getByLabel('Password').fill(server.admin.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/issues$/);
  const made = await page.request.post('/api/v1/me/tokens', { data: { name: 'e2e', scopes: ['read', 'write', 'admin'] }, headers: { origin: server.url } });
  expect(made.status(), await made.text()).toBe(201);
  const { token } = (await made.json()) as { token: string };
  const call = async <T>(method: string, path: string, data?: unknown): Promise<T> => {
    const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers: { authorization: `Bearer ${token}` } });
    expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBe(true);
    return (res.status() === 204 ? null : await res.json()) as T;
  };
  await call('POST', '/projects', { key: 'PKY', name: 'Desk PKY', template: 'software' });
  await call('PATCH', '/projects/PKY', { settings: { helpdesk: { enabled: true } } });
  await call('PUT', '/projects/PKY/helpdesk/mail', { address: 'pky@desk.example' });
  const { url } = await call<{ url: string }>('POST', '/projects/PKY/helpdesk/mail/secret');
  expect((await postMail(url, message({ from: `Lena <${REQUESTER}>`, to: 'pky@desk.example', subject: 'The scanner will not start', body: 'Since Monday.' }))).status).toBe(200);
  await mail.waitFor(REQUESTER, (m) => (m.headers.get('subject') ?? '').includes('The scanner will not start'));

  // The desk's page offers the new way, said for what it means; the manager takes it beside the link.
  await page.goto('/projects/PKY');
  const card = page.getByRole('region', { name: 'How requesters sign in' });
  await card.getByRole('checkbox', { name: /^A passkey/ }).check();
  await card.getByRole('button', { name: 'Save how requesters sign in' }).click();
  await expect(card.getByText('Saved. A session opened another way no longer opens this desk’s requests.')).toBeVisible();
  await inEveryLight(page, 'desk-passkeys', () => expect(card.getByRole('checkbox', { name: /^A passkey/ })).toBeChecked());

  const portal = await browser.newContext({ baseURL: server.url, locale: 'en-GB', viewport: { width: 1280, height: 900 } });
  const watch = await prepareContext(portal);
  try {
    const lena = await portal.newPage();
    const device = await authenticator(lena);

    // By the emailed link: what proves her mailbox, and lets her add a passkey for ten minutes.
    await lena.goto('/portal?desk=PKY');
    await lena.getByRole('textbox', { name: 'Your email' }).fill(REQUESTER);
    await lena.getByRole('button', { name: 'Email me a link' }).click();
    const link = await mail.waitFor(REQUESTER, (m) => /#hdl_/.test(m.text));
    await lena.goto(/(\/portal#hdl_[A-Za-z0-9_-]{43})/.exec(link.text)![1]!);
    await expect(lena.getByRole('button', { name: 'The scanner will not start' })).toBeVisible();
    await expect(lena.getByText('You signed in with a link we emailed you.')).toBeVisible();

    // She adds a passkey on the account page: no more is asked, and she's told by email.
    const section = lena.getByRole('region', { name: 'Passkeys' });
    await expect(section.getByText('No passkeys yet.')).toBeVisible();
    await section.getByRole('button', { name: 'Add a passkey' }).click();
    await expect(section.getByRole('status')).toHaveText(/ is added: it signs you in from the portal’s sign-in page, without a link or a password\.$/);
    const table = section.getByRole('list', { name: 'Your passkeys' });
    await expect(table.getByRole('listitem')).toHaveCount(1);
    await expect(table.getByRole('listitem')).toContainText('not used yet');
    await table.getByRole('button', { name: /^Rename / }).click();
    await table.getByRole('textbox', { name: /^New name for / }).fill('Lena’s laptop');
    await table.getByRole('button', { name: 'Save' }).click();
    await expect(section.getByRole('status')).toHaveText('Renamed to “Lena’s laptop”.');
    const added = await mail.waitFor(REQUESTER, (m) => m.headers.get('subject') === 'A passkey now signs you in to the help desk');
    expect(added.text).toMatch(/This wasn’t me: http:\/\/localhost:\d+\/portal#hdk_[A-Za-z0-9_-]{43}/);
    await inEveryLight(lena, 'account-passkeys', () => expect(table.getByRole('listitem')).toContainText('Lena’s laptop'));

    // Signed out, the sign-in page offers it, in the email field's autofill and by a button. Away
    // from the device, the autofill's request waits, and the page can be looked at.
    await device.present(false);
    await lena.getByRole('button', { name: 'Sign out' }).click();
    const withPasskey = lena.getByRole('button', { name: 'Sign in with a passkey' });
    await expect(withPasskey).toBeVisible();
    await expect(lena.getByRole('textbox', { name: 'Your email' })).toHaveAttribute('autocomplete', 'username webauthn');
    await inEveryLight(lena, 'sign-in', () => expect(withPasskey).toBeVisible());
    // Back at it, the passkey alone signs her in (the button, or the autofill by itself here).
    await device.present(true);
    await withPasskey.click({ timeout: 5_000 }).catch(() => {});
    await expect(lena.getByText('You signed in with a passkey.')).toBeVisible();
    await expect(lena.getByRole('button', { name: 'The scanner will not start' })).toBeVisible();
    await inEveryLight(lena, 'signed-in-by-passkey', () => expect(lena.getByRole('heading', { name: 'Passkeys' })).toBeVisible());

    // The team sees that she has one, never which, and removes it: the session it opened ends.
    await page.goto('/issues/PKY-1');
    const request = page.getByRole('region', { name: 'Help desk request' });
    await expect(request.getByText('Signs in to the portal with 1 passkey')).toBeVisible();
    await expect(request).not.toContainText('Lena’s laptop');
    await inEveryLight(page, 'request-passkeys', () => expect(request.getByRole('button', { name: 'Remove their passkeys' })).toBeVisible());
    await request.getByRole('button', { name: 'Remove their passkeys' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove them' }).click();
    await expect(request.getByRole('status')).toHaveText('1 passkey removed: they’re told by email.');
    await mail.waitFor(REQUESTER, (m) => m.headers.get('subject') === 'The team removed your help desk passkey');
    // The passkey stops right away, and the page can't be used signed in by it.
    await device.present(false);
    await lena.reload();
    await expect(lena.getByRole('textbox', { name: 'Your email' })).toBeVisible();
    expect(watch.unexpected()).toEqual([]);
    expect(teamWatch.unexpected()).toEqual([]);
  } finally {
    await portal.close();
    await team.close();
  }
});
