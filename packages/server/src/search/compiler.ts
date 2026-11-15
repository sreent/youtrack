import { parsePeriod, type QueryProblem } from '@a4a/shared';
import { sql, type SQL } from 'drizzle-orm';
import { issues } from '../db/schema';
import { parseDateExpression, todayISO, type DateRange } from '../lib/dates';
import { didYouMean } from '../lib/text';
import { parseReadableId } from '../services/issue-refs';
import { fieldByName, findUser, type FieldRow, type SchemaSnapshot } from '../services/schema-cache';
import { isEmptyWord } from '../services/values';
import type { ParsedQuery, QueryNode, SortItem, Span, ValueNode } from './parser';
import { HAS_ATTRIBUTES, type TermDef } from './vocabulary';

export interface CompileContext {
  s: SchemaSnapshot;
  meId: string;
  today?: string;
}

export interface CompiledQuery {
  where: SQL | null;
  orderBy: SQL[];
  problems: QueryProblem[];
}

const TRUE = sql`TRUE`;
const FALSE = sql`FALSE`;

function list(values: (string | number)[]): SQL {
  return sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
}

function orAll(parts: SQL[]): SQL {
  if (!parts.length) return FALSE;
  if (parts.length === 1) return parts[0]!;
  return sql`(${sql.join(parts, sql` OR `)})`;
}

function andAll(parts: SQL[]): SQL {
  if (!parts.length) return TRUE;
  if (parts.length === 1) return parts[0]!;
  return sql`(${sql.join(parts, sql` AND `)})`;
}

/** Prefix full-text query: "login saf" -> 'login:* & saf:*' */
export function prefixTsQuery(text: string): string | null {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length > 0)
    .slice(0, 12);
  if (!words.length) return null;
  return words.map((w) => `${w}:*`).join(' & ');
}

function localMidnight(iso: string): Date {
  return new Date(`${iso}T00:00:00`);
}

class Compiler {
  problems: QueryProblem[] = [];
  private today: string;

  constructor(private cc: CompileContext) {
    this.today = cc.today ?? todayISO();
  }

  private problem(message: string, span: Span, hint?: string) {
    this.problems.push({ message, start: span.start, end: span.end, hint });
  }

  compile(node: QueryNode): SQL {
    switch (node.kind) {
      case 'and': {
        const texts = node.items.filter((n): n is Extract<QueryNode, { kind: 'text' }> => n.kind === 'text' && !n.exact);
        const others = node.items.filter((n) => !(n.kind === 'text' && !n.exact));
        const parts = others.map((n) => this.compile(n));
        if (texts.length) parts.push(this.textCondition(texts.map((t) => t.text).join(' '), false));
        return andAll(parts);
      }
      case 'or':
        return orAll(node.items.map((n) => this.compile(n)));
      case 'not':
        return sql`NOT ${this.compile(node.item)}`;
      case 'text':
        return this.textCondition(node.text, node.exact);
      case 'hash':
        return this.hash(node.value, node.span);
      case 'term':
        return this.term(node.def, node.values, node.span);
    }
  }

  // -------------------------------------------------------------------------
  // Free text
  // -------------------------------------------------------------------------

  private textCondition(text: string, exact: boolean): SQL {
    const parts: SQL[] = [];
    const readable = parseReadableId(text);
    if (readable) {
      const id = this.issueIdCondition(text, { start: 0, end: 0 }, true);
      if (id) parts.push(id);
    }
    if (exact) {
      const like = `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      parts.push(
        sql`(${issues.summary} ILIKE ${like} OR ${issues.description} ILIKE ${like} OR EXISTS (SELECT 1 FROM comments c WHERE c.issue_id = ${issues.id} AND c.deleted_at IS NULL AND c.text ILIKE ${like}))`,
      );
    } else {
      const q = prefixTsQuery(text);
      if (q) {
        parts.push(
          sql`(${issues.searchVector} @@ to_tsquery('english', ${q}) OR EXISTS (SELECT 1 FROM comments c WHERE c.issue_id = ${issues.id} AND c.deleted_at IS NULL AND c.search_vector @@ to_tsquery('english', ${q})))`,
        );
      }
    }
    return orAll(parts.length ? parts : [FALSE]);
  }

  // -------------------------------------------------------------------------
  // #values
  // -------------------------------------------------------------------------

  private hash(raw: string, span: Span): SQL {
    const lower = raw.toLowerCase();
    const s = this.cc.s;
    if (lower === 'unresolved') return sql`${issues.resolvedAt} IS NULL`;
    if (lower === 'resolved') return sql`${issues.resolvedAt} IS NOT NULL`;
    const assignee = this.assigneeField();
    if ((lower === 'me' || lower === 'my') && assignee) return this.customField(assignee, [{ kind: 'single', raw: 'me', negated: false, span }], span);
    if (lower === 'unassigned' && assignee) return sql`NOT ${this.fieldExists(assignee.id)}`;
    // Option values (e.g. #Critical, #Bug, #{In Progress})
    const matches: SQL[] = [];
    for (const f of s.fields.values()) {
      if (f.type !== 'enum' && f.type !== 'state' && f.type !== 'version') continue;
      const ids = (s.valuesByField.get(f.id) ?? []).filter((v) => v.name.toLowerCase() === lower).map((v) => v.id);
      if (ids.length) matches.push(this.optionIn(f.id, ids));
    }
    if (matches.length) return orAll(matches);
    const tag = s.tagsByName.get(lower);
    if (tag) return this.tagCondition([tag.name.toLowerCase()]);
    if (parseReadableId(raw)) {
      const c = this.issueIdCondition(raw, span);
      if (c) return c;
    }
    const options = [
      'Unresolved',
      'Resolved',
      ...[...s.tags.values()].map((t) => t.name),
      ...[...s.values.values()].map((v) => v.name),
    ];
    const guess = didYouMean(raw, options);
    this.problem(`Unknown value "#${raw}"`, span, guess ? `Did you mean "#${guess}"?` : 'Use #Unresolved, a field value such as #Critical, or a tag.');
    return FALSE;
  }

  // -------------------------------------------------------------------------
  // field: value terms
  // -------------------------------------------------------------------------

  private assigneeField(): FieldRow | undefined {
    const f = fieldByName(this.cc.s, 'Assignee');
    if (f?.type === 'user') return f;
    for (const field of this.cc.s.fields.values()) if (field.type === 'user') return field;
    return undefined;
  }

  private term(def: TermDef, values: ValueNode[], span: Span): SQL {
    const t = def.term;
    switch (t.kind) {
      case 'custom':
        return this.customField(t.field, values, span);
      case 'assigneeAlias': {
        const f = this.assigneeField();
        if (!f) {
          this.problem('There is no Assignee field', span);
          return FALSE;
        }
        return this.customField(f, values, span);
      }
      default:
        return this.combine(values, (v) => this.attributeValue(def, v));
    }
  }

  /** positives OR'ed, negatives AND NOT'ed */
  private combine(values: ValueNode[], one: (v: ValueNode) => SQL | null): SQL {
    const pos: SQL[] = [];
    const neg: SQL[] = [];
    for (const v of values) {
      const c = one(v.kind === 'single' && v.negated ? { ...v, negated: false } : v);
      if (!c) continue;
      if (v.kind === 'single' && v.negated) neg.push(sql`NOT ${c}`);
      else pos.push(c);
    }
    const parts: SQL[] = [];
    if (pos.length) parts.push(orAll(pos));
    parts.push(...neg);
    return andAll(parts);
  }

  private fieldExists(fieldId: string): SQL {
    return sql`EXISTS (SELECT 1 FROM issue_field_values ifv WHERE ifv.issue_id = ${issues.id} AND ifv.field_id = ${fieldId})`;
  }

  private optionIn(fieldId: string, valueIds: string[]): SQL {
    return sql`EXISTS (SELECT 1 FROM issue_field_values ifv WHERE ifv.issue_id = ${issues.id} AND ifv.field_id = ${fieldId} AND ifv.value_id IN (${list(valueIds)}))`;
  }

  private customField(field: FieldRow, values: ValueNode[], span: Span): SQL {
    const s = this.cc.s;
    return this.combine(values, (v) => {
      if (v.kind === 'single' && isEmptyWord(v.raw)) return sql`NOT ${this.fieldExists(field.id)}`;
      switch (field.type) {
        case 'enum':
        case 'state':
        case 'version': {
          if (v.kind === 'range') {
            this.problem(`Ranges are not supported for ${field.name}`, v.span);
            return null;
          }
          const lower = v.raw.toLowerCase();
          const ids = (s.valuesByField.get(field.id) ?? []).filter((x) => x.name.toLowerCase() === lower).map((x) => x.id);
          if (!ids.length) {
            const names = [...new Set((s.valuesByField.get(field.id) ?? []).map((x) => x.name))];
            const guess = didYouMean(v.raw, names);
            this.problem(`Unknown value "${v.raw}" for ${field.name}`, v.span, guess ? `Did you mean "${guess}"?` : `Values: ${names.join(', ')}`);
            return FALSE;
          }
          return this.optionIn(field.id, ids);
        }
        case 'user': {
          if (v.kind === 'range') {
            this.problem(`Ranges are not supported for ${field.name}`, v.span);
            return null;
          }
          const u = findUser(s, v.raw, this.cc.meId);
          if (!u) {
            const guess = didYouMean(v.raw, [...s.usersByLogin.keys()]);
            this.problem(`Unknown user "${v.raw}"`, v.span, guess ? `Did you mean "${guess}"?` : 'Use a login, a name, "me" or "Unassigned".');
            return FALSE;
          }
          return sql`EXISTS (SELECT 1 FROM issue_field_values ifv WHERE ifv.issue_id = ${issues.id} AND ifv.field_id = ${field.id} AND ifv.user_id = ${u.id})`;
        }
        case 'string':
        case 'text': {
          const raw = v.kind === 'single' ? v.raw : `${v.from ?? ''}`;
          const like = `%${raw.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
          return sql`EXISTS (SELECT 1 FROM issue_field_values ifv WHERE ifv.issue_id = ${issues.id} AND ifv.field_id = ${field.id} AND ifv.text_value ILIKE ${like})`;
        }
        case 'integer':
        case 'float':
        case 'period': {
          const parse = (x: string | null): number | null | undefined => {
            if (x === null) return null;
            const n = field.type === 'period' ? parsePeriod(x) : Number(x);
            return n === null || Number.isNaN(n) ? undefined : n;
          };
          const col = sql`ifv.number_value`;
          if (v.kind === 'single') {
            const n = parse(v.raw);
            if (n === undefined || n === null) {
              this.problem(`"${v.raw}" is not a valid ${field.type === 'period' ? 'duration' : 'number'} for ${field.name}`, v.span);
              return FALSE;
            }
            return sql`EXISTS (SELECT 1 FROM issue_field_values ifv WHERE ifv.issue_id = ${issues.id} AND ifv.field_id = ${field.id} AND ${col} = ${n})`;
          }
          const from = parse(v.from);
          const to = parse(v.to);
          if (from === undefined || to === undefined) {
            this.problem(`Invalid range for ${field.name}`, v.span);
            return FALSE;
          }
          const conds = [sql`ifv.issue_id = ${issues.id}`, sql`ifv.field_id = ${field.id}`];
          if (from !== null) conds.push(sql`${col} >= ${from}`);
          if (to !== null) conds.push(sql`${col} <= ${to}`);
          return sql`EXISTS (SELECT 1 FROM issue_field_values ifv WHERE ${sql.join(conds, sql` AND `)})`;
        }
        case 'date': {
          const range = this.dateRange(v, field.name);
          if (!range) return FALSE;
          const conds = [sql`ifv.issue_id = ${issues.id}`, sql`ifv.field_id = ${field.id}`];
          if (range.from) conds.push(sql`ifv.date_value >= ${range.from}`);
          if (range.to) conds.push(sql`ifv.date_value < ${range.to}`);
          return sql`EXISTS (SELECT 1 FROM issue_field_values ifv WHERE ${sql.join(conds, sql` AND `)})`;
        }
      }
    });
  }

  private dateRange(v: ValueNode, what: string): DateRange | null {
    if (v.kind === 'single') {
      const r = parseDateExpression(v.raw, this.today);
      if (!r) this.problem(`"${v.raw}" is not a date for ${what}`, v.span, 'Use YYYY-MM-DD, today, {this week}, -7d or a range "a .. b".');
      return r;
    }
    const from = v.from ? parseDateExpression(v.from, this.today) : null;
    const to = v.to ? parseDateExpression(v.to, this.today) : null;
    if ((v.from && !from) || (v.to && !to)) {
      this.problem(`Invalid date range for ${what}`, v.span, 'Use e.g. 2026-01-01 .. 2026-01-31 or -7d .. today');
      return null;
    }
    return { from: from?.from ?? null, to: to?.to ?? null };
  }

  private issueIdCondition(raw: string, span: Span, silent = false): SQL | null {
    const parsed = parseReadableId(raw);
    const p = parsed ? this.cc.s.projectsByKey.get(parsed.key) : undefined;
    if (!parsed || !p) {
      if (!silent) this.problem(`"${raw}" is not an issue id`, span, 'Issue ids look like BACK-12.');
      return silent ? null : FALSE;
    }
    return sql`(${issues.projectId} = ${p.id} AND ${issues.number} = ${parsed.number})`;
  }

  private issueIdSubquery(raw: string, span: Span): SQL | null {
    const parsed = parseReadableId(raw);
    const p = parsed ? this.cc.s.projectsByKey.get(parsed.key) : undefined;
    if (!parsed || !p) {
      this.problem(`"${raw}" is not an issue id`, span, 'Issue ids look like BACK-12.');
      return null;
    }
    return sql`(SELECT x.id FROM issues x WHERE x.project_id = ${p.id} AND x.number = ${parsed.number})`;
  }

  private tagCondition(lowerNames: string[]): SQL {
    return sql`EXISTS (SELECT 1 FROM issue_tags it JOIN tags t ON t.id = it.tag_id WHERE it.issue_id = ${issues.id} AND lower(t.name) IN (${list(lowerNames)}))`;
  }

  private attributeValue(def: TermDef, v: ValueNode): SQL | null {
    const s = this.cc.s;
    const t = def.term;
    const single = v.kind === 'single' ? v.raw : null;
    switch (t.kind) {
      case 'project': {
        if (!single) return this.rangeNotSupported(def, v);
        const lower = single.toLowerCase();
        const p = s.projectsByKey.get(single.toUpperCase()) ?? [...s.projects.values()].find((x) => x.name.toLowerCase() === lower);
        if (!p) {
          const guess = didYouMean(single, [...s.projects.values()].flatMap((x) => [x.key, x.name]));
          this.problem(`Unknown project "${single}"`, v.span, guess ? `Did you mean "${guess}"?` : undefined);
          return FALSE;
        }
        return sql`${issues.projectId} = ${p.id}`;
      }
      case 'issueId':
        if (!single) return this.rangeNotSupported(def, v);
        return this.issueIdCondition(single, v.span);
      case 'textAttr': {
        if (!single) return this.rangeNotSupported(def, v);
        const col = t.column === 'summary' ? issues.summary : issues.description;
        const q = prefixTsQuery(single);
        const like = `%${single.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
        return q ? sql`(to_tsvector('english', coalesce(${col}, '')) @@ to_tsquery('english', ${q}) OR ${col} ILIKE ${like})` : sql`${col} ILIKE ${like}`;
      }
      case 'userAttr': {
        if (!single) return this.rangeNotSupported(def, v);
        const u = findUser(s, single, this.cc.meId);
        if (!u) {
          const guess = didYouMean(single, [...s.usersByLogin.keys()]);
          this.problem(`Unknown user "${single}"`, v.span, guess ? `Did you mean "${guess}"?` : undefined);
          return FALSE;
        }
        if (t.column === 'reporter') return sql`${issues.reporterId} = ${u.id}`;
        if (t.column === 'updatedBy') return sql`${issues.updatedById} = ${u.id}`;
        return sql`EXISTS (SELECT 1 FROM comments c WHERE c.issue_id = ${issues.id} AND c.deleted_at IS NULL AND c.author_id = ${u.id})`;
      }
      case 'dateAttr': {
        const range = this.dateRange(v, def.name);
        if (!range) return FALSE;
        const col = t.column === 'created' ? issues.createdAt : t.column === 'updated' ? issues.updatedAt : issues.resolvedAt;
        const conds: SQL[] = [sql`${col} IS NOT NULL`];
        if (range.from) conds.push(sql`${col} >= ${localMidnight(range.from)}`);
        if (range.to) conds.push(sql`${col} < ${localMidnight(range.to)}`);
        return andAll(conds);
      }
      case 'tag': {
        if (!single) return this.rangeNotSupported(def, v);
        if (!s.tagsByName.has(single.toLowerCase())) {
          const guess = didYouMean(single, [...s.tags.values()].map((x) => x.name));
          this.problem(`Unknown tag "${single}"`, v.span, guess ? `Did you mean "${guess}"?` : undefined);
          return FALSE;
        }
        return this.tagCondition([single.toLowerCase()]);
      }
      case 'has':
        if (!single) return this.rangeNotSupported(def, v);
        return this.hasCondition(single, v.span);
      case 'sprint':
        if (!single) return this.rangeNotSupported(def, v);
        return sql`EXISTS (SELECT 1 FROM sprint_issues si JOIN sprints sp ON sp.id = si.sprint_id WHERE si.issue_id = ${issues.id} AND lower(sp.name) = ${single.toLowerCase()})`;
      case 'spent': {
        const total = sql`(SELECT coalesce(sum(w.minutes), 0) FROM work_items w WHERE w.issue_id = ${issues.id})`;
        if (v.kind === 'single') {
          const n = parsePeriod(v.raw);
          if (n === null) {
            this.problem(`"${v.raw}" is not a duration`, v.span);
            return FALSE;
          }
          return sql`${total} = ${n}`;
        }
        const from = v.from ? parsePeriod(v.from) : null;
        const to = v.to ? parsePeriod(v.to) : null;
        const conds: SQL[] = [];
        if (from !== null) conds.push(sql`${total} >= ${from}`);
        if (to !== null) conds.push(sql`${total} <= ${to}`);
        return andAll(conds);
      }
      case 'links': {
        if (!single) return this.rangeNotSupported(def, v);
        const other = this.issueIdSubquery(single, v.span);
        if (!other) return FALSE;
        return sql`EXISTS (SELECT 1 FROM issue_links l WHERE (l.source_id = ${issues.id} AND l.target_id = ${other}) OR (l.target_id = ${issues.id} AND l.source_id = ${other}))`;
      }
      case 'linkPhrase': {
        if (!single) return this.rangeNotSupported(def, v);
        const phrase = s.linkPhrases.find((p) => p.phrase === t.phrase);
        const other = this.issueIdSubquery(single, v.span);
        if (!phrase || !other) return FALSE;
        if (phrase.direction === 'outward') {
          return sql`EXISTS (SELECT 1 FROM issue_links l WHERE l.type_id = ${phrase.type.id} AND l.source_id = ${issues.id} AND l.target_id = ${other})`;
        }
        if (phrase.direction === 'inward') {
          return sql`EXISTS (SELECT 1 FROM issue_links l WHERE l.type_id = ${phrase.type.id} AND l.target_id = ${issues.id} AND l.source_id = ${other})`;
        }
        return sql`EXISTS (SELECT 1 FROM issue_links l WHERE l.type_id = ${phrase.type.id} AND ((l.source_id = ${issues.id} AND l.target_id = ${other}) OR (l.target_id = ${issues.id} AND l.source_id = ${other})))`;
      }
      default:
        return null;
    }
  }

  private rangeNotSupported(def: TermDef, v: ValueNode): SQL {
    this.problem(`Ranges are not supported for ${def.name}`, v.span);
    return FALSE;
  }

  private hasCondition(raw: string, span: Span): SQL {
    const lower = raw.toLowerCase();
    const s = this.cc.s;
    const field = fieldByName(s, raw);
    if (field) return this.fieldExists(field.id);
    const aggregation = s.linkTypes.filter((t) => t.aggregation).map((t) => t.id);
    switch (lower) {
      case 'description':
        return sql`${issues.description} <> ''`;
      case 'comments':
      case 'comment':
        return sql`EXISTS (SELECT 1 FROM comments c WHERE c.issue_id = ${issues.id} AND c.deleted_at IS NULL)`;
      case 'links':
        return sql`EXISTS (SELECT 1 FROM issue_links l WHERE l.source_id = ${issues.id} OR l.target_id = ${issues.id})`;
      case 'tags':
      case 'tag':
        return sql`EXISTS (SELECT 1 FROM issue_tags it WHERE it.issue_id = ${issues.id})`;
      case 'subtasks':
        if (!aggregation.length) return FALSE;
        return sql`EXISTS (SELECT 1 FROM issue_links l WHERE l.source_id = ${issues.id} AND l.type_id IN (${list(aggregation)}))`;
      case 'parent':
        if (!aggregation.length) return FALSE;
        return sql`EXISTS (SELECT 1 FROM issue_links l WHERE l.target_id = ${issues.id} AND l.type_id IN (${list(aggregation)}))`;
      case 'work':
      case 'spent time':
        return sql`EXISTS (SELECT 1 FROM work_items w WHERE w.issue_id = ${issues.id})`;
    }
    const guess = didYouMean(raw, [...[...s.fields.values()].map((f) => f.name), ...HAS_ATTRIBUTES]);
    this.problem(`Unknown attribute "${raw}" for has:`, span, guess ? `Did you mean "${guess}"?` : undefined);
    return FALSE;
  }

  // -------------------------------------------------------------------------
  // sort
  // -------------------------------------------------------------------------

  orderBy(items: SortItem[]): SQL[] {
    const out: SQL[] = [];
    for (const item of items) {
      const dir = item.dir === 'desc' ? sql`DESC` : sql`ASC`;
      for (const expr of this.sortExprs(item.field)) out.push(sql`${expr} ${dir} NULLS LAST`);
    }
    if (!items.length) out.push(sql`${issues.updatedAt} DESC`);
    out.push(sql`${issues.id} ASC`);
    return out;
  }

  private sortExprs(name: string): SQL[] {
    if (name === 'issue id') return [sql`(SELECT p.key FROM projects p WHERE p.id = ${issues.projectId})`, sql`${issues.number}`];
    const e = this.sortExpr(name);
    return e ? [e] : [];
  }

  private sortExpr(name: string): SQL | null {
    switch (name) {
      case 'created':
        return sql`${issues.createdAt}`;
      case 'updated':
        return sql`${issues.updatedAt}`;
      case 'resolved date':
        return sql`${issues.resolvedAt}`;
      case 'summary':
        return sql`lower(${issues.summary})`;
      case 'spent time':
        return sql`(SELECT coalesce(sum(w.minutes), 0) FROM work_items w WHERE w.issue_id = ${issues.id})`;
    }
    const field = fieldByName(this.cc.s, name);
    if (!field) return null;
    switch (field.type) {
      case 'enum':
      case 'state':
      case 'version':
        return sql`(SELECT min(fv.ordinal) FROM issue_field_values ifv JOIN field_values fv ON fv.id = ifv.value_id WHERE ifv.issue_id = ${issues.id} AND ifv.field_id = ${field.id})`;
      case 'user':
        return sql`(SELECT min(lower(u.login)) FROM issue_field_values ifv JOIN users u ON u.id = ifv.user_id WHERE ifv.issue_id = ${issues.id} AND ifv.field_id = ${field.id})`;
      case 'date':
        return sql`(SELECT min(ifv.date_value) FROM issue_field_values ifv WHERE ifv.issue_id = ${issues.id} AND ifv.field_id = ${field.id})`;
      case 'string':
      case 'text':
        return sql`(SELECT min(lower(ifv.text_value)) FROM issue_field_values ifv WHERE ifv.issue_id = ${issues.id} AND ifv.field_id = ${field.id})`;
      default:
        return sql`(SELECT min(ifv.number_value) FROM issue_field_values ifv WHERE ifv.issue_id = ${issues.id} AND ifv.field_id = ${field.id})`;
    }
  }
}

export function compileQuery(parsed: ParsedQuery, cc: CompileContext): CompiledQuery {
  const c = new Compiler(cc);
  const where = parsed.root ? c.compile(parsed.root) : null;
  const orderBy = c.orderBy(parsed.sort);
  // Report problems left to right, whichever stage found them.
  const problems = [...parsed.problems, ...c.problems].sort((a, b) => a.start - b.start || a.end - b.end);
  return { where, orderBy, problems };
}
