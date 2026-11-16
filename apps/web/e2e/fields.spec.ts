/** Fields: a field of this test's own is made, values are added to it, and put in another order. */
import type { Field } from '@a4a/shared';
import { unique } from './support/api';
import { SECOND_AUTH_FILE } from './support/env';
import { expect, test } from './support/fixtures';

// The second of the flows' administrators (support/env.ts says why).
test.use({ storageState: SECOND_AUTH_FILE });

test('values are added to a field, and put in another order', async ({ page, api }) => {
  const name = `Severity ${unique()}`;
  await page.goto('/fields');
  const make = page.getByRole('region', { name: 'Make a field' });
  await make.getByLabel('Name').fill(name);
  await make.getByLabel('What it holds').selectOption('enum');
  await make.getByRole('button', { name: 'Make the field' }).click();

  // The new field opens, with no values yet.
  const field = page.getByRole('region', { name });
  await expect(field.getByText('No values yet.')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Fields' }).getByRole('link', { name: new RegExp(`^${name}`) })).toHaveAttribute('aria-current', 'page');

  const add = field.getByRole('group', { name: 'Add a value' });
  for (const [value, tone] of [
    ['Cosmetic', ''],
    ['Data loss', 'bad'],
  ] as const) {
    await add.getByLabel('Name').fill(value);
    await add.getByLabel('Shows as').selectOption(tone);
    await add.getByRole('button', { name: 'Add the value' }).click();
    await expect(add.getByRole('status')).toHaveText(`${value} is added to ${name}.`);
  }

  const values = field.getByRole('list', { name: `Values of ${name}` });
  const order = () => values.getByRole('listitem').evaluateAll((items) => items.map((li) => li.querySelector('input')?.value));
  await expect.poll(order).toEqual(['Cosmetic', 'Data loss']);
  await expect(field.getByRole('button', { name: 'Move Cosmetic up' })).toBeDisabled();

  await field.getByRole('button', { name: 'Move Data loss up' }).click();
  await expect.poll(order).toEqual(['Data loss', 'Cosmetic']);
  await expect(field.getByRole('button', { name: 'Move Data loss up' })).toBeDisabled();

  const saved = (await api.get<Field[]>('/fields')).find((f) => f.name === name)!;
  expect([...saved.values].sort((a, b) => a.ordinal - b.ordinal).map((v) => [v.name, v.tone])).toEqual([
    ['Data loss', 'bad'],
    ['Cosmetic', null],
  ]);
});
