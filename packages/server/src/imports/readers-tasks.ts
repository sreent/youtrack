/**
 * Asana's and ClickUp's tasks, read as the other trackers' issues are (D29, D46, readers.ts): each
 * task as named cells, the columns the mapping already knows (Summary, State, Priority, Assignee,
 * Watchers, Due date…), and what cells can't hold beside them (D61). A task is known by its id
 * there (Asana's gid, ClickUp's task id), which is what its links and subtasks name it by.
 *
 * The shapes, as their documentation gives them:
 *
 * - Asana (REST API 1.0, under /api/1.0): GET /projects/{gid}/tasks?opt_fields&limit&offset, page by
 *   page by next_page.offset; each task's subtasks by /tasks/{gid}/subtasks, its stories (comments
 *   among them) by /tasks/{gid}/stories, its files by /attachments?parent={gid}; /projects/{gid} and
 *   /projects/{gid}/task_counts for whether the token sees the project and how many tasks it has;
 *   /users/me for whom the token is. A file's download_url lasts minutes, so it is asked for again
 *   (/attachments/{gid}) as each file comes. A personal access token, as a bearer token. Refusals
 *   as { errors: [{ message }] }, 429 with Retry-After.
 * - ClickUp (API v2, under /api/v2): GET /list/{id}/task?page&subtasks=true&include_closed=true
 *   &include_markdown_description=true&order_by=created&reverse=true, up to 100 tasks a page until
 *   last_page; each task's comments by /task/{id}/comment (newest first, 25 at a time, older ones by
 *   start and start_id), its time tracked by /task/{id}/time (each interval logged), its files by
 *   /task/{id}; /list/{id} for whether the token sees the List and how many tasks it has; /user for
 *   whom the token is. A personal token (pk_…) is the Authorization header itself; an OAuth token
 *   goes as a bearer token. Refusals as { err, ECODE }, 429 with X-RateLimit-Reset.
 */
import type { ImportBring } from '@a4a/shared';
import { asanaToMarkdown, deltaToMarkdown } from './markup';
import { personCell, type Reader, type RemoteCursor, type RemoteIssue, type RemotePage, type RemotePerson, type RowExtra } from './readers';
import { Remote, RemoteError } from './remote';

const empty = (): RowExtra => ({ comments: [], work: [], files: [], leftComments: 0 });
/** An instant from an ISO date, or from milliseconds since 1970 as ClickUp writes them ("1712000000000"). */
const ms = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const t = typeof v === 'number' || /^\d{9,}$/.test(v) ? Number(v) : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const iso = (v: string | number | null | undefined) => (ms(v) === null ? '' : new Date(ms(v)!).toISOString());
const minutes = (msValue: number | string | null | undefined) => Math.round(Number(msValue ?? 0) / 60_000);
const cap = (v: string | null | undefined) => (v ? v.charAt(0).toUpperCase() + v.slice(1) : null);
/** How deep subtasks are read: Asana allows five levels below a task. */
const MAX_DEPTH = 5;
/** Items read under one task at most (comments, subtasks, files), so one task can't read forever. */
const MAX_ITEMS = 5000;

function cellsOf(): { cells: [string, string][]; put: (name: string, value: string | number | null | undefined) => void } {
  const cells: [string, string][] = [];
  return {
    cells,
    put: (name, value) => {
      const s = value === null || value === undefined ? '' : String(value);
      if (s.trim() !== '') cells.push([name, s]);
    },
  };
}

/** A custom field's column: its name, unless that's one of the reader's own columns, which it then keeps "(field)" after. */
function customColumn(name: string, own: ReadonlySet<string>): string {
  return own.has(name.trim().toLowerCase()) ? `${name.trim()} (field)` : name.trim();
}

/** The links of a task, as the columns the mapping makes links of: a phrase and the ids there. */
function putLinks(put: (name: string, value: string) => void, links: Map<string, string[]>): void {
  for (const [phrase, ids] of links) if (ids.length) put(phrase, [...new Set(ids)].join(', '));
}

// ---------------------------------------------------------------------------
// Asana
// ---------------------------------------------------------------------------

const ASANA = '/api/1.0';

interface AsUser {
  gid?: string;
  name?: string | null;
  email?: string | null;
}

interface AsCustomField {
  name?: string | null;
  resource_subtype?: string | null;
  type?: string | null;
  display_value?: string | null;
  enum_value?: { name?: string | null } | null;
  multi_enum_values?: { name?: string | null }[] | null;
  number_value?: number | null;
  text_value?: string | null;
  date_value?: { date?: string | null; date_time?: string | null } | null;
  people_value?: AsUser[] | null;
}

interface AsTask {
  gid: string;
  name?: string | null;
  resource_subtype?: string | null;
  notes?: string | null;
  html_notes?: string | null;
  completed?: boolean | null;
  completed_at?: string | null;
  created_at?: string | null;
  modified_at?: string | null;
  due_on?: string | null;
  due_at?: string | null;
  start_on?: string | null;
  start_at?: string | null;
  assignee?: AsUser | null;
  followers?: AsUser[] | null;
  created_by?: AsUser | null;
  tags?: { name?: string | null }[] | null;
  memberships?: { project?: { gid?: string } | null; section?: { name?: string | null } | null }[] | null;
  parent?: { gid?: string } | null;
  num_subtasks?: number | null;
  custom_fields?: AsCustomField[] | null;
  dependencies?: { gid?: string }[] | null;
}

interface AsStory {
  gid: string;
  type?: string | null;
  resource_subtype?: string | null;
  text?: string | null;
  html_text?: string | null;
  created_at?: string | null;
  created_by?: AsUser | null;
}

interface AsAttachment {
  gid: string;
  name?: string | null;
  size?: number | null;
  host?: string | null;
  created_at?: string | null;
}

interface AsPage<T> {
  data?: T[];
  next_page?: { offset?: string | null } | null;
}

const AS_PERSON = (path: string) => `${path}.name,${path}.email`;
const AS_TASK = [
  'name',
  'resource_subtype',
  'notes',
  'html_notes',
  'completed',
  'completed_at',
  'created_at',
  'modified_at',
  'due_on',
  'due_at',
  'start_on',
  'start_at',
  AS_PERSON('assignee'),
  AS_PERSON('followers'),
  AS_PERSON('created_by'),
  'tags.name',
  'memberships.project.gid',
  'memberships.section.name',
  'parent.gid',
  'num_subtasks',
  'custom_fields.name',
  'custom_fields.resource_subtype',
  'custom_fields.type',
  'custom_fields.display_value',
  'custom_fields.enum_value.name',
  'custom_fields.multi_enum_values.name',
  'custom_fields.number_value',
  'custom_fields.text_value',
  'custom_fields.date_value.date',
  'custom_fields.date_value.date_time',
  AS_PERSON('custom_fields.people_value'),
  'dependencies.gid',
].join(',');
const AS_OWN = new Set(['issue key', 'summary', 'description', 'reporter', 'created', 'updated', 'resolved', 'state', 'section', 'type', 'assignee', 'watchers', 'tags', 'due date', 'start date', 'parent', 'depends on']);
const asPerson = (u: AsUser | null | undefined): RemotePerson | null => (u && (u.name || u.email) ? { name: u.name || null, login: null, email: u.email || null } : null);
const people = (list: (RemotePerson | null)[]) => list.map(personCell).filter(Boolean).join(', ');

/** A custom field's value, as a cell: options by name, people by name and email, dates as written. */
function asanaValue(f: AsCustomField): string {
  switch (f.resource_subtype ?? f.type) {
    case 'enum':
      return f.enum_value?.name ?? '';
    case 'multi_enum':
      return (f.multi_enum_values ?? []).map((v) => v.name ?? '').filter(Boolean).join(', ');
    case 'number':
      return typeof f.number_value === 'number' ? String(f.number_value) : '';
    case 'text':
      return f.text_value ?? '';
    case 'date':
      return f.date_value?.date_time ?? f.date_value?.date ?? '';
    case 'people':
      return people((f.people_value ?? []).map(asPerson));
    default:
      return f.display_value ?? '';
  }
}

/** The project a query names: its id, or its address in Asana (/0/{project}/… or …/project/{project}/…). */
export function asanaProject(query: string): string {
  const q = query.trim();
  if (/^\d{1,30}$/.test(q)) return q;
  const m = /\/project\/(\d{1,30})(?:[/?#]|$)/.exec(q) ?? /^https?:\/\/[^/\s]+\/0\/(\d{1,30})(?:[/?#]|$)/i.exec(q);
  if (m) return m[1]!;
  const shown = q.slice(0, 100);
  throw new RemoteError(`"${shown}" isn't an Asana project`, 'Give its address in Asana, or its id: the number after /0/ or /project/ in the address.', 'refused').said('imports.source.notAnAsanaProject', { project: shown });
}

export class AsanaReader implements Reader {
  readonly keyColumn = 'Issue key';
  private readonly project: string;
  /** Tasks kept already, by key: neither read again nor their subtasks (a fetch carrying on). */
  private kept: ReadonlySet<string> = new Set();
  /** Tasks this reader has given, so a task in two places in the project comes once. */
  private readonly given = new Set<string>();
  /** Whether it has gone back to the first page for an offset Asana refused: once, or a refusal of a fresh one would go round for ever. */
  private restarted = false;

  constructor(
    readonly remote: Remote,
    query: string,
    private readonly bring: ImportBring,
    private readonly pageSize = 50,
  ) {
    this.project = asanaProject(query);
    // A file's download_url lasts minutes: it is asked for as the file comes, not when the task was read.
    remote.setLocate(async (href) => {
      const m = /^asana-attachment:(\d{1,30})$/.exec(href);
      if (!m) return href;
      const got = await remote.json<{ data?: { download_url?: string | null } }>(`${ASANA}/attachments/${m[1]}`, { query: { opt_fields: 'download_url' } });
      const url = got.data?.download_url;
      if (!url) throw new RemoteError("Asana didn't say where the file is", 'Run the import again later: the files not brought yet come then.', 'missing').said('imports.source.asanaFileNowhere');
      return url;
    });
  }

  skip(keys: ReadonlySet<string>): void {
    this.kept = keys;
  }

  async probe(): Promise<string | null> {
    const me = await this.remote.json<{ data?: AsUser }>(`${ASANA}/users/me`, { query: { opt_fields: 'name,email' } });
    return me.data?.name || me.data?.email || null;
  }

  /** Whether the token sees the project (one it can't see answers as one that isn't there), and how many tasks it has. */
  async count(): Promise<number | null> {
    try {
      await this.remote.json(`${ASANA}/projects/${this.project}`, { query: { opt_fields: 'name' } });
    } catch (e) {
      if (e instanceof RemoteError && (e.status === 400 || e.status === 403 || e.status === 404)) {
        throw new RemoteError(`Asana has no project ${this.project} the token can see`, "Check the project: its address in Asana, or its id, and that the token's account is in it.", 'missing', e.status).said(
          'imports.source.asanaNoProject',
          { project: this.project },
        );
      }
      throw e;
    }
    try {
      const got = await this.remote.json<{ data?: { num_tasks?: number } }>(`${ASANA}/projects/${this.project}/task_counts`, { query: { opt_fields: 'num_tasks' } });
      return typeof got.data?.num_tasks === 'number' ? got.data.num_tasks : null;
    } catch (e) {
      // The count is only a guide: the tasks are read all the same.
      if (e instanceof RemoteError && e.status !== null && e.status < 500) return null;
      throw e;
    }
  }

  resumeFrom(cursor: RemoteCursor | null): RemoteCursor | null {
    // Asana's offset carries on where it was; one that has expired since reads from the start (page()).
    return cursor && 'token' in cursor ? cursor : null;
  }

  async page(cursor: RemoteCursor | null): Promise<RemotePage> {
    const offset = cursor && 'token' in cursor ? cursor.token : undefined;
    let got: AsPage<AsTask>;
    try {
      got = await this.remote.json<AsPage<AsTask>>(`${ASANA}/projects/${this.project}/tasks`, { query: { opt_fields: AS_TASK, limit: Math.min(100, this.pageSize), offset } });
    } catch (e) {
      // An offset kept from before a stop may have expired: read from the first page, and the tasks kept already are known by key.
      if (offset && !this.restarted && e instanceof RemoteError && e.status === 400) {
        this.restarted = true;
        return this.page(null);
      }
      throw e;
    }
    if (!Array.isArray(got.data)) throw new RemoteError("Asana's answer wasn't a list of tasks", 'Check the address: https://app.asana.com.', 'shape').said('imports.source.asanaNotAList');
    const out: RemoteIssue[] = [];
    for (const t of got.data) await this.task(t, out, 0);
    const next = got.next_page?.offset;
    return { issues: out, next: next ? { token: next } : null };
  }

  /** Every item of a list under a task, page by page. */
  private async all<T>(path: string, query: Record<string, string>): Promise<T[]> {
    const out: T[] = [];
    let offset: string | undefined;
    do {
      const got = await this.remote.json<AsPage<T>>(path, { query: { ...query, limit: 100, offset } });
      out.push(...(Array.isArray(got.data) ? got.data : []));
      offset = got.next_page?.offset ?? undefined;
    } while (offset && out.length < MAX_ITEMS);
    return out;
  }

  /** A task, then its subtasks below it, each a row of its own. */
  private async task(t: AsTask, out: RemoteIssue[], depth: number): Promise<void> {
    // The old API's sections came as tasks; a task already kept, or given, comes once.
    if (!t?.gid || t.resource_subtype === 'section' || this.kept.has(t.gid) || this.given.has(t.gid)) return;
    this.given.add(t.gid);
    const issue = await this.issue(t);
    out.push(issue);
    if ((t.num_subtasks ?? 0) > 0 && depth < MAX_DEPTH) {
      const subtasks = await this.all<AsTask>(`${ASANA}/tasks/${t.gid}/subtasks`, { opt_fields: AS_TASK });
      // Subtasks the token can't read aren't in the list: left out, and counted.
      issue.hidden = Math.max(0, (t.num_subtasks ?? 0) - subtasks.length);
      for (const s of subtasks) await this.task(s.parent?.gid ? s : { ...s, parent: { gid: t.gid } }, out, depth + 1);
    }
  }

  private async issue(t: AsTask): Promise<RemoteIssue> {
    const { cells, put } = cellsOf();
    put('Issue key', t.gid);
    put('Summary', t.name);
    put('Description', asanaToMarkdown(t.html_notes) || t.notes);
    put('Reporter', personCell(asPerson(t.created_by)));
    put('Created', iso(t.created_at));
    put('Updated', iso(t.modified_at));
    const section = (t.memberships ?? []).find((m) => m.project?.gid === this.project)?.section?.name ?? null;
    // A completed task is resolved, when it was completed; one still open is where its section has it.
    put('Resolved', t.completed ? iso(t.completed_at) : '');
    put('State', t.completed ? 'Completed' : section);
    put('Section', section);
    put('Type', t.resource_subtype === 'milestone' ? 'Milestone' : t.resource_subtype === 'approval' ? 'Approval' : 'Task');
    put('Assignee', personCell(asPerson(t.assignee)));
    put('Watchers', people((t.followers ?? []).map(asPerson)));
    put('Tags', (t.tags ?? []).map((x) => x.name ?? '').filter(Boolean).join(', '));
    put('Due date', t.due_at ?? t.due_on);
    put('Start date', t.start_at ?? t.start_on);
    put('Parent', t.parent?.gid);
    putLinks(put, new Map([['depends on', (t.dependencies ?? []).map((d) => d.gid ?? '').filter(Boolean)]]));
    for (const f of t.custom_fields ?? []) if (f.name?.trim()) put(customColumn(f.name, AS_OWN), asanaValue(f));

    const extra = empty();
    if (this.bring.comments) {
      const stories = await this.all<AsStory>(`${ASANA}/tasks/${t.gid}/stories`, { opt_fields: `type,resource_subtype,text,html_text,created_at,${AS_PERSON('created_by')}` });
      for (const s of stories) {
        if (s.type !== 'comment' && s.resource_subtype !== 'comment_added') continue;
        const text = asanaToMarkdown(s.html_text) || (s.text ?? '').trim();
        if (!text) continue;
        extra.comments.push({ id: s.gid, at: ms(s.created_at) ?? ms(t.modified_at) ?? Date.now(), by: asPerson(s.created_by), text });
      }
    }
    if (this.bring.files) {
      const files = await this.all<AsAttachment>(`${ASANA}/attachments`, { parent: t.gid, opt_fields: 'name,size,host,created_at' });
      for (const a of files) {
        // Files kept in Asana come; a link to Google Drive, Dropbox or the like stays a link there.
        if (a.host && a.host !== 'asana') continue;
        extra.files.push({ id: a.gid, name: a.name || 'file', size: a.size ?? 0, type: null, href: `asana-attachment:${a.gid}`, at: ms(a.created_at) ?? ms(t.created_at) ?? Date.now(), by: null, comment: null });
      }
    }
    return { key: t.gid, cells, extra, restricted: false };
  }
}

// ---------------------------------------------------------------------------
// ClickUp
// ---------------------------------------------------------------------------

const CLICKUP = '/api/v2';

interface CuUser {
  id?: number | string;
  username?: string | null;
  email?: string | null;
}

interface CuCustomField {
  name?: string | null;
  type?: string | null;
  type_config?: { options?: { id?: string; name?: string | null; label?: string | null; orderindex?: number | string }[] } | null;
  value?: unknown;
  hide_from_guests?: boolean | null;
}

interface CuChecklistItem {
  name?: string | null;
  resolved?: boolean | null;
  orderindex?: number | null;
  children?: CuChecklistItem[] | null;
}

interface CuAttachment {
  id: string;
  date?: string | null;
  title?: string | null;
  url?: string | null;
  size?: number | null;
  mimetype?: string | null;
  user?: CuUser | null;
  deleted?: boolean | null;
  is_folder?: boolean | null;
}

interface CuTask {
  id: string;
  custom_id?: string | null;
  name?: string | null;
  text_content?: string | null;
  description?: string | null;
  markdown_description?: string | null;
  status?: { status?: string | null; type?: string | null } | null;
  date_created?: string | null;
  date_updated?: string | null;
  date_closed?: string | null;
  date_done?: string | null;
  creator?: CuUser | null;
  assignees?: CuUser[] | null;
  watchers?: CuUser[] | null;
  checklists?: { name?: string | null; orderindex?: number | null; items?: CuChecklistItem[] | null }[] | null;
  tags?: { name?: string | null }[] | null;
  parent?: string | null;
  priority?: { priority?: string | null } | null;
  due_date?: string | null;
  start_date?: string | null;
  points?: number | null;
  time_estimate?: number | null;
  time_spent?: number | null;
  custom_fields?: CuCustomField[] | null;
  dependencies?: { task_id?: string; depends_on?: string }[] | null;
  linked_tasks?: { task_id?: string; link_id?: string }[] | null;
  attachments?: CuAttachment[] | null;
}

interface CuComment {
  id: string;
  comment?: unknown;
  comment_text?: string | null;
  user?: CuUser | null;
  date?: string | null;
}

const CU_OWN = new Set([
  'issue key',
  'custom task id',
  'summary',
  'description',
  'reporter',
  'created',
  'updated',
  'resolved',
  'status',
  'priority',
  'assignee',
  'watchers',
  'tags',
  'due date',
  'start date',
  'estimation',
  'time spent',
  'story points',
  'parent',
  'depends on',
  'is required for',
  'relates to',
]);
const cuPerson = (u: CuUser | null | undefined): RemotePerson | null => (u && (u.username || u.email) ? { name: u.username || null, login: null, email: u.email || null } : null);
/** ClickUp's own page size, which it doesn't let a request change. */
const CU_PAGE = 100;
const CU_COMMENTS_PAGE = 25;

/** A custom field's value, as a cell: an option by its name, people by name and email, a date as an instant. */
function clickupValue(f: CuCustomField): string {
  const v = f.value;
  if (v === null || v === undefined || v === '') return '';
  const options = f.type_config?.options ?? [];
  switch (f.type) {
    case 'drop_down': {
      // An option by its id, or (as ClickUp has answered) by its place in the list.
      const o = options.find((x) => x.id === v) ?? options.find((x) => String(x.orderindex) === String(v));
      return o?.name ?? '';
    }
    case 'labels':
      return (Array.isArray(v) ? v : []).map((id) => options.find((o) => o.id === id)?.label ?? '').filter(Boolean).join(', ');
    case 'users':
      return (Array.isArray(v) ? (v as CuUser[]) : []).map((u) => personCell(cuPerson(u))).filter(Boolean).join(', ');
    case 'date':
      return iso(v as string);
    case 'checkbox':
      return v === true || v === 'true' ? 'true' : 'false';
    case 'location':
      return (v as { formatted_address?: string }).formatted_address ?? '';
    case 'automatic_progress':
    case 'manual_progress':
    case 'progress': {
      const p = (v as { percent_completed?: number }).percent_completed;
      return typeof p === 'number' ? String(p) : '';
    }
    default:
      return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
  }
}

/**
 * A task's checklists, as Markdown's: each under its name in bold, an item ticked as it was there,
 * an item's own items below it. a4a has no checklists of its own, and a description's are ticked in
 * place (D39), so they stay the lists they were rather than becoming issues (D61).
 */
export function checklistsMarkdown(lists: CuTask['checklists']): string {
  const byPlace = <T extends { orderindex?: number | null }>(items: T[]) => [...items].sort((a, b) => (a.orderindex ?? 0) - (b.orderindex ?? 0));
  const lines = (item: CuChecklistItem, depth: number): string[] => [
    `${'  '.repeat(depth)}- [${item.resolved ? 'x' : ' '}] ${(item.name ?? '').trim()}`,
    ...byPlace(item.children ?? []).flatMap((c) => lines(c, depth + 1)),
  ];
  return byPlace(lists ?? [])
    .filter((l) => l.items?.length)
    .map((l) => [...(l.name?.trim() ? [`**${l.name.trim()}**`, ''] : []), ...byPlace(l.items ?? []).flatMap((i) => lines(i, 0))].join('\n'))
    .join('\n\n');
}

/** The List a query names: its id, or its address in ClickUp (…/li/{list} or …/v/l/6-{list}-…). */
export function clickupList(query: string): string {
  const q = query.trim();
  if (/^\d{1,30}$/.test(q)) return q;
  const m = /\/li\/(\d{1,30})(?:[/?#]|$)/.exec(q) ?? /\/v\/l\/6-(\d{1,30})-\d+/.exec(q);
  if (m) return m[1]!;
  const shown = q.slice(0, 100);
  throw new RemoteError(`"${shown}" isn't a ClickUp List`, "Give its address in ClickUp, or its id: the number after /li/ in the List's address.", 'refused').said('imports.source.notAClickupList', { list: shown });
}

export class ClickUpReader implements Reader {
  readonly keyColumn = 'Issue key';
  private readonly list: string;
  /** Tasks kept already, by key: their comments, time and files aren't read again (a fetch carrying on). */
  private kept: ReadonlySet<string> = new Set();

  constructor(
    readonly remote: Remote,
    query: string,
    private readonly bring: ImportBring,
  ) {
    this.list = clickupList(query);
  }

  skip(keys: ReadonlySet<string>): void {
    this.kept = keys;
  }

  async probe(): Promise<string | null> {
    const me = await this.remote.json<{ user?: CuUser }>(`${CLICKUP}/user`);
    return me.user?.username || me.user?.email || null;
  }

  /** Whether the token sees the List (one it can't see answers as one that isn't there), and how many tasks it has. */
  async count(): Promise<number | null> {
    let got: { task_count?: number | string | null };
    try {
      got = await this.remote.json<{ task_count?: number | string | null }>(`${CLICKUP}/list/${this.list}`);
    } catch (e) {
      // The token was taken already (probe): a refusal here is the List's.
      if (e instanceof RemoteError && e.status !== null && [400, 401, 403, 404].includes(e.status)) {
        throw new RemoteError(`ClickUp has no List ${this.list} the token can see`, "Check the List: its address in ClickUp, or its id, and that the token's account can open it.", 'missing', e.status).said(
          'imports.source.clickupNoList',
          { list: this.list },
        );
      }
      throw e;
    }
    const n = Number(got.task_count);
    return got.task_count !== null && got.task_count !== undefined && Number.isFinite(n) ? n : null;
  }

  resumeFrom(cursor: RemoteCursor | null): RemoteCursor | null {
    // A page back: a task deleted there since moves the rest up a place.
    if (!cursor || !('page' in cursor)) return null;
    return { page: Math.max(0, cursor.page - 1) };
  }

  async page(cursor: RemoteCursor | null): Promise<RemotePage> {
    const page = cursor && 'page' in cursor ? cursor.page : 0;
    const got = await this.remote.json<{ tasks?: CuTask[]; last_page?: boolean }>(`${CLICKUP}/list/${this.list}/task`, {
      query: { page, subtasks: 'true', include_closed: 'true', include_markdown_description: 'true', order_by: 'created', reverse: 'true' },
    });
    if (!Array.isArray(got.tasks)) throw new RemoteError("ClickUp's answer wasn't a list of tasks", 'Check the address: https://app.clickup.com.', 'shape').said('imports.source.clickupNotAList');
    const out: RemoteIssue[] = [];
    for (const t of got.tasks) if (t?.id && !this.kept.has(t.id)) out.push(await this.task(t));
    const last = got.last_page === true || !got.tasks.length || (got.last_page === undefined && got.tasks.length < CU_PAGE);
    return { issues: out, next: last ? null : { page: page + 1 } };
  }

  /** Every comment, newest first as ClickUp gives them, then older ones by the oldest read so far. */
  private async comments(id: string): Promise<CuComment[]> {
    const all = new Map<string, CuComment>();
    let query: Record<string, string> = {};
    while (all.size < MAX_ITEMS) {
      const got = await this.remote.json<{ comments?: CuComment[] }>(`${CLICKUP}/task/${encodeURIComponent(id)}/comment`, { query });
      const list = (got.comments ?? []).filter((c) => c?.id);
      const fresh = list.filter((c) => !all.has(String(c.id)));
      for (const c of fresh) all.set(String(c.id), c);
      if (!fresh.length || list.length < CU_COMMENTS_PAGE) break;
      const oldest = list[list.length - 1]!;
      query = { start: String(oldest.date ?? ''), start_id: String(oldest.id) };
    }
    return [...all.values()];
  }

  private async task(listed: CuTask): Promise<RemoteIssue> {
    // Files are on the task as read alone, with its watchers: read it so when its files are to come.
    const full = this.bring.files && !Array.isArray(listed.attachments) ? (await this.remote.json<CuTask>(`${CLICKUP}/task/${encodeURIComponent(listed.id)}`, { query: { include_markdown_description: 'true' } })) : null;
    const t: CuTask = full?.id ? { ...listed, ...full } : listed;
    const { cells, put } = cellsOf();
    put('Issue key', t.id);
    put('Custom task ID', t.custom_id);
    put('Summary', t.name);
    put('Description', [t.markdown_description ?? t.description ?? t.text_content ?? '', checklistsMarkdown(t.checklists)].map((x) => x.trim()).filter(Boolean).join('\n\n'));
    put('Reporter', personCell(cuPerson(t.creator)));
    put('Created', iso(t.date_created));
    put('Updated', iso(t.date_updated));
    put('Resolved', iso(t.date_done ?? t.date_closed));
    put('Status', t.status?.status);
    put('Priority', cap(t.priority?.priority));
    // a4a's Assignee is one person: the first. The others, and the watchers, watch it here.
    const [assignee, ...others] = t.assignees ?? [];
    put('Assignee', personCell(cuPerson(assignee)));
    const watchers = new Map<string, RemotePerson>();
    for (const u of [...others, ...(t.watchers ?? [])]) {
      const p = cuPerson(u);
      const id = String(u.id ?? u.email ?? u.username);
      if (p && !watchers.has(id) && String(assignee?.id ?? '') !== id) watchers.set(id, p);
    }
    put('Watchers', [...watchers.values()].map(personCell).join(', '));
    put('Tags', (t.tags ?? []).map((x) => x.name ?? '').filter(Boolean).join(', '));
    put('Due date', iso(t.due_date));
    put('Start date', iso(t.start_date));
    if (minutes(t.time_estimate) > 0) put('Estimation', `${minutes(t.time_estimate)}m`);
    // With the time tracked brought one interval at a time, its total would count it twice.
    if (!this.bring.work && minutes(t.time_spent) > 0) put('Time spent', `${minutes(t.time_spent)}m`);
    put('Story points', t.points);
    put('Parent', t.parent);
    const links = new Map<string, string[]>([
      ['depends on', []],
      ['is required for', []],
      ['relates to', []],
    ]);
    for (const d of t.dependencies ?? []) {
      // Waiting on another task: depends on it. Blocking one: it depends on this.
      if (d.task_id === t.id && d.depends_on) links.get('depends on')!.push(d.depends_on);
      else if (d.depends_on === t.id && d.task_id) links.get('is required for')!.push(d.task_id);
    }
    for (const l of t.linked_tasks ?? []) {
      const other = l.task_id === t.id ? l.link_id : l.task_id;
      if (other && other !== t.id) links.get('relates to')!.push(other);
    }
    putLinks(put, links);
    for (const f of t.custom_fields ?? []) {
      if (!f.name?.trim()) continue;
      // A field ClickUp hides from guests is for only some people there: it comes as a column no field takes until someone maps it.
      put(f.hide_from_guests ? `${f.name.trim()} (hidden from guests)` : customColumn(f.name, CU_OWN), clickupValue(f));
    }

    const extra = empty();
    if (this.bring.comments) {
      for (const c of await this.comments(t.id)) {
        const text = (deltaToMarkdown(c.comment) || c.comment_text || '').trim();
        if (!text) continue;
        extra.comments.push({ id: String(c.id), at: ms(c.date) ?? ms(t.date_updated) ?? Date.now(), by: cuPerson(c.user), text });
      }
      extra.comments.sort((a, b) => a.at - b.at);
    }
    if (this.bring.work && (t.time_spent === undefined || t.time_spent === null || Number(t.time_spent) > 0)) {
      const got = await this.remote.json<{ data?: { user?: CuUser | null; intervals?: { id?: string; start?: string | null; time?: string | number | null }[] | null }[] }>(`${CLICKUP}/task/${encodeURIComponent(t.id)}/time`);
      for (const entry of got.data ?? []) {
        for (const i of entry.intervals ?? []) {
          const start = ms(i.start);
          if (!i.id || start === null || !(minutes(i.time) > 0)) continue;
          extra.work.push({ id: String(i.id), date: new Date(start).toISOString().slice(0, 10), minutes: minutes(i.time), by: cuPerson(entry.user), text: '' });
        }
      }
    }
    if (this.bring.files) {
      for (const a of t.attachments ?? []) {
        if (!a?.id || !a.url || a.deleted || a.is_folder) continue;
        extra.files.push({ id: String(a.id), name: a.title || 'file', size: a.size ?? 0, type: a.mimetype ?? null, href: a.url, at: ms(a.date) ?? ms(t.date_created) ?? Date.now(), by: cuPerson(a.user), comment: null });
      }
    }
    return { key: t.id, cells, extra, restricted: false };
  }
}
