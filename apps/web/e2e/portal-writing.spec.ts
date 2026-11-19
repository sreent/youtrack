/**
 * A requester's own writing on the portal (docs/architecture.md, D39 and D59): their reply in the
 * editor everyone writes in, a pasted picture kept on the request and shown to them, and writing
 * help whose streamed draft they accept, the saved words saying the assistant drafted them. The AI
 * is stood in for (D20), on the run's own server with its own mail, as D63's spec.
 */
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { aiOn } from './support/ai';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { expect, test } from './support/fixtures';
import { message, postMail } from './support/helpdesk';
import { startMailServer, startMailingServer, type MailingServer, type MailServer } from './support/mail';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let mail: MailServer;
let server: MailingServer;
let team: BrowserContext;
let page: Page;
let call: <T>(method: string, path: string, data?: unknown) => Promise<T>;
let key: string;
let email: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  mail = await startMailServer();
  server = await startMailingServer(mail.port);
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
    const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers: { authorization: `Bearer ${token}`, ...(method !== 'GET' ? { origin: server.url } : {}) } });
    expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBe(true);
    return (res.status() === 204 ? null : await res.json()) as T;
  };
  key = `PW${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  email = 'rosa@desk.example';
  const address = `${key.toLowerCase()}@desk.example`;
  await call('POST', '/projects', { key, name: `Portal writing ${key}`, template: 'software' });
  await call('PATCH', `/projects/${key}`, { settings: { helpdesk: { enabled: true } } });
  await call('PUT', `/projects/${key}/helpdesk/mail`, { address });
  const { url } = await call<{ url: string }>('POST', `/projects/${key}/helpdesk/mail/secret`);
  expect((await postMail(url, message({ from: email, to: address, subject: 'Invoices print twice', body: 'Since Monday, the June invoice prints twice.' }))).status).toBe(200);
});

test.afterAll(async () => {
  await team?.close();
  await server?.close();
  await mail?.close();
});

test("a requester replies in the editor, with a pasted picture, and takes the assistant's streamed draft", async ({ browser }) => {
  test.setTimeout(120_000);
  await call('POST', '/portal/sign-in', { email });
  const sent = await mail.waitFor(email, (m) => /#hdl_/.test(m.text));
  const link = /(\/portal#hdl_[A-Za-z0-9_-]{43})/.exec(sent.text)![1]!;
  const ctx = await browser.newContext({ baseURL: server.url, locale: 'en-GB', viewport: { width: 1280, height: 900 } });
  const rp = await ctx.newPage();
  await aiOn(rp);
  await rp.goto(link);
  await expect(rp.getByRole('heading', { name: 'Your requests' })).toBeVisible();
  await rp.route('**/api/v1/portal/write/stream', async (route) => {
    const frames = [
      'event: draft\ndata: {"text":"Hello, thanks for telling us."}\n\n',
      'event: done\ndata: {"text":"Hello, thanks for telling us. Could you send a copy of the June invoice?","model":"stand-in"}\n\n',
    ].join('');
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: frames });
  });
  await rp.getByRole('button', { name: /Invoices print twice/ }).click();
  await expect(rp.getByRole('heading', { name: 'Invoices print twice' })).toBeVisible();

  // The composer is the editor everyone writes in: its bar and its switch.
  const composer = rp.getByRole('textbox', { name: 'Your reply' });
  await expect(composer).toBeVisible();
  await expect(rp.getByRole('button', { name: 'Bold' })).toBeVisible();
  await expect(rp.getByRole('group', { name: 'How to write it' })).toBeVisible();

  // A pasted picture uploads to the request, and reads in the reply once it's sent.
  await composer.evaluate(
    (el, b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], 'invoice.png', { type: 'image/png' }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    },
    PNG,
  );
  await expect(rp.getByText(/invoice\.png/)).toBeVisible({ timeout: 15_000 });

  // Writing help: the whole text drafted, streamed, accepted; the saved words say the assistant drafted them.
  await rp.getByRole('button', { name: 'Writing help' }).click();
  await rp.getByRole('button', { name: 'Draft the comment from it' }).click();
  const card = rp.getByRole('region', { name: 'A draft' });
  await expect(card).toBeVisible();
  await expect(card.getByText(/Could you send a copy/)).toBeVisible();
  await card.getByRole('button', { name: 'Accept' }).click();
  // The accepted words are in the field before it's sent, mark and all.
  await expect(composer.getByText(/Could you send a copy/)).toBeVisible();
  await rp.getByRole('button', { name: 'Send the reply' }).click();
  await expect(rp.getByText('The assistant drafted these words.')).toBeVisible();
  await expect(rp.getByText(/Could you send a copy/)).toBeVisible();
  await expectNoSidewaysScroll(rp);
  await expectAccessible(rp);
  await ctx.close();
});
