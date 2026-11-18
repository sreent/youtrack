/**
 * Guests beyond issues (D64): someone signed out reads a board, the reports, a plan and a whiteboard
 * of a project open to anyone, from the guest pages, with nothing offered that would change them, and
 * nothing of a project that isn't open to guests.
 */
import type { Page } from '@playwright/test';
import { uniqueKey, type Api } from './support/api';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { expect, settled, test } from './support/fixtures';

// The page is a guest's: no cookies at all. The API's token sets things up.
test.use({ storageState: { cookies: [], origins: [] } });

async function looksRight(page: Page) {
  await settled(page);
  await expectNoSidewaysScroll(page);
  await expectAccessible(page);
}

/** A project open to guests, with a board, a whiteboard and a plan's tasks; and one that isn't. */
async function garden(api: Api) {
  const key = uniqueKey('GO');
  const name = `Garden ${key}`;
  await api.createProject({ key, name, template: 'waterfall' });
  const beans = await api.createIssue({ project: key, summary: 'Plant the beans', fields: { Estimation: '2d' } });
  await api.createIssue({ project: key, summary: 'Build the fence', fields: { Estimation: '3d' } });
  await api.createIssue({ project: key, summary: 'Hidden compost deal', visibleTo: { users: [], groups: [] } });
  const board = await api.createBoard({ name: `Garden board ${key}`, projects: [key] });
  const whiteboard = await api.post<{ id: string }>('/whiteboards', { project: key, name: `Garden sketch ${key}` });
  await api.post(`/whiteboards/${whiteboard.id}/elements`, {
    ops: [
      { op: 'add', id: 'water-note', kind: 'note', x: 0, y: 0, text: 'Water on Sundays' },
      { op: 'add', id: 'beans-card', kind: 'issue', x: 260, y: 0, issue: beans.id },
    ],
  });
  await api.patch(`/projects/${key}`, { guestAccess: true });

  const shut = uniqueKey('GS');
  await api.createProject({ key: shut, name: `Shed ${shut}` });
  await api.createIssue({ project: shut, summary: 'Lock the shed' });
  const shutBoard = await api.createBoard({ name: `Shed board ${shut}`, projects: [shut] });
  const shutWhiteboard = await api.post<{ id: string }>('/whiteboards', { project: shut, name: `Shed sketch ${shut}` });
  return { key, name, board, whiteboard, shut, shutBoard, shutWhiteboard };
}

test('a guest reads a board, the reports, a plan and a whiteboard, and changes nothing', async ({ page, api }) => {
  const g = await garden(api);
  await page.goto(`/public?project=${g.key}`);
  const more = page.getByRole('region', { name: `Also open in ${g.name}` });
  await expect(more).toBeVisible();
  await looksRight(page);

  // The board: the cards a guest may see, and nothing that moves one.
  await more.getByRole('link', { name: `Garden board ${g.key}` }).click();
  await expect(page.getByRole('heading', { level: 1, name: `Garden board ${g.key}` })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Plant the beans' })).toBeVisible();
  await expect(page.getByText('Hidden compost deal')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /with a command/ })).toHaveCount(0);
  await expect(page.getByText(/Drag a card/)).toHaveCount(0);
  await looksRight(page);
  // A card opens its issue on the guest's own page.
  await page.getByRole('link', { name: 'Plant the beans' }).click();
  await expect(page).toHaveURL(/\/public\/issues\//);
  await expect(page.getByRole('heading', { level: 1, name: 'Plant the beans' })).toBeVisible();

  // The reports: over what guests see, never the time report.
  await page.goto(`/public?project=${g.key}`);
  await more.getByRole('link', { name: 'Reports' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();
  const choice = page.getByRole('group', { name: 'Which report' });
  await expect(choice.getByRole('button', { name: 'Time', exact: true })).toHaveCount(0);
  await choice.getByRole('button', { name: 'Issues per field' }).click();
  await expect(page.getByLabel('Project')).toHaveValue(g.key);
  await expect(page.getByRole('region', { name: 'Issues per field' }).getByText(/Normal/).first()).toBeVisible();
  await looksRight(page);

  // The plan: its tasks over time, and no baseline, what-if or levelling.
  await page.goto(`/public?project=${g.key}`);
  await more.getByRole('link', { name: 'Plan' }).click();
  await expect(page.getByRole('heading', { level: 1, name: `${g.name}'s plan` })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Build the fence' })).toBeVisible();
  await expect(page.getByText('Hidden compost deal')).toHaveCount(0);
  for (const offered of ['What if', 'Save a baseline']) await expect(page.getByRole('button', { name: offered })).toHaveCount(0);
  await looksRight(page);

  // The whiteboard: read only, and live.
  await page.goto(`/public?project=${g.key}`);
  await more.getByRole('link', { name: `Garden sketch ${g.key}` }).click();
  await expect(page.getByRole('heading', { level: 1, name: `Garden sketch ${g.key}` })).toBeVisible();
  await expect(page.getByText('You’re reading this whiteboard as a guest')).toBeVisible();
  const outline = page.getByRole('navigation', { name: 'Outline' });
  await expect(outline.getByRole('button', { name: /Water on Sundays/ })).toBeVisible();
  await expect(outline.getByRole('button', { name: /Plant the beans/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add a note' })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Looking now' })).toHaveCount(0);
  await looksRight(page);
  await api.post(`/whiteboards/${g.whiteboard.id}/elements`, { ops: [{ op: 'add', id: 'fresh-note', kind: 'note', x: 0, y: 220, text: 'Mulch in May' }] });
  await expect(outline.getByRole('button', { name: /Mulch in May/ })).toBeVisible({ timeout: 10_000 });

  await api.patch(`/projects/${g.key}`, { guestAccess: false });
});

test('a guest finds nothing of a project that isn’t open to guests', async ({ page, api, watch }) => {
  // Each page asks for what isn't open, and the browser logs the 404 it gets, as for one that doesn't exist.
  watch.allow(/status of 404/);
  const g = await garden(api);
  await page.goto(`/public/boards/${g.shutBoard.id}`);
  await expect(page.getByText('There’s no such board open to guests.')).toBeVisible();
  await expect(page.getByText(`Shed board ${g.shut}`)).toHaveCount(0);
  await page.goto(`/public/whiteboards/${g.shutWhiteboard.id}`);
  await expect(page.getByText('There’s no such whiteboard open to guests.')).toBeVisible();
  await page.goto(`/public/plan/${g.shut}`);
  await expect(page.getByText('There’s no such project open to guests.')).toBeVisible();
  await looksRight(page);
  // The guest-open project's pages name nothing of the other.
  await page.goto(`/public?project=${g.key}`);
  await expect(page.getByRole('region', { name: `Also open in ${g.name}` })).toBeVisible();
  await expect(page.getByText(`Shed board ${g.shut}`)).toHaveCount(0);
  await expect(page.getByText(`Shed sketch ${g.shut}`)).toHaveCount(0);
  await api.patch(`/projects/${g.key}`, { guestAccess: false });
});
