/**
 * Forgejo accounts people connect (docs/architecture.md, D54). A person signs in at the Forgejo the
 * server is set up with (one on this machine, support/forgejo.ts), comes back to their profile with
 * the account connected, and a push Forgejo matched to that account runs its command as them,
 * though a4a knows no email of theirs. Then they disconnect it.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Page, TestInfo } from '@playwright/test';
import { fieldValue, unique, uniqueKey } from './support/api';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { expect, test } from './support/fixtures';
import { startForgejo } from './support/forgejo';

const PASSWORD = 'e2e-forge-pass-1';

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

async function signIn(page: Page, login: string) {
  await page.goto('/login');
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/issues$/);
}

test.describe('signed in as themselves', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a person connects their Forgejo account by signing in there, and its pushes are theirs', async ({ page, api, playwright }, info) => {
    const forgejo = await startForgejo();
    try {
      const login = `erin.${unique()}`;
      await api.createUser({ login, name: 'Erin Okafor', password: PASSWORD, role: 'member' });
      const there = `erin-${unique()}`;
      forgejo.signInAs({ id: 4100 + Math.floor(Math.random() * 1000), login: there });
      await signIn(page, login);

      await page.goto('/me');
      const card = page.getByRole('region', { name: 'Your accounts at code hosts' });
      await card.getByRole('button', { name: 'Connect Forgejo' }).click();
      // At Forgejo: its own page asks, and sends the browser back.
      await expect(page.getByRole('heading', { name: 'Authorize a4a to access your account?' })).toBeVisible();
      await page.getByRole('link', { name: 'Authorize Application' }).click();
      await expect(page).toHaveURL(/\/me(#code-hosts)?$/);
      await expect(card.getByRole('status').filter({ hasText: 'Your Forgejo account is connected: its commits and pull requests are yours.' })).toBeVisible();
      const connected = card.getByRole('list', { name: 'Connected accounts' });
      await expect(connected).toContainText(`Forgejo ${there}`);
      await expectNoSidewaysScroll(page);
      await expectAccessible(page);
      await shoot(page, info, 'forgejo-connected');

      // Forgejo's push, whose commit it matched to that account: the command runs as Erin.
      const key = uniqueKey('FJ');
      await api.createProject({ key, name: `Forge ${key}` });
      const issue = await api.createIssue({ project: key, summary: 'Search drops accents', fields: { Type: 'Bug' } });
      const repository = `acme/${unique()}`;
      const made = await api.post<{ webhookUrl: string; secret: string }>('/vcs/integrations', { provider: 'gitea', name: repository, projects: [key] });
      const sha = randomBytes(20).toString('hex');
      const body = JSON.stringify({
        ref: 'refs/heads/main',
        after: sha,
        repository: { full_name: repository },
        commits: [{ id: sha, message: `Fold accents\n\n${issue.id} #Fixed`, timestamp: new Date().toISOString(), url: `${repository}/commit/${sha}`, author: { name: 'Erin', email: 'erin@noreply.forge.example', username: there } }],
      });
      const forge = await playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
      const res = await forge.post(made.webhookUrl, {
        data: body,
        headers: { 'content-type': 'application/json', 'x-forgejo-event': 'push', 'x-forgejo-delivery': randomUUID(), 'x-forgejo-signature': createHmac('sha256', made.secret).update(body).digest('hex') },
      });
      expect(res.status()).toBe(200);
      await forge.dispose();
      expect(fieldValue(await api.issue(issue.id), 'State')).toBe('Fixed');

      // Disconnected, the account is no longer theirs.
      await connected.getByRole('button', { name: `Disconnect ${there}` }).click();
      await page.getByRole('dialog', { name: `Disconnect ${there}?` }).getByRole('button', { name: 'Disconnect it' }).click();
      await expect(card.getByRole('status').filter({ hasText: "Disconnected: commits under that account aren't yours from now on." })).toBeVisible();
      await expect(card.getByRole('list', { name: 'Connected accounts' })).toHaveCount(0);
      await expect(card.getByRole('button', { name: 'Connect Forgejo' })).toBeVisible();
    } finally {
      await forgejo.close();
    }
  });
});
