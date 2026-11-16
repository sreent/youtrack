import type { QueryProblem } from '@a4a/shared';
import { didYouMean, editDistance } from '../lib/text';
import { lex, type Token } from './lexer';
import { SORT_ATTRIBUTES, type TermDef, type Vocabulary } from './vocabulary';

export interface Span {
  start: number;
  end: number;
}

export type ValueNode =
  | { kind: 'single'; raw: string; negated: boolean; span: Span }
  | { kind: 'range'; from: string | null; to: string | null; span: Span };

export type QueryNode =
  | { kind: 'and'; items: QueryNode[] }
  | { kind: 'or'; items: QueryNode[] }
  | { kind: 'not'; item: QueryNode }
  | { kind: 'term'; def: TermDef; values: ValueNode[]; span: Span }
  | { kind: 'text'; text: string; exact: boolean; span: Span }
  | { kind: 'hash'; value: string; span: Span };

export interface SortItem {
  /** Lower-case field or attribute name */
  field: string;
  display: string;
  dir: 'asc' | 'desc';
  span: Span;
}

export interface ParsedQuery {
  input: string;
  root: QueryNode | null;
  sort: SortItem[];
  problems: QueryProblem[];
}

const RELATIVE_DATE = /^\d+[dwmy]$/i;

class Parser {
  private pos = 0;
  problems: QueryProblem[] = [];

  constructor(
    private tokens: Token[],
    private vocab: Vocabulary,
  ) {}

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset];
  }

  private isKeyword(tok: Token | undefined, word: string): boolean {
    return tok?.kind === 'word' && tok.value.toLowerCase() === word;
  }

  /** Does a "sort by:" clause start here? */
  private atSortBy(): boolean {
    return this.isKeyword(this.peek(), 'sort') && this.isKeyword(this.peek(1), 'by');
  }

  /**
   * If the next words followed by a colon form a known term name, return how many
   * word tokens it spans and the def. Unknown single words before a colon return
   * { words: 1, def: undefined }.
   */
  private termAhead(): { words: number; def: TermDef | undefined; name: string } | null {
    const max = this.vocab.maxTermWords;
    for (let k = max; k >= 1; k--) {
      const words: Token[] = [];
      let ok = true;
      for (let i = 0; i < k; i++) {
        const t = this.peek(i);
        if (t?.kind !== 'word') {
          ok = false;
          break;
        }
        words.push(t);
      }
      if (!ok) continue;
      if (this.peek(k)?.kind !== 'colon') continue;
      const name = words.map((w) => w.value.toLowerCase()).join(' ');
      const def = this.vocab.term(name);
      if (def) return { words: k, def, name };
      if (k === 1) return { words: 1, def: undefined, name };
    }
    return null;
  }

  parse(): Omit<ParsedQuery, 'input'> {
    let root: QueryNode | null = null;
    if (this.peek() && !this.atSortBy()) root = this.parseOr();
    while (this.peek() && !this.atSortBy()) {
      // Stray closing parens etc.
      const t = this.peek()!;
      this.problems.push({ message: `Unexpected "${t.value}"`, start: t.start, end: t.end });
      this.pos++;
      if (this.peek() && !this.atSortBy()) {
        const more = this.parseOr();
        root = root ? { kind: 'and', items: [root, more] } : more;
      }
    }
    const sort = this.atSortBy() ? this.parseSort() : [];
    return { root, sort, problems: this.problems };
  }

  private parseOr(): QueryNode {
    const items = [this.parseAnd()];
    while (this.isKeyword(this.peek(), 'or')) {
      this.pos++;
      if (!this.peek() || this.atSortBy() || this.peek()?.kind === 'rparen') {
        const t = this.tokens[this.pos - 1]!;
        this.problems.push({ message: '"or" needs something after it', start: t.start, end: t.end });
        break;
      }
      items.push(this.parseAnd());
    }
    return items.length === 1 ? items[0]! : { kind: 'or', items };
  }

  private parseAnd(): QueryNode {
    const items: QueryNode[] = [];
    while (this.peek() && !this.atSortBy() && this.peek()!.kind !== 'rparen' && !this.isKeyword(this.peek(), 'or')) {
      if (this.isKeyword(this.peek(), 'and')) {
        this.pos++;
        continue;
      }
      const node = this.parseUnary();
      if (node) items.push(node);
    }
    if (!items.length) return { kind: 'and', items: [] };
    return items.length === 1 ? items[0]! : { kind: 'and', items };
  }

  private parseUnary(): QueryNode | null {
    const t = this.peek()!;
    if (t.kind === 'minus') {
      this.pos++;
      if (!this.peek()) {
        this.problems.push({ message: 'Nothing to exclude after "-"', start: t.start, end: t.end });
        return null;
      }
      const inner = this.parseUnary();
      return inner ? { kind: 'not', item: inner } : null;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): QueryNode | null {
    const t = this.peek()!;
    switch (t.kind) {
      case 'lparen': {
        this.pos++;
        const inner = this.peek()?.kind === 'rparen' ? ({ kind: 'and', items: [] } as QueryNode) : this.parseOr();
        if (this.peek()?.kind === 'rparen') this.pos++;
        else this.problems.push({ message: 'Missing closing )', start: t.start, end: t.end });
        return inner;
      }
      case 'hash':
        this.pos++;
        if (!t.value) {
          this.problems.push({ message: 'Expected a value after #', start: t.start, end: t.end });
          return null;
        }
        return { kind: 'hash', value: t.value, span: { start: t.start, end: t.end } };
      case 'quoted':
        this.pos++;
        return { kind: 'text', text: t.value, exact: true, span: { start: t.start, end: t.end } };
      case 'braced':
        this.pos++;
        return { kind: 'text', text: t.value, exact: true, span: { start: t.start, end: t.end } };
      case 'word': {
        const ahead = this.termAhead();
        if (ahead) return this.parseTerm(ahead);
        this.pos++;
        return { kind: 'text', text: t.value, exact: false, span: { start: t.start, end: t.end } };
      }
      case 'colon':
      case 'comma':
      case 'dotdot':
      case 'rparen':
      case 'minus':
      default:
        this.pos++;
        this.problems.push({ message: `Unexpected "${t.value}"`, start: t.start, end: t.end });
        return null;
    }
  }

  private parseTerm(ahead: { words: number; def: TermDef | undefined; name: string }): QueryNode | null {
    const first = this.peek()!;
    this.pos += ahead.words;
    const colon = this.peek()!;
    this.pos++; // colon
    const span = { start: first.start, end: colon.end };
    if (!ahead.def) {
      const guess = didYouMean(ahead.name, this.vocab.termNames());
      this.problems.push({
        message: `Unknown field "${first.value}"`,
        start: first.start,
        end: colon.start,
        hint: guess ? `Did you mean "${guess}"?` : undefined,
        fix: guess ?? undefined,
      });
      this.parseValues(undefined); // consume values to keep going
      return null;
    }
    const values = this.parseValues(ahead.def);
    if (!values.length) {
      this.problems.push({ message: `Expected a value after "${ahead.def.name}:"`, start: first.start, end: colon.end });
      return null;
    }
    span.end = values[values.length - 1]!.span.end;
    return { kind: 'term', def: ahead.def, values, span };
  }

  private parseValues(def: TermDef | undefined): ValueNode[] {
    const values: ValueNode[] = [];
    for (;;) {
      const v = this.parseValueItem(def);
      if (!v) break;
      values.push(v);
      if (this.peek()?.kind === 'comma') {
        this.pos++;
        continue;
      }
      break;
    }
    return values;
  }

  private parseValueItem(def: TermDef | undefined): ValueNode | null {
    const t = this.peek();
    if (!t) return null;
    const isDate = def?.valueType === 'date';
    let negated = false;
    let start = t.start;
    if (t.kind === 'minus') {
      const next = this.peek(1);
      if (isDate && next?.kind === 'word' && RELATIVE_DATE.test(next.value)) {
        // "-7d" is a relative date, not a negation
        this.pos += 2;
        const raw = `-${next.value}`;
        return this.maybeRange(def, raw, { start: t.start, end: next.end });
      }
      negated = true;
      this.pos++;
      start = t.start;
    }
    const atom = this.parseAtom(def);
    if (atom === null) {
      if (negated) this.problems.push({ message: 'Expected a value after "-"', start, end: start + 1 });
      return null;
    }
    if (negated) return { kind: 'single', raw: atom.raw, negated: true, span: { start, end: atom.end } };
    return this.maybeRange(def, atom.raw, { start, end: atom.end });
  }

  private maybeRange(def: TermDef | undefined, raw: string, span: Span): ValueNode {
    if (this.peek()?.kind !== 'dotdot') return { kind: 'single', raw, negated: false, span };
    this.pos++;
    let to: string | null = null;
    let end = span.end;
    const t = this.peek();
    if (t?.kind === 'minus' && this.peek(1)?.kind === 'word' && RELATIVE_DATE.test(this.peek(1)!.value)) {
      to = `-${this.peek(1)!.value}`;
      end = this.peek(1)!.end;
      this.pos += 2;
    } else {
      const atom = this.parseAtom(def);
      if (atom) {
        to = atom.raw === '*' ? null : atom.raw;
        end = atom.end;
      } else {
        this.problems.push({ message: 'Expected the end of the range after ".."', start: span.start, end: span.end + 2 });
      }
    }
    return { kind: 'range', from: raw === '*' ? null : raw, to, span: { start: span.start, end } };
  }

  /** A single value: quoted, braced, or one or more words (greedy known-value match). */
  private parseAtom(def: TermDef | undefined): { raw: string; end: number } | null {
    const t = this.peek();
    if (!t) return null;
    if (t.kind === 'quoted' || t.kind === 'braced') {
      this.pos++;
      return { raw: t.value, end: t.end };
    }
    if (t.kind === 'hash') {
      // "#" inside a value list is not valid; treat as end of values
      return null;
    }
    if (t.kind !== 'word') return null;
    if (this.isStopWord(0)) return null;
    // Greedy: the longest run of words matching a known value.
    const known = def ? this.vocab.values(def).map((v) => v.toLowerCase()) : [];
    if (known.length) {
      const knownSet = new Set(known);
      const maxWords = Math.min(6, Math.max(...known.map((k) => k.split(' ').length)));
      for (let k = maxWords; k >= 2; k--) {
        const words: Token[] = [];
        for (let i = 0; i < k; i++) {
          const w = this.peek(i);
          if (w?.kind !== 'word' || (i > 0 && this.isStopWord(i))) break;
          words.push(w);
        }
        if (words.length !== k) continue;
        const joined = words.map((w) => w.value.toLowerCase()).join(' ');
        if (knownSet.has(joined)) {
          this.pos += k;
          return { raw: words.map((w) => w.value).join(' '), end: words[k - 1]!.end };
        }
      }
      // Not a value as typed. A misspelt value of several words ("In Progres") is read as one,
      // so the problem and its fix cover all of it, rather than one word and some loose text.
      if (!knownSet.has(t.value.toLowerCase())) {
        for (let k = Math.min(3, maxWords); k >= 2; k--) {
          const words: Token[] = [];
          for (let i = 0; i < k; i++) {
            const w = this.peek(i);
            if (w?.kind !== 'word' || (i > 0 && this.isStopWord(i))) break;
            words.push(w);
          }
          if (words.length !== k) continue;
          const joined = words.map((w) => w.value.toLowerCase()).join(' ');
          const d = Math.min(...known.map((v) => editDistance(joined, v)));
          if ((d > 0 && d <= Math.max(1, Math.floor(joined.length / 4))) || known.some((v) => v.startsWith(joined))) {
            this.pos += k;
            return { raw: words.map((w) => w.value).join(' '), end: words[k - 1]!.end };
          }
        }
      }
    }
    this.pos++;
    return { raw: t.value, end: t.end };
  }

  /** A word that ends a value: a following term name, a keyword, or "sort by". */
  private isStopWord(offset: number): boolean {
    const t = this.peek(offset);
    if (!t || t.kind !== 'word') return true;
    const lower = t.value.toLowerCase();
    if (offset > 0 && (lower === 'and' || lower === 'or')) return true;
    if (lower === 'sort' && this.isKeyword(this.peek(offset + 1), 'by')) return true;
    // Does a term name start here? A single word right before a colon always does
    // (known or not); several words only if together they name a known term, so a
    // value followed by "sort by:" or "fix versions:" is still read as a value.
    for (let k = this.vocab.maxTermWords; k >= 1; k--) {
      if (this.peek(offset + k)?.kind !== 'colon') continue;
      const words: string[] = [];
      for (let i = 0; i < k; i++) {
        const t = this.peek(offset + i);
        if (t?.kind !== 'word') break;
        words.push(t.value.toLowerCase());
      }
      if (words.length !== k) continue;
      if (k === 1 || this.vocab.term(words.join(' '))) return true;
    }
    return false;
  }

  private parseSort(): SortItem[] {
    const sortTok = this.peek()!;
    this.pos += 2; // sort by
    if (this.peek()?.kind === 'colon') this.pos++;
    else this.problems.push({ message: 'Expected ":" after "sort by"', start: sortTok.start, end: sortTok.end });
    const items: SortItem[] = [];
    const sortable = new Set([...SORT_ATTRIBUTES, ...[...this.vocab.snapshot.fields.values()].map((f) => f.name.toLowerCase())]);
    const display = new Map<string, string>([...this.vocab.snapshot.fields.values()].map((f) => [f.name.toLowerCase(), f.name]));
    while (this.peek()) {
      // Collect words up to comma / asc / desc
      const words: Token[] = [];
      while (this.peek()?.kind === 'word') {
        const lower = this.peek()!.value.toLowerCase();
        if (lower === 'asc' || lower === 'desc') break;
        words.push(this.peek()!);
        this.pos++;
      }
      if (!words.length) {
        const t = this.peek()!;
        this.problems.push({ message: `Unexpected "${t.value}" in sort by`, start: t.start, end: t.end });
        this.pos++;
        continue;
      }
      let name = words.map((w) => w.value.toLowerCase()).join(' ');
      if (name === 'resolved') name = 'resolved date';
      if (name === 'id') name = 'issue id';
      let dir: 'asc' | 'desc' = 'asc';
      let end = words[words.length - 1]!.end;
      const d = this.peek();
      if (d?.kind === 'word' && (d.value.toLowerCase() === 'asc' || d.value.toLowerCase() === 'desc')) {
        dir = d.value.toLowerCase() as 'asc' | 'desc';
        end = d.end;
        this.pos++;
      }
      if (!sortable.has(name)) {
        const guess = didYouMean(name, [...sortable]);
        this.problems.push({
          message: `Cannot sort by "${name}"`,
          start: words[0]!.start,
          end,
          hint: guess ? `Did you mean "${guess}"?` : undefined,
        });
      } else {
        items.push({ field: name, display: display.get(name) ?? name, dir, span: { start: words[0]!.start, end } });
      }
      if (this.peek()?.kind === 'comma') {
        this.pos++;
        continue;
      }
      if (this.peek()) {
        const t = this.peek()!;
        this.problems.push({ message: `Unexpected "${t.value}" after sort by`, start: t.start, end: t.end });
        this.pos++;
      }
    }
    if (!items.length && !this.problems.length) {
      this.problems.push({ message: 'Expected a field after "sort by:"', start: sortTok.start, end: sortTok.end });
    }
    return items;
  }
}

export function parseQuery(input: string, vocab: Vocabulary): ParsedQuery {
  const { tokens, problems } = lex(input);
  const parser = new Parser(tokens, vocab);
  const result = parser.parse();
  return { ...result, input, problems: [...problems, ...result.problems] };
}
