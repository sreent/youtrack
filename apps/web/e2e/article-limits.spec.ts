/**
 * Articles limited to some people (D51): an article's page limits it to one person, and someone
 * outside the limit finds neither it nor what's under it: not in the tree, not at its address, not
 * by searching for it.
 */
import type { Page } from '@playwright/test';
import type { ArticleDetail } from '@a4a/shared';
import { unique, uniqueKey, type Api } from './support/api';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { expect, test } from './support/fixtures';
import { THIRD_AUTH_FILE } from './support/env';

// The third of the flows' administrators (support/env.ts says why).
test.use({ storageState: THIRD_AUTH_FILE });

const PASSWORD = 'e2e-person-pass-1';

async function person(api: Api, name: string) {
  const login = `${name.split(' ')[0]!.toLowerCase()}.${unique()}`;
  await api.createUser({ login, name, password: PASSWORD, role: 'member' });
  return { login, name };
}

async function signIn(page: Page, login: string) {
  await page.goto('/login');
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/issues$/);
}

test('an article limited to one person is missing to anyone else, and so is what is under it', async ({ page, api, browser }) => {
  const key = uniqueKey('KL');
  const name = `People ops ${key}`;
  await api.createProject({ key, name });
  const erin = await person(api, 'Erin Hall');
  const ravi = await person(api, 'Ravi Menon');
  const top = await api.post<ArticleDetail>('/articles', { project: key, title: 'Salary bands for 2027', body: 'Band C starts at 72k.' });
  const under = await api.post<ArticleDetail>('/articles', { project: key, title: 'Band C in detail', parent: top.id });
  await api.post<ArticleDetail>('/articles', { project: key, title: 'Holiday calendar' });

  await page.goto(`/articles/${top.id}`);
  const card = page.getByRole('region', { name: 'Visible to' });
  await expect(card.getByText(`Everyone who sees ${key}.`)).toBeVisible();
  await card.getByRole('button', { name: 'Limit who sees it' }).click();
  await card.getByLabel('People').selectOption({ value: erin.login });
  await card.getByRole('button', { name: 'Limit it to them' }).click();
  await expect(card.getByRole('status')).toHaveText(`It's limited to ${erin.name} now, besides those who always see it.`);
  await expect(card.getByRole('listitem').filter({ hasText: erin.name })).toBeVisible();
  // The tree marks it; what's under it says whose limit it takes.
  const tree = page.getByRole('navigation', { name: `${name}'s knowledge base` });
  await expect(tree.getByRole('link', { name: /Salary bands for 2027/ }).getByText('Limited')).toBeVisible();
  await page.goto(`/articles/${under.id}`);
  await expect(page.getByRole('region', { name: 'Visible to' }).getByText('It sits under Salary bands for 2027: only who sees that article sees it.')).toBeVisible();
  // Both, light, dark and on a phone: axe finds nothing, and nothing scrolls sideways.
  for (const [colorScheme, width] of [['light', 1280], ['dark', 1280], ['light', 390]] as const) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width, height: 900 });
    for (const id of [top.id, under.id]) {
      await page.goto(`/articles/${id}`);
      await expect(page.getByRole('region', { name: 'Visible to' }).getByRole('button').first()).toBeVisible();
      await expectAccessible(page);
      await expectNoSidewaysScroll(page);
    }
  }

  // Ravi reads the project, but not what's limited to Erin.
  const outside = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const other = await outside.newPage();
    await signIn(other, ravi.login);
    await other.goto(`/articles?project=${key}`);
    const theirs = other.getByRole('navigation', { name: `${name}'s knowledge base` });
    await expect(theirs.getByRole('link', { name: /Holiday calendar/ })).toBeVisible();
    await expect(theirs.getByRole('link', { name: /Salary bands/ })).toHaveCount(0);
    await expect(other.getByText('Band C in detail')).toHaveCount(0);
    for (const id of [top.id, under.id]) {
      await other.goto(`/articles/${id}`);
      await expect(other.getByText(`There's no article ${id}, or you can't see it.`)).toBeVisible();
      await expect(other.getByText('Salary bands for 2027')).toHaveCount(0);
    }
    await other.goto(`/articles?project=${key}&q=${encodeURIComponent('salary bands')}`);
    await expect(other.getByText('Nothing matches. Try fewer words, or the start of one.')).toBeVisible();
    await expect(other.getByText('72k')).toHaveCount(0);
  } finally {
    await outside.close();
  }
});
