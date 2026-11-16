/**
 * More reports (D44): issues per field and the matrix count the issues a query finds as they are
 * now, by any field's values; average age and time in state read the history, each day as it
 * stood. Worked out on request like the others (services/reports.ts holds the scope, the windows
 * and the loading); nothing is stored.
 */
import { formatPeriod, type AverageAge, type CurrentScope, type Interval, type IssuesPerField, type Matrix, type ReportField, type TimeInState, type Tone, type ValueCount } from '@a4a/shared';
import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { boards, issueFieldValues, issues } from '../db/schema';
import { addDays, addMonths, diffDays, startOfMonth, startOfWeek } from '../lib/dates';
import { badRequest, notFound } from '../lib/errors';
import { didYouMean } from '../lib/text';
import { percentile } from '../reports/engine';
import { buildTimelines, projectBefore, valueBefore, type Timeline } from '../reports/history';
import { averageAge, byState, timeInStates, toDays, type Track } from '../reports/more';
import { dayBounds, startOfDay, timeZoneOrThrow, todayIn } from '../reports/tz';
import { quoteValue } from '../search/lexer';
import { projectAccess, visibleProjectIds } from './access';
import { knownStates, loadEvents, openStates, refOf, resolveScope, scopeDto, windowOf, within, type Scope, type WindowInput } from './reports';
import { stateField, type FieldRow, type SchemaSnapshot } from './schema-cache';
import { toneOf } from './values';

/** Past this many issues a report of issues as they are now asks for a narrower query. */
const MAX_ISSUES = 100_000;
/** Values one report shows of a field; the rest fold into one. */
const MAX_VALUES = 100;
const MAX_AXIS = 50;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);

// ---------------------------------------------------------------------------
// Fields, values and the queries that find them
// ---------------------------------------------------------------------------

type Dim = FieldRow | 'project';

/**
 * A field by name, among the fields of the report's projects (or, with none, the ones the caller
 * sees): a field only a hidden project has answers exactly as one that doesn't exist.
 */
async function fieldNamed(ctx: Ctx, s: SchemaSnapshot, scope: Scope, name: string): Promise<Dim> {
  const n = name.trim();
  if (n.toLowerCase() === 'project') return 'project';
  let projectIds = scope.projects.map((p) => p.id);
  if (!projectIds.length) projectIds = (await visibleProjectIds(ctx)) ?? [...s.projects.keys()];
  const ids = new Set<string>();
  for (const id of projectIds) for (const pf of s.projectFields.get(id) ?? []) ids.add(pf.fieldId);
  const fields = [...s.fields.values()].filter((f) => ids.has(f.id));
  const found = fields.find((f) => f.name.toLowerCase() === n.toLowerCase());
  if (found) return found;
  const names = ['Project', ...fields.map((f) => f.name).sort((a, b) => a.localeCompare(b))];
  const guess = didYouMean(n, names);
  throw badRequest(`No field here is called "${n}"`, `${guess ? `Did you mean "${guess}"? ` : ''}Fields: ${names.join(', ')}`);
}

function fieldDto(d: Dim): ReportField {
  return d === 'project' ? { name: 'Project', type: 'project', multi: false } : { name: d.name, type: d.type, multi: Boolean(d.multi) };
}

/** The report's projects and query, as the start of a query that finds some of its issues now. */
function scopeQuery(scope: Scope): string {
  const parts: string[] = [];
  if (scope.project) parts.push(`project: ${quoteValue(scope.project.key)}`);
  // "sort by" has to come last, and the issues a count opens are sorted however the list is.
  const q = scope.query?.replace(/\bsort\s+by\s*:[\s\S]*$/i, '').trim();
  if (q) parts.push(`(${q})`);
  return parts.join(' ');
}
const joinQuery = (...parts: string[]) => parts.filter(Boolean).join(' ');

const numberWord = (n: number) => (n < 0 ? `{${n}}` : String(n));

/** One value a report counts by: how it reads, how it sorts, and the clause that finds it. */
interface Bucket {
  key: string;
  label: string;
  tone: Tone | null;
  order: number | string;
  clause: string | null;
}

function noValue(d: Dim): Bucket {
  const name = d === 'project' ? 'Project' : d.name;
  return { key: '', label: d !== 'project' && d.type === 'user' ? 'Unassigned' : 'No value', tone: null, order: '', clause: `${name}: {no value}` };
}

/** Which way a field's values sort: their own order, in time, by number, or most issues first. */
function sortsBy(d: Dim): 'order' | 'number' | 'count' {
  if (d === 'project') return 'order';
  if (['enum', 'state', 'version', 'build', 'owned', 'date', 'datetime'].includes(d.type)) return 'order';
  if (['integer', 'float', 'period'].includes(d.type)) return 'number';
  return 'count';
}

function autoInterval(dates: string[]): Interval {
  if (!dates.length) return 'month';
  const sorted = [...dates].sort();
  const span = diffDays(sorted[0]!, sorted[sorted.length - 1]!) + 1;
  return span <= 31 ? 'day' : span <= 182 ? 'week' : 'month';
}

function dateBucket(fieldName: string, date: string, interval: Interval): Bucket {
  const start = interval === 'day' ? date : interval === 'week' ? startOfWeek(date) : startOfMonth(date);
  const last = interval === 'day' ? start : interval === 'week' ? addDays(start, 6) : addDays(addMonths(start, 1), -1);
  const [y, m] = start.split('-').map(Number) as [number, number];
  const label = interval === 'day' ? start : interval === 'week' ? `Week of ${start}` : `${MONTHS[m - 1]} ${y}`;
  return { key: start, label, tone: null, order: start, clause: `${fieldName}: ${start === last ? start : `${start} .. ${last}`}` };
}

/** The values of the issues in scope now, by field: the buckets each issue counts under. */
interface Counted {
  issueIds: string[];
  keysOf: Map<string, string[]>;
  buckets: Map<string, Bucket>;
  interval: Interval | null;
}

async function issuesInScope(ctx: Ctx, scope: Scope): Promise<{ id: string; projectId: string }[]> {
  const rows = await ctx.db.select({ id: issues.id, projectId: issues.projectId }).from(issues).where(scope.issueWhere).limit(MAX_ISSUES + 1);
  if (rows.length > MAX_ISSUES) throw badRequest(`This report would count more than ${MAX_ISSUES.toLocaleString('en')} issues`, 'Narrow it: choose a project, or add a query.');
  return rows;
}

async function countedBy(ctx: Ctx, s: SchemaSnapshot, scope: Scope, d: Dim, list: { id: string; projectId: string }[], intervalIn: Interval | undefined, tz: string): Promise<Counted> {
  const keysOf = new Map<string, string[]>();
  const buckets = new Map<string, Bucket>();
  const add = (issueId: string, b: Bucket) => {
    if (!buckets.has(b.key)) buckets.set(b.key, b);
    const keys = keysOf.get(issueId);
    if (!keys) keysOf.set(issueId, [b.key]);
    else if (!keys.includes(b.key)) keys.push(b.key);
  };
  const issueIds = list.map((r) => r.id);
  if (d === 'project') {
    for (const r of list) {
      const p = s.projects.get(r.projectId);
      if (p) add(r.id, { key: p.key, label: p.name, tone: null, order: p.name.toLowerCase(), clause: `project: ${quoteValue(p.key)}` });
    }
    return { issueIds, keysOf, buckets, interval: null };
  }
  const rows = list.length
    ? await ctx.db
        .select({
          issueId: issueFieldValues.issueId,
          valueId: issueFieldValues.valueId,
          userId: issueFieldValues.userId,
          textValue: issueFieldValues.textValue,
          numberValue: issueFieldValues.numberValue,
          dateValue: issueFieldValues.dateValue,
          groupId: issueFieldValues.groupId,
          timeValue: issueFieldValues.timeValue,
        })
        .from(issueFieldValues)
        .innerJoin(issues, eq(issues.id, issueFieldValues.issueId))
        .where(and(eq(issueFieldValues.fieldId, d.id), scope.issueWhere))
    : [];
  const F = d.name;
  const named = (name: string, tone: Tone | null, order: number | string): Bucket => ({ key: name.toLowerCase(), label: name, tone, order, clause: `${F}: ${quoteValue(name)}` });
  if (d.type === 'date' || d.type === 'datetime') {
    const dated = rows
      .map((r) => ({ issueId: r.issueId, date: d.type === 'date' ? r.dateValue : r.timeValue ? todayIn(tz, new Date(r.timeValue).getTime()) : null }))
      .filter((r): r is { issueId: string; date: string } => Boolean(r.date));
    const interval = intervalIn ?? autoInterval(dated.map((r) => r.date));
    for (const r of dated) add(r.issueId, dateBucket(F, r.date, interval));
    return { issueIds, keysOf, buckets, interval };
  }
  for (const r of rows) {
    switch (d.type) {
      case 'enum':
      case 'state':
      case 'version':
      case 'build':
      case 'owned': {
        // By name: a value each project has of its own counts once, as the query finds it.
        const v = r.valueId ? s.values.get(r.valueId) : undefined;
        if (v) add(r.issueId, named(v.name, toneOf(v.tone), v.ordinal));
        break;
      }
      case 'user': {
        const u = r.userId ? s.users.get(r.userId) : undefined;
        if (u) add(r.issueId, { key: u.login.toLowerCase(), label: u.name || u.login, tone: null, order: u.name.toLowerCase(), clause: `${F}: ${quoteValue(u.login)}` });
        break;
      }
      case 'group': {
        const g = r.groupId ? s.groups.get(r.groupId) : undefined;
        if (g) add(r.issueId, named(g.name, null, g.name.toLowerCase()));
        break;
      }
      case 'string':
      case 'text': {
        const text = r.textValue?.trim();
        if (text) {
          const label = text.length > 80 ? `${text.slice(0, 79)}…` : text;
          add(r.issueId, { key: text, label, tone: null, order: label.toLowerCase(), clause: text.length > 200 ? null : `${F}: ${quoteValue(text)}` });
        }
        break;
      }
      case 'integer':
      case 'float':
      case 'period': {
        const n = r.numberValue;
        if (n === null || n === undefined) break;
        const label = d.type === 'period' ? formatPeriod(n) : String(n);
        add(r.issueId, { key: String(n), label, tone: null, order: n, clause: `${F}: ${d.type === 'period' ? quoteValue(label) : numberWord(n)}` });
        break;
      }
    }
  }
  return { issueIds, keysOf, buckets, interval: null };
}

/**
 * The values to show, in the field's order, with the issues each counts, and how many had none.
 * Past `max`, the values with fewest issues fold into one ("*"), which no single query finds.
 */
function tally(d: Dim, c: Counted, max: number, prefix: string): { values: ValueCount[]; fold: (key: string) => string } {
  const counts = new Map<string, number>();
  for (const id of c.issueIds) for (const k of c.keysOf.get(id) ?? ['']) counts.set(k, (counts.get(k) ?? 0) + 1);
  const keys = [...counts.keys()].filter((k) => k !== '');
  let kept = new Set(keys);
  if (keys.length > max) kept = new Set([...keys].sort((a, b) => counts.get(b)! - counts.get(a)!).slice(0, max - 1));
  const how = sortsBy(d);
  const order = (k: string) => c.buckets.get(k)!.order;
  const sorted = [...kept].sort((a, b) => {
    if (how === 'count') return counts.get(b)! - counts.get(a)! || String(order(a)).localeCompare(String(order(b)));
    const oa = order(a);
    const ob = order(b);
    if (typeof oa === 'number' && typeof ob === 'number') return oa - ob || c.buckets.get(a)!.label.localeCompare(c.buckets.get(b)!.label);
    return String(oa).localeCompare(String(ob));
  });
  const fold = (k: string) => (k === '' || kept.has(k) ? k : '*');
  const values: ValueCount[] = sorted.map((k) => {
    const b = c.buckets.get(k)!;
    return { key: k, label: b.label, tone: b.tone, count: counts.get(k)!, query: b.clause === null ? null : joinQuery(prefix, b.clause) };
  });
  const rest = keys.filter((k) => !kept.has(k));
  if (rest.length) {
    const folded = c.issueIds.filter((id) => (c.keysOf.get(id) ?? []).some((k) => !kept.has(k))).length;
    values.push({ key: '*', label: `${rest.length} more values`, tone: null, count: folded, query: null });
  }
  const none = counts.get('') ?? 0;
  if (none) values.push({ key: '', label: noValue(d).label, tone: null, count: none, query: joinQuery(prefix, noValue(d).clause!) });
  return { values, fold };
}

function currentScope(scope: Scope, issues: number, tz: string, now: number): CurrentScope {
  return { projects: scope.projects.map(refOf), query: scope.query, issues, today: todayIn(tz, now), timeZone: tz };
}

// ---------------------------------------------------------------------------
// Issues per field
// ---------------------------------------------------------------------------

export interface FieldInput {
  project?: string;
  query?: string;
  interval?: Interval;
  timeZone?: string;
}

export async function issuesPerFieldReport(ctx: Ctx, input: FieldInput & { field: string }, now = Date.now()): Promise<IssuesPerField> {
  const s = await ctx.app.schema.get();
  const scope = await resolveScope(ctx, s, input);
  const tz = timeZoneOrThrow(input.timeZone);
  const d = await fieldNamed(ctx, s, scope, input.field);
  const list = await issuesInScope(ctx, scope);
  const counted = await countedBy(ctx, s, scope, d, list, input.interval, tz);
  const { values } = tally(d, counted, MAX_VALUES, scopeQuery(scope));
  return {
    scope: currentScope(scope, list.length, tz, now),
    field: fieldDto(d),
    interval: counted.interval,
    values,
    total: list.length,
    noValue: values.find((v) => v.key === '')?.count ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

export async function matrixReport(ctx: Ctx, input: FieldInput & { rows: string; columns: string }, now = Date.now()): Promise<Matrix> {
  const s = await ctx.app.schema.get();
  const scope = await resolveScope(ctx, s, input);
  const tz = timeZoneOrThrow(input.timeZone);
  const rd = await fieldNamed(ctx, s, scope, input.rows);
  const cd = await fieldNamed(ctx, s, scope, input.columns);
  const list = await issuesInScope(ctx, scope);
  const rc = await countedBy(ctx, s, scope, rd, list, input.interval, tz);
  const cc = await countedBy(ctx, s, scope, cd, list, input.interval, tz);
  const prefix = scopeQuery(scope);
  const rt = tally(rd, rc, MAX_AXIS, prefix);
  const ct = tally(cd, cc, MAX_AXIS, prefix);
  const rIndex = new Map(rt.values.map((v, i) => [v.key, i]));
  const cIndex = new Map(ct.values.map((v, i) => [v.key, i]));
  const clauseOf = (c: Counted, d: Dim, key: string) => (key === '' ? noValue(d).clause : key === '*' ? null : c.buckets.get(key)?.clause ?? null);
  const cells = rt.values.map((r) =>
    ct.values.map((col) => {
      const a = clauseOf(rc, rd, r.key);
      const b = clauseOf(cc, cd, col.key);
      return { count: 0, query: a === null || b === null ? null : joinQuery(prefix, a, b) };
    }),
  );
  for (const id of list.map((x) => x.id)) {
    const rk = new Set((rc.keysOf.get(id) ?? ['']).map(rt.fold));
    const ck = new Set((cc.keysOf.get(id) ?? ['']).map(ct.fold));
    for (const r of rk) for (const c of ck) cells[rIndex.get(r)!]![cIndex.get(c)!]!.count++;
  }
  return {
    scope: currentScope(scope, list.length, tz, now),
    rows: { field: fieldDto(rd), values: rt.values },
    columns: { field: fieldDto(cd), values: ct.values },
    cells,
    total: list.length,
  };
}

// ---------------------------------------------------------------------------
// Average age
// ---------------------------------------------------------------------------

/** A value as history shows it, the way the field's clause would find it now. */
function historyBucket(s: SchemaSnapshot, d: Dim, value: string): Omit<Bucket, 'order'> {
  if (d === 'project') {
    const p = s.projectsByKey.get(value.toUpperCase());
    return { key: value.toUpperCase(), label: p?.name ?? value, tone: null, clause: `project: ${quoteValue(value)}` };
  }
  const F = d.name;
  switch (d.type) {
    case 'user': {
      const u = s.usersByLogin.get(value.toLowerCase());
      return { key: value.toLowerCase(), label: u ? u.name || u.login : value, tone: null, clause: `${F}: ${quoteValue(value)}` };
    }
    case 'enum':
    case 'state':
    case 'version':
    case 'build':
    case 'owned': {
      const v = (s.valuesByField.get(d.id) ?? []).find((x) => x.name.toLowerCase() === value.toLowerCase());
      return { key: value.toLowerCase(), label: value, tone: v ? toneOf(v.tone) : null, clause: `${F}: ${quoteValue(value)}` };
    }
    case 'datetime':
      return { key: value, label: value, tone: null, clause: null };
    default:
      return { key: value.toLowerCase(), label: value, tone: null, clause: `${F}: ${quoteValue(value)}` };
  }
}

export async function averageAgeReport(ctx: Ctx, input: WindowInput & { field?: string }, now = Date.now()): Promise<AverageAge> {
  const s = await ctx.app.schema.get();
  const scope = await resolveScope(ctx, s, input);
  const w = windowOf(input, 30, 366, now);
  const bounds = dayBounds(w.from, w.to, w.tz);
  const d = input.field?.trim() ? await fieldNamed(ctx, s, scope, input.field) : null;
  const events = await loadEvents(ctx, s, scope.activityWhere, d && d !== 'project' ? { field: d.name } : {});
  const timelines = buildTimelines(events, openStates(s), { inScope: scope.inScope });
  const counted = within(timelines.values(), bounds.starts[0]!, Math.min(bounds.ends[bounds.ends.length - 1]!, now + 1));
  // A multi-valued field's history shows its values joined by ", ".
  const split =
    d === null
      ? undefined
      : d === 'project'
        ? (t: Timeline, at: number) => [projectBefore(t, at)]
        : (t: Timeline, at: number) => {
            const v = valueBefore(t, at);
            if (v === null) return [''];
            return d.multi ? v.split(', ').map((x) => x.trim()).filter(Boolean) : [v];
          };
  const res = averageAge(counted, bounds, now, split);
  const prefix = scopeQuery(scope);
  // A value's open issues now: only when the window ends today, so "now" is the last day.
  const live = w.to === w.today;
  const merged = new Map<string, AverageAge['values'][number] & { sums: number[] }>();
  for (const v of res.values) {
    const b = v.value === '' ? { ...noValue(d!), clause: noValue(d!).clause } : historyBucket(s, d!, v.value);
    const query = live && b.clause ? joinQuery(prefix, b.clause, '#Unresolved') : null;
    merged.set(b.key, { key: b.key, label: b.label, tone: b.tone, open: v.open, averageDays: round1(v.averageDays), oldestDays: round1(v.oldestDays), days: v.days.map(round1), query, sums: [] });
  }
  const values = [...merged.values()]
    .map(({ sums: _s, ...rest }) => rest)
    .sort((a, b) => Number(a.key === '') - Number(b.key === '') || b.open - a.open || a.label.localeCompare(b.label));
  return {
    scope: scopeDto(scope, w, counted.length),
    field: d ? fieldDto(d) : null,
    days: res.days.map((x) => ({ date: x.date, open: x.open, averageDays: round1(x.averageDays), medianDays: round1(x.medianDays) })),
    values,
    oldest: res.oldest.map((o) => ({ issue: o.rid, summary: o.summary, created: new Date(o.created).toISOString(), days: round1(o.days)! })),
  };
}

// ---------------------------------------------------------------------------
// Time in state
// ---------------------------------------------------------------------------

type BoardRow = typeof boards.$inferSelect;
interface Column {
  name: string;
  valueIds: string[];
}

/** A board the caller sees (any of its projects), by id or name; one they don't answers as missing. */
async function boardNamed(ctx: Ctx, name: string): Promise<{ board: BoardRow; readable: string[] }> {
  const view = await projectAccess(ctx);
  const all = (await ctx.db.select().from(boards)).filter((b) => b.projectIds.some((id) => view.canRead(id)));
  const board = all.find((b) => b.id === name) ?? all.find((b) => b.name.toLowerCase() === name.toLowerCase());
  if (!board) throw notFound(`Board ${name}`, `Boards: ${all.map((b) => b.name).join(', ') || 'none yet'}`);
  return { board, readable: board.projectIds.filter((id) => view.canRead(id)) };
}

export async function timeInStateReport(ctx: Ctx, input: WindowInput & { board?: string }, now = Date.now()): Promise<TimeInState> {
  const s = await ctx.app.schema.get();
  const sf = stateField(s);
  let scope: Scope;
  let found: { board: BoardRow; readable: string[] } | null = null;
  if (input.board?.trim()) {
    // A board's issues: its projects (those the caller sees) and its query, and the query asked for.
    found = await boardNamed(ctx, input.board.trim());
    const keys = found.readable.map((id) => s.projects.get(id)?.key).filter((k): k is string => Boolean(k));
    const query = joinQuery(`project: ${keys.map(quoteValue).join(', ')}`, found.board.query?.trim() ? `(${found.board.query.trim()})` : '', input.query?.trim() ? `(${input.query.trim()})` : '');
    scope = await resolveScope(ctx, s, { project: input.project, query });
    const own = new Set(keys.map((k) => k.toUpperCase()));
    const before = scope.inScope;
    scope = { ...scope, inScope: (k) => own.has(k.toUpperCase()) && before(k) };
  } else scope = await resolveScope(ctx, s, input);
  const w = windowOf(input, 90, 1100, now);
  const from = startOfDay(w.from, w.tz);
  const to = Math.min(startOfDay(addDays(w.to, 1), w.tz), now + 1);
  const known = knownStates(s, scope.projects);
  const columns = found ? ((found.board.columns as Column[] | null) ?? []) : null;
  // A board's columns are by its column field: the state, or another field, whose history is read.
  const columnField = found?.board.columnFieldId ? s.fields.get(found.board.columnFieldId) : undefined;
  const followed = columns && columnField && columnField.id !== sf?.id ? columnField : undefined;
  const events = await loadEvents(ctx, s, scope.activityWhere, followed ? { field: followed.name } : {});
  const timelines = buildTimelines(events, openStates(s), { inScope: scope.inScope });
  let track: Track = byState;
  if (columns) {
    const columnOf = new Map<string, string>();
    for (const c of columns) for (const id of c.valueIds) { const v = s.values.get(id); if (v) columnOf.set(v.name.toLowerCase(), c.name); }
    track = followed
      ? (t) => t.values.map((v) => ({ at: v.at, key: v.value === null ? null : (columnOf.get(v.value.toLowerCase()) ?? null) }))
      : (t) => t.standings.map((x) => ({ at: x.at, key: x.state === null ? null : (columnOf.get(x.state.toLowerCase()) ?? null) }));
  }
  const res = timeInStates(timelines.values(), from, to, track);
  // The states (or columns) in order: the workflow's, then any only history knows.
  const names: { name: string; resolved: boolean; tone: Tone | null }[] = columns
    ? columns.map((c) => {
        const states = known.filter((k) => c.valueIds.some((id) => s.values.get(id)?.name.toLowerCase() === k.name.toLowerCase()));
        return { name: c.name, resolved: states.length > 0 && states.every((k) => k.resolved), tone: null };
      })
    : known.map((k) => ({ name: k.name, resolved: k.resolved, tone: k.tone }));
  const index = new Map(names.map((n, i) => [n.name.toLowerCase(), i]));
  const extra = (key: string) => {
    if (!index.has(key.toLowerCase())) {
      index.set(key.toLowerCase(), names.length);
      names.push({ name: key, resolved: false, tone: null });
    }
    return index.get(key.toLowerCase())!;
  };
  for (const i of res.issues) for (const k of i.ms.keys()) extra(k);
  for (const o of res.ongoing) extra(o.key);
  const spent = names.map(() => [] as number[]);
  for (const i of res.issues) for (const [k, ms] of i.ms) spent[index.get(k.toLowerCase())!]!.push(toDays(ms));
  const nowCounts = names.map(() => 0);
  for (const o of res.ongoing) nowCounts[index.get(o.key.toLowerCase())!]!++;
  const end = Math.min(to, now);
  const states = names
    .map((n, i) => {
      const values = [...spent[i]!].sort((a, b) => a - b);
      const total = values.reduce((a, b) => a + b, 0);
      return {
        ...n,
        issues: values.length,
        totalDays: round2(total),
        meanDays: values.length ? round1(total / values.length) : null,
        p50: round1(percentile(values, 50)),
        p85: round1(percentile(values, 85)),
        now: nowCounts[i]!,
        // A board's columns all show; of the workflow, its open states, and any state with figures.
        keep: values.length > 0 || nowCounts[i]! > 0 || (columns !== null ? i < columns.length : !n.resolved && known.some((k) => k.name === n.name)),
      };
    });
  const shown = states.map((x, i) => (x.keep ? i : -1)).filter((i) => i >= 0);
  return {
    scope: scopeDto(scope, w, res.issues.length + res.ongoing.length),
    board: found ? { id: found.board.id, name: found.board.name } : null,
    by: columns ? 'column' : 'state',
    states: shown.map((i) => {
      const { keep: _k, ...rest } = states[i]!;
      return rest;
    }),
    issues: res.issues.map((i) => {
      const days = shown.map((k) => round2(toDays(i.ms.get(names[k]!.name) ?? [...i.ms].find(([key]) => key.toLowerCase() === names[k]!.name.toLowerCase())?.[1] ?? 0)));
      return { issue: i.rid, summary: i.summary, resolved: new Date(i.resolved).toISOString(), days, totalDays: round2(days.reduce((a, b) => a + b, 0)) };
    }),
    ongoing: res.ongoing
      .map((o) => ({ issue: o.rid, summary: o.summary, state: names[index.get(o.key.toLowerCase())!]!.name, daysInState: round1(toDays(end - o.since))!, daysOpen: round1(toDays(end - o.start))! }))
      .sort((a, b) => b.daysInState - a.daysInState),
  };
}
