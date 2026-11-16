/**
 * YouTrack and Jira as their REST APIs answer, for the importer's tests: node:http on this machine,
 * with fixtures shaped like the real responses (as their documentation gives them), a record of
 * every request (and its Authorization header), and switches for what goes wrong: a 429 with
 * Retry-After, a page that fails, a redirect to another origin.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string | undefined;
}

export interface Fake {
  url: string;
  port: number;
  seen: Seen[];
  close(): Promise<void>;
}

type Handler = (req: http.IncomingMessage, url: URL, body: string, res: http.ServerResponse) => void;

export async function serve(handle: Handler): Promise<Fake> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      seen.push({ method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, auth: req.headers.authorization });
      handle(req, url, Buffer.concat(chunks).toString('utf8'), res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// YouTrack
// ---------------------------------------------------------------------------

export const YT_TOKEN = 'perm:amFuZQ==.NDMtMg==.secret-yt-token';

const at = (y: number, m: number, d: number, h = 9) => Date.UTC(y, m - 1, d, h);
const anna = { login: 'anna.s', fullName: 'Anna Schmidt', email: null, $type: 'User' };
const ben = { login: 'bokafor', fullName: 'Ben Okafor', email: null, $type: 'User' };
const zed = { login: 'zed', fullName: 'Zed Remote', email: 'zed@elsewhere.example', $type: 'User' };

export interface YtComment {
  id: string;
  text: string;
  created: number;
  deleted: boolean;
  visibility: { $type: string } | null;
  author: Record<string, unknown>;
}

export interface YtWorkItem {
  id: string;
  date: number;
  duration: { minutes: number };
  text: string;
  author: Record<string, unknown>;
}

/** A YouTrack issue as GET /api/issues answers with the fields the reader asks for. */
export interface YtFixture {
  idReadable: string;
  summary: string;
  updated: number;
  comments: YtComment[];
  timeTracking: { workItems: YtWorkItem[] } | null;
  [field: string]: unknown;
}

export function youtrackIssues(): YtFixture[] {
  return [
    {
      $type: 'Issue',
      id: '2-1',
      idReadable: 'YT-1',
      summary: 'Plan the release',
      description: 'We ship **2.0** in April.',
      created: at(2024, 4, 1),
      updated: at(2024, 4, 2, 10),
      resolved: null,
      reporter: ben,
      tags: [{ name: 'release', $type: 'Tag' }],
      visibility: { $type: 'UnlimitedVisibility' },
      customFields: [
        { name: 'State', $type: 'StateIssueCustomField', value: { name: 'Open', isResolved: false, $type: 'StateBundleElement' } },
        { name: 'Priority', $type: 'SingleEnumIssueCustomField', value: { name: 'Major', $type: 'EnumBundleElement' } },
        { name: 'Type', $type: 'SingleEnumIssueCustomField', value: { name: 'Task', $type: 'EnumBundleElement' } },
        { name: 'Assignee', $type: 'SingleUserIssueCustomField', value: anna },
        { name: 'Estimation', $type: 'PeriodIssueCustomField', value: { minutes: 480, presentation: '1d', $type: 'PeriodValue' } },
        { name: 'Spent time', $type: 'PeriodIssueCustomField', value: { minutes: 90, presentation: '1h 30m', $type: 'PeriodValue' } },
        { name: 'Due Date', $type: 'DateIssueCustomField', value: at(2024, 4, 20, 12) },
      ],
      links: [
        { direction: 'OUTWARD', linkType: { name: 'Subtask', sourceToTarget: 'parent for', targetToSource: 'subtask of' }, issues: [{ idReadable: 'YT-2' }] },
        { direction: 'INWARD', linkType: { name: 'Depend', sourceToTarget: 'depends on', targetToSource: 'is required for' }, issues: [{ idReadable: 'YT-2' }] },
      ],
      comments: [
        { id: 'c-11', text: 'Dates are in the plan.', created: at(2024, 4, 1, 11), deleted: false, visibility: { $type: 'UnlimitedVisibility' }, author: anna },
        { id: 'c-12', text: 'Salary bands for the team', created: at(2024, 4, 1, 12), deleted: false, visibility: { $type: 'LimitedVisibility' }, author: ben },
        { id: 'c-13', text: 'gone', created: at(2024, 4, 1, 13), deleted: true, visibility: null, author: ben },
      ],
      attachments: [
        { id: 'f-1', name: 'notes.txt', size: 18, mimeType: 'text/plain', url: '/api/files/f-1?sign=abc', created: at(2024, 4, 1, 10), removed: false, visibility: null, comment: null, author: ben },
      ],
      timeTracking: { workItems: [{ id: 'w-1', date: Date.UTC(2024, 3, 2), duration: { minutes: 90 }, text: 'Drafting the plan', author: anna }] },
    },
    {
      $type: 'Issue',
      id: '2-2',
      idReadable: 'YT-2',
      summary: 'Write the notes',
      description: null,
      created: at(2024, 4, 1, 10),
      updated: at(2024, 4, 3, 16),
      resolved: at(2024, 4, 3, 16),
      reporter: ben,
      tags: [],
      visibility: { $type: 'UnlimitedVisibility' },
      customFields: [
        { name: 'State', $type: 'StateIssueCustomField', value: { name: 'Fixed', isResolved: true } },
        { name: 'Priority', $type: 'SingleEnumIssueCustomField', value: { name: 'Normal' } },
        { name: 'Assignee', $type: 'SingleUserIssueCustomField', value: null },
      ],
      links: [
        { direction: 'INWARD', linkType: { name: 'Subtask', sourceToTarget: 'parent for', targetToSource: 'subtask of' }, issues: [{ idReadable: 'YT-1' }] },
        { direction: 'OUTWARD', linkType: { name: 'Depend', sourceToTarget: 'depends on', targetToSource: 'is required for' }, issues: [{ idReadable: 'YT-1' }] },
      ],
      comments: [{ id: 'c-21', text: 'The log is attached.', created: at(2024, 4, 3, 15), deleted: false, visibility: null, author: zed }],
      attachments: [{ id: 'f-2', name: 'build.log', size: 15, mimeType: 'text/plain', url: '/api/files/f-2?sign=def', created: at(2024, 4, 3, 15), removed: false, visibility: null, comment: { id: 'c-21' }, author: zed }],
      timeTracking: { workItems: [] },
    },
    {
      $type: 'Issue',
      id: '2-3',
      idReadable: 'YT-3',
      summary: 'Pay the contractors',
      description: 'Only finance sees this.',
      created: at(2024, 4, 2),
      updated: at(2024, 4, 2),
      resolved: null,
      reporter: ben,
      tags: [],
      visibility: { $type: 'LimitedVisibility' },
      customFields: [],
      links: [],
      comments: [],
      attachments: [],
      timeTracking: null,
    },
    {
      $type: 'Issue',
      id: '2-4',
      idReadable: 'YT-4',
      summary: 'Retire the old exporter',
      description: '',
      created: at(2024, 4, 4),
      updated: at(2024, 4, 4),
      resolved: null,
      reporter: { login: 'ola', fullName: 'Ola Gone', email: null },
      tags: [{ name: 'cleanup' }],
      visibility: null,
      customFields: [{ name: 'State', $type: 'StateIssueCustomField', value: { name: 'Submitted' } }],
      links: [],
      comments: [],
      attachments: [],
      timeTracking: null,
    },
  ];
}

export interface FakeYouTrack extends Fake {
  issues: ReturnType<typeof youtrackIssues>;
  files: Record<string, Buffer>;
  downloads: string[];
  /** A 429 with Retry-After: 1 the first time this $skip is asked for. */
  slowDownAt: number | null;
  /** A 500 the first n times this $skip is asked for. */
  failAt: { skip: number; times: number } | null;
}

export async function fakeYouTrack(): Promise<FakeYouTrack> {
  // The handler reads the switches from the object returned, so a test can flip them.
  let state!: FakeYouTrack;
  let slowed = false;
  const fake = await serve((req, url, body, res) => {
    if (req.headers.authorization !== `Bearer ${YT_TOKEN}`) return json(res, 401, { error: 'Unauthorized', error_description: 'You are not logged in.' });
    if (url.pathname === '/api/users/me') return json(res, 200, { login: 'jane', fullName: 'Jane Remote', email: 'jane@example.com', $type: 'Me' });
    if (url.pathname === '/api/issuesGetter/count' && req.method === 'POST') {
      const q = (JSON.parse(body || '{}') as { query?: string }).query ?? '';
      return json(res, 200, { count: q.startsWith('project: NONE') ? 0 : state.issues.length, $type: 'IssueCountResponse' });
    }
    if (url.pathname === '/api/issues') {
      const skip = Number(url.searchParams.get('$skip') ?? 0);
      const top = Number(url.searchParams.get('$top') ?? 42);
      if (state.slowDownAt === skip && !slowed) {
        slowed = true;
        return json(res, 429, { error: 'Too Many Requests' }, { 'retry-after': '1' });
      }
      if (state.failAt && state.failAt.skip === skip && state.failAt.times > 0) {
        state.failAt.times--;
        return json(res, 500, { error: 'server_error', error_description: 'Something broke' });
      }
      return json(res, 200, state.issues.slice(skip, skip + top));
    }
    const file = /^\/api\/files\/([\w-]+)$/.exec(url.pathname);
    if (file && state.files[file[1]!]) {
      state.downloads.push(file[1]!);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(state.files[file[1]!]!.length) });
      return res.end(state.files[file[1]!]);
    }
    return json(res, 404, { error: 'Not Found', error_description: `No such resource: ${url.pathname}` });
  });
  state = Object.assign(fake, {
    issues: youtrackIssues(),
    files: { 'f-1': Buffer.from('Release notes, v2\n'), 'f-2': Buffer.from('build: green\n\n\n') } as Record<string, Buffer>,
    downloads: [] as string[],
    slowDownAt: null as number | null,
    failAt: null as { skip: number; times: number } | null,
  });
  return state;
}

// ---------------------------------------------------------------------------
// Jira Cloud
// ---------------------------------------------------------------------------

export const JIRA_EMAIL = 'jane@example.com';
export const JIRA_TOKEN = 'ATATT3xFfGF0-secret-jira-token';
export const JIRA_BASIC = `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64')}`;

const adf = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

/** The smallest PNG there is: one transparent pixel. */
export const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

export function jiraIssues(base: string) {
  const bob = { accountId: 'b1', displayName: 'Ben Okafor', emailAddress: 'ben@example.com' };
  const annaJ = { accountId: 'a1', displayName: 'Anna Schmidt' };
  const zedJ = { accountId: 'z1', displayName: 'Zed Remote' };
  return [
    {
      id: '10001',
      key: 'ABC-1',
      fields: {
        summary: 'Single sign-on fails on Safari',
        description: adf(
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Steps' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Open ' }, { type: 'text', text: 'Safari', marks: [{ type: 'strong' }] }, { type: 'text', text: ' and sign in.' }] },
          { type: 'bulletList', content: [{ type: 'listItem', content: [para('A blank page')] }, { type: 'listItem', content: [para('No error')] }] },
          { type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'login()' }] },
        ),
        issuetype: { name: 'Bug' },
        status: { name: 'In Progress' },
        priority: { name: 'High' },
        resolution: null,
        assignee: annaJ,
        reporter: bob,
        created: '2024-03-12T14:15:00.000+0100',
        updated: '2024-03-14T09:00:00.000+0100',
        resolutiondate: null,
        labels: ['regression', 'sso'],
        components: [{ name: 'Auth' }],
        fixVersions: [],
        duedate: '2024-03-30',
        timeoriginalestimate: 28800,
        timespent: 3600,
        parent: null,
        security: null,
        issuelinks: [{ type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: 'ABC-3' } }],
        comment: {
          comments: [{ id: '100', body: adf(para('I can reproduce it')), created: '2024-03-13T10:00:00.000+0100', author: bob }],
          maxResults: 1,
          total: 3,
          startAt: 0,
        },
        worklog: {
          worklogs: [{ id: '200', started: '2024-03-13T09:00:00.000+0100', timeSpentSeconds: 3600, comment: adf(para('Debugging')), author: annaJ }],
          maxResults: 20,
          total: 1,
        },
        attachment: [
          { id: '10100', filename: 'screenshot.png', size: PNG.length, mimeType: 'image/png', content: `${base}/rest/api/3/attachment/content/10100`, created: '2024-03-12T15:00:00.000+0100', author: bob },
        ],
        customfield_10020: [{ id: 1, name: 'Sprint 1', state: 'active' }],
        customfield_10019: '0|i0000f:',
        customfield_10050: 3,
      },
    },
    {
      id: '10002',
      key: 'ABC-2',
      fields: {
        summary: 'Fix the cookie',
        description: null,
        issuetype: { name: 'Sub-task' },
        status: { name: 'Done' },
        priority: { name: 'Medium' },
        assignee: annaJ,
        reporter: annaJ,
        created: '2024-03-12T15:00:00.000+0100',
        updated: '2024-03-15T17:30:00.000+0100',
        resolutiondate: '2024-03-15T17:30:00.000+0100',
        labels: [],
        parent: { key: 'ABC-1' },
        issuelinks: [],
        comment: { comments: [], total: 0 },
        worklog: { worklogs: [], total: 0 },
        attachment: [],
      },
    },
    {
      id: '10003',
      key: 'ABC-3',
      fields: {
        summary: 'Rotate keys',
        description: adf(para('Every quarter.')),
        issuetype: { name: 'Story' },
        status: { name: 'To Do' },
        priority: { name: 'Lowest' },
        reporter: zedJ,
        created: '2024-03-01T09:00:00.000+0100',
        updated: '2024-03-05T17:30:00.000+0100',
        labels: [],
        issuelinks: [{ type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'ABC-1' } }],
        comment: { comments: [], total: 0 },
        worklog: { worklogs: [], total: 0 },
        attachment: [],
      },
    },
    {
      id: '10004',
      key: 'ABC-4',
      fields: { summary: 'Acquisition talks', security: { id: '10000', name: 'Board only' }, issuetype: { name: 'Task' }, status: { name: 'To Do' }, created: '2024-03-01T09:00:00.000+0100' },
    },
  ];
}

const jiraComments = () => [
  { id: '100', body: adf(para('I can reproduce it')), created: '2024-03-13T10:00:00.000+0100', author: { displayName: 'Ben Okafor', emailAddress: 'ben@example.com' } },
  { id: '101', body: adf(para('Me too')), created: '2024-03-14T08:30:00.000+0100', author: { displayName: 'Zed Remote' } },
  { id: '102', body: adf(para('Customer is ACME, contract #4471')), created: '2024-03-14T08:40:00.000+0100', author: { displayName: 'Ben Okafor' }, visibility: { type: 'role', value: 'Developers' } },
];

export interface FakeJira extends Fake {
  media: Fake;
}

/** Jira Cloud, and the media service its attachments redirect to (another origin). */
export async function fakeJiraCloud(): Promise<FakeJira> {
  const media = await serve((_req, url, _body, res) => {
    if (url.pathname === '/file/10100' && url.searchParams.get('token') === 'media-xyz') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) });
      return res.end(PNG);
    }
    return json(res, 404, { message: 'no such file' });
  });
  let base = '';
  const fake = await serve((req, url, body, res) => {
    if (req.headers.authorization !== JIRA_BASIC) return json(res, 401, { errorMessages: ['You are not authenticated. Authentication required to perform this operation.'], errors: {} });
    if (url.pathname === '/rest/api/3/myself') return json(res, 200, { accountId: '5b10', displayName: 'Jane Remote', emailAddress: JIRA_EMAIL });
    if (url.pathname === '/rest/api/3/field') {
      return json(res, 200, [
        { id: 'summary', name: 'Summary', custom: false },
        { id: 'customfield_10020', name: 'Sprint', custom: true, schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
        { id: 'customfield_10019', name: 'Rank', custom: true, schema: { custom: 'com.pyxis.greenhopper.jira:gh-lexo-rank' } },
        { id: 'customfield_10050', name: 'Story Points', custom: true, schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' } },
      ]);
    }
    if (url.pathname === '/rest/api/3/search/approximate-count' && req.method === 'POST') {
      const jql = (JSON.parse(body || '{}') as { jql?: string }).jql ?? '';
      if (/badfield/.test(jql)) return json(res, 400, { errorMessages: ["Field 'badfield' does not exist or you do not have permission to view it."], errors: {} });
      return json(res, 200, { count: 4 });
    }
    if (url.pathname === '/rest/api/3/search/jql') {
      const all = jiraIssues(base);
      const token = url.searchParams.get('nextPageToken');
      if (!token) return json(res, 200, { issues: all.slice(0, 2), nextPageToken: 'page-2', isLast: false });
      if (token === 'page-2') return json(res, 200, { issues: all.slice(2), isLast: true });
      return json(res, 400, { errorMessages: ['The page token is invalid.'] });
    }
    if (url.pathname === '/rest/api/3/issue/ABC-1/comment') {
      const startAt = Number(url.searchParams.get('startAt') ?? 0);
      const list = jiraComments();
      return json(res, 200, { comments: list.slice(startAt, startAt + 2), startAt, maxResults: 2, total: list.length });
    }
    if (url.pathname === '/rest/api/3/attachment/content/10100') {
      res.writeHead(303, { location: `${media.url}/file/10100?token=media-xyz` });
      return res.end();
    }
    return json(res, 404, { errorMessages: ['Not found'] });
  });
  base = fake.url;
  const closeOwn = fake.close;
  return Object.assign(fake, {
    media,
    close: async () => {
      await media.close();
      await closeOwn();
    },
  });
}

// ---------------------------------------------------------------------------
// Jira Data Center
// ---------------------------------------------------------------------------

export const DC_TOKEN = 'NjE2NzM4OTk1secret-dc-pat';

export async function fakeJiraDataCenter(): Promise<Fake> {
  const issues = [
    {
      id: '20001',
      key: 'OPS-1',
      fields: {
        summary: 'Backups run late',
        description: 'h2. What happens\n* the job starts at 02:00\n* it ends at *09:00*\n{code:bash}\nrun-backup --all\n{code}\nSee [the runbook|https://wiki.example.com/backups].',
        issuetype: { name: 'Bug' },
        status: { name: 'Open' },
        priority: { name: 'Major' },
        assignee: { name: 'anna', displayName: 'Anna Schmidt', emailAddress: 'anna@corp.example' },
        reporter: { name: 'bokafor', displayName: 'Ben Okafor', emailAddress: 'ben@example.com' },
        created: '2024-02-01T08:00:00.000+0000',
        updated: '2024-02-02T08:00:00.000+0000',
        labels: ['backups'],
        comment: { comments: [{ id: '301', body: 'Seen again on *Monday*.', created: '2024-02-02T07:00:00.000+0000', author: { name: 'bokafor', displayName: 'Ben Okafor' } }], total: 1 },
        worklog: { worklogs: [], total: 0 },
        attachment: [],
      },
    },
    {
      id: '20002',
      key: 'OPS-2',
      fields: { summary: 'Rotate the disks', description: null, issuetype: { name: 'Task' }, status: { name: 'Closed' }, priority: { name: 'Minor' }, created: '2024-02-03T08:00:00.000+0000', labels: [] },
    },
    {
      id: '20003',
      key: 'OPS-3',
      fields: { summary: 'Watch the disk space', description: '_Every_ morning.', issuetype: { name: 'Task' }, status: { name: 'Open' }, created: '2024-02-04T08:00:00.000+0000', labels: [] },
    },
  ];
  return serve((req, url, _body, res) => {
    if (req.headers.authorization !== `Bearer ${DC_TOKEN}`) return json(res, 401, { errorMessages: ['You are not authenticated.'] });
    if (url.pathname === '/rest/api/2/myself') return json(res, 200, { name: 'jane', displayName: 'Jane Remote', emailAddress: 'jane@example.com' });
    if (url.pathname === '/rest/api/2/field') return json(res, 200, []);
    if (url.pathname === '/rest/api/2/search') {
      const startAt = Number(url.searchParams.get('startAt') ?? 0);
      const max = Number(url.searchParams.get('maxResults') ?? 50);
      return json(res, 200, { startAt, maxResults: max, total: issues.length, issues: max === 0 ? [] : issues.slice(startAt, startAt + Math.min(max, 2)) });
    }
    return json(res, 404, { errorMessages: ['Not found'] });
  });
}
