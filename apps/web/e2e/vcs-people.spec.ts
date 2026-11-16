/**
 * Who wrote which commits (docs/architecture.md, D33). An administrator records a person's login
 * at Bitbucket and adds an email of theirs, confirmed; a push Bitbucket signed, whose commit it
 * matched to that account, runs its command as the person though a4a knows not its email. A
 * person adds emails of their own, which wait for an administrator where a4a can't send email.
 * Bitbucket Data Center's integration takes its address, and a token to read the commits a push
 * moved. The page a link to confirm an email leads to says when it can't.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { fieldValue, unique, uniqueKey, type Api } from './support/api';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { expect, test } from './support/fixtures';

const PASSWORD = 'e2e-person-pass-1';

/** Someone of the test's own, who can sign in, with no email yet. */
async function person(api: Api, name: string) {
  const login = `${name.split(' ')[0]!.toLowerCase()}.${unique()}`;
  const user = await api.createUser({ login, name, password: PASSWORD, role: 'member' });
  return { id: user.id, login, name };
}

async function signIn(page: Page, login: string) {
  await page.goto('/login');
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/issues$/);
}

test('an administrator records a login at Bitbucket, and a push by that account runs its command as the person', async ({ page, api, playwright, watch }) => {
  // The nickname the administrator tries first is refused: the browser logs its 400.
  watch.allow(/status of 400/);
  const key = uniqueKey('BB');
  const project = await api.createProject({ key, name: `Shop ${key}` });
  const erin = await person(api, 'Erin Okoye');
  const issue = await api.createIssue({ project: key, summary: 'Checkout rounds the total the wrong way', fields: { Type: 'Bug' } });
  const uuid = randomUUID();

  await page.goto('/admin');
  const card = page.getByRole('region', { name: 'Who wrote which commits' });
  await card.getByLabel('Whose').selectOption({ label: `${erin.name} (${erin.login})` });
  await expect(card.getByRole('heading', { name: `Logins of ${erin.name}` })).toBeVisible();
  await expect(card.getByText('None recorded.')).toBeVisible();

  // Bitbucket's nicknames aren't unique: what's recorded is the account itself.
  await card.getByLabel('At', { exact: true }).selectOption({ label: 'Bitbucket Cloud' });
  await card.getByLabel('Their login there').fill('erin');
  await card.getByRole('button', { name: 'Record it' }).click();
  await expect(card.getByRole('alert')).toContainText('That doesn’t look like a login at Bitbucket Cloud. Bitbucket Cloud’s nicknames aren’t unique');
  await card.getByLabel('Their login there').fill(`{${uuid}}`);
  await card.getByRole('button', { name: 'Record it' }).click();
  await expect(card.getByRole('status').filter({ hasText: `Bitbucket Cloud {${uuid}} is ${erin.name}'s login there now.` })).toBeVisible();
  await expect(card.getByRole('region', { name: `Table of ${erin.name}'s logins` }).getByRole('row').filter({ hasText: `{${uuid}}` })).toContainText('Bitbucket Cloud');

  // And an email of hers, which the administrator vouches for.
  await card.getByLabel(`Add an email of ${erin.name}'s, confirmed`).fill(`${erin.login}@example.org`);
  await card.getByRole('button', { name: 'Add it' }).click();
  await expect(card.getByRole('region', { name: `Table of ${erin.name}'s emails` }).getByRole('row').filter({ hasText: `${erin.login}@example.org` })).toContainText('confirmed');
  await expectNoSidewaysScroll(page);
  await expectAccessible(page);

  // An integration for Bitbucket Cloud, for this project only.
  await page.goto('/integrations');
  const add = page.getByRole('region', { name: 'Add an integration' });
  await add.getByRole('radio', { name: 'Bitbucket Cloud' }).check();
  const repository = `acme/${unique()}`;
  await add.getByLabel('Name', { exact: true }).fill(repository);
  await add.getByRole('checkbox', { name: /^Of every project/ }).uncheck();
  await add.getByRole('checkbox', { name: new RegExp(`^${project.name}`) }).check();
  await add.getByRole('button', { name: 'Add the integration' }).click();
  const shown = add.getByRole('status').filter({ hasText: 'Copy the secret now.' });
  // Shown once the integration is made: wait for it before reading what it says.
  await expect(shown).toContainText('Repository settings');
  const [hookUrl, secret] = await shown.getByRole('code').allTextContents();

  // Bitbucket's push: a4a doesn't know the commit's email, but Bitbucket matched it to her account.
  const sha = randomBytes(20).toString('hex');
  const account = { display_name: erin.name, uuid: `{${uuid}}`, nickname: 'erin', account_id: null };
  const body = JSON.stringify({
    repository: { full_name: repository },
    actor: account,
    push: {
      changes: [
        {
          old: { type: 'branch', name: 'main', target: { hash: 'a'.repeat(40) } },
          new: { type: 'branch', name: 'main', target: { hash: sha } },
          truncated: false,
          commits: [
            {
              hash: sha,
              message: `Round half to even\n\n${issue.id} #Fixed`,
              date: new Date().toISOString(),
              author: { raw: 'Erin Okoye <erin@personal.example>', user: account },
              links: { html: { href: `https://bitbucket.org/${repository}/commits/${sha}` } },
            },
          ],
        },
      ],
    },
  });
  // Bitbucket signs in as nobody: its deliveries come with no cookie.
  const bitbucket = await playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
  const res = await bitbucket.post(hookUrl!, {
    data: body,
    headers: {
      'content-type': 'application/json',
      'x-event-key': 'repo:push',
      'x-request-uuid': `{${randomUUID()}}`,
      'x-hub-signature': `sha256=${createHmac('sha256', secret!).update(body).digest('hex')}`,
    },
  });
  expect(res.status()).toBe(200);
  await bitbucket.dispose();
  expect(fieldValue(await api.issue(issue.id), 'State')).toBe('Fixed');

  await page.goto(`/issues/${issue.id}`);
  const code = page.getByRole('region', { name: 'Commits and pull requests' });
  await expect(code).toContainText(`From ${repository}`);
  await expect(code.getByText('applied', { exact: true })).toBeVisible();
  await expect(code).toContainText(`as ${erin.name}`);
});

test("Bitbucket Data Center's integration takes its address, and a token to read the commits a push moved", async ({ page }) => {
  await page.goto('/integrations');
  const add = page.getByRole('region', { name: 'Add an integration' });
  await add.getByRole('radio', { name: 'Bitbucket Data Center' }).check();
  const name = `PROJ/${unique()}`;
  await add.getByLabel('Name', { exact: true }).fill(name);
  await expect(add.getByRole('button', { name: 'Add the integration' })).toBeDisabled();
  await add.getByLabel('Bitbucket’s address').fill('https://bitbucket.acme.example');
  await add.getByRole('button', { name: 'Add the integration' }).click();
  await expect(add.getByRole('status').filter({ hasText: 'Copy the secret now.' })).toContainText('HTTP access token');

  const card = page.getByRole('listitem').filter({ hasText: name });
  await expect(card).toContainText('Reads commits at https://bitbucket.acme.example');
  await expect(card.getByText('no access token: links no commits', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Send a test' }).click();
  await expect(card.getByRole('status').filter({ hasText: "It has no access token, so it can't read the commits pushes move: give it one." })).toBeVisible();

  await card.getByRole('button', { name: 'Give it an access token' }).click();
  await card.getByLabel('Access token').fill('BBDC-e2e-read-token');
  await card.getByRole('button', { name: 'Save the token' }).click();
  await expect(card.getByRole('status').filter({ hasText: 'Saved: a4a reads the commits a delivery leaves out with it.' })).toBeVisible();
  await expect(card.getByText('reads commits with its token', { exact: true })).toBeVisible();
  // Never shown again.
  await page.reload();
  await expect(page.getByText('BBDC-e2e-read-token')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Replace its access token' })).toBeVisible();
});

test("the page a link to confirm an email leads to says when it can't", async ({ page, watch }) => {
  watch.allow(/status of 404/);
  await page.goto(`/emails/confirm?token=${'x'.repeat(43)}`);
  await expect(page.getByRole('heading', { name: 'This link can’t confirm an email' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('This link isn’t valid');
  await expectAccessible(page);
  await page.goto('/emails/confirm');
  await expect(page.getByRole('heading', { name: 'This link has no token' })).toBeVisible();
});

test.describe('signed in as themselves', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a person adds emails of their own; where a4a sends no email, they wait for an administrator', async ({ page, api }) => {
    const omar = await person(api, 'Omar Haddad');
    await signIn(page, omar.login);
    await page.goto('/me');
    const card = page.getByRole('region', { name: 'Emails', exact: true });
    await expect(card.getByText('You have no email in a4a yet.')).toBeVisible();
    await expect(card.getByText("a4a can't send email here, so an administrator confirms emails, under Administration.")).toBeVisible();

    // The first is the primary one.
    await card.getByLabel('Add an email').fill(`${omar.login}@example.org`);
    await card.getByRole('button', { name: 'Add it' }).click();
    await expect(card.getByRole('status').filter({ hasText: `${omar.login}@example.org is added. a4a can't send email here, so an administrator confirms it.` })).toBeVisible();
    const primary = card.getByRole('row').filter({ hasText: `${omar.login}@example.org` });
    await expect(primary).toContainText('primary: where a4a writes');
    await expect(primary).toContainText('waiting to be confirmed');

    await card.getByLabel('Add an email').fill(`${omar.login}@home.example`);
    await card.getByRole('button', { name: 'Add it' }).click();
    const other = card.getByRole('row').filter({ hasText: `${omar.login}@home.example` });
    await expect(other).toContainText('waiting to be confirmed');
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);

    // An administrator confirms it; then it can be the primary one.
    await api.post(`/users/${omar.id}/emails`, { email: `${omar.login}@home.example` });
    await page.reload();
    await expect(other).toContainText('confirmed');
    await other.getByRole('button', { name: `Make it primary: ${omar.login}@home.example` }).click();
    await expect(card.getByRole('status').filter({ hasText: `${omar.login}@home.example is your primary email now.` })).toBeVisible();
    await expect(card.getByRole('row').filter({ hasText: `${omar.login}@home.example` })).toContainText('primary: where a4a writes');

    // The old one stays, and can go.
    const old = card.getByRole('row').filter({ hasText: `${omar.login}@example.org` });
    await old.getByRole('button', { name: `Remove ${omar.login}@example.org` }).click();
    await page.getByRole('dialog', { name: `Remove ${omar.login}@example.org?` }).getByRole('button', { name: 'Remove it' }).click();
    await expect(card.getByRole('status').filter({ hasText: `${omar.login}@example.org is removed` })).toBeVisible();
    await expect(card.getByRole('row').filter({ hasText: `${omar.login}@example.org` })).toHaveCount(0);
  });
});
