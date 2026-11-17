/**
 * Webhooks: one is added for some events, sent a test that arrives signed at a receiver this
 * file starts, and its delivery shows; one is paused, and stays paused with its events (a PATCH
 * once reset what it didn't send).
 */
import { createHmac } from 'node:crypto';
import type { Webhook } from '@a4a/shared';
import { unique } from './support/api';
import { SECOND_AUTH_FILE } from './support/env';
import { expect, test } from './support/fixtures';
import { startReceiver } from './support/receiver';

// The second of the flows' administrators (support/env.ts says why).
test.use({ storageState: SECOND_AUTH_FILE });

let receiver: Awaited<ReturnType<typeof startReceiver>>;

test.beforeAll(async () => {
  receiver = await startReceiver();
});

test.afterAll(async () => {
  await receiver?.close();
});

test('a webhook is added for some events, sent a test that arrives signed, and its delivery shows', async ({ page }) => {
  const path = `/hooks/${unique()}`;
  const url = receiver.url(path);
  await page.goto('/webhooks');
  const add = page.getByRole('region', { name: 'Add a webhook' });
  await add.getByLabel('Where to send').fill(url);
  await add.getByRole('checkbox', { name: 'Every change, including kinds added later' }).uncheck();
  await add.getByRole('checkbox', { name: /^An issue changes/ }).uncheck();
  await expect(add.getByRole('checkbox', { name: /^An issue is created/ })).toBeChecked();
  await add.getByRole('checkbox', { name: /^Someone comments/ }).check();
  await add.getByRole('button', { name: 'Add the webhook' }).click();

  const shown = add.getByRole('status').filter({ hasText: 'Copy its secret now.' });
  const secret = (await shown.getByRole('code').textContent())!;
  expect(secret).toMatch(/^whsec_/);

  const hook = page.getByRole('listitem').filter({ hasText: url });
  await expect(hook).toContainText('When an issue is created, or someone comments · in every project · added just now');
  await expect(hook.getByText('sends', { exact: true })).toBeVisible();

  await hook.getByRole('button', { name: 'Send a test' }).click();
  await expect(hook.getByRole('status').filter({ hasText: 'The test arrived.' })).toBeVisible();
  await expect(hook.getByRole('button', { name: 'Hide its deliveries' })).toHaveAttribute('aria-expanded', 'true');
  const deliveries = hook.getByRole('region', { name: 'Table of recent deliveries' });
  await expect(deliveries.getByRole('row').filter({ hasText: 'a test' })).toContainText('delivered, 200');

  // It arrived signed with the secret shown once: an HMAC-SHA256 of the raw body.
  const got = receiver.received.filter((d) => d.path === path);
  expect(got).toHaveLength(1);
  const [delivery] = got;
  expect(delivery!.headers['x-a4a-signature']).toBe(`sha256=${createHmac('sha256', secret).update(delivery!.body).digest('hex')}`);
  expect(delivery!.headers['x-a4a-delivery']).toBeTruthy();
});

test('a paused webhook stays paused, and keeps its events', async ({ page, api }) => {
  const url = receiver.url(`/hooks/${unique()}`);
  const made = await api.post<Webhook>('/webhooks', { url, events: ['issue.created', 'comment.created'] });
  await page.goto('/webhooks');
  const hook = page.getByRole('listitem').filter({ hasText: url });
  await expect(hook.getByText('sends', { exact: true })).toBeVisible();

  await hook.getByRole('button', { name: 'Pause it' }).click();
  await expect(hook.getByRole('status').filter({ hasText: 'It is paused: nothing is sent until you turn it back on.' })).toBeVisible();
  await expect(hook.getByText('paused', { exact: true })).toBeVisible();

  // As saved, not only as shown.
  await page.reload();
  await expect(hook.getByText('paused', { exact: true })).toBeVisible();
  await expect(hook).toContainText('When an issue is created, or someone comments');
  let saved = (await api.webhooks()).find((h) => h.id === made.id)!;
  expect([saved.active, saved.events]).toEqual([false, ['issue.created', 'comment.created']]);

  await hook.getByRole('button', { name: 'Turn it back on' }).click();
  await expect(hook.getByText('sends', { exact: true })).toBeVisible();
  saved = (await api.webhooks()).find((h) => h.id === made.id)!;
  expect([saved.active, saved.events]).toEqual([true, ['issue.created', 'comment.created']]);
});
