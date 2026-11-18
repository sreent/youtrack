/**
 * A GitHub App across its installations, and check runs on pull requests (docs/architecture.md, D66).
 * An administrator gives an integration that isn't named after a repository an app installed on two
 * accounts (support/github.ts): no question which, and the card lists both installations with their
 * accounts. Check runs are off by default; turning them on asks GitHub whether the app may write them,
 * and the page says how to let it when it may not; then each issue's state is added, and it stays.
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

test('an app on two accounts reads each through its own installation, and reports to pull requests as check runs', async ({ page, watch }, info) => {
  // Turning checks on before the app may write them is answered with a 400, which the browser logs.
  watch.allow(/status of 400/);
  const tag = unique();
  const github = await startGithub({
    id: 97531,
    slug: 'a4a-checks',
    installations: [
      { id: 5101, account: `acme-${tag}`, type: 'Organization', repositories: [`acme-${tag}/backend`] },
      { id: 5102, account: `beta-${tag}`, type: 'User', repositories: [`beta-${tag}/site`] },
    ],
  });
  try {
    await page.goto('/integrations');
    const add = page.getByRole('region', { name: 'Add an integration' });
    await add.getByRole('radio', { name: 'GitHub', exact: true }).check();
    const name = `Acme and Beta ${tag}`;
    await add.getByLabel('Name', { exact: true }).fill(name);
    await add.getByRole('button', { name: 'Add the integration' }).click();
    await add.getByRole('button', { name: "I've kept it" }).click();

    const card = page.getByRole('listitem').filter({ hasText: name });
    await card.getByRole('button', { name: 'Read as a GitHub App' }).click();
    const form = card.getByRole('form', { name: 'Read as a GitHub App' });
    await form.getByLabel('App ID').fill('97531');
    await form.getByLabel('Private key').fill(github.privateKey);
    await form.getByLabel('GitHub Enterprise Server’s API address').fill(github.url);
    await form.getByRole('button', { name: 'Save the app' }).click();
    await expect(card.getByRole('status').filter({ hasText: `Saved: a4a reads as the GitHub App a4a-checks, installed on acme-${tag}.` })).toBeVisible();

    // Both installations, by account: each repository is read through its own.
    await expect(card.getByText('Each repository is read through its own installation. The app is installed on 2 accounts:')).toBeVisible();
    const installations = card.getByRole('list', { name: 'The app’s installations' }).getByRole('listitem');
    await expect(installations).toHaveCount(2);
    await expect(installations.nth(0)).toContainText(`acme-${tag}`);
    await expect(installations.nth(0)).toContainText('organization');
    await expect(installations.nth(1)).toContainText(`beta-${tag}`);
    await expect(installations.nth(1)).toContainText('user');
    await expect(installations.nth(1)).toContainText('nothing read through it yet');

    // Check runs: off by default, said to whoever sees the repository, and needing a permission the app hasn't yet.
    const checks = card.getByRole('group', { name: 'Check runs on pull requests' });
    const on = checks.getByRole('checkbox', { name: 'Report to each pull request as a check run named “a4a”' });
    const states = checks.getByRole('checkbox', { name: 'Say each issue’s state' });
    await expect(on).not.toBeChecked();
    await expect(states).toBeDisabled();
    await expect(card.getByText(/^They take the app’s Checks: Read and write/)).toBeVisible();
    await expect(card.getByText(/^Whoever sees the repository reads its check runs, perhaps everyone/)).toBeVisible();
    await on.click();
    await expect(card.getByText(/The app may not write checks\. In the app’s settings on GitHub, give it Checks: Read and write/)).toBeVisible();
    await expect(on).not.toBeChecked();

    // Given the permission on GitHub, it turns on, and the state can be added.
    github.installations[0]!.checks = true;
    await on.click();
    await expect(card.getByRole('status').filter({ hasText: 'Check runs are on: each pull request gets one when it next changes.' })).toBeVisible();
    await expect(on).toBeChecked();
    await expect(states).toBeEnabled();
    await states.click();
    await expect(card.getByRole('status').filter({ hasText: 'Saved: open pull requests’ check runs are written again.' })).toBeVisible();
    await expect(states).toBeChecked();
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
    await card.scrollIntoViewIfNeeded();
    await shoot(page, info, 'github-checks');

    // Kept as saved, and from the keyboard: the rule is a checkbox like the others.
    await page.reload();
    await expect(states).toBeChecked();
    const rule = checks.getByRole('checkbox', { name: 'Fail while an issue it names isn’t resolved, or an id names none' });
    await rule.focus();
    await page.keyboard.press('Space');
    await expect(card.getByRole('status').filter({ hasText: 'Saved: open pull requests’ check runs are written again.' })).toBeVisible();
    await expect(rule).toBeChecked();
  } finally {
    await github.close();
  }
});
