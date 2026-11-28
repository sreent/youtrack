/**
 * Views of one search (D72): the switch on the Issues page offers whatever views are available and keeps
 * the search, its grouping and what's chosen, all in the address; a saved search opens in its owner's
 * view and grouping, kept across a reload, while anyone else's choice stays in their own address; the
 * list's group heads fold, from the keyboard too, and stay folded for that person; and a board opens in
 * Issues with its projects and query. Light, dark and a phone's width.
 */
import type { Page, Request } from '@playwright/test';
import type { Board, SavedSearch } from '@a4a/shared';
import { Api, unique, uniqueKey } from './support/api';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { BASE_URL, SECOND, SECOND_AUTH_FILE, THIRD_AUTH_FILE } from './support/env';
import { expect, prepareContext, settled, test } from './support/fixtures';

// The second of the flows' administrators (support/env.ts says why): the saved searches here are Theo's.
test.use({ storageState: SECOND_AUTH_FILE });

/** A project of the test's own: two bugs for Theo, a feature for nobody, a task of Theo's. */
async function projectWith(api: Api): Promise<string> {
  const key = uniqueKey('VW');
  await api.createProject({ key, name: `Views ${key}` });
  await api.createIssue({ project: key, summary: 'Login times out on slow networks', fields: { Type: 'Bug', Priority: 'Critical', Assignee: SECOND.login } });
  await api.createIssue({ project: key, summary: 'Export drops the last row', fields: { Type: 'Bug', Priority: 'Major', Assignee: SECOND.login } });
  await api.createIssue({ project: key, summary: 'Dark mode for the board', fields: { Type: 'Feature', Priority: 'Normal' } });
  await api.createIssue({ project: key, summary: 'Rotate the signing keys', fields: { Type: 'Task', Priority: 'Major', Assignee: SECOND.login } });
  return key;
}

/** A saved search of the page's own person, made as they'd make it: through their session. */
async function savedAs(page: Page, body: { name: string; query: string; shared: boolean; view?: unknown }): Promise<SavedSearch> {
  const res = await page.request.post('/api/v1/saved-searches', { data: body, headers: { origin: BASE_URL } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as SavedSearch;
}

async function savedNow(page: Page, id: string): Promise<SavedSearch> {
  const res = await page.request.get('/api/v1/saved-searches');
  const found = ((await res.json()) as SavedSearch[]).find((s) => s.id === id);
  expect(found, `saved search ${id}`).toBeTruthy();
  return found!;
}

const groupBy = (page: Page) => page.getByRole('combobox', { name: 'Group by' });
const views = (page: Page) => page.getByRole('group', { name: 'Views of this search' });
const head = (page: Page, name: string | RegExp) => page.getByRole('heading', { level: 3, name });
const fold = (page: Page, name: string | RegExp) => head(page, name).getByRole('button');
const params = (page: Page) => new URL(page.url()).searchParams;

test('the switch offers the views there are, and the address keeps the search, its grouping and what is chosen', async ({ page, api }) => {
  const key = await projectWith(api);
  const query = `project: ${key}`;
  // Today's address is today's list, with nothing else in it.
  await page.goto(`/issues?q=${encodeURIComponent(query)}`);
  await settled(page);
  await expect(page.getByRole('list', { name: '4 issues' })).toBeVisible();
  await expect(head(page, /./)).toHaveCount(0);

  // Something chosen stays chosen across grouping and views.
  await page.getByRole('checkbox', { name: `Choose ${key}-1` }).check();
  await groupBy(page).selectOption('Type');
  await expect(page).toHaveURL(/group=Type/);
  expect(params(page).get('q')).toBe(query);
  await expect(fold(page, /^Bug/)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('1 chosen')).toBeVisible();

  const buttons = views(page).getByRole('button');
  const offered = await buttons.allTextContents();
  if (offered.length < 2) {
    // Only the list is offered yet: no switch of one, and nothing about views in the address.
    await expect(views(page)).toHaveCount(0);
    expect(params(page).get('view')).toBeNull();
  } else {
    await expect(buttons.filter({ hasText: 'List' })).toHaveAttribute('aria-pressed', 'true');
    for (const name of offered.filter((n) => n !== 'List')) {
      await buttons.filter({ hasText: name }).click();
      await expect(buttons.filter({ hasText: name })).toHaveAttribute('aria-pressed', 'true');
      await expect(page).toHaveURL(new RegExp(`view=${name.toLowerCase()}`));
      expect(params(page).get('q')).toBe(query);
      expect(params(page).get('group')).toBe('Type');
    }
    await buttons.filter({ hasText: 'List' }).click();
    await expect(buttons.filter({ hasText: 'List' })).toHaveAttribute('aria-pressed', 'true');
    expect(params(page).get('view')).toBeNull();
    await expect(page.getByText('1 chosen')).toBeVisible();
  }

  // Ungrouped again, the address is today's again; a new query keeps the grouping.
  await groupBy(page).selectOption({ label: 'None' });
  await expect(head(page, /./)).toHaveCount(0);
  expect([...params(page).keys()]).toEqual(['q']);
  await groupBy(page).selectOption('Priority');
  const bar = page.getByRole('combobox', { name: 'Search issues' });
  await bar.fill(`${query} Type: Bug`);
  await bar.press('Enter');
  await expect(page).toHaveURL(/group=Priority/);
  await expect(page.getByRole('list', { name: 'Critical' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Major' })).toBeVisible();
});

test("a saved search opens in its owner's view and grouping, kept across a reload, and not in anyone else's", async ({ page, api, browser }) => {
  const key = await projectWith(api);
  const query = `project: ${key}`;
  // Saved from the page, it keeps how it was shown then.
  await page.goto(`/issues?q=${encodeURIComponent(query)}&group=Type`);
  await settled(page);
  await page.getByRole('button', { name: 'Save this search' }).click();
  await page.getByRole('textbox', { name: 'Name for this search' }).fill(`Plan ${key}`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/\?search=/);
  const id = params(page).get('search')!;
  await expect(page.getByRole('heading', { level: 1, name: `Plan ${key}` })).toBeVisible();
  expect((await savedNow(page, id)).view).toMatchObject({ kind: 'list', group: 'Type' });

  // Its owner regroups it: kept in it, with its version, and the address stays the search's own.
  const kept = page.waitForResponse((r) => r.url().includes(`/saved-searches/${id}`) && r.request().method() === 'PATCH');
  await groupBy(page).selectOption('Assignee');
  expect((await kept).status()).toBe(200);
  await expect(page.getByRole('status').filter({ hasText: `Kept in “Plan ${key}”.` })).toBeAttached();
  expect([...params(page).keys()]).toEqual(['search']);
  const after = await savedNow(page, id);
  expect(after).toMatchObject({ view: { group: 'Assignee' }, version: 1 });
  const offered = await views(page).getByRole('button').allTextContents();
  await page.reload();
  await settled(page);
  await expect(groupBy(page)).toHaveValue('Assignee');
  await expect(fold(page, /^Theo Ruiz/)).toBeVisible();
  await expect(fold(page, /^No Assignee/)).toBeVisible();
  if (offered.length > 1) await expect(views(page).getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');

  // Shared, Una opens it in Theo's grouping; hers lives in her address, and his search doesn't change.
  const shared = await page.request.patch(`/api/v1/saved-searches/${id}`, { data: { shared: true, expectedVersion: after.version }, headers: { origin: BASE_URL } });
  expect(shared.status()).toBe(200);
  const una = await browser.newContext({ storageState: THIRD_AUTH_FILE });
  const watch = await prepareContext(una);
  const other = await una.newPage();
  const patches: Request[] = [];
  other.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/saved-searches/')) patches.push(r);
  });
  await other.goto(`/issues?search=${id}`);
  await settled(other);
  await expect(groupBy(other)).toHaveValue('Assignee');
  // In the list of saved searches, a shared one says its view when it isn't the list.
  await expect(other.getByRole('button', { name: `Plan ${key}`, exact: true })).toHaveAttribute('aria-current', 'true');
  await groupBy(other).selectOption('Type');
  await expect(other).toHaveURL(/group=Type/);
  await expect(fold(other, /^Bug/)).toBeVisible();
  await other.waitForTimeout(1500);
  expect(patches).toEqual([]);
  expect((await savedNow(page, id)).version).toBe(2);
  await other.goto(`/issues?search=${id}`);
  await settled(other);
  await expect(groupBy(other)).toHaveValue('Assignee');

  // A shared search shown as a timeline says so in the list, and is one of the plans /plan lists.
  const timeline = await savedAs(page, { name: `Timeline ${key}`, query, shared: true, view: { kind: 'timeline', group: null } });
  await other.reload();
  await settled(other);
  await expect(other.getByRole('button', { name: `Timeline ${key} (timeline)` })).toBeVisible();
  await other.goto('/plan');
  await settled(other);
  const plans = other.getByRole('region', { name: 'Plans of saved searches' });
  await expect(plans.getByRole('link', { name: `Timeline ${key}` })).toHaveAttribute('href', `/issues?search=${timeline.id}&view=timeline`);
  await expect(plans.getByRole('link', { name: `Plan ${key}` })).toHaveCount(0);
  await expect(plans.getByRole('listitem').filter({ hasText: `Timeline ${key}` })).toContainText(`Shared by ${SECOND.name}`);
  await other.screenshot({ path: test.info().outputPath('views-plans-light.png') });
  await expectAccessible(other);
  await plans.getByRole('link', { name: `Timeline ${key}` }).click();
  await settled(other);
  await expect(other.getByRole('heading', { level: 1, name: `Timeline ${key}` })).toBeVisible();
  expect(watch.unexpected()).toEqual([]);
  await una.close();
});

test('group heads fold and open, from the keyboard too, and stay as each person left them', async ({ page, api }) => {
  const key = await projectWith(api);
  await page.goto(`/issues?q=${encodeURIComponent(`project: ${key}`)}&group=Assignee`);
  await settled(page);
  const theo = fold(page, /^Theo Ruiz/);
  const nobody = fold(page, /^No Assignee/);
  // Each head says its value, how many the group holds, and whether it's open.
  await expect(theo).toHaveAccessibleName(/^Theo Ruiz\s*3 issues$/);
  await expect(nobody).toHaveAccessibleName(/^No Assignee\s*1 issue$/);
  await expect(page.getByRole('list', { name: 'Theo Ruiz' }).getByRole('listitem')).toHaveCount(3);

  await theo.click();
  await expect(theo).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('list', { name: 'Theo Ruiz' })).toBeHidden();
  await expect(page.getByRole('list', { name: 'No Assignee' }).getByRole('listitem')).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath('views-folded-light.png') });
  await expectAccessible(page);

  // From the keyboard: the head is a stop of its own, Enter and Space fold and open it.
  await theo.focus();
  await page.keyboard.press('Enter');
  await expect(theo).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('list', { name: 'Theo Ruiz' }).getByRole('listitem').first()).toBeFocused();
  await nobody.focus();
  await page.keyboard.press('Space');
  await expect(nobody).toHaveAttribute('aria-expanded', 'false');
  // The arrows go past a folded group's rows: from the last of Theo's, nowhere further.
  const rows = page.getByRole('list', { name: 'Theo Ruiz' }).getByRole('listitem');
  await rows.first().focus();
  await page.keyboard.press('End');
  await expect(rows.last()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(rows.last()).toBeFocused();

  // Folded is this person's, in this browser: it's still folded after a reload.
  await page.reload();
  await settled(page);
  await expect(fold(page, /^No Assignee/)).toHaveAttribute('aria-expanded', 'false');
  await expect(fold(page, /^Theo Ruiz/)).toHaveAttribute('aria-expanded', 'true');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: test.info().outputPath('views-grouped-dark.png') });
  await expectAccessible(page);
  await page.emulateMedia({ colorScheme: 'light' });
});

test('an administrator adopts a shared search whose owner was deleted, and then keeps its view', async ({ page, api }) => {
  const key = await projectWith(api);
  // An agent shares a search, then is deleted: the search stays, nobody's.
  const { agent, token } = await api.createAgent(`vw${unique()}`);
  const theirs = await Api.withToken(token);
  const left = await theirs.post<SavedSearch>('/saved-searches', { name: `Left ${key}`, query: `project: ${key}`, shared: true, view: { kind: 'list', group: 'Type' } });
  await theirs.dispose();
  await api.delete(`/users/${agent.id}`);

  await page.goto(`/issues?search=${left.id}`);
  await settled(page);
  await expect(groupBy(page)).toHaveValue('Type');
  await page.getByRole('button', { name: `Adopt “Left ${key}”` }).click();
  await expect(page.getByRole('status').filter({ hasText: `“Left ${key}” is yours now.` })).toBeAttached();
  await expect(page.getByRole('button', { name: `Adopt “Left ${key}”` })).toHaveCount(0);
  expect((await savedNow(page, left.id)).owner?.login).toBe(SECOND.login);
  // Theirs now: Theo's grouping is kept in it.
  const kept = page.waitForResponse((r) => r.url().includes(`/saved-searches/${left.id}`) && r.request().method() === 'PATCH');
  await groupBy(page).selectOption('Priority');
  expect((await kept).status()).toBe(200);
  expect((await savedNow(page, left.id)).view.group).toBe('Priority');
});

test("a board opens in Issues with its projects and query", async ({ page, api }) => {
  const key = await projectWith(api);
  const board = await api.post<Board>('/boards', { name: `Bugs ${key}`, projects: [key], query: 'Type: Bug' });
  await page.goto(`/boards/${board.id}`);
  await settled(page);
  await page.getByRole('link', { name: 'Open in Issues' }).click();
  await expect(page).toHaveURL(/\/issues\?q=/);
  expect(params(page).get('q')).toBe(`project: ${key} (Type: Bug)`);
  await expect(page.getByRole('list', { name: '2 issues' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Search issues' })).toHaveValue(`project: ${key} (Type: Bug)`);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the grouped list fits, its heads still fold', async ({ page, api }) => {
    const key = await projectWith(api);
    await page.goto(`/issues?q=${encodeURIComponent(`project: ${key}`)}&group=Priority`);
    await settled(page);
    await expect(fold(page, /^Critical/)).toBeVisible();
    await expectNoSidewaysScroll(page);
    await page.screenshot({ path: test.info().outputPath('views-grouped-phone.png'), fullPage: true });
    await fold(page, /^Major/).tap();
    await expect(fold(page, /^Major/)).toHaveAttribute('aria-expanded', 'false');
    await expectAccessible(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectNoSidewaysScroll(page);
    await page.screenshot({ path: test.info().outputPath('views-grouped-phone-dark.png'), fullPage: true });
  });
});
