/**
 * YouTrack's and Jira's APIs, read into what an import's rows hold: each issue as named cells, the
 * columns its export would have (so the mapping a file gets finds them too), and what a file's
 * cells can't hold (comments, work items and files, each with its id there) beside them.
 *
 * The shapes, as their documentation gives them and as these readers expect them:
 *
 * - YouTrack: GET /api/issues?query&fields&$top&$skip, with comments, links, tags, custom fields,
 *   attachments and timeTracking(workItems) as nested fields; POST /api/issuesGetter/count for how
 *   many; GET /api/users/me for whom the token is. A permanent token, as a bearer token.
 * - Jira Cloud: GET /rest/api/3/search/jql with nextPageToken (descriptions and comments in
 *   Atlassian Document Format), POST /rest/api/3/search/approximate-count, /rest/api/3/field for
 *   custom fields' names, /issue/{key}/comment and /worklog past what a search embeds. An email and
 *   an API token, as basic authentication.
 * - Jira Data Center: GET /rest/api/2/search with startAt and total (wiki markup), the same paths
 *   under /rest/api/2. A personal access token, as a bearer token.
 */
import type { ApiImportSource, ImportBring, ImportCredentials } from '@a4a/shared';
import { adfToMarkdown, wikiToMarkdown } from './markup';
import { GithubReader, RedmineReader, ZendeskReader } from './readers-more';
import { checkAddress, Remote, RemoteError, type RemotePolicy } from './remote';

export interface RemotePerson {
  name: string | null;
  login: string | null;
  email: string | null;
}

/** What an issue brings beside its cells, each item with its id there. */
export interface RowExtra {
  /**
   * Who sees each comment, where the tracker says (Zendesk's public replies and internal notes,
   * D46), and whether the request's requester wrote it: kept so on a help desk's request.
   */
  comments: { id: string; at: number; by: RemotePerson | null; text: string; visibility?: 'public' | 'internal'; byRequester?: boolean }[];
  work: { id: string; date: string; minutes: number; by: RemotePerson | null; text: string }[];
  files: { id: string; name: string; size: number; type: string | null; href: string; at: number; by: RemotePerson | null; comment: string | null }[];
  /** Comments only some people may see there: left out. */
  leftComments: number;
  /** Who asked, for a help desk's request (Zendesk's requester, D46). */
  requester?: RemotePerson | null;
}

export interface RemoteIssue {
  key: string;
  cells: [string, string][];
  extra: RowExtra;
  /** Only some people may see it there: left out of the import. */
  restricted: boolean;
}

export type RemoteCursor = { skip: number } | { token: string } | { startAt: number };

export interface RemotePage {
  issues: RemoteIssue[];
  next: RemoteCursor | null;
}

export interface Reader {
  readonly remote: Remote;
  /** The column that holds each issue's key, as named in the cells. */
  readonly keyColumn: string;
  /** Whom the token signs in as, there; refuses a token it doesn't accept. */
  probe(): Promise<string | null>;
  /** How many issues the query matches, when it says; refuses a query it can't read. */
  count(): Promise<number | null>;
  page(cursor: RemoteCursor | null): Promise<RemotePage>;
  /** Where to carry on from after a stop: a page back, since what was read past it may not have been kept. */
  resumeFrom(cursor: RemoteCursor | null): RemoteCursor | null;
}

export interface OriginRef {
  kind: ApiImportSource;
  url: string;
  query: string;
  bring: ImportBring;
}

/** Where an import from an API reads, as kept on the import: never the credentials. */
export interface StoredOrigin extends OriginRef {
  deployment: 'cloud' | 'datacenter' | null;
  account: string | null;
  fetch: {
    complete: boolean;
    /** Where the next page starts. */
    cursor: RemoteCursor | null;
    issues: number;
    comments: number;
    work: number;
    files: number;
    fileBytes: number;
    total: number | null;
    left: { issues: number; comments: number; keys: string[] };
  };
}

/** Issues asked for a page at a time. Tests make it small, to read several pages of a few issues. */
export const paging = { pageSize: 50 };

const empty = (): RowExtra => ({ comments: [], work: [], files: [], leftComments: 0 });
const iso = (ms: unknown) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : '');
const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A person as a cell: a name with the email in angle brackets (how the mapping finds people by email), or the name or login alone. */
export function personCell(p: RemotePerson | null): string {
  if (!p) return '';
  const name = p.name || p.login || '';
  return p.email ? `${name} <${p.email}>`.trim() : name;
}

// ---------------------------------------------------------------------------
// YouTrack
// ---------------------------------------------------------------------------

interface YtUser {
  login?: string | null;
  fullName?: string | null;
  email?: string | null;
}

interface YtCustomField {
  name: string;
  $type?: string;
  value?: unknown;
}

interface YtIssue {
  id?: string;
  idReadable: string;
  summary?: string | null;
  description?: string | null;
  created?: number | null;
  updated?: number | null;
  resolved?: number | null;
  reporter?: YtUser | null;
  tags?: { name?: string }[] | null;
  visibility?: { $type?: string } | null;
  customFields?: YtCustomField[] | null;
  links?: { direction?: string; linkType?: { name?: string; sourceToTarget?: string; targetToSource?: string } | null; issues?: { idReadable?: string }[] | null }[] | null;
  comments?: { id: string; text?: string | null; created?: number | null; deleted?: boolean; visibility?: { $type?: string } | null; author?: YtUser | null }[] | null;
  attachments?:
    | {
        id: string;
        name?: string | null;
        size?: number | null;
        mimeType?: string | null;
        url?: string | null;
        created?: number | null;
        removed?: boolean;
        visibility?: { $type?: string } | null;
        comment?: { id?: string } | null;
        author?: YtUser | null;
      }[]
    | null;
  timeTracking?: { workItems?: { id: string; date?: number | null; duration?: { minutes?: number | null } | null; text?: string | null; author?: YtUser | null }[] | null } | null;
}

const ytPerson = (u: YtUser | null | undefined): RemotePerson | null => (u ? { name: u.fullName || null, login: u.login || null, email: u.email || null } : null);
const limited = (v: { $type?: string } | null | undefined) => v?.$type === 'LimitedVisibility';

/** A value of a YouTrack custom field, as a cell. */
function ytValue(type: string, v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) {
    return v
      .map((x) => ytValue(type, x))
      .filter(Boolean)
      .join(', ');
  }
  if (typeof v === 'number') {
    if (/Date/.test(type)) {
      // A date alone is kept at midnight or noon UTC; anything else is a moment.
      const t = new Date(v);
      return t.getUTCMinutes() === 0 && t.getUTCSeconds() === 0 && (t.getUTCHours() === 0 || t.getUTCHours() === 12) ? utcDate(v) : t.toISOString();
    }
    return String(v);
  }
  if (typeof v === 'string' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.minutes === 'number') return String(o.minutes);
    if (typeof o.login === 'string' || typeof o.fullName === 'string') return personCell(ytPerson(o as YtUser));
    if (typeof o.text === 'string') return o.text;
    if (typeof o.name === 'string') return o.name;
    if (typeof o.presentation === 'string') return o.presentation;
  }
  return '';
}

const YT_USER = 'login,fullName,email';
const STANDARD = new Set(['issue id', 'summary', 'description', 'reporter', 'created', 'updated', 'resolved', 'tags', 'issue key', 'parent']);

export class YouTrackReader implements Reader {
  readonly keyColumn = 'Issue Id';
  private readonly pageSize = paging.pageSize;
  private readonly sorted: string;
  private readonly fields: string;

  constructor(
    readonly remote: Remote,
    query: string,
    private readonly bring: ImportBring,
  ) {
    this.sorted = /\bsort\s+by\s*:/i.test(query) ? query : `${query} sort by: created asc`;
    this.fields = [
      'id',
      'idReadable',
      'summary',
      'description',
      'created',
      'updated',
      'resolved',
      `reporter(${YT_USER})`,
      'tags(name)',
      'visibility($type)',
      `customFields(name,$type,value(name,login,fullName,email,minutes,presentation,text))`,
      'links(direction,linkType(name,sourceToTarget,targetToSource),issues(idReadable))',
      ...(bring.comments ? [`comments(id,text,created,deleted,visibility($type),author(${YT_USER}))`] : []),
      ...(bring.files ? [`attachments(id,name,size,mimeType,url,created,removed,visibility($type),comment(id),author(${YT_USER}))`] : []),
      ...(bring.work ? [`timeTracking(workItems(id,date,duration(minutes),text,author(${YT_USER})))`] : []),
    ].join(',');
  }

  async probe(): Promise<string | null> {
    const me = await this.remote.json<YtUser>('/api/users/me', { query: { fields: YT_USER } });
    return me.fullName || me.login || null;
  }

  async count(): Promise<number | null> {
    for (let i = 0; i < 4; i++) {
      let got: { count?: number };
      try {
        got = await this.remote.json<{ count?: number }>('/api/issuesGetter/count', { method: 'POST', query: { fields: 'count' }, body: { query: this.sorted } });
      } catch (e) {
        // An older YouTrack without the count: it reads the issues all the same.
        if (e instanceof RemoteError && e.status === 404) return null;
        throw e;
      }
      if (typeof got.count === 'number' && got.count >= 0) return got.count;
      await this.remote.wait(500); // -1: still counting
    }
    return null;
  }

  resumeFrom(cursor: RemoteCursor | null): RemoteCursor | null {
    if (!cursor || !('skip' in cursor)) return null;
    return { skip: Math.max(0, cursor.skip - this.pageSize) };
  }

  async page(cursor: RemoteCursor | null): Promise<RemotePage> {
    const skip = cursor && 'skip' in cursor ? cursor.skip : 0;
    const got = await this.remote.json<YtIssue[]>('/api/issues', { query: { query: this.sorted, fields: this.fields, $top: this.pageSize, $skip: skip } });
    if (!Array.isArray(got)) throw new RemoteError("YouTrack's answer wasn't a list of issues", 'Check the address: your YouTrack\'s base address.', 'shape').said('imports.source.youtrackNotAList');
    return { issues: got.map((i) => this.issue(i)), next: got.length < this.pageSize ? null : { skip: skip + got.length } };
  }

  private issue(i: YtIssue): RemoteIssue {
    const cells: [string, string][] = [];
    const put = (name: string, value: string | null | undefined) => {
      if (value !== null && value !== undefined && value.trim() !== '') cells.push([name, value]);
    };
    put('Issue Id', i.idReadable);
    put('Summary', i.summary);
    put('Description', i.description);
    put('Reporter', personCell(ytPerson(i.reporter)));
    put('Created', iso(i.created));
    put('Updated', iso(i.updated));
    put('Resolved', iso(i.resolved));
    put('Tags', (i.tags ?? []).map((t) => t.name ?? '').filter(Boolean).join(', '));
    for (const f of i.customFields ?? []) {
      // With work items brought one by one, their total would count them twice.
      if (this.bring.work && /Period/.test(f.$type ?? '') && /spent/i.test(f.name)) continue;
      put(STANDARD.has(f.name.toLowerCase()) ? `${f.name} (field)` : f.name, ytValue(f.$type ?? '', f.value));
    }
    const links = new Map<string, string[]>();
    for (const l of i.links ?? []) {
      const keys = (l.issues ?? []).map((x) => x.idReadable ?? '').filter(Boolean);
      if (!keys.length || !l.linkType) continue;
      const phrase = (l.direction === 'INWARD' ? l.linkType.targetToSource : l.linkType.sourceToTarget) || l.linkType.sourceToTarget || l.linkType.name;
      if (!phrase) continue;
      const name = phrase.toLowerCase();
      links.set(name, [...(links.get(name) ?? []), ...keys]);
    }
    for (const [name, keys] of links) put(name, [...new Set(keys)].join(', '));

    const extra = empty();
    for (const c of i.comments ?? []) {
      if (c.deleted) continue;
      if (limited(c.visibility)) {
        extra.leftComments++;
        continue;
      }
      if (!c.text?.trim()) continue;
      extra.comments.push({ id: c.id, at: c.created ?? i.updated ?? Date.now(), by: ytPerson(c.author), text: c.text });
    }
    for (const w of i.timeTracking?.workItems ?? []) {
      const minutes = w.duration?.minutes ?? 0;
      if (!(minutes > 0) || typeof w.date !== 'number') continue;
      extra.work.push({ id: w.id, date: utcDate(w.date), minutes, by: ytPerson(w.author), text: w.text ?? '' });
    }
    for (const a of i.attachments ?? []) {
      if (a.removed || limited(a.visibility) || !a.url) continue;
      extra.files.push({
        id: a.id,
        name: a.name || 'file',
        size: a.size ?? 0,
        type: a.mimeType ?? null,
        href: a.url,
        at: a.created ?? i.created ?? Date.now(),
        by: ytPerson(a.author),
        comment: a.comment?.id ?? null,
      });
    }
    return { key: i.idReadable, cells, extra, restricted: limited(i.visibility) };
  }
}

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

interface JiraUser {
  displayName?: string | null;
  emailAddress?: string | null;
  name?: string | null;
  accountId?: string | null;
}

interface JiraComment {
  id: string;
  body?: unknown;
  created?: string | null;
  author?: JiraUser | null;
  visibility?: unknown;
}

interface JiraWorklog {
  id: string;
  started?: string | null;
  timeSpentSeconds?: number | null;
  comment?: unknown;
  author?: JiraUser | null;
}

interface JiraIssue {
  id: string;
  key: string;
  fields: Record<string, unknown> & {
    summary?: string | null;
    description?: unknown;
    issuetype?: { name?: string } | null;
    status?: { name?: string } | null;
    priority?: { name?: string } | null;
    resolution?: { name?: string } | null;
    assignee?: JiraUser | null;
    reporter?: JiraUser | null;
    created?: string | null;
    updated?: string | null;
    resolutiondate?: string | null;
    labels?: string[] | null;
    components?: { name?: string }[] | null;
    fixVersions?: { name?: string }[] | null;
    versions?: { name?: string }[] | null;
    duedate?: string | null;
    timeoriginalestimate?: number | null;
    timespent?: number | null;
    environment?: unknown;
    parent?: { key?: string } | null;
    security?: unknown;
    issuelinks?: { type?: { name?: string } | null; inwardIssue?: { key?: string } | null; outwardIssue?: { key?: string } | null }[] | null;
    comment?: { comments?: JiraComment[]; total?: number; maxResults?: number } | null;
    worklog?: { worklogs?: JiraWorklog[]; total?: number; maxResults?: number } | null;
    attachment?: { id: string; filename?: string; size?: number; mimeType?: string; content?: string; created?: string; author?: JiraUser | null }[] | null;
  };
}

const jiraPerson = (u: JiraUser | null | undefined): RemotePerson | null => (u ? { name: u.displayName || null, login: u.name || null, email: u.emailAddress || null } : null);
const names = (list: { name?: string }[] | null | undefined) => (list ?? []).map((x) => x.name ?? '').filter(Boolean).join(', ');
/** Custom fields whose values say nothing a person reads: ranking strings, development summaries, service desk timers. */
const NOISE = /lexo-rank|devsummary|servicedesk|jira-development-integration|timeinstatus|vp-origin|sd-customer|sd-request/i;
const SYSTEM_COLUMNS = new Set(['issue key', 'issue id', 'summary', 'description', 'issue type', 'status', 'priority', 'assignee', 'reporter', 'created', 'updated', 'resolved', 'labels', 'parent']);

/** A Jira value, as a cell: options by their value, people by name and email, versions and the like by name, rich text as Markdown. */
function jiraValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    return v
      .map((x) => jiraValue(x))
      .filter(Boolean)
      .join(', ');
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.type === 'doc') return adfToMarkdown(o);
    if (typeof o.displayName === 'string') return personCell(jiraPerson(o as JiraUser));
    if (typeof o.value === 'string') return o.child && typeof (o.child as { value?: unknown }).value === 'string' ? `${o.value} - ${(o.child as { value: string }).value}` : o.value;
    if (typeof o.name === 'string') return o.name;
    if (typeof o.key === 'string') return o.key;
  }
  return '';
}

/** The date a worklog was started, as written there (2024-03-12T09:00:00.000+0100: 2024-03-12). */
const startedDate = (s: string | null | undefined) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);

export class JiraReader implements Reader {
  readonly keyColumn = 'Issue key';
  private readonly pageSize = paging.pageSize;
  private readonly v: '2' | '3';
  private readonly ordered: string;
  private fieldNames: Map<string, { name: string; custom: string }> | null = null;

  constructor(
    readonly remote: Remote,
    jql: string,
    private readonly cloud: boolean,
    private readonly bring: ImportBring,
  ) {
    this.v = cloud ? '3' : '2';
    this.ordered = /\border\s+by\b/i.test(jql) ? jql : `${jql} ORDER BY created ASC`;
  }

  private text(v: unknown): string {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return this.cloud ? v : wikiToMarkdown(v);
    return adfToMarkdown(v);
  }

  async probe(): Promise<string | null> {
    const me = await this.remote.json<JiraUser>(`/rest/api/${this.v}/myself`);
    return me.displayName || me.emailAddress || me.name || null;
  }

  async count(): Promise<number | null> {
    if (this.cloud) {
      try {
        const got = await this.remote.json<{ count?: number }>('/rest/api/3/search/approximate-count', { method: 'POST', body: { jql: this.ordered.replace(/\s+order\s+by[\s\S]*$/i, '') } });
        return typeof got.count === 'number' ? got.count : null;
      } catch (e) {
        if (e instanceof RemoteError && e.status === 404) return null;
        throw e;
      }
    }
    const got = await this.remote.json<{ total?: number }>('/rest/api/2/search', { query: { jql: this.ordered, maxResults: 0, fields: 'key' } });
    return typeof got.total === 'number' ? got.total : null;
  }

  resumeFrom(cursor: RemoteCursor | null): RemoteCursor | null {
    if (!cursor) return null;
    if ('startAt' in cursor) return { startAt: Math.max(0, cursor.startAt - this.pageSize) };
    // A page token may be stale by now: read from the start, and skip the keys read already.
    return null;
  }

  private async customNames(): Promise<Map<string, { name: string; custom: string }>> {
    if (!this.fieldNames) {
      const list = await this.remote.json<{ id: string; name: string; schema?: { custom?: string } }[]>(`/rest/api/${this.v}/field`);
      this.fieldNames = new Map((Array.isArray(list) ? list : []).filter((f) => f.id?.startsWith('customfield_')).map((f) => [f.id, { name: f.name, custom: f.schema?.custom ?? '' }]));
    }
    return this.fieldNames;
  }

  async page(cursor: RemoteCursor | null): Promise<RemotePage> {
    const custom = await this.customNames();
    if (this.cloud) {
      const token = cursor && 'token' in cursor ? cursor.token : undefined;
      const got = await this.remote.json<{ issues?: JiraIssue[]; nextPageToken?: string | null; isLast?: boolean }>('/rest/api/3/search/jql', {
        query: { jql: this.ordered, maxResults: this.pageSize, fields: '*all', nextPageToken: token },
      });
      const list = got.issues ?? [];
      const issues: RemoteIssue[] = [];
      for (const i of list) issues.push(await this.issue(i, custom));
      return { issues, next: got.nextPageToken && got.isLast !== true ? { token: got.nextPageToken } : null };
    }
    const startAt = cursor && 'startAt' in cursor ? cursor.startAt : 0;
    const got = await this.remote.json<{ issues?: JiraIssue[]; total?: number }>('/rest/api/2/search', { query: { jql: this.ordered, startAt, maxResults: this.pageSize, fields: '*all' } });
    const list = got.issues ?? [];
    const issues: RemoteIssue[] = [];
    for (const i of list) issues.push(await this.issue(i, custom));
    const next = list.length > 0 && startAt + list.length < (got.total ?? 0) ? { startAt: startAt + list.length } : null;
    return { issues, next };
  }

  /** Every item of a paged list under an issue, past the ones a search embeds. */
  private async rest<T>(key: string, what: 'comment' | 'worklog', have: T[], total: number): Promise<T[]> {
    if (have.length >= total) return have;
    const out: T[] = [];
    for (let startAt = 0; startAt < total; ) {
      const got = await this.remote.json<{ comments?: T[]; worklogs?: T[]; total?: number }>(`/rest/api/${this.v}/issue/${encodeURIComponent(key)}/${what}`, { query: { startAt, maxResults: 100 } });
      const items = (what === 'comment' ? got.comments : got.worklogs) ?? [];
      if (!items.length) break;
      out.push(...items);
      startAt += items.length;
      total = got.total ?? total;
    }
    return out;
  }

  private async issue(i: JiraIssue, custom: Map<string, { name: string; custom: string }>): Promise<RemoteIssue> {
    const f = i.fields ?? {};
    const cells: [string, string][] = [];
    const put = (name: string, value: string | number | null | undefined) => {
      const s = value === null || value === undefined ? '' : String(value);
      if (s.trim() !== '') cells.push([name, s]);
    };
    put('Issue key', i.key);
    put('Issue id', i.id);
    put('Summary', f.summary);
    put('Description', this.text(f.description));
    put('Issue Type', f.issuetype?.name);
    put('Status', f.status?.name);
    put('Priority', f.priority?.name);
    put('Assignee', personCell(jiraPerson(f.assignee)));
    put('Reporter', personCell(jiraPerson(f.reporter)));
    put('Created', f.created);
    put('Updated', f.updated);
    put('Resolved', f.resolutiondate);
    put('Labels', (f.labels ?? []).join(', '));
    put('Component/s', names(f.components));
    put('Fix Version/s', names(f.fixVersions));
    put('Affects Version/s', names(f.versions));
    put('Due Date', f.duedate);
    put('Original Estimate', f.timeoriginalestimate);
    if (!this.bring.work) put('Time Spent', f.timespent);
    put('Parent', f.parent?.key);
    put('Resolution', f.resolution?.name);
    put('Environment', this.text(f.environment));
    const links = new Map<string, string[]>();
    for (const l of f.issuelinks ?? []) {
      const type = l.type?.name;
      if (!type) continue;
      const [column, key] = l.outwardIssue?.key ? [`Outward issue link (${type})`, l.outwardIssue.key] : l.inwardIssue?.key ? [`Inward issue link (${type})`, l.inwardIssue.key] : [null, null];
      if (column && key) links.set(column, [...(links.get(column) ?? []), key]);
    }
    for (const [column, keys] of links) put(column, [...new Set(keys)].join(', '));
    for (const [id, value] of Object.entries(f)) {
      if (!id.startsWith('customfield_')) continue;
      const meta = custom.get(id);
      if (!meta || NOISE.test(meta.custom)) continue;
      const name = SYSTEM_COLUMNS.has(meta.name.toLowerCase()) ? `${meta.name} (field)` : meta.name;
      put(name, jiraValue(value));
    }

    const extra = empty();
    if (this.bring.comments && f.comment) {
      const all = await this.rest<JiraComment>(i.key, 'comment', f.comment.comments ?? [], f.comment.total ?? 0);
      for (const c of all) {
        if (c.visibility) {
          extra.leftComments++;
          continue;
        }
        const text = this.text(c.body);
        if (!text.trim()) continue;
        const at = Date.parse(c.created ?? '');
        extra.comments.push({ id: c.id, at: Number.isNaN(at) ? Date.now() : at, by: jiraPerson(c.author), text });
      }
    }
    if (this.bring.work && f.worklog) {
      const all = await this.rest<JiraWorklog>(i.key, 'worklog', f.worklog.worklogs ?? [], f.worklog.total ?? 0);
      for (const w of all) {
        const minutes = Math.round((w.timeSpentSeconds ?? 0) / 60);
        const date = startedDate(w.started);
        if (!(minutes > 0) || !date) continue;
        extra.work.push({ id: w.id, date, minutes, by: jiraPerson(w.author), text: this.text(w.comment) });
      }
    }
    if (this.bring.files) {
      for (const a of f.attachment ?? []) {
        if (!a.content) continue;
        const at = Date.parse(a.created ?? '');
        extra.files.push({ id: a.id, name: a.filename || 'file', size: a.size ?? 0, type: a.mimeType ?? null, href: a.content, at: Number.isNaN(at) ? Date.now() : at, by: jiraPerson(a.author), comment: null });
      }
    }
    return { key: i.key, cells, extra, restricted: Boolean(f.security) };
  }
}

// ---------------------------------------------------------------------------
// Which reader, with which credentials
// ---------------------------------------------------------------------------

const YT_NAMES = {
  name: 'YouTrack',
  source: 'youtrack',
  example: 'https://example.youtrack.cloud',
  authHint: 'Make a permanent token in YouTrack (your profile, Account Security, Tokens), with YouTrack in its scope, and give it whole: it starts perm:.',
  badRequestHint: "Check the query: it is the one you would type in YouTrack's search, such as project: BACK.",
};
const JIRA_NAMES = {
  name: 'Jira',
  source: 'jira',
  example: 'https://example.atlassian.net',
  authHint:
    "Jira Cloud takes your Atlassian account's email with an API token (id.atlassian.com, Security, API tokens). Jira Data Center takes a personal access token alone (your profile, Personal Access Tokens).",
  badRequestHint: 'Check the JQL: the one you would type in Jira\'s advanced search, such as project = BACK.',
};

const GITHUB_NAMES = {
  name: 'GitHub',
  source: 'github',
  example: 'https://api.github.com',
  authHint: 'Give a token that may read the repository’s issues: a fine-grained token with Issues read, or a classic one with repo.',
  badRequestHint: 'Check the repository: owner/name, then state:open or label:bug if you like.',
};
const REDMINE_NAMES = {
  name: 'Redmine',
  source: 'redmine',
  example: 'https://redmine.acme.example',
  authHint: 'Give your API key (My account, API access key; the REST API must be on, under Administration, Settings, API), or your login as the email with your password as the token.',
  badRequestHint: "Check the project's identifier, as in its address: /projects/backend is backend.",
};
const ZENDESK_NAMES = {
  name: 'Zendesk',
  source: 'zendesk',
  example: 'https://acme.zendesk.com',
  authHint: "Give an agent's email with an API token (Admin Center, Apps and integrations, Zendesk API), or an OAuth token alone.",
  badRequestHint: 'Write all, or since 2026-01-01.',
};
const NAMES_OF: Record<ApiImportSource, typeof YT_NAMES> = { youtrack: YT_NAMES, jira: JIRA_NAMES, github: GITHUB_NAMES, redmine: REDMINE_NAMES, zendesk: ZENDESK_NAMES };

/** The base address a4a keeps: checked, without a query or a fragment, and without a trailing slash. */
export function baseAddress(policy: RemotePolicy, kind: ApiImportSource, raw: string): URL {
  const url = checkAddress(policy, raw, NAMES_OF[kind].example);
  url.search = '';
  url.hash = '';
  // GitHub's own site is read through its API's address.
  if (kind === 'github' && /^(www\.)?github\.com$/i.test(url.hostname)) return new URL('https://api.github.com');
  if (kind !== 'youtrack' && kind !== 'jira') {
    url.pathname = url.pathname.replace(/\/+$/, '');
    if (kind === 'zendesk') url.pathname = url.pathname.replace(/\/(agent|api|hc)(\/.*)?$/i, '');
    if (kind === 'redmine') url.pathname = url.pathname.replace(/\/(projects|issues|my)(\/.*)?$/i, '');
    return url;
  }
  // People paste the address of a page in it: keep what precedes YouTrack's and Jira's own paths.
  url.pathname = url.pathname.replace(/\/(issues?|api|rest|browse|projects?|agiles|secure|jira\/software|jira\/core|dashboard)(\/.*)?$/i, '').replace(/\/+$/, '');
  return url;
}

/** A reader of where an import reads from, with the credentials given for this fetch or run. */
export function readerFor(
  policy: RemotePolicy,
  origin: OriginRef,
  credentials: ImportCredentials,
  /** GitHub: people a4a knows by their login there (D33, D46). */
  known?: ReadonlyMap<string, RemotePerson>,
): Reader {
  const base = baseAddress(policy, origin.kind, origin.url);
  const token = credentials.token.trim();
  const email = credentials.email?.trim();
  const b64 = (v: string) => Buffer.from(v).toString('base64');
  switch (origin.kind) {
    case 'github':
      return new GithubReader(new Remote(base, `Bearer ${token}`, [token], policy, GITHUB_NAMES), origin.query, origin.bring, known);
    case 'redmine': {
      // An API key goes as Basic's user name, with any password; a login goes with its password.
      const basic = b64(email ? `${email}:${token}` : `${token}:x`);
      return new RedmineReader(new Remote(base, `Basic ${basic}`, [token, basic], policy, REDMINE_NAMES), origin.query, origin.bring);
    }
    case 'zendesk': {
      const basic = email ? b64(`${email}/token:${token}`) : '';
      return new ZendeskReader(new Remote(base, email ? `Basic ${basic}` : `Bearer ${token}`, [token, basic].filter(Boolean), policy, ZENDESK_NAMES), origin.query, origin.bring);
    }
    default:
      break;
  }
  if (origin.kind === 'youtrack') {
    const remote = new Remote(base, `Bearer ${token}`, [token], policy, YT_NAMES);
    return new YouTrackReader(remote, origin.query, origin.bring);
  }
  const cloud = Boolean(credentials.email);
  const basic = cloud ? Buffer.from(`${credentials.email!.trim()}:${token}`).toString('base64') : '';
  const remote = new Remote(base, cloud ? `Basic ${basic}` : `Bearer ${token}`, [token, basic].filter(Boolean), policy, JIRA_NAMES);
  return new JiraReader(remote, origin.query, cloud, origin.bring);
}
