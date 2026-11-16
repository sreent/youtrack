/** Checks every page is held to: axe finds nothing against WCAG 2.2 AA, and nothing scrolls sideways. */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect } from './fixtures';

const WCAG_22_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const contains = (hay: string[], needle: string[]) => hay.some((_, i) => needle.length > 0 && needle.every((w, j) => hay[i + j] === w));

/**
 * The one allowance: label-in-name (WCAG 2.5.3) counts a person's initials, drawn in their
 * avatar, as words a control shows. Ocean puts a person's Who, avatar and name, in a field's
 * value, and the avatar is hidden from screen readers, so "Assignee, Anna Schmidt" is the
 * control's whole name; nobody says "AS Anna Schmidt" to reach it. Such a finding is let go only
 * when the control's name holds every other word it shows, in order.
 */
async function onlyInitialsMissing(page: Page, selector: string): Promise<boolean> {
  const control = page.locator(selector);
  if ((await control.locator('.avatar').count()) === 0) return false;
  const name = /"(.*?)"/.exec((await control.ariaSnapshot()).split('\n')[0] ?? '')?.[1] ?? '';
  const shown = await control.evaluate((el) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('.avatar').forEach((a) => a.remove());
    return copy.textContent ?? '';
  });
  return contains(words(name), words(shown));
}

/** axe's findings against WCAG 2.2 AA, each as one line: the rule, what it wants, and where. */
export async function expectAccessible(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  const found: string[] = [];
  for (const v of violations) {
    const nodes = [];
    for (const n of v.nodes) {
      const selector = n.target.join(' ');
      if (v.id === 'label-content-name-mismatch' && (await onlyInitialsMissing(page, selector))) continue;
      nodes.push(selector);
    }
    if (nodes.length) found.push(`${v.id} (${v.impact}): ${v.help}, at ${nodes.slice(0, 5).join(' | ')}`);
  }
  expect(found, 'axe should find nothing against WCAG 2.2 AA').toEqual([]);
}

/**
 * The page is no wider than the window, so nothing makes a person scroll sideways. When it is,
 * the answer names what sticks out: the innermost elements past the window's right edge.
 */
export async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const sticksOut = () =>
    page.evaluate(() => {
      const root = document.documentElement;
      const over = root.scrollWidth - root.clientWidth;
      if (over <= 0) return [];
      const past = [...document.body.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > root.clientWidth + 0.5);
      const innermost = past.filter((el) => ![...el.children].some((c) => past.includes(c)));
      const name = (el: Element) => `${el.tagName.toLowerCase()}${[...el.classList].map((c) => `.${c}`).join('')}`;
      return [`${over}px wider than the window`, ...innermost.slice(0, 5).map((el) => `${name(el)} ends at ${Math.round(el.getBoundingClientRect().right)}px`)];
    });
  await expect.poll(sticksOut, { message: 'the page should not scroll sideways', timeout: 2_000 }).toEqual([]);
}
