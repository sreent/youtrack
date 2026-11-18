/**
 * Ranking cards on the board itself (D53): a card dragged within its column lands where it was
 * dropped, and stays there; from the keyboard, Alt and an arrow on its id moves it a place or a
 * column, says so where a screen reader hears it, and keeps the focus on it; dragged into another
 * column at a place, its state and its place change in one request; and someone else's rank shows
 * without a reload. Each test has a project and a board of its own.
 */
import type { Locator, Page } from '@playwright/test';
import type { Backlog, Board, BoardView } from '@a4a/shared';
import { fieldValue, uniqueKey, type Api } from './support/api';
import { ADMIN, SECOND, SECOND_AUTH_FILE } from './support/env';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { expect, test } from './support/fixtures';

// The second of the flows' administrators (support/env.ts says why).
test.use({ storageState: SECOND_AUTH_FILE });

/** A project and its board, with issues in the states given, made one after another. */
async function boardWith(api: Api, issues: [string, string][]): Promise<Board> {
  const key = uniqueKey('RK');
  await api.createProject({ key, name: `Ranks ${key}` });
  const board = await api.createBoard({
    name: `Ranks ${key}`,
    projects: [key],
    columns: [
      { name: 'Open', values: ['Open'] },
      { name: 'In Progress', values: ['In Progress'] },
      { name: 'Done', values: ['Fixed'] },
    ],
  });
  for (const [summary, state] of issues) await api.createIssue({ project: key, summary, fields: { State: state } });
  return board;
}

const column = (page: Page, name: string) => page.getByRole('list', { name, exact: true });
const idButton = (page: Page, id: string) => page.getByRole('button', { name: `Move ${id} with a command` });
const cardOf = (page: Page, id: string) => page.locator(`li.board-card[data-issue="${id}"]`);
/** A column's cards, top to bottom, by id. */
const order = (page: Page, name: string) => column(page, name).locator(':scope > li.board-card[data-issue]').evaluateAll((els) => els.map((e) => e.getAttribute('data-issue')!));
const status = (page: Page, words: string) => page.getByRole('status').filter({ hasText: words });
const ranked = (page: Page, board: Board) => page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/v1/boards/${board.id}/rank`));

/** Pick a card up as a mouse does: press on its foot, and move past the threshold. */
async function pickUp(page: Page, id: string) {
  const from = await cardOf(page, id).boundingBox();
  if (!from) throw new Error(`Can't see ${id}`);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height - 6);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height - 2, { steps: 4 });
}

/** Carry the card over the upper or lower half of another card, where its slot says what dropping does. */
async function carryOnto(page: Page, onto: Locator, half: 'upper' | 'lower', words: string) {
  const to = await onto.boundingBox();
  if (!to) throw new Error("Can't see where it goes");
  await page.mouse.move(to.x + to.width / 2, to.y + to.height * (half === 'upper' ? 0.25 : 0.75), { steps: 12 });
  await expect(page.locator('li.board-drop').getByText(words)).toBeVisible();
}

test('a card dragged within its column lands where it was dropped, and stays there', async ({ page, api }) => {
  const board = await boardWith(api, [
    ['Write the upgrade guide', 'Open'],
    ['Record the demo', 'Open'],
    ['Check the licences', 'Open'],
  ]);
  await page.goto(`/boards/${board.id}`);
  await expect(column(page, 'Open').locator('li.board-card')).toHaveCount(3);
  const [first, second, last] = await order(page, 'Open');
  const version = (await api.issue(last!)).version;

  const saved = ranked(page, board);
  await pickUp(page, last!);
  await carryOnto(page, cardOf(page, first!), 'upper', `Drop it to put ${last} above ${first}`);
  await page.screenshot({ path: test.info().outputPath('board-rank-dragging.png') });
  // A card on its way, its slot and the gap it left, held to WCAG 2.2 AA.
  await expectAccessible(page);
  await page.mouse.up();
  expect((await saved).postDataJSON()).toEqual({ issue: last, column: 'Open', before: first, expectedVersion: version });

  await expect.poll(() => order(page, 'Open')).toEqual([last, first, second]);
  await expect(status(page, `Moved ${last} above ${first}.`)).toBeAttached();
  // It's the board's order now, for everyone: read again, it's where it was put.
  await page.reload();
  await expect.poll(() => order(page, 'Open')).toEqual([last, first, second]);

  // Dropped where it already is, nothing is sent and nothing moves.
  let sent = 0;
  page.on('request', (r) => void (r.url().endsWith('/rank') && sent++));
  await pickUp(page, first!);
  const own = await cardOf(page, first!).boundingBox();
  await page.mouse.move(own!.x + own!.width / 2, own!.y + own!.height / 2, { steps: 6 });
  await expect(page.locator('li.board-drop')).toHaveCount(0);
  await page.mouse.up();
  await expect.poll(() => order(page, 'Open')).toEqual([last, first, second]);
  expect(sent).toBe(0);
});

test('from the keyboard, Alt and an arrow moves a card a place or a column, says so, and keeps the focus on it', async ({ page, api }) => {
  const board = await boardWith(api, [
    ['Rotate the signing keys', 'Open'],
    ['Paginate the audit log', 'Open'],
    ['Retry webhooks with backoff', 'Open'],
  ]);
  await page.goto(`/boards/${board.id}`);
  await expect(column(page, 'Open').locator('li.board-card')).toHaveCount(3);
  const [top, next, bottom] = await order(page, 'Open');
  const url = page.url();

  await idButton(page, top!).focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(status(page, `Moved ${top} below ${next}.`)).toBeAttached();
  await expect.poll(() => order(page, 'Open')).toEqual([next, top, bottom]);
  await expect(idButton(page, top!)).toBeFocused();
  await page.screenshot({ path: test.info().outputPath('board-rank-keyboard.png') });
  // The board, the card moved and the words said, held to WCAG 2.2 AA.
  await expectAccessible(page);

  await page.keyboard.press('Alt+ArrowUp');
  await expect(status(page, `Moved ${top} above ${next}.`)).toBeAttached();
  await expect.poll(() => order(page, 'Open')).toEqual([top, next, bottom]);
  await expect(idButton(page, top!)).toBeFocused();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(status(page, `${top} is already at the top of Open.`)).toBeAttached();
  // Alt and Left is also the browser's back: on a card, it's the card's.
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(status(page, `${top} is already in the first column.`)).toBeAttached();
  expect(page.url()).toBe(url);

  // Into the next column, keeping its place in the board's order: its state changes, and the focus follows it.
  const version = (await api.issue(top!)).version;
  const saved = ranked(page, board);
  await page.keyboard.press('Alt+ArrowRight');
  expect((await saved).postDataJSON()).toEqual({ issue: top, column: 'In Progress', expectedVersion: version });
  await expect(status(page, `Moved ${top} to In Progress.`)).toBeAttached();
  await expect(column(page, 'In Progress').getByRole('button', { name: `Move ${top} with a command` })).toBeFocused();
  expect(fieldValue(await api.issue(top!), 'State')).toBe('In Progress');
  expect(page.url()).toBe(url);
});

test("dragged into another column at a place, a card's state and its place change in one request", async ({ page, api }) => {
  const board = await boardWith(api, [
    ['Draft the security notice', 'Open'],
    ['Fix the flaky upload test', 'In Progress'],
    ['Tidy the release checklist', 'In Progress'],
  ]);
  await page.goto(`/boards/${board.id}`);
  await expect(column(page, 'In Progress').locator('li.board-card')).toHaveCount(2);
  const doing = await order(page, 'In Progress');
  const [moving] = await order(page, 'Open');
  const version = (await api.issue(moving!)).version;

  const saved = ranked(page, board);
  await pickUp(page, moving!);
  await carryOnto(page, cardOf(page, doing[0]!), 'lower', `Drop it to move ${moving} to In Progress, below ${doing[0]}`);
  await page.mouse.up();
  expect((await saved).postDataJSON()).toEqual({ issue: moving, column: 'In Progress', after: doing[0], expectedVersion: version });

  await expect.poll(() => order(page, 'In Progress')).toEqual([doing[0], moving, doing[1]]);
  await expect(status(page, `Moved ${moving} to In Progress, below ${doing[0]}.`)).toBeAttached();
  const now = await api.issue(moving!);
  expect(fieldValue(now, 'State')).toBe('In Progress');
  // One change of the issue's own, its state, with its version.
  expect(now.version).toBe(version + 1);
});

/** A project and a board with a lane per assignee (D65), its lanes keeping the board's order until a manager says otherwise. */
async function lanedBoard(api: Api, laneOrder = false): Promise<{ board: Board; key: string }> {
  const key = uniqueKey('LN');
  await api.createProject({ key, name: `Lanes ${key}` });
  const board = await api.createBoard({
    name: `Lanes ${key}`,
    projects: [key],
    swimlaneField: 'Assignee',
    laneOrder,
    columns: [
      { name: 'Open', values: ['Open'] },
      { name: 'Done', values: ['Fixed'] },
    ],
  });
  for (const [summary, who] of [
    ['Plan the data migration', SECOND.login],
    ['Write the rollback steps', SECOND.login],
    ['Book the maintenance window', SECOND.login],
    ['Review the alert rules', ADMIN.login],
    ['Rotate the on-call rota', ADMIN.login],
  ]) {
    await api.createIssue({ project: key, summary: summary!, fields: { State: 'Open', Assignee: who! } });
  }
  return { board, key };
}

const theirs = `Open, ${SECOND.name}`;
const admins = `Open, ${ADMIN.name}`;
const backlogOf = async (api: Api, board: Board) => (await api.get<Backlog>(`/boards/${board.id}/backlog`)).issues.map((i) => i.id);

test("a board's lanes keep their own order: turned on by its manager, moved by keyboard and by pointer, the backlog keeping the board's", async ({ page, api }) => {
  const { board } = await lanedBoard(api);
  await page.goto(`/boards/${board.id}`);
  await expect(column(page, theirs).locator('li.board-card')).toHaveCount(3);
  const backlog = await backlogOf(api, board);

  // Turned on from the board itself.
  const setting = page.getByRole('checkbox', { name: 'Each lane keeps its own order' });
  await expect(setting).not.toBeChecked();
  const saved = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/api/v1/boards/${board.id}`));
  await setting.check();
  expect((await saved).postDataJSON()).toEqual({ laneOrder: true });
  await expect(status(page, 'Each lane keeps its own order now.')).toBeAttached();
  await expect(setting).toBeChecked();

  // From the keyboard: Alt and Up, twice, takes the last of a lane to its top.
  const [t0, t1, t2] = await order(page, theirs);
  await idButton(page, t2!).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(status(page, `Moved ${t2} above ${t1}.`)).toBeAttached();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(status(page, `Moved ${t2} above ${t0}.`)).toBeAttached();
  await expect.poll(() => order(page, theirs)).toEqual([t2, t0, t1]);
  await expect(idButton(page, t2!)).toBeFocused();
  // A lane's moves leave the board's own order, the backlog's, as it was.
  expect(await backlogOf(api, board)).toEqual(backlog);
  await page.screenshot({ path: test.info().outputPath('board-lanes-light.png') });
  await expectAccessible(page);

  // By pointer: within a lane, then into another lane at a place in that lane's order.
  const [a0, a1] = await order(page, admins);
  await pickUp(page, a1!);
  await carryOnto(page, cardOf(page, a0!), 'upper', `Drop it to put ${a1} above ${a0}`);
  await page.mouse.up();
  await expect.poll(() => order(page, admins)).toEqual([a1, a0]);
  const moved = ranked(page, board);
  await pickUp(page, a0!);
  // Into the lane from its side, through its empty Done cell: coming in from above, the slot would open above every card.
  const onto = (await cardOf(page, t2!).boundingBox())!;
  const side = (await column(page, `Done, ${SECOND.name}`).boundingBox())!;
  await page.mouse.move(side.x + side.width / 2, onto.y + onto.height * 0.75, { steps: 12 });
  await carryOnto(page, cardOf(page, t2!), 'lower', `Drop it below ${t2} to give ${a0} to ${SECOND.name}`);
  await page.mouse.up();
  expect((await moved).postDataJSON()).toMatchObject({ issue: a0, column: 'Open', lane: SECOND.login, after: t2 });
  await expect.poll(() => order(page, theirs)).toEqual([t2, a0, t0, t1]);
  expect(fieldValue(await api.issue(a0!), 'Assignee')).toBe(SECOND.login);
  expect(await backlogOf(api, board)).toEqual(backlog);

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: test.info().outputPath('board-lanes-dark.png') });
  await expectAccessible(page);
  await page.emulateMedia({ colorScheme: 'light' });

  // Its issue's history says where it went, once for the two moves in a row.
  await page.goto(`/issues/${t2}`);
  await expect(page.getByText(`moved it above ${t0} on ${board.name}`)).toBeVisible();
  await expect(page.getByText(`moved it above ${t1} on`)).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('board-lanes-history.png') });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a board whose lanes keep their own order, and a card's place in its history, fit the screen", async ({ page, api }) => {
    const { board } = await lanedBoard(api, true);
    const view = await api.get<BoardView>(`/boards/${board.id}/view`);
    const assignee = (id: string) => (view.columns[0]!.issues.find((i) => i.id === id)?.fields.find((f) => f.name === 'Assignee')?.value as { login?: string } | null)?.login;
    const [first, , last] = view.order.filter((id) => assignee(id) === SECOND.login);
    await api.post(`/boards/${board.id}/rank`, { issue: last, before: first, column: 'Open' });
    await page.goto(`/boards/${board.id}`);
    await expect(page.getByRole('checkbox', { name: 'Each lane keeps its own order' })).toBeChecked();
    await expect.poll(() => order(page, theirs)).toEqual([last, first, expect.any(String)]);
    await page.screenshot({ path: test.info().outputPath('board-lanes-phone.png') });
    await expectNoSidewaysScroll(page);
    await page.goto(`/issues/${last}`);
    const line = page.getByText(`moved it above ${first} on ${board.name}`);
    await expect(line).toBeVisible();
    await line.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('board-lanes-history-phone.png') });
    await expectNoSidewaysScroll(page);
  });

  test('a card held still is picked up; a finger that moves at once swipes through the columns', async ({ page, api }) => {
    const board = await boardWith(api, [
      ['Shorten the sign-up form', 'Open'],
      ['Explain the export limits', 'Open'],
    ]);
    await page.goto(`/boards/${board.id}`);
    await expect(column(page, 'Open').locator('li.board-card')).toHaveCount(2);
    const [upper, lower] = await order(page, 'Open');
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    const frame = page.locator('.board-scroll');

    // A hold: still for a moment, the card is picked up, and carried above the other.
    const held = (await cardOf(page, lower!).boundingBox())!;
    const onto = (await cardOf(page, upper!).boundingBox())!;
    const start = { x: held.x + held.width / 2, y: held.y + held.height - 8 };
    const end = onto.y + onto.height * 0.25;
    const saved = ranked(page, board);
    await touch('touchStart', start.x, start.y);
    await page.waitForTimeout(400);
    for (let k = 1; k <= 10; k++) await touch('touchMove', start.x, start.y + ((end - start.y) * k) / 10);
    await expect(page.locator('li.board-drop').getByText(`Drop it to put ${lower} above ${upper}`)).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('board-rank-phone.png') });
    await expectNoSidewaysScroll(page);
    await touch('touchEnd');
    expect((await saved).postDataJSON()).toMatchObject({ issue: lower, column: 'Open', before: upper });
    await expect.poll(() => order(page, 'Open')).toEqual([lower, upper]);
    expect(await frame.evaluate((el) => el.scrollLeft)).toBe(0);

    // A swipe: the finger moves at once, so the columns scroll and nothing is picked up.
    let sent = 0;
    page.on('request', (r) => void (r.url().endsWith('/rank') && sent++));
    const from = (await cardOf(page, upper!).boundingBox())!;
    await touch('touchStart', from.x + from.width / 2, from.y + from.height - 8);
    for (let k = 1; k <= 12; k++) await touch('touchMove', from.x + from.width / 2 - k * 22, from.y + from.height - 8);
    await touch('touchEnd');
    await expect.poll(() => frame.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await expect(page.locator('li.board-drop')).toHaveCount(0);
    expect(sent).toBe(0);
    await expect.poll(() => order(page, 'Open')).toEqual([lower, upper]);
  });
});

test("someone else's rank shows on an open board without a reload", async ({ page, api }) => {
  const board = await boardWith(api, [
    ['Move the docs to the new host', 'In Progress'],
    ['Renew the TLS certificates', 'In Progress'],
    ['Archive the old sprint boards', 'In Progress'],
  ]);
  await page.goto(`/boards/${board.id}`);
  await expect(column(page, 'In Progress').locator('li.board-card')).toHaveCount(3);
  const before = await order(page, 'In Progress');
  await api.post(`/boards/${board.id}/rank`, { issue: before.at(-1), before: before[0], column: 'In Progress' });
  await expect.poll(() => order(page, 'In Progress'), { timeout: 15_000 }).toEqual([before.at(-1), ...before.slice(0, -1)]);
});
