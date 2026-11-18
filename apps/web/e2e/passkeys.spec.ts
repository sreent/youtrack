/**
 * Passkeys (D62) in Chromium, with its virtual authenticator (CDP's WebAuthn domain) in place of a
 * phone or a laptop's fingerprint reader: someone adds a passkey on their profile, names it, signs out
 * and signs in with it alone, then removes it; each change is mailed to them, and the mail's "This
 * wasn't me" signs them out everywhere.
 *
 * Browsers make passkeys only for a domain, and the run's own server is at an IP address, so this spec
 * starts a server of its own at http://localhost, which sends mail to a mail server of its own too
 * (support/mail.ts).
 */
import type { CDPSession, Locator, Page } from '@playwright/test';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { expect, prepareContext, test } from './support/fixtures';
import { startMailServer, startMailingServer, type MailServer, type MailingServer } from './support/mail';

const NOOR = { login: 'noor', name: 'Noor Haddad', email: 'noor@corp.example', password: 'e2e-noor-pass-1' };

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

/**
 * A platform authenticator that verifies its person (a fingerprint, say). While `present`, it answers
 * by itself, the autofill's quiet request too, as a person choosing the passkey there would.
 */
async function authenticator(page: Page): Promise<{ present(on: boolean): Promise<void> }> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { present: async (enabled) => void (await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled })) };
}

/** Shots in light and dark, and the whole page at a phone's width, without sideways scroll; and axe. */
async function shoot(page: Page, what: Locator, name: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await what.screenshot({ path: test.info().outputPath(`${name}-${scheme}.png`) });
  }
  await expectAccessible(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoSidewaysScroll(page);
  await page.screenshot({ path: test.info().outputPath(`${name}-390.png`), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function signInWithPassword(page: Page, who: { login: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel('Login').fill(who.login);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/issues$/);
}

test('adds a passkey on the profile, signs out, signs in with it alone, and removes it', async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ baseURL: server.url, locale: 'en-GB', viewport: { width: 1280, height: 900 } });
  const watch = await prepareContext(context);
  // Signed out, the pages ask who's there and are told 401; the removed passkey is refused, 401.
  watch.allow(/status of 401/);
  const page = await context.newPage();
  const device = await authenticator(page);

  // An administrator gives Noor an account, with an email a4a writes to.
  await signInWithPassword(page, server.admin);
  const made = await page.request.post('/api/v1/users', { data: { ...NOOR, role: 'member' }, headers: { origin: server.url } });
  expect(made.status(), await made.text()).toBe(201);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);

  // Noor adds a passkey from her profile: her sign-in was just now, so nothing more is asked.
  await signInWithPassword(page, NOOR);
  await page.goto('/me');
  const card = page.getByRole('region', { name: 'Passkeys', exact: true });
  await expect(card.getByText(/^No passkeys yet\./)).toBeVisible();
  await card.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(card.getByRole('status')).toHaveText(/ is added: it signs you in from the sign-in page, without a password\.$/);
  const table = card.getByRole('region', { name: 'Your passkeys' });
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table.getByRole('row').nth(1)).toContainText('Not yet');
  // She names it.
  await table.getByRole('button', { name: /^Rename / }).click();
  await table.getByRole('textbox', { name: /^New name for / }).fill('Work laptop');
  await table.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByRole('status')).toHaveText('Renamed to “Work laptop”.');
  await expect(table.getByRole('rowheader')).toHaveText('Work laptop');
  const added = await mail.waitFor(NOOR.email, (m) => m.headers.get('subject') === 'A passkey was added to your a4a account');
  expect(added.text).toMatch(/The passkey “.+” was added to your a4a account, noor, on /);
  expect(added.text).toMatch(/This wasn’t me: http:\/\/localhost:\d+\/not-me\?token=/);
  await shoot(page, card, 'profile-passkeys');

  // Signed out, the sign-in page offers the passkey: no login, no password. Away from the device, the
  // autofill's request waits, and the page can be looked at.
  await device.present(false);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  const signIn = page.getByRole('button', { name: 'Sign in with a passkey' });
  await expect(signIn).toBeVisible();
  await expect(page.getByLabel('Login')).toHaveAttribute('autocomplete', 'username webauthn');
  await shoot(page, page.getByRole('main'), 'sign-in');
  // Back at it, the button signs her in.
  await device.present(true);
  await signIn.click({ timeout: 5_000 }).catch(() => {});
  await expect(page).toHaveURL(/\/issues$/);
  // And so does the browser's autofill on the login field, by itself here.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/issues$/);
  await page.goto('/me');
  await expect(table.getByRole('row').nth(1)).not.toContainText('Not yet');

  // She removes it: the sign-in a moment ago is recent enough.
  await table.getByRole('button', { name: 'Remove Work laptop' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove it' }).click();
  await expect(card.getByRole('status')).toHaveText('“Work laptop” is removed: it signs nobody in.');
  await expect(card.getByText(/^No passkeys yet\./)).toBeVisible();
  const removed = await mail.waitFor(NOOR.email, (m) => m.headers.get('subject') === 'A passkey was removed from your a4a account');
  const link = /http:\/\/localhost:\d+(\/not-me\?token=[A-Za-z0-9_-]+)/.exec(removed.text)![1]!;

  // The mail's link: opening it changes nothing; its button signs her out everywhere.
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'A passkey was removed from your account' })).toBeVisible();
  await expect(page.getByText('The passkey “Work laptop”, on the a4a account noor, ')).toBeVisible();
  await shoot(page, page.getByRole('main'), 'not-me');
  await page.getByRole('button', { name: 'Sign me out everywhere' }).click();
  await expect(page.getByRole('heading', { name: 'Done' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('You’re signed out everywhere.');
  await page.goto('/me');
  await expect(page).toHaveURL(/\/login/);

  // The removed passkey is still on the device, and the autofill offers it, but a4a doesn't take it.
  await expect(page.getByRole('alert')).toContainText('a4a doesn’t know that passkey');
  await signInWithPassword(page, NOOR);
  expect(watch.unexpected()).toEqual([]);
  await context.close();
});
