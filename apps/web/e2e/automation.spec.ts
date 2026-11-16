/**
 * Workflow rules and version control (docs/architecture.md, D25 and D26).
 *
 * A rule made on the Rules page acts on its own, a moment after the change that sets it off, as the
 * workflow agent, and says so in the issue's history and in what rules did. A guard refuses a change
 * that would break it, in its own words, and lets it through once the issue holds. A push from
 * GitHub, signed with the secret shown once, links its commit to the issue it names and applies its
 * command as the commit's author, known by the email an administrator gave them.
 *
 * Each test has a project of its own, so its rules never act on another spec's issues.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { fieldValue, unique, uniqueKey } from './support/api';
import { expect, test } from './support/fixtures';

/** A rule acts after the outbox's settle time, not inside the change. */
const ACTS_WITHIN = { timeout: 30_000 };

function ruleCard(page: Page, name: string) {
  return page.getByRole('listitem').filter({ has: page.getByRole('heading', { name, exact: true }) });
}

test('a rule made on the Rules page acts on its own, and says so', async ({ page, api }) => {
  const key = uniqueKey('RU');
  const project = await api.createProject({ key, name: `Rules ${key}` });
  await page.goto(`/rules/${key}`);
  const rules = page.getByRole('region', { name: `Rules in ${project.name}` });
  await expect(rules.getByText('No rules yet.')).toBeVisible();

  const add = page.getByRole('region', { name: 'Add a rule' });
  await add.getByLabel('Name', { exact: true }).fill('Critical bugs get tagged');
  await add.getByRole('combobox', { name: 'If it matches this query' }).fill('Priority: Critical');
  await add.getByRole('combobox', { name: 'Then apply this command' }).fill('tag urgent');
  // The dry run, before it's saved: the project has no issues yet.
  await expect(add.getByRole('group', { name: 'What it would do' })).toBeVisible();
  await add.getByRole('button', { name: 'Save the rule' }).click();
  await expect(rules.getByText('“Critical bugs get tagged” is saved. It acts from the next change.')).toBeVisible();

  const card = ruleCard(page, 'Critical bugs get tagged');
  await expect(card).toContainText('When an issue is created, if it matches Priority: Critical, then apply tag urgent');
  await expect(card).toContainText('It hasn’t acted yet.');

  // An issue it matches: the rule tags it a moment later, and one it doesn't match it leaves be.
  const critical = await api.createIssue({ project: key, summary: 'Checkout fails for every card', fields: { Type: 'Bug', Priority: 'Critical' } });
  const normal = await api.createIssue({ project: key, summary: 'The footer is a pixel off', fields: { Type: 'Bug', Priority: 'Normal' } });
  await expect.poll(async () => (await api.issue(critical.id)).tags.map((t) => t.name), ACTS_WITHIN).toContain('urgent');
  expect((await api.issue(normal.id)).tags).toEqual([]);

  // The issue's history says who changed it and why.
  await page.goto(`/issues/${critical.id}`);
  await expect(page.getByText('applied the rule “Critical bugs get tagged”')).toBeVisible();

  // So does the Rules page: the card's last act, and the run log.
  await page.goto(`/rules/${key}`);
  await expect(card.getByRole('link', { name: critical.id })).toBeVisible();
  await expect(card).toContainText(/Last acted .+, on .+: Tags\./);
  const runs = page.getByRole('region', { name: 'Table of what rules did' });
  await expect(runs.getByRole('row').filter({ hasText: critical.id })).toContainText('Critical bugs get tagged');
  await expect(runs.getByRole('row').filter({ hasText: critical.id })).toContainText('applied');
  await expect(runs.getByRole('row').filter({ hasText: normal.id })).toHaveCount(0);

  // Turned off, as saved and not only as shown. (That an off rule does nothing is the server's
  // tests' to show: here it would take waiting out the settle time.)
  await card.getByRole('button', { name: 'Turn it off' }).click();
  await expect(card.getByText('It’s off: it does nothing until it’s turned back on.')).toBeVisible();
  await page.reload();
  await expect(card.getByText('off', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Turn it back on' })).toBeVisible();
});

test('a guard refuses a change that would break it, in its own words', async ({ page, api, watch }) => {
  const key = uniqueKey('GU');
  await api.createProject({ key, name: `Guards ${key}` });
  await page.goto(`/rules/${key}`);
  const add = page.getByRole('region', { name: 'Add a rule' });
  await add.getByRole('button', { name: "Won't fix needs a comment" }).click();
  await expect(add.getByLabel('Name', { exact: true })).toHaveValue("Won't fix says why");
  await expect(add.getByRole('group', { name: 'What it would do' })).toBeVisible();
  await add.getByRole('button', { name: 'Save the rule' }).click();
  await expect(ruleCard(page, "Won't fix says why")).toContainText('It hasn’t refused a change yet.');

  const issue = await api.createIssue({ project: key, summary: 'Old browsers draw the menu twice', fields: { Type: 'Bug' } });
  await page.goto(`/issues/${issue.id}`);
  const fields = page.getByRole('complementary', { name: `Fields of ${issue.id}` });
  const wontFix = async () => {
    await fields.getByRole('button', { name: /^State / }).click();
    await fields.getByRole('listbox', { name: 'State' }).getByRole('option', { name: "Won't fix resolves it", exact: true }).click();
  };

  // Refused: the browser logs the 422 it's answered with.
  watch.allow(/status of 422/);
  await wontFix();
  await expect(fields.getByText("Say in a comment why it won't be fixed.")).toBeVisible();
  expect(fieldValue(await api.issue(issue.id), 'State')).toBe('Open');

  // With a comment saying why, it goes through.
  await api.post(`/issues/${issue.id}/comments`, { text: 'Those browsers are past their support date.' });
  await page.reload();
  await wontFix();
  await expect(fields.getByRole('button', { name: "State Won't fix" })).toBeVisible();
  expect(fieldValue(await api.issue(issue.id), 'State')).toBe("Won't fix");

  // The refusal is in what rules did.
  await page.goto(`/rules/${key}`);
  const runs = page.getByRole('region', { name: 'Table of what rules did' });
  await expect(runs.getByRole('row').filter({ hasText: issue.id })).toContainText('refused');
});

test('a push from GitHub links its commit, and applies its command as its author', async ({ page, api, playwright }) => {
  const key = uniqueKey('VC');
  const project = await api.createProject({ key, name: `Code ${key}` });
  const login = `dev-${unique()}`;
  const email = `${login}@example.com`;
  // An email an administrator gives is vouched for, so a commit under it is theirs.
  await api.post('/users', { login, name: 'Dana Developer', email, password: 'correct-horse-battery', role: 'member' });
  const issue = await api.createIssue({ project: key, summary: 'The export times out on big projects', fields: { Type: 'Bug' } });

  await page.goto('/integrations');
  const add = page.getByRole('region', { name: 'Add an integration' });
  const repository = `acme/${unique()}`;
  await add.getByLabel('Name', { exact: true }).fill(repository);
  await add.getByRole('checkbox', { name: /^Of every project/ }).uncheck();
  await add.getByRole('checkbox', { name: new RegExp(`^${project.name}`) }).check();
  await add.getByRole('button', { name: 'Add the integration' }).click();

  const shown = add.getByRole('status').filter({ hasText: 'Copy the secret now.' });
  // Shown once the integration is made: reading it before then would read nothing.
  await expect(shown.getByRole('code').nth(1)).toBeVisible();
  const [hookUrl, secret] = await shown.getByRole('code').allTextContents();
  expect(hookUrl).toMatch(/\/api\/v1\/vcs\/hooks\//);
  expect(secret).toBeTruthy();

  const integration = page.getByRole('listitem').filter({ hasText: repository });
  await expect(integration).toContainText(`looks for issues of ${project.name}`);
  await expect(integration.getByText('takes deliveries', { exact: true })).toBeVisible();

  // GitHub's push, signed as GitHub signs it: an HMAC-SHA256 of the raw body with the secret.
  const sha = randomBytes(20).toString('hex');
  const body = JSON.stringify({
    ref: 'refs/heads/main',
    repository: { full_name: repository },
    commits: [
      {
        id: sha,
        message: `Stream the export a page at a time\n\n${issue.id} #Fixed`,
        timestamp: new Date().toISOString(),
        url: `https://github.com/${repository}/commit/${sha}`,
        author: { name: 'Dana Developer', email, username: login },
      },
    ],
  });
  // GitHub signs in as nobody: its deliveries come with no cookie, so not from the signed-in page.
  const github = await playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
  const send = (signature: string) =>
    github.post(hookUrl!, {
      data: body,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': signature,
      },
    });

  // One not signed with the secret is refused before anything is read.
  const forged = await send(`sha256=${createHmac('sha256', 'not-the-secret').update(body).digest('hex')}`);
  expect(forged.status()).toBe(401);
  expect(fieldValue(await api.issue(issue.id), 'State')).toBe('Open');

  const delivered = await send(`sha256=${createHmac('sha256', secret!).update(body).digest('hex')}`);
  expect(delivered.status()).toBe(200);
  await github.dispose();
  expect(fieldValue(await api.issue(issue.id), 'State')).toBe('Fixed');

  // The issue shows the commit, and the command it gave, applied as its author.
  await page.goto(`/issues/${issue.id}`);
  const code = page.getByRole('region', { name: 'Commits and pull requests' });
  await expect(code).toContainText(`From ${repository}`);
  await expect(code.getByRole('link', { name: sha.slice(0, 7) })).toHaveAttribute('href', `https://github.com/${repository}/commit/${sha}`);
  await expect(code).toContainText('Stream the export a page at a time');
  await expect(code).toContainText('#Fixed');
  await expect(code.getByText('applied', { exact: true })).toBeVisible();
  await expect(code).toContainText('as Dana Developer');

  // And the integration's deliveries: the forged one refused, the real one handled.
  await page.goto('/integrations');
  await integration.getByRole('button', { name: 'Show its deliveries' }).click();
  const deliveries = integration.getByRole('region', { name: 'Table of recent deliveries' });
  await expect(deliveries.getByRole('row').filter({ hasText: 'handled' })).toContainText('1 linked, 1 command applied');
  await expect(deliveries.getByRole('row').filter({ hasText: 'refused' })).toHaveCount(1);
});
