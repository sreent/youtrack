/**
 * Commit statuses on Forgejo's pull requests (docs/architecture.md, D70). An administrator gives
 * a Forgejo integration its /api/v1 address and an access token that may write them; its checks
 * turn on with nothing to ask the provider for; a pull request it delivers is answered with a
 * status on its head commit, naming the issues it names as anyone who sees the repository may
 * read them, its commits read from the compare.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { unique, uniqueKey } from './support/api';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { THIRD_AUTH_FILE } from './support/env';
import { expect, test } from './support/fixtures';

// The third of the flows' administrators (support/env.ts says why).
test.use({ storageState: THIRD_AUTH_FILE });

test('reports to a Forgejo pull request as a commit status named “a4a”', async ({ page, api, playwright }) => {
  const key = uniqueKey('FS');
  const project = await api.createProject({ key, name: `Forge Status ${key}` });
  const named = await api.createIssue({ project: key, summary: 'Invoice total rounds twice', fields: { Type: 'Bug' } });

  // A fake of Gitea and Forgejo's API, answering only to the token: the compare its commits are read from, and the statuses written on it.
  const TOKEN = `forgejo_${randomUUID()}`;
  const statuses: { repo: string; sha: string; auth: string; body: Record<string, unknown> }[] = [];
  const compares: { repo: string; from: string; to: string }[] = [];
  const fake = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if ((req.headers.authorization ?? '') !== `Bearer ${TOKEN}`) return send(401, { message: 'invalid token' });
      const path = new URL(req.url ?? '/', 'http://git').pathname;
      const compared = /^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/compare\/([^/]+)\.\.\.([^/]+)$/.exec(path);
      if (compared) {
        compares.push({ repo: `${decodeURIComponent(compared[1]!)}/${decodeURIComponent(compared[2]!)}`, from: decodeURIComponent(compared[3]!), to: decodeURIComponent(compared[4]!) });
        return send(200, { commits: [{ sha: 'c1', commit: { message: `Round once\n\nFixes ${named.id}` } }] });
      }
      const on = /^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/statuses\/([^/]+)$/.exec(path);
      if (on && req.method === 'POST') {
        statuses.push({ repo: `${decodeURIComponent(on[1]!)}/${decodeURIComponent(on[2]!)}`, sha: decodeURIComponent(on[3]!), auth: String(req.headers.authorization), body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
        return send(201, { id: 1, status: 'success' });
      }
      return send(404, { message: 'not found' });
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

  try {
    await page.goto('/integrations');
    const repository = `acme/${unique()}`;
    const connect = page.getByRole('region', { name: 'Add an integration' });
    await connect.getByRole('radio', { name: 'Forgejo/Gitea' }).check();
    await connect.getByLabel('Name', { exact: true }).fill(repository);
    // Gitea and Forgejo take an API address and a token now (D70), to write commit statuses with.
    await connect.getByLabel('Gitea or Forgejo’s API address').fill(`${fakeUrl}/api/v1`);
    await connect.getByLabel('An access token that may write commit statuses').fill(TOKEN);
    await connect.getByRole('checkbox', { name: /^Of every project/ }).uncheck();
    await connect.getByRole('checkbox', { name: new RegExp(`^${project.name}`) }).check();
    await connect.getByRole('button', { name: 'Add the integration' }).click();
    const shown = connect.getByRole('status').filter({ hasText: 'Copy the secret now.' });
    await expect(shown).toBeVisible();
    const [webhookUrl, secret] = await shown.getByRole('code').allTextContents();
    expect(webhookUrl && secret).toBeTruthy();

    // Its checks need no permission asked of a provider, as GitHub's app is asked: the token is what they take.
    const card = page.getByRole('listitem').filter({ hasText: repository });
    const checks = card.getByRole('group', { name: 'Commit statuses on pull requests' });
    const on = checks.getByRole('checkbox', { name: 'Report to each pull request as a commit status named “a4a”' });
    await expect(card.getByText(/^They’re written with the integration’s access token/)).toBeVisible();
    await expect(card.getByText(/^Whoever sees the repository reads its commit statuses/)).toBeVisible();
    await on.check();
    // The status says what the server did: if enabling was refused, its words show instead, in the page's snapshot.
    await expect(card.getByRole('status').filter({ hasText: /Commit statuses are on|the provider’s API token/ })).toBeVisible({ timeout: 15_000 });
    await expect(on).toBeChecked();
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);

    // A pull request whose title and commits name the issue: a status lands on its head commit.
    const head = randomBytes(20).toString('hex');
    const base = randomBytes(20).toString('hex');
    const body = JSON.stringify({
      action: 'opened',
      repository: { full_name: repository },
      pull_request: {
        number: 7,
        html_url: `https://git.acme.example/${repository}/pulls/7`,
        state: 'open',
        merged: false,
        title: `Fixes ${named.id}`,
        body: '',
        updated_at: new Date().toISOString(),
        user: { login: 'bokafor' },
        head: { ref: 'feature/rounding', sha: head },
        base: { ref: 'main', sha: base },
      },
    });
    const forge = await playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
    const res = await forge.post(webhookUrl!, {
      data: body,
      headers: { 'content-type': 'application/json', 'x-forgejo-event': 'pull_request', 'x-forgejo-delivery': randomUUID(), 'x-forgejo-signature': createHmac('sha256', secret!).update(body).digest('hex') },
    });
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: 'processed' });
    await forge.dispose();
    await expect.poll(() => statuses.length, { timeout: 20_000 }).toBe(1);
    expect(statuses[0]).toMatchObject({ repo: repository, sha: head, auth: `Bearer ${TOKEN}` });
    expect(statuses[0]!.body).toMatchObject({ context: 'a4a', state: 'success', target_url: `https://git.acme.example/${repository}/pulls/7`, description: `Names 1 issue: ${named.id}` });
    // Its commits were read from the compare, base to head, with the token.
    expect(compares).toEqual([{ repo: repository, from: base, to: head }]);
  } finally {
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  }
});
