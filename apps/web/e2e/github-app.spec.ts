/**
 * GitHub as an App (docs/architecture.md, D54). An administrator adds a GitHub integration, reads
 * how to point a GitHub App's own webhook at it, and gives it the app, from a GitHub on this machine
 * (support/github.ts): a key GitHub refuses says so; the right one is checked, its installation
 * found from the repository, and the card says it reads as the app. A test takes a token as it, the
 * key is never shown again, and the integration stops reading as the app.
 */
import type { Page, TestInfo } from '@playwright/test';
import { unique } from './support/api';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { THIRD_AUTH_FILE } from './support/env';
import { expect, test } from './support/fixtures';
import { startGithub } from './support/github';

// The third of the flows' administrators (support/env.ts says why).
test.use({ storageState: THIRD_AUTH_FILE });

/** The page in light and dark, and at 390px, where nothing may spill sideways: into the report, and beside the test. */
async function shoot(page: Page, info: TestInfo, name: string) {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    const body = await page.screenshot({ fullPage: true, path: info.outputPath(`${name}-${colorScheme}.png`) });
    await info.attach(`${name}-${colorScheme}.png`, { body, contentType: 'image/png' });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  const size = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth), { message: `${name} spills sideways at 390px` }).toBeLessThanOrEqual(390);
  const body = await page.screenshot({ fullPage: true, path: info.outputPath(`${name}-390.png`) });
  await info.attach(`${name}-390.png`, { body, contentType: 'image/png' });
  if (size) await page.setViewportSize(size);
}

test('an administrator gives a GitHub integration a GitHub App to read as, instead of a person’s token', async ({ page, watch }, info) => {
  // The key GitHub refuses is answered with a 400, which the browser logs.
  watch.allow(/status of 400/);
  const repository = `acme/${unique()}`;
  const github = await startGithub({ id: 98765, slug: 'a4a-e2e', installation: { id: 4321, account: 'acme', repositories: [repository] } });
  try {
    await page.goto('/integrations');
    const add = page.getByRole('region', { name: 'Add an integration' });
    await add.getByRole('radio', { name: 'GitHub', exact: true }).check();
    await add.getByLabel('Name', { exact: true }).fill(repository);
    await add.getByRole('button', { name: 'Add the integration' }).click();
    // The steps say how a GitHub App's own webhook can be this integration's: its URL and secret.
    const shown = add.getByRole('status').filter({ hasText: 'Copy the secret now.' });
    await expect(shown).toContainText('Or with a GitHub App’s webhook, which every repository it’s installed on sends to:');
    await expect(shown).toContainText('Webhook URL: the URL above. Webhook secret: the secret above.');
    await expect(shown).toContainText('subscribe to Push, Pull request and Workflow run');
    await add.getByRole('button', { name: "I've kept it" }).click();

    const card = page.getByRole('listitem').filter({ hasText: repository });
    await expect(card.getByText('no access token', { exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'Read as a GitHub App' }).click();
    const form = card.getByRole('form', { name: 'Read as a GitHub App' });
    await form.getByLabel('App ID').fill('98765');
    await form.getByLabel('Private key').fill(github.otherKey);
    await form.getByLabel('GitHub Enterprise Server’s API address').fill(github.url);
    await expect(form.getByText(`the app’s installation on ${repository}, or its only one`)).toBeVisible();
    await form.getByRole('button', { name: 'Save the app' }).click();
    await expect(form.getByRole('alert')).toContainText('GitHub didn’t take the app’s key (401)');
    await expect(form.getByRole('alert')).toContainText('The server’s clock must be right to the minute.');
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
    await card.scrollIntoViewIfNeeded();
    await shoot(page, info, 'github-app-form');

    await form.getByLabel('Private key').fill(github.privateKey);
    await form.getByRole('button', { name: 'Save the app' }).click();
    await expect(card.getByRole('status').filter({ hasText: 'Saved: a4a reads as the GitHub App a4a-e2e, installed on acme.' })).toBeVisible();
    await expect(card.getByText('reads as the GitHub App a4a-e2e, installed on acme', { exact: true })).toBeVisible();
    await expect(card.getByRole('form', { name: 'Read as a GitHub App' })).toHaveCount(0);
    await expectAccessible(page);

    // A test takes a new token as the app, so a removed installation would show now.
    await card.getByRole('button', { name: 'Send a test' }).click();
    await expect(card.getByRole('status').filter({ hasText: 'a4a took a token as the GitHub App a4a-e2e, so it reads as the app.' })).toBeVisible();

    // The key is never shown again.
    await page.reload();
    await expect(card.getByText('reads as the GitHub App a4a-e2e, installed on acme', { exact: true })).toBeVisible();
    await expect(page.getByText(/-----BEGIN/)).toHaveCount(0);

    await card.getByRole('button', { name: 'Stop reading as the app' }).click();
    await page.getByRole('dialog', { name: `Stop reading as the GitHub App for ${repository}?` }).getByRole('button', { name: 'Forget the app' }).click();
    await expect(card.getByRole('status').filter({ hasText: 'a4a no longer reads as the app, and has forgotten its key.' })).toBeVisible();
    await expect(card.getByText('no access token', { exact: true })).toBeVisible();
  } finally {
    await github.close();
  }
});
