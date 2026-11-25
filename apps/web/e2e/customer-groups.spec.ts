/**
 * Customer groups in the help desk (docs/architecture.md, D56): a desk's manager makes a group with
 * a domain and an agent on the desk's page; a requester at the domain writes in, and the request
 * is filed under the group and given to the agent, as its card and history say. Then a colleague at
 * the same domain signs in to the portal by a link sent to their email, finds the request shared
 * with the group, and answers it; the requester hears of it by email, and the team's page says a
 * colleague wrote it.
 *
 * The run's own server sends no email (playwright.config.ts), so the portal's part runs on a server
 * of its own that does, beside a mail server (support/mail.ts), as D57's spec does.
 */
import { unique, uniqueKey } from './support/api';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { THIRD, THIRD_AUTH_FILE } from './support/env';
import { expect, prepareContext, test } from './support/fixtures';
import { deskTakingMail, message, postMail } from './support/helpdesk';
import { startMailServer, startMailingServer } from './support/mail';

// The third of the flows' administrators (support/env.ts says why).
test.use({ storageState: THIRD_AUTH_FILE });

test('a manager makes a group with a domain and an agent, and its member’s request goes to the agent', async ({ page, api }) => {
  const key = uniqueKey('CG');
  await api.createProject({ key, name: `Customers ${key}`, lead: THIRD.login });
  const address = `help-${unique()}@desk.example`;
  const secret = await deskTakingMail(api, key, address);
  const domain = `acme-${unique()}.example`.toLowerCase();
  const name = `Acme ${unique()}`;

  // On the desk's page: a group, its domain, its members answering each other's requests, and Una taking its new ones.
  await page.goto(`/projects/${key}`);
  const groups = page.getByRole('region', { name: 'Customer groups' });
  await expect(groups.getByText('No customer groups yet.')).toBeVisible();
  await groups.getByRole('button', { name: 'Add a group' }).click();
  const form = groups.getByRole('form', { name: 'Add a group' });
  await form.getByLabel('Name', { exact: true }).fill(name);
  await form.getByLabel('Email domains').fill(domain);
  await form.getByLabel('Their requests').selectOption('comment');
  await form.getByRole('checkbox', { name: THIRD.name }).check();
  await form.getByRole('button', { name: 'Add the group' }).click();
  await expect(groups.getByText('Saved. Requests filed from now on go under it, and its open ones follow its hours.')).toBeVisible();
  await expect(groups.getByText(`By ${domain} · Members read and answer each other’s · In the desk’s hours · 0 added by hand · 0 open requests`)).toBeVisible();
  await expect(groups.getByRole('list', { name: 'Who takes its new requests' }).getByText(THIRD.name)).toBeVisible();
  await expectAccessible(page);
  // On a phone, editing it, nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await groups.getByRole('button', { name: `Edit ${name}` }).click();
  await expect(groups.getByRole('form', { name: `Edit ${name}` })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.setViewportSize({ width: 1280, height: 900 });

  // Pat at the domain writes in: the request is the group's, and Una's.
  const subject = `Invoices are late ${unique()}`;
  expect((await postMail(secret.url, message({ from: `Pat <pat@${domain}>`, to: address, subject, body: 'Since Monday.' }))).status).toBe(200);
  const found = await api.get<{ items: { id: string; summary: string }[] }>(`/issues?query=${encodeURIComponent(`project: ${key} customer: {${name}}`)}`);
  expect(found.items.map((i) => i.summary)).toEqual([subject]);
  const id = found.items[0]!.id;
  const issue = await api.issue(id);
  expect(issue.fields.find((f) => f.name === 'Assignee')?.value).toMatchObject({ login: THIRD.login });
  await page.goto(`/issues/${id}`);
  const card = page.getByRole('region', { name: 'Help desk request' });
  await expect(card.getByLabel('Customer group')).toHaveValue(/.+/);
  await expect(card.getByText(`${name}’s members read and answer it on the portal.`)).toBeVisible();
  // The team keeps it from the group, in its history; and shares it again.
  await card.getByRole('checkbox', { name: `Keep it from ${name}` }).click();
  await expect(card.getByText(`Kept from ${name}: only its requester and the team see it.`)).toBeVisible();
  await card.getByRole('checkbox', { name: `Keep it from ${name}` }).click();
  await expect(card.getByText(`${name}’s members read and answer it on the portal.`)).toBeVisible();
  await expectAccessible(page);

});

test('a manager names a group after a customer another desk serves, told apart from one alike by its domains', async ({ page, api }) => {
  // Another desk serves two customers whose names differ by one character, as Japanese companies' often do.
  const u = unique();
  const other = uniqueKey('CA');
  await api.createProject({ key: other, name: `Customers ${other}`, lead: THIRD.login });
  const one = { name: `〇〇システム株式会社 ${u}`, domain: `sys-${u}.example`.toLowerCase() };
  const two = { name: `〇〇システムズ株式会社 ${u}`, domain: `systems-${u}.example`.toLowerCase() };
  for (const c of [one, two]) await api.post(`/projects/${other}/customer-groups`, { name: c.name, domains: [c.domain], sharing: 'none' });
  // This desk has a group of its own named alike: it's not suggested, since it can't take that name again.
  const key = uniqueKey('CB');
  await api.createProject({ key, name: `Customers ${key}`, lead: THIRD.login });
  const mine = `〇〇システム工業 ${u}`;
  await api.post(`/projects/${key}/customer-groups`, { name: mine, domains: [`kogyo-${u}.example`.toLowerCase()], sharing: 'none' });

  await page.goto(`/projects/${key}`);
  const groups = page.getByRole('region', { name: 'Customer groups' });
  await groups.getByRole('button', { name: 'Add a group' }).click();
  const form = groups.getByRole('form', { name: 'Add a group' });
  const field = form.getByRole('combobox', { name: 'Name', exact: true });
  await field.fill(u);
  // Each by its name and its domains, which tell them apart.
  const known = form.getByRole('listbox', { name: 'Customers other help desks serve' });
  await expect(known.getByRole('option')).toHaveCount(2);
  await expect(known.getByRole('option', { name: `${one.name} ${one.domain}` })).toBeVisible();
  await expect(known.getByRole('option', { name: `${two.name} ${two.domain}` })).toBeVisible();
  await expect(form.getByRole('status').filter({ hasText: 'other help desks serve' })).toHaveText('2 customers other help desks serve: up and down to choose, Enter to take one.');
  await expectAccessible(page);
  // At a phone's width a long name's domains wrap beneath it, and nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoSidewaysScroll(page);
  await page.setViewportSize({ width: 1280, height: 900 });

  // The arrows choose and Enter takes: its name and its domains, which the field had none of. Names
  // come in the page's language's order, where kana come before kanji: システムズ, then システム株式会社.
  await field.press('ArrowDown');
  await expect(known.getByRole('option', { name: `${two.name} ${two.domain}` })).toHaveAttribute('aria-selected', 'true');
  await field.press('Enter');
  await expect(field).toHaveValue(two.name);
  await expect(form.getByLabel('Email domains')).toHaveValue(two.domain);
  await expect(known).toHaveCount(0);
  // Typed, and never taken, a new customer's name stays as written: Escape puts the suggestions away.
  await field.fill(`株式会社 ${u}`);
  await expect(known.getByRole('option')).toHaveCount(2);
  await field.press('Escape');
  await expect(known).toHaveCount(0);
  await expect(field).toHaveValue(`株式会社 ${u}`);
  await expect(form.getByLabel('Email domains')).toHaveValue(two.domain);
});

test('a colleague signs in to the portal, answers a request shared with their group, and the requester hears of it', async ({ browser }) => {
  test.setTimeout(180_000);
  const mail = await startMailServer();
  const server = await startMailingServer(mail.port);
  try {
    const DESK = 'help@desk.example';
    const team = await browser.newContext({ baseURL: server.url, locale: 'en-GB', viewport: { width: 1280, height: 900 } });
    const teamWatch = await prepareContext(team);
    const page = await team.newPage();
    await page.goto('/login');
    await page.getByLabel('Login').fill(server.admin.login);
    await page.getByLabel('Password').fill(server.admin.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/issues$/);
    const made = await page.request.post('/api/v1/me/tokens', { data: { name: 'e2e', scopes: ['read', 'write', 'admin'] }, headers: { origin: server.url } });
    expect(made.status(), await made.text()).toBe(201);
    const { token } = (await made.json()) as { token: string };
    const call = async <T>(method: string, path: string, data?: unknown): Promise<T> => {
      const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers: { authorization: `Bearer ${token}` } });
      expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBe(true);
      return (res.status() === 204 ? null : await res.json()) as T;
    };
    await call('POST', '/projects', { key: 'CGP', name: 'Customers', template: 'software' });
    await call('PATCH', '/projects/CGP', { settings: { helpdesk: { enabled: true } } });
    await call('PUT', '/projects/CGP/helpdesk/mail', { address: DESK });
    const { url: webhook } = await call<{ url: string }>('POST', '/projects/CGP/helpdesk/mail/secret');
    await call('POST', '/projects/CGP/customer-groups', { name: 'Acme', domains: ['acme.example'], sharing: 'comment' });

    // Pat at Acme asks by email.
    const asked = await postMail(webhook, message({ from: 'Pat <pat@acme.example>', to: DESK, subject: 'Invoices are late', body: 'Since Monday.' }));
    expect(asked.body).toEqual({ outcome: 'request', reason: 'a new request' });
    await mail.waitFor('pat@acme.example', (m) => (m.headers.get('subject') ?? '').includes('Invoices are late'));

    // Dana, also at Acme, signs in by a link sent to her email, and finds Pat's request shared with Acme.
    const portal = await browser.newContext({ baseURL: server.url, locale: 'en-GB', viewport: { width: 1280, height: 900 } });
    const portalWatch = await prepareContext(portal);
    const dana = await portal.newPage();
    await dana.goto('/portal');
    await dana.getByRole('textbox', { name: 'Your email' }).fill('dana@acme.example');
    await dana.getByRole('button', { name: 'Email me a link' }).click();
    const link = await mail.waitFor('dana@acme.example', (m) => m.text.includes('/portal#hdl_'));
    await dana.goto(/(\/portal#hdl_[A-Za-z0-9_-]{43})/.exec(link.text)![1]!);
    await expect(dana.getByText('You also see requests shared with Acme (Customers).', { exact: false })).toBeVisible();
    // She gives the name the team, and Pat, will see.
    await dana.getByLabel('The name the team sees').fill('Dana Scully');
    await dana.getByRole('button', { name: 'Change my name' }).click();
    await expect(dana.getByText('Dana Scully', { exact: false }).first()).toBeVisible();
    await dana.getByRole('button', { name: 'Invoices are late' }).click();
    await expect(dana.getByText('This is Pat’s request, shared with Acme: your reply goes to them and the team.')).toBeVisible();
    await dana.getByLabel('Your reply').fill('We see it too, on the third floor.');
    await dana.getByRole('button', { name: 'Send the reply' }).click();
    await expect(dana.getByRole('list', { name: 'The request, and the replies to it' }).getByText('We see it too, on the third floor.')).toBeVisible();
    await expectAccessible(dana);
    await dana.setViewportSize({ width: 390, height: 844 });
    await expectNoSidewaysScroll(dana);

    // Pat hears of it by email, by Dana's name; on the team's page, a colleague of Pat's wrote it.
    const toPat = await mail.waitFor('pat@acme.example', (m) => m.text.includes('We see it too, on the third floor.'));
    expect(toPat.text).toContain('Dana Scully replied to your request.');
    await page.goto('/issues/CGP-1');
    const history = page.getByRole('region', { name: 'History and comments' });
    const hers = history.getByRole('listitem').filter({ hasText: 'We see it too, on the third floor.' });
    await expect(hers).toContainText('Dana Scully');
    await expect(hers).toContainText('public: a colleague of the requester wrote it');
    await expectAccessible(page);

    // The team keeps it from Acme: Dana finds it gone, as if it never was.
    await call('PATCH', '/issues/CGP-1/request', { private: true });
    await dana.setViewportSize({ width: 1280, height: 900 });
    await dana.goto('/portal');
    await expect(dana.getByText('No requests yet.', { exact: false })).toBeVisible();
    expect(teamWatch.unexpected()).toEqual([]);
    expect(portalWatch.unexpected()).toEqual([]);
    await portal.close();
    await team.close();
  } finally {
    await server.close();
    await mail.close();
  }
});
