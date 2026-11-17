/**
 * Builds from Forgejo's Actions (docs/architecture.md, D55). An administrator takes a project's
 * builds from a Forgejo integration's runs on the Integrations page; Forgejo's run, signed as its
 * pushes are, reaches a4a through the integration's own webhook; the build marks the resolved issue
 * the run's push names, which the issue's page and the builds page say.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fieldValue, unique, uniqueKey } from './support/api';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { THIRD_AUTH_FILE } from './support/env';
import { expect, test } from './support/fixtures';

// The third of the flows' administrators (support/env.ts says why).
test.use({ storageState: THIRD_AUTH_FILE });

test("a Forgejo run's build reaches the issue its push names", async ({ page, api, playwright }) => {
  const key = uniqueKey('FJ');
  const project = await api.createProject({ key, name: `Forgejo ${key}` });
  const fixed = await api.createIssue({ project: key, summary: 'Invoice total rounds twice', fields: { Type: 'Bug' } });
  await api.post('/commands', { issues: [fixed.id], command: 'State Fixed' });
  // An integration for the repository on Forgejo, for this project only.
  await page.goto('/integrations');
  const repository = `acme/${unique()}`;
  const connect = page.getByRole('region', { name: 'Add an integration' });
  await connect.getByRole('radio', { name: 'Gitea or Forgejo' }).check();
  await connect.getByLabel('Name', { exact: true }).fill(repository);
  await connect.getByRole('checkbox', { name: /^Of every project/ }).uncheck();
  await connect.getByRole('checkbox', { name: new RegExp(`^${project.name}`) }).check();
  await connect.getByRole('button', { name: 'Add the integration' }).click();
  const shown = connect.getByRole('status').filter({ hasText: 'Copy the secret now.' });
  // Its steps say which of Forgejo's events bring builds.
  await expect(shown.getByRole('listitem').filter({ hasText: 'For builds from its Actions runs' })).toContainText('Workflow run events');
  const [webhookUrl, secret] = await shown.getByRole('code').allTextContents();
  expect(webhookUrl && secret).toBeTruthy();

  const add = page.getByRole('region', { name: "Take a project's builds" });
  await add.getByRole('radio', { name: 'Forgejo or Gitea Actions' }).check();
  const name = `Forgejo Actions ${unique()}`;
  await add.getByLabel('Name', { exact: true }).fill(name);
  await add.getByLabel('Builds of the project').selectOption(key);
  await add.getByLabel('The Gitea or Forgejo integration').selectOption({ label: repository });
  await add.getByLabel('Its workflow').fill('ci.yml');
  await expect(add.getByText('Either way a build is named by its run’s number')).toBeVisible();
  await add.getByRole('button', { name: 'Take its builds' }).click();
  const card = page.getByRole('listitem').filter({ hasText: name });
  await expect(card).toContainText(`${repository}'s runs of ci.yml on main`);
  await expect(card).toContainText('into Fixed in build');
  // Its runs come signed by the integration: no token of its own to give.
  await expect(card.getByRole('button', { name: 'Give it a new token' })).toHaveCount(0);
  await expectNoSidewaysScroll(page);
  await expectAccessible(page);

  // Forgejo 17's run, as it sends one when the run passes: the push that started it names the issue.
  const head = randomBytes(20).toString('hex');
  const finished = new Date();
  const push = {
    ref: 'refs/heads/main',
    after: head,
    commits: [{ id: head, message: `Round once\n\nFixes ${fixed.id}\n`, timestamp: new Date(finished.getTime() - 300_000).toISOString(), author: { name: 'Ben Okafor', email: 'ben@example.com', username: 'bokafor' } }],
    head_commit: { id: head, message: `Round once\n\nFixes ${fixed.id}\n`, timestamp: new Date(finished.getTime() - 300_000).toISOString() },
    repository: { full_name: repository },
  };
  const runUrl = `https://git.acme.example/${repository}/actions/runs/57`;
  const body = JSON.stringify(
    {
      action: 'run_completed',
      run: {
        id: 197719,
        title: 'Round once',
        repository: { id: 9, name: repository.split('/')[1], full_name: repository, html_url: `https://git.acme.example/${repository}` },
        workflow_id: 'ci.yml',
        index_in_repo: 57,
        trigger_user: { id: 4, login: 'bokafor', username: 'bokafor' },
        ScheduleID: 0,
        prettyref: 'main',
        is_ref_deleted: false,
        commit_sha: head,
        is_fork_pull_request: false,
        need_approval: false,
        approved_by: 0,
        event: 'push',
        event_payload: JSON.stringify(push),
        trigger_event: 'push',
        status: 'success',
        started: new Date(finished.getTime() - 200_000).toISOString(),
        stopped: finished.toISOString(),
        created: new Date(finished.getTime() - 210_000).toISOString(),
        updated: finished.toISOString(),
        duration: 200_000_000_000,
        html_url: runUrl,
      },
    },
    null,
    2,
  );
  const sign = (secret: string) => createHmac('sha256', secret).update(body).digest('hex');
  // Forgejo signs in as nobody: its deliveries come with no cookie.
  const forgejo = await playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
  const send = (signature: string) =>
    forgejo.post(webhookUrl!, {
      data: body,
      headers: { 'content-type': 'application/json', 'x-forgejo-event': 'workflow_run_success', 'x-forgejo-delivery': randomUUID(), 'x-forgejo-signature': signature },
    });
  expect((await send(sign('not-the-secret'))).status()).toBe(401);
  const res = await send(sign(secret!));
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ outcome: 'processed', applied: 1 });
  await forgejo.dispose();
  expect(fieldValue(await api.issue(fixed.id), 'Fixed in build')).toBe('57');

  await page.goto(`/issues/${fixed.id}`);
  const builds = page.getByRole('region', { name: 'Commits and pull requests' }).getByRole('group', { name: 'Builds' });
  await expect(builds.getByRole('link', { name: 'Build 57' })).toHaveAttribute('href', runUrl);
  await expect(builds).toContainText('fixed in it');
  await expectAccessible(page);

  await page.goto(`/builds/${key}`);
  await expect(page.getByRole('heading', { name: `Builds of ${project.name}` })).toBeVisible();
  const row = page.getByRole('region', { name: 'Table of builds' }).getByRole('row').filter({ hasText: '57' });
  await expect(row).toContainText('passed');
  await expect(row).toContainText(name);
  await expect(row.getByRole('link', { name: fixed.id })).toBeVisible();
});
