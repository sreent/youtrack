import type { QueryProblem, SuggestItem } from '@a4a/shared';
import { lex, type Token } from '../search/lexer';
import { didYouMean } from '../lib/text';
import { allowedValues, type FieldRow, type LinkPhrase, type SchemaSnapshot } from '../services/schema-cache';
import { isEmptyWord } from '../services/values';

export type CommandOp =
  | { kind: 'field'; field: FieldRow; mode: 'set' | 'add' | 'remove'; raw: string[]; display: string }
  | { kind: 'tag'; mode: 'add' | 'remove'; name: string }
  | { kind: 'link'; mode: 'add' | 'remove'; phrase: LinkPhrase; targets: string[] }
  | { kind: 'comment'; text: string };

export interface ParsedCommand {
  ops: CommandOp[];
  problems: QueryProblem[];
}

const PERIOD_TOKEN = /^\d+(\.\d+)?[wdhm]$/i;
const ISSUE_ID = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

interface Phrase<T> {
  words: string[];
  item: T;
}

function phrases<T>(entries: [string, T][]): Phrase<T>[] {
  return entries
    .map(([text, item]) => ({ words: text.toLowerCase().split(/\s+/).filter(Boolean), item }))
    .filter((p) => p.words.length > 0)
    .sort((a, b) => b.words.length - a.words.length);
}

class CommandParser {
  private pos = 0;
  problems: QueryProblem[] = [];
  ops: CommandOp[] = [];
  private fieldPhrases: Phrase<FieldRow>[];
  private linkPhrases: Phrase<LinkPhrase>[];
  private valuePhrases: Phrase<{ field: FieldRow; value: string }>[];
  private fieldsInScope: FieldRow[];

  constructor(
    private input: string,
    private tokens: Token[],
    private s: SchemaSnapshot,
    projectIds: string[],
  ) {
    const fieldIds = new Set<string>();
    for (const pid of projectIds) for (const pf of s.projectFields.get(pid) ?? []) fieldIds.add(pf.fieldId);
    this.fieldsInScope = [...fieldIds].map((id) => s.fields.get(id)!).filter(Boolean);
    this.fieldPhrases = phrases(this.fieldsInScope.map((f) => [f.name, f]));
    this.linkPhrases = phrases(s.linkPhrases.map((p) => [p.phrase, p]));
    const valueEntries: [string, { field: FieldRow; value: string }][] = [];
    for (const f of this.fieldsInScope) {
      if (f.type !== 'enum' && f.type !== 'state' && f.type !== 'version') continue;
      const names = new Set<string>();
      for (const pid of projectIds) for (const v of allowedValues(s, f.id, pid)) names.add(v.name);
      for (const n of names) valueEntries.push([n, { field: f, value: n }]);
    }
    this.valuePhrases = phrases(valueEntries);
  }

  private peek(o = 0) {
    return this.tokens[this.pos + o];
  }

  private word(o = 0): string | null {
    const t = this.peek(o);
    return t?.kind === 'word' ? t.value.toLowerCase() : null;
  }

  private problem(message: string, t: Token | undefined, hint?: string) {
    const start = t?.start ?? this.input.length;
    this.problems.push({ message, start, end: t?.end ?? start, hint });
  }

  /** Longest phrase matching the upcoming words. */
  private matchPhrase<T>(list: Phrase<T>[]): { item: T; length: number }[] {
    const out: { item: T; length: number }[] = [];
    let best = 0;
    for (const p of list) {
      if (p.words.length < best) break;
      let ok = true;
      for (let i = 0; i < p.words.length; i++) {
        if (this.word(i) !== p.words[i]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        best = p.words.length;
        out.push({ item: p.item, length: p.words.length });
      }
    }
    return out;
  }

  /** Does a new clause start at the current position? */
  private atClauseStart(): boolean {
    const w = this.word();
    if (!w) return false;
    if (['add', 'remove', 'tag', 'untag', 'for', 'comment'].includes(w)) return true;
    return this.matchPhrase(this.fieldPhrases).length > 0 || this.matchPhrase(this.linkPhrases).length > 0;
  }

  parse(): ParsedCommand {
    while (this.pos < this.tokens.length) this.clause();
    return { ops: this.ops, problems: this.problems };
  }

  private clause() {
    const t = this.peek()!;
    if (t.kind === 'comma') {
      this.pos++;
      return;
    }
    if (t.kind === 'hash') {
      this.pos++;
      if (t.value) this.ops.push({ kind: 'tag', mode: 'add', name: t.value });
      return;
    }
    let mode: 'set' | 'add' | 'remove' = 'set';
    const w = this.word();
    if (w === 'add' || w === 'remove') {
      mode = w;
      this.pos++;
      if (!this.peek()) {
        this.problem(`Expected something to ${w}`, t);
        return;
      }
    }
    const w2 = this.word();
    if (w2 === 'tag' || w2 === 'tags') {
      this.pos++;
      const name = this.readAtom();
      if (!name) return this.problem('Expected a tag name', this.peek() ?? t);
      this.ops.push({ kind: 'tag', mode: mode === 'remove' ? 'remove' : 'add', name });
      return;
    }
    if (w2 === 'untag') {
      this.pos++;
      const name = this.readAtom();
      if (!name) return this.problem('Expected a tag name after untag', this.peek() ?? t);
      this.ops.push({ kind: 'tag', mode: 'remove', name });
      return;
    }
    if (w2 === 'comment') {
      const start = this.peek()!.end;
      this.ops.push({ kind: 'comment', text: this.input.slice(start).trim() });
      this.pos = this.tokens.length;
      return;
    }
    if (w2 === 'for') {
      this.pos++;
      const assignee = this.fieldsInScope.find((f) => f.type === 'user' && f.name.toLowerCase() === 'assignee') ?? this.fieldsInScope.find((f) => f.type === 'user');
      if (!assignee) return this.problem('These issues have no Assignee field', t);
      const user = this.readUser();
      if (!user) return this.problem('Expected a user after "for"', this.peek() ?? t);
      this.ops.push({ kind: 'field', field: assignee, mode: 'set', raw: [user], display: `${assignee.name} ${user}` });
      return;
    }
    const link = this.matchPhrase(this.linkPhrases)[0];
    if (link) {
      this.pos += link.length;
      const targets: string[] = [];
      while (this.peek()) {
        const tok = this.peek()!;
        if (tok.kind === 'word' && ISSUE_ID.test(tok.value)) {
          targets.push(tok.value.toUpperCase());
          this.pos++;
          if (this.peek()?.kind === 'comma') this.pos++;
          continue;
        }
        break;
      }
      if (!targets.length) return this.problem(`Expected an issue id after "${link.item.display}"`, this.peek() ?? t);
      this.ops.push({ kind: 'link', mode: mode === 'remove' ? 'remove' : 'add', phrase: link.item, targets });
      return;
    }
    const field = this.matchPhrase(this.fieldPhrases)[0];
    if (field) {
      const fieldTok = this.peek()!;
      this.pos += field.length;
      const raw = this.readFieldValue(field.item);
      if (raw === null) return this.problem(`Expected a value for ${field.item.name}`, this.peek() ?? fieldTok);
      const effective = mode === 'set' && field.item.multi ? 'add' : mode;
      this.ops.push({ kind: 'field', field: field.item, mode: effective, raw: [raw], display: `${field.item.name} ${raw}` });
      return;
    }
    const values = this.matchPhrase(this.valuePhrases);
    if (values.length) {
      const fieldsHit = [...new Map(values.map((v) => [v.item.field.id, v.item])).values()];
      const tok = this.peek()!;
      this.pos += values[0]!.length;
      if (fieldsHit.length > 1) {
        this.problem(
          `"${values[0]!.item.value}" is a value of ${fieldsHit.map((f) => f.field.name).join(' and ')}`,
          tok,
          `Say which one, e.g. "${fieldsHit[0]!.field.name} ${values[0]!.item.value}"`,
        );
        return;
      }
      const hit = fieldsHit[0]!;
      const effective = mode === 'set' && hit.field.multi ? 'add' : mode;
      this.ops.push({ kind: 'field', field: hit.field, mode: effective, raw: [hit.value], display: `${hit.field.name} ${hit.value}` });
      return;
    }
    // Unknown word
    const tok = this.peek()!;
    this.pos++;
    const vocabulary = [
      ...this.fieldsInScope.map((f) => f.name),
      ...this.valuePhrases.map((v) => v.item.value),
      ...this.s.linkPhrases.map((p) => p.display),
      'tag',
      'untag',
      'for',
      'add',
      'remove',
      'comment',
    ];
    const guess = didYouMean(tok.value, vocabulary);
    this.problem(`Unknown command "${tok.value}"`, tok, guess ? `Did you mean "${guess}"?` : 'Use a field name and value, e.g. "State Fixed", or "tag urgent".');
  }

  /** quoted / braced / single word */
  private readAtom(): string | null {
    const t = this.peek();
    if (!t) return null;
    if (t.kind === 'quoted' || t.kind === 'braced' || t.kind === 'word' || t.kind === 'hash') {
      this.pos++;
      return t.value;
    }
    return null;
  }

  private readUser(): string | null {
    const t = this.peek();
    if (!t) return null;
    if (t.kind === 'quoted' || t.kind === 'braced') {
      this.pos++;
      return t.value;
    }
    // Greedy match over full names (2-4 words) before falling back to a login.
    const names = [...this.s.users.values()].map((u) => u.name.toLowerCase());
    for (let k = 4; k >= 2; k--) {
      const words: string[] = [];
      for (let i = 0; i < k; i++) {
        const w = this.word(i);
        if (!w) break;
        words.push(w);
      }
      if (words.length === k && names.includes(words.join(' '))) {
        const raw = this.tokens
          .slice(this.pos, this.pos + k)
          .map((x) => x.value)
          .join(' ');
        this.pos += k;
        return raw;
      }
    }
    if (t.kind === 'word') {
      this.pos++;
      return t.value;
    }
    return null;
  }

  private readFieldValue(field: FieldRow): string | null {
    const t = this.peek();
    if (!t) return null;
    if (t.kind === 'quoted' || t.kind === 'braced') {
      this.pos++;
      return t.value;
    }
    if (t.kind !== 'word') return null;
    if (isEmptyWord(t.value)) {
      this.pos++;
      return 'none';
    }
    switch (field.type) {
      case 'enum':
      case 'state':
      case 'version': {
        const candidates = this.valuePhrases.filter((v) => v.item.field.id === field.id);
        const hit = this.matchPhrase(candidates)[0];
        if (hit) {
          this.pos += hit.length;
          return hit.item.value;
        }
        const guess = didYouMean(t.value, candidates.map((c) => c.item.value));
        this.problem(`Unknown value "${t.value}" for ${field.name}`, t, guess ? `Did you mean "${guess}"?` : `Values: ${candidates.map((c) => c.item.value).join(', ')}`);
        this.pos++;
        return null;
      }
      case 'user':
        return this.readUser();
      case 'period': {
        const parts: string[] = [];
        while (this.peek()?.kind === 'word' && PERIOD_TOKEN.test(this.peek()!.value)) {
          parts.push(this.peek()!.value);
          this.pos++;
        }
        if (!parts.length) {
          if (/^\d+$/.test(t.value)) {
            this.pos++;
            return t.value;
          }
          this.problem(`"${t.value}" is not a duration for ${field.name}`, t, 'Use e.g. 2d, 4h or 1w 2d');
          this.pos++;
          return null;
        }
        return parts.join(' ');
      }
      default: {
        // date, numbers, strings: one word (strings may be multi-word until the next clause)
        if (field.type === 'string' || field.type === 'text') {
          const parts: string[] = [];
          while (this.peek()?.kind === 'word' && (parts.length === 0 || !this.atClauseStart())) {
            parts.push(this.peek()!.value);
            this.pos++;
          }
          return parts.join(' ');
        }
        this.pos++;
        return t.value;
      }
    }
  }
}

export function parseCommand(input: string, s: SchemaSnapshot, projectIds: string[]): ParsedCommand {
  const { tokens, problems } = lex(input);
  const parser = new CommandParser(input, tokens, s, projectIds);
  const result = parser.parse();
  return { ops: result.ops, problems: [...problems, ...result.problems] };
}

export function describeCommand(ops: CommandOp[]): string {
  if (!ops.length) return 'No changes';
  return ops
    .map((op) => {
      switch (op.kind) {
        case 'field':
          return op.mode === 'remove'
            ? `remove ${op.raw.join(', ')} from ${op.field.name}`
            : op.mode === 'add'
              ? `add ${op.raw.join(', ')} to ${op.field.name}`
              : `set ${op.field.name} to ${op.raw.join(', ')}`;
        case 'tag':
          return `${op.mode === 'add' ? 'add' : 'remove'} tag ${op.name}`;
        case 'link':
          return `${op.mode === 'add' ? 'link' : 'unlink'}: ${op.phrase.display} ${op.targets.join(', ')}`;
        case 'comment':
          return 'add a comment';
      }
    })
    .join('; ');
}

/** Completions for the command dialog. */
export function suggestCommand(input: string, caret: number, s: SchemaSnapshot, projectIds: string[], limit = 20): SuggestItem[] {
  const before = input.slice(0, caret);
  const m = /(\S*)$/.exec(before);
  const prefix = (m?.[1] ?? '').toLowerCase();
  const replaceStart = caret - (m?.[1]?.length ?? 0);
  const out: SuggestItem[] = [];
  const push = (label: string, insert: string, kind: SuggestItem['kind'], description?: string) => {
    if (out.length < limit && (!prefix || label.toLowerCase().startsWith(prefix) || label.toLowerCase().split(/\s+/).some((w) => w.startsWith(prefix)))) {
      out.push({ label, insert, kind, description, replaceStart, replaceEnd: caret });
    }
  };
  const fieldIds = new Set<string>();
  for (const pid of projectIds) for (const pf of s.projectFields.get(pid) ?? []) fieldIds.add(pf.fieldId);
  const fields = [...fieldIds].map((id) => s.fields.get(id)!).filter(Boolean);
  // After a field name -> its values
  const words = before.toLowerCase().trimEnd().split(/\s+/);
  const prevText = (prefix ? words.slice(0, -1) : words).join(' ');
  const afterField = fields.find((f) => prevText.endsWith(f.name.toLowerCase()));
  if (afterField) {
    if (afterField.type === 'user') {
      push('me', 'me ', 'user');
      for (const u of s.users.values()) if (!u.banned) push(u.login, `${u.login} `, 'user', u.name);
    } else {
      const names = new Set<string>();
      for (const pid of projectIds) for (const v of allowedValues(s, afterField.id, pid)) names.add(v.name);
      for (const n of names) push(n, `${n} `, 'value', afterField.name);
    }
    if (out.length) return out;
  }
  for (const f of fields) push(f.name, `${f.name} `, 'field', f.type);
  for (const f of fields) {
    if (f.type !== 'enum' && f.type !== 'state' && f.type !== 'version') continue;
    const names = new Set<string>();
    for (const pid of projectIds) for (const v of allowedValues(s, f.id, pid)) names.add(v.name);
    for (const n of names) push(n, `${n} `, 'value', f.name);
  }
  for (const p of s.linkPhrases) push(p.display, `${p.display} `, 'keyword', 'Link to another issue');
  for (const k of ['tag', 'untag', 'for me', 'remove', 'add', 'comment']) push(k, `${k} `, 'keyword');
  return out;
}
