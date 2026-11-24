/**
 * A plan: the timeline's what-if, a baseline saved and chosen, levelling proposed and applied,
 * and levelling refused (409) when the plan changed between seeing the proposal and applying it.
 *
 * Each test makes a small waterfall plan of its own, starting today: Anna writes a runbook (3d)
 * and reviews it (2d) at once, which books her 16 hours a day; Ben rehearses the cutover (2d)
 * once the runbook is written. The review has slack, so levelling moves it after the runbook,
 * within slack.
 */
import type { LevelingResult, Schedule } from '@a4a/shared';
import { fieldValue, uniqueKey, type Api } from './support/api';
import { SECOND_AUTH_FILE } from './support/env';
import { expect, holdLiveEvents, test } from './support/fixtures';

// The second of the flows' administrators (support/env.ts says why).
test.use({ storageState: SECOND_AUTH_FILE });

/** Today, as the server (on this machine) reads it. */
const today = () => new Date().toLocaleDateString('en-CA');
/** The first working day from today: where a plan without a start date of its own begins (D43's revisit). */
const workingToday = () => {
  const t = today();
  const day = new Date(`${t}T00:00:00Z`).getUTCDay();
  if (day === 6) return new Date(Date.parse(`${t}T00:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10);
  if (day === 0) return new Date(Date.parse(`${t}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return t;
};

async function cutoverPlan(api: Api, { startsToday = true } = {}) {
  const key = uniqueKey('PL');
  const project = await api.createProject({ key, name: `Cutover ${key}`, template: 'waterfall' });
  if (startsToday) await api.patch(`/projects/${key}`, { settings: { plan: { startDate: today() } } });
  const runbook = await api.createIssue({ project: key, summary: 'Write the runbook', fields: { Type: 'Task', Assignee: 'anna', Estimation: '3d' } });
  const review = await api.createIssue({ project: key, summary: 'Review the runbook', fields: { Type: 'Task', Assignee: 'anna', Estimation: '2d' } });
  const rehearse = await api.createIssue({
    project: key,
    summary: 'Rehearse the cutover',
    fields: { Type: 'Task', Assignee: 'ben', Estimation: '2d' },
    links: [{ relation: 'depends on', issue: runbook.id }],
  });
  const schedule = () => api.get<Schedule>(`/projects/${key}/schedule`);
  const proposal = () => api.post<LevelingResult>(`/projects/${key}/level`, { mode: 'within_slack', dryRun: true });
  return { key, name: project.name, runbook, review, rehearse, schedule, proposal };
}

test("the timeline's what-if shows what would move, and saves nothing", async ({ page, api }) => {
  const plan = await cutoverPlan(api);
  const before = await plan.schedule();
  await page.goto(`/plan/${plan.key}`);
  await expect(page.getByRole('group', { name: new RegExp(`^${plan.name}, `) })).toBeVisible();
  await expect(page.getByText('2 tasks on the critical path')).toBeVisible();

  const open = page.getByRole('button', { name: 'What if…' });
  await open.click();
  await expect(open).toHaveAttribute('aria-expanded', 'true');
  const whatIf = page.getByRole('region', { name: 'What if…' });
  await whatIf.getByLabel('Task').selectOption(plan.runbook.id);
  await expect(whatIf.getByLabel('What changes')).toHaveValue('delay');
  await whatIf.getByLabel('Working days later').fill('2');
  await whatIf.getByRole('button', { name: 'Show what changes' }).click();

  await expect(whatIf.getByText(`If ${plan.runbook.id} starts 2 days later, the plan ends 2 days later.`)).toBeVisible();
  await expect(whatIf.getByRole('heading', { name: '2 tasks would move' })).toBeVisible();
  const moves = whatIf.getByRole('list').filter({ hasText: plan.rehearse.id });
  await expect(moves).toContainText(plan.runbook.id);
  await expect(moves).not.toContainText(plan.review.id);
  // The chart says it too, in the words beside each bar.
  await expect(page.getByRole('listitem').filter({ hasText: plan.rehearse.summary }).filter({ hasText: 'in the what-if' })).toHaveCount(1);
  await expect(whatIf.getByText('Nothing is saved: this only shows what would happen.')).toBeVisible();

  await whatIf.getByRole('button', { name: 'Clear the what-if' }).click();
  await expect(whatIf.getByText(/the plan ends 2 days later/)).toBeHidden();
  const after = await plan.schedule();
  expect([after.finish, after.tasks.map((t) => [t.issue.id, t.start])]).toEqual([before.finish, before.tasks.map((t) => [t.issue.id, t.start])]);
  expect(fieldValue(await api.issue(plan.runbook.id), 'Start date')).toBeNull();
});

test('a baseline is saved from the timeline, and chosen to compare with', async ({ page, api }) => {
  const plan = await cutoverPlan(api);
  await page.goto(`/plan/${plan.key}`);
  await expect(page.getByText('There is no baseline yet.', { exact: false })).toBeVisible();
  const compare = page.getByLabel('Compare with');
  await expect(compare).toBeHidden();

  const save = async (name: string, note: string) => {
    await page.getByRole('button', { name: 'Save a baseline' }).click();
    const dialog = page.getByRole('dialog', { name: 'Save a baseline' });
    const field = dialog.getByLabel('Name');
    await expect(field).toBeFocused();
    await expect(field).toHaveValue(/^Plan of /);
    await field.fill(name);
    await dialog.getByLabel('A note, if you want one').fill(note);
    await dialog.getByRole('button', { name: 'Save the baseline' }).click();
    await expect(dialog).toBeHidden();
  };

  const baseline = async (name: string) => {
    const found = (await api.get<{ id: string; name: string }[]>(`/projects/${plan.key}/baselines`)).find((b) => b.name === name);
    expect(found, `the baseline ${name} is saved`).toBeTruthy();
    return found!.id;
  };

  await save('Agreed at kickoff', 'Signed off by Chloé');
  // The new baseline is the one compared with, in the page's address too.
  const kickoff = await baseline('Agreed at kickoff');
  await expect(compare).toHaveValue(kickoff);
  await expect(page).toHaveURL(new RegExp(`[?&]baseline=${kickoff}`));
  await expect(page.getByText(/^Ends .*, as Agreed at kickoff planned$/)).toBeVisible();

  await save('After the review', '');
  await expect(compare).toHaveValue(await baseline('After the review'));
  await expect(page.getByText(/as After the review planned$/)).toBeVisible();

  // Choose the first one again, then none.
  await compare.selectOption(kickoff);
  await expect(page).toHaveURL(new RegExp(`[?&]baseline=${kickoff}`));
  await expect(page.getByText(/as Agreed at kickoff planned$/)).toBeVisible();
  await compare.selectOption('none');
  await expect(page).toHaveURL(/[?&]baseline=none/);
  await expect(page.getByText('No baseline is chosen, so the chart shows no ghosts of the plan as agreed.')).toBeVisible();
});

test('levelling is proposed first, and applying writes exactly what was proposed', async ({ page, api }) => {
  const plan = await cutoverPlan(api);
  const proposed = await plan.proposal();
  expect(proposed.starts).toEqual({ [plan.review.id]: expect.any(String) });
  await page.goto(`/plan/${plan.key}/resources`);

  const levelling = page.getByRole('region', { name: 'Levelling would move 1 task' });
  await expect(levelling).toBeVisible();
  await expect(levelling.getByText('So nobody is booked over their day.', { exact: false })).toBeVisible();
  await expect(levelling.getByRole('listitem').filter({ hasText: plan.review.id })).toContainText(`Review the runbook · Anna Schmidt`);
  await expect(levelling.getByRole('listitem').filter({ hasText: plan.review.id })).toContainText('3 days later');
  // Nothing has moved yet.
  expect(fieldValue(await api.issue(plan.review.id), 'Start date')).toBeNull();
  await expect(page.getByRole('table', { name: "Who's booked, and how much" }).getByRole('cell', { name: /16h\s*of 8h/ }).first()).toBeVisible();

  const levelled = page.waitForResponse((r) => r.url().endsWith(`/projects/${plan.key}/level`) && r.request().postDataJSON().dryRun === false);
  await levelling.getByRole('button', { name: 'Level 1 task' }).click();
  expect((await levelled).request().postDataJSON()).toEqual({ mode: 'within_slack', dryRun: false, expect: proposed.starts });
  await expect(page.getByText('Levelled 1 task')).toBeVisible();
  await expect(page.getByText(`${plan.review.id} now starts`, { exact: false })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Nobody is booked over their day' })).toBeVisible();
  expect(fieldValue(await api.issue(plan.review.id), 'Start date')).toBe(proposed.starts[plan.review.id]);
  // Only the task moved for resources is written; the others follow by themselves.
  expect(fieldValue(await api.issue(plan.runbook.id), 'Start date')).toBeNull();
});

test('levelling refuses a proposal the plan has moved on from (409), and shows the new one', async ({ page, api, watch }) => {
  watch.allow(/status of 409/);
  // The page doesn't hear of the change, as when it lands between seeing and applying.
  await holdLiveEvents(page);
  const plan = await cutoverPlan(api);
  const seen = await plan.proposal();
  await page.goto(`/plan/${plan.key}/resources`);
  const level = page.getByRole('button', { name: 'Level 1 task' });
  await expect(level).toBeEnabled();

  // Meanwhile, someone shortens the runbook, so levelling would start the review earlier.
  await api.updateIssue(plan.runbook.id, { fields: { Estimation: '2d' } });
  const now = await plan.proposal();
  expect(now.starts[plan.review.id]).not.toBe(seen.starts[plan.review.id]);

  const refused = page.waitForResponse((r) => r.url().endsWith(`/projects/${plan.key}/level`) && r.request().postDataJSON().dryRun === false);
  await level.click();
  expect((await refused).status()).toBe(409);
  await expect(page.getByRole('alert').filter({ hasText: 'Nothing was levelled' })).toContainText('The plan changed since this was proposed.');
  expect(fieldValue(await api.issue(plan.review.id), 'Start date')).toBeNull();

  // What's shown now is the new proposal; levelling it applies that one.
  await expect(page.getByRole('listitem').filter({ hasText: plan.review.id })).toContainText('2 days later');
  await level.click();
  await expect(page.getByText('Levelled 1 task')).toBeVisible();
  expect(fieldValue(await api.issue(plan.review.id), 'Start date')).toBe(now.starts[plan.review.id]);
});

// With no start date of its own, a plan begins at its earliest task's Start date. Levelling
// writes the review's Start date (day 4), which would become that earliest date and take the
// runbook with it; so applying also sets the plan's start where it began, and the plan applied
// is the plan proposed.
test('levelling a plan with no start date of its own leaves it levelled', async ({ page, api }) => {
  const plan = await cutoverPlan(api, { startsToday: false });
  const proposed = await plan.proposal();
  expect(proposed.keepsStart).toBe(workingToday());
  const before = await plan.schedule();
  await page.goto(`/plan/${plan.key}/resources`);
  await expect(page.getByText(/has no start date of its own/)).toBeVisible();
  await page.getByRole('button', { name: 'Level 1 task' }).click();
  await expect(page.getByText('Levelled 1 task')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Nobody is booked over their day' })).toBeVisible();
  const after = await plan.schedule();
  expect(after.finish).toBe(proposed.finishAfter);
  // The runbook, which levelling didn't move, stays where it was.
  const runbookStart = (s: Schedule) => s.tasks.find((t) => t.issue.id === plan.runbook.id)?.start;
  expect(runbookStart(after)).toBe(runbookStart(before));
});
