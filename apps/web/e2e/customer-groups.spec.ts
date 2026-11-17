/**
 * Customer groups in the help desk (docs/architecture.md, D56): a desk's manager makes a group with
 * a domain and an agent on the desk's page; a requester at the domain writes in, and the request
 * is filed under the group and given to the agent, as its card and history say; a colleague answers
 * it on the portal.
 *
 * This run sends no email (playwright.config.ts), so nobody signs in to the portal by a link here:
 * its answers are stood in for in the browser, shaped as the API's. Signing in, a colleague's reply
 * reaching the requester, and everyone else finding the request missing are the server's tests'.
 */
import type { PortalMe, PortalRequest, PortalRequestDetail } from '@a4a/shared';
import { unique, uniqueKey } from './support/api';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { THIRD, THIRD_AUTH_FILE } from './support/env';
import { expect, test } from './support/fixtures';
import { deskTakingMail, message, postMail } from './support/helpdesk';

// The third of the flows' administrators (support/env.ts says why).
test.use({ storageState: THIRD_AUTH_FILE });

test('a manager makes a group with a domain and an agent, its member’s request goes to the agent, and a colleague answers it', async ({ page, api, browser }) => {
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

  // Dana, a colleague at the same company, answers it on the portal.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const portal = await context.newPage();
  const summary: PortalRequest = {
    id,
    desk: { key, name: `Customers ${key}` },
    summary: subject,
    state: { name: 'Open', resolved: false },
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    requester: { name: 'Pat', mine: false },
    group: name,
    private: false,
    canReply: true,
  };
  let detail: PortalRequestDetail = { ...summary, description: 'Since Monday.', messages: [] };
  const me: PortalMe = { name: 'Dana', email: `dana@${domain}`, groups: [{ desk: summary.desk, name, sharing: 'comment' }] };
  await portal.route('**/api/v1/portal/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/api/v1', '');
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/portal/me') return json(me);
    if (path === '/portal/desks') return json([summary.desk]);
    if (path === '/portal/requests') return json([summary]);
    if (path === `/portal/requests/${id}/replies` && route.request().method() === 'POST') {
      const { text } = route.request().postDataJSON() as { text: string };
      detail = { ...detail, messages: [...detail.messages, { id: 'reply-1', from: 'you', name: 'Dana', text, at: new Date().toISOString() }] };
      return json(detail);
    }
    if (path === `/portal/requests/${id}`) return json(detail);
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'not_found', message: "There's no request here" } }) });
  });
  await portal.goto('/portal');
  await expect(portal.getByText(`You also see requests shared with ${name} (Customers ${key}).`, { exact: false })).toBeVisible();
  await portal.getByRole('button', { name: subject }).click();
  await expect(portal.getByText(`This is Pat’s request, shared with ${name}: your reply goes to them and the team.`)).toBeVisible();
  await portal.getByLabel('Your reply').fill('We see it too, on the third floor.');
  await portal.getByRole('button', { name: 'Send the reply' }).click();
  await expect(portal.getByRole('list', { name: 'The request, and the replies to it' }).getByText('We see it too, on the third floor.')).toBeVisible();
  await expectAccessible(portal);
  await portal.setViewportSize({ width: 390, height: 844 });
  await expectNoSidewaysScroll(portal);
  await context.close();
});
