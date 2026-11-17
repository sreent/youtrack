/**
 * Renaming a project's key (D52): its managers type the new key, then type it again to confirm. Its
 * issues keep their numbers, an old link opens the issue under its new id, and the old key still
 * finds the project.
 */
import { unique, uniqueKey } from './support/api';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { THIRD_AUTH_FILE } from './support/env';
import { expect, test } from './support/fixtures';

// Una, the third of the flows' administrators: nothing here needs `admin`'s own name (support/env.ts says why).
test.use({ storageState: THIRD_AUTH_FILE });

test("a project's key is renamed, and an old link still opens its issue", async ({ page, api }) => {
  const from = uniqueKey('RK');
  const to = uniqueKey('RN');
  await api.createProject({ key: from, name: `Renamed ${unique()}`, template: 'software' });
  const summary = `Opened by its old id ${unique()}`;
  const issue = await api.createIssue({ project: from, summary });
  expect(issue.id).toBe(`${from}-1`);

  await page.goto(`/projects/${from}`);
  const section = page.getByRole('region', { name: 'Key', exact: true });
  await expect(section).toContainText(`${from}-12`);
  const rename = section.getByRole('button', { name: 'Rename the key' });
  // Nothing to rename to yet, nor to its own key.
  await expect(rename).toBeDisabled();
  await section.getByLabel('New key').fill(from.toLowerCase());
  await expect(rename).toBeDisabled();
  await section.getByLabel('New key').fill(to.toLowerCase());
  await rename.click();

  // The new key typed again, as Ocean's Confirm asks; Escape keeps it as it was.
  const dialog = page.getByRole('dialog', { name: `Rename ${from} to ${to}?` });
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole('button', { name: 'Rename it' });
  await expect(confirm).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect((await api.get<{ key: string }>(`/projects/${from}`)).key).toBe(from);
  await rename.click();
  await expect(dialog.getByLabel(`Type ${to} again`)).toBeFocused();
  await dialog.getByLabel(`Type ${to} again`).fill(to.slice(0, -1));
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(`Type ${to} again`).fill(to.toLowerCase());
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(page).toHaveURL(new RegExp(`/projects/${to}$`));
  await expect(section).toContainText(`${from} is ${to} now. Its old ids still find its issues.`);
  await expect(section).toContainText(`Before, it went by ${from}.`);
  expect((await api.issue(`${from}-1`)).id).toBe(`${to}-1`);

  // An old link opens the issue at its new id, and says which it was asked for by.
  await page.goto(`/issues/${from}-1`);
  await expect(page).toHaveURL(new RegExp(`/issues/${to}-1$`));
  await expect(page.getByRole('heading', { name: summary })).toBeVisible();
  await expect(page.getByText(`was ${from}-1`)).toBeVisible();

  // The project's old address goes to the new one, and its old key still finds it in a query.
  await page.goto(`/projects/${from}`);
  await expect(page).toHaveURL(new RegExp(`/projects/${to}$`));
  expect((await api.search(`project: ${from}`)).items.map((i) => i.id)).toEqual([`${to}-1`]);
});

for (const mode of [
  { name: 'light', use: { colorScheme: 'light' as const } },
  { name: 'dark', use: { colorScheme: 'dark' as const } },
  { name: 'phone', use: { colorScheme: 'light' as const, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
]) {
  test.describe(mode.name, () => {
    test.use(mode.use);
    test('the key, the keys it had and the rename read well', async ({ page, api }, info) => {
      const from = uniqueKey('RL');
      await api.createProject({ key: from, name: `Read well ${unique()}`, template: 'blank' });
      await api.post(`/projects/${from}/key`, { key: uniqueKey('RM') });
      const p = await api.get<{ key: string }>(`/projects/${from}`);
      await page.goto(`/projects/${p.key}`);
      const section = page.getByRole('region', { name: 'Key', exact: true });
      await expect(section).toContainText(`Before, it went by ${from}.`);
      await section.getByLabel('New key').fill(uniqueKey('RP'));
      await expectAccessible(page);
      await expectNoSidewaysScroll(page);
      await section.screenshot({ path: info.outputPath('key.png') });
      // From the keyboard: the button, then the field typed again, then the answer.
      await section.getByRole('button', { name: 'Rename the key' }).focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expectAccessible(page);
      await page.screenshot({ path: info.outputPath('dialog.png') });
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    });
  });
}
