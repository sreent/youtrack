/**
 * Passkeys (D62) in Chromium, with its virtual authenticator (CDP's WebAuthn domain) in place of a
 * phone or a laptop's fingerprint reader: someone adds a passkey on their profile, names it, signs out
 * and signs in with it alone, then removes it; each change is mailed to them, and the mail's "This
 * wasn't me" signs them out everywhere.
 *
 * In depth (D68): where passkeys are required, a sign-in without one adds it; someone with a synced
 * passkey removes their password, and is then told, signing in with it, that the account has none;
 * and an administrator makes an account with no password, whose mailed link adds its first passkey.
 *
 * Browsers make passkeys only for a domain, and the run's own server is at an IP address, so this spec
 * starts a server of its own at http://localhost, which sends mail to a mail server of its own too
 * (support/mail.ts).
 */
import type { Browser, CDPSession, Locator, Page } from '@playwright/test';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { expect, prepareContext, settled, test } from './support/fixtures';
import { unique } from './support/api';
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
async function authenticator(page: Page, o: { synced?: boolean } = {}): Promise<{ present(on: boolean): Promise<void> }> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      // A passkey its provider syncs (backup eligible, backed up): a spare by itself (D68).
      ...(o.synced ? { defaultBackupEligibility: true, defaultBackupState: true } : {}),
    },
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

/** An administrator's browser, signed in, with a passkey of their own: the guard asks one before passkeys are required (D68). */
async function adminWithPasskey(browser: Browser) {
  const context = await browser.newContext({ baseURL: server.url, locale: 'en-GB', viewport: { width: 1280, height: 900 } });
  const watch = await prepareContext(context);
  watch.allow(/status of 401/);
  const page = await context.newPage();
  await authenticator(page);
  await signInWithPassword(page, server.admin);
  const mine = await page.request.get('/api/v1/me/passkeys');
  if (!((await mine.json()) as { passkeys: unknown[] }).passkeys.length) {
    await page.goto('/me');
    const card = page.getByRole('region', { name: 'Passkeys', exact: true });
    await card.getByRole('button', { name: 'Add a passkey' }).click();
    await expect(card.getByRole('status')).toHaveText(/ is added: /);
  }
  return { context, page, watch };
}

test('asks for a passkey at sign-in where they are required, and lets a passkey alone sign in once the password goes', async ({ browser }) => {
  test.setTimeout(180_000);
  const admin = await adminWithPasskey(browser);
  // The administrator asks it of everyone, on the administration page.
  await admin.page.goto('/admin');
  const instance = admin.page.getByRole('region', { name: 'This instance' });
  // The radio follows the saved setting, so it's checked once the save is under way.
  const everyone = instance.getByRole('radio', { name: 'Of everyone who signs in with a password' });
  await everyone.click();
  await expect(instance.getByText('From the next sign-in, everyone is asked for a passkey.')).toBeVisible();
  await expect(everyone).toBeChecked();
  await shoot(admin.page, instance, 'admin-passkey-policy');
  const rhea = { login: 'rhea', name: 'Rhea Required', email: 'rhea@corp.example', password: 'e2e-rhea-pass-1' };
  expect((await admin.page.request.post('/api/v1/users', { data: { ...rhea, role: 'member' }, headers: { origin: server.url } })).status()).toBe(201);

  try {
    const context = await browser.newContext({ baseURL: server.url, locale: 'en-GB', viewport: { width: 1280, height: 900 } });
    const watch = await prepareContext(context);
    // Signed out, the pages ask who's there (401); and a password sign-in for an account with none is refused, 401.
    watch.allow(/status of 401/);
    const page = await context.newPage();
    const device = await authenticator(page, { synced: true });
    // Her password is right; her sign-in owes a passkey, and adds one before it starts.
    await device.present(false);
    await page.goto('/login');
    await page.getByLabel('Login').fill(rhea.login);
    await page.getByLabel('Password').fill(rhea.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Add a passkey to sign in' })).toBeVisible();
    await shoot(page, page.getByRole('main'), 'sign-in-owes-a-passkey');
    await device.present(true);
    await page.getByRole('main').getByRole('button', { name: 'Add a passkey' }).click();
    await expect(page).toHaveURL(/\/issues$/);
    await mail.waitFor(rhea.email, (m) => m.headers.get('subject') === 'A passkey was added to your a4a account');

    // The passkey is synced, a spare by itself; her sign-in was with it just now: she removes her password.
    await page.goto('/me');
    const card = page.getByRole('region', { name: 'Passkeys', exact: true });
    await expect(card.getByText('Passkeys are required of you here: a password sign-in asks for one.')).toBeVisible();
    await expect(card.getByRole('heading', { name: 'Sign in with passkeys alone' })).toBeVisible();
    await card.getByRole('button', { name: 'Remove my password' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove it' }).click();
    await expect(card.getByRole('status')).toHaveText('Your password is removed: your passkeys alone sign you in.');
    await expect(card.getByText('You have no password: your passkeys alone sign you in.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Password' }).getByText(/^You have no password: your passkeys sign you in\./)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Two-factor sign-in' })).toHaveCount(0);
    await shoot(page, card, 'profile-passkeys-alone');
    const told = await mail.waitFor(rhea.email, (m) => m.headers.get('subject') === 'Your a4a password was removed');
    expect(told.text).toMatch(/from now on, passkeys alone sign you in/);

    // Her password no longer signs her in, and the sign-in page says why; her passkey does.
    await device.present(false);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel('Login').fill(rhea.login);
    await page.getByLabel('Password').fill(rhea.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('This account signs in with a passkey');
    await shoot(page, page.getByRole('main'), 'sign-in-passkeys-only');
    await device.present(true);
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click({ timeout: 5_000 }).catch(() => {});
    await expect(page).toHaveURL(/\/issues$/);
    expect(watch.unexpected()).toEqual([]);
    await context.close();
  } finally {
    await admin.page.request.patch('/api/v1/settings', { data: { requirePasskeys: 'off' }, headers: { origin: server.url } });
  }
  expect(admin.watch.unexpected()).toEqual([]);
  await admin.context.close();
});

test('an administrator makes an account with no password, and its mailed link adds the first passkey', async ({ browser }) => {
  test.setTimeout(180_000);
  const admin = await adminWithPasskey(browser);
  const sam = { login: 'sam', name: 'Sam Setup', email: 'sam@corp.example' };
  await admin.page.goto('/admin');
  const people = admin.page.getByRole('region', { name: 'People', exact: true });
  const form = people.getByRole('group', { name: 'Add someone' });
  await form.getByLabel('Name').fill(sam.name);
  await form.getByLabel('Login').fill(sam.login);
  await form.getByLabel('Email').fill(sam.email);
  await form.getByLabel('No password: they add a passkey from a link you send').check();
  await expect(form.getByLabel('Password', { exact: true })).toBeDisabled();
  await form.getByRole('button', { name: 'Add them' }).click();
  await expect(form.getByRole('status')).toHaveText('Sam Setup is added, as sam. A link to add their passkey went to their email.');
  const row = people.getByRole('row').filter({ hasText: sam.login });
  await expect(row).toContainText('Passkeys alone');
  await expect(row).toContainText(/a link to add one runs out in \d+ days/);
  await shoot(admin.page, people, 'admin-passkeys-alone');
  const sent = await mail.waitFor(sam.email, (m) => m.headers.get('subject') === 'Add a passkey to sign in to a4a');
  expect(sent.text).toContain('made you an a4a account, sam.');
  const link = /http:\/\/localhost:\d+(\/passkey-setup#a4k_[A-Za-z0-9_-]+)/.exec(sent.text)![1]!;

  // Someone with no email: their link is shown, once, to hand over.
  const tia = await admin.page.request.post('/api/v1/users', { data: { login: 'tia', name: 'Tia Handed', passkeysOnly: true }, headers: { origin: server.url } });
  expect(tia.status(), await tia.text()).toBe(201);
  await admin.page.reload();
  const tiaRow = people.getByRole('row').filter({ hasText: 'tia' });
  await tiaRow.getByRole('button', { name: 'Send a link to Tia Handed, to add a passkey' }).click();
  await expect(tiaRow.getByRole('textbox', { name: 'Give Tia Handed this link: it works once, for three days.' })).toHaveValue(/\/passkey-setup#a4k_[A-Za-z0-9_-]{43}$/);
  await shoot(admin.page, people, 'admin-shown-link');

  // Opened in the administrator's browser, the link says it's someone else's and asks to sign out.
  await admin.page.goto(link);
  await expect(admin.page.getByRole('alert')).toHaveText('You’re signed in as admin, and this link is for sam. Sign out first.');
  await shoot(admin.page, admin.page.getByRole('main'), 'passkey-setup-wrong-person');

  // In Sam's own browser, it adds the passkey, and signs Sam in.
  const context = await browser.newContext({ baseURL: server.url, locale: 'en-GB', viewport: { width: 1280, height: 900 } });
  const watch = await prepareContext(context);
  // Signed out at first (401); the link, once used, is missing (404).
  watch.allow(/status of 40[14]/);
  const page = await context.newPage();
  await authenticator(page);
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Add a passkey' })).toBeVisible();
  await expect(page.getByText('For Sam Setup (sam). This account has no password: the passkey you add signs you in.')).toBeVisible();
  await expect(page.getByText(/^This link works once, and runs out in \d+ days\.$/)).toBeVisible();
  await shoot(page, page.getByRole('main'), 'passkey-setup');
  await page.getByRole('main').getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page).toHaveURL(/\/issues$/);
  const me = await page.request.get('/api/v1/me');
  expect(((await me.json()) as { login: string }).login).toBe('sam');
  // The link worked once.
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'This link doesn’t work' })).toBeVisible();
  expect(watch.unexpected()).toEqual([]);
  await context.close();
  expect(admin.watch.unexpected()).toEqual([]);
  await admin.context.close();
});
test('a group or a project can require a passkey of its people', async ({ browser }) => {
  test.setTimeout(180_000);
  const admin = await adminWithPasskey(browser);
  const tag = unique();
  const mira = { login: `mira-${tag}`, name: 'Mira Grouped', email: `mira-${tag}@corp.example`, password: 'e2e-mira-pass-1' };
  expect((await admin.page.request.post('/api/v1/users', { data: { ...mira, role: 'member' }, headers: { origin: server.url } })).status()).toBe(201);

  // The group's switch is among its settings; the administrator holding a passkey lets it turn on.
  const made = await admin.page.request.post('/api/v1/groups', { data: { name: `On call ${tag}` }, headers: { origin: server.url } });
  const group = (await made.json()) as { id: string };
  await admin.page.request.post(`/api/v1/groups/${group.id}/members`, { data: { user: mira.login }, headers: { origin: server.url } });
  await admin.page.goto(`/groups/${group.id}`);
  const settings = admin.page.getByRole('region', { name: 'The group' });
  await settings.getByRole('checkbox', { name: 'Require a passkey of its people' }).check();
  await settings.getByRole('button', { name: 'Save the group' }).click();
  await expect(settings.getByRole('status')).toHaveText('Saved.');
  await settled(admin.page);
  // No axe here: the group page's live queries crash axe's frame analysis; the shots still catch layout drift.
  await admin.page.screenshot({ path: test.info().outputPath('group-passkey-requirement-light.png'), fullPage: true });
  await expectNoSidewaysScroll(admin.page);

  // Mira's password sign-in now owes one, and adds it before her session starts.
  const context = await browser.newContext({ baseURL: server.url, locale: 'en-GB', viewport: { width: 1280, height: 900 } });
  const watch = await prepareContext(context);
  const page = await context.newPage();
  const device = await authenticator(page, { synced: true });
  await device.present(false);
  await page.goto('/login');
  await page.getByLabel('Login').fill(mira.login);
  await page.getByLabel('Password').fill(mira.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Add a passkey to sign in' })).toBeVisible();
  await device.present(true);
  await page.getByRole('main').getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page).toHaveURL(/\/issues$/);
  await mail.waitFor(mira.email, (m) => m.headers.get('subject') === 'A passkey was added to your a4a account');
  expect(watch.unexpected()).toEqual([]);
  await context.close();

  // A project's own switch, on its page, reaching everyone who can see it.
  expect(
    (await admin.page.request.post('/api/v1/projects', { data: { key: `PK${tag.toUpperCase()}`, name: 'Passkey Guards' }, headers: { origin: server.url } })).status(),
  ).toBe(201);
  await admin.page.goto(`/projects/PK${tag.toUpperCase()}`);
  const passkeys = admin.page.getByRole('region', { name: 'Passkeys' });
  await passkeys.getByRole('checkbox', { name: 'Require a passkey of everyone who can see this project' }).check();
  await expect(passkeys.getByRole('checkbox', { name: 'Require a passkey of everyone who can see this project' })).toBeChecked();
  await settled(admin.page);
  await admin.page.screenshot({ path: test.info().outputPath('project-passkey-requirement-light.png'), fullPage: true });
  await expectNoSidewaysScroll(admin.page);
  await admin.page.reload();
  await expect(admin.page.getByRole('region', { name: 'Passkeys' }).getByRole('checkbox', { name: 'Require a passkey of everyone who can see this project' })).toBeChecked();
  expect(admin.watch.unexpected()).toEqual([]);
  await admin.context.close();
});
