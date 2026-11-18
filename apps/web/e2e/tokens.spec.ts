/**
 * Agents and tokens: a token is shown once and works until it's revoked; the MCP setup for each
 * kind of client carries this server's address and the token, exactly; and a token limited to
 * some projects sees only those.
 */
import type { ApiToken } from '@a4a/shared';
import { unique, uniqueKey } from './support/api';
import { BASE_URL } from './support/env';
import { expect, test } from './support/fixtures';

test('a token is shown once, works, and stops working once revoked', async ({ page, api, request }) => {
  const name = `cursor-${unique()}`;
  await page.goto('/agents');
  const connect = page.getByRole('region', { name: 'Connect an agent' });
  await connect.getByLabel('Name').fill(name);
  // Read-only: the safe way to let an agent explore.
  await connect.getByRole('checkbox', { name: /^write/ }).uncheck();
  await expect(connect.getByRole('checkbox', { name: /^read/ })).toBeChecked();
  await connect.getByRole('button', { name: 'Create the token' }).click();

  const shown = connect.getByRole('status').filter({ hasText: 'Copy it now.' });
  await expect(shown).toContainText(`This is the only time a4a shows the token ${name}`);
  const token = (await shown.getByRole('code').textContent())!;
  expect(token).toMatch(/^a4a_[\w-]{20,}$/);

  const made = (await api.get<ApiToken[]>('/me/tokens')).find((t) => t.name === name)!;
  expect([made.scopes, Boolean(made.expiresAt)]).toEqual([['read'], true]);
  const asAgent = (path: string) => request.get(`/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
  // Every project it can see (no limit to some of them), read-only.
  expect((await (await asAgent('/me')).json()).auth).toEqual({ method: 'token', scopes: ['read'], tokenName: name, projects: null });

  // Once kept, it's never shown again: only its first letters, to tell it apart.
  await shown.getByRole('button', { name: "I've kept it" }).click();
  await expect(shown).toBeHidden();
  await page.reload();
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toContainText(`${made.prefix}…`);
  await expect(page.getByText(token)).toHaveCount(0);

  // Revoking asks first; the safe answer has the focus, and Escape keeps it.
  await row.getByRole('button', { name: 'Revoke it' }).click();
  const confirm = page.getByRole('dialog', { name: `Revoke the token ${name}?` });
  await expect(confirm.getByRole('button', { name: 'Keep it' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  expect((await asAgent('/me')).status()).toBe(200);

  await row.getByRole('button', { name: 'Revoke it' }).click();
  await confirm.getByRole('button', { name: 'Revoke it' }).click();
  await expect(page.getByRole('status').filter({ hasText: `The token ${name} is revoked.` })).toBeVisible();
  await expect(row).toBeHidden();
  expect((await asAgent('/me')).status()).toBe(401);
});

test('the MCP setup for each client carries this server and the token', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const name = `claude-code-${unique()}`;
  await page.goto('/agents');
  const connect = page.getByRole('region', { name: 'Connect an agent' });
  const which = connect.getByRole('group', { name: 'Which agent' });

  // Before there's a token, the setup shows where it will go.
  await expect(which.getByRole('button', { name: 'Claude Code' })).toHaveAttribute('aria-pressed', 'true');
  await expect(connect.getByLabel('For Claude Code')).toHaveText(`claude mcp add --transport http a4a ${BASE_URL}/mcp --header "Authorization: Bearer a4a_your_token"`);

  await connect.getByLabel('Name').fill(name);
  await connect.getByRole('button', { name: 'Create the token' }).click();
  const token = (await connect.getByRole('status').filter({ hasText: 'Copy it now.' }).getByRole('code').textContent())!;

  await expect(connect.getByLabel('For Claude Code')).toHaveText(`claude mcp add --transport http a4a ${BASE_URL}/mcp --header "Authorization: Bearer ${token}"`);
  await expect(connect.getByText(`It has the token ${name} in it.`)).toBeVisible();

  await which.getByRole('button', { name: 'Cursor and other HTTP clients' }).click();
  const http = JSON.parse((await connect.getByLabel('For Cursor and other HTTP clients').textContent())!);
  expect(http).toEqual({ mcpServers: { a4a: { url: `${BASE_URL}/mcp`, headers: { Authorization: `Bearer ${token}` } } } });

  await which.getByRole('button', { name: 'Claude Desktop' }).click();
  await expect(which.getByRole('button', { name: 'Claude Desktop' })).toHaveAttribute('aria-pressed', 'true');
  const desktop = JSON.parse((await connect.getByLabel('For Claude Desktop').textContent())!);
  expect(desktop).toEqual({ mcpServers: { a4a: { command: 'node', args: ['/path/to/a4a/packages/mcp-bridge/dist/index.js'], env: { A4A_URL: BASE_URL, A4A_TOKEN: token } } } });

  // Copying it puts exactly that on the clipboard.
  await connect.getByRole('button', { name: 'Copy it' }).click();
  await expect(connect.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toEqual(desktop);
});

test('a token limited to some projects sees those, and no others', async ({ page, api, request }) => {
  const name = `docs-bot-${unique()}`;
  const key = uniqueKey('TK');
  const other = uniqueKey('TX');
  await api.createProject({ key, name: `API guide ${key}` });
  await api.createProject({ key: other, name: `Elsewhere ${other}` });
  const inside = await api.createIssue({ project: key, summary: 'Write the pagination section' });
  const outside = await api.createIssue({ project: other, summary: 'Not for the docs bot' });

  await page.goto('/agents');
  const connect = page.getByRole('region', { name: 'Connect an agent' });
  await connect.getByLabel('Name').fill(name);
  await connect.getByRole('radio', { name: /^Only some projects/ }).check();
  await expect(connect.getByText('Choose at least one project.')).toBeVisible();
  await expect(connect.getByRole('button', { name: 'Create the token' })).toBeDisabled();
  await connect.getByRole('group', { name: 'Its projects' }).getByRole('checkbox', { name: new RegExp(`^${key} `) }).check();
  await connect.getByRole('button', { name: 'Create the token' }).click();
  const token = (await connect.getByRole('status').filter({ hasText: 'Copy it now.' }).getByRole('code').textContent())!;
  await expect(page.getByRole('row').filter({ hasText: name })).toContainText(key);

  const asAgent = (path: string) => request.get(`/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
  expect((await (await asAgent('/me')).json()).auth.projects).toEqual([key]);
  expect((await asAgent(`/issues/${inside.id}`)).status()).toBe(200);
  // Another project's issue doesn't exist for it.
  expect((await asAgent(`/issues/${outside.id}`)).status()).toBe(404);
});
