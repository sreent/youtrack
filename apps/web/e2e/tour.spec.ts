/**
 * Every page, light, dark and on a phone (390px): nothing goes wrong in the console, the CSP
 * blocks nothing, nothing scrolls sideways, and axe finds nothing against WCAG 2.2 AA.
 *
 * The tour only reads, so its stops run at once. It holds the live feed, so what other specs
 * change meanwhile can't redraw a page in the middle of a check. It's taken by an administrator
 * of its own (support/env.ts says why).
 *
 * A new page joins the tour with one line in STOPS: its address, and what shows once it's drawn.
 */
import type { Locator, Page } from '@playwright/test';
import type { Api } from './support/api';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { TOUR_AUTH_FILE } from './support/env';
import { expect, holdLiveEvents, settled, test } from './support/fixtures';

interface Stop {
  name: string;
  /** The address, or how to find it (a board's id). */
  path: string | ((api: Api) => Promise<string>);
  /** Something that shows only once the page has drawn what it's for. */
  ready: (page: Page) => Locator;
}

const board = (name: string) => async (api: Api) => {
  const found = (await api.boards()).find((b) => b.name === name);
  if (!found) throw new Error(`The demo data has no board "${name}"`);
  return `/boards/${found.id}`;
};

const STOPS: Stop[] = [
  { name: 'issues', path: '/issues', ready: (p) => p.getByRole('list', { name: /^\d+ issues$/ }) },
  { name: 'an issue with comments and work', path: '/issues/BACK-2', ready: (p) => p.getByRole('heading', { name: 'History and comments' }) },
  { name: 'an issue just reported', path: '/issues/BACK-3', ready: (p) => p.getByRole('heading', { name: 'History and comments' }) },
  { name: 'a new issue', path: '/issues/new', ready: (p) => p.getByLabel('Summary') },
  { name: 'boards', path: '/boards', ready: (p) => p.getByRole('link', { name: 'Backend sprints' }) },
  { name: 'a sprint board', path: board('Backend sprints'), ready: (p) => p.getByRole('group', { name: "Sprint 14's columns" }) },
  { name: 'a kanban board with lanes', path: board('Web kanban'), ready: (p) => p.getByRole('group', { name: "Web kanban's columns" }) },
  { name: 'plans', path: '/plan', ready: (p) => p.getByRole('link', { name: 'Data center migration' }) },
  { name: 'a timeline', path: '/plan/MIG', ready: (p) => p.getByRole('group', { name: /^Data center migration, / }) },
  { name: 'who is booked', path: '/plan/MIG/resources', ready: (p) => p.getByRole('table', { name: "Who's booked, and how much" }) },
  { name: 'costs', path: '/plan/MIG/costs', ready: (p) => p.getByRole('heading', { name: 'Cost against plan' }) },
  { name: 'the assistant', path: '/assistant', ready: (p) => p.getByRole('navigation', { name: 'Your conversations' }) },
  { name: 'suggestions', path: '/suggestions', ready: (p) => p.getByRole('heading', { name: /waits on you|Waiting on you/ }) },
  { name: 'projects', path: '/projects', ready: (p) => p.getByRole('region', { name: 'Table of projects' }) },
  { name: 'a project', path: '/projects/MIG', ready: (p) => p.getByRole('heading', { name: 'Plan settings' }) },
  { name: 'fields', path: '/fields', ready: (p) => p.getByRole('heading', { name: 'Make a field' }) },
  { name: 'activity', path: '/activity', ready: (p) => p.getByRole('region', { name: 'The ledger' }) },
  { name: 'agents and tokens', path: '/agents', ready: (p) => p.getByRole('heading', { name: /^What they read/ }) },
  { name: 'webhooks', path: '/webhooks', ready: (p) => p.getByRole('heading', { name: 'Where it sends' }) },
  { name: 'administration', path: '/admin', ready: (p) => p.getByRole('region', { name: 'Table of people' }) },
  { name: 'your profile', path: '/me', ready: (p) => p.getByRole('heading', { name: 'Password' }) },
];

const MODES = [
  { name: 'light', use: { colorScheme: 'light' as const } },
  { name: 'dark', use: { colorScheme: 'dark' as const } },
  { name: 'phone', use: { colorScheme: 'light' as const, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];

test.describe.configure({ mode: 'parallel' });
test.use({ storageState: TOUR_AUTH_FILE });

async function visit(page: Page, path: string, ready: Locator) {
  await holdLiveEvents(page);
  await page.goto(path);
  await expect(ready.first()).toBeVisible();
  await settled(page);
  await expectNoSidewaysScroll(page);
  await expectAccessible(page);
}

for (const mode of MODES) {
  test.describe(mode.name, () => {
    test.use(mode.use);

    for (const stop of STOPS) {
      test(stop.name, async ({ page, api }) => {
        const path = typeof stop.path === 'string' ? stop.path : await stop.path(api);
        await visit(page, path, stop.ready(page));
      });
    }

    test.describe('signed out', () => {
      test.use({ storageState: { cookies: [], origins: [] } });
      test('sign in', async ({ page }) => {
        await visit(page, '/login', page.getByRole('button', { name: 'Sign in' }));
      });
    });
  });
}
