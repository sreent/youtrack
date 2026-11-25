/**
 * Customer groups in the help desk (docs/architecture.md, D56): a desk's manager makes a group with
 * a domain and an agent on the desk's page; a requester at the domain writes in, and the request
 * is filed under the group and given to the agent, as its card and history say. Then a colleague at
 * the same domain signs in to the portal by a link sent to their email, finds the request shared
 * with the group, and answers it; the requester hears of it by email, and the team's page says a
 * colleague wrote it.
 *
 * Then a group's member copied on its new request (D56's revisit): their email says it's because of
 * the group, with no reply address where it shares to read; its stop link's page stops the group's
 * emails, and the portal's switch turns them back on.
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

test('a group’s member hears its new request, says why, stops the group’s emails from the link, and turns them back on in the portal', async ({ browser }) => {
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
    await call('POST', '/projects', { key: 'CGR', name: 'Readers desk', template: 'software' });
    await call('PATCH', '/projects/CGR', { settings: { helpdesk: { enabled: true } } });
    await call('PUT', '/projects/CGR/helpdesk/mail', { address: DESK });
    const { url: webhook } = await call<{ url: string }>('POST', '/projects/CGR/helpdesk/mail/secret');
    await call('POST', '/projects/CGR/customer-groups', { name: 'Globex', domains: ['globex.example'], sharing: 'read' });

    // Rae at Globex asked once before; Sam, also at Globex, asks now, and the group shares its people's requests to read.
    await postMail(webhook, message({ from: 'Rae <rae@globex.example>', to: DESK, subject: 'Badges for the new hires', body: 'Three of them.' }));
    await mail.waitFor('rae@globex.example', (m) => (m.headers.get('subject') ?? '').includes('Badges for the new hires'));
    await postMail(webhook, message({ from: 'Sam <sam@globex.example>', to: DESK, subject: 'The projector is dim', body: 'Room 4.' }));
    await mail.waitFor('sam@globex.example', (m) => (m.headers.get('subject') ?? '').includes('The projector is dim'));
    await call('POST', '/issues/CGR-2/comments', { text: 'A new lamp is on its way.', visibility: 'public' });

    // Rae hears of it, and her email says why: she's in Globex, whose people read each other's requests. No reply address.
    const toRae = await mail.waitFor('rae@globex.example', (m) => m.text.includes('A new lamp is on its way.'));
    expect(toRae.text).toContain("replied to Sam's request.");
    expect(toRae.text).toContain("You get this because you're in Globex, whose people can read each other's requests to Readers desk's help desk. Replies to this email reach nobody: the link above opens it.");
    expect(toRae.headers.get('reply-to')).toBeUndefined();
    const stop = /Stop emails about Globex's requests: (\S+)/.exec(toRae.text)?.[1];
    expect(stop).toBeTruthy();

    // The team's card lists her as one of Globex's people.
    await page.goto('/issues/CGR-2');
    const card = page.getByRole('region', { name: 'Help desk request' });
    await expect(card.getByText(/as one of Globex's people/)).toBeVisible();

    // Her link's page says which group's emails it stops; its button stops them, this request's, the group's other open ones and its new ones.
    const portal = await browser.newContext({ baseURL: server.url, locale: 'en-GB', viewport: { width: 1280, height: 900 } });
    const portalWatch = await prepareContext(portal);
    const rae = await portal.newPage();
    await rae.goto(new URL(stop!).pathname + new URL(stop!).search);
    await expect(rae.getByRole('heading', { name: 'Stop these emails?' })).toBeVisible();
    await expect(rae.getByText("Emails about this request and Globex's other requests at Readers desk, which copy you as one of its people.")).toBeVisible();
    await expectAccessible(rae);
    await rae.screenshot({ path: test.info().outputPath('group-stop-light.png') });
    await rae.getByRole('button', { name: 'Stop them' }).click();
    await expect(rae.getByRole('heading', { name: 'Stopped' })).toBeVisible();
    await expect(rae.getByText("You're no longer copied on Globex's requests, open or new.", { exact: false })).toBeVisible();
    for (const [colorScheme, width] of [['dark', 1280], ['light', 390]] as const) {
      await rae.emulateMedia({ colorScheme });
      await rae.setViewportSize({ width, height: 844 });
      await expectAccessible(rae);
      await expectNoSidewaysScroll(rae);
      await rae.screenshot({ path: test.info().outputPath(`group-stopped-${colorScheme}-${width}.png`) });
    }
    await rae.emulateMedia({ colorScheme: 'light' });
    await rae.setViewportSize({ width: 1280, height: 900 });

    // The request's history says she stopped Globex's emails; she's copied no more.
    await page.reload();
    await expect(page.getByRole('region', { name: 'History and comments' }).getByText("stopped emails about Globex's requests, from the link in an email")).toBeVisible();
    await expect(card.getByText(/as one of Globex's people/)).toBeHidden();

    // In the portal, her groups each have a switch; Globex's is off, and she turns it back on from the keyboard.
    await rae.goto('/portal');
    await rae.getByRole('textbox', { name: 'Your email' }).fill('rae@globex.example');
    await rae.getByRole('button', { name: 'Email me a link' }).click();
    const link = await mail.waitFor('rae@globex.example', (m) => m.text.includes('/portal#hdl_'));
    await rae.goto(/(\/portal#hdl_[A-Za-z0-9_-]{43})/.exec(link.text)![1]!);
    const emails = rae.getByRole('region', { name: "Emails about your groups' requests" });
    const toggle = emails.getByRole('checkbox', { name: "Email me about Globex's new requests" });
    await expect(toggle).not.toBeChecked();
    await toggle.focus();
    await rae.keyboard.press('Space');
    await expect(emails.getByRole('status')).toHaveText("You're copied on Globex's new requests again.");
    await expect(toggle).toBeChecked();
    for (const [colorScheme, width] of [['light', 1280], ['dark', 1280], ['light', 390]] as const) {
      await rae.emulateMedia({ colorScheme });
      await rae.setViewportSize({ width, height: 844 });
      await expectAccessible(rae);
      await expectNoSidewaysScroll(rae);
      await emails.screenshot({ path: test.info().outputPath(`group-switch-${colorScheme}-${width}.png`) });
    }
    // Globex's next request copies her again.
    await postMail(webhook, message({ from: 'Sam <sam@globex.example>', to: DESK, subject: 'The screen flickers', body: 'Room 5.' }));
    const copied = await call<{ ccs: { email: string; hears: boolean }[] }>('GET', '/issues/CGR-3/request');
    expect(copied.ccs).toEqual([expect.objectContaining({ email: 'rae@globex.example', hears: true })]);

    // The desk's page says whom Globex's requests copy.
    await page.goto('/projects/CGR');
    await expect(page.getByRole('region', { name: 'Customer groups' }).getByText('Its new requests copy its people by email, all but whoever asked: 2 people now.')).toBeVisible();
    await expectAccessible(page);
    expect(teamWatch.unexpected()).toEqual([]);
    expect(portalWatch.unexpected()).toEqual([]);
    await portal.close();
    await team.close();
  } finally {
    await server.close();
    await mail.close();
  }
});
