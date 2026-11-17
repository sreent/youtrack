/**
 * GitHub Issues, Redmine and Zendesk, read as YouTrack and Jira are (D29, readers.ts): each issue
 * as named cells, the columns the mapping already knows (Summary, State, Priority, Assignee, Fix
 * versions…), and what cells can't hold beside them (D46).
 *
 * The shapes, as their documentation gives them:
 *
 * - GitHub: GET /repos/{owner}/{repo}/issues?state&labels&sort=created&direction=asc, page by page
 *   by its Link header (pull requests come in the same list, and are left out), each issue's
 *   comments by /issues/{n}/comments; /search/issues for how many; /user for whom the token is. A
 *   token, as a bearer token. Rate limits are waited out (Retry-After, x-ratelimit-reset).
 * - Redmine: GET /issues.json?project_id&status_id=*&sort=id&offset&limit, then each issue with
 *   /issues/{id}.json?include=journals,attachments,relations, and its time entries; total_count for
 *   how many; /users/current.json for whom. An API key as Basic's user name, or a login and password.
 * - Zendesk: the incremental export, GET /api/v2/incremental/tickets/cursor.json with its cursor,
 *   requesters and assignees side-loaded; each ticket's comments by /tickets/{id}/comments.json, with
 *   whether each is public; /users/me.json for whom. An agent's email and API token as Basic
 *   ("email/token:…"), or an OAuth token.
 */
import type { ImportBring } from '@a4a/shared';
import { personCell, type Reader, type RemoteCursor, type RemoteIssue, type RemotePage, type RemotePerson, type RowExtra } from './readers';
import { Remote, RemoteError } from './remote';

const empty = (): RowExtra => ({ comments: [], work: [], files: [], leftComments: 0 });
const ms = (v: string | null | undefined): number | null => {
  const t = v ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? null : t;
};
const iso = (v: string | null | undefined) => (ms(v) === null ? '' : new Date(ms(v)!).toISOString());
/** A key's first part, from a name: its letters and digits, upper case, starting with a letter. */
export function keyPart(name: string, fallback: string): string {
  const k = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const start = k.search(/[A-Z]/);
  const out = start < 0 ? '' : k.slice(start, start + 10);
  return out || fallback;
}

/** The next page's address, from a Link header. */
export function nextLink(header: string | string[] | undefined): string | null {
  const v = Array.isArray(header) ? header.join(',') : (header ?? '');
  for (const part of v.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part.trim());
    if (m) return m[1]!;
  }
  return null;
}

type Put = (name: string, value: string | null | undefined) => void;
function cellsOf(): { cells: [string, string][]; put: Put } {
  const cells: [string, string][] = [];
  return {
    cells,
    put: (name, value) => {
      if (value !== null && value !== undefined && String(value).trim() !== '') cells.push([name, String(value)]);
    },
  };
}

// ---------------------------------------------------------------------------
// GitHub Issues
// ---------------------------------------------------------------------------

interface GhUser {
  login?: string | null;
  name?: string | null;
  email?: string | null;
}

interface GhIssue {
  id: number;
  number: number;
  title?: string | null;
  body?: string | null;
  state?: string | null;
  state_reason?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  closed_at?: string | null;
  user?: GhUser | null;
  assignees?: GhUser[] | null;
  labels?: (string | { name?: string | null })[] | null;
  milestone?: { title?: string | null } | null;
  comments?: number | null;
  pull_request?: unknown;
}

interface GhComment {
  id: number;
  body?: string | null;
  created_at?: string | null;
  user?: GhUser | null;
}

/** What GitHub's search takes and the list's own parameters, from the query after the repository. */
export function githubQuery(query: string): { repo: string; state: string; labels: string | null; since: string | null } {
  const words = query.trim().split(/\s+/);
  const repo = (words.shift() ?? '').replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new RemoteError(`"${repo}" isn't a repository`, 'Give it as owner/name, e.g. acme/backend; then state:open or label:bug if you like.', 'refused').said('imports.source.notARepository', { repo });
  }
  let state = 'all';
  const labels: string[] = [];
  let since: string | null = null;
  for (const w of words) {
    const [k, ...rest] = w.split(':');
    const v = rest.join(':');
    if (k === 'state' && ['open', 'closed', 'all'].includes(v)) state = v;
    else if (k === 'label' && v) labels.push(v);
    else if (k === 'since' && /^\d{4}-\d{2}-\d{2}/.test(v)) since = v;
    else throw new RemoteError(`a4a doesn't read "${w}" for GitHub`, 'After the repository: state:open, state:closed, label:<name> or since:2026-01-01.', 'refused').said('imports.source.githubUnknownWord', { word: w });
  }
  return { repo, state, labels: labels.length ? labels.join(',') : null, since };
}

export class GithubReader implements Reader {
  readonly keyColumn = 'Issue Id';
  private readonly pageSize: number;
  private readonly q: ReturnType<typeof githubQuery>;
  private readonly key: string;

  constructor(
    readonly remote: Remote,
    query: string,
    private readonly bring: ImportBring,
    /** People a4a knows by their GitHub login (D33, D46), with the email to match them by. */
    private readonly known: ReadonlyMap<string, RemotePerson> = new Map(),
    pageSize = 50,
  ) {
    this.q = githubQuery(query);
    this.key = keyPart(this.q.repo.split('/')[1]!, 'GH');
    this.pageSize = pageSize;
  }

  private person(u: GhUser | null | undefined): RemotePerson | null {
    if (!u?.login) return null;
    return this.known.get(u.login.toLowerCase()) ?? { name: u.name || u.login, login: u.login, email: u.email || null };
  }

  async probe(): Promise<string | null> {
    const me = await this.remote.json<GhUser>('/user');
    return me.name || me.login || null;
  }

  async count(): Promise<number | null> {
    const parts = [`repo:${this.q.repo}`, 'is:issue'];
    if (this.q.state !== 'all') parts.push(`state:${this.q.state}`);
    for (const l of this.q.labels?.split(',') ?? []) parts.push(`label:"${l}"`);
    if (this.q.since) parts.push(`updated:>=${this.q.since}`);
    try {
      const got = await this.remote.json<{ total_count?: number }>('/search/issues', { query: { q: parts.join(' '), per_page: 1 } });
      return typeof got.total_count === 'number' ? got.total_count : null;
    } catch (e) {
      // A repository the token can't see is refused when the issues are read; a search that fails says nothing more.
      if (e instanceof RemoteError && (e.status === 422 || e.status === 403)) return null;
      throw e;
    }
  }

  resumeFrom(cursor: RemoteCursor | null): RemoteCursor | null {
    // A Link's page can't be stepped back from: carry on from it, as the rows read before it are known by key.
    return cursor;
  }

  async page(cursor: RemoteCursor | null): Promise<RemotePage> {
    const first = `/repos/${this.q.repo}/issues`;
    const { data, headers } =
      cursor && 'token' in cursor
        ? await this.remote.jsonWithHeaders<GhIssue[]>(cursor.token)
        : await this.remote.jsonWithHeaders<GhIssue[]>(first, { state: this.q.state, labels: this.q.labels, since: this.q.since, sort: 'created', direction: 'asc', per_page: this.pageSize });
    if (!Array.isArray(data)) throw new RemoteError("GitHub's answer wasn't a list of issues", 'Check the address: https://api.github.com, or your GitHub Enterprise API.', 'shape').said('imports.source.githubNotAList');
    const out: RemoteIssue[] = [];
    for (const i of data) {
      if (i.pull_request) continue;
      out.push(await this.issue(i));
    }
    const next = nextLink(headers.link);
    return { issues: out, next: next ? { token: next } : null };
  }

  private async comments(n: number): Promise<GhComment[]> {
    const all: GhComment[] = [];
    let at: string | null = `/repos/${this.q.repo}/issues/${n}/comments`;
    let query: Record<string, number> = { per_page: 100 };
    while (at && all.length < 5000) {
      const page: { data: GhComment[]; headers: Record<string, string | string[] | undefined> } = await this.remote.jsonWithHeaders<GhComment[]>(at, query);
      all.push(...(Array.isArray(page.data) ? page.data : []));
      at = nextLink(page.headers.link);
      query = {};
    }
    return all;
  }

  private async issue(i: GhIssue): Promise<RemoteIssue> {
    const { cells, put } = cellsOf();
    put('Issue Id', `${this.key}-${i.number}`);
    put('Summary', i.title);
    put('Description', i.body);
    put('Reporter', personCell(this.person(i.user)));
    put('Created', iso(i.created_at));
    put('Updated', iso(i.updated_at));
    // Closed as completed is fixed; as not planned, won't fix; GitHub's duplicate, a duplicate.
    const closed = i.state === 'closed';
    put('Resolved', closed ? iso(i.closed_at) : '');
    put('State', !closed ? 'Open' : i.state_reason === 'not_planned' ? "Won't fix" : i.state_reason === 'duplicate' ? 'Duplicate' : 'Fixed');
    put('Assignee', personCell(this.person(i.assignees?.[0])));
    put('Tags', (i.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean).join(', '));
    put('Fix versions', i.milestone?.title);
    const extra = empty();
    if (this.bring.comments && (i.comments ?? 0) > 0) {
      for (const c of await this.comments(i.number)) {
        if (!c.body?.trim()) continue;
        extra.comments.push({ id: String(c.id), at: ms(c.created_at) ?? ms(i.updated_at) ?? Date.now(), by: this.person(c.user), text: c.body });
      }
    }
    return { key: `${this.key}-${i.number}`, cells, extra, restricted: false };
  }
}

// ---------------------------------------------------------------------------
// Redmine
// ---------------------------------------------------------------------------

interface RmRef {
  id: number;
  name?: string | null;
}

interface RmIssue {
  id: number;
  project?: RmRef | null;
  tracker?: RmRef | null;
  status?: RmRef | null;
  priority?: RmRef | null;
  author?: RmRef | null;
  assigned_to?: RmRef | null;
  category?: RmRef | null;
  fixed_version?: RmRef | null;
  parent?: { id: number } | null;
  subject?: string | null;
  description?: string | null;
  start_date?: string | null;
  due_date?: string | null;
  estimated_hours?: number | null;
  is_private?: boolean | null;
  custom_fields?: { id: number; name: string; value?: unknown; multiple?: boolean }[] | null;
  created_on?: string | null;
  updated_on?: string | null;
  closed_on?: string | null;
  journals?: { id: number; user?: RmRef | null; notes?: string | null; created_on?: string | null; private_notes?: boolean | null }[] | null;
  attachments?: { id: number; filename?: string | null; filesize?: number | null; content_type?: string | null; content_url?: string | null; author?: RmRef | null; created_on?: string | null }[] | null;
  relations?: { issue_id: number; issue_to_id: number; relation_type: string }[] | null;
}

/** Redmine's relations, as the a4a phrase each direction becomes. */
const RM_RELATIONS: Record<string, { from: string; to: string }> = {
  relates: { from: 'relates to', to: 'relates to' },
  duplicates: { from: 'duplicates', to: 'is duplicated by' },
  duplicated: { from: 'is duplicated by', to: 'duplicates' },
  blocks: { from: 'is required for', to: 'depends on' },
  blocked: { from: 'depends on', to: 'is required for' },
  precedes: { from: 'is required for', to: 'depends on' },
  follows: { from: 'depends on', to: 'is required for' },
  copied_to: { from: 'relates to', to: 'relates to' },
  copied_from: { from: 'relates to', to: 'relates to' },
};

const rmPerson = (r: RmRef | null | undefined): RemotePerson | null => (r?.name ? { name: r.name, login: null, email: null } : null);

export class RedmineReader implements Reader {
  readonly keyColumn = 'Issue Id';
  private readonly key: string;
  private readonly project: string;

  constructor(
    readonly remote: Remote,
    query: string,
    private readonly bring: ImportBring,
    private readonly pageSize = 50,
  ) {
    this.project = query.trim().split(/\s+/)[0] ?? '';
    if (!/^[a-z0-9_-]{1,100}$/i.test(this.project)) {
      throw new RemoteError(`"${this.project}" isn't a Redmine project's identifier`, "Give its identifier, as in its address: /projects/backend is backend.", 'refused').said('imports.source.notARedmineProject', { project: this.project });
    }
    this.key = keyPart(this.project, 'RM');
  }

  async probe(): Promise<string | null> {
    const me = await this.remote.json<{ user?: { login?: string; firstname?: string; lastname?: string } }>('/users/current.json');
    const name = [me.user?.firstname, me.user?.lastname].filter(Boolean).join(' ');
    return name || me.user?.login || null;
  }

  async count(): Promise<number | null> {
    const got = await this.remote.json<{ total_count?: number }>('/issues.json', { query: { project_id: this.project, status_id: '*', limit: 1 } });
    return typeof got.total_count === 'number' ? got.total_count : null;
  }

  resumeFrom(cursor: RemoteCursor | null): RemoteCursor | null {
    if (!cursor || !('startAt' in cursor)) return null;
    return { startAt: Math.max(0, cursor.startAt - this.pageSize) };
  }

  async page(cursor: RemoteCursor | null): Promise<RemotePage> {
    const offset = cursor && 'startAt' in cursor ? cursor.startAt : 0;
    const got = await this.remote.json<{ issues?: RmIssue[]; total_count?: number }>('/issues.json', {
      query: { project_id: this.project, status_id: '*', sort: 'id', offset, limit: this.pageSize },
    });
    if (!Array.isArray(got.issues)) throw new RemoteError("Redmine's answer wasn't a list of issues", "Check the address: your Redmine's own.", 'shape').said('imports.source.redmineNotAList');
    const out: RemoteIssue[] = [];
    for (const brief of got.issues) {
      const full = await this.remote.json<{ issue?: RmIssue }>(`/issues/${brief.id}.json`, { query: { include: 'journals,attachments,relations' } });
      out.push(await this.issue(full.issue ?? brief));
    }
    const read = offset + got.issues.length;
    return { issues: out, next: got.issues.length < this.pageSize || (typeof got.total_count === 'number' && read >= got.total_count) ? null : { startAt: read } };
  }

  private async issue(i: RmIssue): Promise<RemoteIssue> {
    const { cells, put } = cellsOf();
    const key = (id: number) => `${this.key}-${id}`;
    put('Issue Id', key(i.id));
    put('Summary', i.subject);
    put('Description', i.description);
    put('Reporter', personCell(rmPerson(i.author)));
    put('Created', iso(i.created_on));
    put('Updated', iso(i.updated_on));
    put('Resolved', iso(i.closed_on));
    put('Type', i.tracker?.name);
    put('State', i.status?.name);
    put('Priority', i.priority?.name);
    put('Assignee', personCell(rmPerson(i.assigned_to)));
    put('Subsystem', i.category?.name);
    put('Fix versions', i.fixed_version?.name);
    put('Start date', i.start_date);
    put('Due date', i.due_date);
    if (typeof i.estimated_hours === 'number' && i.estimated_hours > 0) put('Estimation', `${Math.round(i.estimated_hours * 60)}m`);
    if (i.parent?.id) put('Parent', key(i.parent.id));
    for (const f of i.custom_fields ?? []) {
      const v = Array.isArray(f.value) ? f.value.filter((x) => x !== null && x !== '').join(', ') : f.value === null || f.value === undefined ? '' : String(f.value);
      put(['summary', 'description', 'state', 'type', 'priority', 'assignee', 'issue id'].includes(f.name.toLowerCase()) ? `${f.name} (field)` : f.name, v);
    }
    const links = new Map<string, string[]>();
    for (const r of i.relations ?? []) {
      const phrases = RM_RELATIONS[r.relation_type] ?? RM_RELATIONS.relates!;
      const outward = r.issue_id === i.id;
      const phrase = outward ? phrases.from : phrases.to;
      const other = outward ? r.issue_to_id : r.issue_id;
      links.set(phrase, [...(links.get(phrase) ?? []), key(other)]);
    }
    for (const [phrase, keys] of links) put(phrase, [...new Set(keys)].join(', '));

    const extra = empty();
    if (this.bring.comments) {
      for (const j of i.journals ?? []) {
        if (!j.notes?.trim()) continue;
        if (j.private_notes) {
          extra.leftComments++;
          continue;
        }
        extra.comments.push({ id: String(j.id), at: ms(j.created_on) ?? ms(i.updated_on) ?? Date.now(), by: rmPerson(j.user), text: j.notes });
      }
    }
    if (this.bring.files) {
      for (const a of i.attachments ?? []) {
        if (!a.content_url) continue;
        extra.files.push({ id: String(a.id), name: a.filename || 'file', size: a.filesize ?? 0, type: a.content_type ?? null, href: a.content_url, at: ms(a.created_on) ?? Date.now(), by: rmPerson(a.author), comment: null });
      }
    }
    if (this.bring.work) {
      const entries = await this.remote.json<{ time_entries?: { id: number; hours?: number; spent_on?: string; comments?: string | null; user?: RmRef | null }[] }>('/time_entries.json', {
        query: { issue_id: i.id, limit: 100 },
      });
      for (const t of entries.time_entries ?? []) {
        const minutes = Math.round((t.hours ?? 0) * 60);
        if (!(minutes > 0) || !t.spent_on) continue;
        extra.work.push({ id: String(t.id), date: t.spent_on, minutes, by: rmPerson(t.user), text: t.comments ?? '' });
      }
    }
    return { key: key(i.id), cells, extra, restricted: Boolean(i.is_private) };
  }
}

// ---------------------------------------------------------------------------
// Zendesk, into a help desk
// ---------------------------------------------------------------------------

interface ZdUser {
  id: number;
  name?: string | null;
  email?: string | null;
}

interface ZdTicket {
  id: number;
  subject?: string | null;
  description?: string | null;
  status?: string | null;
  priority?: string | null;
  type?: string | null;
  tags?: string[] | null;
  requester_id?: number | null;
  assignee_id?: number | null;
  group_id?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  via?: { channel?: string | null } | null;
}

interface ZdComment {
  id: number;
  author_id?: number | null;
  body?: string | null;
  plain_body?: string | null;
  public?: boolean | null;
  created_at?: string | null;
  attachments?: { id: number; file_name?: string | null; content_url?: string | null; content_type?: string | null; size?: number | null }[] | null;
}

/** Zendesk's statuses, in words the mapping knows. */
const ZD_STATUS: Record<string, string> = { new: 'New', open: 'Open', pending: 'Waiting for customer', hold: 'On hold', solved: 'Resolved', closed: 'Closed' };
const cap = (v: string | null | undefined) => (v ? v.charAt(0).toUpperCase() + v.slice(1) : null);

/** The moment to read from: "all", or "since 2026-01-01". */
export function zendeskStart(query: string): number {
  const q = query.trim().toLowerCase();
  if (q === 'all' || q === '*') return 0;
  const m = /^since\s+(\d{4}-\d{2}-\d{2})$/.exec(q);
  if (!m) throw new RemoteError(`a4a doesn't read "${query}" for Zendesk`, 'Write all, or since 2026-01-01 for the tickets changed since then.', 'refused').said('imports.source.zendeskUnknownQuery', { query });
  return Math.floor(Date.parse(`${m[1]}T00:00:00Z`) / 1000);
}

export class ZendeskReader implements Reader {
  readonly keyColumn = 'Issue Id';
  private readonly start: number;
  private readonly users = new Map<number, RemotePerson>();
  private readonly groups = new Map<number, string>();

  constructor(
    readonly remote: Remote,
    query: string,
    private readonly bring: ImportBring,
    private readonly pageSize = 100,
  ) {
    this.start = zendeskStart(query);
  }

  private person(id: number | null | undefined): RemotePerson | null {
    return id ? (this.users.get(id) ?? null) : null;
  }

  private learn(users: ZdUser[] | undefined, groups?: { id: number; name?: string | null }[]): void {
    for (const u of users ?? []) this.users.set(u.id, { name: u.name || null, login: null, email: u.email || null });
    for (const g of groups ?? []) if (g.name) this.groups.set(g.id, g.name);
  }

  async probe(): Promise<string | null> {
    const me = await this.remote.json<{ user?: { name?: string; email?: string; role?: string } }>('/api/v2/users/me.json');
    if (!me.user || me.user.role === 'end-user') {
      throw new RemoteError("Zendesk didn't take the token as an agent's", "Give an agent's email with an API token (Admin Center, Apps and integrations, Zendesk API), or an OAuth token.", 'auth', 401).said('imports.source.zendeskNotAnAgent');
    }
    return me.user.name || me.user.email || null;
  }

  async count(): Promise<number | null> {
    if (this.start > 0) return null;
    try {
      const got = await this.remote.json<{ count?: { value?: number } }>('/api/v2/tickets/count.json');
      return typeof got.count?.value === 'number' ? got.count.value : null;
    } catch (e) {
      if (e instanceof RemoteError && e.status === 404) return null;
      throw e;
    }
  }

  resumeFrom(cursor: RemoteCursor | null): RemoteCursor | null {
    // The export's cursor names where it got to; tickets read twice are known by key.
    return cursor;
  }

  async page(cursor: RemoteCursor | null): Promise<RemotePage> {
    const query: Record<string, string | number> =
      cursor && 'token' in cursor ? { cursor: cursor.token, include: 'users,groups', per_page: this.pageSize } : { start_time: this.start, include: 'users,groups', per_page: this.pageSize };
    const got = await this.remote.json<{ tickets?: ZdTicket[]; users?: ZdUser[]; groups?: { id: number; name?: string }[]; after_cursor?: string | null; end_of_stream?: boolean }>(
      '/api/v2/incremental/tickets/cursor.json',
      { query },
    );
    if (!Array.isArray(got.tickets)) throw new RemoteError("Zendesk's answer wasn't a list of tickets", 'Check the address: https://<your subdomain>.zendesk.com.', 'shape').said('imports.source.zendeskNotAList');
    this.learn(got.users, got.groups);
    const out: RemoteIssue[] = [];
    for (const t of got.tickets) {
      if (t.status === 'deleted') continue;
      out.push(await this.ticket(t));
    }
    return { issues: out, next: got.end_of_stream || !got.after_cursor ? null : { token: got.after_cursor } };
  }

  private async comments(id: number): Promise<ZdComment[]> {
    const all: ZdComment[] = [];
    let query: Record<string, string | number> = { include: 'users', 'page[size]': 100 };
    for (let pages = 0; pages < 50; pages++) {
      const got = await this.remote.json<{ comments?: ZdComment[]; users?: ZdUser[]; meta?: { has_more?: boolean; after_cursor?: string | null } }>(`/api/v2/tickets/${id}/comments.json`, { query });
      this.learn(got.users);
      all.push(...(got.comments ?? []));
      if (!got.meta?.has_more || !got.meta.after_cursor) break;
      query = { include: 'users', 'page[size]': 100, 'page[after]': got.meta.after_cursor };
    }
    return all;
  }

  private async ticket(t: ZdTicket): Promise<RemoteIssue> {
    const { cells, put } = cellsOf();
    const key = `ZD-${t.id}`;
    put('Issue Id', key);
    put('Summary', t.subject || `Ticket ${t.id}`);
    put('Description', t.description);
    put('Created', iso(t.created_at));
    put('Updated', iso(t.updated_at));
    // Solved and closed tickets were resolved when last changed: the export says no more.
    put('Resolved', t.status === 'solved' || t.status === 'closed' ? iso(t.updated_at) : '');
    put('State', t.status ? (ZD_STATUS[t.status] ?? t.status) : null);
    put('Priority', cap(t.priority));
    put('Type', cap(t.type));
    put('Assignee', personCell(this.person(t.assignee_id)));
    put('Tags', (t.tags ?? []).join(', '));
    put('Group', t.group_id ? this.groups.get(t.group_id) : null);
    put('Channel', t.via?.channel);
    const extra: RowExtra = { ...empty(), requester: this.person(t.requester_id) };
    if (this.bring.comments || this.bring.files) {
      const all = await this.comments(t.id);
      // The first comment is the ticket's description.
      for (const c of all.slice(1)) {
        const text = (c.plain_body ?? c.body ?? '').trim();
        const byRequester = Boolean(t.requester_id) && c.author_id === t.requester_id;
        if (this.bring.comments && text) {
          extra.comments.push({ id: String(c.id), at: ms(c.created_at) ?? Date.now(), by: this.person(c.author_id), text, visibility: c.public === false ? 'internal' : 'public', byRequester });
        }
      }
      if (this.bring.files) {
        for (const c of all) {
          for (const a of c.attachments ?? []) {
            if (!a.content_url) continue;
            extra.files.push({ id: String(a.id), name: a.file_name || 'file', size: a.size ?? 0, type: a.content_type ?? null, href: a.content_url, at: ms(c.created_at) ?? Date.now(), by: this.person(c.author_id), comment: c === all[0] ? null : String(c.id) });
          }
        }
      }
    }
    return { key, cells, extra, restricted: false };
  }
}
