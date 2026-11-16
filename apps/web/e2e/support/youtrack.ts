/**
 * A YouTrack, as its REST API answers, for the browser tests of importing from an API. It runs in
 * the test's process on this machine; the server under test may read from it over plain http
 * because the suite starts it with IMPORT_ALLOW_HTTP_LOOPBACK (playwright.config.ts).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const YT_TOKEN = 'perm:ZTJl.dGVzdA==.e2e-token';

const at = (d: number, h = 9) => Date.UTC(2024, 3, d, h);
const anna = { login: 'anna.s', fullName: 'Anna Schmidt', email: null };
const ben = { login: 'bokafor', fullName: 'Ben Okafor', email: 'ben.okafor@old-tracker.example' };

function issues() {
  return [
    {
      id: '2-1',
      idReadable: 'OLD-1',
      summary: 'Move the invoices to the new store',
      description: 'They live in the **old** bucket.',
      created: at(1),
      updated: at(2),
      resolved: null,
      reporter: ben,
      tags: [{ name: 'migration' }],
      visibility: null,
      customFields: [
        { name: 'State', $type: 'StateIssueCustomField', value: { name: 'Open' } },
        { name: 'Priority', $type: 'SingleEnumIssueCustomField', value: { name: 'Major' } },
        { name: 'Type', $type: 'SingleEnumIssueCustomField', value: { name: 'Task' } },
      ],
      links: [],
      comments: [{ id: 'c-1', text: 'The bucket is read-only now.', created: at(1, 11), deleted: false, visibility: null, author: ben }],
      attachments: [{ id: 'f-1', name: 'notes.txt', size: 18, mimeType: 'text/plain', url: '/api/files/f-1', created: at(1, 10), removed: false, visibility: null, comment: null, author: ben }],
      timeTracking: { workItems: [{ id: 'w-1', date: Date.UTC(2024, 3, 2), duration: { minutes: 45 }, text: 'Listing the files', author: anna }] },
    },
    {
      id: '2-2',
      idReadable: 'OLD-2',
      summary: 'Retire the old exporter',
      description: '',
      created: at(3),
      updated: at(3),
      resolved: null,
      reporter: anna,
      tags: [],
      visibility: null,
      customFields: [{ name: 'State', $type: 'StateIssueCustomField', value: { name: 'Submitted' } }],
      links: [{ direction: 'INWARD', linkType: { name: 'Subtask', sourceToTarget: 'parent for', targetToSource: 'subtask of' }, issues: [{ idReadable: 'OLD-1' }] }],
      comments: [],
      attachments: [],
      timeTracking: { workItems: [] },
    },
  ];
}

export interface FakeYouTrack {
  url: string;
  close(): Promise<void>;
}

export async function startYouTrack(): Promise<FakeYouTrack> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    req.resume();
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${YT_TOKEN}`) return send(401, { error: 'Unauthorized', error_description: 'You are not logged in.' });
      if (url.pathname === '/api/users/me') return send(200, { login: 'jane', fullName: 'Jane Remote', email: 'jane@example.com' });
      if (url.pathname === '/api/issuesGetter/count') return send(200, { count: 2 });
      if (url.pathname === '/api/issues') {
        const skip = Number(url.searchParams.get('$skip') ?? 0);
        const top = Number(url.searchParams.get('$top') ?? 50);
        return send(200, issues().slice(skip, skip + top));
      }
      if (url.pathname === '/api/files/f-1') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('Invoices, by year\n');
      }
      return send(404, { error: 'Not Found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}
