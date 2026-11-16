/**
 * Every page, light, dark and on a phone (390px): nothing goes wrong in the console, the CSP
 * blocks nothing, nothing scrolls sideways, and axe finds nothing against WCAG 2.2 AA.
 *
 * The tour only reads, so its stops run at once. It holds the live feed, so what other specs
 * change meanwhile can't redraw a page in the middle of a check. It's taken by an administrator
 * of its own (support/env.ts says why).
 *
 * A new page joins the tour with one line in STOPS: its address, and what shows once it's drawn.
 * What the server can't show without AI (a conversation, suggestions waiting) is stood in for.
 */
import type { Locator, Page } from '@playwright/test';
import { BACK_3_TRIAGE, mockStoredConversation, mockWaitingSuggestions, takeIssue, triageSuggestion } from './support/ai';
import type { Api } from './support/api';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { TOUR_AUTH_FILE } from './support/env';
import { expect, holdLiveEvents, settled, test } from './support/fixtures';

interface Stop {
  name: string;
  /** The address, or how to arrive at it: finding a board's id, or standing in for the AI. */
  path: string | ((api: Api, page: Page) => Promise<string>);
  /** Something that shows only once the page has drawn what it's for. */
  ready: (page: Page) => Locator;
}

const waitingOnBack3 = (to: string) => async (_api: Api, page: Page) => {
  await mockWaitingSuggestions(page, [triageSuggestion('BACK-3', BACK_3_TRIAGE)]);
  return to;
};

const board = (name: string) => async (api: Api) => {
  const found = (await api.boards()).find((b) => b.name === name);
  if (!found) throw new Error(`The demo data has no board "${name}"`);
  return `/boards/${found.id}`;
};

const STOPS: Stop[] = [
  { name: 'issues', path: '/issues', ready: (p) => p.getByRole('list', { name: /^\d+ issues$/ }) },
  { name: 'an issue with comments and work', path: '/issues/BACK-2', ready: (p) => p.getByRole('heading', { name: 'History and comments' }) },
  { name: 'an issue just reported', path: '/issues/BACK-3', ready: (p) => p.getByRole('heading', { name: 'History and comments' }) },
  { name: "an issue with triage's values waiting", path: waitingOnBack3('/issues/BACK-3'), ready: (p) => p.getByText('Dashed values were worked out by an agent') },
  { name: 'a new issue', path: '/issues/new', ready: (p) => p.getByLabel('Summary') },
  { name: 'boards', path: '/boards', ready: (p) => p.getByRole('link', { name: 'Backend sprints' }) },
  { name: 'a sprint board', path: board('Backend sprints'), ready: (p) => p.getByRole('group', { name: "Sprint 14's columns" }) },
  { name: 'a kanban board with lanes', path: board('Web kanban'), ready: (p) => p.getByRole('group', { name: "Web kanban's columns" }) },
  { name: 'plans', path: '/plan', ready: (p) => p.getByRole('link', { name: 'Data center migration' }) },
  { name: 'a timeline', path: '/plan/MIG', ready: (p) => p.getByRole('group', { name: /^Data center migration, / }) },
  { name: 'who is booked', path: '/plan/MIG/resources', ready: (p) => p.getByRole('table', { name: "Who's booked, and how much" }) },
  { name: 'costs', path: '/plan/MIG/costs', ready: (p) => p.getByRole('heading', { name: 'Cost against plan' }) },
  { name: 'the assistant', path: '/assistant', ready: (p) => p.getByRole('navigation', { name: 'Your conversations' }) },
  {
    name: 'a conversation waiting on you',
    path: (_api, page) => mockStoredConversation(page, takeIssue({ id: 'BACK-6', summary: 'Document the v2 authentication flow' }, 'BACK').script),
    ready: (p) => p.getByRole('region', { name: 'assistant asks to update an issue' }),
  },
  { name: 'suggestions', path: '/suggestions', ready: (p) => p.getByRole('heading', { name: 'Nothing waits on you' }) },
  { name: 'suggestions waiting on you', path: waitingOnBack3('/suggestions'), ready: (p) => p.getByRole('region', { name: 'triage suggests changes to BACK-3' }) },
  { name: 'projects', path: '/projects', ready: (p) => p.getByRole('region', { name: 'Table of projects' }) },
  { name: 'a project', path: '/projects/MIG', ready: (p) => p.getByRole('heading', { name: 'Plan settings' }) },
  { name: 'fields', path: '/fields', ready: (p) => p.getByRole('heading', { name: 'Make a field' }) },
  { name: 'activity', path: '/activity', ready: (p) => p.getByRole('region', { name: 'The ledger' }) },
  { name: 'agents and tokens', path: '/agents', ready: (p) => p.getByRole('heading', { name: /^What they read/ }) },
  { name: 'webhooks', path: '/webhooks', ready: (p) => p.getByRole('heading', { name: 'Where it sends' }) },
  { name: 'administration', path: '/admin', ready: (p) => p.getByRole('region', { name: 'Table of people' }) },
  { name: 'your profile', path: '/me', ready: (p) => p.getByRole('heading', { name: 'Password' }) },
  { name: 'the knowledge base', path: '/articles?project=BACK', ready: (p) => p.getByRole('link', { name: 'Database failover' }).first() },
  { name: 'an article', path: '/articles/BACK-A-2', ready: (p) => p.getByRole('article', { name: 'Database failover' }) },
  { name: "an article's versions", path: '/articles/BACK-A-2/history', ready: (p) => p.getByRole('heading', { name: /^Version \d+$/ }) },
  { name: 'writing an article', path: '/articles/BACK-A-2/edit', ready: (p) => p.getByRole('form', { name: 'Editing BACK-A-2' }) },
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
        const path = typeof stop.path === 'string' ? stop.path : await stop.path(api, page);
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
