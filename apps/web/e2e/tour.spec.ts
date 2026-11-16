/**
 * Every page, light, dark and on a phone (390px): nothing goes wrong in the console, the CSP
 * blocks nothing, nothing scrolls sideways, and axe finds nothing against WCAG 2.2 AA.
 *
 * The tour only reads, or makes what a stop shows in a project of its own, so its stops run at
 * once. It holds the live feed, so what other specs
 * change meanwhile can't redraw a page in the middle of a check. It's taken by an administrator
 * of its own (support/env.ts says why).
 *
 * A new page joins the tour with one line in STOPS: its address, and what shows once it's drawn.
 * What the server can't show without AI (a conversation, suggestions waiting) is stood in for.
 */
import type { TrackerEvent } from '@a4a/shared';
import type { Import } from '@a4a/shared';
import type { Locator, Page } from '@playwright/test';
import { BACK_3_TRIAGE, mockStoredConversation, mockWaitingSuggestions, takeIssue, triageSuggestion } from './support/ai';
import { Api, unique, uniqueKey } from './support/api';
import { expectAccessible, expectNoSidewaysScroll } from './support/checks';
import { BASE_URL, TOUR_AUTH_FILE } from './support/env';
import { expect, holdLiveEvents, settled, test } from './support/fixtures';
import { deskTakingMail, message, postMail } from './support/helpdesk';
import { startYouTrack, YT_TOKEN } from './support/youtrack';

/** A project of the tour's own whose help desk takes mail, with what came in: a request, and an auto-reply set aside. */
const deskWithMail = async (api: Api) => {
  const key = uniqueKey('TM');
  await api.createProject({ key, name: `Tour ${key}` });
  const address = `support-${unique()}@desk.example`;
  const made = await deskTakingMail(api, key, address);
  await postMail(made.url, message({ from: 'Jane Doe <jane@example.com>', to: address, subject: 'Invoices show the wrong VAT', body: 'Since Monday.' }));
  await postMail(made.url, message({ from: 'jane@example.com', to: address, subject: 'Automatic reply', body: 'Away.', headers: ['Auto-Submitted: auto-replied'] }));
  return `/projects/${key}`;
};

/** A help desk of the tour's own that takes mail and asks its form for a proof of work. */
const checkedForm = async (api: Api) => {
  const key = uniqueKey('TC');
  await api.createProject({ key, name: `Tour ${key}` });
  await deskTakingMail(api, key, `help-${unique()}@desk.example`);
  await api.patch(`/projects/${key}`, { settings: { helpdesk: { captcha: true, intro: 'Tell us what went wrong.' } } });
  return `/help/${key}`;
};

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

/** A project of the tour's own, with a rule of each kind. It has no issues, so they never act. */
/**
 * A plan of its own whose one person is away a whole day and the afternoon of the next, in the
 * grid's days: three days' work from today, which waits for them.
 */
const withDaysAway = async (api: Api) => {
  const key = uniqueKey('TA');
  await api.createProject({ key, name: `Tour ${key}`, template: 'waterfall' });
  const login = `ines.${unique()}`;
  await api.createUser({ login, name: 'Inès Aubert', password: 'tour-away-pass-1', role: 'member' });
  const today = new Date().toLocaleDateString('en-CA');
  const weekdays: string[] = [];
  for (let d = Date.parse(`${today}T00:00:00Z`) + 86_400_000; weekdays.length < 2; d += 86_400_000) {
    if (![0, 6].includes(new Date(d).getUTCDay())) weekdays.push(new Date(d).toISOString().slice(0, 10));
  }
  await api.createIssue({ project: key, summary: 'Patch the core switches', fields: { Type: 'Task', Assignee: login, Estimation: '3d', 'Start date': today } });
  await api.post('/absences', { user: login, from: weekdays[0], kind: 'holiday' });
  await api.post('/absences', { user: login, from: weekdays[1], half: 'afternoon', kind: 'training' });
  return `/plan/${key}/resources`;
};

const withRules = async (api: Api) => {
  const key = uniqueKey('TR');
  await api.createProject({ key, name: `Tour ${key}` });
  await api.post('/rules', { project: key, name: 'Critical bugs get tagged', kind: 'change', trigger: 'created', query: 'Priority: Critical', command: 'tag urgent' });
  await api.post('/rules', {
    project: key,
    name: "Won't fix says why",
    kind: 'guard',
    query: "State: {Won't fix}",
    requires: 'has: comments',
    message: "Say in a comment why it won't be fixed.",
  });
  await api.post('/rules', { project: key, name: 'Overdue issues get tagged', kind: 'schedule', schedule: { every: 'day', at: '09:00' }, query: '#Unresolved', command: 'tag overdue', enabled: false });
  await api.post('/rules', {
    project: key,
    name: 'Done subtasks fix their parent',
    kind: 'change',
    trigger: 'updated',
    field: 'State',
    query: '#Resolved',
    related: { of: 'siblings', match: 'all', query: '#Resolved' },
    target: { to: 'parent' },
    command: 'State Fixed',
    notify: { to: ['watchers'], people: [], message: 'All its subtasks are done.' },
  });
  return `/rules/${key}`;
};

/** An integration of the tour's own: it only waits for deliveries. */
/**
 * The guide subscribes, in their own session, to a project of the tour's own and to a saved search
 * in it: their profile lists them. Nothing happens in that project, so nothing is told.
 */
const withSubscriptions = async (api: Api, page: Page) => {
  const key = uniqueKey('TS');
  await api.createProject({ key, name: `Tour ${key}` });
  const theirs = async <T,>(path: string, data: unknown): Promise<T> => {
    const res = await page.request.post(`/api/v1${path}`, { data, headers: { origin: BASE_URL } });
    expect(res.ok(), `POST ${path}: ${res.status()}`).toBe(true);
    return (await res.json()) as T;
  };
  await theirs('/subscriptions', { project: key, events: 'all', email: false });
  const search = await theirs<{ id: string }>('/saved-searches', { name: `Critical in ${key}`, query: `project: ${key} Priority: Critical`, shared: false });
  await theirs('/subscriptions', { savedSearch: search.id, events: 'new' });
  return '/me';
};

const withIntegration = async (api: Api) => {
  await api.post('/vcs/integrations', { provider: 'github', name: `acme/${unique()}`, projects: [] });
  // One of Bitbucket Data Center's, with its address and no token yet: it says what it lacks.
  await api.post('/vcs/integrations', { provider: 'bitbucket-dc', name: `PROJ/${unique()}`, projects: [], baseUrl: 'https://bitbucket.acme.example' });
  return '/integrations';
};

/** An app of the tour's own, asking to work as the person (OAuth): registered, then its request. Nobody follows it back. */
const anAppAsks = async (api: Api) => {
  const callback = 'http://127.0.0.1:9/callback';
  const res = await api.context.post('/oauth/register', { data: { client_name: 'Claude', redirect_uris: [callback] } });
  const { client_id } = (await res.json()) as { client_id: string };
  const params = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: callback,
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    state: 'tour',
    scope: 'read write',
  });
  return `/oauth/authorize?${params}`;
};

/** A group of the tour's own: someone in it, and a role in a project of its own. */
const withGroup = async (api: Api) => {
  const key = uniqueKey('TG');
  await api.createProject({ key, name: `Tour ${key}` });
  const group = await api.post<{ id: string }>('/groups', { name: `Tour group ${unique()}`, description: 'People the tour shows' });
  const login = `tara.${unique()}`;
  await api.createUser({ login, name: 'Tara Tour', password: 'e2e-person-pass-1', role: 'member' });
  await api.post(`/groups/${group.id}/members`, { user: login });
  await api.post(`/projects/${key}/groups`, { group: group.id, role: 'viewer' });
  return `/groups/${group.id}`;
};

/** An issue limited to one person, with a comment limited to them too (D37). */
const limitedIssue = async (api: Api) => {
  const key = uniqueKey('TV');
  await api.createProject({ key, name: `Tour ${key}` });
  const login = `erin.${unique()}`;
  await api.createUser({ login, name: 'Erin Hall', password: 'e2e-person-pass-1', role: 'member' });
  const issue = await api.createIssue({ project: key, summary: 'Due diligence on Initech', visibleTo: { users: [login], groups: [] } });
  await api.post(`/issues/${issue.id}/comments`, { text: 'The numbers are in the data room.', visibleTo: { users: [login], groups: [] } });
  return `/issues/${issue.id}`;
};

/** Administration, with a role of the tour's own among the built-in ones (D37). */
const withRole = async (api: Api) => {
  await api.post('/roles', { name: `Tour role ${unique()}`, description: 'Files and comments', permissions: ['read', 'comment', 'create'] });
  return '/admin';
};

/** A project open to guests, read signed out (D37). */
const guestProject = async (api: Api) => {
  const key = uniqueKey('TP');
  await api.createProject({ key, name: `Tour ${key}` });
  await api.patch(`/projects/${key}`, { guestAccess: true });
  await api.createIssue({ project: key, summary: 'Dark mode for the mobile app' });
  return `/public?project=${key}`;
};

/** An agent of the tour's own, with a token issued to it (D34). */
const withAgent = async (api: Api) => {
  await api.createAgent(`tour-${unique()}`);
  return '/agents';
};

/** In a project of the tour's own: one change an agent made on its own to undo, and one undone (D34). */
const agentsChanges = async (api: Api) => {
  const { token } = await api.createAgent(`tour-${unique()}`);
  const key = uniqueKey('TA');
  await api.createProject({ key, name: `Tour ${key}` });
  const issue = await api.createIssue({ project: key, summary: 'Flaky upload test', fields: { Type: 'Bug' } });
  const agent = await Api.withToken(token);
  await agent.patch(`/issues/${issue.id}`, { addTags: ['flaky'] });
  await agent.updateIssue(issue.id, { fields: { Priority: 'Critical' } });
  await agent.dispose();
  const tagged = (await api.get<TrackerEvent[]>(`/issues/${issue.id}/activity`)).find((e) => e.type === 'issue.updated' && e.changes.some((c) => c.field === 'Tags'))!;
  await api.post(`/events/${tagged.id}/undo`);
  return `/issues/${issue.id}`;
};

/** Issues read from a YouTrack the tour starts, into a project of its own, ready to map. */
const fromYouTrack = async (api: Api) => {
  const yt = await startYouTrack();
  try {
    const key = uniqueKey('TY');
    await api.createProject({ key, name: `Tour ${key}` });
    const imp = await api.post<Import>('/imports/from-api', { project: key, source: 'youtrack', url: yt.url, query: 'project: OLD', credentials: { token: YT_TOKEN } });
    await expect.poll(async () => (await api.get<Import>(`/imports/${imp.id}`)).status, { timeout: 20_000 }).toBe('ready');
    return `/import/${imp.id}`;
  } finally {
    await yt.close();
  }
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
  { name: 'who is booked, and who is away', path: withDaysAway, ready: (p) => p.getByRole('cell', { name: 'away', exact: true }) },
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
  { name: 'an app asking to work as you', path: anAppAsks, ready: (p) => p.getByRole('main', { name: '“Claude” asks to work in a4a as you' }) },
  { name: 'webhooks', path: '/webhooks', ready: (p) => p.getByRole('heading', { name: 'Where it sends' }) },
  { name: 'administration', path: '/admin', ready: (p) => p.getByRole('region', { name: 'Table of people' }) },
  { name: 'your profile', path: '/me', ready: (p) => p.getByRole('heading', { name: 'Password' }) },
  { name: 'your inbox', path: '/inbox', ready: (p) => p.getByRole('heading', { name: "You're up to date" }).or(p.getByRole('list', { name: 'Unread, by issue' })) },
  {
    name: "a help desk's form",
    path: async (api) => {
      await api.patch('/projects/WEB', { settings: { helpdesk: { enabled: true, intro: 'Tell the web team what went wrong.' } } });
      return '/help/WEB';
    },
    ready: (p) => p.getByRole('heading', { name: /^Ask .+ for help$/ }),
  },
  { name: 'a help desk by email', path: deskWithMail, ready: (p) => p.getByRole('region', { name: 'Table of what came in by email' }) },
  { name: "a help desk's form that checks for a person", path: checkedForm, ready: (p) => p.getByRole('heading', { name: /^Ask .+ for help$/ }) },
  { name: 'the knowledge base', path: '/articles?project=BACK', ready: (p) => p.getByRole('link', { name: 'Database failover' }).first() },
  { name: 'an article', path: '/articles/BACK-A-2', ready: (p) => p.getByRole('article', { name: 'Database failover' }) },
  { name: "an article's versions", path: '/articles/BACK-A-2/history', ready: (p) => p.getByRole('heading', { name: /^Version \d+$/ }) },
  { name: 'writing an article', path: '/articles/BACK-A-2/edit', ready: (p) => p.getByRole('form', { name: 'Editing BACK-A-2' }) },
  { name: 'cumulative flow', path: '/reports/flow', ready: (p) => p.getByRole('group', { name: 'Issues in each state, day by day' }) },
  { name: 'cycle time', path: '/reports/cycle-time', ready: (p) => p.getByRole('group', { name: 'Issues by how long they took' }) },
  { name: 'your dashboard', path: '/dashboard', ready: (p) => p.getByRole('heading', { name: 'How long work takes, the last 90 days' }) },
  { name: 'importing', path: '/import', ready: (p) => p.getByRole('heading', { name: 'Upload an export' }) },
  { name: 'an import from YouTrack', path: fromYouTrack, ready: (p) => p.getByRole('heading', { name: 'Its columns' }) },
  { name: 'workflow rules', path: withRules, ready: (p) => p.getByRole('heading', { name: "Won't fix says why" }) },
  { name: 'version control', path: withIntegration, ready: (p) => p.getByRole('heading', { name: 'Where they come from' }) },
  { name: 'a group', path: withGroup, ready: (p) => p.getByRole('region', { name: 'Its roles in projects' }).getByRole('row').nth(1) },
  { name: 'agents of their own', path: withAgent, ready: (p) => p.getByRole('region', { name: /^Tokens of tour-/ }) },
  { name: "an agent's change to undo", path: agentsChanges, ready: (p) => p.getByRole('button', { name: /^Undo tour-.+’s change$/ }) },
  { name: 'your subscriptions', path: withSubscriptions, ready: (p) => p.getByRole('region', { name: 'Table of your subscriptions' }) },
  { name: 'an issue limited to some people', path: limitedIssue, ready: (p) => p.getByRole('region', { name: 'Visible to' }).getByRole('listitem') },
  { name: 'roles', path: withRole, ready: (p) => p.getByRole('row', { name: /^Tour role / }) },
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
      test('a project open to guests', async ({ page, api }) => {
        await visit(page, await guestProject(api), page.getByRole('link', { name: /Dark mode for the mobile app/ }));
      });
    });
  });
}
