/**
 * Imports from a CSV export (Jira's or YouTrack's). The steps, each a call:
 *
 * 1. Upload: the file streams through the parser into `import_rows`, never held whole, and each
 *    column's header and values give a first mapping.
 * 2. Mapping: the person maps the columns to the project's fields, and the values (states,
 *    priorities, people, sprints) to a4a's.
 * 3. Check: the whole import, worked out and written nowhere: what it would create and update,
 *    and each row's problems.
 * 4. Run: a job, with its progress kept on the import. Each row is a transaction of its own: the
 *    issue, its comments and the record of which external key it came from commit together, so a
 *    run stopped anywhere can run again and carries on: a key seen before updates or skips, never
 *    duplicates. Links and parents go in a second pass, by external key, once every issue exists.
 * 5. Report, and undo: the issues it created go again, unless someone has worked on them since.
 *
 * Imports are for administrators: they set other people as reporters and comment authors, and
 * keep the other tracker's dates.
 */
import {
  formatPeriod,
  type Import,
  type ImportCheck,
  type ImportColumn,
  type ImportCounts,
  type ImportOptions,
  type ImportProblem,
  type ImportRow,
  type ImportSource,
  type ImportUndo,
  type ImportValueMap,
} from '@a4a/shared';
import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { activities, boards, comments, externalIssues, importRows, imports, issues, sprints, workItems } from '../db/schema';
import { publishActivities, recordActivity, type ActivityRow } from '../events/activity';
import { CsvError, parseCsvStream } from '../imports/csv';
import {
  detectSource,
  matchPerson,
  parseComment,
  parseDate,
  parseDuration,
  splitMulti,
  suggestOption,
  targetFor,
  type FieldInfo,
  type PersonInfo,
} from '../imports/mapping';
import { badRequest, conflict, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { excerpt } from '../lib/text';
import { localDate, timeZoneOrThrow } from '../reports/tz';
import { assertCanWriteProject } from './access';
import { changeSprintInTx } from './boards';
import { issueRefsById, readableId, type IssueRow } from './issue-refs';
import { applyChanges, createIssueInTx, resolveFieldsInput, resolveLinkPhrase, type LinkSpec } from './issues';
import { allowedValues, fieldByName, projectByKey, type FieldRow, type ProjectRow, type SchemaSnapshot } from './schema-cache';
import { userRefDto, resolveFieldInput } from './values';

const MAX_ROWS = 50_000;
const MAX_BYTES = 64 * 1024 * 1024;
const BATCH = 500;
const DISTINCT_CAP = 2000;
const VALUE_ITEMS = 500;
const PROBLEMS_SHOWN = 200;
/** A run that hasn't said it's alive for this long has stopped (the server restarted, say). */
const STALE_MS = 60_000;

const SINGLE_TARGETS = new Set(['key', 'external-id', 'summary', 'description', 'parent', 'created', 'updated', 'resolved', 'reporter', 'spent']);
const SOURCE_NAMES: Record<ImportSource, string> = { jira: 'Jira', youtrack: 'YouTrack', csv: 'the other tracker' };

type ImportRowRecord = typeof imports.$inferSelect;

interface ColumnStats {
  samples: string[];
  filled: number;
  /** Each value and how many rows have it, or null past DISTINCT_CAP different values. */
  distinct: [string, number][] | null;
}

interface StoredMapping {
  targets: string[];
  found: boolean[];
  columns: ColumnStats[];
  /** Values a person chose, by target and value; anything else is suggested afresh. */
  values: Record<string, Record<string, string | null>>;
  options: ImportOptions;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Context: the project, its fields, its people, its sprints
// ---------------------------------------------------------------------------

interface Context {
  s: SchemaSnapshot;
  project: ProjectRow;
  fields: FieldRow[];
  phrases: string[];
  people: PersonInfo[];
  sprints: { id: string; name: string; board: string }[];
  /** Who runs the import, for "me". */
  meId: string;
}

async function contextFor(ctx: Ctx, project: ProjectRow): Promise<Context> {
  const s = await ctx.app.schema.get();
  const fields = (s.projectFields.get(project.id) ?? []).map((pf) => s.fields.get(pf.fieldId)).filter((f): f is FieldRow => Boolean(f));
  const people = [...s.users.values()].filter((u) => !u.banned).map((u) => ({ id: u.id, login: u.login, name: u.name, email: u.email }));
  const rows = await ctx.db
    .select({ id: sprints.id, name: sprints.name, board: boards.name, projectIds: boards.projectIds })
    .from(sprints)
    .innerJoin(boards, eq(boards.id, sprints.boardId))
    .orderBy(asc(sprints.startDate));
  return {
    s,
    project,
    fields,
    phrases: [...new Set(s.linkPhrases.map((p) => p.phrase))],
    people,
    sprints: rows.filter((r) => r.projectIds.includes(project.id)).map((r) => ({ id: r.id, name: r.name, board: r.board })),
    meId: ctx.actor.user.id,
  };
}

async function projectFor(ctx: Ctx, key: string): Promise<ProjectRow> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const project = projectByKey(s, key);
  if (!project) throw notFound(`Project ${key}`, `Projects: ${[...s.projectsByKey.keys()].join(', ')}`);
  await assertCanWriteProject(ctx, project.id);
  if (project.archived) throw badRequest(`Project ${project.key} is archived`);
  return project;
}

async function loadImport(ctx: Ctx, id: string): Promise<{ row: ImportRowRecord; project: ProjectRow }> {
  requireScope(ctx, 'admin');
  const [row] = await ctx.db.select().from(imports).where(eq(imports.id, id));
  if (!row) throw notFound('Import', 'GET /imports lists them.');
  const s = await ctx.app.schema.get();
  const project = s.projects.get(row.projectId);
  if (!project) throw notFound('Import');
  await assertCanWriteProject(ctx, project.id);
  return { row, project };
}

function fieldOf(c: Context, target: string): FieldRow | undefined {
  if (!target.startsWith('field:')) return undefined;
  const name = target.slice(6).toLowerCase();
  return c.fields.find((f) => f.name.toLowerCase() === name);
}

/** The kind of value map a target needs, or null when its values are taken as they are. */
function valueKind(c: Context, target: string): { kind: 'option' | 'user' | 'sprint'; multi: boolean; label: string } | null {
  if (target === 'reporter') return { kind: 'user', multi: false, label: 'Reporter' };
  if (target === 'sprint') return { kind: 'sprint', multi: true, label: 'Sprint' };
  const f = fieldOf(c, target);
  if (!f) return null;
  if (f.type === 'user') return { kind: 'user', multi: f.multi, label: f.name };
  if (f.type === 'enum' || f.type === 'state' || f.type === 'version') return { kind: 'option', multi: f.multi, label: f.name };
  return null;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export async function uploadImport(
  ctx: Ctx,
  input: { project: string; source?: ImportSource; fileName?: string },
  body: ReadableStream<Uint8Array> | null,
): Promise<Import> {
  const project = await projectFor(ctx, input.project);
  if (!body) throw badRequest('The request has no file', 'Send the CSV as the request body, with Content-Type: text/csv.');
  const id = newId();
  await ctx.db.insert(imports).values({
    id,
    projectId: project.id,
    source: input.source ?? 'csv',
    fileName: (input.fileName ?? 'export.csv').slice(0, 200),
    createdById: ctx.actor.user.id,
    status: 'uploading',
    header: [],
    mapping: {},
  });
  const file: { header: string[] | null } = { header: null };
  const stats: ColumnStats[] = [];
  const distinct: Map<string, number>[] = [];
  let rows = 0;
  try {
    const res = await parseCsvStream(
      body,
      async (records) => {
        const batch: (typeof importRows.$inferInsert)[] = [];
        for (const r of records) {
          if (!file.header) {
            const header = r.cells.map((h) => h.trim());
            if (!header.some(Boolean)) throw new CsvError('The first line, the header, is empty', 1);
            file.header = header;
            header.forEach(() => {
              stats.push({ samples: [], filled: 0, distinct: [] });
              distinct.push(new Map());
            });
            continue;
          }
          rows++;
          if (rows > MAX_ROWS) throw new CsvError(`The file has more than ${MAX_ROWS.toLocaleString('en')} rows`, r.line);
          r.cells.forEach((cell, i) => {
            const st = stats[i];
            if (!st || !cell.trim()) return;
            st.filled++;
            if (st.samples.length < 3) st.samples.push(excerpt(cell, 80));
            const d = distinct[i]!;
            if (st.distinct !== null) {
              const v = cell.trim().slice(0, 200);
              d.set(v, (d.get(v) ?? 0) + 1);
              if (d.size > DISTINCT_CAP) {
                st.distinct = null;
                d.clear();
              }
            }
          });
          batch.push({ importId: id, n: r.record, cells: r.cells });
        }
        for (let i = 0; i < batch.length; i += BATCH) await ctx.db.insert(importRows).values(batch.slice(i, i + BATCH));
      },
      { maxBytes: MAX_BYTES, maxField: 1_000_000, maxColumns: 500 },
    );
    const h = file.header;
    if (!h) throw new CsvError('The file is empty', 0);
    if (!rows) throw new CsvError('The file has a header and no rows', 1);
    stats.forEach((st, i) => {
      if (st.distinct !== null) st.distinct = [...distinct[i]!.entries()].sort((a, b) => b[1] - a[1]);
    });
    const c = await contextFor(ctx, project);
    const source = input.source ?? detectSource(h);
    const targets: string[] = [];
    const found: boolean[] = [];
    const taken = new Set<string>();
    h.forEach((name, i) => {
      const t = targetFor(name, stats[i]!.samples, c.fields, c.phrases);
      const single = SINGLE_TARGETS.has(t.target) || (fieldOf(c, t.target) ? !fieldOf(c, t.target)!.multi : false);
      if (t.target !== 'ignore' && single && taken.has(t.target)) {
        targets.push('ignore');
        found.push(false);
        return;
      }
      taken.add(t.target);
      targets.push(t.target);
      found.push(t.found);
    });
    const notes: string[] = [];
    if (res.replaced) notes.push(`${res.replaced} ${res.replaced === 1 ? 'character' : 'characters'} in the file weren't UTF-8 and show as �. Export it as UTF-8 to keep them.`);
    const mapping: StoredMapping = {
      targets,
      found,
      columns: stats,
      values: {},
      options: { onExisting: 'update', timeZone: timeZoneOrThrow(null) },
      notes,
    };
    await ctx.db.update(imports).set({ header: h, rowCount: rows, mapping, source, status: 'ready' }).where(eq(imports.id, id));
  } catch (e) {
    await ctx.db.delete(imports).where(eq(imports.id, id));
    if (e instanceof CsvError) throw badRequest(`The file can't be read: ${e.message}`, 'Export it again as CSV (UTF-8, comma-separated), and upload that.');
    throw e;
  }
  return getImport(ctx, id);
}

// ---------------------------------------------------------------------------
// What an import is now
// ---------------------------------------------------------------------------

function statusOf(row: ImportRowRecord, now = Date.now()): Import['status'] {
  if (row.status === 'running' && (!row.heartbeatAt || now - row.heartbeatAt.getTime() > STALE_MS)) return 'stopped';
  return row.status as Import['status'];
}

/** Each distinct value of the columns with `target`, with how many rows have it. */
function valuesOf(m: StoredMapping, target: string, multi: boolean): { items: [string, number][]; more: number } {
  const counts = new Map<string, number>();
  let unknown = 0;
  m.targets.forEach((t, i) => {
    if (t !== target) return;
    const d = m.columns[i]?.distinct;
    if (!d) {
      unknown += m.columns[i]?.filled ?? 0;
      return;
    }
    for (const [value, n] of d) for (const v of multi ? splitMulti(value) : [value]) counts.set(v, (counts.get(v) ?? 0) + n);
  });
  const all = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { items: all.slice(0, VALUE_ITEMS), more: all.length - Math.min(all.length, VALUE_ITEMS) + (unknown ? 1 : 0) };
}

/** What a value of `target` becomes: the person's choice, else the suggestion. */
function mapValue(c: Context, m: StoredMapping, target: string, value: string): { to: string | null; found: boolean } {
  const chosen = m.values[target];
  if (chosen && Object.prototype.hasOwnProperty.call(chosen, value)) return { to: chosen[value]!, found: false };
  const kind = valueKind(c, target);
  if (!kind) return { to: value, found: true };
  if (kind.kind === 'user') {
    const p = matchPerson(value, c.people);
    return { to: p?.login ?? null, found: Boolean(p) };
  }
  if (kind.kind === 'sprint') {
    const sp = c.sprints.find((x) => x.name.toLowerCase() === value.trim().toLowerCase());
    return { to: sp?.id ?? null, found: Boolean(sp) };
  }
  const f = fieldOf(c, target)!;
  return suggestOption(f.name, value, allowedValues(c.s, f.id, c.project.id).map((v) => v.name));
}

/** What leaving a value unmapped means: as a choice in a list, and in a sentence. */
function emptyMeaning(c: Context, target: string): { choice: string; sentence: string } {
  if (target === 'reporter') return { choice: 'Nobody: the reporter is left empty', sentence: 'the reporter is left empty' };
  if (target === 'sprint') return { choice: 'In no sprint', sentence: 'it goes in no sprint' };
  const f = fieldOf(c, target)!;
  if (f.type === 'user') return { choice: 'Unassigned', sentence: `${f.name} is left empty` };
  const pf = (c.s.projectFields.get(c.project.id) ?? []).find((x) => x.fieldId === f.id);
  if (pf?.defaultValue !== null && pf?.defaultValue !== undefined) {
    const value = Array.isArray(pf.defaultValue) ? pf.defaultValue.join(', ') : String(pf.defaultValue);
    return { choice: `The project's default, ${value}`, sentence: `it takes the project's default, ${value}` };
  }
  return { choice: 'Left empty', sentence: `${f.name} is left empty` };
}

function choicesFor(c: Context, target: string): { value: string; label: string }[] {
  const kind = valueKind(c, target);
  if (!kind) return [];
  if (kind.kind === 'user') return c.people.map((p) => ({ value: p.login, label: `${p.name} (${p.login})` }));
  if (kind.kind === 'sprint') return c.sprints.map((sp) => ({ value: sp.id, label: `${sp.name}, ${sp.board}` }));
  const f = fieldOf(c, target)!;
  return allowedValues(c.s, f.id, c.project.id).map((v) => ({ value: v.name, label: v.name }));
}

async function dto(ctx: Ctx, row: ImportRowRecord, project: ProjectRow, c?: Context): Promise<Import> {
  const s = await ctx.app.schema.get();
  const m = row.mapping as StoredMapping;
  const header = row.header as string[];
  const columns: ImportColumn[] = header.map((name, i) => ({
    index: i,
    name,
    target: m.targets?.[i] ?? 'ignore',
    found: m.found?.[i] ?? false,
    samples: m.columns?.[i]?.samples ?? [],
    filled: m.columns?.[i]?.filled ?? 0,
  }));
  const values: ImportValueMap[] = [];
  if (row.status !== 'uploading' && m.targets) {
    const cx = c ?? (await contextFor(ctx, project));
    for (const target of [...new Set(m.targets)]) {
      const kind = valueKind(cx, target);
      if (!kind) continue;
      const { items, more } = valuesOf(m, target, kind.multi);
      values.push({
        target,
        label: kind.label,
        kind: kind.kind,
        multi: kind.multi,
        items: items.map(([value, count]) => ({ value, count, ...mapValue(cx, m, target, value) })),
        more,
        choices: choicesFor(cx, target),
        empty: emptyMeaning(cx, target).choice,
      });
    }
  }
  const by = row.createdById ? s.users.get(row.createdById) : undefined;
  return {
    id: row.id,
    project: { id: project.id, key: project.key, name: project.name },
    source: row.source as ImportSource,
    fileName: row.fileName,
    createdBy: by ? userRefDto(by) : null,
    createdAt: row.createdAt.toISOString(),
    status: statusOf(row),
    rows: row.rowCount,
    columns,
    values,
    options: m.options ?? { onExisting: 'update', timeZone: timeZoneOrThrow(null) },
    progress: { phase: (row.progressPhase as 'issues' | 'links' | null) ?? null, done: row.progressDone, total: row.progressTotal },
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    error: row.error,
    result: (row.result as ImportCounts | null) ?? null,
  };
}

export async function getImport(ctx: Ctx, id: string): Promise<Import> {
  const { row, project } = await loadImport(ctx, id);
  return dto(ctx, row, project);
}

export async function listImports(ctx: Ctx, projectKey?: string): Promise<Import[]> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const project = projectKey ? projectByKey(s, projectKey) : undefined;
  if (projectKey && !project) throw notFound(`Project ${projectKey}`);
  const rows = await ctx.db
    .select()
    .from(imports)
    .where(project ? eq(imports.projectId, project.id) : undefined)
    .orderBy(sql`${imports.createdAt} desc`)
    .limit(100);
  const out: Import[] = [];
  for (const r of rows) {
    const p = s.projects.get(r.projectId);
    if (!p || r.status === 'uploading') continue;
    try {
      await assertCanWriteProject(ctx, p.id);
    } catch {
      continue;
    }
    out.push({ ...(await dto(ctx, r, p)), values: [] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

export async function updateMapping(
  ctx: Ctx,
  id: string,
  body: { columns?: Record<string, string>; values?: Record<string, Record<string, string | null>>; options?: Partial<ImportOptions> },
): Promise<Import> {
  const { row, project } = await loadImport(ctx, id);
  const status = statusOf(row);
  if (status === 'running') throw conflict('The import is running', 'Wait for it to finish; change the mapping before running it again.');
  if (status === 'undone') throw conflict('This import was undone', 'Upload the file again to import it afresh.');
  const c = await contextFor(ctx, project);
  const m = structuredClone(row.mapping as StoredMapping);
  const header = row.header as string[];
  for (const [index, target] of Object.entries(body.columns ?? {})) {
    const i = Number(index);
    if (!(i >= 0 && i < header.length)) throw badRequest(`There is no column ${index}`, `Columns run from 0 to ${header.length - 1}.`);
    if (target.startsWith('field:') && !fieldOf(c, target)) {
      throw badRequest(`${project.key} has no field "${target.slice(6)}"`, `Its fields: ${c.fields.map((f) => f.name).join(', ')}`);
    }
    if (target.startsWith('link:') && !c.phrases.includes(target.slice(5).toLowerCase())) {
      throw badRequest(`"${target.slice(5)}" is not a link a4a knows`, `Links: ${c.phrases.join(', ')}`);
    }
    m.targets[i] = target.startsWith('link:') ? `link:${target.slice(5).toLowerCase()}` : target;
    m.found[i] = false;
  }
  // A target that takes one value can have one column.
  const seen = new Map<string, number>();
  m.targets.forEach((t, i) => {
    const single = SINGLE_TARGETS.has(t) || (fieldOf(c, t) ? !fieldOf(c, t)!.multi : false);
    if (t === 'ignore' || !single) return;
    if (seen.has(t)) throw badRequest(`Both "${header[seen.get(t)!]}" and "${header[i]}" are mapped to ${t.replace(/^field:/, '')}`, 'Map one of them to something else, or ignore it.');
    seen.set(t, i);
  });
  for (const [target, values] of Object.entries(body.values ?? {})) {
    const kind = valueKind(c, target);
    if (!kind) throw badRequest(`Values of "${target}" aren't mapped`, 'Map values of option fields, people (Assignee, Reporter) and sprints.');
    const choices = new Map(choicesFor(c, target).map((x) => [x.value.toLowerCase(), x.value]));
    const out = (m.values[target] ??= {});
    for (const [value, to] of Object.entries(values)) {
      if (to === null) {
        out[value] = null;
        continue;
      }
      const canonical = choices.get(to.toLowerCase());
      if (!canonical) throw badRequest(`"${to}" is not a ${kind.label} here, for "${value}"`, `Choose one of: ${[...choices.values()].slice(0, 30).join(', ')}`);
      out[value] = canonical;
    }
  }
  if (body.options) {
    if (body.options.timeZone !== undefined) m.options.timeZone = timeZoneOrThrow(body.options.timeZone);
    if (body.options.onExisting !== undefined) m.options.onExisting = body.options.onExisting;
  }
  await ctx.db.update(imports).set({ mapping: m }).where(eq(imports.id, id));
  return dto(ctx, { ...row, mapping: m }, project, c);
}

// ---------------------------------------------------------------------------
// From a row to what it would do
// ---------------------------------------------------------------------------

interface Comment {
  at: number;
  authorId: string | null;
  authorName: string | null;
  text: string;
}

interface Intent {
  n: number;
  key: string | null;
  externalId: string | null;
  summary: string | null;
  description: string;
  fields: Record<string, string | number | string[] | null>;
  tags: string[];
  created: number;
  updated: number;
  resolved: number | null;
  reporterId: string | null;
  reporterName: string | null;
  comments: Comment[];
  spent: number | null;
  /** Who logged the spent time: the assignee, when they're here. */
  spentBy: string | null;
  links: { phrase: string; keys: string[] }[];
  parent: string | null;
  sprintIds: string[];
  problems: ImportProblem[];
  failed: boolean;
}

/** What a4a writes, as compared from one run to the next. */
interface Snapshot {
  summary: string;
  description: string;
  fields: Record<string, string | number | string[] | null>;
  tags: string[];
  comments: string[];
  spent: number;
}

function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return `${text.length}:${h.toString(36)}`;
}

const commentHash = (c: Comment) => hash(`${c.at}|${c.authorName ?? ''}|${c.text}`);

function snapshotOf(i: Intent): Snapshot {
  return { summary: i.summary ?? '', description: i.description, fields: i.fields, tags: [...i.tags].sort(), comments: i.comments.map(commentHash), spent: i.spent ?? 0 };
}

/** The values a row's cells give, by target, and the problems found reading them. */
function readRow(c: Context, m: StoredMapping, header: string[], source: ImportSource, n: number, cells: string[], now: number): Intent {
  const problems: ImportProblem[] = [];
  const tz = m.options.timeZone;
  const cellsOf = (target: string) => m.targets.flatMap((t, i) => (t === target && (cells[i] ?? '').trim() ? [{ value: (cells[i] ?? '').trim(), column: header[i] ?? `Column ${i + 1}` }] : []));
  const first = (target: string) => cellsOf(target)[0] ?? null;
  const key = first('key')?.value ?? null;
  const problem = (severity: ImportProblem['severity'], column: string | null, message: string, hint?: string) =>
    problems.push({ row: n, key, column, severity, message, ...(hint ? { hint } : {}) });

  const date = (target: string) => {
    const cell = first(target);
    if (!cell) return null;
    const t = parseDate(cell.value, tz);
    if (t === null) problem('warning', cell.column, `"${cell.value}" isn't a date a4a can read, so it's left out`, 'Dates such as 2024-03-12 14:15, 12/Mar/24 2:15 PM or 12.03.2024 are read.');
    return t;
  };
  let created = date('created');
  let updated = date('updated');
  const resolvedCell = date('resolved');
  if (created !== null && created > now) {
    problem('warning', null, 'Its created date is in the future, so it counts as created now');
    created = now;
  }
  created ??= updated ?? now;
  updated ??= created;
  if (updated < created) updated = created;
  if (updated > now) updated = now;

  const fields: Intent['fields'] = {};
  let stateResolved = false;
  for (const f of c.fields) {
    const target = `field:${f.name}`;
    const found = cellsOf(target);
    if (!found.length) continue;
    const kind = valueKind(c, target);
    const raw = f.multi ? found.flatMap((x) => splitMulti(x.value).map((v) => ({ value: v, column: x.column }))) : [found[0]!];
    const out: string[] = [];
    for (const r of raw) {
      if (kind) {
        const to = mapValue(c, m, target, r.value).to;
        if (to !== null) out.push(to);
        continue;
      }
      if (f.type === 'period') {
        const minutes = parseDuration(r.value, source);
        if (minutes === null) problem('warning', r.column, `"${r.value}" isn't a duration, so ${f.name} is left out`, 'Durations such as 2h 30m, 1d or a number of seconds (Jira) are read.');
        else if (minutes > 0) out.push(formatPeriod(minutes));
      } else if (f.type === 'date') {
        const t = parseDate(r.value, tz);
        if (t === null) problem('warning', r.column, `"${r.value}" isn't a date, so ${f.name} is left out`);
        else out.push(localDate(t, tz));
      } else out.push(r.value);
    }
    if (!out.length) continue;
    // Check each value now, so one bad value leaves out one field, not the whole row.
    try {
      const vals = resolveFieldInput(c.s, f, c.project.id, f.multi ? out : out[0]!, c.meId);
      if (f.type === 'state') stateResolved = vals.some((v) => (v.valueId ? c.s.values.get(v.valueId)?.isResolved : false));
      fields[f.name] = f.multi ? out : out[0]!;
    } catch (e) {
      const err = e as { message?: string; hint?: string };
      problem('warning', found[0]!.column, `${err.message ?? 'A value is not allowed'}, so ${f.name} is left out`, err.hint);
    }
  }
  // An unmapped state takes the project's default; whether that is resolved decides the issue's.
  if (!Object.keys(fields).some((k) => fieldOf(c, `field:${k}`)?.type === 'state')) {
    const sf = c.fields.find((f) => f.type === 'state');
    const pf = sf ? (c.s.projectFields.get(c.project.id) ?? []).find((x) => x.fieldId === sf.id) : undefined;
    if (sf && typeof pf?.defaultValue === 'string') {
      stateResolved = allowedValues(c.s, sf.id, c.project.id).find((v) => v.name.toLowerCase() === String(pf.defaultValue).toLowerCase())?.isResolved ?? false;
    }
  }

  const tags = [...new Set(cellsOf('tags').flatMap((x) => splitMulti(x.value)))].filter((t) => {
    if (t.length <= 60) return true;
    problem('warning', null, `The tag "${t.slice(0, 20)}…" is longer than 60 characters, so it's left out`);
    return false;
  });

  const reporterCell = first('reporter');
  const reporterLogin = reporterCell ? mapValue(c, m, 'reporter', reporterCell.value).to : null;
  const reporter = reporterLogin ? (c.people.find((p) => p.login === reporterLogin) ?? null) : null;
  const assigneeField = c.fields.find((f) => f.type === 'user' && !f.multi && fields[f.name]);
  const spentBy = assigneeField ? (c.people.find((p) => p.login === fields[assigneeField.name])?.id ?? null) : null;

  const comments: Comment[] = [];
  for (const cell of cellsOf('comment')) {
    const parsed = parseComment(cell.value, tz);
    if (!parsed) continue;
    const person = parsed.author ? matchPerson(parsed.author, c.people) : null;
    comments.push({ at: Math.min(parsed.at ?? updated, now), authorId: person?.id ?? null, authorName: parsed.author, text: parsed.text });
  }

  let spent: number | null = null;
  for (const cell of cellsOf('spent')) {
    const minutes = parseDuration(cell.value, source);
    if (minutes === null) problem('warning', cell.column, `"${cell.value}" isn't a duration, so the time spent is left out`);
    else spent = (spent ?? 0) + minutes;
  }

  const links: Intent['links'] = [];
  for (const t of [...new Set(m.targets.filter((x) => x.startsWith('link:')))]) {
    const keys = [...new Set(cellsOf(t).flatMap((x) => splitMulti(x.value)))];
    if (keys.length) links.push({ phrase: t.slice(5), keys });
  }
  const sprintIds = [...new Set(cellsOf('sprint').flatMap((x) => splitMulti(x.value)).map((v) => mapValue(c, m, 'sprint', v).to).filter((x): x is string => Boolean(x)))];

  const summary = first('summary')?.value ?? null;
  let failed = false;
  if (!key) {
    problem('error', null, 'It has no key, so it is not imported', 'Every row needs its key in the other tracker (Issue key in Jira, Issue Id in YouTrack): that is how running the import again finds it.');
    failed = true;
  }
  if (!summary) {
    problem('error', null, 'It has no summary, so it is not imported');
    failed = true;
  } else if (summary.length > 500) problem('warning', null, 'Its summary is longer than 500 characters, so it is cut short');

  return {
    n,
    key,
    externalId: first('external-id')?.value ?? null,
    summary: summary ? summary.slice(0, 500) : null,
    description: (first('description')?.value ?? '').slice(0, 100_000),
    fields,
    tags,
    created,
    updated,
    resolved: stateResolved ? Math.min(resolvedCell ?? updated, now) : null,
    reporterId: reporter?.id ?? null,
    reporterName: reporterCell?.value ?? null,
    comments,
    spent,
    spentBy,
    links,
    parent: first('parent')?.value ?? null,
    sprintIds,
    problems,
    failed,
  };
}

/** Problems that apply to many rows, said once: values with nowhere to go. */
function mappingWarnings(c: Context, m: StoredMapping): string[] {
  const out: string[] = [...(m.notes ?? [])];
  if (!m.targets.includes('key')) out.push('No column is the key, so nothing can be imported: map the column with each issue\'s key in the other tracker.');
  if (!m.targets.includes('summary')) out.push('No column is the summary, so nothing can be imported.');
  for (const target of new Set(m.targets)) {
    const kind = valueKind(c, target);
    if (!kind) continue;
    const { items } = valuesOf(m, target, kind.multi);
    const unmapped = items.filter(([v]) => mapValue(c, m, target, v).to === null);
    if (!unmapped.length) continue;
    const rows = unmapped.reduce((n, [, k]) => n + k, 0);
    const names = unmapped
      .slice(0, 5)
      .map(([v]) => `"${v}"`)
      .join(', ');
    out.push(`${names}${unmapped.length > 5 ? ` and ${unmapped.length - 5} more` : ''} (${rows} ${rows === 1 ? 'row' : 'rows'}) ${unmapped.length === 1 ? 'has' : 'have'} no ${kind.label} here, so ${emptyMeaning(c, target).sentence}.`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Check: the import, worked out and written nowhere
// ---------------------------------------------------------------------------

async function existingFor(db: Db, projectId: string, source: string, keys: string[]) {
  if (!keys.length) return new Map<string, typeof externalIssues.$inferSelect>();
  const rows = await db
    .select()
    .from(externalIssues)
    .where(and(eq(externalIssues.projectId, projectId), eq(externalIssues.source, source), inArray(externalIssues.externalKey, keys)));
  return new Map(rows.map((r) => [r.externalKey, r]));
}

function changedFields(before: Snapshot, after: Snapshot): string[] {
  const out: string[] = [];
  if (before.summary !== after.summary) out.push('Summary');
  if (before.description !== after.description) out.push('Description');
  for (const k of new Set([...Object.keys(before.fields ?? {}), ...Object.keys(after.fields)])) {
    if (JSON.stringify(before.fields?.[k] ?? null) !== JSON.stringify(after.fields[k] ?? null)) out.push(k);
  }
  if (JSON.stringify(before.tags ?? []) !== JSON.stringify(after.tags)) out.push('Tags');
  if (after.comments.some((h) => !(before.comments ?? []).includes(h))) out.push('Comments');
  if ((before.spent ?? 0) !== after.spent) out.push('Spent time');
  return out;
}

export async function checkImport(ctx: Ctx, id: string): Promise<ImportCheck> {
  const { row, project } = await loadImport(ctx, id);
  if (statusOf(row) === 'running') throw conflict('The import is running', 'Its progress is on the import; check it again when it has finished.');
  const c = await contextFor(ctx, project);
  const m = row.mapping as StoredMapping;
  const header = row.header as string[];
  const counts: ImportCounts = { total: row.rowCount, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, comments: 0, links: 0, linksMissing: 0, problems: 0 };
  const problems: ImportProblem[] = [];
  const keys = new Set<string>();
  const ids = new Set<string>();
  const pendingLinks: { n: number; key: string | null; refs: string[] }[] = [];
  const now = Date.now();
  const canImport = m.targets.includes('key') && m.targets.includes('summary');
  for (let after = 0; ; ) {
    const batch = await ctx.db
      .select({ n: importRows.n, cells: importRows.cells })
      .from(importRows)
      .where(and(eq(importRows.importId, id), gt(importRows.n, after)))
      .orderBy(asc(importRows.n))
      .limit(BATCH);
    if (!batch.length) break;
    after = batch[batch.length - 1]!.n;
    const intents = batch.map((b) => readRow(c, m, header, row.source as ImportSource, b.n, b.cells as string[], now));
    const existing = await existingFor(ctx.db, project.id, row.source, intents.map((i) => i.key).filter((k): k is string => Boolean(k)));
    for (const it of intents) {
      if (it.key && keys.has(it.key)) {
        it.problems.push({ row: it.n, key: it.key, column: null, severity: 'error', message: `${it.key} is on an earlier row of the file too, so this row is not imported` });
        it.failed = true;
      }
      if (!canImport) it.failed = true;
      counts.problems += it.problems.length;
      for (const p of it.problems) if (problems.length < PROBLEMS_SHOWN) problems.push(p);
      if (it.failed) {
        counts.failed++;
        continue;
      }
      keys.add(it.key!);
      if (it.externalId) ids.add(it.externalId);
      const ex = existing.get(it.key!);
      if (!ex) {
        counts.created++;
        counts.comments += it.comments.length;
      } else if (!ex.issueId || m.options.onExisting === 'skip') counts.skipped++;
      else {
        const changed = changedFields(ex.values as Snapshot, snapshotOf(it));
        if (changed.length) {
          counts.updated++;
          const before = (ex.values as Snapshot).comments ?? [];
          counts.comments += it.comments.filter((x) => !before.includes(commentHash(x))).length;
        } else counts.unchanged++;
      }
      const refs = [...it.links.flatMap((l) => l.keys), ...(it.parent ? [it.parent] : [])];
      if (refs.length) pendingLinks.push({ n: it.n, key: it.key, refs });
    }
  }
  // Links resolve against this file and what earlier imports made.
  const unknown = [...new Set(pendingLinks.flatMap((p) => p.refs).filter((k) => !keys.has(k) && !ids.has(k)))];
  const earlier = new Set<string>();
  for (let i = 0; i < unknown.length; i += BATCH) {
    const part = unknown.slice(i, i + BATCH);
    const rows = await ctx.db
      .select({ key: externalIssues.externalKey, externalId: externalIssues.externalId })
      .from(externalIssues)
      .where(and(eq(externalIssues.projectId, project.id), eq(externalIssues.source, row.source), sql`(${inArraySql(externalIssues.externalKey, part)} OR ${inArraySql(externalIssues.externalId, part)})`));
    for (const r of rows) {
      earlier.add(r.key);
      if (r.externalId) earlier.add(r.externalId);
    }
  }
  for (const p of pendingLinks) {
    for (const ref of p.refs) {
      if (keys.has(ref) || ids.has(ref) || earlier.has(ref)) counts.links++;
      else {
        counts.linksMissing++;
        counts.problems++;
        if (problems.length < PROBLEMS_SHOWN) {
          problems.push({ row: p.n, key: p.key, column: null, severity: 'warning', message: `${ref} is neither in this file nor imported before, so its link is left out` });
        }
      }
    }
  }
  problems.sort((a, b) => a.row - b.row);
  return { counts, problems, warnings: mappingWarnings(c, m) };
}

function inArraySql(column: typeof externalIssues.externalKey | typeof externalIssues.externalId, values: string[]) {
  return values.length
    ? sql`${column} IN (${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )})`
    : sql`FALSE`;
}

// ---------------------------------------------------------------------------
// Run: the job
// ---------------------------------------------------------------------------

const running = new Map<string, Promise<void>>();

/** For tests: wait for a run started here to finish. */
export async function waitForImport(id: string): Promise<void> {
  await running.get(id);
}

export async function runImport(ctx: Ctx, id: string): Promise<Import> {
  const { row, project } = await loadImport(ctx, id);
  const m = row.mapping as StoredMapping;
  if (!m.targets?.includes('key')) throw badRequest('No column is the key', "Map the column with each issue's key in the other tracker: running the import again finds the issues it made by it.");
  if (!m.targets.includes('summary')) throw badRequest('No column is the summary', 'Map the column with each issue\'s title.');
  // Claim the run: one at a time, per import and per project. A run whose heartbeat stopped may be taken over.
  const stale = new Date(Date.now() - STALE_MS);
  const [busy] = await ctx.db
    .select({ id: imports.id })
    .from(imports)
    .where(and(eq(imports.projectId, project.id), eq(imports.status, 'running'), gt(imports.heartbeatAt, stale), sql`${imports.id} <> ${id}`));
  if (busy) throw conflict(`Another import into ${project.key} is running`, 'Run this one when it has finished.');
  const [claimed] = await ctx.db
    .update(imports)
    .set({ status: 'running', heartbeatAt: new Date(), startedAt: new Date(), finishedAt: null, error: null, progressPhase: 'issues', progressDone: 0, progressTotal: row.rowCount })
    .where(and(eq(imports.id, id), sql`(${imports.status} IN ('ready', 'done', 'failed', 'undone') OR (${imports.status} = 'running' AND (${imports.heartbeatAt} IS NULL OR ${imports.heartbeatAt} < ${stale})))`))
    .returning();
  if (!claimed) throw conflict('The import is running already', 'Its progress is on the import.');
  const job = execute(ctx, claimed, project).catch(async (e) => {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`import ${id} failed:`, e);
    await ctx.app.db
      .update(imports)
      .set({ status: 'failed', error: `It stopped: ${message}`, finishedAt: new Date() })
      .where(eq(imports.id, id))
      .catch(() => {});
  });
  running.set(id, job);
  job.finally(() => running.delete(id)).catch(() => {});
  return dto(ctx, claimed, project);
}

interface Tally {
  comments: number;
  links: number;
  linksMissing: number;
}

async function execute(ctx: Ctx, imp: ImportRowRecord, project: ProjectRow): Promise<void> {
  const c = await contextFor(ctx, project);
  const m = imp.mapping as StoredMapping;
  const header = imp.header as string[];
  const source = imp.source as ImportSource;
  const tally: Tally = { comments: 0, links: 0, linksMissing: 0 };
  const origin = (key: string) => ({ importId: imp.id, source, key });
  const beat = (done: number, phase: 'issues' | 'links', total: number) =>
    ctx.db.update(imports).set({ heartbeatAt: new Date(), progressDone: done, progressPhase: phase, progressTotal: total }).where(eq(imports.id, imp.id));

  // Pass 1: the issues, a row at a time, each in a transaction of its own.
  const seen = new Set<string>();
  let done = 0;
  const now = Date.now();
  for (let after = 0; ; ) {
    const batch = await ctx.db
      .select()
      .from(importRows)
      .where(and(eq(importRows.importId, imp.id), gt(importRows.n, after)))
      .orderBy(asc(importRows.n))
      .limit(BATCH);
    if (!batch.length) break;
    after = batch[batch.length - 1]!.n;
    for (const r of batch) {
      const it = readRow(c, m, header, source, r.n, r.cells as string[], now);
      if (it.key && seen.has(it.key)) {
        it.problems.push({ row: it.n, key: it.key, column: null, severity: 'error', message: `${it.key} is on an earlier row of the file too, so this row is not imported` });
        it.failed = true;
      }
      if (it.key) seen.add(it.key);
      await importOne(ctx, c, imp, it, origin, tally);
      if (++done % 25 === 0) await beat(done, 'issues', imp.rowCount);
    }
  }
  await beat(done, 'issues', imp.rowCount);

  // Pass 2: links, parents and sprints, by external key, now that every issue exists.
  const withRefs = await ctx.db
    .select({ n: importRows.n, cells: importRows.cells, issueId: importRows.issueId, problems: importRows.problems })
    .from(importRows)
    .where(and(eq(importRows.importId, imp.id), isNotNull(importRows.issueId)))
    .orderBy(asc(importRows.n));
  let linked = 0;
  for (const r of withRefs) {
    const it = readRow(c, m, header, source, r.n, r.cells as string[], now);
    if (it.links.length || it.parent || it.sprintIds.length) {
      const problems = await linkOne(ctx, c, imp, it, r.issueId!, origin(it.key ?? ''), tally);
      if (problems.length) {
        await ctx.db
          .update(importRows)
          .set({ problems: [...((r.problems as ImportProblem[] | null) ?? []), ...problems] })
          .where(and(eq(importRows.importId, imp.id), eq(importRows.n, r.n)));
      }
    }
    if (++linked % 25 === 0) await beat(linked, 'links', withRefs.length);
  }

  const result = await countsOf(ctx.db, imp.id, imp.rowCount, tally);
  await ctx.db
    .update(imports)
    .set({ status: 'done', finishedAt: new Date(), heartbeatAt: new Date(), progressPhase: null, progressDone: imp.rowCount, progressTotal: imp.rowCount, result })
    .where(eq(imports.id, imp.id));
}

async function countsOf(db: Db, importId: string, total: number, tally: Tally): Promise<ImportCounts> {
  const rows = await db
    .select({ status: importRows.status, n: sql<number>`count(*)::int`, problems: sql<number>`coalesce(sum(jsonb_array_length(coalesce(${importRows.problems}, '[]'::jsonb))), 0)::int` })
    .from(importRows)
    .where(eq(importRows.importId, importId))
    .groupBy(importRows.status);
  const by = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
  return {
    total,
    created: by('created'),
    updated: by('updated'),
    unchanged: by('unchanged'),
    skipped: by('skipped'),
    failed: by('failed'),
    comments: tally.comments,
    links: tally.links,
    linksMissing: tally.linksMissing,
    problems: rows.reduce((n, r) => n + Number(r.problems), 0),
  };
}

async function markRow(tx: Db, importId: string, n: number, status: ImportRow['status'], problems: ImportProblem[], issue?: { id: string; rid: string }) {
  await tx
    .update(importRows)
    .set({ status, problems: problems.length ? problems : null, ...(issue ? { issueId: issue.id, readableId: issue.rid } : {}) })
    .where(and(eq(importRows.importId, importId), eq(importRows.n, n)));
}

/** One row: create its issue, update the one it made before, or leave it, with its comments and spent time. */
async function importOne(ctx: Ctx, c: Context, imp: ImportRowRecord, it: Intent, origin: (key: string) => Record<string, unknown>, tally: Tally): Promise<void> {
  const m = imp.mapping as StoredMapping;
  const source = imp.source as ImportSource;
  if (it.failed || !it.key || !it.summary) {
    await markRow(ctx.db, imp.id, it.n, 'failed', it.problems);
    return;
  }
  const key = it.key;
  const data = { ...origin(key) };
  let published: ActivityRow[] = [];
  try {
    published = await ctx.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const acts: ActivityRow[] = [];
      const [ex] = await tx
        .select()
        .from(externalIssues)
        .where(and(eq(externalIssues.projectId, c.project.id), eq(externalIssues.source, imp.source), eq(externalIssues.externalKey, key)))
        .for('update');
      const snap = snapshotOf(it);
      if (ex && (!ex.issueId || m.options.onExisting === 'skip')) {
        const why = ex.issueId ? `${ex.readableId} was imported from it before; this import leaves existing issues as they are` : `${ex.readableId}, made from it before, has been deleted since, so it is not made again`;
        await markRow(tx, imp.id, it.n, 'skipped', [...it.problems, { row: it.n, key, column: null, severity: 'warning', message: why }]);
        return acts;
      }
      if (ex) {
        const [issue] = await tx.select().from(issues).where(eq(issues.id, ex.issueId!));
        if (!issue) {
          await markRow(tx, imp.id, it.n, 'skipped', it.problems);
          return acts;
        }
        const before = ex.values as Snapshot;
        const changed = changedFields(before, snap);
        if (!changed.length) {
          await markRow(tx, imp.id, it.n, 'unchanged', it.problems, { id: issue.id, rid: ex.readableId });
          return acts;
        }
        // Change only what changed in the export since the last run: what someone changed here stays.
        // A required field the export now leaves empty keeps what it has.
        const fields: Record<string, string | number | string[] | null> = {};
        const pfs = c.s.projectFields.get(c.project.id) ?? [];
        for (const name of changed) {
          if (!(name in snap.fields) && !(name in (before.fields ?? {}))) continue;
          const f = fieldOf(c, `field:${name}`);
          if (snap.fields[name] === undefined && f && pfs.find((pf) => pf.fieldId === f.id)?.required) continue;
          fields[name] = snap.fields[name] ?? null;
        }
        const res = await applyChanges(tx, ctx, issue, {
          summary: changed.includes('Summary') ? snap.summary : undefined,
          description: changed.includes('Description') ? snap.description : undefined,
          fields: resolveFieldsInput(c.s, c.project, fields, ctx.actor.user.id),
          addTags: snap.tags.filter((t) => !(before.tags ?? []).includes(t)),
          removeTags: (before.tags ?? []).filter((t) => !snap.tags.includes(t)),
          data: { imported: data },
        });
        acts.push(...res.activities);
        // Updated as of the export's date, unless something here happened later.
        await tx
          .update(issues)
          .set({ updatedAt: new Date(Math.max(it.updated, issue.updatedAt.getTime())) })
          .where(eq(issues.id, issue.id));
        const fresh = it.comments.filter((x) => !(before.comments ?? []).includes(commentHash(x)));
        acts.push(...(await addComments(tx, ctx, c, res.issue, fresh, source, data)));
        tally.comments += fresh.length;
        if (snap.spent > (before.spent ?? 0)) acts.push(...(await addSpent(tx, ctx, c, res.issue, it, snap.spent - (before.spent ?? 0), source, data, m.options.timeZone)));
        await tx
          .update(externalIssues)
          .set({ values: snap, lastImportId: imp.id, updatedAt: new Date(), ...(it.externalId ? { externalId: it.externalId } : {}) })
          .where(and(eq(externalIssues.projectId, c.project.id), eq(externalIssues.source, imp.source), eq(externalIssues.externalKey, key)));
        await markRow(tx, imp.id, it.n, 'updated', it.problems, { id: issue.id, rid: ex.readableId });
        return acts;
      }
      const reporterName = it.reporterName && !it.reporterId ? it.reporterName : null;
      const created = await createIssueInTx(
        tx,
        ctx,
        { project: c.project.key, summary: it.summary!, description: it.description, fields: it.fields, tags: it.tags },
        {
          imported: {
            createdAt: new Date(it.created),
            updatedAt: new Date(it.updated),
            resolvedAt: it.resolved === null ? null : new Date(it.resolved),
            reporterId: it.reporterId,
            data: {
              ...data,
              createdAt: new Date(it.created).toISOString(),
              updatedAt: new Date(it.updated).toISOString(),
              ...(it.resolved !== null ? { resolvedAt: new Date(it.resolved).toISOString() } : {}),
              ...(reporterName ? { reporter: reporterName } : {}),
            },
          },
        },
      );
      acts.push(...created.activities);
      acts.push(...(await addComments(tx, ctx, c, created.issue, it.comments, source, data)));
      tally.comments += it.comments.length;
      if (snap.spent > 0) acts.push(...(await addSpent(tx, ctx, c, created.issue, it, snap.spent, source, data, m.options.timeZone)));
      const rid = readableId(c.s, created.issue);
      await tx.insert(externalIssues).values({
        projectId: c.project.id,
        source: imp.source,
        externalKey: key,
        externalId: it.externalId,
        issueId: created.issue.id,
        readableId: rid,
        createdByImportId: imp.id,
        lastImportId: imp.id,
        values: snap,
      });
      await markRow(tx, imp.id, it.n, 'created', it.problems, { id: created.issue.id, rid });
      return acts;
    });
  } catch (e) {
    const err = e as { message?: string; hint?: string; code?: string; cause?: { code?: string } };
    const duplicate = err.code === '23505' || err.cause?.code === '23505';
    const message = duplicate ? `${key} was imported by another run at the same moment, so this row was left` : `It could not be imported: ${err.message ?? String(e)}`;
    await markRow(ctx.db, imp.id, it.n, duplicate ? 'skipped' : 'failed', [...it.problems, { row: it.n, key, column: null, severity: duplicate ? 'warning' : 'error', message, ...(err.hint ? { hint: err.hint } : {}) }]);
    return;
  }
  await publishActivities(ctx.app, published);
}

async function addComments(tx: Db, ctx: Ctx, c: Context, issue: IssueRow, list: Comment[], source: ImportSource, data: Record<string, unknown>): Promise<ActivityRow[]> {
  if (!list.length) return [];
  const ref = (await issueRefsById(tx, c.s, [issue.id])).get(issue.id);
  const out: ActivityRow[] = [];
  for (const cm of list) {
    const id = newId();
    // Someone not here keeps their name, at the top of what they wrote.
    const text = cm.authorId || !cm.authorName ? cm.text : `**${cm.authorName}** wrote in ${SOURCE_NAMES[source]}:\n\n${cm.text}`;
    await tx.insert(comments).values({ id, issueId: issue.id, authorId: cm.authorId, text, channel: ctx.actor.channel, createdAt: new Date(cm.at), updatedAt: new Date(cm.at) });
    out.push(
      await recordActivity(tx, ctx, {
        type: 'comment.created',
        projectId: issue.projectId,
        issueId: issue.id,
        payload: { issue: ref, data: { commentId: id, text: excerpt(text, 1000), imported: { ...data, at: new Date(cm.at).toISOString(), ...(cm.authorName ? { author: cm.authorName } : {}) } } },
      }),
    );
  }
  return out;
}

async function addSpent(tx: Db, ctx: Ctx, c: Context, issue: IssueRow, it: Intent, minutes: number, source: ImportSource, data: Record<string, unknown>, tz: string): Promise<ActivityRow[]> {
  const author = it.spentBy ? c.s.users.get(it.spentBy) : undefined;
  // Logged on the day it was resolved there, or last updated.
  const date = localDate(it.resolved ?? it.updated, tz);
  const id = newId();
  const description = `Time spent in ${SOURCE_NAMES[source]}`;
  await tx.insert(workItems).values({ id, issueId: issue.id, authorId: author?.id ?? null, date, minutes, description, hourlyRate: author?.hourlyRate ?? null });
  const ref = (await issueRefsById(tx, c.s, [issue.id])).get(issue.id);
  return [
    await recordActivity(tx, ctx, {
      type: 'work.logged',
      projectId: issue.projectId,
      issueId: issue.id,
      payload: { issue: ref, data: { workItemId: id, minutes, duration: formatPeriod(minutes), date, author: author?.login ?? null, description, imported: data } },
    }),
  ];
}

/** Pass 2 for one row: its links and parent, by external key, and the sprints it was in. */
async function linkOne(ctx: Ctx, c: Context, imp: ImportRowRecord, it: Intent, issueId: string, data: Record<string, unknown>, tally: Tally): Promise<ImportProblem[]> {
  const problems: ImportProblem[] = [];
  const warn = (message: string, hint?: string) => problems.push({ row: it.n, key: it.key, column: null, severity: 'warning', message, ...(hint ? { hint } : {}) });
  const refs = [...new Set([...it.links.flatMap((l) => l.keys), ...(it.parent ? [it.parent] : [])])];
  const found = await ctx.db
    .select({ key: externalIssues.externalKey, externalId: externalIssues.externalId, issueId: externalIssues.issueId })
    .from(externalIssues)
    .where(and(eq(externalIssues.projectId, c.project.id), eq(externalIssues.source, imp.source), sql`(${inArraySql(externalIssues.externalKey, refs)} OR ${inArraySql(externalIssues.externalId, refs)})`));
  const target = (ref: string) => found.find((f) => f.key === ref)?.issueId ?? found.find((f) => f.externalId === ref)?.issueId ?? null;
  const wanted: { phrase: string; ref: string }[] = [...it.links.flatMap((l) => l.keys.map((ref) => ({ phrase: l.phrase, ref }))), ...(it.parent ? [{ phrase: 'subtask of', ref: it.parent }] : [])];
  for (const w of wanted) {
    const other = target(w.ref);
    if (!other) {
      tally.linksMissing++;
      warn(`${w.ref} is neither in this file nor imported before, so its link is left out`);
      continue;
    }
    if (other === issueId) continue;
    try {
      const acts = await ctx.db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Db;
        const [self] = await tx.select().from(issues).where(eq(issues.id, issueId));
        const [to] = await tx.select().from(issues).where(eq(issues.id, other));
        if (!self || !to) return [];
        const link: LinkSpec = { phrase: resolveLinkPhrase(c.s, w.phrase), target: to };
        const res = await applyChanges(tx, ctx, self, { links: [link], data: { imported: data } });
        if (res.changes.length) {
          tally.links++;
          // The link is the export's, as of its own date: the issue keeps the updated date it had.
          await tx.update(issues).set({ updatedAt: self.updatedAt }).where(eq(issues.id, self.id));
        }
        return res.activities;
      });
      await publishActivities(ctx.app, acts);
    } catch (e) {
      const err = e as { message?: string; hint?: string };
      warn(`Its link "${w.phrase} ${w.ref}" is left out: ${err.message ?? String(e)}`, err.hint);
    }
  }
  if (it.sprintIds.length) {
    const acts = await ctx.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const out: ActivityRow[] = [];
      const [self] = await tx.select({ id: issues.id, projectId: issues.projectId }).from(issues).where(eq(issues.id, issueId));
      if (!self) return out;
      for (const sid of it.sprintIds) {
        const [sprint] = await tx.select().from(sprints).where(eq(sprints.id, sid));
        const [board] = sprint ? await tx.select().from(boards).where(eq(boards.id, sprint.boardId)) : [];
        if (!sprint || !board) continue;
        out.push(...(await changeSprintInTx(tx, ctx, sprint, board, [self], false, { imported: data })));
      }
      return out;
    });
    await publishActivities(ctx.app, acts);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// What each row became
// ---------------------------------------------------------------------------

export async function importRowsOf(ctx: Ctx, id: string, q: { status?: string; offset: number; limit: number }): Promise<{ total: number; items: ImportRow[] }> {
  const { row } = await loadImport(ctx, id);
  const m = row.mapping as StoredMapping;
  const keyCol = m.targets.indexOf('key');
  const summaryCol = m.targets.indexOf('summary');
  const conds = [eq(importRows.importId, id)];
  if (q.status === 'problems') conds.push(sql`jsonb_array_length(coalesce(${importRows.problems}, '[]'::jsonb)) > 0`);
  else if (q.status) conds.push(eq(importRows.status, q.status));
  const [rows, [{ n } = { n: 0 }]] = await Promise.all([
    ctx.db.select().from(importRows).where(and(...conds)).orderBy(asc(importRows.n)).limit(q.limit).offset(q.offset),
    ctx.db.select({ n: sql<number>`count(*)::int` }).from(importRows).where(and(...conds)),
  ]);
  return {
    total: Number(n),
    items: rows.map((r) => {
      const cells = r.cells as string[];
      return {
        row: r.n,
        key: keyCol >= 0 ? cells[keyCol]?.trim() || null : null,
        summary: summaryCol >= 0 ? excerpt(cells[summaryCol] ?? '', 200) || null : null,
        status: r.status as ImportRow['status'],
        issue: r.readableId,
        problems: (r.problems as ImportProblem[] | null) ?? [],
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/**
 * Take back an import: the issues it created go, each in a transaction with its deletion recorded,
 * unless anyone but an import has done anything to one since (commented, changed it, logged work,
 * linked it): those stay, and say why. Changes it made to issues that were there before stay too:
 * undoing them would mean writing old values over whatever happened since, which isn't safe.
 */
export async function undoImport(ctx: Ctx, id: string, opts: { dryRun: boolean }): Promise<ImportUndo> {
  const { row, project } = await loadImport(ctx, id);
  if (statusOf(row) === 'running') throw conflict('The import is running', 'Undo it when it has finished.');
  const s = await ctx.app.schema.get();
  const made = await ctx.db
    .select({ issueId: externalIssues.issueId, readableId: externalIssues.readableId, key: externalIssues.externalKey })
    .from(externalIssues)
    .where(and(eq(externalIssues.projectId, project.id), eq(externalIssues.createdByImportId, id), isNotNull(externalIssues.issueId)));
  const [{ n: updatedStay } = { n: 0 }] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(externalIssues)
    .where(and(eq(externalIssues.projectId, project.id), eq(externalIssues.lastImportId, id), sql`${externalIssues.createdByImportId} IS DISTINCT FROM ${id}`));
  const remove: string[] = [];
  const keep: { issue: string; why: string }[] = [];
  /** The first thing someone did to it that no import did, in words; null when there's nothing. */
  const touched = async (db: Db, issueId: string): Promise<string | null> => {
    const [a] = await db
      .select({ type: activities.type, actorId: activities.actorId, at: activities.createdAt })
      .from(activities)
      .where(and(eq(activities.issueId, issueId), isNull(sql`${activities.payload}->'data'->'imported'`)))
      .orderBy(asc(activities.id))
      .limit(1);
    if (!a) return null;
    const who = a.actorId ? (s.users.get(a.actorId)?.name ?? 'Someone') : 'a4a';
    const did: Record<string, string> = {
      'issue.updated': 'changed it',
      'comment.created': 'commented on it',
      'comment.updated': 'edited a comment on it',
      'comment.deleted': 'deleted a comment on it',
      'link.created': 'linked it',
      'link.deleted': 'unlinked it',
      'work.logged': 'logged work on it',
      'work.deleted': 'removed work logged on it',
      'sprint.issue_added': 'put it in a sprint',
      'sprint.issue_removed': 'took it out of a sprint',
      'ai.triage.completed': 'triaged it',
    };
    return `${who} ${did[a.type] ?? 'worked on it'} on ${a.at.toISOString().slice(0, 10)}`;
  };
  for (const r of made) {
    const why = await touched(ctx.db, r.issueId!);
    if (why) keep.push({ issue: r.readableId, why });
    else remove.push(r.readableId);
  }
  if (opts.dryRun) return { applied: false, remove, keep, updatedStay: Number(updatedStay) };

  const removed: string[] = [];
  for (const r of made) {
    if (!remove.includes(r.readableId)) continue;
    const activity = await ctx.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const [issue] = await tx.select().from(issues).where(eq(issues.id, r.issueId!)).for('update');
      if (!issue) return null;
      // Checked again under the issue's lock: someone may have worked on it since the list was made.
      const why = await touched(tx, issue.id);
      if (why) {
        keep.push({ issue: r.readableId, why });
        return null;
      }
      const ref = (await issueRefsById(tx, s, [issue.id])).get(issue.id);
      await tx.delete(issues).where(eq(issues.id, issue.id));
      await tx.delete(externalIssues).where(and(eq(externalIssues.projectId, project.id), eq(externalIssues.source, row.source), eq(externalIssues.externalKey, r.key)));
      return recordActivity(tx, ctx, { type: 'issue.deleted', projectId: issue.projectId, issueId: null, payload: { issue: ref, data: { undoneImport: id } } });
    });
    if (activity) {
      removed.push(r.readableId);
      await publishActivities(ctx.app, [activity]);
    }
  }
  await ctx.db.update(imports).set({ status: 'undone' }).where(eq(imports.id, id));
  return { applied: true, remove: removed, keep, updatedStay: Number(updatedStay) };
}

/** Forget an upload: its rows and its record. The issues it made, and what links them to their keys, stay. */
export async function deleteImport(ctx: Ctx, id: string): Promise<void> {
  const { row } = await loadImport(ctx, id);
  if (statusOf(row) === 'running') throw conflict('The import is running', 'Delete it when it has finished.');
  await ctx.db.delete(imports).where(eq(imports.id, id));
}
