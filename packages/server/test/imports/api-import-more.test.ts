/**
 * Importing from GitHub Issues, Redmine and Zendesk (docs/architecture.md, D46), through D29's path:
 * read over the API into rows, mapped as an export's columns are, run, and run again without making
 * anything twice. Zendesk's tickets come into a help desk with their requesters and who saw each reply.
 */
import type { Ctx } from '../../src/context';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { comments, helpdeskRequests, imports, requesters } from '../../src/db/schema';
import { importFromApi, waitForFetch } from '../../src/services/api-imports';
import { getImport, importRowsOf, runImport, waitForImport } from '../../src/services/imports';
import { getIssue } from '../../src/services/issues';
import { createProject, updateProject } from '../../src/services/projects';
import { updateUser } from '../../src/services/users';
import { presentField } from '../../src/tools/registry';
import { addProviderLogin } from '../../src/vcs/logins';
import { createWorld, type TestWorld } from '../helpers';
import { json, serve, type Fake } from './fake-trackers';

let w: TestWorld;
let admin: Ctx;
const fakes: Fake[] = [];
const at = (d: number, h = 9) => new Date(Date.UTC(2026, 2, d, h)).toISOString();
const field = (i: Awaited<ReturnType<typeof getIssue>>, name: string) => presentField(i.fields.find((f) => f.name === name)!);

beforeAll(async () => {
  w = await createWorld({ config: { importAllowHttpLoopback: true } });
  admin = w.adminCtx;
  await updateUser(admin, 'anna', { email: 'anna@example.com' });
  await updateUser(admin, 'ben', { email: 'ben@example.com' });
  await addProviderLogin(admin, 'anna', { provider: 'github', login: 'anna-s' });
  for (const key of ['GHI', 'RMI', 'DESK']) await createProject(admin, { key, name: `Import ${key}`, template: 'software' });
  await updateProject(admin, 'DESK', { settings: { helpdesk: { enabled: true } } });
});

afterAll(async () => {
  for (const f of fakes) await f.close();
  await w.close();
});

async function fetched(started: { id: string }) {
  await waitForFetch(started.id);
  const imp = await getImport(admin, started.id);
  expect(imp.status, imp.error ?? '').toBe('ready');
  return imp;
}

async function ran(id: string) {
  await runImport(admin, id);
  await waitForImport(id);
  const done = await getImport(admin, id);
  expect(done.status, done.error ?? '').toBe('done');
  const rows = await importRowsOf(admin, id, { offset: 0, limit: 50 });
  return { done, made: new Map(rows.items.map((r) => [r.key, r.issue!])) };
}

describe('GitHub Issues', () => {
  let gh: Fake;
  let limited = false;
  const token = 'github_pat_reader';
  beforeAll(async () => {
    gh = await serve((req, url, _body, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { message: 'Bad credentials' });
      if (url.pathname === '/user') return json(res, 200, { login: 'importer', name: 'Ima Porter' });
      if (url.pathname === '/search/issues') return json(res, 200, { total_count: 3 });
      if (url.pathname === '/repos/acme/backend/issues') {
        // Its secondary rate limit, once: a 403 with Retry-After.
        if (!limited) {
          limited = true;
          return json(res, 403, { message: 'You have exceeded a secondary rate limit' }, { 'retry-after': '1' });
        }
        if (url.searchParams.get('page') === '2') {
          return json(res, 200, [{ id: 3, number: 3, title: 'Dark mode', body: '', state: 'closed', state_reason: 'not_planned', created_at: at(3), updated_at: at(4), closed_at: at(4), user: { login: 'stranger' }, labels: [], comments: 0 }]);
        }
        return json(
          res,
          200,
          [
            { id: 1, number: 1, title: 'Login loops on Safari', body: 'Steps:\n1. Sign in', state: 'open', created_at: at(1), updated_at: at(2), user: { login: 'anna-s' }, assignees: [{ login: 'anna-s' }], labels: [{ name: 'bug' }, 'p1'], milestone: { title: '1.1' }, comments: 1 },
            { id: 2, number: 2, title: 'A pull request', state: 'open', created_at: at(1), pull_request: { url: 'x' }, comments: 0 },
            { id: 4, number: 4, title: 'Crash on save', body: 'Boom', state: 'closed', state_reason: 'completed', created_at: at(2), updated_at: at(3), closed_at: at(3), user: { login: 'anna-s' }, labels: [], comments: 0 },
          ],
          { link: `<${gh.url}/repos/acme/backend/issues?page=2&per_page=50>; rel="next", <${gh.url}/repos/acme/backend/issues?page=2&per_page=50>; rel="last"` },
        );
      }
      if (url.pathname === '/repos/acme/backend/issues/1/comments') return json(res, 200, [{ id: 501, body: 'Seen on 17.4 too', created_at: at(2), user: { login: 'anna-s' } }]);
      json(res, 404, { message: 'Not Found' });
    });
    fakes.push(gh);
  });

  it('reads a repository’s issues, not its pull requests, page by page by Link, waiting out its limit', async () => {
    const started = await importFromApi(admin, { project: 'GHI', source: 'github', url: gh.url, query: 'acme/backend', credentials: { token } });
    expect(started.origin).toMatchObject({ kind: 'github', account: 'Ima Porter', fetch: { total: 3 } });
    const imp = await fetched(started);
    expect(imp.rows).toBe(3);
    const target = (name: string) => imp.columns.find((c) => c.name === name)?.target;
    expect([target('Issue Id'), target('Summary'), target('State'), target('Tags'), target('Fix versions'), target('Assignee'), target('Reporter')]).toEqual([
      'key',
      'summary',
      'field:State',
      'tags',
      'field:Fix versions',
      'field:Assignee',
      'reporter',
    ]);
    // GitHub names people by login; one a4a knows by theirs (D33, D46) is matched by their email.
    expect(imp.values.find((v) => v.target === 'field:Assignee')!.items).toEqual([{ value: 'Anna Schmidt <anna@example.com>', count: 1, to: 'anna', found: true }]);
    expect(gh.seen.filter((s) => s.path === '/repos/acme/backend/issues').length).toBe(3);
    expect(JSON.stringify(imp)).not.toContain(token);
  });

  it('runs, keeping states, labels, the milestone and comments, and makes nothing twice when run again', async () => {
    const [imp] = await w.app.db.select({ id: imports.id }).from(imports).where(eq(imports.source, 'github'));
    const { done, made } = await ran(imp!.id);
    expect(done.result).toMatchObject({ created: 3, comments: 1, failed: 0 });
    const one = await getIssue(admin, made.get('BACKEND-1')!);
    expect([one.summary, field(one, 'State'), field(one, 'Assignee'), field(one, 'Fix versions'), one.reporter?.login]).toEqual(['Login loops on Safari', 'Open', 'anna', '1.1', 'anna']);
    expect(one.tags.map((t) => t.name).sort()).toEqual(['bug', 'p1']);
    expect(field(await getIssue(admin, made.get('BACKEND-3')!), 'State')).toBe("Won't fix");
    expect(field(await getIssue(admin, made.get('BACKEND-4')!), 'State')).toBe('Fixed');
    const again = await ran(imp!.id);
    expect(again.done.result).toMatchObject({ created: 0, failed: 0 });
  });
});

describe('Redmine', () => {
  let rm: Fake;
  const key = 'f00dfeedc0ffee';
  beforeAll(async () => {
    rm = await serve((req, url, _body, res) => {
      if (req.headers.authorization !== `Basic ${Buffer.from(`${key}:x`).toString('base64')}`) return json(res, 401, {});
      if (url.pathname === '/users/current.json') return json(res, 200, { user: { login: 'jdoe', firstname: 'Jo', lastname: 'Doe' } });
      if (url.pathname === '/issues.json') {
        const brief = [{ id: 11 }, { id: 12 }];
        return json(res, 200, { issues: Number(url.searchParams.get('limit')) === 1 ? brief.slice(0, 1) : brief, total_count: 2, offset: 0, limit: 50 });
      }
      if (url.pathname === '/issues/11.json') {
        return json(res, 200, {
          issue: {
            id: 11,
            subject: 'Invoices round twice',
            description: 'Off by a cent.',
            tracker: { id: 1, name: 'Bug' },
            status: { id: 2, name: 'In Progress' },
            priority: { id: 3, name: 'High' },
            author: { id: 5, name: 'Ben Okafor' },
            assigned_to: { id: 6, name: 'Anna Schmidt' },
            estimated_hours: 2.5,
            created_on: at(5),
            updated_on: at(6),
            custom_fields: [{ id: 1, name: 'Customer', value: 'Acme' }],
            journals: [
              { id: 900, user: { id: 6, name: 'Anna Schmidt' }, notes: 'Found it: rounding in two places.', created_on: at(6) },
              { id: 901, user: { id: 6, name: 'Anna Schmidt' }, notes: 'Only for the team.', private_notes: true, created_on: at(6) },
              { id: 902, user: { id: 6, name: 'Anna Schmidt' }, notes: '', created_on: at(6) },
            ],
            relations: [{ issue_id: 11, issue_to_id: 12, relation_type: 'blocks' }],
          },
        });
      }
      if (url.pathname === '/issues/12.json') {
        return json(res, 200, { issue: { id: 12, subject: 'Release 2.0', tracker: { id: 2, name: 'Feature' }, status: { id: 5, name: 'Closed' }, created_on: at(5), updated_on: at(7), closed_on: at(7), is_private: false } });
      }
      if (url.pathname === '/time_entries.json') {
        return json(res, 200, { time_entries: url.searchParams.get('issue_id') === '11' ? [{ id: 70, hours: 1.5, spent_on: '2026-03-06', comments: 'Debugging', user: { id: 6, name: 'Anna Schmidt' } }] : [] });
      }
      json(res, 404, {});
    });
    fakes.push(rm);
  });

  it("reads a project's issues with their journals, relations and time, and leaves private notes out", async () => {
    const started = await importFromApi(admin, { project: 'RMI', source: 'redmine', url: `${rm.url}/projects/backend/issues`, query: 'backend', credentials: { token: key }, bring: { files: false } });
    expect(started.origin).toMatchObject({ kind: 'redmine', url: rm.url, account: 'Jo Doe', fetch: { total: 2 } });
    const imp = await fetched(started);
    expect(imp.origin!.fetch).toMatchObject({ issues: 2, comments: 1, work: 1, left: { comments: 1 } });
    const target = (name: string) => imp.columns.find((c) => c.name === name)?.target;
    expect([target('Type'), target('State'), target('Priority'), target('Estimation'), target('is required for')]).toEqual(['field:Type', 'field:State', 'field:Priority', 'field:Estimation', 'link:is required for']);
    const { done, made } = await ran(imp.id);
    expect(done.result).toMatchObject({ created: 2, comments: 1, work: 1, links: 1, failed: 0 });
    const one = await getIssue(admin, made.get('BACKEND-11')!);
    expect([field(one, 'Type'), field(one, 'State'), field(one, 'Priority'), field(one, 'Assignee'), field(one, 'Estimation'), one.reporter?.login]).toEqual(['Bug', 'In Progress', 'Critical', 'anna', '2h 30m', 'ben']);
    expect(one.links.map((l) => `${l.phrase} ${l.issue.id}`)).toEqual([`is required for ${made.get('BACKEND-12')}`]);
    expect(field(await getIssue(admin, made.get('BACKEND-12')!), 'State')).toBe('Done');
  });
});

describe('Zendesk, into a help desk', () => {
  let zd: Fake;
  const token = 'zd-api-token';
  beforeAll(async () => {
    zd = await serve((req, url, _body, res) => {
      if (req.headers.authorization !== `Basic ${Buffer.from(`agent@acme.example/token:${token}`).toString('base64')}`) return json(res, 401, { error: 'Couldn\'t authenticate you' });
      if (url.pathname === '/api/v2/users/me.json') return json(res, 200, { user: { name: 'Sam Agent', email: 'agent@acme.example', role: 'agent' } });
      if (url.pathname === '/api/v2/tickets/count.json') return json(res, 200, { count: { value: 1 } });
      if (url.pathname === '/api/v2/incremental/tickets/cursor.json') {
        return json(res, 200, {
          tickets: [
            { id: 77, subject: 'Cannot download my invoice', description: 'The button does nothing.', status: 'solved', priority: 'urgent', type: 'problem', tags: ['billing'], requester_id: 1, assignee_id: 2, group_id: 9, created_at: at(8), updated_at: at(9), via: { channel: 'email' } },
            { id: 78, status: 'deleted' },
          ],
          users: [
            { id: 1, name: 'Rita Requester', email: 'rita@customer.example' },
            { id: 2, name: 'Ben Okafor', email: 'ben@example.com' },
          ],
          groups: [{ id: 9, name: 'Billing' }],
          after_cursor: 'c1',
          end_of_stream: true,
        });
      }
      if (url.pathname === '/api/v2/tickets/77/comments.json') {
        return json(res, 200, {
          comments: [
            { id: 1, author_id: 1, plain_body: 'The button does nothing.', public: true, created_at: at(8) },
            { id: 2, author_id: 2, plain_body: 'Looking at it now.', public: true, created_at: at(8, 10) },
            { id: 3, author_id: 2, plain_body: 'The PDF service is down again.', public: false, created_at: at(8, 11) },
            { id: 4, author_id: 1, plain_body: 'Works now, thanks!', public: true, created_at: at(9) },
          ],
          meta: { has_more: false },
        });
      }
      json(res, 404, {});
    });
    fakes.push(zd);
  });

  it('brings tickets in as requests: requesters, and public replies and internal notes as they were', async () => {
    const started = await importFromApi(admin, { project: 'DESK', source: 'zendesk', url: `${zd.url}/agent/tickets/77`, query: 'all', credentials: { token, email: 'agent@acme.example' } });
    expect(started.origin).toMatchObject({ kind: 'zendesk', account: 'Sam Agent', fetch: { total: 1 } });
    const imp = await fetched(started);
    expect(imp.rows).toBe(1);
    const { done, made } = await ran(imp.id);
    expect(done.result).toMatchObject({ created: 1, comments: 3, failed: 0 });
    const issue = await getIssue(admin, made.get('ZD-77')!);
    expect([issue.summary, field(issue, 'State'), field(issue, 'Priority'), field(issue, 'Type'), field(issue, 'Assignee')]).toEqual(['Cannot download my invoice', 'Fixed', 'Show-stopper', 'Bug', 'ben']);
    const [request] = await w.app.db.select({ email: requesters.email, name: requesters.name }).from(helpdeskRequests).innerJoin(requesters, eq(requesters.id, helpdeskRequests.requesterId)).where(eq(helpdeskRequests.issueId, issue.uid));
    expect(request).toEqual({ email: 'rita@customer.example', name: 'Rita Requester' });
    const said = await w.app.db.select().from(comments).where(eq(comments.issueId, issue.uid));
    const byText = (t: string) => said.find((c) => c.text.endsWith(t))!;
    expect(byText('Looking at it now.')).toMatchObject({ visibility: 'public', requesterId: null });
    expect(byText('The PDF service is down again.')).toMatchObject({ visibility: 'internal' });
    expect(byText('Works now, thanks!')).toMatchObject({ visibility: 'public', channel: 'helpdesk', text: 'Works now, thanks!' });
    expect(byText('Works now, thanks!').requesterId).not.toBeNull();
  });
});
