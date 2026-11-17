import { isOwnAgent, type QueryProblem, type SuggestItem, isOptionType } from '@a4a/shared';
import type { Translator } from '@a4a/shared/i18n';
import { translatorFor } from '../i18n';
import { fixValue, lex, type Token } from '../search/lexer';
import { guessWords, keyedProblem, type QueryProblemWords } from '../lib/errors';
import { didYouMean, editDistance } from '../lib/text';
import { actionsFor, allowedValues, machinesFor, transitionsOf, type FieldRow, type LinkPhrase, type SchemaSnapshot } from '../services/schema-cache';
import { isEmptyWord } from '../services/values';

export type CommandOp =
  | { kind: 'field'; field: FieldRow; mode: 'set' | 'add' | 'remove'; raw: string[]; display: string }
  | { kind: 'tag'; mode: 'add' | 'remove'; name: string }
  | { kind: 'link'; mode: 'add' | 'remove'; phrase: LinkPhrase; targets: string[] }
  /** `at`: where the comment clause starts in the command, so it can be taken out. */
  | { kind: 'comment'; text: string; at: number }
  /** A project's custom action, by name (D40): what it does is read in each issue's project. */
  | { kind: 'action'; name: string }
  /** A state machine's transition, by name (D40): its field moves to `to`, by that transition. */
  | { kind: 'transition'; name: string; field: string; to: string }
  /** Into or out of a sprint of a board of the issue's project, by its name (D43). */
  | { kind: 'sprint'; mode: 'add' | 'remove'; name: string };

type Named = { kind: 'action'; name: string } | { kind: 'transition'; name: string; field: string; to: string };

/** The names of the custom actions and transitions in these projects, which read as commands. */
export function namedCommands(s: SchemaSnapshot, projectIds: string[]): Named[] {
  const out = new Map<string, Named>();
  for (const pid of projectIds) {
    for (const a of actionsFor(s, pid)) if (a.enabled && !out.has(a.name.toLowerCase())) out.set(a.name.toLowerCase(), { kind: 'action', name: a.name });
    for (const m of machinesFor(s, pid)) {
      if (!m.enabled) continue;
      const field = s.fields.get(m.fieldId)?.name ?? '';
      for (const t of transitionsOf(m)) if (!out.has(t.name.toLowerCase())) out.set(t.name.toLowerCase(), { kind: 'transition', name: t.name, field, to: t.to });
    }
  }
  return [...out.values()];
}

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
  private namedPhrases: Phrase<Named>[];
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
      if (!isOptionType(f.type)) continue;
      const names = new Set<string>();
      for (const pid of projectIds) for (const v of allowedValues(s, f.id, pid)) names.add(v.name);
      for (const n of names) valueEntries.push([n, { field: f, value: n }]);
    }
    this.valuePhrases = phrases(valueEntries);
    this.namedPhrases = phrases(namedCommands(s, projectIds).map((n) => [n.name, n]));
  }

  private peek(o = 0) {
    return this.tokens[this.pos + o];
  }

  private word(o = 0): string | null {
    const t = this.peek(o);
    return t?.kind === 'word' ? t.value.toLowerCase() : null;
  }

  /**
   * `words` say it on a page in another language (D49); the API carries the English. `fix` is the
   * text to put in the token's place, when there's a likely one.
   */
  private problem(words: QueryProblemWords, message: string, t: Token | undefined, hint?: string, fix?: string | null) {
    const start = t?.start ?? this.input.length;
    this.problems.push(keyedProblem({ message, start, end: t?.end ?? start, hint, ...(fix ? { fix } : {}) }, words.key, words.values));
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
    if (w === 'sprint' && this.sprintClause()) return true;
    return this.matchPhrase(this.fieldPhrases).length > 0 || this.matchPhrase(this.linkPhrases).length > 0 || this.matchPhrase(this.namedPhrases).length > 0;
  }

  /**
   * "sprint" begins the sprint clause (D43), unless the issues have a field called Sprint: then it
   * is that field, as it always was.
   */
  private sprintClause(): boolean {
    return !this.fieldsInScope.some((f) => f.name.toLowerCase() === 'sprint' || f.name.toLowerCase() === 'sprints');
  }

  /** A sprint's name: one quoted or braced token, or the words up to the next clause. */
  private readSprintName(): string | null {
    const t = this.peek();
    if (!t) return null;
    if (t.kind === 'quoted' || t.kind === 'braced') {
      this.pos++;
      return t.value;
    }
    const first = this.pos;
    while (this.peek() && this.peek()!.kind !== 'comma' && this.peek()!.kind !== 'hash' && (this.pos === first || !this.atClauseStart())) this.pos++;
    if (this.pos === first) return null;
    return this.input.slice(this.tokens[first]!.start, this.tokens[this.pos - 1]!.end).trim() || null;
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
        this.problem({ key: 'command.somethingTo', values: { word: w } }, `Expected something to ${w}`, t);
        return;
      }
    }
    const w2 = this.word();
    if (w2 === 'tag' || w2 === 'tags') {
      this.pos++;
      const name = this.readAtom();
      if (!name) return this.problem({ key: 'command.tagName' }, 'Expected a tag name', this.peek() ?? t);
      this.ops.push({ kind: 'tag', mode: mode === 'remove' ? 'remove' : 'add', name });
      return;
    }
    if (w2 === 'untag') {
      this.pos++;
      const name = this.readAtom();
      if (!name) return this.problem({ key: 'command.tagNameAfterUntag' }, 'Expected a tag name after untag', this.peek() ?? t);
      this.ops.push({ kind: 'tag', mode: 'remove', name });
      return;
    }
    if (w2 === 'comment') {
      const start = this.peek()!.end;
      this.ops.push({ kind: 'comment', text: this.input.slice(start).trim(), at: this.peek()!.start });
      this.pos = this.tokens.length;
      return;
    }
    if ((w2 === 'sprint' || w2 === 'sprints') && this.sprintClause()) {
      this.pos++;
      const name = this.readSprintName();
      if (!name) return this.problem({ key: 'command.sprintName' }, 'Expected the name of a sprint', this.peek() ?? t, 'e.g. "sprint Sprint 4", or "remove sprint Sprint 4"');
      this.ops.push({ kind: 'sprint', mode: mode === 'remove' ? 'remove' : 'add', name });
      return;
    }
    if (w2 === 'for') {
      this.pos++;
      const assignee = this.fieldsInScope.find((f) => f.type === 'user' && f.name.toLowerCase() === 'assignee') ?? this.fieldsInScope.find((f) => f.type === 'user');
      if (!assignee) return this.problem({ key: 'command.noAssigneeField' }, 'These issues have no Assignee field', t);
      const user = this.readUser();
      if (!user) return this.problem({ key: 'command.userAfterFor' }, 'Expected a user after "for"', this.peek() ?? t);
      this.ops.push({ kind: 'field', field: assignee, mode: 'set', raw: [user], display: `${assignee.name} ${user}` });
      return;
    }
    // An action or a transition, by its name, when no field, link or value reads longer: a value
    // as long as it wins, since setting it goes by the machine's transition anyway.
    const named = mode === 'set' ? this.matchPhrase(this.namedPhrases)[0] : undefined;
    if (named) {
      const longest = Math.max(
        this.matchPhrase(this.linkPhrases)[0]?.length ?? 0,
        this.matchPhrase(this.fieldPhrases)[0]?.length ?? 0,
        this.matchPhrase(this.valuePhrases)[0]?.length ?? 0,
      );
      if (named.length > longest) {
        this.pos += named.length;
        this.ops.push(named.item);
        return;
      }
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
      if (!targets.length) return this.problem({ key: 'command.issueAfterLink', values: { phrase: link.item.display } }, `Expected an issue id after "${link.item.display}"`, this.peek() ?? t);
      this.ops.push({ kind: 'link', mode: mode === 'remove' ? 'remove' : 'add', phrase: link.item, targets });
      return;
    }
    const field = this.matchPhrase(this.fieldPhrases)[0];
    if (field) {
      const fieldTok = this.peek()!;
      this.pos += field.length;
      const reported = this.problems.length;
      const raw = this.readFieldValue(field.item);
      if (raw === null) {
        // Say a value is missing only if reading it didn't already say what was wrong with it.
        if (this.problems.length === reported) this.problem({ key: 'command.valueFor', values: { field: field.item.name } }, `Expected a value for ${field.item.name}`, this.peek() ?? fieldTok);
        return;
      }
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
        const names = fieldsHit.map((f) => f.field.name);
        this.problem(
          { key: 'command.valueOfFields', values: { value: values[0]!.item.value, n: names.length, first: names[0]!, last: names[names.length - 1]!, fields: names.join(' and ') } },
          `"${values[0]!.item.value}" is a value of ${names.join(' and ')}`,
          tok,
          `Say which one, e.g. "${names[0]} ${values[0]!.item.value}"`,
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
    if (ISSUE_ID.test(tok.value)) {
      // The command already applies to the chosen issues; another issue only follows a link phrase.
      let end = tok.end;
      while (end < this.input.length && /\s/.test(this.input[end]!)) end++;
      this.problems.push(
        keyedProblem(
          {
            message: `"${tok.value}" is an issue id, not a command`,
            start: tok.start,
            end,
            hint: `A command applies to the chosen issues, so leave it out. To link to ${tok.value}, say how, e.g. "relates to ${tok.value}".`,
            fix: '',
          },
          'command.issueIdNotCommand',
          { id: tok.value },
        ),
      );
      return;
    }
    const vocabulary = [
      ...this.fieldsInScope.map((f) => f.name),
      ...this.valuePhrases.map((v) => v.item.value),
      ...this.s.linkPhrases.map((p) => p.display),
      ...this.namedPhrases.map((n) => n.item.name),
      'tag',
      'untag',
      'for',
      'add',
      'remove',
      'comment',
    ];
    const guess = didYouMean(tok.value, vocabulary);
    this.problem(
      { key: 'command.unknown', values: { word: tok.value, ...guessWords(guess) } },
      `Unknown command "${tok.value}"`,
      tok,
      guess ? `Did you mean "${guess}"?` : 'Use a field name and value, e.g. "State Fixed", or "tag urgent".',
      guess,
    );
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

  /**
   * The value nearest to the next one to three words, for a value that didn't match: the
   * run of words is taken only while none of them starts a command of its own, and the
   * longest run that is close enough to a value wins.
   */
  private nearestValue(values: string[]): { value: string; words: number } | null {
    const stops = new Set([
      ...this.fieldsInScope.map((f) => f.name.toLowerCase().split(' ')[0]!),
      'tag',
      'untag',
      'for',
      'add',
      'remove',
      'comment',
    ]);
    const words: string[] = [];
    for (let k = 0; k < 3; k++) {
      const tok = this.tokens[this.pos + k];
      if (!tok || tok.kind !== 'word' || (k > 0 && stops.has(tok.value.toLowerCase()))) break;
      words.push(tok.value);
    }
    for (let k = words.length; k >= 1; k--) {
      const typed = words.slice(0, k).join(' ').toLowerCase();
      let best: string | null = null;
      let bestD = Infinity;
      for (const v of values) {
        const d = editDistance(typed, v.toLowerCase());
        if (d < bestD) {
          bestD = d;
          best = v;
        }
      }
      if (best !== null && bestD > 0 && bestD <= Math.max(1, Math.floor(typed.length / 4))) return { value: best, words: k };
      // Still being typed: the start of a value of several words.
      const started = k > 1 ? values.find((v) => v.toLowerCase().startsWith(typed)) : undefined;
      if (started) return { value: started, words: k };
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
      case 'version':
      case 'build':
      case 'owned': {
        const candidates = this.valuePhrases.filter((v) => v.item.field.id === field.id);
        const hit = this.matchPhrase(candidates)[0];
        if (hit) {
          this.pos += hit.length;
          return hit.item.value;
        }
        // A misspelt value can run over several words ("In Progres"): read it as one, with one fix.
        const near = this.nearestValue(candidates.map((c) => c.item.value));
        const last = this.tokens[this.pos + Math.max(near?.words ?? 1, 1) - 1]!;
        const typed = this.input.slice(t.start, last.end);
        const guess = near?.value ?? didYouMean(t.value, candidates.map((c) => c.item.value));
        const span = { ...t, end: last.end };
        const known = candidates.map((c) => c.item.value);
        this.problem(
          { key: 'command.unknownValue', values: { value: typed, field: field.name, ...guessWords(guess), n: known.length, allowed: known.join(', ') } },
          `Unknown value "${typed}" for ${field.name}`,
          span,
          guess ? `Did you mean "${guess}"?` : known.length ? `Values: ${known.join(', ')}` : 'There are no values yet.',
          guess ? fixValue(this.input, t.start, last.end, guess) : null,
        );
        this.pos += near?.words ?? 1;
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
          this.problem({ key: 'command.notADuration', values: { value: t.value, field: field.name } }, `"${t.value}" is not a duration for ${field.name}`, t, 'Use e.g. 2d, 4h or 1w 2d');
          this.pos++;
          return null;
        }
        return parts.join(' ');
      }
      case 'group': {
        // A group's name may run over several words ("Backend team"): the longest that names one.
        let best = 0;
        let typed = '';
        for (let k = 1; k <= 4; k++) {
          const words = this.tokens.slice(this.pos, this.pos + k);
          if (words.length < k || words.some((w) => w.kind !== 'word')) break;
          typed = words.map((w) => w.value).join(' ');
          if (this.s.groupsByName.has(typed.toLowerCase())) best = k;
        }
        const k = Math.max(best, 1);
        const value = this.tokens
          .slice(this.pos, this.pos + k)
          .map((w) => w.value)
          .join(' ');
        this.pos += k;
        return value;
      }
      case 'datetime': {
        // "2026-11-20T15:00", "+2h", "now": the words that touch; then a time after a day ("tomorrow 09:30").
        const glued = (): string => {
          let out = this.tokens[this.pos]!.value;
          let end = this.tokens[this.pos]!.end;
          this.pos++;
          while (this.peek() && this.peek()!.start === end && (this.peek()!.kind === 'word' || this.peek()!.kind === 'colon')) {
            out += this.peek()!.value;
            end = this.peek()!.end;
            this.pos++;
          }
          return out;
        };
        const first = glued();
        const next = this.peek();
        const after = this.tokens[this.pos + 1];
        const isDay = /^(\d{4}-\d{2}-\d{2}|today|tomorrow|yesterday)$/i.test(first);
        if (isDay && next?.kind === 'word' && /^\d{1,2}$/.test(next.value) && after?.kind === 'colon' && after.start === next.end) {
          return `${first} ${glued()}`;
        }
        return first;
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

/**
 * A command in words: "set State to Fixed; add tag perf". In a page's language for the rule form,
 * which reads a rule's command as it's typed (D49); in English, as the API's words are, by default.
 * The command language's own words in it (fields, values, tags, link phrases) stay as written.
 */
export function describeCommand(ops: CommandOp[], tr: Translator = translatorFor('en')): string {
  if (!ops.length) return tr.t('server.command.noChanges');
  return ops
    .map((op) => {
      switch (op.kind) {
        case 'field':
          return tr.t('server.command.field', { mode: op.mode === 'remove' ? 'remove' : op.mode === 'add' ? 'add' : 'set', field: op.field.name, values: op.raw.join(', ') });
        case 'tag':
          return tr.t('server.command.tag', { mode: op.mode === 'add' ? 'add' : 'remove', name: op.name });
        case 'link':
          return tr.t('server.command.link', { mode: op.mode === 'add' ? 'add' : 'remove', phrase: op.phrase.display, targets: op.targets.join(', ') });
        case 'comment':
          return tr.t('server.command.comment');
        case 'action':
          return tr.t('server.command.action', { name: op.name });
        case 'transition':
          return tr.t('server.command.transition', { name: op.name, field: op.field, to: op.to });
        case 'sprint':
          return tr.t('server.command.sprint', { mode: op.mode === 'add' ? 'add' : 'remove', name: op.name });
      }
    })
    .join(tr.t('server.command.then'));
}

/** Completions for the command dialog. */
/**
 * What could come next at the caret. A value can be several words ("In Progress"), so the
 * text being typed may start a few words back: each start is tried, longest first, and
 * the first that something fits replaces from there.
 */
export function suggestCommand(input: string, caret: number, s: SchemaSnapshot, projectIds: string[], limit = 20): SuggestItem[] {
  const before = input.slice(0, caret);
  const words = [...before.matchAll(/\S+/g)].map((m) => ({ text: m[0], start: m.index! }));
  const typing = words.length > 0 && !/\s$/.test(before); // the caret is at the end of a word

  const fieldIds = new Set<string>();
  for (const pid of projectIds) for (const pf of s.projectFields.get(pid) ?? []) fieldIds.add(pf.fieldId);
  const fields = [...fieldIds].map((id) => s.fields.get(id)!).filter(Boolean);
  const valuesOf = (fieldId: string) => {
    const names = new Set<string>();
    for (const pid of projectIds) for (const v of allowedValues(s, fieldId, pid)) names.add(v.name);
    return [...names];
  };
  const people = (): [string, SuggestItem['kind'], string?][] => [
    ['me', 'user'],
    // Whoever may take work: people, and agents an administrator added; not a4a's own agents (D34).
    ...[...s.users.values()].filter((u) => !u.banned && !isOwnAgent(u)).map((u): [string, SuggestItem['kind'], string] => [u.login, 'user', u.isBot ? `${u.login} (agent)` : u.name]),
  ];

  /** What fits after the given words (lower case), or null when they say nothing about it. */
  const after = (prev: string): [string, SuggestItem['kind'], string?][] | null => {
    const last = prev.split(' ').pop() ?? '';
    if (last === 'for') return people();
    if (last === 'tag' || last === 'untag') return [...s.tags.values()].map((t): [string, SuggestItem['kind']] => [t.name, 'tag']);
    const field = fields
      .filter((f) => prev === f.name.toLowerCase() || prev.endsWith(` ${f.name.toLowerCase()}`))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (field) return field.type === 'user' ? people() : valuesOf(field.id).map((n): [string, SuggestItem['kind'], string] => [n, 'value', field.name]);
    return null;
  };
  const anything = (): [string, SuggestItem['kind'], string?][] => [
    ...fields.map((f): [string, SuggestItem['kind'], string] => [f.name, 'field', f.type]),
    ...fields
      .filter((f) => isOptionType(f.type))
      .flatMap((f) => valuesOf(f.id).map((n): [string, SuggestItem['kind'], string] => [n, 'value', f.name])),
    ...s.linkPhrases.map((p): [string, SuggestItem['kind'], string] => [p.display, 'keyword', 'Link to another issue']),
    ...namedCommands(s, projectIds).map((n): [string, SuggestItem['kind'], string] => [n.name, 'keyword', n.kind === 'action' ? 'Action' : `${n.field} → ${n.to}`]),
    ...['tag', 'untag', 'for me', 'remove', 'add', 'comment'].map((k): [string, SuggestItem['kind']] => [k, 'keyword']),
  ];

  // Try the typed text as the last k words (k = 0 when a new word starts at the caret).
  const most = typing ? Math.min(3, words.length) : 0;
  for (let k = most; k >= 0; k--) {
    if (typing && k === 0) continue;
    const from = words.length - k;
    const typed = words.slice(from).map((w) => w.text).join(' ').toLowerCase();
    const prev = words.slice(0, from).map((w) => w.text.toLowerCase()).join(' ');
    const options = after(prev) ?? (k <= 1 ? anything() : null);
    if (!options) continue;
    const replaceStart = k ? words[from]!.start : caret;
    const fits = options.filter(([label]) => {
      const l = label.toLowerCase();
      return !typed || l.startsWith(typed) || (k === 1 && l.split(/\s+/).some((w) => w.startsWith(typed)));
    });
    // A word that is already complete and fits nothing more isn't worth a list.
    if (!fits.length || (fits.length === 1 && fits[0]![0].toLowerCase() === typed)) continue;
    return fits.slice(0, limit).map(([label, kind, description]) => ({ label, insert: `${label} `, kind, description, replaceStart, replaceEnd: caret }));
  }
  return [];
}
