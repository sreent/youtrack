/**
 * The suite's `test`: Playwright's, with what every spec gets.
 *
 * - Every page's clock is fixed at the run's start (env.ts), so times read the same throughout.
 * - Every page is watched: a console error, an uncaught error or a CSP violation fails the test,
 *   unless the test says it expects it (`watch.allow(/status of 409/)` where it provokes one).
 * - `api` reaches the REST API with the run's token.
 */
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { Api } from './api';
import { NOW } from './env';

export { expect };

export interface Watch {
  /** Say which console errors this test provokes on purpose, by pattern. */
  allow(...patterns: RegExp[]): void;
}

interface Watcher extends Watch {
  /** What went wrong that the test didn't expect. */
  unexpected(): string[];
}

/**
 * Fix the clock and watch every page of a context. The `watch` fixture does this for the test's
 * own context; a test that opens another context calls it for that one too.
 */
export async function prepareContext(context: BrowserContext): Promise<Watcher> {
  const problems: string[] = [];
  const allowed: RegExp[] = [];
  const watchPage = (page: Page) => {
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`uncaught: ${e.message}`));
  };
  context.pages().forEach(watchPage);
  context.on('page', watchPage);
  // Chrome logs a CSP violation to the console too; this names the directive and what it blocked.
  await context.exposeBinding('__a4aCspViolation', (_source, text: string) => {
    problems.push(`CSP violation: ${text}`);
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      const report = (window as unknown as { __a4aCspViolation(text: string): void }).__a4aCspViolation;
      void report(`${e.violatedDirective} blocked ${e.blockedURI || 'something inline'}${e.sample ? `: ${e.sample}` : ''}`);
    });
  });
  await context.clock.setFixedTime(NOW);
  return {
    allow: (...patterns) => allowed.push(...patterns),
    unexpected: () => problems.filter((p) => !allowed.some((re) => re.test(p))),
  };
}

export const test = base.extend<{ watch: Watch; api: Api }, { workerApi: Api }>({
  workerApi: [
    async ({}, use) => {
      const api = await Api.open();
      await use(api);
      await api.dispose();
    },
    { scope: 'worker' },
  ],
  api: async ({ workerApi }, use) => use(workerApi),
  watch: [
    async ({ context }, use) => {
      const watcher = await prepareContext(context);
      await use(watcher);
      expect(watcher.unexpected(), 'the pages should log no errors and break no CSP rule').toEqual([]);
    },
    { auto: true },
  ],
});

/**
 * Keep the live feed quiet: the page never hears of changes made elsewhere, as when a change
 * lands between a person seeing something and acting on it. The request stays open, unanswered.
 */
export async function holdLiveEvents(page: Page): Promise<void> {
  await page.route('**/api/v1/events/stream', () => {});
}

/** The page has drawn what it was loading: its heading is up and nothing says "Loading". */
export async function settled(page: Page): Promise<void> {
  await expect(page.getByRole('main').getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /Loading/ })).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}
