/**
 * Demo data: three projects that exercise search, commands, boards, triage,
 * duplicates and the planner. Demo people have no passwords, so a seeded public
 * instance can't be signed into with them; only the admin who ran setup can.
 */
import { and, eq, sql } from 'drizzle-orm';
import { adminCtx, systemCtx } from '../app-services';
import type { AppServices, UserRow } from '../context';
import { addDays, todayISO } from '../lib/dates';
import { addComment } from '../services/comments';
import { addFieldValue } from '../services/fields';
import { createIssue, updateIssue } from '../services/issues';
import { linkIssues } from '../services/links';
import { createProject } from '../services/projects';
import { createSavedSearch } from '../services/saved-searches';
import { createBoard, createSprint, setSprintIssues } from '../services/boards';
import { createBaseline } from '../services/planning';
import { fieldByName } from '../services/schema-cache';
import { insertUser } from '../services/users';
import { logWork } from '../services/workitems';
import { createArticle, updateArticle } from '../services/articles';
import { reindexComment } from '../services/mentions';
import { activities, issues, projects } from './schema';

type Seeded = Record<string, string>;

export async function seedDemo(app: AppServices, admin: UserRow): Promise<void> {
  const [{ n } = { n: 0 }] = await app.db.select({ n: sql<number>`count(*)::int` }).from(projects);
  if (Number(n) > 0) return; // never seed over real data

  const ctx = adminCtx(app, admin, 'system');
  const people = {
    anna: await insertUser(app.db, { login: 'anna', name: 'Anna Schmidt', email: 'anna@example.com', hourlyRate: 95 }),
    ben: await insertUser(app.db, { login: 'ben', name: 'Ben Okafor', email: 'ben@example.com', hourlyRate: 85 }),
    chloe: await insertUser(app.db, { login: 'chloe', name: 'Chloé Martin', email: 'chloe@example.com', hourlyRate: 100 }),
    diego: await insertUser(app.db, { login: 'diego', name: 'Diego Alvarez', email: 'diego@example.com', hourlyRate: 70, capacityHoursPerDay: 6 }),
  };
  app.schema.invalidate();
  const as = (u: UserRow) => systemCtx(app, u, 'web');
  const today = todayISO();

  await createProject(ctx, { key: 'BACK', name: 'Backend platform', description: 'APIs, authentication and data services.', lead: 'anna', template: 'software' });
  await createProject(ctx, { key: 'WEB', name: 'Web app', description: 'The customer-facing web application.', lead: 'ben', template: 'software' });
  await createProject(ctx, {
    key: 'MIG',
    name: 'Data center migration',
    description: 'Move every production workload from the Leeds data center to the new region, then decommission it.',
    lead: 'chloe',
    template: 'waterfall',
    plan: { startDate: addDays(today, -21), budget: 60000, currency: 'USD', hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5], holidays: [] },
  });

  const s = await app.schema.get();
  const subsystem = fieldByName(s, 'Subsystem')!;
  for (const name of ['API', 'Auth', 'Database', 'Infrastructure']) await addFieldValue(ctx, subsystem.id, { name, project: 'BACK' });
  for (const name of ['UI', 'Accessibility', 'Build']) await addFieldValue(ctx, subsystem.id, { name, project: 'WEB' });
  for (const name of ['Network', 'Storage', 'Compute', 'Applications']) await addFieldValue(ctx, subsystem.id, { name, project: 'MIG' });
  const versions = fieldByName(s, 'Fix versions')!;
  for (const name of ['1.0', '1.1', '2.0']) await addFieldValue(ctx, versions.id, { name });

  const ids: Seeded = {};
  const mk = async (key: string, by: UserRow, input: Parameters<typeof createIssue>[1], daysAgo = 0) => {
    const issue = await createIssue(as(by), input);
    ids[key] = issue.id;
    if (daysAgo) await backdate(app, issue.uid, daysAgo);
    return issue;
  };

  // --- BACK ------------------------------------------------------------------
  await mk('apiv2', people.anna, { project: 'BACK', summary: 'Public API v2', description: 'Pagination, rate limits and documentation for the v2 API.', fields: { Type: 'Epic', Priority: 'Major', Assignee: 'anna' } }, 30);
  await mk('sso', people.diego, {
    project: 'BACK',
    summary: 'Login fails on Safari with SSO',
    description:
      'Steps:\n1. Open the app in Safari 17\n2. Choose "Sign in with SSO"\n3. Complete the identity provider login\n\nExpected: back in the app, signed in.\nActual: a blank page; the session cookie is missing.',
    fields: { Type: 'Bug', Priority: 'Critical', Assignee: 'anna', Subsystem: 'Auth', State: 'In Progress', Estimation: '2d' },
    tags: ['regression'],
  }, 6);
  await mk('sso2', people.ben, {
    project: 'BACK',
    summary: "Users can't sign in with single sign-on on Safari 17",
    description: 'Several customers report that after the Okta redirect, Safari shows an empty page. Chrome works.',
    fields: { Type: 'Bug', Priority: 'Normal', State: 'Submitted' },
  }, 1);
  await mk('rate', people.anna, { project: 'BACK', summary: 'Add rate limiting to the public API', description: 'Token-bucket limits per API key, with Retry-After on 429.', fields: { Type: 'Feature', Priority: 'Major', Assignee: 'ben', Subsystem: 'API', Estimation: '3d', 'Fix versions': ['1.1'] }, parent: ids.apiv2 }, 20);
  await mk('pagination', people.diego, { project: 'BACK', summary: 'API returns 500 when the pagination cursor is malformed', description: 'GET /v2/orders?cursor=abc returns 500 instead of 400.', fields: { Type: 'Bug', Priority: 'Major', Subsystem: 'API' }, parent: ids.apiv2 }, 9);
  await mk('docs', people.anna, { project: 'BACK', summary: 'Document the v2 authentication flow', fields: { Type: 'Task', Priority: 'Normal' }, parent: ids.apiv2 }, 15);
  await mk('sessions', people.anna, { project: 'BACK', summary: 'Migrate the sessions table to Postgres 16', fields: { Type: 'Task', Priority: 'Normal', Assignee: 'anna', Subsystem: 'Database', State: 'In Review', Estimation: '1d 4h' } }, 12);
  await mk('keys', people.anna, { project: 'BACK', summary: 'Rotate signing keys without downtime', description: 'Support two active keys during rotation.', fields: { Type: 'Feature', Priority: 'Critical', Assignee: 'anna', Subsystem: 'Auth', State: 'Blocked' }, tags: ['security'], links: [{ relation: 'depends on', issue: ids.sessions! }] }, 10);
  await mk('flaky', people.diego, { project: 'BACK', summary: 'Flaky test: OrdersSyncTest times out on CI', fields: { Type: 'Bug', Priority: 'Minor', Assignee: 'diego' }, tags: ['flaky'] }, 4);
  await mk('webhook', people.ben, { project: 'BACK', summary: 'Webhook deliveries are not retried on 503', fields: { Type: 'Bug', Priority: 'Major', Assignee: 'ben', Subsystem: 'API' } }, 14);
  await mk('slow', people.anna, { project: 'BACK', summary: 'Slow query on the activity feed for large projects', description: 'p95 is 2.3s for projects with more than 50k events.', fields: { Type: 'Bug', Priority: 'Major', Assignee: 'anna', Subsystem: 'Database', Estimation: '2d' }, tags: ['performance'] }, 3);
  await mk('v1export', people.ben, { project: 'BACK', summary: 'Remove the deprecated v1 export endpoint', fields: { Type: 'Task', Priority: 'Minor', Assignee: 'ben' } }, 25);

  await updateIssue(as(people.ben), ids.webhook!, { fields: { State: 'Fixed', 'Fix versions': ['1.1'] } });
  await updateIssue(as(people.ben), ids.v1export!, { fields: { State: "Won't fix" } });
  await addComment(as(people.ben), ids.sso!, 'I can reproduce it with the Okta sandbox. The SameSite attribute on the session cookie looks wrong after the redirect.');
  await addComment(as(people.anna), ids.sso!, 'Confirmed: Safari drops the cookie because it is SameSite=None without Secure on the callback. Fix in progress.');
  await addComment(as(people.anna), ids.keys!, 'Waiting for the sessions migration, which moves key material to the new table.');
  await logWork(as(people.anna), ids.sso!, { duration: '3h', date: addDays(today, -2), description: 'Reproduced and traced the cookie handling' });
  await logWork(as(people.ben), ids.webhook!, { duration: '5h', date: addDays(today, -5), description: 'Retry with backoff' });

  // --- WEB -------------------------------------------------------------------
  await mk('dark', people.ben, { project: 'WEB', summary: 'Dark mode toggle is missing from settings', fields: { Type: 'Feature', Priority: 'Normal', Assignee: 'ben', Subsystem: 'UI' } }, 18);
  await mk('focus', people.diego, { project: 'WEB', summary: 'Keyboard focus is lost after closing the command dialog', fields: { Type: 'Bug', Priority: 'Major', Assignee: 'ben', Subsystem: 'Accessibility', State: 'In Progress' }, tags: ['accessibility'] }, 5);
  await mk('onboarding', people.anna, { project: 'WEB', summary: 'Onboarding checklist for new workspaces', fields: { Type: 'Feature', Priority: 'Normal', State: 'Submitted' } }, 2);
  await mk('charts', people.diego, { project: 'WEB', summary: "Charts don't render in Safari 16", fields: { Type: 'Bug', Priority: 'Critical', Assignee: 'ben', Subsystem: 'UI' } }, 7);
  await mk('typo', people.diego, { project: 'WEB', summary: 'Fix the typo on the pricing page', fields: { Type: 'Bug', Priority: 'Minor', Assignee: 'ben' } }, 11);
  await mk('empty', people.ben, { project: 'WEB', summary: 'Improve empty states on the issues page', fields: { Type: 'Task', Priority: 'Minor' } }, 8);
  await mk('back', people.diego, { project: 'WEB', summary: 'Search box loses the query after navigating back', fields: { Type: 'Bug', Priority: 'Normal', Assignee: 'ben' } }, 13);
  await updateIssue(as(people.ben), ids.typo!, { fields: { State: 'Fixed' } });
  await updateIssue(as(people.diego), ids.back!, { fields: { State: 'Verified' } });
  await linkIssues(as(people.ben), ids.charts!, 'relates to', ids.sso!);

  // --- MIG: a waterfall plan ------------------------------------------------------
  const start = addDays(today, -21);
  const phase = (key: string, summary: string, daysAgo: number) =>
    mk(key, people.chloe, { project: 'MIG', summary, fields: { Type: 'Epic', Priority: 'Major' } }, daysAgo);
  const task = (
    key: string,
    summary: string,
    fields: Record<string, string | string[]>,
    parent: string,
    deps: string[] = [],
    daysAgo = 21,
  ) =>
    mk(key, people.chloe, {
      project: 'MIG',
      summary,
      fields: { Type: 'Task', Priority: 'Normal', ...fields },
      parent: ids[parent],
      links: deps.map((d) => ({ relation: 'depends on', issue: ids[d]! })),
    }, daysAgo);

  await phase('p1', 'Assessment', 21);
  await task('inventory', 'Inventory servers and applications', { Assignee: 'chloe', Estimation: '4d', 'Start date': start, Subsystem: 'Compute' }, 'p1');
  await task('depmap', 'Map application dependencies', { Assignee: 'anna', Estimation: '3d', Subsystem: 'Applications' }, 'p1', ['inventory']);
  await task('signoff', 'Assessment signed off', { Type: 'Milestone' }, 'p1', ['depmap']);
  await phase('p2', 'Design', 21);
  await task('network', 'Target network design', { Assignee: 'chloe', Estimation: '5d', Subsystem: 'Network' }, 'p2', ['signoff']);
  await task('storage', 'Storage and backup design', { Assignee: 'chloe', Estimation: '4d', Subsystem: 'Storage' }, 'p2', ['signoff']);
  await task('secreview', 'Security review of the design', { Assignee: 'diego', Estimation: '2d' }, 'p2', ['network', 'storage']);
  await task('approved', 'Design approved', { Type: 'Milestone', Priority: 'Critical' }, 'p2', ['secreview']);
  await phase('p3', 'Migration', 21);
  await task('provision', 'Provision the target environment', { Assignee: 'chloe', Estimation: '5d', 'Fixed cost': '12000', Subsystem: 'Compute' }, 'p3', ['approved']);
  await task('databases', 'Migrate databases', { Assignee: 'anna', Estimation: '6d', Subsystem: 'Storage', Priority: 'Critical' }, 'p3', ['provision']);
  await task('apps', 'Migrate application servers', { Assignee: 'ben', Estimation: '8d', Subsystem: 'Applications' }, 'p3', ['provision']);
  await task('cutover', 'Cut over DNS and traffic', { Assignee: 'chloe', Estimation: '1d', Priority: 'Critical', 'Due date': addDays(today, 30), Subsystem: 'Network' }, 'p3', ['databases', 'apps']);
  await phase('p4', 'Closure', 21);
  await task('decom', 'Decommission the Leeds data center', { Assignee: 'chloe', Estimation: '3d', 'Fixed cost': '3000', Subsystem: 'Compute' }, 'p4', ['cutover']);
  await task('complete', 'Migration complete', { Type: 'Milestone', 'Due date': addDays(today, 40) }, 'p4', ['decom']);

  // The plan of record, as it stood on the first day, before any progress.
  await createBaseline(as(people.chloe), 'MIG', { name: 'Plan of record', note: 'Approved at kickoff' }, { asOf: start, createdAt: new Date(Date.now() - 21 * 86_400_000) });

  // Progress so far: assessment done (a little late), network design under way.
  await logWork(as(people.chloe), ids.inventory!, { duration: '4d', date: start, description: 'Inventory of 140 servers' });
  await logWork(as(people.anna), ids.depmap!, { duration: '3d 4h', date: addDays(start, 6), description: 'Dependency interviews and tracing' });
  await updateIssue(as(people.chloe), ids.inventory!, { fields: { State: 'Done' } });
  await updateIssue(as(people.anna), ids.depmap!, { fields: { State: 'Done' } });
  await updateIssue(as(people.chloe), ids.signoff!, { fields: { State: 'Done' } });
  await setResolvedAt(app, ids.inventory!, addDays(start, 5));
  await setResolvedAt(app, ids.depmap!, addDays(start, 11));
  await setResolvedAt(app, ids.signoff!, addDays(start, 11));
  await logWork(as(people.chloe), ids.network!, { duration: '3d', date: addDays(today, -6), description: 'Addressing plan and VPN design' });
  await updateIssue(as(people.chloe), ids.network!, { fields: { State: 'In Progress' } });

  // --- Boards, sprints, saved searches ---------------------------------------------
  const backBoard = await createBoard(ctx, { name: 'Backend sprints', projects: ['BACK'], sprintsEnabled: true });
  const current = await createSprint(ctx, backBoard.id, { name: 'Sprint 14', goal: 'Fix SSO on Safari and ship rate limiting', startDate: addDays(today, -7), endDate: addDays(today, 6) });
  await createSprint(ctx, backBoard.id, { name: 'Sprint 15', goal: 'Key rotation', startDate: addDays(today, 7), endDate: addDays(today, 20) });
  await setSprintIssues(ctx, current.id, [ids.sso!, ids.rate!, ids.sessions!, ids.pagination!, ids.keys!, ids.slow!, ids.webhook!], false);
  await createBoard(ctx, {
    name: 'Web kanban',
    projects: ['WEB'],
    columns: [
      { name: 'To do', values: ['Submitted', 'Open'] },
      { name: 'In progress', values: ['In Progress'], wipLimit: 3 },
      { name: 'In review', values: ['In Review', 'Blocked'] },
      { name: 'Done', values: ['Fixed', 'Verified', 'Done'] },
    ],
    swimlaneField: 'Priority',
  });
  await seedKnowledgeBase(app, as, people, ids);

  for (const [name, query] of [
    ['My open issues', 'for: me #Unresolved sort by: Priority, updated desc'],
    ['Critical bugs', 'Type: Bug Priority: Show-stopper, Critical #Unresolved'],
    ['Untriaged', 'State: Submitted has: -Assignee'],
    ['Resolved this week', 'resolved date: {this week}'],
  ] as const) {
    await createSavedSearch(ctx, { name, query, shared: true });
  }
}

/**
 * A knowledge base for BACK and MIG: runbooks in a tree, conventions saved twice (so there's a
 * history), and mentions both ways between articles and issues.
 */
async function seedKnowledgeBase(app: AppServices, as: (u: UserRow) => ReturnType<typeof systemCtx>, people: Record<string, UserRow>, ids: Seeded) {
  const anna = as(people.anna!);
  const runbooks = await createArticle(anna, {
    project: 'BACK',
    title: 'Runbooks',
    body: 'How we run the backend in production. Start here when something is on fire, and write down what you learn.',
  });
  await createArticle(anna, {
    project: 'BACK',
    title: 'Database failover',
    parent: runbooks.id,
    body: [
      'When the primary fails, promote the replica before anything else: the pooler queues requests for 30 seconds, and the app retries after that.',
      '',
      '# Promote the replica',
      '',
      '1. Check it has caught up: `SELECT pg_last_wal_replay_lsn();`',
      '2. Promote it with `pg_ctl promote`.',
      '3. Repoint the pooler, then the app.',
      '',
      '> Never promote a replica that is more than a minute behind without asking the database lead.',
      '',
      '# Afterwards',
      '',
      `The activity feed is slow on large projects (${ids.slow}), so the first minutes after a failover look worse than they are.`,
    ].join('\n'),
  });
  await createArticle(as(people.ben!), {
    project: 'BACK',
    title: 'Deploying the API',
    parent: runbooks.id,
    body: 'Deploys go out from main, one region at a time.\n\n1. Merge to main; CI builds the image.\n2. Run `make deploy REGION=eu` and watch the error rate for five minutes.\n3. Then the other regions.\n\nRoll back with `make rollback REGION=eu`.',
  });
  const conventions = await createArticle(anna, {
    project: 'BACK',
    title: 'API conventions',
    body: `Every error is \`{"error": {"code", "message", "hint"}}\`: the hint says how to fix the request.\n\nRate limits (${ids.rate}) answer 429 with Retry-After.`,
  });
  await updateArticle(as(people.ben!), conventions.id, {
    body: `${conventions.body}\n\nPagination uses cursors. A malformed cursor is a 400 that says so, never a 500 (${ids.pagination}).`,
  });
  const sso = await createArticle(anna, {
    project: 'BACK',
    title: 'Single sign-on',
    body: `We sign people in with Okta over OIDC. The session cookie is set on the callback, so it must be \`SameSite=None; Secure\`: Safari drops it otherwise (${ids.sso}).`,
  });
  await createArticle(as(people.chloe!), {
    project: 'MIG',
    title: 'Cutover plan',
    body: `The night of the cutover (${ids.cutover}), in order: freeze writes, replicate the last changes, switch DNS, then watch for an hour before anyone goes home.\n\nAfter that, the Leeds data center is decommissioned (${ids.decom}).`,
  });
  // An issue's comment that points at an article. The outbox worker indexes comments as they
  // come; it starts after the seed, so this one is indexed here.
  const comment = await addComment(anna, ids.sso!, `What the fix changes and how to test it is written up in ${sso.id}.`);
  await reindexComment(app, comment.id);
}

/** Move an issue's creation (and its creation event) into the past, for a lifelike history. */
async function backdate(app: AppServices, issueId: string, daysAgo: number) {
  const when = new Date(Date.now() - daysAgo * 86_400_000);
  await app.db.update(issues).set({ createdAt: when, updatedAt: when }).where(eq(issues.id, issueId));
  await app.db
    .update(activities)
    .set({ createdAt: when })
    .where(and(eq(activities.issueId, issueId), eq(activities.type, 'issue.created')));
}

async function setResolvedAt(app: AppServices, readable: string, date: string) {
  const s = await app.schema.get();
  const [key, num] = readable.split('-');
  const p = s.projectsByKey.get(key!);
  if (!p) return;
  await app.db
    .update(issues)
    .set({ resolvedAt: new Date(`${date}T17:00:00`) })
    .where(and(eq(issues.projectId, p.id), eq(issues.number, Number(num))));
}

