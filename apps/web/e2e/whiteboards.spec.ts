/**
 * Whiteboards (D58): Una makes a whiteboard and two notes, connects them and takes back a note she
 * didn't mean; Theo, in a browser of his own, sees her changes as she makes them and she his, and
 * both are listed as looking; she makes issues of the two notes and a link of their arrow, and a
 * card follows its issue when it changes. From the keyboard where a person would use it.
 */
import type { Whiteboard } from '@a4a/shared';
import type { Page } from '@playwright/test';
import { uniqueKey } from './support/api';
import { SECOND, SECOND_AUTH_FILE, THIRD, THIRD_AUTH_FILE } from './support/env';
import { expect, prepareContext, test } from './support/fixtures';

test.use({ storageState: THIRD_AUTH_FILE });

const outline = (page: Page) => page.getByRole('navigation', { name: 'Outline' });
const canvas = (page: Page) => page.getByRole('group', { name: /^Planning [A-Z0-9]+, \d+ elements?$/ });

async function addNote(page: Page, text: string, tone: string) {
  await page.getByRole('toolbar', { name: 'Whiteboard tools' }).getByRole('button', { name: 'Add a note' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a note' });
  await dialog.getByLabel('What it says').fill(text);
  await dialog.getByRole('radio', { name: tone }).check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
}

test('two people plan on a whiteboard, and its notes and arrow become issues and a link', async ({ page, api, browser }) => {
  const key = uniqueKey('WB');
  await api.createProject({ key, name: `Whiteboards ${key}` });
  const name = `Planning ${key}`;

  // Una makes the whiteboard in her project.
  await page.goto(`/whiteboards?project=${key}`);
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Project', { exact: true }).selectOption(key);
  await page.getByRole('button', { name: 'Make it' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  const id = page.url().split('/').pop()!;

  await addNote(page, 'Login is slow\nIt takes four seconds on the mobile app.', 'Problem');
  await addNote(page, 'Cache the session', 'Idea');
  await expect(outline(page).getByRole('button', { name: /Note, problem.*Login is slow/ })).toBeVisible();
  await expect(canvas(page).getByRole('button', { name: /^Note, idea: Cache the session/ })).toBeVisible();

  // Theo opens it in a browser of his own: he sees her notes, and both of them are looking.
  const theirs = await browser.newContext({ storageState: SECOND_AUTH_FILE });
  const theo = await theirs.newPage();
  const watch = await prepareContext(theirs);
  await theo.goto(`/whiteboards/${id}`);
  await expect(outline(theo).getByRole('button', { name: /Cache the session/ })).toBeVisible();
  const looking = (p: Page) => p.getByRole('list', { name: 'Looking now' });
  await expect(looking(page)).toContainText(SECOND.name);
  await expect(looking(theo)).toContainText(THIRD.name);

  // She connects her two notes, from the keyboard's dialog; he sees the arrow within moments.
  await page.getByRole('toolbar', { name: 'Whiteboard tools' }).getByRole('button', { name: 'Connect' }).click();
  const connect = page.getByRole('dialog', { name: 'Connect two elements' });
  await connect.getByLabel('From').selectOption({ label: 'Note, problem: Login is slow' });
  await connect.getByLabel('To').selectOption({ label: 'Note, idea: Cache the session' });
  await connect.getByLabel('Label (if any)').fill('fixed by');
  await connect.getByRole('button', { name: 'Connect them' }).click();
  await expect(outline(theo).getByRole('button', { name: /Arrow.*Login is slow → Cache the session: fixed by/ })).toBeVisible();

  // He adds a note while she moves hers with the arrow keys: both land, on both pages.
  await addNote(theo, 'Who owns the session store?', 'Question');
  await outline(page).getByRole('button', { name: /Note, problem.*Login is slow/ }).click();
  const login = canvas(page).getByRole('button', { name: /^Note, problem: Login is slow/ });
  await expect(login).toBeFocused();
  const before = await login.getAttribute('transform');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('status').filter({ hasText: 'Moved 1 element.' })).toBeVisible();
  const after = await login.getAttribute('transform');
  expect(after).not.toBe(before);
  await expect(canvas(theo).getByRole('button', { name: /^Note, problem: Login is slow/ })).toHaveAttribute('transform', after!);
  await expect(outline(page).getByRole('button', { name: /Who owns the session store/ })).toBeVisible();

  // A note she didn't mean: added, then taken back with Ctrl+Z, and brought back with Ctrl+Shift+Z.
  await addNote(page, 'A stray thought', 'Plain');
  await expect(outline(theo).getByRole('button', { name: /A stray thought/ })).toBeVisible();
  await canvas(page).getByRole('button', { name: /A stray thought/ }).focus();
  await page.keyboard.press('Control+z');
  await expect(outline(page).getByRole('button', { name: /A stray thought/ })).toHaveCount(0);
  await expect(outline(theo).getByRole('button', { name: /A stray thought/ })).toHaveCount(0);
  await page.keyboard.press('Control+Shift+z');
  await expect(outline(page).getByRole('button', { name: /A stray thought/ })).toBeVisible();
  await page.keyboard.press('Control+z');
  await expect(outline(page).getByRole('button', { name: /A stray thought/ })).toHaveCount(0);

  // She chooses her two notes and makes issues of them, and a link of their arrow, checking first.
  await outline(page).getByRole('button', { name: /Note, problem.*Login is slow/ }).click();
  await outline(page).getByRole('button', { name: /Note, idea.*Cache the session/ }).click({ modifiers: ['Shift'] });
  await page.getByRole('toolbar', { name: 'Whiteboard tools' }).getByRole('button', { name: 'Make issues' }).click();
  const convert = page.getByRole('dialog', { name: 'Make issues' });
  await expect(convert.getByRole('checkbox', { name: 'Login is slow', exact: true })).toBeChecked();
  await expect(convert.getByRole('checkbox', { name: 'Login is slow → Cache the session', exact: true })).toBeChecked();
  await convert.getByLabel(/^How Login is slow relates to Cache the session$/).selectOption('depends on');
  await convert.getByRole('button', { name: 'Check first' }).click();
  await expect(convert.getByText('Would become an issue: Login is slow.')).toBeVisible();
  await convert.getByRole('button', { name: 'Make 2 issues' }).click();
  await expect(convert.getByText(new RegExp(`Became ${key}-1: Login is slow\\.`))).toBeVisible();
  await expect(convert.getByText(`Linked: ${key}-1 depends on ${key}-2.`)).toBeVisible();
  await convert.getByRole('button', { name: 'Close' }).click();

  // The notes are their issues' cards now, where they were, for both of them; the arrow is the link.
  const card = (p: Page) => canvas(p).getByRole('button', { name: new RegExp(`^Issue ${key}-1: Login is slow`) });
  await expect(card(page)).toBeVisible();
  await expect(card(theo)).toBeVisible();
  await expect(outline(theo).getByRole('button', { name: /Arrow, linked: depends on/ })).toBeVisible();

  // The issue's history says where it came from.
  const issue = await api.issue(`${key}-1`);
  expect(issue.description).toBe('It takes four seconds on the mobile app.');
  expect(issue.links.some((l) => l.issue.id === `${key}-2` && l.phrase === 'depends on')).toBe(true);

  // A card follows its issue: changed elsewhere, both pages show it within moments.
  await api.updateIssue(`${key}-1`, { summary: 'Login is slow on phones', fields: { State: 'In Progress' } });
  const renamed = (p: Page) => canvas(p).getByRole('button', { name: new RegExp(`^Issue ${key}-1: Login is slow on phones, In Progress`) });
  await expect(renamed(page)).toBeVisible();
  await expect(renamed(theo)).toBeVisible();

  // When it's deleted, Theo's page says so.
  const boards = await api.get<Whiteboard[]>(`/whiteboards?project=${key}`);
  expect(boards.map((b) => b.id)).toContain(id);
  await api.delete(`/whiteboards/${id}`);
  await expect(theo.getByText('This whiteboard was deleted, or you can no longer see it.')).toBeVisible();
  expect(watch.unexpected()).toEqual([]);
  await theirs.close();
  await page.goto(`/issues/${key}-1`);
  await expect(page.getByText(`made it from a note on the whiteboard ${name}`)).toBeVisible();
});
