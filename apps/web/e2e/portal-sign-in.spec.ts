/**
 * The portal's own sign-in (docs/architecture.md, D63). A desk that takes passwords: its requester
 * asks for a link to set one, sets it from the email, signs out and back in with it, and sees their
 * requests. And a desk that offers its customer's identity provider: the requester signs in through
 * it (a provider on this machine, support/idp.ts) and sees theirs; one whose email the provider
 * hasn't verified is told so. Light, dark and at 390px.
 *
 * The run's own server sends no email (playwright.config.ts), so these run on a server of their own
 * that does, beside a mail server (support/mail.ts), as D56's and D57's specs do.
 */
import type { BrowserContext, Page } from '@playwright/test';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { expect, prepareContext, test } from './support/fixtures';
import { message, postMail } from './support/helpdesk';
import { startIdp, type FakeIdp } from './support/idp';
import { startMailServer, startMailingServer, type MailingServer, type MailServer } from './support/mail';

let mail: MailServer;
let server: MailingServer;
let idp: FakeIdp;
let team: BrowserContext;
let page: Page;
let call: <T>(method: string, path: string, data?: unknown) => Promise<T>;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  mail = await startMailServer();
  server = await startMailingServer(mail.port);
  idp = await startIdp();
  team = await browser.newContext({ baseURL: server.url, locale: 'en-GB', viewport: { width: 1280, height: 900 } });
  page = await team.newPage();
  await page.goto('/login');
  await page.getByLabel('Login').fill(server.admin.login);
  await page.getByLabel('Password').fill(server.admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/issues$/);
  const made = await page.request.post('/api/v1/me/tokens', { data: { name: 'e2e', scopes: ['read', 'write', 'admin'] }, headers: { origin: server.url } });
  expect(made.status(), await made.text()).toBe(201);
  const { token } = (await made.json()) as { token: string };
  call = async <T>(method: string, path: string, data?: unknown): Promise<T> => {
    const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers: { authorization: `Bearer ${token}` } });
    expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBe(true);
    return (res.status() === 204 ? null : await res.json()) as T;
  };
});

test.afterAll(async () => {
  await team?.close();
  await server?.close();
  await mail?.close();
  await idp?.close();
});

/** A desk that takes requests by email, and a request in it from `from`. */
async function deskWithRequest(key: string, from: string, subject: string) {
  const address = `${key.toLowerCase()}@desk.example`;
  await call('POST', '/projects', { key, name: `Desk ${key}`, template: 'software' });
  await call('PATCH', `/projects/${key}`, { settings: { helpdesk: { enabled: true } } });
  await call('PUT', `/projects/${key}/helpdesk/mail`, { address });
  const { url } = await call<{ url: string }>('POST', `/projects/${key}/helpdesk/mail/secret`);
  expect((await postMail(url, message({ from, to: address, subject, body: 'Since this morning.' }))).status).toBe(200);
}

/** Light, dark and on a phone: axe finds nothing, and nothing scrolls sideways. */
async function inEveryLight(p: Page, name: string, ready: () => Promise<void>) {
  for (const [colorScheme, width] of [['light', 1280], ['dark', 1280], ['light', 390]] as const) {
    await p.emulateMedia({ colorScheme });
    await p.setViewportSize({ width, height: 900 });
    await ready();
    await p.screenshot({ path: test.info().outputPath(`${name}-${colorScheme}-${width}.png`) });
    await expectAccessible(p);
    await expectNoSidewaysScroll(p);
  }
  await p.emulateMedia({ colorScheme: 'light' });
  await p.setViewportSize({ width: 1280, height: 900 });
}

test('a desk takes passwords: a requester sets one from the emailed link, signs out and back in with it, and sees their requests', async ({ browser }) => {
  test.setTimeout(180_000);
  await deskWithRequest('PWD', 'Nora <nora@example.org>', 'The printer is jammed');
  await mail.waitFor('nora@example.org', (m) => (m.headers.get('subject') ?? '').includes('The printer is jammed'));

  // The desk's manager chooses passwords beside the emailed link, on the desk's page.
  await page.goto('/projects/PWD');
  const card = page.getByRole('region', { name: 'How requesters sign in' });
  await expect(card.getByRole('checkbox', { name: /A link emailed to them/ })).toBeChecked();
  await card.getByRole('checkbox', { name: /A password/ }).check();
  await card.getByRole('button', { name: 'Save how requesters sign in' }).click();
  await expect(card.getByText('Saved. A session opened another way no longer opens this desk’s requests.')).toBeVisible();
  await inEveryLight(page, 'desk-passwords', () => expect(card.getByRole('checkbox', { name: /A password/ })).toBeChecked());

  const portal = await browser.newContext({ baseURL: server.url, locale: 'en-GB', viewport: { width: 1280, height: 900 } });
  const watch = await prepareContext(portal);
  try {
    const nora = await portal.newPage();
    await nora.goto('/portal?desk=PWD');
    await expect(nora.getByText('Sign in with your password, or with a link we email you.')).toBeVisible();
    await inEveryLight(nora, 'sign-in', () => expect(nora.getByRole('button', { name: 'Set or reset my password' })).toBeVisible());
    await nora.getByRole('textbox', { name: 'Your email' }).fill('nora@example.org');
    await nora.getByRole('button', { name: 'Set or reset my password' }).click();
    await expect(nora.getByRole('status')).toHaveText('If nora@example.org can have a password here, a link to set it is on its way. It works once, for 20 minutes.');

    // From the email: she chooses a password, and is signed in with it.
    const link = await mail.waitFor('nora@example.org', (m) => /#hdp_/.test(m.text));
    expect(link.headers.get('subject')).toBe("Set a password for Desk PWD's help desk");
    await nora.goto(/(\/portal\?desk=PWD#hdp_[A-Za-z0-9_-]{43})/.exec(link.text)![1]!);
    await expect(nora.getByRole('heading', { name: 'Choose a password' })).toBeVisible();
    await inEveryLight(nora, 'choose-password', () => expect(nora.getByLabel('New password')).toBeVisible());
    await nora.getByLabel('New password').fill('a long portal password');
    await nora.getByRole('button', { name: 'Set the password' }).click();
    await expect(nora.getByRole('button', { name: 'The printer is jammed' })).toBeVisible();
    await expect(nora.getByText('You signed in with your password.')).toBeVisible();
    await mail.waitFor('nora@example.org', (m) => m.text.includes('A password was set for nora@example.org'));

    // Out, and back in with it.
    await nora.getByRole('button', { name: 'Sign out' }).click();
    await expect(nora.getByRole('textbox', { name: 'Your email' })).toBeVisible();
    await nora.getByRole('textbox', { name: 'Your email' }).fill('nora@example.org');
    await nora.getByLabel('Password', { exact: true }).fill('a long portal password');
    await nora.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(nora.getByRole('button', { name: 'The printer is jammed' })).toBeVisible();
    await inEveryLight(nora, 'signed-in', () => expect(nora.getByRole('heading', { name: 'How you sign in' })).toBeVisible());
    await nora.getByRole('button', { name: 'The printer is jammed' }).click();
    await expect(nora.getByRole('list', { name: 'The request, and the replies to it' })).toContainText('Since this morning.');
    expect(watch.unexpected()).toEqual([]);
  } finally {
    await portal.close();
  }
});

test('a desk offers its customer’s identity provider: a requester signs in through it and sees their requests', async ({ browser }) => {
  test.setTimeout(180_000);
  await deskWithRequest('SSO', 'Omar <omar@acme.example>', 'Badge reader is down');
  await mail.waitFor('omar@acme.example', (m) => (m.headers.get('subject') ?? '').includes('Badge reader is down'));

  // An administrator adds Acme's provider on the desk's page, and the desk offers it.
  await page.goto('/projects/SSO');
  const card = page.getByRole('region', { name: 'How requesters sign in' });
  await card.getByRole('button', { name: 'Add a provider' }).click();
  const form = card.getByRole('form', { name: 'Add a provider' });
  await form.getByLabel('Name').fill('Acme SSO');
  await form.getByLabel('Issuer').fill(idp.url);
  await form.getByLabel('Client ID').fill(idp.clientId);
  await form.getByLabel('Client secret').fill(idp.clientSecret);
  await form.getByLabel('Email domains').fill('acme.example');
  await form.getByRole('button', { name: 'Add a provider' }).click();
  await expect(card.getByText('Acme SSO is added: a desk can offer it now.')).toBeVisible();
  await card.getByRole('checkbox', { name: /Through Acme SSO/ }).check();
  await card.getByRole('button', { name: 'Save how requesters sign in' }).click();
  await expect(card.getByText('Saved. A session opened another way no longer opens this desk’s requests.')).toBeVisible();
  await expect(card.getByRole('list', { name: 'Identity providers for requesters' })).toContainText('1 desk offers it');
  await inEveryLight(page, 'desk-provider', () => expect(card.getByRole('checkbox', { name: /Through Acme SSO/ })).toBeChecked());

  const portal = await browser.newContext({ baseURL: server.url, locale: 'en-GB', viewport: { width: 1280, height: 900 } });
  const watch = await prepareContext(portal);
  try {
    const omar = await portal.newPage();
    // The provider hasn't verified his email: he's told, and nothing opens.
    idp.person = { sub: 'omar-1', email: 'omar@acme.example', email_verified: false, name: 'Omar Haddad' };
    await omar.goto('/portal?desk=SSO');
    await omar.getByRole('link', { name: 'Sign in through Acme SSO' }).click();
    await expect(omar.getByRole('alert')).toContainText('Your identity provider hasn’t verified your email address');
    await inEveryLight(omar, 'unverified', () => expect(omar.getByRole('alert')).toBeVisible());
    // Verified, he's in, and sees his request.
    idp.person = { ...idp.person, email_verified: true };
    await omar.goto('/portal?desk=SSO');
    await omar.getByRole('link', { name: 'Sign in through Acme SSO' }).click();
    await expect(omar).toHaveURL(/\/portal\?desk=SSO$/);
    await expect(omar.getByRole('button', { name: 'Badge reader is down' })).toBeVisible();
    await expect(omar.getByText('You signed in through Acme SSO.')).toBeVisible();
    await inEveryLight(omar, 'through-provider', () => expect(omar.getByRole('button', { name: 'Badge reader is down' })).toBeVisible());
    await mail.waitFor('omar@acme.example', (m) => m.text.includes('Acme SSO signed you in to the help desk'));
    expect(watch.unexpected()).toEqual([]);
  } finally {
    await portal.close();
  }
});
