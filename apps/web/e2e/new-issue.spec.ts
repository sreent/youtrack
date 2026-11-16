/**
 * Reporting an issue: issues like it show while the summary is typed, and a report retried after
 * its answer was lost is made once, because the retry carries the same Idempotency-Key.
 */
import { uniqueKey } from './support/api';
import { SECOND_AUTH_FILE } from './support/env';
import { expect, test } from './support/fixtures';

// The second of the flows' administrators (support/env.ts says why).
test.use({ storageState: SECOND_AUTH_FILE });

let key: string;

test.beforeAll(async ({ workerApi: api }) => {
  key = uniqueKey('NI');
  await api.createProject({ key, name: `Accounts ${key}` });
  await api.createIssue({ project: key, summary: 'Password reset email never arrives', fields: { Type: 'Bug' } });
  await api.createIssue({ project: key, summary: 'Add two-factor sign-in with an authenticator app', fields: { Type: 'Feature' } });
});

test('issues like it show while the summary is typed', async ({ page }) => {
  await page.goto(`/issues/new?project=${key}`);
  const summary = page.getByLabel('Summary');
  await expect(summary).toBeFocused();
  await expect(page.getByLabel('Project')).toHaveValue(key);

  await summary.pressSequentially('The password reset email');
  const similar = page.getByRole('region', { name: 'Issues that may be the same' });
  await expect(similar.getByRole('link', { name: 'Password reset email never arrives' })).toBeVisible();
  await expect(similar.getByRole('link', { name: /two-factor/ })).toBeHidden();
  await expect(similar.getByText('If one of these is what you’re reporting, add to it instead.')).toBeVisible();

  // Too few words to look for: the list goes.
  await summary.fill('Email');
  await expect(similar).toBeHidden();
});

test('a report retried after its answer was lost is made once (Idempotency-Key)', async ({ page, api, watch }) => {
  // The first answer is lost on the way back: the browser logs a failed request.
  watch.allow(/net::ERR_CONNECTION_RESET/);
  const words = `Invoice PDF shows the wrong VAT rate (${key})`;
  await page.goto(`/issues/new?project=${key}`);
  await page.getByLabel('Summary').fill(words);
  await page.getByLabel('Description').fill('Steps: download the November invoice. Expected 20%, shown 19%.');
  await page.getByLabel('Priority').selectOption('Major');

  // The server makes the issue, and its answer never reaches the page.
  const reports: { key: string | undefined; status: number; replayed: string | undefined; id: string }[] = [];
  await page.route(
    (url) => url.pathname === '/api/v1/issues',
    async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const response = await route.fetch();
      const body = (await response.json()) as { id: string };
      reports.push({ key: route.request().headers()['idempotency-key'], status: response.status(), replayed: response.headers()['idempotent-replayed'], id: body.id });
      if (reports.length === 1) return route.abort('connectionreset');
      return route.fulfill({ response });
    },
  );

  const report = page.getByRole('button', { name: 'Report it' });
  await report.click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(report).toBeEnabled();
  expect(reports).toHaveLength(1);
  const made = reports[0]!;
  expect(made.status).toBe(201);
  expect(made.key).toBeTruthy();

  // Nothing in the form changed, so trying again sends the same key: the server answers with
  // the issue it made, and makes no other.
  await report.click();
  await expect(page).toHaveURL(new RegExp(`/issues/${made.id}$`));
  await expect(page.getByRole('heading', { level: 1 })).toContainText(words);
  expect(reports).toHaveLength(2);
  expect(reports[1]).toEqual({ key: made.key, status: 201, replayed: 'true', id: made.id });
  const found = await api.search(`project: ${key} "Invoice PDF shows the wrong VAT rate"`);
  expect(found.items.map((i) => i.id)).toEqual([made.id]);
});
