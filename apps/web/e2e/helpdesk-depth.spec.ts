/**
 * The help desk in depth (docs/architecture.md, D45): a desk's working hours and SLA policies set
 * on its page, a request's targets on its card, paused while it waits on its requester; the
 * requesters' portal; and the kinds of change that tell a person.
 *
 * This run sends no email (playwright.config.ts), so the portal is seen as far as asking for a
 * link: signing in by one is the server's tests' to show.
 */
import type { HelpdeskMailSecret } from '@a4a/shared';
import { unique, uniqueKey } from './support/api';
import { expect, test } from './support/fixtures';
import { deskTakingMail, message, postMail } from './support/helpdesk';

test('a desk sets its SLA on its page, and a request shows its targets, paused while it waits', async ({ page, api }) => {
  const key = uniqueKey('SL');
  await api.createProject({ key, name: `Service ${key}` });
  const address = `help-${unique()}@desk.example`;
  const secret: HelpdeskMailSecret = await deskTakingMail(api, key, address);

  await page.goto(`/projects/${key}`);
  const levels = page.getByRole('region', { name: 'Service levels' });
  await expect(levels.getByText('No policies yet.')).toBeVisible();
  // Waiting on the requester: Blocked, here; their answer moves it back to Open.
  await levels.getByLabel('Waiting states').fill('Blocked');
  await levels.getByLabel('When they answer, move it to').fill('Open');
  await levels.getByRole('button', { name: 'Save working hours' }).click();
  await expect(levels.getByText('Saved. Open requests follow it now.')).toBeVisible();

  const add = levels.getByRole('form', { name: 'Add a policy' });
  await add.getByLabel('Name', { exact: true }).fill('Standard');
  await add.getByLabel('First response within').fill('4h');
  await add.getByLabel('Resolved within').fill('3d');
  await add.getByRole('button', { name: 'Add the policy' }).click();
  await expect(levels.getByText('“Standard” covers what it matches from now, open requests too.')).toBeVisible();
  await expect(levels.getByText(/Every request: first response in 4h, resolved in 3d/)).toBeVisible();

  // A request by email: its card shows both targets counting.
  const subject = `Printer jams ${unique()}`;
  expect((await postMail(secret.url, message({ from: 'Pat <pat@example.org>', to: address, subject, body: 'On every page.' }))).status).toBe(200);
  const found = await api.get<{ items: { id: string }[] }>(`/issues?query=${encodeURIComponent(`project: ${key} "${subject}"`)}`);
  const id = found.items[0]!.id;
  await page.goto(`/issues/${id}`);
  const card = page.getByRole('region', { name: 'Help desk request' });
  await expect(card.getByText('Standard, round the clock.')).toBeVisible();
  await expect(card.getByText(/First response due in/)).toBeVisible();
  await expect(card.getByText(/Resolution due in/)).toBeVisible();

  // Waiting on the requester: the clocks pause, and the field the agent keeps says so.
  await api.post('/commands', { issues: [id], command: 'State Blocked' });
  await page.reload();
  await expect(card.getByText(/It waits on its requester/)).toBeVisible();
  await expect(card.getByText(/Resolution paused/)).toBeVisible();
  const issue = await api.issue(id);
  expect(issue.fields.find((f) => f.name === 'SLA status')?.value).toMatchObject({ name: 'Paused' });
  const paused = await api.get<{ total: number }>(`/issues?query=${encodeURIComponent(`project: ${key} sla: paused`)}`);
  expect(paused.total).toBe(1);
});

test('the portal asks for an email to send a sign-in link to', async ({ browser }) => {
  // Signed out, as a requester is.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto('/portal');
  await expect(page.getByRole('heading', { name: 'Your requests' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Your email' }).fill('pat@example.org');
  await page.getByRole('button', { name: 'Email me a link' }).click();
  // This run sends no email, and the page says what that means.
  await expect(page.getByText("Signing in needs email, and this server doesn't send any")).toBeVisible();
  await context.close();
});

test('a person chooses the kinds of change that tell them', async ({ page }) => {
  await page.goto('/me');
  const kinds = page.getByRole('table', { name: 'The kinds of change that tell you' });
  const box = () => kinds.getByRole('checkbox', { name: 'Commented on, issues you watch, email' });
  // Whatever it was, it's turned the other way, kept, and turned back.
  const was = await box().isChecked();
  await box().click();
  await expect(box()).toBeChecked({ checked: !was });
  await page.reload();
  await expect(box()).toBeChecked({ checked: !was });
  await box().click();
  await expect(box()).toBeChecked({ checked: was });
  await expect(page.getByText(/always tell you/)).toBeVisible();
});
