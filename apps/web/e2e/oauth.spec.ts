/**
 * An app signs in to a4a's MCP server with OAuth (docs/architecture.md, D28): it registers, sends
 * the person to a4a's consent page, and gets a code back at its own address, which it exchanges
 * for a token that works at /mcp. The person chooses what it may do and where, sees it under
 * Agents and tokens, and revokes it there. The app here is the test, with a receiver of its own
 * standing in for the app's callback.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { uniqueKey } from './support/api';
import { ADMIN, BASE_URL } from './support/env';
import { expect, test } from './support/fixtures';
import { startReceiver } from './support/receiver';

let receiver: Awaited<ReturnType<typeof startReceiver>>;

test.beforeAll(async () => {
  receiver = await startReceiver();
});

test.afterAll(async () => {
  await receiver?.close();
});

/** What an app does before it sends the browser: register, and make a PKCE pair and a state. */
async function anApp(outside: APIRequestContext, name: string) {
  const callback = receiver.url(`/callback/${randomBytes(4).toString('hex')}`);
  const res = await outside.post('/oauth/register', { data: { client_name: name, redirect_uris: [callback] } });
  expect(res.status()).toBe(201);
  const { client_id } = (await res.json()) as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(8).toString('hex');
  const url = new URL(`${BASE_URL}/oauth/authorize`);
  for (const [k, v] of Object.entries({
    response_type: 'code',
    client_id,
    redirect_uri: callback,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state,
    scope: 'read write',
    resource: `${BASE_URL}/mcp`,
  })) {
    url.searchParams.set(k, v);
  }
  return { client_id, callback, verifier, state, url: `${url.pathname}${url.search}` };
}

/** Who the token acts as, over MCP. */
async function whoami(outside: APIRequestContext, token: string) {
  const res = await outside.post('/mcp', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_current_user', arguments: {} } },
  });
  if (res.status() !== 200) return { status: res.status() };
  const body = (await res.json()) as { result: { content: { text: string }[] } };
  return { status: 200, me: JSON.parse(body.result.content[0]!.text) as { login: string; scopes: string[]; token: string; onlyProjects?: string[] } };
}

test('an app signs in with what the person allows, works at /mcp, and stops when they revoke it', async ({ page, api, playwright }) => {
  // The app has no cookie and no token of a4a's: only what OAuth gives it.
  const outside = await playwright.request.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
  try {
    const key = uniqueKey('OA');
    const project = await api.createProject({ key, name: `Agents ${key}` });
    const app = await anApp(outside, 'Claude');

    await page.goto(app.url);
    const card = page.getByRole('main', { name: '“Claude” asks to work in a4a as you' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('The name is its own, and a4a can’t check it · it is a program on this computer');
    await expect(card.getByRole('code')).toHaveText(app.callback);
    const may = card.getByRole('group', { name: 'May' });
    await expect(may.getByRole('checkbox', { name: 'Read issues, boards and plans' })).toBeDisabled();
    await may.getByRole('checkbox', { name: 'Make changes, as you' }).uncheck();
    const where = card.getByRole('group', { name: 'Where' });
    await where.getByRole('radio', { name: 'Only these' }).check();
    await expect(card.getByText('Choose at least one project.')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Allow' })).toBeDisabled();
    await where.getByRole('checkbox', { name: `${key} ${project.name}` }).check();

    await card.getByRole('button', { name: 'Allow' }).click();
    await page.waitForURL((u) => u.href.startsWith(app.callback));
    const back = new URL(page.url());
    expect(back.searchParams.get('state')).toBe(app.state);
    expect(back.searchParams.get('iss')).toBe(BASE_URL);
    const code = back.searchParams.get('code')!;
    expect(code).toMatch(/^a4c_/);

    const exchanged = await outside.post('/oauth/token', {
      form: { grant_type: 'authorization_code', code, code_verifier: app.verifier, client_id: app.client_id, redirect_uri: app.callback, resource: `${BASE_URL}/mcp` },
    });
    expect(exchanged.status()).toBe(200);
    const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string; scope: string };
    expect(tokens.scope).toBe('read');
    const who = await whoami(outside, tokens.access_token);
    expect(who.me).toMatchObject({ scopes: ['read'], token: 'Claude', onlyProjects: [key] });

    // The person sees it beside their tokens, and revokes it.
    await page.goto('/agents');
    const apps = page.getByRole('region', { name: 'Table of the apps you allowed' });
    const row = apps.getByRole('row').filter({ hasText: 'Claude' }).filter({ hasText: key });
    await expect(row).toContainText('back to 127.0.0.1');
    await expect(row).toContainText('read');
    await row.getByRole('button', { name: 'Revoke Claude' }).click();
    await page.getByRole('dialog', { name: 'Revoke Claude?' }).getByRole('button', { name: 'Revoke it' }).click();
    await expect(page.getByText('Claude is revoked: it can’t reach a4a any more.')).toBeVisible();
    expect((await whoami(outside, tokens.access_token)).status).toBe(401);
    const renewed = await outside.post('/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: app.client_id } });
    expect(((await renewed.json()) as { error: string }).error).toBe('invalid_grant');
  } finally {
    await outside.dispose();
  }
});

test('a person who declines sends the app away with nothing', async ({ page, playwright }) => {
  const outside = await playwright.request.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
  try {
    const app = await anApp(outside, 'Unwanted');
    await page.goto(app.url);
    await page.getByRole('main', { name: '“Unwanted” asks to work in a4a as you' }).getByRole('button', { name: 'Decline' }).click();
    await page.waitForURL((u) => u.href.startsWith(app.callback));
    const back = new URL(page.url());
    expect([back.searchParams.get('error'), back.searchParams.get('state'), back.searchParams.get('code')]).toEqual(['access_denied', app.state, null]);
  } finally {
    await outside.dispose();
  }
});

test('a request a4a can’t trust is shown on its page, and goes nowhere', async ({ page, playwright }) => {
  const outside = await playwright.request.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
  try {
    const app = await anApp(outside, 'Elsewhere');
    await page.goto(app.url.replace(encodeURIComponent(app.callback), encodeURIComponent('https://evil.example/callback')));
    await expect(page.getByRole('heading', { name: 'a4a can’t send you back to this app' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('The app asked to send you back to an address it didn’t register.');
    expect(new URL(page.url()).origin).toBe(BASE_URL);
  } finally {
    await outside.dispose();
  }
});

test('someone signed out signs in first, and comes back to the app’s request', async ({ browser, playwright }) => {
  const outside = await playwright.request.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const app = await anApp(outside, 'After sign-in');
    const page = await context.newPage();
    await page.goto(app.url);
    await expect(page).toHaveURL(/\/login\?next=%2Foauth%2Fauthorize/);
    await page.getByLabel('Login').fill(ADMIN.login);
    await page.getByLabel('Password').fill(ADMIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('main', { name: '“After sign-in” asks to work in a4a as you' })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('client_id')).toBe(app.client_id);
  } finally {
    await context.close();
    await outside.dispose();
  }
});
