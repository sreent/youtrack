/**
 * The help desk by email, and its form's proof of work (D30). A desk's managers give it an address
 * and its mail provider a secret on the project page; a message the provider posts becomes a
 * request, which the desk's log, the request's card and its history all say came by email. A desk
 * that asks for a proof of work gets one from the form, solved in the browser, before it sends.
 */
import { unique, uniqueKey } from './support/api';
import { SECOND_AUTH_FILE } from './support/env';
import { expect, test } from './support/fixtures';
import { message, postMail } from './support/helpdesk';

// The second of the flows' administrators (support/env.ts says why).
test.use({ storageState: SECOND_AUTH_FILE });

test('a desk takes mail: set up on its project page, a message becomes a request, and its log says so', async ({ page, api }) => {
  const key = uniqueKey('HM');
  await api.createProject({ key, name: `Mail ${key}` });
  await api.patch(`/projects/${key}`, { settings: { helpdesk: { enabled: true } } });
  await page.goto(`/projects/${key}`);
  const section = page.getByRole('region', { name: 'Help desk by email' });
  await expect(section.getByText('Give the desk an address')).toBeVisible();

  const address = `support-${unique()}@desk.example`;
  await section.getByLabel("The desk's address").fill(address);
  await section.getByRole('button', { name: 'Save the address' }).click();
  await expect(section.getByText(`Saved. Mail to ${address} comes here.`)).toBeVisible();
  await expect(section.getByText(/^support-\w+\+k7q2x9…@desk\.example$/)).toBeVisible();
  await expect(section.getByText('takes none yet')).toBeVisible();

  // The secret is shown once, in the address the provider is given.
  await section.getByRole('button', { name: 'Make its secret' }).click();
  const shown = section.getByRole('status').filter({ hasText: 'Copy the address now.' });
  const url = (await shown.getByRole('code').textContent())!;
  expect(url).toMatch(new RegExp(`^http://a4a:hdm_[A-Za-z0-9_-]{32}@127\\.0\\.0\\.1:\\d+/api/v1/mail/inbound/${key}$`));
  await shown.getByRole('button', { name: "I've kept it" }).click();
  await expect(section.getByText(/^takes posts with the secret hdm_[\w-]{4}…$/)).toBeVisible();

  const posted = await postMail(url, message({ from: 'Jane Doe <jane@example.com>', to: address, subject: 'Invoices show the wrong VAT', body: 'Since Monday, every invoice says 19%.\n\n-- \nJane Doe\nExample Ltd' }));
  expect(posted).toEqual({ status: 200, body: { outcome: 'request', reason: 'a new request' } });
  // Mail no person wrote is set aside, and said so.
  const away = await postMail(url, message({ from: 'jane@example.com', to: address, subject: 'Automatic reply: Invoices', body: 'Away until Monday.', headers: ['Auto-Submitted: auto-replied'] }));
  expect(away.body).toEqual({ outcome: 'ignored', reason: 'an automatic reply' });

  await page.reload();
  const log = section.getByRole('region', { name: 'Table of what came in by email' });
  const setAside = log.getByRole('row').filter({ hasText: 'Automatic reply: Invoices' });
  await expect(setAside).toContainText('set aside');
  await expect(setAside).toContainText('an automatic reply');
  const filed = log.getByRole('row').filter({ hasText: 'Invoices show the wrong VAT' });
  await expect(filed).toContainText('a new request');
  await expect(filed).toContainText('jane@example.com');
  await filed.getByRole('link', { name: new RegExp(`^${key}-\\d+$`) }).click();

  // The request says it came by email, on its card and in its history, without the signature.
  await expect(page.getByRole('heading', { level: 1, name: 'Invoices show the wrong VAT' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Help desk request' })).toContainText('They wrote in by email, and may answer by email.');
  await expect(page.getByText('asked for help by email')).toBeVisible();
  await expect(page.getByText('Since Monday, every invoice says 19%.')).toBeVisible();
  await expect(page.getByText('Example Ltd')).toHaveCount(0);
});

test('a desk that asks for a proof of work gets one from the form, solved before it sends', async ({ page, api }) => {
  const key = uniqueKey('HC');
  await api.createProject({ key, name: `Checked ${key}` });
  await api.patch(`/projects/${key}`, { settings: { helpdesk: { enabled: true, captcha: true } } });
  await page.goto(`/help/${key}`);
  await page.getByLabel('Your name').fill('Rae Lin');
  await page.getByLabel('Your email').fill(`rae-${unique()}@example.com`);
  await page.getByLabel("What it's about").fill('Two-factor codes arrive late');
  const sent = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/v1/help/${key}/requests`));
  await page.getByRole('button', { name: 'Send the request' }).click();
  const body = (await sent).postDataJSON() as { captcha?: { number: number; challenge: string; salt: string } };
  expect(body.captcha).toMatchObject({ number: expect.any(Number), challenge: expect.stringMatching(/^[0-9a-f]{64}$/), salt: expect.stringContaining(`desk=${key}`) });
  await expect(page.getByRole('heading', { name: 'We have your request' })).toBeVisible();
});
