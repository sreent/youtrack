/**
 * A ClickUp, as its API v2 answers, for the browser tests of importing from it (D61). It runs in
 * the test's process on this machine; the server under test may read from it over plain http
 * because the suite starts it with IMPORT_ALLOW_HTTP_LOOPBACK (playwright.config.ts).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const CU_TOKEN = 'pk_4242_E2E0F1E2D3C4B5A69788796A5B4C3D2';
export const CU_LIST = '901234567';

const at = (d: number, h = 9) => String(Date.UTC(2026, 2, d, h));
const ben = { id: 12, username: 'Ben Okafor', email: 'ben.okafor@old-tracker.example' };
const zed = { id: 13, username: 'Zed Remote', email: 'zed@old-tracker.example' };

function tasks() {
  return [
    {
      id: '86e1',
      name: 'Ship the mobile app',
      markdown_description: 'Ready for **review**.',
      status: { status: 'in progress', type: 'custom' },
      date_created: at(1),
      date_updated: at(2),
      creator: ben,
      assignees: [ben],
      watchers: [zed],
      tags: [{ name: 'mobile' }],
      priority: { priority: 'urgent' },
      time_estimate: 7_200_000,
      time_spent: 2_700_000,
      checklists: [
        {
          name: 'Release',
          orderindex: 0,
          items: [
            { name: 'Tag the build', resolved: true, orderindex: 0 },
            { name: 'Write the notes', resolved: false, orderindex: 1 },
          ],
        },
      ],
      custom_fields: [],
      dependencies: [{ task_id: '86e1', depends_on: '86e2' }],
    },
    { id: '86e2', name: 'Store listing', status: { status: 'complete', type: 'closed' }, date_created: at(1, 10), date_updated: at(3), date_closed: at(3), date_done: at(3), assignees: [], watchers: [], time_spent: 0, custom_fields: [] },
  ];
}

export interface FakeClickUp {
  url: string;
  close(): Promise<void>;
}

export async function startClickUp(): Promise<FakeClickUp> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const path = url.pathname.replace(/^\/api\/v2/, '');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    req.resume();
    req.on('end', () => {
      if (req.headers.authorization !== CU_TOKEN) return send(401, { err: 'Token invalid', ECODE: 'OAUTH_025' });
      if (path === '/user') return send(200, { user: { id: 1, username: 'Jane Remote', email: 'jane@example.com' } });
      if (path === `/list/${CU_LIST}`) return send(200, { id: CU_LIST, name: 'Mobile', task_count: 2 });
      if (path === `/list/${CU_LIST}/task`) return send(200, { tasks: tasks(), last_page: true });
      if (path === '/task/86e1/comment') return send(200, { comments: [{ id: 'c1', comment: [{ text: 'The build is ' }, { text: 'green', attributes: { bold: true } }, { text: '\n' }], comment_text: 'The build is green', user: ben, date: at(2, 11) }] });
      if (/^\/task\/[^/]+\/comment$/.test(path)) return send(200, { comments: [] });
      if (path === '/task/86e1/time') return send(200, { data: [{ user: ben, time: 2_700_000, intervals: [{ id: 'i1', start: at(2, 9), end: at(2, 10), time: '2700000' }] }] });
      const task = tasks().find((t) => path === `/task/${t.id}`);
      if (task) return send(200, { ...task, attachments: [] });
      return send(404, { err: 'Route not found', ECODE: 'APP_001' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}
