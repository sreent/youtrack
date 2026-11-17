/**
 * The visual editor (docs/architecture.md, D39): what's written is Markdown, kept as Markdown, and
 * written as it reads; a screenshot pasted goes in the text as one of the issue's or the article's
 * files; a checklist is ticked where it's read, against the version read, and a change made
 * meanwhile says so and reloads. Signed in as the first of the flows' administrators.
 */
import type { ArticleDetail, Comment, IssueDetail } from '@a4a/shared';
import type { Locator, Page } from '@playwright/test';
import { uniqueKey, type Api } from './support/api';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { ADMIN, GUIDE } from './support/env';
import { expect, holdLiveEvents, test } from './support/fixtures';

/** One red pixel: a real PNG, so the page can draw it. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const IMAGE = /^\/api\/v1\/attachments\/[A-Za-z0-9_-]+\/image$/;

/** Paste a file, as a screenshot is pasted: a clipboard with the file and nothing else. */
async function paste(field: Locator, name: string, type = 'image/png', base64 = PNG) {
  await field.evaluate(
    (el, f) => {
      const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], f.name, { type: f.type }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    },
    { name, type, base64 },
  );
}

async function project(api: Api, prefix: string): Promise<string> {
  const key = uniqueKey(prefix);
  await api.createProject({ key, name: `Writing ${key}` });
  return key;
}

/** The page draws a picture it was given: its bytes arrived and decoded. */
async function drawn(img: Locator) {
  await expect(img).toHaveAttribute('src', IMAGE);
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(1);
}

async function openDescription(page: Page, id: string): Promise<Locator> {
  await page.goto(`/issues/${id}`);
  await page.getByRole('button', { name: 'Edit the description' }).click();
  const editor = page.getByRole('textbox', { name: 'Description' });
  await expect(editor).toBeVisible();
  return editor;
}

test('a description is written as it reads, and kept as Markdown', async ({ page, api }) => {
  const key = await project(api, 'ED');
  const issue = await api.createIssue({ project: key, summary: 'The invoice rounds the rate down' });
  const editor = await openDescription(page, issue.id);
  const tools = page.locator('.editor', { has: editor });
  const bold = tools.getByRole('button', { name: 'Bold' });
  const checklist = tools.getByRole('button', { name: 'Checklist' });

  // Words, a tool pressed while it's on.
  await editor.click();
  await page.keyboard.type('The rate shows ');
  await bold.click();
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.type('19%');
  await bold.click();
  await expect(bold).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.type(' where the contract says 20%. Ask @mi');

  // "@" offers people, as the composer always has.
  const people = page.getByRole('listbox', { name: 'People to mention' });
  await expect(people.getByRole('option', { name: /Mira Patel/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(people).toHaveCount(0);
  await expect(editor).toContainText(`Ask @${GUIDE.login}`);

  // A checklist from the toolbar, and its first box ticked in the editor.
  await page.keyboard.press('Enter');
  await checklist.click();
  await expect(checklist).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.type('Check the rounding rule');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Ask finance');
  await editor.getByRole('checkbox', { name: 'Done: Check the rounding rule' }).click();
  await expect(editor.getByRole('checkbox', { name: 'Done: Check the rounding rule' })).toBeChecked();

  // A screenshot pasted goes in where the caret is, as one of the issue's files.
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('As it shows: ');
  await paste(editor, 'rate.png');
  const picture = editor.getByRole('img', { name: 'rate.png' });
  await drawn(picture);
  await expect(page.getByText('rate.png is in the text, and among the files.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Files', exact: true }).getByRole('link', { name: 'rate.png', exact: true })).toBeVisible();

  // A table, its cells filled by Tab.
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await tools.getByRole('button', { name: 'Table' }).click();
  await page.keyboard.type('Month');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Rate');
  await expect(editor.getByRole('table')).toBeVisible();
  await expectAccessible(page);
  await expectNoSidewaysScroll(page);

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const description = page.getByRole('region', { name: 'Description' });
  await expect(description.getByRole('strong')).toHaveText('19%');
  await expect(description.getByRole('link', { name: 'Mira Patel' })).toBeVisible();
  await expect(description.getByRole('checkbox', { name: 'Check the rounding rule' })).toBeChecked();
  await expect(description.getByRole('checkbox', { name: 'Ask finance' })).not.toBeChecked();
  await expect(description.getByRole('columnheader', { name: 'Rate' })).toBeVisible();
  await drawn(description.getByRole('img', { name: 'rate.png' }));

  // What's kept is Markdown.
  const saved = (await api.issue(issue.id)).description;
  expect(saved).toContain('The rate shows **19%** where the contract says 20%. Ask @mira');
  expect(saved).toMatch(/^- \[x\] Check the rounding rule$/m);
  expect(saved).toMatch(/^- \[ \] Ask finance$/m);
  expect(saved).toMatch(/^\| Month +\| Rate +\| +\|$/m);
  // An empty line is a blank line, never HTML.
  expect(saved).not.toContain('<');
  expect(saved).toMatch(/!\[rate\.png\]\(\/api\/v1\/attachments\/[A-Za-z0-9_-]+\/image\)/);

  // Opened and saved untouched, it's the same text to the byte; and the Markdown itself is a choice away.
  await page.getByRole('button', { name: 'Edit the description' }).click();
  await expect(editor).toBeVisible();
  const modes = page.locator('form', { has: page.getByRole('button', { name: 'Cancel' }) }).getByRole('group', { name: 'How to write it' });
  await modes.getByRole('button', { name: 'Markdown' }).click();
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue(saved);
  await modes.getByRole('button', { name: 'Visual' }).click();
  await expect(editor).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(description).toBeVisible();
  expect((await api.issue(issue.id)).description).toBe(saved);
});

test('a checklist is ticked where it is read, against the version read', async ({ page, api, watch }) => {
  watch.allow(/status of 409/);
  const key = await project(api, 'EC');
  const issue = await api.createIssue({
    project: key,
    summary: 'Before the release',
    description: 'Before the release:\n\n- [ ] Write the notes\n- [ ] Tag the build\n\n```\n- [ ] not an item: code\n```\n',
  });
  await holdLiveEvents(page);
  await page.goto(`/issues/${issue.id}`);
  const description = page.getByRole('region', { name: 'Description' });

  await description.getByRole('checkbox', { name: 'Tag the build' }).click();
  await expect.poll(async () => (await api.issue(issue.id)).description).toContain('- [x] Tag the build');
  await expect(description.getByRole('checkbox', { name: 'Tag the build' })).toBeChecked();
  expect((await api.issue(issue.id)).description).toContain('- [ ] not an item: code');

  // Someone changes the issue meanwhile: the tick says so, and the page has the issue as it now is.
  const now = await api.issue(issue.id);
  await api.updateIssue(issue.id, { summary: 'Before the release, and after', expectedVersion: now.version });
  await description.getByRole('checkbox', { name: 'Write the notes' }).click();
  await expect(description.getByText('Someone changed this issue just now. It’s been reloaded: check it and try again.')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Before the release, and after');
  await expect(description.getByRole('checkbox', { name: 'Write the notes' })).not.toBeChecked();
  expect((await api.issue(issue.id)).description).toContain('- [ ] Write the notes');

  // Ticked again, on the version now read.
  await description.getByRole('checkbox', { name: 'Write the notes' }).click();
  await expect.poll(async () => (await api.issue(issue.id)).description).toContain('- [x] Write the notes');
});

test('a comment takes a pasted screenshot, and its checklist is ticked by its author', async ({ page, api, watch }) => {
  watch.allow(/status of 409/);
  const key = await project(api, 'EM');
  const issue = await api.createIssue({ project: key, summary: 'The gateway gives up after 30 seconds' });
  await holdLiveEvents(page);
  await page.goto(`/issues/${issue.id}`);
  const history = page.getByRole('region', { name: 'History and comments' });

  const composer = page.getByRole('textbox', { name: `A comment, as ${ADMIN.name}` });
  await composer.click();
  await page.keyboard.type('Reproduced on staging: ');
  await paste(composer, 'timeout.png');
  await drawn(composer.getByRole('img', { name: 'timeout.png' }));
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await drawn(history.getByRole('img', { name: 'timeout.png' }));
  await expect(composer).toHaveText('');
  const [posted] = await api.get<Comment[]>(`/issues/${issue.id}/comments`);
  expect(posted!.text).toMatch(/^Reproduced on staging: !\[timeout\.png\]\(\/api\/v1\/attachments\/[A-Za-z0-9_-]+\/image\)$/);

  // A checklist in a comment, ticked by its author, saved against the comment's version.
  const list = await api.post<Comment>(`/issues/${issue.id}/comments`, { text: '- [ ] Restart the gateway\n- [ ] Tell support' });
  await page.reload();
  await history.getByRole('checkbox', { name: 'Restart the gateway' }).click();
  await expect.poll(async () => (await api.get<Comment[]>(`/issues/${issue.id}/comments`)).find((c) => c.id === list.id)).toMatchObject({
    version: 2,
    text: '- [x] Restart the gateway\n- [ ] Tell support',
  });

  // Changed meanwhile: said, and reloaded.
  await api.patch<Comment>(`/comments/${list.id}`, { text: '- [x] Restart the gateway\n- [ ] Tell support\n- [ ] Close the incident', expectedVersion: 2 });
  await history.getByRole('checkbox', { name: 'Tell support' }).click();
  await expect(history.getByText('Someone changed this comment just now. It’s been reloaded: check it and tick again.')).toBeVisible();
  await expect(history.getByRole('checkbox', { name: 'Close the incident' })).toBeVisible();
  await expect(history.getByRole('checkbox', { name: 'Tell support' })).not.toBeChecked();
});

test('an article takes a pasted screenshot, and a tick is a new version', async ({ page, api }) => {
  const key = await project(api, 'EA');
  const article = await api.post<ArticleDetail>('/articles', { project: key, title: 'Restarting the gateway', body: '## Steps\n\n- [ ] Drain the node\n- [ ] Restart it\n' });
  await page.goto(`/articles/${article.id}/edit`);
  const editor = page.getByRole('textbox', { name: 'What it says' });
  await expect(editor).toBeVisible();
  await editor.getByText('Restart it').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await paste(editor, 'dashboard.png');
  await drawn(editor.getByRole('img', { name: 'dashboard.png' }));
  await page.getByRole('button', { name: 'Save version 2' }).click();

  const body = page.getByRole('article', { name: 'Restarting the gateway' });
  await drawn(body.getByRole('img', { name: 'dashboard.png' }));
  await body.getByRole('checkbox', { name: 'Drain the node' }).click();
  await expect(page.getByText('Version 3', { exact: true })).toBeVisible();
  const kept = await api.get<ArticleDetail>(`/articles/${article.id}`);
  expect(kept.body).toContain('- [x] Drain the node');
  expect(kept.body).toMatch(/!\[dashboard\.png\]\(\/api\/v1\/attachments\/[A-Za-z0-9_-]+\/image\)/);
});

test('a picture within text is a4a’s own, or only named', async ({ page, api }) => {
  const key = await project(api, 'EP');
  const issue = await api.createIssue({
    project: key,
    summary: 'Pictures from elsewhere',
    description: 'From the vendor: ![their chart](https://charts.example/rates.png)\n\nAnd a path: ![not ours](/api/v1/attachments/x/content)',
  });
  await page.goto(`/issues/${issue.id}`);
  const description = page.getByRole('region', { name: 'Description' });
  // Never fetched: a link to it, named; and a4a's own path of another kind, a name.
  await expect(description.getByRole('link', { name: 'their chart' })).toHaveAttribute('href', 'https://charts.example/rates.png');
  await expect(description.getByText('not ours')).toBeVisible();
  await expect(description.getByRole('img')).toHaveCount(0);

  // In the editor too: named, never loaded.
  await page.getByRole('button', { name: 'Edit the description' }).click();
  const editor = page.getByRole('textbox', { name: 'Description' });
  await expect(editor.getByText('their chart')).toBeVisible();
  await expect(editor.locator('img:not(.ProseMirror-separator)')).toHaveCount(0);
});

for (const mode of [
  { name: 'light', use: { colorScheme: 'light' as const } },
  { name: 'dark', use: { colorScheme: 'dark' as const } },
  { name: 'phone', use: { colorScheme: 'light' as const, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
]) {
  test.describe(mode.name, () => {
    test.use(mode.use);
    test('the editor and what it wrote read well', async ({ page, api }, info) => {
      const key = await project(api, 'EL');
      const issue: IssueDetail = await api.createIssue({
        project: key,
        summary: 'The rate rounds down',
        description: 'The rate shows **19%**.\n\n- [x] Reproduce it\n- [ ] Check the rule\n\n| Month | Rate |\n| --- | --: |\n| October | 20% |\n| November | 19% |\n',
      });
      await page.goto(`/issues/${issue.id}`);
      await expect(page.getByRole('region', { name: 'Description' }).getByRole('table')).toBeVisible();
      await expectAccessible(page);
      await expectNoSidewaysScroll(page);
      await page.getByRole('region', { name: 'Description' }).screenshot({ path: info.outputPath('read.png') });

      const editor = await openDescription(page, issue.id);
      await editor.locator('strong').click();
      await expect(page.locator('.editor', { has: editor }).getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
      await expectAccessible(page);
      await expectNoSidewaysScroll(page);
      await page.locator('.editor', { has: editor }).screenshot({ path: info.outputPath('editor.png') });
    });
  });
}
